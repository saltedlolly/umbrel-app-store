#!/usr/bin/env bash
set -euo pipefail

# Build and push multi-arch images for UI and DDNS, then pin compose to new manifest digests.
# Also auto-bump umbrel-app.yml version (unless overridden), tag images to match, and prepend release notes.
#
# Requirements:
# - Docker Buildx with docker-container driver for multi-platform support
# - Logged in to Docker Hub for `saltedlolly/*`
# - macOS (BSD sed) or Linux (GNU sed)
# - Local git repos for UI and DDNS within the app folder
#
# Usage examples:
#   tools/build-and-pin.sh
#     # Defaults: bump patch version, auto-build/push both images, pin digests
#
#   tools/build-and-pin.sh --version 0.0.15
#     # Use explicit version instead of bumping
#
#   tools/build-and-pin.sh --bump minor
#     # Bump minor version instead of patch
#
#   tools/build-and-pin.sh --notes "Upgrade upstream favonia/cloudflare-ddns"
#     # Custom release notes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(dirname "$SCRIPT_DIR")"

# Default repo paths (within the app folder)
UI_REPO="$APP_ROOT/ui"
DDNS_REPO="$APP_ROOT/cloudflare-ddns"

SET_VERSION=""
BUMP_KIND="patch"   # patch|minor|major
RELEASE_NOTES="Publish multi-arch images (linux/arm64 + linux/amd64) for Umbrel Home compatibility"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
APP_YML_FILE="$APP_ROOT/umbrel-app.yml"

is_macos=false
if [[ "${OSTYPE:-}" == darwin* ]]; then is_macos=true; fi

usage() {
  cat >&2 <<EOF
Usage: $0 [--version <x.y.z> | --bump patch|minor|major] [--notes <text>]

Default repo paths (within the app folder):
  UI_REPO:   $UI_REPO
  DDNS_REPO: $DDNS_REPO

Options:
  --version <x.y.z>    : Set explicit version (otherwise auto-bump)
  --bump patch|minor|major : Choose bump type (default: patch)
  --notes <text>       : Custom release notes
EOF
}

semver_bump() {
  local version="$1" kind="$2"
  IFS='.' read -r major minor patch <<<"$version"
  case "$kind" in
    major) major=$((major+1)); minor=0; patch=0 ;;
    minor) minor=$((minor+1)); patch=0 ;;
    patch) patch=$((patch+1)) ;;
    *) echo "Unknown bump kind: $kind" >&2; exit 1 ;;
  esac
  echo "${major}.${minor}.${patch}"
}

read_current_version() {
  # Extract version: "x.y.z" from umbrel-app.yml
  awk -F'"' '/^version:/ {print $2; exit}' "$APP_YML_FILE"
}

set_version_in_app_yml() {
  local newv="$1"
  if $is_macos; then
    sed -E -i '' "s/^(version:\s*)\"[0-9]+\.[0-9]+\.[0-9]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  else
    sed -E -i "s/^(version:\s*)\"[0-9]+\.[0-9]+\.[0-9]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  fi
}

prepend_release_notes() {
  local newv="$1" notes="$2"
  # Insert new section right after the 'releaseNotes: >-' line
  awk -v ver="$newv" -v msg="$notes" '
    BEGIN{inserted=0}
    /^releaseNotes:[[:space:]]*>-/ {
      if (!inserted) {
        print; print "  v" ver ":\n\n  - " msg "\n"; inserted=1; next
      }
    }
    {print}
  ' "$APP_YML_FILE" > "$APP_YML_FILE.tmp"
  mv "$APP_YML_FILE.tmp" "$APP_YML_FILE"
}

ensure_buildx() {
  echo "Setting up Docker buildx for multi-platform builds..."
  
  # Check if docker is available
  if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH" >&2
    exit 1
  fi
  
  # List all builders and find one with docker-container driver and both platforms
  local container_builder=$(docker buildx ls 2>/dev/null | awk '$2 ~ /docker-container/ && $4 ~ /linux\/amd64/ && $4 ~ /linux\/arm64/ {print $1; exit}')
  # Strip trailing '*' that marks the current builder in `docker buildx ls`
  container_builder="${container_builder%\*}"
  
  if [[ -z "$container_builder" ]]; then
    # Try to find any docker-container builder
    container_builder=$(docker buildx ls 2>/dev/null | awk '$2 ~ /docker-container/ {print $1; exit}')
    container_builder="${container_builder%\*}"
    
    if [[ -z "$container_builder" ]]; then
      # Create a new multiarch builder
      echo "Creating multiarch builder with both amd64 and arm64 support..."
      docker buildx create --driver docker-container --platform linux/amd64,linux/arm64 --name multiarch >/dev/null 2>&1
      container_builder="multiarch"
    else
      echo "Warning: Found docker-container builder but it may not support both amd64 and arm64"
    fi
  fi
  
  # Switch to the docker-container builder
  echo "Using buildx builder: $container_builder"
  docker buildx use "$container_builder" 2>/dev/null || {
    echo "Error: Could not switch to builder $container_builder" >&2
    exit 1
  }
  
  # Bootstrap the builder
  echo "Bootstrapping builder..."
  docker buildx inspect --bootstrap >/dev/null 2>&1 || {
    echo "Error: Could not bootstrap builder" >&2
    exit 1
  }
  
  echo "Builder is ready."
}

update_compose_digest() {
  local image_prefix="$1" digest="$2"
  # Use [[:space:]] instead of \s for compatibility with BSD sed (macOS)
  local pattern="^([[:space:]]*image:[[:space:]]*${image_prefix}@sha256:)[a-f0-9]+"
  
  if $is_macos; then
    sed -E -i '' "s|$pattern|\\1${digest#sha256:}|" "$COMPOSE_FILE"
  else
    sed -E -i "s|$pattern|\\1${digest#sha256:}|" "$COMPOSE_FILE"
  fi
}

########################################
# Parse arguments
########################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) SET_VERSION="$2"; shift 2 ;;
    --bump) BUMP_KIND="$2"; shift 2 ;;
    --notes) RELEASE_NOTES="$2"; shift 2 ;;
    *) usage; exit 1 ;;
  esac
done

########################################
# Validate repos exist
########################################
if [[ ! -d "$UI_REPO" ]]; then
  echo "Error: UI repo not found at $UI_REPO" >&2
  exit 1
fi

if [[ ! -d "$DDNS_REPO" ]]; then
  echo "Error: DDNS repo not found at $DDNS_REPO" >&2
  exit 1
fi

########################################
# Determine version
########################################
current_v=$(read_current_version)
if [[ -z "$current_v" ]]; then
  echo "Error: Could not read current version from $APP_YML_FILE" >&2
  exit 1
fi

target_v="$SET_VERSION"
if [[ -z "$target_v" ]]; then
  target_v=$(semver_bump "$current_v" "$BUMP_KIND")
fi

echo "Current app version: $current_v"
echo "Target app version:  $target_v"
echo

########################################
# Update umbrel-app.yml (version + release notes)
########################################
echo "Updating umbrel-app.yml version and release notes..."
set_version_in_app_yml "$target_v"
prepend_release_notes "$target_v" "$RELEASE_NOTES"

########################################
# Buildx setup
########################################
ensure_buildx

########################################
# Build UI multi-arch
########################################
echo "Building UI multi-arch: saltedlolly/cloudflare-ddns-ui:${target_v}"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "saltedlolly/cloudflare-ddns-ui:${target_v}" \
  -f ui/Dockerfile \
  --push "$APP_ROOT"

echo "Fetching UI manifest digest..."
UI_DIGEST=$(docker buildx imagetools inspect "saltedlolly/cloudflare-ddns-ui:${target_v}" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
if [[ -z "$UI_DIGEST" ]]; then
  echo "Error: Failed to obtain UI digest" >&2
  exit 1
fi
echo "UI digest: $UI_DIGEST"

########################################
# Build DDNS multi-arch
########################################
echo
echo "Building DDNS multi-arch: saltedlolly/cloudflare-ddns:${target_v}"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "saltedlolly/cloudflare-ddns:${target_v}" \
  -f cloudflare-ddns/Dockerfile \
  --push "$APP_ROOT"

echo "Fetching DDNS manifest digest..."
DDNS_DIGEST=$(docker buildx imagetools inspect "saltedlolly/cloudflare-ddns:${target_v}" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
if [[ -z "$DDNS_DIGEST" ]]; then
  echo "Error: Failed to obtain DDNS digest" >&2
  exit 1
fi
echo "DDNS digest: $DDNS_DIGEST"

########################################
# Update docker-compose.yml with new digests
########################################
echo
echo "Updating docker-compose.yml with new digests..."
update_compose_digest "saltedlolly/cloudflare-ddns-ui" "$UI_DIGEST"
update_compose_digest "saltedlolly/cloudflare-ddns" "$DDNS_DIGEST"

echo
echo "=== Done ==="
echo "Updated files:"
echo "  - umbrel-app.yml (version: $target_v)"
echo "  - docker-compose.yml (digests pinned)"
echo
echo "Next steps:"
echo "  1. Review changes: git diff"
echo "  2. Commit: git add -A && git commit -m 'chore: bump to v${target_v}, build multi-arch and pin digests'"
echo "  3. Push: git push"
echo "  4. Reinstall app from Umbrel community app store"
