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
#   ./build.sh
#     # Defaults: bump patch version, auto-build/push both images, pin digests
#
#   ./build.sh --version 0.0.15
#     # Use explicit version instead of bumping
#
#   ./build.sh --bump minor
#     # Bump minor version instead of patch
#
#   ./build.sh --notes "Upgrade upstream favonia/cloudflare-ddns"
#     # Custom release notes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$SCRIPT_DIR"

# Default repo paths (within the app folder)
UI_REPO="$APP_ROOT/ui"
DDNS_REPO="$APP_ROOT/cloudflare-ddns"

SET_VERSION=""
BUMP_KIND="patch"   # patch|minor|major
RELEASE_NOTES="Publish multi-arch images (linux/arm64 + linux/amd64) for Umbrel Home compatibility"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
APP_YML_FILE="$APP_ROOT/umbrel-app.yml"
LOCAL_TEST=false
PUBLISH_TO_GITHUB=false
UMBREL_DEV_HOST="192.168.215.2"

is_macos=false
if [[ "${OSTYPE:-}" == darwin* ]]; then is_macos=true; fi

usage() {
  cat >&2 <<EOF
Usage: $0 [OPTIONS]

Options:
  -h, --help           : Show this help message
  --version <x.y.z>    : Set explicit version (otherwise auto-bump)
  --bump patch|minor|major : Choose bump type (default: patch)
  --notes <text>       : Custom release notes
  --localtest          : Build and deploy to local umbrel-dev ($UMBREL_DEV_HOST)
  --publish            : Build and push to GitHub (prompts for version and notes if not provided)

Default repo paths (within the app folder):
  UI_REPO:   $UI_REPO
  DDNS_REPO: $DDNS_REPO
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
  # Use [[:space:]] instead of \s for BSD sed (macOS) compatibility
  if $is_macos; then
    sed -E -i '' "s/^(version:[[:space:]]*)\"[0-9]+\.[0-9]+\.[0-9]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  else
    sed -E -i "s/^(version:[[:space:]]*)\"[0-9]+\.[0-9]+\.[0-9]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  fi
}

set_version_in_package_json() {
  local newv="$1"
  local package_json="ui/package.json"
  # Update version in package.json for consistency
  if $is_macos; then
    sed -E -i '' "s/\"version\":[[:space:]]*\"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"${newv}\"/" "$package_json"
  else
    sed -E -i "s/\"version\":[[:space:]]*\"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"${newv}\"/" "$package_json"
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
    --help|-h) usage; exit 0 ;;
    --version) SET_VERSION="$2"; shift 2 ;;
    --bump) BUMP_KIND="$2"; shift 2 ;;
    --notes) RELEASE_NOTES="$2"; shift 2 ;;
    --localtest) LOCAL_TEST=true; shift ;;
    --publish) PUBLISH_TO_GITHUB=true; shift ;;
    *) usage; exit 1 ;;
  esac
done

########################################
# Interactive prompts for --publish mode
########################################
if [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  current_v=$(read_current_version)
  if [[ -z "$current_v" ]]; then
    echo "Error: Could not read current version from $APP_YML_FILE" >&2
    exit 1
  fi
  
  # Prompt for version if not specified
  if [[ -z "$SET_VERSION" ]]; then
    echo "Current version: $current_v"
    echo
    patch_v=$(semver_bump "$current_v" "patch")
    minor_v=$(semver_bump "$current_v" "minor")
    major_v=$(semver_bump "$current_v" "major")
    
    echo "Select version bump:"
    echo "  1) Patch: $patch_v (bug fixes, minor changes)"
    echo "  2) Minor: $minor_v (new features, backwards compatible)"
    echo "  3) Major: $major_v (breaking changes)"
    echo "  4) Cancel"
    echo
    read -p "Enter choice (1-4): " -n 1 -r
    echo
    
    case "$REPLY" in
      1) SET_VERSION="$patch_v"; BUMP_KIND="patch" ;;
      2) SET_VERSION="$minor_v"; BUMP_KIND="minor" ;;
      3) SET_VERSION="$major_v"; BUMP_KIND="major" ;;
      4) echo "Cancelled."; exit 0 ;;
      *) echo "Invalid choice. Cancelled."; exit 1 ;;
    esac
    
    echo "Selected version: $SET_VERSION"
    echo
  fi
  
  # Prompt for release notes if not specified
  if [[ "$RELEASE_NOTES" == "Publish multi-arch images (linux/arm64 + linux/amd64) for Umbrel Home compatibility" ]]; then
    echo "Enter release notes (used for commit message and umbrel-app.yml):"
    read -r RELEASE_NOTES
    
    if [[ -z "$RELEASE_NOTES" ]]; then
      echo "Error: Release notes cannot be empty" >&2
      exit 1
    fi
    
    echo
  fi
fi

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
# Ensure SSO is enabled for production
########################################
echo "Checking Umbrel SSO configuration..."
sso_path=$(grep '^path:' "$APP_YML_FILE" | awk '{print $2}' | tr -d '"')
if [[ "$sso_path" != "" ]]; then
  echo "⚠️  SSO is currently disabled (path: '$sso_path')"
  echo "✓ Re-enabling Umbrel SSO for production build (path: \"\")"
  if $is_macos; then
    sed -i '' 's/^path:.*/path: ""/' "$APP_YML_FILE"
  else
    sed -i 's/^path:.*/path: ""/' "$APP_YML_FILE"
  fi
else
  echo "✓ SSO already enabled (path: \"\")"
fi
echo

########################################
# Update umbrel-app.yml and package.json
########################################
echo "Updating umbrel-app.yml version..."
set_version_in_app_yml "$target_v"

# Only update release notes for non-localtest builds (mainly --publish)
if [[ "$LOCAL_TEST" != "true" ]]; then
  echo "Updating release notes..."
  prepend_release_notes "$target_v" "$RELEASE_NOTES"
fi

echo "Updating package.json version..."
set_version_in_package_json "$target_v"

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
  --build-arg VERSION="${target_v}" \
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

########################################
# Local test deployment
########################################
if [[ "$LOCAL_TEST" == "true" ]]; then
  echo "========================================" 
  echo "LOCAL TEST DEPLOYMENT"
  echo "========================================"
  echo
  
  APP_ID="saltedlolly-cloudflare-ddns"
  UMBREL_USER="umbrel"
  
  echo "Deploying to umbrel-dev at $UMBREL_DEV_HOST..."
  echo
  
  # Check if we can reach umbrel-dev
  if ! ssh -o ConnectTimeout=5 "$UMBREL_USER@$UMBREL_DEV_HOST" "echo 'Connection successful'" > /dev/null 2>&1; then
    echo "❌ Error: Cannot connect to umbrel-dev at $UMBREL_DEV_HOST"
    echo "   Please check:"
    echo "   - umbrel-dev is running"
    echo "   - IP address is correct (currently: $UMBREL_DEV_HOST)"
    echo "   - SSH is accessible"
    exit 1
  fi
  
  echo "✓ Connected to umbrel-dev"
  echo
  
  # Check if app is currently installed
  echo "Checking if app is currently installed..."
  if ssh "$UMBREL_USER@$UMBREL_DEV_HOST" "test -d ~/umbrel/app-data/$APP_ID"; then
    echo "⚠️  App is currently installed on umbrel-dev"
    echo
    echo "You need to uninstall it first. You can:"
    echo "  1. Uninstall via Web UI (right-click app icon → Uninstall)"
    echo "  2. Uninstall via SSH: ssh $UMBREL_USER@$UMBREL_DEV_HOST 'umbreld client apps.uninstall.mutate --appId $APP_ID'"
    echo
    read -p "Has the app been uninstalled? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Please uninstall the app and run this script again with --localtest"
      exit 1
    fi
  fi
  
  # Copy app files to umbrel-dev  
  echo "Copying app files to umbrel-dev..."
  
  # Find the existing app store directory
  EXISTING_STORE=$(ssh "$UMBREL_USER@$UMBREL_DEV_HOST" "ls -1 /home/umbrel/umbrel/app-stores/ | grep 'getumbrel-umbrel-apps-github' | head -1")
  
  if [[ -z "$EXISTING_STORE" ]]; then
    echo "❌ Error: Could not find existing app store directory"
    exit 1
  fi
  
  echo "Using app store: $EXISTING_STORE"
  
  # Copy to umbrel-dev using the correct path structure
  rsync -av --exclude=".git" \
            --exclude=".gitignore" \
            --exclude=".gitkeep" \
            --exclude="data" \
            --exclude="tools" \
            --exclude="build.sh" \
            --exclude="ui/node_modules" \
            --exclude="ui/.npm" \
            "$APP_ROOT/" \
            "$UMBREL_USER@$UMBREL_DEV_HOST:/home/umbrel/umbrel/app-stores/$EXISTING_STORE/$APP_ID/"
  
  echo "✓ App files copied"
  echo
  echo "========================================" 
  echo "NEXT STEPS"
  echo "========================================" 
  echo
  echo "The NEW version (v$target_v) is now on umbrel-dev with updated Docker images."
  echo
  echo "⚠️  CRITICAL: Umbrel only reads app files during installation!"
  echo "   You MUST reinstall for changes to take effect."
  echo
  echo "Steps to test:"
  echo
  echo "  1. REINSTALL from App Store:"
  echo "     • Go to App Store → Find 'Cloudflare DDNS Client'"
  echo "     • Click Install"
  echo "     • This will pull the NEW images from Docker Hub"
  echo
  echo "  2. TEST the app:"
  echo "     • Access at: http://$UMBREL_DEV_HOST:4100/"
  echo "     • Version badge should show: v$target_v"
  echo
  echo "Built images on Docker Hub:"
  echo "  • UI:   saltedlolly/cloudflare-ddns-ui:$target_v@$UI_DIGEST"
  echo "  • DDNS: saltedlolly/cloudflare-ddns:$target_v@$DDNS_DIGEST"
  echo
elif [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  echo "========================================" 
  echo "PUBLISHING TO GITHUB"
  echo "========================================" 
  echo
  
  # Commit and push to GitHub
  echo "Committing changes..."
  git add -A
  git commit -m "release: v${target_v} - ${RELEASE_NOTES}"
  
  echo "Pushing to GitHub..."
  git push
  
  echo
  echo "✓ Successfully published v${target_v} to GitHub"
  echo
  echo "Built images on Docker Hub:"
  echo "  • UI:   saltedlolly/cloudflare-ddns-ui:$target_v@$UI_DIGEST"
  echo "  • DDNS: saltedlolly/cloudflare-ddns:$target_v@$DDNS_DIGEST"
  echo
else
  echo "Next steps:"
  echo "  1. Review changes: git diff"
  echo "  2. Commit: git add -A && git commit -m 'chore: bump to v${target_v}, build multi-arch and pin digests'"
  echo "  3. Push: git push"
fi
