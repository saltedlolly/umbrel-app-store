#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-npm-plus"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"
UPSTREAM_IMAGE="docker.io/zoeyvid/npmplus"
UPSTREAM_RELEASE_API="https://api.github.com/repos/ZoeyVid/NPMplus/releases"

MODE="check"
REQUESTED_VERSION=""
RELEASE_NOTES=""
UMBREL_DEV_HOST="${UMBREL_DEV_HOST:-192.168.215.2}"
UMBREL_USER="${UMBREL_USER:-umbrel}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Modes (choose one; default is --check):
  --check                 Check the current and latest upstream releases without editing files
  --update                Pin a release and update the local package
  --localtest             Update, validate, and copy the package to umbrel-dev
  --publish               Update, validate, commit only this app, and push the branch

Options:
  --version <tag>         Use a specific stable tag, for example 2026-07-24-r1
  --notes <text>          Release notes used in umbrel-app.yml and the release commit
  --host <host-or-ip>     umbrel-dev host for --localtest (default: $UMBREL_DEV_HOST)
  -h, --help              Show this help

Examples:
  $(basename "$0") --check
  $(basename "$0") --update --notes "Update NPMplus"
  $(basename "$0") --localtest --host umbrel-dev.local
  $(basename "$0") --publish --notes "Update NPMplus"
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

set_mode() {
  local requested="$1"
  if [[ "$MODE" != "check" && "$MODE" != "$requested" ]]; then
    fail "Choose only one of --check, --update, --localtest, or --publish"
  fi
  MODE="$requested"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      set_mode "check"
      shift
      ;;
    --update)
      set_mode "update"
      shift
      ;;
    --localtest)
      set_mode "localtest"
      shift
      ;;
    --publish)
      set_mode "publish"
      shift
      ;;
    --version)
      [[ $# -ge 2 ]] || fail "--version requires a value"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --notes)
      [[ $# -ge 2 ]] || fail "--notes requires a value"
      RELEASE_NOTES="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || fail "--host requires a value"
      UMBREL_DEV_HOST="$2"
      shift 2
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

require_command curl
require_command python3
require_command docker

current_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$MANIFEST_FILE"
}

fetch_release_json() {
  local tag="$1"
  if [[ -n "$tag" ]]; then
    curl -L --fail --silent --show-error "$UPSTREAM_RELEASE_API/tags/$tag"
  else
    curl -L --fail --silent --show-error "$UPSTREAM_RELEASE_API/latest"
  fi
}

resolve_release() {
  local release_json
  release_json="$(fetch_release_json "$REQUESTED_VERSION")"
  RELEASE_JSON="$release_json" python3 - <<'PY'
import json
import os

release = json.loads(os.environ["RELEASE_JSON"])
if release.get("draft") or release.get("prerelease"):
    raise SystemExit("Requested release is a draft or prerelease")
tag = release.get("tag_name", "")
if not tag:
    raise SystemExit("Release response did not contain tag_name")
print(tag)
PY
}

validate_release_tag() {
  local tag="$1"
  [[ "$tag" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-r[0-9]+$ ]] || \
    fail "Unsupported stable NPMplus tag format: $tag"
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

  python3 - "$COMPOSE_FILE" "$MANIFEST_FILE" "$tag" "$digest" "$notes" <<'PY'
from pathlib import Path
import re
import sys

compose_path = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
tag = sys.argv[3]
digest = sys.argv[4]
notes = sys.argv[5] or f"Update NPMplus to upstream release {tag}."

compose = compose_path.read_text()
image_pattern = re.compile(
    r"(image:\s*docker\.io/zoeyvid/npmplus:)[^@\s]+(@sha256:)[a-f0-9]{64}"
)
compose, count = image_pattern.subn(rf"\g<1>{tag}\g<2>{digest.removeprefix('sha256:')}", compose, count=1)
if count != 1:
    raise SystemExit("Could not update the NPMplus image reference in docker-compose.yml")
compose_path.write_text(compose)

manifest = manifest_path.read_text()
manifest, count = re.subn(
    r'^version:\s*"[^"]+"$',
    f'version: "{tag}"',
    manifest,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit("Could not update version in umbrel-app.yml")

release_block = (
    "releaseNotes: >-\n"
    f"  {notes}\n\n\n"
    f"  This package pins the immutable multi-architecture NPMplus {tag} image for amd64 and arm64.\n\n\n"
    f"  Full upstream release notes: https://github.com/ZoeyVid/NPMplus/releases/tag/{tag}\n\n"
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

validate_package() {
  echo "Validating package..."
  bash -n "$0"

  python3 - "$COMPOSE_FILE" "$MANIFEST_FILE" "$APP_ROOT/exports.sh" "$APP_ID" <<'PY'
from pathlib import Path
import re
import sys

compose = Path(sys.argv[1]).read_text()
manifest = Path(sys.argv[2]).read_text()
exports = Path(sys.argv[3]).read_text()
app_id = sys.argv[4]

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
for required in ("5181", "50080", "50443"):
    if f'="{required}"' not in exports:
        raise SystemExit(f"Missing required exported port: {required}")
if 'APP_SALTEDLOLLY_NPM_PLUS_HTTPS_PORT}:443/udp' not in compose:
    raise SystemExit("NPMplus HTTPS port is not published over UDP for HTTP/3")
PY

  local validation_override
  validation_override="$(mktemp)"
  printf '%s\n' 'services:' '  app_proxy:' '    image: docker.io/library/busybox:1.37.0' >"$validation_override"

  APP_DATA_DIR="$APP_ROOT" \
  APP_PASSWORD="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
  APP_SALTEDLOLLY_NPM_PLUS_COOKIE_SECRET="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" \
  APP_SALTEDLOLLY_NPM_PLUS_DATA_DIR="$APP_ROOT/data" \
  APP_SALTEDLOLLY_NPM_PLUS_ADMIN_PORT="5181" \
  APP_SALTEDLOLLY_NPM_PLUS_HTTP_PORT="50080" \
  APP_SALTEDLOLLY_NPM_PLUS_HTTPS_PORT="50443" \
  DEVICE_DOMAIN_NAME="umbrel.local" \
    docker compose -f "$COMPOSE_FILE" -f "$validation_override" config --quiet
  rm -f "$validation_override"

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
    --exclude='npmplus-build.sh' \
    --exclude='docker-compose.yml.backup.yml' \
    "$APP_ROOT/" \
    "$UMBREL_USER@$UMBREL_DEV_HOST:$store_dir/$APP_ID/"

  cat <<EOF

Package copied to umbrel-dev.

For a clean test, uninstall any existing test copy first, then install $APP_ID from
the App Store. Umbrel deletes test app data on uninstall, so never use this workflow
against the working Portainer installation or its volume.

Launcher:  http://$UMBREL_DEV_HOST:5180
Admin UI:  https://$UMBREL_DEV_HOST:5181
EOF
}

publish_package() {
  require_command git
  [[ -n "$RELEASE_NOTES" ]] || fail "--publish requires --notes"

  local staged_outside
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | \
    awk -v prefix="$APP_ID/" 'index($0, prefix) != 1 {print}')"
  [[ -z "$staged_outside" ]] || {
    echo "Already-staged files outside $APP_ID:" >&2
    echo "$staged_outside" >&2
    fail "Unstage unrelated files before publishing"
  }

  git -C "$STORE_ROOT" add -- "$APP_ROOT"
  git -C "$STORE_ROOT" diff --cached --quiet && fail "There are no NPMplus changes to publish"
  git -C "$STORE_ROOT" commit -m "release: NPMplus $TARGET_VERSION - $RELEASE_NOTES"
  git -C "$STORE_ROOT" push
  echo "Published NPMplus $TARGET_VERSION."
}

TARGET_VERSION="$(resolve_release)"
validate_release_tag "$TARGET_VERSION"
CURRENT_VERSION="$(current_version)"
TARGET_DIGEST="$(inspect_upstream_image "$TARGET_VERSION")"

echo
echo "Current package version: $CURRENT_VERSION"
echo "Target upstream version: $TARGET_VERSION"
echo "Target image digest:     $TARGET_DIGEST"
echo "Architectures:           linux/amd64, linux/arm64"
echo

if [[ "$MODE" == "check" ]]; then
  if [[ "$CURRENT_VERSION" == "$TARGET_VERSION" ]] && \
     grep -q "$UPSTREAM_IMAGE:$TARGET_VERSION@$TARGET_DIGEST" "$COMPOSE_FILE"; then
    echo "NPMplus is already pinned to the requested release and digest."
  else
    echo "An update or digest correction is available. Run with --update to prepare it."
  fi
  exit 0
fi

update_package "$TARGET_VERSION" "$TARGET_DIGEST" "$RELEASE_NOTES"
validate_package

case "$MODE" in
  update)
    echo "Updated the local NPMplus package. Review with: git diff -- $APP_ID"
    ;;
  localtest)
    deploy_localtest
    ;;
  publish)
    publish_package
    ;;
esac
