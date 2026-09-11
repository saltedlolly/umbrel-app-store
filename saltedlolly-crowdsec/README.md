# CrowdSec for Umbrel

Crowd-sourced intrusion detection and automatic IP banning, powered by [CrowdSec](https://www.crowdsec.net/). This app runs the CrowdSec engine plus a local web dashboard ([crowdsec-web-ui](https://github.com/TheDuffman85/crowdsec-web-ui)) so you can browse alerts and manage bans without needing SSH or the `cscli` command line.

## Architecture

- `crowdsec` runs the actual detection/decision engine (the LAPI - local API) - not exposed to the Umbrel dashboard directly, only reachable by other containers on Umbrel's internal network.
- `crowdsec-web-ui` is a small dashboard that talks to the engine's LAPI, fronted by Umbrel's app proxy on port `5190`. This is what you actually open from the Umbrel home screen.
- `hooks/post-start` registers the dashboard with the engine automatically on first boot. The dashboard's own image doesn't support the same env-var auto-registration CrowdSec bouncers get, so this hook runs the one-time `cscli machines add` command for you, directly on the Umbrel host (not inside a container - no Docker socket access needed).

## First login

Open the app and create your dashboard admin account on first visit - there's no default username/password, you set it yourself the first time you load the page.

## Protecting NPMplus (or other apps)

CrowdSec doesn't protect anything by itself - something needs to actually enforce its decisions. That's a "bouncer," and [saltedlolly-npm-plus](../saltedlolly-npm-plus) already has one built in.

Install both apps and they're wired together automatically: this app generates a shared secret (`BOUNCER_KEY_npmplus`) and registers a bouncer named `npmplus` with it on every startup. Point NPMplus's own bouncer config at this app to complete the connection - see [saltedlolly-npm-plus's README](../saltedlolly-npm-plus/README.md#crowdsec-integration-optional-bring-your-own-crowdsec) for the exact `API_URL`/`API_KEY` fields.

To protect a different app or service, register another bouncer the same way this app registers NPMplus's: add a `BOUNCER_KEY_<name>=<a-generated-secret>` environment variable to this app's `crowdsec` service (the entrypoint registers it automatically on every start), then configure that other service's own bouncer with the matching key and `http://saltedlolly-crowdsec_crowdsec_1:8080` as its LAPI URL.

## Default protection rules

This app installs the [`ZoeyVid/npmplus`](https://hub.crowdsec.net/author/ZoeyVid/collections/npmplus) collection by default - built specifically for NPMplus's exact log format and covers common HTTP attack patterns (via the CrowdSec [hub](https://hub.crowdsec.net/)). To add more collections (for other apps, or broader coverage), edit the `COLLECTIONS` environment variable in `docker-compose.yml` - space-separated, installed automatically on every restart.

## Local log-based detection (not enabled by default)

Community-blocklist and AppSec (WAF) protection work over the network with no extra setup. NPMplus-specific *local* behavioral scenarios (e.g. spotting a brute-force pattern from its actual access logs) need this app to see those logs directly, which isn't wired up by default. Two ways to do this if you want it:

- CrowdSec's own syslog datasource - have NPMplus forward its logs over the network to this app (no shared volume needed; CrowdSec's docs note this path is best for smaller setups).
- A shared bind mount under the Umbrel Home folder that both apps mount (the same pattern `saltedlolly-audiobookshelf` uses for its Audiobooks/Podcasts folders) - NPMplus writes logs there, this app reads them.

Neither is configured out of the box; this is a known limitation for a first release, not an oversight.

## Persistence

All engine state (config, ban/alert database, hub collections) lives under `${APP_DATA_DIR}/data/crowdsec/`, and the dashboard's own account/settings under `${APP_DATA_DIR}/data/web-ui/`. Both are backed up by Umbrel's Backup tool and preserved across restarts and updates.

⚠️ Uninstalling this app deletes all of the above, including your ban history and dashboard account.

## Release tooling

`crowdsec-build.sh` checks both upstream projects (the `crowdsec` engine and `crowdsec-web-ui`) independently, pins digests, updates package metadata, and can deploy to `umbrel-dev` or publish a scoped commit.

```bash
# Update files locally, no commit/push
./crowdsec-build.sh

# Force an app version bump even without an upstream change
./crowdsec-build.sh --bump

# Prepare and copy the package to umbrel-dev
./crowdsec-build.sh --localtest

# Prepare, commit, and push
./crowdsec-build.sh --publish --notes "..."
```

Use `--crowdsec-version <X.Y.Z>` / `--webui-version <tag>` to pin a specific upstream release of either component (mainly for CI).

## Credits

- **CrowdSec**: [crowdsecurity/crowdsec](https://github.com/crowdsecurity/crowdsec)
- **crowdsec-web-ui**: [TheDuffman85/crowdsec-web-ui](https://github.com/TheDuffman85/crowdsec-web-ui) - a third-party dashboard, not an official CrowdSec product
- **Umbrel packaging**: Olly Stedall (saltedlolly)

## Support

For issues specific to this Umbrel packaging, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).

For CrowdSec itself, see the [upstream repo](https://github.com/crowdsecurity/crowdsec). For the dashboard, see [crowdsec-web-ui](https://github.com/TheDuffman85/crowdsec-web-ui).
