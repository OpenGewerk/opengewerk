# The service for updates (#1093): the Docker CLI with Compose, to start an
# update beside the stack and run start.sh in it, and cosign, to check the
# signature of the kit before anything of it is unpacked. Both bases are
# named by their digest, like every other here.
FROM ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d AS cosign

FROM docker:29.10.0-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d

# curl for GitHub, jq for every file that comes in or goes out, GNU tar for
# the listing of a kit, coreutils for sort -V, stat -c and date -d. And the
# two folders of its volumes, so that a volume created for this service first
# has them as the application needs them: the requests belong to the user of
# the application image, node with ID 1000, and only it writes there.
RUN apk add --no-cache coreutils curl jq tar \
  && mkdir -p /var/lib/opengewerk/update-status /var/lib/opengewerk/update-requests \
  && chown 1000:1000 /var/lib/opengewerk/update-requests

COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign
COPY --chmod=755 common.sh updater.sh update.sh /usr/local/bin/

# The image of docker:cli starts its own entrypoint, which would take the
# command for arguments of docker.
ENTRYPOINT []
CMD ["updater.sh"]
