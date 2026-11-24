#!/bin/sh
# Exercises setup.sh in a scratch copy of this folder, for the CI and for
# anybody who changes the script: the first run, a second one, an older .env
# meeting a newer template, and the refusals. Above all it checks that no
# value the script makes appears in what it prints. And that another
# application can run it against its own folder (opengewerk-haustechnik#14).
#
# Prints what it checks and stops at the first thing that is wrong.
set -eu

source_dir=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cp "$source_dir/setup.sh" "$source_dir/.env.example" "$source_dir/application.env" "$work/"

# What the environment of whoever runs the test holds for the address, the
# port, Compose and the stand-in for docker below stays out; the cases that
# need one set it themselves.
unset OPENGEWERK_ADDRESS OPENGEWERK_PORT TRUSTED_ORIGINS FAKE_JSON FAKE_PUBLISHED FAKE_LATER FAKE_OPERATOR FAKE_ENV \
  FAKE_MISSING FAKE_COUNT
for compose_variable in $(printenv | sed -n 's/^\(COMPOSE_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$compose_variable"
done

check() {
  printf 'check: %s\n' "$1"
}

# 1. The first run, with the address from the environment.
out=$(OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
test -f "$work/.env"
# An if and not "! grep": set -e leaves out a negated command, so that line
# could never fail. A value and not the word, which the comment at the top of
# the template names too.
if grep -q '^[A-Z_]*=bitte-ersetzen' "$work/.env"; then
  echo 'FEHLER: in der .env steht noch ein Platzhalter'
  exit 1
fi
grep -q '^TRUSTED_ORIGINS=http://127.0.0.1:23700$' "$work/.env"
grep -qx 'COMPOSE_PROFILES=renderer' "$work/.env"
check 'erster Lauf: keine Platzhalter, Adresse eingetragen, Renderer eingeschaltet'

for name in POSTGRES_PASSWORD OPENGEWERK_OWNER_PASSWORD OPENGEWERK_APP_PASSWORD RENDERER_TOKEN SESSION_SECRET; do
  value=$(grep "^${name}=" "$work/.env" | cut -d= -f2-)
  printf '%s' "$value" | grep -Eq '^[0-9a-f]{64}$'
  if printf '%s' "$out" | grep -q "$value"; then
    echo "FEHLER: der Wert von $name steht in der Ausgabe"
    exit 1
  fi
done
check 'fünf Schlüssel aus 64 Hexzeichen, keiner in der Ausgabe'

distinct=$(grep -E '^(POSTGRES_PASSWORD|OPENGEWERK_OWNER_PASSWORD|OPENGEWERK_APP_PASSWORD|RENDERER_TOKEN|SESSION_SECRET)=' "$work/.env" | cut -d= -f2- | sort -u | wc -l)
test "$distinct" -eq 5
check 'jeder Schlüssel anders'

# The setup code (#215): eight characters to type, without 0, O, 1, I and L,
# and not in the output either.
code=$(grep '^SETUP_CODE=' "$work/.env" | cut -d= -f2-)
printf '%s' "$code" | grep -Eq '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'
if printf '%s' "$out" | grep -qF "$code"; then
  echo 'FEHLER: der Einrichtungscode steht in der Ausgabe'
  exit 1
fi
printf '%s' "$out" | grep -q 'eingetragen:.* SETUP_CODE'
check 'Einrichtungscode: XXXX-XXXX ohne verwechselbare Zeichen, nicht in der Ausgabe'

# The key for push (#284): a private key on P-256 in PKCS #8, and not in the
# output either. "pkcs8" and not "pkey" for the form: pkey reads the older SEC1
# form as well, which the application refuses, and a check with it passed while
# every instance it made failed to start.
vapid=$(grep '^VAPID_PRIVATE_KEY=' "$work/.env" | cut -d= -f2-)
printf '%s' "$vapid" | openssl base64 -d -A | openssl pkcs8 -nocrypt -inform DER -outform PEM > /dev/null 2>&1
printf '%s' "$vapid" | openssl base64 -d -A | openssl pkey -inform DER -noout -text 2>/dev/null | grep -q prime256v1
if printf '%s' "$out" | grep -qF "$vapid"; then
  echo 'FEHLER: der Schlüssel für Push steht in der Ausgabe'
  exit 1
fi
printf '%s' "$out" | grep -q 'eingetragen:.* VAPID_PRIVATE_KEY'
check 'Schlüssel für Push: auf P-256, nicht in der Ausgabe'

# 2. A second run changes nothing.
before=$(sha256sum "$work/.env" | cut -d' ' -f1)
out=$(sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
after=$(sha256sum "$work/.env" | cut -d' ' -f1)
test "$before" = "$after"
printf '%s' "$out" | grep -q 'nichts zu erzeugen'
check 'zweiter Lauf: Datei unverändert'

# 3. An older .env meets a newer template.
grep -v '^CLOSED=' "$work/.env" > "$work/.env.old"
mv "$work/.env.old" "$work/.env"
printf 'NEW_SECRET=bitte-ersetzen-9\n' >> "$work/.env.example"
out=$(sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
grep -q '^CLOSED=false$' "$work/.env"
grep -Eq '^NEW_SECRET=[0-9a-f]{64}$' "$work/.env"
printf '%s' "$out" | grep -q 'Aus der Vorlage übernommen: CLOSED NEW_SECRET'
check 'neuere Vorlage: fehlende Variablen übernommen, neuer Schlüssel erzeugt'

# 4. An .env from before #215 has no setup code. It gets one on the next
# start, like any key a newer template brings, and in the same form.
grep -v '^SETUP_CODE=' "$work/.env" > "$work/.env.old"
mv "$work/.env.old" "$work/.env"
out=$(sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
grep -Eq '^SETUP_CODE=[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$' "$work/.env"
printf '%s' "$out" | grep -q 'Aus der Vorlage übernommen: SETUP_CODE'
code=$(grep '^SETUP_CODE=' "$work/.env" | cut -d= -f2-)
if printf '%s' "$out" | grep -qF "$code"; then
  echo 'FEHLER: der Einrichtungscode steht in der Ausgabe'
  exit 1
fi
check 'ältere .env ohne Einrichtungscode: bekommt einen'

# 4b. An .env from before #284 has no key for push, and gets one the same way.
grep -v '^VAPID_PRIVATE_KEY=' "$work/.env" > "$work/.env.old"
mv "$work/.env.old" "$work/.env"
out=$(sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
printf '%s' "$out" | grep -q 'Aus der Vorlage übernommen: VAPID_PRIVATE_KEY'
vapid=$(grep '^VAPID_PRIVATE_KEY=' "$work/.env" | cut -d= -f2-)
printf '%s' "$vapid" | openssl base64 -d -A | openssl pkcs8 -nocrypt -inform DER -outform PEM > /dev/null 2>&1
check 'ältere .env ohne Schlüssel für Push: bekommt einen'

# 5. A renderer switched off stays off. An empty value is a value, and only a
# line that is missing is taken from the template again.
sed 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=/' "$work/.env" > "$work/.env.off"
mv "$work/.env.off" "$work/.env"
out=$(sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
grep -qx 'COMPOSE_PROFILES=' "$work/.env"
check 'abgeschalteter Renderer: bleibt abgeschaltet'

# 6. An .env from before #155 still says "latest", which never named a
# version. It becomes empty, and a version somebody chose stays.
sed 's/^OPENGEWERK_VERSION=.*/OPENGEWERK_VERSION=latest/' "$work/.env" > "$work/.env.old"
mv "$work/.env.old" "$work/.env"
out=$(sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
grep -qx 'OPENGEWERK_VERSION=' "$work/.env"
printf '%s' "$out" | grep -q 'stand auf latest'
sed 's/^OPENGEWERK_VERSION=.*/OPENGEWERK_VERSION=0.2.0/' "$work/.env" > "$work/.env.pinned"
mv "$work/.env.pinned" "$work/.env"
sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
grep -qx 'OPENGEWERK_VERSION=0.2.0' "$work/.env"
check 'latest aus einer alten .env: jetzt leer, eine gewählte Fassung bleibt'

# 6b. The folder of the installation, for an update from the office (#1093):
# on Linux the path of the folder above the scripts, corrected after a move,
# and empty for a path the .env and a mount would not carry as it is. On
# another system it stays empty, as the template has it.
installation=$(cd "$work/.." && pwd -P)
if [ "$(uname -s)" = Linux ]; then
  grep -qx "OPENGEWERK_DIRECTORY=$installation" "$work/.env"
  sed 's|^OPENGEWERK_DIRECTORY=.*|OPENGEWERK_DIRECTORY=/srv/elsewhere|' "$work/.env" > "$work/.env.moved"
  mv "$work/.env.moved" "$work/.env"
  out=$(sh "$work/setup.sh" < /dev/null 2>&1)
  grep -qx "OPENGEWERK_DIRECTORY=$installation" "$work/.env"
  printf '%s' "$out" | grep -q 'für Aktualisierungen aus dem Büro eingetragen'
  spaced="$work/mit Leerzeichen/docker"
  mkdir -p "$spaced"
  cp "$source_dir/setup.sh" "$source_dir/.env.example" "$source_dir/application.env" "$spaced/"
  OPENGEWERK_ADDRESS=http://127.0.0.1:23700 sh "$spaced/setup.sh" < /dev/null > /dev/null 2>&1
  grep -qx 'OPENGEWERK_DIRECTORY=' "$spaced/.env"
  # Moved there from a path that went into the .env: that path comes out.
  sed 's|^OPENGEWERK_DIRECTORY=.*|OPENGEWERK_DIRECTORY=/srv/opengewerk|' "$spaced/.env" > "$spaced/.env.moved"
  mv "$spaced/.env.moved" "$spaced/.env"
  out=$(sh "$spaced/setup.sh" < /dev/null 2>&1)
  grep -qx 'OPENGEWERK_DIRECTORY=' "$spaced/.env"
  printf '%s' "$out" | grep -q 'nur von Hand'
  rm -rf "$work/mit Leerzeichen"
  check 'Ordner der Installation: eingetragen, nach einem Umzug berichtigt, mit Leerzeichen leer, auch nach einem Umzug dorthin'
else
  grep -qx 'OPENGEWERK_DIRECTORY=' "$work/.env"
  check 'Ordner der Installation: außerhalb von Linux leer'
fi

# 7. No address and nobody at the terminal: a sentence, and a failure.
rm "$work/.env"
if out=$(sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: ohne Adresse lief das Skript durch'
  exit 1
fi
printf '%s\n' "$out"
printf '%s' "$out" | grep -q 'fehlt die Adresse'
check 'ohne Adresse: abgelehnt'

# 8. An address with a path.
rm "$work/.env"
if out=$(OPENGEWERK_ADDRESS=https://opengewerk.example.org/buero sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine Adresse mit Pfad lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'hat einen Pfad'
check 'Adresse mit Pfad: abgelehnt'

# 9. A trailing slash is taken off.
rm "$work/.env"
OPENGEWERK_ADDRESS=https://opengewerk.example.org/ sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
grep -q '^TRUSTED_ORIGINS=https://opengewerk.example.org$' "$work/.env"
check 'Schrägstrich am Ende: weggenommen'

# 9b. The port of the scheme is taken off as well, another port stays.
for pair in 'http://localhost:80 http://localhost' 'https://opengewerk.example.org:443 https://opengewerk.example.org' \
  'http://localhost:8080 http://localhost:8080' 'http://localhost:080 http://localhost' \
  'https://opengewerk.example.org:0443 https://opengewerk.example.org' 'http://localhost:08080 http://localhost:8080' \
  'https://opengewerk.example.org:8443 https://opengewerk.example.org:8443'; do
  given=${pair% *}
  kept=${pair#* }
  rm "$work/.env"
  OPENGEWERK_ADDRESS=$given sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
  grep -qxF "TRUSTED_ORIGINS=$kept" "$work/.env" || {
    printf 'FEHLER: aus %s wurde nicht %s\n' "$given" "$kept"
    exit 1
  }
done
for address in https://:443 http://:8080 'http://[]:80' 'https://[::1'; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'nennt keine Maschine'
done
for address in http://localhost:65536 https://opengewerk.example.org:65536 http://localhost:80:80 \
  https://opengewerk.example.org:999999 http://localhost:0 https://opengewerk.example.org:00000; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'keinen Port aus Ziffern zwischen 1 und 65535'
done
# A port browsers do not open, in any spelling.
for address in https://opengewerk.example.org:6000 http://localhost:10080 http://127.0.0.1:0021; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'öffnen Browser nicht'
done
# http to another machine with a port out of range: the first word is about
# https, so that one run says what to change.
rm -f "$work/.env"
if out=$(OPENGEWERK_ADDRESS=http://opengewerk.example.org:65536 sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: http mit einem Port über 65535 lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'beginnt mit https://'
for address in 'https://[2001:0db8::1]:443' 'https://[2001:db8::1]' 'http://[fe80::1]:8080' 'http://[::1]' \
  'http://[::1]:23700' 'http://[::1]:x' 'https://[::1]:8443]' 'https://[::1]x'; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'Eine IPv6-Adresse nimmt die Rückfrage nicht'
done
# The name as a browser writes it: in small letters, and nothing a browser
# would write differently.
for pair in 'https://OpenGewerk.Example.org https://opengewerk.example.org' \
  'http://LOCALHOST:23700 http://localhost:23700' 'https://192.0.2.10 https://192.0.2.10' \
  'https://werk_statt.example.org:8443 https://werk_statt.example.org:8443' \
  'https://werkstatt.0xlab https://werkstatt.0xlab'; do
  given=${pair% *}
  kept=${pair#* }
  rm -f "$work/.env"
  OPENGEWERK_ADDRESS=$given sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
  grep -qxF "TRUSTED_ORIGINS=$kept" "$work/.env" || {
    printf 'FEHLER: aus %s wurde nicht %s\n' "$given" "$kept"
    exit 1
  }
done
for pair in 'https://bücher.example.org|nicht so, wie ein Browser' 'https://user@example.org|Angaben vor dem Namen' \
  'http://[::1]:1@example.org:80|Angaben vor dem Namen' 'http://localhost:x@example.org|Angaben vor dem Namen' \
  'http://localhost:1@example.org:8080|Angaben vor dem Namen' \
  'https://example.org.|Punkt am Ende des Namens' 'http://127.0.0.1.:23700|Punkt am Ende des Namens' \
  'https://example.org?x|nicht so, wie ein Browser' \
  'https://example.org#x|nicht so, wie ein Browser' 'https://a..example.org|nicht so, wie ein Browser' \
  'https://127.1|keine IPv4-Adresse' 'https://0x7f.0.0.1|keine IPv4-Adresse' \
  'https://192.0.2.010|keine IPv4-Adresse' 'https://256.1.1.1|keine IPv4-Adresse' 'https://example.0x10|keine IPv4-Adresse'; do
  address=${pair%%|*}
  said=${pair#*|}
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  printf '%s' "$out" | grep -q "$said" || {
    printf 'FEHLER: %s ohne den Satz "%s"\n' "$address" "$said"
    printf '%s\n' "$out"
    exit 1
  }
done
check 'Port des Schemas: weggenommen, führende Nullen weg, ein anderer bleibt, keiner über 65535 und keiner doppelt'

# 9a. Plain http only on this machine (#984): every other host is turned
# away with a sentence that asks for https, a port that is no number with one
# that asks for digits; localhost and 127.0.0.1, with and without a port, are
# taken. [::1] is refused with the IPv6 addresses under 9b.
for address in http://opengewerk.example.org http://192.168.1.20:23700 \
  http://localhost.example.org http://127.0.0.1: http://localhost:abc:23700; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  case "$address" in
    *:abc:* | *:) printf '%s' "$out" | grep -q 'keinen Port aus Ziffern' ;;
    *) printf '%s' "$out" | grep -q 'beginnt mit https://' ;;
  esac
done
for address in http://localhost http://localhost:23700 http://127.0.0.1 http://127.0.0.1:23700; do
  rm -f "$work/.env"
  OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
  grep -qxF "TRUSTED_ORIGINS=$address" "$work/.env"
done
check 'http:// nur für diese Maschine: andere Adressen abgelehnt, localhost und 127.0.0.1 angenommen'

# 9c. An address with a user and a password before the name is turned away,
# and no sentence repeats either of them.
for address in 'https://benutzer:geheim@example.org:8080' 'https://benutzer:geheim@example.org' \
  'https://geheim@example.org' 'http://benutzer:geheim@localhost:8080'; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  if printf '%s' "$out" | grep -q 'geheim\|benutzer'; then
    printf 'FEHLER: die Meldung zu einer Adresse mit Passwort wiederholte es: %s\n' "$out"
    exit 1
  fi
done
check 'Adresse mit Benutzer und Passwort: abgelehnt, ohne sie zu wiederholen'

# 9d. The port of the address offered is the one Docker Compose publishes,
# asked from Compose itself: the exported environment before the .env, a
# value over several lines and COMPOSE_DISABLE_ENV_FILE as Compose takes
# them. A value compose.yaml requires gets a stand-in only where Compose finds
# it missing, so a port given through one still counts. A second mapping of
# any kind offers none. Needs Docker Compose, which the CI has.
sed -n '/^published_port() {/,/^}/p' "$work/setup.sh" > "$work/published-port.sh"
test -s "$work/published-port.sh"
port_in() {
  (
    here=$1
    . "$work/published-port.sh"
    published_port
  )
}
if docker compose version > /dev/null 2>&1; then
  mkdir "$work/ports"
  cp "$source_dir/compose.yaml" "$work/ports/compose.yaml"
  printf 'OPENGEWERK_PORT=24567\n' > "$work/ports/.env"
  [ "$(port_in "$work/ports")" = 24567 ]
  [ "$(OPENGEWERK_PORT=24999 port_in "$work/ports")" = 24999 ]
  [ "$(COMPOSE_DISABLE_ENV_FILE=1 port_in "$work/ports")" = 23700 ]
  printf "OPENGEWERK_PORT=24567\nNOTE='erste Zeile\nOPENGEWERK_PORT=24999\nletzte'\n" > "$work/ports/.env"
  [ "$(port_in "$work/ports")" = 24567 ]
  rm "$work/ports/.env"
  [ "$(port_in "$work/ports")" = 23700 ]
  # The migrate step gets the address as Compose hands it on, so that it
  # refuses one the application would before the first change (#984).
  grep -o '\${[A-Za-z_][A-Za-z0-9_]*:?' "$source_dir/compose.yaml" | sed -e 's/^\${//' -e 's/:?$/=set/' |
    sort -u > "$work/ports/.env"
  TRUSTED_ORIGINS=set docker compose -f "$work/ports/compose.yaml" config --format json |
    awk '/^    "migrate": \{$/ { migrate = 1; next } migrate && /^    \}/ { migrate = 0 }
      migrate && /^ *"TRUSTED_ORIGINS": "set"/ { found = 1 } END { exit !found }' || {
    echo 'FEHLER: der Schritt migrate bekommt TRUSTED_ORIGINS nicht'
    exit 1
  }
  rm "$work/ports/.env"
  # A port given through a value compose.yaml requires: the value set counts,
  # and without it none is offered.
  sed 's/\${OPENGEWERK_PORT:-23700}/${OPENGEWERK_PORT:?Port fehlt}/' "$source_dir/compose.yaml" > "$work/ports/compose.yaml"
  [ "$(grep -c 'OPENGEWERK_PORT:?Port fehlt' "$work/ports/compose.yaml")" = 1 ]
  printf 'OPENGEWERK_PORT=24567\n' > "$work/ports/.env"
  [ "$(port_in "$work/ports")" = 24567 ] || {
    echo 'FEHLER: ein gesetzter Port, den compose.yaml verlangt, bekam einen Platzhalter'
    exit 1
  }
  rm "$work/ports/.env"
  [ -z "$(port_in "$work/ports")" ]
  # A second mapping of any kind, a range or one without a port of its own
  # included: no port is offered.
  for second in '127.0.0.1:23701:23701' '3000' '9000-9005:9000-9005'; do
    awk -v second="$second" '{ print } index($0, "${OPENGEWERK_PORT:-23700}:23700") { print "      - '\''" second "'\''" }' \
      "$source_dir/compose.yaml" > "$work/ports/compose.yaml"
    [ "$(grep -cF "      - '$second'" "$work/ports/compose.yaml")" = 1 ]
    # Compose takes the file, with every value it requires set: the empty
    # answer below is about the second mapping, not about a broken file.
    grep -o '\${[A-Za-z_][A-Za-z0-9_]*:?' "$source_dir/compose.yaml" | sed -e 's/^\${//' -e 's/:?$/=set/' |
      sort -u > "$work/ports/.env"
    docker compose -f "$work/ports/compose.yaml" config -q || {
      printf 'FEHLER: Docker Compose nahm compose.yaml mit der zweiten Zuordnung %s nicht an\n' "$second"
      exit 1
    }
    [ -z "$(port_in "$work/ports")" ] || {
      printf 'FEHLER: mit der zweiten Zuordnung %s wurde ein Port angeboten\n' "$second"
      exit 1
    }
    rm "$work/ports/.env"
  done
  rm -r "$work/ports"
  check 'Port der Adresse: so, wie Docker Compose ihn veröffentlicht'
else
  echo 'Hinweis: ohne Docker Compose bleibt der Port der vorgeschlagenen Adresse ungeprüft.'
fi

# A stand-in for docker, for answers Compose would not give here. It prints
# nothing but the first of FAKE_MISSING that is not set, as missing, when there
# is one. Else FAKE_JSON when that is set, else one mapping with the port FAKE_PUBLISHED,
# and from its third question on FAKE_LATER, when that is set; from then on it
# also writes FAKE_OPERATOR into the address of the .env FAKE_ENV, as someone
# would while the question waits. FAKE_COUNT holds how often it was asked.
mkdir "$work/fake"
cat > "$work/fake/docker" <<'FAKE'
#!/bin/sh
case "$*" in
  'compose -f '*' config --format json') ;;
  *) exit 1 ;;
esac
asked=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0)
asked=$((asked + 1))
echo "$asked" > "$FAKE_COUNT"
# One missing value at a time, as an older Compose names them.
for name in ${FAKE_MISSING:-}; do
  if ! printenv "$name" > /dev/null; then
    echo "error while interpolating: required variable $name is missing a value: $name fehlt" >&2
    exit 1
  fi
done
if [ -n "${FAKE_JSON:-}" ]; then
  printf '%s\n' "$FAKE_JSON"
  exit 0
fi
port=$FAKE_PUBLISHED
if [ -n "${FAKE_LATER:-}" ] && [ "$asked" -gt 2 ]; then
  port=$FAKE_LATER
fi
if [ -n "${FAKE_OPERATOR:-}" ] && [ "$asked" -gt 2 ]; then
  sed "s|^TRUSTED_ORIGINS=.*|TRUSTED_ORIGINS=$FAKE_OPERATOR|" "$FAKE_ENV" > "$FAKE_ENV.new"
  mv "$FAKE_ENV.new" "$FAKE_ENV"
fi
printf '{\n  "services": {\n    "app": {\n      "ports": [\n        {\n          "target": 23700,\n          "published": "%s"\n        }\n      ]\n    }\n  }\n}\n' "$port"
FAKE
chmod +x "$work/fake/docker"
FAKE_COUNT="$work/fake/count"
export FAKE_COUNT

# 9e. The port comes from the mapping and nowhere else: "published" as the
# name of a variable in the environment of a service is no port, a target
# outside the ports of a service is no mapping, leading zeros fall away, and 0
# is no fixed port.
decoy='{
  "services": {
    "app": {
      "environment": {
        "published": "8088"
      },
      "ports": [
        {
          "mode": "ingress",
          "target": 23700,
          "protocol": "tcp"
        }
      ]
    }
  }
}'
rm -f "$FAKE_COUNT"
[ -z "$(PATH="$work/fake:$PATH" FAKE_JSON=$decoy port_in "$work")" ] || {
  echo 'FEHLER: eine Variable namens published galt als Port'
  exit 1
}
rm -f "$FAKE_COUNT"
[ "$(PATH="$work/fake:$PATH" FAKE_PUBLISHED=08080 port_in "$work")" = 8080 ]
# A mapping over UDP alone gives no port for a browser.
udp='{
  "services": {
    "app": {
      "ports": [
        {
          "mode": "ingress",
          "host_ip": "127.0.0.1",
          "target": 23700,
          "published": "8080",
          "protocol": "udp"
        }
      ]
    }
  }
}'
rm -f "$FAKE_COUNT"
[ -z "$(PATH="$work/fake:$PATH" FAKE_JSON=$udp port_in "$work")" ] || {
  echo 'FEHLER: eine Zuordnung über UDP gab einen Port'
  exit 1
}
tcp=$(printf '%s\n' "$udp" | sed 's/"udp"/"tcp"/')
rm -f "$FAKE_COUNT"
[ "$(PATH="$work/fake:$PATH" FAKE_JSON=$tcp port_in "$work")" = 8080 ]
# Port 0, in any spelling, is no fixed port: Docker picks one then.
for nothing in 0 000; do
  rm -f "$FAKE_COUNT"
  [ -z "$(PATH="$work/fake:$PATH" FAKE_PUBLISHED=$nothing port_in "$work")" ] || {
    printf 'FEHLER: der Port %s galt als fester Port\n' "$nothing"
    exit 1
  }
done
# A Compose that names one missing value at a time is asked until it names
# none.
rm -f "$FAKE_COUNT"
[ "$(PATH="$work/fake:$PATH" FAKE_MISSING='ERSTER_WERT ZWEITER_WERT' FAKE_PUBLISHED=8080 port_in "$work")" = 8080 ] || {
  echo 'FEHLER: mit zwei fehlenden Werten, einzeln gemeldet, kam kein Port'
  exit 1
}
elsewhere='{
  "services": {
    "app": {
      "ports": [
        {
          "mode": "ingress",
          "target": 23700,
          "published": "8080",
          "protocol": "tcp"
        }
      ],
      "x-metadata": {
        "target": 1
      }
    }
  },
  "x-ports": {
    "ports": [
      {
        "target": 2
      }
    ]
  }
}'
rm -f "$FAKE_COUNT"
[ "$(PATH="$work/fake:$PATH" FAKE_JSON=$elsewhere port_in "$work")" = 8080 ] || {
  echo 'FEHLER: ein Ziel außerhalb der Ports eines Dienstes zählte als Zuordnung'
  exit 1
}
check 'Port der Adresse: nur aus der Zuordnung, ohne führende Nullen'

# 9f. The question in a terminal: Enter takes the address with the port
# Docker Compose publishes, a port browsers refuse is not offered at all, the
# end of the input takes nothing, and neither does a port that changed while
# the question waited. Needs the script of util-linux, which the CI has.
if script -q -e -c true /dev/null > /dev/null 2>&1; then
  rm -f "$work/.env" "$FAKE_COUNT"
  printf '\n' | PATH="$work/fake:$PATH" FAKE_PUBLISHED=08080 script -q -e -c "sh '$work/setup.sh'" /dev/null > "$work/asked.txt" 2>&1
  grep -q 'Leer lassen für http://localhost:8080' "$work/asked.txt"
  grep -qxF 'TRUSTED_ORIGINS=http://localhost:8080' "$work/.env"
  # Every case that ends early leaves the address of the template as it was.
  untouched() {
    [ "$(grep -c '^TRUSTED_ORIGINS=' "$work/.env")" = 1 ] &&
      grep -qxF "$(grep '^TRUSTED_ORIGINS=' "$work/.env.example")" "$work/.env" || {
      printf 'FEHLER: %s, und in der .env stand danach eine andere Adresse\n' "$1"
      grep '^TRUSTED_ORIGINS' "$work/.env"
      exit 1
    }
  }
  # The end of the input instead of a line (Ctrl+D) takes nothing.
  rm -f "$work/.env" "$FAKE_COUNT"
  if printf '' | PATH="$work/fake:$PATH" FAKE_PUBLISHED=8080 script -q -e -c "sh '$work/setup.sh'" /dev/null > "$work/asked.txt" 2>&1; then
    echo 'FEHLER: das Ende der Eingabe nahm die vorgeschlagene Adresse'
    exit 1
  fi
  grep -q 'blieb ohne Antwort' "$work/asked.txt"
  untouched 'das Ende der Eingabe'
  rm -f "$work/.env" "$FAKE_COUNT"
  if printf '\n' | PATH="$work/fake:$PATH" FAKE_PUBLISHED=06000 script -q -e -c "sh '$work/setup.sh'" /dev/null > "$work/asked.txt" 2>&1; then
    echo 'FEHLER: ohne Adresse lief die Einrichtung mit Port 06000 durch'
    exit 1
  fi
  if grep -q 'Leer lassen\|sperren' "$work/asked.txt" ||
    ! grep -q 'Unter welcher Adresse' "$work/asked.txt" ||
    ! grep -q 'fehlt die Adresse' "$work/asked.txt"; then
    echo 'FEHLER: Port 06000 wurde als Adresse angeboten, oder die Rückfrage endete aus einem anderen Grund'
    cat "$work/asked.txt"
    exit 1
  fi
  untouched 'Port 06000'
  # A port that changed while the question waited is not taken.
  rm -f "$work/.env" "$FAKE_COUNT"
  if printf '\n' | PATH="$work/fake:$PATH" FAKE_PUBLISHED=8080 FAKE_LATER=8081 script -q -e -c "sh '$work/setup.sh'" /dev/null > "$work/asked.txt" 2>&1; then
    echo 'FEHLER: ein Port, der sich während der Frage änderte, wurde eingetragen'
    exit 1
  fi
  grep -q 'hat sich während der Frage geändert' "$work/asked.txt"
  untouched 'ein geänderter Port'
  # An address someone put into the .env while the question waited stays.
  rm -f "$work/.env" "$FAKE_COUNT"
  if printf '\n' | PATH="$work/fake:$PATH" FAKE_PUBLISHED=8080 FAKE_OPERATOR=https://werkstatt.example.org \
    FAKE_ENV="$work/.env" script -q -e -c "sh '$work/setup.sh'" /dev/null > "$work/asked.txt" 2>&1; then
    echo 'FEHLER: die Einrichtung überschrieb eine Adresse, die während der Frage eingetragen wurde'
    exit 1
  fi
  grep -q 'inzwischen eine andere Adresse' "$work/asked.txt"
  grep -qxF 'TRUSTED_ORIGINS=https://werkstatt.example.org' "$work/.env"
  [ "$(grep -c '^TRUSTED_ORIGINS=' "$work/.env")" = 1 ]
  check 'Rückfrage im Terminal: Enter nimmt den Port von Docker Compose, sonst nichts'
else
  echo 'Hinweis: ohne "script" bleibt die Rückfrage im Terminal ungeprüft.'
fi
rm -r "$work/fake"

# 10. Another application runs the same script against its own folder
# (opengewerk-haustechnik#14): its name at the start of every line, its prefix
# for its own variables, the address of its own template, and nothing of this
# one's, not even when the variables of this one are set as well.
probe="$work/probe"
mkdir -p "$probe"
cat > "$probe/application.env" <<'APPLICATION'
APPLICATION_NAME='Probewerk'
APPLICATION_PREFIX='PROBEWERK'
APPLICATION_EXAMPLE_ADDRESS='https://probewerk.meinbetrieb.de'
APPLICATION
sed -e 's/OPENGEWERK_/PROBEWERK_/g' \
  -e 's|^TRUSTED_ORIGINS=.*|TRUSTED_ORIGINS=https://probewerk.example.de|' \
  "$source_dir/.env.example" > "$probe/.env.example"

ours=$(sha256sum "$work/.env" | cut -d' ' -f1)
out=$(OPENGEWERK_ADDRESS=http://127.0.0.1:23700 PROBEWERK_ADDRESS=http://127.0.0.1:23900 \
  APPLICATION_DIRECTORY="$probe" sh "$work/setup.sh" < /dev/null 2>&1)
printf '%s\n' "$out"
grep -q '^TRUSTED_ORIGINS=http://127.0.0.1:23900$' "$probe/.env"
grep -Eq '^PROBEWERK_OWNER_PASSWORD=[0-9a-f]{64}$' "$probe/.env"
test "$(sha256sum "$work/.env" | cut -d' ' -f1)" = "$ours"
if printf '%s\n' "$out" | grep -qv '^Probewerk: '; then
  echo 'FEHLER: eine Zeile beginnt nicht mit dem Namen der Anwendung'
  exit 1
fi
if printf '%s' "$out" | grep -q 'OpenGewerk'; then
  echo 'FEHLER: die zweite Anwendung bekommt den Namen der ersten zu lesen'
  exit 1
fi
check 'zweite Anwendung: ihr Name, ihre Adresse aus PROBEWERK_ADDRESS, die .env der ersten unberührt'

# Its own version variable, and only that one, comes out of "latest".
sed 's/^PROBEWERK_VERSION=.*/PROBEWERK_VERSION=latest/' "$probe/.env" > "$probe/.env.old"
mv "$probe/.env.old" "$probe/.env"
out=$(APPLICATION_DIRECTORY="$probe" sh "$work/setup.sh" < /dev/null 2>&1)
grep -qx 'PROBEWERK_VERSION=' "$probe/.env"
printf '%s' "$out" | grep -q 'PROBEWERK_VERSION stand auf latest'
check 'zweite Anwendung: ihre Fassung aus latest geleert'

# The address of the first application is no address for the second.
rm "$probe/.env"
if out=$(OPENGEWERK_ADDRESS=http://127.0.0.1:23700 APPLICATION_DIRECTORY="$probe" sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: die zweite Anwendung nahm die Adresse der ersten'
  exit 1
fi
printf '%s' "$out" | grep -q 'oder PROBEWERK_ADDRESS setzen'
check 'zweite Anwendung: OPENGEWERK_ADDRESS gilt nicht für sie'

# A prefix that is no beginning of a variable, and a folder without names.
printf "APPLICATION_NAME='Probewerk'\nAPPLICATION_PREFIX='probewerk'\n" > "$probe/application.env"
if out=$(PROBEWERK_ADDRESS=http://127.0.0.1:23900 APPLICATION_DIRECTORY="$probe" sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: ein Präfix aus Kleinbuchstaben lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'kein Präfix für Variablen'
rm "$probe/application.env"
if out=$(APPLICATION_DIRECTORY="$probe" sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: ohne application.env lief das Skript durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'fehlt application.env'
check 'zweite Anwendung: falsches Präfix und fehlende Namen abgelehnt'

# 11. The .env in a form this script reads the way Docker Compose does
# (#996). "export", blanks around the =, a value in quotes over several lines
# or with a backslash in it, a name twice and TRUSTED_ORIGINS with more than
# addresses and commas stop the run with the number of the line, never with a
# value; the line with the value GEHEIM-1 is where it would show. The file
# stays as it was to the byte, also when its last line has no line end.
for case in export blanks blank_after vtab_after nbsp_after quotes escaped after_quote comment_glued bom twice origins_quoted origins_variable origins_comment version_variable version_tab; do
  rm -f "$work/.env"
  OPENGEWERK_ADDRESS=https://opengewerk.example.org sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
  case "$case" in
    export)
      printf 'export EXTRA_VALUE=GEHEIM-1\n' >> "$work/.env"
      expected='bitte als NAME=Wert' ;;
    blanks)
      printf 'EXTRA_VALUE = GEHEIM-1\n' >> "$work/.env"
      expected='bitte als NAME=Wert' ;;
    blank_after)
      printf 'EXTRA_VALUE= GEHEIM-1' >> "$work/.env"
      expected='der Wert beginnt mit einem Leerzeichen' ;;
    vtab_after)
      printf 'EXTRA_VALUE=\013"GEHEIM-1\nOTHER_VALUE=more"\n' >> "$work/.env"
      expected='der Wert beginnt mit einem Leerzeichen' ;;
    nbsp_after)
      printf 'EXTRA_VALUE=\302\240"GEHEIM-1\nOTHER_VALUE=more"\n' >> "$work/.env"
      expected='der Wert beginnt mit einem Leerzeichen' ;;
    version_variable)
      sed -i 's|^OPENGEWERK_VERSION=.*|OPENGEWERK_VERSION=${TAG:-GEHEIM-1}|' "$work/.env"
      expected='OPENGEWERK_VERSION bitte nur mit der Fassung' ;;
    version_tab)
      sed -i 's|^OPENGEWERK_VERSION=.*|OPENGEWERK_VERSION=0.8.0\t|' "$work/.env"
      expected='OPENGEWERK_VERSION bitte nur mit der Fassung' ;;
    quotes)
      printf "EXTRA_VALUE='GEHEIM-1\nOTHER_VALUE=more'\n" >> "$work/.env"
      expected='schließt nicht auf dieser Zeile' ;;
    escaped)
      printf '%s\n' 'EXTRA_VALUE="GEHEIM-1\"' 'OTHER_VALUE=more"' >> "$work/.env"
      expected='mit einem \ darin' ;;
    after_quote)
      printf '%s\n' 'EXTRA_VALUE="x" TRUSTED_ORIGINS=https://GEHEIM-1.example.org' >> "$work/.env"
      expected='darf nur ein Kommentar stehen' ;;
    comment_glued)
      printf '%s\n' 'EXTRA_VALUE="x"#GEHEIM-1' >> "$work/.env"
      expected='darf nur ein Kommentar stehen' ;;
    bom)
      { printf '\357\273\277'; cat "$work/.env"; } > "$work/.env.bom"
      mv "$work/.env.bom" "$work/.env"
      printf 'EXTRA_VALUE=GEHEIM-1\n' >> "$work/.env"
      expected='Byte Order Mark' ;;
    twice)
      printf 'TRUSTED_ORIGINS=https://GEHEIM-1.example.org\n' >> "$work/.env"
      expected='TRUSTED_ORIGINS steht ein zweites Mal' ;;
    origins_quoted)
      sed -i 's|^TRUSTED_ORIGINS=.*|TRUSTED_ORIGINS="https://GEHEIM-1.example.org"|' "$work/.env"
      expected='TRUSTED_ORIGINS bitte nur mit den Adressen' ;;
    origins_variable)
      sed -i 's|^TRUSTED_ORIGINS=.*|TRUSTED_ORIGINS=${PUBLIC_ORIGIN:-https://GEHEIM-1.example.org}|' "$work/.env"
      expected='TRUSTED_ORIGINS bitte nur mit den Adressen' ;;
    origins_comment)
      sed -i 's|^TRUSTED_ORIGINS=.*|TRUSTED_ORIGINS=https://GEHEIM-1.example.org # alt|' "$work/.env"
      expected='TRUSTED_ORIGINS bitte nur mit den Adressen' ;;
  esac
  before=$(cksum < "$work/.env")
  if out=$(sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: eine .env mit %s lief durch\n' "$case"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'docker/.env, Zeile [0-9]' || {
    printf 'FEHLER: eine .env mit %s ohne die Nummer der Zeile abgelehnt: %s\n' "$case" "$out"
    exit 1
  }
  printf '%s' "$out" | grep -qF "$expected" || {
    printf 'FEHLER: eine .env mit %s aus einem anderen Grund abgelehnt: %s\n' "$case" "$out"
    exit 1
  }
  if printf '%s' "$out" | grep -q 'GEHEIM-1'; then
    printf 'FEHLER: die Meldung zu %s nannte einen Wert\n' "$case"
    exit 1
  fi
  [ "$(cksum < "$work/.env")" = "$before" ] || {
    printf 'FEHLER: eine .env mit %s wurde trotzdem geändert\n' "$case"
    exit 1
  }
done
check '.env: export, Leerzeichen um das =, Wert ohne ASCII am Anfang, über mehrere Zeilen oder mit \ in Anführungszeichen, doppelter Name, TRUSTED_ORIGINS mit mehr als Adressen und $ in der Fassung halten an, ohne Wert'

# A NUL byte, which the shell drops from a line and Compose keeps, stops the
# run as well, and the file stays as it was.
rm -f "$work/.env"
OPENGEWERK_ADDRESS=https://opengewerk.example.org sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
printf 'EXTRA_VALUE=0.8.0\000GEHEIM-1\n' >> "$work/.env"
before=$(cksum < "$work/.env")
if out=$(sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine .env mit einem Nullbyte lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'Nullbyte' || {
  printf 'FEHLER: eine .env mit einem Nullbyte aus einem anderen Grund abgelehnt: %s\n' "$out"
  exit 1
}
[ "$(cksum < "$work/.env")" = "$before" ] || {
  echo 'FEHLER: eine .env mit einem Nullbyte wurde trotzdem geändert'
  exit 1
}
check '.env: ein Nullbyte hält an, die Datei bleibt'

# A carriage return from Windows is read away, comments after blanks stay, and
# another value may stand in quotes with a comment after it; the example
# address with a carriage return is the example address all the same.
rm -f "$work/.env"
sh "$work/setup.sh" < /dev/null > /dev/null 2>&1 || true
sed -e 's/$/\r/' "$work/.env" > "$work/.env.windows"
printf '   # eingerückter Kommentar\r\n' >> "$work/.env.windows"
printf '%s\r\n' 'EXTRA_VALUE="mit Leerzeichen" # Sicherung unter C:\Backup' >> "$work/.env.windows"
mv "$work/.env.windows" "$work/.env"
OPENGEWERK_ADDRESS=https://werkstatt.example.org sh "$work/setup.sh" < /dev/null > "$work/out" 2>&1 || {
  echo 'FEHLER: eine .env aus Windows mit Kommentaren und einem Wert in Anführungszeichen wurde abgelehnt'
  cat "$work/out"
  exit 1
}
grep -qxF 'TRUSTED_ORIGINS=https://werkstatt.example.org' "$work/.env"
check '.env: Windows-Zeilenende, Kommentare und andere Werte in Anführungszeichen angenommen'

# An address exported in the environment counts before the .env, as for
# Docker Compose: no question and nothing written; an empty one stops.
rm -f "$work/.env"
TRUSTED_ORIGINS=https://umgebung.example.org sh "$work/setup.sh" < /dev/null > "$work/out" 2>&1 || {
  echo 'FEHLER: eine Adresse aus der Umgebung galt nicht'
  cat "$work/out"
  exit 1
}
grep -qx "$(grep '^TRUSTED_ORIGINS=' "$work/.env.example")" "$work/.env"
if TRUSTED_ORIGINS= OPENGEWERK_ADDRESS=https://werkstatt.example.org sh "$work/setup.sh" < /dev/null > "$work/out" 2>&1; then
  echo 'FEHLER: eine leere Adresse in der Umgebung lief durch'
  exit 1
fi
grep -q 'steht in der Umgebung' "$work/out"
check 'TRUSTED_ORIGINS aus der Umgebung geht der .env vor'

# A list is no answer to the question, and the sentence of the http rule
# quotes the address as it was given, port included.
rm -f "$work/.env"
if out=$(OPENGEWERK_ADDRESS=https://a.example.org,https://b.example.org sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: eine Liste als Adresse lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'keine Liste'
rm -f "$work/.env"
if out=$(OPENGEWERK_ADDRESS=http://example.org:80 sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: http zu einer anderen Maschine lief durch'
  exit 1
fi
printf '%s' "$out" | grep -qF '"http://example.org:80" beginnt mit http://'
check 'Rückfrage: eine Liste abgelehnt, die Meldung zu http nennt die Adresse mit Port'

echo 'alles geprüft'
