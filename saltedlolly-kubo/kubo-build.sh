#!/usr/bin/env bash
set -euo pipefail

# Track the latest ipfs/kubo release and pin docker-compose.yml to its
# multi-arch manifest digest. Version = the upstream tag verbatim (e.g.
# v0.43.1) when there's no packaging-only patch, matching upstream exactly
# so users can tell at a glance which Kubo release they're running. A 4th
# number only appears (starting at .1) for a local-only packaging fix
# published while upstream is unchanged - use --patch for that.
#
# Nothing to build here: the image is already public and multi-arch
# (amd64/arm64/arm-v7) - no Dockerfile, no docker buildx build, no push, no
# registry login required.
#
# Requirements:
# - Docker (for `docker buildx imagetools inspect`, no login needed - the
#   image is public)
# - macOS (BSD sed) or Linux (GNU sed)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-kubo"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"
UPSTREAM_IMAGE="docker.io/ipfs/kubo"
UPSTREAM_RELEASES_API="https://api.github.com/repos/ipfs/kubo/releases?per_page=20"

# Everything in umbrel-app.yml's releaseNotes field ABOVE this marker is
# preserved untouched (any manually-written notes); everything from the
# marker down is fully regenerated from ipfs/kubo's own last two releases
# on every run.
RELEASE_NOTES_MARKER="--- ipfs/kubo upstream release notes (auto-updated) ---"

MODE="check"
REQUESTED_VERSION=""
RELEASE_NOTES=""
FORCE_PATCH=false
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
  --version <tag>         Use a specific stable tag, for example v0.43.1
  --patch                 Publish a local-only packaging fix (upstream unchanged) - appends/increments a 4th version number
  --notes <text>          Release notes used in umbrel-app.yml and the release commit
  --host <host-or-ip>     umbrel-dev host for --localtest (default: $UMBREL_DEV_HOST)
  -h, --help              Show this help

Examples:
  $(basename "$0") --check
  $(basename "$0") --update --notes "Update Kubo"
  $(basename "$0") --localtest --host umbrel-dev.local
  $(basename "$0") --publish --notes "Update Kubo"
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

# Newest non-draft, non-prerelease ipfs/kubo release with a clean vX.Y.Z tag.
resolve_latest_tag() {
  curl -sf "$UPSTREAM_RELEASES_API" | python3 -c "
import json, re, sys

data = json.load(sys.stdin)
pattern = re.compile(r'^v[0-9]+\.[0-9]+\.[0-9]+\$')
candidates = [r for r in data if not r['draft'] and not r['prerelease'] and pattern.match(r['tag_name'])]
if not candidates:
    sys.exit('Could not find a primary release tag matching vX.Y.Z')
candidates.sort(key=lambda r: r['published_at'])
print(candidates[-1]['tag_name'])
"
}

validate_release_tag() {
  local tag="$1"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    fail "Unsupported ipfs/kubo tag format: $tag"
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
  local target_version="$3"

  python3 - "$COMPOSE_FILE" "$tag" "$digest" <<'PY'
from pathlib import Path
import re
import sys

compose_path = Path(sys.argv[1])
tag, digest = sys.argv[2], sys.argv[3]

compose = compose_path.read_text()
image_pattern = re.compile(
    r"(image:\s*docker\.io/ipfs/kubo:)[^@\s]+(@sha256:)[a-f0-9]{64}"
)
compose, count = image_pattern.subn(rf"\g<1>{tag}\g<2>{digest.removeprefix('sha256:')}", compose, count=1)
if count != 1:
    raise SystemExit("Could not update the ipfs/kubo image reference in docker-compose.yml")
compose_path.write_text(compose)
PY

  python3 - "$MANIFEST_FILE" "$target_version" <<'PY'
from pathlib import Path
import re
import sys

manifest_path = Path(sys.argv[1])
new_manifest_version = sys.argv[2]

manifest = manifest_path.read_text()
manifest, count = re.subn(
    r'^version:\s*"[^"]+"$',
    f'version: "{new_manifest_version}"',
    manifest,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit("Could not update version in umbrel-app.yml")
manifest_path.write_text(manifest)
PY
}

# Fetches ipfs/kubo's own release notes for the two most recent stable
# releases and regenerates the auto-updated portion of umbrel-app.yml's
# releaseNotes field, preserving any manually-written notes above
# RELEASE_NOTES_MARKER byte-for-byte. Matches the pattern established in
# saltedlolly-audiobookshelf/abs-build.sh.
update_release_notes() {
  local target_tag="$1"
  echo "Fetching ipfs/kubo's own release notes for $target_tag and the preceding release..."
  local releases_file
  releases_file="$(mktemp)"
  if ! curl -sf "https://api.github.com/repos/ipfs/kubo/releases?per_page=10" -o "$releases_file"; then
    echo "⚠️  Could not fetch upstream release notes, leaving releaseNotes as-is" >&2
    rm -f "$releases_file"
    return
  fi

  python3 - "$MANIFEST_FILE" "$target_tag" "$RELEASE_NOTES_MARKER" "$releases_file" "ipfs/kubo" <<'PY'
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
    r'(<td nowrap id="saltedlolly-kubo-version"><code>)[^<]*(</code></td>)',
    rf"\g<1>{new_version}\g<2>",
    text,
    count=1,
)

text = re.sub(
    r'id="saltedlolly-kubo-date">(\d{4}-\d{2}-\d{2})',
    f'id="saltedlolly-kubo-date">{today}',
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
if '"4001:4001/tcp"' not in compose or '"4001:4001/udp"' not in compose:
    raise SystemExit("Expected the swarm P2P port (4001 tcp+udp) to be published")
if re.search(r"^\s*-\s*[\"']?5001:", compose, re.MULTILINE):
    raise SystemExit("The API/WebUI port (5001) must not be published directly - it should only be reachable via app_proxy")
PY

  # app_proxy has no image of its own in this package - Umbrel supplies it
  # at runtime - so `docker compose config` needs a stub image override to
  # validate cleanly, matching npm-plus-build.sh's approach.
  local validation_override
  validation_override="$(mktemp)"
  printf '%s\n' 'services:' '  app_proxy:' '    image: docker.io/library/busybox:1.37.0' >"$validation_override"

  APP_DATA_DIR="$APP_ROOT" \
  UMBREL_ROOT="$APP_ROOT" \
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
    --exclude='kubo-build.sh' \
    "$APP_ROOT/" \
    "$UMBREL_USER@$UMBREL_DEV_HOST:$store_dir/$APP_ID/"

  cat <<EOF

Package copied to umbrel-dev.

For a clean test, uninstall any existing test copy first, then install $APP_ID from
the App Store.

WebUI: http://$UMBREL_DEV_HOST:5001/webui
Swarm: $UMBREL_DEV_HOST:4001 (tcp+udp)
EOF
}

publish_package() {
  require_command git
  [[ -n "$RELEASE_NOTES" ]] || fail "--publish requires --notes"

  local staged_outside
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | \
    awk -v prefix="$APP_ID/" 'index($0, prefix) != 1 && $0 != ".github/workflows/kubo-auto-release.yml" && $0 != "README.md" {print}')"
  [[ -z "$staged_outside" ]] || {
    echo "Already-staged files outside $APP_ID, its workflow file, and README.md:" >&2
    echo "$staged_outside" >&2
    fail "Unstage unrelated files before publishing"
  }

  git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/.github/workflows/kubo-auto-release.yml" "$STORE_ROOT/README.md"
  git -C "$STORE_ROOT" diff --cached --quiet && fail "There are no Kubo changes to publish"
  git -C "$STORE_ROOT" commit -m "release: Kubo (IPFS) $TARGET_VERSION - $RELEASE_NOTES"
  git -C "$STORE_ROOT" push
  echo "Published Kubo (IPFS) $TARGET_VERSION."
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

# CURRENT_VERSION may be bare (vX.Y.Z, no local patch yet) or suffixed
# (vX.Y.Z.N, a prior local-only packaging fix) - derive both parts.
if [[ "$CURRENT_VERSION" =~ ^(v[0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
  CURRENT_TAG="${BASH_REMATCH[1]}"
  CURRENT_PATCH="${BASH_REMATCH[2]}"
else
  CURRENT_TAG="$CURRENT_VERSION"
  CURRENT_PATCH="0"
fi

if [[ "$TARGET_TAG" != "$CURRENT_TAG" ]]; then
  # Genuine upstream bump - publish the bare tag, matching upstream
  # exactly, regardless of what patch number (if any) was live before.
  TARGET_VERSION="$TARGET_TAG"
elif [[ "$FORCE_PATCH" == "true" ]]; then
  TARGET_VERSION="${TARGET_TAG}.$((CURRENT_PATCH + 1))"
else
  TARGET_VERSION="$CURRENT_VERSION"
fi

TARGET_DIGEST="$(inspect_upstream_image "$TARGET_TAG")"

echo
echo "Current package version: $CURRENT_VERSION"
echo "Target upstream tag:     $TARGET_TAG"
echo "Resulting version:       $TARGET_VERSION"
echo "Target image digest:     $TARGET_DIGEST"
echo "Architectures:           linux/amd64, linux/arm64"
echo

if [[ "$MODE" == "check" ]]; then
  if [[ "$CURRENT_VERSION" == "$TARGET_VERSION" ]] && \
     grep -q "$UPSTREAM_IMAGE:$TARGET_TAG@$TARGET_DIGEST" "$COMPOSE_FILE"; then
    echo "Kubo is already pinned to the requested release and digest."
  else
    echo "An update or digest correction is available. Run with --update to prepare it."
  fi
  exit 0
fi

if [[ "$CURRENT_VERSION" == "$TARGET_VERSION" ]]; then
  echo "Nothing to update (pass --patch to publish a local-only packaging fix)."
  exit 0
fi

update_package "$TARGET_TAG" "$TARGET_DIGEST" "$TARGET_VERSION"
update_release_notes "$TARGET_TAG"
update_readme_version "$TARGET_VERSION"
validate_package

case "$MODE" in
  update)
    echo "Updated the local Kubo package. Review with: git diff -- $APP_ID"
    ;;
  localtest)
    deploy_localtest
    ;;
  publish)
    publish_package
    ;;
esac
