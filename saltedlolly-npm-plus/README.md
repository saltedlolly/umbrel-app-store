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

### Migrating from the Portainer `npmplus-data` volume

⚠️ **Umbrel's Portainer app runs its own nested Docker daemon** (this is
the same nesting that caused the original outage this package exists to
avoid). The `npmplus-data` named volume lives inside that nested daemon,
not Umbrel's own host Docker daemon - a plain `docker volume inspect
npmplus-data` run directly on the Umbrel over SSH will not find it. The
steps below use Portainer's own container console, which works regardless
of the nested-daemon layout, rather than guessing at raw `docker` commands
against a daemon this package can't directly verify the exact access path
for on your specific Umbrel. **Confirm each step works on your hardware
before trusting it with the only copy of your data.**

1. **Back up first, independently of both installations.** In the
   Portainer web UI, open the running `npmplus` container → **Console**,
   attach as `sh`, and run:
   ```sh
   tar czf /tmp/npmplus-data-backup.tar.gz -C /data .
   ```
   Then use Portainer's container **Console** file download (or `docker
   cp` if you've confirmed how to reach Portainer's nested daemon from
   the host) to get `/tmp/npmplus-data-backup.tar.gz` off the container
   and onto a machine that isn't the Umbrel itself (a laptop, another
   NAS, cloud storage - anywhere independent of this Umbrel's storage).
   Verify the archive is non-empty and extracts cleanly before continuing.
2. **Install this app fresh** (not yet with the migrated data) and
   confirm it works standalone: first login, creating a test proxy host,
   restart, persistence. Do not proceed until this passes.
3. **Stop both NPMplus instances** - the Portainer-managed container and
   this app's `npmplus` container - before copying anything. Running two
   NPMplus instances against the same data at once will corrupt it.
4. **Restore the backup into this app's data directory.** Extract
   `npmplus-data-backup.tar.gz` into
   `~/umbrel/app-data/saltedlolly-npm-plus/data/` on the Umbrel (via SSH,
   or the Umbrel Files app if it's mounted there), preserving the
   original file structure so it lands directly under that `data/`
   directory (i.e. `data/nginx/`, `data/letsencrypt/`, etc. sit directly
   inside it, not inside an extra nested folder).
5. **Restart this app** and verify: existing proxy hosts, certificates,
   and login all present exactly as they were under Portainer.
6. Only after step 5 is fully confirmed, consider decommissioning the old
   Portainer stack. Keep the backup archive until you're confident the
   migration is fully stable.

If step 1's Portainer Console approach doesn't match how your specific
Umbrel's Portainer install is set up, stop and figure out reliable data
access before proceeding - do not improvise a live copy between the two
installations.

## CrowdSec integration (optional, bring your own CrowdSec)

NPMplus ships with a built-in CrowdSec bouncer (no extra container needed
in this package) - it just needs a reachable CrowdSec engine + LAPI to
query. This package doesn't include CrowdSec itself: a standalone CrowdSec
Umbrel app is planned as a separate future package, so a single CrowdSec
instance can protect multiple apps/services rather than being tied to
this one.

Once you have a CrowdSec instance running (on this Umbrel or elsewhere on
your network), configure the bouncer by editing
`${APP_DATA_DIR}/data/crowdsec/crowdsec.conf` with your `API_URL`,
`API_KEY`, and (if using AppSec/WAF checks) `APPSEC_URL`, then restart the
app. See [NPMplus's own CrowdSec documentation](https://github.com/ZoeyVid/NPMplus)
for the exact config format and for registering this app as a bouncer
(`cscli bouncers add`) on the CrowdSec side.

CrowdSec's *local log-based detection* scenarios (as opposed to its
community IP-reputation blocklist and AppSec checks, which work over pure
network calls) need access to NPMplus's actual access logs. Since this
package doesn't bundle CrowdSec, that needs either CrowdSec's own syslog
log-forwarding datasource, or a shared bind mount under the Umbrel Home
folder that both this app and a future CrowdSec app mount (the same
pattern `saltedlolly-audiobookshelf` uses for its Audiobooks/Podcasts
folders) - not yet wired up in this package's default configuration.

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
