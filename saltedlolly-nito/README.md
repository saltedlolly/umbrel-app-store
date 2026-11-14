<h1><a href="https://saltedlolly.com">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/saltedlolly/saltedlolly-wordmark-dark-bg.png">
  <img alt="saltedlolly" src="../assets/saltedlolly/saltedlolly-wordmark-light-bg.png" height="36" align="right">
</picture>
</a>
Nito for Umbrel</h1>

A self-hosted [Nito](https://nito.network/) node - a fair-launch, SHA-256 proof-of-work blockchain with a 200-year emission schedule, built as a direct Bitcoin Core fork. Includes an original dashboard: new blocks sliding in as they're found, sync progress, charts of recent blocks and the mempool, and a map of the countries your peers are in.

This package was built from scratch, compiling the node from source rather than trusting upstream's unattested pre-built binaries - see [Background](#background) below for why, and for what was found reviewing the project's history along the way.

## Architecture

Two containers, deliberately split:

- **`nito`** ([Nito-Tools/docker-nito](https://github.com/Nito-Tools/docker-nito)) - the compiled node itself (`nitod`/`nito-cli`, built from [NitoNetwork/Nito-core](https://github.com/NitoNetwork/Nito-core)'s source, no wallet/GUI/dashboard). This image is generically useful to anyone wanting to run Nito via Docker, not just Umbrel users.
- **`dashboard`** (`docker-containers/nito-dashboard/` in this repo) - an original Node/TypeScript + React dashboard, connecting to the `nito` container's RPC over the internal Docker network. Umbrel-specific, so it lives with the Umbrel packaging rather than the generic node image.

## The dashboard

- **Latest blocks:** the newest blocks as a chain, with each new one sliding in when it's found (about once a minute), and a timer since the last one. While the node is catching up, a progress ring shows how far it has got and roughly how long is left.
- **At a glance:** block height, peers (in and out), mempool, chain size, uptime, node version and network (mainnet, testnet, regtest or signet).
- **Charts:** time between the last 60 blocks against the 1 minute target, transactions per block, and the mempool over the last 2 hours (kept in memory, so it starts again when the app restarts).
- **Peer map:** the countries your peers are in. The lookup uses [DB-IP](https://db-ip.com)'s free country database, built into the image and used offline: peer addresses are never sent anywhere. Peers on Tor, I2P or private addresses are counted as "not located".
- Light and dark themes, with a picker at the top right.

## Help the network: open port 8820

Your node connects out to other nodes on its own, but other nodes can only connect **in** to it if port `8820` (TCP) is forwarded to your Umbrel on your router. Nodes that accept incoming connections make the Nito network stronger. The dashboard tells you when nobody has connected in after 30 minutes, and shows a tick once someone has.

1. Give your Umbrel a fixed local address on your router (often called a *DHCP reservation*), so the rule keeps pointing at it.
2. In your router's settings, find *Port forwarding* and forward TCP port `8820` to that address, port `8820`.

Every router is different; search for your router's model and "port forwarding" for exact steps. Only do this if you're comfortable with your Umbrel accepting connections from the internet on this port: only the Nito node listens on it.

## Ports

| Purpose | Port | Exposure |
| --- | ---: | --- |
| Dashboard | `3000` | `app_proxy`, without Umbrel's login (`PROXY_AUTH_ADD: "false"`): the page only shows information, with no controls and no peer addresses |
| Swarm (P2P) | `8820` (tcp+udp) | Published directly (forward TCP `8820` on your router to accept incoming peers) |

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

`nito-build.sh` pins two images, building neither: `Nito-Tools/docker-nito` (built by that repo's own CI) and this app's dashboard, `ghcr.io/saltedlolly/nito-dashboard`. The dashboard is built by this repo's `nito-dashboard-build.yml` workflow whenever `docker-containers/nito-dashboard/` changes on `master`; the workflow then runs `nito-build.sh --publish` with the new image's tag and digest. The release notes come from a `Release-Notes:` trailer on the commit that triggered the build.

```bash
# Read-only check for a newer docker-nito
./nito-build.sh --check

# Prepare a docker-nito update locally, without committing
./nito-build.sh --update --notes "..."

# Prepare, validate, commit only this app, and push
./nito-build.sh --publish --notes "..."
```

## Credits

- **Nito**: [NitoNetwork/Nito-core](https://github.com/NitoNetwork/Nito-core)
- **Node image**: Nito-Tools
- **Packaging and dashboard**: Olly Stedall (saltedlolly)
- **Country lookups**: [IP Geolocation by DB-IP](https://db-ip.com) (CC BY 4.0)
- **World map**: [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth, public domain)

## Support

For issues specific to this Umbrel packaging, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).
