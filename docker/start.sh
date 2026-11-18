#!/bin/sh
# Starts an instance: the first time, every time after, and after an update.
#
# First the engine (#985): Docker Engine 28.3.3 or newer, the context held for
# the whole run, and the same engine from this check to the start, asked again
# before each step that starts containers and right after the migrations.
# Below it nothing is pulled, built or set up, and no .env is made.
#
# Then the .env, through setup.sh: on the first start every secret is made
# and the address asked for, later only what a newer version brought is
# added. No value is printed, only names.
#
# Then the images (#155). In a release kit the version stands in compose.yaml,
# and the signed images of that release are pulled; a checkout of the source
# has "source" there and builds them. A version in the .env wins over both,
# except over a kit that names its images with their digest (#687): that one
# starts its own version, and checks their signature before it pulls them.
#
# Then the migration on its own, and only after it the containers. That is the
# order docs/betrieb.md explains under "Aktualisieren": `docker compose up -d`
# alone replaces the running application before the migration has even
# started, and a migration that fails leaves the instance standing still
# instead of answering on the state before.
#
# What the application is called and how its variables begin come from
# application.env beside the .env (opengewerk-haustechnik#14). The script is
# the foundation's; another application runs it against its own folder by
# naming it in APPLICATION_DIRECTORY, which the setup script beside this one
# reads from the environment as well.

set -eu

scripts=$(cd "$(dirname "$0")" && pwd)
here=${APPLICATION_DIRECTORY:-$scripts}

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

# The prefix goes into the name of a variable that is read with eval below,
# so it is held to what a name of a variable may be and nothing more.
case "$APPLICATION_PREFIX" in
  '' | [!A-Z]* | *[!A-Z0-9_]*)
    fail 'APPLICATION_PREFIX in application.env ist kein Präfix für Variablen: nur Großbuchstaben, Ziffern und Unterstriche.'
    ;;
esac

command -v docker >/dev/null 2>&1 ||
  fail "Docker fehlt auf dieser Maschine. $APPLICATION_NAME läuft in Docker: https://docs.docker.com/engine/install/"

docker compose version >/dev/null 2>&1 ||
  fail 'Docker Compose fehlt. Es gehört zu jeder aktuellen Docker-Installation und heißt "docker compose", ohne Bindestrich.'

# The application is published on 127.0.0.1 only, behind a reverse proxy with
# TLS (#985). Docker before 28.0.0 lets machines on the same network reach such
# a port anyway, and 28.2.0 to 28.3.2 open it again when firewalld reloads
# (CVE-2025-54388): a machine next door would get past the proxy. A version
# that cannot be read as numbers counts as too old.
minimum_docker='28.3.3'

# The engine checked is the one everything below talks to: the context in use
# now, fixed for this run, so that a "docker context use" in another shell
# meanwhile changes nothing. DOCKER_HOST, when set, names the engine already.
# A CLI before 23.0 knows no "context show"; then the version below still
# speaks first, and only one that would do stops for want of a context.
no_context=''
if [ -z "${DOCKER_HOST:-}" ] && [ -z "${DOCKER_CONTEXT:-}" ]; then
  DOCKER_CONTEXT=$(docker context show 2>/dev/null) || DOCKER_CONTEXT=''
  if [ -n "$DOCKER_CONTEXT" ]; then
    export DOCKER_CONTEXT
  else
    unset DOCKER_CONTEXT
    no_context=yes
  fi
fi

# The version of the engine, held against the minimum, and the engine itself
# by its ID. Asked here, again right before each step that starts containers
# and right after the migrations: a context whose endpoint was changed meanwhile, under the same
# name, is caught there, whether the other engine is too old or not, since
# its database never saw the migrations of this run. engine_note is said
# after each sentence once the migrations have run.
engine_note=''
engine_id=''
engine_new_enough() {
# Version and ID from one answer, so that both are of the same engine.
engine=$(docker info --format '{{.ServerVersion}}|{{.ID}}' 2>/dev/null) ||
  fail "Docker antwortet nicht. Läuft der Docker-Dienst, und darf dieser Benutzer ihn ansprechen?$engine_note"
docker_version=${engine%%|*}
case "$engine" in
  *'|'*) current_id=${engine#*|} ;;
  *) current_id='' ;;
esac

docker_too_old=$(printf '%s\n' "$docker_version" | awk -F. -v minimum="$minimum_docker" '
  { original = $0 }
  # The whole of it first: three numbers, and after the third at most what a
  # distribution or a pre-release adds behind a sign. 28.3.3.dev is none.
  original !~ /^[0-9]+\.[0-9]+\.[0-9]+([-+~][0-9A-Za-z.+~-]*)?$/ { print "yes"; exit }
  function number(field) { return field ~ /^[0-9]+$/ ? field + 0 : -1 }
  {
    split(minimum, least, ".")
    # All three parts readable first, then compared: 28.4.dev and 28garbage.4.0
    # are no versions. Only the third may carry what a distribution or a
    # pre-release adds (28.3.3+ds1, 28.3.3-rc.1, 28.3.3~rc1), and only after
    # a sign.
    patch = $3
    sub(/[-+~].*$/, "", patch)
    $3 = patch
    for (i = 1; i <= 3; i++) {
      if (number($i) < 0) { print "yes"; exit }
    }
    for (i = 1; i <= 3; i++) {
      have = number($i)
      if (have != least[i] + 0) { print (have < least[i] + 0 ? "yes" : "no"); exit }
    }
    # The minimum itself, but a pre-release of it (28.3.3-rc.1, or 28.3.3~rc1
    # in a Debian package), comes before the release that has the fix.
    print (original ~ /^[0-9]+\.[0-9]+\.[0-9]+[-~]/ ? "yes" : "no")
    exit
  }')

if [ "$docker_too_old" != 'no' ]; then
  fail "Docker meldet die Fassung \"$docker_version\", $APPLICATION_NAME braucht Docker Engine ab $minimum_docker. Vor 28.0.0 erreichen Rechner im selben Netz Ports, die nur auf 127.0.0.1 veröffentlicht sind, und 28.2.0 bis 28.3.2 öffnen sie nach einem Neuladen von firewalld wieder (CVE-2025-54388); beides führt am Proxy mit TLS vorbei. Docker aktualisieren: https://docs.docker.com/engine/install/$engine_note"
fi

if [ -z "$current_id" ]; then
  fail "Docker nennt keine Kennung seiner Engine (docker info), an der sich prüfen ließe, dass der ganze Lauf mit derselben spricht.$engine_note"
elif [ -z "$engine_id" ]; then
  engine_id=$current_id
elif [ "$current_id" != "$engine_id" ]; then
  fail "Hinter dem Kontext steht jetzt eine andere Engine als zu Beginn dieses Laufs. Auf ihr startet $APPLICATION_NAME nicht, denn ihre Datenbank hat die Migrationen dieses Laufs nicht gesehen.$engine_note"
fi
}
engine_new_enough

if [ -n "$no_context" ]; then
  fail 'Docker nennt keinen Kontext, an dem sich die Engine für diesen Lauf festhalten ließe, obwohl die Engine antwortet. Das kommt von einer Docker-CLI vor 23.0: sie aktualisieren oder die Engine mit DOCKER_CONTEXT oder DOCKER_HOST ausdrücklich wählen.'
fi

sh "$scripts/setup.sh"

compose() {
  docker compose -f "$here/compose.yaml" "$@"
}

# The version that runs, read the way Docker Compose reads it: from the
# environment, else from the .env, else the default in compose.yaml. A value
# edited by hand may carry a comment, quotes or, from Windows, a carriage
# return, none of which belongs to a version.
version_variable="${APPLICATION_PREFIX}_VERSION"
eval "pinned=\${${version_variable}:-}"

if [ -z "$pinned" ]; then
  pinned=$(sed -n "s/^${version_variable}=//p" "$here/.env" | head -n 1 | sed 's/[[:space:]]#.*//' | tr -d "\r\"' ")
fi

shipped=$(sed -n "s/.*${version_variable}:-\([^}]*\)}.*/\1/p" "$here/compose.yaml" | head -n 1)

# The images a kit names with their digest (#687): the release wrote them as
# "<image>:<version>@sha256:..." with kit-images.sh, and only those are this
# application's. The renderer carries a digest as well, under a tag of its own.
signed=$(sed -n "s/^[[:space:]]*image:[[:space:]]*\([^[:space:]]*:${shipped}@sha256:[0-9a-f]\{64\}\).*/\1/p" "$here/compose.yaml" | sort -u)

if [ -n "$signed" ]; then
  # A kit with digests starts its own version and no other, its images being
  # these bytes. A version in the .env is for a checkout.
  if [ -n "$pinned" ] && [ "$pinned" != "$shipped" ]; then
    say "In der .env steht ${version_variable}=${pinned}. Dieses Paket ist die Fassung ${shipped} und nennt seine Abbilder mit Digest, die Zeile gilt nur für einen Checkout und kann weg."
  fi
  version=$shipped
else
  version=${pinned:-$shipped}
fi

# That the images of a kit are the ones the release workflow of this
# application built and signed, keyless through Sigstore (#687). With cosign
# on the machine a signature that does not hold stops the start before
# anything is pulled; without it the start says how to check by hand. COSIGN
# names another cosign than the one on the PATH.
verify_signatures() {
  [ -n "${APPLICATION_REPOSITORY:-}" ] ||
    fail 'In application.env fehlt APPLICATION_REPOSITORY, ohne sie lässt sich die Signatur der Abbilder nicht prüfen.'

  identity="https://github.com/${APPLICATION_REPOSITORY}/.github/workflows/release.yml@refs/tags/v${version}"
  issuer=https://token.actions.githubusercontent.com
  cosign=${COSIGN:-cosign}

  if command -v "$cosign" >/dev/null 2>&1; then
    for image in $signed; do
      if ! answer=$("$cosign" verify --certificate-identity "$identity" --certificate-oidc-issuer "$issuer" "$image" 2>&1); then
        printf '%s\n' "$answer" >&2
        fail "Die Signatur von $image ließ sich nicht bestätigen, das Abbild stammt nicht sicher aus dem Release der Fassung $version. Geholt und gestartet wird nichts, eine laufende Instanz arbeitet unverändert weiter."
      fi
    done
    say 'Die Signaturen der Abbilder sind geprüft.'
  else
    say 'cosign fehlt auf dieser Maschine, die Signaturen der Abbilder sind nicht geprüft. Von Hand, je Abbild:'
    for image in $signed; do
      say "  cosign verify --certificate-identity $identity --certificate-oidc-issuer $issuer $image"
    done
  fi
}

case "$version" in
  '' | latest | source)
    say 'Die Abbilder werden aus dem Quelltext gebaut.'
    # The backup along with the application: the service that backs up every
    # night would otherwise keep the image of the first start.
    compose build migrate backup-schedule ||
      fail 'Die Abbilder ließen sich nicht bauen, der Grund steht darüber. Eine laufende Instanz arbeitet unverändert weiter.'
    ;;
  *)
    export "$version_variable=$version"
    if [ -n "$signed" ]; then
      verify_signatures
    fi
    say "Fassung $version: die signierten Abbilder werden geholt."
    compose pull --policy missing ||
      fail "Die Abbilder der Fassung $version ließen sich nicht holen, der Grund steht darüber. Gebraucht werden eine Verbindung zu ghcr.io und Docker Compose ab 2.22. Eine laufende Instanz arbeitet unverändert weiter."
    ;;
esac

engine_new_enough
say 'Die Datenbank wird eingerichtet oder auf den neuen Stand gebracht.'
compose run --rm migrate ||
  fail 'Die Migration ist gescheitert, der Grund steht darüber. Eine laufende Instanz arbeitet unverändert weiter, die Datenbank steht auf dem Stand davor.'

# Asked again right after the migrations, before the login comes back below:
# an engine swapped meanwhile would get it without having seen them.
engine_note=' Die Datenbank steht schon auf dem neuen Stand; ein neuer Lauf von sh docker/start.sh mit derselben Fassung startet die Dienste, sobald Docker passt.'
engine_new_enough

# After a restore of a backup from an earlier version, restore.sh leaves the
# application locked, with a note on its role, so that it does not work on a
# schema older than itself (#988). The migrations have run now, and the login
# comes back. A role without the note stays as it is: one locked by a restore
# that did not go through waits for the next one.
unlock_after_restore() {
  compose exec -T postgres psql --username postgres --dbname postgres --quiet --no-psqlrc \
    --set ON_ERROR_STOP=1 > /dev/null <<'SQL'
DO $$
BEGIN
  IF pg_catalog.shobj_description(
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'opengewerk_app'), 'pg_authid'
  ) = 'restored, waiting for migrations' THEN
    ALTER ROLE opengewerk_app LOGIN;
    COMMENT ON ROLE opengewerk_app IS NULL;
  END IF;
END
$$;
SQL
}
unlock_after_restore ||
  fail 'Nach dem Zurückspielen ließ sich der Anwendung die Anmeldung nicht zurückgeben, der Grund steht darüber.'

engine_new_enough
say "$APPLICATION_NAME startet."
compose up -d --wait --wait-timeout 300 ||
  fail "$APPLICATION_NAME ist nicht gestartet. Warum, zeigt: docker compose -f docker/compose.yaml logs app"

address=$(grep '^TRUSTED_ORIGINS=' "$here/.env" | head -n 1 | cut -d= -f2- | cut -d, -f1)
say "$APPLICATION_NAME läuft. Im Browser: $address"

# An instance nobody has set up yet asks for the setup code on its first
# screen (#215). Said here is where it is and never what it is: the code
# stands in the .env and nowhere else, not in this output and not in a log.
# Asked from inside the application container, which has node, so that this
# machine needs neither curl nor wget; a question without an answer, as on a
# closed instance, costs the sentence and nothing more.
needed=$(compose exec -T app node -e 'fetch(`http://127.0.0.1:${process.env.PORT}/setup`).then((answer) => answer.json()).then((body) => console.log(body.needed === true), () => console.log(false))' 2>/dev/null | tr -d '\r') || needed=''

if [ "$needed" = true ]; then
  say 'Die Instanz ist noch leer. Die Einrichtung im Browser fragt nach dem Einrichtungscode, er steht in docker/.env unter SETUP_CODE. Am besten gleich einrichten.'
fi
