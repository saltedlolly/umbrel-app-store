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
RELEASE_NOTES="Update network-shares-ui multi-arch image for Umbrel Home compatibility"
LOCAL_TEST=false
PUBLISH_TO_GITHUB=false
CLEANUP_IMAGES=false
KEEP_IMAGES=10
UMBREL_DEV_HOST="192.168.215.2"

is_macos=false
if [[ "${OSTYPE:-}" == darwin* ]]; then is_macos=true; fi

usage() {
  cat >&2 <<EOF
Usage: $0 [OPTIONS]

Options:
  -h, --help           : Show this help message
  --notes <text>       : Custom release notes (for --publish mode)
  --localtest          : Build multi-arch, push to Docker Hub, and deploy to umbrel-dev ($UMBREL_DEV_HOST)
  --publish            : Build multi-arch, push to Docker Hub (for production)
  --cleanup [N]        : Delete old Docker Hub images, keep last N versions (default: 10)

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
  
  # Use extended regex (-E) so we can use + instead of \+ for one-or-more
  # Escape dots with \. so they match literally not "any character"
  local pattern="ghcr\.io/advplyr/audiobookshelf:[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]+"
  local replacement="${ABS_IMAGE}:${latest_version}@${abs_digest}"
  
  if $is_macos; then
    sed -i '' -E "s|${pattern}|${replacement}|" "$COMPOSE_FILE"
  else
    sed -i -E "s|${pattern}|${replacement}|" "$COMPOSE_FILE"
  fi
  
  echo "✓ Updated docker-compose.yml to ABS $latest_version"
  echo ""
}

# Update UI version in version.json
update_ui_version() {
  local VERSION_FILE="$UI_REPO/public/version.json"
  
  # Get current ABS version from docker-compose.yml (source of truth)
  local abs_version=$(grep "$ABS_IMAGE" "$COMPOSE_FILE" | grep -o ':[0-9]\+\.[0-9]\+\.[0-9]\+' | cut -d':' -f2)
  
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
  
  # Read current ABS version from version.json
  local stored_abs_version=$(grep '"absVersion"' "$VERSION_FILE" | cut -d'"' -f4)
  local ui_version=$(grep '"uiVersion"' "$VERSION_FILE" | cut -d':' -f2 | tr -d ' ,')
  
  # Compare version.json's absVersion with docker-compose.yml's version
  # If ABS version changed (in docker-compose.yml), reset UI version to 1
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

# Update umbrel-app.yml with full version from version.json
update_app_yml_version() {
  local VERSION_FILE="$UI_REPO/public/version.json"
  local full_version=$(node -p "require('$VERSION_FILE').version")
  
  echo "Updating umbrel-app.yml to v$full_version..."
  if $is_macos; then
    sed -i '' "s/^version: .*/version: \"$full_version\"/" "$APP_YML_FILE"
  else
    sed -i "s/^version: .*/version: \"$full_version\"/" "$APP_YML_FILE"
  fi
  echo "✓ Updated umbrel-app.yml version to $full_version"
  echo ""
}

# Cleanup old Docker Hub images
cleanup_docker_hub_images() {
  echo "========================================="
  echo "Docker Hub Image Cleanup"
  echo "========================================="
  echo "Repository: $IMAGE_NAME"
  echo "Keep last: $KEEP_IMAGES images"
  echo ""
  
  local docker_username=""
  local docker_token=""
  
  # Try to get credentials from docker config
  local docker_config="$HOME/.docker/config.json"
  if [[ -f "$docker_config" ]]; then
    # Check if using credential store (macOS keychain, etc.)
    local creds_store=$(grep '"credsStore"' "$docker_config" | cut -d'"' -f4)
    
    if [[ -n "$creds_store" ]]; then
      # Use docker-credential helper to get credentials
      echo "Retrieving credentials from $creds_store..."
      local creds=$(echo "https://index.docker.io/v1/" | docker-credential-"$creds_store" get 2>/dev/null || true)
      if [[ -n "$creds" ]]; then
        docker_username=$(echo "$creds" | grep -o '"Username":"[^"]*' | cut -d'"' -f4)
        docker_token=$(echo "$creds" | grep -o '"Secret":"[^"]*' | cut -d'"' -f4)
        if [[ -n "$docker_username" ]] && [[ -n "$docker_token" ]]; then
          echo "✓ Using Docker credentials from $creds_store"
        fi
      fi
    else
      # Try to extract auth from config.json directly
      local auth=$(grep -A 2 '"https://index.docker.io/v1/"' "$docker_config" 2>/dev/null | grep '"auth"' | cut -d'"' -f4)
      
      if [[ -n "$auth" ]]; then
        # Decode base64 auth (format: username:token)
        local decoded=$(echo "$auth" | base64 -d 2>/dev/null || echo "$auth" | base64 -D 2>/dev/null)
        docker_username=$(echo "$decoded" | cut -d':' -f1)
        docker_token=$(echo "$decoded" | cut -d':' -f2)
        echo "✓ Using Docker credentials from ~/.docker/config.json"
      fi
    fi
  fi
  
  # Fall back to environment variables
  if [[ -z "$docker_username" ]] || [[ -z "$docker_token" ]]; then
    docker_username="${DOCKER_HUB_USERNAME:-}"
    docker_token="${DOCKER_HUB_TOKEN:-}"
    if [[ -n "$docker_username" ]] && [[ -n "$docker_token" ]]; then
      echo "✓ Using Docker credentials from environment variables"
    fi
  fi
  
  # Check if we have credentials
  if [[ -z "$docker_username" ]] || [[ -z "$docker_token" ]]; then
    echo "Error: Docker Hub credentials not found" >&2
    echo "" >&2
    echo "Please either:" >&2
    echo "  1. Run 'docker login' to save credentials, OR" >&2
    echo "  2. Set environment variables:" >&2
    echo "     export DOCKER_HUB_USERNAME='your-username'" >&2
    echo "     export DOCKER_HUB_TOKEN='your-token'" >&2
    echo "" >&2
    echo "To create a token: https://hub.docker.com/settings/security" >&2
    exit 1
  fi
  
  # Extract repository name (e.g., "saltedlolly/audiobookshelf-network-shares-ui" -> "saltedlolly" and "audiobookshelf-network-shares-ui")
  local namespace=$(echo "$IMAGE_NAME" | cut -d'/' -f1)
  local repo=$(echo "$IMAGE_NAME" | cut -d'/' -f2)
  
  echo "Fetching image tags from Docker Hub..."
  
  # Get authentication token
  local auth_token=$(curl -s -H "Content-Type: application/json" \
    -X POST \
    -d "{\"username\": \"$docker_username\", \"password\": \"$docker_token\"}" \
    https://hub.docker.com/v2/users/login/ | grep -o '"token":"[^"]*' | cut -d'"' -f4)
  
  if [[ -z "$auth_token" ]]; then
    echo "Error: Failed to authenticate with Docker Hub" >&2
    exit 1
  fi
  
  # Fetch all tags
  local tags=$(curl -s -H "Authorization: JWT $auth_token" \
    "https://hub.docker.com/v2/repositories/${namespace}/${repo}/tags/?page_size=100" \
    | grep -o '"name":"[^"]*' | cut -d'"' -f4 | sort -V -r)
  
  if [[ -z "$tags" ]]; then
    echo "No tags found or failed to fetch tags" >&2
    exit 1
  fi
  
  local tag_count=$(echo "$tags" | wc -l | tr -d ' ')
  echo "Found $tag_count tags"
  echo ""
  
  if [[ $tag_count -le $KEEP_IMAGES ]]; then
    echo "Only $tag_count tags exist (keeping $KEEP_IMAGES), nothing to delete"
    exit 0
  fi
  
  # Calculate how many to delete
  local delete_count=$((tag_count - KEEP_IMAGES))
  local tags_to_delete=$(echo "$tags" | tail -n "$delete_count")
  
  echo "Tags to keep (newest $KEEP_IMAGES):"
  echo "$tags" | head -n "$KEEP_IMAGES" | sed 's/^/  ✓ /'
  echo ""
  echo "Tags to DELETE ($delete_count):"
  echo "$tags_to_delete" | sed 's/^/  ✗ /'
  echo ""
  
  # Confirm deletion
  read -p "Delete these $delete_count old image(s)? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 0
  fi
  
  echo ""
  echo "Deleting old images..."
  local deleted=0
  
  while IFS= read -r tag; do
    echo -n "  Deleting $tag... "
    local response=$(curl -s -X DELETE \
      -H "Authorization: JWT $auth_token" \
      "https://hub.docker.com/v2/repositories/${namespace}/${repo}/tags/${tag}/")
    
    if [[ "$response" == "" ]]; then
      echo "✓"
      deleted=$((deleted + 1))
    else
      echo "✗ (error: $response)"
    fi
  done <<< "$tags_to_delete"
  
  echo ""
  echo "✓ Deleted $deleted of $delete_count images"
  echo "✓ Kept $KEEP_IMAGES most recent images"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --notes)
      RELEASE_NOTES="$2"
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
    --cleanup)
      CLEANUP_IMAGES=true
      if [[ -n "${2:-}" ]] && [[ "$2" =~ ^[0-9]+$ ]]; then
        KEEP_IMAGES="$2"
        shift 2
      else
        shift
      fi
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# If cleanup mode, run cleanup and exit
if [[ "$CLEANUP_IMAGES" == true ]]; then
  cleanup_docker_hub_images
  exit 0
fi

# Always check and update ABS version to latest stable release
update_abs_version

# Check if network-shares-ui has changes OR if ABS version changed
echo ""
echo "Checking for network-shares-ui changes..."
UI_HAS_CHANGES=false
ABS_VERSION_CHANGED=false

# Check current ABS version from docker-compose.yml
current_abs_version=$(grep "$ABS_IMAGE" "$COMPOSE_FILE" | grep -o ':[0-9]\+\.[0-9]\+\.[0-9]\+' | cut -d':' -f2)

# Check stored ABS version from version.json (if it exists)
if [[ -f "$UI_REPO/public/version.json" ]]; then
  stored_abs_version=$(grep '"absVersion"' "$UI_REPO/public/version.json" | cut -d'"' -f4)
  
  if [[ "$stored_abs_version" != "$current_abs_version" ]]; then
    echo "✓ ABS version changed from $stored_abs_version to $current_abs_version"
    echo "  Will rebuild UI with updated ABS version"
    ABS_VERSION_CHANGED=true
  fi
fi

# Check for uncommitted changes in network-shares-ui directory
if git diff --quiet HEAD -- "$UI_REPO" && git diff --cached --quiet -- "$UI_REPO"; then
  if [[ "$ABS_VERSION_CHANGED" == false ]]; then
    echo "✓ No changes detected in network-shares-ui"
    echo "  Will use existing Docker image"
  fi
else
  echo "✓ Changes detected in network-shares-ui"
  echo "  Will build and push new Docker image"
  UI_HAS_CHANGES=true
fi

# Update UI version if there are code changes OR ABS version changed
if [[ "$UI_HAS_CHANGES" == true ]] || [[ "$ABS_VERSION_CHANGED" == true ]]; then
  update_ui_version
else
  echo ""
  echo "Skipping UI version increment (no code changes)"
  # Ensure version.json exists with current version
  if [[ ! -f "$UI_REPO/public/version.json" ]]; then
    echo "Error: version.json not found, but UI has no changes" >&2
    echo "Run with UI changes to initialize version.json" >&2
    exit 1
  fi
fi

# Update umbrel-app.yml with the full 4-part version
update_app_yml_version

# Get the full version from version.json for everything (e.g., "2.31.0.13")
FULL_VERSION=$(node -p "require('$UI_REPO/public/version.json').version")

# Build if there are UI code changes OR ABS version changed
if [[ "$UI_HAS_CHANGES" == true ]] || [[ "$ABS_VERSION_CHANGED" == true ]]; then
  echo "========================================="
  echo "Building Network Shares UI Docker image"
  echo "========================================="
  echo "Image: $IMAGE_NAME:$FULL_VERSION"
  # Ensure buildx is set up
  ensure_buildx

  # Build and push multi-arch image
  echo "Building multi-arch image (linux/amd64, linux/arm64)..."
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$IMAGE_NAME:$FULL_VERSION" \
    -t "$IMAGE_NAME:latest" \
    -f "$UI_REPO/Dockerfile" \
    --push \
    "$UI_REPO"

  echo ""
  echo "Fetching manifest digest..."
  UI_DIGEST=$(docker buildx imagetools inspect "$IMAGE_NAME:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
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
else
  echo ""
  echo "========================================="
  echo "Using existing Docker image"
  echo "========================================="
  echo "Image: $IMAGE_NAME:$FULL_VERSION"
  echo ""
  echo "Fetching existing manifest digest..."
  UI_DIGEST=$(docker buildx imagetools inspect "$IMAGE_NAME:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$UI_DIGEST" ]]; then
    echo "Error: Failed to find existing image on Docker Hub" >&2
    echo "Image $IMAGE_NAME:$FULL_VERSION does not exist" >&2
    echo "You may need to build with UI changes first" >&2
    exit 1
  fi
  echo "Image digest: $UI_DIGEST"
  
  # Ensure docker-compose.yml has correct digest
  echo ""
  echo "Verifying docker-compose.yml has correct digest..."
  update_compose_digest "$IMAGE_NAME" "$UI_DIGEST"
  
  echo ""
  echo "✓ Using existing image (no rebuild needed)"
fi
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
  echo "The NEW version (v$FULL_VERSION) is now on umbrel-dev with updated Docker image."
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
  echo "  • $IMAGE_NAME:$FULL_VERSION@$UI_DIGEST"
  echo ""
elif $PUBLISH_TO_GITHUB; then
  echo "========================================" 
  echo "PUBLISHING TO GITHUB"
  echo "========================================" 
  echo ""
  
  # Prompt for release notes if using default
  if [[ "$RELEASE_NOTES" == "Update network-shares-ui multi-arch image for Umbrel Home compatibility" ]]; then
    echo "Enter release notes (used for commit message):"
    read -r RELEASE_NOTES
    
    if [[ -z "$RELEASE_NOTES" ]]; then
      echo "Error: Release notes cannot be empty" >&2
      exit 1
    fi
    
    echo ""
  fi
  
  # Commit and push to GitHub
  echo "Committing changes..."
  git add -A
  git commit -m "release: v${FULL_VERSION} - ${RELEASE_NOTES}"
  
  echo "Pushing to GitHub..."
  git push
  
  echo ""
  echo "✓ Successfully published v${FULL_VERSION} to GitHub"
  echo ""
  echo "Built image on Docker Hub:"
  echo "  • $IMAGE_NAME:$FULL_VERSION@$UI_DIGEST"
  echo ""
else
  echo "Next steps:"
  echo "  1. Review changes: git diff"
  echo "  2. Test locally: ./build.sh --localtest"
  echo "  3. Publish: ./build.sh --publish"
fi
