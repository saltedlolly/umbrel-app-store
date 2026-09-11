#!/usr/bin/env bash
set -euo pipefail

# Track the latest crowdsecurity/crowdsec and TheDuffman85/crowdsec-web-ui
# releases and pin docker-compose.yml to their multi-arch manifest digests.
# Also auto-bumps umbrel-app.yml version (unless overridden) and prepends
# release notes.
#
# Like tb-build.sh, this app has nothing to build: both images are already
# public and multi-arch - no Dockerfile, no docker buildx build, no push,
# no registry login required. Unlike tb-build.sh, there are two independent
# upstream projects to track; the crowdsec engine is treated as primary
# (it drives the app's own vX.Y.Z.N version), the web UI is pinned
# independently and just bumps the app patch when it updates on its own.
#
# Requirements:
# - Docker (for `docker buildx imagetools inspect`, no login needed - both
#   images are public)
# - macOS (BSD sed) or Linux (GNU sed)
#
# Usage examples:
#   ./crowdsec-build.sh
#     # Check both upstreams, update files locally, no commit/push
#
#   ./crowdsec-build.sh --bump
#     # Force increment app patch version (even without an upstream change)
#
#   ./crowdsec-build.sh --crowdsec-version 1.8.2 --webui-version 2026.9.1
#     # Skip both upstream release checks and pin these exact versions (CI)
#
#   ./crowdsec-build.sh --publish
#     # Update files, commit, and push (prompts for notes if not provided)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$SCRIPT_DIR"

COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
APP_YML_FILE="$APP_ROOT/umbrel-app.yml"

CROWDSEC_IMAGE="docker.io/crowdsecurity/crowdsec"
WEBUI_IMAGE="ghcr.io/theduffman85/crowdsec-web-ui"

# Explicit version overrides (for CI/automation): skip the GitHub releases
# lookup and use these exact versions directly.
CROWDSEC_VERSION_OVERRIDE=""
WEBUI_VERSION_OVERRIDE=""

SET_VERSION=""
RELEASE_NOTES="Update crowdsec/crowdsec-web-ui to latest upstream release"
LOCAL_TEST=false
PUBLISH_TO_GITHUB=false
FORCE_BUMP=false
UMBREL_DEV_HOST="192.168.215.2"

is_macos=false
if [[ "${OSTYPE:-}" == darwin* ]]; then is_macos=true; fi

usage() {
  cat >&2 <<EOF
Usage: $0 [OPTIONS]

Options:
  -h, --help                 : Show this help message
  --version <vx.x.x.x>       : Set explicit app version (e.g., v1.8.1.1)
  --bump                     : Force increment app patch version
  --notes <text>             : Custom release notes
  --crowdsec-version <X.Y.Z> : Skip the crowdsecurity/crowdsec release check and use
                               this exact version (for CI/automation)
  --webui-version <tag>      : Skip the crowdsec-web-ui release check and use this
                               exact version (for CI/automation)
  --localtest                : Update files and deploy to local umbrel-dev ($UMBREL_DEV_HOST)
  --publish                  : Update files, commit, and push to GitHub

Version numbering: vX.Y.Z.N where:
  X.Y.Z = crowdsecurity/crowdsec upstream version (auto-reset app patch when it updates)
  N     = app patch number (increments on publish, resets to 0 when the engine version updates)
crowdsec-web-ui is pinned independently and doesn't drive the reset - an
update to it alone still bumps the app patch on publish.
EOF
}

# Extract the pinned crowdsec engine version (X.Y.Z, no v prefix) from docker-compose.yml
extract_current_crowdsec_version() {
  grep -oE "${CROWDSEC_IMAGE}:v[0-9]+\.[0-9]+\.[0-9]+" "$COMPOSE_FILE" | head -1 | sed -E 's/.*:v//'
}

# Extract the pinned crowdsec-web-ui tag from docker-compose.yml
extract_current_webui_version() {
  grep -oE "${WEBUI_IMAGE}:[0-9]+\.[0-9]+\.[0-9]+" "$COMPOSE_FILE" | head -1 | sed -E 's/.*://'
}

# Extract full app version from umbrel-app.yml
extract_full_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$APP_YML_FILE"
}

# Extract app patch version (last component) from full version
extract_app_patch() {
  local full_version="$1"
  echo "$full_version" | awk -F'.' '{print $NF}'
}

# Compare versions and reset app patch if the crowdsec engine version changed
check_and_reset_app_version() {
  local current_crowdsec_version=$(extract_current_crowdsec_version)
  local full_version=$(extract_full_version)
  local version_prefix=$(echo "$full_version" | sed -E 's/^v//' | cut -d'.' -f1-3)

  if [[ "$version_prefix" != "$current_crowdsec_version" ]]; then
    echo "✓ crowdsec engine version changed to $current_crowdsec_version, resetting app patch to 0" >&2
    echo "v${current_crowdsec_version}.0"
  else
    echo "$full_version"
  fi
}

# Increment the app patch version (last component)
increment_app_patch() {
  local full_version="$1"
  local prefix=$(echo "$full_version" | cut -d'.' -f1-3)
  local patch=$(extract_app_patch "$full_version")
  local new_patch=$((patch + 1))
  echo "${prefix}.${new_patch}"
}

set_version_in_app_yml() {
  local newv="$1"
  if $is_macos; then
    sed -E -i '' "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  else
    sed -E -i "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  fi
}

prepend_release_notes() {
  local newv="$1" notes="$2"
  awk -v ver="$newv" -v msg="$notes" '
    BEGIN{inserted=0}
    /^releaseNotes:[[:space:]]*>-/ {
      if (!inserted) {
        print; print "  " ver ":\n\n  - " msg "\n"; inserted=1; next
      }
    }
    {print}
  ' "$APP_YML_FILE" > "$APP_YML_FILE.tmp"
  mv "$APP_YML_FILE.tmp" "$APP_YML_FILE"
}

# Update app store README.md with the app version and release date
update_readme_version() {
  local new_version="$1"
  local README_FILE="$APP_ROOT/../README.md"
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
    r'(<td nowrap id="saltedlolly-crowdsec-version"><code>)[^<]*(</code></td>)',
    rf"\g<1>{new_version}\g<2>",
    text,
    count=1,
)

text = re.sub(
    r'id="saltedlolly-crowdsec-date">(\d{4}-\d{2}-\d{2})',
    f'id="saltedlolly-crowdsec-date">{today}',
    text,
    count=1,
)

readme_path.write_text(text)
PY
  echo "✓ Updated README.md version to $new_version"
  echo "✓ Updated README.md release date to $today"
  echo ""
}

# Rewrite docker-compose.yml's pinned tag@digest for a given image
update_compose_image() {
  local image="$1" new_tag="$2" new_digest="$3" version_pattern="$4"
  local escaped_image=$(echo "$image" | sed 's/[\/&]/\\&/g')
  local pattern="^([[:space:]]*image:[[:space:]]*)${escaped_image}:${version_pattern}@sha256:[a-f0-9]+"
  local replacement="\\1${image}:${new_tag}@${new_digest}"

  if $is_macos; then
    sed -E -i '' "s|$pattern|$replacement|" "$COMPOSE_FILE"
  else
    sed -E -i "s|$pattern|$replacement|" "$COMPOSE_FILE"
  fi
}

update_crowdsec_pin() {
  echo ""
  echo "========================================="
  echo "Checking crowdsecurity/crowdsec upstream version"
  echo "========================================="

  local latest_version
  if [[ -n "$CROWDSEC_VERSION_OVERRIDE" ]]; then
    latest_version="$CROWDSEC_VERSION_OVERRIDE"
    echo "Using explicitly supplied crowdsec version: $latest_version (skipping GitHub release lookup)"
  else
    echo "Fetching latest release from GitHub..."
    latest_version=$(curl -s https://api.github.com/repos/crowdsecurity/crowdsec/releases/latest | grep -o '"tag_name": "v[^"]*' | cut -d'v' -f2)

    if [[ -z "$latest_version" ]]; then
      echo "⚠️  Could not fetch latest crowdsec version from GitHub, skipping update" >&2
      echo ""
      return
    fi

    echo "Latest stable version: $latest_version"
  fi

  local current_version=$(extract_current_crowdsec_version)
  echo "Current pinned version: $current_version"

  if [[ "$current_version" == "$latest_version" ]]; then
    echo "✓ Already on latest crowdsec version"
    echo ""
    return
  fi

  echo "Updating from $current_version to $latest_version..."

  echo "Fetching digest for crowdsec v$latest_version..."
  local digest=$(docker buildx imagetools inspect "$CROWDSEC_IMAGE:v$latest_version" 2>/dev/null | grep "^Digest:" | awk '{print $2}')

  if [[ -z "$digest" ]]; then
    echo "❌ Error: Could not fetch digest for $CROWDSEC_IMAGE:v$latest_version" >&2
    exit 1
  fi

  echo "Digest: $digest"
  update_compose_image "$CROWDSEC_IMAGE" "v$latest_version" "$digest" 'v[0-9]+\.[0-9]+\.[0-9]+'
  echo "✓ Updated docker-compose.yml to ${CROWDSEC_IMAGE}:v${latest_version}@${digest}"
  echo ""
}

update_webui_pin() {
  echo ""
  echo "========================================="
  echo "Checking crowdsec-web-ui upstream version"
  echo "========================================="

  local latest_version
  if [[ -n "$WEBUI_VERSION_OVERRIDE" ]]; then
    latest_version="$WEBUI_VERSION_OVERRIDE"
    echo "Using explicitly supplied crowdsec-web-ui version: $latest_version (skipping GitHub release lookup)"
  else
    echo "Fetching latest release from GitHub..."
    latest_version=$(curl -s https://api.github.com/repos/TheDuffman85/crowdsec-web-ui/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)

    if [[ -z "$latest_version" ]]; then
      echo "⚠️  Could not fetch latest crowdsec-web-ui version from GitHub, skipping update" >&2
      echo ""
      return
    fi

    echo "Latest stable version: $latest_version"
  fi

  local current_version=$(extract_current_webui_version)
  echo "Current pinned version: $current_version"

  if [[ "$current_version" == "$latest_version" ]]; then
    echo "✓ Already on latest crowdsec-web-ui version"
    echo ""
    return
  fi

  echo "Updating from $current_version to $latest_version..."

  echo "Fetching digest for crowdsec-web-ui $latest_version..."
  local digest=$(docker buildx imagetools inspect "$WEBUI_IMAGE:$latest_version" 2>/dev/null | grep "^Digest:" | awk '{print $2}')

  if [[ -z "$digest" ]]; then
    echo "❌ Error: Could not fetch digest for $WEBUI_IMAGE:$latest_version" >&2
    exit 1
  fi

  echo "Digest: $digest"
  update_compose_image "$WEBUI_IMAGE" "$latest_version" "$digest" '[0-9]+\.[0-9]+\.[0-9]+'
  echo "✓ Updated docker-compose.yml to ${WEBUI_IMAGE}:${latest_version}@${digest}"
  echo ""
}

########################################
# Parse arguments
########################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --version) SET_VERSION="$2"; shift 2 ;;
    --bump) FORCE_BUMP=true; shift ;;
    --notes) RELEASE_NOTES="$2"; shift 2 ;;
    --crowdsec-version) CROWDSEC_VERSION_OVERRIDE="$2"; shift 2 ;;
    --webui-version) WEBUI_VERSION_OVERRIDE="$2"; shift 2 ;;
    --localtest) LOCAL_TEST=true; shift ;;
    --publish) PUBLISH_TO_GITHUB=true; shift ;;
    *) usage; exit 1 ;;
  esac
done

########################################
# Check for upstream updates
########################################
update_crowdsec_pin
update_webui_pin

########################################
# Interactive prompts for --publish mode
########################################
if [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  current_full_v=$(extract_full_version)
  if [[ -z "$current_full_v" ]]; then
    echo "Error: Could not read current version from $APP_YML_FILE" >&2
    exit 1
  fi

  if [[ -z "$SET_VERSION" ]]; then
    echo "Current version: $current_full_v"
    echo
    bumped_v=$(increment_app_patch "$(check_and_reset_app_version)")

    if [[ ! -t 0 ]]; then
      # Non-interactive (CI/automation): no TTY to prompt, so just take the
      # normal-publish path rather than hang waiting for input that will
      # never arrive.
      echo "Non-interactive shell detected, auto-selecting: increment app patch to $bumped_v"
      SET_VERSION="$bumped_v"
    else
      echo "Select action:"
      echo "  1) Increment app patch: $bumped_v (normal publish)"
      echo "  2) Cancel"
      echo
      read -p "Enter choice (1-2): " -n 1 -r
      echo

      case "$REPLY" in
        1) SET_VERSION="$bumped_v" ;;
        2) echo "Cancelled."; exit 0 ;;
        *) echo "Invalid choice. Cancelled."; exit 1 ;;
      esac
    fi

    echo "Selected version: $SET_VERSION"
    echo
  fi

  if [[ "$RELEASE_NOTES" == "Update crowdsec/crowdsec-web-ui to latest upstream release" ]]; then
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
# Determine version
########################################
current_full_v=$(check_and_reset_app_version)

target_v="$SET_VERSION"
if [[ -z "$target_v" ]]; then
  if [[ "$FORCE_BUMP" == "true" ]] || [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
    target_v=$(increment_app_patch "$current_full_v")
  else
    target_v="$current_full_v"
  fi
fi

crowdsec_ver=$(extract_current_crowdsec_version)
webui_ver=$(extract_current_webui_version)
echo "Current crowdsec version: $crowdsec_ver"
echo "Current web-ui version:   $webui_ver"
echo "Current app version:      $current_full_v"
echo "Target app version:       $target_v"
echo

########################################
# Update umbrel-app.yml and README.md
########################################
echo "Updating umbrel-app.yml version..."
set_version_in_app_yml "$target_v"

echo "Updating app store README.md..."
update_readme_version "$target_v"

# Only update release notes for non-localtest builds (mainly --publish)
if [[ "$LOCAL_TEST" != "true" ]]; then
  echo "Updating release notes..."
  prepend_release_notes "$target_v" "$RELEASE_NOTES"
fi

echo
echo "=== Done ==="
echo "Updated files:"
echo "  - umbrel-app.yml (version: $target_v)"
echo "  - docker-compose.yml (crowdsec: $crowdsec_ver, web-ui: $webui_ver)"
echo

########################################
# Local test deployment
########################################
if [[ "$LOCAL_TEST" == "true" ]]; then
  echo "========================================"
  echo "LOCAL TEST DEPLOYMENT"
  echo "========================================"
  echo

  APP_ID="saltedlolly-crowdsec"
  UMBREL_USER="umbrel"

  echo "Deploying to umbrel-dev at $UMBREL_DEV_HOST..."
  echo

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

  echo "Copying app files to umbrel-dev..."

  EXISTING_STORE=$(ssh "$UMBREL_USER@$UMBREL_DEV_HOST" "ls -1 /home/umbrel/umbrel/app-stores/ | grep 'getumbrel-umbrel-apps-github' | head -1")

  if [[ -z "$EXISTING_STORE" ]]; then
    echo "❌ Error: Could not find existing app store directory"
    exit 1
  fi

  echo "Using app store: $EXISTING_STORE"

  rsync -av --exclude=".git" \
            --exclude=".gitignore" \
            --exclude=".gitkeep" \
            --exclude=".DS_Store" \
            --exclude="crowdsec-build.sh" \
            "$APP_ROOT/" \
            "$UMBREL_USER@$UMBREL_DEV_HOST:/home/umbrel/umbrel/app-stores/$EXISTING_STORE/$APP_ID/"

  echo "✓ App files copied"
  echo
  echo "========================================"
  echo "NEXT STEPS"
  echo "========================================"
  echo
  echo "The NEW version (v$target_v) is now on umbrel-dev with the updated image pins."
  echo
  echo "⚠️  CRITICAL: Umbrel only reads app files during installation!"
  echo "   You MUST reinstall for changes to take effect."
  echo
  echo "Steps to test:"
  echo
  echo "  1. REINSTALL from App Store:"
  echo "     • Go to App Store → Find 'CrowdSec'"
  echo "     • Click Install"
  echo "     • This will pull the pinned images from GHCR/Docker Hub"
  echo
  echo "  2. TEST the app:"
  echo "     • Access at: http://$UMBREL_DEV_HOST:5190/"
  echo
elif [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  echo "========================================"
  echo "PUBLISHING TO GITHUB"
  echo "========================================"
  echo

  STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"

  # Scoped staging only - never `git add -A` here. Broadly staging the
  # whole working tree during a --publish run is exactly what swept an
  # unrelated app's untracked draft files into a different app's release
  # commit earlier in this store's history; only ever stage this app's own
  # directory plus the root README this script itself updates.
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | \
    awk -v prefix="saltedlolly-crowdsec/" 'index($0, prefix) != 1 && $0 != "README.md" {print}')"
  if [[ -n "$staged_outside" ]]; then
    echo "Already-staged files outside saltedlolly-crowdsec/ and README.md:" >&2
    echo "$staged_outside" >&2
    echo "Unstage unrelated files before publishing" >&2
    exit 1
  fi

  echo "Committing changes..."
  git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/README.md"
  git -C "$STORE_ROOT" commit -m "release: ${target_v} - ${RELEASE_NOTES}"

  echo "Pushing to GitHub..."
  git -C "$STORE_ROOT" push

  echo
  echo "✓ Successfully published ${target_v} to GitHub"
  echo
else
  echo "Next steps:"
  echo "  1. Review changes: git diff"
  echo "  2. Test locally: ./crowdsec-build.sh --localtest"
  echo "  3. Publish: ./crowdsec-build.sh --publish"
fi
