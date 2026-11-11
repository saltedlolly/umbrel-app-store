import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deleteEventsNotBy } from "../relay-db.js";

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const carol = "c".repeat(64);

test("events from accounts that aren't synced are deleted with their tags", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nostr-relay-db-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "nostr.db");
  const db = new DatabaseSync(file);
  // The parts of nostr-rs-relay's schema this touches
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE event (id INTEGER PRIMARY KEY, event_hash BLOB NOT NULL, first_seen INTEGER NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER, author BLOB NOT NULL, delegated_by BLOB, kind INTEGER NOT NULL, hidden INTEGER, content TEXT NOT NULL);
    CREATE TABLE tag (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, name TEXT, value TEXT, value_hex BLOB, created_at INTEGER NOT NULL,
      kind INTEGER NOT NULL, FOREIGN KEY(event_id) REFERENCES event(id) ON UPDATE CASCADE ON DELETE CASCADE);`);
  const insert = db.prepare("INSERT INTO event (event_hash, first_seen, created_at, author, kind, content) VALUES (?, 0, 0, ?, 1, '{}')");
  const tag = db.prepare("INSERT INTO tag (event_id, name, value, created_at, kind) VALUES (?, 'p', 'x', 0, 1)");
  let n = 0;
  for (const author of [alice, alice, bob, carol, carol, carol]) {
    const { lastInsertRowid } = insert.run(Buffer.from([n++]), Buffer.from(author, "hex"));
    tag.run(lastInsertRowid);
  }
  const count = table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);

  assert.throws(() => deleteEventsNotBy([alice], { author: alice, file }), /synced/);
  assert.equal(deleteEventsNotBy([alice], { author: bob, file }), 1);
  assert.equal(count("event"), 5);
  assert.equal(deleteEventsNotBy([alice], { file }), 3);
  assert.equal(count("event"), 2);
  assert.equal(count("tag"), 2, "tags of deleted events are deleted too");
  db.close();
});
