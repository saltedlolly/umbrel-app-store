## 🌂 Olly's Umbrel App Store

My Umbrel Community App Store, containing apps I have created for UmbrelOS. If you find them useful, please sponsor my work. A monthly donation is a real help. Many thanks.

**Disclaimer:** This is an unofficial app store. Apps here are Some apps here are still under development. Use at your own risk.

## 🧱 How to add the App Store to your Umbrel

1. Open the Umbrel Dashboard and click on the **App Store**.
2. Click the **•••** button in the top right, and click "Community App Stores".
3. Paste the URL `https://github.com/saltedlolly/umbrel-app-store` and click 'Add'.
4. Click 'Open' next to "Olly's Umbrel Community App Store".

## 🖤 Support App Development

If you find these apps useful, please please support my work by becoming a sponsor: 

Give the repo a ⭐ or share it fellow with Umbrel users


## 🧩 Apps

### Audiobookshelf: NAS Edition  `v2.32.0.2`

🚨 WARNING: 🚧 This app is currently a work-in-progress and may not be functional. Data loss is possible. Use for testing only until further notice.

ABS NAS Edition is a custom version of [Audiobookshelf](https://www.audiobookshelf.org/) for Umbrel that adds robust support for accessing your media on a network share (NAS/SMB/NFS). The app includes a dedicated Network Shares Config Tool for managing which shares are available in Audiobookshelf. ABS NAS Edition also stores the Audiobookshelf settings and metadata in the user's Home folder, making backups easier, and ensuring that the library does not get deleted automatically, if the app is uninstalled. (If needed, Audiobookshelf settings and metadata can be deleted manually - stop/uninstall the Audiobookshelf app, and use the Files app to delete the ~/Audiobookshelf/app-data folders. Restart/reinstall when done.)

⚠️ WARNING: ABS NAS Edition is not compatible with the "official" Audiobookshelf app available in the Umbrel App Store. User accounts, audiobook libraries and metadata are NOT automatically shared between them - after installing you will be required to setup Audiobookshelf from scratch. Be advised that uninstalling the "official" app will delete your existing libary from the Umbrel - before proceeding, stop the app and make a backup, if needed. Migrating data manually may be possible if you are comfortable with the command line.

| App Folder                      | Description                  | Port         | Local Address                                            | Umbrel SSO    |
|---------------------------------|------------------------------| ------------ | -------------------------------------------------------- | ------------- |
| `saltedlolly-audiobookshelf/`   | Network Share Config Tool    | `23378`      | [http://umbrel.local:23378](http://umbrel.local:23378/)  | ✅            |
|                                 | Audiobookshelf               | `13378`      | [http://umbrel.local:13378](http://umbrel.local:13378/)  |               | 

Location: `saltedlolly-audiobookshelf/`

---

### Cloudflare DDNS for Umbrel  `v0.1.2`

A dynamic DNS client for Cloudflare powered by [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) which helps you automatically keep your domain or subdomain updated with your changing public IP address. Includes a web UI for configuration and monitoring. Supports IPv4 and IPv6, multiple domains, and Cloudflare cloud proxying.

| App Folder                      | Description                    | Port         | Local Address                                           | Umbrel SSO    |
|---------------------------------|--------------------------------| ------------ | ------------------------------------------------------- | ------------- |
| `saltedlolly-cloudflare-ddns/`  | Cloudflare DDNS Updater        | `4100`       | [http://umbrel.local:4100](http://umbrel.local:4100/)   | ✅            | 

---
