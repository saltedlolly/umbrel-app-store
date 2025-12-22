## Olly's Umbrel App Store

This is my Umbrel Community App Store, containing apps I have created for UmbrelOS. If you find them useful, please sponsor my work. A monthly donation is a real help. Many thanks.

**Disclaimer:** Some apps here are still under development. Use at your own risk.

## Adding this App Store to your Umbrel

1. Open the Umbrel Dashboard and click on the **App Store**.
2. Click the **•••** button in the top right, and click "Community App Stores".
3. Paste the URL `https://github.com/saltedlolly/umbrel-app-store` and click 'Add'.
4. Click 'Open' next to "Olly's Umbrel Community App Store".

## Apps

### Audiobookshelf: NAS Edition [ 🚧 Work in Progress ]

Custom version of [Audiobookshelf](https://www.audiobookshelf.org/) for Umbrel that adds robust support for accessing your media on a network share (NAS/SMB/NFS). The app includes a dedicated Network Shares configuration UI accessible on port 23378 for managing which shares are available Audiobookshelf. Audiobookshelf itself is accessible at port 13378. The app also keeps Audiobookshelf metadata and config files in the Home folder, making backups easier, and ensuring that your library does get deleted automatically if the app is uninstalled. (If needed, Audiobookshelf can be deleted manually - stop or uninstall Audiobookshelf, and delete the Audiobookshelf/app-data folders using Umbrel's Files app.)

🚨 Warning: This app is currently in development and may not be functional. Data loss is possible. Use for testing only until further notice.

Location: `saltedlolly-audiobookshelf/`

### Cloudflare DDNS for Umbrel

A dynamic DNS client for Cloudflare powered by [favonia/cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) which helps you automatically keep your domain or subdomain updated with your changing public IP address. Includes a web UI for configuration and monitoring. Supports IPv4 and IPv6, multiple domains, and Cloudflare cloud proxying.

Location: `saltedlolly-cloudflare-ddns/`
