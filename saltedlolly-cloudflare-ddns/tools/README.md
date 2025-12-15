# build.sh

Automated multi-arch Docker build and digest pinning for Umbrel app releases.

## Location

The script is located in the app root directory:

```
saltedlolly-cloudflare-ddns/
├── build.sh                      ← The build script (you are here)
├── ui/                            ← UI container source
├── cloudflare-ddns/              ← DDNS wrapper source
├── docker-compose.yml            ← Will be updated with digests
└── umbrel-app.yml                ← Version source of truth
```

Run it from the app root directory for easiest usage.

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

### Show Help
```bash
./build.sh --help
./build.sh -h
```

### Basic Usage (Patch Bump)
```bash
./build.sh
```
Bumps patch version (1.0.12 → 1.0.13), builds both images, pins digests.

### Explicit Version
```bash
./build.sh --version 2.0.0
```
Sets exact version instead of auto-bumping.

### Version Bump Types
```bash
./build.sh --bump minor    # 1.0.12 → 1.1.0
./build.sh --bump major    # 1.0.12 → 2.0.0
./build.sh --bump patch    # 1.0.12 → 1.0.13 (default)
```

### Custom Release Notes
```bash
./build.sh --notes "Add IPv6 support and health check notifications"
```
Prepends custom notes to `releaseNotes` in umbrel-app.yml.

### Combined Options
```bash
./build.sh --bump minor --notes "Major UI redesign with dark mode"
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
