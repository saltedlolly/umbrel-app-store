#!/usr/bin/env bash
set -euo pipefail

# Build script for NPMplus Wrapper image
# Wraps the upstream NPMplus image with our entrypoint-wrapper.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NPMPLUS_DIR="$SCRIPT_DIR/npmplus"
IMAGE_NAME="ghcr.io/saltedlolly/npmplus-wrapper"
VERSION="${1:-2026-07-24-r1.01}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <version>

Build and push the NPMplus wrapper image to GHCR.

Arguments:
  version         Version tag (e.g., 2026-07-24-r1.01)

Examples:
  $(basename "$0") 2026-07-24-r1.01

The script will:
1. Ensure Docker buildx is set up for multi-platform builds
2. Build multi-arch wrapper image (linux/amd64, linux/arm64)
3. Push to $IMAGE_NAME:version
4. Display the multi-arch digest for use in docker-compose.yml
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

ensure_buildx() {
  echo "Setting up Docker buildx for multi-platform builds..."

  if ! command -v docker &> /dev/null; then
    fail "Docker is not installed or not in PATH"
  fi

  local container_builder=$(docker buildx ls 2>/dev/null | awk '$2 ~ /docker-container/ && $4 ~ /linux\/amd64/ && $4 ~ /linux\/arm64/ {print $1; exit}')
  container_builder="${container_builder%\*}"

  if [[ -z "$container_builder" ]]; then
    container_builder=$(docker buildx ls 2>/dev/null | awk '$2 ~ /docker-container/ {print $1; exit}')
    container_builder="${container_builder%\*}"

    if [[ -z "$container_builder" ]]; then
      echo "Creating multiarch builder with both amd64 and arm64 support..."
      docker buildx create --driver docker-container --platform linux/amd64,linux/arm64 --name multiarch >/dev/null 2>&1
      container_builder="multiarch"
    else
      echo "Warning: Found docker-container builder but it may not support both amd64 and arm64"
    fi
  fi

  echo "Using buildx builder: $container_builder"
  docker buildx use "$container_builder" 2>/dev/null || fail "Could not switch to builder $container_builder"

  echo "Bootstrapping builder..."
  docker buildx inspect --bootstrap >/dev/null 2>&1 || fail "Could not bootstrap builder"

  echo "Builder is ready."
  echo
}

if [[ "$VERSION" == "-h" ]] || [[ "$VERSION" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$VERSION" ]]; then
  fail "Version argument is required"
fi

require_command docker

echo "========================================="
echo "Building NPMplus Wrapper"
echo "========================================="
echo "Image: $IMAGE_NAME:$VERSION"
echo "Architectures: linux/amd64, linux/arm64"
echo

ensure_buildx

echo "Building and pushing NPMplus wrapper image..."
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "$IMAGE_NAME:$VERSION" \
  --push \
  "$NPMPLUS_DIR"

echo
echo "Image pushed successfully."
echo "Fetching manifest digest..."

DIGEST=$(docker buildx imagetools inspect "$IMAGE_NAME:$VERSION" 2>/dev/null | awk '/^Digest:/ {print $2; exit}')

if [[ ! "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  fail "Could not resolve multi-arch digest"
fi

echo
echo "========================================="
echo "Build Complete"
echo "========================================="
echo "NPMplus wrapper digest: $DIGEST"
echo
echo "Use this in docker-compose.yml:"
echo "  image: $IMAGE_NAME@$DIGEST"
echo
