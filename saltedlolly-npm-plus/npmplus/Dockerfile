FROM docker.io/zoeyvid/npmplus:2026-10-22-r1@sha256:244fbf14f0c8bfb969434bfacba14ba71f8eee9911a2466035e640d64e594178

# Copy our entrypoint wrapper
COPY entrypoint-wrapper.sh /entrypoint-wrapper.sh
RUN chmod +x /entrypoint-wrapper.sh

# Override the entrypoint
ENTRYPOINT ["/entrypoint-wrapper.sh"]
