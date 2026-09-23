# Nito for Umbrel

A self-hosted [Nito](https://nito.network/) node - a fair-launch, SHA-256 proof-of-work blockchain with a 200-year emission schedule, built as a direct Bitcoin Core fork. Includes an original dashboard showing block height, sync progress, peers, and mempool activity.

This package was built from scratch, compiling the node from source rather than trusting upstream's unattested pre-built binaries - see [Background](#background) below for why, and for what was found reviewing the project's history along the way.

## Architecture

Two containers, deliberately split:

- **`nito`** ([Nito-Tools/docker-nito](https://github.com/Nito-Tools/docker-nito)) - the compiled node itself (`nitod`/`nito-cli`, built from [NitoNetwork/Nito-core](https://github.com/NitoNetwork/Nito-core)'s source, no wallet/GUI/dashboard). This image is generically useful to anyone wanting to run Nito via Docker, not just Umbrel users.
- **`dashboard`** (`docker-containers/nito-dashboard/` in this repo) - an original Node/TypeScript + React dashboard, connecting to the `nito` container's RPC over the internal Docker network. Umbrel-specific, so it lives with the Umbrel packaging rather than the generic node image.

## Ports

| Purpose | Port | Exposure |
| --- | ---: | --- |
| Dashboard | `3000` | Umbrel SSO only (`app_proxy`) |
| Swarm (P2P) | `8820` (tcp+udp) | Published directly |

The RPC port (`8825`) is never published to the host - only the `dashboard` container can reach it, over the internal Docker network, scoped to this Umbrel's own app subnet (`NITO_RPC_ALLOW_IP=${NETWORK_IP}/16`, Umbrel's documented mechanism for exactly this) and gated by generated credentials either way.

## Persistence

- `${APP_DATA_DIR}/data/nito` → `/data` - the node's chain data. This is an opaque, content-addressed database, not recognizable/browsable files, so it lives in `APP_DATA_DIR` (covered by Backup while installed) rather than the Home folder - **deleted if you uninstall the app**, even though you'd care about not losing it. Take a Backup first if that matters to you.

## No Lightning support

Bitcoin's Lightning Network implementations (LND, Core Lightning) are cryptographically pinned to Bitcoin's own chain and cannot connect to a different blockchain's node, even one that's RPC-compatible. No equivalent Lightning fork exists for Nito. This is a permanent limitation of the chain, not a gap in this package.

## Background

Nito is a direct fork of Bitcoin Core (confirmed via leftover mechanical find/replace artifacts in its docs, an unmodified RPC/CLI/config surface, and identical consensus-parameter code). Reviewing its commit history while building this package surfaced a real, if non-malicious, quality issue worth documenting here rather than in the app's own description (which is about what the software does today, not its history):

A missing-braces bug in the original `GetBlockSubsidy` code meant every `if` block's `return` statement after the first was unreachable dead code - the coin minted a flat, non-decaying 512 NITO per block for its entire first year (genesis to September 2025), rather than the halving-style schedule the code intended. This was fixed in a hard fork (v2.1.0) described in the release notes only as "a consensus change to the block subsidy schedule," with no disclosure of the actual severity. The chain wasn't reset, so the resulting over-issuance is permanent. No evidence of a deliberate backdoor or fund-redirection mechanism was found anywhere in the code reviewed - this reads as a genuine coding mistake by a small, thinly-resourced team, not a scam.

Given upstream's own release binaries have no independent build attestation (no CI builds the Linux/ARM64 binaries it publishes; they're uploaded manually, with no reproducible-build signing chain), this package compiles `nitod` from source instead of trusting them - see [docker-nito](https://github.com/Nito-Tools/docker-nito) for how.

## Release tooling

`nito-build.sh` tracks two independent things: the latest `Nito-Tools/docker-nito` tag (built by that repo's own CI - this script just pins it), and this app's own `docker-containers/nito-dashboard`, built and pushed locally with hash-based change detection (skips rebuilding when nothing changed), matching the pattern `saltedlolly-audiobookshelf/abs-build.sh` uses for its own components.

```bash
# Read-only check for both
./nito-build.sh --check

# Prepare updates locally (builds/pushes the dashboard if its source changed)
./nito-build.sh --update --notes "..."

# Prepare and copy the package to umbrel-dev
./nito-build.sh --localtest

# Prepare, validate, commit only this app, and push
./nito-build.sh --publish --notes "..."
```

Pushing the dashboard image requires being logged in to GHCR: `docker login ghcr.io -u saltedlolly` (a GitHub PAT with `write:packages`/`read:packages` as the password).

## Credits

- **Nito**: [NitoNetwork/Nito-core](https://github.com/NitoNetwork/Nito-core)
- **Node image**: Nito-Tools
- **Packaging and dashboard**: Olly Stedall (saltedlolly)

## Support

For issues specific to this Umbrel packaging, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).
