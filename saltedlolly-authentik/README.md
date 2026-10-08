<a href="https://saltedlolly.com"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/saltedlolly/saltedlolly-wordmark-dark-bg.png">
  <img alt="saltedlolly" src="../assets/saltedlolly/saltedlolly-wordmark-light-bg.png" height="36" align="right">
</picture></a>

# Authentik for Umbrel

One login for the apps you share from your Umbrel, powered by [Authentik](https://goauthentik.io). Share the services you want, with the people you want, securing each account how you want. Supports MFA, TOTP, passkey, Google account login and more.

> ⚠️ **Under construction.** This app is still being tested and the steps below are still being checked. Please don't use it yet.

## Before you start

- **Memory:** Authentik uses about 1 GB of RAM. An Umbrel with 8 GB is recommended (for example a Raspberry Pi 5 with 8 GB, or an Umbrel Home). 4 GB works if you run only a few other apps.

To let people sign in from outside your home, you also need:

- **A domain name pointing at your home.** Any DNS provider works. Unless your home has a fixed IP address, you also need a way to keep the domain's records updated with your public IP address (dynamic DNS). If you use Cloudflare, the [Cloudflare DDNS](../saltedlolly-cloudflare-ddns) app from this store can do this for you.
- **A reverse proxy on your Umbrel** that publishes your apps on your domain with HTTPS, and a way for traffic to reach it: usually your router forwarding ports 80 and 443 to the reverse proxy. [NPMplus](../saltedlolly-npm-plus), also available from this store, is a powerful reverse proxy with built-in support for Authentik and CrowdSec. The steps below use NPMplus, but any reverse proxy running as an app on your Umbrel can do the same job.

Optional:

- **[CrowdSec](../saltedlolly-crowdsec)** (also in this store) adds crowdsourced security to NPMplus, blocking known attackers and common attacks from the internet.

Do the steps below in order. In particular, publish Authentik on your domain (step 2) **before** setting up passkeys: a passkey only works on the address it was created on.

## 1. First login

Open Authentik from your Umbrel dashboard. Sign in as **akadmin** with the password shown on the app's page in Umbrel (click the app, then the key icon).

## 2. Publish Authentik on your domain

The people you share apps with sign in on a page like `https://auth.yourdomain.com`.

1. **DNS:** point `auth.yourdomain.com` at your home, the same way as your other apps. For example, with Cloudflare: a CNAME record to the hostname your dynamic DNS keeps up to date.
2. **Reverse proxy:** publish `auth.yourdomain.com` with HTTPS, forwarding to `http://10.21.0.1:9810`. With NPMplus, add a proxy host:
   - Domain: `auth.yourdomain.com`
   - Scheme: `http`, forward host: `10.21.0.1`, port: `9810`
   - TLS: request a certificate, force HTTPS

`10.21.0.1:9810` is only reachable by other apps on your Umbrel, not by other devices on your network, so the reverse proxy has to run as an app on the same Umbrel.

## 3. Tell Authentik its public address

Authentik needs its public address in **two** places. Open the admin interface at `https://auth.yourdomain.com` from now on.

1. **System → Settings → Base URL:** `https://auth.yourdomain.com`
2. **Applications → Outposts → authentik Embedded Outpost → Edit → Advanced settings:** set `authentik_host: https://auth.yourdomain.com/`. Authentik fills this in automatically from the first address you opened it on (usually `https://umbrel.local:9800`), and the Base URL doesn't change it.

## 4. Your accounts

Keep two admin accounts:

- **Your own account for daily use.** **Directory → Users → Create**, type **Internal**, with your own email address, then add it to the **authentik Admins** group. Sign in as yourself at `https://auth.yourdomain.com` and add a passkey and an authenticator app (**Settings → MFA Devices**).
- **akadmin as a backup**, with the password Umbrel shows. Give it its own email address (plus addressing like `you+authentik-admin@example.com` works) and an authenticator app, and don't use it day to day.

Don't give two accounts the same email address: Authentik's login page and Google sign-in then pick one of them unpredictably.

## 5. Sign-in security

Two settings make signing in both safer and easier.

**Require two-factor authentication for password sign-ins.** **Flows and Stages → Stages → default-authentication-mfa-validation → Edit**:
- **Not configured action:** Force the user to configure an authenticator
- **Configuration stages:** `default-authenticator-totp-setup` and `default-authenticator-webauthn-setup` (people choose an authenticator app or a passkey)

Anyone signing in with a password who hasn't set up a second factor is asked to do so before they can continue.

**Sign in with a passkey straight from the username field.** **Flows and Stages → Stages → default-authentication-identification → Edit → Passkey settings:** set **WebAuthn Authenticator Validation Stage** to `default-authentication-mfa-validation`. People with a passkey then pick it from their browser or password manager and are signed in with no password or code. A passkey already proves two things (the device holding it and the face, fingerprint or PIN that unlocks it), so no extra code is needed.

## 6. Sign in with Google (optional)

People can use their Google account instead of a password. Only people you have added to Authentik can sign in this way.

**In the [Google Cloud console](https://console.cloud.google.com/)** (free, no billing account needed; ignore the free-trial offers):
1. Create a project, e.g. `Authentik`.
2. **APIs and services → OAuth consent screen** (Google Auth Platform) → **Get started**: app name (people see "Sign in to *app name*"), your support email, **Audience: External** (Internal only allows accounts from your own Google Workspace), contact email.
3. **Audience → Test users:** add each person's Google address. While the app is in Testing, only these accounts can use it (up to 100). There's no need to publish it.
4. **Clients → Create client:** type **Web application**, authorised redirect URI `https://auth.yourdomain.com/source/oauth/callback/google/`. Save the Client ID and secret in your password manager.

If you use a Google Workspace account and can't create a project, a Workspace admin needs to allow it at [admin.google.com](https://admin.google.com): **Apps → Additional Google services → Google Cloud Platform → Cloud Resource Manager API settings → Allow users to create projects**.

**In Authentik:**
1. **Directory → Federation and Social login → Create → Google OAuth Source:**
   - Name `Google`, slug `google`, **Promoted** on (a full-width "Continue with Google" button)
   - **User matching mode:** Link to a user with identical email address (safe with Google, which only gives out verified addresses)
   - Consumer key and secret: the Client ID and secret
   - **Enrollment flow: empty.** This makes it invite-only: a Google account that doesn't match a user you've created is refused ("Source is not configured for enrollment"), instead of getting a new account
2. **Flows and Stages → Stages → default-authentication-identification → Edit → Sources:** add Google.

Google sign-ins rely on Google's own security (such as 2-Step Verification), not on Authentik's second factor.

## 7. Apps with OpenID login: Audiobookshelf as an example

Apps with a "Log in with OpenID" option can use Authentik as their login. This section shows it for Audiobookshelf; skip it if you don't use Audiobookshelf. Other apps need the same two halves (an application and provider in Authentik, the OpenID settings in the app), with their own redirect URIs. With Audiobookshelf, its mobile apps work too, and each person keeps their own account and progress.

**In Authentik**, first a small fix: Authentik tells apps that email addresses are *not* verified, and Audiobookshelf then refuses to match accounts by email. People can't change their own email in Authentik, so it's safe to say they are verified:

1. **Customization → Property Mappings → Create → Scope Mapping:** name `Email (verified)`, scope name `email`, expression:
   ```python
   return {"email": request.user.email, "email_verified": True}
   ```
2. **Applications → Applications → Create with provider:**
   - Name `Audiobookshelf`. Provider type **OAuth2/OpenID Provider**
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Client type: Confidential. Redirect URIs (strict), with your Audiobookshelf address:
     - `https://abs.yourdomain.com/auth/openid/callback`
     - `https://abs.yourdomain.com/auth/openid/mobile-redirect`
   - **Advanced protocol settings → Scopes:** `openid`, `profile` and **Email (verified)** (instead of the default email mapping)
   - **Advanced flow settings → Invalidation flow:** `default-invalidation-flow`, so signing out of Audiobookshelf also signs you out of Authentik
   - Note the **Client ID** and **Client Secret**
3. Optionally, under **Bindings**, choose who may use it (for example a group of the people who use it). With no bindings, every Authentik user can.

**In Audiobookshelf:** **Settings → Authentication → OpenID Connect**:
1. Issuer URL: `https://auth.yourdomain.com/application/o/audiobookshelf/` (the last part is the application's slug), then **Auto-populate**.
2. Paste the Client ID and Client Secret.
3. **Match existing users by:** email. **Auto Register:** off. Create each person in Audiobookshelf first, with the same email as in Authentik.
4. **Subfolder for Redirect URLs:** None.
5. **Allowed Mobile Redirect URIs:** add the redirect URI of every mobile app your users might use; apps that aren't on the list fail at the last step of signing in. Audiobookshelf's [OpenID Connect documentation](https://audiobookshelf.org/docs/documentation/server-management/oidc-authentication) explains this field. For an app's URI, check that page, the app's sign-in screen or its own documentation. If you plan to switch off Audiobookshelf's password login, first check that every app your users rely on supports OpenID sign-in.
6. Save, and restart Audiobookshelf.

Always open Audiobookshelf on its public address (`https://abs.yourdomain.com`) to sign in: it builds the return address from the address you opened it on, and a local address won't match the redirect URIs.

**Once it works for you:**
- **Auto Launch** (in the same OpenID settings) sends everyone straight to Authentik when they open Audiobookshelf. To reach Audiobookshelf's own login page, add `/login?autoLaunch=0` to its address.
- **Password Authentication** can then be switched off, so the only way in is through Authentik. First check that the account you sign in with through Authentik is an Audiobookshelf admin (you can open **Settings**). If OpenID ever stops working with password login off, the only way back in is editing Audiobookshelf's database.

## 8. Sites without their own login (optional, with NPMplus)

For a site people open in a browser that has no login of its own, the [NPMplus app](../saltedlolly-npm-plus) can ask Authentik before letting anyone in ("forward auth"). NPMplus finds Authentik automatically; you choose which sites to protect and who may use each one. The steps are in the [NPMplus README](../saltedlolly-npm-plus/README.md#authentik-integration-optional) and on the Authentik card in the NPMplus launcher. Forward auth needs the embedded outpost's `authentik_host` from step 3; without it, visitors are sent to a sign-in address they can't reach.

Apps with their own OpenID login (step 7) don't need this.

## 9. Adding other users

For each person:

1. **In each app they'll use** that matches accounts by email (such as Audiobookshelf): create their user there, with their email address.
2. **In Authentik:** **Directory → Users → Create**, type **External** (they can sign in to apps, but not to Authentik's own dashboard), with the **same email address**. If you limited an app to a group (its **Bindings**), add them to that group.
3. **If they'll use Google:** add their Google address to the test users in the Google Cloud console. Don't set a password in Authentik.
4. **If they'll use a password:** set one for them (the user's **⋮ → Set password**). They'll be asked to add an authenticator app or passkey the first time they sign in.

Without outgoing email set up in Authentik, people can't reset their own password: you reset it for them.

External users who open Authentik itself (for example with **Go home** on an error page) see "Interface can only be reached by internal users". To send them somewhere useful instead, set a default application: **System → Brands → your brand → Edit → Default application**, for example Audiobookshelf.

## Troubleshooting

- **"No callback or already expired"** (Audiobookshelf): Audiobookshelf only allows 2 minutes from clicking its sign-in button to coming back from Authentik ([issue #5614](https://github.com/advplyr/audiobookshelf/issues/5614)). Open Audiobookshelf's address again and sign in again: you're usually still signed in to Authentik, so it goes straight through. With Auto Launch on, just reopening Audiobookshelf is enough.
- **"No session"** (Audiobookshelf): usually after pressing Back on an error page. Open Audiobookshelf's address again instead.
- **"Unauthorized"** (Audiobookshelf): the email isn't marked as verified. Check the provider uses the **Email (verified)** scope mapping, and that the person's email is the same in both apps.
- **`redirect_uri_no_match`** (Authentik): Audiobookshelf was opened on a different address from the redirect URIs (for example a local one), or **Subfolder for Redirect URLs** isn't None.
- **Passkey not offered:** passkeys only work on the address they were created on. Create them at `https://auth.yourdomain.com`, not on the Umbrel's local address.
- **A site protected with NPMplus forward auth shows "500 Internal Server Error":** Authentik isn't running or isn't reachable. The site stays closed until Authentik is back (on purpose).
- **Forward auth sends visitors to `umbrel.local`:** the embedded outpost's `authentik_host` still has the address you first opened Authentik on. Set it to your public address (step 3).
- **Password manager doesn't fill:** in private windows, browser extensions (such as 1Password) are off unless you allow them there.

## Updates and backups

Authentik has to be upgraded one release at a time (2026.5 → 2026.8 → …) and refuses to start if a release is skipped. umbrelOS always installs the newest version of an app, so this app catches up by itself: before starting, it runs each release you missed in turn (a few minutes each). You'll find a log in `data/upgrade/upgrade.log`.

Before every Authentik version change, it also backs up Authentik's database to `data/backups/` (the newest 3 are kept). Authentik can't be downgraded, so these backups are the only way back from a failed upgrade.

## How it works

- `server`: Authentik's web interface, login pages, API and built-in outpost (forward auth). Opened from the Umbrel dashboard through Umbrel's app proxy (port 9800), and published for your reverse proxy (such as NPMplus) on the Docker gateway only (`10.21.0.1:9810`).
- `worker`: background tasks. Unlike Authentik's own compose file, it doesn't run as root and has no Docker socket access (only needed to deploy extra outposts as containers).
- `postgresql`: PostgreSQL 16.
- `hooks/pre-start`: the database backup and release-by-release upgrade described above.
- Secrets (Authentik's secret key and the database password) are generated per Umbrel from its app entropy. The akadmin password is Umbrel's deterministic app password, and its email starts as `admin@umbrel.local`; both are only used on the very first start.

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
