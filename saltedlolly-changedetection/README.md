<h1><a href="https://saltedlolly.com">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/saltedlolly/saltedlolly-wordmark-dark-bg.png">
  <img alt="saltedlolly" src="../assets/saltedlolly/saltedlolly-wordmark-light-bg.png" height="36" align="right">
</picture>
</a>
changedetection.io for Umbrel</h1>

A self-hosted [changedetection.io](https://changedetection.io/) - watch any web page for changes and get notified (email, Discord, Slack, Telegram, and dozens more) the moment something changes: a price drop, a restock, a keyword appearing, or any part of a page you care about.

## Bundled headless-Chrome sidecar

This package includes [sockpuppetbrowser](https://github.com/dgtlmoon/sockpuppetbrowser), a headless-Chrome helper, already wired up via the `PLAYWRIGHT_DRIVER_URL` environment variable. changedetection.io's default fetch method is a plain HTTP request (no JavaScript execution), which is enough for most static/server-rendered pages. For pages that build their content client-side (single-page apps, sites needing JS to render), select **Playwright/Chromium** as the fetch method on that watch (or as the site-wide default in Settings) to route it through the sidecar instead.

The sidecar's concurrency is capped at `MAX_CONCURRENT_CHROME_PROCESSES=2` (upstream's own default is 10) to bound worst-case RAM usage on typical Umbrel hardware - a headless Chrome instance costs roughly 150-300MB idle, more per active fetch. A 3rd concurrent Playwright fetch queues for a free slot (up to 120 seconds) rather than failing outright.

## Known limitation: notification links

`BASE_URL` (which changedetection.io uses to build links inside notification messages, e.g. "view the change") is intentionally left unset, since there's no single fixed external URL to embed - this app might be reached via a LAN IP, a `.local` hostname, or Umbrel's remote access, and Umbrel apps don't expose a way to edit environment variables through the UI. Links inside notifications may not resolve correctly outside your home network as a result; the notification content itself is unaffected.

## Ports

| Purpose | Port | Umbrel SSO |
| --- | ---: | --- |
| Web UI | `5000` | ✅ |

## Persistence

- `${APP_DATA_DIR}/data` → `/datastore` - all watches, settings, and page-snapshot history, including any notification webhook URLs/credentials you configure. Deleted if you uninstall the app; covered by Umbrel's per-app Backup tool while installed.

## Credits

- **changedetection.io**: [dgtlmoon/changedetection.io](https://github.com/dgtlmoon/changedetection.io)
- **sockpuppetbrowser**: [dgtlmoon/sockpuppetbrowser](https://github.com/dgtlmoon/sockpuppetbrowser)
- **Umbrel packaging**: Olly Stedall (saltedlolly)

## Support

For issues specific to this Umbrel packaging, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).

For changedetection.io itself, see the [upstream repo](https://github.com/dgtlmoon/changedetection.io) and its [wiki](https://github.com/dgtlmoon/changedetection.io/wiki).
