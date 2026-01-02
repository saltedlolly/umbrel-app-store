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
- **Startup Gating**: Waits for selected shares to be mounted before starting the app
- **Mount Verification**: Verifies shares are actually accessible before proceeding
- **Configuration UI**: Simple web interface to manage share access
- **Reboot Resilience**: Solves the "share isn't mounted yet" problem after Umbrel reboots

## Architecture

This solution consists of three main components:

### 1. **Pre-Start Hook** (`hooks/pre-start`)
- Runs before Audiobookshelf starts
- Reads configuration from `${APP_DATA_DIR}/data/network-shares.json`
- Waits up to 5 minutes for each enabled share to be mounted
- Verifies shares are accessible using `mountpoint` and filesystem checks
- Provides detailed logging and clear error messages
- Prevents app start if enabled shares are unavailable

### 2. **Network Shares UI Service** (`network-shares-ui/`)
- Lightweight Node.js/Express service
- Discovers available network shares by scanning `/umbrel-network`
- Provides a web interface for enabling/disabling shares
- Allows testing share accessibility
- Saves configuration to `data/network-shares.json`
- Accessible at the app's settings page

### 3. **Docker Compose Configuration**
- Mounts Umbrel's network storage root at `/media/network` (read-only)
- Runs the UI service alongside Audiobookshelf
- Shares configuration directory between services

## How It Works

### Mount Path Mapping

Umbrel mounts network shares with this structure:
- **Virtual path (in Umbrel UI)**: `/Network/<host>/<share-name>`
- **System path (on host)**: `${UMBREL_ROOT}/data/storage/network/<host>/<share-name>`
- **Path in Audiobookshelf**: `/media/network/<host>/<share-name>`

### Workflow

1. **User adds NAS share in Umbrel's Files app**
   - Umbrel mounts the share at `${UMBREL_ROOT}/data/storage/network/<host>/<share>`

2. **User enables share in Audiobookshelf settings**
   - Opens Network Shares UI
   - Selects desired shares
   - Saves configuration

3. **App starts/restarts**
   - Pre-start hook runs
   - Reads enabled shares from configuration
   - Waits for each share to be mounted
   - Verifies accessibility
   - Only then allows Audiobookshelf to start

4. **User adds audiobook library in Audiobookshelf**
   - Points to `/media/network/<host>/<share>/Audiobooks`
   - App can now access the network share

## Installation

### Prerequisites

1. Umbrel (umbrelOS 1.0+)
2. Network shares mounted via Umbrel's Files app
3. Docker Buildx for building images (if building from source)

### Deployment

#### Option 1: Use Pre-built Image (Recommended)

The app is configured to use a pre-built Docker image from Docker Hub. Simply:

1. Copy the `saltedlolly-audiobookshelf` folder to your Umbrel app store
2. Install via the Umbrel App Store UI

#### Option 2: Build Locally

```bash
# Build the network-shares-ui Docker image
cd saltedlolly-audiobookshelf
./build.sh --localtest

# Deploy to umbrel-dev
rsync -av --exclude='.git' --exclude='node_modules' --exclude='.gitkeep' \
  . umbrel@umbrel-dev.local:~/umbrel/app-stores/saltedlolly/saltedlolly-audiobookshelf/

# Install in Umbrel
ssh umbrel@umbrel-dev.local
umbreld client apps.install.mutate --appId saltedlolly-audiobookshelf
```

#### Option 3: Publish to Docker Hub

```bash
# Build and push multi-arch images
./build.sh --publish

# This will:
# - Build for linux/amd64 and linux/arm64
# - Push to Docker Hub
# - Update docker-compose.yml with the new digest
```

## Usage

### Initial Setup

1. **Add network shares in Umbrel Files app**
   - Go to Umbrel → Files
   - Click "Add Network Device"
   - Enter your NAS details (host, share, credentials)
   - Verify the share appears and is accessible

2. **Configure Audiobookshelf network access**
   - Install/open Audiobookshelf in Umbrel
   - Go to Settings → Network Shares (or access the UI service directly)
   - Enable the shares you want Audiobookshelf to access
   - Test each share to verify accessibility
   - Save configuration

3. **Restart Audiobookshelf**
   - Right-click the app → Restart
   - The pre-start hook will wait for enabled shares
   - Check logs for mount verification status

4. **Add libraries in Audiobookshelf**
   - In Audiobookshelf, go to Settings → Libraries
   - Add a new library
   - Browse to `/media/network/<host>/<share>/...`
   - Configure and scan

### Accessing the Network Shares UI

The Network Shares configuration UI is accessible at:
- `http://umbrel.local:<port>` (same as Audiobookshelf main app)

The UI is served by the `network-shares-ui` sidecar service.

### Troubleshooting

#### Share Not Mounting

Check the logs when starting the app:
```bash
ssh umbrel@umbrel.local
umbreld client apps.logs --appId saltedlolly-audiobookshelf
```

Look for messages from `[PRE-START]`:
- `Waiting for network share to be mounted: <share>`
- `Timeout waiting for network share: <share>`

**Common causes:**
- NAS is offline or unreachable
- Incorrect credentials in Files app
- Network connectivity issues
- Share was removed from Files app

**Solutions:**
1. Verify NAS is online and accessible
2. Check share credentials in Files app
3. Test share access in Files app
4. Disable problematic shares in Network Shares settings
5. Fix issues and restart the app

#### App Won't Start

If the pre-start hook blocks app startup:

1. Check which shares are enabled:
   ```bash
   ssh umbrel@umbrel.local
   cat ~/umbrel/app-data/saltedlolly-audiobookshelf/data/network-shares.json
   ```

2. Temporarily disable all shares to allow app to start:
   ```bash
   echo '{"enabledShares":[],"shareSettings":{}}' > ~/umbrel/app-data/saltedlolly-audiobookshelf/data/network-shares.json
   ```

3. Restart the app

4. Re-enable shares one by one in the UI to identify the problematic one

#### Share Shows as "Not Mounted"

This means Umbrel hasn't successfully mounted the share. Check:
- Is the share visible in Umbrel's Files app?
- Can you browse the share in Files app?
- Are there any errors in Umbrel's system logs?

Fix in Files app first, then return to Audiobookshelf.

#### Empty Configuration

If `data/network-shares.json` doesn't exist or is empty, the app starts immediately without waiting. This is by design for first-time setup.

## Development

### Project Structure

```
saltedlolly-audiobookshelf/
├── docker-compose.yml        # Main compose file with services
├── umbrel-app.yml           # App manifest (v1.1 with hooks)
├── exports.sh               # Environment variables
├── build.sh                 # Build script
├── hooks/
│   └── pre-start           # Pre-start hook script
├── network-shares-ui/       # UI service for share management
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js           # Express API server
│   ├── .dockerignore
│   └── public/
│       └── index.html      # Web UI
└── data/                    # Persistent data directories
    ├── config/
    └── metadata/
```

### Key Files

- **`docker-compose.yml`**: Defines services, volumes, and network mounts
- **`umbrel-app.yml`**: Manifest version 1.1 with `hooks.pre-start`
- **`hooks/pre-start`**: Bash script for mount verification
- **`network-shares-ui/server.js`**: API for share discovery and configuration
- **`network-shares-ui/public/index.html`**: Web UI for share management

### Building

The build process:
1. Builds the `network-shares-ui` Docker image
2. Pushes to Docker Hub (if `--publish` is used)
3. Updates `docker-compose.yml` with the new image digest

```bash
# Local testing
./build.sh --localtest

# Publish to Docker Hub
./build.sh --publish
```

### Testing

#### Test in umbrel-dev

```bash
# Start umbrel-dev
cd /path/to/umbrel
npm run dev

# Deploy app
rsync -av --exclude='.git' --exclude='node_modules' --exclude='.gitkeep' \
  saltedlolly-audiobookshelf \
  umbrel@umbrel-dev.local:~/umbrel/app-stores/saltedlolly/

# Install
ssh umbrel@umbrel-dev.local
umbreld client apps.install.mutate --appId saltedlolly-audiobookshelf

# View logs
umbreld client apps.logs --appId saltedlolly-audiobookshelf
```

#### Test Scenarios

1. **Fresh install with no shares**: App should start immediately
2. **Fresh install with mounted shares**: Should discover and list them in UI
3. **Enable shares and restart**: Should wait for mounts
4. **Unmount share and restart**: Should timeout with clear error
5. **Re-enable share while running**: Should work on next restart

### Configuration File Format

The `data/network-shares.json` configuration file:

```json
{
  "enabledShares": [
    "nas.local/media",
    "nas.local/backup"
  ],
  "shareSettings": {
    "nas.local/media": {
      "subfolder": "/Audiobooks"
    }
  }
}
```

- **`enabledShares`**: Array of share paths to wait for (format: `<host>/<share>`)
- **`shareSettings`**: Optional per-share settings (reserved for future use)

## Security Considerations

- Network shares are mounted **read-only** in the container
- Only the APP_DATA_DIR is writable
- The UI service runs as non-root user (node)
- Pre-start hook validates paths to prevent traversal
- No hardcoded credentials
- Uses Umbrel's existing share authentication

## Known Limitations

- Shares must be added via Umbrel's Files app first
- Only SMB/CIFS and NFS shares are supported (as per Umbrel)
- Maximum wait time per share: 5 minutes
- No automatic retry if share becomes unavailable during runtime
- Requires Umbrel to handle actual mounting (this app just waits for it)

## Future Enhancements

Potential improvements:
- [ ] Dynamic mount detection during runtime (not just at startup)
- [ ] Per-share mount timeout configuration
- [ ] Automatic retry logic for intermittent mount failures
- [ ] Integration with Audiobookshelf settings UI
- [ ] Subfolder selection in UI
- [ ] Health checks for share availability
- [ ] Notifications when shares become unavailable

## Contributing

To contribute:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly in umbrel-dev
5. Submit a pull request

## License

This project follows the same license as the official Audiobookshelf application.

## Credits

- **Audiobookshelf**: [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf)
- **Umbrel**: [getumbrel/umbrel](https://github.com/getumbrel/umbrel)
- **Network Shares Enhancement**: Olly Stedall (saltedlolly)

## Support

For issues specific to the network shares functionality:
- Open an issue in this repository
- Include logs from the pre-start hook
- Describe your NAS setup and network configuration

For general Audiobookshelf issues:
- Visit the [official Audiobookshelf Discord](https://discord.gg/pJsjuNCKRq)
