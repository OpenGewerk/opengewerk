#!/bin/sh
# The service for updates (#1093). Runs with every installation and does two
# things: once a day it asks GitHub for the newest release of the
# application, and when an operator asks for an update in the office, it
# starts update.sh in a container of its own, which outlives the restart of
# this service and of the application.
#
# What it writes, into the volume the application reads and may not write:
#
#   available.json  the newest release with its notes, the version of the
#                   installation and whether it can be updated from the
#                   office at all, and why not
#   run.json        the last update that ran, its step and how it ended
#   refusal.json    the last request turned away, and why
#   taken           the ID of the last request taken, so that none is taken
#                   twice
#   alive           when this service last went round, so that the office
#                   sees a service that does not run
#
# What it reads, from the volume the application writes: request.json, the
# request of an operator. It only says "now", with an ID, the version the
# office showed and who asked. The version to update to is never taken from
# it: it has to be the newest release this service found itself, newer than
# the installation, and the request at most ten minutes old, so that a request
# that waited through a stop of this service does not start an update
# nobody expects any more.

set -eu

. "$(dirname "$0")/common.sh"

check_every=${UPDATE_CHECK_INTERVAL:-86400}
retry_after=${UPDATE_RETRY_INTERVAL:-3600}
poll_every=${UPDATE_POLL_INTERVAL:-5}
request_lifetime=${UPDATE_REQUEST_LIFETIME:-600}
directory=${INSTALL_DIRECTORY:-}
status_mount=/var/lib/opengewerk/update-status

temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
# Docker stops this service with TERM; the shell would ignore it as process 1.
trap 'exit 0' TERM INT

project=''
mode=unsupported
reason=docker
installed=''

# Whether this installation can be updated from the office, and if not, why
# not. The office names the reason; here it is a word.
assess() {
  mode=unsupported
  installed=''
  if ! read_application; then
    reason=application
    return
  fi
  installed=$(installed_version)
  if ! version_valid "$installed"; then
    # A checkout of the source: updated with git, and built.
    mode=checkout
    reason=checkout
    installed=''
    return
  fi
  if ! kit_signed "$installed"; then
    reason=unsigned
    return
  fi
  # The path of the installation on the machine, which start.sh writes into
  # the .env on Linux. Without it, as under Docker Desktop on Windows and
  # macOS, the update would mount other folders than Compose does.
  case "$directory" in
    /*) ;;
    *) reason=directory; return ;;
  esac
  case "$directory" in
    *[!A-Za-z0-9/._-]*) reason=directory; return ;;
  esac
  project=$(self_project 2>/dev/null) || project=''
  image=$(self_image 2>/dev/null) || image=''
  if [ -z "$project" ] || [ -z "$image" ]; then
    reason=docker
    return
  fi
  # That the path names the folder this service was started from: the same
  # compose.yaml, seen through a mount of that path.
  probe=$(docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges:true --volume "$directory:$directory:ro" \
    "$image" stat -c '%d:%i' "$directory/docker/compose.yaml" 2>/dev/null) || probe=''
  here=$(identity_of "$install/docker/compose.yaml" 2>/dev/null) || here=''
  if [ -z "$probe" ] || [ "$probe" != "$here" ]; then
    reason=elsewhere
    return
  fi
  mode=ready
  reason=''
}

# available.json anew: what assess found, with the release from the last
# answer of GitHub, or from before when there is none now.
publish() {
  release=$1
  error=$2
  if [ ! -f "$release" ]; then
    release="$status_path/available.json"
    [ -f "$release" ] || printf '{}' > "$temp/empty.json"
    [ -f "$release" ] || release="$temp/empty.json"
  fi
  jq --arg checked "$(now)" --arg mode "$mode" --arg reason "$reason" \
    --arg installed "$installed" --arg error "$error" '
    def text: if type == "string" then . else null end;
    {
      checked_at: $checked,
      mode: $mode,
      reason: (if $reason == "" then null else $reason end),
      installed: (if $installed == "" then null else $installed end),
      latest: (.latest // (.tag_name | text | if . != null and test("^v[0-9]+\\.[0-9]+\\.[0-9]+$") then .[1:] else null end)),
      published_at: ((.published_at | text) // null),
      url: ((.url // .html_url) | text | if . != null and startswith("https://github.com/") then . else null end),
      notes: ((.notes // .body) | text | if . == null then "" else .[0:60000] end),
      error: (if $error == "" then null else $error end)
    }' "$release" | write_json "$status_path/available.json"
}

# The newest release, from the API of GitHub. Drafts and pre-releases are
# never the latest there.
check_release() {
  rm -f "$temp/release.json"
  if ! curl --fail --silent --show-error --location --proto '=https' --max-time 30 \
    --max-filesize 2000000 --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' --user-agent "$kit_name-updater" \
    --output "$temp/release.json" "https://api.github.com/repos/$repository/releases/latest" 2> "$temp/curl.log"; then
    say "GitHub antwortet nicht: $(tail -n 1 "$temp/curl.log")"
    rm -f "$temp/release.json"
    publish none unreachable
    return 1
  fi
  if ! jq -e '(.tag_name | type) == "string" and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' \
    "$temp/release.json" > /dev/null 2>&1; then
    say 'Die Antwort von GitHub nennt keine Fassung der Form v1.2.3.'
    rm -f "$temp/release.json"
    publish none invalid
    return 1
  fi
  publish "$temp/release.json" ''
  say "Neueste Fassung: $(jq -r .latest "$status_path/available.json"), installiert: ${installed:-keine}."
}

# run.json with the fields given merged in, as jq arguments.
record() {
  if [ -f "$status_path/run.json" ]; then
    jq "$@" "$status_path/run.json" | write_json "$status_path/run.json"
  else
    jq -n "$@" | write_json "$status_path/run.json"
  fi
}

# A request turned away, in a file of its own: run.json belongs to the last
# update that ran, and one under way keeps writing to it.
refuse() {
  say "Aktualisierung $id abgelehnt: $1"
  jq -n --arg id "$id" --arg version "$version" --arg by "$by" --arg at "$(now)" --arg reason "$1" '{
    id: $id, version: $version, by: $by, reason: $reason, at: $at
  }' | write_json "$status_path/refusal.json"
}

# The request of the office, once per ID.
take_request() {
  request="$requests_path/request.json"
  [ -f "$request" ] || return 0
  id=$(jq -r 'if (.id | type) == "string" then .id else "" end' "$request" 2>/dev/null) || return 0
  id_valid "$id" || return 0
  taken=$(cat "$status_path/taken" 2>/dev/null) || taken=''
  [ "$id" != "$taken" ] || return 0
  printf '%s\n' "$id" > "$temp/taken"
  mv "$temp/taken" "$status_path/taken"

  version=$(jq -r 'if (.version | type) == "string" then .version else "" end' "$request")
  by=$(jq -r 'if (.by | type) == "string" then .by[0:200] else "" end' "$request")
  age=$(($(date +%s) - $(stat -c %Y "$request")))
  latest=$(jq -r '.latest // ""' "$status_path/available.json" 2>/dev/null) || latest=''

  [ "$age" -le "$request_lifetime" ] || { refuse expired; return 0; }
  [ "$mode" = ready ] || { refuse "$reason"; return 0; }
  version_valid "$version" || { refuse version; return 0; }
  [ "$version" = "$latest" ] || { refuse version; return 0; }
  # The version the instance runs is not always the one of its files: an
  # update that stopped after it unpacked the kit leaves the files of its
  # version, and the instance on the one before or, once somebody started
  # it, on the new one. Docker says which runs. Without an answer, the
  # version the stopped run started from, else the one of the files. From
  # there a new try for the same version goes, or one for a later; never one
  # older than the files, and the run names the version it starts from.
  from=$(running_version "$project")
  if ! version_valid "$from"; then
    from=$installed
    stopped_from=$(jq -r --arg installed "$installed" \
      'if .state == "failed" and .version == $installed then .from // "" else "" end' \
      "$status_path/run.json" 2>/dev/null) || stopped_from=''
    if version_valid "$stopped_from"; then
      from=$stopped_from
    fi
  fi
  if ! newer "$version" "$from" || newer "$installed" "$version"; then
    refuse current
    return 0
  fi
  ! update_running "$project" || { refuse running; return 0; }

  image=$(self_image) || image=''
  socket=$(self_mount /var/run/docker.sock) || socket=''
  volume=$(self_mount "$status_mount") || volume=''
  if [ -z "$image" ] || [ -z "$socket" ] || [ -z "$volume" ]; then
    refuse docker
    return 0
  fi

  jq -n --arg id "$id" --arg version "$version" --arg from "$from" --arg by "$by" --arg at "$(now)" '{
    id: $id, version: $version, from: $from, by: $by, state: "running", reason: null,
    step: 0, started_at: $at, finished_at: null, log: []
  }' | write_json "$status_path/run.json"
  say "Aktualisierung $id von $from auf $version, angestoßen von $by."

  # Beside Compose and not under it: the update replaces this service, and
  # the container that runs it must outlive that. The same image, the
  # installation under its own path, so that every relative path in
  # compose.yaml means in there what it means on the machine. Its root file
  # system read-only like that of every service; of the capabilities of root
  # it keeps three, to write the new version over the files of the
  # installation and hand them back to their owner.
  if ! docker run --detach --rm --name "$project-update-${id%%-*}" \
    --label "opengewerk.update.project=$project" --label "opengewerk.update.id=$id" \
    --log-driver local --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,size=512m \
    --env HOME=/tmp --env "UPDATE_INSTALL=$directory" --env "UPDATE_STATUS_PATH=$status_mount" \
    --volume "$socket:/var/run/docker.sock" --volume "$directory:$directory" \
    --volume "$volume:$status_mount" \
    "$image" update.sh "$id" "$version" > "$temp/run.log" 2>&1; then
    say "Der Lauf ließ sich nicht starten: $(tail -n 1 "$temp/run.log")"
    record --arg at "$(now)" '. + {state: "failed", reason: "docker", finished_at: $at}'
  fi
}

# A run that says it is under way while no container runs it any more, after
# a restart of the machine, say, ended without saying so.
watch_run() {
  [ -f "$status_path/run.json" ] || return 0
  state=$(jq -r '.state // ""' "$status_path/run.json" 2>/dev/null) || return 0
  [ "$state" = running ] || return 0
  started=$(jq -r '.started_at // ""' "$status_path/run.json")
  started_seconds=$(date -d "$started" +%s 2>/dev/null) || started_seconds=0
  [ $(($(date +%s) - started_seconds)) -gt 60 ] || return 0
  if ! update_running "$project"; then
    say 'Der Lauf ist verschwunden, ohne zu Ende zu kommen.'
    # Only while it still says so: a run that ended between the two questions
    # wrote how, and that stays.
    record --arg at "$(now)" \
      'if .state == "running" then . + {state: "failed", reason: "vanished", finished_at: $at} else . end'
  fi
}

assess
say "Dienst für Aktualisierungen gestartet, Modus $mode${reason:+ ($reason)}."
next_check=0
alive_at=0
seen_finish=$(jq -r '.finished_at // ""' "$status_path/run.json" 2>/dev/null) || seen_finish=''
# As many rounds as given, for test-updater.sh; else without end.
rounds=${UPDATE_ROUNDS:-0}

while :; do
  if [ "$rounds" -gt 0 ]; then
    [ "$rounds" -gt 1 ] || poll_every=0
    rounds=$((rounds - 1))
    [ "$rounds" -gt 0 ] || rounds=-1
  elif [ "$rounds" -lt 0 ]; then
    break
  fi
  moment=$(date +%s)
  if [ "$moment" -ge "$next_check" ]; then
    if [ "$mode" = unsupported ] && [ "$reason" = application ]; then
      publish none ''
      next_check=$((moment + check_every))
    elif check_release; then
      next_check=$((moment + check_every))
    else
      next_check=$((moment + retry_after))
    fi
  fi

  take_request
  watch_run

  # A run that ended changes the installation: assessed again, without asking
  # GitHub.
  finish=$(jq -r '.finished_at // ""' "$status_path/run.json" 2>/dev/null) || finish=''
  if [ "$finish" != "$seen_finish" ]; then
    seen_finish=$finish
    assess
    publish none ''
  fi

  if [ $((moment - alive_at)) -ge 60 ]; then
    now > "$temp/alive"
    chmod 644 "$temp/alive"
    mv "$temp/alive" "$status_path/alive"
    alive_at=$moment
  fi

  sleep "$poll_every" &
  wait $! || true
done
