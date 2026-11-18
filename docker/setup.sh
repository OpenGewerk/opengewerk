#!/bin/sh
# Prepares the .env next to this script, so that nobody has to fill it in by
# hand.
#
# The first time it copies the template and replaces every placeholder with a
# secret made here, 32 random bytes as hex, and the setup code with a code of
# eight characters somebody can type (#215). Later runs add what a newer
# template brought and leave everything that is set alone, so the script is
# safe to run before every start and every update; `start.sh` does exactly
# that.
#
# The one value it cannot make is the address the instance is reached at. It
# asks for it when somebody is at the terminal, takes it from the variable
# <prefix>_ADDRESS when nobody is, and stops with a sentence otherwise.
#
# What the application is called and how its variables begin come from
# application.env beside the .env (opengewerk-haustechnik#14), with the
# application.env in this folder OPENGEWERK_ADDRESS. The script is the
# foundation's; another application runs it against its own folder by naming
# it in APPLICATION_DIRECTORY.
#
# No secret ever reaches the terminal or a log. Only the names of the values
# that were made are printed; the values are in the .env and nowhere else,
# which is also why the file is readable by its owner only.

set -eu

# The ranges in the patterns of this script are ranges of bytes, whichever
# shell runs it and in whichever locale: bash before 5.0 under en_US.UTF-8,
# the sh of RHEL 8 among them, would read [!!-~] by its order of letters and
# turn away every value that begins with a letter.
LC_ALL=C

here=${APPLICATION_DIRECTORY:-$(cd "$(dirname "$0")" && pwd)}
env_file="$here/.env"
template="$here/.env.example"

if [ ! -f "$here/application.env" ]; then
  printf 'In %s fehlt application.env mit den Namen der Anwendung.\n' "$here" >&2
  exit 1
fi

# shellcheck source=application.env
. "$here/application.env"

say() {
  printf '%s: %s\n' "$APPLICATION_NAME" "$*"
}

fail() {
  printf '%s: %s\n' "$APPLICATION_NAME" "$*" >&2
  exit 1
}

# The prefix goes into the names of variables that are read with eval below,
# so it is held to what a name of a variable may be and nothing more.
case "$APPLICATION_PREFIX" in
  '' | [!A-Z]* | *[!A-Z0-9_]*)
    fail "APPLICATION_PREFIX in application.env ist kein Präfix für Variablen: nur Großbuchstaben, Ziffern und Unterstriche."
    ;;
esac

# 32 random bytes as hex. Hex and not base64: the passwords end up inside
# connection strings, where a "/" or "@" splits the address.
secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  else
    return 1
  fi
}

# Random bytes, as many as asked for, from the same two sources.
random_bytes() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand "$1"
  elif [ -r /dev/urandom ]; then
    dd if=/dev/urandom bs="$1" count=1 2>/dev/null
  else
    return 1
  fi
}

# The code the first run asks for (#215): eight characters as XXXX-XXXX, from
# an alphabet without 0, O, 1, I and L, because somebody reads it off a
# terminal and types it into a browser. tr keeps the random bytes that are in
# the alphabet and drops the rest, and every byte value is as likely as any
# other, so every character of the alphabet is too. 512 bytes leave about 60
# of them, and the length is checked all the same.
setup_code() {
  pool=$(random_bytes 512 | LC_ALL=C tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789')
  code=$(printf '%.8s' "$pool")
  [ "${#code}" -eq 8 ] || return 1
  printf '%.4s-%s\n' "$code" "${code#????}"
}

# The key push messages are signed with (#284): a private key on P-256 as
# PKCS #8 in base64 on one line, not a random string, because a push service
# checks a signature with its public half. Through "pkcs8 -topk8" and not
# straight out of genpkey: asked for DER, genpkey writes an EC key in the older
# SEC1 form. Only openssl makes one here; without it the line stays empty and
# the instance runs without push, rather than not at all.
vapid_key() {
  command -v openssl >/dev/null 2>&1 || return 1
  key=$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 2>/dev/null |
    openssl pkcs8 -topk8 -nocrypt -outform DER 2>/dev/null |
    openssl base64 -A) || return 1
  [ -n "$key" ] || return 1
  printf '%s\n' "$key"
}

# Rewrites the .env through a file next to it and moves that over the old one,
# so that an interrupted run leaves the old file whole rather than half of it.
replace_env() {
  mv "$1" "$env_file"
  chmod 600 "$env_file"
}

[ -f "$template" ] || fail "Die Vorlage $template fehlt. Sie gehört neben application.env in den Ordner docker der Anwendung."

# The address the template carries until the real one is given, read there
# rather than written here a second time.
example_address=$(sed -n 's/^TRUSTED_ORIGINS=//p' "$template" | head -n 1)

umask 077

if [ ! -f "$env_file" ]; then
  cp "$template" "$env_file"
  say "docker/.env aus der Vorlage angelegt."
fi

chmod 600 "$env_file"

# A byte order mark, which some editors on Windows put first, would come
# before the first name or comment for every check below and not for Compose.
if [ "$(head -c 3 "$env_file")" = "$(printf '\357\273\277')" ]; then
  fail "docker/.env, Zeile 1: die Datei beginnt mit einer Byte Order Mark (BOM). Bitte als UTF-8 ohne BOM speichern, in den meisten Editoren unter Kodierung."
fi

# Every assignment in the .env in the form this script finds the way Docker
# Compose finds it (#996): NAME=value with the name at the start of the line,
# and no name twice. Compose takes more, "export", blanks around the =, a
# value in quotes over several lines, the last of two lines with one name,
# and in such a form this script would not see the name, or see another line
# than Compose: an "export SESSION_SECRET=..." got a second line with a new
# secret below it, and Compose took that one. Such a file stops the run with
# the number of the line, and with the name where it is one, never with a
# value, which can be a secret. Blank lines and comments, also after blanks,
# stay as they are, and a carriage return from Windows is read away.
carriage_return=$(printf '\r')
line_number=0
names_seen=' '
while IFS= read -r line || [ -n "$line" ]; do
  line_number=$((line_number + 1))
  line=${line%"$carriage_return"}
  # Empty, or nothing but blanks.
  case "$line" in
    *[!\ \	]*) ;;
    *) continue ;;
  esac
  case "${line#"${line%%[!\ \	]*}"}" in
    \#*) continue ;;
  esac
  case "$line" in
    *=*) name=${line%%=*} ;;
    *) fail "docker/.env, Zeile $line_number: keine Zeile der Form NAME=Wert." ;;
  esac
  case "$name" in
    '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*)
      fail "docker/.env, Zeile $line_number: bitte als NAME=Wert schreiben, ohne export davor und ohne Leerzeichen um das =."
      ;;
  esac
  value=${line#*=}
  # A value begins with a visible character of ASCII, a quote among them.
  # Compose skips blanks there, and not only space and tab: after a no-break
  # space, say, a quote would open a value over several lines for Compose that
  # this check would not see.
  case "$value" in
    [!!-~]*)
      fail "docker/.env, Zeile $line_number ($name): der Wert beginnt mit einem Leerzeichen oder einem Zeichen außerhalb von ASCII. Bitte ohne Leerzeichen nach dem = schreiben, ein anderes Zeichen am Anfang in Anführungszeichen."
      ;;
  esac
  # A value in quotes ends on its line: one that goes on would hide the lines
  # after it from Compose, not from this script. A backslash before a quote
  # keeps it from closing the value, for Compose and not for this check, so a
  # value in quotes has no backslash at all.
  case "$value" in
    \"*) rest=${value#\"} quote='"' ;;
    \'*) rest=${value#\'} quote="'" ;;
    *) rest='' quote='' ;;
  esac
  if [ -n "$quote" ]; then
    case "$rest" in
      *"$quote"*) ;;
      *) fail "docker/.env, Zeile $line_number ($name): das Anführungszeichen am Anfang des Werts schließt nicht auf dieser Zeile. Ein Wert über mehrere Zeilen geht hier nicht." ;;
    esac
    # Up to the first quote of its kind: a backslash right before it would
    # keep it from closing for Compose; one in a comment after it counts not.
    case "${rest%%"$quote"*}" in
      *\\*) fail "docker/.env, Zeile $line_number ($name): ein Wert in Anführungszeichen mit einem \\ darin geht hier nicht." ;;
    esac
    # After the closing quote Compose reads on as if a new line began, so
    # "A=x" B=y sets B as well. Only blanks may follow, and a comment after
    # one of them.
    after=${rest#*"$quote"}
    comment=${after#"${after%%[!\ \	]*}"}
    case "$comment" in
      '') ;;
      \#*) [ "$comment" != "$after" ] || fail "docker/.env, Zeile $line_number ($name): hinter dem schließenden Anführungszeichen darf nur ein Kommentar stehen, mit einem Leerzeichen davor." ;;
      *) fail "docker/.env, Zeile $line_number ($name): hinter dem schließenden Anführungszeichen darf nur ein Kommentar stehen, mit einem Leerzeichen davor." ;;
    esac
  fi
  # TRUSTED_ORIGINS is read here and in start.sh straight from its line. It
  # stands there in the one form whose text is the value Docker Compose takes:
  # addresses and commas, and nothing Compose takes away or fills in, such as
  # quotes, a comment or a ${...}.
  if [ "$name" = TRUSTED_ORIGINS ]; then
    case "$value" in
      *[!]A-Za-z0-9.:/,_[-]*)
        fail "docker/.env, Zeile $line_number: TRUSTED_ORIGINS bitte nur mit den Adressen schreiben, durch Komma getrennt, ohne Anführungszeichen, Leerzeichen, Kommentar oder \$."
        ;;
    esac
  fi
  # The version start.sh reads from its line as well (#1001), taking away a
  # comment, quotes and blanks. What is left of it here, without a comment
  # after a space, the spaces at its end and its quotes, are the characters of
  # a tag and nothing else: a ${...} Compose would fill in, a tab or another
  # blank at the end it would take away, and start.sh would read another
  # version than the one Compose starts.
  if [ "$name" = "${APPLICATION_PREFIX}_VERSION" ]; then
    version=${value%%" #"*}
    version=${version%"${version##*[! ]}"}
    case "$version" in
      \"*\") version=${version#\"} version=${version%\"} ;;
      \'*\') version=${version#\'} version=${version%\'} ;;
    esac
    case "$version" in
      *[!A-Za-z0-9._-]*)
        fail "docker/.env, Zeile $line_number: $name bitte nur mit der Fassung schreiben, etwa 0.8.0, ohne \$ und ohne Tabulator."
        ;;
    esac
  fi
  case "$names_seen" in
    *" $name "*)
      fail "docker/.env, Zeile $line_number: $name steht ein zweites Mal in der Datei. Docker Compose nimmt die letzte dieser Zeilen, mit ihrem Wert läuft die Instanz bisher; bitte nur sie behalten."
      ;;
  esac
  names_seen="$names_seen$name "
done < "$env_file"

# A last line without a line end would swallow the first line appended below.
# Only now, after the checks above, so that a file they stop stays as it was.
if [ -n "$(tail -c 1 "$env_file")" ]; then
  printf '\n' >> "$env_file"
fi

# What a newer template brought: every variable the .env does not have yet,
# with the value from the template. A placeholder among them is made below
# like any other.
added=''

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | \#*) continue ;;
  esac

  name=${line%%=*}

  if ! grep -q "^${name}=" "$env_file"; then
    printf '%s\n' "$line" >> "$env_file"
    added="$added $name"
  fi
done < "$template"

if [ -n "$added" ]; then
  say "Aus der Vorlage übernommen:$added"
fi

# "latest" was the value of OPENGEWERK_VERSION in the template until #155 and
# never named a version. Kept, it would make a release kit build, and a kit
# has no source to build from; empty runs what the kit or the checkout brings.
version_variable="${APPLICATION_PREFIX}_VERSION"

if grep -q "^${version_variable}=latest[[:space:]]*\$" "$env_file"; then
  draft=$(mktemp "$here/.env.XXXXXX")
  trap 'rm -f "$draft"' EXIT
  sed "s/^${version_variable}=latest[[:space:]]*\$/${version_variable}=/" "$env_file" > "$draft"
  replace_env "$draft"
  say "$version_variable stand auf latest, der früheren Vorgabe, und ist jetzt leer: ein Paket läuft damit in seiner Fassung, ein Checkout baut aus dem Quelltext."
fi

# Every placeholder becomes a secret of its own. The loop reads from a file
# and writes to one, with no pipe in between: behind a pipe it would run in a
# subshell, and the list of names would be empty afterwards.
made=''
without_push=''
draft=$(mktemp "$here/.env.XXXXXX")
trap 'rm -f "$draft"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    \#*)
      printf '%s\n' "$line"
      ;;
    SETUP_CODE=bitte-ersetzen*)
      value=$(setup_code) || fail 'Es ließ sich kein Einrichtungscode erzeugen, weder openssl noch /dev/urandom ist verfügbar. docker/.env ist unverändert.'
      printf 'SETUP_CODE=%s\n' "$value"
      made="$made SETUP_CODE"
      ;;
    VAPID_PRIVATE_KEY=bitte-ersetzen*)
      if value=$(vapid_key); then
        printf 'VAPID_PRIVATE_KEY=%s\n' "$value"
        made="$made VAPID_PRIVATE_KEY"
      else
        printf 'VAPID_PRIVATE_KEY=\n'
        without_push=1
      fi
      ;;
    *=bitte-ersetzen*)
      name=${line%%=*}
      value=$(secret) || fail 'Es ließ sich kein Schlüssel erzeugen, weder openssl noch /dev/urandom ist verfügbar. docker/.env ist unverändert.'
      printf '%s=%s\n' "$name" "$value"
      made="$made $name"
      ;;
    *)
      printf '%s\n' "$line"
      ;;
  esac
done < "$env_file" > "$draft"

if [ -n "$made" ] || [ -n "$without_push" ]; then
  replace_env "$draft"

  if [ -n "$made" ]; then
    say "Schlüssel erzeugt und in docker/.env eingetragen:$made"
    say 'Die Werte stehen nur in dieser Datei, und sie gehört in die Sicherung: ohne SESSION_SECRET lassen sich nach dem Rückspielen weder die zweiten Faktoren noch die Passwörter der Mailserver lesen.'
  fi
else
  rm -f "$draft"
  say 'Alle Schlüssel in docker/.env sind gesetzt, es war nichts zu erzeugen.'
fi

if [ -n "$without_push" ]; then
  say "Ohne openssl ließ sich kein Schlüssel für Push-Nachrichten erzeugen. VAPID_PRIVATE_KEY bleibt leer, und $APPLICATION_NAME läuft ohne Push; den Befehl für einen Schlüssel nennt docker/.env.example."
fi

# Plain http only on this machine (#984). Anywhere else the setup code and
# every password would cross the network readable, so an address of another
# host is the one of a reverse proxy with TLS. After a name of this machine
# comes nothing, or a colon and a port of digits and nothing else: in
# http://localhost:1@example.org:8080 the host is example.org. This is the
# early word for the address asked for here; the application holds every
# entry of TRUSTED_ORIGINS to the same rule when it starts, however the value
# reached it.
# $1 is scheme and name, the port is checked on its own below; $2 is the
# address as it was given, which the sentence quotes.
only_here_over_http() {
  case "$1" in
    http://*) ;;
    *) return 0 ;;
  esac

  case "${1#http://}" in
    localhost | 127.0.0.1) return 0 ;;
    *)
      fail "\"$2\" beginnt mit http://. So gingen Einrichtungscode und Passwörter lesbar durchs Netz. Die Adresse beginnt mit https://, davor steht ein Reverse Proxy mit TLS, Vorlagen dafür liegen in docker/proxy/. Nur auf dieser Maschine, mit localhost oder 127.0.0.1, geht http://."
      ;;
  esac
}

# The port Docker Compose publishes the application on, asked from Compose
# itself: the .env, the environment and the variables of Compose count the way
# they count at the start, and nothing here reads the .env for it. A value
# compose.yaml requires and Compose finds missing, such as the address being
# asked for, gets a stand-in for this one question; a value that is set keeps
# it. Prints the port without leading zeros, or nothing when Compose gives no
# answer or maps more than one port, or the one it maps is no TCP port. Read
# from the JSON Compose prints, two blanks to a level: only the "ports" of a
# service count (in "services", three levels in), each mapping there is one
# object with a target, its published port and its protocol.
published_port() {
  # Names and values have no blanks, so each stand-in is one word. Asked
  # again with the stand-ins found so far, since a Compose may name only one
  # missing value at a time; ten rounds at most.
  missing=''
  rounds=0
  while [ "$rounds" -lt 10 ]; do
    # shellcheck disable=SC2086
    found=$(env $missing docker compose -f "$here/compose.yaml" config --format json 2>&1 >/dev/null |
      sed -n 's/.*required variable \([A-Za-z_][A-Za-z0-9_]*\) is missing a value.*/\1=stand-in/p' |
      sort -u | tr '\n' ' ')
    [ -n "$found" ] || break
    missing="$missing$found"
    rounds=$((rounds + 1))
  done
  # shellcheck disable=SC2086
  config=$(env $missing docker compose -f "$here/compose.yaml" config --format json 2>/dev/null) || return 0
  printf '%s\n' "$config" | awk '
    /^  "services": \{$/ { services = 1; next }
    services && /^  \}/ { services = 0; next }
    services && /^      "ports": \[$/ { ports = 1; next }
    ports && /^      \]/ { ports = 0; next }
    ports && /^        \{$/ { entry = 1; target = 0; value = ""; protocol = "tcp"; next }
    entry && /^ *"target": *[0-9]/ { target = 1; next }
    entry && /^ *"published": *"[0-9][0-9]*"/ { value = $0; next }
    entry && /^ *"protocol": *"/ { protocol = $0; sub(/^ *"protocol": *"/, "", protocol); sub(/".*$/, "", protocol); next }
    entry && /^        \}/ {
      entry = 0
      if (target) { mappings++; if (protocol == "tcp") published = value }
      next
    }
    END {
      if (mappings == 1 && published != "") {
        sub(/^ *"published": *"/, "", published)
        sub(/".*$/, "", published)
        # Without leading zeros; 0 is no fixed port, Docker picks one then.
        sub(/^0*/, "", published)
        if (published != "") print published
      }
    }'
}

# Whether a browser opens port $1, digits without leading zeros: ends with 0
# from 1 to 65535, with 1 for a bad port of the Fetch standard, which browsers
# refuse, and with 2 for anything out of range.
browser_opens() {
  case "$1" in
    '' | *[!0-9]*) return 2 ;;
  esac
  if [ "${#1}" -gt 5 ] || [ "$1" -gt 65535 ] || [ "$1" -eq 0 ]; then
    return 2
  fi
  case "$1" in
    1 | 7 | 9 | 11 | 13 | 15 | 17 | 19 | 20 | 21 | 22 | 23 | 25 | 37 | 42 | 43 | 53 | 69 | 77 | 79 | 87 | 95 | \
      101 | 102 | 103 | 104 | 109 | 110 | 111 | 113 | 115 | 117 | 119 | 123 | 135 | 137 | 139 | 143 | 161 | \
      179 | 389 | 427 | 465 | 512 | 513 | 514 | 515 | 526 | 530 | 531 | 532 | 540 | 548 | 554 | 556 | 563 | \
      587 | 601 | 636 | 989 | 990 | 993 | 995 | 1719 | 1720 | 1723 | 2049 | 3659 | 4045 | 4190 | 5060 | 5061 | \
      6000 | 6566 | 6665 | 6666 | 6667 | 6668 | 6669 | 6679 | 6697 | 10080) return 1 ;;
  esac
}

# The value of TRUSTED_ORIGINS in the .env, from its one line there, without
# a carriage return from Windows. The checks above hold that line to the
# addresses alone, so this is the value Docker Compose takes; start.sh reads
# it the same way.
origins_in_env_file() {
  sed -n 's/^TRUSTED_ORIGINS=//p' "$env_file" | tr -d '\r'
}

# The address, the one value nothing here can make up, as the instance will
# run with it: from the environment when it is exported there, which Docker
# Compose takes before the .env, else from its one line in the .env.
if printenv TRUSTED_ORIGINS >/dev/null 2>&1; then
  address=$(printenv TRUSTED_ORIGINS)
  address_from_environment=yes
else
  address=$(origins_in_env_file)
  address_from_environment=''
fi

if [ -z "$address" ] || [ "$address" = "$example_address" ]; then
  # An address written into the .env would not count while the environment
  # holds another one.
  if [ -n "$address_from_environment" ]; then
    fail "TRUSTED_ORIGINS steht in der Umgebung und ist leer oder die Beispieladresse. Die Umgebung geht docker/.env vor, deshalb trägt dieses Skript dort nichts ein. Die Variable bitte mit der Adresse setzen oder aus der Umgebung nehmen."
  fi
  address_variable="${APPLICATION_PREFIX}_ADDRESS"
  eval "wanted=\${${address_variable}:-}"

  if [ -z "$wanted" ] && [ -t 0 ]; then
    # Enter takes this machine on the port Docker Compose publishes, when
    # Compose names one and a browser opens it; else one has to be entered.
    port=$(published_port)
    if [ -n "$port" ] && ! browser_opens "$port"; then
      port=''
    fi
    printf '%s: Unter welcher Adresse wird %s im Browser geöffnet?\n' "$APPLICATION_NAME" "$APPLICATION_NAME"
    if [ -n "$port" ]; then
      printf '  Etwa %s. Leer lassen für http://localhost:%s: ' "$APPLICATION_EXAMPLE_ADDRESS" "$port"
      # Only an empty line takes the address offered; the end of the input,
      # Ctrl+D, is no answer and writes nothing.
      if ! read -r wanted; then
        printf '\n'
        fail "Die Frage nach der Adresse blieb ohne Antwort, in docker/.env ist nichts eingetragen. Das Skript noch einmal starten oder $address_variable setzen."
      fi
      if [ -z "$wanted" ]; then
        # Compose is asked once more: a port that changed meanwhile, in the
        # .env or elsewhere, would not be the one the start publishes.
        [ "$(published_port)" = "$port" ] ||
          fail "Der Port, den Docker Compose veröffentlicht, hat sich während der Frage geändert; in docker/.env ist nichts eingetragen. Das Skript bitte noch einmal starten."
        wanted=http://localhost:$port
      fi
    else
      printf '  Etwa %s: ' "$APPLICATION_EXAMPLE_ADDRESS"
      read -r wanted || wanted=''
    fi
  fi

  if [ -z "$wanted" ]; then
    fail "In docker/.env fehlt die Adresse, unter der $APPLICATION_NAME erreichbar ist (TRUSTED_ORIGINS). Das Skript einmal im Terminal starten, dann fragt es danach, oder $address_variable setzen."
  fi

  # Something before the name, a user and a password, is no part of an
  # origin. It is turned away before anything else, without being repeated,
  # so that no sentence below can show a part of it.
  case "$wanted" in
    *@*) fail "Die Adresse hat Angaben vor dem Namen, etwa einen Benutzer oder ein Passwort. Gebraucht wird nur die Adresse, etwa $APPLICATION_EXAMPLE_ADDRESS." ;;
  esac

  # An origin and nothing more: a path or a trailing slash never matches what
  # a browser sends, and the sign in would fail without saying why.
  wanted=${wanted%/}

  # One address, not the list TRUSTED_ORIGINS can hold: a second one is
  # written into the .env by hand.
  case "$wanted" in
    *,*)
      fail "Die Rückfrage nimmt eine einzige Adresse, keine Liste. Weitere Adressen kommen danach von Hand in docker/.env, durch Komma getrennt."
      ;;
  esac

  case "$wanted" in
    http://*/* | https://*/*)
      fail "\"$wanted\" hat einen Pfad. Gebraucht wird nur die Adresse, etwa $APPLICATION_EXAMPLE_ADDRESS."
      ;;
    http://?* | https://?*) ;;
    *)
      fail "\"$wanted\" ist keine Adresse mit http:// oder https:// davor."
      ;;
  esac

  # The port written the way a browser sends it in the origin, which the
  # application compares against: everything after the host is the port, a
  # number from 1 to 65535 without leading zeros, and the port a scheme has
  # anyway is left out. Otherwise the application would not start. A port
  # that browsers refuse to open (the bad ports of the Fetch standard) makes
  # no address either.
  scheme=${wanted%%://*}
  host_and_port=${wanted#*://}
  case "$host_and_port" in
    \[\]*) fail "\"$wanted\" nennt keine Maschine." ;;
    \[*\]*)
      # No IPv6 address: the application is published on 127.0.0.1 only, so
      # [::1] reaches nothing, and any other has more than one way to be
      # written while the application takes only the one a browser sends.
      fail "\"$wanted\": Eine IPv6-Adresse nimmt die Rückfrage nicht. Auf dieser Maschine ist $APPLICATION_NAME unter localhost oder 127.0.0.1 erreichbar, für eine andere Maschine bitte ihren Namen nehmen, etwa $APPLICATION_EXAMPLE_ADDRESS."
      ;;
    \[*) fail "\"$wanted\" nennt keine Maschine." ;;
    *:*) host=${host_and_port%%:*} port=${host_and_port#*:} given=yes ;;
    *) host=$host_and_port port='' given='' ;;
  esac
  case "$host" in
    '') fail "\"$wanted\" nennt keine Maschine." ;;
  esac
  # The name the way a browser writes it in the origin: in small letters and
  # only with what a name in the network holds. A name with umlauts goes in
  # its form with xn--, an IPv4 address only as four plain numbers. Anything
  # else a browser writes differently, and the application would not start.
  case "$host" in
    \[*) ;;
    *)
      host=$(printf '%s' "$host" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')
      case "$host" in
        *.)
          fail "\"$wanted\" hat einen Punkt am Ende des Namens. Ein Browser schickt ihn nur mit, wenn er auch in der Adresszeile steht, und die Anwendung startet mit ihm nicht. Bitte ohne den Punkt."
          ;;
        *[!a-z0-9._-]* | .* | *..*)
          fail "\"$wanted\" nennt die Maschine nicht so, wie ein Browser sie schreibt. Erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich, ein Name mit Umlauten in seiner Form mit xn--."
          ;;
      esac
      # A browser reads a name whose last part is a number, decimal or 0x and
      # hex digits, as an IPv4 address and writes it as four plain numbers.
      last_label=${host##*.}
      case "$last_label" in
        *[!0-9]*)
          case "$last_label" in
            0x*)
              case "${last_label#0x}" in
                *[!0-9a-f]*) numeric='' ;;
                *) numeric=yes ;;
              esac
              ;;
            *) numeric='' ;;
          esac
          ;;
        *) numeric=yes ;;
      esac
      if [ -n "$numeric" ] &&
        ! printf '%s\n' "$host" | grep -Eq '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'; then
        fail "\"$wanted\" ist keine IPv4-Adresse in der Form, die ein Browser schreibt, etwa 192.0.2.10."
      fi
      ;;
  esac
  # Whether http may be, first: it says what else to change, whatever the
  # port is.
  only_here_over_http "$scheme://$host" "$wanted"
  case "$given" in
    yes)
      digits=$(printf '%s' "$port" | sed 's/^0*\(.\)/\1/')
      case "$port" in
        '' | *[!0-9]*) fail "\"$wanted\" hat nach dem Namen der Maschine keinen Port aus Ziffern zwischen 1 und 65535." ;;
      esac
      browser_opens "$digits" || case $? in
        1) fail "\"$wanted\": Port $digits öffnen Browser nicht, sie sperren ihn. Bitte einen anderen Port nehmen." ;;
        *) fail "\"$wanted\" hat nach dem Namen der Maschine keinen Port aus Ziffern zwischen 1 und 65535." ;;
      esac
      case "$scheme:$digits" in
        http:80 | https:443) wanted="$scheme://$host" ;;
        *) wanted="$scheme://$host:$digits" ;;
      esac
      ;;
    *) wanted="$scheme://$host" ;;
  esac

  # The .env as it is now: an address someone put there while the question
  # waited stays, and nothing is written.
  now=$(origins_in_env_file)
  if [ "$now" != "$address" ]; then
    fail "In docker/.env steht inzwischen eine andere Adresse. Die Einrichtung lässt sie, wie sie ist, und trägt nichts ein."
  fi

  draft=$(mktemp "$here/.env.XXXXXX")

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      TRUSTED_ORIGINS=*) printf 'TRUSTED_ORIGINS=%s\n' "$wanted" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$env_file" > "$draft"

  replace_env "$draft"
  say "Adresse eingetragen: $wanted"
fi
