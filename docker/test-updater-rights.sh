#!/bin/sh
# The request of the office, read by the service for updates (#1093) with the
# rights compose.yaml gives it: root without CAP_CHOWN, a file system that is
# read-only, and a request that belongs to the application. test-updater.sh
# runs with more rights, which update.sh needs, and writes its requests as
# root. Run by the CI after a first container left a request of UID 1000 in
# /r, as
#
#   docker run --rm --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true \
#     --read-only --tmpfs /tmp --volume <volume>:/r:ro --volume "$PWD:/docker:ro" \
#     opengewerk-updater-under-test sh /docker/test-updater-rights.sh
set -eu

. /docker/updater/common.sh

[ "$(stat -c %u /r/request.json)" = 1000 ] || { echo 'FEHLER: der Auftrag gehört nicht der Anwendung'; exit 1; }
copy_request /r/request.json /tmp/request.json || { echo 'FEHLER: der Dienst kann den Auftrag nicht lesen'; exit 1; }
[ "$(stat -c %Y /tmp/request.json)" = "$(stat -c %Y /r/request.json)" ] ||
  { echo 'FEHLER: die Kopie hat nicht die Zeit des Auftrags'; exit 1; }
printf 'check: Auftrag der Anwendung mit den Rechten des Dienstes gelesen, mit seiner Zeit\n'
