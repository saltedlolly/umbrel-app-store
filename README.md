## Olly's Umbrel Community App Store

This is my Umbrel Community App Store. Apps here are a work in progress. Use at your own risk.

### Multi-Arch Docker Images (arm64 + amd64)

Umbrel Home devices are typically arm64. To avoid “exec format error” when installing apps, publish multi-arch Docker images and pin the multi-arch manifest digests in saltedlolly-cloudflare-ddns/docker-compose.yml.

#### One-Time Setup

- Install Docker Buildx and log in to Docker Hub.
- Ensure your Dockerfiles produce Linux-compatible images and any shell scripts have LF line endings and executable bit.

#### Build + Bump + Pin Workflow

For the Cloudflare DDNS app in saltedlolly-cloudflare-ddns/:

1) Run the helper script (auto-bumps app version, tags images to match, builds/pushes multi-arch, and pins digests):

```bash
saltedlolly-cloudflare-ddns/tools/build-and-pin.sh
```

The script defaults to looking for UI and DDNS repos in parallel directories:
- `../cloudflare-ddns-ui`
- `../cloudflare-ddns`

If your repos are elsewhere, override via flags or env vars:

```bash
saltedlolly-cloudflare-ddns/tools/build-and-pin.sh \
  --ui-repo /path/to/ui \
  --ddns-repo /path/to/ddns
```

Options:
- Set explicit version: `--version 0.0.14`
- Choose bump kind: `--bump patch|minor|major` (default: patch)
- Custom release notes: `--notes "Upgrade upstream favonia/cloudflare-ddns and improve logging"`

Example with options:

```bash
saltedlolly-cloudflare-ddns/tools/build-and-pin.sh \
  --bump minor \
  --notes "Upgrade upstream favonia/cloudflare-ddns to latest"
```
git push
```

3) Reinstall from your Umbrel community app store; it will pull the correct arch automatically.

#### Notes

- No SSH-side tweaks should be required. Multi-arch images + pinned digests guarantee the right binary on Umbrel Home.
- If you bump upstream Cloudflare DDNS, rerun the script; it will bump the app version and push new images/tags matching that version.

### Multi-Arch Docker Images (arm64 + amd64)

Umbrel Home devices are typically arm64. To avoid “exec format error” when installing apps, publish multi-arch Docker images and pin the multi-arch manifest digests in `docker-compose.yml`.

#### One-Time Setup

- Install Docker Buildx and log in to Docker Hub.
- Ensure your Dockerfiles produce Linux-compatible images and any shell scripts have LF line endings and executable bit.

#### Build + Pin Workflow

For the Cloudflare DDNS app in `saltedlolly-cloudflare-ddns/`:

1. Build and push multi-arch images for both services.
2. Fetch the multi-arch manifest digests.
3. Update `docker-compose.yml` to pin to those digests.
4. Bump `umbrel-app.yml` version and write release notes.

You can automate steps 1–3 with the helper script:

```
saltedlolly-cloudflare-ddns/tools/build-and-pin.sh \
	--ui-repo ../cloudflare-ddns-ui \
	--ui-tag 0.0.13 \
	--ddns-repo ../cloudflare-ddns \
	--ddns-tag 0.0.11
```

This script will:
- Build `saltedlolly/cloudflare-ddns-ui:<ui-tag>` and `saltedlolly/cloudflare-ddns:<ddns-tag>` for `linux/amd64,linux/arm64`.
- Fetch their multi-arch manifest digests.
- Update `saltedlolly-cloudflare-ddns/docker-compose.yml` to pin `image: ...@sha256:<digest>` for each.

Finally, commit and push:

```
git add -A && git commit -m "chore: pin multi-arch digests (ui <ui-tag>, ddns <ddns-tag>)" && git push
```

Then bump the app version and release notes in `saltedlolly-cloudflare-ddns/umbrel-app.yml` so Umbrel can pick up the update from your community app store.

#### Notes

- Umbrel installs should not require SSH tweaks. Multi-arch images + pinned digests ensure the right binary is pulled automatically.
- If you bump upstream Cloudflare DDNS, re-run the script with the new tag to republish and pin.