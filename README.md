## 🌂 Olly's Umbrel App Store

My Umbrel Community App Store containing apps I have created for [Umbrel](https://umbrel.com/). 


## 🧱 How to add the App Store to your Umbrel

1. Launch the **App Store** from your Umbrel Dashboard.
2. Click the **•••** button in the top right, and click "Community App Stores".
3. Paste this URL `https://github.com/saltedlolly/umbrel-app-store` and click 'Add'.
4. Click 'Open' next to "Olly's Umbrel Community App Store".

**Disclaimer:** This is an unofficial App Store that is in no way affiliated with Umbrel. Use at your own risk.


## 🖤 Support App Development

Give the repo a ⭐ or share it fellow with Umbrel users.

If you find these apps useful, please support my work by [becoming a sponsor](https://github.com/sponsors/saltedlolly?o=esb). A monthly donation is a real help. Many thanks.


## 🧩 Umbrel Apps

### Audiobookshelf: NAS Edition  `v2.32.0.10`

🚨 WARNING: 🚧 This app is currently a work-in-progress and may not be functional. Data loss is possible. Use for testing only until further notice.

- Enhanced [Audiobookshelf](https://www.audiobookshelf.org/) App with several advanced features not found in the Audiobookshelf App in the official Umbrel App Store.
- Adds robust support for accessing your media on a network share (NAS/SMB/NFS) - very useful if your audiobooks are stored on another device on your network.
- Use the dedicated Network Shares Config Tool to choose which shares mounted in the Files app can be accessed in Audiobookshelf.
- Your Audiobookshelf user accounts, libraries and associated metadata are backed up when using Umbrel's Backup feature.

⚠️ CAUTION: If you are moving from the Audiobookshelf app available in the official Umbrel App Store to this NAS Edition, your user accounts, libraries and associated metadata are NOT migrated automatically. Be advised that uninstalling either app will delete your existing library from your Umbrel. The ABS Library Migration Tool (see below) can help you migrate your existing library to the NAS edition.

| Name                         | Port         | Local Address                                            | Umbrel SSO    |
|------------------------------| ------------ | -------------------------------------------------------- | ------------- |
| Network Share Config Tool    | `23378`      | [http://umbrel.local:23378](http://umbrel.local:23378/)  | ✅            |
| Audiobookshelf               | `13378`      | [http://umbrel.local:13378](http://umbrel.local:13378/)  |               | 

#### Audiobookshelf Data Folders

The app creates the following folders in your Umbrel Home folder. These folders remain even after the app is uninstalled. You can manage them from the Files app.

 - `Audiobookshelf/`       - Parent folder - visible in the Files app
 - `├── Audiobooks/`       - Audiobooks stored locally on your Umbrel live here
 - `└── Podcasts/`         - Podcasts stored locally on your Umbrel live here

The folders below contain your user accounts, libraries and associated metadata. They will be deleted if you uninstall the app. It is reccomended to use Umbrel Backup so they can be easily recovered, if needed. You can also create a manual backup from the Files app. The ABS Library Migration Tool (see below) can be used to migrate your library when moving from the Audiobookshelf app available from the Umbrel App Store. 
 
 - `Apps/`
 - `└── saltedlolly-audiobookshelf/`   
 - `    └── data/`    
 - `        ├── config/`       - Contains config files for Audiobookshelf (user accounts, libraries etc.)
 - `        └── metadata/`     - Contains metadata for your Audiobookshelf media (cover art, file metadata etc.)

 #### ABS Library Migration Tool

 If you're switching between the official Audiobookshelf app and this NAS Edition, use the migration tool to backup and restore your library (user accounts, libraries, reading progress, and metadata).

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

 For detailed migration instructions, see the [migration tool documentation](https://github.com/saltedlolly/umbrel-app-store/tree/master/saltedlolly-audiobookshelf/tools#readme).

---

### Cloudflare DDNS  `v0.1.2` 

A dynamic DNS client for Cloudflare powered by [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) which helps you automatically keep your Cloudflare domain or subdomain updated with your changing public IP address. Includes a web UI for configuration and monitoring. Supports IPv4 and IPv6, multiple domains, and Cloudflare cloud proxying.

| Description                    | Port         | Local Address                                           | Umbrel SSO    |
|--------------------------------| ------------ | ------------------------------------------------------- | ------------- |
| Cloudflare DDNS Updater        | `4100`       | [http://umbrel.local:4100](http://umbrel.local:4100/)   | ✅            | 
