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

Install both apps and they're wired together automatically, in either order (restart NPMplus if you install CrowdSec second). NPMplus finds CrowdSec at startup and sets up three things with no configuration:

- **Blocklist bouncer** – NPMplus checks every visitor's IP against CrowdSec's decisions (your own bans plus the community blocklist). Both apps derive the same bouncer key, and this app registers the `npmplus` bouncer with it on every start.
- **AppSec (WAF)** – NPMplus sends each request to CrowdSec's AppSec listener on port 7422, which blocks known CVE exploits and common attack probes. If AppSec is ever unavailable, requests are let through rather than blocked.
- **Log analysis** – NPMplus sends its access logs to this app over syslog, so CrowdSec can spot patterns across many requests (scanners, brute force, aggressive crawlers) and ban the source.

NPMplus's launcher page shows the connection status and active ban counts.

To protect a different app or service, register another bouncer the same way this app registers NPMplus's: add a `BOUNCER_KEY_<name>=<a-generated-secret>` environment variable to this app's `crowdsec` service (the entrypoint registers it automatically on every start), then configure that other service's own bouncer with the matching key and `http://saltedlolly-crowdsec_crowdsec_1:8080` as its LAPI URL.

## Default protection rules

This app installs the [`ZoeyVid/npmplus`](https://hub.crowdsec.net/author/ZoeyVid/collections/npmplus) collection by default - built specifically for NPMplus's exact log format and covers common HTTP attack patterns (via the CrowdSec [hub](https://hub.crowdsec.net/)). To add more collections (for other apps, or broader coverage), edit the `COLLECTIONS` environment variable in `docker-compose.yml` - space-separated, installed automatically on every restart.

## How NPMplus's logs reach CrowdSec

NPMplus forwards its access logs over syslog (UDP) to port 4242, published only on the Umbrel's internal Docker gateway (`10.21.0.1`), so other apps' containers can reach it but devices on your network can't send fake log lines. A shared file mount isn't used because umbrelOS only lets an app see another app's files if it depends on that app, and CrowdSec deliberately doesn't depend on NPMplus. CrowdSec's docs describe its syslog listener as suited to small setups (a few hundred log lines per second), which is well above typical home traffic.

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
