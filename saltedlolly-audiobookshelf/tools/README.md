# Audiobookshelf Library Migration Tool

This tool helps you migrate your Audiobookshelf library data between the official Audiobookshelf app and the Audiobookshelf: NAS Edition.

## What It Does

- **Backs up** your library (config and metadata) from the currently installed app
- **Restores** your library to a newly installed version
- **Manages** app stopping/starting during the migration
- **Preserves** your entire library including user accounts, reading progress, and book metadata

## Quick Start

Run this single command in the Umbrel terminal:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/saltedlolly/umbrel-apps/master/saltedlolly-audiobookshelf/tools/migrate-library.sh)
```

## Migration Process

### Step 1: Backup Your Library

1. Run the migration tool
2. Choose to backup your current library
3. The tool will:
   - Stop the running app (if needed)
   - Backup config and metadata to `/home/abs-library-backup`
   - Confirm successful backup

### Step 2: Switch Apps

1. **Uninstall** the current Audiobookshelf app:
   - Open Umbrel dashboard
   - Right-click the Audiobookshelf app icon
   - Select "Uninstall"

2. **Install** the other version:
   - **Official App**: Find "Audiobookshelf" in Umbrel App Store
   - **NAS Edition**: Add saltedlolly's Community App Store, then install "Audiobookshelf: NAS Edition"

### Step 3: Restore Your Library

1. Run the migration tool again
2. Choose to restore your backup
3. The tool will:
   - Stop the new app (if needed)
   - Restore your config and metadata
   - Fix permissions
   - Clean up the backup
   - Start the app

## What Gets Migrated

✅ **Included in migration:**
- User accounts and passwords
- Reading progress and bookmarks
- Library organization and metadata
- Book covers and descriptions
- App settings and preferences
- Collections and playlists

❌ **Not included:**
- Log files (automatically excluded)
- Cache files (automatically excluded)
- Downloaded podcast episodes (can be re-downloaded)

## Backup Location

Temporary backups are stored at:
```
~/umbrel/home/abs-library-backup/
```

This location is:
- Visible in Files app at `/Home/abs-library-backup`
- Safe from app uninstalls
- Automatically cleaned up after successful restore

## Safety Features

- **Confirmation prompts** before destructive operations
- **Automatic permission fixing** for restored files
- **Backup verification** before proceeding
- **Preserves logs** during restore
- **Size reporting** to verify backup completeness

## Troubleshooting

### Script fails to stop app

If the script cannot stop the app automatically:
1. Manually stop the app from the Umbrel dashboard
2. Run the script again

### Permission errors after restore

If you encounter permission errors:
```bash
sudo chown -R 1000:1000 ~/umbrel/app-data/audiobookshelf/
# or for NAS edition:
sudo chown -R 1000:1000 ~/umbrel/app-data/saltedlolly-audiobookshelf/
```

### Backup shows 0 bytes

This means no library data was found. Possible causes:
- Fresh install with no library configured yet
- Library data was already deleted
- Different app version than expected

### Library doesn't appear after restore

1. Check that the app is running
2. Verify ownership is set to 1000:1000
3. Check logs in the app for errors
4. Try restarting the app

## Manual Migration (Alternative)

If you prefer to migrate manually without this tool:

```bash
# 1. Stop the current app from dashboard

# 2. Backup library
sudo mkdir -p ~/umbrel/home/abs-library-backup
sudo cp -r ~/umbrel/app-data/audiobookshelf/config ~/umbrel/home/abs-library-backup/
sudo cp -r ~/umbrel/app-data/audiobookshelf/metadata ~/umbrel/home/abs-library-backup/

# 3. Uninstall current app, install new app

# 4. Stop new app from dashboard

# 5. Restore library (adjust app ID if needed)
sudo cp -r ~/umbrel/home/abs-library-backup/config ~/umbrel/app-data/audiobookshelf/
sudo cp -r ~/umbrel/home/abs-library-backup/metadata ~/umbrel/app-data/audiobookshelf/

# 6. Fix permissions
sudo chown -R 1000:1000 ~/umbrel/app-data/audiobookshelf/

# 7. Start app from dashboard

# 8. Clean up backup
sudo rm -rf ~/umbrel/home/abs-library-backup
```

## Important Notes

- Media files (audiobooks/podcasts) are **not** affected by migration
  - Official app stores them in app-data (deleted on uninstall)
  - NAS Edition stores them in `/home/Audiobookshelf` (persists)
  - You may need to reconfigure library paths after migration

- Network share configuration (NAS Edition only) is **not** migrated
  - You'll need to reconfigure network shares in the NAS Edition

- The backup is temporary and should be deleted after successful migration
  - The script automatically cleans up after successful restore
  - You can manually delete it anytime from `/Home/abs-library-backup`

## Support

For issues or questions:
- Open an issue on [GitHub](https://github.com/saltedlolly/umbrel-apps)

## Version

Current version: 1.0.0
