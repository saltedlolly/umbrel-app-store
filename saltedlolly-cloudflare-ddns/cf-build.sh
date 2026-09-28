#!/usr/bin/env bash
set -euo pipefail

# Build and push multi-arch images for UI and DDNS, then pin compose to new manifest digests.
# Also auto-bump umbrel-app.yml version (unless overridden), tag images to match, and prepend release notes.
#
# Version scheme: the app version is the favonia/cloudflare-ddns tag
# verbatim (e.g. v1.17.1) when there's no packaging-only patch, matching
# upstream exactly. A 4th number only appears (starting at .1) for a
# local-only fix (a UI/DDNS-wrapper change with no upstream bump) - use
# --bump for that.
#
# Requirements:
# - Docker Buildx with docker-container driver for multi-platform support
# - Logged in to GHCR (ghcr.io) for `saltedlolly/*`:
#     docker login ghcr.io -u saltedlolly
#   using a GitHub Personal Access Token (classic: write:packages +
#   read:packages scopes; or fine-grained: Packages read/write) as the
#   password. GHCR does not use Docker Hub credentials.
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

# Image hosting: GitHub Container Registry (GHCR), not Docker Hub
UI_IMAGE="ghcr.io/saltedlolly/cloudflare-ddns-ui"
DDNS_IMAGE="ghcr.io/saltedlolly/cloudflare-ddns"

SET_VERSION=""
BUMP_KIND="patch"   # kept for backwards compatibility, not used in 4-part versioning
# Explicit favonia/cloudflare-ddns version override (for CI/automation):
# skips the GitHub releases lookup in update_ddns_version() and uses this
# version directly. Independent of SET_VERSION/--version, which controls
# the overall app version string, not which upstream tag gets pinned.
DDNS_VERSION_OVERRIDE=""

# Everything in umbrel-app.yml's releaseNotes field ABOVE this marker is
# preserved untouched (manually-written notes); everything from the
# marker down is fully regenerated from favonia/cloudflare-ddns's own
# last two releases on every run.
RELEASE_NOTES_MARKER="--- favonia/cloudflare-ddns upstream release notes (auto-updated) ---"

RELEASE_NOTES="Publish multi-arch images (linux/arm64 + linux/amd64) for Umbrel Home compatibility"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
APP_YML_FILE="$APP_ROOT/umbrel-app.yml"
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
  -h, --help             : Show this help message
  --version <vx.x.x[.x]> : Set explicit version (e.g., v1.17.1 or v1.17.1.1)
  --bump                 : Publish a local-only fix (upstream unchanged) - appends/
                           increments a 4th version number
  --notes <text>         : Custom release notes
  --ddns-version <X.Y.Z> : Skip the upstream GitHub release check and use this exact
                           favonia/cloudflare-ddns version (for CI/automation)
  --localtest            : Build and deploy to local umbrel-dev ($UMBREL_DEV_HOST)
  --publish              : Build and push to GitHub (prompts for notes if not provided)

Version numbering: vX.Y.Z when there's no packaging-only patch (matches
favonia/cloudflare-ddns's own version exactly), or vX.Y.Z.N for a
local-only fix (N starts at 1, and resets to bare vX.Y.Z on the next
genuine upstream update).

Default repo paths (within the app folder):
  UI_REPO:   $UI_REPO
  DDNS_REPO: $DDNS_REPO
EOF
}

# Extract cloudflare-ddns version from Dockerfile (source of truth)
extract_ddns_version() {
  grep -o 'favonia/cloudflare-ddns:[0-9.]*' "$DDNS_REPO/Dockerfile" | cut -d':' -f2
}

# Extract full app version from umbrel-app.yml
extract_full_version() {
  # Extract version: "vx.x.x.x" from umbrel-app.yml
  awk -F'"' '/^version:/ {print $2; exit}' "$APP_YML_FILE"
}

# Old semver_bump for backwards compatibility (not used for 4-part versioning)
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

update_ddns_version() {
  echo ""
  echo "========================================="
  echo "Checking cloudflare-ddns upstream version"
  echo "========================================="
  
  local latest_version
  if [[ -n "$DDNS_VERSION_OVERRIDE" ]]; then
    latest_version="$DDNS_VERSION_OVERRIDE"
    echo "Using explicitly supplied cloudflare-ddns version: $latest_version (skipping GitHub release lookup)"
  else
    # Get latest stable release tag from GitHub
    echo "Fetching latest release from GitHub..."
    latest_version=$(curl -s https://api.github.com/repos/favonia/cloudflare-ddns/releases/latest | grep -o '"tag_name": "v[^"]*' | cut -d'v' -f2)

    if [[ -z "$latest_version" ]]; then
      echo "⚠️  Could not fetch latest version from GitHub, skipping update" >&2
      echo ""
      return
    fi

    echo "Latest stable version: $latest_version"
  fi
  
  # Get current version from Dockerfile
  local current_version=$(extract_ddns_version)
  echo "Current version in Dockerfile: $current_version"
  
  if [[ "$current_version" == "$latest_version" ]]; then
    echo "✓ Already on latest version"
    echo ""
    return
  fi
  
  echo "Updating from $current_version to $latest_version..."
  
  # Update Dockerfile
  if $is_macos; then
    sed -i '' "s/favonia\/cloudflare-ddns:[0-9.]*/favonia\/cloudflare-ddns:${latest_version}/" "$DDNS_REPO/Dockerfile"
  else
    sed -i "s/favonia\/cloudflare-ddns:[0-9.]*/favonia\/cloudflare-ddns:${latest_version}/" "$DDNS_REPO/Dockerfile"
  fi
  
  echo "✓ Updated Dockerfile to use favonia/cloudflare-ddns:${latest_version}"
  echo ""
}

set_version_in_app_yml() {
  local newv="$1"
  # Use [[:space:]] instead of \s for BSD sed (macOS) compatibility
  if $is_macos; then
    sed -E -i '' "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  else
    sed -E -i "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  fi
}

# Update version.json with version info. app_patch is 0 for a bare
# vX.Y.Z (no local-only patch yet) or the 4th number for vX.Y.Z.N.
update_version_json() {
  local full_version="$1"
  local ddns_version=$(extract_ddns_version)
  local app_patch="0"
  if [[ "$full_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+\.([0-9]+)$ ]]; then
    app_patch="${BASH_REMATCH[1]}"
  fi
  local VERSION_FILE="$APP_ROOT/ui/public/version.json"
  
  # Create parent directory if needed
  mkdir -p "$(dirname "$VERSION_FILE")"
  
  echo "{" > "$VERSION_FILE"
  echo "  \"version\": \"$full_version\"," >> "$VERSION_FILE"
  echo "  \"ddnsVersion\": \"$ddns_version\"," >> "$VERSION_FILE"
  echo "  \"appVersion\": $app_patch" >> "$VERSION_FILE"
  echo "}" >> "$VERSION_FILE"
  
  echo "✓ Updated version.json to $full_version (upstream: $ddns_version, app patch: $app_patch)"
  echo ""
}

# Update app store README.md with the app version and release date
update_readme_version() {
  local new_version="$1"
  # Remove leading 'v' if present for consistency with other scripts
  new_version="${new_version#v}"
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
    r'(<td nowrap id="saltedlolly-cloudflare-ddns-version"><code>)v[^<]*(</code></td>)',
    rf"\1v{new_version}\2",
    text,
    count=1,
)

text = re.sub(
    r'id="saltedlolly-cloudflare-ddns-date">(\d{4}-\d{2}-\d{2})',
    f'id="saltedlolly-cloudflare-ddns-date">{today}',
    text,
    count=1,
)

readme_path.write_text(text)
PY
  echo "✓ Updated README.md version to v$new_version"
  echo "✓ Updated README.md release date to $today"
  echo ""
}

set_version_in_package_json() {
  local newv="$1"
  local package_json="ui/package.json"
  # Update version in package.json for consistency
  if $is_macos; then
    sed -E -i '' "s/\"version\":[[:space:]]*\"[^\"]+\"/\"version\": \"${newv}\"/" "$package_json"
  else
    sed -E -i "s/\"version\":[[:space:]]*\"[^\"]+\"/\"version\": \"${newv}\"/" "$package_json"
  fi
}

# New upstream release: release notes start afresh. Replace everything
# above the upstream-notes marker (or the whole block if there's no marker)
# with this release's single entry. Patch releases use prepend_release_notes
# instead, so notes cover the current upstream release plus later patches.
reset_release_notes() {
  local file="$1" newv="$2" notes="$3"
  python3 - "$file" "$newv" "$notes" <<'PY'
import re, sys
path, ver, msg = sys.argv[1:4]
s = open(path).read()
m = re.search(r'^releaseNotes:[ \t]*>-\n', s, re.M)
if not m:
    sys.exit("releaseNotes block not found")
start, rest = m.end(), s[m.end():]
marker = re.search(r'^  --- .*upstream release notes \(auto-updated\) ---$', rest, re.M)
nextkey = re.search(r'^\S', rest, re.M)
if marker and (not nextkey or marker.start() < nextkey.start()):
    end, tail = marker.start(), "\n"
else:
    end, tail = (nextkey.start() if nextkey else len(rest)), ""
open(path, 'w').write(s[:start] + f"  ## {ver}\n\n  - {msg}\n\n" + tail + rest[end:])
PY
}

prepend_release_notes() {
  local newv="$1" notes="$2"
  # Insert new section right after the 'releaseNotes: >-' line
  # Use markdown h2 heading (##) for version headers to make them stand out
  awk -v ver="$newv" -v msg="$notes" '
    BEGIN{inserted=0}
    /^releaseNotes:[[:space:]]*>-/ {
      if (!inserted) {
        print; print "  ## " ver "\n\n  - " msg "\n"; inserted=1; next
      }
    }
    {print}
  ' "$APP_YML_FILE" > "$APP_YML_FILE.tmp"
  mv "$APP_YML_FILE.tmp" "$APP_YML_FILE"
}

# Fetches favonia/cloudflare-ddns's own release notes for the two most
# recent stable releases and regenerates the auto-updated portion of
# umbrel-app.yml's releaseNotes field, preserving any manually-written
# notes above RELEASE_NOTES_MARKER byte-for-byte. Matches the pattern
# established in saltedlolly-audiobookshelf/abs-build.sh and
# saltedlolly-kubo/kubo-build.sh.
update_release_notes() {
  local target_tag="v$1"
  echo "Fetching favonia/cloudflare-ddns's own release notes for $target_tag and the preceding release..."
  local releases_file
  releases_file="$(mktemp)"
  if ! curl -sf "https://api.github.com/repos/favonia/cloudflare-ddns/releases?per_page=10" -o "$releases_file"; then
    echo "⚠️  Could not fetch upstream release notes, leaving releaseNotes as-is" >&2
    rm -f "$releases_file"
    return
  fi

  python3 - "$APP_YML_FILE" "$target_tag" "$RELEASE_NOTES_MARKER" "$releases_file" "favonia/cloudflare-ddns" <<'PY'
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
        line = re.sub(r"^#{2,4}\s*", "", line).rstrip()
        out.append(("    " + line) if line else "")
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

ensure_buildx() {
  # Pick a multi-arch (docker-container) builder without parsing
  # `docker buildx ls`: its column layout changes between Docker versions,
  # and it exits non-zero when any other builder (e.g. a stopped OrbStack
  # one) is unreachable. Order: the currently selected builder (what
  # docker/setup-buildx-action selects in CI), then multi-platform-builder,
  # else create multi-platform-builder.
  echo "Setting up Docker buildx for multi-platform builds..."
  if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH" >&2
    exit 1
  fi

  # Capture first, then parse: piping into `awk '{...; exit}'` can SIGPIPE
  # docker, which under `set -o pipefail` + `set -e` silently kills the script
  local info current driver
  info=$(docker buildx inspect 2>/dev/null || true)
  current=$(awk '/^Name:/{print $2; exit}' <<< "$info")
  driver=$(awk '/^Driver:/{print $2; exit}' <<< "$info")

  if [[ "$driver" == "docker-container" ]] && docker buildx inspect --bootstrap >/dev/null 2>&1; then
    echo "Using current buildx builder: $current"
  elif docker buildx inspect --bootstrap multi-platform-builder >/dev/null 2>&1; then
    docker buildx use multi-platform-builder
    echo "Using buildx builder: multi-platform-builder"
  else
    echo "Creating buildx builder multi-platform-builder (linux/amd64, linux/arm64)..."
    docker buildx rm multi-platform-builder >/dev/null 2>&1 || true
    docker buildx create --driver docker-container \
      --platform linux/amd64,linux/arm64 \
      --name multi-platform-builder --use >/dev/null
    docker buildx inspect --bootstrap >/dev/null 2>&1 || {
      echo "Error: Could not bootstrap builder multi-platform-builder" >&2
      exit 1
    }
  fi
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

# Git sync pre-flight check - prevents pushing to stale branch
# Commit/push failure handling. By the time we commit, images are pushed and
# the release files are updated and staged, so a failed commit (often commit
# signing, e.g. 1Password locked or timed out) must not leave a mystery.
# Re-running the script would bump the version again, so explain how to finish.
explain_failed_commit() {
  local msg="$1" root
  root="$(git rev-parse --show-toplevel)"
  {
    echo ""
    echo "❌ git commit failed (often commit signing: e.g. 1Password locked or timed out)."
    echo "Everything else is done: images are pushed and the release files are updated and staged."
    echo "Do NOT re-run this script - it would bump the version again."
    echo "Once the cause is fixed, finish the release with:"
    echo ""
    echo "  git -C $(printf '%q' "$root") commit -m $(printf '%q' "$msg")"
    echo "  git -C $(printf '%q' "$root") push"
    echo ""
  } >&2
  exit 1
}

explain_failed_push() {
  local root
  root="$(git rev-parse --show-toplevel)"
  {
    echo ""
    echo "❌ git push failed. The release commit was made locally."
    echo "Once the cause is fixed (network, or pull if GitHub moved on), run:"
    echo ""
    echo "  git -C $(printf '%q' "$root") push"
    echo ""
  } >&2
  exit 1
}

check_git_sync() {
  echo "Checking repository sync status..."
  
  # Determine STORE_ROOT if not set
  local store_root="${STORE_ROOT:-$(cd "$APP_ROOT/.." && pwd)}"
  
  # 1. Check for uncommitted changes
  if ! git -C "$store_root" diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes"
    echo "Commit or stash them first, then try again"
    exit 1
  fi
  
  # 2. Fetch remote state (quietly)
  git -C "$store_root" fetch origin >/dev/null 2>&1
  
  # 3. Get current branch
  local current_branch=$(git -C "$store_root" rev-parse --abbrev-ref HEAD)
  
  # 4. Check if behind remote
  local behind=$(git -C "$store_root" rev-list HEAD..origin/$current_branch --count 2>/dev/null || echo "0")
  if [[ "$behind" -gt 0 ]]; then
    echo "❌ Error: Local branch is $behind commit(s) behind origin/$current_branch"
    echo ""
    echo "Your local repository is outdated. This can happen when:"
    echo "  • GitHub Actions auto-release ran overnight"
    echo "  • Changes were made on another machine"
    echo "  • A collaborator pushed changes"
    echo ""
    echo "To fix:"
    echo "  git pull"
    echo ""
    echo "Then run this build script again."
    exit 1
  fi
  
  # 5. Check if ahead (informational only)
  local ahead=$(git -C "$store_root" rev-list origin/$current_branch..HEAD --count 2>/dev/null || echo "0")
  if [[ "$ahead" -gt 0 ]]; then
    echo "ℹ️  Note: You have $ahead unpushed commit(s)"
  fi
  
  echo "✓ Repository is in sync with origin/$current_branch"
}

# Parse arguments
########################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --version) SET_VERSION="$2"; shift 2 ;;
    --bump) FORCE_BUMP=true; shift ;;
    --notes) RELEASE_NOTES="$2"; shift 2 ;;
    --ddns-version) DDNS_VERSION_OVERRIDE="$2"; shift 2 ;;
    --localtest) LOCAL_TEST=true; shift ;;
    --publish) PUBLISH_TO_GITHUB=true; shift ;;
    *) usage; exit 1 ;;
  esac
done

# Git sync check (if publishing)
if [[ "${PUBLISH_TO_GITHUB:-false}" == "true" ]] || [[ "${MODE:-}" == "publish" ]]; then
  check_git_sync
  echo ""
fi

########################################
# Check for upstream cloudflare-ddns updates
########################################
update_ddns_version

########################################
# Interactive prompts for --publish mode
########################################
if [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  current_full_v=$(extract_full_version)
  if [[ -z "$current_full_v" ]]; then
    echo "Error: Could not read current version from $APP_YML_FILE" >&2
    exit 1
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
current_full_v=$(extract_full_version)
if [[ -z "$current_full_v" ]]; then
  echo "Error: Could not read current version from $APP_YML_FILE" >&2
  exit 1
fi

ddns_ver=$(extract_ddns_version)

# current_full_v may be bare (vX.Y.Z, no local patch yet) or suffixed
# (vX.Y.Z.N, a prior local-only fix) - derive both parts.
if [[ "$current_full_v" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
  current_app_tag="${BASH_REMATCH[1]}"
  current_app_patch="${BASH_REMATCH[2]}"
else
  current_app_tag="${current_full_v#v}"
  current_app_patch="0"
fi

target_v="$SET_VERSION"
if [[ -z "$target_v" ]]; then
  if [[ "$ddns_ver" != "$current_app_tag" ]]; then
    # Genuine upstream bump - publish the bare tag, matching upstream
    # exactly, regardless of what patch number (if any) was live before.
    target_v="v${ddns_ver}"
  elif [[ "$FORCE_BUMP" == "true" ]]; then
    target_v="v${ddns_ver}.$((current_app_patch + 1))"
  else
    target_v="$current_full_v"
  fi
fi

echo "Current cloudflare-ddns version: $ddns_ver"
echo "Current app version:             $current_full_v"
echo "Target app version:              $target_v"
echo

########################################
# Manage SSO configuration
########################################
echo "Checking Umbrel SSO configuration..."

# Handle umbrel-app.yml path setting
sso_path=$(grep '^path:' "$APP_YML_FILE" | awk '{print $2}' | tr -d '"')
if [[ "$LOCAL_TEST" == "true" ]]; then
  # For local testing, SSO can be disabled if desired (no change needed)
  if [[ "$sso_path" != "" ]]; then
    echo "ℹ️  SSO disabled for local testing (path: '$sso_path')"
  else
    echo "ℹ️  SSO enabled (can be manually disabled by setting path: '/' for local testing)"
  fi
else
  # For production builds, ensure SSO is enabled
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
fi

# Handle docker-compose.yml PROXY_AUTH_ADD setting
proxy_auth_line=$(grep -n "PROXY_AUTH_ADD" "$COMPOSE_FILE" | head -1 || true)
if [[ "$LOCAL_TEST" == "true" ]]; then
  # For local testing, ensure PROXY_AUTH_ADD is set to "false" to bypass SSO
  if [[ -z "$proxy_auth_line" ]]; then
    echo "✓ Adding PROXY_AUTH_ADD: \"false\" for local testing"
    # Insert after APP_PORT line in app_proxy environment section
    if $is_macos; then
      sed -i '' '/APP_PORT: 3000/a\
      # Disable SSO for local testing\
      PROXY_AUTH_ADD: "false"
' "$COMPOSE_FILE"
    else
      sed -i '/APP_PORT: 3000/a\      # Disable SSO for local testing\n      PROXY_AUTH_ADD: "false"' "$COMPOSE_FILE"
    fi
  else
    echo "✓ PROXY_AUTH_ADD already set for local testing"
  fi
else
  # For production builds, ensure PROXY_AUTH_ADD is removed (SSO enabled)
  if [[ -n "$proxy_auth_line" ]]; then
    echo "⚠️  PROXY_AUTH_ADD found in docker-compose.yml"
    echo "✓ Removing PROXY_AUTH_ADD to enable SSO for production"
    # Remove the PROXY_AUTH_ADD line and the comment above it
    if $is_macos; then
      sed -i '' '/# Disable SSO for local testing/d' "$COMPOSE_FILE"
      sed -i '' '/PROXY_AUTH_ADD/d' "$COMPOSE_FILE"
    else
      sed -i '/# Disable SSO for local testing/d' "$COMPOSE_FILE"
      sed -i '/PROXY_AUTH_ADD/d' "$COMPOSE_FILE"
    fi
  else
    echo "✓ PROXY_AUTH_ADD not present (SSO enabled)"
  fi
fi
echo

########################################
# Update umbrel-app.yml, version.json, and package.json
########################################
echo "Updating umbrel-app.yml version..."
set_version_in_app_yml "$target_v"

echo "Updating version.json..."
update_version_json "$target_v"

echo "Updating app store README.md..."
update_readme_version "$target_v"

# Only update release notes for non-localtest builds (mainly --publish)
if [[ "$LOCAL_TEST" != "true" ]]; then
  echo "Updating release notes..."
  if [[ "$ddns_ver" != "$current_app_tag" ]]; then
    reset_release_notes "$APP_YML_FILE" "$target_v" "$RELEASE_NOTES"
  else
    prepend_release_notes "$target_v" "$RELEASE_NOTES"
  fi
  update_release_notes "$ddns_ver"
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
echo "Building UI multi-arch: ${UI_IMAGE}:${target_v}"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg VERSION="${target_v}" \
  -t "${UI_IMAGE}:${target_v}" \
  -f ui/Dockerfile \
  --push "$APP_ROOT"

echo "Fetching UI manifest digest..."
UI_DIGEST=$(docker buildx imagetools inspect "${UI_IMAGE}:${target_v}" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
if [[ -z "$UI_DIGEST" ]]; then
  echo "Error: Failed to obtain UI digest" >&2
  exit 1
fi
echo "UI digest: $UI_DIGEST"

########################################
# Build DDNS multi-arch
########################################
echo
echo "Building DDNS multi-arch: ${DDNS_IMAGE}:${target_v}"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "${DDNS_IMAGE}:${target_v}" \
  -f cloudflare-ddns/Dockerfile \
  --push "$APP_ROOT"

echo "Fetching DDNS manifest digest..."
DDNS_DIGEST=$(docker buildx imagetools inspect "${DDNS_IMAGE}:${target_v}" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
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
update_compose_digest "$UI_IMAGE" "$UI_DIGEST"
update_compose_digest "$DDNS_IMAGE" "$DDNS_DIGEST"

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
  echo "     • This will pull the NEW images from GHCR"
  echo
  echo "  2. TEST the app:"
  echo "     • Access at: http://$UMBREL_DEV_HOST:4100/"
  echo "     • Version badge should show: v$target_v"
  echo
  echo "Built images on GHCR:"
  echo "  • UI:   ${UI_IMAGE}:$target_v@$UI_DIGEST"
  echo "  • DDNS: ${DDNS_IMAGE}:$target_v@$DDNS_DIGEST"
  echo
elif [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  echo "========================================" 
  echo "PUBLISHING TO GITHUB"
  echo "========================================" 
  echo
  
  # Commit and push to GitHub
  echo "Committing changes..."
  # Scoped staging only - this script touches its own app folder and the
  # root README (version + date), nothing else. Never `git add -A`.
  git add -- "$APP_ROOT" "$APP_ROOT/../README.md"
  release_msg="release: ${target_v} - ${RELEASE_NOTES}"
  git commit -m "$release_msg" || explain_failed_commit "$release_msg"
  echo "Pushing to GitHub..."
  git push || explain_failed_push
  echo
  echo "✓ Successfully published ${target_v} to GitHub"
  echo
  echo "Built images on GHCR:"
  echo "  • UI:   ${UI_IMAGE}:$target_v@$UI_DIGEST"
  echo "  • DDNS: ${DDNS_IMAGE}:$target_v@$DDNS_DIGEST"
  echo
else
  echo "Next steps:"
  echo "  1. Review changes: git diff"
  echo "  2. Commit: git add -- \"$APP_ROOT\" \"$APP_ROOT/../README.md\" && git commit -m 'chore: bump to ${target_v}, build multi-arch and pin digests'"
  echo "  3. Push: git push"
fi
