# ReadMeABook for Umbrel

This package runs [ReadMeABook](https://github.com/kikootwo/ReadMeABook), an audiobook request and download automation service, on umbrelOS.

> **Under construction:** this package is being tested. Do not rely on it without keeping backups of your application data and audiobook library.

## What you need

ReadMeABook coordinates other services rather than downloading directly. Before completing its setup wizard, install and configure:

- **Audiobookshelf or Plex** for the finished audiobook library
- **Prowlarr** with at least one suitable audiobook indexer
- **A download client:** qBittorrent, Transmission, SABnzbd, NZBGet or Deluge

The official Umbrel qBittorrent, Transmission, SABnzbd and Prowlarr apps use the same shared Downloads folder mounted here at `/downloads`. This package prepares the writable `/downloads/audiobooks` subfolder for audiobook jobs.

## Audiobookshelf NAS Edition

This package exposes Audiobookshelf NAS Edition's storage in the paths ReadMeABook expects:

| Content | Path inside ReadMeABook |
|---|---|
| Umbrel's shared Downloads folder | `/downloads` |
| Writable audiobook download folder | `/downloads/audiobooks` |
| Local Audiobookshelf audiobooks | `/media/audiobooks` |
| Shares mounted in Umbrel Files | `/media/network/<host>/<share>/...` |

ReadMeABook can reach the local Audiobookshelf NAS Edition server through the Umbrel Docker gateway. During the setup wizard:

1. Select **Audiobookshelf** as the library backend.
2. In Audiobookshelf, open **Settings → API Keys** and create a key for ReadMeABook. Treat this key like a password.
3. Enter `http://10.21.0.1:13378` as the Audiobookshelf Server URL.
4. Paste the API key, test the connection, and select the audiobook library.
5. Set the download directory to `/downloads/audiobooks`.
6. For a local Audiobookshelf library, leave the media directory as `/media/audiobooks`.
7. For a NAS library, use its corresponding `/media/network/<host>/<share>/...` path. It must be a writable share because ReadMeABook places completed books there.

The server address and media mounts are prepared automatically. The API key and library selection deliberately remain a one-time manual step: Audiobookshelf does not export these credentials to other apps, and this package does not read Audiobookshelf's private database.

Audiobookshelf normally watches its library folders automatically. Leave **Trigger scan after import** off unless you disabled Audiobookshelf's filesystem watcher.

## Prowlarr and the download client

Use the address shown by the relevant app's Umbrel page. Set ReadMeABook's download directory and the download client's audiobook/category save path to `/downloads/audiobooks`.

The container path matters: ReadMeABook must see a completed download at the same path reported by the download client. If the client reports `/downloads/audiobooks/example.m4b`, that exact path must exist inside this container too.

## Accounts and remote access

ReadMeABook supplies its own user accounts, permissions, API authentication and optional OpenID Connect login, so Umbrel's additional app-proxy login is not placed in front of it.

Keep it on your trusted network unless you have configured ReadMeABook authentication. If you publish it through a reverse proxy or use Plex/OIDC sign-in, ReadMeABook also needs `PUBLIC_URL` set to its exact external HTTPS address for OAuth callbacks. This initial package does not guess a public domain.

## Storage and backups

Application-owned data is stored under this app's `APP_DATA_DIR`:

- `data/config` — generated secrets and configuration
- `data/postgres` — users, requests and settings
- `data/redis` — background-job state
- `data/cache` — rebuildable caches; excluded from Umbrel backups

Umbrel's Backup tool covers the app-owned data while the app is installed. Uninstalling the app deletes it, so take a backup first.

Downloaded and finished audiobook files live outside the app directory:

- Downloads: Umbrel shared storage (`Home/Downloads/audiobooks`)
- Local ABS media: `Home/Audiobookshelf/Audiobooks`
- NAS media: the share mounted through Umbrel Files

Those user files are not owned by this app and are not removed when ReadMeABook is uninstalled.

## Troubleshooting

### Audiobookshelf connection fails

- Confirm Audiobookshelf NAS Edition is running and its web interface opens on port `13378`.
- Confirm the API key is current and belongs to a user with access to the selected library.
- Use `http://10.21.0.1:13378`, not `localhost`. Inside the ReadMeABook container, `localhost` means ReadMeABook itself.

### Download completes but is not imported

- Keep the download path identical in ReadMeABook and the download client.
- Use `/downloads/audiobooks` in both ReadMeABook and the download client; the shared `/downloads` root itself may be read-only to app users.
- Check ReadMeABook's system logs for the path reported by the client.

### ReadMeABook cannot write to a NAS library

- Confirm the share is mounted and reported as accessible by Audiobookshelf NAS Edition.
- Confirm it was mounted read-write in Umbrel Files.
- Select the matching path below `/media/network` in ReadMeABook.

### OAuth redirects to localhost

Plex OAuth and OpenID Connect require `PUBLIC_URL` to match the address users open, such as `https://books.example.com`. Local accounts do not require OAuth. See [upstream's environment documentation](https://github.com/kikootwo/ReadMeABook/blob/main/documentation/backend/services/environment.md).

## Upstream documentation

- [ReadMeABook documentation](https://github.com/kikootwo/ReadMeABook/tree/main/documentation)
- [Setup wizard](https://github.com/kikootwo/ReadMeABook/blob/main/documentation/setup-wizard.md)
- [Volume mapping guide](https://github.com/kikootwo/ReadMeABook/blob/main/documentation/deployment/volume-mapping.md)
- [Upstream issues](https://github.com/kikootwo/ReadMeABook/issues)
