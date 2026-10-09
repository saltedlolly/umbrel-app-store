#!/usr/bin/env python3
"""abs-share-watcher: tells Audiobookshelf about changes on network shares.

Audiobookshelf's own folder watcher uses Linux inotify, which only sees changes
made on the Umbrel itself. Books added to a NAS from another computer are never
noticed. This helper asks the NAS for SMB change notifications on each library
folder (the kernel's CIFS_IOC_NOTIFY_INFO request, one per folder tree, no
folder walk) and passes each change to Audiobookshelf's external watcher API
(POST /api/watcher/update), which then scans only the book folders involved.

Files in DATA_DIR:
  settings.json  written by the config tool: {"enabled": bool, "catchupTime": "HH:MM"}
  api-key        written by the config tool (mode 600): an Audiobookshelf API key
  command.json   written by the config tool: {"action": "run" | "skip"} for a scheduled catch-up
  status.json    written here, read by the config tool
  state.json     written here: when watching last worked, and any scheduled catch-up
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

SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
KEY_FILE = os.path.join(DATA_DIR, "api-key")
COMMAND_FILE = os.path.join(DATA_DIR, "command.json")
STATUS_FILE = os.path.join(DATA_DIR, "status.json")
STATE_FILE = os.path.join(DATA_DIR, "state.json")

TICK = 2                 # seconds between main-loop passes
KEY_CHECK_EVERY = 300    # check the API key every 5 minutes
LIBRARIES_EVERY = 600    # refresh libraries and folders every 10 minutes
ITEMS_EVERY = 900        # refresh the list of known book folders every 15 minutes
GAP_SECONDS = 120        # not watching for longer than this means changes may have been missed
RETRY_SECONDS = 15       # wait before reopening a folder whose watch failed

# struct smb3_notify_info { __u32 completion_filter; bool watch_tree; __u32 data_len; __u8 notify_data[]; } __packed
# CIFS_IOC_NOTIFY_INFO = _IOWR(0xCF, 11, struct smb3_notify_info): direction 3, size 9 (fs/smb/client/cifs_ioctl.h)
CIFS_IOC_NOTIFY_INFO = (3 << 30) | (9 << 16) | (0xCF << 8) | 11
NOTIFY_FILTER = 0x1 | 0x2 | 0x10   # FILE_NOTIFY_CHANGE_FILE_NAME | DIR_NAME | LAST_WRITE
NOTIFY_BUFFER = 64 * 1024
ADDED, REMOVED, MODIFIED, RENAMED_OLD, RENAMED_NEW = 1, 2, 3, 4, 5


def log(msg):
    print(f"{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    # Temporary file + rename, so the config tool never reads a half-written file
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def is_hidden(rel):
    # Dotfiles and folders (.DS_Store, ._AppleDouble, .Trashes) are ignored by Audiobookshelf too
    return any(part.startswith(".") for part in rel.split("/"))


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
        self.events = queue.Queue()
        self.watches = {}            # folder path -> FolderWatch
        self.pending = []            # hook bodies not yet delivered
        self.state = read_json(STATE_FILE, {})
        # Last known libraries, so watching starts before Audiobookshelf answers
        self.libraries = self.state.get("libraries", [])
        self.folder_library = {f: lib for lib in self.libraries for f in lib["nasFolders"]}   # folder -> library
        self.items = {}              # library id -> {book path: isFile}
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
        self.overflow_libraries = set()
        self.was_enabled = None

    # ---- settings and Audiobookshelf -------------------------------------

    def settings(self):
        s = read_json(SETTINGS_FILE, {})
        return {"enabled": bool(s.get("enabled")), "catchupTime": s.get("catchupTime") or "04:00"}

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
                                   "deactivated or expired). Create a new key in Audiobookshelf and save it here.")
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
        self.libraries = libs
        self.folder_library = {f: lib for lib in libs for f in lib["nasFolders"]}
        self.state["libraries"] = libs
        write_json(STATE_FILE, self.state)

    def refresh_items(self):
        items = {}
        for lib in self.libraries:
            if not lib["nasFolders"]:
                continue
            data = Abs(self.key).call("GET", f"/api/libraries/{lib['id']}/items?minified=1", timeout=60)
            items[lib["id"]] = {i["path"].rstrip("/"): bool(i.get("isFile")) for i in data.get("results", [])}
        self.items = items

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
        calls = []
        if action in (ADDED, MODIFIED, RENAMED_NEW):
            if os.path.isdir(path):
                # The NAS doesn't reliably list a new or renamed folder's files, so list them here
                for root, dirs, files in os.walk(path):
                    dirs[:] = [d for d in dirs if not d.startswith(".")]
                    calls += [("add", os.path.join(root, f)) for f in files if not f.startswith(".")]
            elif os.path.isfile(path):
                calls.append(("add", path))
        elif action in (REMOVED, RENAMED_OLD):
            books = self.items.get(lib["id"], {})
            under = [b for b in books if b == path or b.startswith(path + "/")]
            for b in under:
                # A made-up file name inside the book folder is enough for Audiobookshelf to
                # notice the folder is gone and mark the book missing
                calls.append(("unlink", b if books[b] else f"{b}/removed.mp3"))
            if not under:
                if os.path.splitext(rel)[1]:
                    calls.append(("unlink", path))   # a single file removed from a book
                else:
                    # Possibly a book added since the book list was last read
                    calls.append(("unlink", f"{path}/removed.mp3"))
        return calls

    def drain_events(self):
        batch = []
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
                self.overflow_libraries.add(lib["id"])
                self.schedule_catchup([lib["id"]], "the NAS reported too many changes at once")
                continue
            self.last_change = {"at": now_iso(), "path": f"{folder}/{rel}"}
            for kind, path in self.changes_for(lib, folder, action, rel):
                batch.append({"libraryId": lib["id"], "path": path, "type": kind})
        if batch:
            seen = {(b["libraryId"], b["path"], b["type"]) for b in self.pending}
            for b in batch:
                k = (b["libraryId"], b["path"], b["type"])
                if k not in seen:
                    seen.add(k)
                    self.pending.append(b)

    def deliver(self):
        sent = 0
        while self.pending:
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
            self.pending.pop(0)
            sent += 1
            if body["type"] == "unlink":
                self.last_items = 0   # the book list changed
        if sent:
            self.reported_total += sent
            self.last_report = {"at": now_iso(), "count": sent}
            log(f"Reported {sent} change(s) to Audiobookshelf")

    # ---- catch-up scans after a gap ----------------------------------------

    def next_run(self, hhmm):
        try:
            h, m = (int(x) for x in hhmm.split(":"))
        except ValueError:
            h, m = 4, 0
        now = datetime.datetime.now()
        at = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if at <= now:
            at += datetime.timedelta(days=1)
        return at

    def schedule_catchup(self, library_ids, reason):
        c = self.state.get("catchup") or {"libraries": [], "reasons": []}
        c["libraries"] = sorted(set(c["libraries"]) | set(library_ids))
        if reason not in c["reasons"]:
            c["reasons"].append(reason)
        c["at"] = self.next_run(self.settings()["catchupTime"]).isoformat(timespec="minutes")
        self.state["catchup"] = c
        write_json(STATE_FILE, self.state)

    def check_gaps(self, enabled):
        """Schedule a catch-up scan for libraries that weren't watched for a while."""
        if not enabled or not self.watches:
            return
        now = time.time()
        if any(w.ok for w in self.watches.values()):
            if not self.startup_checked:
                # Changes made while the app (or the Umbrel) wasn't running can't be seen afterwards
                self.startup_checked = True
                last = self.state.get("lastWatching")
                if last and now - last > GAP_SECONDS:
                    ids = [lib["id"] for lib in self.libraries if lib["nasFolders"]]
                    self.schedule_catchup(ids, "changes may have been missed while the app wasn't running")
            self.state["lastWatching"] = now
            write_json(STATE_FILE, self.state)
        for w in self.watches.values():
            if w.recovered_after > GAP_SECONDS:
                lib = self.folder_library.get(w.folder)
                if lib:
                    self.schedule_catchup([lib["id"]], f"the share for \"{lib['name']}\" was unavailable for a while")
            w.recovered_after = 0

        # A new catch-up time moves an already scheduled scan
        t = self.settings()["catchupTime"]
        if self.catchup_time and t != self.catchup_time and self.state.get("catchup"):
            self.state["catchup"]["at"] = self.next_run(t).isoformat(timespec="minutes")
            write_json(STATE_FILE, self.state)
        self.catchup_time = t

    def run_catchup_if_due(self):
        cmd = read_json(COMMAND_FILE, None)
        if cmd:
            try:
                os.remove(COMMAND_FILE)
            except OSError:
                pass
        c = self.state.get("catchup")
        if not c:
            return
        if cmd and cmd.get("action") == "skip":
            log("Catch-up scan skipped by the user")
            self.state.pop("catchup", None)
            write_json(STATE_FILE, self.state)
            return
        due = cmd and cmd.get("action") == "run"
        if not due:
            try:
                due = datetime.datetime.now() >= datetime.datetime.fromisoformat(c["at"])
            except (KeyError, ValueError):
                due = True
        if not due:
            return
        names = []
        for lib_id in c["libraries"]:
            lib = next((l for l in self.libraries if l["id"] == lib_id), None)
            if not lib:
                continue
            try:
                Abs(self.key).call("POST", f"/api/libraries/{lib_id}/scan", timeout=10)
                names.append(lib["name"])
            except (OSError, ValueError) as e:
                log(f"Couldn't start the catch-up scan of \"{lib['name']}\": {e}; will try again")
                return
        log(f"Started catch-up scan of: {', '.join(names) or 'no libraries'}")
        self.state["lastCatchup"] = {"at": now_iso(), "libraries": names}
        self.state.pop("catchup", None)
        self.overflow_libraries.clear()
        self.last_items = 0
        write_json(STATE_FILE, self.state)

    # ---- status for the config tool --------------------------------------

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
        c = self.state.get("catchup")
        lib_names = {l["id"]: l["name"] for l in self.libraries}
        write_json(STATUS_FILE, {
            "updatedAt": now_iso(),
            "enabled": enabled,
            "catchupTime": settings["catchupTime"],
            "state": state,
            "message": message,
            "user": self.username if self.key_status[0] == "ok" else None,
            "folders": [{"path": f, "library": self.folder_library[f]["name"], "ok": w.ok, "error": w.error}
                        for f, w in sorted(self.watches.items()) if f in self.folder_library],
            "warnings": warnings,
            "lastChange": self.last_change,
            "lastReport": self.last_report,
            "reportedTotal": self.reported_total,
            "pending": len(self.pending),
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
                    self.refresh_items()
                    self.last_items = now
            elif self.key_status[0] == "abs-unavailable" and now - self.last_key_check > 30:
                self.last_key_check = 0   # Audiobookshelf starting up: try again soon
        self.sync_watches(enabled and bool(self.key))
        self.drain_events()
        if enabled and self.key_status[0] == "ok":
            self.deliver()
            self.run_catchup_if_due()
        self.check_gaps(enabled and bool(self.key))
        self.write_status(enabled)


if __name__ == "__main__":
    Watcher().run()
