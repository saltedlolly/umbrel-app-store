# ABS Library Migration Tool

This tool helps you migrate your Audiobookshelf library data between the official Audiobookshelf app and the Audiobookshelf: NAS Edition.

## What It Does

- **Backs up** your library (config and metadata) from the currently installed app
- **Restores** your library to a newly installed version
- **Migrates** local media files (audiobooks and podcasts) between app locations
- **Manages** app stopping/starting during the migration
- **Preserves** your entire library including user accounts, reading progress, and book metadata

## Quick Start

Run this single command in the Umbrel terminal:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/saltedlolly/umbrel-app-store/master/saltedlolly-audiobookshelf/tools/migrate-library.sh)
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
   - **Migrate media files** if found in the old app location
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
- **Local media files** (audiobooks and podcasts)
  - Official app: `/data/storage/downloads/{audiobooks,podcasts}`
  - NAS Edition: `/home/Audiobookshelf/{Audiobooks,Podcasts}`
  - Files are automatically moved to the new location during restore
  - You'll be prompted to confirm migration if media files are found

❌ **Not included:**
- Log files (automatically excluded)
- Cache files (automatically excluded)

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

### Media files didn't migrate

If you see the prompt but files weren't migrated:
- **To Official app**: Check `/home/Audiobookshelf/{Audiobooks,Podcasts}`
- **To NAS Edition**: Check `/data/storage/downloads/{audiobooks,podcasts}`

You can manually move them using the paths shown in Step 3.

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
sudo cp -r ~/umbrel/home/abs-library-backup/config ~/umbrel/app-data/saltedlolly-audiobookshelf/
sudo cp -r ~/umbrel/home/abs-library-backup/metadata ~/umbrel/app-data/saltedlolly-audiobookshelf/

# 6. Fix permissions
sudo chown -R 1000:1000 ~/umbrel/app-data/saltedlolly-audiobookshelf/

# 7. Start app from dashboard

# 8. Clean up backup
sudo rm -rf ~/umbrel/home/abs-library-backup
```

## Important Notes

- **Media files are now migrated automatically** during restore
  - The script detects media in the old app location
  - You'll be prompted if you want to migrate them
  - Files are moved (not copied) to avoid duplication
  - Permissions are automatically fixed to 1000:1000

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
