# Shared by updater.sh and update.sh (#1093), read with "." by both.
#
# The service for updates checks once a day whether the repository of this
# application has published a newer release, and updates only when an
# operator asks for it in the office. The application never talks to Docker:
# it writes its request as a file into a volume only it may write to, and
# reads back what this service writes into a second one only this service
# may write to. Everything that comes in from there, or from GitHub, is held
# to a pattern before it is used, and goes into JSON through jq and never
# through the shell.

umask 022

# The installation, read-only in the service: compose.yaml, application.env
# and the version of the kit. The update itself runs on the installation
# under its path on the machine, see update.sh.
install=${UPDATE_INSTALL:-/srv/install}
status_path=${UPDATE_STATUS_PATH:-/var/lib/opengewerk/update-status}
requests_path=${UPDATE_REQUESTS_PATH:-/var/lib/opengewerk/update-requests}

# The steps of an update as the office shows them, in their order. The office
# names them itself and reads only their number from run.json.
step_backup=0
step_download=1
step_images=2
step_migration=3
step_restart=4
step_check=5

now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

say() {
  printf '%s %s\n' "$(now)" "$*"
}

# JSON from standard input into a file, whole or not at all: the office reads
# these files while they are written, and a half file would read as broken.
write_json() {
  draft=$(mktemp "$1.XXXXXX")
  if ! cat > "$draft" || ! jq -e . "$draft" > /dev/null; then
    rm -f "$draft"
    return 1
  fi
  chmod 644 "$draft"
  mv "$draft" "$1"
}

# Each held to its pattern as a whole: grep alone takes a value of several
# lines when one of them fits.
version_valid() {
  case "$1" in
    '' | *[!0-9.]*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}

id_valid() {
  case "$1" in
    '' | *[!0-9a-f-]*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

# Whether the first version comes after the second.
newer() {
  [ "$1" != "$2" ] &&
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]
}

# One value of application.env, the way the scripts beside it read it: a line
# NAME='value'. Read with sed and not with ".", since nothing of the
# installation runs in this service.
application_value() {
  sed -n "s/^$1='\\([^']*\\)'[[:space:]]*\$/\\1/p" "$install/docker/application.env" | head -n 1
}

# What the installation is called and where its releases come from. Every
# value held to what it may be, since they go into addresses and patterns.
read_application() {
  name=$(application_value APPLICATION_NAME)
  prefix=$(application_value APPLICATION_PREFIX)
  repository=$(application_value APPLICATION_REPOSITORY)
  printf '%s' "$prefix" | grep -Eq '^[A-Z][A-Z0-9_]*$' || return 1
  printf '%s' "$repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || return 1
  [ -n "$name" ] || return 1
  # The kit is named after the repository, opengewerk-1.2.3.tar.gz, and
  # unpacks into a folder of that name.
  kit_name=$(printf '%s' "${repository#*/}" | tr 'A-Z' 'a-z')
}

# The version of the installation: the one its compose.yaml was packed with.
# A checkout has "source" there and builds its images; it is updated with git
# and not from here.
installed_version() {
  sed -n "s/.*${prefix}_VERSION:-\\([^}]*\\)}.*/\\1/p" "$install/docker/compose.yaml" | head -n 1
}

# Whether the images of the kit are named with their digest, as every kit
# since #687 is. Only then does start.sh check their signature.
kit_signed() {
  grep -Eq "^[[:space:]]*image:[[:space:]]*[^[:space:]]+:$1@sha256:[0-9a-f]{64}" "$install/docker/compose.yaml"
}

# Device and inode of compose.yaml, the same through every mount of the same
# folder: how this service sees that the path in the .env is the folder it
# was started from.
identity_of() {
  stat -c '%d:%i' "$1"
}

# This container, its image and where its volumes come from, asked from
# Docker. The update runs in a container of the same image, beside this one
# and not under Compose, so that it outlives the restart of this service.
self=$(hostname)

self_image() {
  docker inspect --format '{{.Image}}' "$self"
}

# The source of a mount of this container: the name of a volume, or the path
# on the machine of a bind mount such as the socket of Docker.
self_mount() {
  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$1\"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}" "$self"
}

# The Compose project of this installation. Two installations on one machine
# each have their own, and each service for updates sees only its own update.
self_project() {
  docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$self"
}

# Whether an update of this installation runs now, in a container of its own.
# Without an answer from Docker it counts as running: nothing starts then.
update_running() {
  running=$(docker ps --quiet --filter "label=opengewerk.update.project=$1") || return 0
  [ -n "$running" ]
}
