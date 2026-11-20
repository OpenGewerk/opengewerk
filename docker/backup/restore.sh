#!/bin/sh
# Plays a backup back into an instance, and checks that what comes back is
# what went in: the archive and its file store before anything changes, the
# audit log after the database is back.
#
# Usage:
#
#   docker compose --profile backup run --rm backup restore.sh <archive>
#   docker compose --profile backup run --rm backup restore.sh latest
#   docker compose --profile backup run --rm backup restore.sh --skip-origin-check <archive>
#
# Before any of it the archive has to be one this instance wrote: listed in
# its record with the same SHA-256, and encrypted when the installation
# encrypts. --skip-origin-check is for a new machine that has no record, see
# archive-checks.sh.
#
# The checks are the reason this is a script and not a page in a manual. A
# restore that silently produced half a database would be found weeks later,
# by an auditor rather than by an operator.
#
# Three of them, and each answers a question the others cannot:
#
#   the manifest        whether the archive arrived whole
#   the file hashes     whether the file store is intact, which a content
#                       addressed store can answer by itself: the name of a
#                       file is the SHA-256 of what is in it, so a mismatch
#                       needs no database and no application to be found
#   the audit heads     whether the log is the same log. The head was written
#                       outside the database at backup time, so a rewritten
#                       chain that fits internally still fails here
#
# The application is locked out for the duration rather than asked to be
# absent. Counting its connections was the first attempt and it protects
# against nothing: the pool drops an idle connection within seconds, so the
# count reads zero while the application is very much running.

set -eu

# The copy of the archive and what is unpacked from it hold every tenant.
umask 077

# A stop of the container (docker stop, Ctrl+C) sends SIGINT, and under the
# init of the backup service every step of this run gets it at once (#1007).
# The run ends as soon as the step under way has ended, before anything looks
# at what that step left, so a hash cut short is never taken for a verdict on
# the archive. It ends through the way out below, which cleans up and gives
# the login back or says why not. Only while the dump is played is a stop just
# noted, see there. Without a trap the shell would end at the signal and skip
# the way out, or, as the first process of a container without an init, not
# end at all.
stopped=''
trap 'stopped=1; exit 1' HUP INT TERM

# The folders of this run, made once the archive is found.
work=''
held=''
cleanup() {
	# Once it cleans up it finishes that: a second stop would end the run
	# halfway and leave the unpacked archive behind. What it starts here
	# ignores the signal as well.
	trap '' HUP INT TERM
	rm -rf ${work:+"$work"} ${held:+"$held"}
	if [ -n "$stopped" ]; then
		echo "Das Rückspielen wurde angehalten." >&2
	fi
	# The lock against backups, taken further below, given up outright: what
	# this run started may hold it a moment longer, see backup.sh.
	flock -u 8 2>/dev/null || true
}
# Until the application is locked out further below, a run that ends has
# changed nothing. The documented way stops the application and the nightly
# backup first and chains the start to this run with &&, so after a run that
# fails nothing starts them again (#1010): it says how. Unless an earlier
# restore that did not go through left the application locked: then its
# message holds, and a start would bring the nightly backup back onto a half
# restored instance. Which of the two it is, this run does not ask the
# database, since a run turned away asks it nothing.
leave_untouched() {
	# As in cleanup: a second stop does not end this halfway.
	trap '' HUP INT TERM
	if [ "$1" -ne 0 ]; then
		echo "" >&2
		echo "Datenbank und Dateispeicher sind von diesem Lauf unverändert. Wurden Anwendung und" >&2
		echo "nächtliche Sicherung dafür angehalten, startet sh docker/start.sh sie wieder, auf dem" >&2
		echo "Stand von vorher. Hat ein früheres Rückspielen die Anwendung ausgesperrt, weil es" >&2
		echo "nicht durchlief, gilt seine Meldung: erst eine Sicherung ganz zurückspielen, dann starten." >&2
	fi
	cleanup
}
trap 'leave_untouched "$?"' EXIT

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_DB:=opengewerk}"
: "${STORAGE_PATH:=/var/lib/opengewerk/storage}"
: "${BACKUP_PATH:=/var/lib/opengewerk/backups}"

# The names of the archives, in one place for backup, restore and verify.
. "$(dirname "$0")/names.sh"

# Reading the database as postgres without running what it defines.
. "$(dirname "$0")/superuser-reads.sh"

# Where an archive comes from and what its chains hold.
. "$(dirname "$0")/archive-checks.sh"

wanted=''
trusted=false

for argument in "$@"; do
	case "$argument" in
	--skip-origin-check) trusted=true ;;
	-*)
		echo "Unbekannte Option ${argument}. Es gibt nur --skip-origin-check." >&2
		exit 1
		;;
	*)
		if [ -n "$wanted" ]; then
			echo "Zurückgespielt wird eine Sicherung je Lauf, genannt waren mehrere." >&2
			exit 1
		fi

		wanted=$argument
		;;
	esac
done

: "${wanted:=latest}"

if [ -z "${PGPASSWORD:-}" ]; then
	echo "PGPASSWORD fehlt. Das Rückspielen sperrt die Anwendung aus und prüft danach" >&2
	echo "über alle Mandanten, beides als Superuser." >&2
	exit 1
fi

# The database itself is restored by the owner of the tables, not by the
# superuser. A dump is a list of statements, and one restored as the
# superuser runs whatever it holds with every right on the machine, a step
# back from SET ROLE included. As the owner it can do what the migrations can
# do and nothing more, which is everything a dump of this database needs.
if [ -z "${OPENGEWERK_OWNER_PASSWORD:-}" ]; then
	echo "OPENGEWERK_OWNER_PASSWORD fehlt. Die Datenbank spielt die Rolle opengewerk_owner" >&2
	echo "zurück, der die Tabellen gehören, und nicht der Superuser." >&2
	exit 1
fi

# --- Find the archive ------------------------------------------------------
if [ "$wanted" = "latest" ]; then
	archive=$(find "$BACKUP_PATH" -maxdepth 1 -name "$archives" | sort | tail -n 1)

	if [ -z "$archive" ]; then
		echo "Unter $BACKUP_PATH liegt keine Sicherung." >&2
		exit 1
	fi
else
	archive="$wanted"
	[ -f "$archive" ] || archive="${BACKUP_PATH}/${wanted}"

	if [ ! -f "$archive" ]; then
		echo "Die Sicherung \"${wanted}\" gibt es nicht." >&2
		exit 1
	fi

	# A named archive is held to the names "latest" looks among, see names.sh.
	if ! is_own_archive "$archive"; then
		echo "Die Sicherung \"$(basename "$archive")\" gehört nicht zu dieser Anwendung: ihre" >&2
		echo "Sicherungen heißen ${BACKUP_PREFIX}-<Zeit>.tar.gz, verschlüsselt mit .age dahinter." >&2
		echo "Es wird nichts zurückgespielt." >&2
		exit 1
	fi
fi

echo "Sicherung: $(basename "$archive")"

work=$(mktemp -d)
held=$(mktemp -d)

# --- Where it comes from ---------------------------------------------------
# Before it is decrypted or unpacked, see archive-checks.sh. The archive is
# read from the target once, into a folder of this container, and from then
# on only that copy is checked and read: the target is where somebody else
# can write, and a file checked there could be another one by the time it is
# read. The copy is as the target holds it, encrypted when the archive is.
copy="${held}/archive"
cp "$archive" "$copy"

if ! check_origin "$copy" "$(basename "$archive")" "$trusted"; then
	refuse_origin "Es wird nichts zurückgespielt."
fi

# --- Unpack, decrypting first when needed ----------------------------------
case "$archive" in
*.age)
	if [ -z "${BACKUP_AGE_IDENTITY:-}" ]; then
		echo "Die Sicherung ist verschlüsselt, aber BACKUP_AGE_IDENTITY zeigt auf" >&2
		echo "keine Schlüsseldatei. Ohne den privaten Schlüssel gibt es keinen Weg" >&2
		echo "an die Daten, und das ist der Zweck der Verschlüsselung." >&2
		exit 1
	fi

	echo "  Sicherung wird entschlüsselt."
	age --decrypt --identity "$BACKUP_AGE_IDENTITY" --output "${work}/archive.tar.gz" "$copy"
	tar --extract --gzip --file "${work}/archive.tar.gz" --directory "$work"
	rm -f "${work}/archive.tar.gz"
	;;
*)
	tar --extract --gzip --file "$copy" --directory "$work"
	;;
esac

rm -f "$copy"

# The second part of the store comes with archives from #991 on, and an
# archive whose manifest names it, or the order that has it, has to bring it.
# One from before has neither.
parts="database.dump storage.tar audit-chains.tsv"
if grep -q -e '"storage-late.tar"' -e '"order"[[:space:]]*:[[:space:]]*"storage-database-late"' "${work}/manifest.json"; then
	parts="${parts} storage-late.tar"
fi

for part in manifest.json $parts; do
	if [ ! -f "${work}/${part}" ]; then
		echo "In der Sicherung fehlt ${part}. Sie ist unvollständig." >&2
		exit 1
	fi
done

# --- Check 1: did the archive arrive whole? --------------------------------
echo "  Prüfsummen werden geprüft."
for part in $parts; do
	expected=$(sed -n "s/.*\"${part}\": \"\([0-9a-f]*\)\".*/\1/p" "${work}/manifest.json")
	actual=$(sha256sum "${work}/${part}" | cut -d' ' -f1)

	if [ -z "$expected" ]; then
		echo "Im Manifest steht keine Prüfsumme für ${part}." >&2
		exit 1
	fi

	if [ "$expected" != "$actual" ]; then
		echo "Die Prüfsumme von ${part} stimmt nicht. Die Sicherung ist beschädigt," >&2
		echo "es wird nichts zurückgespielt." >&2
		echo "  erwartet: ${expected}" >&2
		echo "  gelesen:  ${actual}" >&2
		exit 1
	fi
done

if ! check_chains "${work}/audit-chains.tsv"; then
	echo "In audit-chains.tsv steht eine Zeile, die kein Kopf einer Kette ist: je Zeile gehören" >&2
	echo "dorthin ein Mandant als UUID und eine Zahl. Es wird nichts zurückgespielt." >&2
	exit 1
fi

# --- Check 2: is every file of the store the file its name claims? ---------
# Before anything changes (#1000). Both parts of the store are unpacked into a
# folder of this container and checked there, and only a store that passes
# goes on to the database. A file whose content is not what its name says, as
# a disk that broke while the backup packed the first part leaves it, turns
# the archive away while database and store are still as they were; checked
# after the import of the database, as before, it ended the restore with the
# database replaced and the store half done.
#
# ADR 0007 asks for a sample. This checks all of them, because it costs
# seconds on the amount of data an instance keeps and a sample answers
# "probably" where this answers "yes".
echo "  Dateispeicher wird ausgepackt und gegen die Hashes geprüft."
staged="${work}/store"
mkdir "$staged"

# The store holds files and their folders and nothing else. A link that came
# with the first part would take whatever the second part unpacks under its
# name to wherever it points in this container (#991), and one in either part
# has no place in the store at all. find takes a failed rm for a test that did
# not hold and goes on, so what is left is looked at once more; a find that
# cannot read ends the restore under set -e, through the assignment.
only_files_staged() {
	# Each one it takes is named on a line of its own; a control character in
	# a name shows as ?.
	find "$staged" -mindepth 1 ! -type f ! -type d -exec sh -c 'rm -f "$1" && printf "    entfernt: %s\n" "$(printf "%s" "$1" | tr "\001-\037\177" "?")"' sh {} \;
	left=$(find "$staged" -mindepth 1 ! -type f ! -type d)
	if [ -n "$left" ]; then
		echo "In der Sicherung blieb ein Link oder etwas anderes, das keine Datei ist;" >&2
		echo "es wird nichts zurückgespielt." >&2
		exit 1
	fi
}
tar --extract --no-same-owner --file "${work}/storage.tar" --directory "$staged"
only_files_staged
# What the store got while the backup ran, see backup.sh.
case " $parts " in
*" storage-late.tar "*)
	tar --extract --no-same-owner --file "${work}/storage-late.tar" --directory "$staged"
	only_files_staged
	;;
esac
# Unpacked, the parts are needed no more, and the room they take is the room
# of a second copy of the store.
rm -f "${work}/storage.tar" "${work}/storage-late.tar"

# Only what FileStore writes is restored: a file two folders deep, each
# folder two hex characters, its name a SHA-256 in hex. Anything else, another
# name, another depth, a name with a line break, or what a link swapped in
# while the backup read the store left under a name of its own, is no stored
# file. It goes now, before the check below reads names line by line; find
# hands rm each path whole.
hex='[0-9a-f]'
stored_name=''
hex_count=0
while [ "$hex_count" -lt 64 ]; do
	stored_name="${stored_name}${hex}"
	hex_count=$((hex_count + 1))
done
stored_path="./${hex}${hex}/${hex}${hex}/${stored_name}"
foreign=$(cd "$staged" && find . -type f ! -path "$stored_path" | wc -l | tr -d ' ')
(cd "$staged" && find . -type f ! -path "$stored_path" -exec sh -c 'rm -f "$1" && printf "    entfernt: %s\n" "$(printf "%s" "$1" | tr "\001-\037\177" "?")"' sh {} \;)
left_foreign=$(cd "$staged" && find . -type f ! -path "$stored_path")
if [ -n "$left_foreign" ]; then
	echo "In der Sicherung blieb eine Datei, die keine Datei des Speichers ist;" >&2
	echo "es wird nichts zurückgespielt." >&2
	exit 1
fi
# And only where FileStore looks for it: the two folders are the first four
# characters of the name. Every name is hex by now, so the list is read line
# by line, and without a process for each file.
(cd "$staged" && find . -type f) >"${work}/stored.list"
while IFS= read -r file; do
	name=${file##*/}
	after_first=${name#??}
	after_second=${after_first#??}
	if [ "$file" != "./${name%"$after_first"}/${after_first%"$after_second"}/${name}" ]; then
		rm -f "${staged}/${file#./}" || {
			echo "In der Sicherung blieb eine Datei, die keine Datei des Speichers ist;" >&2
			echo "es wird nichts zurückgespielt." >&2
			exit 1
		}
		printf '    entfernt: %s\n' "$file"
		foreign=$((foreign + 1))
	fi
done <"${work}/stored.list"
rm -f "${work}/stored.list"
if [ "$foreign" -gt 0 ]; then
	echo "    ${foreign} Datei(en) ohne Namen oder Ort des Speichers entfernt, sie werden nicht zurückgespielt."
fi

# Built as a checklist and handed to sha256sum, rather than compared in a
# loop. A loop behind a pipe runs in a subshell, so its counters are gone by
# the time anybody looks at them, and the check would report nothing while
# appearing to work. sha256sum -c carries the verdict in its exit code. Every
# name is a hash by now, two folders deep where it belongs. The list comes
# first, into a file and not through a pipe: a find that fails halfway would
# leave a list that misses files, and set -e sees its status only here.
(cd "$staged" && find . -type f) >"${work}/staged.list"
while IFS= read -r file; do
	printf '%s  %s\n' "${file##*/}" "$file"
done <"${work}/staged.list" >"${work}/expected.sha256"

# Counted without a pipe, whose status would be that of its last command, and
# the check below goes by whether the checklist has anything in it, not by a
# number: a count that fails would leave no number, and an empty one would
# skip the check (#1000).
expected_files=$(wc -l <"${work}/expected.sha256")
files=$(wc -l <"${work}/staged.list")
rm -f "${work}/staged.list"

if [ -s "${work}/expected.sha256" ]; then
	# -s rather than --quiet: this runs on busybox, which has the short option
	# and not the long one. On failure the same check runs again without it,
	# because "something is broken" without naming the file leaves an operator
	# to go looking through the archive by hand.
	if ! (cd "$staged" && sha256sum -cs "${work}/expected.sha256"); then
		echo "Der Inhalt einzelner Dateien passt nicht mehr zu ihrem Namen. In einem" >&2
		echo "inhaltsadressierten Speicher heißt das, sie sind beschädigt oder untergeschoben." >&2
		echo "Es wird nichts zurückgespielt, Datenbank und Dateispeicher bleiben, wie sie sind:" >&2
		(cd "$staged" && sha256sum -c "${work}/expected.sha256" 2>&1) | grep -v ': OK$' >&2 || true
		exit 1
	fi
fi

echo "    ${files} Datei(en) in der Sicherung, ${expected_files} davon gegen ihren Hash geprüft."

# --- Who the store belongs to ----------------------------------------------
# The store belongs to the user of the application, and an application that
# still runs, which the documented way rules out but nothing here can see, can
# change what is in it at any moment: put a link where a folder was between a
# look at the folder and the step that follows, say. Root, going by paths in
# the store, would follow that link out of it and delete, write or hand over
# files of this container, the archives among them. So what this restore does
# in the store runs with the rights of the store's owner, and a link takes it
# only where that user may write in this container. It gets no password of the
# database along.
#
# The owner empties only folders it may read, write and enter, the store
# itself among them. One that belongs to someone else, root after a copy that
# failed halfway before #1000 say, or one of its own without those rights,
# would end the restore with the database already replaced; it is turned away
# here, while nothing has changed yet.
#
# The archives and the record of the backups are in this container too, and
# not in that of the application. Where the owner may write to them, a target
# on a share that maps every file to that user say, a link would take it
# there, and the restore is turned away as well.
mkdir -p "$STORAGE_PATH"
# Read before anything is copied, from the store itself, which carries the
# owner the application runs as.
storage_owner=$(stat -c '%u:%g' "$STORAGE_PATH")
storage_uid=${storage_owner%%:*}
as_store_owner() {
	if [ "$storage_uid" = 0 ]; then
		env -u PGPASSWORD -u OPENGEWERK_OWNER_PASSWORD "$@"
	else
		env -u PGPASSWORD -u OPENGEWERK_OWNER_PASSWORD gosu "$storage_owner" "$@"
	fi
}
if [ "$storage_uid" != 0 ]; then
	# gosu needs SETUID and SETGID, which compose.yaml gives the service. A
	# service without them is told so here, and not after the database is
	# replaced.
	if ! as_store_owner true 2>"${work}/gosu.err"; then
		echo "Als Eigentümer des Dateispeichers (${storage_owner}) kann dieser Dienst nicht arbeiten:" >&2
		sed 's/^/  /' "${work}/gosu.err" >&2
		echo "Er braucht dafür die Capabilities SETUID und SETGID, in docker/compose.yaml unter" >&2
		echo "cap_add des Dienstes backup. Es wird nichts zurückgespielt, Datenbank und" >&2
		echo "Dateispeicher bleiben, wie sie sind." >&2
		exit 1
	fi
	for kept in "$BACKUP_PATH" "${BACKUP_STATUS_PATH:-}"; do
		[ -n "$kept" ] && [ -d "$kept" ] || continue
		# Tried rather than read from the mode, which busybox test -w does: an
		# ACL, or a share that treats every user alike (NFS with all_squash,
		# SMB with noperm), gives a right the mode does not show.
		probe_status=0
		probe=$(as_store_owner mktemp -d -p "$kept" .restore-probe.XXXXXX 2>"${work}/probe.err") ||
			probe_status=$?
		# Only a refusal answers the question. Any other failure, a full target
		# say, says nothing about the right, and deleting needs no room.
		if [ "$probe_status" -ne 0 ]; then
			case $(cat "${work}/probe.err") in
			*'Permission denied'* | *'Operation not permitted'* | *'Read-only file system'*)
				continue
				;;
			esac
			echo "Ob der Eigentümer des Dateispeichers (${storage_owner}) in ${kept} schreiben darf," >&2
			echo "ließ sich nicht ausprobieren:" >&2
			tr "\001-\011\013-\037\177" "?" <"${work}/probe.err" | sed 's/^/  /' >&2
			echo "Es wird nichts zurückgespielt, Datenbank und Dateispeicher bleiben, wie sie sind." >&2
			exit 1
		fi
		as_store_owner rmdir "$probe" || true
		echo "In ${kept} darf der Eigentümer des Dateispeichers (${storage_owner}) schreiben." >&2
		echo "Das Rückspielen leert und füllt den Speicher mit dessen Rechten, und eine Anwendung," >&2
		echo "die dabei noch liefe, könnte es mit einem Link dorthin lenken und Sicherungen löschen." >&2
		echo "Es wird nichts zurückgespielt, Datenbank und Dateispeicher bleiben, wie sie sind." >&2
		echo "Das Verzeichnis soll root gehören und anderen kein Schreibrecht geben; auf einem" >&2
		echo "NAS darf die Freigabe nicht diesem Benutzer zugeordnet eingehängt sein." >&2
		exit 1
	done
	# Looked for as the owner: a folder above the store or in it that the owner
	# may not enter or read makes this find fail, and is turned away as well.
	foreign_status=0
	as_store_owner find "$STORAGE_PATH" -type d \( ! -user "$storage_uid" -o ! -perm -700 \) \
		>"${work}/foreign-folders" 2>"${work}/foreign-folders.err" || foreign_status=$?
	if [ "$foreign_status" -ne 0 ] || [ -s "${work}/foreign-folders" ]; then
		echo "Im Dateispeicher liegen Ordner, die sein Eigentümer (${storage_owner}) nicht leeren darf," >&2
		echo "oder er erreicht den Speicher nicht:" >&2
		head -n 3 "${work}/foreign-folders" | tr "\001-\011\013-\037\177" "?" | sed 's/^/  /' >&2
		head -n 3 "${work}/foreign-folders.err" | tr "\001-\011\013-\037\177" "?" | sed 's/^/  /' >&2
		echo "Das Rückspielen leert und füllt den Speicher mit dessen Rechten. Es wird nichts" >&2
		echo "zurückgespielt, Datenbank und Dateispeicher bleiben, wie sie sind. Bei angehaltener" >&2
		echo "Anwendung geben diese Befehle den Speicher seinem Eigentümer zurück, danach das" >&2
		echo "Rückspielen noch einmal laufen lassen:" >&2
		echo "  docker compose -f docker/compose.yaml --profile backup run --rm backup chown -R ${storage_owner} ${STORAGE_PATH}" >&2
		echo "  docker compose -f docker/compose.yaml --profile backup run --rm backup chmod -R u+rwX ${STORAGE_PATH}" >&2
		exit 1
	fi
fi
# A folder the archive keeps without write for its owner, 0555 say, would be
# made so in the store first and then refuse the owner the files that go into
# it. In the checked folder, which is root's alone, every folder gets read,
# write and enter for its owner.
find "$staged" -type d ! -perm -700 -exec chmod u+rwx {} +

# --- Not while a backup runs (#1012) ----------------------------------------
# A backup that read while this run replaces database and store would hold a
# mix of both, and as the newest archive it would be the one restore.sh
# latest takes next. Every backup holds this lock shared, from before its
# first read until it ends. This run holds it alone from here, before it
# changes anything, until it ends: it does not start while a backup runs, and
# no backup starts before it is over. See backup.sh.
#
# Held by another restore, the lock cannot be had shared either. Then the
# message names that one, and the hint at the end about starting on the
# state from before is left out: start.sh would run the migrations on the
# database the other one is replacing.
#
# Where the file lies is decided as in backup.sh (#1015), and its folder is
# made the same way: on a new machine there may be none yet.
lock_file=${BACKUP_LOCK_PATH:-${BACKUP_STATUS_PATH:-/var/lib/opengewerk/backup-status}/.running}
mkdir -p -m 0755 "$(dirname "$lock_file")"
exec 8>>"$lock_file"
if ! flock -x -n 8; then
	if flock -s -n 8; then
		echo "Eine Sicherung läuft gerade. Zurückgespielt wird erst, wenn sie fertig ist; ob" >&2
		echo "die nächtliche läuft, zeigt: docker compose -f docker/compose.yaml logs backup-schedule" >&2
	else
		echo "Ein anderes Rückspielen läuft gerade. Dieser Lauf hat nichts geändert. Bis das" >&2
		echo "andere fertig ist, nichts starten; danach gilt seine Meldung." >&2
		trap cleanup EXIT
	fi
	exit 1
fi

# --- Lock the application out for the duration ------------------------------
# Counting open connections was the first attempt at this and it protects
# against nothing: the pool closes an idle connection after a few seconds, so
# between two health checks the count is zero while the application is very
# much running. A restore would then go through underneath it.
#
# So the role is locked instead of counted. NOLOGIN keeps new connections out,
# terminating ends the ones that exist, and the owner restoring and the
# superuser checking are unaffected because they are different roles. Locking
# the whole database would not work: that shuts out these connections too.
lock_application() {
	psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
		--command "alter role opengewerk_app nologin" >/dev/null
	psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
		--tuples-only --no-align --command \
		"select pg_terminate_backend(pid) from pg_stat_activity
		  where datname = '${POSTGRES_DB}' and usename = 'opengewerk_app'" >/dev/null
}

superuser_command() {
	psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
		--command "$1" >/dev/null
}

# Written on the role of the application when a restore went through and the
# backup is from an earlier version than the database it replaced (#988). The
# application stays locked then, because it would work on a schema older than
# itself until the migrations have run; start.sh runs them and gives the login
# back to a role that carries this note, and only to such a role.
#
# The same when the application was locked before the run. The database this
# run replaced is then one an earlier restore left, and how far its migrations
# had come says nothing about how far the application needs them. And the same
# when that database had no migrations at all: then nothing says it either.
waiting_note='restored, waiting for migrations'

# The way out runs psql in a session of its own (#1007). psql answers a SIGINT
# by cancelling its statement even when the signal is ignored, as it is there,
# so a second stop that reaches the process group of this run, or the
# terminal, would take back what the way out does. setsid runs psql in place,
# because a child of this shell never leads a group, and keeps its status.
superuser_command_alone() {
	setsid psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
		--command "$1" >/dev/null
}

unlock_application() {
	superuser_command_alone "alter role opengewerk_app login; comment on role opengewerk_app is null"
}

# A login that could not be given back is said, with the command that gives it
# back. The role is locked then and carries no note, and start.sh gives the
# login back only to a role with the note: the application would look as if
# its password were broken.
unlock_failed=0
unlock_or_say() {
	unlock_application && return 0
	unlock_failed=1
	echo "" >&2
	echo "Die Anwendung bleibt ausgesperrt: Ihre Anmeldung ließ sich nicht zurückgeben," >&2
	echo "der Grund steht darüber. Im Ordner der Installation gibt dieser Befehl sie zurück:" >&2
	echo "  docker compose -f docker/compose.yaml exec postgres psql -U postgres -c \"alter role opengewerk_app login; comment on role opengewerk_app is null\"" >&2
}

# Locked before this run starts: by an earlier restore that did not go through,
# or by one that waits for the migrations.
was_locked=$(psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
	--tuples-only --no-align \
	--command "select not rolcanlogin from pg_catalog.pg_roles where rolname = 'opengewerk_app'")
# And whether that earlier one waits for the migrations: then its note stands
# on the role, which this run takes off before it changes anything, see below.
had_note=$(psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
	--tuples-only --no-align \
	--command "select pg_catalog.shobj_description(oid, 'pg_authid') = '${waiting_note}' from pg_catalog.pg_roles where rolname = 'opengewerk_app'")

# A restore that fails before the database is replaced leaves it as it was,
# see below, and the application gets its login back: a role left locked would
# turn one problem into two, and the second one looks like a broken password.
# Unless it was locked before this run: then the database it leaves is the one
# that earlier run left, and the lock stays with it.
#
# Once the database is replaced, a failure leaves it next to a file store or a
# check that did not finish (#988). The application stays locked then, so that
# nothing works on that state, and the message says so. A second restore gives
# the login back when it goes through.
replaced=0
waiting=0
unlock_and_cleanup() {
	# As in cleanup: a second stop does not end this halfway.
	trap '' HUP INT TERM
	if [ "$1" -eq 0 ]; then
		[ "$waiting" -eq 1 ] || unlock_or_say
	elif [ "$replaced" -eq 1 ]; then
		superuser_command_alone "comment on role opengewerk_app is null" || true
		echo "" >&2
		echo "Die Anwendung bleibt ausgesperrt: die Datenbank ist schon zurückgespielt," >&2
		echo "der Rest nicht. Das Rückspielen noch einmal laufen lassen und danach" >&2
		echo "starten; der Start gibt der Anwendung die Anmeldung zurück." >&2
	elif [ "$was_locked" = t ]; then
		echo "" >&2
		echo "Die Anwendung bleibt ausgesperrt, wie sie es vor diesem Lauf war: ein" >&2
		echo "früheres Rückspielen ist nicht durchgelaufen oder wartet auf die Migrationen." >&2
		# Nothing changed, so the note of one that waits goes back on the role.
		# Should that fail, the role stays locked without it, and start.sh
		# refuses: the safe way round, and the message says how to go on.
		if [ "$had_note" = t ] &&
			! superuser_command_alone "comment on role opengewerk_app is '${waiting_note}'"; then
			echo "Es wartete auf die Migrationen, und den Vermerk dafür konnte dieser Lauf nicht" >&2
			echo "zurückschreiben, der Grund steht darüber. Ohne ihn startet sh docker/start.sh" >&2
			echo "nicht. Im Ordner der Installation schreibt ihn dieser Befehl zurück:" >&2
			echo "  docker compose -f docker/compose.yaml exec postgres psql -U postgres -c \"comment on role opengewerk_app is '${waiting_note}'\"" >&2
		fi
	else
		unlock_or_say
	fi
	cleanup
	# A run that went through ends with an error all the same when the
	# application did not get its login back.
	if [ "$unlock_failed" -eq 1 ]; then
		exit 1
	fi
}
trap 'unlock_and_cleanup "$?"' EXIT

echo "  Anwendung wird für die Dauer des Rückspielens ausgesperrt."
# Is the backup older than the database, she stays so until sh docker/start.sh
# has migrated, and that one needs Docker Engine 28.3.3 or newer (#985). This
# container cannot see the engine of the machine, so it is said beforehand.
echo "  Bleibt sie danach ausgesperrt, gibt ihr erst sh docker/start.sh die Anmeldung"
echo "  zurück, und das braucht Docker Engine ab 28.3.3."
lock_application
# The note of an earlier restore that waits for the migrations goes now,
# before anything changes (#1012). Left on the role, it would make start.sh
# give the login back on whatever this run leaves, half a state included, and
# taking it off later can fail with the very connection that broke the run.
# Should this run change nothing, the way out puts it back. If taking it off
# fails, nothing has changed yet, and the note is still there.
if [ "$had_note" = t ]; then
	superuser_command "comment on role opengewerk_app is null"
fi
# --- Restore the database --------------------------------------------------
# Everything the owner holds goes first, and the dump is played into what is
# left, all of it in one transaction (#988). Restoring into a database that
# still holds rows would mix two states, and the result would look plausible
# and be wrong.
#
# Not pg_restore --clean: it throws away only what the dump names. A backup of
# an earlier version lacks what later migrations added, and that hangs on what
# the dump does name, an index or a table, so the clean stopped halfway, with
# part of the schema gone. Emptied here, an older backup lands as it would in a
# new database, and start.sh migrates it to the running version afterwards.
#
# One transaction: a restore that fails anywhere, while emptying or while
# playing the dump, leaves the database exactly as it was, and not without its
# policies and triggers.
#
# Signed in as the owner, see above, and not as the superuser with SET ROLE:
# a statement in the dump could take that back with RESET ROLE.
empty_owned_schema() {
	cat <<'SQL'
SELECT 'restore-transaction ' || pg_catalog.pg_current_xact_id();
DROP SCHEMA IF EXISTS drizzle CASCADE;
DO $$
DECLARE
	item record;
BEGIN
	-- Extensions first: their functions and types go with them and cannot go
	-- on their own.
	FOR item IN
		SELECT pg_catalog.quote_ident(e.extname) AS name
		  FROM pg_catalog.pg_extension e
		  JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
		 WHERE n.nspname = 'public' AND e.extowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
	LOOP
		EXECUTE pg_catalog.format('DROP EXTENSION IF EXISTS %s CASCADE', item.name);
	END LOOP;

	FOR item IN
		SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS name,
		       CASE c.relkind
		         WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'f' THEN 'FOREIGN TABLE'
		         WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
		         WHEN 'S' THEN 'SEQUENCE' WHEN 'c' THEN 'TYPE'
		       END AS kind
		  FROM pg_catalog.pg_class c
		  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public'
		   AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S', 'c')
		   AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
		 ORDER BY CASE c.relkind WHEN 'r' THEN 0 WHEN 'p' THEN 0 WHEN 'f' THEN 0 ELSE 1 END
	LOOP
		EXECUTE pg_catalog.format('DROP %s IF EXISTS %s CASCADE', item.kind, item.name);
	END LOOP;

	FOR item IN
		SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname)
		         || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS name,
		       CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS kind
		  FROM pg_catalog.pg_proc p
		  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
		 WHERE n.nspname = 'public'
		   AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
	LOOP
		EXECUTE pg_catalog.format('DROP %s IF EXISTS %s CASCADE', item.kind, item.name);
	END LOOP;

	-- Enums, domains and ranges. Not multiranges: one goes with its range and
	-- cannot go on its own, and dropped first it would stop the restore.
	FOR item IN
		SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(t.typname) AS name,
		       CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END AS kind
		  FROM pg_catalog.pg_type t
		  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
		 WHERE n.nspname = 'public'
		   AND t.typtype IN ('e', 'd', 'r')
		   AND t.typowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
	LOOP
		EXECUTE pg_catalog.format('DROP %s IF EXISTS %s CASCADE', item.kind, item.name);
	END LOOP;
END
$$;
SQL
}

# How far the migrations had come, the last one's time as drizzle notes it, or
# 0 without any. Asked as the owner, who also plays the dump: after the restore
# the table is whatever the archive made it.
owner_value() {
	PGPASSWORD="$OPENGEWERK_OWNER_PASSWORD" psql --host "$POSTGRES_HOST" \
		--username opengewerk_owner --dbname "$POSTGRES_DB" \
		--no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$1"
}
migration_level() {
	level=0
	if [ "$(owner_value "select to_regclass('drizzle.__drizzle_migrations') is not null")" = t ]; then
		level=$(owner_value "select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations")
	fi
	case "$level" in
	'' | *[!0-9]*) level=0 ;;
	esac
	echo "$level"
}

echo "  Datenbank wird zurückgespielt."
level_before=$(migration_level)
empty_owned_schema >"${work}/empty.sql"
# Into a file first, not through a pipe: in a pipe only psql's status counts,
# and a pg_restore that stopped halfway would hand it half a dump, which the
# transaction would then commit over an emptied schema.
pg_restore --no-owner --file "${work}/database.sql" "${work}/database.dump"
#
# The transaction names its number first. A psql that fails has not always
# seen it fail: when the connection breaks after the COMMIT went out and
# before its answer came back, the database may hold the backup already. So
# the database is asked how the transaction ended, and only one it aborted
# leaves the database as it was; one it committed, or one whose end nobody
# can say, counts as replaced. So the run counts as replaced from here on,
# and only that answer, or a transaction that never began, takes it back: a
# way out that comes before it, a step of the question that fails, say,
# leaves the application locked rather than on a database it cannot know.
#
# While the dump is played a stop is only noted (#1007). psql ends by it, or
# plays on when the signal reached this script alone, and either way the run
# goes on to the question before it ends. Ended at once, it would leave the
# application locked on a database that may well be as it was.
trap 'stopped=1' HUP INT TERM
replaced=1
if ! PGPASSWORD="$OPENGEWERK_OWNER_PASSWORD" PGOPTIONS="-c client_min_messages=warning" \
	psql --host "$POSTGRES_HOST" --username opengewerk_owner --dbname "$POSTGRES_DB" \
	--no-psqlrc --quiet --tuples-only --no-align --single-transaction --set ON_ERROR_STOP=1 \
	--file "${work}/empty.sql" --file "${work}/database.sql" >"${work}/played.txt"; then
	# sed reads the number alone and stops at the first one. Through a pipe only
	# the status of its last command would count, and a sed that a second stop
	# ended would read as a transaction that never began. As it is, a failed
	# lookup ends the run here, and the application stays locked.
	transaction=$(sed -n '/^restore-transaction [0-9][0-9]*$/{s/^restore-transaction //p;q;}' "${work}/played.txt")
	# Without its number the transaction never began, and nothing changed.
	# The number is what the first statement returns, and psql writes each
	# result out before it sends the next statement, so it stands in the file
	# before anything changes, even when psql is killed afterwards.
	if [ -z "$transaction" ]; then
		replaced=0
	else
		outcome=$(psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
			--tuples-only --no-align \
			--command "select pg_catalog.pg_xact_status('${transaction}'::xid8)") || outcome=''
		if [ "$outcome" = aborted ]; then
			replaced=0
		else
			echo "Die Transaktion des Rückspielens ist nicht sicher abgebrochen (${outcome:-unbekannt})." >&2
		fi
	fi
	exit 1
fi
# A stop ends the run again from here on, and one noted while psql played on
# ends it now: the database is replaced, the store is not.
trap 'stopped=1; exit 1' HUP INT TERM
if [ -n "$stopped" ]; then
	exit 1
fi
# A note an earlier restore left belongs to the database that was there.
superuser_command "comment on role opengewerk_app is null"
level_after=$(migration_level)

# --- Restore the file store ------------------------------------------------
# What check 2 let through, from the folder it checked: nothing that goes into
# the store now is read from the archive.
echo "  Dateispeicher wird zurückgespielt."
# With the rights of the store's owner, see above. Root reads the checked
# folder, which lies in this container where the application cannot reach it,
# and the owner unpacks it into the store: every file it writes is its own,
# also when the copy fails halfway, a full disk say, so the next restore, the
# one the message asks for, finds the owner on the store (#1000). umask 0
# keeps the modes the files have in the archive, as a copy by root did.
# Through a pipe only the status of its last command counts, so the tar that
# packs leaves a mark that stands until it went through. A mark that cannot be
# written ends the run here, before the store is emptied.
pack_pending="${work}/pack-pending"
: >"$pack_pending"
as_store_owner find "$STORAGE_PATH" -mindepth 1 -delete
{ tar --create --file - --directory "$staged" . && rm -f "$pack_pending"; } |
	as_store_owner sh -c 'umask 0 && exec tar --extract --no-same-owner --file - --directory "$1"' \
		sh "$STORAGE_PATH"
if [ -e "$pack_pending" ]; then
	exit 1
fi
rm -rf "$staged"

# --- Check 3: is the audit log the same log? -------------------------------
echo "  Audit-Ketten werden gegen die Sicherung geprüft."
mismatch=0

while IFS="$(printf '\t')" read -r tenant sequence head; do
	[ -n "$tenant" ] || continue

	# Locked and checked for each tenant: a check made once before the loop
	# would not hold for the reads after it.
	current=$(checked_query audit_chains "tenant_id next_sequence head_hash" \
		"select next_sequence || '|' || coalesce(head_hash, '') from only public.audit_chains where tenant_id = '${tenant}'") ||
		exit 1

	if [ "$current" != "${sequence}|${head}" ]; then
		echo "    Mandant ${tenant}: die Kette weicht von der Sicherung ab." >&2
		echo "      Sicherung:      ${sequence}|${head}" >&2
		echo "      zurückgespielt: ${current}" >&2
		mismatch=$((mismatch + 1))
	fi
done <"${work}/audit-chains.tsv"

if [ "$mismatch" -gt 0 ]; then
	echo "Bei ${mismatch} Mandant(en) passt die Audit-Kette nicht zur Sicherung." >&2
	exit 1
fi

chains=$(wc -l <"${work}/audit-chains.tsv" | tr -d ' ')
echo "    ${chains} Kette(n) stimmen mit der Sicherung überein."

if [ "$level_before" -eq 0 ] || [ "$level_after" -lt "$level_before" ] || [ "$was_locked" = t ]; then
	waiting=1
	superuser_command "comment on role opengewerk_app is '${waiting_note}'"
fi

echo "Fertig."
if [ "$waiting" -eq 1 ]; then
	if [ "$level_after" -lt "$level_before" ]; then
		echo "Die Sicherung stammt von einer älteren Fassung als die Datenbank davor."
		# The way back after an update starts the older version next, and up to
		# 0.8.0 its start.sh does not know the note.
		echo "Startet danach eine Fassung bis 0.8.0, gibt ihr Start die Anmeldung nicht"
		echo "zurück. Dann vorher im Ordner der Installation die laufende Anwendung"
		echo "anhalten, damit sie nicht auf dem älteren Schema arbeitet, und erst dann"
		echo "die Anmeldung zurückgeben:"
		echo "  docker compose -f docker/compose.yaml stop app backup-schedule"
		echo "  docker compose -f docker/compose.yaml exec postgres psql -U postgres -c \"alter role opengewerk_app login; comment on role opengewerk_app is null\""
	elif [ "$level_before" -eq 0 ]; then
		echo "Die Datenbank davor hatte keine Migrationen, welchen Stand die Anwendung"
		echo "braucht, ist also offen."
	else
		echo "Die Anwendung war schon vor diesem Lauf ausgesperrt, von einem früheren"
		echo "Rückspielen."
	fi
	echo "Die Anwendung bleibt ausgesperrt, bis die Migrationen gelaufen sind; das"
	echo "erledigt der Start, und danach bekommt sie ihre Anmeldung zurück."
fi
echo "Jetzt im Ordner der Installation starten; das braucht Docker Engine ab 28.3.3"
echo "und führt auch die Migrationen aus, wenn die Sicherung von einer älteren"
echo "Fassung stammt:"
echo "  sh docker/start.sh"
