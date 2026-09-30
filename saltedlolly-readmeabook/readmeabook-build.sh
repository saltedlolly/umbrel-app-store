#!/usr/bin/env bash
set -euo pipefail

# Track stable kikootwo/ReadMeABook releases and pin the upstream multi-arch
# image by digest. Nothing is built or pushed: upstream publishes amd64 and
# arm64 images to GHCR. Local packaging-only releases append a fourth version
# component while continuing to use the same upstream image.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-readmeabook"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"
WORKFLOW_FILE="$STORE_ROOT/.github/workflows/readmeabook-auto-release.yml"
UPSTREAM_IMAGE="ghcr.io/kikootwo/readmeabook"
UPSTREAM_RELEASES_API="https://api.github.com/repos/kikootwo/ReadMeABook/releases?per_page=20"
RELEASE_NOTES_MARKER="--- kikootwo/ReadMeABook upstream release notes (auto-updated) ---"

MODE="check"
REQUESTED_TAG=""
RELEASE_NOTES=""
FORCE_PATCH=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Modes (choose one; default is --check):
  --check                 Check current and latest stable releases without editing files
  --update                Update local package files
  --publish               Update, validate, commit only this app, and push

Options:
  --version <vX.Y.Z>      Use a specific stable upstream release
  --patch                 Append/increment a local packaging patch version
  --notes <text>          Release notes for --update/--publish
  -h, --help              Show this help

Examples:
  $(basename "$0") --check
  $(basename "$0") --update --version v1.2.2 --notes "Update ReadMeABook"
  $(basename "$0") --publish --patch --notes "Fix Umbrel volume mapping"
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

check_git_sync() {
  echo "Checking repository sync status..."

  if ! git diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes"
    echo "Commit or stash them first, then try again"
    exit 1
  fi

  git fetch origin >/dev/null 2>&1

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)

  local behind
  behind=$(git rev-list "HEAD..origin/$current_branch" --count 2>/dev/null || echo "0")
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

  local ahead
  ahead=$(git rev-list "origin/$current_branch..HEAD" --count 2>/dev/null || echo "0")
  if [[ "$ahead" -gt 0 ]]; then
    echo "ℹ️  Note: You have $ahead unpushed commit(s)"
  fi

  echo "✓ Repository is in sync with origin/$current_branch"
}

explain_failed_commit() {
  local message="$1"
  echo ""
  echo "❌ Git commit failed. Package files are already updated and staged."
  echo "After fixing the cause, finish with:"
  printf '  git commit -m %q\n' "$message"
  echo "  git push origin $(git rev-parse --abbrev-ref HEAD)"
}

explain_failed_push() {
  echo ""
  echo "❌ Git push failed. The release commit already exists locally."
  echo "After fixing the cause, finish with:"
  echo "  git push origin $(git rev-parse --abbrev-ref HEAD)"
}

current_app_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$MANIFEST_FILE"
}

current_upstream_tag() {
  local image_tag
  image_tag=$(grep -oE 'ghcr\.io/kikootwo/readmeabook:[0-9]+\.[0-9]+\.[0-9]+' "$COMPOSE_FILE" | sed -n '1p' | cut -d: -f2)
  [[ -n "$image_tag" ]] || fail "Could not extract the pinned ReadMeABook tag"
  printf 'v%s\n' "$image_tag"
}

resolve_latest_tag() {
  curl -sf "$UPSTREAM_RELEASES_API" | python3 -c '
import json, re, sys
releases = json.load(sys.stdin)
pattern = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
stable = [r for r in releases if not r["draft"] and not r["prerelease"] and pattern.match(r["tag_name"])]
if not stable:
    sys.exit("Could not find a stable vX.Y.Z release")
stable.sort(key=lambda r: r["published_at"])
print(stable[-1]["tag_name"])
'
}

validate_release_tag() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unsupported ReadMeABook tag: $1"
}

inspect_upstream_image() {
  local tag="$1"
  local image_tag="${tag#v}"
  local inspection

  echo "Inspecting $UPSTREAM_IMAGE:$image_tag..." >&2
  inspection=$(docker buildx imagetools inspect "$UPSTREAM_IMAGE:$image_tag")

  grep -q 'Platform:[[:space:]]*linux/amd64' <<<"$inspection" || \
    fail "$UPSTREAM_IMAGE:$image_tag does not publish linux/amd64"
  grep -q 'Platform:[[:space:]]*linux/arm64' <<<"$inspection" || \
    fail "$UPSTREAM_IMAGE:$image_tag does not publish linux/arm64"

  local digest
  digest=$(awk '/^Digest:/ {print $2; exit}' <<<"$inspection")
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || \
    fail "Could not resolve the multi-architecture digest for $UPSTREAM_IMAGE:$image_tag"
  printf '%s\n' "$digest"
}

bump_patch_version() {
  local current="$1"
  local base="$2"

  if [[ "$current" == "$base" ]]; then
    printf '%s.1\n' "$base"
  elif [[ "$current" =~ ^${base//./\.}\.([0-9]+)$ ]]; then
    printf '%s.%d\n' "$base" "$((BASH_REMATCH[1] + 1))"
  else
    fail "Current app version '$current' is not based on '$base'"
  fi
}

update_package() {
  local tag="$1"
  local digest="$2"
  local target_version="$3"
  local image_tag="${tag#v}"

  python3 - "$COMPOSE_FILE" "$image_tag" "$digest" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
tag = sys.argv[2]
digest = sys.argv[3].removeprefix("sha256:")
text = path.read_text()
text, count = re.subn(
    r"(image:\s*ghcr\.io/kikootwo/readmeabook:)[^@\s]+(@sha256:)[a-f0-9]{64}",
    rf"\g<1>{tag}\g<2>{digest}",
    text,
    count=1,
)
if count != 1:
    raise SystemExit("Could not update image reference in docker-compose.yml")
path.write_text(text)
PY

  python3 - "$MANIFEST_FILE" "$target_version" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
text, count = re.subn(
    r'^version:\s*"[^"]+"$',
    f'version: "{sys.argv[2]}"',
    text,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit("Could not update version in umbrel-app.yml")
path.write_text(text)
PY
}

update_release_notes() {
  local tag="$1"
  local target_version="$2"
  local mode="$3"
  local notes="$4"
  local release_file
  release_file=$(mktemp)

  echo "Fetching upstream release notes for $tag..."
  if ! curl -sf "https://api.github.com/repos/kikootwo/ReadMeABook/releases/tags/$tag" -o "$release_file"; then
    rm -f "$release_file"
    fail "Could not fetch upstream release notes for $tag"
  fi

  python3 - "$MANIFEST_FILE" "$tag" "$target_version" "$mode" "$notes" "$RELEASE_NOTES_MARKER" "$release_file" <<'PY'
import json
import re
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
tag, target_version, mode, note, marker = sys.argv[2:7]
release = json.loads(Path(sys.argv[7]).read_text())

def format_body(body: str, url: str) -> str:
    lines = body.replace("\r\n", "\n").strip().split("\n")
    out = []
    for line in lines:
        line = re.sub(r"^#{1,4}\s*", "", line).rstrip()
        out.append(("    " + line) if line else "")
    if len(out) > 40:
        out = out[:40]
        while out and not out[-1]:
            out.pop()
        out += ["", f"    … (truncated) Full release notes: {url}"]
    return "\n".join(out)

text = manifest_path.read_text()
match = re.search(r"^releaseNotes:\s*>-\n((?:.*\n)*?)(?=^\S)", text, re.MULTILINE)
if not match:
    raise SystemExit("Could not find releaseNotes block")

existing = match.group(1)
entry = f"  ## {target_version}\n\n  - {note}\n"
upstream = (
    f"  {marker}\n\n\n"
    f"  kikootwo/ReadMeABook {tag}\n\n"
    f"{format_body(release.get('body') or '(no notes provided)', release.get('html_url', ''))}\n\n\n"
    "  See the full release history: https://github.com/kikootwo/ReadMeABook/releases\n\n"
)

if mode == "reset":
    new_block = entry + "\n\n" + upstream
else:
    new_block = entry + "\n" + existing

manifest_path.write_text(text[:match.start(1)] + new_block + text[match.end(1):])
PY

  rm -f "$release_file"
}

update_readme_version() {
  local version="$1"
  local today
  today=$(date +%F)

  python3 - "$STORE_ROOT/README.md" "$version" "$today" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
version, today = sys.argv[2:4]
text = path.read_text()
text, version_count = re.subn(
    r'(<td nowrap id="saltedlolly-readmeabook-version"><code>)[^<]*(</code></td>)',
    rf'\g<1>{version}\g<2>',
    text,
    count=1,
)
text, date_count = re.subn(
    r'id="saltedlolly-readmeabook-date">\d{4}-\d{2}-\d{2}',
    f'id="saltedlolly-readmeabook-date">{today}',
    text,
    count=1,
)
if version_count != 1 or date_count != 1:
    raise SystemExit("Could not update ReadMeABook's root README row")
path.write_text(text)
PY
}

validate_package() {
  echo "Validating package..."
  grep -q '^id: saltedlolly-readmeabook$' "$MANIFEST_FILE" || fail "Wrong app id"
  grep -q "image: $UPSTREAM_IMAGE:" "$COMPOSE_FILE" || fail "Missing upstream image"
  grep -q '^  - STORAGE_DOWNLOADS$' "$MANIFEST_FILE" || fail "Missing STORAGE_DOWNLOADS permission"

  # umbrelOS injects the app_proxy image at install time. Supply a harmless
  # image in a temporary override so standalone Docker Compose can still
  # validate the merged file during local development and CI.
  local proxy_override
  proxy_override=$(mktemp)
  printf 'services:\n  app_proxy:\n    image: alpine:3.22\n' > "$proxy_override"
  if ! APP_DATA_DIR=/tmp/readmeabook-app-data \
    UMBREL_ROOT=/tmp/readmeabook-umbrel-root \
      docker compose -f "$COMPOSE_FILE" -f "$proxy_override" config --quiet; then
    rm -f "$proxy_override"
    fail "docker-compose.yml is invalid"
  fi
  rm -f "$proxy_override"

  echo "✓ Package validation passed"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--update|--publish)
      MODE="${1#--}"
      shift
      ;;
    --version)
      [[ $# -ge 2 ]] || fail "--version requires a value"
      REQUESTED_TAG="$2"
      shift 2
      ;;
    --patch)
      FORCE_PATCH=true
      shift
      ;;
    --notes)
      [[ $# -ge 2 ]] || fail "--notes requires a value"
      RELEASE_NOTES="$2"
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

# Git sync check (if publishing)
if [[ "${PUBLISH_TO_GITHUB:-false}" == "true" ]] || [[ "${MODE:-}" == "publish" ]]; then
  check_git_sync
  echo ""
fi

require_command curl
require_command docker
require_command python3

target_tag="${REQUESTED_TAG:-$(resolve_latest_tag)}"
validate_release_tag "$target_tag"

current_tag=$(current_upstream_tag)
current_version=$(current_app_version)

echo "Current upstream image: $current_tag"
echo "Current app version:     $current_version"
echo "Target upstream release: $target_tag"

if [[ "$MODE" == "check" ]]; then
  if [[ "$current_tag" == "$target_tag" ]]; then
    echo "✓ Already on the latest stable upstream release"
  else
    echo "Update available: $current_tag -> $target_tag"
  fi
  exit 0
fi

[[ -n "$RELEASE_NOTES" ]] || fail "--notes is required for --$MODE"

if [[ "$FORCE_PATCH" == "true" ]]; then
  [[ "$target_tag" == "$current_tag" ]] || fail "--patch requires the pinned upstream release ($current_tag)"
  target_version=$(bump_patch_version "$current_version" "$target_tag")
  notes_mode="prepend"
else
  if [[ "$target_tag" == "$current_tag" ]]; then
    fail "$target_tag is already pinned; use --patch for a packaging-only release"
  else
    target_version="$target_tag"
    notes_mode="reset"
  fi
fi

digest=$(inspect_upstream_image "$target_tag")
update_package "$target_tag" "$digest" "$target_version"
update_release_notes "$target_tag" "$target_version" "$notes_mode" "$RELEASE_NOTES"
update_readme_version "$target_version"
validate_package

echo ""
echo "Updated ReadMeABook package:"
echo "  Upstream: $target_tag"
echo "  App:      $target_version"
echo "  Digest:   $digest"

if [[ "$MODE" == "publish" ]]; then
  commit_message="release: ReadMeABook $target_version - $RELEASE_NOTES"
  git add "$APP_ROOT" "$WORKFLOW_FILE" "$STORE_ROOT/README.md"

  if git diff --cached --quiet; then
    fail "No ReadMeABook release changes to commit"
  fi

  if ! git commit -m "$commit_message"; then
    explain_failed_commit "$commit_message"
    exit 1
  fi

  if ! git push origin "$(git rev-parse --abbrev-ref HEAD)"; then
    explain_failed_push
    exit 1
  fi

  echo "✓ Published ReadMeABook $target_version"
fi
