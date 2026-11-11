import assert from "node:assert/strict";
import test from "node:test";
import { parseStoreVersion, isNewer, createVersionChecker } from "../version.js";

test("store version parsing", () => {
  assert.equal(parseStoreVersion('manifestVersion: 1\nid: saltedlolly-nostr-backup-relay\nversion: "v1.2.1.2"\n'), "v1.2.1.2");
  assert.equal(parseStoreVersion("version: v1.2.1.3 # comment\n"), "v1.2.1.3");
  assert.equal(parseStoreVersion("version: '1.2.2'\n"), "1.2.2");
  // only the top-level key counts
  assert.equal(parseStoreVersion("manifestVersion: 1\n  version: nested\n"), null);
  assert.equal(parseStoreVersion("no version here"), null);
  assert.equal(parseStoreVersion(null), null);
});

test("version comparison", () => {
  assert.equal(isNewer("v1.2.1.2", "v1.2.1.1"), true);
  assert.equal(isNewer("v1.2.2", "v1.2.1.9"), true);
  assert.equal(isNewer("v1.2.1", "v1.2.1.1"), false);
  assert.equal(isNewer("v1.2.1.1", "v1.2.1.1"), false);
  assert.equal(isNewer("v1.2.1.1", "dev"), false);
});

test("the store is checked at most every 10 minutes and failures are silent", async () => {
  let time = 0;
  let calls = 0;
  let reply = 'version: "v1.2.1.2"';
  const getVersion = createVersionChecker({
    version: "v1.2.1.1",
    now: () => time,
    fetchManifest: async () => {
      calls++;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });

  assert.deepEqual(await getVersion(), { version: "v1.2.1.1", latestVersion: "v1.2.1.2", updateAvailable: true });
  time += 9 * 60 * 1000;
  reply = 'version: "v1.2.1.3"';
  assert.equal((await getVersion()).latestVersion, "v1.2.1.2");
  assert.equal(calls, 1);

  time += 60 * 1000;
  assert.equal((await getVersion()).latestVersion, "v1.2.1.3");
  assert.equal(calls, 2);

  // Offline or a bad reply keeps the last version seen
  time += 10 * 60 * 1000;
  reply = new Error("offline");
  assert.equal((await getVersion()).latestVersion, "v1.2.1.3");
  time += 10 * 60 * 1000;
  reply = null;
  assert.equal((await getVersion()).latestVersion, "v1.2.1.3");
  assert.equal(calls, 4);

  // Never reached the store: no update notice
  const offline = createVersionChecker({ version: "v1.2.1.1", fetchManifest: async () => null });
  assert.deepEqual(await offline(), { version: "v1.2.1.1", latestVersion: null, updateAvailable: false });

  // Concurrent requests share one fetch
  let concurrent = 0;
  const shared = createVersionChecker({ version: "v1", fetchManifest: async () => { concurrent++; return "version: v2"; } });
  await Promise.all([shared(), shared(), shared()]);
  assert.equal(concurrent, 1);
});
