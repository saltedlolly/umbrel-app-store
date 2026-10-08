# Cloudflare DDNS for Umbrel

Keeps your Cloudflare DNS records pointing at your home's current public IP address, so a domain such as `home.example.com` keeps working when your internet provider changes your IP. Powered by [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns), with a web page for setting it up and checking on it. Open it from the Umbrel home screen (port `4100`, behind Umbrel's login).

## Setting it up

1. **Get a Cloudflare API token.** The domain must use Cloudflare for its DNS. Create a token with the **Edit zone DNS** template, limited to your domain; Cloudflare explains how in [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/). It must be an API *token*: the older Global API Key is not accepted. Cloudflare shows the token only once, so paste it straight into the app.
2. **Open the app and click Edit Config.** Paste the token and enter the name or names to keep updated, separated by commas, for example `home.example.com`.
3. **Save.** The app starts on its own. Within a minute the domain table shows a green tick.

The record doesn't need to exist beforehand: the app creates it, then updates it whenever your IP changes. It checks every 5 minutes.

### Choosing a name

The app takes over the A record (and, with IPv6 on, the AAAA record) of every name you enter. **If your main domain (such as `example.com`) already points at a website or email service hosted elsewhere, use a subdomain such as `home.example.com` instead**, or that service will stop working. The app asks before saving a new name that looks like a main domain.

## The settings

| Setting | What it does |
|---|---|
| **Proxied** | On: visitors connect to Cloudflare, which hides your home IP address and can cache web pages. Off: your home IP address is published in DNS for anyone to see. Keep it on for websites; turn it off only for services that aren't websites (an email server, for example). The app asks before you turn it off. |
| **IPv4 Support** | Keeps the A record updated. Leave it on unless your connection has no IPv4 at all. While it's off, the app removes the A records for your domains. |
| **IPv6 Support** | Keeps the AAAA record updated. Off for new installs: see [IPv6](#ipv6). While it's off, the app removes the AAAA records for your domains. |
| **Enable / Disable** | Starts or stops the updater. Changing a setting doesn't switch a disabled updater back on; saving a new token does. |

## IPv6

Leave IPv6 off unless you need it.

- **With Proxied on, Cloudflare already serves visitors over IPv6**, even without an AAAA record of your own ([IPv6 compatibility](https://developers.cloudflare.com/network/ipv6-compatibility/)).
- **An AAAA record points straight at your Umbrel, not at your router.** IPv4 visitors reach your router, which forwards them to your reverse proxy (for example NPMplus on port 50443). IPv6 has no such translation: visitors arrive on port 443, which belongs to umbrelOS itself, so they would bypass your reverse proxy and anything behind it.

Turn IPv6 on if:

- **Your connection has no public IPv4 address of its own** (CGNAT, common with some providers and mobile broadband). For websites behind a reverse proxy you then also need a Cloudflare [Origin Rule](https://developers.cloudflare.com/rules/origin-rules/) that sends traffic to your proxy's port, and your router must allow incoming IPv6 to that port.
- **You publish a service that isn't a website directly**, on its own port, with Proxied off.

The page shows a warning when IPv6 and Proxied are both on.

## Notifications (optional)

Click **Edit Notifiers** to add any of these, then use the switches to turn them on and off without losing the URL. For what each service receives, see favonia's [README](https://github.com/favonia/cloudflare-ddns).

- **Healthchecks**: a [Healthchecks](https://healthchecks.io) ping URL. It is pinged when the updater starts, after each successful check, and on failures.
- **Uptime Kuma**: the push URL of a *Push* monitor. Use it without its `?status=...` part; the updater adds its own.
- **Shoutrrr**: one [Shoutrrr URL](https://containrrr.dev/shoutrrr/latest/services/overview/) per line (Discord, ntfy, Slack and many more). For a plain-HTTP webhook use `generic+http://...` or `generic://...?disabletls=yes`.

If a notification fails, a ⚠️ appears next to its switch; hover over it to see the error. The notifier stays on.

Each settings change restarts the updater, so Healthchecks and Shoutrrr may receive a "stopped" and a "started" message.

## Reading the page

- **Public IPs**: the addresses the updater last detected.
- **Cloudflare Last Updated**: when the app last actually changed a record. Until it has had to change one, it says **Already up to date**.
- **Domain table**: ✅ the record matches your current IP; ⏳ waiting for the next update; ⚠️ or ⛔️ a problem, explained under the domain name.
- **Live Logs**: the last 500 lines of the updater's log.
- **Report Issue** (footer): opens a new GitHub issue with your app version filled in.

## Troubleshooting

- **Status "disabled" with "Invalid Cloudflare API token"**: Cloudflare refused the token. Create a new one with the *Edit zone DNS* template and save it in Edit Config; the updater starts again on its own. If you fixed the token's permissions in Cloudflare instead, press **Enable**.
- **A domain says "Not found in your Cloudflare account"**: check the spelling, and that the domain is in the Cloudflare account the token belongs to.
- **"No successful check in the last ... minutes"**: the updater is running but can't confirm your records. Check the Live Logs; usually the internet connection or Cloudflare is unreachable.
- **"Lost connection to the Cloudflare DDNS app"**: the page can't reach the app on your Umbrel. It reconnects by itself when the app is back.
- **A notification shows ⚠️**: hover over it for the error, and check the URL in Edit Notifiers.

If you're still stuck, use **Report Issue** at the bottom of the page. Please install the latest version first: the problem may already be fixed.

## How it works

The app runs two containers:

- **ui**: the web page (Node.js). It writes the settings file and shows the state the updater reports.
- **cloudflare-ddns**: a small wrapper ([`cloudflare-ddns/entrypoint.sh`](cloudflare-ddns/entrypoint.sh)) around favonia's `ddns` program. It checks the settings file every 3 seconds and restarts `ddns` when it changes, so no Docker socket access is needed. `ddns` runs as an unprivileged user; it only needs outbound internet access. This container uses the host network, so it detects the Umbrel's own addresses.

They share these files in the app's data volume:

| File | Contents |
|---|---|
| `cloudflare-ddns.env` | Settings, including the API token. Readable by root only. |
| `status.json` | Running, enabled, last successful check, errors (written by the wrapper) |
| `last-change.json` | When an A or AAAA record last really changed (survives restarts and updates) |
| `cloudflare-ddns.log` | The updater's log. Trimmed to the last 10,000 lines when it passes 5 MB. |

Note: the settings currently live in a Docker volume that Umbrel's backups don't include, so after restoring a backup you may need to enter them again. A future version will move them into the app's backed-up data folder.

## Release tooling

`cf-build.sh` (run from this folder) builds both images for amd64 and arm64, pushes them to GHCR (`ghcr.io/saltedlolly/cloudflare-ddns` and `cloudflare-ddns-ui`), pins their digests in `docker-compose.yml`, and updates the version in `umbrel-app.yml`, `ui/package.json`, `ui/public/version.json` and the root README, plus the release notes. With `--publish` it commits only this folder and the root README, and pushes. New upstream releases of favonia/cloudflare-ddns are picked up by the daily auto-release workflow (`.github/workflows/cloudflare-ddns-auto-release.yml`).

```bash
# One-time: log in to GHCR with a GitHub token that can write packages
docker login ghcr.io -u saltedlolly

# Release a packaging change (adds or increments the 4th version number)
./cf-build.sh --bump --notes "What changed" --publish

# Build and deploy to a local umbrel-dev (192.168.215.2) for testing, without publishing
./cf-build.sh --bump --localtest
```

For local testing you can bypass Umbrel's login by setting `path: "/"` in `umbrel-app.yml`; `cf-build.sh` sets it back to `path: ""` before any build that isn't `--localtest`, so a release can't go out without the login. The version in the page footer comes from the image itself (the `VERSION` build argument, served by `/api/version`), so it always matches what is running.

## Credits

- **Updater**: [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) (Apache-2.0)
- **Umbrel packaging and web page**: Olly Stedall (saltedlolly)

## Support

For problems with this Umbrel app, use **Report Issue** on the app's page, or open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues). For the updater itself, see [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns).
