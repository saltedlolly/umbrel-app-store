#!/usr/bin/env bash
set -euo pipefail

# Track goauthentik/authentik releases and pin docker-compose.yml to the
# multi-arch manifest digest of ghcr.io/goauthentik/server. Also sets the
# umbrel-app.yml version, release notes and the root README.md.
#
# Nothing is built: the image is public and multi-arch (no Dockerfile, no
# registry login).
#
# Authentik must be upgraded one release family at a time (2026.5.x ->
# 2026.8.x -> ...; it refuses to start on a database more than one family
# old). So:
# - The next version is the newest patch of the current family, or else the
#   newest patch of the NEXT family, never further (--next-version).
# - When moving to a new family, the old family's newest patch is added to
#   hooks/pre-start's STEPPING_STONES, which walks installs that skipped app
#   updates through each family in turn.
# Versions are compared by number, not release date: older families keep
# getting patches after newer ones ship (2026.2.7 came out after 2026.8.1).
#
# PostgreSQL stays pinned by hand (major upgrades need a dump and restore).
#
# Requirements: Docker (for `docker buildx imagetools inspect`), python3,
# curl, macOS (BSD sed) or Linux (GNU sed)
#
# Usage examples:
#   ./authentik-build.sh --next-version --min-age-days 2
#     # Print the next eligible Authentik version (empty if none) and exit (CI)
#
#   ./authentik-build.sh --authentik-version 2026.11.0 --publish --notes "..."
#     # Pin this exact Authentik version, commit and push (CI)
#
#   ./authentik-build.sh --bump --notes "Fix something" --publish
#     # Local packaging fix on the same Authentik version (2026.8.3 -> 2026.8.3.1)
#
#   ./authentik-build.sh --publish --notes "..."
#     # Move to the next eligible Authentik version (if any), commit and push

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$SCRIPT_DIR"
APP_ID="saltedlolly-authentik"

COMPOSE_FILE="$APP_ROOT/docker-compose.yml"
APP_YML_FILE="$APP_ROOT/umbrel-app.yml"
HOOK_FILE="$APP_ROOT/hooks/pre-start"

AUTHENTIK_IMAGE="ghcr.io/goauthentik/server"
UPSTREAM_REPO="goauthentik/authentik"
RELEASE_NOTES_MARKER="--- goauthentik/authentik upstream release notes (auto-updated) ---"

AUTHENTIK_VERSION_OVERRIDE=""
SET_VERSION=""
RELEASE_NOTES=""
PUBLISH_TO_GITHUB=false
FORCE_BUMP=false
NEXT_VERSION_ONLY=false
MIN_AGE_DAYS=0

is_macos=false
if [[ "${OSTYPE:-}" == darwin* ]]; then is_macos=true; fi

usage() {
  cat >&2 <<EOF
Usage: $0 [OPTIONS]

Options:
  -h, --help                  : Show this help message
  --version <X.Y.Z[.N]>       : Set explicit app version (e.g. 2026.8.3 or 2026.8.3.1)
  --bump                      : Local packaging fix on the same Authentik version -
                                appends/increments a trailing patch number
  --notes <text>              : Release notes (required with --publish)
  --authentik-version <X.Y.Z> : Pin this exact Authentik version, skipping the
                                release lookup (for CI)
  --next-version              : Print the next eligible Authentik version (or
                                nothing) and exit. Never skips a release family
  --min-age-days <N>          : With --next-version or a lookup: only consider
                                releases at least N days old (CI uses 2)
  --publish                   : Update files, commit, and push to GitHub

Version numbering: the app version is Authentik's version exactly (2026.8.3).
A local-only fix appends a patch number (2026.8.3.1), which resets on the
next Authentik update.
EOF
}

extract_current_authentik_version() {
  grep -oE "${AUTHENTIK_IMAGE}:[0-9]+\.[0-9]+\.[0-9]+" "$COMPOSE_FILE" | head -1 | sed -E 's/.*://'
}

extract_full_version() {
  awk -F'"' '/^version:/ {print $2; exit}' "$APP_YML_FILE"
}

family() { echo "$1" | cut -d. -f1,2; }

set_version_in_app_yml() {
  local newv="$1"
  if $is_macos; then
    sed -E -i '' "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  else
    sed -E -i "s/^(version:[[:space:]]*)\"[^\"]+\"/\\1\"${newv}\"/" "$APP_YML_FILE"
  fi
}

# Stable releases as "X.Y.Z published_at", from the GitHub API
fetch_releases() {
  local out
  out="$(mktemp)"
  if ! curl -sf ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
      "https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=100" -o "$out"; then
    rm -f "$out"
    echo "❌ Error: could not fetch ${UPSTREAM_REPO} releases" >&2
    return 1
  fi
  python3 - "$out" <<'PY'
import json, re, sys
for r in json.load(open(sys.argv[1])):
    m = re.fullmatch(r"version/(\d+\.\d+\.\d+)", r["tag_name"])
    if m and not r["draft"] and not r["prerelease"]:
        print(m.group(1), r["published_at"])
PY
  rm -f "$out"
}

# Next version after $1: newest patch in the same family, else the newest
# patch of the next family. Releases younger than $2 days are ignored.
next_version_after() {
  local current="$1" min_age="$2" releases
  releases="$(fetch_releases)" || return 1
  python3 - "$current" "$min_age" <<PY
import sys
from datetime import datetime, timedelta, timezone
current, min_age = sys.argv[1], int(sys.argv[2])
cutoff = datetime.now(timezone.utc) - timedelta(days=min_age)
key = lambda v: tuple(int(x) for x in v.split("."))
vers = []
for line in """$releases""".strip().splitlines():
    v, published = line.split()
    if datetime.fromisoformat(published.replace("Z", "+00:00")) <= cutoff:
        vers.append(v)
cur, cur_fam = key(current), key(current)[:2]
same = [v for v in vers if key(v)[:2] == cur_fam and key(v) > cur]
if same:
    print(max(same, key=key)); sys.exit()
newer_fams = sorted({key(v)[:2] for v in vers if key(v)[:2] > cur_fam})
if newer_fams:
    nf = newer_fams[0]
    print(max((v for v in vers if key(v)[:2] == nf), key=key))
PY
}

# Newest released patch of family $1 (e.g. 2026.8 -> 2026.8.3)
latest_in_family() {
  local fam="$1" releases
  releases="$(fetch_releases)" || return 1
  python3 - "$fam" <<PY
import sys
fam = tuple(int(x) for x in sys.argv[1].split("."))
key = lambda v: tuple(int(x) for x in v.split("."))
vers = [l.split()[0] for l in """$releases""".strip().splitlines()]
match = [v for v in vers if key(v)[:2] == fam]
if match:
    print(max(match, key=key))
PY
}

image_digest() {
  docker buildx imagetools inspect "$1" 2>/dev/null | awk '/^Digest:/ {print $2; exit}'
}

# Rewrite every ghcr.io/goauthentik/server:<ver>@sha256:... pin (server + worker)
update_compose_pins() {
  local new_tag="$1" new_digest="$2"
  local pattern="(ghcr\\.io/goauthentik/server:)[0-9]+\\.[0-9]+\\.[0-9]+@sha256:[a-f0-9]+"
  if $is_macos; then
    sed -E -i '' "s|$pattern|\\1${new_tag}@${new_digest}|g" "$COMPOSE_FILE"
  else
    sed -E -i "s|$pattern|\\1${new_tag}@${new_digest}|g" "$COMPOSE_FILE"
  fi
}

# Add (or replace) the stepping stone for a release family in hooks/pre-start
set_stepping_stone() {
  local version="$1" image_ref="$2"
  python3 - "$HOOK_FILE" "$version" "$image_ref" <<'PY'
import re, sys
path, version, image_ref = sys.argv[1:4]
fam = ".".join(version.split(".")[:2])
s = open(path).read()
m = re.search(r"(# BEGIN STEPPING STONES\nSTEPPING_STONES=\(\n)(.*?)(\)\n# END STEPPING STONES)", s, re.S)
if not m:
    sys.exit("STEPPING_STONES block not found in hooks/pre-start")
key = lambda v: tuple(int(x) for x in v.split("."))
entries = [l.strip().strip('"') for l in m.group(2).splitlines() if l.strip().startswith('"')]
entries = [e for e in entries if ".".join(e.split()[0].split(".")[:2]) != fam]
entries.append(f"{version} {image_ref}")
entries.sort(key=lambda e: key(e.split()[0]))
body = "".join(f'  "{e}"\n' for e in entries)
open(path, "w").write(s[:m.start(2)] + body + s[m.end(2):])
PY
}

# New upstream release: release notes start afresh (current upstream release
# plus later patches only)
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

# Regenerate the upstream part of releaseNotes (below the marker) from the
# Authentik release this version ships, cut at 40 lines
update_release_notes() {
  local target_tag="version/$1"
  echo "Fetching ${UPSTREAM_REPO}'s release notes for $target_tag..."
  local release_file
  release_file="$(mktemp)"
  if ! curl -sf ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
      "https://api.github.com/repos/${UPSTREAM_REPO}/releases/tags/${target_tag//\//%2F}" -o "$release_file"; then
    echo "⚠️  Could not fetch upstream release notes, leaving releaseNotes as-is" >&2
    rm -f "$release_file"
    return
  fi

  python3 - "$APP_YML_FILE" "$RELEASE_NOTES_MARKER" "$release_file" "$UPSTREAM_REPO" <<'PY'
import json
import re
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
marker = sys.argv[2]
r = json.loads(Path(sys.argv[3]).read_text())
repo_label = sys.argv[4]

MAX_UPSTREAM_LINES = 40  # longer upstream notes are cut, with a link to the full text


def format_body(body: str, url: str = "") -> str:
    lines = body.replace("\r\n", "\n").strip("\n").split("\n")
    out = []
    for line in lines:
        line = re.sub(r"^#{2,4}\s*", "", line).rstrip()
        out.append(("    " + line) if line else "")
    if len(out) > MAX_UPSTREAM_LINES:
        out = out[:MAX_UPSTREAM_LINES]
        while out and not out[-1]:
            out.pop()
        out += ["", f"    … (truncated) Full release notes: {url}"]
    return "\n".join(out)


version = r["tag_name"].removeprefix("version/")
upstream_block = f"  {repo_label} {version}\n\n{format_body(r.get('body') or '(no notes provided)', r.get('html_url', ''))}"
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
manifest_path.write_text(text[: m.start(1)] + new_block + text[m.end(1) :])
print(f"✓ Updated releaseNotes with {version}")
PY
  rm -f "$release_file"
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

  python3 - "$README_FILE" "$new_version" "$today" "$APP_ID" <<'PY'
from pathlib import Path
import re
import sys

readme_path, new_version, today, app_id = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
text = readme_path.read_text()
text, n1 = re.subn(
    rf'(<td nowrap id="{app_id}-version"><code>)[^<]*(</code></td>)',
    rf"\g<1>{new_version}\g<2>", text, count=1)
text, n2 = re.subn(
    rf'id="{app_id}-date">(\d{{4}}-\d{{2}}-\d{{2}})',
    f'id="{app_id}-date">{today}', text, count=1)
if not (n1 and n2):
    sys.exit(f"README.md has no {app_id} version/date cells")
readme_path.write_text(text)
PY
  echo "✓ Updated README.md: $new_version, $today"
}

# Commit/push failure handling. By the time we commit, the release files are
# updated and staged, so a failed commit (often commit signing, e.g.
# 1Password locked or timed out) must not leave a mystery. Re-running the
# script would bump the version again, so explain how to finish.
explain_failed_commit() {
  local msg="$1" root
  root="$(git rev-parse --show-toplevel)"
  {
    echo ""
    echo "❌ git commit failed (often commit signing: e.g. 1Password locked or timed out)."
    echo "Everything else is done: the release files are updated and staged."
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

  local store_root="${STORE_ROOT:-$(cd "$APP_ROOT/.." && pwd)}"

  if ! git -C "$store_root" diff-index --quiet HEAD --; then
    echo "❌ Error: You have uncommitted changes"
    echo "Commit or stash them first, then try again"
    exit 1
  fi

  git -C "$store_root" fetch origin >/dev/null 2>&1

  local current_branch=$(git -C "$store_root" rev-parse --abbrev-ref HEAD)

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

  local ahead=$(git -C "$store_root" rev-list origin/$current_branch..HEAD --count 2>/dev/null || echo "0")
  if [[ "$ahead" -gt 0 ]]; then
    echo "ℹ️  Note: You have $ahead unpushed commit(s)"
  fi

  echo "✓ Repository is in sync with origin/$current_branch"
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
    --authentik-version) AUTHENTIK_VERSION_OVERRIDE="$2"; shift 2 ;;
    --next-version) NEXT_VERSION_ONLY=true; shift ;;
    --min-age-days) MIN_AGE_DAYS="$2"; shift 2 ;;
    --publish) PUBLISH_TO_GITHUB=true; shift ;;
    *) usage; exit 1 ;;
  esac
done

# Git sync check (if publishing)
if [[ "${PUBLISH_TO_GITHUB:-false}" == "true" ]] || [[ "${MODE:-}" == "publish" ]]; then
  check_git_sync
  echo ""
fi

current_authentik="$(extract_current_authentik_version)"
if [[ -z "$current_authentik" ]]; then
  echo "❌ Error: could not read the pinned Authentik version from $COMPOSE_FILE" >&2
  exit 1
fi

if $NEXT_VERSION_ONLY; then
  next_version_after "$current_authentik" "$MIN_AGE_DAYS"
  exit 0
fi

if [[ "$PUBLISH_TO_GITHUB" == "true" && -z "$RELEASE_NOTES" ]]; then
  echo "❌ Error: --publish needs --notes \"what changed\"" >&2
  exit 1
fi

########################################
# Choose and pin the Authentik version
########################################
echo "Current Authentik version: $current_authentik"
if [[ -n "$AUTHENTIK_VERSION_OVERRIDE" ]]; then
  target_authentik="$AUTHENTIK_VERSION_OVERRIDE"
  echo "Using explicitly supplied Authentik version: $target_authentik"
elif $FORCE_BUMP; then
  target_authentik="$current_authentik"
else
  target_authentik="$(next_version_after "$current_authentik" "$MIN_AGE_DAYS")"
  target_authentik="${target_authentik:-$current_authentik}"
  echo "Next eligible Authentik version: $target_authentik"
fi

if ! [[ "$target_authentik" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ Error: unexpected Authentik version '$target_authentik'" >&2
  exit 1
fi

# Never let a release skip a family: installs from the version before this
# one must be able to start (the pre-start hook covers older ones).
# Authentik accepts any patch of the previous family, so compare families:
# asking for the version after "<current family>.99999" gives the newest
# patch of the next family.
if [[ "$(family "$target_authentik")" != "$(family "$current_authentik")" ]]; then
  next_family_version="$(next_version_after "$(family "$current_authentik").99999" 0 || true)"
  if [[ -n "$next_family_version" && "$(family "$next_family_version")" != "$(family "$target_authentik")" ]]; then
    echo "❌ Error: $current_authentik -> $target_authentik skips the $(family "$next_family_version") release family" >&2
    exit 1
  fi
fi

AUTHENTIK_CHANGED=false
if [[ "$target_authentik" != "$current_authentik" ]]; then
  AUTHENTIK_CHANGED=true
  echo "Fetching digest for $AUTHENTIK_IMAGE:$target_authentik..."
  digest="$(image_digest "$AUTHENTIK_IMAGE:$target_authentik")"
  if [[ -z "$digest" ]]; then
    echo "❌ Error: could not fetch digest for $AUTHENTIK_IMAGE:$target_authentik" >&2
    exit 1
  fi
  update_compose_pins "$target_authentik" "$digest"
  echo "✓ Pinned $AUTHENTIK_IMAGE:$target_authentik@$digest"

  # Moving to a new release family: the old family becomes a stepping stone
  old_family="$(family "$current_authentik")"
  if [[ "$old_family" != "$(family "$target_authentik")" ]]; then
    stone_version="$(latest_in_family "$old_family")"
    stone_version="${stone_version:-$current_authentik}"
    stone_digest="$(image_digest "$AUTHENTIK_IMAGE:$stone_version")"
    if [[ -z "$stone_digest" ]]; then
      echo "❌ Error: could not fetch digest for stepping stone $AUTHENTIK_IMAGE:$stone_version" >&2
      exit 1
    fi
    set_stepping_stone "$stone_version" "$AUTHENTIK_IMAGE:$stone_version@$stone_digest"
    echo "✓ Added stepping stone $stone_version to hooks/pre-start"
  fi
elif ! $FORCE_BUMP && [[ -z "$SET_VERSION" ]]; then
  echo "✓ Already on the newest eligible Authentik version, nothing to release"
  exit 0
fi

########################################
# Determine the app version
########################################
current_full_v="$(extract_full_version)"
if [[ "$current_full_v" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.([0-9]+)$ ]]; then
  current_app_patch="${BASH_REMATCH[1]}"
else
  current_app_patch="0"
fi

target_v="$SET_VERSION"
if [[ -z "$target_v" ]]; then
  if $AUTHENTIK_CHANGED; then
    target_v="$target_authentik"
  else
    target_v="${target_authentik}.$((current_app_patch + 1))"
  fi
fi

echo "Current app version: $current_full_v"
echo "Target app version:  $target_v"
echo

########################################
# Update umbrel-app.yml and README.md
########################################
set_version_in_app_yml "$target_v"
update_readme_version "$target_v"

if [[ -n "$RELEASE_NOTES" ]]; then
  # A new Authentik version (or an explicit bare version, e.g. the first
  # release) starts the notes afresh; a packaging patch is added on top
  if $AUTHENTIK_CHANGED || [[ "$target_v" == "$target_authentik" ]]; then
    reset_release_notes "$APP_YML_FILE" "$target_v" "$RELEASE_NOTES"
  else
    prepend_release_notes "$target_v" "$RELEASE_NOTES"
  fi
  update_release_notes "$target_authentik"
fi

echo
echo "=== Done ==="
echo "  - umbrel-app.yml (version: $target_v)"
echo "  - docker-compose.yml (Authentik: $target_authentik)"
echo

if [[ "$PUBLISH_TO_GITHUB" == "true" ]]; then
  echo "========================================"
  echo "PUBLISHING TO GITHUB"
  echo "========================================"
  echo

  STORE_ROOT="$(cd "$APP_ROOT/.." && pwd)"

  # Scoped staging only - never `git add -A`: this app's folder and the root
  # README this script updates
  staged_outside="$(git -C "$STORE_ROOT" diff --cached --name-only | \
    awk -v prefix="${APP_ID}/" 'index($0, prefix) != 1 && $0 != "README.md" {print}')"
  if [[ -n "$staged_outside" ]]; then
    echo "Already-staged files outside ${APP_ID}/ and README.md:" >&2
    echo "$staged_outside" >&2
    echo "Unstage unrelated files before publishing" >&2
    exit 1
  fi

  echo "Committing changes..."
  git -C "$STORE_ROOT" add -- "$APP_ROOT" "$STORE_ROOT/README.md"
  release_msg="release: Authentik ${target_v} - ${RELEASE_NOTES}"
  git -C "$STORE_ROOT" commit -m "$release_msg" || explain_failed_commit "$release_msg"
  echo "Pushing to GitHub..."
  git -C "$STORE_ROOT" push || explain_failed_push
  echo
  echo "✓ Successfully published ${target_v} to GitHub"
  echo
else
  echo "Next steps:"
  echo "  1. Review changes: git diff"
  echo "  2. Publish: ./authentik-build.sh --publish --notes \"...\""
fi
