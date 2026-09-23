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
# (it drives the app's own version) - a crowdsec bump publishes its bare
# tag verbatim (e.g. v1.8.2), matching upstream exactly. The web UI is
# pinned independently: an update to it alone (crowdsec unchanged), or an
# explicit --bump for a local-only packaging fix, appends/increments a
# trailing patch number instead (e.g. v1.8.2.1).
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

# Everything in umbrel-app.yml's releaseNotes field ABOVE this marker is
# preserved untouched (manually-written notes); everything from the
# marker down is fully regenerated from crowdsecurity/crowdsec's own last
# two releases on every run.
RELEASE_NOTES_MARKER="--- crowdsecurity/crowdsec upstream release notes (auto-updated) ---"

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
  --version <vx.x.x[.x]>     : Set explicit app version (e.g., v1.8.1 or v1.8.1.1)
  --bump                     : Publish a local-only packaging fix (neither upstream
                               changed) - appends/increments a trailing patch number
  --notes <text>             : Custom release notes
  --crowdsec-version <X.Y.Z> : Skip the crowdsecurity/crowdsec release check and use
                               this exact version (for CI/automation)
  --webui-version <tag>      : Skip the crowdsec-web-ui release check and use this
                               exact version (for CI/automation)
  --localtest                : Update files and deploy to local umbrel-dev ($UMBREL_DEV_HOST)
  --publish                  : Update files, commit, and push to GitHub

Version numbering: vX.Y.Z when there's no patch on top of it (matches
crowdsecurity/crowdsec's own version exactly). crowdsec-web-ui is pinned
independently: an update to it alone, or an explicit --bump for a
local-only fix, appends/increments a trailing patch number instead (e.g.
v1.8.1.1), which resets to bare vX.Y.Z on the next genuine crowdsec
engine update.
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

# Fetches crowdsecurity/crowdsec's own release notes for the two most
# recent stable releases and regenerates the auto-updated portion of
# umbrel-app.yml's releaseNotes field, preserving any manually-written
# notes above RELEASE_NOTES_MARKER byte-for-byte. Matches the pattern
# established in saltedlolly-audiobookshelf/abs-build.sh and
# saltedlolly-kubo/kubo-build.sh. Only the primary (crowdsec engine)
# upstream's notes are fetched - a web-ui-only bump is still called out
# via the short manual bullet from prepend_release_notes.
update_release_notes() {
  local target_tag="v$1"
  echo "Fetching crowdsecurity/crowdsec's own release notes for $target_tag and the preceding release..."
  local releases_file
  releases_file="$(mktemp)"
  if ! curl -sf "https://api.github.com/repos/crowdsecurity/crowdsec/releases?per_page=10" -o "$releases_file"; then
    echo "⚠️  Could not fetch upstream release notes, leaving releaseNotes as-is" >&2
    rm -f "$releases_file"
    return
  fi

  python3 - "$APP_YML_FILE" "$target_tag" "$RELEASE_NOTES_MARKER" "$releases_file" "crowdsecurity/crowdsec" <<'PY'
import json
import re
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
target_tag = sys.argv[2]
marker = sys.argv[3]
releases = json.loads(Path(sys.argv[4]).read_text())
repo_label = sys.argv[5]

stable = [r for r in releases if not r["draft"] and not r["prerelease"]]
stable.sort(key=lambda r: r["published_at"], reverse=True)

idx = next((i for i, r in enumerate(stable) if r["tag_name"] == target_tag), None)
selected = stable[idx : idx + 2] if idx is not None else stable[:2]
if not selected:
    sys.exit(f"Could not find release {target_tag} (or any stable release) to build notes from")


def format_body(body: str) -> str:
    lines = body.replace("\r\n", "\n").strip("\n").split("\n")
    out = []
    for line in lines:
        line = re.sub(r"^#{2,4}\s*", "", line)
        out.append(("    " + line) if line.strip() else "")
    return "\n".join(out)


sections = []
for r in selected:
    sections.append(f"  {repo_label} {r['tag_name']}\n\n{format_body(r.get('body') or '(no notes provided)')}")

upstream_block = "\n\n\n".join(sections)
upstream_block += f"\n\n\n  See the full release history: https://github.com/{repo_label}/releases"

text = manifest_path.read_text()
m = re.search(r"^releaseNotes:\s*>-\n((?:.*\n)*?)(?=^\S)", text, re.MULTILINE)
if not m:
    sys.exit("Could not find releaseNotes block in umbrel-app.yml")

existing_block = m.group(1)
if marker in existing_block:
    manual_part = existing_block.split(marker, 1)[0].rstrip("\n")
else:
    manual_part = existing_block.rstrip("\n")

new_block = (manual_part.rstrip() + "\n\n\n" if manual_part.strip() else "") + f"  {marker}\n\n\n" + upstream_block + "\n\n"
new_text = text[: m.start(1)] + new_block + text[m.end(1) :]
manifest_path.write_text(new_text)
print(f"✓ Updated releaseNotes with {[r['tag_name'] for r in selected]}")
PY
  rm -f "$releases_file"
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
PRE_CROWDSEC_VER="$(extract_current_crowdsec_version)"
PRE_WEBUI_VER="$(extract_current_webui_version)"

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
current_full_v=$(extract_full_version)
crowdsec_ver=$(extract_current_crowdsec_version)
webui_ver=$(extract_current_webui_version)

CROWDSEC_CHANGED=false; [[ "$crowdsec_ver" != "$PRE_CROWDSEC_VER" ]] && CROWDSEC_CHANGED=true
WEBUI_CHANGED=false; [[ "$webui_ver" != "$PRE_WEBUI_VER" ]] && WEBUI_CHANGED=true

if [[ "$current_full_v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\.([0-9]+)$ ]]; then
  current_app_patch="${BASH_REMATCH[1]}"
else
  current_app_patch="0"
fi

target_v="$SET_VERSION"
if [[ -z "$target_v" ]]; then
  if [[ "$CROWDSEC_CHANGED" == "true" ]]; then
    # Genuine crowdsec engine bump - publish the bare tag, matching
    # upstream exactly, regardless of what patch number was live before.
    target_v="v${crowdsec_ver}"
  elif [[ "$WEBUI_CHANGED" == "true" || "$FORCE_BUMP" == "true" ]]; then
    target_v="v${crowdsec_ver}.$((current_app_patch + 1))"
  else
    target_v="$current_full_v"
  fi
fi

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
  update_release_notes "$crowdsec_ver"
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
