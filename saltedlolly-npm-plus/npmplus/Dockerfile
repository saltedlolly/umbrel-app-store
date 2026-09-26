FROM docker.io/zoeyvid/npmplus:2026-07-24-r1@sha256:f7f6ca26082036ee6387a7da336267fe61f16b1eb8087dd964237238b59479ef

# Copy our entrypoint wrapper
COPY entrypoint-wrapper.sh /entrypoint-wrapper.sh
RUN chmod +x /entrypoint-wrapper.sh

# Override the entrypoint
ENTRYPOINT ["/entrypoint-wrapper.sh"]
