#!/usr/bin/env python3
"""abs-share-watcher: tells Audiobookshelf about changes on network shares.

Audiobookshelf's own folder watcher uses Linux inotify, which only sees changes
made on the Umbrel itself. Books added to a NAS from another computer are never
noticed. This helper asks the NAS for SMB change notifications on each library
folder (the kernel's CIFS_IOC_NOTIFY_INFO request, one per folder tree, no
folder walk) and passes each change to Audiobookshelf's external watcher API
(POST /api/watcher/update), which then scans only the book folders involved.

Some NAS models don't report every kind of change. A Drobo 5N, for example,
reports new files at any depth but not a book folder renamed or deleted from a
Mac. So a light check (listing only the folders above the books, never the
files inside them) runs in a nightly window and catches what wasn't reported.
The helper learns, per NAS, which kinds of change are reported, and runs the
light check less often once renames and deletions are known to be reported.

Files in DATA_DIR:
  settings.json  written by the config tool: {"enabled", "catchupTime" (nightly window, HH:MM),
                 "lightCheck": "auto" | "daily" | "weekly" | "off"}
  api-key        written by the config tool (mode 600): an Audiobookshelf API key
  command.json   written by the config tool: {"action": "run" | "skip" | "lightcheck", "host"?}
  status.json    written here, read by the config tool
  state.json     written here: libraries, gaps, scheduled scans, light check history, NAS evidence
"""

import datetime
import fcntl
import json
import os
import queue
import struct
import threading
import time
import urllib.error
import urllib.request

DATA_DIR = os.environ.get("WATCHER_DIR", "/data/share-watcher")
ABS_URL = os.environ.get("ABS_URL", "http://saltedlolly-audiobookshelf_abs-server_1:80").rstrip("/")
NETWORK_ROOT = os.environ.get("NETWORK_ROOT", "/media/network")
LIGHT_CHECK_RATE = float(os.environ.get("LIGHT_CHECK_RATE", "5"))   # folders listed per second

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
KEY_FILE = os.path.join(DATA_DIR, "api-key")
COMMAND_FILE = os.path.join(DATA_DIR, "command.json")
STATUS_FILE = os.path.join(DATA_DIR, "status.json")
STATE_FILE = os.path.join(DATA_DIR, "state.json")

TICK = 2                   # seconds between main-loop passes
KEY_CHECK_EVERY = 300      # check the API key every 5 minutes
LIBRARIES_EVERY = 600      # refresh libraries and folders every 10 minutes
ITEMS_EVERY = 3600         # refresh the list of known book folders every hour (and before each light check)
ITEMS_PAGE = 500           # books per request, with a short pause between pages, so Audiobookshelf stays responsive
GAP_SECONDS = 120          # not watching for longer than this means changes may have been missed
LONG_GAP_SECONDS = 3600    # a gap this long gets a full scan; a shorter one only a light check
RETRY_SECONDS = 15         # wait before reopening a folder whose watch failed
CONFIRM_AFTER = 3          # this many reported changes of a kind (since the last miss) confirm it
WEEKLY_DAYS = 6.5          # a "weekly" light check runs when the last one is older than this
RECENT_SCAN_HOURS = 24     # no light check if a full scan of the library ran this recently

# struct smb3_notify_info { __u32 completion_filter; bool watch_tree; __u32 data_len; __u8 notify_data[]; } __packed
# CIFS_IOC_NOTIFY_INFO = _IOWR(0xCF, 11, struct smb3_notify_info): direction 3, size 9 (fs/smb/client/cifs_ioctl.h)
CIFS_IOC_NOTIFY_INFO = (3 << 30) | (9 << 16) | (0xCF << 8) | 11
NOTIFY_FILTER = 0x1 | 0x2 | 0x10   # FILE_NOTIFY_CHANGE_FILE_NAME | DIR_NAME | LAST_WRITE
NOTIFY_BUFFER = 64 * 1024
ADDED, REMOVED, MODIFIED, RENAMED_OLD, RENAMED_NEW = 1, 2, 3, 4, 5

# The four kinds of change the page reports on, per NAS
KINDS = ("new", "changed", "renamed", "deleted")

# Files Audiobookshelf imports (used to tell a book folder from other folders)
MEDIA_EXTENSIONS = {
    ".mp3", ".m4b", ".m4a", ".mp4", ".aac", ".flac", ".opus", ".ogg", ".oga", ".wma", ".aiff", ".aif", ".wav",
    ".webm", ".webma", ".mka", ".awb", ".caf", ".epub", ".pdf", ".mobi", ".azw3", ".cbr", ".cbz",
}


def log(msg):
    print(f"{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def iso_to_ts(iso):
    try:
        return datetime.datetime.fromisoformat(iso).timestamp()
    except (TypeError, ValueError):
        return 0


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    # Temporary file + rename, so the config tool never reads a half-written file
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def is_hidden(rel):
    # Dotfiles and folders (.DS_Store, ._AppleDouble, .Trashes) are ignored by Audiobookshelf too
    return any(part.startswith(".") for part in rel.split("/"))


def is_media(name):
    return os.path.splitext(name)[1].lower() in MEDIA_EXTENSIONS


def host_of(path):
    """The NAS a path is on: the first folder under the network root, e.g. "Drobo5N.local"."""
    rest = path[len(NETWORK_ROOT) + 1:] if path.startswith(NETWORK_ROOT + "/") else ""
    return rest.split("/", 1)[0] or None


def parse_notify(buf, length):
    """Parse FILE_NOTIFY_INFORMATION records into (action, relative path) pairs."""
    events, off = [], 0
    while length and off + 12 <= length:
        nxt, action, name_len = struct.unpack_from("<III", buf, off)
        name = bytes(buf[off + 12: off + 12 + name_len]).decode("utf-16-le", "replace")
        events.append((action, name.replace("\\", "/")))
        if not nxt:
            break
        off += nxt
    return events


def capability(ev):
    """'reported' / 'not-reported' / 'unknown' from a kind's evidence."""
    if ev.get("missed") and ev.get("sinceMiss", 0) < CONFIRM_AFTER:
        return "not-reported"
    if ev.get("reported", 0) >= CONFIRM_AFTER:
        return "reported"
    return "unknown"


def light_check_diff(dirs, known, listdir, isdir):
    """Compare a light check's folder listings with Audiobookshelf's books.

    dirs: the folders above the books (each library folder down to each book's parent)
    known: {book path: isFile} for the books Audiobookshelf has (not missing ones)
    listdir(path) -> names, or None if the folder can't be listed
    Returns (missing books, unknown entries): entries found in those folders that
    are neither a known book nor one of the listed folders.
    """
    by_parent = {}
    for b in known:
        by_parent.setdefault(os.path.dirname(b), []).append(b)
    missing, unknown = [], []
    for d in dirs:
        names = listdir(d)
        if names is None:
            continue
        present = set(names)
        for b in by_parent.get(d, []):
            if os.path.basename(b) not in present:
                missing.append(b)
        for n in names:
            if n.startswith("."):
                continue
            p = f"{d}/{n}"
            if p in known or p in dirs:
                continue
            if isdir(p) or is_media(n):
                unknown.append(p)
    return missing, unknown


class FolderWatch(threading.Thread):
    """Blocks on SMB change notifications for one library folder and queues what it hears."""

    def __init__(self, folder, events):
        super().__init__(daemon=True)
        self.folder = folder
        self.events = events
        self.stopped = False
        self.ok = False
        self.error = None
        self.down_since = None       # set when a working watch fails
        self.recovered_after = 0     # seconds it was down, set when it works again

    def run(self):
        while not self.stopped:
            try:
                fd = os.open(self.folder, os.O_RDONLY)
            except OSError as e:
                self._failed(e)
                continue
            try:
                while not self.stopped:
                    buf = bytearray(struct.pack("<I?I", NOTIFY_FILTER, True, NOTIFY_BUFFER)) + bytearray(NOTIFY_BUFFER)
                    self._watching()
                    fcntl.ioctl(fd, CIFS_IOC_NOTIFY_INFO, buf, True)
                    if self.stopped:
                        break
                    length = struct.unpack_from("<I", buf, 5)[0]
                    if length == 0:
                        # The NAS had too many changes to list (STATUS_NOTIFY_ENUM_DIR)
                        self.events.put((self.folder, None, None))
                    for action, rel in parse_notify(buf[9:], length):
                        self.events.put((self.folder, action, rel))
            except OSError as e:
                self._failed(e)
            finally:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def _watching(self):
        if not self.ok:
            log(f"Watching {self.folder}")
            if self.down_since:
                self.recovered_after = time.time() - self.down_since
                self.down_since = None
        self.ok, self.error = True, None

    def _failed(self, e):
        if self.ok or self.error != str(e):
            log(f"Watch failed for {self.folder}: {e}; retrying every {RETRY_SECONDS}s")
        if self.ok:
            self.down_since = time.time()
        self.ok, self.error = False, str(e)
        time.sleep(RETRY_SECONDS)


class Abs:
    """Minimal Audiobookshelf API client."""

    def __init__(self, key):
        self.key = key

    def call(self, method, path, body=None, timeout=15):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(ABS_URL + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode()
            return json.loads(text) if text[:1] in ("{", "[") else text


class Watcher:
    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self.lock = threading.RLock()   # state, pending and items are shared with the light check thread
        self.events = queue.Queue()
        self.watches = {}               # folder path -> FolderWatch
        self.pending = []               # hook bodies not yet delivered
        self.state = read_json(STATE_FILE, {})
        for k, v in (("lightChecks", {}), ("nas", {}), ("lastFullScan", {}), ("seenUnknown", {})):
            self.state.setdefault(k, v)
        # Last known libraries, so watching starts before Audiobookshelf answers
        self.libraries = self.state.get("libraries", [])
        self.folder_library = {f: lib for lib in self.libraries for f in lib["nasFolders"]}   # folder -> library
        self.items = {}                 # library id -> {book path: isFile}, books not marked missing
        self.startup_checked = False
        self.catchup_time = None
        self.key = None
        self.key_mtime = None
        self.key_status = ("no-key", "No Audiobookshelf API key saved yet")
        self.username = None
        self.server_watcher_disabled = False
        self.last_key_check = self.last_libraries = self.last_items = 0
        self.last_change = None
        self.last_report = None
        self.reported_total = 0
        self.was_enabled = None
        self.light_thread = None
        self.light_running = None       # host being checked, for the status
        self.recent_evidence = {}       # (host, kind, path) -> time, to count each change once
        self.items_thread = None

    def save_state(self):
        with self.lock:
            write_json(STATE_FILE, self.state)

    # ---- settings and Audiobookshelf -------------------------------------

    def settings(self):
        s = read_json(SETTINGS_FILE, {})
        mode = s.get("lightCheck") if s.get("lightCheck") in ("auto", "daily", "weekly", "off") else "auto"
        return {"enabled": bool(s.get("enabled")), "catchupTime": s.get("catchupTime") or "04:00", "lightCheck": mode}

    def load_key(self):
        try:
            mtime = os.stat(KEY_FILE).st_mtime
        except OSError:
            self.key = self.key_mtime = None
            self.key_status = ("no-key", "No Audiobookshelf API key saved yet")
            return
        if mtime != self.key_mtime:
            with open(KEY_FILE) as f:
                self.key = f.read().strip()
            self.key_mtime = mtime
            self.last_key_check = self.last_libraries = self.last_items = 0   # check the new key now

    def check_key(self):
        """Ask Audiobookshelf who the key belongs to. Returns True if it can be used."""
        try:
            me = Abs(self.key).call("GET", "/api/me")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                self.key_status = ("key-rejected", "Audiobookshelf rejected the API key (it may have been deleted, "
                                   "deactivated or expired, or never switched on). Create a new active key in "
                                   "Audiobookshelf and save it here.")
            else:
                self.key_status = ("abs-unavailable", f"Audiobookshelf answered with an error ({e.code})")
            return False
        except (OSError, ValueError):
            self.key_status = ("abs-unavailable", "Audiobookshelf isn't answering yet (it can take several minutes to "
                               "start with large libraries). Changes are kept and sent when it's ready.")
            return False
        self.username = me.get("username")
        if me.get("type") not in ("admin", "root"):
            self.key_status = ("not-admin", f"The API key belongs to \"{self.username}\", who isn't an Audiobookshelf "
                               "administrator. Create the key on an administrator account.")
            return False
        self.key_status = ("ok", f"Connected to Audiobookshelf as \"{self.username}\"")
        try:
            auth = Abs(self.key).call("POST", "/api/authorize")
            self.server_watcher_disabled = bool((auth.get("serverSettings") or {}).get("scannerDisableWatcher"))
        except (OSError, ValueError):
            pass
        return True

    def refresh_libraries(self):
        data = Abs(self.key).call("GET", "/api/libraries")
        libs = []
        for lib in data.get("libraries", []):
            folders = [f["fullPath"].rstrip("/") for f in lib.get("folders", [])]
            libs.append({"id": lib["id"], "name": lib["name"], "mediaType": lib.get("mediaType"),
                         "folders": folders,
                         "nasFolders": [f for f in folders if f.startswith(NETWORK_ROOT + "/")],
                         "watcherDisabled": bool((lib.get("settings") or {}).get("disableWatcher"))})
        with self.lock:
            self.libraries = libs
            self.folder_library = {f: lib for lib in libs for f in lib["nasFolders"]}
            self.state["libraries"] = libs
        self.save_state()

    def refresh_items(self):
        """Read Audiobookshelf's books on network shares, a page at a time (a whole large
        library in one request kept Audiobookshelf busy for several seconds)."""
        items = {}
        for lib in self.libraries:
            if not lib["nasFolders"]:
                continue
            books, page = {}, 0
            while True:
                data = Abs(self.key).call(
                    "GET", f"/api/libraries/{lib['id']}/items?minified=1&limit={ITEMS_PAGE}&page={page}", timeout=60)
                results = data.get("results", [])
                for i in results:
                    if not i.get("isMissing"):
                        books[i["path"].rstrip("/")] = bool(i.get("isFile"))
                page += 1
                if len(results) < ITEMS_PAGE or page * ITEMS_PAGE >= (data.get("total") or 0):
                    break
                time.sleep(0.5)
            items[lib["id"]] = books
        with self.lock:
            self.items = items

    def refresh_items_in_background(self):
        if self.items_thread and self.items_thread.is_alive():
            return

        def run():
            try:
                self.refresh_items()
            except (OSError, ValueError) as e:
                log(f"Couldn't read Audiobookshelf's book list: {e}; will try again")
                self.last_items = time.time() - ITEMS_EVERY + 300   # retry in 5 minutes

        self.items_thread = threading.Thread(target=run, daemon=True)
        self.items_thread.start()

    def scan_running(self, lib_id):
        """True if Audiobookshelf is running a full scan of this library (or can't say)."""
        try:
            tasks = Abs(self.key).call("GET", "/api/tasks").get("tasks", [])
        except (OSError, ValueError):
            return True
        return any(t.get("action") == "library-scan" and not t.get("isFinished")
                   and (t.get("data") or {}).get("libraryId") == lib_id for t in tasks)

    # ---- evidence: which kinds of change each NAS reports -----------------

    def evidence(self, host, kind, outcome, path=""):
        """Record that the NAS reported (outcome='reported') or missed ('missed') a change."""
        if not host:
            return
        with self.lock:
            if outcome == "reported":
                key = (host, kind, path)
                if time.time() - self.recent_evidence.get(key, 0) < 600:
                    return   # the same change, reported again
                self.recent_evidence = {k: t for k, t in self.recent_evidence.items() if time.time() - t < 600}
                self.recent_evidence[key] = time.time()
            ev = self.state["nas"].setdefault(host, {}).setdefault(kind, {"reported": 0, "missed": 0, "sinceMiss": 0})
            if outcome == "reported":
                ev["reported"] += 1
                ev["sinceMiss"] += 1
                ev["lastReported"] = now_iso()
            else:
                ev["missed"] += 1
                ev["sinceMiss"] = 0
                ev["lastMissed"] = now_iso()
        self.save_state()

    def notification_evidence(self, lib, folder, action, rel):
        host = host_of(folder)
        path = f"{folder}/{rel}"
        top = rel.split("/")
        # Count each book folder once: the change is attributed to its first two levels
        key = "/".join(top[:2])
        if action == RENAMED_OLD:
            self.evidence(host, "renamed", "reported", key)
        elif action == REMOVED and not os.path.splitext(rel)[1]:
            self.evidence(host, "deleted", "reported", key)
        elif action == ADDED and (os.path.isdir(path) or is_media(rel)):
            self.evidence(host, "new", "reported", key)
        elif action == MODIFIED and (is_media(rel) or os.path.isdir(path)):
            # A changed file, or a folder reported as changed (a Drobo reports the author folder when
            # Finder replaces a file), in or around a book Audiobookshelf already has
            books = self.items.get(lib["id"], {})
            if any(path == b or path.startswith(b + "/") or b.startswith(path + "/") for b in books):
                self.evidence(host, "changed", "reported", key)

    # ---- watching ---------------------------------------------------------

    def sync_watches(self, enabled):
        wanted = set(self.folder_library) if enabled else set()
        for folder in list(self.watches):
            if folder not in wanted:
                self.watches.pop(folder).stopped = True   # its next notification is dropped
                log(f"Stopped watching {folder}")
        for folder in wanted:
            if folder not in self.watches:
                w = FolderWatch(folder, self.events)
                self.watches[folder] = w
                w.start()

    def changes_for(self, lib, folder, action, rel):
        """Turn one notification into Audiobookshelf hook calls (see planning notes for the rules)."""
        if is_hidden(rel):
            return []
        path = f"{folder}/{rel}"
        if action in (ADDED, MODIFIED, RENAMED_NEW):
            return [("add", p) for p in self.files_under(path)]
        if action in (REMOVED, RENAMED_OLD):
            return self.removal_calls(lib, path)
        return []

    def files_under(self, path):
        """A file, or every file in a folder (the NAS doesn't reliably list a new folder's files)."""
        if os.path.isdir(path):
            out = []
            for root, dirs, files in os.walk(path):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                out += [os.path.join(root, f) for f in files if not f.startswith(".")]
            return out
        return [path] if os.path.isfile(path) else []

    def removal_calls(self, lib, path):
        books = self.items.get(lib["id"], {})
        under = [b for b in books if b == path or b.startswith(path + "/")]
        if under:
            # A made-up file name inside the book folder is enough for Audiobookshelf to
            # notice the folder is gone and mark the book missing
            return [("unlink", b if books[b] else f"{b}/removed.mp3") for b in under]
        if os.path.splitext(path)[1]:
            return [("unlink", path)]   # a single file removed from a book
        return [("unlink", f"{path}/removed.mp3")]   # possibly a book added since the book list was read

    def queue_calls(self, lib, calls):
        with self.lock:
            seen = {(b["libraryId"], b["path"], b["type"]) for b in self.pending}
            for kind, path in calls:
                k = (lib["id"], path, kind)
                if k not in seen:
                    seen.add(k)
                    self.pending.append({"libraryId": lib["id"], "path": path, "type": kind})

    def drain_events(self):
        while True:
            try:
                folder, action, rel = self.events.get_nowait()
            except queue.Empty:
                break
            w = self.watches.get(folder)
            lib = self.folder_library.get(folder)
            if not w or w.stopped or not lib:
                continue
            if action is None:
                log(f"{folder}: too many changes at once for the NAS to list; a full scan of "
                    f"\"{lib['name']}\" is scheduled")
                self.schedule_full_scan([lib["id"]], "the NAS reported too many changes at once")
                continue
            if is_hidden(rel):
                continue
            self.last_change = {"at": now_iso(), "path": f"{folder}/{rel}"}
            self.notification_evidence(lib, folder, action, rel)
            self.queue_calls(lib, self.changes_for(lib, folder, action, rel))

    def deliver(self):
        sent = 0
        while True:
            with self.lock:
                if not self.pending:
                    break
                body = self.pending[0]
            try:
                Abs(self.key).call("POST", "/api/watcher/update", body, timeout=10)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    self.last_key_check = 0   # re-check the key on the next pass
                    break
                log(f"Audiobookshelf refused {body['type']} {body['path']} ({e.code}); dropped")
            except (OSError, ValueError):
                break   # Audiobookshelf not answering; keep the changes for later
            with self.lock:
                if self.pending and self.pending[0] is body:
                    self.pending.pop(0)
            sent += 1
        if sent:
            self.reported_total += sent
            self.last_report = {"at": now_iso(), "count": sent}
            log(f"Reported {sent} change(s) to Audiobookshelf")

    # ---- gaps, full scans and the nightly window --------------------------

    def next_run(self, hhmm, after=None):
        try:
            h, m = (int(x) for x in hhmm.split(":"))
        except ValueError:
            h, m = 4, 0
        now = after or datetime.datetime.now()
        at = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if at <= now:
            at += datetime.timedelta(days=1)
        return at

    def schedule_full_scan(self, library_ids, reason):
        with self.lock:
            c = self.state.get("catchup") or {"libraries": [], "reasons": []}
            c["libraries"] = sorted(set(c["libraries"]) | set(library_ids))
            if reason not in c["reasons"]:
                c["reasons"].append(reason)
            c["at"] = self.next_run(self.settings()["catchupTime"]).isoformat(timespec="minutes")
            self.state["catchup"] = c
        self.save_state()

    def force_light_check(self, library_ids):
        with self.lock:
            forced = set(self.state.get("forceLightCheck", [])) | set(library_ids)
            self.state["forceLightCheck"] = sorted(forced)
        self.save_state()

    def gap(self, library_ids, seconds, reason):
        """Changes made during a gap can't be noticed afterwards: a short gap gets a light check
        in the nightly window, a long one a full scan."""
        if not library_ids:
            return
        if seconds >= LONG_GAP_SECONDS:
            self.schedule_full_scan(library_ids, reason)
        else:
            self.force_light_check(library_ids)
        with self.lock:
            for lib_id in library_ids:
                self.state["lightChecks"].setdefault(lib_id, {})["gapSince"] = now_iso()
        self.save_state()

    def check_gaps(self, enabled):
        if not enabled or not self.watches:
            return
        now = time.time()
        nas_ids = [lib["id"] for lib in self.libraries if lib["nasFolders"]]
        if any(w.ok for w in self.watches.values()):
            if not self.startup_checked:
                self.startup_checked = True
                last = self.state.get("lastWatching")
                if last and now - last > GAP_SECONDS:
                    self.gap(nas_ids, now - last, "changes may have been missed while the app wasn't running")
            with self.lock:
                self.state["lastWatching"] = now
            self.save_state()
        for w in self.watches.values():
            if w.recovered_after > GAP_SECONDS:
                lib = self.folder_library.get(w.folder)
                if lib:
                    self.gap([lib["id"]], w.recovered_after, f"the share for \"{lib['name']}\" was unavailable for a while")
            w.recovered_after = 0

        # A new nightly time moves an already scheduled full scan
        t = self.settings()["catchupTime"]
        if self.catchup_time and t != self.catchup_time and self.state.get("catchup"):
            with self.lock:
                self.state["catchup"]["at"] = self.next_run(t).isoformat(timespec="minutes")
            self.save_state()
        self.catchup_time = t

    def run_full_scans_if_due(self, cmd):
        c = self.state.get("catchup")
        if not c:
            return
        if cmd and cmd.get("action") == "skip":
            log("Full scan skipped by the user")
            with self.lock:
                self.state.pop("catchup", None)
            self.save_state()
            return
        due = (cmd and cmd.get("action") == "run") or time.time() >= iso_to_ts(c.get("at"))
        if not due:
            return
        remaining, started = [], []
        for lib_id in c["libraries"]:
            lib = next((l for l in self.libraries if l["id"] == lib_id), None)
            if not lib:
                continue
            if self.scan_running(lib_id):
                remaining.append(lib_id)   # wait for Audiobookshelf's own scan to finish
                continue
            try:
                Abs(self.key).call("POST", f"/api/libraries/{lib_id}/scan", timeout=10)
            except (OSError, ValueError) as e:
                log(f"Couldn't start the full scan of \"{lib['name']}\": {e}; will try again")
                remaining.append(lib_id)
                continue
            started.append(lib["name"])
            with self.lock:
                self.state["lastFullScan"][lib_id] = now_iso()
                lc = self.state["lightChecks"].setdefault(lib_id, {})
                lc.pop("gapSince", None)   # the scan covers whatever the gap hid
        if started:
            log(f"Started full scan of: {', '.join(started)}")
        with self.lock:
            if remaining:
                c["libraries"] = remaining
            else:
                self.state["lastCatchup"] = {"at": now_iso(), "libraries": started}
                self.state.pop("catchup", None)
        self.last_items = 0
        self.save_state()

    def effective_mode(self, host):
        """How often the light check runs for a NAS: what the user chose, or worked out from what it reports."""
        mode = self.settings()["lightCheck"]
        if mode != "auto":
            return mode
        nas = self.state["nas"].get(host, {})
        if all(capability(nas.get(k, {})) == "reported" for k in ("new", "renamed", "deleted")):
            return "weekly"
        return "daily"

    def light_check_due(self, lib):
        """Should the nightly window run a light check of this library?"""
        lc = self.state["lightChecks"].get(lib["id"], {})
        if lib["id"] in self.state.get("forceLightCheck", []):
            return True
        if time.time() - iso_to_ts(self.state["lastFullScan"].get(lib["id"])) < RECENT_SCAN_HOURS * 3600:
            return False
        hosts = {host_of(f) for f in lib["nasFolders"]}
        modes = {self.effective_mode(h) for h in hosts}
        if modes <= {"off"}:
            return False
        last = iso_to_ts(lc.get("lastRun"))
        if "daily" in modes:
            return time.time() - last > 20 * 3600
        return time.time() - last > WEEKLY_DAYS * 86400

    def nightly_window(self, cmd):
        """Once a night, at the chosen time: start due light checks (one thread, one library at a time)."""
        if self.light_thread and self.light_thread.is_alive():
            return
        manual_host = cmd.get("host") if cmd and cmd.get("action") == "lightcheck" else None
        if cmd and cmd.get("action") == "lightcheck":
            libs = [l for l in self.libraries if l["nasFolders"] and
                    (not manual_host or manual_host in {host_of(f) for f in l["nasFolders"]})]
        else:
            window = self.next_run(self.settings()["catchupTime"],
                                   after=datetime.datetime.now() - datetime.timedelta(days=1))
            if "lastWindow" not in self.state:
                # First start: wait for the next nightly window rather than checking straight away
                with self.lock:
                    self.state["lastWindow"] = window.isoformat(timespec="minutes")
                self.save_state()
                return
            if datetime.datetime.now() < window or self.state.get("lastWindow") == window.isoformat(timespec="minutes"):
                return
            with self.lock:
                self.state["lastWindow"] = window.isoformat(timespec="minutes")
            self.save_state()
            libs = [l for l in self.libraries if l["nasFolders"] and self.light_check_due(l)]
        if not libs:
            return
        self.light_thread = threading.Thread(target=self.light_check, args=(libs,), daemon=True)
        self.light_thread.start()

    def light_check(self, libs):
        for lib in libs:
            try:
                self.light_check_library(lib)
            except Exception as e:
                log(f"Light check of \"{lib['name']}\" failed: {e}")
        self.light_running = None

    def light_check_library(self, lib):
        hosts = sorted({host_of(f) for f in lib["nasFolders"]})
        self.light_running = ", ".join(hosts)
        started = time.time()
        log(f"Light check of \"{lib['name']}\" started")
        try:
            self.refresh_items()
        except (OSError, ValueError) as e:
            log(f"Light check of \"{lib['name']}\" postponed: Audiobookshelf's book list isn't available ({e})")
            return
        with self.lock:
            known = dict(self.items.get(lib["id"], {}))
            lc = self.state["lightChecks"].setdefault(lib["id"], {})
            clean = bool(lc.get("lastRun")) and not lc.get("gapSince")
        dirs = set()
        for root in lib["nasFolders"]:
            dirs.add(root)
            for b in known:
                if b.startswith(root + "/"):
                    p = os.path.dirname(b)
                    while len(p) > len(root):
                        dirs.add(p)
                        p = os.path.dirname(p)
        delay = 1 / LIGHT_CHECK_RATE if LIGHT_CHECK_RATE > 0 else 0
        failed_roots = []

        def listdir(d):
            time.sleep(delay)
            try:
                return os.listdir(d)
            except OSError:
                if d in lib["nasFolders"]:
                    failed_roots.append(d)
                return None

        missing, unknown = light_check_diff(dirs, known, listdir, os.path.isdir)
        if failed_roots:
            log(f"Light check of \"{lib['name']}\" stopped: can't read {', '.join(failed_roots)}")
            return

        # Unknown folders already reported before, and unchanged since, aren't reported again
        # (for example a folder of extras that Audiobookshelf doesn't import)
        new_found = []
        calls = []
        with self.lock:
            seen = self.state["seenUnknown"]
        for p in unknown:
            try:
                mtime = os.stat(p).st_mtime
            except OSError:
                continue
            if seen.get(p) == mtime:
                continue
            files = self.files_under(p)
            if any(is_media(f) for f in files):
                new_found.append(p)
                calls += [("add", f) for f in files]
            seen[p] = mtime
        for b in missing:
            calls.append(("unlink", b if known[b] else f"{b}/removed.mp3"))
        self.queue_calls(lib, calls)

        # Evidence: only when watching was continuous since the last light check (otherwise
        # the differences may come from a gap, or from before automatic imports were on)
        if clean:
            renamed = min(len(missing), len(new_found))
            for host in hosts:
                for kind, n in (("renamed", renamed), ("deleted", len(missing) - renamed),
                                ("new", len(new_found) - renamed)):
                    for _ in range(n):
                        self.evidence(host, kind, "missed")
        with self.lock:
            lc.update({"lastRun": now_iso(), "folders": len(dirs), "missing": len(missing),
                       "new": len(new_found), "seconds": round(time.time() - started)})
            lc.pop("gapSince", None)
            self.state["forceLightCheck"] = [i for i in self.state.get("forceLightCheck", []) if i != lib["id"]]
            self.state["seenUnknown"] = {p: m for p, m in seen.items() if os.path.dirname(p) in dirs or p in unknown}
        self.save_state()
        log(f"Light check of \"{lib['name']}\" done in {round(time.time() - started)}s: {len(dirs)} folders, "
            f"{len(missing)} book(s) gone, {len(new_found)} new folder(s)")

    # ---- status for the config tool --------------------------------------

    def host_status(self, host):
        nas = self.state["nas"].get(host, {})
        caps = {}
        for kind in KINDS:
            ev = nas.get(kind, {})
            st = capability(ev)
            if kind == "changed" and st == "not-reported":
                st = "unknown"   # the light check can't see changed files, so this is never ruled out
            caps[kind] = {"state": st, "reported": ev.get("reported", 0), "missed": ev.get("missed", 0),
                          "lastReported": ev.get("lastReported"), "lastMissed": ev.get("lastMissed")}
        libs = [l for l in self.libraries if host in {host_of(f) for f in l["nasFolders"]}]
        runs = [self.state["lightChecks"].get(l["id"], {}) for l in libs]
        last_runs = [r.get("lastRun") for r in runs if r.get("lastRun")]
        mode = self.effective_mode(host)
        window = self.next_run(self.settings()["catchupTime"])
        return {
            "host": host,
            "libraries": [l["name"] for l in libs],
            "capabilities": caps,
            "score": sum(1 for c in caps.values() if c["state"] == "reported"),
            "lightCheck": {
                "mode": self.settings()["lightCheck"], "effective": mode,
                "lastRun": max(last_runs) if last_runs else None,
                "lastFound": {"missing": sum(r.get("missing", 0) for r in runs), "new": sum(r.get("new", 0) for r in runs)}
                if last_runs else None,
                "nextWindow": window.isoformat(timespec="minutes") if mode != "off" else None,
                "running": self.light_running is not None and host in (self.light_running or ""),
            },
        }

    def write_status(self, enabled):
        settings = self.settings()
        if not enabled:
            state, message = "off", "Automatic imports are switched off"
        elif self.key_status[0] != "ok":
            state, message = self.key_status
        elif not self.folder_library:
            state, message = "no-network-libraries", "No Audiobookshelf library uses a folder on a network share"
        elif all(w.ok for w in self.watches.values()):
            state, message = "watching", f"Watching {len(self.watches)} library folder(s) on network shares"
        else:
            state, message = "watch-error", "Some library folders can't be watched right now"
        warnings = []
        if enabled and self.key_status[0] == "ok":
            if self.server_watcher_disabled:
                warnings.append("Audiobookshelf's folder watcher is switched off. Automatic imports need it on: in "
                                "Audiobookshelf, go to Settings and switch on \"Automatically watch libraries for "
                                "changes\", then restart Audiobookshelf.")
            for lib in self.libraries:
                if lib["nasFolders"] and lib["watcherDisabled"]:
                    warnings.append(f"The folder watcher is switched off for the \"{lib['name']}\" library, so "
                                    "changes there can't be imported automatically. In Audiobookshelf, edit the library "
                                    "and switch on \"Automatically watch library for changes\".")
        with self.lock:
            c = self.state.get("catchup")
            lib_names = {l["id"]: l["name"] for l in self.libraries}
            hosts = sorted({host_of(f) for f in self.folder_library} - {None})
            pending = len(self.pending)
        write_json(STATUS_FILE, {
            "updatedAt": now_iso(),
            "enabled": enabled,
            "catchupTime": settings["catchupTime"],
            "lightCheck": settings["lightCheck"],
            "state": state,
            "message": message,
            "user": self.username if self.key_status[0] == "ok" else None,
            "folders": [{"path": f, "library": self.folder_library[f]["name"], "ok": w.ok, "error": w.error}
                        for f, w in sorted(self.watches.items()) if f in self.folder_library],
            "nas": [self.host_status(h) for h in hosts],
            "warnings": warnings,
            "lastChange": self.last_change,
            "lastReport": self.last_report,
            "reportedTotal": self.reported_total,
            "pending": pending,
            "catchup": {"at": c["at"], "libraries": [lib_names.get(i, i) for i in c["libraries"]],
                        "reasons": c["reasons"]} if c else None,
            "lastCatchup": self.state.get("lastCatchup"),
        })

    # ---- main loop ---------------------------------------------------------

    def run(self):
        log(f"abs-share-watcher started; Audiobookshelf at {ABS_URL}")
        while True:
            try:
                self.tick()
            except Exception as e:   # never die; report and carry on
                log(f"Error: {e}")
            time.sleep(TICK)

    def take_command(self):
        cmd = read_json(COMMAND_FILE, None)
        if cmd:
            try:
                os.remove(COMMAND_FILE)
            except OSError:
                pass
        return cmd

    def tick(self):
        enabled = self.settings()["enabled"]
        if enabled != self.was_enabled:
            log("Automatic imports switched " + ("on" if enabled else "off"))
            self.was_enabled = enabled
        now = time.time()
        if enabled:
            self.load_key()
            if self.key and now - self.last_key_check > KEY_CHECK_EVERY:
                self.last_key_check = now
                if self.check_key():
                    self.last_libraries = 0
            if self.key_status[0] == "ok":
                if now - self.last_libraries > LIBRARIES_EVERY:
                    self.refresh_libraries()
                    self.last_libraries = now
                if now - self.last_items > ITEMS_EVERY:
                    self.last_items = now
                    self.refresh_items_in_background()
            elif self.key_status[0] == "abs-unavailable" and now - self.last_key_check > 30:
                self.last_key_check = 0   # Audiobookshelf starting up: try again soon
        self.sync_watches(enabled and bool(self.key))
        self.drain_events()
        cmd = self.take_command() if enabled else None
        if enabled and self.key_status[0] == "ok":
            self.deliver()
            self.run_full_scans_if_due(cmd)
            self.nightly_window(cmd)
        self.check_gaps(enabled and bool(self.key))
        self.write_status(enabled)


if __name__ == "__main__":
    Watcher().run()
