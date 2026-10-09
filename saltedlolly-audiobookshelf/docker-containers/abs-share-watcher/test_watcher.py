"""Tests for the parts of watcher.py that don't need a NAS: python3 -m unittest test_watcher.py"""

import os
import struct
import tempfile
import unittest

import watcher


def record(action, name, last=False):
    data = name.encode("utf-16-le")
    size = 12 + len(data)
    size += (-size) % 4
    body = struct.pack("<III", 0 if last else size, action, len(data)) + data
    return body + b"\0" * (size - len(body))


class ParseNotify(unittest.TestCase):
    def test_records_and_backslashes(self):
        buf = record(1, "Author\\Book\\01.mp3") + record(5, "Author\\Book (New)", last=True)
        self.assertEqual(watcher.parse_notify(bytearray(buf), len(buf)),
                         [(1, "Author/Book/01.mp3"), (5, "Author/Book (New)")])

    def test_empty(self):
        self.assertEqual(watcher.parse_notify(bytearray(64), 0), [])


class ChangesFor(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = self.tmp.name
        os.makedirs(f"{self.folder}/Author/Book")
        for f in ("01.mp3", "02.mp3", ".DS_Store"):
            open(f"{self.folder}/Author/Book/{f}", "w").close()
        self.w = watcher.Watcher.__new__(watcher.Watcher)
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


class NextRun(unittest.TestCase):
    def test_bad_time_falls_back_to_four(self):
        w = watcher.Watcher.__new__(watcher.Watcher)
        self.assertEqual((w.next_run("nonsense").hour, w.next_run("nonsense").minute), (4, 0))
        self.assertEqual(w.next_run("23:15").minute, 15)


if __name__ == "__main__":
    unittest.main()
