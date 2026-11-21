FROM docker.io/zoeyvid/npmplus:2026-11-18-r1@sha256:de97158ec24f463ce2b7fe6bbac58afe0ee9f4e2eb6beed380b9af041b1abcf6

# Copy our entrypoint wrapper
COPY entrypoint-wrapper.sh /entrypoint-wrapper.sh
RUN chmod +x /entrypoint-wrapper.sh

# Override the entrypoint
ENTRYPOINT ["/entrypoint-wrapper.sh"]
