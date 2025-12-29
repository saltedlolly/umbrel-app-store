## 🌂 Olly's Umbrel App Store

Welcome to my Umbrel Community App Store, containing all the apps I have developed for [Umbrel](https://umbrel.com/).

Details about the Apps are below. More may be added in future. Give the repo a ⭐ to be kept informed.

## 🧱 How to access the App Store on your Umbrel

1. Launch the **App Store** from your Umbrel Dashboard.
2. Click the **•••** button in the top right, and click "Community App Stores".
3. Paste this URL `https://github.com/saltedlolly/umbrel-app-store` and click 'Add'.
4. Click 'Open' next to "Olly's Umbrel Community App Store".

**Disclaimer:** This is a community project, not an official Umbrel service. Stuff might break. Please back up your data and don’t rely on any app without testing first. By using this app store, you accept that you’re responsible for your own system.


## ❤️ Support App Development

If you find these Apps useful, please support my work by [becoming a sponsor](https://github.com/sponsors/saltedlolly). 

Your support helps me maintain and improve existing Apps, and develop new ones.

One-time donations and monthly sponsors are both hugely appreciated — thank you for helping keep open-source sustainable. 🙏


## 🧩 Umbrel Apps

### Audiobookshelf: NAS Edition  `v2.32.1.83`
<img src="https://raw.githubusercontent.com/getumbrel/umbrel-apps-gallery/master/audiobookshelf/icon.svg" align="right" hspace="20px" vspace="0 20px" width="150px" style="border-radius: 10%;" />

🚨 WARNING: 🚧 This app is currently a work-in-progress and may not be functional. Data loss is possible. Use for testing only until further notice.

 This [Audiobookshelf](https://www.audiobookshelf.org/) app includes several advanced features not available in the Umbrel App Store version:

- Adds robust support for accessing your media on a network share (NAS/SMB/NFS) - essential if your audiobooks are stored on another device on your network.
- Use the 'ABS Network Share Config Tool' to select the network share(s) containing your media, and it will aways wait until they are available before starting Audiobookshelf.
- Your Audiobookshelf user accounts, libraries, associated metadata, and local media files are all backed up when using Umbrel's Backup tool.
- The separate ABS Library Migration Tool (see below) can help you migrate your existing Audiobookshelf library from the official app.

⚠️ IMPORTANT: If you are moving from the Audiobookshelf app available in the official Umbrel App Store to the NAS Edition, your user accounts, libraries and associated metadata are NOT migrated automatically. Be advised that uninstalling either app will delete your existing library from your Umbrel. The ABS Library Migration Tool (see below) can help you migrate your existing library to the NAS edition.

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
<img src="https://raw.githubusercontent.com/saltedlolly/umbrel-app-store-gallery/master/saltedlolly-cloudflare-ddns/logo.png" align="right" hspace="20px" vspace="0 20px" width="150px" style="border-radius: 10%;" />

A dynamic DNS client for Cloudflare powered by [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) which helps you automatically keep your Cloudflare domain or subdomain updated with your current IP address. Includes a web UI for configuration and monitoring. Supports IPv4 and IPv6, multiple domains, and Cloudflare cloud proxying.

| Description                    | Port         | Local Address                                           | Umbrel SSO    |
|--------------------------------| ------------ | ------------------------------------------------------- | ------------- |
| Cloudflare DDNS Updater        | `4100`       | [http://umbrel.local:4100](http://umbrel.local:4100/)   | ✅            | 
