#!/bin/sh
# One update of the installation (#1093), started by updater.sh in a
# container of its own, with the installation under its path on the machine.
# The same steps docs/betrieb.md names under "Aktualisieren", in the same
# order, each written into run.json as it begins:
#
#   0  a backup, before anything changes; a failed one ends the run there
#   1  the kit of the new version, its signature checked against the release
#      workflow of exactly that tag, unpacked over the installation
#   2  start.sh of the new version: the signatures of its images checked and
#      the images pulled,
#   3  the migration on its own,
#   4  and only after it the services, this one's service among them
#   5  the version the application answers with, held to the one asked for
#
# Steps 2 to 4 are start.sh as it is, and run.json follows the sentences it
# says. What start.sh promises holds here too: a migration that fails leaves
# the instance answering on the version before.
#
#   update.sh <id> <version>

set -eu

. "$(dirname "$0")/common.sh"

id=${1:-}
version=${2:-}
id_valid "$id" ||
  { echo 'Keine Kennung eines Laufs.' >&2; exit 2; }
version_valid "$version" || { echo 'Keine Fassung der Form 1.2.3.' >&2; exit 2; }

work=$(mktemp -d)
log="$work/log"
: > "$log"
step=$step_backup
finished=''

# The last lines of what the run said, for the office. Only what the scripts
# print, and they print names and never values.
tail_of_log() {
  tail -n 60 "$log" | jq -R -s 'split("\n") | map(select(. != ""))'
}

# run.json with the step, the end of the log and the fields of the object
# given, a jq expression over the arguments after it.
record() {
  fields=$1
  shift
  jq --argjson step "$step" --argjson log "$(tail_of_log)" "$@" \
    ". + {step: \$step, log: \$log} + ($fields)" "$status_path/run.json" | write_json "$status_path/run.json"
}

progress() {
  record '{}'
}

finish() {
  record '{state: $state, finished_at: $at}' --arg at "$(now)" --arg state "$1" || true
}

# Whatever ends the run before it says so: failed in the step it was in. And
# the .env back to the owner of the installation in any case: setup.sh writes
# a new one as the user it runs as, root in here, and a start.sh that fails
# after that would leave the owner a .env they cannot read.
owner=''
leave() {
  status=$?
  if [ -z "$finished" ]; then
    finish failed
  fi
  if [ -n "$owner" ] && [ -f "$install/docker/.env" ]; then
    chown "$owner" "$install/docker/.env" || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap leave EXIT
trap 'exit 1' TERM INT

# A run that does not belong to the request recorded is not this run's to
# write.
[ "$(jq -r '.id // ""' "$status_path/run.json" 2>/dev/null)" = "$id" ] || {
  finished=yes
  echo 'Der Lauf gehört nicht zum Auftrag in run.json.' >&2
  exit 2
}

log_line() {
  say "$*" >> "$log"
}

read_application || { log_line 'application.env der Installation ist nicht lesbar.'; exit 1; }
compose_file="$install/docker/compose.yaml"
from=$(installed_version)
owner=$(stat -c '%u:%g' "$install")

compose() {
  docker compose -f "$compose_file" "$@"
}

# The version start.sh uses comes from the kit, and nothing in this
# environment may pin another.
unset "${prefix}_VERSION" 2>/dev/null || true
unset DOCKER_HOST DOCKER_CONTEXT 2>/dev/null || true

# 0: the backup, with the backup of the version installed now.
progress
log_line "Sicherung vor dem Update von $from auf $version."
compose --profile backup run --rm backup backup.sh >> "$log" 2>&1
log_line 'Die Sicherung ist fertig.'

# 1: the kit of the new version and its signature, from the release page.
step=$step_download
progress
kit="$kit_name-$version.tar.gz"
base="https://github.com/$repository/releases/download/v$version"
for file in "$kit" "$kit.sigstore.json"; do
  curl --fail --silent --show-error --location --proto '=https' --max-time 300 \
    --max-filesize 200000000 --output "$work/$file" "$base/$file" >> "$log" 2>&1
done
cosign verify-blob "$work/$kit" --bundle "$work/$kit.sigstore.json" \
  --certificate-identity "https://github.com/$repository/.github/workflows/release.yml@refs/tags/v$version" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com >> "$log" 2>&1
log_line "Die Signatur des Pakets $kit ist geprüft."

# Nothing in the kit but files and folders below its one folder: no link,
# no absolute path, no way up. The release packs it that way; a kit that is
# otherwise is not unpacked.
listing=$(tar -tvzf "$work/$kit")
if printf '%s\n' "$listing" | awk '{ print substr($1, 1, 1) }' | grep -qv '^[-d]$'; then
  log_line 'Das Paket enthält etwas anderes als Dateien und Ordner und wird nicht entpackt.'
  exit 1
fi
if tar -tzf "$work/$kit" | grep -Ev "^$kit_name(/|\$)" | grep -q . ||
  tar -tzf "$work/$kit" | grep -Eq '(^|/)\.\.(/|$)'; then
  log_line "Das Paket enthält Pfade außerhalb von $kit_name/ und wird nicht entpackt."
  exit 1
fi
mkdir "$work/kit"
tar --no-same-owner --no-same-permissions -xzf "$work/$kit" -C "$work/kit" >> "$log" 2>&1
grep -Eq "^[[:space:]]*image:[[:space:]]*[^[:space:]]+:$version@sha256:[0-9a-f]{64}" "$work/kit/$kit_name/docker/compose.yaml" ||
  { log_line "Das Paket nennt seine Abbilder nicht mit der Fassung $version und ihrem Digest."; exit 1; }

# Over the installation, the .env and everything else that is not in the kit
# staying as it is, and every file of the kit handed to the owner of the
# installation, as tar --no-same-owner does for the one who unpacks.
cp -R "$work/kit/$kit_name/." "$install/"
(cd "$work/kit/$kit_name" && find . -mindepth 1) | while IFS= read -r path; do
  chown -h "$owner" "$install/$path"
done
log_line "Die Fassung $version liegt im Ordner der Installation."

# 2 to 4: start.sh, as an operator calls it.
step=$step_images
progress
# The step start.sh is in, from the sentences it says as each begins.
step_of_start() {
  if grep -Fq "$name: $name startet." "$log"; then
    echo "$step_restart"
  elif grep -Fq "$name: Die Datenbank wird eingerichtet oder auf den neuen Stand gebracht." "$log"; then
    echo "$step_migration"
  else
    echo "$step_images"
  fi
}

sh "$install/docker/start.sh" >> "$log" 2>&1 &
started=$!
while kill -0 "$started" 2>/dev/null; do
  sleep 2
  next=$(step_of_start)
  if [ "$next" != "$step" ]; then
    step=$next
    progress
  fi
done
if ! wait "$started"; then
  step=$(step_of_start)
  exit 1
fi

# 5: the version the application answers with.
step=$step_check
progress
answered=''
attempt=0
while [ "$attempt" -lt "${UPDATE_HEALTH_ATTEMPTS:-30}" ]; do
  attempt=$((attempt + 1))
  answered=$(compose exec -T app node -e 'fetch(`http://127.0.0.1:${process.env.PORT}/health`).then((answer) => answer.json()).then((body) => console.log(body.version ?? ""), () => console.log(""))' 2>/dev/null | tr -d '\r') || answered=''
  [ "$answered" != "$version" ] || break
  sleep 2
done
if [ "$answered" != "$version" ]; then
  log_line "Die Anwendung meldet die Fassung ${answered:-keine}, erwartet war $version."
  exit 1
fi
log_line "Die Anwendung meldet die Fassung $version."

finished=yes
finish succeeded ''
