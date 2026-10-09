"""Tests for the parts of watcher.py that don't need a NAS: python3 -m unittest test_watcher.py"""

import datetime
import json
import os
import shutil
import struct
import tempfile
import time
import unittest

DATA = tempfile.mkdtemp()
ROOT = tempfile.mkdtemp()   # stands in for /media/network
os.environ["WATCHER_DIR"] = DATA
os.environ["NETWORK_ROOT"] = ROOT
os.environ["LIGHT_CHECK_RATE"] = "0"   # no pacing in tests

import watcher  # noqa: E402


def record(action, name, last=False):
    data = name.encode("utf-16-le")
    size = 12 + len(data)
    size += (-size) % 4
    body = struct.pack("<III", 0 if last else size, action, len(data)) + data
    return body + b"\0" * (size - len(body))


def write_settings(settings):
    with open(watcher.SETTINGS_FILE, "w") as f:
        json.dump(settings, f)


def make_watcher(settings=None):
    for f in os.listdir(DATA):
        os.remove(os.path.join(DATA, f))
    if settings is not None:
        write_settings(settings)
    return watcher.Watcher()


class ParseNotify(unittest.TestCase):
    def test_records_and_backslashes(self):
        buf = record(1, "Author\\Book\\01.mp3") + record(5, "Author\\Book (New)", last=True)
        self.assertEqual(watcher.parse_notify(bytearray(buf), len(buf)),
                         [(1, "Author/Book/01.mp3"), (5, "Author/Book (New)")])

    def test_empty(self):
        self.assertEqual(watcher.parse_notify(bytearray(64), 0), [])


class Helpers(unittest.TestCase):
    def test_host_of(self):
        self.assertEqual(watcher.host_of(f"{ROOT}/Drobo5N.local/Public/Spoken Word"), "Drobo5N.local")
        self.assertIsNone(watcher.host_of("/podcasts"))

    def test_capability(self):
        cap = watcher.capability
        self.assertEqual(cap({}), "unknown")
        self.assertEqual(cap({"reported": 2, "sinceMiss": 2}), "unknown")
        self.assertEqual(cap({"reported": 3, "sinceMiss": 3}), "reported")
        self.assertEqual(cap({"reported": 5, "missed": 1, "sinceMiss": 1}), "not-reported")
        self.assertEqual(cap({"reported": 9, "missed": 1, "sinceMiss": 3}), "reported")


class ChangesFor(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = self.tmp.name
        os.makedirs(f"{self.folder}/Author/Book")
        for f in ("01.mp3", "02.mp3", ".DS_Store"):
            open(f"{self.folder}/Author/Book/{f}", "w").close()
        self.w = make_watcher()
        self.lib = {"id": "lib1", "name": "Lib"}
        self.w.items = {"lib1": {f"{self.folder}/Author/Old Book": False,
                                 f"{self.folder}/Author/Single.m4b": True,
                                 f"{self.folder}/Other/Book": False}}

    def tearDown(self):
        self.tmp.cleanup()

    def calls(self, action, rel):
        return sorted(self.w.changes_for(self.lib, self.folder, action, rel))

    def test_added_folder_lists_its_files(self):
        self.assertEqual(self.calls(watcher.ADDED, "Author/Book"),
                         [("add", f"{self.folder}/Author/Book/01.mp3"), ("add", f"{self.folder}/Author/Book/02.mp3")])

    def test_renamed_to_folder_lists_its_files(self):
        self.assertEqual(len(self.calls(watcher.RENAMED_NEW, "Author")), 2)

    def test_modified_file_counts_as_added(self):
        self.assertEqual(self.calls(watcher.MODIFIED, "Author/Book/02.mp3"), [("add", f"{self.folder}/Author/Book/02.mp3")])

    def test_hidden_files_ignored(self):
        self.assertEqual(self.calls(watcher.ADDED, "Author/Book/.DS_Store"), [])
        self.assertEqual(self.calls(watcher.ADDED, "._01.mp3"), [])

    def test_vanished_before_handling_is_ignored(self):
        self.assertEqual(self.calls(watcher.ADDED, "Author/Gone/01.mp3"), [])

    def test_removed_book_folder_uses_made_up_file(self):
        self.assertEqual(self.calls(watcher.REMOVED, "Author/Old Book"),
                         [("unlink", f"{self.folder}/Author/Old Book/removed.mp3")])

    def test_removed_author_folder_reports_each_book(self):
        self.assertEqual(self.calls(watcher.RENAMED_OLD, "Author"),
                         [("unlink", f"{self.folder}/Author/Old Book/removed.mp3"),
                          ("unlink", f"{self.folder}/Author/Single.m4b")])

    def test_removed_file_in_book(self):
        self.assertEqual(self.calls(watcher.REMOVED, "Other/Book/03.mp3"), [("unlink", f"{self.folder}/Other/Book/03.mp3")])

    def test_removed_unknown_folder_is_treated_as_possible_book(self):
        self.assertEqual(self.calls(watcher.REMOVED, "New Author/New Book"),
                         [("unlink", f"{self.folder}/New Author/New Book/removed.mp3")])

    def test_prefix_is_not_a_parent(self):
        # "Other/Bo" must not match "Other/Book"
        self.assertEqual(self.calls(watcher.REMOVED, "Other/Bo"), [("unlink", f"{self.folder}/Other/Bo/removed.mp3")])


class LightCheckDiff(unittest.TestCase):
    """The comparison itself, with made-up listings."""

    def test_missing_and_unknown(self):
        known = {"/L/A/Book 1": False, "/L/A/Book 2": False, "/L/B/Series/Book 3": False, "/L/C/Single.m4b": True}
        dirs = {"/L", "/L/A", "/L/B", "/L/B/Series", "/L/C"}
        listings = {"/L": ["A", "B", "C", "New Author", ".Trashes", "notes.txt"],
                    "/L/A": ["Book 1", "Book 2 (Renamed)", ".DS_Store"],
                    "/L/B": ["Series"], "/L/B/Series": ["Book 3", "cover.jpg"], "/L/C": []}
        isdir = lambda p: p in ("/L/New Author", "/L/A/Book 2 (Renamed)")
        missing, unknown = watcher.light_check_diff(dirs, known, listings.get, isdir)
        self.assertEqual(sorted(missing), ["/L/A/Book 2", "/L/C/Single.m4b"])
        # notes.txt and cover.jpg are neither folders nor media; hidden names are skipped
        self.assertEqual(sorted(unknown), ["/L/A/Book 2 (Renamed)", "/L/New Author"])

    def test_unlistable_folder_is_skipped(self):
        missing, unknown = watcher.light_check_diff({"/L"}, {"/L/Book": False}, lambda d: None, lambda p: False)
        self.assertEqual((missing, unknown), ([], []))


class LightCheckRun(unittest.TestCase):
    """A whole light check against real temporary folders."""

    def setUp(self):
        self.lib_root = f"{ROOT}/NAS.local/Share/Books"
        shutil.rmtree(f"{ROOT}/NAS.local", ignore_errors=True)
        for book in ("Author A/Book 1", "Author A/Book 2", "Author B/Book 3"):
            os.makedirs(f"{self.lib_root}/{book}")
            open(f"{self.lib_root}/{book}/01.mp3", "w").close()
        self.w = make_watcher({"enabled": True})
        self.lib = {"id": "lib1", "name": "Books", "folders": [self.lib_root], "nasFolders": [self.lib_root],
                    "watcherDisabled": False}
        self.w.libraries = [self.lib]
        self.w.folder_library = {self.lib_root: self.lib}
        self.known = {f"{self.lib_root}/{b}": False for b in ("Author A/Book 1", "Author A/Book 2", "Author B/Book 3")}
        self.w.refresh_items = lambda: setattr(self.w, "items", {"lib1": dict(self.known)})

    def test_first_check_reports_but_learns_nothing(self):
        os.rename(f"{self.lib_root}/Author A/Book 2", f"{self.lib_root}/Author A/Book 2 (Renamed)")
        self.w.light_check_library(self.lib)
        bodies = sorted((b["type"], b["path"]) for b in self.w.pending)
        self.assertEqual(bodies, [("add", f"{self.lib_root}/Author A/Book 2 (Renamed)/01.mp3"),
                                  ("unlink", f"{self.lib_root}/Author A/Book 2/removed.mp3")])
        self.assertEqual(self.w.state["nas"], {})   # no previous check, so no evidence
        lc = self.w.state["lightChecks"]["lib1"]
        self.assertEqual((lc["missing"], lc["new"]), (1, 1))

    def test_later_check_counts_misses(self):
        self.w.light_check_library(self.lib)            # baseline, nothing changed
        self.assertEqual(self.w.pending, [])
        os.rename(f"{self.lib_root}/Author A/Book 2", f"{self.lib_root}/Author A/Book 2 (Renamed)")
        shutil.rmtree(f"{self.lib_root}/Author B/Book 3")
        os.makedirs(f"{self.lib_root}/Author C/Book 4")
        open(f"{self.lib_root}/Author C/Book 4/01.mp3", "w").close()
        self.w.light_check_library(self.lib)
        nas = self.w.state["nas"]["NAS.local"]
        # 2 gone + 2 new: counted as 2 renames (pairs), no deletions, no new
        self.assertEqual(nas["renamed"]["missed"], 2)
        self.assertNotIn("deleted", nas)
        self.assertNotIn("new", nas)

    def test_after_gap_learns_nothing(self):
        self.w.light_check_library(self.lib)
        self.w.gap(["lib1"], 600, "test")
        shutil.rmtree(f"{self.lib_root}/Author B/Book 3")
        self.w.light_check_library(self.lib)
        self.assertEqual(self.w.state["nas"], {})
        self.assertEqual(len(self.w.pending), 1)

    def test_unchanged_unknown_folder_not_reported_twice(self):
        os.makedirs(f"{self.lib_root}/Author A/Extras")
        open(f"{self.lib_root}/Author A/Extras/notes.txt", "w").close()
        os.makedirs(f"{self.lib_root}/Author A/New Book")
        open(f"{self.lib_root}/Author A/New Book/01.mp3", "w").close()
        self.w.light_check_library(self.lib)
        first = len(self.w.pending)
        self.w.pending = []
        self.w.light_check_library(self.lib)
        self.assertEqual(first, 1)            # only the new book's file, not the extras folder
        self.assertEqual(self.w.pending, [])  # already reported and unchanged

    def test_unreadable_library_folder_stops_without_reporting(self):
        self.lib["nasFolders"] = [f"{ROOT}/NAS.local/Share/Gone"]
        self.w.light_check_library(self.lib)
        self.assertEqual(self.w.pending, [])
        self.assertNotIn("lastRun", self.w.state["lightChecks"].get("lib1", {}))


class Evidence(unittest.TestCase):
    def setUp(self):
        self.w = make_watcher()
        self.lib = {"id": "lib1", "name": "Lib"}
        self.folder = f"{ROOT}/NAS.local/Share/Books"
        os.makedirs(f"{self.folder}/Author/New Book", exist_ok=True)
        self.w.items = {"lib1": {f"{self.folder}/Author/Book": False}}

    def test_rename_counted_once(self):
        for _ in range(3):
            self.w.notification_evidence(self.lib, self.folder, watcher.RENAMED_OLD, "Author/Book")
        self.assertEqual(self.w.state["nas"]["NAS.local"]["renamed"]["reported"], 1)

    def test_kinds(self):
        w, f = self.w, self.folder
        w.notification_evidence(self.lib, f, watcher.ADDED, "Author/New Book")
        w.notification_evidence(self.lib, f, watcher.REMOVED, "Author/Old Book")
        w.notification_evidence(self.lib, f, watcher.REMOVED, "Author/Book/03.mp3")   # a file: not a deletion of a book
        w.notification_evidence(self.lib, f, watcher.MODIFIED, "Author/Book/01.mp3")
        w.notification_evidence(self.lib, f, watcher.MODIFIED, "Author/Elsewhere/01.mp3")   # not a known book
        nas = w.state["nas"]["NAS.local"]
        self.assertEqual({k: v["reported"] for k, v in nas.items()}, {"new": 1, "deleted": 1, "changed": 1})

    def test_modified_folder_around_a_known_book_counts_as_changed(self):
        os.makedirs(f"{self.folder}/Author/Book", exist_ok=True)
        self.w.notification_evidence(self.lib, self.folder, watcher.MODIFIED, "Author")
        self.assertEqual(self.w.state["nas"]["NAS.local"]["changed"]["reported"], 1)

    def test_three_renames_confirm(self):
        for i in range(3):
            self.w.notification_evidence(self.lib, self.folder, watcher.RENAMED_OLD, f"Author {i}/Book")
        self.assertEqual(self.w.host_status("NAS.local")["capabilities"]["renamed"]["state"], "reported")

    def test_scheduled_scans_listed_per_nas(self):
        self.w.libraries = [
            {"id": "a", "name": "Fantasy", "nasFolders": [f"{ROOT}/NAS.local/Share/F"], "scanSchedule": "0 03 * * 0,1,3,5"},
            {"id": "b", "name": "Fiction", "nasFolders": [f"{ROOT}/NAS.local/Share/G"], "scanSchedule": None},
            {"id": "c", "name": "Other NAS", "nasFolders": [f"{ROOT}/Other.local/S/H"], "scanSchedule": "0 2 * * *"},
        ]
        self.assertEqual(self.w.host_status("NAS.local")["scheduledScans"], [{"library": "Fantasy", "cron": "0 03 * * 0,1,3,5"}])
        self.assertEqual(self.w.host_status("Other.local")["scheduledScans"], [{"library": "Other NAS", "cron": "0 2 * * *"}])

    def test_changed_is_never_ruled_out(self):
        self.w.evidence("NAS.local", "changed", "missed")
        self.assertEqual(self.w.host_status("NAS.local")["capabilities"]["changed"]["state"], "unknown")


class Scheduling(unittest.TestCase):
    def setUp(self):
        self.w = make_watcher({"enabled": True, "catchupTime": "04:00", "lightCheck": "auto"})
        self.lib = {"id": "lib1", "name": "Lib", "nasFolders": [f"{ROOT}/NAS.local/Share/Books"]}
        self.w.libraries = [self.lib]

    def confirm(self, kinds):
        for k in kinds:
            for i in range(watcher.CONFIRM_AFTER):
                self.w.evidence("NAS.local", k, "reported", f"Author {i}/Book")

    def test_auto_daily_until_renames_and_deletions_confirmed(self):
        self.assertEqual(self.w.effective_mode("NAS.local"), "daily")
        self.confirm(["new", "renamed"])
        self.assertEqual(self.w.effective_mode("NAS.local"), "daily")
        self.confirm(["deleted"])
        self.assertEqual(self.w.effective_mode("NAS.local"), "weekly")

    def test_user_choice_wins(self):
        write_settings({"enabled": True, "lightCheck": "off"})
        self.assertEqual(self.w.effective_mode("NAS.local"), "off")
        self.assertFalse(self.w.light_check_due(self.lib))

    def test_due(self):
        self.assertTrue(self.w.light_check_due(self.lib))          # never run
        self.w.state["lightChecks"]["lib1"] = {"lastRun": watcher.now_iso()}
        self.assertFalse(self.w.light_check_due(self.lib))         # ran just now
        self.w.state["lightChecks"]["lib1"]["lastRun"] = (datetime.datetime.now(datetime.timezone.utc)
                                                          - datetime.timedelta(hours=21)).isoformat()
        self.assertTrue(self.w.light_check_due(self.lib))          # daily: older than 20 hours
        self.confirm(["new", "renamed", "deleted"])
        self.assertFalse(self.w.light_check_due(self.lib))         # weekly now

    def test_recent_full_scan_skips_light_check(self):
        self.w.state["lastFullScan"]["lib1"] = watcher.now_iso()
        self.assertFalse(self.w.light_check_due(self.lib))

    def test_forced_runs_even_when_off(self):
        write_settings({"enabled": True, "lightCheck": "off"})
        self.w.force_light_check(["lib1"])
        self.assertTrue(self.w.light_check_due(self.lib))

    def test_short_gap_light_check_long_gap_full_scan(self):
        self.w.gap(["lib1"], 600, "short")
        self.assertIn("lib1", self.w.state["forceLightCheck"])
        self.assertIsNone(self.w.state.get("catchup"))
        self.w.gap(["lib1"], 7200, "long")
        self.assertEqual(self.w.state["catchup"]["libraries"], ["lib1"])

    def test_first_start_waits_for_the_night(self):
        started = []
        self.w.light_check = lambda libs: started.append(libs)
        self.w.nightly_window(None)
        self.assertIn("lastWindow", self.w.state)
        time.sleep(0.05)
        self.assertEqual(started, [])

    def test_bad_time_falls_back_to_four(self):
        self.assertEqual((self.w.next_run("nonsense").hour, self.w.next_run("nonsense").minute), (4, 0))
        self.assertEqual(self.w.next_run("23:15").minute, 15)


class FullScans(unittest.TestCase):
    """Scheduled full scans, with a stand-in for Audiobookshelf."""

    def setUp(self):
        self.w = make_watcher({"enabled": True})
        self.w.libraries = [{"id": "lib1", "name": "Lib", "nasFolders": [f"{ROOT}/NAS.local/x"]}]
        self.calls = []
        self.running = False
        test = self

        class FakeAbs:
            def __init__(self, key):
                pass

            def call(self, method, path, body=None, timeout=15):
                test.calls.append((method, path))
                if path == "/api/tasks":
                    return {"tasks": [{"action": "library-scan", "isFinished": False,
                                       "data": {"libraryId": "lib1"}}] if test.running else []}
                return "OK"

        self.real_abs = watcher.Abs
        watcher.Abs = FakeAbs
        self.w.schedule_full_scan(["lib1"], "test")

    def tearDown(self):
        watcher.Abs = self.real_abs

    def test_not_due_yet(self):
        self.w.run_full_scans_if_due(None)
        self.assertNotIn(("POST", "/api/libraries/lib1/scan"), self.calls)
        self.assertIsNotNone(self.w.state.get("catchup"))

    def test_scan_now(self):
        self.w.run_full_scans_if_due({"action": "run"})
        self.assertIn(("POST", "/api/libraries/lib1/scan"), self.calls)
        self.assertIsNone(self.w.state.get("catchup"))
        self.assertIn("lib1", self.w.state["lastFullScan"])

    def test_waits_while_abs_is_scanning(self):
        self.running = True
        self.w.run_full_scans_if_due({"action": "run"})
        self.assertNotIn(("POST", "/api/libraries/lib1/scan"), self.calls)
        self.assertEqual(self.w.state["catchup"]["libraries"], ["lib1"])   # still waiting
        self.running = False
        self.w.state["catchup"]["at"] = "2000-01-01T04:00"                  # now due
        self.w.run_full_scans_if_due(None)
        self.assertIn(("POST", "/api/libraries/lib1/scan"), self.calls)

    def test_skip(self):
        self.w.run_full_scans_if_due({"action": "skip"})
        self.assertIsNone(self.w.state.get("catchup"))
        self.assertNotIn(("POST", "/api/libraries/lib1/scan"), self.calls)


if __name__ == "__main__":
    unittest.main()
