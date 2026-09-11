# Tronbyt Server for Umbrel

A self-hosted server for managing [Tidbyt](https://tidbyt.com/) and [Tronbyt](https://tronbyt.com/) smart displays, powered by [tronbyt/server](https://github.com/tronbyt/server), running entirely on your own Umbrel — no dependency on Tidbyt's cloud backend.

## Features

- Web UI for adding devices, browsing/configuring apps, and generating device firmware
- Works fully offline from Tidbyt's cloud, including some APIs Tidbyt's own servers block
- Supports Tidbyt Gen1/Gen2, Tronbyt S3/S3 Wide, MatrixPortal S3, and Raspberry Pi-driven LED matrix panels
- Multi-user support with its own login system (self-registration on first visit)

## Installation

The app uses the pre-built multi-arch image published upstream at `ghcr.io/tronbyt/server`, so no local building is required. See the root [README.md](../README.md) for how to add this community app store and install the app.

## Usage

### First run

1. Install Tronbyt Server from your Umbrel app store and open it at `http://umbrel.local:19191`.
2. Create your account (self-registration is enabled by default — the first account you create becomes an admin).
3. Add a device, then click **Firmware**, enter your WiFi credentials, and generate/download the firmware.
4. Use the ESPHome firmware flasher (linked from the Firmware page) to flash your Tidbyt into a Tronbyt.
5. Add and configure an app for your device via the built-in Pixlet interface.

### No Umbrel single sign-on

This app disables Umbrel's SSO (`PROXY_AUTH_ADD: "false"`) and relies entirely on Tronbyt's own account system. This is necessary rather than optional: physical Tidbyt/Tronbyt displays poll this server directly for content and firmware updates, and can't complete an interactive browser login — Umbrel SSO sitting in front of the app would block every device from ever reaching it. Tronbyt's own login already protects the web UI, so nothing is left unauthenticated as a result.

### Data persistence

All app state (accounts, devices, apps, and the SQLite database) is stored under the app's data folder, mounted into the container at `/app/data`:

```
~/umbrel/app-data/saltedlolly-tronbyt/data/
```

This is backed up automatically by Umbrel's Backup tool.

## Updates

This app checks daily for new `tronbyt/server` releases and auto-publishes an update once a release has been out for 5 days, giving upstream bugs time to surface before this store adopts them.

## Credits

- **Tronbyt Server**: [tronbyt/server](https://github.com/tronbyt/server)
- **Umbrel**: [getumbrel/umbrel](https://github.com/getumbrel/umbrel)
- **Umbrel packaging**: Olly Stedall (saltedlolly)

## Support

For issues specific to this Umbrel packaging, open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues).

For general Tronbyt Server issues, see the [upstream repo](https://github.com/tronbyt/server).
