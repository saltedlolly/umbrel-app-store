#!/usr/bin/env bash
set -euo pipefail

# Track the latest dgtlmoon/changedetection.io release (primary image, drives
# the app's own version) and independently track the latest stable
# dgtlmoon/sockpuppetbrowser tag (secondary/sidecar image, tracked per the
# "auto-track every upstream image, not just the primary one" convention -
# a manually-pinned secondary image in this store has gone stale before).
#
# Both images already publish public, multi-arch (amd64+arm64) images, so
# like netbootxyz-build.sh and tb-build.sh there's nothing to actually build
# here - no Dockerfile, no docker buildx build, no push, no registry login.
#
# Version scheme: the manifest version is the changedetection.io tag
# verbatim (e.g. 0.60.7) when there's no patch on top of it, matching
# upstream exactly. A changedetection.io bump always resets to that bare
# tag. A sockpuppetbrowser-only bump (changedetection.io unchanged), or an
# explicit --patch for a local-only packaging fix, appends/increments a
# trailing patch number instead (e.g. 0.60.7.1), so the manifest version
# still changes even when only the sidecar moves or nothing upstream has.
#
# Requirements:
# - Docker (for `docker buildx imagetools inspect`, no login needed - both
#   images are public)
# - macOS (BSD sed) or Linux (GNU sed)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-changedetection"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"

CDIO_IMAGE="ghcr.io/dgtlmoon/changedetection.io"
CDIO_RELEASES_API="https://api.github.com/repos/dgtlmoon/changedetection.io/releases?per_page=20"
SPB_IMAGE="docker.io/dgtlmoon/sockpuppetbrowser"
SPB_TAGS_API="https://hub.docker.com/v2/repositories/dgtlmoon/sockpuppetbrowser/tags?page_size=100"

# Everything in umbrel-app.yml's releaseNotes field ABOVE this marker is
# preserved untouched (manually-written notes); everything from the marker
# down is fully regenerated from changedetection.io's own last two
# releases on every run.
RELEASE_NOTES_MARKER="--- dgtlmoon/changedetection.io upstream release notes (auto-updated) ---"

MODE="check"
REQUESTED_CDIO_VERSION=""
REQUESTED_SPB_VERSION=""
FORCE_PATCH=false
RELEASE_NOTES=""
UMBREL_DEV_HOST="${UMBREL_DEV_HOST:-192.168.215.2}"
UMBREL_USER="${UMBREL_USER:-umbrel}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Modes (choose one; default is --check):
  --check                 Check current vs. latest upstream releases without editing files
  --update                Pin releases and update the local package
  --localtest              Update, validate, and copy the package to umbrel-dev
  --publish                Update, validate, commit only this app, and push

Options:
  --cdio-version <tag>    Use a specific changedetection.io tag, for example 0.60.6
  --spb-version <tag>     Use a specific sockpuppetbrowser tag, for example 0.0.3
  --patch                 Bump the trailing patch number for a local-only fix (neither
                          upstream image has changed)
  --notes <text>          Release notes used in umbrel-app.yml and the release commit
  --host <host-or-ip>     umbrel-dev host for --localtest (default: $UMBREL_DEV_HOST)
  -h, --help              Show this help

Examples:
  $(basename "$0") --check
  $(basename "$0") --update --notes "Update changedetection.io"
  $(basename "$0") --localtest --host umbrel-dev.local
  $(basename "$0") --publish --notes "Update changedetection.io"
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

current_manifest_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$MANIFEST_FILE"
}

current_pinned_tag() {
  local image="$1"
  grep -oE "${image}:[0-9]+\.[0-9]+\.[0-9]+" "$COMPOSE_FILE" | head -1 | cut -d: -f2
}

# Newest non-draft, non-prerelease changedetection.io release with a clean
# X.Y.Z tag (its GitHub releases map 1:1 to its published image tags).
resolve_latest_cdio_tag() {
  curl -sf "$CDIO_RELEASES_API" | python3 -c "
import json, re, sys

data = json.load(sys.stdin)
pattern = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+\$')
candidates = [r for r in data if not r['draft'] and not r['prerelease'] and pattern.match(r['tag_name'])]
if not candidates:
    sys.exit('Could not find a primary release tag matching X.Y.Z')
candidates.sort(key=lambda r: r['published_at'])
print(candidates[-1]['tag_name'])
"
}

# Newest stable sockpuppetbrowser tag, excluding latest/master/edge and any
# non-semver build tags.
resolve_latest_spb_tag() {
  curl -sf "$SPB_TAGS_API" | python3 -c "
import json, re, sys

data = json.load(sys.stdin)
pattern = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+\$')
candidates = [r for r in data['results'] if pattern.match(r['name'])]
if not candidates:
    sys.exit('Could not find a sockpuppetbrowser tag matching X.Y.Z')
candidates.sort(key=lambda r: tuple(int(p) for p in r['name'].split('.')))
print(candidates[-1]['name'])
"
}

validate_semver_tag() {
  local tag="$1"
  local label="$2"
  [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unsupported $label tag format: $tag"
}

inspect_upstream_image() {
  local image="$1"
  local tag="$2"
  local inspection
  echo "Inspecting $image:$tag..." >&2
  inspection="$(docker buildx imagetools inspect "$image:$tag")"

  grep -q 'Platform:[[:space:]]*linux/amd64' <<<"$inspection" || \
    fail "$image:$tag does not publish linux/amd64"
  grep -q 'Platform:[[:space:]]*linux/arm64' <<<"$inspection" || \
    fail "$image:$tag does not publish linux/arm64"

  local digest
  digest="$(awk '/^Digest:/ {print $2; exit}' <<<"$inspection")"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail "Could not resolve the multi-architecture digest for $image:$tag"
  printf '%s\n' "$digest"
}

# Computes the manifest version for a given upstream change: a
# changedetection.io bump always resets to the bare upstream tag. A
# sockpuppetbrowser-only bump (or an explicit local-only --patch, with
# neither upstream changed) appends/increments a trailing patch number
# instead, since the manifest version must still change to reflect it.
compute_manifest_version() {
  local cdio_changed="$1"
  local spb_changed="$2"
  local current="$3"
  local target_cdio="$4"
  local force_patch="$5"

  if [[ "$cdio_changed" == "true" ]]; then
    printf '%s\n' "$target_cdio"
  elif [[ "$spb_changed" == "true" || "$force_patch" == "true" ]]; then
    if [[ "$current" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
      printf '%s.%s\n' "${BASH_REMATCH[1]}" "$((BASH_REMATCH[2] + 1))"
    else
      printf '%s.1\n' "$current"
    fi
  else
    printf '%s\n' "$current"
  fi
}

update_package() {
  local target_cdio="$1"
  local cdio_digest="$2"
  local target_spb="$3"
  local spb_digest="$4"
  local new_manifest_version="$5"
  local notes="$6"

  python3 - "$COMPOSE_FILE" "$MANIFEST_FILE" "$target_cdio" "$cdio_digest" "$target_spb" "$spb_digest" "$new_manifest_version" "$notes" <<'PY'
from pathlib import Path
import re
import sys

compose_path = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
target_cdio, cdio_digest = sys.argv[3], sys.argv[4]
target_spb, spb_digest = sys.argv[5], sys.argv[6]
new_manifest_version = sys.argv[7]
notes = sys.argv[8] or f"Update to changedetection.io {target_cdio}."

compose = compose_path.read_text()

cdio_pattern = re.compile(
    r"(image:\s*ghcr\.io/dgtlmoon/changedetection\.io:)[^@\s]+(@sha256:)[a-f0-9]{64}"
)
compose, count = cdio_pattern.subn(rf"\g<1>{target_cdio}\g<2>{cdio_digest.removeprefix('sha256:')}", compose, count=1)
if count != 1:
    raise SystemExit("Could not update the changedetection.io image reference in docker-compose.yml")

spb_pattern = re.compile(
    r"(image:\s*docker\.io/dgtlmoon/sockpuppetbrowser:)[^@\s]+(@sha256:)[a-f0-9]{64}"
)
compose, count = spb_pattern.subn(rf"\g<1>{target_spb}\g<2>{spb_digest.removeprefix('sha256:')}", compose, count=1)
if count != 1:
    raise SystemExit("Could not update the sockpuppetbrowser image reference in docker-compose.yml")

compose_path.write_text(compose)

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

release_block = (
    "releaseNotes: >-\n"
    f"  {new_manifest_version}:\n\n"
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

# Fetches dgtlmoon/changedetection.io's own release notes for the two most
# recent stable releases and regenerates the auto-updated portion of
# umbrel-app.yml's releaseNotes field, preserving any manually-written
# notes above RELEASE_NOTES_MARKER byte-for-byte. Matches the pattern
# established in saltedlolly-audiobookshelf/abs-build.sh and
# saltedlolly-kubo/kubo-build.sh. Only the primary (changedetection.io)
# upstream's notes are fetched - the sockpuppetbrowser sidecar's own
# release, when that's what triggered the bump, is still called out via
# the short manual bullet from update_package's release_block.
update_release_notes() {
  local target_tag="$1"
  echo "Fetching changedetection.io's own release notes for $target_tag and the preceding release..."
  local releases_file
  releases_file="$(mktemp)"
  if ! curl -sf "$CDIO_RELEASES_API" -o "$releases_file"; then
    echo "⚠️  Could not fetch upstream release notes, leaving releaseNotes as-is" >&2
    rm -f "$releases_file"
    return
  fi

  python3 - "$MANIFEST_FILE" "$target_tag" "$RELEASE_NOTES_MARKER" "$releases_file" "dgtlmoon/changedetection.io" <<'PY'
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
    r'(<td nowrap id="saltedlolly-changedetection-version"><code>)[^<]*(</code></td>)',
    rf"\g<1>{new_version}\g<2>",
    text,
    count=1,
)

text = re.sub(
    r'id="saltedlolly-changedetection-date">(\d{4}-\d{2}-\d{2})',
    f'id="saltedlolly-changedetection-date">{today}',
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

# Only real YAML directives count here - explanatory comments in the compose
# file legitimately discuss cap_add/SYS_ADMIN in prose (why it's omitted).
active_lines = "\n".join(
    line for line in compose.splitlines() if not line.strip().startswith("#")
)
if re.search(r"^\s*-\s*SYS_ADMIN\s*$", active_lines, re.MULTILINE):
    raise SystemExit("cap_add: SYS_ADMIN should not be present unless proven necessary on real hardware")
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
    --exclude='changedetection-build.sh' \
    "$APP_ROOT/" \
    "$UMBREL_USER@$UMBREL_DEV_HOST:$store_dir/$APP_ID/"

  cat <<EOF

Package copied to umbrel-dev.

For a clean test, uninstall any existing test copy first, then install $APP_ID from
the App Store.

Web UI: http://$UMBREL_DEV_HOST:5000

If watches using the "Playwright/Chromium" fetch method fail to fetch (rather
than just timing out), check the changedetection container's logs for a
startup error from the sockpuppetbrowser sidecar naming SYS_ADMIN - if so,
cap_add: [SYS_ADMIN] needs to be added back to the sockpuppetbrowser service.
EOF
}

publish_package() {
  require_command git
  [[ -n "$RELEASE_NOTES" ]] || fail "--publish requires --notes"

  local staged_outside
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | \
    awk -v prefix="$APP_ID/" 'index($0, prefix) != 1 && $0 != ".github/workflows/changedetection-auto-release.yml" && $0 != "README.md" {print}')"
  [[ -z "$staged_outside" ]] || {
    echo "Already-staged files outside $APP_ID, its workflow file, and README.md:" >&2
    echo "$staged_outside" >&2
    fail "Unstage unrelated files before publishing"
  }

  git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/.github/workflows/changedetection-auto-release.yml" "$STORE_ROOT/README.md"
  git -C "$STORE_ROOT" diff --cached --quiet && fail "There are no changedetection.io changes to publish"
  git -C "$STORE_ROOT" commit -m "release: changedetection.io $TARGET_MANIFEST_VERSION - $RELEASE_NOTES"
  git -C "$STORE_ROOT" push
  echo "Published changedetection.io $TARGET_MANIFEST_VERSION."
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
    --cdio-version) REQUESTED_CDIO_VERSION="$2"; shift 2 ;;
    --spb-version) REQUESTED_SPB_VERSION="$2"; shift 2 ;;
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

TARGET_CDIO="${REQUESTED_CDIO_VERSION:-$(resolve_latest_cdio_tag)}"
validate_semver_tag "$TARGET_CDIO" "changedetection.io"
TARGET_SPB="${REQUESTED_SPB_VERSION:-$(resolve_latest_spb_tag)}"
validate_semver_tag "$TARGET_SPB" "sockpuppetbrowser"

CURRENT_MANIFEST_VERSION="$(current_manifest_version)"
CURRENT_CDIO="$(current_pinned_tag "$CDIO_IMAGE")"
CURRENT_SPB="$(current_pinned_tag "$SPB_IMAGE")"

CDIO_CHANGED="false"; [[ "$TARGET_CDIO" != "$CURRENT_CDIO" ]] && CDIO_CHANGED="true"
SPB_CHANGED="false"; [[ "$TARGET_SPB" != "$CURRENT_SPB" ]] && SPB_CHANGED="true"

TARGET_MANIFEST_VERSION="$(compute_manifest_version "$CDIO_CHANGED" "$SPB_CHANGED" "$CURRENT_MANIFEST_VERSION" "$TARGET_CDIO" "$FORCE_PATCH")"

echo
echo "Current manifest version:      $CURRENT_MANIFEST_VERSION"
echo "Current changedetection.io:    $CURRENT_CDIO"
echo "Target changedetection.io:     $TARGET_CDIO"
echo "Current sockpuppetbrowser:     $CURRENT_SPB"
echo "Target sockpuppetbrowser:      $TARGET_SPB"
echo "Resulting manifest version:    $TARGET_MANIFEST_VERSION"
echo

if [[ "$MODE" == "check" ]]; then
  if [[ "$CDIO_CHANGED" == "false" && "$SPB_CHANGED" == "false" ]]; then
    echo "Both images are already pinned to the requested releases."
  else
    echo "An update is available. Run with --update to prepare it."
  fi
  exit 0
fi

if [[ "$CDIO_CHANGED" == "false" && "$SPB_CHANGED" == "false" && "$FORCE_PATCH" != "true" ]]; then
  echo "Nothing to update (pass --patch to publish a local-only packaging fix)."
  exit 0
fi

CDIO_DIGEST="$(inspect_upstream_image "$CDIO_IMAGE" "$TARGET_CDIO")"
SPB_DIGEST="$(inspect_upstream_image "$SPB_IMAGE" "$TARGET_SPB")"

if [[ -z "$RELEASE_NOTES" ]]; then
  if [[ "$CDIO_CHANGED" == "true" ]]; then
    RELEASE_NOTES="Update changedetection.io to upstream release $TARGET_CDIO."
  elif [[ "$SPB_CHANGED" == "true" ]]; then
    RELEASE_NOTES="Update bundled sockpuppetbrowser sidecar to $TARGET_SPB."
  else
    RELEASE_NOTES="Local-only packaging fix."
  fi
fi

update_package "$TARGET_CDIO" "$CDIO_DIGEST" "$TARGET_SPB" "$SPB_DIGEST" "$TARGET_MANIFEST_VERSION" "$RELEASE_NOTES"
update_release_notes "$TARGET_CDIO"
update_readme_version "$TARGET_MANIFEST_VERSION"
validate_package

case "$MODE" in
  update)
    echo "Updated the local changedetection.io package. Review with: git diff -- $APP_ID"
    ;;
  localtest)
    deploy_localtest
    ;;
  publish)
    publish_package
    ;;
esac
