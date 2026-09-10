# Audiobookshelf for Umbrel with Network Shares Support

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
- **Path in Audiobookshelf**: `/umbrel-network/<host>/<share-name>`

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
   - Points to `/umbrel-network/<host>/<share>/Audiobooks`
   - App can now access the network share content

## Installation

1. Umbrel (umbrelOS 1.2+)
2. Network shares mounted via Umbrel's Files app (optional — can be added later)

The app uses pre-built multi-architecture Docker images hosted on GitHub Container Registry (GHCR), so no local building is required. See the root [README.md](../README.md) for how to add this community app store and install the app.

## Usage

### Initial Setup

1. **Install Audiobookshelf from your Umbrel app store**
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
   - From the config tool, click "Go to Audiobookshelf Server" link in footer
   - Or install/use the Audiobookshelf mobile apps
   - Add libraries pointing to `/umbrel-network/<host>/<share>/...`

### Accessing the Interfaces

**Network Shares Config Tool** (Primary interface):
- Accessible via the Umbrel dashboard app icon
- Shows real-time share status
- Allows enabling/disabling shares
- Provides link to Audiobookshelf server

**Audiobookshelf Server**:
- Accessible via link in config tool footer
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
- **Correct**: `/umbrel-network/<host>/<share>/path/to/audiobooks`
- **Incorrect**: `/media/network/...` or other paths

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
6. **abs-server**: Audiobookshelf server (created by manager when shares are ready)

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
