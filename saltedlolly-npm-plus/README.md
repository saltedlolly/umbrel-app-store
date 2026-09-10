# NPMplus for umbrelOS

This package runs NPMplus directly under Umbrel's Docker engine. It does not use Portainer and does not include Authentik or CrowdSec.

## Architecture

- `launcher` is a small HTTP setup page behind Umbrel's authenticated app proxy on port `5180`.
- `npmplus` runs on Umbrel's normal bridge network and publishes its HTTPS administration interface and reverse-proxy entrypoints.
- `docker-host` matches the official Umbrel Nginx Proxy Manager package and makes the Umbrel host resolvable from NPMplus as the device's `.local` hostname.
- `${APP_DATA_DIR}/data` is mounted at `/data` and contains all persistent NPMplus state.

## Ports

| Purpose | Umbrel port | Container port | Protocol |
| --- | ---: | ---: | --- |
| Umbrel launcher | `5180` | `8080` | TCP/HTTP |
| NPMplus administration | `5181` | `81` | TCP/HTTPS |
| Proxy HTTP | `50080` | `80` | TCP |
| Proxy HTTPS | `50443` | `443` | TCP |
| Proxy HTTP/3 | `50443` | `443` | UDP |

For public access, forward router TCP port 80 to Umbrel TCP port 50080, and router TCP/UDP port 443 to Umbrel TCP/UDP port 50443.

## First login

- Username: `admin@umbrel.local`
- Password: the per-install password displayed by Umbrel

The package passes Umbrel's stable `${APP_PASSWORD}` to NPMplus as `INITIAL_ADMIN_PASSWORD`. NPMplus only consumes the initial username and password when it creates a fresh database; existing users are not reset during restarts or updates.

NPMplus serves its administration interface using HTTPS. A clean installation begins with a locally generated certificate, so the browser may show a certificate warning on the first visit to `https://umbrel.local:5181`.

## Persistence and migration safety

NPMplus data is stored at `${APP_DATA_DIR}/data`. Restarts and app updates preserve this directory. Uninstalling the Umbrel app deletes it.

Do not migrate an existing Portainer volume until:

1. The complete existing NPMplus `/data` volume has been backed up.
2. This package has passed a clean-install and first-login test.
3. Both the old and new NPMplus containers are stopped before any data is copied.
4. The backup has been checked independently of the live Portainer stack.

The Portainer migration procedure will be added after its nested Docker volume layout has been verified on the target Umbrel. Do not improvise a live copy between the two installations.

## Release tooling

`npmplus-build.sh` checks upstream releases, verifies multi-architecture image support, pins the manifest digest, updates package metadata, validates the package, deploys it to `umbrel-dev`, and optionally publishes a scoped Git commit.

```bash
# Read-only release and image check
./npmplus-build.sh --check

# Prepare the latest stable release locally
./npmplus-build.sh --update --notes "Update NPMplus"

# Prepare and copy the package to umbrel-dev
./npmplus-build.sh --localtest --notes "Test NPMplus update"

# Prepare, validate, commit only this app, and push
./npmplus-build.sh --publish --notes "Update NPMplus"
```

Use `--version <release-tag>` to package a specific immutable NPMplus release and `--host <host-or-ip>` to override the default `umbrel-dev` address.

## Test checklist

- Install through the Umbrel App Store UI.
- Open the launcher from the home screen.
- Open the NPMplus HTTPS UI and sign in with the displayed Umbrel credential.
- Confirm TCP ports 50080 and 50443 and UDP port 50443 are bound.
- Create an HTTP proxy host and obtain a certificate.
- Enable HTTP/3 for a test host and verify QUIC externally.
- Confirm the upstream service sees the expected client address.
- Restart the app and confirm login, hosts, and certificates remain.
- Update the app and repeat the persistence checks.

Bridge networking is intentional for the first release. Host networking should only be adopted if device testing demonstrates a concrete NPMplus feature that cannot work through Umbrel's direct bridge and port publishing.
