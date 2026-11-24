#!/bin/sh
# Exercises the service for updates (#1093) in its own image, with a docker,
# a curl and a cosign that only write down what they are asked and answer
# what each case needs: what updater.sh takes from a request of the office
# and what it turns away, and what update.sh does in each step and how it
# ends when one fails. Run by the CI as
#
#   docker build --tag opengewerk-updater-under-test updater
#   docker run --rm --volume "$PWD:/docker:ro" opengewerk-updater-under-test sh /docker/test-updater.sh
#
# Prints what it checks and stops at the first thing that is wrong.
set -eu

source_dir=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/install/docker" "$work/status" "$work/requests" "$work/kits"
CALLS="$work/calls"
: > "$CALLS"

# A kit of the version given, packed the way the release packs it: one
# folder, compose.yaml with every image of the application by its digest, and
# a start.sh that says the sentences of the real one and ends as START_ENDS
# says: ok, or the step it fails in.
pack() {
  folder="$work/pack/opengewerk"
  rm -rf "$work/pack"
  mkdir -p "$folder/docker"
  cp "$source_dir/compose.yaml" "$source_dir/application.env" "$folder/docker/"
  sh "$source_dir/kit-images.sh" "$folder/docker/compose.yaml" OPENGEWERK "$1" \
    "ghcr.io/opengewerk/opengewerk@sha256:$(printf '%064d' 1)" \
    "ghcr.io/opengewerk/backup@sha256:$(printf '%064d' 2)" \
    "ghcr.io/opengewerk/updater@sha256:$(printf '%064d' 3)"
  cat > "$folder/docker/start.sh" <<'START'
#!/bin/sh
# setup.sh writes a new .env as whoever runs it, as here.
here=$(dirname "$0")
cat "$here/.env" > "$here/.env.new"
mv "$here/.env.new" "$here/.env"
echo 'OpenGewerk: Fassung: die signierten Abbilder werden geholt.'
[ "${START_ENDS:-ok}" != images ] || exit 1
echo 'OpenGewerk: Die Datenbank wird eingerichtet oder auf den neuen Stand gebracht.'
[ "${START_ENDS:-ok}" != migration ] || exit 1
echo 'OpenGewerk: OpenGewerk startet.'
[ "${START_ENDS:-ok}" != restart ] || exit 1
echo 'OpenGewerk: OpenGewerk läuft. Im Browser: https://example.org'
START
  printf 'neu in %s\n' "$1" > "$folder/docker/only-in-$1.txt"
  tar -czf "$work/kits/opengewerk-$1.tar.gz" -C "$work/pack" opengewerk
  printf '{}' > "$work/kits/opengewerk-$1.tar.gz.sigstore.json"
}

# The installation: the kit of 1.0.0, unpacked, with a .env, belonging to an
# account that is not root.
pack 1.0.0
cp -R "$work/pack/opengewerk/." "$work/install/"
printf 'SESSION_SECRET=geheim\n' > "$work/install/docker/.env"
chown -R 1234:1234 "$work/install"

cat > "$work/bin/docker" <<'FAKE'
#!/bin/sh
printf 'docker|%s\n' "$*" >> "$CALLS"
for last; do :; done
case "$*" in
  inspect*Config.Labels*) printf '%s\n' "${FAKE_PROJECT-opengewerk}" ;;
  'inspect --format {{.Image}} '*) printf '%s\n' "${FAKE_IMAGE-sha256:updater}" ;;
  inspect*/var/run/docker.sock*) printf '/var/run/docker.sock\n' ;;
  inspect*update-status*) printf 'opengewerk_update-status\n' ;;
  'ps --quiet --filter label=opengewerk.update.project='*) [ -z "${FAKE_RUNNING:-}" ] || printf 'c0ffee\n' ;;
  'run --rm --network none '*' stat -c %d:%i '*) stat -c '%d:%i' "$last" ;;
  'run --detach '*) exit "${FAKE_RUN_FAILS:-0}" ;;
  compose*' --profile backup run --rm backup backup.sh') exit "${BACKUP_FAILS:-0}" ;;
  compose*' exec -T app node -e '*) printf '%s\n' "${ANSWERED-1.1.0}" ;;
esac
FAKE

cat > "$work/bin/curl" <<'FAKE'
#!/bin/sh
printf 'curl|%s\n' "$*" >> "$CALLS"
output=''
previous=''
for argument; do
  [ "$previous" != --output ] || output=$argument
  previous=$argument
  address=$argument
done
case "$address" in
  https://api.github.com/*)
    [ -z "${GITHUB_DOWN:-}" ] || { echo 'curl: (6) Could not resolve host' >&2; exit 6; }
    cp "$RELEASE" "$output"
    ;;
  *) cp "$KITS/${address##*/}" "$output" ;;
esac
FAKE

cat > "$work/bin/cosign" <<'FAKE'
#!/bin/sh
printf 'cosign|%s\n' "$*" >> "$CALLS"
[ -z "${COSIGN_REFUSES:-}" ] || { echo 'Error: no matching signatures' >&2; exit 1; }
FAKE
chmod +x "$work/bin/docker" "$work/bin/curl" "$work/bin/cosign"

PATH="$work/bin:$PATH"
KITS="$work/kits"
RELEASE="$work/release.json"
UPDATE_INSTALL="$work/install"
UPDATE_STATUS_PATH="$work/status"
UPDATE_REQUESTS_PATH="$work/requests"
UPDATE_POLL_INTERVAL=0
INSTALL_DIRECTORY="$work/install"
export CALLS PATH KITS RELEASE UPDATE_INSTALL UPDATE_STATUS_PATH UPDATE_REQUESTS_PATH UPDATE_POLL_INTERVAL \
  INSTALL_DIRECTORY

check() {
  printf 'check: %s\n' "$1"
}

fail() {
  printf 'FEHLER: %s\n' "$1"
  exit 1
}

field() {
  jq -r "$1" "$2"
}

release() {
  jq -n --arg tag "$1" '{tag_name: $tag, html_url: ("https://github.com/OpenGewerk/opengewerk/releases/tag/" + $tag),
    published_at: "2026-11-24T10:00:00Z", body: "### Sicherheit\n\n- Eine Lücke geschlossen.\n\n### Neu\n\n- Etwas Neues."}' > "$RELEASE"
}

# One round of updater.sh, with the variables given for this round alone.
round() {
  : > "$CALLS"
  env "$@" UPDATE_ROUNDS=1 sh "$source_dir/updater/updater.sh" > "$work/updater.log" 2>&1 ||
    { cat "$work/updater.log"; fail 'updater.sh endete mit einem Fehler'; }
}

request() {
  jq -n --arg id "$1" --arg version "$2" '{id: $id, version: $version, by: "Moritz Beispiel", at: "2026-11-24T10:00:00Z"}' \
    > "$work/requests/request.json"
}

started() {
  grep -q '^docker|run --detach ' "$CALLS"
}

# 1. The newest release, from GitHub, and the installation ready for an
# update: a kit by its digests, its path in the .env, and that path the
# folder the service sees.
release v1.1.0
round
available="$work/status/available.json"
[ "$(field .latest "$available")" = 1.1.0 ] || fail 'neueste Fassung nicht 1.1.0'
[ "$(field .installed "$available")" = 1.0.0 ] || fail 'installiert nicht 1.0.0'
[ "$(field .mode "$available")" = ready ] || fail "Modus $(field .mode "$available") statt ready"
field .notes "$available" | grep -q 'Eine Lücke geschlossen' || fail 'Hinweise fehlen'
[ "$(field .url "$available")" = https://github.com/OpenGewerk/opengewerk/releases/tag/v1.1.0 ] || fail 'Adresse fehlt'
[ -s "$work/status/alive" ] || fail 'kein Lebenszeichen'
check 'neueste Fassung, Hinweise und Adresse übernommen, Installation bereit'

# 2. An answer of GitHub without a version keeps what was found before, and
# says so; so does no answer at all.
printf '{"tag_name": "latest; rm -rf /"}' > "$RELEASE"
round
[ "$(field .latest "$available")" = 1.1.0 ] || fail 'eine ungültige Antwort ersetzte die Fassung'
[ "$(field .error "$available")" = invalid ] || fail 'ungültige Antwort nicht gemeldet'
round GITHUB_DOWN=1
[ "$(field .latest "$available")" = 1.1.0 ] || fail 'ohne Antwort ging die Fassung verloren'
[ "$(field .error "$available")" = unreachable ] || fail 'fehlende Antwort nicht gemeldet'
release v1.1.0
check 'ungültige oder fehlende Antwort: Fassung von vorher, Fehler genannt'

# 3. A path in the .env that is another folder, an empty one, and a checkout.
mkdir -p "$work/elsewhere/docker"
cp "$work/install/docker/compose.yaml" "$work/elsewhere/docker/"
round "INSTALL_DIRECTORY=$work/elsewhere"
[ "$(field .reason "$available")" = elsewhere ] || fail 'ein anderer Ordner wurde nicht erkannt'
round INSTALL_DIRECTORY=
[ "$(field .reason "$available")" = directory ] || fail 'ein fehlender Pfad wurde nicht erkannt'
round 'INSTALL_DIRECTORY=/srv/mit leerzeichen'
[ "$(field .reason "$available")" = directory ] || fail 'ein Pfad mit Leerzeichen wurde angenommen'
mkdir -p "$work/checkout/docker"
cp "$source_dir/compose.yaml" "$source_dir/application.env" "$work/checkout/docker/"
round "UPDATE_INSTALL=$work/checkout" "INSTALL_DIRECTORY=$work/checkout"
[ "$(field .mode "$available")" = checkout ] || fail 'ein Checkout wurde nicht erkannt'
round
check 'anderer Ordner, kein Pfad, Pfad mit Leerzeichen und Checkout: kein Update aus dem Büro'

# 4. A request with the version found: the update starts in a container of
# its own, as the installation's owner would by hand, with three
# capabilities, read-only, under the path of the installation.
id=11111111-2222-4333-8444-555555555555
request "$id" 1.1.0
round
started || fail 'das Update startete nicht'
line=$(grep '^docker|run --detach ' "$CALLS")
for part in "--label opengewerk.update.project=opengewerk" "--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER" \
  "--security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,size=512m" "--env UPDATE_INSTALL=$work/install" \
  "--volume $work/install:$work/install" \
  "--volume /var/run/docker.sock:/var/run/docker.sock" "--volume opengewerk_update-status:/var/lib/opengewerk/update-status" \
  "sha256:updater update.sh $id 1.1.0"; do
  printf '%s' "$line" | grep -qF -- "$part" || fail "dem Start fehlt: $part"
done
run="$work/status/run.json"
[ "$(field .state "$run")" = running ] || fail 'run.json läuft nicht'
[ "$(field .from "$run")" = 1.0.0 ] || fail 'run.json nennt nicht die Fassung davor'
[ "$(field .by "$run")" = 'Moritz Beispiel' ] || fail 'run.json nennt nicht, wer es angestoßen hat'
check 'Auftrag mit der gefundenen Fassung: Update gestartet, mit drei Capabilities und nur lesbar'

# 5. The same request again starts nothing.
round
if started; then fail 'derselbe Auftrag startete ein zweites Mal'; fi
check 'derselbe Auftrag: kein zweiter Start'

refusal="$work/status/refusal.json"

# A request that is turned away, with the variables given for its round: in
# refusal.json with its reason, and run.json, which belongs to the update that
# ran last, untouched.
refused() {
  identifier=$1
  wanted=$2
  why=$3
  shift 3
  request "$identifier" "$wanted"
  before=$(cat "$run")
  round "$@"
  if started; then fail "gestartet trotz $why"; fi
  [ "$(field .id "$refusal")" = "$identifier" ] || fail "nicht abgelehnt: $why"
  [ "$(field .reason "$refusal")" = "$why" ] || fail "abgelehnt mit $(field .reason "$refusal") statt $why"
  [ "$(cat "$run")" = "$before" ] || fail "eine Ablehnung ($why) hat run.json verändert"
}

# 6. Every request that does not hold is turned away, and says why: another
# version than the newest, one that is no version, a request older than ten
# minutes, an update already under way, a path that is not this folder, and
# a newest version that is the installed one.
refused 22222222-2222-4333-8444-555555555555 1.2.0 version
refused 33333333-2222-4333-8444-555555555555 '1.1.0; reboot' version
request 44444444-2222-4333-8444-555555555555 1.1.0
touch -d '20 minutes ago' "$work/requests/request.json"
round
if started; then fail 'ein alter Auftrag startete'; fi
[ "$(field .reason "$refusal")" = expired ] || fail 'ein alter Auftrag wurde nicht als zu alt abgelehnt'
refused 55555555-2222-4333-8444-555555555555 1.1.0 running FAKE_RUNNING=1
refused 66666666-2222-4333-8444-555555555555 1.1.0 elsewhere "INSTALL_DIRECTORY=$work/elsewhere"
release v1.0.0
refused 77777777-2222-4333-8444-555555555555 1.0.0 current
release v1.1.0
check 'andere oder keine Fassung, alter Auftrag, laufendes Update, anderer Ordner, schon aktuell: abgelehnt, run.json bleibt'

# 7. A request whose ID is no ID is not even recorded.
before=$(cat "$run")
before_refusal=$(cat "$refusal")
request '../../etc/passwd' 1.1.0
round
if started; then fail 'ein Auftrag ohne gültige Kennung startete'; fi
[ "$(cat "$run")" = "$before" ] || fail 'ein Auftrag ohne gültige Kennung veränderte run.json'
[ "$(cat "$refusal")" = "$before_refusal" ] || fail 'ein Auftrag ohne gültige Kennung wurde eingetragen'
check 'Auftrag ohne gültige Kennung: übergangen'

# A run as updater.sh writes it before the update starts.
begin() {
  jq -n --arg id "$1" '{id: $id, version: "1.1.0", from: "1.0.0", by: "Moritz Beispiel", state: "running",
    reason: null, step: 0, started_at: "2026-11-24T10:00:00Z", finished_at: null, message: null, log: []}' > "$run"
}

# One update, with the variables given for it alone.
update() {
  : > "$CALLS"
  begin "$1"
  identifier=$1
  shift
  env "$@" UPDATE_HEALTH_ATTEMPTS=2 sh "$source_dir/updater/update.sh" "$identifier" 1.1.0 > "$work/update.log" 2>&1 || true
}

unchanged() {
  [ ! -e "$work/install/docker/only-in-1.1.0.txt" ] || fail "$1: die neue Fassung wurde schon entpackt"
}

# 8. An update that goes through: the backup before anything else, the kit
# checked against the release workflow of its tag before it is unpacked, the
# files of the new version given to the owner of the installation, the .env
# kept, and the version the application answers with checked.
cp -R "$work/install" "$work/install.before"
pack 1.1.0
update 88888888-2222-4333-8444-555555555555
[ "$(field .state "$run")" = succeeded ] || { cat "$work/update.log"; jq . "$run"; fail 'das Update ging nicht durch'; }
[ "$(field .step "$run")" = 5 ] || fail 'das Update endete nicht im letzten Schritt'
backup=$(grep -n 'backup.sh$' "$CALLS" | head -n 1 | cut -d: -f1)
signature=$(grep -n '^cosign|verify-blob' "$CALLS" | head -n 1 | cut -d: -f1)
[ -n "$backup" ] && [ -n "$signature" ] && [ "$backup" -lt "$signature" ] || fail 'die Sicherung kam nicht zuerst'
grep -qF -- '--certificate-identity https://github.com/OpenGewerk/opengewerk/.github/workflows/release.yml@refs/tags/v1.1.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com' "$CALLS" ||
  fail 'die Signatur wurde nicht gegen den Workflow dieses Tags geprüft'
[ "$(stat -c %u:%g "$work/install/docker/only-in-1.1.0.txt")" = 1234:1234 ] || fail 'die neue Datei gehört nicht dem Besitzer'
[ "$(stat -c %u:%g "$work/install/docker/compose.yaml")" = 1234:1234 ] || fail 'compose.yaml gehört nicht dem Besitzer'
grep -q ':1.1.0@sha256:' "$work/install/docker/compose.yaml" || fail 'compose.yaml ist nicht die der neuen Fassung'
grep -qx 'SESSION_SECRET=geheim' "$work/install/docker/.env" || fail 'die .env wurde verändert'
check 'Update: erst Sicherung, dann Signatur des Pakets, neue Fassung dem Besitzer, .env bleibt'

restore() {
  rm -rf "$work/install"
  cp -R "$work/install.before" "$work/install"
}

failed_in() {
  [ "$(field .state "$run")" = failed ] || { jq . "$run"; fail "$2: nicht gescheitert"; }
  [ "$(field .step "$run")" = "$1" ] || fail "$2: gescheitert in Schritt $(field .step "$run") statt $1"
}

# 9. A backup that fails ends the run before anything is fetched.
restore
update 99999999-2222-4333-8444-555555555555 BACKUP_FAILS=1
failed_in 0 'Sicherung'
if grep -q '^curl|\|^cosign|' "$CALLS"; then fail 'nach einer gescheiterten Sicherung wurde weitergemacht'; fi
unchanged 'Sicherung'
check 'Sicherung scheitert: nichts geladen, nichts entpackt'

# 10. A signature that does not hold: nothing unpacked.
restore
update aaaaaaaa-2222-4333-8444-555555555555 COSIGN_REFUSES=1
failed_in 1 'Signatur'
unchanged 'Signatur'
check 'Signatur des Pakets hält nicht: nichts entpackt'

# 11. A kit with a link in it, or with a path out of its folder, is not
# unpacked, signature or not.
restore
pack 1.1.0
ln -s /etc "$work/pack/opengewerk/docker/link"
tar -czf "$work/kits/opengewerk-1.1.0.tar.gz" -C "$work/pack" opengewerk
update bbbbbbbb-2222-4333-8444-555555555555
failed_in 1 'Verweis im Paket'
unchanged 'Verweis im Paket'
[ ! -e "$work/install/docker/link" ] || fail 'der Verweis wurde entpackt'
restore
pack 1.1.0
mkdir -p "$work/pack/other"
printf 'x\n' > "$work/pack/other/file"
tar -czf "$work/kits/opengewerk-1.1.0.tar.gz" -C "$work/pack" opengewerk other
update cccccccc-2222-4333-8444-555555555555
failed_in 1 'Pfad außerhalb'
unchanged 'Pfad außerhalb'
check 'Paket mit Verweis oder Pfad außerhalb seines Ordners: nicht entpackt'

# 12. A kit of another version than the one asked for.
restore
pack 1.2.0
cp "$work/kits/opengewerk-1.2.0.tar.gz" "$work/kits/opengewerk-1.1.0.tar.gz"
update dddddddd-2222-4333-8444-555555555555
failed_in 1 'andere Fassung im Paket'
check 'Paket einer anderen Fassung: abgelehnt'

# 13. start.sh failing in each of its steps, and an application that answers
# with another version: each ends in its own step.
pack 1.1.0
for case in images:2 migration:3 restart:4; do
  restore
  update eeeeeeee-2222-4333-8444-555555555555 "START_ENDS=${case%%:*}"
  failed_in "${case#*:}" "start.sh bei ${case%%:*}"
done
restore
update ffffffff-2222-4333-8444-555555555555 ANSWERED=1.0.0
failed_in 5 'Fassung der Anwendung'
field '.log | join("\n")' "$run" | grep -q 'meldet die Fassung 1.0.0' || fail 'das Protokoll nennt die gemeldete Fassung nicht'
check 'start.sh scheitert bei Abbildern, Migration oder Neustart, falsche Fassung: Schritt 2, 3, 4 und 5'

# 14. A run for another request than the one recorded writes nothing.
restore
begin 12121212-2222-4333-8444-555555555555
before=$(cat "$run")
sh "$source_dir/updater/update.sh" 13131313-2222-4333-8444-555555555555 1.1.0 > /dev/null 2>&1 || true
[ "$(cat "$run")" = "$before" ] || fail 'ein fremder Lauf hat run.json verändert'
unchanged 'fremder Lauf'
check 'Lauf zu einem anderen Auftrag: schreibt nichts, entpackt nichts'

# 15. A start.sh that fails after setup.sh wrote the .env anew leaves it with
# the owner of the installation, who could not read it otherwise.
restore
chown -R 1234:1234 "$work/install"
update 14141414-2222-4333-8444-555555555555 START_ENDS=migration
failed_in 3 '.env nach einem Abbruch'
[ "$(stat -c %u:%g "$work/install/docker/.env")" = 1234:1234 ] || fail 'die .env gehört nach einem Abbruch root'
check 'Abbruch nach dem Schreiben der .env: sie gehört weiter dem Besitzer'

# 16. After a run that stopped once the files of the new version were in
# place, the installation names the new version while the instance runs the
# one before. A new request for the version that failed takes it up again,
# from the version it started from; another version than that still counts
# as current.
pack 1.1.0
cp -R "$work/pack/opengewerk/." "$work/install/"
jq -n '{id: "15151515-2222-4333-8444-555555555555", version: "1.1.0", from: "1.0.0", by: "Moritz Beispiel",
  state: "failed", reason: null, step: 3, started_at: "2026-11-24T10:00:00Z", finished_at: "2026-11-24T10:01:00Z", log: []}' > "$run"
request 16161616-2222-4333-8444-555555555555 1.1.0
round
started || fail 'ein neuer Versuch nach einem Abbruch startete nicht'
[ "$(field .from "$run")" = 1.0.0 ] || fail 'der neue Versuch nennt nicht die Fassung, von der er ausging'
jq '.state = "succeeded"' "$run" > "$run.new" && mv "$run.new" "$run"
refused 17171717-2222-4333-8444-555555555555 1.1.0 current
check 'Neuer Versuch nach einem Abbruch mit entpackter Fassung: startet, nach einem Erfolg nicht mehr'

# 17. After such a stop a later version starts from the version that runs, as
# the stopped run names it, not from the one of the files; an earlier version
# than the files never starts, whatever run.json says.
stopped_run() {
  jq -n '{id: "15151515-2222-4333-8444-555555555555", version: "1.1.0", from: "1.0.0", by: "Moritz Beispiel",
    state: "failed", reason: null, step: 3, started_at: "2026-11-24T10:00:00Z", finished_at: "2026-11-24T10:01:00Z", log: []}' > "$run"
}
stopped_run
release v1.2.0
request 18181818-2222-4333-8444-555555555555 1.2.0
round
started || fail 'eine neuere Fassung nach einem Abbruch startete nicht'
[ "$(field .from "$run")" = 1.0.0 ] || fail "der Lauf nennt $(field .from "$run") statt der Fassung, die läuft"
pack 1.2.0
cp -R "$work/pack/opengewerk/." "$work/install/"
stopped_run
release v1.1.0
refused 19191919-2222-4333-8444-555555555555 1.1.0 current
check 'Nach einem Abbruch: neuere Fassung von der laufenden aus, ältere als die Dateien nie'

printf 'Dienst für Aktualisierungen: alles in Ordnung.\n'
