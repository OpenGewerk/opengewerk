#!/bin/sh
# Makes a backup every night without anybody having to remember it (#130).
#
# Leitentscheidung 6 counts the backup as part of the product. A backup that
# runs when somebody thinks of it is missing on exactly the day it is needed,
# and the one that nobody ever watched turns out to be empty; the second half
# is answered by the office, which shows when the last one finished and warns
# when that is more than two days ago.
#
# Four things in here are decisions.
#
# 1. THE TIME IS A SETTING OF THE INSTANCE, 02:30 until its operators choose
#    another in their area (#188), in the time zone of the instance (TZ). Not
#    a setting of a tenant: one instance can carry several, and the hour of
#    all of them is decided by the people who run the instance. It is read
#    again before every check, so a change arrives within five minutes and
#    without a restart, and a database that cannot be asked means 02:30.
#
# 2. IT CATCHES UP. A machine that is off at night makes its backup when it
#    comes back: a backup is due whenever the last one finished before the
#    most recent 02:30. A container restart in the afternoon, after the backup
#    of that night, therefore makes none.
#
# 3. ONE ATTEMPT PER NIGHT. A failure is written to the log, and a missing
#    backup turns up on the screen of the office after two days; trying again
#    every five minutes would fill the disk with half archives and the log
#    with the same sentence.
#
# 4. AN INSTANCE WITHOUT A TENANT IS NOT BACKED UP BY THE SCHEDULE. After a
#    lost disk the instance comes back empty, and a nightly backup of that
#    empty instance would be the newest archive, the one `restore.sh latest`
#    takes, and fourteen nights later the last one with data would be gone.
#    `backup.sh --scheduled` checks and skips; a backup by hand still does
#    whatever it is told.

set -eu

: "${BACKUP_STATUS_PATH:=/var/lib/opengewerk/backup-status}"

# Reading the database as postgres without running what it defines.
. "$(dirname "$0")/superuser-reads.sh"

fallback='02:30'
time_errors=$(mktemp)

# The time from the settings of the instance, "HH:MM", or the fallback when
# the database does not answer or answers with something that is not a time.
configured_time() {
	# Only from the table the application made: after a restore it could be a
	# view that runs what it calls as postgres. psql ends with 3 where a
	# check refuses it, and that is said here, with the fallback that holds
	# instead; a database that does not answer only means the fallback. Within
	# limits, for the lock, the select and the connection: a lock held on the
	# table, by a migration hanging in its transaction, say, would keep the
	# schedule waiting without end and make no backup at all (#1003).
	if value=$(
		SUPERUSER_LIMITS='-c lock_timeout=30s -c statement_timeout=60s' PGCONNECT_TIMEOUT=30
		export SUPERUSER_LIMITS PGCONNECT_TIMEOUT
		checked_query instance_settings "id backup_time" \
			"select to_char(backup_time, 'HH24:MI') from only public.instance_settings where id = 1" \
			2>"$time_errors"
	); then
		:
	elif [ "$?" -eq 3 ]; then
		cat "$time_errors" >&2
		echo "Die Uhrzeit der Sicherung ließ sich nicht lesen, es gilt ${fallback} Uhr." >&2
		value=''
	else
		value=''
	fi

	case "$value" in
		[0-2][0-9]:[0-5][0-9]) echo "$value" ;;
		*) echo "$fallback" ;;
	esac
}

# The epoch of the last backup that finished, or 0 when none is recorded.
last_recorded() {
	file="${BACKUP_STATUS_PATH}/last.json"

	if [ -f "$file" ]; then
		value=$(sed -n 's/.*"finishedEpoch": *\([0-9][0-9]*\).*/\1/p' "$file" | head -n 1)
		echo "${value:-0}"
	else
		echo 0
	fi
}

# The most recent moment a backup was due: today at $at once that has come,
# yesterday at $at before. On the two days a year the clock changes the day
# is an hour longer or shorter, and the moment moves by that hour, once.
latest_due() {
	now=$(date +%s)
	today=$(date -d "$(date +%Y-%m-%d) ${at}" +%s)

	if [ "$now" -ge "$today" ]; then
		echo "$today"
	else
		echo $((today - 86400))
	fi
}

# The time it would take, and nothing else: for the check of the stack.
if [ "${1:-}" = "--time" ]; then
	configured_time
	exit 0
fi

# A stop of the service (docker stop, compose down, an update) sends TERM to
# this script, the first process of its container. Without a trap the kernel
# drops that signal for PID 1, and the KILL after the grace period ends a
# backup under way before it cleans up: the hidden file on the target and
# the parts in the container would stay (#1004). So TERM goes on to the
# process group of the backup, which cleans up as after any other failure,
# and this script ends once it has. The backup and the pause between checks
# run behind a wait, which a trap interrupts at once; a command in the
# foreground would hold the trap until it ends. A TERM between the start of
# the backup and the line that keeps its process waits for that line, and
# then for the group of the backup, so that it does not end this script with
# a backup it has not reached.
backup=''
starting=false
stopping=false
stop() {
	stopping=true
	if [ "$starting" = true ]; then
		return
	fi
	if [ -n "$backup" ]; then
		echo "Der Dienst wird angehalten, die laufende Sicherung räumt auf." >&2
		# To its group, which exists once setsid ran in the child. Before that
		# the child may still carry the handler of this script, which would
		# only note the signal and lose it with the exec. So the group is
		# waited for, five seconds at most, and the process alone gets the
		# signal when it never comes. Without "--": the kill of busybox sh
		# takes the group as -PID only.
		tries=0
		until kill -s TERM "-$backup" 2>/dev/null; do
			kill -0 "$backup" 2>/dev/null || break
			tries=$((tries + 1))
			if [ "$tries" -ge 50 ]; then
				kill -s TERM "$backup" 2>/dev/null || true
				break
			fi
			sleep 0.1
		done
		wait "$backup" 2>/dev/null || true
	fi
	exit 143
}
trap stop TERM INT HUP

at=$(configured_time)

echo "Geplante Sicherung: jeden Tag um ${at} Uhr (${TZ:-UTC}), und nachgeholt, wenn die letzte vor dem letzten Termin lag."

attempted=0

while true; do
	wanted=$(configured_time)

	if [ "$wanted" != "$at" ]; then
		at=$wanted
		echo "Die Uhrzeit der geplanten Sicherung ist jetzt ${at} Uhr (${TZ:-UTC})."
	fi

	due=$(latest_due)
	last=$(last_recorded)

	if [ "$last" -lt "$due" ] && [ "$attempted" -lt "$due" ]; then
		attempted=$due

		# In a process group of its own, which the limit of twelve hours in
		# backup.sh ends as a whole (#999); setsid keeps the status.
		starting=true
		setsid backup.sh --scheduled &
		backup=$!
		starting=false
		if [ "$stopping" = true ]; then
			stop
		fi
		status=0
		wait "$backup" || status=$?
		backup=''
		if [ "$status" -ne 0 ]; then
			echo "Die geplante Sicherung ist fehlgeschlagen, der nächste Versuch folgt zum nächsten Termin." >&2
		fi
	fi

	sleep 300 &
	wait $! || true
done
