#!/usr/bin/env bash
set -euo pipefail

# Build and release Nostr Backup Relay: a fork of Umbrel's official Nostr
# Relay app (getumbrel/umbrel-apps, nostr-relay) that backs up several
# accounts.
#
# Two images are built here from docker-containers/ (multi-arch, pushed to
# GHCR and pinned by digest): the dashboard (ui) and the sync service
# (relay-proxy). The relay itself is Umbrel's nostr-rs-relay image, pinned
# in docker-compose.yml by hand.
#
# Version scheme: v<official base>[.LOCAL]. The official app's version
# 1.2.1-patch.1 has the base 1.2.1. A release after merging a new official
# version by hand (--based-on) uses the bare base (v1.2.2) and starts the
# release notes afresh; --bump adds or increments .LOCAL (v1.2.1.1 -> v1.2.1.2).
# With neither, the version already in umbrel-app.yml is released (used for
# the first release), and only if it isn't on GitHub's master yet.
#
# The official version this code is built from is recorded in the first
# comment line of umbrel-app.yml ("# based-on-official-nostr-relay: X"); the
# upstream-check workflow compares it with the official app daily.
#
# Requirements:
# - Docker Buildx with the docker-container driver (created if missing)
# - Logged in to GHCR for saltedlolly/*: docker login ghcr.io -u saltedlolly
#   (a GitHub token with write:packages as the password)
# - python3, curl, git

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
APP_ID="saltedlolly-nostr-backup-relay"
APP_NAME="Nostr Backup Relay"
COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
MANIFEST_FILE="$APP_ROOT/umbrel-app.yml"

UI_IMAGE="ghcr.io/saltedlolly/nostr-backup-relay-ui"
PROXY_IMAGE="ghcr.io/saltedlolly/nostr-backup-relay-proxy"
UI_CONTEXT="$APP_ROOT/docker-containers/ui"
PROXY_CONTEXT="$APP_ROOT/docker-containers/relay-proxy"

OFFICIAL_MANIFEST_URL="https://raw.githubusercontent.com/getumbrel/umbrel-apps/master/nostr-relay/umbrel-app.yml"
OFFICIAL_COMMITS_API="https://api.github.com/repos/getumbrel/umbrel-apps/commits?path=nostr-relay/umbrel-app.yml&per_page=30"
OFFICIAL_HISTORY_URL="https://github.com/getumbrel/umbrel-apps/commits/master/nostr-relay"
BASED_ON_KEY="# based-on-official-nostr-relay:"

# Everything in releaseNotes ABOVE this marker is this app's own notes;
# everything from the marker down is regenerated from the official app's
# release notes for the version this app is based on.
RELEASE_NOTES_MARKER="--- Umbrel Nostr Relay upstream release notes (auto-updated) ---"

MODE="check"
FORCE_BUMP=false
NEW_BASED_ON=""
RELEASE_NOTES=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Modes (choose one; default is --check):
  --check               Show the versions and whether the official app has changed. Changes nothing
  --localtest           Build and push the images and update the local files, without committing
  --publish             Build, push, update the files, commit only this app (and the root README) and push

Options:
  --bump                Add or increment the .LOCAL number (a fix on top of the current version)
  --based-on <version>  Record that the code now matches this official Nostr Relay version
                        (for example 1.2.2 or 1.2.2-patch.1, after merging it by hand)
  --notes <text>        Release notes for umbrel-app.yml and the release commit (required with --publish)
  -h, --help            Show this help
EOF
}

fail() { echo "Error: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"; }

current_manifest_version() {
  local line
  line="$(grep -m1 -E '^version:' "$MANIFEST_FILE" || true)"
  sed -E 's/^version:[[:space:]]*"([^"]+)".*/\1/' <<<"$line"
}

recorded_based_on() {
  local line
  line="$(grep -m1 -F "$BASED_ON_KEY" "$MANIFEST_FILE" || true)"
  [[ -n "$line" ]] || fail "umbrel-app.yml has no '$BASED_ON_KEY' line"
  sed -E "s/^${BASED_ON_KEY}[[:space:]]*//" <<<"$line" | tr -d '[:space:]'
}

# 1.2.1-patch.1 -> 1.2.1
base_of() {
  sed -E 's/^v//; s/-patch\.[0-9]+$//' <<<"$1"
}

latest_official_version() {
  local manifest
  manifest="$(curl -sfL "$OFFICIAL_MANIFEST_URL")" || return 1
  python3 -c '
import re, sys
m = re.search(r"^version:\s*\"?([^\"\s]+)\"?", sys.stdin.read(), re.M)
print(m.group(1) if m else "")
' <<<"$manifest"
}

set_based_on() {
  local version="$1"
  python3 - "$MANIFEST_FILE" "$BASED_ON_KEY" "$version" <<'PY'
import sys
from pathlib import Path
path, key, version = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text().split("\n")
for i, line in enumerate(lines):
    if line.startswith(key):
        lines[i] = f"{key} {version}"
        break
else:
    raise SystemExit("based-on line not found in umbrel-app.yml")
path.write_text("\n".join(lines))
PY
}

set_manifest_version() {
  local version="$1"
  python3 - "$MANIFEST_FILE" "$version" <<'PY'
import re, sys
from pathlib import Path
path, version = Path(sys.argv[1]), sys.argv[2]
text, count = re.subn(r'^version:\s*"[^"]+"$', f'version: "{version}"', path.read_text(), count=1, flags=re.M)
if count != 1:
    raise SystemExit("Could not update version in umbrel-app.yml")
path.write_text(text)
PY
}

# NOTES_MODE=reset: a new official base, so notes start afresh with this entry.
# NOTES_MODE=prepend: add this entry on top and keep the rest; skipped if an
# entry for this version is already there (the first release).
write_release_entry() {
  local version="$1" notes="$2" mode="$3"
  python3 - "$MANIFEST_FILE" "$version" "$notes" "$mode" <<'PY'
import re, sys
from pathlib import Path
path, version, notes, mode = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
text = path.read_text()
m = re.search(r"^releaseNotes:[ \t]*>-\n", text, re.M)
if not m:
    raise SystemExit("releaseNotes block not found in umbrel-app.yml")
start, rest = m.end(), text[m.end():]
entry = f"  ## {version}\n\n  - {notes}\n\n"
if mode == "reset":
    marker = re.search(r"^  --- .*upstream release notes \(auto-updated\) ---$", rest, re.M)
    nextkey = re.search(r"^\S", rest, re.M)
    if marker and (not nextkey or marker.start() < nextkey.start()):
        end, tail = marker.start(), "\n"
    else:
        end, tail = (nextkey.start() if nextkey else len(rest)), ""
    text = text[:start] + entry + tail + rest[end:]
else:
    block_end = re.search(r"^\S", rest, re.M)
    block = rest[: block_end.start() if block_end else len(rest)]
    if re.search(rf"^  ## {re.escape(version)}$", block, re.M):
        print(f"Release notes already have an entry for {version}, leaving them as they are")
        sys.exit(0)
    text = text[:start] + entry + rest
path.write_text(text)
PY
}

# Regenerates the section below the marker from the official manifest of the
# version this app is based on (found in getumbrel/umbrel-apps' history).
update_upstream_notes() {
  local based_on="$1"
  local commits_file
  commits_file="$(mktemp)"
  if ! curl -sfL "$OFFICIAL_COMMITS_API" -o "$commits_file"; then
    echo "Warning: could not fetch the official app's history, leaving the upstream release notes as they are" >&2
    rm -f "$commits_file"
    return
  fi
  python3 - "$MANIFEST_FILE" "$based_on" "$RELEASE_NOTES_MARKER" "$commits_file" "$OFFICIAL_HISTORY_URL" <<'PY' || echo "Warning: upstream release notes not updated" >&2
import json, re, sys, urllib.request
from pathlib import Path

path, based_on, marker, commits_file, history_url = sys.argv[1:6]
commits = json.loads(Path(commits_file).read_text())

def official_notes():
    for commit in commits:
        url = f"https://raw.githubusercontent.com/getumbrel/umbrel-apps/{commit['sha']}/nostr-relay/umbrel-app.yml"
        with urllib.request.urlopen(url, timeout=20) as response:
            manifest = response.read().decode()
        version = re.search(r'^version:\s*"?([^"\s]+)"?', manifest, re.M)
        if version and version.group(1) == based_on:
            notes = re.search(r"^releaseNotes:\s*>-?\n((?:[ \t].*\n|\n)*)", manifest, re.M)
            return notes.group(1) if notes else ""
    return None

raw = official_notes()
if raw is None:
    raise SystemExit(f"Official version {based_on} not found in the last {len(commits)} commits")

MAX_UPSTREAM_LINES = 40
lines = [line.strip() for line in raw.strip("\n").split("\n")]
# Collapse runs of blank lines into one
body = []
for line in lines:
    if line or (body and body[-1]):
        body.append(line)
body = [("    " + line) if line else "" for line in body]
if len(body) > MAX_UPSTREAM_LINES:
    body = body[:MAX_UPSTREAM_LINES] + ["", f"    ... (truncated) Full release notes: {history_url}"]

upstream = (f"  {marker}\n\n\n  Umbrel Nostr Relay {based_on}\n\n" + "\n".join(body)
            + f"\n\n\n  See the full release history: {history_url}\n\n")

text = Path(path).read_text()
m = re.search(r"^releaseNotes:\s*>-\n((?:.*\n)*?)(?=^\S)", text, re.M)
if not m:
    raise SystemExit("releaseNotes block not found in umbrel-app.yml")
own = m.group(1).split(f"  {marker}", 1)[0].rstrip()
new_block = (own + "\n\n\n" if own else "") + upstream
Path(path).write_text(text[: m.start(1)] + new_block + text[m.end(1):])
print(f"Updated the upstream release notes from official version {based_on}")
PY
  rm -f "$commits_file"
}

update_readme_version() {
  local version="$1" today
  today="$(date +%F)"
  python3 - "$STORE_ROOT/README.md" "$APP_ID" "$version" "$today" <<'PY'
import re, sys
from pathlib import Path
path, app_id, version, today = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
text = path.read_text()
text, a = re.subn(rf'(<td nowrap id="{app_id}-version"><code>)[^<]*(</code></td>)', rf"\g<1>{version}\g<2>", text, count=1)
text, b = re.subn(rf'(id="{app_id}-date">)\d{{4}}-\d{{2}}-\d{{2}}', rf"\g<1>{today}", text, count=1)
if a != 1 or b != 1:
    raise SystemExit("Could not find this app's version and date in the root README.md")
path.write_text(text)
PY
}

ensure_buildx() {
  # Capture first, then parse: piping into awk '{...; exit}' can SIGPIPE
  # docker, which under pipefail + set -e silently ends the script
  local info current driver
  info="$(docker buildx inspect 2>/dev/null || true)"
  current="$(awk '/^Name:/{print $2; exit}' <<<"$info")"
  driver="$(awk '/^Driver:/{print $2; exit}' <<<"$info")"
  if [[ "$driver" == "docker-container" ]] && docker buildx inspect --bootstrap >/dev/null 2>&1; then
    echo "Using current buildx builder: $current"
  elif docker buildx inspect --bootstrap multi-platform-builder >/dev/null 2>&1; then
    docker buildx use multi-platform-builder
    echo "Using buildx builder: multi-platform-builder"
  else
    echo "Creating buildx builder multi-platform-builder (linux/amd64, linux/arm64)..."
    docker buildx rm multi-platform-builder >/dev/null 2>&1 || true
    docker buildx create --driver docker-container --platform linux/amd64,linux/arm64 \
      --name multi-platform-builder --use >/dev/null
    docker buildx inspect --bootstrap >/dev/null 2>&1 || fail "Could not start the buildx builder multi-platform-builder"
  fi
}

# Builds and pushes one image, then prints its multi-arch digest
build_image() {
  local image="$1" context="$2" version="$3"
  echo "Building $image:$version (linux/amd64, linux/arm64)..." >&2
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --build-arg APP_VERSION="$version" \
    -t "$image:$version" \
    --push "$context" >&2
  local inspection digest
  inspection="$(docker buildx imagetools inspect "$image:$version")"
  grep -q 'Platform:[[:space:]]*linux/amd64' <<<"$inspection" || fail "$image:$version has no linux/amd64 image"
  grep -q 'Platform:[[:space:]]*linux/arm64' <<<"$inspection" || fail "$image:$version has no linux/arm64 image"
  digest="$(awk '/^Digest:/ {print $2; exit}' <<<"$inspection")"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "Could not read the digest of $image:$version"
  printf '%s\n' "$digest"
}

update_compose_image() {
  local image="$1" tag="$2" digest="$3"
  python3 - "$COMPOSE_FILE" "$image" "$tag" "$digest" <<'PY'
import re, sys
from pathlib import Path
path, image, tag, digest = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
text = path.read_text()
# Matches a real pin (tag@sha256:...) or the initial PENDING placeholder
regex = re.compile(re.escape(f"image: {image}:") + r"(?:[^@\s]+@sha256:[a-f0-9]{64}|PENDING@sha256:PENDING)")
text, count = regex.subn(f"image: {image}:{tag}@{digest}", text, count=1)
if count != 1:
    raise SystemExit(f"Could not update the {image} image in docker-compose.yml")
path.write_text(text)
PY
}

# A new GHCR package is private by default, and Umbrels can't pull it
check_public_image() {
  local image="$1" tag="$2" name token code
  name="${image#ghcr.io/}"
  token="$(curl -sf "https://ghcr.io/token?scope=repository:${name}:pull" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' || true)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/${name}/manifests/${tag}" || true)"
  if [[ "$code" != "200" ]]; then
    {
      echo ""
      echo "Error: $image:$tag can't be pulled without logging in (HTTP $code). New GHCR packages are private."
      echo "Open https://github.com/users/saltedlolly/packages/container/${name#saltedlolly/}/settings,"
      echo "set it to Public, and under Manage Actions access add umbrel-app-store with the Admin role."
      echo "The images are pushed and the files are updated but not committed. Once it's public, run:"
      echo "  $0 --publish --notes $(printf '%q' "$RELEASE_NOTES")"
      echo "(it releases the same version again, since it isn't on master yet)."
    } >&2
    exit 1
  fi
  echo "OK: $image:$tag can be pulled publicly"
}

validate_package() {
  echo "Validating package..."
  bash -n "$0"
  bash -n "$APP_ROOT/hooks/pre-start"
  python3 - "$COMPOSE_FILE" "$MANIFEST_FILE" "$APP_ID" <<'PY'
import re, sys
from pathlib import Path
compose = Path(sys.argv[1]).read_text()
manifest = Path(sys.argv[2]).read_text()
app_id = sys.argv[3]
if not re.search(rf"^id:\s*{re.escape(app_id)}$", manifest, re.M):
    raise SystemExit("Manifest id does not match the app folder")
for image in re.findall(r"^\s*image:\s*(\S+)", compose, re.M):
    if "PENDING" in image:
        raise SystemExit(f"Image still has a PENDING placeholder: {image}")
    if not re.search(r":[^@\s]+@sha256:[a-f0-9]{64}$", image):
        raise SystemExit(f"Image is not pinned by tag and digest: {image}")
if 'PROXY_AUTH_ADD: "false"' not in compose:
    raise SystemExit('Nostr clients need PROXY_AUTH_ADD: "false" on app_proxy')
PY
  local override
  override="$(mktemp)"
  printf '%s\n' 'services:' '  app_proxy:' '    image: docker.io/library/busybox:1.37.0' >"$override"
  APP_DATA_DIR="$APP_ROOT" UMBREL_ROOT="$APP_ROOT" docker compose -f "$COMPOSE_FILE" -f "$override" config --quiet
  rm -f "$override"
  git -C "$STORE_ROOT" diff --check -- "$APP_ID" README.md
  echo "Package validation passed."
}

# Commit/push failure handling. By the time we commit, the images are pushed
# and the release files are updated and staged, so a failed commit (often
# commit signing, e.g. 1Password locked or timed out) must not leave a mystery.
explain_failed_commit() {
  local msg="$1"
  {
    echo ""
    echo "❌ git commit failed (often commit signing: e.g. 1Password locked or timed out)."
    echo "Everything else is done: images are pushed and the release files are updated and staged."
    echo "Do NOT re-run this script with --bump - it would bump the version again."
    echo "Once the cause is fixed, finish the release with:"
    echo ""
    echo "  git -C $(printf '%q' "$STORE_ROOT") commit -m $(printf '%q' "$msg")"
    echo "  git -C $(printf '%q' "$STORE_ROOT") push"
    echo ""
  } >&2
  exit 1
}

explain_failed_push() {
  {
    echo ""
    echo "❌ git push failed. The release commit was made locally."
    echo "Once the cause is fixed (network, or pull if GitHub moved on), run:"
    echo ""
    echo "  git -C $(printf '%q' "$STORE_ROOT") push"
    echo ""
  } >&2
  exit 1
}

check_git_sync() {
  echo "Checking repository sync status..."
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
  local current_branch
  current_branch=$(git -C "$store_root" rev-parse --abbrev-ref HEAD)

  # 4. Check if behind remote
  local behind
  behind=$(git -C "$store_root" rev-list HEAD..origin/$current_branch --count 2>/dev/null || echo "0")
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
  local ahead
  ahead=$(git -C "$store_root" rev-list origin/$current_branch..HEAD --count 2>/dev/null || echo "0")
  if [[ "$ahead" -gt 0 ]]; then
    echo "ℹ️  Note: You have $ahead unpushed commit(s)"
  fi

  echo "✓ Repository is in sync with origin/$current_branch"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --localtest) MODE="localtest"; shift ;;
    --publish) MODE="publish"; shift ;;
    --bump) FORCE_BUMP=true; shift ;;
    --based-on) NEW_BASED_ON="${2:-}"; shift 2 ;;
    --notes) RELEASE_NOTES="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; fail "Unknown option: $1" ;;
  esac
done

# Git sync check (if publishing)
if [[ "${PUBLISH_TO_GITHUB:-false}" == "true" ]] || [[ "${MODE:-}" == "publish" ]]; then
  check_git_sync
  echo ""
fi

require_command python3; require_command curl; require_command git

CURRENT_VERSION="$(current_manifest_version)"
[[ "$CURRENT_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail "Unexpected version in umbrel-app.yml: $CURRENT_VERSION"
BASED_ON="$(recorded_based_on)"
OFFICIAL_VERSION="$(latest_official_version || true)"

if [[ -n "$NEW_BASED_ON" ]]; then
  [[ "$NEW_BASED_ON" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-patch\.[0-9]+)?$ ]] || fail "Unexpected --based-on version: $NEW_BASED_ON"
  NEW_BASED_ON="${NEW_BASED_ON#v}"
fi

NOTES_MODE="prepend"
if [[ -n "$NEW_BASED_ON" && "$(base_of "$NEW_BASED_ON")" != "$(base_of "$BASED_ON")" ]]; then
  # A new official base: bare version, release notes start afresh
  TARGET_VERSION="v$(base_of "$NEW_BASED_ON")"
  NOTES_MODE="reset"
elif [[ "$FORCE_BUMP" == "true" || ( -n "$NEW_BASED_ON" && "$NEW_BASED_ON" != "$BASED_ON" ) ]]; then
  # A fix, or an official patch release (same base) merged on top
  if [[ "$CURRENT_VERSION" =~ ^(v[0-9]+\.[0-9]+\.[0-9]+)\.([0-9]+)$ ]]; then
    TARGET_VERSION="${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1))"
  else
    TARGET_VERSION="${CURRENT_VERSION}.1"
  fi
else
  TARGET_VERSION="$CURRENT_VERSION"
fi
TARGET_BASED_ON="${NEW_BASED_ON:-$BASED_ON}"

echo
echo "Current version:            $CURRENT_VERSION"
echo "Based on official version:  $BASED_ON"
echo "Latest official version:    ${OFFICIAL_VERSION:-unknown (could not fetch)}"
echo "Version to release:         $TARGET_VERSION (based on $TARGET_BASED_ON)"
echo
if [[ -n "$OFFICIAL_VERSION" && "$OFFICIAL_VERSION" != "$TARGET_BASED_ON" ]]; then
  echo "Note: the official Nostr Relay app is at $OFFICIAL_VERSION. Its source isn't public, so changes"
  echo "      must be merged by hand from its images, then released with --based-on $OFFICIAL_VERSION."
  echo "      History: $OFFICIAL_HISTORY_URL"
  echo
fi

if [[ "$MODE" == "check" ]]; then
  exit 0
fi

[[ "$MODE" != "publish" || -n "$RELEASE_NOTES" ]] || fail "--publish requires --notes"
[[ -n "$RELEASE_NOTES" ]] || RELEASE_NOTES="Local test build."

# A version that is already on master must not be released again: Umbrel
# wouldn't offer it as an update. Use --bump instead.
RELEASED_MANIFEST="$(git -C "$STORE_ROOT" show "origin/master:$APP_ID/umbrel-app.yml" 2>/dev/null || true)"
if [[ -n "$RELEASED_MANIFEST" ]] && grep -qE "^version:[[:space:]]*\"${TARGET_VERSION//./\\.}\"" <<<"$RELEASED_MANIFEST"; then
  fail "$TARGET_VERSION is already released on master. Use --bump for a fix, or --based-on after merging a new official version."
fi

if [[ "$MODE" == "publish" ]]; then
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | grep -vE "^(${APP_ID}/|README\.md$)" || true)"
  [[ -z "$staged_outside" ]] || fail "Unstage unrelated files before publishing: $staged_outside"
fi

require_command docker
ensure_buildx
UI_DIGEST="$(build_image "$UI_IMAGE" "$UI_CONTEXT" "$TARGET_VERSION")"
echo "UI digest: $UI_DIGEST"
PROXY_DIGEST="$(build_image "$PROXY_IMAGE" "$PROXY_CONTEXT" "$TARGET_VERSION")"
echo "Relay proxy digest: $PROXY_DIGEST"

update_compose_image "$UI_IMAGE" "$TARGET_VERSION" "$UI_DIGEST"
update_compose_image "$PROXY_IMAGE" "$TARGET_VERSION" "$PROXY_DIGEST"
set_manifest_version "$TARGET_VERSION"
[[ "$TARGET_BASED_ON" != "$BASED_ON" ]] && set_based_on "$TARGET_BASED_ON"
write_release_entry "$TARGET_VERSION" "$RELEASE_NOTES" "$NOTES_MODE"
update_upstream_notes "$TARGET_BASED_ON"
update_readme_version "$TARGET_VERSION"
validate_package

if [[ "$MODE" == "localtest" ]]; then
  echo
  echo "Built and pushed $TARGET_VERSION; files updated but not committed. Review with: git diff -- $APP_ID README.md"
  exit 0
fi

check_public_image "$UI_IMAGE" "$TARGET_VERSION"
check_public_image "$PROXY_IMAGE" "$TARGET_VERSION"

# Scoped staging only: this app's folder and the root README. Never git add -A.
git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/README.md"
git -C "$STORE_ROOT" diff --cached --quiet && fail "There are no $APP_NAME changes to publish"
release_msg="release: $APP_NAME $TARGET_VERSION - $RELEASE_NOTES"
git -C "$STORE_ROOT" commit -m "$release_msg" || explain_failed_commit "$release_msg"
git -C "$STORE_ROOT" push || explain_failed_push
echo
echo "Published $APP_NAME $TARGET_VERSION"
echo "  UI:          $UI_IMAGE:$TARGET_VERSION@$UI_DIGEST"
echo "  Relay proxy: $PROXY_IMAGE:$TARGET_VERSION@$PROXY_DIGEST"
