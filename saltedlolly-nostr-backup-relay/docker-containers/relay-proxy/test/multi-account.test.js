import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { generatePrivateKey, getPublicKey, getEventHash, getSignature, nip19 } from "nostr-tools";
import RelayManager from "../RelayManager.js";

function signed(secret, kind, content, tags = [], created_at = 100) {
  const event = { pubkey: getPublicKey(secret), kind, content, tags, created_at };
  event.id = getEventHash(event);
  event.sig = getSignature(event, secret);
  return event;
}

function fakeSockets() {
  const made = [];
  const createSocket = (url, options) => {
    const socket = { url, options, sent: [], status: 1, send(message) { this.sent.push(message); return true; }, close() { this.closed = true; } };
    made.push(socket);
    return socket;
  };
  return { made, createSocket };
}

test("several accounts sync through shared relay connections", async t => {
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "nostr-multi-account-test-"));
  process.chdir(directory);
  await mkdir("data");

  const alice = generatePrivateKey();
  const bob = generatePrivateKey();
  const alicePub = getPublicKey(alice);
  const bobPub = getPublicKey(bob);
  const aliceNpub = nip19.npubEncode(alicePub);
  const bobNpub = nip19.npubEncode(bobPub);

  // Start from the official app's single-identifier store
  await writeFile("data/store.json", JSON.stringify({ identifier: aliceNpub }));
  const { made, createSocket } = fakeSockets();
  const manager = new RelayManager({ createSocket });
  t.after(async () => {
    manager.close();
    process.chdir(cwd);
    await rm(directory, { recursive: true, force: true });
  });
  await delay(20);
  const sent = () => manager.localRelay.sent;
  const open = url => {
    const socket = manager.relays[url];
    socket.options.onOpen(socket);
    return socket;
  };

  await t.test("an existing single-account store keeps syncing", () => {
    assert.deepEqual(manager.getConnectionStatus().identifiers, [{ identifier: aliceNpub, pubkey: alicePub, firstEventReceived: false }]);
    assert.ok(Object.keys(manager.relays).length > 0);
    const socket = open(Object.keys(manager.relays)[0]);
    assert.deepEqual(socket.sent.at(-1), ["REQ", "backup", { authors: [alicePub] }]);
  });

  await t.test("adding an account resubscribes open relays with both pubkeys", async () => {
    await manager.addIdentifier(` ${bobNpub} `);
    assert.deepEqual(JSON.parse(await readFile("data/store.json", "utf8")), { identifiers: [aliceNpub, bobNpub] });
    const socket = Object.values(manager.relays)[0];
    // Closed first: nostr-rs-relay ignores a REQ that reuses an open subscription id
    assert.deepEqual(socket.sent.slice(-2), [["CLOSE", "backup"], ["REQ", "backup", { authors: [alicePub, bobPub] }]]);
    assert.deepEqual(sent().at(-2), ["CLOSE", "relay-metadata"]);
    assert.deepEqual(sent().at(-1), ["REQ", "relay-metadata", { authors: [alicePub, bobPub], kinds: [0, 3, 10002] }]);
  });

  await t.test("duplicates and invalid addresses are rejected", async () => {
    await assert.rejects(manager.addIdentifier(bobNpub), /already being synced/);
    await assert.rejects(manager.addIdentifier(""), /Enter a NIP-05/);
    await assert.rejects(manager.addIdentifier("npub1invalid"), /Invalid npub/);
    assert.equal(manager.getConnectionStatus().identifiers.length, 2);
  });

  await t.test("events from each account are backed up and tracked separately", () => {
    const relay = Object.values(manager.relays)[0];
    const count = sent().length;
    relay.options.onMessage(["EVENT", "backup", signed(bob, 1, "from bob")]);
    assert.equal(sent().length, count + 1);
    assert.deepEqual(manager.getConnectionStatus().identifiers, [
      { identifier: aliceNpub, pubkey: alicePub, firstEventReceived: false },
      { identifier: bobNpub, pubkey: bobPub, firstEventReceived: true },
    ]);
    relay.options.onMessage(["EVENT", "backup", signed(alice, 1, "from alice")]);
    relay.options.onMessage(["EVENT", "backup", signed(generatePrivateKey(), 1, "stranger")]);
    assert.equal(sent().length, count + 2);
    assert.equal(manager.getConnectionStatus().identifiers[0].firstEventReceived, true);
  });

  await t.test("each account's relay list adds its own relays", () => {
    const relay = Object.values(manager.relays)[0];
    relay.options.onMessage(["EVENT", "backup", signed(alice, 10002, "", [["r", "wss://alice.test"]], 200)]);
    relay.options.onMessage(["EVENT", "backup", signed(bob, 10002, "", [["r", "wss://bob.test"], ["r", "wss://shared.test"]], 200)]);
    relay.options.onMessage(["EVENT", "backup", signed(alice, 3, '{"wss://ignored.test":{}}', [], 300)]);
    assert.deepEqual(manager.desiredRelays().sort(), ["wss://alice.test/", "wss://bob.test/", "wss://shared.test/"]);
    manager.removeOutdatedRelays();
    assert.deepEqual(Object.keys(manager.relays).sort(), ["wss://alice.test/", "wss://bob.test/", "wss://shared.test/"]);
    // Relay lists are kept in the history, each account separately
    assert.deepEqual(manager.history.versions([alicePub])[alicePub].map(event => event.kind), [10002]);
    assert.equal(manager.history.versions([bobPub])[bobPub].length, 1);
    const shared = open("wss://shared.test/");
    assert.deepEqual(shared.sent.at(-1), ["REQ", "backup", { authors: [alicePub, bobPub] }]);
  });

  await t.test("removing one account keeps the other syncing and closes relays only it used", async () => {
    const bobOnly = manager.relays["wss://bob.test/"];
    const aliceRelay = open("wss://alice.test/");
    await manager.removeIdentifier(bobNpub);
    assert.deepEqual(JSON.parse(await readFile("data/store.json", "utf8")), { identifiers: [aliceNpub] });
    assert.deepEqual(manager.history.versions([bobPub]), {});
    assert.ok(bobOnly.closed);
    assert.deepEqual(Object.keys(manager.relays), ["wss://alice.test/"]);
    assert.deepEqual(aliceRelay.sent.at(-1), ["REQ", "backup", { authors: [alicePub] }]);
    const count = sent().length;
    aliceRelay.options.onMessage(["EVENT", "backup", signed(bob, 1, "late bob event")]);
    assert.equal(sent().length, count);
    assert.deepEqual(manager.getConnectionStatus().identifiers, [{ identifier: aliceNpub, pubkey: alicePub, firstEventReceived: true }]);
  });

  await t.test("removing the last account stops syncing and clears the store", async () => {
    const old = Object.values(manager.relays);
    await manager.removeIdentifier(aliceNpub);
    assert.ok(old.every(socket => socket.closed));
    assert.deepEqual(manager.getConnectionStatus(), { identifiers: [], status: "idle", firstEventReceived: false, relayStates: [] });
    await assert.rejects(readFile("data/store.json"), /ENOENT/);
    assert.ok(made.length > 0);
  });
});
