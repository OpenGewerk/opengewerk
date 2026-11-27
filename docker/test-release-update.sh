#!/bin/sh
# A real update from the release before to the one just published, through
# the updater of the installation, as the office of an instance starts it
# (#1107). The workflow "Release" runs it after the release page is written:
# the updater offers only the latest release of GitHub, and it fetches the kit
# from that page and checks its signature against the run of that tag. No
# kit of a pull request carries that signature, so nothing before a release
# can run this.
#
# It takes the kit of the release before from its page, checks it, starts it
# on this machine, sets up the instance with an operator, writes a request
# for the new version into the folder update-requests the way the
# application does, and waits for run.json. The update went through when
# run.json says so and /health names the new version. A release before 0.9.0
# has no updater, and then there is nothing to try: it says so and ends
# green. A release that is not the latest of GitHub, a patch of an older
# line, is not offered by the updater either.
#
#   sh docker/test-release-update.sh <version>
#
# Needs gh with a token that reads releases, cosign, jq, openssl,
# curl, docker and sudo for reading the volume of the update status.
set -eu

new=${1:-}
repository=OpenGewerk/opengewerk
identity="https://github.com/$repository/.github/workflows/release.yml@refs/tags"
issuer=https://token.actions.githubusercontent.com
work=${RUNNER_TEMP:-/tmp}/release-update
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
base=http://127.0.0.1:23700
statement='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# A sentence for the log and for the summary of the run.
say() {
  printf '%s\n' "$*"
  printf '%s\n\n' "$*" >> "$summary"
}

fail() {
  say "$*"
  exit 1
}

printf '%s\n' "$new" | grep -Eq "$statement" || fail "Aufruf: sh docker/test-release-update.sh <Fassung>, etwa 0.10.0."

# The release before: the highest release published below this one. A tag
# whose run failed before it wrote its page has no kit, and an installation
# never ran it.
releases=$(gh release list --repo "$repository" --exclude-drafts --exclude-pre-releases --limit 200 \
  --json tagName --jq '.[].tagName') ||
  fail "Die Releases auf GitHub ließen sich nicht lesen; das Update ist nicht geprüft."
previous=$(printf '%s\nv%s\n' "$releases" "$new" | sed 's/^v//' | grep -E "$statement" |
  sort -uV | awk -v new="$new" '$0 == new { print last; exit } { last = $0 }')

if [ -z "$previous" ]; then
  say "Vor $new ist keine Fassung erschienen; ein Update auf sie lässt sich nicht prüfen."
  exit 0
fi

# The updater offers only the latest release of GitHub. Asked again before a
# failure over what it offers: a release published meanwhile is no failure.
not_latest() {
  latest=$(gh api "repos/$repository/releases/latest" --jq .tag_name) || return 1
  [ "$latest" != "v$new" ] || return 1
  # Only a newer release is offered instead; an older answer is GitHub not
  # having caught up with this one yet, and the updater tells then.
  newest=$(printf '%s\n%s\n' "${latest#v}" "$new" | sort -V | tail -n 1)
  [ "$newest" != "$new" ] || return 1
  say "Die neueste Fassung auf GitHub ist $latest, nicht v$new. Der Dienst für Aktualisierungen bietet nur die neueste an; ein Update auf $new lässt sich so nicht prüfen."
}

if not_latest; then
  exit 0
fi

rm -rf "$work"
mkdir -p "$work"
kit="opengewerk-$previous.tar.gz"

gh release download "v$previous" --repo "$repository" --dir "$work" \
  --pattern "$kit" --pattern "$kit.sigstore.json" ||
  fail "Das Paket von $previous ließ sich nicht holen; das Update ist nicht geprüft."
cosign verify-blob "$work/$kit" --bundle "$work/$kit.sigstore.json" \
  --certificate-identity "$identity/v$previous" --certificate-oidc-issuer "$issuer" ||
  fail "Die Signatur des Pakets von $previous stimmt nicht; das Update ist nicht geprüft."
tar --no-same-owner -xzf "$work/$kit" -C "$work"
install="$work/opengewerk"

# The service came with 0.9.0 (x-since in compose.yaml).
if ! grep -Eq '^  updater:' "$install/docker/compose.yaml"; then
  say "Die Fassung $previous hat noch keinen Dienst für Aktualisierungen, er kam mit 0.9.0. Ein Update über ihn lässt sich von ihr aus nicht prüfen."
  exit 0
fi

compose() {
  (cd "$install/docker" && docker compose "$@")
}

# What the volume of the update status holds, read from the machine: the
# application that could read it restarts during the update.
status_volume=''
status_file() {
  if [ -z "$status_volume" ]; then
    status_volume=$(docker volume inspect --format '{{ .Mountpoint }}' opengewerk_update-status)
  fi
  sudo cat "$status_volume/$1" 2>/dev/null
}

# The end of run.json and the log of the updater, for the report.
diagnose() {
  if run=$(status_file run.json); then
    printf '%s\n' "$run" | jq -r '"Schritt \(.step), Stand \(.state), Grund \(.reason // "keiner")", (.log // [] | .[])' |
      tee -a "$summary" || true
  fi
  compose logs --no-color --tail 200 updater 2>&1 | tail -n 200 || true
}

report() {
  say "Das Update von $previous auf $new ging nicht durch: $1"
  diagnose
  fail "Die Fassung $new ist erschienen. Ein Update aus dem Bereich der Instanz von $previous auf sie trägt nicht, bis eine Korrektur erschienen ist."
}

# The installation goes again however the script ends, after what a failure
# reports, and with the status it ended with: also after a start that got
# half way.
trap 'ended=$?; compose down --volumes > /dev/null 2>&1 || true; exit "$ended"' EXIT

say "Update von $previous auf $new über den Dienst für Aktualisierungen."
(cd "$install" && OPENGEWERK_ADDRESS="$base" sh docker/start.sh) ||
  fail "Die Fassung $previous ließ sich hier nicht starten; das Update ist nicht geprüft."

# start.sh waits for the health of every service (compose up --wait); the
# application answering from here is asked once more, each time for five
# seconds and thirty times at most.
for _ in $(seq 1 30); do
  curl --fail --silent --max-time 5 --output /dev/null "$base/health" && break
  sleep 2
done

# The first operator, with the code from the .env (#215). The code and the
# password go into no output.
code=$(sed -n 's/^SETUP_CODE=//p' "$install/docker/.env")
password=$(openssl rand -hex 24)
jq -n --arg code "$code" --arg password "$password" '{
  company: "Prüfung GmbH", name: "Paula Prüfung", email: "betrieb@pruefung.example.de",
  password: $password, setupCode: $code
}' | curl --fail --silent --show-error --max-time 30 --output /dev/null \
  --header 'Content-Type: application/json' --data @- "$base/setup" ||
  fail "Die Fassung $previous ließ sich hier nicht einrichten; das Update ist nicht geprüft."

# The updater asks GitHub once it starts; ready means it found a kit with
# digests, the installation under its path and Docker answering.
for _ in $(seq 1 60); do
  available=$(status_file available.json) || available=''
  if [ -n "$available" ] &&
    printf '%s\n' "$available" | jq -e --arg new "$new" '.latest == $new and .mode == "ready"' > /dev/null; then
    break
  fi
  sleep 5
done

if ! printf '%s\n' "${available:-}" | jq -e --arg new "$new" '.latest == $new and .mode == "ready"' > /dev/null 2>&1; then
  if not_latest; then
    exit 0
  fi
  # GitHub not answering the updater, which asks without a token from the
  # address of the runner: red as well, but the update is untried, not failed.
  if trouble=$(printf '%s\n' "${available:-}" | jq -er '.error // empty' 2>/dev/null); then
    fail "Der Dienst für Aktualisierungen erreichte GitHub nicht ($trouble); das Update ist nicht geprüft."
  fi
  # What the updater of the release before offers is that release's doing:
  # no request is written yet, and the update is untried.
  offered=$(printf '%s\n' "${available:-}" | jq -c '{latest, mode, reason}' 2>/dev/null) || offered=nichts
  diagnose
  fail "Der Dienst der Fassung $previous bietet $new nicht an (${offered:-nichts}); das Update ist nicht geprüft."
fi

# The request as the application writes it (update.ts): a file of its own,
# renamed into place, by the user of the application.
id=$(cat /proc/sys/kernel/random/uuid)
compose exec -T app node -e '
const fs = require("node:fs")
const [id, version] = process.argv.slice(1)
const folder = "/var/lib/opengewerk/update-requests"
const body = JSON.stringify({ id, version, by: "Prüfung des Release", at: new Date().toISOString() })
fs.writeFileSync(`${folder}/.request-${id}.json`, body, { mode: 0o644 })
fs.renameSync(`${folder}/.request-${id}.json`, `${folder}/request.json`)
' "$id" "$new" ||
  fail "Der Auftrag ließ sich in der Fassung $previous nicht in den Ordner update-requests schreiben; das Update ist nicht geprüft."

# Taken within seconds; a run backs up, fetches, migrates and restarts,
# which takes some minutes.
state=''
for _ in $(seq 1 180); do
  refusal=$(status_file refusal.json) || refusal=''
  if [ -n "$refusal" ] && [ "$(printf '%s\n' "$refusal" | jq -r .id)" = "$id" ]; then
    report "Der Dienst lehnte den Auftrag ab: $(printf '%s\n' "$refusal" | jq -r .reason)"
  fi
  run=$(status_file run.json) || run=''
  if [ -n "$run" ] && [ "$(printf '%s\n' "$run" | jq -r .id)" = "$id" ]; then
    state=$(printf '%s\n' "$run" | jq -r .state)
    [ "$state" = running ] || break
  fi
  sleep 10
done

# A run that did not end in half an hour, and a request nobody took, leave
# the update untried; a run that ended otherwise failed.
case $state in
  succeeded) ;;
  running)
    diagnose
    fail "Der Lauf war nach einer halben Stunde nicht zu Ende; das Update ist nicht geprüft."
    ;;
  '')
    diagnose
    fail "Der Dienst der Fassung $previous nahm den Auftrag in einer halben Stunde nicht an; das Update ist nicht geprüft."
    ;;
  *)
    # A reason is the updater's own, when the container of the run did not
    # start (docker) or went without saying how it ended (vanished): the
    # runner, not the update. update.sh itself names none.
    why=$(printf '%s\n' "$run" | jq -r '.reason // empty' 2>/dev/null) || why=''
    if [ -n "$why" ]; then
      diagnose
      fail "Der Lauf endete mit dem Grund $why, ohne das Update auszuführen; das Update ist nicht geprüft."
    fi
    report "run.json sagt $state in Schritt $(printf '%s\n' "$run" | jq -r '.step // "?"') statt succeeded."
    ;;
esac

# Asked apart: in a pipeline sh takes the status of its last command, and jq
# ends well on an empty answer.
answer=$(curl --fail --silent --show-error --max-time 30 "$base/health") ||
  report "/health antwortet nicht."
running=$(printf '%s\n' "$answer" | jq -r .version) ||
  report "/health antwortet nicht mit JSON."
[ "$running" = "$new" ] || report "/health nennt $running statt $new."

say "Das Update von $previous auf $new über den Dienst für Aktualisierungen ging durch, /health nennt $new."
