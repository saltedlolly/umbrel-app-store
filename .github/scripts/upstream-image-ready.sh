#!/usr/bin/env bash
# Usage: upstream-image-ready.sh <image:tag>
#
# Exits 0 when <image:tag> is published for both linux/amd64 and linux/arm64,
# otherwise prints a GitHub Actions notice and exits 1.
#
# The auto-release workflows call this before treating an upstream release as
# an update. Upstream projects often publish the GitHub release before their
# CI has pushed the image (crowdsecurity/crowdsec v1.8.2 was released on
# GitHub on 2026-10-26, its image appeared on Docker Hub on 2026-10-29), and
# the 2-day buffer alone doesn't cover that. Skipping instead of failing lets
# the next daily run pick it up.
set -euo pipefail

ref="${1:?usage: upstream-image-ready.sh <image:tag>}"

raw="$(docker buildx imagetools inspect --raw "$ref" 2>/dev/null || true)"
if [[ -z "$raw" ]]; then
  echo "::notice::$ref isn't published yet - skipping, will retry tomorrow"
  exit 1
fi

platforms="$(jq -r '.manifests[]?.platform | select(. != null) | "\(.os)/\(.architecture)"' <<< "$raw")"
for platform in linux/amd64 linux/arm64; do
  if ! grep -qx "$platform" <<< "$platforms"; then
    echo "::notice::$ref has no $platform image yet - skipping, will retry tomorrow"
    exit 1
  fi
done

echo "$ref is published for linux/amd64 and linux/arm64"
