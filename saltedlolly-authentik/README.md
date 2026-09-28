# Authentik for Umbrel

One login for the apps you share from your Umbrel, powered by [Authentik](https://goauthentik.io). Create each person once, choose which apps they can use, and let them sign in with a password, a passkey or their Google account.

> ⚠️ **Under construction.** This app is still being tested and the steps below are still being checked. Please don't use it yet.

## Before you start

- **Memory:** Authentik uses about 1 GB of RAM. An Umbrel with 8 GB is recommended (for example a Raspberry Pi 5 with 8 GB, or an Umbrel Home). 4 GB works if you run only a few other apps.
- **To sign in from outside your home** you need your apps published on your own domain: the [Cloudflare DDNS](../saltedlolly-cloudflare-ddns) and [NPMplus](../saltedlolly-npm-plus) apps from this app store, and your router forwarding ports 80 and 443 to NPMplus.

## First login

Open Authentik from your Umbrel dashboard. Sign in as **akadmin** with the password shown on the app's page in Umbrel (click the app, then the key icon).

Then, in the admin interface:

1. Open your account (top right) and change the email address from `root@localhost` to your own.
2. Set up two-factor authentication or a passkey for the admin account (**Settings → MFA Devices**).

## Publish Authentik on your domain

Friends and family sign in on a page like `https://auth.yourdomain.com`. To publish it:

1. **DNS:** point `auth.yourdomain.com` at your home, the same way as your other apps (with Cloudflare, a CNAME to your Cloudflare DDNS hostname).
2. **NPMplus:** add a proxy host:
   - Domain: `auth.yourdomain.com`
   - Scheme: `http`, forward host: `10.21.0.1`, port: `9810`
   - SSL: request a certificate, force SSL
3. **Authentik:** tell its built-in outpost its public address. **Applications → Outposts → authentik Embedded Outpost → Edit → Advanced settings**, set `authentik_host: https://auth.yourdomain.com/`, and save.

`10.21.0.1:9810` is only reachable by other apps on your Umbrel, not by other devices on your network. The admin interface you open from the Umbrel dashboard keeps working as before.

## Audiobookshelf (and other apps with OpenID login)

Apps with a "Log in with OpenID" option use Authentik as their login. Their mobile apps work too, and each person keeps their own account and progress.

**In Authentik:** **Applications → Applications → Create with provider**:
1. Name: `Audiobookshelf`. Provider type: **OAuth2/OpenID Provider**.
2. Redirect URIs (strict), replacing the domain with your Audiobookshelf address:
   - `https://abs.yourdomain.com/auth/openid/callback`
   - `https://abs.yourdomain.com/auth/openid/mobile-redirect`
3. Note the **Client ID** and **Client Secret**.
4. Under **Bindings**, choose who may use it (for example a `family` group).

**In Audiobookshelf:** **Settings → Authentication → OpenID Connect**:
1. Issuer URL: `https://auth.yourdomain.com/application/o/audiobookshelf/`, then **Auto-populate**.
2. Paste the Client ID and Client Secret.
3. **Match existing users by:** email. Create each person in Audiobookshelf first, with the same email as in Authentik.
4. **Allowed Mobile Redirect URIs:** add each mobile app you use, for example `audiobookshelf://oauth` (official app) and `audiobooth://oauth` (Audiobooth). The app's add-server screen usually shows its address.
5. Keep **Password Authentication** switched on as a backup. If OpenID stops working and it's off, you can only get back in by editing Audiobookshelf's database.

If someone gets "Unauthorized", check that their email address is marked as verified in Authentik (Audiobookshelf requires it).

## Sign in with Google

Friends and family with a Google account can use it instead of a new password.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, set up the OAuth consent screen (External, app name, your email), then create an **OAuth client ID** of type **Web application** with this authorised redirect URI: `https://auth.yourdomain.com/source/oauth/callback/google/`
2. In Authentik: **Directory → Federation and Social login → Create → Google OAuth Source**. Slug `google`, paste the client ID and secret.
3. Show the Google button on the login page: **Flows and Stages → Stages → default-authentication-identification → Edit**, and add Google under **Sources**.

Google allows apps like this for up to 100 people without review; people may see an "unverified app" notice the first time they sign in.

## Apps without their own login (forward auth)

For apps with no login of their own, NPMplus can ask Authentik before letting anyone through. This needs the NPMplus integration, which is still being built.

If Authentik is down, these apps show an error rather than opening up to everyone.

## Updates and backups

Authentik has to be upgraded one release at a time (2026.5 → 2026.8 → …) and refuses to start if a release is skipped. umbrelOS always installs the newest version of an app, so this app catches up by itself: before starting, it runs each release you missed in turn (a few minutes each). You'll find a log in `data/upgrade/upgrade.log`.

Before every Authentik version change, it also backs up Authentik's database to `data/backups/` (the newest 3 are kept). Authentik can't be downgraded, so these backups are the only way back from a failed upgrade.

## How it works

- `server`: Authentik's web interface, login pages, API and built-in outpost (forward auth). Opened from the Umbrel dashboard through Umbrel's app proxy (port 9800), and published for NPMplus on the Docker gateway only (`10.21.0.1:9810`).
- `worker`: background tasks. Unlike Authentik's own compose file, it doesn't run as root and has no Docker socket access (only needed to deploy extra outposts as containers).
- `postgresql`: PostgreSQL 16.
- `hooks/pre-start`: the database backup and release-by-release upgrade described above.
- Secrets (Authentik's secret key and the database password) are generated per Umbrel from its app entropy. The akadmin password is Umbrel's deterministic app password and is only used on the very first start.

Data lives in `~/umbrel/app-data/saltedlolly-authentik/data/`: `postgres/` (database), `data/` (uploaded files), `custom-templates/`, `certs/`, `backups/`, `upgrade/`.

## Release tooling

```bash
# Print the next eligible Authentik version (never skips a release family)
./authentik-build.sh --next-version --min-age-days 2

# Move to the next Authentik version, commit and push
./authentik-build.sh --publish --notes "Update to Authentik 2026.11.0"

# Local packaging fix on the same Authentik version
./authentik-build.sh --bump --notes "Fix something" --publish
```

When moving to a new release family, the script adds the previous family's last release to `hooks/pre-start` as a stepping stone.

## Credits

[Authentik](https://github.com/goauthentik/authentik) by Authentik Security Inc. This package is maintained by [@saltedlolly](https://github.com/saltedlolly).

## Support

Problems with this Umbrel package: [open an issue](https://github.com/saltedlolly/umbrel-app-store/issues).
