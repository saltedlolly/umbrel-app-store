# Quick Start Guide

## For Users: Using Audiobookshelf with Network Shares

### Step 1: Set up your NAS share in Umbrel

1. Open **Umbrel → Files**
2. Click **"Add Network Device"**
3. Enter your NAS connection details:
   - **Host**: `nas.local` or IP address
   - **Share name**: `media` (or your share name)
   - **Username & Password**: Your NAS credentials
4. Click **Add** and verify the share appears in Files

### Step 2: Configure Audiobookshelf

1. Open **Audiobookshelf** from Umbrel
2. Access **Network Shares Settings** (via app menu or settings)
3. The UI will automatically discover your mounted shares
4. **Enable** the shares you want Audiobookshelf to access
5. Click **"Test Access"** to verify each share works
6. Click **"Save Configuration"**

### Step 3: Restart the app

1. Right-click Audiobookshelf app icon
2. Click **"Restart"**
3. The app will wait for your shares to be mounted
4. Check logs if needed to see mount progress

### Step 4: Add libraries in Audiobookshelf

1. In Audiobookshelf, go to **Settings → Libraries**
2. Click **"Add Library"**
3. Browse to **`/media/network/<your-nas>/<share-name>/Audiobooks`**
4. Configure and scan your library

✅ **Done!** Your audiobooks from NAS are now accessible in Audiobookshelf.

---

## For Developers: Building and Testing

### Local Development

```bash
# Navigate to the app directory
cd saltedlolly-audiobookshelf

# Build the UI service for local testing
./build.sh --localtest

# Deploy to umbrel-dev
rsync -av --exclude='.git' --exclude='node_modules' --exclude='.gitkeep' \
  . umbrel@umbrel-dev.local:~/umbrel/app-stores/saltedlolly/saltedlolly-audiobookshelf/

# Install in umbrel-dev
ssh umbrel@umbrel-dev.local
umbreld client apps.install.mutate --appId saltedlolly-audiobookshelf
```

### Testing the Pre-Start Hook

```bash
# View app logs to see pre-start hook output
ssh umbrel@umbrel-dev.local
umbreld client apps.logs --appId saltedlolly-audiobookshelf | grep PRE-START
```

### Building for Production

```bash
# Build and push multi-arch images to Docker Hub
./build.sh --publish

# Commit the updated docker-compose.yml
git add docker-compose.yml
git commit -m "Update network-shares-ui image digest"
```

---

## Troubleshooting

### App won't start

**Problem**: "Timeout waiting for network share"

**Solutions**:
1. Check if your NAS is online and reachable
2. Verify the share is accessible in Umbrel Files app
3. Temporarily disable the share in Network Shares settings
4. Fix the NAS connection and re-enable

### Share not appearing in UI

**Problem**: Added share in Files but not showing in Audiobookshelf

**Solutions**:
1. Click **"Refresh Shares"** in the Network Shares UI
2. Verify the share is actually mounted in Files app
3. Check the path: `/umbrel-network/<host>/<share>` exists
4. Restart the network-shares-ui service

### Can't access files in Audiobookshelf

**Problem**: Library added but files not accessible

**Solutions**:
1. Verify share is enabled in Network Shares settings
2. Check the path format: `/media/network/<host>/<share>/...`
3. Ensure share permissions allow read access
4. Test share access using the "Test Access" button

---

## Key Paths

- **Config file**: `${APP_DATA_DIR}/network-shares.json`
- **Network mounts in container**: `/media/network/<host>/<share>`
- **System mount location**: `${UMBREL_ROOT}/data/storage/network/<host>/<share>`
- **Virtual path in Umbrel**: `/Network/<host>/<share>`

---

## Support

- **GitHub Issues**: Report bugs and request features
- **Umbrel Community**: Get help from other users
- **Audiobookshelf Discord**: General Audiobookshelf support
