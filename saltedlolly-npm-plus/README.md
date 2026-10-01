# NPMplus for umbrelOS

This package runs NPMplus directly under Umbrel's Docker engine. It does not use Portainer. It works on its own, and connects automatically to the CrowdSec and Authentik apps from this store if you install them.

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

## CrowdSec integration (optional)

NPMplus has a built-in CrowdSec bouncer. Install the [CrowdSec app](../saltedlolly-crowdsec) from this store and the two connect automatically the next time NPMplus starts; nothing to configure. Every site published through NPMplus is then protected:

- **Blocklist:** known attackers (CrowdSec's community list plus anything your CrowdSec bans) are blocked.
- **Web application firewall (AppSec):** common attacks and exploit probes are refused. It can be switched off for a single proxy host (**Disable Crowdsec Appsec**).
- **Log analysis:** NPMplus sends its access logs to CrowdSec, which bans scanners, brute-force attempts and aggressive crawlers.

The integration fails open: if CrowdSec is stopped or uninstalled, your sites keep working. The launcher's CrowdSec card shows the connection state and the number of active bans. If CrowdSec bans a legitimate app (for example an Audiobookshelf mobile app), see the whitelist recipe in the [CrowdSec README](../saltedlolly-crowdsec/README.md).

## Authentik integration (optional)

With the [Authentik app](../saltedlolly-authentik) from this store installed, NPMplus can ask Authentik before letting anyone into a site ("forward auth"). NPMplus finds Authentik automatically and already knows its address, so you only choose **authentik** under **Auth Request** on a proxy host. Nothing is protected until you do: each site is switched on separately.

**When to use it:** for sites people open in a web browser that have no login of their own (or a weak one). Apps with their own OpenID login, such as Audiobookshelf, should use that instead: forward auth would stop their mobile apps working, and people would have to sign in twice. For OIDC, follow the app's own documentation and [Authentik's integration guides](https://integrations.goauthentik.io/), then publish the app as a normal proxy host (Auth Request: none). [Authentik's forward auth documentation](https://docs.goauthentik.io/add-secure-apps/providers/proxy/forward_auth/) explains how forward auth works.

**Setting up a site** (the launcher's Authentik card has the same steps):

1. **First, give Authentik a public address** such as `auth.yourdomain.com` (once, after securing your Authentik admin account with a passkey or authenticator app):
   - **DNS:** point it at your home's public IP address, like your other sites. If you use Cloudflare and your home doesn't have a fixed IP address, the [Cloudflare DDNS app](../saltedlolly-cloudflare-ddns) keeps it up to date.
   - **NPMplus:** add a proxy host for it: scheme `http`, forward hostname `10.21.0.1`, port `9810`, with a TLS certificate.
   - **Authentik:** set the address in **System → Settings → Base URL** and in the embedded outpost's `authentik_host` (details in the [Authentik README](../saltedlolly-authentik/README.md)). Otherwise visitors are sent to a sign-in address they can't reach.
2. **In Authentik:** Applications → Applications → **Create with provider**. Choose **Proxy Provider**, mode **Forward auth (single application)**, and set **External host** to the site's public address. Under **Bindings**, choose who may use it.
3. **In Authentik:** Applications → Outposts → **authentik Embedded Outpost** → Edit, and add the application.
4. **In NPMplus:** on the site's proxy host, set **Auth Request** to **authentik** and leave **Auth Request Upstream** empty.

**Important:** forward auth works only for people using a web browser. Mobile apps and other programs that connect to the site directly can't show Authentik's login page, so they're blocked. If other apps use the site's API (for example Sonarr, Radarr and Prowlarr, with an API key), add a **Custom Location** for its API path (such as `/api`) with Auth Request set to **none**; the API stays protected by its key.

**If Authentik is down**, protected sites show an error instead of opening ("fail closed"). Other sites are unaffected.

> ⚠️ **Be careful what you share.** Authentik decides *who* gets in; once in, people can do whatever the app allows.
>
> 1. **If you don't need to share an app, don't.** If only you use it, use it over Tailscale (or on your home network) behind your Umbrel login instead. Never publish apps that control your Umbrel or its files, even behind Authentik: for example Portainer, terminals, file managers with access to your Home folder, NPMplus's own admin page, or the Umbrel dashboard.
> 2. **If you must share an app that normally uses your Umbrel login** (most apps without a login of their own), forward its proxy host to the app's container, not to its Umbrel port. Otherwise visitors also get your Umbrel's login page. To find the container name and port:
>    - Open the app's page in the Umbrel App Store: its app ID is the last part of the page's address (for example `librespeed`).
>    - Open its `docker-compose.yml` on GitHub: for apps from the official store, `https://github.com/getumbrel/umbrel-apps/blob/master/<app-id>/docker-compose.yml` (for a community store, that store's own repository).
>    - Under `app_proxy`, use `APP_HOST` as the forward hostname and `APP_PORT` as the port (for LibreSpeed: `librespeed_server_1` and `8080`).
>
>    This only works for apps on the same Umbrel as NPMplus.

The launcher's Authentik card shows whether Authentik is detected, its public address (found from your proxy hosts; **Open Authentik** uses it), and the sites NPMplus checks with Authentik, with a warning if they can't reach it. Apps that sign in with OIDC aren't listed there: they talk to Authentik directly.

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
