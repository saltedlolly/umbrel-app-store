# netboot.xyz for Umbrel

A self-hosted [netboot.xyz](https://netboot.xyz/) server - network-boot (PXE) a menu of OS installers, live rescue/diagnostic tools, and utilities to any machine on your LAN, no USB stick required.

## ⚠️ Required: point your router's DHCP at this app

netboot.xyz has no built-in DHCP server - it only serves boot files once a client is told to fetch them from here. **This is a one-time change on your router, not something this app can configure for you.**

You need to set two DHCP fields (sometimes labelled "Option 66"/"Option 67", or "next-server"/"boot filename", depending on your router):

- **next-server / TFTP server**: your Umbrel's IP address
- **boot filename**: `netboot.xyz.kpxe` for BIOS/legacy boot, or `netboot.xyz.efi` for UEFI (check [netboot.xyz's own docs](https://netboot.xyz/docs/booting/tftp/) for other architecture variants, e.g. ARM64)

Exactly where these fields live varies a lot by router. If your router runs **dnsmasq** (many do, including most consumer routers with third-party firmware like OpenWrt), the setup is documented directly by netboot.xyz: [netboot.xyz Docker DHCP docs](https://netboot.xyz/docs/docker/dhcp/). For other router software, check your router's own DHCP settings for "TFTP server" / "boot filename" / "PXE" options - this README doesn't attempt to cover every router UI.

## First boot needs internet access

By default, boot images stream live from netboot.xyz's own servers - your Umbrel needs outbound internet access the first time a client boots something. You can optionally mirror images locally (see below), which also lets you boot without needing an internet connection at that point.

## Adding your own images / local mirroring

Optional local/custom images live in your Umbrel's Home folder, under `Home/netboot.xyz` - visible and manageable through the Umbrel Files app. This is also where netboot.xyz stores anything it mirrors locally if you enable that via its web UI. Content here survives uninstalling this app (unlike its menu configuration).

To add a fully custom boot entry (not from netboot.xyz's own catalog), see netboot.xyz's own docs on `custom.ipxe` - the app's menu includes a "custom" option that loads from a file you maintain separately from the built-in menu.

## Why this app uses host networking

Unlike every other app in this store, this one runs with `network_mode: host` rather than being routed through Umbrel's app proxy - and there's no login/SSO in front of it as a result. This isn't a preference, it's a requirement: TFTP (which PXE clients use to fetch the initial boot file) negotiates a different, unpredictable UDP port for each transfer, which Docker's normal bridge networking can't forward correctly - a known, unresolved limitation of running TFTP in Docker. Host networking is the only way to get PXE booting working reliably.

## Ports

| Purpose | Port | Protocol |
| --- | ---: | --- |
| Web admin UI | `30380` | TCP/HTTP |
| Boot assets / menu (used by PXE clients, not for browsing) | `30480` | TCP/HTTP |
| TFTP (used by PXE clients) | `69` | UDP |

## Persistence

- `${APP_DATA_DIR}/data/config` - menu configuration. Self-populates with netboot.xyz's default menus on first start. Deleted if you uninstall the app.
- `Home/netboot.xyz` - locally-mirrored and custom boot images. Survives uninstalling the app, backed up along with the rest of your Home folder.

## Release tooling

`netbootxyz-build.sh` checks the upstream image's own tags (via Docker Hub's API - this project's GitHub releases don't map cleanly to its published image tags), pins the digest, updates package metadata, validates, and can deploy to `umbrel-dev` or publish a scoped commit.

```bash
# Read-only release and image check
./netbootxyz-build.sh --check

# Prepare the latest stable release locally
./netbootxyz-build.sh --update --notes "Update netboot.xyz"

# Prepare and copy the package to umbrel-dev
./netbootxyz-build.sh --localtest

# Prepare, validate, commit only this app, and push
./netbootxyz-build.sh --publish --notes "Update netboot.xyz"
```

## Credits

- **netboot.xyz**: [netbootxyz/docker-netbootxyz](https://github.com/netbootxyz/docker-netbootxyz)
- **Umbrel packaging**: Olly Stedall (saltedlolly)

## Support

For issues specific to this Umbrel packaging, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).

For netboot.xyz itself, see the [upstream repo](https://github.com/netbootxyz/docker-netbootxyz) and [netboot.xyz's own docs](https://netboot.xyz/docs/).
