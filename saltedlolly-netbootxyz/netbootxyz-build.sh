#!/usr/bin/env bash
set -euo pipefail

# Track the latest netbootxyz/docker-netbootxyz release and pin
# docker-compose.yml to its multi-arch manifest digest. Version = the
# upstream tag verbatim (e.g. 0.7.6-nbxyz24) whenever the tag itself has
# changed. A local-only packaging fix (no upstream tag change) instead
# appends/increments a 4th number via --patch (e.g. 0.7.6-nbxyz24.1) so a
# genuine upstream bump can never look like a version decrease. Note: no
# rich upstream release notes are fetched here - docker-netbootxyz
# publishes zero GitHub releases (confirmed directly against its API), so
# there is no upstream notes source to pull from, unlike this store's
# other auto-release scripts.
#
# Like npmplus-build.sh, nothing to build here: the image is already
# public and multi-arch - no Dockerfile, no docker buildx build, no push,
# no registry login required.
#
# Unlike every other build script in this store, this upstream's release
# discovery uses the Docker Hub tags API, not a GitHub Releases API -
# netbootxyz/docker-netbootxyz's GitHub releases don't map 1:1 to its
# actual published image tags, so the registry itself is the source of
# truth here.
#
# Requirements:
# - Docker (for `docker buildx imagetools inspect`, no login needed - the
#   image is public)
# - macOS (BSD sed) or Linux (GNU sed)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-netbootxyz"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"
UPSTREAM_IMAGE="ghcr.io/netbootxyz/netbootxyz"
UPSTREAM_TAGS_API="https://hub.docker.com/v2/repositories/netbootxyz/netbootxyz/tags?page_size=100"

MODE="check"
REQUESTED_VERSION=""
FORCE_PATCH=false
RELEASE_NOTES=""
UMBREL_DEV_HOST="${UMBREL_DEV_HOST:-192.168.215.2}"
UMBREL_USER="${UMBREL_USER:-umbrel}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Modes (choose one; default is --check):
  --check                 Check the current and latest upstream releases without editing files
  --update                Pin a release and update the local package
  --localtest              Update, validate, and copy the package to umbrel-dev
  --publish                Update, validate, commit only this app, and push

Options:
  --version <tag>         Use a specific stable tag, for example 0.7.6-nbxyz24
  --patch                 Bump the local-only patch number (no upstream change) instead
                          of publishing the bare upstream tag as the app version
  --notes <text>          Release notes used in umbrel-app.yml and the release commit
  --host <host-or-ip>     umbrel-dev host for --localtest (default: $UMBREL_DEV_HOST)
  -h, --help              Show this help

Examples:
  $(basename "$0") --check
  $(basename "$0") --update --notes "Update netboot.xyz"
  $(basename "$0") --localtest --host umbrel-dev.local
  $(basename "$0") --publish --notes "Update netboot.xyz"
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

current_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$MANIFEST_FILE"
}

# Find the newest primary release tag (X.Y.Z-nbxyzNN) from Docker Hub,
# excluding `latest`, raw commit-SHA tags, and `pr-*` CI build tags.
resolve_latest_tag() {
  curl -sf "$UPSTREAM_TAGS_API" | python3 -c "
import json, re, sys

data = json.load(sys.stdin)
pattern = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+-nbxyz([0-9]+)\$')
best_tag, best_build = None, -1
for result in data['results']:
    name = result['name']
    match = pattern.match(name)
    if not match:
        continue
    build = int(match.group(1))
    if build > best_build:
        best_build, best_tag = build, name

if best_tag is None:
    sys.exit('Could not find a primary release tag matching X.Y.Z-nbxyzNN')
print(best_tag)
"
}

validate_release_tag() {
  local tag="$1"
  [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nbxyz[0-9]+$ ]] || \
    fail "Unsupported netboot.xyz tag format: $tag"
}

inspect_upstream_image() {
  local tag="$1"
  local inspection
  echo "Inspecting $UPSTREAM_IMAGE:$tag..." >&2
  inspection="$(docker buildx imagetools inspect "$UPSTREAM_IMAGE:$tag")"

  grep -q 'Platform:[[:space:]]*linux/amd64' <<<"$inspection" || \
    fail "$UPSTREAM_IMAGE:$tag does not publish linux/amd64"
  grep -q 'Platform:[[:space:]]*linux/arm64' <<<"$inspection" || \
    fail "$UPSTREAM_IMAGE:$tag does not publish linux/arm64"

  local digest
  digest="$(awk '/^Digest:/ {print $2; exit}' <<<"$inspection")"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail "Could not resolve the multi-architecture digest for $UPSTREAM_IMAGE:$tag"
  printf '%s\n' "$digest"
}

update_package() {
  local tag="$1"
  local digest="$2"
  local notes="$3"
  local target_version="$4"

  python3 - "$COMPOSE_FILE" "$MANIFEST_FILE" "$tag" "$digest" "$notes" "$target_version" <<'PY'
from pathlib import Path
import re
import sys

compose_path = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
tag = sys.argv[3]
digest = sys.argv[4]
notes = sys.argv[5] or f"Update netboot.xyz to upstream release {tag}."
target_version = sys.argv[6]

compose = compose_path.read_text()
image_pattern = re.compile(
    r"(image:\s*ghcr\.io/netbootxyz/netbootxyz:)[^@\s]+(@sha256:)[a-f0-9]{64}"
)
compose, count = image_pattern.subn(rf"\g<1>{tag}\g<2>{digest.removeprefix('sha256:')}", compose, count=1)
if count != 1:
    raise SystemExit("Could not update the netbootxyz image reference in docker-compose.yml")
compose_path.write_text(compose)

manifest = manifest_path.read_text()
manifest, count = re.subn(
    r'^version:\s*"[^"]+"$',
    f'version: "{target_version}"',
    manifest,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit("Could not update version in umbrel-app.yml")

# No upstream release-notes source exists for this app - docker-netbootxyz
# has zero GitHub releases (confirmed directly), which is exactly why
# version tracking uses Docker Hub tags instead. Notes stay a short
# manually/automatically-supplied bullet rather than fetched content.
release_block = (
    "releaseNotes: >-\n"
    f"  {target_version}:\n\n"
    f"  - {notes}\n\n"
)
manifest, count = re.subn(
    r"releaseNotes:\s*>-\n.*?\ndeveloper:",
    release_block + "developer:",
    manifest,
    count=1,
    flags=re.DOTALL,
)
if count != 1:
    raise SystemExit("Could not update releaseNotes in umbrel-app.yml")
manifest_path.write_text(manifest)
PY
}

update_readme_version() {
  local new_version="$1"
  local readme_file="$STORE_ROOT/README.md"
  local today
  today=$(date +%F)

  if [[ ! -f "$readme_file" ]]; then
    echo "⚠️  README.md not found at $readme_file, skipping README update"
    return
  fi

  python3 - "$readme_file" "$new_version" "$today" <<'PY'
from pathlib import Path
import re
import sys

readme_path = Path(sys.argv[1])
new_version = sys.argv[2]
today = sys.argv[3]

text = readme_path.read_text()

text = re.sub(
    r'(<td nowrap id="saltedlolly-netbootxyz-version"><code>)[^<]*(</code></td>)',
    rf"\g<1>{new_version}\g<2>",
    text,
    count=1,
)

text = re.sub(
    r'id="saltedlolly-netbootxyz-date">(\d{4}-\d{2}-\d{2})',
    f'id="saltedlolly-netbootxyz-date">{today}',
    text,
    count=1,
)

readme_path.write_text(text)
PY
  echo "✓ Updated README.md version to $new_version"
  echo "✓ Updated README.md release date to $today"
}

validate_package() {
  echo "Validating package..."
  bash -n "$0"

  python3 - "$COMPOSE_FILE" "$MANIFEST_FILE" "$APP_ID" <<'PY'
from pathlib import Path
import re
import sys

compose = Path(sys.argv[1]).read_text()
manifest = Path(sys.argv[2]).read_text()
app_id = sys.argv[3]

if not re.search(rf"^id:\s*{re.escape(app_id)}$", manifest, re.MULTILINE):
    raise SystemExit("Manifest ID does not match the app directory")
if re.search(r"^\s*image:.*:latest(?:@|\s|$)", compose, re.MULTILINE):
    raise SystemExit("Compose contains a latest image tag")
images = re.findall(r"^\s*image:\s*(\S+)", compose, re.MULTILINE)
if not images:
    raise SystemExit("Compose contains no runtime images")
for image in images:
    if not re.search(r":[^@\s]+@sha256:[a-f0-9]{64}$", image):
        raise SystemExit(f"Image is not pinned by tag and digest: {image}")
if "network_mode: host" not in compose:
    raise SystemExit("Expected network_mode: host (required for TFTP)")
if re.search(r"^\s*app_proxy:\s*$", compose, re.MULTILINE):
    raise SystemExit("app_proxy is not valid for a host-network app")
PY

  # No app_proxy service exists in this package (host-network apps can't
  # use it), so - unlike npmplus-build.sh's equivalent check - there's no
  # image-less stub service that needs an override to validate cleanly.
  APP_DATA_DIR="$APP_ROOT" \
  UMBREL_ROOT="$APP_ROOT" \
    docker compose -f "$COMPOSE_FILE" config --quiet

  git -C "$STORE_ROOT" diff --check -- "$APP_ID"
  echo "Package validation passed."
}

deploy_localtest() {
  require_command ssh
  require_command rsync

  echo "Checking access to $UMBREL_USER@$UMBREL_DEV_HOST..."
  ssh -o ConnectTimeout=5 "$UMBREL_USER@$UMBREL_DEV_HOST" "true" || \
    fail "Could not connect to umbrel-dev at $UMBREL_DEV_HOST"

  local store_dir
  store_dir="$(ssh "$UMBREL_USER@$UMBREL_DEV_HOST" \
    "find /home/umbrel/umbrel/app-stores -maxdepth 1 -type d -name 'getumbrel-umbrel-apps-github-*' -print | head -1")"
  [[ -n "$store_dir" ]] || fail "Could not find the official app-store directory on umbrel-dev"

  echo "Copying $APP_ID to $UMBREL_DEV_HOST..."
  rsync -av \
    --exclude='.DS_Store' \
    --exclude='README.md' \
    --exclude='netbootxyz-build.sh' \
    "$APP_ROOT/" \
    "$UMBREL_USER@$UMBREL_DEV_HOST:$store_dir/$APP_ID/"

  cat <<EOF

Package copied to umbrel-dev.

For a clean test, uninstall any existing test copy first, then install $APP_ID from
the App Store.

Web UI: http://$UMBREL_DEV_HOST:30380
Assets: http://$UMBREL_DEV_HOST:30480
TFTP:   $UMBREL_DEV_HOST:69/udp
EOF
}

publish_package() {
  require_command git
  [[ -n "$RELEASE_NOTES" ]] || fail "--publish requires --notes"

  local staged_outside
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | \
    awk -v prefix="$APP_ID/" 'index($0, prefix) != 1 && $0 != ".github/workflows/netbootxyz-auto-release.yml" && $0 != "README.md" {print}')"
  [[ -z "$staged_outside" ]] || {
    echo "Already-staged files outside $APP_ID, its workflow file, and README.md:" >&2
    echo "$staged_outside" >&2
    fail "Unstage unrelated files before publishing"
  }

  git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/.github/workflows/netbootxyz-auto-release.yml" "$STORE_ROOT/README.md"
  git -C "$STORE_ROOT" diff --cached --quiet && fail "There are no netboot.xyz changes to publish"
  git -C "$STORE_ROOT" commit -m "release: netboot.xyz $TARGET_VERSION - $RELEASE_NOTES"
  git -C "$STORE_ROOT" push
  echo "Published netboot.xyz $TARGET_VERSION."
}

########################################
# Parse arguments
########################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --update) MODE="update"; shift ;;
    --localtest) MODE="localtest"; shift ;;
    --publish) MODE="publish"; shift ;;
    --version) REQUESTED_VERSION="$2"; shift 2 ;;
    --patch) FORCE_PATCH=true; shift ;;
    --notes) RELEASE_NOTES="$2"; shift 2 ;;
    --host) UMBREL_DEV_HOST="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

require_command curl
require_command python3
require_command docker

TARGET_TAG="${REQUESTED_VERSION:-$(resolve_latest_tag)}"
validate_release_tag "$TARGET_TAG"
CURRENT_VERSION="$(current_version)"

# CURRENT_VERSION may be the bare upstream tag (no local patch yet) or that
# tag with an appended .N (a prior local-only packaging fix).
if [[ "$CURRENT_VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+-nbxyz[0-9]+)\.([0-9]+)$ ]]; then
  CURRENT_TAG="${BASH_REMATCH[1]}"
  CURRENT_PATCH="${BASH_REMATCH[2]}"
else
  CURRENT_TAG="$CURRENT_VERSION"
  CURRENT_PATCH="0"
fi

if [[ "$TARGET_TAG" != "$CURRENT_TAG" ]]; then
  TARGET_VERSION="$TARGET_TAG"
elif [[ "$FORCE_PATCH" == "true" ]]; then
  TARGET_VERSION="${TARGET_TAG}.$((CURRENT_PATCH + 1))"
else
  TARGET_VERSION="$CURRENT_VERSION"
fi

TARGET_DIGEST="$(inspect_upstream_image "$TARGET_TAG")"

echo
echo "Current package version: $CURRENT_VERSION"
echo "Target upstream version: $TARGET_TAG"
echo "Resulting version:       $TARGET_VERSION"
echo "Target image digest:     $TARGET_DIGEST"
echo "Architectures:           linux/amd64, linux/arm64"
echo

if [[ "$MODE" == "check" ]]; then
  if [[ "$CURRENT_VERSION" == "$TARGET_VERSION" ]] && \
     grep -q "$UPSTREAM_IMAGE:$TARGET_TAG@$TARGET_DIGEST" "$COMPOSE_FILE"; then
    echo "netboot.xyz is already pinned to the requested release and digest."
  else
    echo "An update or digest correction is available. Run with --update to prepare it."
  fi
  exit 0
fi

if [[ "$CURRENT_VERSION" == "$TARGET_VERSION" ]]; then
  echo "Nothing to update (pass --patch to publish a local-only packaging fix)."
  exit 0
fi

update_package "$TARGET_TAG" "$TARGET_DIGEST" "$RELEASE_NOTES" "$TARGET_VERSION"
update_readme_version "$TARGET_VERSION"
validate_package

case "$MODE" in
  update)
    echo "Updated the local netboot.xyz package. Review with: git diff -- $APP_ID"
    ;;
  localtest)
    deploy_localtest
    ;;
  publish)
    publish_package
    ;;
esac
