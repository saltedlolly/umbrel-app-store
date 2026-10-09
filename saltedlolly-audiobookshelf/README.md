<h1><a href="https://saltedlolly.com">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/saltedlolly/saltedlolly-wordmark-dark-bg.png">
  <img alt="saltedlolly" src="../assets/saltedlolly/saltedlolly-wordmark-light-bg.png" height="36" align="right">
</picture>
</a>
Audiobookshelf for Umbrel with Network Shares Support</h1>

This is a custom version of Audiobookshelf for Umbrel that includes robust support for network shares (NAS/SMB/NFS) mounted via Umbrel's Files app.

## Features

### Core Audiobookshelf Features
- All standard Audiobookshelf functionality
- Self-hosted audiobook and podcast server
- Multi-user support with custom permissions
- Mobile apps for Android and iOS
- Progressive Web App (PWA)
- Chromecast support

### Network Shares Enhancements
- **Network Share Discovery**: Automatically discovers NAS shares mounted via Umbrel's Files app
- **Selective Access**: Choose which specific shares Audiobookshelf can access
- **Continuous Monitoring**: Background service continuously checks share accessibility
- **Smart Startup**: Only starts Audiobookshelf when all required shares are available
- **Real-time Status**: Live status display showing which shares are accessible
- **Configuration UI**: Simple web interface to manage share access and view status
- **Reboot Resilience**: Solves the "share isn't mounted yet" problem after Umbrel reboots
- **Automatic Restart**: Restarts Audiobookshelf when required shares become available
- **Automatic Imports from Network Shares**: New books copied to a network share from another computer appear in Audiobookshelf automatically (see [below](#automatic-imports-from-network-shares))

## Start-up time with large libraries on a NAS

With a large library on a network share, Audiobookshelf can take a long time to start: 10 to 20 minutes is possible with tens of thousands of files. While it starts, the app's status light is orange and Audiobookshelf doesn't answer yet. This is normal, and it happens after every restart, including app updates and Umbrel restarts.

**Why:** at start-up, Audiobookshelf's folder watcher sets up a watch on every folder in every library. On a network share that means asking the NAS about every folder and file over the network before Audiobookshelf can answer, and on a busy or slower NAS this adds up. The watcher is needed for [automatic imports](#automatic-imports-from-network-shares).

You can make Audiobookshelf start much faster by switching off its folder watcher (**Automatically watch libraries for changes** in Audiobookshelf's settings), but then new books on network shares only appear after you scan the library, and automatic imports stop working.

## Automatic imports from network shares

### Why it's needed

Audiobookshelf can watch its library folders and add new books by itself, but on Umbrel that only works for folders on the Umbrel itself. When you copy a book to a network share from another computer (for example from your laptop to your NAS), the change happens on the NAS, so the Umbrel is never told about it. Without this feature, new books only appear after you scan the library, which can take a long time with a large library on a NAS.

### What it does

When it's switched on, this app asks your NAS to report changes in your Audiobookshelf library folders, and passes each change straight to Audiobookshelf. Audiobookshelf then scans just the books involved, not the whole library. A newly copied book normally appears a few seconds after the copy finishes. If you copy many books one after another, Audiobookshelf waits until files stop changing and works through them in order.

Libraries on the Umbrel's own storage (such as `Home/Audiobookshelf/Audiobooks`) don't need this: Audiobookshelf's own folder watcher already handles them.

### Setting it up

1. In Audiobookshelf, go to **Settings > API Keys > Add API Key**. Choose an administrator as the user, make sure the key is switched on (active), and copy the key.
2. Open this app from the Umbrel dashboard. In **Automatic imports from network shares**, paste the key and click **Save key**. The page checks the key with Audiobookshelf straight away.
3. Switch **Automatic imports** on.

Keep Audiobookshelf's own folder watcher switched on: **Automatically watch libraries for changes** in Audiobookshelf's settings, and **Automatically watch library for changes** in each library's settings. This app hands changes to Audiobookshelf through it, and the page warns you if it's switched off.

The API key is stored with this app's settings, readable only by the app, and included in Umbrel backups. It isn't shown again after saving; use **Replace** or **Remove** to change it. If the key stops working (for example it was deleted or expired in Audiobookshelf), the page tells you.

### Which changes your NAS reports

Not every NAS reports every kind of change. Some report everything; others, for example, report new files but not a book folder that was renamed or deleted from another computer. This app learns what your NAS reports from the changes you make, and shows it in **Your NAS** on the page, and as a badge on each network share:

| Badge | Meaning |
|---|---|
| ✓ All changes | Your NAS has been seen reporting every kind of change |
| *n* of 4 | Your NAS reports some kinds of change; the nightly light check (below) finds the rest |
| Learning | Not enough changes seen yet to tell |

The four kinds of change are new books and files, changed files (for example edited tags), renamed or moved books, and deleted books. The learning happens per NAS, so if you have shares on more than one NAS, each one gets its own entry.

### The nightly light check

To catch changes a NAS doesn't report, a light check runs once a night at the **Nightly check time** (04:00 by default). It lists only the folders above your books and compares them with Audiobookshelf's library, so it finds books that were renamed, moved, added or deleted. It never opens the files inside your books, so it's much lighter than a library scan and usually finishes within a few minutes. Many NAS models keep folder listings in memory or on an SSD cache, so it often doesn't need to spin up the hard drives.

**Light check** can be set to:

- **Automatic (recommended)**: every night until your NAS has been seen reporting renamed and deleted books itself, then once a week as a safety net
- **Every night** or **Once a week**
- **Off**: renamed or deleted books are then only picked up when you scan the library

**Check now** runs it straight away for one NAS. A scheduled library scan in Audiobookshelf isn't needed while automatic imports are on.

### When the app wasn't running

Changes made while this app isn't running (for example while the Umbrel is off, restarting or updating) can't be noticed afterwards. When the app starts again it schedules a catch-up for the nightly check time: a light check after a short break (under an hour, such as an app update), or a full scan of the libraries on network shares after a longer one, because more could have changed. The page shows what's scheduled, with **Scan now** and **Skip**.

### Things to know

- **Changed files**: if your NAS doesn't report changed files (for example a replaced audio file or cover image), the light check can't see that either, because it doesn't look inside books. A library scan in Audiobookshelf picks those up. Edited book details such as title or author in the tags of a book Audiobookshelf already has are a different matter: Audiobookshelf keeps its own saved details for that book, so neither automatic imports nor a scan apply them. Deleting the book from the Audiobookshelf library (not the audio files themselves) and rescanning the library is, at the time of writing, the only way to update the library listing with new embedded metadata from an audiobook. Deleting it also removes its listening progress and any changes made to it in Audiobookshelf. New files, such as a cover image added to a book folder, are picked up like any new file.
- **Renamed books on some NAS models**: Audiobookshelf recognises a renamed or moved book by its file IDs. Some NAS models don't give files permanent IDs, and on those Audiobookshelf treats a renamed or moved book folder as a new book and marks the old entry as missing (this happens with a library scan too, not just with automatic imports). Listening progress stays with the old entry. You can remove missing books from the library's **Issues** list.
- Automatic imports only watch Audiobookshelf libraries whose folders are on network shares added in Umbrel's Files app.

## Architecture

This solution consists of four main components working together:

### 1. **Network Shares Config Tool** (`abs-network-shares-config-tool`)
- Lightweight Node.js/Express web interface (port 3001)
- Discovers available network shares by scanning `/umbrel-network`
- Provides real-time status display of share accessibility
- Allows enabling/disabling specific shares
- Configuration persisted to `/data/network-shares.json`
- Accessible as the app's primary interface via Umbrel dashboard

### 2. **Manager Service** (`abs-manager`)
- Orchestrates the checker and Audiobookshelf server containers
- Communicates with Docker via secure socket proxy
- Monitors share status from checker service
- Only starts Audiobookshelf when all required shares are accessible
- Automatically restarts Audiobookshelf when shares become ready
- Handles container lifecycle management

### 3. **Network Shares Checker** (`abs-network-shares-checker`)
- Background service that continuously monitors share accessibility
- Checks each enabled share every 5 seconds (with 15-minute caching)
- Uses `mountpoint` and filesystem checks for verification
- Updates status in real-time to configuration file
- Notifies manager when share status changes
- Handles temporary network interruptions gracefully

### 4. **Docker Socket Proxy**
- Provides secure, limited access to Docker API
- Used by manager to create and control containers
- Prevents direct socket access for better security

## How It Works

### Mount Path Mapping

Umbrel mounts network shares with this structure:
- **Virtual path (in Umbrel UI)**: `/Network/<host>/<share-name>`
- **System path (on host)**: `${UMBREL_ROOT}/network/<host>/<share-name>`
- **Path in Audiobookshelf**: `/media/network/<host>/<share-name>`

### Workflow

1. **User adds NAS share in Umbrel's Files app**
   - Umbrel mounts the share at `${UMBREL_ROOT}/network/<host>/<share>`

2. **User enables share in Audiobookshelf settings**
   - Opens Network Shares config tool (app's main interface)
   - Selects desired shares from discovered list
   - Views real-time accessibility status for each share
   - Saves configuration

3. **Manager orchestrates startup**
   - Manager starts the checker service
   - Checker continuously monitors enabled shares every 5 seconds
   - Manager waits for all required shares to be accessible
   - Only when ready, manager starts the Audiobookshelf server

4. **Continuous monitoring**
   - Checker keeps validating share accessibility in the background
   - If shares become unavailable, status updates in real-time
   - If shares come back online, manager automatically restarts Audiobookshelf

5. **User adds audiobook library in Audiobookshelf**
   - Points to `/media/network/<host>/<share>/Audiobooks`
   - App can now access the network share content

## Installation

1. Umbrel (umbrelOS 1.2+)
2. Network shares mounted via Umbrel's Files app (optional — can be added later)

The app uses pre-built multi-architecture Docker images hosted on GitHub Container Registry (GHCR), so no local building is required. See the root [README.md](../README.md) for how to add this community app store and install the app.

## Usage

### Initial Setup

1. **Install Audiobookshelf from the Umbrel App Store**
   - The app will start automatically with default settings
   - No configuration needed if you don't use network shares

2. **(Optional) Add network shares in Umbrel Files app**
   - Go to Umbrel → Files
   - Click "Add Network Device"
   - Enter your NAS details (host, share, credentials)
   - Verify the share appears and is accessible

3. **(Optional) Configure Audiobookshelf network share access**
   - Open Audiobookshelf in Umbrel (opens the config tool by default)
   - The UI will display all discovered network shares
   - View real-time status for each share (Accessible/Not Mounted/etc.)
   - Enable the shares you want Audiobookshelf to access
   - Save configuration

4. **Automatic restart and monitoring**
   - Manager automatically restarts Audiobookshelf when share status changes
   - Checker continuously monitors enabled shares in the background
   - Status updates in real-time in the config tool UI

5. **Access Audiobookshelf directly**
   - From the config tool, click **Open Audiobookshelf**
   - Or install/use the Audiobookshelf mobile apps
   - Add libraries pointing to `/media/network/<host>/<share>/...`

6. **(Optional) Switch on automatic imports**
   - See [Automatic imports from network shares](#automatic-imports-from-network-shares)

### Accessing the Interfaces

**Network Shares Config Tool** (Primary interface):
- Accessible via the Umbrel dashboard app icon
- Shows real-time share status
- Allows enabling/disabling shares
- Provides a button to open Audiobookshelf
- Sets up automatic imports from network shares

**Audiobookshelf Server**:
- Opens from the **Open Audiobookshelf** button in the config tool
- Or directly via mobile apps
- Standard Audiobookshelf interface for managing libraries

### Troubleshooting

#### Share Status Shows "Checking..."

The checker service continuously monitors shares. "Checking..." should only display briefly:
- Wait 5-10 seconds for the first check to complete
- If it persists, check the checker container logs:
  ```bash
  ssh umbrel@umbrel.local
  docker logs saltedlolly-audiobookshelf_abs-network-shares-checker_1
  ```

#### Share Shows as "Not Mounted" or "Not Accessible"

Check the logs for specific error messages:
```bash
ssh umbrel@umbrel.local
docker logs saltedlolly-audiobookshelf_abs-network-shares-checker_1
```

**Common causes:**
- NAS is offline or unreachable
- Incorrect credentials in Files app
- Network connectivity issues
- Share was removed from Umbrel Files app
- Permissions issue on the NAS

**Solutions:**
1. Verify NAS is online and accessible from Umbrel Files app
2. Check share credentials in Files app
3. Test share access in Files app first
4. Disable problematic shares in config tool temporarily
5. Check NAS-side permissions for the Umbrel user

#### Audiobookshelf Won't Start

The manager waits for all enabled shares to be accessible before starting Audiobookshelf:

1. Check manager logs to see what it's waiting for:
   ```bash
   docker logs saltedlolly-audiobookshelf_abs-manager_1
   ```

2. Check current configuration and share status in the config tool UI

3. Temporarily disable problematic shares:
   - Open the config tool
   - Uncheck shares that aren't accessible
   - Save configuration
   - Manager will automatically restart Audiobookshelf

#### Automatic Imports Don't Work

The status line in **Automatic imports from network shares** says what's wrong:

- **Audiobookshelf rejected the API key**: the key was deleted, deactivated or has expired, or was never switched on. Create a new active key and click **Replace**
- **The API key belongs to a user who isn't an administrator**: create the key on an administrator account
- **Audiobookshelf isn't answering yet**: Audiobookshelf can take several minutes to start with large libraries on a NAS. Changes are kept and sent when it's ready
- **A warning that the folder watcher is switched off**: switch it back on in Audiobookshelf (see [Setting it up](#setting-it-up))
- **A red dot next to a watched folder**: the share can't be reached right now. Check it in Umbrel's Files app; watching resumes by itself when the share is back

#### Configuration Changes Don't Save

Check config tool logs:
```bash
docker logs saltedlolly-audiobookshelf_abs-network-shares-config-tool_1
```

Verify the data directory is writable:
```bash
ls -la ~/umbrel/app-data/saltedlolly-audiobookshelf/data/
```

#### Audiobookshelf Can't See My Files

Make sure you're using the correct path in Audiobookshelf libraries:
- **Correct**: `/media/network/<host>/<share>/path/to/audiobooks`
- **Incorrect**: `/umbrel-network/...` (that's where the config tool sees the shares, not Audiobookshelf) or other paths

Verify the share is enabled in the config tool and shows as "Accessible".

## How It's Put Together

### Project Structure

```
saltedlolly-audiobookshelf/
├── docker-compose.yml        # Main compose file with all services
├── umbrel-app.yml           # App manifest
├── docker-containers/
│   ├── abs-network-shares-config-tool/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── server.js         # Express API server
│   │   └── public/
│   │       └── index.html    # Configuration UI
│   ├── abs-manager/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── manager.js        # Container orchestration logic
│   ├── abs-network-shares-checker/
│   │   ├── Dockerfile
│   │   └── wait-for-shares.js # Share monitoring service
│   ├── abs-share-watcher/
│   │   ├── Dockerfile
│   │   └── watcher.py        # Automatic imports from network shares
│   └── abs-server/
│       └── Dockerfile        # Custom ABS server build
└── data/                     # Persistent data directories
    ├── config/              # Audiobookshelf config
    └── metadata/            # Audiobookshelf metadata
```

### Key Components

- **`docker-compose.yml`**: Defines all services, volumes, and the Docker socket proxy
- **`config-tool/server.js`**: API for share discovery, configuration, and status display
- **`config-tool/public/index.html`**: Web UI with real-time status polling
- **`manager/manager.js`**: Orchestrates checker and ABS server using Docker API
- **`checker/wait-for-shares.js`**: Continuous share monitoring with caching

### Services Overview

1. **app_proxy**: Routes traffic to config tool (primary interface)
2. **docker-socket-proxy**: Secure Docker API access for manager
3. **abs-network-shares-config-tool**: Web UI and API (port 3001)
4. **abs-manager**: Orchestration service
5. **abs-network-shares-checker**: Background monitoring (created by manager)
6. **abs-share-watcher**: Automatic imports: passes changes on network shares to Audiobookshelf
7. **abs-server**: Audiobookshelf server (created by manager when shares are ready)

### Configuration File Format

The `/data/network-shares.json` configuration file:

```json
{
  "enabledShares": [
    "nas.local/media",
    "nas.local/backup"
  ],
  "shareSettings": {},
  "shares": {
    "nas.local/media": {
      "status": "accessible",
      "lastCheckedAt": "2026-01-02T12:34:56.789Z",
      "errorMessage": null
    },
    "nas.local/backup": {
      "status": "not-mounted",
      "lastCheckedAt": "2026-01-02T12:34:51.123Z",
      "errorMessage": "Mountpoint check failed"
    }
  }
}
```

- **`enabledShares`**: Array of share paths (format: `<host>/<share>`) that should be checked
- **`shareSettings`**: Reserved for future per-share configuration
- **`shares`**: Real-time status for each discovered share, maintained by checker service
  - `status`: One of: `checking`, `accessible`, `not-mounted`, `not-accessible`, `permission-denied`
  - `lastCheckedAt`: ISO timestamp of last check
  - `errorMessage`: Details if status indicates a problem

## Security Considerations

- Network shares are mounted **read-only** in all containers
- Only `/data` directory is writable (app configuration and Audiobookshelf data)
- Docker socket access is restricted via docker-socket-proxy with minimal permissions
- Config tool and manager run as non-root user (node:1000)
- No hardcoded credentials - uses Umbrel's existing share authentication
- Container-to-container communication uses Docker's internal networking
- Checker validates paths to prevent directory traversal attacks

## Known Limitations

- Shares must be added via Umbrel's Files app first
- Only SMB/CIFS and NFS shares are supported (as per Umbrel's Files app)
- Share monitoring checks every 5 seconds (with 15-minute caching to reduce I/O)
- Manager must restart Audiobookshelf when share status changes
- No notification system for share availability changes (status visible in config tool only)
- Automatic imports depend on what each NAS reports; see [Which changes your NAS reports](#which-changes-your-nas-reports)

## License

This project follows the same license as the official Audiobookshelf application.

## Credits

- **Audiobookshelf**: [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf)
- **Umbrel**: [getumbrel/umbrel](https://github.com/getumbrel/umbrel)
- **Network Shares Enhancement**: Olly Stedall (saltedlolly)

## Support

For issues specific to the network shares functionality:
- Check the troubleshooting section above
- Review container logs for specific error messages
- Open an issue with logs and your network share configuration

For general Audiobookshelf issues:
- Visit the [official Audiobookshelf documentation](https://www.audiobookshelf.org/)
- Join the [Audiobookshelf Discord](https://discord.gg/pJsjuNCKRq)

### Useful Commands

View all container logs:
```bash
docker logs saltedlolly-audiobookshelf_abs-network-shares-config-tool_1
docker logs saltedlolly-audiobookshelf_abs-manager_1
docker logs saltedlolly-audiobookshelf_abs-network-shares-checker_1
docker logs saltedlolly-audiobookshelf_abs-server_1
```

Check configuration:
```bash
cat ~/umbrel/app-data/saltedlolly-audiobookshelf/data/network-shares.json
```

List running containers:
```bash
docker ps | grep saltedlolly-audiobookshelf
```
