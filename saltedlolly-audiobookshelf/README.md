<h1><a href="https://saltedlolly.com">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/saltedlolly/saltedlolly-wordmark-dark-bg.png">
  <img alt="saltedlolly" src="../assets/saltedlolly/saltedlolly-wordmark-light-bg.png" height="36" align="right">
</picture>
</a>
Audiobookshelf: NAS Edition for Umbrel</h1>

[Audiobookshelf](https://www.audiobookshelf.org/) is a self-hosted audiobook and podcast server, with apps for Android and iOS. This edition is made for libraries on a NAS: it works with the network shares you add in Umbrel's Files app, waits for them after a restart, and can import new books copied to them from another computer.

For everything about using Audiobookshelf itself (libraries, users, the mobile apps), see the [official Audiobookshelf documentation](https://www.audiobookshelf.org/docs). This page covers what's different in this edition.

## What's different from the standard app

- **Network shares**: every network share added in Umbrel's Files app is available to Audiobookshelf, at `/media/network/<NAS name>/<share>`.
- **Waits for your NAS**: mark the shares your libraries use as **required**, and Audiobookshelf only starts once they're available. After an Umbrel restart the NAS can take a while to be mounted; without this, Audiobookshelf could start with empty library folders.
- **Network shares page**: the app's own page, opened from the Umbrel dashboard, shows whether Audiobookshelf is running and the state of every network share, and has buttons to open and restart Audiobookshelf.
- **Automatic imports**: new books copied to a network share from another computer appear in Audiobookshelf by themselves (see [below](#automatic-imports-from-network-shares)).
- **Your own folders**: `Home/Audiobookshelf/Audiobooks` and `Home/Audiobookshelf/Podcasts` in Umbrel's Files app, for books and podcasts stored on the Umbrel itself.

## Moving from the standard Audiobookshelf app

This edition is a separate app from the Audiobookshelf app in the official Umbrel App Store, and its library data isn't shared with it. Back up your existing library before switching: you need to uninstall the standard app first, and uninstalling it deletes its user accounts, libraries and metadata (your audiobook and podcast files are kept). The [ABS Library Migration Tool](tools/README.md) can move your library across.

## Getting started

1. **Add your network shares** in Umbrel's **Files** app (Network, then add your NAS and its shares). Check you can browse them there.
2. **Open the app** from the Umbrel dashboard (or `https://umbrel.local:23378`). This opens the network shares page (the ABS Network Shares Config Tool).
3. **Mark the shares your libraries use as required** by ticking their boxes. Leave other shares unticked: Audiobookshelf can still use them, it just won't wait for them.
4. Click **Open Audiobookshelf** (or go to `http://umbrel.local:13378`) and create your admin account the first time.
5. **Add your libraries** in Audiobookshelf (Settings, then Libraries). Use these folder paths:

   | Where the books are | Folder path in Audiobookshelf |
   |---|---|
   | A network share | `/media/network/<NAS name>/<share>/...` (shown as **Path in Audiobookshelf** on the network shares page) |
   | `Home/Audiobookshelf/Audiobooks` on the Umbrel | `/audiobooks` |
   | `Home/Audiobookshelf/Podcasts` on the Umbrel | `/podcasts` |

6. **Optional:** switch on [automatic imports](#automatic-imports-from-network-shares) for libraries on network shares.

**Added a share later?** Audiobookshelf only sees network shares that were mounted when it started, so after adding a new share in the Files app, click **Restart Audiobookshelf** on the network shares page. The page reminds you when a restart is needed.

Bookmark the network shares page: it's the first place to look if Audiobookshelf doesn't start.

## The network shares page

The light at the top shows Audiobookshelf's state: green when it's running, orange while it starts or waits for required shares, red when it's stopped or not responding.

Each network share shows one of these:

| Status | Meaning |
|---|---|
| **Accessible** | The share is mounted and files on it can be read |
| **Checking...** | The share is being checked (normally only for a few seconds) |
| **Not Mounted** | Umbrel hasn't mounted the share: the NAS may be off or unreachable, or the share was removed in the Files app |
| **Not Accessible** | The share is mounted but no readable files were found on it |
| **Permission Denied** | The share is mounted but can't be read with the account it was added with in the Files app |

If a required share becomes unavailable while Audiobookshelf is running, the app checks again a few times over about two minutes, so a NAS that is briefly slow doesn't cause a restart. If the share is still missing, Audiobookshelf is stopped, and it starts again by itself once the share is back.

## Start-up time with large libraries on a NAS

With a large library on a network share, Audiobookshelf can take a long time to start: 10 to 20 minutes is possible with tens of thousands of files. While it starts, the app's status light is orange and Audiobookshelf doesn't answer yet. This is normal, and it happens after every restart, including app updates and Umbrel restarts.

**Why:** at start-up, Audiobookshelf's folder watcher sets up a watch on every folder in every library. On a network share that means asking the NAS about every folder and file over the network before Audiobookshelf can answer, and on a busy or slower NAS this adds up. The watcher is needed for [automatic imports](#automatic-imports-from-network-shares).

You can make Audiobookshelf start much faster by switching off its folder watcher (**Automatically watch libraries for changes** in Audiobookshelf's settings), but then new books on network shares only appear after you scan the library, and automatic imports stop working.

## Automatic imports from network shares

### Why it's needed

Audiobookshelf can watch its library folders and add new books by itself, but on Umbrel that only works for folders on the Umbrel itself. When you copy a book to a network share from another computer (for example from your laptop to your NAS), the change happens on the NAS, so the Umbrel is never told about it. Without this feature, new books only appear after you scan the library, which can take a long time with a large library on a NAS.

### What it does

When it's switched on, this app asks your NAS to report changes in your Audiobookshelf library folders, and passes each change straight to Audiobookshelf. Audiobookshelf then scans just the books involved, not the whole library. A newly copied book normally appears a few seconds after the copy finishes. If you copy many books one after another, Audiobookshelf waits until files stop changing and works through them in order.

Libraries on the Umbrel's own storage (such as `Home/Audiobookshelf/Audiobooks`) don't need this: Audiobookshelf's own folder watcher already handles them.

### Setting it up

1. In Audiobookshelf, go to **Settings > API Keys > Add API Key**. Choose an administrator as the user, make sure the key is switched on (active), and copy the key.
2. Open this app from the Umbrel dashboard. In **Automatic imports from network shares**, paste the key and click **Save key**. The page checks the key with Audiobookshelf straight away.
3. Switch **Automatic imports** on.

Keep Audiobookshelf's own folder watcher switched on: **Automatically watch libraries for changes** in Audiobookshelf's settings, and **Automatically watch library for changes** in each library's settings. This app hands changes to Audiobookshelf through it, and the page warns you if it's switched off.

The API key is stored with this app's settings, readable only by the app, and included in Umbrel backups. It isn't shown again after saving; use **Replace** or **Remove** to change it. If the key stops working (for example it was deleted or expired in Audiobookshelf), the page tells you.

### Which changes your NAS reports

Not every NAS reports every kind of change. Some report everything; others, for example, report new files but not a book folder that was renamed or deleted from another computer. This app learns what your NAS reports from the changes you make, and shows it in **Your NAS** on the page, and as a badge on each network share:

| Badge | Meaning |
|---|---|
| ✓ All changes | Your NAS has been seen reporting every kind of change |
| *n* of 4 | Your NAS reports some kinds of change; the nightly light check (below) finds the rest |
| Learning | Not enough changes seen yet to tell |

The four kinds of change are new books and files, changed files (for example edited tags), renamed or moved books, and deleted books. The learning happens per NAS, so if you have shares on more than one NAS, each one gets its own entry.

### The nightly light check

To catch changes a NAS doesn't report, a light check runs once a night at the **Nightly check time** (04:00 by default). It lists only the folders above your books and compares them with Audiobookshelf's library, so it finds books that were renamed, moved, added or deleted. It never opens the files inside your books, so it's much lighter than a library scan and usually finishes within a few minutes. Many NAS models keep folder listings in memory or on an SSD cache, so it often doesn't need to spin up the hard drives.

**Light check** can be set to:

- **Automatic (recommended)**: every night until your NAS has been seen reporting renamed and deleted books itself, then once a week as a safety net
- **Every night** or **Once a week**
- **Off**: renamed or deleted books are then only picked up when you scan the library

**Check now** runs it straight away for one NAS. A scheduled library scan in Audiobookshelf isn't needed while automatic imports are on.

### When the app wasn't running

Changes made while this app isn't running (for example while the Umbrel is off, restarting or updating) can't be noticed afterwards. When the app starts again it schedules a catch-up for the nightly check time: a light check after a short break (under an hour, such as an app update), or a full scan of the libraries on network shares after a longer one, because more could have changed. The page shows what's scheduled, with **Scan now** and **Skip**.

### Things to know

- **Changed files**: if your NAS doesn't report changed files (for example a replaced audio file or cover image), the light check can't see that either, because it doesn't look inside books. A library scan in Audiobookshelf picks those up. Edited book details such as title or author in the tags of a book Audiobookshelf already has are a different matter: Audiobookshelf keeps its own saved details for that book, so neither automatic imports nor a scan apply them. Deleting the book from the Audiobookshelf library (not the audio files themselves) and rescanning the library is, at the time of writing, the only way to update the library listing with new embedded metadata from an audiobook. Deleting it also removes its listening progress and any changes made to it in Audiobookshelf. New files, such as a cover image added to a book folder, are picked up like any new file.
- **Renamed books on some NAS models**: Audiobookshelf recognises a renamed or moved book by its file IDs. Some NAS models don't give files permanent IDs, and on those Audiobookshelf treats a renamed or moved book folder as a new book and marks the old entry as missing (this happens with a library scan too, not just with automatic imports). Listening progress stays with the old entry. You can remove missing books from the library's **Issues** list.
- Automatic imports only watch Audiobookshelf libraries whose folders are on network shares added in Umbrel's Files app.

## Troubleshooting

**Audiobookshelf doesn't start.** Open the network shares page. If it says it's waiting for required shares, it shows which ones aren't available: check them in Umbrel's Files app, or untick a share Audiobookshelf doesn't need. If the light is orange and no shares are missing, Audiobookshelf is still starting; with a large library on a NAS this can take a while (see [Start-up time](#start-up-time-with-large-libraries-on-a-nas)), and the page shows how long it usually takes.

**A share shows Not Mounted, Not Accessible or Permission Denied.** Make sure the NAS is switched on and reachable, and that you can browse the share in Umbrel's Files app. For Permission Denied, check that the account used for the share in the Files app can read it on the NAS.

**Audiobookshelf can't see my books.** If the share was added in the Files app after Audiobookshelf started, click **Restart Audiobookshelf** on the network shares page. Otherwise check the library's folder path: network shares are under `/media/network/<NAS name>/<share>`, and the Umbrel's own folders are `/audiobooks` and `/podcasts`. The network shares page shows each share's **Path in Audiobookshelf**.

**Automatic imports don't work.** The status line in **Automatic imports from network shares** says what's wrong:

- **Audiobookshelf rejected the API key**: the key was deleted, deactivated or has expired, or was never switched on. Create a new active key and click **Replace**
- **The API key belongs to a user who isn't an administrator**: create the key on an administrator account
- **Audiobookshelf isn't answering yet**: Audiobookshelf can take several minutes to start with large libraries on a NAS. Changes are kept and sent when it's ready
- **A warning that the folder watcher is switched off**: switch it back on in Audiobookshelf (see [Setting it up](#setting-it-up))
- **A red dot next to a watched folder**: the share can't be reached right now. Check it in Umbrel's Files app; watching resumes by itself when the share is back

**Still stuck?** Use **🐛 Report Issue** at the bottom of the network shares page. It opens a GitHub issue with the app version filled in.

## Your data and backups

- **Audiobookshelf's settings, users, listening progress and covers** are kept with the app's data on the Umbrel. They are included in Umbrel backups and removed if you uninstall the app.
- **`Home/Audiobookshelf/Audiobooks` and `Podcasts`** are ordinary folders in Umbrel's Files app. They are kept if you uninstall the app.
- **Your network shares** stay on your NAS. Audiobookshelf can write to them (some of its tools save files into book folders), so keep your NAS backed up as usual.

## Updates

Install updates from the Umbrel App Store. The network shares page shows **Update available** when a newer version is out. An update restarts Audiobookshelf, so it takes as long as a normal start.

## How it works

The app runs a few small services alongside Audiobookshelf:

- **Network shares page**: the page described above
- **Share checker**: checks that the required shares are mounted and readable, at start-up and every 15 minutes
- **Manager**: starts Audiobookshelf once the share checker reports the required shares are ready, and stops it if one goes missing
- **Share watcher**: passes changes on network shares to Audiobookshelf for [automatic imports](#automatic-imports-from-network-shares)
- **Docker proxy**: gives the manager limited access to Docker so it can start and stop Audiobookshelf, on a private network the other apps on your Umbrel can't reach

The source code is in this folder on GitHub.

## Credits

- [Audiobookshelf](https://github.com/advplyr/audiobookshelf) by advplyr and contributors
- NAS Edition by Olly Stedall ([saltedlolly](https://saltedlolly.com))

This project follows the same licence as Audiobookshelf.

## Support

For problems with this edition (network shares, the network shares page, automatic imports), use **🐛 Report Issue** on the network shares page, or open an issue at [saltedlolly/umbrel-app-store](https://github.com/saltedlolly/umbrel-app-store/issues). Please remove private details such as your domain or IP addresses from anything you paste.

For Audiobookshelf itself, see the [official documentation](https://www.audiobookshelf.org/docs) and the [Audiobookshelf Discord](https://discord.gg/pJsjuNCKRq).
