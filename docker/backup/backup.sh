#!/bin/sh
# Writes one backup: the database, the file store and the heads of the audit
# chains, in a single archive.
#
# Three things in here are decisions rather than mechanics.
#
# 1. THE FILE STORE IS PACKED AROUND THE DATABASE, once before the dump and
#    once after it. A row points at a file by its hash. Packed only before,
#    anything uploaded between the two steps has a row in the dump and no file
#    in the archive. Packed only after, a file whose last row went after the
#    dump could be taken by the sweep of the store before tar reached it
#    (#991), and the dump would name a file the archive lacks. So the store is
#    packed first, then the database is dumped, and then every file of the
#    store that the first part does not hold goes into a second, small part.
#    Which files that are is read from the first part, not from any clock.
#    The worst case left is a file nobody references, and an unreferenced
#    file in a content addressed store costs disk and nothing else.
#
# 2. IT CONNECTS AS THE SUPERUSER, not as the owner of the tables. Row level
#    security is FORCEd on every table, and it applies to the owner as well,
#    so a dump taken as the owner would be refused by pg_dump or, worse, come
#    back empty. A backup that is allowed to see less than everything is not a
#    backup.
#
# 3. IT RECORDS THE HEAD OF EVERY AUDIT CHAIN. The chain in the database
#    proves that nobody made a small correction; it cannot prove anything
#    against somebody who rewrites every entry from the changed one onwards,
#    because the rewritten chain fits again. A head kept outside the database
#    pins everything written before it. That is what turns the chain into
#    evidence, and it costs one small file.
#
# And the archive reaches the target only encrypted, and only whole
# (opengewerk-haustechnik#360). The parts are written inside this container,
# readable by nobody but root, and packed and encrypted in one stream into a
# hidden file on the target, which gets the name of an archive at the very
# end. Whatever fails before that takes the hidden file and the parts with it.
# Only then is the name and the SHA-256 of the archive recorded on the
# instance, which restore.sh and verify.sh hold every archive to, see
# archive-checks.sh.
#
# Called with --scheduled by the nightly schedule (schedule.sh), it skips an
# instance that has no tenant: after a lost disk the empty instance would
# otherwise become the newest archive. After every backup it records when it
# finished in BACKUP_STATUS_PATH, which the office reads (#130).

set -eu

# The archive is packed and encrypted in a pipe, and a pipe answers with the
# status of its last command alone: a tar that broke off would leave age to
# encrypt what it got and report success. The shell of the image, busybox sh,
# knows pipefail; a shell that does not stops here rather than without it.
set -o pipefail

# Dump, file store and archive hold every tenant. Nothing written here is for
# anybody but the user running it; the record the office reads is made
# readable on purpose below.
umask 077

scheduled=false

if [ "${1:-}" = "--scheduled" ]; then
	scheduled=true
fi

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_DB:=opengewerk}"
: "${STORAGE_PATH:=/var/lib/opengewerk/storage}"
: "${BACKUP_PATH:=/var/lib/opengewerk/backups}"
: "${BACKUP_KEEP:=14}"

# The names of the archives, in one place for backup, restore and verify.
. "$(dirname "$0")/names.sh"

# Reading the database as postgres without running what it defines.
. "$(dirname "$0")/superuser-reads.sh"

if [ -z "${PGPASSWORD:-}" ]; then
	echo "PGPASSWORD fehlt. Die Sicherung meldet sich als Superuser an, weil sie" >&2
	echo "sonst wegen der Mandantentrennung leere Tabellen sichern würde." >&2
	exit 1
fi

if [ ! -d "$STORAGE_PATH" ]; then
	echo "Der Dateispeicher unter $STORAGE_PATH fehlt. Ist das Volume eingehängt?" >&2
	exit 1
fi

if [ "$scheduled" = true ]; then
	# A database that is not migrated yet has no table of tenants at all, and
	# nothing in it to back up either.
	migrated=$(superuser_query --command "select to_regclass('public.tenants') is not null")
	tenants=0

	if [ "$migrated" = "t" ]; then
		tenants=$(checked_query tenants "" "select count(*) from only public.tenants") || exit 1
	fi

	if [ "$tenants" = "0" ]; then
		echo "Keine Mandanten in der Datenbank. Die geplante Sicherung wird übersprungen, damit"
		echo "eine leere Instanz keine ältere Sicherung mit Daten verdrängt. Von Hand geht sie weiter."
		exit 0
	fi
fi

mkdir -p "$BACKUP_PATH"

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
name="${BACKUP_PREFIX}-${stamp}"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
	archive="${BACKUP_PATH}/${name}.tar.gz.age"
else
	archive="${BACKUP_PATH}/${name}.tar.gz"
fi

# The parts are written here, in the container, and never on the target: on a
# share or a NAS a dump in the clear would lie there for as long as the backup
# runs, and in its snapshots for longer. TMPDIR moves it, for a machine whose
# containers have too little room for a dump and a copy of the file store.
work=$(mktemp -d)

# The archive is written under a hidden name, which the names of archives do
# not match (names.sh), and renamed when it is whole. mktemp makes the name
# up and creates the file, so nobody who writes to the target can lay a link
# there beforehand for the archive to be written through.
partial=''
renamed=false
recorded=false

# Where the checksum and the size of the archive are taken on its way to the
# target, see step 5. A folder of its own, beside the parts and not among
# them, since the parts folder is what is packed.
measured=''
hasher=''
counter=''

# Anything that fails before the record is written leaves nothing behind on
# the target, neither a half archive nor a whole one nobody recorded: a backup
# directory holding a file that looks like a backup and is none is worse than
# one holding nothing. A signal ends the script through the same way out.
cleanup() {
	for reader in $hasher $counter; do
		kill "$reader" 2>/dev/null || true
	done

	rm -rf "$work" "$measured"
	rm -f "$partial"

	if [ "$renamed" = true ] && [ "$recorded" = false ]; then
		rm -f "$archive"
	fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

partial=$(mktemp -p "$BACKUP_PATH" ".${name}.XXXXXX")

echo "Sicherung ${name} wird erstellt."

# busybox sh does not understand $'\t', so the tab is built instead of written.
tab=$(printf '\t')

# Whether what tar or find said about the store is only that files went while
# it read them: busybox names a path of the store it found gone, in one of
# three forms, and sums up at the end. Anything else, and a failure that names
# no gone path at all, is printed and ends the backup.
only_vanished() {
	cat >"${work}/vanished.patterns" <<'PATTERNS'
^tar: \./.*: No such file or directory$
^tar: can't open '\./.*': No such file or directory$
^find: \./.*: No such file or directory$
PATTERNS

	# The status of grep -v itself, not of a pipe into grep -q: that one quits
	# at the first line, and under pipefail the writer it leaves behind would
	# turn the answer round as soon as there is more than one. And only its 1,
	# no other line, is good news; a 2 is a grep that could not read.
	others=0
	if grep -q -f "${work}/vanished.patterns" "$1"; then
		grep -v -f "${work}/vanished.patterns" -e '^tar: error exit delayed from previous errors$' \
			"$1" >/dev/null || others=$?
	fi
	if [ "$others" -ne 1 ]; then
		echo "  Beim Lesen des Dateispeichers kam ein Fehler, die Sicherung bricht ab:" >&2
		cat "$1" >&2
		return 1
	fi
}

# Seconds since the machine started, which no change of the clock moves. The
# path is only ever another one in test-backup.sh.
uptime_seconds() {
	up=''
	read -r up _ <"${UPTIME_PATH:-/proc/uptime}" || true
	up=${up%.*}
	case "$up" in
	'' | *[!0-9]*)
		echo "  Die Laufzeit der Sicherung lässt sich nicht messen, sie bricht ab." >&2
		return 1
		;;
	esac
	echo "$up"
}

# tar over the store, within what is left of the twelve hours below. busybox
# tar looks at a file and opens it after: a name swapped for a pipe in between
# makes it wait on that pipe for good, and a backup that hangs backs nothing up
# from then on. Ends the backup when the time runs out. $1 takes what tar
# says, the sentence here goes to where the backup speaks.
store_tar() {
	tar_said=$1
	shift
	left=$(time_left) || exit 1
	status=0
	timeout "$left" tar "$@" 2>"$tar_said" || status=$?
	out_of_time "$status"
	return "$status"
}

# Seconds left of the twelve hours, one at least, so that a read started late
# ends at once.
time_left() {
	now=$(uptime_seconds) || return 1
	left=$((started + 43200 - now))
	[ "$left" -gt 0 ] || left=1
	echo "$left"
}

# Ends the backup when a read of the store was ended by its limit.
out_of_time() {
	case "$1" in
	124 | 143)
		echo "  Das Lesen des Dateispeichers kam in zwölf Stunden nicht zum Ende, die Sicherung bricht ab." >&2
		exit 1
		;;
	esac
}

# --- 1. The file store, before the database --------------------------------
# See the note at the top. Only stored files, as in the second part: a .part
# or .gone is renamed any moment. A file that is gone by the time tar comes to
# it was one of those or one the sweep took, which no row names any more, so
# tar may say "No such file or directory" for a path in the store and nothing
# else.
echo "  Dateispeicher wird gesichert."
started=$(uptime_seconds)
if ! store_tar "${work}/storage.err" --create --file "${work}/storage.tar" --directory "$STORAGE_PATH" \
	--exclude '*.part' --exclude '*.gone' .; then
	only_vanished "${work}/storage.err" || exit 1
fi
rm -f "${work}/storage.err"

# --- 2. The database -------------------------------------------------------
# Custom format, because it restores selectively and compresses on the way.
echo "  Datenbank wird gesichert."
pg_dump --host "$POSTGRES_HOST" --username postgres --dbname "$POSTGRES_DB" \
	--format custom --compress 6 --file "${work}/database.dump"

# --- 3. The heads of the audit chains --------------------------------------
# Read with the same connection, right after the dump, so the heads describe
# the state the dump holds.
echo "  Audit-Ketten werden festgehalten."
checked_query audit_chains "tenant_id next_sequence head_hash" \
	"select tenant_id, next_sequence, coalesce(head_hash, '') from only public.audit_chains order by tenant_id" \
	--field-separator="$tab" >"${work}/audit-chains.tsv" || exit 1

# --- 4. What the first part does not hold ----------------------------------
# Every stored file the store holds now and the first part does not: an upload
# while the backup ran above all, but also one tar did not meet on its way or
# one the sweep had set aside while tar passed. Read from the first part and
# not from a clock, so a clock that jumps changes nothing. Only names of the
# layout of the store, two folders and the hash, so neither a .part, a .gone
# nor a name somebody made up comes in.
#
# A file the sweep takes is one no row names. Whatever the dump names was put
# before the dump, and the sweep only takes what is older than its grace of a
# day; so this holds as long as the store is read within less than that, and a
# backup that has taken half of it by then stops instead, see below.
echo "  Nachträge im Dateispeicher werden gesichert."
# The two folders are the first four characters of the hash, as FileStore
# lays them out; a hash under any other folders is no stored file.
layout='^\./\([0-9a-f][0-9a-f]\)/\([0-9a-f][0-9a-f]\)/\1\2[0-9a-f]\{60\}$'

# grep says 1 when no line fits, which here is an empty list and no error.
names_of() {
	grep "$layout" "$1" || [ $? -eq 1 ]
}

# Only plain files of the first part count as held: a link there under a name
# of the store is not the file a later upload put in its place.
# The whole name, everything after the five columns before it, and not only
# its last word: a file named "./Import ./ab/cd/<hash>" is not that hash. Cut
# from the line as it is, column by column, and not by setting the columns,
# which would build the line anew and take a blank at the end of the name.
tar --list --verbose --file "${work}/storage.tar" |
	awk '$1 ~ /^-/ { name = $0; for (i = 1; i <= 5; i++) sub(/^[^ ]+ +/, "", name); print name }' \
		>"${work}/storage.names"
# Every entry of the first part on a line of its own: a name with a line
# break could let a part of it pass for an entry in the listing above. tar
# lists every name of the first part starting with "./", so a line that does
# not is the rest of one, and the only kind of rest that could pass for an
# entry there, which starts with the type of a file. The store never makes
# such a name; the backup stops instead of guessing. A rest that starts with
# "./" passes for no entry in the listing (no type in front), so it is let be.
odd_lines=$(tar --list --file "${work}/storage.tar" | grep -cv '^\./' || true)
if [ "$odd_lines" != 0 ]; then
	echo "  Im Dateispeicher steht ein Name über mehrere Zeilen, den der Speicher nie anlegt;" >&2
	echo "  die Sicherung bricht ab." >&2
	exit 1
fi
names_of "${work}/storage.names" | sort >"${work}/storage.first"

# find looks at every entry before it reads its name, so a .part that goes
# while it walks makes it say "No such file or directory" as well. It walks
# within the twelve hours like tar.
left=$(time_left) || exit 1
status=0
(cd "$STORAGE_PATH" && timeout "$left" find . -type f) >"${work}/storage.now" 2>"${work}/storage-late.err" ||
	status=$?
out_of_time "$status"
if [ "$status" -ne 0 ]; then
	only_vanished "${work}/storage-late.err" || exit 1
fi
names_of "${work}/storage.now" | sort | comm -13 "${work}/storage.first" - >"${work}/storage-late.list"

# Packed straight from the store with tar, which reads no file it was not
# given and stores a link or a pipe it finds as what it is; one swapped in
# while it reads is what the limit of store_tar is for.
# Unpacked into a folder of its own, a file stays only when it is a plain file
# whose name is the SHA-256 of what it holds: a name swapped for a link, a
# pipe, or a folder swapped for a link to somewhere in this container between
# find and tar cannot be that.
mkdir "${work}/storage-late"
if [ -s "${work}/storage-late.list" ]; then
	if ! store_tar "${work}/storage-late.err" --create --no-recursion --file "${work}/storage-late.raw" \
		--directory "$STORAGE_PATH" -T "${work}/storage-late.list"; then
		only_vanished "${work}/storage-late.err" || exit 1
	fi
	tar --extract --no-same-owner --file "${work}/storage-late.raw" --directory "${work}/storage-late"
	rm -f "${work}/storage-late.raw"
fi
# Nothing but files and the two folders above them: a name of the list that
# had become a folder by the time tar came is packed as an empty folder only
# (--no-recursion) and goes here with whatever else lies that deep.
find "${work}/storage-late" ! -type f ! -type d -exec rm -f {} \;
find "${work}/storage-late" -mindepth 3 -type d -prune -exec rm -rf {} \;
# find takes a failed rm for a test that did not hold and goes on, so what is
# left is looked at once more; a find that cannot read ends the backup under
# set -e, through the assignments.
left_odd=$(find "${work}/storage-late" ! -type f ! -type d)
left_deep=$(find "${work}/storage-late" -mindepth 3 -type d)
if [ -n "$left_odd" ] || [ -n "$left_deep" ]; then
	echo "  Im zweiten Teil blieb etwas, das keine Datei des Speichers ist, die Sicherung bricht ab." >&2
	exit 1
fi
find "${work}/storage-late" -type f >"${work}/storage-late.files"
while IFS= read -r copy; do
	held_hash=$(sha256sum "$copy" | cut -d' ' -f1)
	held_path=$(printf '%s' "$held_hash" | cut -c1-2)/$(printf '%s' "$held_hash" | cut -c3-4)/$held_hash
	if [ "${copy#"${work}/storage-late/"}" != "$held_path" ]; then
		rm -f "$copy"
	fi
done <"${work}/storage-late.files"
tar --create --file "${work}/storage-late.tar" --directory "${work}/storage-late" .

# What the archive holds, counted from its two parts and not from the store,
# which goes on changing: a .part renamed while find walked it would end the
# backup here.
storage_files=$(($(wc -l <"${work}/storage.first") + $(find "${work}/storage-late" -type f | wc -l)))

# The store is read. Did that take half the grace of the sweep or more, the
# second part may lack a file the sweep took meanwhile; this backup stops.
read_done=$(uptime_seconds)
if [ $((read_done - started)) -ge 43200 ]; then
	echo "  Die Sicherung läuft seit zwölf Stunden oder länger, das Aufräumen des" >&2
	echo "  Dateispeichers könnte inzwischen Dateien nehmen, die der Dump nennt." >&2
	echo "  Sie bricht ab; eine Sicherung braucht sonst Minuten." >&2
	exit 1
fi
rm -rf "${work}/storage-late" "${work}/storage-late.files" "${work}/storage-late.list" \
	"${work}/storage-late.err" "${work}/storage.names" "${work}/storage.first" "${work}/storage.now" \
	"${work}/vanished.patterns"

# --- 5. The manifest -------------------------------------------------------
# A checksum per part, so that a restore can tell a damaged archive from a
# complete one before it touches a running database.
echo "  Prüfsummen werden berechnet."
database_hash=$(sha256sum "${work}/database.dump" | cut -d' ' -f1)
storage_hash=$(sha256sum "${work}/storage.tar" | cut -d' ' -f1)
late_hash=$(sha256sum "${work}/storage-late.tar" | cut -d' ' -f1)
chains_hash=$(sha256sum "${work}/audit-chains.tsv" | cut -d' ' -f1)
chains=$(wc -l <"${work}/audit-chains.tsv" | tr -d ' ')
server_version=$(superuser_query --command "show server_version")

cat >"${work}/manifest.json" <<JSON
{
  "name": "${name}",
  "created": "${stamp}",
  "postgres": "${server_version}",
  "order": "storage-database-late",
  "parts": {
    "database.dump": "${database_hash}",
    "storage.tar": "${storage_hash}",
    "storage-late.tar": "${late_hash}",
    "audit-chains.tsv": "${chains_hash}"
  },
  "storageFiles": ${storage_files},
  "auditChains": ${chains}
}
JSON

# --- 6. Pack, and encrypt when a key is there ------------------------------
# In one stream into the hidden file: the packed archive in the clear exists
# nowhere, not on the target and not here.
#
# The checksum that goes into the record, and the size, are taken of that
# stream inside this container, through tee, on its way to the target, and
# never read back from there (opengewerk-haustechnik#360). Read back, they
# would be the ones of whatever lies on the target by then, and whoever writes
# there could have put an archive of their own in place of the hidden file
# and have it recorded as one this instance wrote. Two named pipes, since sh
# has no process substitution; their readers run beside the stream.
measured=$(mktemp -d)
mkfifo "${measured}/hash" "${measured}/count"
sha256sum <"${measured}/hash" >"${measured}/hash.out" &
hasher=$!
wc -c <"${measured}/count" >"${measured}/count.out" &
counter=$!

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
	# A public key encrypts, and only the private key decrypts. The machine
	# making backups therefore cannot read its own older ones, which is the
	# point: whoever takes over the server does not get the archive with it.
	echo "  Sicherung wird gepackt und verschlüsselt."
	tar --create --gzip --file - --directory "$work" . |
		age --recipient "$BACKUP_AGE_RECIPIENT" |
		tee "${measured}/hash" "${measured}/count" >"$partial"
else
	echo "  WARNUNG: BACKUP_AGE_RECIPIENT ist nicht gesetzt, die Sicherung liegt"
	echo "  unverschlüsselt. Sie enthält Kundendaten und Belege."
	tar --create --gzip --file - --directory "$work" . |
		tee "${measured}/hash" "${measured}/count" >"$partial"
fi

wait "$hasher"
wait "$counter"
hasher=''
counter=''
archive_hash=$(cut -d' ' -f1 "${measured}/hash.out")
archive_bytes=$(tr -d ' ' <"${measured}/count.out")

case "$archive_hash" in
'' | *[!0-9a-f]*)
	echo "Die Prüfsumme der Sicherung ließ sich nicht bilden." >&2
	exit 1
	;;
esac

# A second backup in the same second would take the name of the first, and
# when it failed after that, the first with it.
if [ -e "$archive" ]; then
	echo "Unter dem Namen $(basename "$archive") liegt schon eine Sicherung. Eine zweite in" >&2
	echo "derselben Sekunde wird nicht geschrieben." >&2
	exit 1
fi

mv "$partial" "$archive"
renamed=true

# --- 7. The record of the archive and the one the office reads -------------
# Both on the instance, never on the target, and both written under a
# temporary name and moved into place: the office never reads a record of a
# backup that is not there, and restore.sh never finds half a line.
# archives.sha256 keeps every archive this instance wrote, also after the
# retention took it off the target, so that one fetched back from elsewhere
# can still be held to it; a line is about a hundred bytes. last.json is read
# by the application, which runs as another user, and is made readable for it.
# Under a lock, because the nightly backup and one by hand can finish at the
# same moment, and the one that read the record first would otherwise write
# it back without the line of the other.
if [ -n "${BACKUP_STATUS_PATH:-}" ]; then
	# A folder made here has to let the application through to last.json.
	mkdir -p -m 0755 "$BACKUP_STATUS_PATH"
	record="${BACKUP_STATUS_PATH}/archives.sha256"
	encrypted=false

	if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
		encrypted=true
	fi

	(
	flock 9

	{
		if [ -f "$record" ]; then
			cat "$record"
		fi
		printf '%s  %s\n' "$archive_hash" "$(basename "$archive")"
	} >"${record}.tmp"

	cat >"${BACKUP_STATUS_PATH}/.last.json" <<JSON
{
  "finished": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "finishedEpoch": $(date +%s),
  "archive": "$(basename "$archive")",
  "sha256": "${archive_hash}",
  "bytes": ${archive_bytes},
  "encrypted": ${encrypted},
  "storageFiles": ${storage_files},
  "auditChains": ${chains}
}
JSON
	chmod 0644 "${BACKUP_STATUS_PATH}/.last.json"
	mv "${record}.tmp" "$record"
	mv "${BACKUP_STATUS_PATH}/.last.json" "${BACKUP_STATUS_PATH}/last.json"
	) 9>"${BACKUP_STATUS_PATH}/.lock"
else
	echo "  WARNUNG: BACKUP_STATUS_PATH ist nicht gesetzt, die Sicherung steht in keinem"
	echo "  Verzeichnis. Zurückspielen lässt sie sich nur mit --skip-origin-check."
fi

recorded=true

# --- 8. Retention ----------------------------------------------------------
# Oldest first, keep the newest BACKUP_KEEP. Sorting by name works because the
# timestamp is the name and it is written in a sortable shape. Only archives of
# this prefix count, see names.sh. After the record, so that a retention that
# fails takes nothing of the new archive back.
if [ "$BACKUP_KEEP" -gt 0 ]; then
	total=$(find "$BACKUP_PATH" -maxdepth 1 -name "$archives" | wc -l | tr -d ' ')
	surplus=$((total - BACKUP_KEEP))

	if [ "$surplus" -gt 0 ]; then
		echo "  ${surplus} alte Sicherung(en) werden entfernt, ${BACKUP_KEEP} bleiben."
		find "$BACKUP_PATH" -maxdepth 1 -name "$archives" | sort | head -n "$surplus" |
			while read -r old; do
				rm -f "$old"
				echo "    entfernt: $(basename "$old")"
			done
	fi
fi

size=$(du -h "$archive" | cut -f1)
echo "Fertig: ${archive} (${size}, ${storage_files} Dateien, ${chains} Mandanten)"
