## 🌂 Olly's Umbrel App Store

This is my Umbrel Community App Store containing apps I have created for Umbrel OS. 

If you find these apps useful, please support my work by [becoming a sponsor](https://github.com/sponsors/saltedlolly?o=esb). 


## 🧱 How to add the App Store to your Umbrel

1. Launch the **App Store** from your Umbrel Dashboard.
2. Click the **•••** button in the top right, and click "Community App Stores".
3. Paste this URL `https://github.com/saltedlolly/umbrel-app-store` and click 'Add'.
4. Click 'Open' next to "Olly's Umbrel Community App Store".

**Disclaimer:** This is an unofficial App Store that is in no way affiliated with Umbrel. Use at your own risk.


## 🖤 Support App Development

Give the repo a ⭐ or share it fellow with Umbrel users.

If you find these apps useful, please support my work by [becoming a sponsor](https://github.com/sponsors/saltedlolly?o=esb). A monthly donation is a real help. Many thanks.


## 🧩 Apps

### Audiobookshelf: NAS Edition  `v2.32.0.6`

🚨 WARNING: 🚧 This app is currently a work-in-progress and may not be functional. Data loss is possible. Use for testing only until further notice.

- Enhanced [Audiobookshelf](https://www.audiobookshelf.org/) App with several advanced features not found in the Audiobookshelf App in the official Umbrel App Store.
- Adds robust support for accessing your media on a network share (NAS/SMB/NFS) - very useful if your audiobooks are stored on another device on your network.
- Use the dedicated Network Shares Config Tool to choose which shares mounted in the Files app can be accessed in Audiobookshelf.
- Audiobookshelf settings and metadata are stored in persistent storage - your library is not deleted if you uninstall. 
- User accounts and settings are accessible from within the Umbrel Files app for easier backup and restore.

⚠️ CAUTION: At this time, ABS NAS Edition is not compatible with the Audiobookshelf app available in the official Umbrel App Store. User accounts, audiobook libraries and metadata are NOT automatically shared between them - switching to this app will require you to setup Audiobookshelf again from scratch. Be advised that uninstalling the "official" app will actually delete your existing libary from your Umbrel - before proceeding, stop the app and make a backup, if needed. Migrating data manually may be possible if you are comfortable with the command line.

| Name                         | Port         | Local Address                                            | Umbrel SSO    |
|------------------------------| ------------ | -------------------------------------------------------- | ------------- |
| Network Share Config Tool    | `23378`      | [http://umbrel.local:23378](http://umbrel.local:23378/)  | ✅            |
| Audiobookshelf               | `13378`      | [http://umbrel.local:13378](http://umbrel.local:13378/)  |               | 

#### Audiobookshelf Data Folders

The app creates the following folders in your Umbrel Home folder:

 - `Audiobookshelf/`       - Parent folder - visible in the Files app
 - `├── app-data/`     
 - `│   ├── config/`       - Contains config files for Audiobookshelf (user accounts, libraries etc.)
 - `│   └── metadata/`     - Contains metadata for your Audiobookshelf media (cover art, file metadata etc.)
 - `├── Audiobooks/`       - Audiobooks stored locally on your Umbrel live here
 - `└── Podcasts/`         - Podcasts stored locally on your Umbrel live here

 These folders can be accessed using the Files app on your Umbrel, and remain in place even if the App is uninstalled. To fully "factory reset" Audiobookshelf, stop or uninstall the app, delete the `app-data` folder using the Files app, and then reinstall/restart the App. You can then visit the web ui to set it up again from scratch.

---

### Cloudflare DDNS  `v0.1.2` 

A dynamic DNS client for Cloudflare powered by [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) which helps you automatically keep your Cloudflare domain or subdomain updated with your changing public IP address. Includes a web UI for configuration and monitoring. Supports IPv4 and IPv6, multiple domains, and Cloudflare cloud proxying.

| Description                    | Port         | Local Address                                           | Umbrel SSO    |
|--------------------------------| ------------ | ------------------------------------------------------- | ------------- |
| Cloudflare DDNS Updater        | `4100`       | [http://umbrel.local:4100](http://umbrel.local:4100/)   | ✅            | 
