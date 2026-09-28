#!/usr/bin/env bash
set -euo pipefail

# Build and push multi-arch images for NPMplus launcher and wrapper, then pin
# compose to new manifest digests. Auto-bump umbrel-app.yml version (unless
# overridden), tag images to match, and manage release notes.
#
# Version scheme: matches upstream zoeyvid/npmplus version (e.g., 2026-07-24-r1)
# when there's no packaging-only patch. A 4th number (starting at .1) appears
# for local-only fixes (launcher UI change, config tweak, etc.) - use --bump.
#
# Requirements:
# - Docker Buildx with docker-container driver for multi-platform support
# - Logged in to GHCR (ghcr.io) for `saltedlolly/*`:
#     docker login ghcr.io -u saltedlolly
#   using a GitHub Personal Access Token with packages:write scope
# - macOS (BSD sed) or Linux (GNU sed)
#
# Usage examples:
#   ./npmplus-build.sh --bump --notes "Fix launcher UI bug" --publish
#     # Local packaging patch: increments .N, updates files, commits, pushes
#
#   ./npmplus-build.sh --version 2026-07-24-r2 --notes "Update upstream" --publish
#     # Explicit version (upstream update): resets to bare version
#
#   ./npmplus-build.sh --bump --localtest
#     # Build and deploy to local umbrel-dev for testing

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-npm-plus"

# Image hosting: GitHub Container Registry
LAUNCHER_IMAGE="ghcr.io/saltedlolly/npmplus-launcher"
WRAPPER_IMAGE="ghcr.io/saltedlolly/npmplus-wrapper"

# Upstream NPMplus Docker image
UPSTREAM_IMAGE="docker.io/zoeyvid/npmplus"

# File paths
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"

# Release notes marker - everything below this is auto-generated
RELEASE_NOTES_MARKER="--- zoeyvid/npmplus upstream release notes (auto-updated) ---"

# Defaults
SET_VERSION=""
RELEASE_NOTES=""
LOCAL_TEST=false
PUBLISH_TO_GITHUB=false
FORCE_BUMP=false
UMBREL_DEV_HOST="${UMBREL_DEV_HOST:-192.168.215.2}"
UMBREL_USER="${UMBREL_USER:-umbrel}"

is_macos=false
if [[ "${OSTYPE:-}" == darwin* ]]; then is_macos=true; fi

usage() {
  cat >&2 <<EOF
Usage: $0 [OPTIONS]

Options:
  -h, --help              : Show this help message
  --version <X-Y-Z-rN[.L]>: Set explicit version (e.g., 2026-07-24-r1 or 2026-07-24-r1.1)
  --bump                  : Publish a local-only fix (upstream unchanged) - appends/
                            increments a 4th version number (.1, .2, etc.)
  --notes <text>          : Release notes (required for --publish or --bump)
  --localtest             : Build and deploy to local umbrel-dev ($UMBREL_DEV_HOST)
  --publish               : Build, push to GHCR, update files, commit, and push to GitHub

Version numbering: X-Y-Z-rN when matching upstream exactly, or X-Y-Z-rN.L for
a local-only fix (L starts at 1, resets to bare version on next upstream update).

Default mode (no flags): Check current version and show what would be built.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

# Extract current app version from umbrel-app.yml
current_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$MANIFEST_FILE"
}

# Extract upstream NPMplus version from wrapper Dockerfile
extract_upstream_version() {
  grep -o "$UPSTREAM_IMAGE:[0-9-]*-r[0-9]*" "$APP_ROOT/npmplus/Dockerfile" | cut -d':' -f2 | head -1
}

# Update wrapper Dockerfile with new upstream version
update_upstream_version() {
  local new_version="$1"
  echo "Updating wrapper Dockerfile to use $UPSTREAM_IMAGE:$new_version..."
  if $is_macos; then
    sed -i '' "s|$UPSTREAM_IMAGE:[0-9-]*-r[0-9]*|$UPSTREAM_IMAGE:$new_version|" "$APP_ROOT/npmplus/Dockerfile"
  else
    sed -i "s|$UPSTREAM_IMAGE:[0-9-]*-r[0-9]*|$UPSTREAM_IMAGE:$new_version|" "$APP_ROOT/npmplus/Dockerfile"
  fi
  echo "✓ Updated Dockerfile to $UPSTREAM_IMAGE:$new_version"
}

# Check latest upstream NPMplus release
check_upstream_version() {
  echo "Checking zoeyvid/npmplus upstream version..."
  local latest
  latest=$(curl -s "https://api.github.com/repos/ZoeyVid/NPMplus/releases/latest" | \
    grep -o '"tag_name": "[^"]*' | cut -d'"' -f4)

  if [[ -z "$latest" ]]; then
    echo "⚠️  Could not fetch latest version from GitHub"
    return
  fi

  local current_upstream=$(extract_upstream_version)
  echo "Current upstream version: $current_upstream"
  echo "Latest upstream version:  $latest"

  if [[ "$current_upstream" != "$latest" ]]; then
    echo "ℹ️  Upstream update available: $current_upstream → $latest"
  else
    echo "✓ Already on latest upstream"
  fi
}

# Set version in umbrel-app.yml
set_version_in_manifest() {
  local newv="$1"
  if $is_macos; then
    sed -E -i '' "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$MANIFEST_FILE"
  else
    sed -E -i "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$MANIFEST_FILE"
  fi
}

# Update app store README.md with version and date
update_readme_version() {
  local new_version="$1"
  local README_FILE="$STORE_ROOT/README.md"
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
    r'(<td nowrap id="saltedlolly-npm-plus-version"><code>)[^<]*(</code></td>)',
    rf"\g<1>{new_version}\g<2>",
    text,
    count=1,
)

text = re.sub(
    r'id="saltedlolly-npm-plus-date">(\d{4}-\d{2}-\d{2})',
    f'id="saltedlolly-npm-plus-date">{today}',
    text,
    count=1,
)

readme_path.write_text(text)
PY
  echo "✓ Updated README.md version to $new_version"
  echo "✓ Updated README.md release date to $today"
}

# Prepend new release notes section
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
  echo "Prepending release notes for $newv..."
  awk -v ver="$newv" -v msg="$notes" '
    BEGIN{inserted=0}
    /^releaseNotes:[[:space:]]*>-/ {
      if (!inserted) {
        print; print "  ## " ver "\n\n  - " msg "\n"; inserted=1; next
      }
    }
    {print}
  ' "$MANIFEST_FILE" > "$MANIFEST_FILE.tmp"
  mv "$MANIFEST_FILE.tmp" "$MANIFEST_FILE"
  echo "✓ Prepended release notes"
}

# Update auto-generated upstream release notes
update_release_notes() {
  local target_tag="$1"
  echo "Fetching zoeyvid/npmplus release notes for $target_tag..."
  local releases_file
  releases_file="$(mktemp)"
  if ! curl -sf "https://api.github.com/repos/ZoeyVid/NPMplus/releases?per_page=10" -o "$releases_file"; then
    echo "⚠️  Could not fetch upstream release notes, leaving as-is"
    rm -f "$releases_file"
    return
  fi

  python3 - "$MANIFEST_FILE" "$target_tag" "$RELEASE_NOTES_MARKER" "$releases_file" "zoeyvid/npmplus" <<'PY'
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
    sys.exit(f"Could not find release {target_tag}")


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
    sys.exit("Could not find releaseNotes block")

existing_block = m.group(1)
if marker in existing_block:
    manual_part = existing_block.split(marker, 1)[0].rstrip("\n")
else:
    manual_part = existing_block.rstrip("\n")

new_block = (manual_part.rstrip() + "\n\n\n" if manual_part.strip() else "") + f"  {marker}\n\n\n" + upstream_block + "\n\n"
new_text = text[: m.start(1)] + new_block + text[m.end(1) :]
manifest_path.write_text(new_text)
print(f"✓ Updated upstream release notes")
PY
  rm -f "$releases_file"
}

# Git sync pre-flight check - prevents pushing to stale branch
check_git_sync() {
  echo "Checking repository sync status..."

  # 1. Check for uncommitted changes
  if ! git -C "$STORE_ROOT" diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes"
    echo "Commit or stash them first, then try again"
    exit 1
  fi

  # 2. Fetch remote state (quietly)
  git -C "$STORE_ROOT" fetch origin >/dev/null 2>&1

  # 3. Get current branch
  local current_branch=$(git -C "$STORE_ROOT" rev-parse --abbrev-ref HEAD)

  # 4. Check if behind remote
  local behind=$(git -C "$STORE_ROOT" rev-list HEAD..origin/$current_branch --count 2>/dev/null || echo "0")
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
  local ahead=$(git -C "$STORE_ROOT" rev-list origin/$current_branch..HEAD --count 2>/dev/null || echo "0")
  if [[ "$ahead" -gt 0 ]]; then
    echo "ℹ️  Note: You have $ahead unpushed commit(s)"
  fi

  echo "✓ Repository is in sync with origin/$current_branch"
}

# Build launcher image
build_launcher() {
  local version="$1"
  echo ""
  echo "========================================="
  echo "Building Launcher Image"
  echo "========================================="
  echo "Version: $version"
  echo "Platforms: linux/amd64,linux/arm64"

  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "${LAUNCHER_IMAGE}:${version}" \
    --build-arg "APP_VERSION=${version}" \
    --label "org.opencontainers.image.source=https://github.com/saltedlolly/umbrel-app-store" \
    --label "org.opencontainers.image.description=NPMplus launcher - configuration UI" \
    --push \
    "$APP_ROOT/launcher"

  echo ""
  echo "Fetching launcher manifest digest..."
  local digest
  digest=$(docker buildx imagetools inspect "${LAUNCHER_IMAGE}:${version}" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$digest" ]]; then
    fail "Failed to obtain launcher digest"
  fi
  echo "Launcher digest: $digest"
  LAUNCHER_DIGEST="$digest"
}

# Build wrapper image
build_wrapper() {
  local version="$1"
  echo ""
  echo "========================================="
  echo "Building Wrapper Image"
  echo "========================================="
  echo "Version: $version"
  echo "Platforms: linux/amd64,linux/arm64"

  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "${WRAPPER_IMAGE}:${version}" \
    --label "org.opencontainers.image.source=https://github.com/saltedlolly/umbrel-app-store" \
    --label "org.opencontainers.image.description=NPMplus wrapper - integration framework" \
    --push \
    "$APP_ROOT/npmplus"

  echo ""
  echo "Fetching wrapper manifest digest..."
  local digest
  digest=$(docker buildx imagetools inspect "${WRAPPER_IMAGE}:${version}" 2>/dev/null | grep "^Digest:" | awk '{print $2}')
  if [[ -z "$digest" ]]; then
    fail "Failed to obtain wrapper digest"
  fi
  echo "Wrapper digest: $digest"
  WRAPPER_DIGEST="$digest"
}

# Update docker-compose.yml with new digests
update_compose_digests() {
  local launcher_digest="$1"
  local wrapper_digest="$2"

  echo "Updating docker-compose.yml with new digests..."

  # Update launcher image reference
  if $is_macos; then
    sed -E -i '' "s|image: ${LAUNCHER_IMAGE}@sha256:[a-f0-9]{64}|image: ${LAUNCHER_IMAGE}@${launcher_digest}|" "$COMPOSE_FILE"
  else
    sed -E -i "s|image: ${LAUNCHER_IMAGE}@sha256:[a-f0-9]{64}|image: ${LAUNCHER_IMAGE}@${launcher_digest}|" "$COMPOSE_FILE"
  fi

  # Update wrapper image reference
  if $is_macos; then
    sed -E -i '' "s|image: ${WRAPPER_IMAGE}@sha256:[a-f0-9]{64}|image: ${WRAPPER_IMAGE}@${wrapper_digest}|" "$COMPOSE_FILE"
  else
    sed -E -i "s|image: ${WRAPPER_IMAGE}@sha256:[a-f0-9]{64}|image: ${WRAPPER_IMAGE}@${wrapper_digest}|" "$COMPOSE_FILE"
  fi

  echo "✓ Updated docker-compose.yml"
}

# Ensure Docker Buildx is set up
ensure_buildx() {
  # Inspect by name: `docker buildx ls` exits non-zero if any other builder is
  # unreachable (e.g. OrbStack stopped), which breaks a `ls | grep` under pipefail
  if ! docker buildx inspect multi-platform-builder >/dev/null 2>&1; then
    echo "Creating multi-platform-builder..."
    docker buildx create --driver docker-container \
      --platform linux/amd64,linux/arm64 \
      --name multi-platform-builder \
      --use
    docker buildx inspect --bootstrap
  else
    docker buildx use multi-platform-builder
    echo "✓ Using existing multi-platform-builder"
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || fail "--version requires a value"
      SET_VERSION="$2"
      shift 2
      ;;
    --bump)
      FORCE_BUMP=true
      shift
      ;;
    --notes)
      [[ $# -ge 2 ]] || fail "--notes requires a value"
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

# Require dependencies
require_command curl
require_command python3
require_command docker
require_command git
require_command awk

# Main execution
echo ""
echo "========================================="
echo "NPMplus Build Script (Pattern A)"
echo "========================================="

# Determine target version
CURRENT_VERSION=$(current_version)
UPSTREAM_VERSION=$(extract_upstream_version)

echo "Current app version: $CURRENT_VERSION"
echo "Current upstream:    $UPSTREAM_VERSION"
echo ""

# Version determination logic
if [[ -n "$SET_VERSION" ]]; then
  # Explicit version provided
  TARGET_VERSION="$SET_VERSION"
  echo "Using explicit version: $TARGET_VERSION"
elif [[ "$FORCE_BUMP" == "true" ]]; then
  # Local patch: increment .N or add .1
  if [[ "$CURRENT_VERSION" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}-r[0-9]+)\.([0-9]+)$ ]]; then
    # Already has .N, increment it
    BASE_VERSION="${BASH_REMATCH[1]}"
    LOCAL_PATCH="${BASH_REMATCH[2]}"
    NEW_PATCH=$((LOCAL_PATCH + 1))
    TARGET_VERSION="${BASE_VERSION}.${NEW_PATCH}"
  elif [[ "$CURRENT_VERSION" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-r[0-9]+$ ]]; then
    # Bare version, add .1
    TARGET_VERSION="${CURRENT_VERSION}.1"
  else
    fail "Cannot parse current version: $CURRENT_VERSION"
  fi
  echo "Bumping local patch: $CURRENT_VERSION → $TARGET_VERSION"
else
  # Check mode: show what's available
  check_upstream_version
  echo ""
  echo "No --version or --bump specified. Exiting."
  echo ""
  echo "To build:"
  echo "  • For upstream update: ./npmplus-build.sh --version $UPSTREAM_VERSION --notes \"...\" --publish"
  echo "  • For local patch:     ./npmplus-build.sh --bump --notes \"...\" --publish"
  exit 0
fi

# Validate release notes
if [[ "$PUBLISH_TO_GITHUB" == "true" ]] || [[ "$FORCE_BUMP" == "true" ]]; then
  if [[ -z "$RELEASE_NOTES" ]]; then
    fail "--publish or --bump requires --notes"
  fi
fi

# Git sync check (before building)
if [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  check_git_sync
  echo ""
fi

# Ensure buildx is ready
ensure_buildx
echo ""

# Build images
build_launcher "$TARGET_VERSION"
build_wrapper "$TARGET_VERSION"

# Update files
echo ""
echo "========================================="
echo "Updating Package Files"
echo "========================================="

set_version_in_manifest "$TARGET_VERSION"
update_readme_version "$TARGET_VERSION"
update_compose_digests "$LAUNCHER_DIGEST" "$WRAPPER_DIGEST"

if [[ "$FORCE_BUMP" == "true" ]] || [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  # A bare version (no .N) is a new upstream release: notes start afresh
  if [[ "$TARGET_VERSION" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-r[0-9]+$ ]]; then
    reset_release_notes "$MANIFEST_FILE" "$TARGET_VERSION" "$RELEASE_NOTES"
  else
    prepend_release_notes "$TARGET_VERSION" "$RELEASE_NOTES"
  fi
fi

# Update upstream release notes if this is a bare version (upstream update)
if [[ "$TARGET_VERSION" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-r[0-9]+$ ]]; then
  update_release_notes "$TARGET_VERSION"
fi

echo ""
echo "✓ Package files updated"

# Publish to GitHub
if [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  echo ""
  echo "========================================="
  echo "Publishing to GitHub"
  echo "========================================="

  git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/README.md"

  git -C "$STORE_ROOT" commit -m "$(cat <<EOF
release: NPMplus ${TARGET_VERSION}

${RELEASE_NOTES}

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SGgVTea3S5kqngpPgj6HfG
EOF
)"

  git -C "$STORE_ROOT" push

  echo "✓ Committed and pushed to GitHub"
fi

# Summary
echo ""
echo "========================================="
echo "Build Complete"
echo "========================================="
echo "Version:          $TARGET_VERSION"
echo "Launcher digest:  $LAUNCHER_DIGEST"
echo "Wrapper digest:   $WRAPPER_DIGEST"
echo ""

if [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  echo "✓ Published to GitHub"
elif [[ "$LOCAL_TEST" == "true" ]]; then
  echo "ℹ️  Local test mode - files updated but not committed"
else
  echo "ℹ️  Files updated locally. To publish:"
  echo "   git add -- \"$APP_ROOT\" \"$STORE_ROOT/README.md\" && git commit && git push"
fi

echo ""
echo "Done!"
