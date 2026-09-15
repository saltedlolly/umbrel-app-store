# Kubo (IPFS) for Umbrel

A self-hosted [Kubo](https://github.com/ipfs/kubo) node - the reference implementation of [IPFS](https://ipfs.tech/), a peer-to-peer network for storing and sharing content-addressed data. Includes the official WebUI for managing peers, pinning and browsing content, and monitoring bandwidth and repository usage.

This package was built from scratch rather than derived from any existing community Kubo package, after finding that an existing one (from a different developer's Umbrel Community App Store) had a design that never actually worked as intended - see [Background](#background) below.

## Ports

| Purpose | Port | Exposure |
| --- | ---: | --- |
| WebUI + RPC API | `5001` | Umbrel SSO only (`app_proxy`) |
| Swarm (P2P) | `4001` (tcp+udp) | Published directly |

The API port is **never published to the host at all** - `app_proxy` reaches it over the internal Docker network. Upstream's own docs call this port "admin-level access to your IPFS node" and recommend binding it to localhost only; not publishing it at all is stricter than that, with Umbrel SSO as the auth gate.

The Gateway (`8080`, serves IPFS content over plain HTTP to anyone who can reach it) and swarm-over-websockets (`8081`) are **not exposed** in this initial release - the Gateway in particular would let anyone who reaches it pull arbitrary content through this node's bandwidth, which shouldn't be on by default.

## Persistence

- `${APP_DATA_DIR}/data/ipfs` → `/data/ipfs` - the entire Kubo repository: config, keys, and all pinned/imported block data.

  **This is not browsable as ordinary files.** IPFS stores content in a `flatfs`-sharded, content-addressed block store - hash-named fragments in nested directories, where even a single logical file is split across many blocks. Opened directly, none of it is something you could identify, preview, rename, or usefully copy. Because of that, it lives in `APP_DATA_DIR` rather than the Home folder, even though users clearly care about not losing pinned content - the deciding factor for Home-folder placement is whether content is literally actionable as a file, not just whether it's valued. It's covered by Umbrel's per-app Backup tool while the app is installed, but **is deleted if you uninstall the app** - take a Backup first if that data matters to you.

## Initial node profile

The container sets `IPFS_PROFILE=server` on first initialization only - this tunes Kubo for a stable, always-on server (disables local-network mDNS discovery noise, assumes a fixed identity) rather than a laptop that roams networks, matching upstream's own Docker documentation.

## Background

An existing Kubo package in a different developer's Umbrel Community App Store was requested to store pinned files in a location accessible via Umbrel's Files app (see [the original discussion](https://github.com/dennysubke/dennys-umbrel-app-store/issues/46)). Several iterations tried mounting an `/export` directory into the Home folder for this purpose. Investigation while building this package found that:

- The current official `ipfs/kubo` Docker image doesn't create an `/export` directory at all (confirmed directly from its `Dockerfile` and by running the image) - upstream's own docs page still shows it in an example command, but that's stale.
- Even if it existed, `/export` was never automatically populated - Kubo doesn't watch it, and the WebUI's Import function uploads via the browser's file picker, not from a mounted directory.
- IPFS content (pinned or otherwise) is fundamentally not stored as ordinary files - see [Persistence](#persistence) above - so no mount location would have made it browsable.

This package doesn't attempt to solve that (see the file above for why), and is upfront about the limitation in its own description rather than repeating a setup that looked plausible but never worked.

## Release tooling

`kubo-build.sh` checks the upstream GitHub releases, pins the digest, updates package metadata, validates (including that the API port is never published), and can deploy to `umbrel-dev` or publish a scoped commit.

```bash
# Read-only release and image check
./kubo-build.sh --check

# Prepare the latest stable release locally
./kubo-build.sh --update --notes "Update Kubo"

# Prepare and copy the package to umbrel-dev
./kubo-build.sh --localtest

# Prepare, validate, commit only this app, and push
./kubo-build.sh --publish --notes "Update Kubo"
```

## Credits

- **Kubo**: [ipfs/kubo](https://github.com/ipfs/kubo)
- **Umbrel packaging**: Olly Stedall (saltedlolly)

## Support

For issues specific to this Umbrel packaging, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).

For Kubo/IPFS itself, see the [upstream repo](https://github.com/ipfs/kubo) and the [IPFS docs](https://docs.ipfs.tech/).
