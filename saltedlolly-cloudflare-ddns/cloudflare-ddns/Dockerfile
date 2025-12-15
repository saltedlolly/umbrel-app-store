FROM favonia/cloudflare-ddns:1.15.1 AS favonia

# Use an Alpine base with a shell for the wrapper script, and copy the favonia
# ddns binary into it using a multi-stage build. Alpine provides busybox and
# coreutils to support the wrapper's `stat`, `date`, and other utilities.
FROM alpine:3.18

RUN apk add --no-cache coreutils

# Copy the favonia ddns binary from the base image into the Alpine image
COPY --from=favonia /bin/ddns /bin/ddns

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
