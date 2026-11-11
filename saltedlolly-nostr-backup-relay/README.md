<h1><a href="https://saltedlolly.com">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/saltedlolly/saltedlolly-wordmark-dark-bg.png">
  <img alt="saltedlolly" src="../assets/saltedlolly/saltedlolly-wordmark-light-bg.png" height="36" align="right">
</picture>
</a>
Nostr Backup Relay for Umbrel</h1>

> **Under construction:** this app is still being tested. Please don't rely on it yet.

A private [Nostr](https://nostr.com/) relay on your Umbrel that backs up everything you post, from as many Nostr accounts as you like.

It is a fork of Umbrel's official [Nostr Relay](https://apps.umbrel.com/app/nostr-relay) app, built from Umbrel's v1.2.1 code, with one addition: "Sync from public relays" accepts several NIP-05 or npub addresses instead of one. If you run a personal account and an account for a project, both are backed up. It is not made or supported by Umbrel, so please report problems [here](https://github.com/saltedlolly/umbrel-app-store/issues), not to Umbrel.

## What's different from the official app

| | Official Nostr Relay | Nostr Backup Relay |
| --- | --- | --- |
| Accounts synced from public relays | One | As many as you like |
| Relay engine | nostr-rs-relay 0.10.0 | The same image |
| Reconnection, NIP-65 relay lists, signature checks | Yes (v1.2.1) | Yes, unchanged |
| Port | `4848` | `4849` |
| Copies the official app's backup | | Once, on first start |

Each public relay gets one connection, subscribed to every account. Each account still brings its own relays: those in its NIP-05 file (or a list of popular relays for an npub), then the ones in its own relay list (NIP-65, or the older Kind 3 contact list).

## Setting it up

1. **Connect your Nostr clients** (for example Damus, Amethyst or Primal) to your private relay, using the Relay URL shown at the top of the app's page. New activity is then saved as you post it.
2. **Add your accounts:** open the app, click the globe icon next to the Relay URL, enter an account's NIP-05 address (`name@example.com`) or npub, and click the add button. For each further account, click **+ Add another account**. Past and future activity of every account is copied from its public relays in the background.

To stop backing up an account, click the bin next to it. Its activity already saved stays in the relay.

## Addresses

| Name | Port | Local address | Umbrel login |
| --- | --- | --- | --- |
| Dashboard | `4849` | [https://umbrel.local:4849](https://umbrel.local:4849/) | No |
| Relay URL for Nostr clients | `4849` | `ws://umbrel.local:4849` | No |

The relay has no Umbrel login because Nostr clients can't sign in to Umbrel. That's the same as the official app.

`wss://umbrel.local:4849` also works, but uses Umbrel's self-signed certificate, which many Nostr clients refuse. Away from home, use [Tailscale](https://apps.umbrel.com/app/tailscale) with MagicDNS and `ws://umbrel:4849`, as Umbrel suggests for the official app.

## Moving from the official Nostr Relay app

If the official Nostr Relay app is installed, this app copies its relay database and saved account the first time it starts, before its own relay runs. The copy:

- uses SQLite's online backup, so it's safe while the official relay is running and writing;
- checks the copy's integrity before using it;
- only reads the official app's files, which are left exactly as they were;
- runs once only. After that the app keeps its own database, and installing or updating either app copies nothing again.

You can keep both apps installed while you check that everything is there, then uninstall the official one. While both are installed, point your Nostr clients at this app (port `4849`), or at both.

If the copy fails, for example because the official database is damaged, the app logs why and starts with an empty relay, which fills up again from the public relays. Anything no longer on public relays is then only in the official app's copy. To copy it by hand, stop this app, then on the Umbrel:

```bash
sudo rm -f ~/umbrel/app-data/saltedlolly-nostr-backup-relay/data/relay/db/nostr.db*
sudo -u '#1000' python3 -c "import sqlite3; s=sqlite3.connect('file:$HOME/umbrel/app-data/nostr-relay/data/relay/db/nostr.db?mode=ro', uri=True); d=sqlite3.connect('$HOME/umbrel/app-data/saltedlolly-nostr-backup-relay/data/relay/db/nostr.db'); s.backup(d); d.close()"
```

Then start the app again. The first command deletes this app's own relay database.

## Data

- `${APP_DATA_DIR}/data/relay/db`: the relay database (SQLite). Covered by Umbrel's Backup while the app is installed, and **deleted if you uninstall the app**.
- `${APP_DATA_DIR}/data/relay-proxy/store.json`: the accounts being synced. The official app's single-account file is read as a list of one, and saved in the new format once you add or remove an account.

## Updates

Umbrel doesn't publish the source of the official app's current version on GitHub, so new official versions are merged into this app by hand. A daily check opens an issue in this store when the official app changes.

## Credits and licence

- **Umbrel's Nostr Relay** ([getumbrel/umbrel-nostr-relay](https://github.com/getumbrel/umbrel-nostr-relay), and the published v1.2.1 images): the dashboard, the sync service and their tests. Umbrel's code is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md), and so is this fork of it. It may be used, changed and shared for noncommercial purposes only.
- **[nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay)** (MIT): the relay engine, used unchanged through Umbrel's image.
- The multiple-account sync and the official app data copy are by [saltedlolly](https://saltedlolly.com).

## Release tooling

`nostr-backup-relay-build.sh` builds the dashboard and sync service images for linux/amd64 and linux/arm64, pushes them to GHCR, pins their digests, and updates the version, release notes and the store README.

```bash
# Read-only: versions, and whether the official app has changed
./nostr-backup-relay-build.sh --check

# Release the version in umbrel-app.yml (first release)
./nostr-backup-relay-build.sh --publish --notes "First release"

# A fix on top of the current version (v1.2.1.1 becomes v1.2.1.2)
./nostr-backup-relay-build.sh --bump --publish --notes "Fix ..."

# After merging a new official version by hand (version becomes v1.2.2)
./nostr-backup-relay-build.sh --based-on 1.2.2 --publish --notes "Update to Umbrel's Nostr Relay 1.2.2"
```

Images: `ghcr.io/saltedlolly/nostr-backup-relay-ui` and `ghcr.io/saltedlolly/nostr-backup-relay-proxy`.
