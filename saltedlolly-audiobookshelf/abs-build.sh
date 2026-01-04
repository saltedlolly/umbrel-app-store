#!/usr/bin/env bash
#
# Build script for Audiobookshelf with Network Shares Support
# Builds the network-shares-ui Docker image and updates docker-compose.yml with the new digest
#
set -euo pipefail
echo "[DEBUG] Current working directory: $(pwd)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$SCRIPT_DIR"

# Configuration
DOCKER_COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
APP_YML_FILE="$APP_ROOT/umbrel-app.yml"

# Images used in docker-compose.yml
CONFIG_TOOL_UI_REPO="$APP_ROOT/docker-containers/abs-network-shares-config-tool"
CONFIG_TOOL_UI_IMAGE_NAME="saltedlolly/abs-network-shares-config-tool"
ABS_MANAGER_REPO="$APP_ROOT/docker-containers/abs-manager"
ABS_MANAGER_IMAGE="saltedlolly/abs-manager"

# Images used in abs-manager to deploy other services
ABS_NETWORK_SHARES_CHECKER_REPO="$APP_ROOT/docker-containers/abs-network-shares-checker"
ABS_NETWORK_SHARES_CHECKER_IMAGE="saltedlolly/abs-network-shares-checker"
ABS_NETWORK_SHARES_CHECKER_TXT_FILE="$APP_ROOT/docker-containers/abs-manager/abs-network-shares-checker-image.txt"
ABS_SERVER_IMAGE="ghcr.io/advplyr/audiobookshelf"
ABS_SERVER_LOCAL_TXT_FILE="$APP_ROOT/docker-containers/abs-manager/abs-server-image.txt"

# Development / publishing options 
RELEASE_NOTES="Update abs-network-shares-config-tool multi-arch image for Umbrel Home compatibility"
LOCAL_TEST=false
PUBLISH_TO_GITHUB=false
CLEANUP_IMAGES=false
KEEP_IMAGES=10
FORCE_BUMP=false
UMBREL_DEV_HOST="192.168.215.2"

is_macos=false
if [[ "${OSTYPE:-}" == darwin* ]]; then is_macos=true; fi

usage() {
  cat >&2 <<EOF
Usage: $0 [OPTIONS]

Options:
  -h, --help           : Show this help message
  --notes <text>       : Custom release notes (for --publish mode)
  --bump               : Force UI version increment (even without code changes)
  --localtest          : Build multi-arch, push to Docker Hub, and deploy to umbrel-dev ($UMBREL_DEV_HOST)
  --publish            : Build multi-arch, push to Docker Hub (for production)
  --cleanup [N]        : Delete old Docker Hub images, keep last N versions (default: 10)

Default paths:
  CONFIG_TOOL_UI_REPO: $CONFIG_TOOL_UI_REPO
  DOCKER_COMPOSE_FILE: $DOCKER_COMPOSE_FILE
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

# Calculate SHA256 hash of all files in a directory (excluding .git, node_modules, etc.)
calculate_dir_hash() {
  local dir="$1"
  
  if [[ ! -d "$dir" ]]; then
    echo ""
    return
  fi
  
  # Find all files, exclude common ignore patterns, sort, and hash contents
  find "$dir" -type f \
    -not -path '*/\.git/*' \
    -not -path '*/\.gitignore' \
    -not -path '*/node_modules/*' \
    -not -path '*/.npm/*' \
    -not -path '*/\.DS_Store' \
    -print0 | sort -z | xargs -0 cat | shasum -a 256 | awk '{print $1}'
}

# Load stored hashes from .build-hashes file
load_build_hashes() {
  local hashes_file="$APP_ROOT/.build-hashes"
  
  if [[ -f "$hashes_file" ]]; then
    cat "$hashes_file"
  else
    echo "{}"
  fi
}

# Save hashes to .build-hashes file
save_build_hashes() {
  local hashes_json="$1"
  local hashes_file="$APP_ROOT/.build-hashes"
  
  echo "$hashes_json" > "$hashes_file"
}

# Check if a docker-containers folder has changes since last build
# Returns 0 (true) if changed, 1 (false) if unchanged
has_docker_container_changed() {
  local container_name="$1"
  local container_dir="$APP_ROOT/docker-containers/$container_name"
  
  if [[ ! -d "$container_dir" ]]; then
    echo "Error: Container directory not found: $container_dir" >&2
    return 1
  fi
  
  # Calculate current hash
  local current_hash=$(calculate_dir_hash "$container_dir")
  
  if [[ -z "$current_hash" ]]; then
    echo "Error: Could not calculate hash for $container_name" >&2
    return 1
  fi
  
  # Load stored hashes
  local stored_hashes=$(load_build_hashes)
  local stored_hash=$(echo "$stored_hashes" | grep -o "\"$container_name\":\"[^\"]*\"" | cut -d'"' -f4)
  
  # Compare hashes
  if [[ "$current_hash" == "$stored_hash" ]]; then
    return 1  # No changes
  else
    return 0  # Has changes
  fi
}

# Update a container's hash in the .build-hashes file
update_container_hash() {
  local container_name="$1"
  local container_dir="$APP_ROOT/docker-containers/$container_name"
  
  if [[ ! -d "$container_dir" ]]; then
    echo "Error: Container directory not found: $container_dir" >&2
    return 1
  fi
  
  # Calculate current hash
  local current_hash=$(calculate_dir_hash "$container_dir")
  
  if [[ -z "$current_hash" ]]; then
    echo "Error: Could not calculate hash for $container_name" >&2
    return 1
  fi
  
  # Load current hashes
  local stored_hashes=$(load_build_hashes)
  
  # Update or add the hash for this container
  if echo "$stored_hashes" | grep -q "\"$container_name\""; then
    # Update existing
    local updated_hashes=$(echo "$stored_hashes" | sed "s/\"$container_name\":\"[^\"]*\"/\"$container_name\":\"$current_hash\"/")
  else
    # Add new (handle empty object case)
    if [[ "$stored_hashes" == "{}" ]]; then
      local updated_hashes="{\"$container_name\":\"$current_hash\"}"
    else
      local updated_hashes=$(echo "$stored_hashes" | sed "s/}/,\"$container_name\":\"$current_hash\"}/")
    fi
  fi
  
  # Save updated hashes
  save_build_hashes "$updated_hashes"
}

update_compose_digest() {
  local image_prefix="$1" digest="$2"

  # Escape special characters in image_prefix for use in regex
  local escaped_prefix=$(echo "$image_prefix" | sed 's/[\/&]/\\&/g')

  # Pattern matches any image line for this image (with or without tag/digest)
  local pattern="^([[:space:]]*image:[[:space:]]*)${escaped_prefix}(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]+)?"
  local replacement="\\1${image_prefix}@${digest}"

  if $is_macos; then
    sed -E -i '' "s|$pattern|$replacement|" "$DOCKER_COMPOSE_FILE"
  else
    sed -E -i "s|$pattern|$replacement|" "$DOCKER_COMPOSE_FILE"
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
  
  # Get current version from abs-server-image.txt (source of truth)
  local current_version=""
  if [[ -f "$ABS_SERVER_LOCAL_TXT_FILE" ]]; then
    current_version=$(grep -o ':[0-9]\+\.[0-9]\+\.[0-9]\+' "$ABS_SERVER_LOCAL_TXT_FILE" | cut -d':' -f2)
    echo "Current ABS version in abs-server-image.txt: $current_version"
  else
    echo "abs-server-image.txt not found, treating as first run."
  fi

  if [[ "$current_version" == "$latest_version" ]]; then
    echo "✓ Already on latest stable version"
    echo ""
    return
  fi

  echo "Updating from $current_version to $latest_version..."

  # Fetch digest for latest version
  echo "Fetching digest for ABS $latest_version..."
  local abs_digest=$(docker buildx imagetools inspect "$ABS_SERVER_IMAGE:$latest_version" 2>/dev/null | grep "^Digest:" | awk '{print $2}')

  if [[ -z "$abs_digest" ]]; then
    echo "❌ Error: Could not fetch digest for $ABS_SERVER_IMAGE:$latest_version" >&2
    exit 1
  fi

  echo "ABS digest: $abs_digest"

  # Write image reference to abs-server-image.txt for abs-manager
  echo "# This file is auto-generated by build.sh and read by abs-manager to determine the Audiobookshelf image to use for abs-server." > "$ABS_SERVER_LOCAL_TXT_FILE"
  echo "# Do not edit manually." >> "$ABS_SERVER_LOCAL_TXT_FILE"
  echo "ghcr.io/advplyr/audiobookshelf:${latest_version}@${abs_digest}" >> "$ABS_SERVER_LOCAL_TXT_FILE"
  echo "✓ Wrote abs-server image reference to abs-manager/abs-server-image.txt"
  echo ""
}

# Update UI version in version.json
update_ui_version() {
  local VERSION_FILE="$CONFIG_TOOL_UI_REPO/public/version.json"
  
  # Get current ABS version from abs-server-image.txt (source of truth)
  local abs_version=""
  if [[ -f "$ABS_SERVER_LOCAL_TXT_FILE" ]]; then
    abs_version=$(grep -o ':[0-9]\+\.[0-9]\+\.[0-9]\+' "$ABS_SERVER_LOCAL_TXT_FILE" | cut -d':' -f2)
  fi
  
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
  local VERSION_FILE="$CONFIG_TOOL_UI_REPO/public/version.json"
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

# Update app store README.md with the app version
update_readme_version() {
  local new_version="$1"
  local README_FILE="$SCRIPT_DIR/../README.md"
  local today
  today=$(date +%F)
  
  if [[ ! -f "$README_FILE" ]]; then
    echo "⚠️  README.md not found at $README_FILE, skipping README update"
    return
  fi
  
  echo "Updating app store README.md version and release date..."
  python3 - "$README_FILE" "$new_version" "$today" <<'PY'
from pathlib import Path
import re
import sys

readme_path = Path(sys.argv[1])
new_version = sys.argv[2]
today = sys.argv[3]

text = readme_path.read_text()

text = re.sub(
    r'(<td nowrap id="saltedlolly-audiobookshelf-version"><code>)v[^<]*(</code></td>)',
    rf"\1v{new_version}\2",
    text,
    count=1,
)

text = re.sub(
    r'id="saltedlolly-audiobookshelf-date">(\d{4}-\d{2}-\d{2})',
    f'id="saltedlolly-audiobookshelf-date">{today}',
    text,
    count=1,
)

readme_path.write_text(text)
PY
  echo "✓ Updated README.md version to v$new_version"
  echo "✓ Updated README.md release date to $today"
  echo ""
}

# Update migrate-library.sh SCRIPT_VERSION to match app version
update_migration_script_version() {
  local new_version="$1"
  local SCRIPT_FILE="$SCRIPT_DIR/tools/migrate-library.sh"

  if [[ ! -f "$SCRIPT_FILE" ]]; then
    echo "⚠️  migrate-library.sh not found at $SCRIPT_FILE, skipping version update"
    return
  fi

  echo "Updating migrate-library.sh SCRIPT_VERSION to v$new_version..."
  if $is_macos; then
    sed -i '' -E "s/^(readonly SCRIPT_VERSION=\")([^\"]+)(\")/\\1$new_version\\3/" "$SCRIPT_FILE"
  else
    sed -i -E "s/^(readonly SCRIPT_VERSION=\")([^\"]+)(\")/\\1$new_version\\3/" "$SCRIPT_FILE"
  fi
  echo "✓ Updated SCRIPT_VERSION to v$new_version"
  echo ""
}

# Cleanup old Docker Hub images
cleanup_docker_hub_images() {
  local image_name="$1"
  
  echo "========================================="
  echo "Docker Hub Image Cleanup"
  echo "========================================="
  echo "Repository: $image_name"
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
  
  # Extract repository name (e.g., "saltedlolly/abs-network-shares-config-tool" -> "saltedlolly" and "abs-network-shares-config-tool")
  local namespace=$(echo "$image_name" | cut -d'/' -f1)
  local repo=$(echo "$image_name" | cut -d'/' -f2)
  
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
    --bump)
      FORCE_BUMP=true
      shift
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

# If cleanup mode, run cleanup for all repositories and exit
if [[ "$CLEANUP_IMAGES" == true ]]; then
  echo "========================================"
  echo "Cleaning up old images from Docker Hub"
  echo "========================================"
  echo "This will clean up old images from all 3 repositories:"
  echo "  1. $CONFIG_TOOL_UI_IMAGE_NAME"
  echo "  2. $ABS_NETWORK_SHARES_CHECKER_IMAGE"
  echo "  3. $ABS_MANAGER_IMAGE"
  echo ""
  
  cleanup_docker_hub_images "$CONFIG_TOOL_UI_IMAGE_NAME"
  echo ""
  echo ""
  cleanup_docker_hub_images "$ABS_NETWORK_SHARES_CHECKER_IMAGE"
  echo ""
  echo ""
  cleanup_docker_hub_images "$ABS_MANAGER_IMAGE"
  
  echo ""
  echo "========================================"
  echo "✓ Cleanup complete for all repositories"
  echo "========================================"
  exit 0
fi

# Always check and update ABS version to latest stable release
update_abs_version

# Check if network-shares-ui has changes OR if ABS version changed
echo ""
echo "Checking for abs-network-shares-config-tool changes..."
echo "[DEBUG] CONFIG_TOOL_UI_REPO: $CONFIG_TOOL_UI_REPO"
echo "[DEBUG] DOCKER_COMPOSE_FILE: $DOCKER_COMPOSE_FILE"
echo "[DEBUG] CONFIG_TOOL_UI_IMAGE_NAME: $CONFIG_TOOL_UI_IMAGE_NAME"
echo "[DEBUG] ABS_NETWORK_SHARES_CHECKER_IMAGE: $ABS_NETWORK_SHARES_CHECKER_IMAGE"
echo "[DEBUG] ABS_SERVER_IMAGE: $ABS_SERVER_IMAGE"
echo "[DEBUG] FORCE_BUMP: $FORCE_BUMP"
echo "[DEBUG] LOCAL_TEST: $LOCAL_TEST"
UI_HAS_CHANGES=false
ABS_VERSION_CHANGED=false
ABS_MANAGER_HAS_CHANGES=false

# Check current ABS version from abs-server-image.txt
current_abs_version=$(grep "$ABS_SERVER_IMAGE" "$ABS_SERVER_LOCAL_TXT_FILE" | grep -o ':[0-9]\+\.[0-9]\+\.[0-9]\+' | cut -d':' -f2)
echo "[DEBUG] current_abs_version from abs-server-image.txt: $current_abs_version"

# Check stored ABS version from version.json (if it exists)
if [[ -f "$CONFIG_TOOL_UI_REPO/public/version.json" ]]; then
  stored_abs_version=$(grep '"absVersion"' "$CONFIG_TOOL_UI_REPO/public/version.json" | cut -d'"' -f4)
  echo "[DEBUG] stored_abs_version from version.json: $stored_abs_version"
  
  if [[ "$stored_abs_version" != "$current_abs_version" ]]; then
    echo "✓ ABS version changed from $stored_abs_version to $current_abs_version"
    echo "  Will rebuild UI with updated ABS version"
    ABS_VERSION_CHANGED=true
    echo "[DEBUG] ABS_VERSION_CHANGED set to true"
  fi
fi

# Check for changes in abs-network-shares-config-tool directory
echo "[DEBUG] Reached change detection, FORCE_BUMP: '$FORCE_BUMP'"
if has_docker_container_changed "abs-network-shares-config-tool"; then
  echo "✓ Changes detected in abs-network-shares-config-tool"
  echo "  Will build and push new Docker image"
  UI_HAS_CHANGES=true
  echo "[DEBUG] UI_HAS_CHANGES set to true due to code changes"
else
  if [[ "$ABS_VERSION_CHANGED" == false ]]; then
    echo "✓ No changes detected in abs-network-shares-config-tool"
    echo "  Will use existing Docker image"
    echo "[DEBUG] No changes detected, UI_HAS_CHANGES: $UI_HAS_CHANGES, ABS_VERSION_CHANGED: $ABS_VERSION_CHANGED"
  fi
fi

# Check for changes in abs-network-shares-checker
echo ""
echo "Checking for abs-network-shares-checker changes..."
CHECKER_HAS_CHANGES=false
if has_docker_container_changed "abs-network-shares-checker"; then
  echo "✓ Changes detected in abs-network-shares-checker"
  echo "  Will build and push new Docker image"
  CHECKER_HAS_CHANGES=true
  echo "[DEBUG] CHECKER_HAS_CHANGES set to true due to code changes"
elif [[ "$ABS_VERSION_CHANGED" == true ]]; then
  echo "✓ ABS version changed, rebuilding checker for compatibility"
  CHECKER_HAS_CHANGES=true
  echo "[DEBUG] CHECKER_HAS_CHANGES set to true due to ABS version change"
else
  echo "✓ No changes detected in abs-network-shares-checker"
  echo "  Will use existing Docker image"
  echo "[DEBUG] No changes detected, CHECKER_HAS_CHANGES: $CHECKER_HAS_CHANGES"
fi

# Check for changes in abs-manager (rebuild if checker changed, server changed, or abs-manager code changed)
echo ""
echo "Checking for abs-manager changes..."
if [[ "$ABS_VERSION_CHANGED" == true ]] || [[ "$CHECKER_HAS_CHANGES" == true ]]; then
  echo "✓ Dependencies changed (checker or ABS version)"
  echo "  Will rebuild abs-manager with updated references"
  ABS_MANAGER_HAS_CHANGES=true
  echo "[DEBUG] ABS_MANAGER_HAS_CHANGES set to true due to dependency changes"
elif has_docker_container_changed "abs-manager"; then
  echo "✓ Changes detected in abs-manager code"
  echo "  Will build and push new abs-manager image"
  ABS_MANAGER_HAS_CHANGES=true
  echo "[DEBUG] ABS_MANAGER_HAS_CHANGES set to true due to code changes"
else
  echo "✓ No changes detected in abs-manager"
  echo "  Will use existing abs-manager image"
  echo "[DEBUG] No abs-manager changes detected"
fi

# Always update UI version when --bump is used OR when there are actual changes
if [[ "$FORCE_BUMP" == true ]] || [[ "$UI_HAS_CHANGES" == true ]] || [[ "$ABS_VERSION_CHANGED" == true ]]; then
  echo "[DEBUG] Calling update_ui_version (FORCE_BUMP: $FORCE_BUMP, UI_HAS_CHANGES: $UI_HAS_CHANGES, ABS_VERSION_CHANGED: $ABS_VERSION_CHANGED)"
  update_ui_version
else
  echo ""
  echo "Skipping UI version increment (no code changes)"
  # Ensure version.json exists with current version
  if [[ ! -f "$CONFIG_TOOL_UI_REPO/public/version.json" ]]; then
    echo "Error: version.json not found, but UI has no changes" >&2
    echo "Run with UI changes to initialize version.json" >&2
    exit 1
  fi
fi

# Update umbrel-app.yml with the full 4-part version
echo "[DEBUG] Calling update_app_yml_version"
update_app_yml_version

# Get the full version from version.json for everything (e.g., "2.31.0.13")
echo "[DEBUG] Reading FULL_VERSION from version.json"
FULL_VERSION=$(node -p "require('$CONFIG_TOOL_UI_REPO/public/version.json').version")
echo "[DEBUG] FULL_VERSION: $FULL_VERSION"

# Update migrate-library.sh script version to match app version
echo "[DEBUG] Calling update_migration_script_version with $FULL_VERSION"
update_migration_script_version "$FULL_VERSION"

# Update app store README.md with the new version and release date
echo "[DEBUG] Calling update_readme_version with $FULL_VERSION"
update_readme_version "$FULL_VERSION"

if [[ "$UI_HAS_CHANGES" == true ]] || [[ "$ABS_VERSION_CHANGED" == true ]]; then
  echo "======================================================"
  echo "Building 'ABS Network Shares Config Tool' Docker image"
  echo "======================================================"
  echo "Image: $CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION"
  # Ensure buildx is set up
  ensure_buildx

  # Build and push multi-arch image for abs-network-shares-config-tool
  echo "Building multi-arch image (linux/amd64, linux/arm64) for abs-network-shares-config-tool..."
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION" \
    -t "$CONFIG_TOOL_UI_IMAGE_NAME:latest" \
    -f "$CONFIG_TOOL_UI_REPO/Dockerfile" \
    --push \
    "$CONFIG_TOOL_UI_REPO"

  echo ""
  echo "Fetching manifest digest for abs-network-shares-config-tool..."
  UI_DIGEST=$(docker buildx imagetools inspect "$CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$UI_DIGEST" ]]; then
    echo "Error: Failed to obtain image digest for abs-network-shares-config-tool" >&2
    exit 1
  fi
  echo "Image digest: $UI_DIGEST"

  # Update docker-compose.yml with new digest for abs-network-shares-config-tool
  echo ""
  echo "Updating docker-compose.yml with new digest for abs-network-shares-config-tool..."
  update_compose_digest "$CONFIG_TOOL_UI_IMAGE_NAME" "$UI_DIGEST"

  echo ""
  echo "Updating .build-hashes for successful builds..."
  update_container_hash "abs-network-shares-config-tool"
  echo "✓ Build hash updated for config-tool"
  
  echo ""
  echo "✓ Config-tool build complete"
else
  echo ""
  echo "========================================="
  echo "Using existing config-tool image"
  echo "========================================="
  echo "Image: $CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION"
  echo ""
  echo "Fetching existing manifest digest..."
  UI_DIGEST=$(docker buildx imagetools inspect "$CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$UI_DIGEST" ]]; then
    echo "Error: Failed to find existing image on Docker Hub" >&2
    echo "Image $CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION does not exist" >&2
    echo "You may need to build with UI changes first" >&2
    exit 1
  fi
  echo "Image digest: $UI_DIGEST"
  
  # Ensure docker-compose.yml has correct digest
  echo ""
  echo "Verifying docker-compose.yml has correct digest..."
  update_compose_digest "$CONFIG_TOOL_UI_IMAGE_NAME" "$UI_DIGEST"
  
  echo ""
  echo "✓ Using existing image (no rebuild needed)"
fi

# Build abs-network-shares-checker if it has changes
if [[ "$CHECKER_HAS_CHANGES" == true ]]; then
  echo ""
  echo "================================================="
  echo "Building 'ABS Network Shares Checker' Docker image"
  echo "=================================================="
  echo "Image: $ABS_NETWORK_SHARES_CHECKER_IMAGE:$FULL_VERSION"


  # Build and push multi-arch image for abs-network-shares-checker
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$ABS_NETWORK_SHARES_CHECKER_IMAGE:$FULL_VERSION" \
    -t "$ABS_NETWORK_SHARES_CHECKER_IMAGE:latest" \
    -f "$ABS_NETWORK_SHARES_CHECKER_REPO/Dockerfile" \
    --push \
    "$ABS_NETWORK_SHARES_CHECKER_REPO"

  echo ""
  echo "Fetching manifest digest for abs-network-shares-checker..."
  ABS_NETWORK_SHARES_CHECKER_DIGEST=$(docker buildx imagetools inspect "$ABS_NETWORK_SHARES_CHECKER_IMAGE:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$ABS_NETWORK_SHARES_CHECKER_DIGEST" ]]; then
    echo "Error: Failed to obtain image digest for abs-network-shares-checker" >&2
    exit 1
  fi
  echo "abs-network-shares-checker image digest: $ABS_NETWORK_SHARES_CHECKER_DIGEST"

  # Write image reference to abs-network-shares-checker-image.txt for abs-manager
  # (docker-compose.yml is not updated with this digest as it's only used by abs-manager)
  echo "# This file is auto-generated by build.sh and read by abs-manager to determine the abs-network-shares-checker image to use." > "$ABS_NETWORK_SHARES_CHECKER_TXT_FILE"
  echo "# Do not edit manually." >> "$ABS_NETWORK_SHARES_CHECKER_TXT_FILE"
  echo "${ABS_NETWORK_SHARES_CHECKER_IMAGE}@${ABS_NETWORK_SHARES_CHECKER_DIGEST}" >> "$ABS_NETWORK_SHARES_CHECKER_TXT_FILE"
  echo "✓ Wrote abs-network-shares-checker image reference to abs-manager/abs-network-shares-checker-image.txt"

  echo ""
  echo "Updating .build-hashes for successful build..."
  update_container_hash "abs-network-shares-checker"
  echo "✓ Build hash updated for checker"
  
  echo ""
  echo "✓ Checker build complete"
else
  echo ""
  echo "========================================="
  echo "Using existing checker image"
  echo "========================================="
  echo "Image: $ABS_NETWORK_SHARES_CHECKER_IMAGE:$FULL_VERSION"
  echo ""
  echo "Fetching existing manifest digest..."
  ABS_NETWORK_SHARES_CHECKER_DIGEST=$(docker buildx imagetools inspect "$ABS_NETWORK_SHARES_CHECKER_IMAGE:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$ABS_NETWORK_SHARES_CHECKER_DIGEST" ]]; then
    echo "Error: Failed to find existing checker image on Docker Hub" >&2
    echo "Image $ABS_NETWORK_SHARES_CHECKER_IMAGE:$FULL_VERSION does not exist" >&2
    echo "You may need to build with checker changes first" >&2
    exit 1
  fi
  echo "Image digest: $ABS_NETWORK_SHARES_CHECKER_DIGEST"
  
  # Ensure abs-network-shares-checker-image.txt has correct image reference
  echo ""
  echo "Verifying abs-network-shares-checker-image.txt has correct digest..."
  echo "# This file is auto-generated by build.sh and read by abs-manager to determine the abs-network-shares-checker image to use." > "$ABS_NETWORK_SHARES_CHECKER_TXT_FILE"
  echo "# Do not edit manually." >> "$ABS_NETWORK_SHARES_CHECKER_TXT_FILE"
  echo "${ABS_NETWORK_SHARES_CHECKER_IMAGE}@${ABS_NETWORK_SHARES_CHECKER_DIGEST}" >> "$ABS_NETWORK_SHARES_CHECKER_TXT_FILE"
  echo "✓ Verified abs-network-shares-checker image reference"
  
  echo ""
  echo "✓ Using existing checker image (no rebuild needed)"
fi

# Build abs-manager if it has changes (or config-tool/checker were built)
if [[ "$ABS_MANAGER_HAS_CHANGES" == true ]]; then
  echo ""
  echo "================================================="
  echo "Building 'ABS Manager' Docker image"
  echo "=================================================="
  echo "Image: $ABS_MANAGER_IMAGE:$FULL_VERSION"
  echo ""
  echo "Note: abs-manager includes references to abs-server and abs-network-shares-checker"
  echo ""

  # Ensure buildx is set up
  ensure_buildx

  # Build and push multi-arch image for abs-manager
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$ABS_MANAGER_IMAGE:$FULL_VERSION" \
    -t "$ABS_MANAGER_IMAGE:latest" \
    -f "$ABS_MANAGER_REPO/Dockerfile" \
    --push \
    "$ABS_MANAGER_REPO"

  echo ""
  echo "Fetching manifest digest for abs-manager..."
  ABS_MANAGER_DIGEST=$(docker buildx imagetools inspect "$ABS_MANAGER_IMAGE:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$ABS_MANAGER_DIGEST" ]]; then
    echo "Error: Failed to obtain image digest for abs-manager" >&2
    exit 1
  fi
  echo "abs-manager image digest: $ABS_MANAGER_DIGEST"

  # Update docker-compose.yml with new digest for abs-manager
  echo ""
  echo "Updating docker-compose.yml with new digest for abs-manager..."
  update_compose_digest "$ABS_MANAGER_IMAGE" "$ABS_MANAGER_DIGEST"

  # Update hash for abs-manager after successful build
  echo ""
  echo "Updating .build-hashes for abs-manager..."
  update_container_hash "abs-manager"
  echo "✓ abs-manager hash updated"

  echo ""
  echo "✓ abs-manager build complete"
else
  echo ""
  echo "✓ No abs-manager changes, using existing image"
  
  # Ensure docker-compose.yml has correct digest for abs-manager
  echo "Verifying docker-compose.yml has correct abs-manager digest..."
  ABS_MANAGER_DIGEST=$(docker buildx imagetools inspect "$ABS_MANAGER_IMAGE:$FULL_VERSION" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$ABS_MANAGER_DIGEST" ]]; then
    echo "Warning: Could not fetch existing abs-manager digest from Docker Hub" >&2
  else
    update_compose_digest "$ABS_MANAGER_IMAGE" "$ABS_MANAGER_DIGEST"
  fi
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
  echo "  • $CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION@$UI_DIGEST"
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
  # Explicitly add the README.md from app store root (in case it's not in current dir)
  git add "$SCRIPT_DIR/../README.md" 2>/dev/null || true
  git commit -m "release: v${FULL_VERSION} - ${RELEASE_NOTES}"
  
  echo "Pushing to GitHub..."
  git push
  
  echo ""
  echo "✓ Successfully published v${FULL_VERSION} to GitHub"
  echo ""
  echo "Built image on Docker Hub:"
  echo "  • $CONFIG_TOOL_UI_IMAGE_NAME:$FULL_VERSION@$UI_DIGEST"
  echo ""
else
  echo "Next steps:"
  echo "  1. Review changes: git diff"
  echo "  2. Test locally: ./build.sh --localtest"
  echo "  3. Publish: ./build.sh --publish"
fi
