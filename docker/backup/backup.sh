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
#    packed first, then the database is dumped, and then every file written
#    since a mark set before the first pack goes into a second, small part.
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
	# turn the answer round as soon as there is more than one.
	if ! grep -q -f "${work}/vanished.patterns" "$1" ||
		grep -v -f "${work}/vanished.patterns" -e '^tar: error exit delayed from previous errors$' "$1" >/dev/null; then
		echo "  Beim Lesen des Dateispeichers kam ein Fehler, die Sicherung bricht ab:" >&2
		cat "$1" >&2
		return 1
	fi
}

# --- 1. The file store, before the database --------------------------------
# See the note at the top. The mark is set a second before tar starts: a file
# written in the second of the mark goes into this part, and one written while
# or after tar runs has a later time and goes into the second part. Only
# stored files, as in the second part: a .part or .gone is renamed any moment.
# A file that is gone by the time tar comes to it was one of those or one the
# sweep took, which no row names any more, so tar may say "No such file or
# directory" for a path in the store and nothing else.
echo "  Dateispeicher wird gesichert."
mark="${work}/storage.mark"
: >"$mark"
sleep 1
if ! tar --create --file "${work}/storage.tar" --directory "$STORAGE_PATH" \
	--exclude '*.part' --exclude '*.gone' . 2>"${work}/storage.err"; then
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

# --- 4. What the store got since the mark ---------------------------------
# Every file written after the mark, an upload while the backup ran above all.
# Copied first and packed as a folder, so that a part with no file in it is
# still a valid archive. Only stored files: a write still under way as .part
# or a file set aside as .gone is renamed any moment, and neither is a file a
# row names. A file gone between find and cp was one of those, or one the
# sweep took, which is old and in the first part; a new file is younger than
# the grace of the sweep and stays.
echo "  Nachträge im Dateispeicher werden gesichert."
# find looks at every entry before it reads its name, so a .part that goes
# while it walks makes it say "No such file or directory" as well.
mkdir "${work}/storage-late"
if ! (cd "$STORAGE_PATH" && find . -type f -newer "$mark" ! -name '*.part' ! -name '*.gone') \
	>"${work}/storage-late.list" 2>"${work}/storage-late.err"; then
	only_vanished "${work}/storage-late.err" || exit 1
fi
# Copied as what it is: a name swapped for a link between find and cp stays
# a link, which is then taken out, and never brings the file it points at,
# one of this container perhaps, into the archive. A folder on the way may be
# swapped for a link as well, and cp follows that one; so a copy stays only
# when its name is the SHA-256 of what it holds, which a file from anywhere
# else cannot be.
while IFS= read -r file; do
	mkdir -p "${work}/storage-late/$(dirname "$file")"
	cp -P -p "${STORAGE_PATH}/${file}" "${work}/storage-late/${file}" || {
		# Whatever cp left of a failed copy goes, so no half file is packed.
		rm -f "${work}/storage-late/${file}"
		[ ! -e "${STORAGE_PATH}/${file}" ]
	}
	copy="${work}/storage-late/${file}"
	if [ -f "$copy" ] && [ ! -L "$copy" ] &&
		[ "$(sha256sum <"$copy" | cut -d' ' -f1)" != "$(basename "$file")" ]; then
		rm -f "$copy"
	fi
done <"${work}/storage-late.list"
find "${work}/storage-late" ! -type f ! -type d -exec rm -f {} \;
rm -f "${work}/storage-late.list" "${work}/storage-late.err"
tar --create --file "${work}/storage-late.tar" --directory "${work}/storage-late" .
rm -rf "${work}/storage-late" "$mark" "${work}/vanished.patterns"

# --- 5. The manifest -------------------------------------------------------
# A checksum per part, so that a restore can tell a damaged archive from a
# complete one before it touches a running database.
echo "  Prüfsummen werden berechnet."
database_hash=$(sha256sum "${work}/database.dump" | cut -d' ' -f1)
storage_hash=$(sha256sum "${work}/storage.tar" | cut -d' ' -f1)
late_hash=$(sha256sum "${work}/storage-late.tar" | cut -d' ' -f1)
chains_hash=$(sha256sum "${work}/audit-chains.tsv" | cut -d' ' -f1)
storage_files=$(find "$STORAGE_PATH" -type f | wc -l | tr -d ' ')
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
