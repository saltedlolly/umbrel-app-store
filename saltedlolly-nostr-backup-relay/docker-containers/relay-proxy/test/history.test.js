import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import History from "../history.js";

const version = (id, pubkey, kind, created_at, content = "{}") =>
  ({ id, pubkey, kind, created_at, content, tags: [], sig: "s" });

test("the history keeps every profile and relay list version, oldest first", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nostr-history-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "history.json");
  const history = new History({ file, saveDelay: 10000 });

  assert.equal(history.record(version("b", "alice", 0, 200)), true);
  assert.equal(history.record(version("a", "alice", 0, 100)), true);
  assert.equal(history.record(version("a", "alice", 0, 100)), false, "duplicates are ignored");
  assert.equal(history.record(version("c", "alice", 1, 300)), false, "posts are not kept");
  history.record(version("d", "alice", 10002, 150));
  history.record(version("e", "bob", 0, 120));

  assert.deepEqual(history.versions(["alice"]).alice.map(event => event.id), ["a", "d", "b"]);
  assert.deepEqual(Object.keys(history.versions(["alice", "bob", "carol"])), ["alice", "bob"]);

  history.close();
  const reloaded = new History({ file });
  assert.deepEqual(reloaded.versions(["alice"]).alice.map(event => event.id), ["a", "d", "b"]);

  reloaded.forget("alice");
  reloaded.close();
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))), ["bob"]);
  reloaded.clear();
  reloaded.close();
  await assert.rejects(readFile(file), /ENOENT/);
});

test("only the newest 50 versions are kept", () => {
  const history = new History({ file: "/nonexistent/history.json" });
  for (let n = 0; n < 60; n++) history.record(version(`v${n}`, "alice", 0, n));
  const kept = history.versions(["alice"]).alice;
  assert.equal(kept.length, 50);
  assert.equal(kept[0].id, "v10");
  clearTimeout(history.timer);
});
