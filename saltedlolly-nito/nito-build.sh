#!/usr/bin/env bash
set -euo pipefail

# Two independently-tracked images, both built externally (this script
# only ever pins, never builds):
#
# - Nito-Tools/docker-nito (the compiled node): built and published by its
#   own repo's CI. Resolved and pinned here the same "pin an
#   externally-built image" way changedetection-build.sh / kubo-build.sh
#   pin their own upstream images.
#
# - ghcr.io/saltedlolly/nito-dashboard (the dashboard): built and pushed by
#   this store's own nito-dashboard-build.yml workflow, triggered when
#   docker-containers/nito-dashboard changes. That workflow builds via a
#   GitHub Actions-issued token (no local GHCR login, no standing
#   credential on any machine, and every published image traces back to
#   an exact committed source revision) and then calls this script with
#   --dashboard-tag/--dashboard-digest already resolved, the same way
#   changedetection-auto-release.yml/kubo-auto-release.yml pass an
#   already-resolved version into their own build scripts rather than
#   having the script re-discover it.
#
# Manifest version = "<nito-core tag>.<patch>": a docker-nito bump resets
# the trailing patch to 0; a dashboard-only update increments it instead,
# matching changedetection-build.sh's dual-tracking scheme.
#
# Requirements:
# - Docker (for `docker buildx imagetools inspect`, no login needed - both
#   images are public)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-nito"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"

NITO_CORE_RELEASES_API="https://api.github.com/repos/NitoNetwork/Nito-core/releases"
NITO_IMAGE="ghcr.io/nito-tools/docker-nito"
DASHBOARD_IMAGE="ghcr.io/saltedlolly/nito-dashboard"

MODE="check"
REQUESTED_NITO_VERSION=""
DASHBOARD_TAG=""
DASHBOARD_DIGEST=""
RELEASE_NOTES=""
UMBREL_DEV_HOST="${UMBREL_DEV_HOST:-192.168.215.2}"
UMBREL_USER="${UMBREL_USER:-umbrel}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Modes (choose one; default is --check):
  --check                 Check for a newer docker-nito release without editing files
  --update                Pin as needed and update the local package
  --localtest              Update, validate, and copy the package to umbrel-dev
  --publish                Update, validate, commit only this app, and push

Options:
  --nito-version <tag>       Use a specific Nito-core tag, for example v3.0.1
  --dashboard-tag <tag>      Pin nito-dashboard to this tag (used by CI - see nito-dashboard-build.yml)
  --dashboard-digest <sha>   The matching digest for --dashboard-tag (sha256:...)
  --notes <text>             Release notes used in umbrel-app.yml and the release commit
  --host <host-or-ip>        umbrel-dev host for --localtest (default: $UMBREL_DEV_HOST)
  -h, --help                 Show this help
EOF
}

fail() { echo "Error: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"; }

current_manifest_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$MANIFEST_FILE"
}

current_pinned_tag() {
  local image="$1"
  grep -oE "${image}:[^@[:space:]]+" "$COMPOSE_FILE" | head -1 | cut -d: -f2
}

resolve_latest_nito_core_tag() {
  curl -sf "$NITO_CORE_RELEASES_API?per_page=20" | python3 -c "
import json, re, sys
data = json.load(sys.stdin)
pattern = re.compile(r'^v[0-9]+\.[0-9]+\.[0-9]+\$')
candidates = [r for r in data if not r['draft'] and not r['prerelease'] and pattern.match(r['tag_name'])]
if not candidates:
    sys.exit('Could not find a Nito-core release tag matching vX.Y.Z')
candidates.sort(key=lambda r: r['published_at'])
print(candidates[-1]['tag_name'])
"
}

inspect_image_digest() {
  local image="$1" tag="$2"
  local inspection
  echo "Inspecting $image:$tag..." >&2
  inspection="$(docker buildx imagetools inspect "$image:$tag")"
  grep -q 'Platform:[[:space:]]*linux/amd64' <<<"$inspection" || fail "$image:$tag does not publish linux/amd64"
  grep -q 'Platform:[[:space:]]*linux/arm64' <<<"$inspection" || fail "$image:$tag does not publish linux/arm64"
  local digest
  digest="$(awk '/^Digest:/ {print $2; exit}' <<<"$inspection")"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "Could not resolve the multi-architecture digest for $image:$tag"
  printf '%s\n' "$digest"
}

update_compose_image() {
  local image="$1" tag="$2" digest="$3"
  python3 - "$COMPOSE_FILE" "$image" "$tag" "$digest" <<'PY'
from pathlib import Path
import re
import sys

compose_path = Path(sys.argv[1])
image, tag, digest = sys.argv[2], sys.argv[3], sys.argv[4]

compose = compose_path.read_text()
# Matches either a real pin (tag@sha256:...) or the initial PENDING placeholder.
regex = re.compile(re.escape(f"image: {image}:") + r"(?:[^@\s]+@sha256:[a-f0-9]{64}|PENDING@sha256:PENDING)")
compose, count = regex.subn(f"image: {image}:{tag}@{digest}", compose, count=1)
if count != 1:
    raise SystemExit(f"Could not update the {image} image reference in docker-compose.yml")
compose_path.write_text(compose)
PY
}

update_manifest_version_and_notes() {
  local new_version="$1" notes="$2"
  python3 - "$MANIFEST_FILE" "$new_version" "$notes" <<'PY'
from pathlib import Path
import re
import sys

manifest_path = Path(sys.argv[1])
new_version, notes = sys.argv[2], sys.argv[3]

manifest = manifest_path.read_text()
manifest, count = re.subn(r'^version:\s*"[^"]+"$', f'version: "{new_version}"', manifest, count=1, flags=re.MULTILINE)
if count != 1:
    raise SystemExit("Could not update version in umbrel-app.yml")

release_block = f"releaseNotes: >-\n  {new_version}:\n\n  - {notes}\n\n"
manifest, count = re.subn(r"releaseNotes:\s*>-\n.*?\ndeveloper:", release_block + "developer:", manifest, count=1, flags=re.DOTALL)
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
  [[ -f "$readme_file" ]] || { echo "⚠️  README.md not found, skipping"; return; }
  python3 - "$readme_file" "$new_version" "$today" <<'PY'
from pathlib import Path
import re
import sys

readme_path = Path(sys.argv[1])
new_version, today = sys.argv[2], sys.argv[3]
text = readme_path.read_text()
text = re.sub(r'(<td nowrap id="saltedlolly-nito-version"><code>)[^<]*(</code></td>)', rf"\g<1>{new_version}\g<2>", text, count=1)
text = re.sub(r'id="saltedlolly-nito-date">(\d{4}-\d{2}-\d{2})', f'id="saltedlolly-nito-date">{today}', text, count=1)
readme_path.write_text(text)
PY
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
    if "PENDING" in image:
        raise SystemExit(f"Image still has a PENDING placeholder: {image}")
    if not re.search(r":[^@\s]+@sha256:[a-f0-9]{64}$", image):
        raise SystemExit(f"Image is not pinned by tag and digest: {image}")
if not re.search(r'^\s*-\s*"8820:8820/tcp"', compose, re.MULTILINE):
    raise SystemExit("Expected the swarm P2P port (8820 tcp) to be published")
if re.search(r"^\s*-\s*[\"']?8825:", compose, re.MULTILINE):
    raise SystemExit("The RPC port (8825) must not be published directly")
PY

  local validation_override
  validation_override="$(mktemp)"
  printf '%s\n' 'services:' '  app_proxy:' '    image: docker.io/library/busybox:1.37.0' >"$validation_override"
  APP_DATA_DIR="$APP_ROOT" UMBREL_ROOT="$APP_ROOT" NETWORK_IP="10.21.0.0" \
    docker compose -f "$COMPOSE_FILE" -f "$validation_override" config --quiet
  rm -f "$validation_override"

  git -C "$STORE_ROOT" diff --check -- "$APP_ID"
  echo "Package validation passed."
}

deploy_localtest() {
  require_command ssh; require_command rsync
  ssh -o ConnectTimeout=5 "$UMBREL_USER@$UMBREL_DEV_HOST" "true" || fail "Could not connect to umbrel-dev at $UMBREL_DEV_HOST"
  local store_dir
  store_dir="$(ssh "$UMBREL_USER@$UMBREL_DEV_HOST" "find /home/umbrel/umbrel/app-stores -maxdepth 1 -type d -name 'getumbrel-umbrel-apps-github-*' -print | head -1")"
  [[ -n "$store_dir" ]] || fail "Could not find the official app-store directory on umbrel-dev"
  rsync -av --exclude='.DS_Store' --exclude='README.md' --exclude='nito-build.sh' \
    "$APP_ROOT/" "$UMBREL_USER@$UMBREL_DEV_HOST:$store_dir/$APP_ID/"
  echo "Copied $APP_ID to $UMBREL_DEV_HOST. Dashboard: http://$UMBREL_DEV_HOST:3000  Swarm: $UMBREL_DEV_HOST:8820"
}

publish_package() {
  require_command git
  [[ -n "$RELEASE_NOTES" ]] || fail "--publish requires --notes"
  local staged_outside
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | \
    awk -v prefix="$APP_ID/" 'index($0, prefix) != 1 && $0 != "README.md" {print}')"
  [[ -z "$staged_outside" ]] || fail "Unstage unrelated files before publishing: $staged_outside"
  git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/README.md"
  git -C "$STORE_ROOT" diff --cached --quiet && fail "There are no Nito changes to publish"
  git -C "$STORE_ROOT" commit -m "release: Nito $TARGET_MANIFEST_VERSION - $RELEASE_NOTES"
  git -C "$STORE_ROOT" push
  echo "Published Nito $TARGET_MANIFEST_VERSION."
}

########################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --update) MODE="update"; shift ;;
    --localtest) MODE="localtest"; shift ;;
    --publish) MODE="publish"; shift ;;
    --nito-version) REQUESTED_NITO_VERSION="$2"; shift 2 ;;
    --dashboard-tag) DASHBOARD_TAG="$2"; shift 2 ;;
    --dashboard-digest) DASHBOARD_DIGEST="$2"; shift 2 ;;
    --notes) RELEASE_NOTES="$2"; shift 2 ;;
    --host) UMBREL_DEV_HOST="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[[ -z "$DASHBOARD_TAG" && -n "$DASHBOARD_DIGEST" ]] && fail "--dashboard-digest requires --dashboard-tag"
[[ -n "$DASHBOARD_TAG" && -z "$DASHBOARD_DIGEST" ]] && fail "--dashboard-tag requires --dashboard-digest"

require_command curl; require_command python3; require_command docker

CURRENT_MANIFEST_VERSION="$(current_manifest_version)"
CURRENT_NITO_TAG="$(current_pinned_tag "$NITO_IMAGE")"

if [[ -n "$DASHBOARD_TAG" && -z "$REQUESTED_NITO_VERSION" ]]; then
  # A dashboard-only CI call (nito-dashboard-build.yml) must not also
  # silently fast-track a docker-nito bump with no adoption buffer just
  # because a newer Nito-core release happens to exist at the same
  # moment - that's a separate concern with its own buffered workflow.
  # Only check/update the docker-nito pin here when explicitly asked to
  # (--nito-version), or when running as a plain check/update with no
  # dashboard flags at all.
  TARGET_NITO_TAG="$CURRENT_NITO_TAG"
else
  TARGET_NITO_TAG="${REQUESTED_NITO_VERSION:-$(resolve_latest_nito_core_tag)}"
fi
[[ "$TARGET_NITO_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unsupported Nito-core tag format: $TARGET_NITO_TAG"
NITO_CHANGED="false"; [[ "$TARGET_NITO_TAG" != "$CURRENT_NITO_TAG" ]] && NITO_CHANGED="true"

# Dashboard changes are only ever known because nito-dashboard-build.yml
# just built one and told us via --dashboard-tag/--dashboard-digest - this
# script has no way to detect a dashboard source change on its own, since
# building it is deliberately not this script's job any more.
DASHBOARD_CHANGED="false"; [[ -n "$DASHBOARD_TAG" ]] && DASHBOARD_CHANGED="true"

if [[ "$NITO_CHANGED" == "true" ]]; then
  TARGET_MANIFEST_VERSION="${TARGET_NITO_TAG}.0"
elif [[ "$DASHBOARD_CHANGED" == "true" ]]; then
  patch="${CURRENT_MANIFEST_VERSION##*.}"
  TARGET_MANIFEST_VERSION="${CURRENT_MANIFEST_VERSION%.*}.$((patch + 1))"
else
  TARGET_MANIFEST_VERSION="$CURRENT_MANIFEST_VERSION"
fi

echo
echo "Current manifest version:   $CURRENT_MANIFEST_VERSION"
echo "Current docker-nito tag:    $CURRENT_NITO_TAG"
echo "Target docker-nito tag:     $TARGET_NITO_TAG (changed: $NITO_CHANGED)"
echo "Dashboard pin requested:    ${DASHBOARD_TAG:-none} (changed: $DASHBOARD_CHANGED)"
echo "Resulting manifest version: $TARGET_MANIFEST_VERSION"
echo

if [[ "$MODE" == "check" ]]; then
  if [[ "$NITO_CHANGED" == "false" && "$DASHBOARD_CHANGED" == "false" ]]; then
    echo "Nothing to update."
  else
    echo "An update is available. Run with --update to prepare it."
  fi
  exit 0
fi

if [[ "$NITO_CHANGED" == "true" ]]; then
  NITO_DIGEST="$(inspect_image_digest "$NITO_IMAGE" "$TARGET_NITO_TAG")"
  update_compose_image "$NITO_IMAGE" "$TARGET_NITO_TAG" "$NITO_DIGEST"
fi

if [[ "$DASHBOARD_CHANGED" == "true" ]]; then
  update_compose_image "$DASHBOARD_IMAGE" "$DASHBOARD_TAG" "$DASHBOARD_DIGEST"
fi

if [[ -z "$RELEASE_NOTES" ]]; then
  if [[ "$NITO_CHANGED" == "true" ]]; then
    RELEASE_NOTES="Update to Nito-core $TARGET_NITO_TAG."
  elif [[ "$DASHBOARD_CHANGED" == "true" ]]; then
    RELEASE_NOTES="Update the dashboard."
  fi
fi

if [[ "$NITO_CHANGED" == "true" || "$DASHBOARD_CHANGED" == "true" ]]; then
  update_manifest_version_and_notes "$TARGET_MANIFEST_VERSION" "$RELEASE_NOTES"
  update_readme_version "$TARGET_MANIFEST_VERSION"
fi

validate_package

case "$MODE" in
  update) echo "Updated the local Nito package. Review with: git diff -- $APP_ID" ;;
  localtest) deploy_localtest ;;
  publish) publish_package ;;
esac
