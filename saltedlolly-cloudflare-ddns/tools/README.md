# build-and-pin.sh

Automated multi-arch Docker build and digest pinning for Umbrel app releases.

## Location Requirements

**Important:** You can run this script from anywhere, but it expects specific folder structure:

```
saltedlolly-cloudflare-ddns/
├── tools/
│   └── build-and-pin.sh          ← The script
├── ui/                            ← UI container source
├── cloudflare-ddns/              ← DDNS wrapper source
├── docker-compose.yml            ← Will be updated with digests
└── umbrel-app.yml                ← Version source of truth
```

The script automatically finds the app root from its own location, so you can run it from any directory.

## What It Does

1. **Version Management**
   - Reads current version from `umbrel-app.yml`
   - Bumps version (patch/minor/major) or uses explicit version
   - Updates version in `umbrel-app.yml` AND `package.json`
   - Prepends release notes to `umbrel-app.yml`

2. **Multi-Arch Builds**
   - Builds for linux/amd64 and linux/arm64
   - Pushes to Docker Hub (saltedlolly/*)
   - Tags images with version number
   - Passes version as build ARG (baked into container as version.json)

3. **Digest Pinning**
   - Extracts sha256 digests from pushed manifests
   - Updates `docker-compose.yml` with immutable digest references
   - Ensures exact image versions are deployed

## Syntax

### Basic Usage (Patch Bump)
```bash
tools/build-and-pin.sh
```
Bumps patch version (1.0.12 → 1.0.13), builds both images, pins digests.

### Explicit Version
```bash
tools/build-and-pin.sh --version 2.0.0
```
Sets exact version instead of auto-bumping.

### Version Bump Types
```bash
tools/build-and-pin.sh --bump minor    # 1.0.12 → 1.1.0
tools/build-and-pin.sh --bump major    # 1.0.12 → 2.0.0
tools/build-and-pin.sh --bump patch    # 1.0.12 → 1.0.13 (default)
```

### Custom Release Notes
```bash
tools/build-and-pin.sh --notes "Add IPv6 support and health check notifications"
```
Prepends custom notes to `releaseNotes` in umbrel-app.yml.

### Combined Options
```bash
tools/build-and-pin.sh --bump minor --notes "Major UI redesign with dark mode"
```

## Requirements

- **Docker Buildx** with docker-container driver for multi-platform builds
- **Docker Hub login** for saltedlolly/* repositories
- **Git** working directory (changes are not auto-committed)
- **macOS or Linux** (BSD or GNU sed)

## Output Files Modified

After running, these files will have uncommitted changes:
- `umbrel-app.yml` - Updated version and release notes
- `ui/package.json` - Synced version number
- `docker-compose.yml` - Updated image digests

**Remember to commit and push these changes:**
```bash
git add -A
git commit -m "release: v1.0.13"
git push
```

## Troubleshooting

### "Error: Could not read current version"
Check that `umbrel-app.yml` has a valid `version: "x.y.z"` line.

### "No manifest found"
Ensure you're logged in to Docker Hub: `docker login`

### Digest not updating
The script strips trailing `*` from builder names (macOS compatibility).
If it fails, check your buildx builder: `docker buildx ls`

### Version not showing in UI
The version is baked into the container at build time as `version.json`.
After updating, you must recreate containers (not just restart) to see new version.

## Version Flow

```
umbrel-app.yml version
       ↓
Docker build --build-arg VERSION=x.y.z
       ↓
Dockerfile creates version.json
       ↓
Container serves /api/version
       ↓
Footer displays version badge
```

This ensures the version displayed always matches the actual running container.
