#!/bin/sh
# Plays a backup back into an instance, and checks afterwards that what came
# back is what went in.
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
# The checks after the restore are the reason this is a script and not a page
# in a manual. A restore that silently produced half a database would be found
# weeks later, by an auditor rather than by an operator.
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
cleanup() {
	rm -rf "$work" "$held"
}
trap cleanup EXIT

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

for part in manifest.json database.dump storage.tar audit-chains.tsv; do
	if [ ! -f "${work}/${part}" ]; then
		echo "In der Sicherung fehlt ${part}. Sie ist unvollständig." >&2
		exit 1
	fi
done

# --- Check 1: did the archive arrive whole? --------------------------------
echo "  Prüfsummen werden geprüft."
for part in database.dump storage.tar audit-chains.tsv; do
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

unlock_application() {
	superuser_command "alter role opengewerk_app login; comment on role opengewerk_app is null"
}

# Locked before this run starts: by an earlier restore that did not go through,
# or by one that waits for the migrations.
was_locked=$(psql --host "$POSTGRES_HOST" --username postgres --dbname postgres --quiet \
	--tuples-only --no-align \
	--command "select not rolcanlogin from pg_catalog.pg_roles where rolname = 'opengewerk_app'")

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
	if [ "$1" -eq 0 ]; then
		[ "$waiting" -eq 1 ] || unlock_application || true
	elif [ "$replaced" -eq 1 ]; then
		superuser_command "comment on role opengewerk_app is null" || true
		echo "" >&2
		echo "Die Anwendung bleibt ausgesperrt: die Datenbank ist schon zurückgespielt," >&2
		echo "der Rest nicht. Das Rückspielen noch einmal laufen lassen und danach" >&2
		echo "starten; der Start gibt der Anwendung die Anmeldung zurück." >&2
	elif [ "$was_locked" = t ]; then
		echo "" >&2
		echo "Die Anwendung bleibt ausgesperrt, wie sie es vor diesem Lauf war: ein" >&2
		echo "früheres Rückspielen ist nicht durchgelaufen oder wartet auf die Migrationen." >&2
	else
		unlock_application || true
	fi
	cleanup
}
trap 'unlock_and_cleanup "$?"' EXIT

echo "  Anwendung wird für die Dauer des Rückspielens ausgesperrt."
lock_application

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

	FOR item IN
		SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(t.typname) AS name,
		       CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END AS kind
		  FROM pg_catalog.pg_type t
		  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
		 WHERE n.nspname = 'public'
		   AND t.typtype IN ('e', 'd', 'r', 'm')
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
PGPASSWORD="$OPENGEWERK_OWNER_PASSWORD" PGOPTIONS="-c client_min_messages=warning" \
	psql --host "$POSTGRES_HOST" --username opengewerk_owner --dbname "$POSTGRES_DB" \
	--no-psqlrc --quiet --single-transaction --set ON_ERROR_STOP=1 \
	--file "${work}/empty.sql" --file "${work}/database.sql" >/dev/null
replaced=1
# A note an earlier restore left belongs to the database that was there.
superuser_command "comment on role opengewerk_app is null"
level_after=$(migration_level)

# --- Restore the file store ------------------------------------------------
echo "  Dateispeicher wird zurückgespielt."
mkdir -p "$STORAGE_PATH"

# Read before anything is unpacked. This container runs as root, the
# application does not, so files restored with root's ownership would be
# readable and undeletable for the very process that needs them. The
# directory itself already carries the right owner, so it is the one to ask.
storage_owner=$(stat -c '%u:%g' "$STORAGE_PATH")

find "$STORAGE_PATH" -mindepth 1 -delete
tar --extract --no-same-owner --file "${work}/storage.tar" --directory "$STORAGE_PATH"
chown -R "$storage_owner" "$STORAGE_PATH"

# --- Check 2: is every file still the file its name claims? ----------------
# ADR 0007 asks for a sample. This checks all of them, because it costs
# seconds on the amount of data an instance keeps and a sample answers
# "probably" where this answers "yes".
echo "  Dateispeicher wird gegen die Hashes geprüft."

# Built as a checklist and handed to sha256sum, rather than compared in a
# loop. A loop behind a pipe runs in a subshell, so its counters are gone by
# the time anybody looks at them, and the check would report nothing while
# appearing to work. sha256sum -c carries the verdict in its exit code.
: >"${work}/expected.sha256"

find "$STORAGE_PATH" -type f | while read -r file; do
	name=$(basename "$file")

	# Only files whose name is a SHA-256 in hex. Anything else is not a stored
	# object and gets no opinion from this check.
	case "$name" in
	*[!0-9a-f]*) continue ;;
	esac
	[ "${#name}" -eq 64 ] || continue

	printf '%s  %s\n' "$name" "$file" >>"${work}/expected.sha256"
done

expected_files=$(wc -l <"${work}/expected.sha256" | tr -d ' ')
files=$(find "$STORAGE_PATH" -type f | wc -l | tr -d ' ')

if [ "$expected_files" -gt 0 ]; then
	# -s rather than --quiet: this runs on busybox, which has the short option
	# and not the long one. On failure the same check runs again without it,
	# because "something is broken" without naming the file leaves an operator
	# to go looking through the whole store by hand.
	if ! sha256sum -cs "${work}/expected.sha256"; then
		echo "Der Inhalt einzelner Dateien passt nicht mehr zu ihrem Namen. In einem" >&2
		echo "inhaltsadressierten Speicher heißt das, sie sind beschädigt:" >&2
		sha256sum -c "${work}/expected.sha256" 2>&1 | grep -v ': OK$' >&2 || true
		exit 1
	fi
fi

echo "    ${files} Datei(en) im Speicher, ${expected_files} davon gegen ihren Hash geprüft."

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
		echo "zurück; dann vorher im Ordner der Installation:"
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
echo "Jetzt im Ordner der Installation starten, das führt auch die Migrationen aus,"
echo "wenn die Sicherung von einer älteren Fassung stammt:"
echo "  sh docker/start.sh"
