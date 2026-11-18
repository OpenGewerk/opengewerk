#!/bin/sh
# Exercises the choice start.sh makes (#155), with a docker that only writes
# down what it was asked: a checkout of the source builds, a release kit pulls
# the version in its compose.yaml and builds nothing, and a version in the .env
# or the environment wins. And what it says about the setup code (#215): where
# it is while the instance is empty, never what it is. And another
# application with these scripts and its own folder (opengewerk-haustechnik#14).
# What the containers then do is the job of the CI run that starts the whole
# stack.
#
# Prints what it checks and stops at the first thing that is wrong.
set -eu

source_dir=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/docker"
cp "$source_dir/start.sh" "$source_dir/setup.sh" "$source_dir/.env.example" \
  "$source_dir/compose.yaml" "$source_dir/application.env" "$work/docker/"

# Every call as one line: the version it saw in the environment, then the
# arguments. Which variable holds the version is the prefix of the application
# that starts, OPENGEWERK_VERSION unless WATCHED names another. "docker compose
# version" answers like the real one does, and "docker info" with the version
# of the engine in DOCKER_SERVER, 28.3.3 when it is not set, and its ID. The one
# question start.sh asks the running application, whether it still waits for
# its first run, is answered with SETUP_NEEDED, false when it is not set and
# nothing at all when it is empty.
cat > "$work/bin/docker" <<'FAKE'
#!/bin/sh
eval "seen=\${${WATCHED:-OPENGEWERK_VERSION}:-}"
printf '%s|%s\n' "$seen" "$*" >> "$CALLS"
case "$*" in
  *' exec -T app '*) printf '%s' "${SETUP_NEEDED-false}" ;;
  "info --format {{.ServerVersion}}|{{.ID}}")
    # The engine answers its version and its ID at once. DOCKER_SERVERS and
    # DOCKER_IDS answer the questions in turn, the last one for every
    # question after, as an engine swapped meanwhile behind the same context
    # would; else DOCKER_SERVER and DOCKER_ID answer all of them.
    echo asked >> "$CALLS.engine"
    asked=$(wc -l < "$CALLS.engine")
    if [ -n "${DOCKER_SERVERS:-}" ]; then
      server=$(printf '%s\n' "$DOCKER_SERVERS" | awk -v n="$asked" '{ print (n <= NF ? $n : $NF) }')
    else
      server=${DOCKER_SERVER-28.3.3}
    fi
    if [ -n "${DOCKER_IDS:-}" ]; then
      id=$(printf '%s\n' "$DOCKER_IDS" | awk -v n="$asked" '{ print (n <= NF ? $n : $NF) }')
    else
      id=${DOCKER_ID-engine-1}
    fi
    printf '%s|%s\n' "$server" "$id"
    ;;
  'info --format '* | 'version --format '*)
    echo 'nur {{.ServerVersion}}|{{.ID}} fragt start.sh' >&2
    exit 1
    ;;
  'context show')
    [ -z "${CONTEXT_FAILS:-}" ] || exit 1
    printf '%s\n' "${CONTEXT_IN_USE-default}"
    ;;
esac
FAKE
chmod +x "$work/bin/docker"

CALLS="$work/calls"
PATH="$work/bin:$PATH"
export CALLS PATH
# Which engine start.sh talks to is what case 13 checks; nothing of the
# machine this runs on comes in.
unset DOCKER_CONTEXT DOCKER_HOST CONTEXT_FAILS CONTEXT_IN_USE DOCKER_SERVER DOCKER_SERVERS DOCKER_ID DOCKER_IDS \
  WATCHED SETUP_NEEDED

check() {
  printf 'check: %s\n' "$1"
}

# An if and not "! grep": set -e leaves out a negated command, so a check
# written that way could never fail.
absent() {
  if grep -q -- "$1" "$CALLS"; then
    printf 'FEHLER: aufgerufen wurde%s\n' "$1"
    exit 1
  fi
}

start() {
  : > "$CALLS"
  OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null > /dev/null 2>&1
}

pin() {
  sed "s/^OPENGEWERK_VERSION=.*/OPENGEWERK_VERSION=$1/" "$work/docker/.env" > "$work/docker/.env.new"
  mv "$work/docker/.env.new" "$work/docker/.env"
}

pulled() {
  grep -q "^$1|compose -f .*compose.yaml pull --policy missing\$" "$CALLS"
  grep -q "^$1|compose -f .*compose.yaml run --rm migrate\$" "$CALLS"
  grep -q "^$1|compose -f .*compose.yaml up -d --wait" "$CALLS"
  absent ' build'
}

# 1. A checkout: "source" in compose.yaml, nothing in the .env. The backup is
# built along with the application.
start
grep -q '|compose -f .*compose.yaml build migrate backup-schedule$' "$CALLS"
grep -q '|compose -f .*compose.yaml run --rm migrate$' "$CALLS"
absent ' pull'
check 'Quelltext: Anwendung und Sicherung gebaut, nichts geholt'

# 1b. Between the migration and the start, the application gets its login
# back if a restore of an older backup left it locked (#988): after the
# migration, so that it never works on the older schema, and before the
# start, which would otherwise wait for an application that cannot sign in.
awk '/\|compose -f .*compose.yaml run --rm migrate$/ { migrated = NR }
  /\|compose -f .*compose.yaml exec -T postgres psql / { unlocked = NR }
  /\|compose -f .*compose.yaml up -d --wait/ { started = NR }
  END { exit !(migrated && unlocked && started && migrated < unlocked && unlocked < started) }' "$CALLS" || {
  echo 'FEHLER: die Anmeldung nach einem Zurückspielen kommt nicht zwischen Migration und Start zurück'
  cat "$CALLS"
  exit 1
}
check 'Zurückspielen: die Anmeldung der Anwendung kommt nach der Migration zurück, vor dem Start'

# 2. A release kit: the version in compose.yaml, written there the way the
# release workflow writes it.
sed 's/OPENGEWERK_VERSION:-source}/OPENGEWERK_VERSION:-0.3.0}/' "$work/docker/compose.yaml" > "$work/docker/compose.kit"
mv "$work/docker/compose.kit" "$work/docker/compose.yaml"
start
pulled '0\.3\.0'
check 'Paket: Fassung 0.3.0 geholt, nichts gebaut'

# 3. A version in the .env wins over the kit, also written by hand on Windows.
pin 0.2.1
start
pulled '0\.2\.1'
check 'Fassung aus der .env geht vor'

printf 'OPENGEWERK_VERSION="0.2.2" # pinned\r\n' > "$work/docker/.env.line"
grep -v '^OPENGEWERK_VERSION=' "$work/docker/.env" >> "$work/docker/.env.line"
mv "$work/docker/.env.line" "$work/docker/.env"
start
pulled '0\.2\.2'
check 'Anführungszeichen, Kommentar und Zeilenende aus Windows gehören nicht zur Fassung'

# 4. And the environment over the .env, as Docker Compose has it.
: > "$CALLS"
OPENGEWERK_VERSION=0.4.0 OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null > /dev/null 2>&1
pulled '0\.4\.0'
check 'Fassung aus der Umgebung geht vor'

# 5. An .env from before #155 says "latest". In a kit that would build with
# no source to build from; setup.sh empties it, and the kit pulls its own.
pin latest
start
pulled '0\.3\.0'
check 'latest aus einer alten .env: das Paket holt seine Fassung'

# 6. An instance nobody has set up yet (#215): one line on where the setup
# code is, with the name of the variable and the file, and the code itself in
# none of what start.sh prints.
code=$(grep '^SETUP_CODE=' "$work/docker/.env" | cut -d= -f2-)
test -n "$code"
: > "$CALLS"
out=$(SETUP_NEEDED=true OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
printf '%s' "$out" | grep -q 'Einrichtungscode, er steht in docker/.env unter SETUP_CODE'
if printf '%s' "$out" | grep -qF "$code"; then
  echo 'FEHLER: der Einrichtungscode steht in der Ausgabe'
  exit 1
fi
grep -q '|compose -f .*compose.yaml exec -T app node -e ' "$CALLS"
check 'leere Instanz: nennt, wo der Einrichtungscode steht, und nicht den Code'

# 7. Set up, or no answer at all: not a word about the code.
for answer in false ''; do
  out=$(SETUP_NEEDED=$answer OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null 2>&1)
  if printf '%s' "$out" | grep -q 'Einrichtungscode'; then
    echo 'FEHLER: eine eingerichtete Instanz bekommt den Hinweis auf den Einrichtungscode'
    exit 1
  fi
done
check 'eingerichtete Instanz: kein Hinweis'

# 8. Another application: the scripts of this folder, its material in a folder
# of its own, named in APPLICATION_DIRECTORY (opengewerk-haustechnik#14). Its
# compose.yaml, its .env, its version variable and its name in every line; the
# version of the first application in the environment changes nothing.
probe="$work/probe"
mkdir -p "$probe"
cat > "$probe/application.env" <<'APPLICATION'
APPLICATION_NAME='Probewerk'
APPLICATION_PREFIX='PROBEWERK'
APPLICATION_EXAMPLE_ADDRESS='https://probewerk.meinbetrieb.de'
APPLICATION
sed 's/OPENGEWERK_/PROBEWERK_/g' "$source_dir/.env.example" > "$probe/.env.example"
sed -e 's/OPENGEWERK_/PROBEWERK_/g' -e 's/PROBEWERK_VERSION:-source}/PROBEWERK_VERSION:-1.0.0}/' \
  "$source_dir/compose.yaml" > "$probe/compose.yaml"

probe_start() {
  : > "$CALLS"
  WATCHED=PROBEWERK_VERSION OPENGEWERK_VERSION=9.9.9 PROBEWERK_ADDRESS=http://127.0.0.1:23900 \
    APPLICATION_DIRECTORY="$probe" sh "$work/docker/start.sh" < /dev/null 2>&1
}

ours=$(sha256sum "$work/docker/.env" | cut -d' ' -f1)
out=$(probe_start)
printf '%s\n' "$out"
grep -q "^1\.0\.0|compose -f $probe/compose.yaml pull --policy missing\$" "$CALLS"
grep -q "^1\.0\.0|compose -f $probe/compose.yaml run --rm migrate\$" "$CALLS"
absent ' build'
absent "$work/docker/compose.yaml"
grep -q '^TRUSTED_ORIGINS=http://127.0.0.1:23900$' "$probe/.env"
test "$(sha256sum "$work/docker/.env" | cut -d' ' -f1)" = "$ours"
if printf '%s\n' "$out" | grep -qv '^Probewerk: '; then
  echo 'FEHLER: eine Zeile beginnt nicht mit dem Namen der Anwendung'
  exit 1
fi
if printf '%s' "$out" | grep -q 'OpenGewerk'; then
  echo 'FEHLER: die zweite Anwendung bekommt den Namen der ersten zu lesen'
  exit 1
fi
check 'zweite Anwendung: ihre compose.yaml und Fassung, ihr Name, die .env der ersten unberührt'

sed 's/^PROBEWERK_VERSION=.*/PROBEWERK_VERSION=1.0.1/' "$probe/.env" > "$probe/.env.new"
mv "$probe/.env.new" "$probe/.env"
probe_start > /dev/null
grep -q "^1\.0\.1|compose -f $probe/compose.yaml pull --policy missing\$" "$CALLS"
check 'zweite Anwendung: ihre Fassung aus ihrer .env geht vor'

# A prefix that is no beginning of a variable stops before anything is called.
printf "APPLICATION_NAME='Probewerk'\nAPPLICATION_PREFIX='PROBE-WERK'\n" > "$probe/application.env"
: > "$CALLS"
if out=$(APPLICATION_DIRECTORY="$probe" sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: ein Präfix mit Bindestrich lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'kein Präfix für Variablen'
test ! -s "$CALLS"
check 'zweite Anwendung: falsches Präfix abgelehnt, bevor Docker gefragt wird'

# 9. A kit with digests (#687), packed the way the release packs it: its own
# version and no other, a version in the .env notwithstanding, and the
# signature of each image of the application checked against the release
# workflow before anything is pulled. Not the renderer, which nobody here
# signs.
cp "$source_dir/compose.yaml" "$work/docker/compose.yaml"
app_digest="sha256:$(printf '%064d' 1)"
backup_digest="sha256:$(printf '%064d' 2)"
sh "$source_dir/kit-images.sh" "$work/docker/compose.yaml" OPENGEWERK 0.6.0 \
  "ghcr.io/opengewerk/opengewerk@$app_digest" "ghcr.io/opengewerk/backup@$backup_digest"

cat > "$work/bin/cosign" <<'FAKE'
#!/bin/sh
printf 'cosign|%s\n' "$*" >> "$CALLS"
if [ -n "${COSIGN_REFUSES:-}" ]; then
  echo 'Error: no matching signatures' >&2
  exit 1
fi
FAKE
chmod +x "$work/bin/cosign"

said() {
  : > "$CALLS"
  OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null 2>&1
}

identity='https://github.com/OpenGewerk/opengewerk/.github/workflows/release.yml@refs/tags/v0.6.0'
pin 0.2.1
out=$(said)
for image in "ghcr.io/opengewerk/opengewerk:0.6.0@$app_digest" "ghcr.io/opengewerk/backup:0.6.0@$backup_digest"; do
  grep -qF "cosign|verify --certificate-identity $identity --certificate-oidc-issuer https://token.actions.githubusercontent.com $image" "$CALLS"
done
absent 'cosign|.*browserless'
pulled '0\.6\.0'
first_pull=$(grep -n 'pull --policy missing' "$CALLS" | head -n 1 | cut -d: -f1)
last_check=$(grep -n '^cosign|' "$CALLS" | tail -n 1 | cut -d: -f1)
test "$last_check" -lt "$first_pull"
printf '%s' "$out" | grep -q 'gilt nur für einen Checkout'
printf '%s' "$out" | grep -q 'Die Signaturen der Abbilder sind geprüft.'
check 'Paket mit Digest: seine Fassung, jede Signatur geprüft, bevor etwas geholt wird'

# 10. A signature that does not hold stops the start before anything is
# pulled or migrated, and says why.
if out=$(COSIGN_REFUSES=1 said); then
  echo 'FEHLER: eine abgelehnte Signatur lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'ließ sich nicht bestätigen'
printf '%s' "$out" | grep -q 'no matching signatures'
absent ' pull'
absent ' run --rm migrate'
check 'Paket mit Digest: abgelehnte Signatur hält den Start an'

# 11. Without cosign the start goes on and says how to check by hand.
out=$(COSIGN="$work/no-cosign" said)
printf '%s' "$out" | grep -q 'cosign fehlt auf dieser Maschine'
printf '%s' "$out" | grep -qF "cosign verify --certificate-identity $identity"
absent '^cosign|'
pulled '0\.6\.0'
check 'Paket mit Digest ohne cosign: sagt, wie man von Hand prüft'

# 12. The version of the engine (#985): below 28.3.3, or one that cannot be
# read as numbers, stops the start before anything is pulled, built or set
# up; 28.3.3 and newer, a suffix of a distribution included, starts.
for engine in 27.5.1 28.3.2 28.2.0 dev 28.4.dev 28.3.3-rc.1 '28.3.3~rc1' '' 28garbage.4.0 28.4x.0 '28.3.3x' 28.3.3.dev 28.3.3.1 '28.3.3 '; do
  : > "$CALLS"
  rm -f "$work/docker/.env"
  if out=$(DOCKER_SERVER=$engine OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null 2>&1); then
    printf 'FEHLER: Docker "%s" lief durch\n' "$engine"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'braucht Docker Engine ab'
  absent 'compose -f'
  if [ -f "$work/docker/.env" ]; then
    printf 'FEHLER: mit Docker "%s" wurde erst eingerichtet, dann abgelehnt
' "$engine"
    exit 1
  fi
done
check 'Docker unter 28.3.3 oder ohne lesbare Fassung: abgelehnt, bevor etwas geholt oder eingerichtet wird'

for engine in 28.3.3 28.4.0 29.0.0 28.10.1 '29.4.2+dfsg1' 28.3.3+ds1 29.0.0-rc.1; do
  : > "$CALLS"
  DOCKER_SERVER=$engine OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null > /dev/null 2>&1 || {
    printf 'FEHLER: Docker "%s" wurde abgelehnt\n' "$engine"
    exit 1
  }
  grep -q 'compose -f .*compose.yaml up -d --wait' "$CALLS"
done
check 'Docker ab 28.3.3 startet'

# Every question for the version of the engine, three in a run that starts
# (at the beginning, before the migrations and before the start), was asked
# with $1 in the watched variable, and no other.
every_version_question_in() {
  all_questions=$(grep -c '|info --format {{.ServerVersion}}|{{.ID}}$' "$CALLS" || true)
  these=$(grep -c "^$1|info --format {{.ServerVersion}}|{{.ID}}\$" "$CALLS" || true)
  [ "$all_questions" -eq 3 ] && [ "$these" -eq 3 ] || {
    printf 'FEHLER: %s von %s Fragen nach der Engine liefen mit "%s"\n' "$these" "$all_questions" "$1"
    cat "$CALLS"
    exit 1
  }
  # And every other call of docker that talks to an engine, pull, run and up
  # among them, with the same, whether the context was read or set before.
  # "compose version" asks the local plugin and "context show" the CLI, not
  # an engine; cosign is no call of docker.
  elsewhere=$(awk -v prefix="$1|" '!/^cosign[|]/ && !/[|]compose version$/ && !/[|]context show$/ &&
    index($0, prefix) != 1 { n++ }
    END { print n + 0 }' "$CALLS")
  [ "$elsewhere" -eq 0 ] || {
    printf 'FEHLER: %s Aufrufe von docker liefen nicht mit "%s"\n' "$elsewhere" "$1"
    cat "$CALLS"
    exit 1
  }
}

# 13. The engine checked is the one compose talks to (#985): the context in use
# when start.sh began holds for every call after, and one set beforehand, or
# DOCKER_HOST, is left as it is.
: > "$CALLS"
WATCHED=DOCKER_CONTEXT CONTEXT_IN_USE=nachbar OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null > /dev/null 2>&1
every_version_question_in nachbar &&
  grep -q '^nachbar|compose -f .*compose.yaml up -d --wait' "$CALLS" || {
  echo 'FEHLER: Prüfung und compose liefen nicht im selben, festgehaltenen Kontext'
  cat "$CALLS"
  exit 1
}
: > "$CALLS"
DOCKER_CONTEXT=eigener WATCHED=DOCKER_CONTEXT CONTEXT_IN_USE=nachbar OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null > /dev/null 2>&1
every_version_question_in eigener
grep -q '^eigener|compose -f .*compose.yaml up -d --wait' "$CALLS"
: > "$CALLS"
DOCKER_HOST=tcp://127.0.0.1:2375 WATCHED=DOCKER_CONTEXT CONTEXT_IN_USE=nachbar OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null > /dev/null 2>&1
grep -q '^|compose -f .*compose.yaml up -d --wait' "$CALLS"
: > "$CALLS"
DOCKER_HOST=tcp://127.0.0.1:2375 WATCHED=DOCKER_HOST CONTEXT_IN_USE=nachbar OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null > /dev/null 2>&1
every_version_question_in tcp://127.0.0.1:2375
grep -q '^tcp://127.0.0.1:2375|compose -f .*compose.yaml up -d --wait' "$CALLS"
: > "$CALLS"
if out=$(CONTEXT_IN_USE='' OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: ohne lesbaren Kontext lief der Start durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'nennt keinen Kontext.*CLI vor 23.0'
absent 'compose -f'
# A CLI before 23.0 knows no "context show": the version still speaks first.
: > "$CALLS"
rm -f "$work/docker/.env"
if out=$(CONTEXT_FAILS=1 DOCKER_SERVER=20.10.24 OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine alte Docker-CLI ohne Kontext lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'Docker meldet die Fassung "20.10.24"'
absent 'compose -f'
test ! -f "$work/docker/.env"
check 'Docker: Prüfung und Start im selben Kontext, ein gesetzter Kontext oder DOCKER_HOST bleibt, ohne Kontext kein Start'

# 14. An engine that changed behind the same context between the checks is
# asked again before each step that starts containers: too old before the
# migrations, nothing starts; too old only before the start, the migrations
# ran and the application does not start.
: > "$CALLS"
rm -f "$CALLS.engine"
if out=$(DOCKER_SERVERS='28.3.3 27.5.1' OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine Engine, die vor den Migrationen zu alt wurde, startete Container'
  exit 1
fi
printf '%s' "$out" | grep -q 'Docker meldet die Fassung "27.5.1"'
if printf '%s' "$out" | grep -q 'schon auf dem neuen Stand'; then
  echo 'FEHLER: vor den Migrationen hieß es, die Datenbank sei schon auf dem neuen Stand'
  exit 1
fi
absent 'run --rm migrate'
absent 'up -d'
: > "$CALLS"
rm -f "$CALLS.engine"
if out=$(DOCKER_SERVERS='28.3.3 28.3.3 27.5.1' OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine Engine, die vor dem Start zu alt wurde, startete die Anwendung'
  exit 1
fi
printf '%s' "$out" | grep -q 'Docker meldet die Fassung "27.5.1"'
printf '%s' "$out" | grep -q 'schon auf dem neuen Stand' || {
  echo 'FEHLER: nach den Migrationen sagte die Meldung nicht, dass die Datenbank schon migriert ist'
  exit 1
}
grep -q 'run --rm migrate$' "$CALLS"
absent 'up -d'
rm -f "$CALLS.engine"
check 'Docker: vor jedem Schritt, der Container startet, wird die Engine noch einmal gefragt'

# 15. Another engine behind the same context, new enough as well: before the
# migrations nothing starts, after them the application does not start on
# it; an engine without an ID starts nothing.
: > "$CALLS"
rm -f "$CALLS.engine"
if out=$(DOCKER_IDS='erste zweite' OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine andere Engine vor den Migrationen bekam Container'
  exit 1
fi
printf '%s' "$out" | grep -q 'eine andere Engine'
absent 'run --rm migrate'
absent 'up -d'
: > "$CALLS"
rm -f "$CALLS.engine"
if out=$(DOCKER_IDS='erste erste zweite' OPENGEWERK_ADDRESS=http://127.0.0.1:23700 \
  sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine andere Engine nach den Migrationen startete die Anwendung'
  exit 1
fi
printf '%s' "$out" | grep -q 'eine andere Engine.*schon auf dem neuen Stand'
grep -q 'run --rm migrate$' "$CALLS"
absent 'up -d'
: > "$CALLS"
rm -f "$CALLS.engine"
if out=$(DOCKER_ID='' OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/docker/start.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine Engine ohne Kennung bekam Container'
  exit 1
fi
printf '%s' "$out" | grep -q 'keine Kennung seiner Engine'
absent 'run --rm migrate'
rm -f "$CALLS.engine"
check 'Docker: dieselbe Engine vom ersten Blick bis zum Start'

echo 'Startskript: alles in Ordnung.'
