#!/usr/bin/env bash
#
# Build script for Audiobookshelf with Network Shares Support
# Builds the network-shares-ui Docker image and updates docker-compose.yml with the new digest
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$SCRIPT_DIR"

# Configuration
UI_REPO="$APP_ROOT/network-shares-ui"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
APP_YML_FILE="$APP_ROOT/umbrel-app.yml"
IMAGE_NAME="saltedlolly/audiobookshelf-network-shares-ui"
ABS_IMAGE="ghcr.io/advplyr/audiobookshelf"
SET_VERSION=""
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
  --version <x.y.z>    : Set explicit version (default: use package.json version)
  --localtest          : Build multi-arch, push to Docker Hub, and deploy to umbrel-dev ($UMBREL_DEV_HOST)
  --publish            : Build multi-arch, push to Docker Hub (for production)

Default paths:
  UI_REPO:      $UI_REPO
  COMPOSE_FILE: $COMPOSE_FILE
EOF
}

ensure_buildx() {
  echo "Setting up Docker buildx for multi-platform builds..."
  
  if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH" >&2
    exit 1
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
  docker buildx use "$container_builder" 2>/dev/null || {
    echo "Error: Could not switch to builder $container_builder" >&2
    exit 1
  }
  
  echo "Bootstrapping builder..."
  docker buildx inspect --bootstrap >/dev/null 2>&1 || {
    echo "Error: Could not bootstrap builder" >&2
    exit 1
  }
  
  echo "Builder is ready."
}

update_compose_digest() {
  local image_prefix="$1" digest="$2"
  
  # Escape special characters in image_prefix for use in regex
  local escaped_prefix=$(echo "$image_prefix" | sed 's/[\/&]/\\&/g')
  
  # Pattern matches either existing digest or placeholder
  local pattern="^([[:space:]]*image:[[:space:]]*${escaped_prefix}@sha256:)[a-f0-9A-Z_]+"
  
  if $is_macos; then
    sed -E -i '' "s|$pattern|\\1${digest#sha256:}|" "$COMPOSE_FILE"
  else
    sed -E -i "s|$pattern|\\1${digest#sha256:}|" "$COMPOSE_FILE"
  fi
}

update_abs_version() {
  echo ""
  echo "========================================="
  echo "Checking Audiobookshelf version"
  echo "========================================="
  
  # Get latest stable release tag from GitHub (not edge/develop)
  echo "Fetching latest stable ABS version from GitHub..."
  local latest_version=$(curl -s https://api.github.com/repos/advplyr/audiobookshelf/releases/latest | grep -o '"tag_name": "v[^"]*' | cut -d'v' -f2)
  
  if [[ -z "$latest_version" ]]; then
    echo "❌ Error: Could not fetch latest version from GitHub" >&2
    exit 1
  fi
  
  echo "Latest stable ABS version: $latest_version"
  
  # Get current version from docker-compose.yml
  local current_version=$(grep "$ABS_IMAGE" "$COMPOSE_FILE" | grep -o ':[0-9]\+\.[0-9]\+\.[0-9]\+' | cut -d':' -f2)
  echo "Current ABS version: $current_version"
  
  if [[ "$current_version" == "$latest_version" ]]; then
    echo "✓ Already on latest stable version"
    # Still need to ensure umbrel-app.yml matches
    local app_yml_version=$(grep '^version:' "$APP_YML_FILE" | awk '{print $2}' | tr -d '"')
    if [[ "$app_yml_version" != "$latest_version" ]]; then
      echo "Updating umbrel-app.yml version to match ABS..."
      if $is_macos; then
        sed -i '' "s/^version: .*/version: \"$latest_version\"/" "$APP_YML_FILE"
      else
        sed -i "s/^version: .*/version: \"$latest_version\"/" "$APP_YML_FILE"
      fi
      echo "✓ Updated umbrel-app.yml version to $latest_version"
    fi
    echo ""
    return
  fi
  
  echo "Updating from $current_version to $latest_version..."
  
  # Fetch digest for latest version
  echo "Fetching digest for ABS $latest_version..."
  local abs_digest=$(docker buildx imagetools inspect "$ABS_IMAGE:$latest_version" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  
  if [[ -z "$abs_digest" ]]; then
    echo "❌ Error: Could not fetch digest for $ABS_IMAGE:$latest_version" >&2
    exit 1
  fi
  
  echo "ABS digest: $abs_digest"
  
  # Update docker-compose.yml with new version and digest
  echo "Updating docker-compose.yml..."
  local escaped_image=$(echo "$ABS_IMAGE" | sed 's/[\/&]/\\&/g')
  local pattern="${escaped_image}:[0-9]\+\.[0-9]\+\.[0-9]\+@sha256:[a-f0-9A-Z]+"
  local replacement="${ABS_IMAGE}:${latest_version}@${abs_digest}"
  
  if $is_macos; then
    sed -i '' "s|${pattern}|${replacement}|" "$COMPOSE_FILE"
  else
    sed -i "s|${pattern}|${replacement}|" "$COMPOSE_FILE"
  fi
  
  echo "✓ Updated docker-compose.yml to ABS $latest_version"
  
  # Update umbrel-app.yml version to match ABS version
  echo "Updating umbrel-app.yml version..."
  if $is_macos; then
    sed -i '' "s/^version: .*/version: \"$latest_version\"/" "$APP_YML_FILE"
  else
    sed -i "s/^version: .*/version: \"$latest_version\"/" "$APP_YML_FILE"
  fi
  
  echo "✓ Updated umbrel-app.yml version to $latest_version"
  echo ""
}

# Update UI version in version.json
update_ui_version() {
  local VERSION_FILE="$UI_REPO/public/version.json"
  
  # Get current ABS version from umbrel-app.yml
  local abs_version=$(grep '^version:' "$APP_YML_FILE" | awk '{print $2}' | tr -d '"')
  
  # Check if version.json exists
  if [[ ! -f "$VERSION_FILE" ]]; then
    echo "Creating version.json..."
    echo "{" > "$VERSION_FILE"
    echo "  \"version\": \"${abs_version}.1\"," >> "$VERSION_FILE"
    echo "  \"absVersion\": \"${abs_version}\"," >> "$VERSION_FILE"
    echo "  \"uiVersion\": 1" >> "$VERSION_FILE"
    echo "}" >> "$VERSION_FILE"
    echo "✓ Created version.json with v${abs_version}.1"
    return
  fi
  
  # Read current version info
  local stored_abs_version=$(grep '"absVersion"' "$VERSION_FILE" | cut -d'"' -f4)
  local ui_version=$(grep '"uiVersion"' "$VERSION_FILE" | cut -d':' -f2 | tr -d ' ,')
  
  # If ABS version changed, reset UI version to 1
  if [[ "$stored_abs_version" != "$abs_version" ]]; then
    ui_version=1
    echo "ABS version changed from $stored_abs_version to $abs_version, resetting UI version to 1"
  else
    # Increment UI version
    ui_version=$((ui_version + 1))
    echo "Incrementing UI version to $ui_version"
  fi
  
  # Update version.json
  echo "{" > "$VERSION_FILE"
  echo "  \"version\": \"${abs_version}.${ui_version}\"," >> "$VERSION_FILE"
  echo "  \"absVersion\": \"${abs_version}\"," >> "$VERSION_FILE"
  echo "  \"uiVersion\": ${ui_version}" >> "$VERSION_FILE"
  echo "}" >> "$VERSION_FILE"
  
  echo "✓ Updated version.json to v${abs_version}.${ui_version}"
  echo ""
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --version)
      SET_VERSION="$2"
      shift 2
      ;;
    --localtest)
      LOCAL_TEST=true
      shift
      ;;
    --publish)
      PUBLISH_TO_GITHUB=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Determine version from umbrel-app.yml (the main app version)
if [[ -z "$SET_VERSION" ]]; then
  SET_VERSION=$(grep '^version:' "$APP_YML_FILE" | sed 's/version: *"\(.*\)"/\1/')
  echo "Using version from umbrel-app.yml: $SET_VERSION"
else
  echo "Using specified version: $SET_VERSION"
fi

# Always check and update ABS version to latest stable release
update_abs_version

# Update UI version (this creates/updates version.json with ABS version + UI build number)
update_ui_version

# Get the full version from version.json for Docker image tagging (e.g., "2.31.0.11")
UI_VERSION=$(node -p "require('$UI_REPO/public/version.json').version")

echo "========================================="
echo "Building Network Shares UI Docker image"
echo "========================================="
echo "Image: $IMAGE_NAME:$UI_VERSION"
# Ensure buildx is set up
ensure_buildx

# Build and push multi-arch image
echo "Building multi-arch image (linux/amd64, linux/arm64)..."
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "$IMAGE_NAME:$UI_VERSION" \
  -t "$IMAGE_NAME:latest" \
  -f "$UI_REPO/Dockerfile" \
  --push \
  "$UI_REPO"

echo ""
echo "Fetching manifest digest..."
UI_DIGEST=$(docker buildx imagetools inspect "$IMAGE_NAME:$UI_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
if [[ -z "$UI_DIGEST" ]]; then
  echo "Error: Failed to obtain image digest" >&2
  exit 1
fi
echo "Image digest: $UI_DIGEST"

# Update docker-compose.yml with new digest
echo ""
echo "Updating docker-compose.yml with new digest..."
update_compose_digest "$IMAGE_NAME" "$UI_DIGEST"

echo ""
echo "✓ Build complete"
echo ""

if $LOCAL_TEST; then
  echo "========================================" 
  echo "LOCAL TEST DEPLOYMENT"
  echo "========================================"
  echo ""
  
  APP_ID="saltedlolly-audiobookshelf"
  UMBREL_USER="umbrel"
  
  echo "Deploying to umbrel-dev at $UMBREL_DEV_HOST..."
  echo ""
  
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
  echo ""
  
  # Check if app is currently installed
  echo "Checking if app is currently installed..."
  if ssh "$UMBREL_USER@$UMBREL_DEV_HOST" "test -d ~/umbrel/app-data/$APP_ID"; then
    echo "⚠️  App is currently installed on umbrel-dev"
    echo ""
    echo "The app must be uninstalled first. You can:"
    echo "  1. Uninstall via Web UI (right-click app icon → Uninstall)"
    echo ""
    read -p "Has the app been uninstalled? (y/N): " -n 1 -r
    echo ""
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
            --exclude=".DS_Store" \
            --exclude="data" \
            --exclude="build.sh" \
            --exclude="network-shares-ui/node_modules" \
            --exclude="network-shares-ui/.npm" \
            "$APP_ROOT/" \
            "$UMBREL_USER@$UMBREL_DEV_HOST:/home/umbrel/umbrel/app-stores/$EXISTING_STORE/$APP_ID/"
  
  echo "✓ App files copied"
  echo ""
  echo "========================================" 
  echo "NEXT STEPS"
  echo "========================================" 
  echo ""
  echo "The NEW version (v$UI_VERSION) is now on umbrel-dev with updated Docker image."
  echo ""
  echo "⚠️  CRITICAL: Umbrel only reads app files during installation!"
  echo "   You MUST reinstall for changes to take effect."
  echo ""
  echo "Steps to test:"
  echo ""
  echo "  1. REINSTALL from App Store:"
  echo "     • Go to App Store → Find 'Audiobookshelf'"
  echo "     • Click Install"
  echo "     • This will pull the NEW image from Docker Hub"
  echo ""
  echo "  2. TEST the app:"
  echo "     • Access at: http://$UMBREL_DEV_HOST/"
  echo "     • Configure network shares via Network Shares UI"
  echo ""
  echo "Built image on Docker Hub:"
  echo "  • $IMAGE_NAME:$UI_VERSION@$UI_DIGEST"
  echo ""
elif $PUBLISH_TO_GITHUB; then
  echo "========================================" 
  echo "PUBLISHING TO GITHUB"
  echo "========================================" 
  echo ""
  
  # Commit and push to GitHub
  echo "Committing changes..."
  git add -A
  git commit -m "release: v${SET_VERSION} - Build and push network-shares-ui multi-arch image"
  
  echo "Pushing to GitHub..."
  git push
  
  echo ""
  echo "✓ Successfully published v${SET_VERSION} to GitHub"
  echo ""
  echo "Built image on Docker Hub:"
  echo "  • $IMAGE_NAME:$UI_VERSION@$UI_DIGEST"
  echo ""
else
  echo "Next steps:"
  echo "  1. Review changes: git diff"
  echo "  2. Test locally: ./build.sh --localtest"
  echo "  3. Publish: ./build.sh --publish"
fi
