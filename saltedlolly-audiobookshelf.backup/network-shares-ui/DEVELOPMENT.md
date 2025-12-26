# Network Shares UI - Development Notes

## Overview

This is a lightweight sidecar service for managing network share access in Audiobookshelf. It provides a simple web interface for discovering, enabling, and testing network shares.

## Architecture

### Backend (server.js)

**Express API with the following endpoints:**

- `GET /health` - Health check for Docker healthcheck
- `GET /api/config` - Read current configuration
- `GET /api/shares/discover` - Discover available network shares
- `POST /api/shares/test` - Test access to a specific share
- `POST /api/config/save` - Save share configuration

**Key Functions:**

- `discoverShares()` - Scans `/umbrel-network` for mounted shares
- `checkIfMounted()` - Verifies a path is actually mounted using `mountpoint` command
- `checkIfAccessible()` - Tests read access to a path
- `readConfig()` / `writeConfig()` - Manage `network-shares.json` file

### Frontend (public/index.html)

**Single-page application with vanilla JavaScript:**

- Discovers and displays available shares
- Allows enabling/disabling shares with checkboxes
- Visual indicators for mount status (green = accessible, red = not mounted)
- Test button for each share to verify access
- Save button to persist configuration

**No framework dependencies** - uses vanilla JS for simplicity and small size.

## Configuration Format

```json
{
  "enabledShares": [
    "nas.local/media",
    "nas.local/backup"
  ],
  "shareSettings": {}
}
```

- **enabledShares**: Array of share paths (format: `<host>/<share>`)
- **shareSettings**: Reserved for future per-share settings

## Docker Image

**Base**: `node:18-alpine`

**Key features:**
- Multi-stage build for small image size
- Runs as non-root user (`node`)
- Includes `util-linux` for `mountpoint` command
- Health check on `/health` endpoint
- Exposes port 3001

## Integration with Pre-Start Hook

The pre-start hook reads the configuration file and waits for enabled shares:

```bash
# Hook reads this file
CONFIG_FILE="${APP_DATA_DIR}/network-shares.json"

# For each enabled share
for share in "${ENABLED_SHARES[@]}"; do
    mount_path="${NETWORK_MOUNT_ROOT}/${share}"
    wait_for_mount "$mount_path"
done
```

## Development Workflow

### Local Development

```bash
cd network-shares-ui

# Install dependencies
npm install

# Run locally (requires proper environment)
npm start

# Build Docker image
docker build -t audiobookshelf-network-shares-ui:dev .

# Run container for testing
docker run -p 3001:3001 \
  -e APP_DATA_DIR=/data \
  -v ./test-data:/data \
  -v ./test-network:/umbrel-network:ro \
  audiobookshelf-network-shares-ui:dev
```

### Building Multi-Arch Images

```bash
# From app root
./build.sh --publish
```

This uses Docker Buildx to build for both `linux/amd64` and `linux/arm64`.

## Testing

### Unit Testing Share Discovery

```javascript
// Mock network directory structure
/umbrel-network/
  nas.local/
    media/
      Audiobooks/
      Movies/
    backup/
```

### Integration Testing

1. Create test shares in umbrel-dev
2. Mount via Umbrel Files app
3. Access UI and verify shares appear
4. Enable shares and test access
5. Save configuration
6. Restart app and check pre-start hook logs

### Edge Cases to Test

- Empty `/umbrel-network` directory (no shares)
- Share that exists but is not mounted
- Share that is mounted but not accessible (permissions)
- Multiple shares from same host
- Share names with special characters
- Configuration file doesn't exist (first run)
- Malformed configuration JSON
- Network timeout during share test

## Performance Considerations

- Share discovery scans filesystem - may be slow with many hosts/shares
- `mountpoint` command can be slow on network filesystems
- Configuration is read from disk on every request (acceptable for low-traffic admin UI)
- No caching layer (simplicity over performance for admin tool)

## Security Notes

- Runs as non-root user in container
- Network mount is read-only
- No authentication (relies on Umbrel's app proxy)
- No shell execution with user input (all paths are validated)
- Configuration file only writable by app

## Future Improvements

- [ ] Add caching for share discovery (with TTL)
- [ ] WebSocket for real-time mount status updates
- [ ] Subfolder selection widget
- [ ] Batch test all enabled shares
- [ ] Export/import configuration
- [ ] Advanced settings per share (custom mount options)
- [ ] Integration with Audiobookshelf API to auto-create libraries

## Debugging

### Check service logs

```bash
docker logs saltedlolly-audiobookshelf_network-shares-ui_1
```

### Check configuration

```bash
cat ~/umbrel/app-data/saltedlolly-audiobookshelf/network-shares.json
```

### Verify mounts in container

```bash
docker exec saltedlolly-audiobookshelf_network-shares-ui_1 ls -la /umbrel-network
docker exec saltedlolly-audiobookshelf_network-shares-ui_1 mountpoint /umbrel-network/nas.local/media
```

### Test API manually

```bash
# Discover shares
curl http://localhost:3001/api/shares/discover

# Get config
curl http://localhost:3001/api/config

# Test a share
curl -X POST http://localhost:3001/api/shares/test \
  -H "Content-Type: application/json" \
  -d '{"sharePath":"nas.local/media"}'
```

## Dependencies

- **express** (^4.18.2): Web framework
- **Node.js 18**: Runtime

That's it! Keeping dependencies minimal for reliability and small image size.
