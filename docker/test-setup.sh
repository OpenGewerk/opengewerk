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
  'http://[::1]:80 http://[::1]' 'http://localhost:8080 http://localhost:8080' 'http://localhost:080 http://localhost' \
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
  https://opengewerk.example.org:999999 'http://[::1]:x' 'https://[::1]:8443]' 'https://[::1]x'; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'keinen Port aus Ziffern zwischen 0 und 65535'
done
# http to another machine with a port out of range: the first word is about
# https, so that one run says what to change.
rm -f "$work/.env"
if out=$(OPENGEWERK_ADDRESS=http://opengewerk.example.org:65536 sh "$work/setup.sh" < /dev/null 2>&1); then
  echo 'FEHLER: http mit einem Port über 65535 lief durch'
  exit 1
fi
printf '%s' "$out" | grep -q 'beginnt mit https://'
for address in 'https://[2001:0db8::1]:443' 'https://[2001:db8::1]' 'http://[fe80::1]:8080'; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  printf '%s' "$out" | grep -q 'Von den IPv6-Adressen nimmt die Rückfrage nur \[::1\]'
done
# The name as a browser writes it: in small letters, and nothing a browser
# would write differently.
for pair in 'https://OpenGewerk.Example.org https://opengewerk.example.org' \
  'http://LOCALHOST:23700 http://localhost:23700' 'https://192.0.2.10 https://192.0.2.10' \
  'https://werk_statt.example.org:8443 https://werk_statt.example.org:8443'; do
  given=${pair% *}
  kept=${pair#* }
  rm -f "$work/.env"
  OPENGEWERK_ADDRESS=$given sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
  grep -qxF "TRUSTED_ORIGINS=$kept" "$work/.env" || {
    printf 'FEHLER: aus %s wurde nicht %s\n' "$given" "$kept"
    exit 1
  }
done
for pair in 'https://bücher.example.org|nicht so, wie ein Browser' 'https://user@example.org|nicht so, wie ein Browser' \
  'https://example.org.|nicht so, wie ein Browser' 'https://example.org?x|nicht so, wie ein Browser' \
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

# 9a. Plain http only on this machine (#984): every other host, and a port
# that is no number, is turned away with a sentence that asks for https; the
# three names of this machine, with and without a port, are taken.
for address in http://opengewerk.example.org http://192.168.1.20:23700 \
  http://localhost.example.org http://localhost:x@example.org http://127.0.0.1: \
  http://localhost:1@example.org:8080 http://localhost:abc:23700 'http://[::1]:1@example.org:80'; do
  rm -f "$work/.env"
  if out=$(OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null 2>&1); then
    printf 'FEHLER: %s lief durch\n' "$address"
    exit 1
  fi
  case "$address" in
    *@* | *:abc:* | *:) printf '%s' "$out" | grep -q 'keinen Port aus Ziffern' ;;
    *) printf '%s' "$out" | grep -q 'beginnt mit https://' ;;
  esac
done
for address in http://localhost http://localhost:23700 http://127.0.0.1 http://[::1] http://[::1]:23700; do
  rm -f "$work/.env"
  OPENGEWERK_ADDRESS=$address sh "$work/setup.sh" < /dev/null > /dev/null 2>&1
  grep -qxF "TRUSTED_ORIGINS=$address" "$work/.env"
done
check 'http:// nur für diese Maschine: andere Adressen abgelehnt, localhost, 127.0.0.1 und [::1] angenommen'

# 9c. The port of the address offered is the one Docker Compose takes: from
# the environment first, else from the last line of the .env that sets it,
# with "export", blanks, quotes, a comment and a carriage return as Compose
# reads them.
sed -n '/^compose_value() {/,/^}/p' "$work/setup.sh" > "$work/compose-value.sh"
test -s "$work/compose-value.sh"
. "$work/compose-value.sh"
value_of() {
  printf '%s\n' "$1" > "$work/port.env"
  compose_value PROBE_PORT "$work/port.env"
}
unset PROBE_PORT
for pair in 'PROBE_PORT=24567|24567' 'PROBE_PORT=24567 # lokal|24567' 'PROBE_PORT="24567"|24567' \
  'PROBE_PORT="24567 # lokal"|24567 # lokal' "PROBE_PORT='24567'|24567" 'export PROBE_PORT=24567|24567' \
  '  PROBE_PORT = 24567|24567' 'PROBE_PORT=24567#x|24567#x' 'PROBE_PORT=|'; do
  line=${pair%%|*}
  expected=${pair#*|}
  got=$(value_of "$line")
  [ "$got" = "$expected" ] || {
    printf 'FEHLER: aus "%s" wurde "%s", nicht "%s"\n' "$line" "$got" "$expected"
    exit 1
  }
done
printf 'PROBE_PORT=24567\r\n' > "$work/port.env"
[ "$(compose_value PROBE_PORT "$work/port.env")" = 24567 ]
printf 'PROBE_PORT=1\nPROBE_PORT=24567\n' > "$work/port.env"
[ "$(compose_value PROBE_PORT "$work/port.env")" = 24567 ]
[ "$(PROBE_PORT=24999 compose_value PROBE_PORT "$work/port.env")" = 24999 ]
[ -z "$(compose_value PROBE_PORT "$work/no-such.env")" ]
check 'Port aus der .env: so gelesen wie von Docker Compose'

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

echo 'alles geprüft'
