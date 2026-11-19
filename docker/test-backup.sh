#!/bin/sh
# Exercises the names of the archives (opengewerk-haustechnik#14) with the
# backup scripts themselves and stand-ins for the tools of PostgreSQL: an
# archive is named after its database unless BACKUP_PREFIX says otherwise, the
# retention removes only archives of its own prefix, "latest" is the newest of
# its own, and an archive named outright is taken only if it is one of its own.
# All of it in one folder with the archives of another application whose
# prefix begins with this one's, the case a bare "<prefix>-*" gets wrong.
#
# Then what a restore turns away before it asks anything of the database: an
# archive that unpacks cleanly and does not hold what its manifest says
# (opengewerk-haustechnik#31), an archive this instance did not write or that
# is in the clear where the installation encrypts, and a file of chains that
# holds something other than chains (opengewerk-haustechnik#360). And how a
# backup reaches the target: encrypted in one stream, never in the clear, and
# when anything fails on the way not at all. Whether a whole instance comes
# back out of an archive is the job of the CI run that backs one up and
# restores it.
#
# Runs in the image of the backup, with its shell, its tar and a real age:
#
#   docker build --tag opengewerk-backup-under-test backup
#   docker run --rm --volume "$PWD:/docker:ro" opengewerk-backup-under-test sh /docker/test-backup.sh
#
# Prints what it checks and stops at the first thing that is wrong.
set -eu

source_dir=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

real_age=$(command -v age) || {
  echo 'FEHLER: age fehlt. test-backup.sh läuft im Abbild der Sicherung, siehe oben.'
  exit 1
}
real_tar=$(command -v tar)
real_date=$(command -v date)
real_cp=$(command -v cp)
real_find=$(command -v find)
real_rm=$(command -v rm)
real_timeout=$(command -v timeout)

mkdir -p "$work/bin" "$work/storage" "$work/backups" "$work/status" "$work/tmp"
# A restore empties and fills the store as the store's owner, and where that is
# not root, the fakes in bin run as that user: it has to reach them. What else
# lies here keeps its own modes.
chmod 711 "$work"
cp "$source_dir/backup/backup.sh" "$source_dir/backup/restore.sh" \
  "$source_dir/backup/verify.sh" "$source_dir/backup/names.sh" \
  "$source_dir/backup/archive-checks.sh" "$source_dir/backup/superuser-reads.sh" \
  "$source_dir/backup/schedule.sh" "$work/bin/"

# A dump with something in it, a database without audit chains and a server
# with a version; whatever else the scripts ask is answered with nothing.
cat > "$work/bin/pg_dump" <<'FAKE'
#!/bin/sh
# While the dump runs, the sweep of the store may take a file whose last row
# just went, and somebody may upload one (#991).
# Where the store keeps a file: two folders from its hash, then the hash.
stored() {
  printf '%s/%s/%s/%s' "$STORAGE_PATH" "$(printf '%s' "$1" | cut -c1-2)" "$(printf '%s' "$1" | cut -c3-4)" "$1"
}
if [ -n "${DUMP_SWEEPS:-}" ]; then
  rm -f "$(stored "$DUMP_SWEEPS")"
fi
if [ -n "${DUMP_UPLOADS:-}" ]; then
  uploaded=$(stored "$(printf '%s' "$DUMP_UPLOADS" | sha256sum | cut -d' ' -f1)")
  mkdir -p "$(dirname "$uploaded")"
  rm -f "$uploaded"
  printf '%s' "$DUMP_UPLOADS" > "$uploaded"
fi
# A dump that takes more than half a day: the uptime UPTIME_PATH names jumps.
if [ -n "${UPTIME_JUMPS:-}" ]; then
  echo '60000.00 120000.00' > "$UPTIME_PATH"
fi
# A dump after which two seconds are left of the twelve hours.
if [ -n "${UPTIME_ALMOST:-}" ]; then
  echo '43298.00 86596.00' > "$UPTIME_PATH"
fi
# A machine whose uptime can no longer be read while the dump runs.
if [ -n "${UPTIME_GOES:-}" ]; then
  : > "$UPTIME_PATH"
fi
# A dump that waits for good, after the twelve hours are over, as one behind
# a lock would: it notes its process and becomes a sleep of ten minutes, or
# of DUMP_HANGS_FOR seconds.
if [ -n "${DUMP_HANGS:-}" ]; then
  [ -n "${UPTIME_GOES:-}" ] || echo '43400.00 86800.00' > "$UPTIME_PATH"
  echo "$$" > "$DUMP_HANGS"
  exec sleep "${DUMP_HANGS_FOR:-600}"
fi
# A dump that fails.
if [ -n "${DUMP_FAILS:-}" ]; then
  echo 'pg_dump: error: connection lost' >&2
  exit 1
fi
# A file named after its own hash that does not lie where the store keeps it.
if [ -n "${DUMP_ASTRAY:-}" ]; then
  mkdir -p "$STORAGE_PATH/00/00"
  printf '%s' "$DUMP_ASTRAY" > "$STORAGE_PATH/00/00/$(printf '%s' "$DUMP_ASTRAY" | sha256sum | cut -d' ' -f1)"
fi
# A write still under way, which is no stored file yet.
if [ -n "${DUMP_WRITES:-}" ]; then
  printf 'halb' > "$STORAGE_PATH/$DUMP_WRITES"
fi
while [ $# -gt 0 ]; do
  if [ "$1" = --file ]; then
    printf 'dump\n' > "$2"
  fi
  shift
done
FAKE
#
# Each writes down that it was called. A restore that is turned away has to be
# turned away before the first of them, the one that locks the application out
# included. The psql that plays the dump writes down whom it signs in as,
# with the password; pg_restore only turns the dump into statements.
cat > "$work/bin/psql" <<'FAKE'
#!/bin/sh
# The first call whose arguments hold PSQL_SLOW_ON takes three seconds, for a
# second stop to reach a restore that cleans up (#1007). PSQL_SLOW_MARK is a
# file it writes first: the process that started it and the process group of
# that one, the group of the run. A SIGINT for a process group, written down
# in PSQL_SLOW_MARK.sent, cancels its statement when the group is its own, the
# way psql answers one even when it is ignored: it ends without effect.
if [ -n "${PSQL_SLOW_ON:-}" ] && [ ! -e "$PSQL_SLOW_MARK" ]; then
  case "$*" in
    *"$PSQL_SLOW_ON"*)
      parent_stat=$(sed 's/.*) //' "/proc/$PPID/stat")
      printf '%s %s\n' "$PPID" "$(echo "$parent_stat" | cut -d' ' -f3)" > "$PSQL_SLOW_MARK"
      sleep 3
      psql_stat=$(sed 's/.*) //' "/proc/$$/stat")
      if [ -e "$PSQL_SLOW_MARK.sent" ] &&
        [ "$(cat "$PSQL_SLOW_MARK.sent")" = "$(echo "$psql_stat" | cut -d' ' -f3)" ]; then
        echo 'ERROR:  canceling statement due to user request' >&2
        exit 1
      fi
      ;;
  esac
fi
# With UNLOCK_FAILS the login cannot be given back.
if [ -n "${UNLOCK_FAILS:-}" ]; then
  case "$*" in
    *'alter role opengewerk_app login'*)
      echo 'psql: error: connection to server failed' >&2
      exit 2
      ;;
  esac
fi
printf 'psql %s\n' "$*" >> "$CALLS"
case " $* " in
  *" --single-transaction "*) printf 'restore-as %s password=%s\n' "$*" "${PGPASSWORD:-}" >> "$CALLS" ;;
esac
# The files it plays are written down as well, in their order, each line with
# the call that played it and whether that call was one transaction that stops
# at the first error.
mode=plain
case " $* " in
  *" --single-transaction "*)
    case " $* " in
      *" --set ON_ERROR_STOP=1 "*) mode=transaction ;;
    esac
    ;;
esac
previous=''
for argument in "$@"; do
  if [ "$previous" = --file ] && [ "$argument" != - ]; then
    sed "s/^/file $$ $mode: /" "$argument" >> "$CALLS"
  fi
  previous=$argument
done
# Without --command, psql reads its statements from stdin, as checked_query
# hands them over; they are written down with the call.
case " $* " in
  *" --command "*) ;;
  *) cat >> "$CALLS" ;;
esac
case "$*" in
  *server_version*) echo 18 ;;
  *rolcanlogin*) echo "${WAS_LOCKED:-f}" ;;
  *pg_xact_status*) echo "${XACT_STATUS:-aborted}" ;;
  *"to_regclass('drizzle.__drizzle_migrations')"*) echo t ;;
  # How far the migrations had come: before the dump is played and after.
  *'max(created_at)'*)
    if grep -q '^restore-as ' "$CALLS"; then
      echo "${LEVEL_AFTER:-2}"
    else
      echo "${LEVEL_BEFORE:-2}"
    fi
    ;;
esac
# The call that plays the dump takes three seconds, for a stop to reach a
# restore while it plays (#1007). PLAY_SLOW is a file it writes once the
# transaction has named its number: the process that started it and its
# process group.
if [ -n "${PLAY_SLOW:-}" ]; then
  case " $* " in
    *" --single-transaction "*)
      echo 'restore-transaction 42'
      play_stat=$(sed 's/.*) //' "/proc/$$/stat")
      printf '%s %s\n' "$PPID" "$(echo "$play_stat" | cut -d' ' -f3)" > "$PLAY_SLOW"
      sleep 3
      ;;
  esac
fi
# The call that plays the dump fails after the transaction named its number,
# the way a connection lost after the COMMIT went out looks to psql; with
# PLAY_FAILS=early before it began, as a refused connection fails.
if [ -n "${PLAY_FAILS:-}" ]; then
  case " $* " in
    *" --single-transaction "*)
      [ "$PLAY_FAILS" = early ] || echo 'restore-transaction 42'
      exit 1
      ;;
  esac
fi
FAKE
cat > "$work/bin/pg_restore" <<'FAKE'
#!/bin/sh
printf 'pg_restore %s password=%s\n' "$*" "${PGPASSWORD:-}" >> "$CALLS"
[ -z "${PG_RESTORE_FAILS:-}" ] || exit 1
# The statements of the dump, into the file it is asked to write.
previous=''
for argument in "$@"; do
  if [ "$previous" = --file ]; then
    printf -- '-- the statements of the dump\n' > "$argument"
  fi
  previous=$argument
done
FAKE
#
# age as it is, unless a check asks otherwise: AGE_SAW names a file to write
# down what lies on the target while it encrypts, AGE_FAILS=halfway passes on
# a little of what it reads and fails. SWAP_FROM and SWAP_ONTO replace a file
# on the target with another before it decrypts, the way somebody who writes
# there could between the check of an archive and its reading; tar does the
# same before it unpacks. AGE_SWAPS does it on the way in: age encrypts,
# keeps what it wrote in AGE_KEPT, and then puts AGE_SWAPS in place of the
# hidden file on the target, the way somebody who writes there could between
# the writing of an archive and its record.
cat > "$work/bin/age" <<FAKE
#!/bin/sh
if [ -n "\${SWAP_FROM:-}" ] && [ "\$1" = --decrypt ]; then
  cp "\$SWAP_FROM" "\$SWAP_ONTO"
fi
if [ -n "\${AGE_SAW:-}" ]; then
  ls -A "\$BACKUP_PATH" > "\$AGE_SAW"
  find "\$TMPDIR" -type f -exec stat -c %a {} + | sort -u > "\$AGE_SAW.parts"
fi
if [ "\${AGE_FAILS:-}" = halfway ]; then
  head -c 100
  exit 1
fi
if [ -n "\${AGE_SWAPS:-}" ]; then
  $real_age "\$@" | tee "\$AGE_KEPT"
  for hidden in "\$BACKUP_PATH"/."\$BACKUP_PREFIX"-*; do
    cp "\$AGE_SWAPS" "\$hidden.swap"
    mv "\$hidden.swap" "\$hidden"
  done
  exit 0
fi
exec $real_age "\$@"
FAKE
#
# tar as it is, unless TAR_FAILS is set: then the archive it writes into a
# pipe breaks off after a little, the way a disk error would end it.
cat > "$work/bin/tar" <<FAKE
#!/bin/sh
if [ -n "\${SWAP_FROM:-}" ] && [ "\$1" = --extract ]; then
  cp "\$SWAP_FROM" "\$SWAP_ONTO"
fi
# A tar that unpacks takes three seconds, for a stop to reach a check while it
# unpacks (#1007). TAR_EXTRACT_SLOW is a file it writes first: the process
# that started it and its process group.
if [ -n "\${TAR_EXTRACT_SLOW:-}" ] && [ "\$1" = --extract ]; then
  tar_stat=\$(sed 's/.*) //' "/proc/\$\$/stat")
  printf '%s %s\\n' "\$PPID" "\$(echo "\$tar_stat" | cut -d' ' -f3)" > "\$TAR_EXTRACT_SLOW"
  sleep 3
fi
# A file of the store that is gone by the time tar comes to it: tar names a
# path that is not there, which is what it says for a file that vanished.
if [ -n "\${TAR_MISSES:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *" --directory \$STORAGE_PATH "*)
      [ -z "\${FAKE_MARK:-}" ] || : > "\$FAKE_MARK"
      exec $real_tar "\$@" "\$TAR_MISSES"
      ;;
  esac
fi
# A tar that stops with an error and says nothing at all.
# A file that went and more than one other error: a failing disk, say.
if [ -n "\${TAR_MIXED:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *" --directory \$STORAGE_PATH "*)
      [ -z "\${FAKE_MARK:-}" ] || : > "\$FAKE_MARK"
      $real_tar "\$@" || exit
      printf 'tar: ./ab/cd/weg: No such file or directory\\n' >&2
      for n in 1 2 3 4 5 6 7 8; do
        printf 'tar: ./ab/cd/x%s: Input/output error\\n' "\$n" >&2
      done
      exit 1
      ;;
  esac
fi
if [ -n "\${TAR_SILENT:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *" --directory \$STORAGE_PATH "*)
      [ -z "\${FAKE_MARK:-}" ] || : > "\$FAKE_MARK"
      $real_tar "\$@"
      exit 1
      ;;
  esac
fi
# The other form busybox tar has for it, when the file goes between the look
# at it and the opening: everything else is packed, and this is said.
if [ -n "\${TAR_CANT_OPEN:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *" --directory \$STORAGE_PATH "*)
      $real_tar "\$@" || exit
      printf "tar: can't open '%s': No such file or directory\\n" "\$TAR_CANT_OPEN" >&2
      printf 'tar: error exit delayed from previous errors\\n' >&2
      exit 1
      ;;
  esac
fi
# Between find and the tar of the second part (the one with -T), the file
# LATE_HASH names goes, is swapped for a link to LATE_TARGET or a pipe, or its
# folder is swapped for a link to LATE_TARGET, as a process that may write to
# the store could do it. LATE_DONE is written once it happened.
if [ -n "\${LATE_HASH:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *" -T "*)
      late=\$STORAGE_PATH/\$(printf '%s' "\$LATE_HASH" | cut -c1-2)/\$(printf '%s' "\$LATE_HASH" | cut -c3-4)/\$LATE_HASH
      # Every step has to work, or LATE_DONE is not written and the case fails.
      set -e
      case "\$LATE_DOES" in
        vanish) $real_rm -f "\$late" ;;
        link)
          ln -s "\$LATE_TARGET" "\$late.link"
          mv -f "\$late.link" "\$late"
          ;;
        pipe)
          $real_rm -f "\$late"
          mkfifo "\$late"
          ;;
        dir)
          $real_rm -f "\$late"
          mkdir "\$late"
          printf 'GEHEIMNIS DES CONTAINERS' > "\$late/\$(printf 'GEHEIMNIS DES CONTAINERS' | sha256sum | cut -d' ' -f1)"
          ;;
        folder)
          printf 'GEHEIMNIS DES CONTAINERS' > "\$LATE_TARGET/\$LATE_HASH"
          mv "\$(dirname "\$late")" "\$(dirname "\$late").moved"
          ln -s "\$LATE_TARGET" "\$(dirname "\$late")"
          ;;
      esac
      : > "\$LATE_DONE"
      set +e
      ;;
  esac
fi
# A tar of the second part that waits, as busybox tar does on a pipe swapped
# in between its look at a name and the opening.
if [ -n "\${TAR_HANGS:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *" -T "*) sleep 30 ;;
  esac
fi
if [ -n "\${TAR_FAILS:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *' --file - '*)
      $real_tar "\$@" | head -c 200
      exit 1
      ;;
  esac
fi
# The tar that packs the checked folder for the copy into the store misses a
# file, PACK_MISSES: it packs the rest and fails, as on a disk that lost one.
if [ -n "\${PACK_MISSES:-}" ] && [ "\$1" = --create ]; then
  case " \$* " in
    *" --directory \$STORAGE_PATH "*) ;;
    *' --file - '*) exec $real_tar "\$@" "\$PACK_MISSES" ;;
  esac
fi
# A store that the checked files do not all reach, the way a full disk ends
# the copy: tar unpacks and still fails, and the restore fails after the
# database is replaced.
if [ -n "\${STORAGE_FAILS:-}" ] && [ "\$1" = --extract ]; then
  case " \$* " in
    *" --directory \$STORAGE_PATH "*)
      $real_tar "\$@"
      exit 1
      ;;
  esac
fi
exec $real_tar "\$@"
FAKE
#
# date as it is, unless FIXED_STAMP is set: then the time backup.sh names an
# archive after is that one, as for two backups in the same second.
cat > "$work/bin/date" <<FAKE
#!/bin/sh
if [ -n "\${FIXED_STAMP:-}" ] && [ "\$*" = '-u +%Y-%m-%dT%H%M%SZ' ]; then
  echo "\$FIXED_STAMP"
  exit 0
fi
exec $real_date "\$@"
FAKE
#
# cp as it is, unless CP_SERVES is set: then a copy of CP_FROM gets what
# CP_SERVES holds, as if the target held another file at the moment it is
# copied and the archive again right after.
cat > "$work/bin/cp" <<FAKE
#!/bin/sh
if [ -n "\${CP_SERVES:-}" ] && [ "\$1" = "\${CP_FROM:-}" ]; then
  exec $real_cp "\$CP_SERVES" "\$2"
fi
exec $real_cp "\$@"
FAKE
# A .part that goes while find walks the store for the second part (the walk
# that starts at "."): everything else is listed, and the gone one is said.
cat > "$work/bin/find" <<FAKE
#!/bin/sh
# The Nth list of all files below . (find . -type f) breaks off after its
# first line, as on a disk that fails halfway, counted in FIND_COUNT.
if [ -n "\${FIND_FAILS_AT:-}" ] && [ "\$*" = ". -type f" ]; then
  find_number=\$((\$(cat "\$FIND_COUNT" 2>/dev/null || echo 0) + 1))
  echo "\$find_number" > "\$FIND_COUNT"
  if [ "\$find_number" = "\$FIND_FAILS_AT" ]; then
    $real_find "\$@" | head -n 1
    echo 'find: ./ab: I/O error' >&2
    exit 1
  fi
fi
$real_find "\$@" || exit
[ "\$1" = . ] || [ "\$1" = "\$STORAGE_PATH" ] || exit 0
# The find that empties the store writes who ran it to EMPTIED_BY. Then a
# running application puts STORE_LINK_AT back into the store, as a link to
# STORE_LINK_TO, between the emptying and the copy.
case " \$* " in
  *" -delete "*)
    [ -z "\${EMPTIED_BY:-}" ] || id -u > "\$EMPTIED_BY"
    [ -z "\${STORE_LINK_AT:-}" ] || ln -s "\$STORE_LINK_TO" "\$STORAGE_PATH/\$STORE_LINK_AT"
    ;;
esac
# A find over the store that does not come back, as on a disk that hangs.
if [ -n "\${FIND_HANGS:-}" ] && [ "\$1" = . ]; then
  sleep 30
fi
if [ -n "\${FIND_MISSES:-}" ]; then
  [ -z "\${FAKE_MARK:-}" ] || : > "\$FAKE_MARK"
  printf 'find: %s: No such file or directory\\n' "\$FIND_MISSES" >&2
  exit 1
fi
FAKE
# wc as it is, unless WC_FAILS_AT is set: then the Nth count of lines read
# from stdin (wc -l) fails without a number, counted in WC_COUNT.
real_wc=$(command -v wc)
cat > "$work/bin/wc" <<FAKE
#!/bin/sh
if [ -n "\${WC_FAILS_AT:-}" ] && [ "\$*" = -l ]; then
  wc_number=\$((\$(cat "\$WC_COUNT" 2>/dev/null || echo 0) + 1))
  echo "\$wc_number" > "\$WC_COUNT"
  if [ "\$wc_number" = "\$WC_FAILS_AT" ]; then
    echo 'wc: standard input: I/O error' >&2
    exit 1
  fi
fi
exec $real_wc "\$@"
FAKE
chmod +x "$work/bin/wc"
# sed as it is, unless SED_FAILS is set: then the sed that looks up the number
# of the transaction fails without output, the way one a second Ctrl+C reached
# would end.
real_sed=$(command -v sed)
cat > "$work/bin/sed" <<FAKE
#!/bin/sh
if [ -n "\${SED_FAILS:-}" ]; then
  case "\$*" in
    *restore-transaction*) exit 1 ;;
  esac
fi
exec $real_sed "\$@"
FAKE
chmod +x "$work/bin/sed"
# grep as it is, unless GREP_FAILS is set: then the grep -v that holds what
# tar or find said against the gone files cannot read.
real_grep=$(command -v grep)
cat > "$work/bin/grep" <<FAKE
#!/bin/sh
if [ -n "\${GREP_FAILS:-}" ] && [ "\$1" = -v ]; then
  case "\$*" in
    *vanished.patterns*)
      : > "\$GREP_MARK"
      echo 'grep: Input/output error' >&2
      exit 2
      ;;
  esac
fi
exec $real_grep "\$@"
FAKE
# sha256sum as it is, unless SHA_FAILS names a file it is asked to read.
real_sha256sum=$(command -v sha256sum)
cat > "$work/bin/sha256sum" <<FAKE
#!/bin/sh
# The first call whose first argument matches the pattern SHA_SLOW_ON takes
# three seconds, for a stop to reach a restore while it hashes (#1007): -cs
# for the files of check 2, /* for the copy of the archive and its origin.
# SHA_SLOW_MARK is a file it writes first: the process that started it and
# its process group.
if [ -n "\${SHA_SLOW_ON:-}" ] && [ ! -e "\$SHA_SLOW_MARK" ]; then
  case "\${1:-}" in
    \$SHA_SLOW_ON)
      sha_stat=\$(sed 's/.*) //' "/proc/\$\$/stat")
      printf '%s %s\\n' "\$PPID" "\$(echo "\$sha_stat" | cut -d' ' -f3)" > "\$SHA_SLOW_MARK"
      sleep 3
      ;;
  esac
fi
if [ -n "\${SHA_FAILS:-}" ] && [ "\$(basename "\${1:-}")" = "\$SHA_FAILS" ]; then
  echo "sha256sum: \$1: I/O error" >&2
  : > "\$SHA_FAILED"
  exit 1
fi
exec $real_sha256sum "\$@"
FAKE
# rm as it is, unless RM_FAILS_ON is part of a path it is asked to remove.
cat > "$work/bin/rm" <<FAKE
#!/bin/sh
# The rm of the two folders below RM_SLOW_UNDER that a restore or a check
# removes at its end takes three seconds, for a second stop to reach it there
# (#1007). RM_SLOW_MARK is a file it writes first: the process that started it
# and its process group.
if [ -n "\${RM_SLOW_UNDER:-}" ] && [ ! -e "\$RM_SLOW_MARK" ]; then
  case "\$*" in
    "-rf \$RM_SLOW_UNDER/"*" \$RM_SLOW_UNDER/"*)
      rm_stat=\$(sed 's/.*) //' "/proc/\$\$/stat")
      printf '%s %s\\n' "\$PPID" "\$(echo "\$rm_stat" | cut -d' ' -f3)" > "\$RM_SLOW_MARK"
      sleep 3
      ;;
  esac
fi
if [ -n "\${RM_FAILS_ON:-}" ]; then
  case "\$*" in
    *"\$RM_FAILS_ON"*)
      [ -z "\${FAKE_MARK:-}" ] || : > "\$FAKE_MARK"
      echo "rm: \$*: I/O error" >&2
      exit 1
      ;;
  esac
fi
# A target that stopped answering: rm of a hidden file right below
# RM_BLOCKS_UNDER waits two minutes first, and TERM does not end that wait.
# Old archives the backup takes away when there are too many are not hidden.
# RM_BLOCKS_MARK is made when that wait begins.
if [ -n "\${RM_BLOCKS_UNDER:-}" ]; then
  case "\$*" in
    *"\$RM_BLOCKS_UNDER"/.*)
      trap '' TERM
      [ -z "\${RM_BLOCKS_MARK:-}" ] || : > "\$RM_BLOCKS_MARK"
      sleep 120
      ;;
  esac
fi
exec $real_rm "\$@"
FAKE
chmod +x "$work/bin/rm"
# timeout as it is; TIMEOUT_CALLS takes down what it is asked to limit.
cat > "$work/bin/timeout" <<FAKE
#!/bin/sh
[ -z "\${TIMEOUT_CALLS:-}" ] || printf '%s\n' "\$*" >> "\$TIMEOUT_CALLS"
exec $real_timeout "\$@"
FAKE
chmod +x "$work/bin/timeout"
chmod +x "$work/bin/pg_dump" "$work/bin/psql" "$work/bin/pg_restore" "$work/bin/age" "$work/bin/tar" \
  "$work/bin/date" "$work/bin/cp" "$work/bin/find" "$work/bin/sha256sum" "$work/bin/grep"

PATH="$work/bin:$PATH"
PGPASSWORD=probe
OPENGEWERK_OWNER_PASSWORD=owner-probe
STORAGE_PATH="$work/storage"
BACKUP_PATH="$work/backups"
BACKUP_STATUS_PATH="$work/status"
TMPDIR="$work/tmp"
CALLS="$work/calls"
export PATH PGPASSWORD OPENGEWERK_OWNER_PASSWORD STORAGE_PATH BACKUP_PATH BACKUP_STATUS_PATH TMPDIR CALLS

# A key pair for the archives that are encrypted here.
"$real_age-keygen" -o "$work/key.txt" 2> /dev/null
recipient=$("$real_age-keygen" -y "$work/key.txt")

check() {
  printf 'check: %s\n' "$1"
}

present() {
  for name in "$@"; do
    if [ ! -f "$work/backups/$name" ]; then
      printf 'FEHLER: %s fehlt\n' "$name"
      ls "$work/backups"
      exit 1
    fi
  done
}

gone() {
  for name in "$@"; do
    if [ -f "$work/backups/$name" ]; then
      printf 'FEHLER: %s ist noch da\n' "$name"
      exit 1
    fi
  done
}

# A command that has to be turned away: it fails, it says why in the words
# given, and it has asked nothing of the database on the way there.
refused() {
  sentence=$1
  shift
  : > "$CALLS"

  if "$@" > "$work/out" 2>&1; then
    printf 'FEHLER: lief durch: %s\n' "$*"
    cat "$work/out"
    exit 1
  fi

  if ! grep -q "$sentence" "$work/out"; then
    printf 'FEHLER: abgelehnt, aber ohne "%s": %s\n' "$sentence" "$*"
    cat "$work/out"
    exit 1
  fi

  if [ -s "$CALLS" ]; then
    printf 'FEHLER: vor der Ablehnung wurde die Datenbank gefragt: %s\n' "$*"
    cat "$CALLS"
    exit 1
  fi
}

# The same, for a command that has to go through.
taken() {
  : > "$CALLS"

  if ! "$@" > "$work/out" 2>&1; then
    printf 'FEHLER: abgelehnt: %s\n' "$*"
    cat "$work/out"
    exit 1
  fi
}

# Two older archives of this application, two of another whose prefix begins
# with this one's and a hyphen, and a file that only looks like an archive.
# Sorted by name, every one of the others comes after the newest of this one.
# None of them was written by a backup, so none stands in the record.
older='opengewerk-2026-01-01T000000Z.tar.gz'
old='opengewerk-2026-01-02T000000Z.tar.gz.age'
theirs_older='opengewerk-haustechnik-2026-01-03T000000Z.tar.gz'
theirs='opengewerk-haustechnik-2026-01-04T000000Z.tar.gz.age'
lookalike='opengewerk-notizen.tar.gz'

for name in "$older" "$old" "$theirs_older" "$theirs" "$lookalike"; do
  : > "$work/backups/$name"
done

# 1. A backup named after its database, and the retention for its own.
POSTGRES_DB=opengewerk BACKUP_KEEP=2 sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
ours=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
printf '%s' "$ours" | grep -Eq '^opengewerk-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.tar\.gz$'
present "$ours" "$old" "$theirs_older" "$theirs" "$lookalike"
gone "$older"
check 'Sicherung: nach der Datenbank benannt, von den eigenen bleiben die zwei neuesten, fremde unberührt'

# 2. "latest" is the newest of its own, for verify and for restore.
POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" latest > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
grep -qx "Sicherung: $ours" "$work/out"
POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" latest > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
grep -qx "Sicherung: $ours" "$work/out"
check 'latest: die neueste eigene Sicherung, für Prüfen und Rückspielen'

# 3. The other application, through BACKUP_PREFIX: its own retention, and the
# archives of the first stay where they are.
BACKUP_PREFIX=opengewerk-haustechnik POSTGRES_DB=haustechnik BACKUP_KEEP=1 \
  sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
mine=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
printf '%s' "$mine" | grep -Eq '^opengewerk-haustechnik-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.tar\.gz$'
present "$mine" "$ours" "$old" "$lookalike"
gone "$theirs_older" "$theirs"
BACKUP_PREFIX=opengewerk-haustechnik POSTGRES_DB=haustechnik sh "$work/bin/verify.sh" latest > "$work/out" 2>&1
grep -qx "Sicherung: $mine" "$work/out"
check 'BACKUP_PREFIX: eigene Sicherungen, eigene Aufbewahrung, die der ersten Anwendung unberührt'

# Without BACKUP_PREFIX the name of the database is the prefix, whatever it is.
POSTGRES_DB=haustechnik BACKUP_KEEP=0 sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
named=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
printf '%s' "$named" | grep -Eq '^haustechnik-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.tar\.gz$'
present "$named" "$mine" "$ours" "$old" "$lookalike"
check 'ohne BACKUP_PREFIX: der Name der Datenbank'

# 4. A prefix that is no beginning of a file name stops before anything is
# written.
before=$(ls "$work/backups" | wc -l)
if BACKUP_PREFIX='../x' POSTGRES_DB=opengewerk sh "$work/bin/backup.sh" > "$work/out" 2>&1; then
  echo 'FEHLER: ein Präfix mit Schrägstrich lief durch'
  exit 1
fi
grep -q 'taugt nicht als Anfang eines Dateinamens' "$work/out"
test "$(ls "$work/backups" | wc -l)" -eq "$before"
check 'falsches Präfix: abgelehnt, nichts geschrieben'

# 5. An archive named outright is held to the names "latest" looks among. The
# archive of the other application lies in the same folder, and by its name or
# by its path it is turned away before anything is asked of the database, in
# both directions, as is the file that only looks like an archive.
foreign='gehört nicht zu dieser Anwendung'
refused "$foreign" env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$mine"
refused "$foreign" env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$work/backups/$mine"
refused "$foreign" env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$named"
refused "$foreign" env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$lookalike"
refused "$foreign" env POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" "$mine"
refused "$foreign" env POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" "$work/backups/$mine"
refused "$foreign" env POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" "$lookalike"
refused "$foreign" env BACKUP_PREFIX=opengewerk-haustechnik POSTGRES_DB=haustechnik \
  sh "$work/bin/restore.sh" "$ours"
refused "$foreign" env BACKUP_PREFIX=opengewerk-haustechnik POSTGRES_DB=haustechnik \
  sh "$work/bin/verify.sh" "$ours"
grep -q 'opengewerk-haustechnik-<Zeit>.tar.gz' "$work/out"
check 'mit Namen genannt: das Archiv einer anderen Anwendung wird abgelehnt, die Datenbank nicht gefragt'

# Its own it takes, by name and by path. The encrypted one was never written
# by a backup and stops at the record; with --skip-origin-check it gets as far
# as the question for the key, which this run has none of: its name did not
# stop it.
taken env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours"
grep -qx "Sicherung: $ours" "$work/out"
taken env POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" "$work/backups/$ours"
grep -qx "Sicherung: $ours" "$work/out"
taken env BACKUP_PREFIX=opengewerk-haustechnik POSTGRES_DB=haustechnik sh "$work/bin/restore.sh" "$mine"
grep -qx "Sicherung: $mine" "$work/out"
refused 'steht nicht im Verzeichnis' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$old"
refused 'BACKUP_AGE_IDENTITY' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" --skip-origin-check "$old"
grep -qx "Sicherung: $old" "$work/out"
check 'mit Namen genannt: das eigene Archiv wird genommen'

# 6. An archive that unpacks cleanly and does not hold what its manifest says.
# A changed byte in the packed file would not get as far as the manifest: gzip
# carries a checksum of its own, and an encrypted archive is authenticated by
# age. What only the manifest can notice is a part that is not the part the
# backup wrote, inside packing that is whole. So each one is unpacked, changed
# and packed again here, and turned away before anything is asked of the
# database. A repacked archive is no longer the one in the record, which turns
# it away first; the manifest is what stands behind the record on a new
# machine, so it is asked with --skip-origin-check.
pristine="$work/pristine.tar.gz"
cp "$work/backups/$ours" "$pristine"

# Unpacks the archive as the backup wrote it, runs the change on its parts
# and packs it again under the name in $target, its own unless set.
repacked() {
  rm -rf "$work/unpacked"
  mkdir "$work/unpacked"
  tar --extract --gzip --file "$pristine" --directory "$work/unpacked"
  (cd "$work/unpacked" && "$@")
  tar --create --gzip --file "$work/backups/${target:-$ours}" --directory "$work/unpacked" .
}

one_byte_more() {
  printf 'x' >> "$1"
}

without_its_checksum() {
  grep -v "\"$1\"" manifest.json > manifest.new
  mv manifest.new manifest.json
}

repacked one_byte_more database.dump
refused 'weicht vom Verzeichnis ab' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours"
refused 'weicht vom Verzeichnis ab' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" latest
refused 'weicht vom Verzeichnis ab' env POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" "$ours"
check 'Verzeichnis: ein verändertes Archiv ist nicht mehr das geschriebene, die Datenbank nicht gefragt'

for part in database.dump storage.tar storage-late.tar audit-chains.tsv; do
  repacked one_byte_more "$part"
  refused "Die Prüfsumme von $part stimmt nicht" env POSTGRES_DB=opengewerk \
    sh "$work/bin/restore.sh" --skip-origin-check "$ours"
  refused "Die Prüfsumme von $part stimmt nicht" env POSTGRES_DB=opengewerk \
    sh "$work/bin/restore.sh" --skip-origin-check latest
done
check 'Manifest: ein veränderter Teil in einem heilen Archiv wird abgelehnt, die Datenbank nicht gefragt'

repacked without_its_checksum storage.tar
refused 'Im Manifest steht keine Prüfsumme für storage.tar' env POSTGRES_DB=opengewerk \
  sh "$work/bin/restore.sh" --skip-origin-check "$ours"
repacked rm audit-chains.tsv
refused 'In der Sicherung fehlt audit-chains.tsv' env POSTGRES_DB=opengewerk \
  sh "$work/bin/restore.sh" --skip-origin-check "$ours"
# The second part of the store, named in the manifest and missing.
repacked rm storage-late.tar
refused 'In der Sicherung fehlt storage-late.tar' env POSTGRES_DB=opengewerk \
  sh "$work/bin/restore.sh" --skip-origin-check "$ours"
check 'Manifest: ein Teil ohne Prüfsumme und ein fehlender Teil werden abgelehnt'

# An archive from before #991 has no second part, and its manifest names none:
# it goes back as it did.
# An archive whose order has the second part, with the part and its checksum
# taken out, is not one from before.
without_the_late_part() {
  rm storage-late.tar
  without_its_checksum storage-late.tar
}
repacked without_the_late_part
refused 'In der Sicherung fehlt storage-late.tar' env POSTGRES_DB=opengewerk \
  sh "$work/bin/restore.sh" --skip-origin-check "$ours"
# The same written without blanks, as JSON allows.
compact_order() {
  without_the_late_part
  sed 's/"order": "storage-database-late"/"order":"storage-database-late"/' manifest.json > manifest.new
  mv manifest.new manifest.json
}
repacked compact_order
refused 'In der Sicherung fehlt storage-late.tar' env POSTGRES_DB=opengewerk \
  sh "$work/bin/restore.sh" --skip-origin-check "$ours"
check 'Manifest: die Reihenfolge mit zweitem Teil verlangt ihn, auch ohne seine Prüfsumme und ohne Leerzeichen'

before_991() {
  without_the_late_part
  sed 's/"order": "storage-database-late"/"order": "database-then-storage"/' manifest.json > manifest.new
  mv manifest.new manifest.json
}
repacked before_991
taken env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" --skip-origin-check "$ours"
check 'Manifest: ein Archiv ohne zweiten Teil des Dateispeichers geht zurück wie bisher'

# Packed again without a change it goes through, and the database is asked:
# what was turned away above was the change and not the packing.
repacked true
taken env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" --skip-origin-check "$ours"
grep -q '^pg_restore ' "$CALLS"
grep -q 'WARNUNG: Die Herkunft der Sicherung wird nicht geprüft' "$work/out"
check 'Manifest: dasselbe Archiv, unverändert neu gepackt, wird mit --skip-origin-check zurückgespielt'

# Back to what the backup wrote, for the checks below.
cp "$pristine" "$work/backups/$ours"

# 7. Where an archive comes from (opengewerk-haustechnik#360). Whoever can write
# to the target can put an archive there with a later time in its name, whole
# and with a manifest that fits, and encrypted too: the recipient is a public
# key. "latest" finds it, and the record turns it away before it is unpacked
# or decrypted.
planted='opengewerk-2099-01-01T000000Z.tar.gz'
target=$planted
repacked true
target=''
refused 'steht nicht im Verzeichnis' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" latest
grep -qx "Sicherung: $planted" "$work/out"
refused 'steht nicht im Verzeichnis' env POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" latest
grep -qx "Sicherung: $planted" "$work/out"

planted_encrypted='opengewerk-2099-01-02T000000Z.tar.gz.age'
"$real_age" --recipient "$recipient" --output "$work/backups/$planted_encrypted" "$work/backups/$planted"
refused 'steht nicht im Verzeichnis' env POSTGRES_DB=opengewerk BACKUP_AGE_RECIPIENT="$recipient" \
  BACKUP_AGE_IDENTITY="$work/key.txt" sh "$work/bin/restore.sh" latest
grep -qx "Sicherung: $planted_encrypted" "$work/out"
if grep -q 'entschlüsselt' "$work/out"; then
  echo 'FEHLER: die untergeschobene Sicherung wurde entschlüsselt'
  exit 1
fi
rm -f "$work/backups/$planted" "$work/backups/$planted_encrypted"
check 'Herkunft: eine untergeschobene Sicherung mit späterem Datum wird abgelehnt, verschlüsselt oder nicht'

# An installation that encrypts takes no archive in the clear, even one of its
# own from before it encrypted.
refused 'ist unverschlüsselt, diese Installation verschlüsselt' env POSTGRES_DB=opengewerk \
  BACKUP_AGE_RECIPIENT="$recipient" sh "$work/bin/restore.sh" "$ours"
refused 'ist unverschlüsselt, diese Installation verschlüsselt' env POSTGRES_DB=opengewerk \
  BACKUP_AGE_RECIPIENT="$recipient" sh "$work/bin/verify.sh" "$ours"
taken env POSTGRES_DB=opengewerk BACKUP_AGE_RECIPIENT="$recipient" \
  sh "$work/bin/restore.sh" --skip-origin-check "$ours"
grep -q '^pg_restore ' "$CALLS"
check 'Herkunft: Klartext wird abgelehnt, wenn die Installation verschlüsselt'

# A new machine after a lost one has no record. Without the flag nothing is
# restored, with it the archive is, and the checks behind it still run.
mkdir -p "$work/new-machine"
refused 'kein Verzeichnis der Sicherungen' env POSTGRES_DB=opengewerk \
  BACKUP_STATUS_PATH="$work/new-machine" sh "$work/bin/restore.sh" latest
refused 'kein Verzeichnis der Sicherungen' env -u BACKUP_STATUS_PATH POSTGRES_DB=opengewerk \
  sh "$work/bin/restore.sh" "$ours"
refused 'kein Verzeichnis der Sicherungen' env POSTGRES_DB=opengewerk \
  BACKUP_STATUS_PATH="$work/new-machine" sh "$work/bin/verify.sh" latest
taken env POSTGRES_DB=opengewerk BACKUP_STATUS_PATH="$work/new-machine" \
  sh "$work/bin/restore.sh" --skip-origin-check latest
grep -qx "Sicherung: $ours" "$work/out"
grep -q '^pg_restore ' "$CALLS"
check 'Herkunft: auf einer neuen Maschine ohne Verzeichnis nur mit --skip-origin-check'

# 8. The dump is restored by the owner of the tables, with its own password,
# and not by the superuser under SET ROLE, which a statement in the dump could
# take back. In one transaction that stops at the first error, after the
# owner's objects are emptied, and without pg_restore --clean, which stopped
# at what later migrations added (#988).
taken env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours"
grep '^restore-as ' "$CALLS" > "$work/restored"
grep -q -- '--username opengewerk_owner ' "$work/restored"
grep -q ' password=owner-probe$' "$work/restored"
grep -q -- '--set ON_ERROR_STOP=1 ' "$work/restored"
grep '^pg_restore ' "$CALLS" | grep -q -- '--no-owner --file '
# Emptied first, then the dump, both in the same call and so in its one
# transaction: emptied in one call and played in another, a dump that fails
# could not take the emptying back.
awk '/^file [0-9]+ transaction: DROP SCHEMA IF EXISTS drizzle CASCADE;$/ { emptied = NR; emptying = $2 }
  /^file [0-9]+ transaction: -- the statements of the dump$/ { played = NR; playing = $2 }
  END { exit !(emptied && played && emptied < played && emptying == playing) }' "$CALLS" || {
  echo 'FEHLER: Leeren und Dump laufen nicht nacheinander in derselben Transaktion'
  grep '^file ' "$CALLS"
  exit 1
}
if grep '^pg_restore ' "$CALLS" | grep -q -e '--clean' -e '--username' -e '--host'; then
  echo 'FEHLER: pg_restore räumt selbst auf oder meldet sich an'
  grep '^pg_restore ' "$CALLS"
  exit 1
fi
if grep -q -e '--role' -e '--username postgres' -e 'password=probe$' "$work/restored"; then
  echo 'FEHLER: der Dump lief als Superuser'
  cat "$work/restored"
  exit 1
fi
grep -q 'alter role opengewerk_app login' "$CALLS" || {
  echo 'FEHLER: nach dem Rückspielen bekam die Anwendung ihre Anmeldung nicht zurück'
  exit 1
}
# The command it names to start again works from the folder of the installation
# (#987): there is no compose.yaml at its root.
grep -q '^  sh docker/start.sh$' "$work/out" || {
  echo 'FEHLER: die Meldung am Ende nennt nicht, wie die Anwendung wieder startet'
  cat "$work/out"
  exit 1
}
refused 'OPENGEWERK_OWNER_PASSWORD fehlt' env -u OPENGEWERK_OWNER_PASSWORD POSTGRES_DB=opengewerk \
  sh "$work/bin/restore.sh" "$ours"
check 'Rückspielen: als Eigentümer der Tabellen, in einer Transaktion, nicht als Superuser'

# 8a. A list of the checked store that find cannot finish stops the restore
# before anything changes (#1000): the second "find . -type f" of a restore
# is the one the checklist of the hashes is built from.
: > "$CALLS"
rm -f "$work/find-count"
if FIND_FAILS_AT=2 FIND_COUNT="$work/find-count" POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours"   > "$work/out" 2>&1; then
  echo 'FEHLER: ein Rückspielen lief durch, obwohl die Liste des geprüften Speichers abbrach'
  exit 1
fi
[ "$(cat "$work/find-count" 2>/dev/null)" = 2 ] || {
  echo 'FEHLER: die Liste für die Prüfung der Hashes wurde nicht erreicht, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
if grep -q -e 'alter role opengewerk_app nologin' -e 'restore-as' "$CALLS"; then
  echo 'FEHLER: nach einer abgebrochenen Liste des Speichers wurde ausgesperrt oder eingespielt'
  exit 1
fi
# And a count of the checklist that fails: the second "wc -l" of a restore is
# that count, and the check of the hashes must not go by a number it lacks.
: > "$CALLS"
rm -f "$work/wc-count"
if WC_FAILS_AT=2 WC_COUNT="$work/wc-count" POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours" \
  > "$work/out" 2>&1; then
  echo 'FEHLER: ein Rückspielen lief durch, obwohl sich die Prüfliste nicht zählen ließ'
  exit 1
fi
[ "$(cat "$work/wc-count" 2>/dev/null)" = 2 ] || {
  echo 'FEHLER: die Zählung der Prüfliste wurde nicht erreicht, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
if grep -q -e 'alter role opengewerk_app nologin' -e 'restore-as' "$CALLS"; then
  echo 'FEHLER: nach einer Zählung der Prüfliste, die scheiterte, wurde ausgesperrt oder eingespielt'
  exit 1
fi

# 8b. A restore that fails after the database is replaced leaves the
# application locked and says so, because the file store did not come back.
# One that fails before gives the login back: the database is as it was
# (#988).
halfway() {
  : > "$CALLS"
  if env POSTGRES_DB=opengewerk "$@" sh "$work/bin/restore.sh" "$ours" > "$work/out" 2>&1; then
    printf 'FEHLER: lief durch mit %s\n' "$*"
    cat "$work/out"
    exit 1
  fi
  grep -q 'alter role opengewerk_app nologin' "$CALLS" || {
    printf 'FEHLER: die Anwendung wurde nicht ausgesperrt: %s\n' "$*"
    exit 1
  }
}
# The store belongs to the user of the application, and after a copy that
# failed it still does, every file of it, so that the next restore, the one
# the message asks for, keeps that owner (#1000). The archive for that holds
# a file in the store, so that there is a file the copy has written.
filled_text='im Speicher beim Kopieren'
filled_hash=$(printf '%s' "$filled_text" | sha256sum | cut -d' ' -f1)
filled_dir="$STORAGE_PATH/$(printf '%s' "$filled_hash" | cut -c1-2)"
mkdir -p "$filled_dir/$(printf '%s' "$filled_hash" | cut -c3-4)"
printf '%s' "$filled_text" > "$filled_dir/$(printf '%s' "$filled_hash" | cut -c3-4)/$filled_hash"
POSTGRES_DB=opengewerk FIXED_STAMP=2031-04-01T000000Z sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
ours_kept=$ours
ours=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
# Kept for a stop while check 2 hashes the files of the store, further below.
ours_filled=$ours
chown -R 1000:1000 "$STORAGE_PATH"
halfway STORAGE_FAILS=1
ours=$ours_kept
grep -q 'bleibt ausgesperrt' "$work/out" || {
  echo 'FEHLER: die Meldung sagt nicht, dass die Anwendung ausgesperrt bleibt'
  cat "$work/out"
  exit 1
}
if [ ! -f "$filled_dir/$(printf '%s' "$filled_hash" | cut -c3-4)/$filled_hash" ]; then
  echo 'FEHLER: das gescheiterte Kopieren schrieb keine Datei, der Fall wurde nicht geprüft'
  exit 1
fi
if [ "$(stat -c '%u:%g' "$STORAGE_PATH")" != 1000:1000 ] || [ -n "$(find "$STORAGE_PATH" ! -user 1000 | head -n 1)" ]; then
  echo 'FEHLER: nach einem gescheiterten Kopieren gehört der Dateispeicher nicht mehr dem Benutzer der Anwendung'
  ls -lnR "$STORAGE_PATH"
  exit 1
fi
rm -rf "$filled_dir"
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: nach einem halben Rückspielen bekam die Anwendung ihre Anmeldung zurück'
  exit 1
fi

# In the store the restore works with the rights of its owner, not as root: an
# application that still runs and puts a link where a folder of the archive
# goes, between the emptying and the copy, does not lead it out of the store.
# The emptying runs as the owner, and so does the copy, which writes the
# owner's files with the modes of the archive.
mkdir -p "$work/outside" "$work/as-owner"
chmod 755 "$work/outside"
chmod 777 "$work/as-owner"
filled_top=$(printf '%s' "$filled_hash" | cut -c1-2)
filled_file="$filled_dir/$(printf '%s' "$filled_hash" | cut -c3-4)/$filled_hash"
restore_status=0
env POSTGRES_DB=opengewerk EMPTIED_BY="$work/as-owner/emptied-by" STORE_LINK_AT="$filled_top" \
  STORE_LINK_TO="$work/outside" sh "$work/bin/restore.sh" "$ours_filled" > "$work/out" 2>&1 ||
  restore_status=$?
[ -L "$STORAGE_PATH/$filled_top" ] || {
  echo 'FEHLER: der Link kam nicht in den Dateispeicher, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
if [ -n "$(ls -A "$work/outside")" ] || [ "$(stat -c %a "$work/outside")" != 755 ]; then
  echo 'FEHLER: das Rückspielen folgte einem Link aus dem Dateispeicher hinaus'
  ls -lnR "$work/outside"
  exit 1
fi
[ "$(cat "$work/as-owner/emptied-by")" = 1000 ] || {
  echo "FEHLER: den Dateispeicher leerte nicht sein Eigentümer, sondern $(cat "$work/as-owner/emptied-by")"
  exit 1
}
if [ "$restore_status" -eq 0 ] || ! grep -q 'bleibt ausgesperrt' "$work/out"; then
  echo "FEHLER: ein Kopieren, das nicht in den Speicher kam, lief durch oder sagte nicht, dass die Anwendung ausgesperrt bleibt (Status $restore_status)"
  cat "$work/out"
  exit 1
fi
rm -f "$STORAGE_PATH/$filled_top"
taken env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours_filled"
if [ "$(stat -c '%u %a' "$filled_file")" != '1000 644' ] || [ -n "$(find "$STORAGE_PATH" ! -user 1000 | head -n 1)" ]; then
  echo "FEHLER: das Rückspielen schrieb den Dateispeicher nicht als sein Eigentümer mit den Rechten der Sicherung ($(stat -c '%u %a' "$filled_file"))"
  ls -lnR "$STORAGE_PATH"
  exit 1
fi
# A pack of the checked folder that misses a file still ends the copy in the
# store with all the rest; the restore fails all the same, and the application
# stays locked.
restore_status=0
env POSTGRES_DB=opengewerk PACK_MISSES=./nicht-da sh "$work/bin/restore.sh" "$ours_filled" \
  > "$work/out" 2>&1 || restore_status=$?
[ -f "$filled_file" ] || {
  echo 'FEHLER: das Packen für das Kopieren brach ganz ab, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
if [ "$restore_status" -eq 0 ] || ! grep -q 'bleibt ausgesperrt' "$work/out"; then
  echo "FEHLER: ein Packen, dem eine Datei fehlte, ließ das Rückspielen durchlaufen (Status $restore_status)"
  cat "$work/out"
  exit 1
fi
rm -rf "$filled_dir"
# A folder in the store that its owner may not empty turns the restore away
# before anything changes, with the commands that give the store back: one
# that belongs to root, and one of the owner's own that it may not write.
mkdir "$STORAGE_PATH/fremd"
: > "$STORAGE_PATH/fremd/datei"
refused 'nicht leeren darf' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours"
grep -q "run --rm backup chown -R 1000:1000 $STORAGE_PATH\$" "$work/out" || {
  echo 'FEHLER: die Ablehnung nennt nicht den Befehl, der den Speicher seinem Eigentümer zurückgibt'
  cat "$work/out"
  exit 1
}
[ -f "$STORAGE_PATH/fremd/datei" ] || {
  echo 'FEHLER: ein abgelehntes Rückspielen änderte den Dateispeicher'
  exit 1
}
rm -rf "$STORAGE_PATH/fremd"
mkdir "$STORAGE_PATH/gesperrt"
: > "$STORAGE_PATH/gesperrt/datei"
chown -R 1000:1000 "$STORAGE_PATH/gesperrt"
chmod 500 "$STORAGE_PATH/gesperrt"
refused 'nicht leeren darf' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$ours"
[ -f "$STORAGE_PATH/gesperrt/datei" ] || {
  echo 'FEHLER: ein abgelehntes Rückspielen änderte den Dateispeicher'
  exit 1
}
chmod 700 "$STORAGE_PATH/gesperrt"
rm -rf "$STORAGE_PATH/gesperrt"
chown -R 0:0 "$STORAGE_PATH"
check 'Rückspielen: im Dateispeicher mit den Rechten seines Eigentümers, ein Link führt nicht hinaus'
halfway PG_RESTORE_FAILS=1
grep -q 'alter role opengewerk_app login' "$CALLS" || {
  echo 'FEHLER: vor dem Einspielen gescheitert, und die Anwendung blieb ausgesperrt'
  exit 1
}
if grep -q 'bleibt ausgesperrt' "$work/out"; then
  echo 'FEHLER: die Meldung nennt eine Sperre, die es nicht gibt'
  exit 1
fi
# Locked by an earlier run that did not go through, the database is the one
# that run left: a second run that fails before the dump keeps the lock.
halfway WAS_LOCKED=t PG_RESTORE_FAILS=1
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: ein zweiter, früh gescheiterter Lauf gab die Sperre des ersten frei'
  exit 1
fi
grep -q 'wie sie es vor diesem Lauf war' "$work/out" || {
  echo 'FEHLER: die Meldung sagt nicht, warum die Anwendung ausgesperrt bleibt'
  cat "$work/out"
  exit 1
}
# psql fails while playing: the database is asked how the transaction ended.
# Committed, or not known, the application stays locked; aborted, it gets its
# login back.
halfway PLAY_FAILS=1 XACT_STATUS=committed
grep -q "pg_xact_status('42'::xid8)" "$CALLS" || {
  echo 'FEHLER: nach einem Fehler beim Einspielen wurde nicht nach dem Ausgang der Transaktion gefragt'
  exit 1
}
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: nach einer übernommenen Transaktion bekam die Anwendung ihre Anmeldung zurück'
  exit 1
fi
halfway PLAY_FAILS=1 XACT_STATUS='in progress'
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: bei offenem Ausgang der Transaktion bekam die Anwendung ihre Anmeldung zurück'
  exit 1
fi
halfway PLAY_FAILS=1 XACT_STATUS=aborted
grep -q 'alter role opengewerk_app login' "$CALLS" || {
  echo 'FEHLER: nach einer abgebrochenen Transaktion blieb die Anwendung ausgesperrt'
  exit 1
}
# psql fails before the transaction named its number: it never began, and
# the application gets its login back without the database being asked.
halfway PLAY_FAILS=early XACT_STATUS=committed
if grep -q 'pg_xact_status' "$CALLS"; then
  echo 'FEHLER: nach einer Transaktion ohne Nummer wurde die Datenbank gefragt'
  exit 1
fi
grep -q 'alter role opengewerk_app login' "$CALLS" || {
  echo 'FEHLER: nach einer Transaktion, die nie begann, blieb die Anwendung ausgesperrt'
  exit 1
}
check 'Rückspielen: scheitert es nach der Datenbank, bleibt die Anwendung ausgesperrt, davor nicht'

# From the play of the dump on, only the answer of the database that the
# transaction was aborted, or a transaction that never began, gives the login
# back (#1007). A sed that fails while the number is looked up, the way one a
# second Ctrl+C reached would end, ends the run before the database is asked,
# and the application stays locked: its failure is not taken for a transaction
# that never began.
halfway PLAY_FAILS=1 XACT_STATUS=aborted SED_FAILS=1
grep -q '^restore-as ' "$CALLS" || {
  echo 'FEHLER: der Dump wurde nicht eingespielt, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
if grep -q 'pg_xact_status' "$CALLS"; then
  echo 'FEHLER: das Nachschlagen der Transaktion scheiterte nicht, der Fall wurde nicht geprüft'
  exit 1
fi
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: ohne Antwort der Datenbank bekam die Anwendung ihre Anmeldung zurück'
  exit 1
fi
grep -q 'bleibt ausgesperrt' "$work/out" || {
  echo 'FEHLER: die Meldung sagt nicht, dass die Anwendung ausgesperrt bleibt'
  cat "$work/out"
  exit 1
}
check 'Rückspielen: ab dem Einspielen gibt nur ein bestätigter Abbruch die Anmeldung zurück'

# A login that cannot be given back is said, with the command that gives it
# back, and a run that went through ends with an error then (#1007). The role
# is locked without a note, and start.sh would not give the login back.
unlock_refused() {
  grep -q 'Anmeldung ließ sich nicht zurückgeben' "$work/out" &&
    grep -q 'psql -U postgres -c "alter role opengewerk_app login; comment on role opengewerk_app is null"' "$work/out" || {
    echo "FEHLER: ein gescheitertes Zurückgeben der Anmeldung wurde nicht gemeldet ($1)"
    cat "$work/out"
    exit 1
  }
}
: > "$CALLS"
restore_status=0
POSTGRES_DB=opengewerk UNLOCK_FAILS=1 sh "$work/bin/restore.sh" "$ours" > "$work/out" 2>&1 ||
  restore_status=$?
grep -q '^Fertig\.' "$work/out" || {
  echo 'FEHLER: das Rückspielen kam nicht bis zum Ende, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
unlock_refused 'nach einem Rückspielen, das durchlief'
[ "$restore_status" -ne 0 ] || {
  echo 'FEHLER: ein Rückspielen, nach dem die Anwendung ausgesperrt blieb, endete ohne Fehler'
  exit 1
}
halfway PLAY_FAILS=early UNLOCK_FAILS=1
unlock_refused 'nach einem Rückspielen, das vor der Datenbank scheiterte'
check 'Rückspielen: lässt sich die Anmeldung nicht zurückgeben, sagt der Lauf es und endet mit Fehler'

# 8b2. A stop, docker stop or Ctrl+C, while a restore plays the dump or a
# check unpacks the archive (#1007). The init of the service hands the SIGINT
# to the whole process group: psql ends, the database says the transaction
# was aborted, and the application gets its login back. A SIGINT for the
# script alone, while psql goes on, is noticed once the play ended: the
# database is replaced then, the store is not touched, and the application
# stays locked. Either way the run says it was stopped and leaves nothing in
# TMPDIR; a check leaves no unpacked chains.
#
# Sends SIGINT once the mark file $1 is there, to the process that started the
# fake ("script") or to its process group ("group"). The group has to be
# another one than that of the test, or the test would signal itself. A group
# it signalled is written to $1.sent.
interrupt_when_marked() {
  waited=0
  until [ -s "$1" ] || [ "$waited" -ge 300 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  [ -s "$1" ] || return 0
  read -r marked_script marked_group < "$1"
  if [ "$2" = group ]; then
    test_stat=$(sed 's/.*) //' "/proc/$$/stat")
    if [ "$marked_group" = "$(echo "$test_stat" | cut -d' ' -f3)" ]; then
      echo 'the group of the test' > "$1.refused"
      return 0
    fi
    kill -s INT "-$marked_group"
    echo "$marked_group" > "$1.sent"
  else
    kill -s INT "$marked_script"
  fi
}
# Runs the restore with the play that takes its time and signals it as $1
# says. $2, when it is not empty, names a psql call of the way out: a second
# SIGINT reaches the run while that call takes its time. The rest is the
# environment of the restore.
stopped_restore() {
  signalled=$1
  second_at=$2
  shift 2
  rm -rf "$work/play-mark" "$work/play-mark.refused" "$work/play-mark.sent" "$work/psql-mark" \
    "$work/psql-mark.refused" "$work/psql-mark.sent" "$work/stop-tmp"
  mkdir -p "$work/stop-tmp"
  : > "$CALLS"
  interrupt_when_marked "$work/play-mark" "$signalled" &
  interrupter=$!
  second_interrupter=''
  if [ -n "$second_at" ]; then
    interrupt_when_marked "$work/psql-mark" "$signalled" &
    second_interrupter=$!
  fi
  restore_status=0
  if [ "$signalled" = group ]; then
    env POSTGRES_DB=opengewerk PLAY_SLOW="$work/play-mark" TMPDIR="$work/stop-tmp" \
      PSQL_SLOW_ON="$second_at" PSQL_SLOW_MARK="$work/psql-mark" "$@" \
      setsid sh "$work/bin/restore.sh" "$ours" > "$work/out" 2>&1 || restore_status=$?
  else
    env POSTGRES_DB=opengewerk PLAY_SLOW="$work/play-mark" TMPDIR="$work/stop-tmp" \
      PSQL_SLOW_ON="$second_at" PSQL_SLOW_MARK="$work/psql-mark" "$@" \
      sh "$work/bin/restore.sh" "$ours" > "$work/out" 2>&1 || restore_status=$?
  fi
  wait "$interrupter" || true
  [ -z "$second_interrupter" ] || wait "$second_interrupter" || true
  if [ ! -s "$work/play-mark" ] || [ -e "$work/play-mark.refused" ]; then
    echo "FEHLER: das Einspielen wurde nicht erreicht oder nicht angehalten ($signalled), der Fall wurde nicht geprüft"
    cat "$work/out"
    exit 1
  fi
  if [ "$restore_status" -eq 0 ] || ! grep -q 'Das Rückspielen wurde angehalten' "$work/out"; then
    echo "FEHLER: ein angehaltenes Rückspielen lief durch oder sagte es nicht ($signalled, Status $restore_status)"
    cat "$work/out"
    exit 1
  fi
  if grep -q 'Dateispeicher wird zurückgespielt' "$work/out"; then
    echo "FEHLER: nach dem Anhalten wurde der Dateispeicher noch zurückgespielt ($signalled)"
    exit 1
  fi
  if [ -n "$(ls -A "$work/stop-tmp")" ]; then
    echo "FEHLER: ein angehaltenes Rückspielen ließ Teile im Container liegen ($signalled)"
    ls -A "$work/stop-tmp"
    exit 1
  fi
}
stopped_restore script ''
grep -q '^restore-as ' "$CALLS" || {
  echo 'FEHLER: der Dump wurde nicht eingespielt, der Fall wurde nicht geprüft'
  exit 1
}
if grep -q 'alter role opengewerk_app login' "$CALLS" || ! grep -q 'schon zurückgespielt' "$work/out"; then
  echo 'FEHLER: nach einem Anhalten hinter dem Einspielen bekam die Anwendung ihre Anmeldung zurück'
  cat "$work/out"
  exit 1
fi
# A second SIGINT for the group while the run gives the login back does not
# end that halfway, nor does it cancel the statement of psql, which has a
# session of its own: the login comes back all the same, and nothing is left
# in TMPDIR.
stopped_restore group 'alter role opengewerk_app login' XACT_STATUS=aborted
grep -q "pg_xact_status('42'::xid8)" "$CALLS" || {
  echo 'FEHLER: nach einem Anhalten beim Einspielen wurde nicht nach dem Ausgang der Transaktion gefragt'
  cat "$work/out"
  exit 1
}
grep -q 'alter role opengewerk_app login' "$CALLS" || {
  echo 'FEHLER: nach einem Anhalten mit abgebrochener Transaktion blieb die Anwendung ausgesperrt'
  cat "$work/out"
  exit 1
}
if [ ! -s "$work/psql-mark" ] || [ -e "$work/psql-mark.refused" ] || [ ! -s "$work/psql-mark.sent" ]; then
  echo 'FEHLER: das zweite Anhalten beim Zurückgeben der Anmeldung wurde nicht erreicht, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
fi
# A SIGINT for the script alone after the play, while it takes the note of an
# earlier restore off the role: the run ends after that step, before the store,
# and the application stays locked.
rm -rf "$work/psql-mark" "$work/psql-mark.refused" "$work/psql-mark.sent"
: > "$CALLS"
interrupt_when_marked "$work/psql-mark" script &
interrupter=$!
restore_status=0
POSTGRES_DB=opengewerk PSQL_SLOW_ON='comment on role opengewerk_app is null' \
  PSQL_SLOW_MARK="$work/psql-mark" sh "$work/bin/restore.sh" "$ours" > "$work/out" 2>&1 ||
  restore_status=$?
wait "$interrupter" || true
grep -q '^restore-as ' "$CALLS" && [ -s "$work/psql-mark" ] || {
  echo 'FEHLER: das Rückspielen kam nicht bis hinter das Einspielen, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
if [ "$restore_status" -eq 0 ] || grep -q 'Dateispeicher wird zurückgespielt' "$work/out" ||
  grep -q 'alter role opengewerk_app login' "$CALLS" || ! grep -q 'schon zurückgespielt' "$work/out"; then
  echo "FEHLER: ein Anhalten hinter dem Einspielen beendete den Lauf nicht vor dem Dateispeicher (Status $restore_status)"
  cat "$work/out"
  exit 1
fi
# A check, stopped while it unpacks.
# A second SIGINT while it removes what it unpacked does not end that halfway.
rm -rf "$work/extract-mark" "$work/extract-mark.refused" "$work/rm-mark" "$work/rm-mark.refused" \
  "$work/stop-tmp"
mkdir -p "$work/stop-tmp"
interrupt_when_marked "$work/extract-mark" group &
interrupter=$!
interrupt_when_marked "$work/rm-mark" group &
second_interrupter=$!
verify_status=0
TMPDIR="$work/stop-tmp" TAR_EXTRACT_SLOW="$work/extract-mark" POSTGRES_DB=opengewerk \
  RM_SLOW_UNDER="$work/stop-tmp" RM_SLOW_MARK="$work/rm-mark" \
  setsid sh "$work/bin/verify.sh" "$ours" > "$work/out" 2>&1 || verify_status=$?
wait "$interrupter" || true
wait "$second_interrupter" || true
if [ ! -s "$work/extract-mark" ] || [ -e "$work/extract-mark.refused" ] || [ -e "$work/rm-mark.refused" ]; then
  echo 'FEHLER: die Prüfung kam nicht zum Auspacken oder wurde nicht angehalten, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
fi
[ -s "$work/rm-mark" ] || {
  echo 'FEHLER: eine angehaltene Prüfung räumte nicht auf'
  cat "$work/out"
  exit 1
}
if [ "$verify_status" -eq 0 ] || [ -n "$(ls -A "$work/stop-tmp")" ]; then
  echo "FEHLER: eine angehaltene Prüfung lief durch oder ließ Ausgepacktes liegen (Status $verify_status)"
  ls -A "$work/stop-tmp"
  cat "$work/out"
  exit 1
fi
# A restore stopped before the play, while it hashes the copy of the archive
# for its origin or the files of check 2: the run ends after that hash and
# says it was stopped, and nothing in it judges the archive, which is whole.
# Neither is the application locked out. A second SIGINT while it removes
# what it unpacked does not end that halfway.
for slow_hash in '/*' -cs; do
  rm -rf "$work/sha-mark" "$work/sha-mark.refused" "$work/rm-mark" "$work/rm-mark.refused" \
    "$work/stop-tmp"
  mkdir -p "$work/stop-tmp"
  : > "$CALLS"
  interrupt_when_marked "$work/sha-mark" group &
  interrupter=$!
  interrupt_when_marked "$work/rm-mark" group &
  second_interrupter=$!
  restore_status=0
  env POSTGRES_DB=opengewerk TMPDIR="$work/stop-tmp" SHA_SLOW_ON="$slow_hash" \
    SHA_SLOW_MARK="$work/sha-mark" RM_SLOW_UNDER="$work/stop-tmp" RM_SLOW_MARK="$work/rm-mark" \
    setsid sh "$work/bin/restore.sh" "$ours_filled" > "$work/out" 2>&1 || restore_status=$?
  wait "$interrupter" || true
  wait "$second_interrupter" || true
  if [ ! -s "$work/sha-mark" ] || [ -e "$work/sha-mark.refused" ] || [ -e "$work/rm-mark.refused" ]; then
    echo "FEHLER: das Rückspielen kam nicht zum Hash ($slow_hash) oder wurde nicht angehalten, der Fall wurde nicht geprüft"
    cat "$work/out"
    exit 1
  fi
  [ -s "$work/rm-mark" ] || {
    echo "FEHLER: ein Rückspielen, angehalten beim Hash ($slow_hash), räumte nicht auf"
    cat "$work/out"
    exit 1
  }
  if [ "$restore_status" -eq 0 ] || ! grep -q 'Das Rückspielen wurde angehalten' "$work/out"; then
    echo "FEHLER: ein Rückspielen, angehalten beim Hash ($slow_hash), lief durch oder sagte es nicht (Status $restore_status)"
    cat "$work/out"
    exit 1
  fi
  if grep -q -e 'beschädigt' -e 'untergeschoben' -e 'nicht mehr die' -e 'skip-origin-check' "$work/out"; then
    echo "FEHLER: ein Anhalten beim Hash ($slow_hash) wurde als Urteil über das Archiv gemeldet"
    cat "$work/out"
    exit 1
  fi
  if grep -q 'alter role opengewerk_app nologin' "$CALLS"; then
    echo "FEHLER: nach einem Anhalten beim Hash ($slow_hash) wurde die Anwendung ausgesperrt"
    exit 1
  fi
  if [ -n "$(ls -A "$work/stop-tmp")" ]; then
    echo "FEHLER: ein zweites Anhalten beim Aufräumen ließ Ausgepacktes liegen ($slow_hash)"
    ls -A "$work/stop-tmp"
    exit 1
  fi
done
# A restore that went through, stopped while it gives the login back at its
# end. The trap in force then is the one that ends the run, and the stop
# reaches the whole group: it ends neither the way out nor, through a cancel,
# the statement of psql. The login comes back, and nothing is left in TMPDIR.
rm -rf "$work/psql-mark" "$work/psql-mark.refused" "$work/psql-mark.sent" "$work/stop-tmp"
mkdir -p "$work/stop-tmp"
: > "$CALLS"
interrupt_when_marked "$work/psql-mark" group &
interrupter=$!
restore_status=0
env POSTGRES_DB=opengewerk TMPDIR="$work/stop-tmp" PSQL_SLOW_ON='alter role opengewerk_app login' \
  PSQL_SLOW_MARK="$work/psql-mark" setsid sh "$work/bin/restore.sh" "$ours" > "$work/out" 2>&1 ||
  restore_status=$?
wait "$interrupter" || true
if ! grep -q '^Fertig\.' "$work/out" || [ ! -s "$work/psql-mark" ] || [ -e "$work/psql-mark.refused" ] ||
  [ ! -s "$work/psql-mark.sent" ]; then
  echo 'FEHLER: das Anhalten beim Zurückgeben der Anmeldung am Ende wurde nicht erreicht, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
fi
grep -q 'alter role opengewerk_app login' "$CALLS" || {
  echo 'FEHLER: ein Anhalten beim Zurückgeben der Anmeldung nahm sie der Anwendung wieder'
  cat "$work/out"
  exit 1
}
if [ "$restore_status" -ne 0 ] || [ -n "$(ls -A "$work/stop-tmp")" ]; then
  echo "FEHLER: ein Anhalten beim Zurückgeben der Anmeldung am Ende brach den Weg hinaus ab (Status $restore_status)"
  ls -A "$work/stop-tmp"
  cat "$work/out"
  exit 1
fi
check 'Anhalten: Rückspielen und Prüfen enden auf ihrem Weg hinaus, das Rückspielen gibt die Anmeldung nur ohne ersetzte Datenbank zurück'

# 8c. A backup from an earlier version than the database it replaces: the
# restore goes through, and the application stays locked with the note
# start.sh looks for, until the migrations have run (#988). The same version
# gives the login back at once, see 8.
taken env POSTGRES_DB=opengewerk LEVEL_BEFORE=3 LEVEL_AFTER=2 sh "$work/bin/restore.sh" "$ours"
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: die Anwendung bekam die Anmeldung vor den Migrationen zurück'
  exit 1
fi
grep -q "comment on role opengewerk_app is 'restored, waiting for migrations'" "$CALLS" || {
  echo 'FEHLER: die Rolle trägt nicht den Vermerk, nach dem start.sh sucht'
  exit 1
}
grep -q 'älteren Fassung' "$work/out" || {
  echo 'FEHLER: die Meldung sagt nicht, warum die Anwendung ausgesperrt bleibt'
  cat "$work/out"
  exit 1
}
# The way back to a version up to 0.8.0, whose start.sh knows no note: the
# running application stopped first, then the login given back.
awk '/^  docker compose -f docker\/compose.yaml stop app backup-schedule$/ { stopped = NR }
  /alter role opengewerk_app login; comment on role opengewerk_app is null/ { unlocked = NR }
  END { exit !(stopped && unlocked && stopped < unlocked) }' "$work/out" || {
  echo 'FEHLER: die Meldung nennt nicht, wie eine Fassung bis 0.8.0 nach dem Anhalten die Anmeldung zurückbekommt'
  cat "$work/out"
  exit 1
}
# Locked before the run, by an earlier restore: the database this one
# replaces may itself be older than the application, so how far its
# migrations had come proves nothing. Locked with the note as well.
taken env POSTGRES_DB=opengewerk WAS_LOCKED=t sh "$work/bin/restore.sh" "$ours"
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: nach einer Sperre von vor dem Lauf kam die Anmeldung vor den Migrationen zurück'
  exit 1
fi
grep -q "comment on role opengewerk_app is 'restored, waiting for migrations'" "$CALLS" || {
  echo 'FEHLER: nach einer Sperre von vor dem Lauf trägt die Rolle nicht den Vermerk'
  exit 1
}
# A database without any migrations before the run says nothing about the
# version the application needs either.
taken env POSTGRES_DB=opengewerk LEVEL_BEFORE=0 sh "$work/bin/restore.sh" "$ours"
if grep -q 'alter role opengewerk_app login' "$CALLS"; then
  echo 'FEHLER: nach einer Datenbank ohne Migrationen kam die Anmeldung vor den Migrationen zurück'
  exit 1
fi
grep -q 'keine Migrationen' "$work/out" || {
  echo 'FEHLER: die Meldung sagt nicht, warum die Anwendung ausgesperrt bleibt'
  cat "$work/out"
  exit 1
}
check 'Rückspielen: eine ältere Sicherung lässt die Anwendung bis zu den Migrationen ausgesperrt'

# 9. The heads of the chains go into statements of the superuser after the
# restore, and into those of verify.sh. A line that is no head is turned away
# before, also from an archive taken on the word of whoever types the flag.
# The manifest is made to fit, so that it is the line that is turned away.
with_chains() {
  printf '%s\n' "$1" > audit-chains.tsv
  sum=$(sha256sum audit-chains.tsv | cut -d' ' -f1)
  sed -i "s/\"audit-chains.tsv\": \"[0-9a-f]*\"/\"audit-chains.tsv\": \"$sum\"/" manifest.json
}

tab=$(printf '\t')
tenant='01931c00-0000-7000-8000-000000000001'
# A statement as long as a UUID, a UUID cut short, a number with a statement
# behind it, and no number.
statement="x'; select 1; --$(printf '%020d' 0 | tr 0 a)"
for line in "${statement}${tab}1${tab}" "${tenant%-*}${tab}1${tab}" \
  "${tenant}${tab}1; select 1${tab}" "${tenant}${tab}${tab}"; do
  repacked with_chains "$line"
  refused 'kein Kopf einer Kette' env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" --skip-origin-check "$ours"
  refused 'kein Kopf einer Kette' env POSTGRES_DB=opengewerk sh "$work/bin/verify.sh" --skip-origin-check "$ours"
done
# A line that is a head gets through to the query. The stand-in of psql knows
# no chain, so the comparison after it fails, and says so.
repacked with_chains "${tenant}${tab}7${tab}$(printf '%064d' 0 | tr 0 a)"
for script in restore.sh verify.sh; do
  : > "$CALLS"
  if env POSTGRES_DB=opengewerk sh "$work/bin/$script" --skip-origin-check "$ours" > "$work/out" 2>&1; then
    printf 'FEHLER: %s lief gegen eine Kette durch, die die Datenbank nicht kennt\n' "$script"
    exit 1
  fi
  grep -q -e 'die Kette weicht von der Sicherung ab' -e 'Eintrag 6 fehlt heute' "$work/out"
  grep -q "tenant_id = '${tenant}'" "$CALLS"
done
cp "$pristine" "$work/backups/$ours"
check 'Audit-Ketten: eine Zeile, die kein Kopf ist, wird abgelehnt, bevor sie in eine Abfrage geht'

# 10. How a backup reaches the target (opengewerk-haustechnik#360). Under a
# prefix of its own, so that "latest" of the checks above stays where it was.
# What lay on the target while age encrypted is written down by the stand-in:
# the archives from before and the hidden file it encrypts into, never a
# packed archive or a dump in the clear. And the parts in the container, which
# are readable by their owner alone.
export BACKUP_PREFIX=streamed
ls -A "$work/backups" > "$work/before"
cp "$work/status/archives.sha256" "$work/record-before"

POSTGRES_DB=opengewerk BACKUP_KEEP=0 BACKUP_AGE_RECIPIENT="$recipient" AGE_SAW="$work/saw" \
  sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
streamed=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
printf '%s' "$streamed" | grep -Eq '^streamed-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.tar\.gz\.age$'
grep -vxF -f "$work/before" "$work/saw" > "$work/new" || true
if [ "$(wc -l < "$work/new")" -ne 1 ] ||
  ! grep -Eqx "\.${streamed%.tar.gz.age}\.[A-Za-z0-9]{6}" "$work/new"; then
  echo 'FEHLER: während age lief, lag auf dem Ziel mehr als die verborgene Datei:'
  cat "$work/new"
  exit 1
fi
ls -A "$work/backups" | grep -vxF -f "$work/before" > "$work/new" || true
test "$(cat "$work/new")" = "$streamed"
test "$(stat -c %a "$work/backups/$streamed")" = 600
test "$(stat -c %a "$work/backups/$named")" = 600
test "$(cat "$work/saw.parts")" = 600
test -z "$(ls -A "$work/tmp")"
check 'Strom: auf dem Ziel liegt nur die verschlüsselte Datei, nur für ihren Besitzer lesbar, die Teile sind weg'

# What the record holds: the archive with its SHA-256, a line more than before,
# and the same in last.json, which stays readable for the application.
hash=$(sha256sum "$work/backups/$streamed" | cut -d' ' -f1)
grep -vxF -f "$work/record-before" "$work/status/archives.sha256" > "$work/new"
test "$(cat "$work/new")" = "$hash  $streamed"
grep -q "\"sha256\": \"$hash\"" "$work/status/last.json"
grep -q "\"archive\": \"$streamed\"" "$work/status/last.json"
grep -q '"encrypted": true' "$work/status/last.json"
test "$(stat -c %a "$work/status/last.json")" = 644
"$real_age" --decrypt --identity "$work/key.txt" "$work/backups/$streamed" | "$real_tar" -tzf - | grep -qx './manifest.json'
taken env POSTGRES_DB=opengewerk BACKUP_AGE_RECIPIENT="$recipient" BACKUP_AGE_IDENTITY="$work/key.txt" \
  sh "$work/bin/restore.sh" latest
grep -qx "Sicherung: $streamed" "$work/out"
grep -q '^pg_restore ' "$CALLS"
check 'Verzeichnis: Name und Prüfsumme der Sicherung auf der Instanz, das Rückspielen nimmt sie'

# The checksum in the record is the one of the bytes this backup wrote, taken
# on their way to the target, and never read back from there. Here the hidden
# file on the target is replaced after the writing and before the record, by
# an archive of somebody else, whole and encrypted to the same key: the record
# keeps the checksum and the size of the own bytes, and the archive that lies
# on the target is turned away.
"$real_age" --recipient "$recipient" --output "$work/foreign.age" "$pristine"
POSTGRES_DB=opengewerk BACKUP_KEEP=0 BACKUP_PREFIX=swapped BACKUP_AGE_RECIPIENT="$recipient" \
  AGE_SWAPS="$work/foreign.age" AGE_KEPT="$work/own-bytes" sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
swapped=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
cmp -s "$work/foreign.age" "$work/backups/$swapped"
own=$(sha256sum "$work/own-bytes" | cut -d' ' -f1)
grep -qx "$own  $swapped" "$work/status/archives.sha256"
grep -q "\"sha256\": \"$own\"" "$work/status/last.json"
grep -q "\"bytes\": $(stat -c %s "$work/own-bytes")," "$work/status/last.json"
refused 'weicht vom Verzeichnis ab' env POSTGRES_DB=opengewerk BACKUP_PREFIX=swapped \
  BACKUP_AGE_RECIPIENT="$recipient" BACKUP_AGE_IDENTITY="$work/key.txt" sh "$work/bin/restore.sh" latest
check 'Verzeichnis: eingetragen wird die Prüfsumme der eigenen Bytes, ein danach getauschtes Archiv wird abgelehnt'

# What is checked is what is read: the archive is copied from the target once,
# and replaced there after the check, before age or tar read it, the restore
# and the check of the chains still read the archive that was checked. An
# encrypted one and one in the clear, because they are read by different
# tools.
printf 'kein Archiv' > "$work/swap"
cp "$work/backups/$streamed" "$work/kept"
for script in restore.sh verify.sh; do
  taken env POSTGRES_DB=opengewerk BACKUP_AGE_RECIPIENT="$recipient" BACKUP_AGE_IDENTITY="$work/key.txt" \
    SWAP_FROM="$work/swap" SWAP_ONTO="$work/backups/$streamed" sh "$work/bin/$script" latest
  cmp -s "$work/swap" "$work/backups/$streamed"
  [ "$script" = verify.sh ] || grep -q '^pg_restore ' "$CALLS"
  cp "$work/kept" "$work/backups/$streamed"
done
for script in restore.sh verify.sh; do
  taken env BACKUP_PREFIX=opengewerk POSTGRES_DB=opengewerk \
    SWAP_FROM="$work/swap" SWAP_ONTO="$work/backups/$ours" sh "$work/bin/$script" "$ours"
  cmp -s "$work/swap" "$work/backups/$ours"
  [ "$script" = verify.sh ] || grep -q '^pg_restore ' "$CALLS"
  cp "$pristine" "$work/backups/$ours"
done

# And the checksum is the one of the copy: when the target held another file
# at the moment it was copied, the copy is turned away, though the archive is
# back on the target by the time anybody looks.
for script in restore.sh verify.sh; do
  refused 'weicht vom Verzeichnis ab' env POSTGRES_DB=opengewerk BACKUP_AGE_RECIPIENT="$recipient" \
    BACKUP_AGE_IDENTITY="$work/key.txt" CP_SERVES="$work/swap" CP_FROM="$work/backups/$streamed" \
    sh "$work/bin/$script" latest
done
check 'Herkunft: geprüft und gelesen wird dieselbe Kopie, ein danach getauschtes Archiv bleibt ungelesen'

# Two backups that finish at the same moment both keep their line: the record
# is rewritten under a lock. The lock is held here while a line is added the
# same way, read before the backup runs and written after it would have.
(
  flock 9
  cp "$work/status/archives.sha256" "$work/held"
  sleep 2
  printf '%064d  %s\n' 0 'held-2026-01-01T000000Z.tar.gz' >> "$work/held"
  mv "$work/held" "$work/status/archives.sha256"
) 9> "$work/status/.lock" &
holder=$!
sleep 1
BACKUP_PREFIX=locked POSTGRES_DB=opengewerk BACKUP_KEEP=0 sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
wait "$holder"
locked=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
grep -q '  held-2026-01-01T000000Z.tar.gz$' "$work/status/archives.sha256"
grep -q "  ${locked}\$" "$work/status/archives.sha256"
check 'Verzeichnis: zwei Sicherungen zugleich behalten beide ihre Zeile'

# A backup that fails on the way leaves nothing on the target and no record:
# age that breaks off after a little, age that refuses the recipient, a tar
# that breaks off while age carries on, which only pipefail notices, and a
# record that cannot be written once the archive is whole and has its name,
# which takes the archive with it. Under a prefix of their own: in the second
# of the backup above, a name of its own would already be taken.
export BACKUP_PREFIX=failing
ls -A "$work/backups" > "$work/before"
cp "$work/status/archives.sha256" "$work/record-before"
cp "$work/status/last.json" "$work/last-before"

failed_backup() {
  if env POSTGRES_DB=opengewerk BACKUP_KEEP=0 "$@" sh "$work/bin/backup.sh" > "$work/out" 2>&1; then
    printf 'FEHLER: die Sicherung lief durch: %s\n' "$*"
    cat "$work/out"
    exit 1
  fi

  ls -A "$work/backups" > "$work/after"

  if ! cmp -s "$work/before" "$work/after"; then
    printf 'FEHLER: nach einer gescheiterten Sicherung liegt etwas auf dem Ziel: %s\n' "$*"
    grep -vxF -f "$work/before" "$work/after" || true
    exit 1
  fi

  if ! cmp -s "$work/record-before" "$work/status/archives.sha256" ||
    ! cmp -s "$work/last-before" "$work/status/last.json"; then
    printf 'FEHLER: eine gescheiterte Sicherung steht im Verzeichnis: %s\n' "$*"
    exit 1
  fi

  test -z "$(ls -A "$work/tmp")"
}

failed_backup BACKUP_AGE_RECIPIENT="$recipient" AGE_FAILS=halfway
failed_backup BACKUP_AGE_RECIPIENT=age1nothing
failed_backup BACKUP_AGE_RECIPIENT="$recipient" TAR_FAILS=1
: > "$work/no-folder"
failed_backup BACKUP_AGE_RECIPIENT="$recipient" BACKUP_STATUS_PATH="$work/no-folder"
check 'Strom: scheitert age oder tar, bleibt auf dem Ziel nichts liegen und nichts im Verzeichnis'

# A second backup in the same second would take the name of the first. It
# stops before that, and when it fails, the first stays as it was.
POSTGRES_DB=opengewerk BACKUP_KEEP=0 FIXED_STAMP=2026-05-05T000000Z sh "$work/bin/backup.sh" > "$work/out" 2>&1 || {
  cat "$work/out"
  exit 1
}
first="$work/backups/failing-2026-05-05T000000Z.tar.gz"
sum=$(sha256sum "$first")

if POSTGRES_DB=opengewerk BACKUP_KEEP=0 FIXED_STAMP=2026-05-05T000000Z BACKUP_STATUS_PATH="$work/no-folder" \
  sh "$work/bin/backup.sh" > "$work/out" 2>&1; then
  echo 'FEHLER: eine zweite Sicherung in derselben Sekunde lief durch'
  exit 1
fi

grep -q 'liegt schon eine Sicherung' "$work/out"
test "$(sha256sum "$first")" = "$sum"
check 'Strom: eine zweite Sicherung in derselben Sekunde lässt die erste, wie sie war'

# 11. The file store around the database (#991). While the backup runs, the
# sweep takes a file whose last row went after the dump, and somebody uploads
# a file. The archive holds both, the old one in the part from before the
# dump and the new one in the part after it, and a restore brings both back.
# A file that was there all along is in the first part and not again in the
# second.
stored() {
  printf '%s/%s/%s/%s' "$STORAGE_PATH" "$(printf '%s' "$1" | cut -c1-2)" "$(printf '%s' "$1" | cut -c3-4)" "$1"
}
put_old() {
  mkdir -p "$(dirname "$(stored "$2")")"
  printf '%s' "$1" > "$(stored "$2")"
}
hash_of() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}
# The archive the last backup named, unpacked into $work/$1.
unpacked() {
  name=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
  rm -rf "${work:?}/$1"
  mkdir "$work/$1"
  tar --extract --gzip --file "$work/backups/$name" --directory "$work/$1"
}
# Each backup here under a name of its own: several run within a second.
stamp_number=0
run_backup() {
  stamp_number=$((stamp_number + 1))
  FIXED_STAMP=$(printf '2031-01-01T%06dZ' "$stamp_number") POSTGRES_DB=opengewerk \
    sh "$work/bin/backup.sh" > "$work/out" 2>&1
}
# A backup that has to fail at what a stand-in does: the stand-in leaves a
# mark, so a backup that failed earlier for another reason does not count.
refused_at() {
  rm -f "$work/fake-mark"
  if FAKE_MARK="$work/fake-mark" run_backup; then
    echo "FEHLER: $1"
    exit 1
  fi
  test -f "$work/fake-mark" || {
    echo "FEHLER: $1 (der Fehler trat nie ein)"
    cat "$work/out"
    exit 1
  }
}
backed_up() {
  run_backup || {
    echo "FEHLER: $1"
    cat "$work/out"
    exit 1
  }
}

old_text='abgelegt vor der Sicherung'
old_hash=$(hash_of "$old_text")
kept_text='liegt die ganze Zeit da'
kept_hash=$(hash_of "$kept_text")
new_text='abgelegt während der Sicherung'
new_hash=$(hash_of "$new_text")
put_old "$old_text" "$old_hash"
put_old "$kept_text" "$kept_hash"

DUMP_SWEEPS="$old_hash" DUMP_UPLOADS="$new_text" DUMP_WRITES=unterwegs.part \
  backed_up 'die Sicherung um die Datenbank scheiterte'
around=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
unpacked around
grep -q '"storage-late.tar"' "$work/around/manifest.json"
first_names=$(tar --list --file "$work/around/storage.tar")
late_names=$(tar --list --file "$work/around/storage-late.tar")
printf '%s\n' "$first_names" | grep -q "$old_hash" || {
  echo 'FEHLER: die Datei, die das Aufräumen während der Sicherung nahm, fehlt im Archiv'
  exit 1
}
printf '%s\n' "$late_names" | grep -q "$new_hash" || {
  echo 'FEHLER: die Datei, die während der Sicherung kam, fehlt im Archiv'
  exit 1
}
if printf '%s\n' "$late_names" | grep -q -e 'unterwegs.part' -e "$kept_hash"; then
  echo 'FEHLER: im zweiten Teil steht ein Schreibvorgang oder eine Datei aus dem ersten'
  exit 1
fi
for leftover in vanished.patterns storage.err storage.names storage.first storage.now \
  storage-late.list storage-late.err storage-late.files storage-late.raw storage-late; do
  if [ -e "$work/around/$leftover" ]; then
    echo "FEHLER: die Arbeitsdatei $leftover steht im Archiv"
    exit 1
  fi
done

taken env POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" "$around"
test "$(cat "$(stored "$old_hash")")" = "$old_text" || {
  echo 'FEHLER: das Rückspielen brachte die genommene Datei nicht zurück'
  exit 1
}
test "$(cat "$(stored "$new_hash")")" = "$new_text" || {
  echo 'FEHLER: das Rückspielen brachte die Datei aus dem zweiten Teil nicht zurück'
  exit 1
}
check 'Dateispeicher um die Datenbank: genommene und neue Datei im Archiv und nach dem Rückspielen'

# An archive whose first part holds a link where a folder belongs and whose
# second part holds a file under that folder: the restore puts the file into
# the store and nothing through the link.
mkdir -p "$work/outside-restore"
through_text='durch den Link'
through_hash=$(hash_of "$through_text")
through_folder=$(dirname "$(stored "$through_hash")" | sed "s|^$STORAGE_PATH/||")
rm -rf "$work/through"
mkdir -p "$work/through/first" "$work/through/late"
tar --extract --gzip --file "$work/backups/$around" --directory "$work/through"
tar --extract --file "$work/through/storage.tar" --directory "$work/through/first"
mkdir -p "$work/through/first/$(dirname "$through_folder")"
rm -rf "${work:?}/through/first/$through_folder"
ln -s "$work/outside-restore" "$work/through/first/$through_folder"
tar --create --file "$work/through/storage.tar" --directory "$work/through/first" .
tar --extract --file "$work/through/storage-late.tar" --directory "$work/through/late"
mkdir -p "$work/through/late/$through_folder"
printf '%s' "$through_text" > "$work/through/late/$through_folder/$through_hash"
tar --create --file "$work/through/storage-late.tar" --directory "$work/through/late" .
rm -rf "$work/through/first" "$work/through/late"
for part in storage.tar storage-late.tar; do
  sum=$(sha256sum "$work/through/$part" | cut -d' ' -f1)
  sed "s|\"$part\": \"[0-9a-f]*\"|\"$part\": \"$sum\"|" "$work/through/manifest.json" > "$work/through/manifest.new"
  mv "$work/through/manifest.new" "$work/through/manifest.json"
done
tar --create --gzip --file "$work/backups/$around" --directory "$work/through" .
POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" --skip-origin-check "$around" > "$work/out" 2>&1 || {
  echo 'FEHLER: das Rückspielen des Archivs mit dem Link scheiterte'
  cat "$work/out"
  exit 1
}
outside_now=$(ls -A "$work/outside-restore")
if [ -n "$outside_now" ]; then
  echo 'FEHLER: das Rückspielen schrieb durch einen Link aus dem ersten Teil'
  exit 1
fi
if [ -L "$STORAGE_PATH/$through_folder" ] || [ ! -f "$STORAGE_PATH/$through_folder/$through_hash" ]; then
  echo 'FEHLER: die Datei aus dem zweiten Teil liegt nicht im Speicher, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
fi
# And when rm cannot take the link, the restore stops before the second part.
rm -rf "$work/outside-restore"
mkdir -p "$work/outside-restore"
tar --create --gzip --file "$work/backups/$around" --directory "$work/through" .
if POSTGRES_DB=opengewerk RM_FAILS_ON="$through_folder" sh "$work/bin/restore.sh" --skip-origin-check "$around" \
  > "$work/out" 2>&1; then
  echo 'FEHLER: ein Link, den rm nicht nahm, ließ das Rückspielen durch'
  exit 1
fi
grep -q 'blieb ein Link' "$work/out"
outside_now=$(ls -A "$work/outside-restore")
if [ -n "$outside_now" ]; then
  echo 'FEHLER: das Rückspielen schrieb durch einen Link, den rm nicht nahm'
  exit 1
fi
check 'Rückspielen: ein Link im ersten Teil leitet den zweiten nicht aus dem Speicher hinaus'

# A link that the second part brings itself has no place in the store either.
late_link_archive() {
  mkdir late
  tar --extract --file storage-late.tar --directory late
  mkdir -p late/ab/cd
  ln -s /etc late/ab/cd/fremd
  tar --create --file storage-late.tar --directory late .
  rm -rf late
  sum=$(sha256sum storage-late.tar | cut -d' ' -f1)
  sed "s|\"storage-late.tar\": \"[0-9a-f]*\"|\"storage-late.tar\": \"$sum\"|" manifest.json > manifest.new
  mv manifest.new manifest.json
}
repacked late_link_archive
taken env BACKUP_PREFIX=opengewerk POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" --skip-origin-check "$ours"
odd_in_store=$(find "$STORAGE_PATH" ! -type f ! -type d)
if [ -n "$odd_in_store" ]; then
  echo 'FEHLER: ein Link aus dem zweiten Teil blieb im Speicher'
  exit 1
fi
check 'Rückspielen: auch ein Link aus dem zweiten Teil bleibt nicht im Speicher'

# A file the first part did not hold and that does not lie where the store
# keeps it, even one named after its own hash, does not come into the second
# part: only two folders from the hash and then the hash are a stored file.
astray_text='am falschen Ort'
astray_hash=$(hash_of "$astray_text")
DUMP_ASTRAY="$astray_text" backed_up 'eine Datei am falschen Ort beendete die Sicherung'
unpacked madeup
madeup_names=$(tar --list --file "$work/madeup/storage-late.tar")
if printf '%s\n' "$madeup_names" | grep -q "$astray_hash"; then
  echo 'FEHLER: eine Datei, die nicht nach ihrem Hash liegt, steht im zweiten Teil'
  exit 1
fi
rm -rf "$STORAGE_PATH/00"
check 'Dateispeicher: nur Dateien, die nach ihrem Hash liegen, kommen in den zweiten Teil'

# What may happen to a new file between find and the tar of the second part.
# It goes: the backup goes on. It becomes a link, a pipe, or its folder a
# link into this container: the backup goes on, does not wait on the pipe,
# and neither the link, the pipe nor the file behind it is in the archive.
printf 'GEHEIMNIS DES CONTAINERS' > "$work/secret"
mkdir -p "$work/outside"
late_number=0
for does in vanish link pipe dir folder; do
  late_number=$((late_number + 1))
  late_text="gleich verändert: $does"
  late_hash=$(hash_of "$late_text")
  case "$does" in
    folder) target="$work/outside" ;;
    *) target="$work/secret" ;;
  esac
  rm -f "$work/late-done"
  DUMP_UPLOADS="$late_text" LATE_HASH="$late_hash" LATE_DOES="$does" LATE_TARGET="$target" \
    LATE_DONE="$work/late-done" FIXED_STAMP="2031-02-01T0000${late_number}0Z" \
    timeout 120 sh -c 'POSTGRES_DB=opengewerk sh "$1/bin/backup.sh"' sh "$work" > "$work/out" 2>&1 || {
    echo "FEHLER: die Sicherung endete bei $does nicht ordentlich"
    cat "$work/out"
    exit 1
  }
  test -f "$work/late-done" || {
    echo "FEHLER: bei $does geschah nichts, der Fall wurde nicht geprüft"
    exit 1
  }
  unpacked "late-$does"
  mkdir "$work/late-$does/late"
  tar --extract --file "$work/late-$does/storage-late.tar" --directory "$work/late-$does/late"
  odd_in_late=$(find "$work/late-$does/late" ! -type d ! -type f)
  # grep says 1 for no match; a 2, a file it could not read, fails the case.
  secret_found=0
  grep -r -q 'GEHEIMNIS DES CONTAINERS' "$work/late-$does/late" || secret_found=$?
  if [ "$secret_found" -gt 1 ]; then
    echo "FEHLER: bei $does ließ sich der zweite Teil nicht lesen"
    exit 1
  fi
  if [ -n "$odd_in_late" ] || [ "$secret_found" -eq 0 ] ||
    [ -e "$work/late-$does/late/$(stored "$late_hash" | sed "s|^$STORAGE_PATH/||")" ]; then
    echo "FEHLER: bei $does steht etwas Fremdes oder die veränderte Datei im zweiten Teil"
    exit 1
  fi
  late_folder=$(dirname "$(stored "$late_hash")")
  rm -rf "$late_folder" "$late_folder.moved" "$(dirname "$late_folder")"
done
check 'Dateispeicher: verschwunden, Link, Pipe, Ordner oder Ordner als Link zwischen find und tar, nichts Fremdes im Archiv'

# The first part, packed while the store is in use: a write under way stays
# out of it, a file the sweep takes while tar runs does not end the backup,
# and any other error of tar still does.
printf 'halb' > "$STORAGE_PATH/liegengeblieben.part"
TAR_MISSES="./$(hash_of 'weg')" backed_up 'eine Datei, die während tar verschwand, beendete die Sicherung'
unpacked first
first_part_names=$(tar --list --file "$work/first/storage.tar")
if printf '%s\n' "$first_part_names" | grep -q 'liegengeblieben.part'; then
  echo 'FEHLER: ein Schreibvorgang, der noch lief, steht im ersten Teil'
  exit 1
fi
rm -f "$STORAGE_PATH/liegengeblieben.part"
TAR_MISSES=/nirgends refused_at 'ein anderer Fehler von tar ließ die Sicherung durch'
check 'Dateispeicher vor der Datenbank: ohne .part, eine verschwundene Datei geduldet, jeder andere Fehler nicht'

# The other forms of a file that went while it was read: tar could not open
# it, or find found it gone. Neither ends the backup; another error of find
# still does.
TAR_CANT_OPEN="./ab/cd/$(hash_of 'weg')" backed_up 'eine Datei, die tar nicht mehr öffnen konnte, beendete die Sicherung'
FIND_MISSES=./ab/cd/unterwegs.part backed_up 'ein .part, das während find verschwand, beendete die Sicherung'
FIND_MISSES=/nirgends refused_at 'ein anderer Fehler von find ließ die Sicherung durch'
check 'Dateispeicher: eine Datei, die tar nicht mehr öffnen konnte oder find verschwunden fand, beendet die Sicherung nicht'

# A failure of tar that names no gone file is no file that went, and a file
# that went beside several other errors does not hide them.
TAR_SILENT=1 refused_at 'ein Fehler von tar ohne Meldung ließ die Sicherung durch'
TAR_MIXED=1 refused_at 'andere Fehler neben einer verschwundenen Datei ließen die Sicherung durch'
rm -f "$work/grep-mark"
if TAR_MISSES="./$(hash_of 'weg')" GREP_FAILS=1 GREP_MARK="$work/grep-mark" run_backup; then
  echo 'FEHLER: ein grep, das die Meldungen nicht lesen konnte, ließ die Sicherung durch'
  exit 1
fi
test -f "$work/grep-mark" || {
  echo 'FEHLER: grep -v wurde nie gefragt, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
check 'Dateispeicher: ein Fehler ohne Meldung oder neben einer verschwundenen Datei beendet die Sicherung'

# A link or a pipe in the store when the first part is packed, under a name
# of the store or elsewhere, a link with a line break in its target among
# them: the store never makes one, and the backup stops without an archive.
odd_text='erst Link oder Pipe, dann Datei'
odd_hash=$(hash_of "$odd_text")
odd_place=$(stored "$odd_hash")
for kind in link pipe target; do
  mkdir -p "$(dirname "$odd_place")"
  case "$kind" in
    link) ln -s "./$(printf '%s' "$odd_place" | sed "s|^$STORAGE_PATH/||")" "$odd_place" ;;
    pipe) mkfifo "$odd_place" ;;
    target) ln -s "irgendwo
-rw-r--r-- 0/0 1 2031-01-01 00:00:00 ./$(printf '%s' "$odd_place" | sed "s|^$STORAGE_PATH/||")" "$STORAGE_PATH/verweis" ;;
  esac
  archives_before=$(ls "$work/backups" | wc -l)
  if DUMP_UPLOADS="$odd_text" run_backup; then
    printf 'FEHLER: ein %s im Speicher ließ die Sicherung durch\n' "$kind"
    exit 1
  fi
  grep -q 'weder Datei noch Ordner' "$work/out" || {
    printf 'FEHLER: ein %s im Speicher beendete die Sicherung nicht an seiner Stelle\n' "$kind"
    cat "$work/out"
    exit 1
  }
  test "$(ls "$work/backups" | wc -l)" = "$archives_before"
  "$real_rm" -rf "$(dirname "$odd_place")" "$STORAGE_PATH/verweis"
done
check 'Dateispeicher: ein Link oder eine Pipe im Speicher beendet die Sicherung'

# A file in the first part whose name ends like a stored file after a blank,
# "./Import ./ab/cd/<hash>": the file uploaded at the true name during the
# dump is not taken for held and comes into the second part.
blank_text='hinter einem Leerzeichen'
blank_hash=$(hash_of "$blank_text")
blank_tail=$(stored "$blank_hash" | sed "s|^$STORAGE_PATH/||")
mkdir -p "$STORAGE_PATH/Import ./$(dirname "$blank_tail")"
printf '%s' "$blank_text" > "$STORAGE_PATH/Import ./$blank_tail"
DUMP_UPLOADS="$blank_text" backed_up 'ein Name mit Leerzeichen im ersten Teil beendete die Sicherung'
unpacked blanked
blanked_names=$(tar --list --file "$work/blanked/storage-late.tar")
printf '%s\n' "$blanked_names" | grep -q "^\./$blank_tail\$" || {
  echo 'FEHLER: eine Datei, die ein Name mit Leerzeichen im ersten Teil vortäuschte, fehlt im zweiten'
  exit 1
}
rm -rf "$STORAGE_PATH/Import ." "$(dirname "$(stored "$blank_hash")")"
# And one whose name is the hash with a blank at its end.
trailing_text='Leerzeichen am Ende'
trailing_hash=$(hash_of "$trailing_text")
mkdir -p "$(dirname "$(stored "$trailing_hash")")"
printf '%s' "$trailing_text" > "$(stored "$trailing_hash") "
DUMP_UPLOADS="$trailing_text" backed_up 'ein Name mit Leerzeichen am Ende im ersten Teil beendete die Sicherung'
unpacked trailing
trailing_names=$(tar --list --file "$work/trailing/storage-late.tar")
printf '%s\n' "$trailing_names" | grep -q "^\./$(stored "$trailing_hash" | sed "s|^$STORAGE_PATH/||")\$" || {
  echo 'FEHLER: eine Datei, die ein Name mit Leerzeichen am Ende im ersten Teil vortäuschte, fehlt im zweiten'
  exit 1
}
rm -rf "$(dirname "$(stored "$trailing_hash")")"
check 'Dateispeicher: ein Name mit Leerzeichen im ersten Teil hält keine Datei aus dem zweiten'

# A name with a line break whose second line reads like an entry of the
# listing, for a file uploaded under that hash during the dump: the backup
# stops instead of taking the file for held.
broken_text='Zeilenumbruch im Namen'
broken_hash=$(hash_of "$broken_text")
broken_tail=$(stored "$broken_hash" | sed "s|^$STORAGE_PATH/||")
# A name can hold no slash, so the line break sits in the first folder, and
# the rest of the path follows below it.
broken_path="$STORAGE_PATH/x
-rw-r--r-- 0/0 1 2031-01-01 00:00:00 ./$broken_tail"
mkdir -p "$(dirname "$broken_path")"
printf 'x' > "$broken_path"
archives_before=$(ls "$work/backups" | wc -l)
if DUMP_UPLOADS="$broken_text" run_backup; then
  echo 'FEHLER: ein Name über mehrere Zeilen im Speicher ließ die Sicherung durch'
  exit 1
fi
grep -q 'Name über mehrere Zeilen' "$work/out" || {
  echo 'FEHLER: ein Name über mehrere Zeilen beendete die Sicherung nicht an seiner Stelle'
  cat "$work/out"
  exit 1
}
test "$(ls "$work/backups" | wc -l)" = "$archives_before"
"$real_rm" -rf "$STORAGE_PATH/x
-rw-r--r-- 0" "$(dirname "$(stored "$broken_hash")")"
check 'Dateispeicher: ein Name über mehrere Zeilen beendet die Sicherung'

# A link or pipe in the second part that rm could not take ends the backup.
pipe_text='Pipe, die bleibt'
pipe_hash=$(hash_of "$pipe_text")
DUMP_UPLOADS="$pipe_text" LATE_HASH="$pipe_hash" LATE_DOES=pipe LATE_TARGET="$work/secret" \
  LATE_DONE="$work/late-done" RM_FAILS_ON="$pipe_hash" refused_at 'eine Pipe, die rm nicht nahm, blieb im zweiten Teil'
grep -q 'keine Datei des Speichers' "$work/out"
"$real_rm" -rf "$(dirname "$(stored "$pipe_hash")")"
check 'Dateispeicher: was rm im zweiten Teil nicht nehmen kann, beendet die Sicherung'

# A new file sha256sum cannot read ends the backup instead of leaving the
# second part without it.
unread_text='nicht lesbar'
unread_hash=$(hash_of "$unread_text")
rm -f "$work/sha-failed"
if DUMP_UPLOADS="$unread_text" SHA_FAILS="$unread_hash" SHA_FAILED="$work/sha-failed" run_backup; then
  echo 'FEHLER: eine Datei, die sha256sum nicht lesen konnte, fehlte still im zweiten Teil'
  exit 1
fi
test -f "$work/sha-failed" || {
  echo 'FEHLER: sha256sum las die Datei nie, der Fall wurde nicht geprüft'
  exit 1
}
rm -rf "$(dirname "$(stored "$unread_hash")")"
check 'Dateispeicher: eine neue Datei, die sich nicht lesen lässt, beendet die Sicherung'

# A backup that has taken more than half a day by the time it read the store
# stops and writes no archive: the sweep could by then have taken a file the
# dump names.
echo '100.00 200.00' > "$work/uptime"
archives_before=$(ls "$work/backups" | wc -l)
if UPTIME_PATH="$work/uptime" UPTIME_JUMPS=1 run_backup; then
  echo 'FEHLER: eine Sicherung, die länger als einen halben Tag lief, ging durch'
  exit 1
fi
grep -q 'seit zwölf Stunden oder länger' "$work/out"
test "$(ls "$work/backups" | wc -l)" = "$archives_before" || {
  echo 'FEHLER: eine Sicherung, die zu lange lief, hinterließ ein Archiv'
  exit 1
}
# And one whose uptime cannot be read by then stops as well, without archive.
echo '100.00 200.00' > "$work/uptime"
if UPTIME_PATH="$work/uptime" UPTIME_GOES=1 run_backup; then
  echo 'FEHLER: eine Sicherung ohne messbare Laufzeit ging durch'
  exit 1
fi
grep -q 'lässt sich nicht messen' "$work/out"
test "$(ls "$work/backups" | wc -l)" = "$archives_before" || {
  echo 'FEHLER: eine Sicherung ohne messbare Laufzeit hinterließ ein Archiv'
  exit 1
}
check 'Dateispeicher: nach einem halben Tag bis zum Ende des Lesens bricht die Sicherung ab'

# A tar of the store that waits is ended when the twelve hours are over, and
# the backup stops without an archive instead of hanging.
waits_text='wartet'
echo '100.00 200.00' > "$work/uptime"
archives_before=$(ls "$work/backups" | wc -l)
if DUMP_UPLOADS="$waits_text" UPTIME_PATH="$work/uptime" UPTIME_ALMOST=1 TAR_HANGS=1 run_backup; then
  echo 'FEHLER: eine Sicherung, deren tar wartete, ging durch'
  exit 1
fi
grep -q 'in zwölf Stunden nicht zum Ende' "$work/out" || {
  echo 'FEHLER: eine Sicherung, deren tar wartete, endete nicht an der Grenze von zwölf Stunden'
  cat "$work/out"
  exit 1
}
test "$(ls "$work/backups" | wc -l)" = "$archives_before" || {
  echo 'FEHLER: eine Sicherung, deren tar wartete, hinterließ ein Archiv'
  exit 1
}
rm -rf "$(dirname "$(stored "$(hash_of "$waits_text")")")"
# A find over the store that hangs is ended the same way.
hangs_text='find hängt'
echo '100.00 200.00' > "$work/uptime"
if DUMP_UPLOADS="$hangs_text" UPTIME_PATH="$work/uptime" UPTIME_ALMOST=1 FIND_HANGS=1 run_backup; then
  echo 'FEHLER: eine Sicherung, deren find hing, ging durch'
  exit 1
fi
grep -q 'in zwölf Stunden nicht zum Ende' "$work/out" || {
  echo 'FEHLER: eine Sicherung, deren find hing, endete nicht an der Grenze von zwölf Stunden'
  cat "$work/out"
  exit 1
}
rm -rf "$(dirname "$(stored "$(hash_of "$hangs_text")")")"
check 'Dateispeicher: ein tar, das wartet, endet mit den zwölf Stunden'

# Both tars over the store run with that limit, the first part's and the
# second's, and so does the find between them.
limited_text='mit Grenze'
rm -f "$work/timeout-calls"
DUMP_UPLOADS="$limited_text" TIMEOUT_CALLS="$work/timeout-calls" backed_up 'eine Sicherung mit Zeitgrenze scheiterte'
grep -q -- "tar --create --file .*/storage.tar --directory $STORAGE_PATH " "$work/timeout-calls" &&
  grep -q -- "tar --create --no-recursion .* -T " "$work/timeout-calls" &&
  grep -q -- " find \. -type f\$" "$work/timeout-calls" || {
  echo 'FEHLER: nicht jedes tar über den Speicher lief mit der Zeitgrenze'
  cat "$work/timeout-calls"
  exit 1
}
rm -rf "$(dirname "$(stored "$(hash_of "$limited_text")")")"
check 'Dateispeicher: beide tar über den Speicher laufen mit der Zeitgrenze'

# The whole backup has a limit as well (#999). In a process group of its own,
# as schedule.sh starts it, a dump that waits for good ends after the twelve
# hours with everything the backup started: the dump is gone, and neither an
# archive, a hidden file on the target nor a part in TMPDIR is left. A time
# that can no longer be read ends it the same way.
# The names of the processes still alive in process group $1.
alive_in_group() {
  for stat_file in /proc/[0-9]*/stat; do
    stat_line=$(cat "$stat_file" 2>/dev/null) || continue
    process_name=${stat_line#*(}
    process_name=${process_name%%)*}
    # shellcheck disable=SC2086
    set -- "$1" ${stat_line##*) }
    if [ "$4" = "$1" ] && [ "$2" != Z ]; then
      printf '%s\n' "$process_name"
    fi
  done
}
mkdir -p "$work/run-tmp"
for unread in '' 1; do
  echo '100.00 200.00' > "$work/uptime"
  rm -f "$work/dump-pid"
  targets_before=$(ls -A "$work/backups" | wc -l)
  run_status=0
  # The dump waits ninety seconds and the watcher looks every five: a backup
  # that ends only after thirty was not ended by its limit but by the dump.
  run_started=$(date +%s)
  TMPDIR="$work/run-tmp" DUMP_HANGS="$work/dump-pid" DUMP_HANGS_FOR=90 UPTIME_PATH="$work/uptime" \
    UPTIME_GOES="$unread" FIXED_STAMP="2031-03-01T00000${unread:-0}Z" POSTGRES_DB=opengewerk \
    "$real_timeout" -s KILL 120 setsid sh "$work/bin/backup.sh" > "$work/out" 2>&1 || run_status=$?
  run_seconds=$(($(date +%s) - run_started))
  case "$unread" in
    1) said='lässt sich nicht messen' ;;
    *) said='Die Sicherung kam in zwölf Stunden nicht zum Ende' ;;
  esac
  if [ "$run_status" -eq 0 ] || [ "$run_seconds" -ge 30 ] || ! grep -q "$said" "$work/out"; then
    echo "FEHLER: eine Sicherung, deren Dump wartete, endete nicht an ihrer Grenze (Status $run_status nach $run_seconds Sekunden)"
    cat "$work/out"
    exit 1
  fi
  dump_pid=$(cat "$work/dump-pid")
  if kill -0 "$dump_pid" 2>/dev/null; then
    echo 'FEHLER: der wartende Dump lief nach dem Ende der Sicherung weiter'
    exit 1
  fi
  if [ "$(ls -A "$work/backups" | wc -l)" != "$targets_before" ] || [ -n "$(ls -A "$work/run-tmp")" ]; then
    echo 'FEHLER: eine Sicherung, die an ihrer Grenze endete, ließ etwas zurück'
    ls -A "$work/backups" "$work/run-tmp"
    exit 1
  fi
done
# A target that no longer answers when the backup cleans up keeps it there
# for half a minute and no longer: the hidden file stays and is named.
echo '100.00 200.00' > "$work/uptime"
run_status=0
run_started=$(date +%s)
TMPDIR="$work/run-tmp" DUMP_HANGS="$work/dump-pid" DUMP_HANGS_FOR=90 UPTIME_PATH="$work/uptime" \
  RM_BLOCKS_UNDER="$work/backups" FIXED_STAMP=2031-03-01T000003Z POSTGRES_DB=opengewerk \
  "$real_timeout" -s KILL 150 setsid sh "$work/bin/backup.sh" > "$work/out" 2>&1 || run_status=$?
run_seconds=$(($(date +%s) - run_started))
left_on_target=$(ls -A "$work/backups" | grep '^\..*-2031-03-01T000003Z\.' || true)
if [ "$run_status" -eq 0 ] || [ "$run_seconds" -ge 60 ] || [ -z "$left_on_target" ] ||
  ! grep -qF "sie bleibt dort liegen: $work/backups/$left_on_target" "$work/out"; then
  echo "FEHLER: eine Sicherung, deren Ziel beim Aufräumen nicht antwortete, endete nicht (Status $run_status nach $run_seconds Sekunden)"
  cat "$work/out"
  exit 1
fi
rm -f "$work/backups/$left_on_target"
# Started from a shell, in that shell's process group, the backup has no
# watcher: its TERM would end the shell as well. The dump that waits eight
# seconds past the twelve hours ends the backup at the check after it, and the
# shell around it lives on.
echo '100.00 200.00' > "$work/uptime"
rm -f "$work/outer-lives"
TMPDIR="$work/run-tmp" DUMP_HANGS="$work/dump-pid" DUMP_HANGS_FOR=8 UPTIME_PATH="$work/uptime" \
  FIXED_STAMP=2031-03-01T000005Z POSTGRES_DB=opengewerk \
  "$real_timeout" 60 setsid sh -c 'sh "$1/bin/backup.sh"; echo lives > "$1/outer-lives"' sh "$work" \
  > "$work/out" 2>&1 || true
if ! test -f "$work/outer-lives" || grep -q 'Die Sicherung kam in zwölf Stunden nicht zum Ende' "$work/out"; then
  echo 'FEHLER: eine Sicherung ohne eigene Prozessgruppe beendete die Shell, aus der sie lief'
  cat "$work/out"
  exit 1
fi
grep -q 'seit zwölf Stunden oder länger' "$work/out" || {
  echo 'FEHLER: die Sicherung ohne eigene Prozessgruppe endete nicht an der Prüfung nach dem Dump'
  cat "$work/out"
  exit 1
}
# A backup that ends in time takes its watcher along, and once its archive has
# its name it asks the target for no hidden file any more: a target that would
# not answer that does not hold it up.
echo '100.00 200.00' > "$work/uptime"
watched_text='mit Wächter'
run_started=$(date +%s)
UPTIME_PATH="$work/uptime" DUMP_UPLOADS="$watched_text" RM_BLOCKS_UNDER="$work/backups" \
  FIXED_STAMP=2031-03-01T000010Z POSTGRES_DB=opengewerk \
  setsid sh "$work/bin/backup.sh" > "$work/out" 2>&1 &
backup_pid=$!
wait "$backup_pid" || {
  echo 'FEHLER: eine Sicherung in einer eigenen Prozessgruppe scheiterte'
  cat "$work/out"
  exit 1
}
if [ $(($(date +%s) - run_started)) -ge 25 ]; then
  echo 'FEHLER: eine Sicherung wartete nach ihrem Ende noch auf das Ziel'
  cat "$work/out"
  exit 1
fi
if alive_in_group "$backup_pid" | grep -qvx sleep; then
  echo 'FEHLER: nach der Sicherung lief ihr Wächter weiter'
  alive_in_group "$backup_pid"
  exit 1
fi
rm -rf "$(dirname "$(stored "$(hash_of "$watched_text")")")"
# And schedule.sh starts it in a group of its own: a stand-in for backup.sh
# notes whether it leads one, and ends the schedule.
mkdir -p "$work/schedule-bin"
cat > "$work/schedule-bin/backup.sh" <<'FAKE'
#!/bin/sh
stat_line=$(cat "/proc/$$/stat")
# shellcheck disable=SC2086
set -- ${stat_line##*) }
if [ "$3" = "$$" ]; then
  echo leads > "$SCHEDULE_MARK"
else
  echo shares > "$SCHEDULE_MARK"
fi
kill "$PPID"
FAKE
chmod +x "$work/schedule-bin/backup.sh"
# Its psql notes the settings of the session it would ask with.
cat > "$work/schedule-bin/psql" <<'FAKE'
#!/bin/sh
printf '%s|%s\n' "${PGOPTIONS:-}" "${PGCONNECT_TIMEOUT:-}" >> "$SCHEDULE_PSQL"
FAKE
chmod +x "$work/schedule-bin/psql"
rm -f "$work/schedule-mark" "$work/schedule-psql"
SCHEDULE_MARK="$work/schedule-mark" SCHEDULE_PSQL="$work/schedule-psql" BACKUP_STATUS_PATH="$work/schedule-status" \
  POSTGRES_HOST=postgres POSTGRES_DB=opengewerk PATH="$work/schedule-bin:$PATH" \
  "$real_timeout" 60 sh "$work/bin/schedule.sh" > "$work/out" 2>&1 || true
[ "$(cat "$work/schedule-mark" 2>/dev/null)" = leads ] || {
  echo 'FEHLER: schedule.sh startete die Sicherung nicht in einer eigenen Prozessgruppe'
  cat "$work/out"
  exit 1
}
# The question for the time waits for a lock, the select and the connection
# within limits (#1003), every time it is asked.
if ! test -s "$work/schedule-psql" ||
  grep -vxF -- '-c search_path=pg_catalog -c lock_timeout=30s -c statement_timeout=60s|30' "$work/schedule-psql" | grep -q .; then
  echo 'FEHLER: schedule.sh fragte die Uhrzeit ohne Grenze für Sperre, Abfrage und Verbindung'
  cat "$work/schedule-psql"
  exit 1
fi
check 'Sicherung als Ganzes: nach zwölf Stunden endet sie mit allem, was sie gestartet hat, und lässt nichts zurück'

# A stop of the service reaches a backup under way (#1004): schedule.sh passes
# TERM on to the group of the backup, waits until it has cleaned up and ends.
# In the pause between two checks it ends at once. The stand-in for backup.sh
# notes that it started, that it cleaned up, which takes it two seconds, and
# the process it started.
mkdir -p "$work/stop-bin"
cat > "$work/stop-bin/backup.sh" <<'FAKE'
#!/bin/sh
trap 'sleep 2; echo cleaned > "$STOP_MARK"; exit 1' TERM
echo "$$" > "$STOP_PID"
echo started > "$STOP_MARK"
if [ -n "${STOP_HANGS:-}" ]; then
  sleep 120 &
  echo "$!" > "$STOP_CHILD"
  wait $!
fi
FAKE
cp "$work/schedule-bin/psql" "$work/stop-bin/psql"
chmod +x "$work/stop-bin/backup.sh" "$work/stop-bin/psql"
for phase in backup pause; do
  rm -f "$work/stop-mark" "$work/stop-child" "$work/stop-pid"
  hangs=''
  expected=started
  if [ "$phase" = backup ]; then
    hangs=1
    expected=cleaned
  fi
  STOP_MARK="$work/stop-mark" STOP_PID="$work/stop-pid" STOP_CHILD="$work/stop-child" STOP_HANGS="$hangs" \
    SCHEDULE_PSQL="$work/stop-psql" \
    BACKUP_STATUS_PATH="$work/stop-status-$phase" POSTGRES_HOST=postgres POSTGRES_DB=opengewerk \
    PATH="$work/stop-bin:$PATH" sh "$work/bin/schedule.sh" > "$work/out" 2>&1 &
  schedule_pid=$!
  waited=0
  until [ -s "$work/stop-mark" ] || [ "$waited" -ge 20 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  [ -s "$work/stop-mark" ] || {
    echo "FEHLER: die Sicherung des Zeitplans begann nicht, der Fall $phase wurde nicht geprüft"
    cat "$work/out"
    exit 1
  }
  # In the pause, once the stand-in has ended and the schedule has taken its
  # status, which ends its process for good.
  if [ "$phase" = pause ]; then
    waited=0
    while kill -0 "$(cat "$work/stop-pid")" 2>/dev/null; do
      [ "$waited" -lt 50 ] || {
        echo 'FEHLER: die Sicherung des Zeitplans endete nicht, die Pause wurde nicht geprüft'
        exit 1
      }
      sleep 0.2
      waited=$((waited + 1))
    done
  fi
  stop_started=$(date +%s)
  kill -s TERM "$schedule_pid"
  stop_status=0
  wait "$schedule_pid" || stop_status=$?
  stop_seconds=$(($(date +%s) - stop_started))
  if [ "$stop_status" -ne 143 ] || [ "$stop_seconds" -ge 10 ] ||
    [ "$(cat "$work/stop-mark" 2>/dev/null)" != "$expected" ]; then
    echo "FEHLER: ein Anhalten des Zeitplans erreichte die Sicherung nicht ($phase: Status $stop_status nach $stop_seconds Sekunden, $(cat "$work/stop-mark" 2>/dev/null))"
    cat "$work/out"
    exit 1
  fi
  if [ "$phase" = backup ] && kill -0 "$(cat "$work/stop-child")" 2>/dev/null; then
    echo 'FEHLER: nach dem Anhalten lief ein Prozess der Sicherung weiter'
    exit 1
  fi
done
# A TERM that reaches a backup which already cleans up, after a failure of its
# own and on a target slow to answer, does not end that clean up: the backup
# still gives up on the target after its 35 seconds and names the file.
rm -f "$work/rm-blocks"
TMPDIR="$work/run-tmp" DUMP_FAILS=1 RM_BLOCKS_UNDER="$work/backups" RM_BLOCKS_MARK="$work/rm-blocks" \
  FIXED_STAMP=2031-03-01T000020Z POSTGRES_DB=opengewerk \
  "$real_timeout" -s KILL 150 setsid sh "$work/bin/backup.sh" > "$work/out" 2>&1 &
cleaning_pid=$!
waited=0
until [ -e "$work/rm-blocks" ] || [ "$waited" -ge 30 ]; do
  sleep 1
  waited=$((waited + 1))
done
[ -e "$work/rm-blocks" ] || {
  echo 'FEHLER: die Sicherung kam nicht ins Aufräumen, der Fall wurde nicht geprüft'
  cat "$work/out"
  exit 1
}
kill -s TERM "-$cleaning_pid" || {
  echo 'FEHLER: das TERM erreichte die aufräumende Sicherung nicht, der Fall wurde nicht geprüft'
  exit 1
}
wait "$cleaning_pid" || true
left_on_target=$(ls -A "$work/backups" | grep '^\..*-2031-03-01T000020Z\.' || true)
if [ ! -e "$work/rm-blocks" ] || [ -z "$left_on_target" ] ||
  ! grep -qF "sie bleibt dort liegen: $work/backups/$left_on_target" "$work/out"; then
  echo 'FEHLER: ein TERM brach das Aufräumen einer Sicherung ab'
  cat "$work/out"
  exit 1
fi
rm -f "$work/backups/$left_on_target"
check 'Zeitplan: ein Anhalten erreicht die laufende Sicherung mit allem, was sie gestartet hat, und endet in der Pause sofort'

# A file in an archive whose content is not what its name says, as a link
# swapped in while tar read the store or a disk that broke would leave it: the
# restore stops before anything changes (#1000). The application is not
# locked out, the dump is not played, and the store holds what it held, file
# for file, without the forged one, where the application would read it.
put_old 'echt' "$(hash_of 'echt')"
backed_up 'eine Sicherung für die untergeschobene Datei scheiterte'
forged=$(sed -n 's|^Fertig: .*/\([^/ ]*\) (.*|\1|p' "$work/out")
rm -rf "$work/forged"
mkdir -p "$work/forged/first"
tar --extract --gzip --file "$work/backups/$forged" --directory "$work/forged"
tar --extract --file "$work/forged/storage.tar" --directory "$work/forged/first"
forged_name=$(stored "$(hash_of 'echt')" | sed "s|^$STORAGE_PATH/||")
test -f "$work/forged/first/$forged_name"
printf 'GEHEIMNIS DES CONTAINERS' > "$work/forged/first/$forged_name"
# And beside it what a swapped link can leave under a name that is no hash, a
# folder whose name holds what sha256sum says, and a name with a line break.
forged_dir=$(dirname "$forged_name")
printf 'GEHEIMNIS DES CONTAINERS' > "$work/forged/first/$forged_dir/umgebung"
mkdir -p "$work/forged/first/q: FAILEDzz"
printf 'GEHEIMNIS DES CONTAINERS' > "$work/forged/first/q: FAILEDzz/$(hash_of 'anders')"
printf 'GEHEIMNIS DES CONTAINERS' > "$work/forged/first/$forged_dir/zeile
umbruch"
# And a file whose content is its name, but in folders FileStore never looks in.
astray_hash=$(hash_of 'versetzt')
mkdir -p "$work/forged/first/00/00"
printf 'versetzt' > "$work/forged/first/00/00/$astray_hash"
tar --create --file "$work/forged/storage.tar" --directory "$work/forged/first" .
rm -rf "$work/forged/first"
sum=$(sha256sum "$work/forged/storage.tar" | cut -d' ' -f1)
sed "s|\"storage.tar\": \"[0-9a-f]*\"|\"storage.tar\": \"$sum\"|" "$work/forged/manifest.json" > "$work/forged/manifest.new"
mv "$work/forged/manifest.new" "$work/forged/manifest.json"
tar --create --gzip --file "$work/backups/$forged" --directory "$work/forged" .
# The store, file for file with its content, before the restore.
store_state() {
  (cd "$STORAGE_PATH" && find . -type f | sort | while IFS= read -r file; do sha256sum "$file"; done) | cksum
}
store_before=$(store_state)
: > "$CALLS"
if POSTGRES_DB=opengewerk sh "$work/bin/restore.sh" --skip-origin-check "$forged" > "$work/out" 2>&1; then
  echo 'FEHLER: ein Archiv mit einer untergeschobenen Datei ließ sich zurückspielen'
  exit 1
fi
grep -q 'passt nicht mehr zu ihrem Namen' "$work/out" && grep -q 'bleiben, wie sie sind' "$work/out" || {
  echo 'FEHLER: das Rückspielen eines Archivs mit einer untergeschobenen Datei endete nicht an der Prüfung der Hashes'
  cat "$work/out"
  exit 1
}
if grep -q -e 'alter role opengewerk_app nologin' -e 'restore-as' "$CALLS"; then
  echo 'FEHLER: vor der Prüfung der Hashes wurde die Anwendung ausgesperrt oder die Datenbank zurückgespielt'
  cat "$CALLS"
  exit 1
fi
if [ "$(store_state)" != "$store_before" ]; then
  echo 'FEHLER: das abgelehnte Archiv veränderte den Dateispeicher'
  exit 1
fi
left_secret=$(grep -rl 'GEHEIMNIS DES CONTAINERS' "$STORAGE_PATH" || true)
if [ -n "$left_secret" ]; then
  printf 'FEHLER: fremder Inhalt blieb nach dem Rückspielen im Speicher: %s\n' "$left_secret"
  exit 1
fi
grep -q 'ohne Namen oder Ort des Speichers entfernt' "$work/out"
grep -q "entfernt: \./$forged_dir/umgebung\$" "$work/out" &&
  grep -q "entfernt: \./$forged_dir/zeile?umbruch\$" "$work/out" &&
  grep -q "entfernt: \./00/00/$astray_hash\$" "$work/out" || {
  echo 'FEHLER: das Rückspielen nannte nicht jeden Eintrag, den es entfernte'
  cat "$work/out"
  exit 1
}
if [ -e "$STORAGE_PATH/00/00/$astray_hash" ]; then
  echo 'FEHLER: eine Datei am falschen Ort blieb nach dem Rückspielen im Speicher'
  exit 1
fi
# A file that is no stored file and rm cannot take stops the restore before
# the check of the hashes.
if POSTGRES_DB=opengewerk RM_FAILS_ON=umgebung sh "$work/bin/restore.sh" --skip-origin-check "$forged" \
  > "$work/out" 2>&1; then
  echo 'FEHLER: eine fremde Datei, die rm nicht nahm, ließ das Rückspielen durch'
  exit 1
fi
grep -q 'blieb eine Datei, die keine Datei des Speichers ist' "$work/out" || {
  echo 'FEHLER: eine fremde Datei, die rm nicht nahm, beendete das Rückspielen nicht an ihrer Stelle'
  cat "$work/out"
  exit 1
}
check 'Rückspielen: eine Datei, deren Inhalt nicht ihr Name ist, hält an, bevor sich Datenbank oder Speicher ändern'

echo 'Sicherungen: alles in Ordnung.'
