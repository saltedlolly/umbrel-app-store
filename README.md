## 🌂 Olly's Umbrel App Store

Welcome to my Umbrel Community App Store containing apps I have created for [Umbrel](https://umbrel.com/). 

## 🧱 How to access the App Store on your Umbrel

1. Launch the **App Store** from your Umbrel Dashboard.
2. Click the **•••** button in the top right, and click "Community App Stores".
3. Paste this URL `https://github.com/saltedlolly/umbrel-app-store` and click 'Add'.
4. Click 'Open' next to "Olly's Umbrel Community App Store".

**Disclaimer:** This is an unofficial App Store that is in no way affiliated with Umbrel. I cannot be held liable for any data loss that migh


## 🖤 Support App Development

Give the repo a ⭐ or share it fellow with Umbrel users.

If you find these apps useful, please support my work by [becoming a sponsor](https://github.com/sponsors/saltedlolly?o=esb). Your monthly donation helps me to keep improving theese Apps, and developing new ones.


## 🧩 Umbrel Apps

### Audiobookshelf: NAS Edition  `v2.32.1.80`

🚨 WARNING: 🚧 This app is currently a work-in-progress and may not be functional. Data loss is possible. Use for testing only until further notice.

- Enhanced [Audiobookshelf](https://www.audiobookshelf.org/) App with several advanced features not found in the official Audiobookshelf App found in the Umbrel App Store.
- Adds robust support for accessing your media on a network share (NAS/SMB/NFS) - very useful if your audiobooks are stored on another device on your network.
- Use the ABS Network Share Config Tool to select the network shares containing your media, and it will aways wait until they are accessible before starting Audibookshelf.
- Your Audiobookshelf user accounts, libraries, associated metadata, and local media files are all backed up when using Umbrel's Backup tool.

⚠️ CAUTION: If you are moving from the Audiobookshelf app available in the official Umbrel App Store to the NAS Edition, your user accounts, libraries and associated metadata are NOT migrated automatically. Be advised that uninstalling either app will delete your existing library from your Umbrel. The ABS Library Migration Tool (see below) can help you migrate your existing library to the NAS edition.

| Name                          | Port         | Local Address                                            | Umbrel SSO    |
|-------------------------------| ------------ | -------------------------------------------------------- | ------------- |
| ABS Network Share Config Tool | `23378`      | [http://umbrel.local:23378](http://umbrel.local:23378/)  | ✅            |
| Audiobookshelf                | `13378`      | [http://umbrel.local:13378](http://umbrel.local:13378/)  |               | 

#### Audiobookshelf Data Folders

The app creates the following folders in your Umbrel Home folder to store your media locally on the Umbrel. These can be managed using the Umbrel Files app. If you uninstall the app, these folders will be kept. 

 - `Audiobookshelf/`       - Parent folder - visible in the Files app
 - `├── Audiobooks/`       - Audiobooks stored locally on your Umbrel live here
 - `└── Podcasts/`         - Podcasts stored locally on your Umbrel live here

The folders below contain your user accounts, libraries and associated metadata. They will be deleted if you uninstall the app. It is reccomended to use Umbrel's Backup tool to keep them safe. You can also create a manual backup from the Files app. The ABS Library Migration Tool can be used to migrate your library when switching from the official Audiobookshelf app in the Umbrel App Store. 
 
 - `Apps/`
 - `└── saltedlolly-audiobookshelf/`   
 - `    └── data/`    
 - `        ├── config/`       - Contains config files for Audiobookshelf (user accounts, libraries etc.)
 - `        └── metadata/`     - Contains metadata for your Audiobookshelf media (cover art, file metadata etc.)
 - `            └── logs/`     - Contains Audiobookshelf log files

 #### ABS Library Migration Tool

 If you're switching from the official Audiobookshelf app to the NAS Edition, you can use the ABS Library Migration Tool to backup and restore your existing library (user accounts, libraries, reading progress, and metadata).

 **To run the migration tool:**

 1. Open the **Terminal** app from your Umbrel Dashboard. (Go to Settings → Advanced Settings → Terminal)
 2. Run this command:
    ```bash
    bash <(curl -fsSL https://raw.githubusercontent.com/saltedlolly/umbrel-apps/master/saltedlolly-audiobookshelf/tools/migrate-library.sh)
    ```
 3. Follow the interactive prompts to:
    - Backup your current library
    - Uninstall the current app and install the other version
    - Restore your library to the newly installed app

 For detailed migration instructions, see the [ABS Library Migration Tool documentation](https://github.com/saltedlolly/umbrel-app-store/tree/master/saltedlolly-audiobookshelf/tools#readme).

---

### Cloudflare DDNS  `v0.1.2` 

A dynamic DNS client for Cloudflare powered by [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) which helps you automatically keep your Cloudflare domain or subdomain updated with your current IP address. Includes a web UI for configuration and monitoring. Supports IPv4 and IPv6, multiple domains, and Cloudflare cloud proxying.

| Description                    | Port         | Local Address                                           | Umbrel SSO    |
|--------------------------------| ------------ | ------------------------------------------------------- | ------------- |
| Cloudflare DDNS Updater        | `4100`       | [http://umbrel.local:4100](http://umbrel.local:4100/)   | ✅            | 
