# Pulled from the upstream author's own GHCR copy (identical to Docker Hub)
FROM ghcr.io/favonia/cloudflare-ddns:1.17.1 AS favonia

# Use an Alpine base with a shell for the wrapper script, and copy the favonia
# ddns binary into it using a multi-stage build. Alpine provides busybox and
# coreutils to support the wrapper's `stat`, `date`, and other utilities.
FROM alpine:3.24

# su-exec: the wrapper runs as root (it writes /data) but starts ddns as an
# unprivileged user, since ddns only needs outbound network access
RUN apk add --no-cache coreutils su-exec

# Copy the favonia ddns binary from the base image into the Alpine image
COPY --from=favonia /bin/ddns /bin/ddns

COPY cloudflare-ddns/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
