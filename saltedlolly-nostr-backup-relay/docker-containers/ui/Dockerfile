# Build stage
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS builder

WORKDIR /app

# Install dependencies first so they are cached between builds (npm ci installs the exact versions in the lockfile)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# Final image: Caddy serves the built page and proxies the relay and relay proxy
FROM caddy:2.11.7@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e

WORKDIR /app

COPY Caddyfile /etc/caddy/Caddyfile

# Only the built page is needed at runtime
COPY --from=builder /app/build /app/build

# Umbrel's Nostr Relay code is under the PolyForm Noncommercial License 1.0.0, whose terms must go with every copy
COPY LICENSE.md /app/LICENSE.md

# Version set by the build script (the footer reads the running version from the relay proxy)
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version=$APP_VERSION
