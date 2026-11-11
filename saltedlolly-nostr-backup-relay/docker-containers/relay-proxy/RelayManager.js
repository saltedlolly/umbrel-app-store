import { getEventHash, validateEvent, verifySignature } from "nostr-tools";
import ReconnectingSocket from "./ReconnectingSocket.js";
import {
  readIdentifiersFromFile,
  writeIdentifiersToFile,
  validateIdentifier,
  getPublicKeyAndRelaysFromIdentifier,
} from "./helpers.js";
import { LOCAL_RELAY_URL, DISCOVERY_STATUS } from "./constants.js";

export function normalizeRelayUrl(value) {
  try {
    const url = new URL(value);
    // Preserve the existing policy of excluding unencrypted/local relay addresses.
    if (url.protocol !== "wss:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function normalizeRelays(relays) {
  return [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))];
}

const DISCOVERY_RETRY_MS = 30000;

// Syncs the activity of one or more accounts (NIP-05 or npub identifiers) from their public relays
// into the local relay. Each public relay has one connection and one "backup" subscription whose
// filter lists every account's pubkey; each account brings its own relays (NIP-05 or default relays,
// then its NIP-65 or Kind 3 relay list).
export default class RelayManager {
  constructor({ createSocket = (url, options) => new ReconnectingSocket(url, options) } = {}) {
    this.createSocket = createSocket;
    this.generation = 0;
    this.discoveryTimers = {};
    this.resetState();
    this.localRelay = this.createSocket(LOCAL_RELAY_URL, {
      onOpen: () => {
        this.subscribeToLocalMetadata();
        // Fetch history again after a local outage, covering events we could not save.
        for (const url of Object.keys(this.relays)) {
          this.closeRelay(url);
          this.connectAndSubscribeToRelay(url);
        }
      },
      onMessage: message => {
        if (message[0] === "EVENT" && message[1] === "relay-metadata") {
          this.handleEvent(message[2], { local: true });
        }
      },
    });
    this.discoverAndConnectToRelays();
  }

  resetState() {
    this.relays = {};
    // { [identifier]: { identifier, pubkey, seedRelays, latestRelays, firstEventReceived } }
    this.accounts = {};
    // identifiers saved in the store, including any whose NIP-05 lookup has not succeeded yet
    this.savedIdentifiers = [];
    this.status = DISCOVERY_STATUS.IDLE;
    this.firstEventReceived = false;
    clearInterval(this.cleanUpRelaysInterval);
    this.cleanUpRelaysInterval = null;
    for (const timer of Object.values(this.discoveryTimers)) clearTimeout(timer);
    this.discoveryTimers = {};
  }

  get pubkeys() {
    return Object.values(this.accounts).map(account => account.pubkey);
  }

  accountForPubkey(pubkey) {
    return Object.values(this.accounts).find(account => account.pubkey === pubkey);
  }

  async discoverAndConnectToRelays() {
    const generation = this.generation;
    try {
      const identifiers = await readIdentifiersFromFile();
      if (generation !== this.generation) return;
      this.savedIdentifiers = identifiers;
      if (identifiers.length === 0) return;
      this.status = DISCOVERY_STATUS.DISCOVERING_RELAYS;
      for (const identifier of identifiers) this.loadAccount(identifier);
      this.startCleanUpInterval();
    } catch (error) {
      console.error("Could not read saved accounts:", error.message);
    }
  }

  // Looks up an account's pubkey and relays, retrying every 30 seconds if the lookup fails
  // (e.g. no internet yet), so one account cannot hold up the others.
  async loadAccount(identifier) {
    const generation = this.generation;
    clearTimeout(this.discoveryTimers[identifier]);
    delete this.discoveryTimers[identifier];
    if (this.accounts[identifier]) return;
    try {
      const { pubkey, relays } = await getPublicKeyAndRelaysFromIdentifier(identifier);
      // The account may have been removed, or everything reset, while we were looking it up
      if (generation !== this.generation || !this.savedIdentifiers.includes(identifier) || this.accounts[identifier]) return;
      this.accounts[identifier] = {
        identifier,
        pubkey,
        seedRelays: normalizeRelays(relays),
        latestRelays: null,
        firstEventReceived: false,
      };
      this.updateSubscriptions();
      for (const url of this.desiredRelays()) this.connectAndSubscribeToRelay(url);
    } catch (error) {
      if (generation !== this.generation || !this.savedIdentifiers.includes(identifier)) return;
      console.error(`Could not discover relays for ${identifier}:`, error.message);
      this.discoveryTimers[identifier] = setTimeout(() => this.loadAccount(identifier), DISCOVERY_RETRY_MS);
    }
  }

  backupFilter() {
    return { authors: this.pubkeys };
  }

  subscribeToLocalMetadata() {
    if (this.pubkeys.length > 0) {
      this.localRelay.send(["REQ", "relay-metadata", { authors: this.pubkeys, kinds: [3, 10002] }]);
    } else {
      this.localRelay.send(["CLOSE", "relay-metadata"]);
    }
  }

  // Called when accounts are added or removed. Sending REQ again with the same subscription id
  // replaces the filter (NIP-01), so open connections start sending the new list of accounts.
  // Relays that are still connecting use the current list when they open.
  updateSubscriptions() {
    this.subscribeToLocalMetadata();
    for (const socket of Object.values(this.relays)) {
      if (this.pubkeys.length > 0) socket.send(["REQ", "backup", this.backupFilter()]);
      else socket.send(["CLOSE", "backup"]);
    }
  }

  connectAndSubscribeToRelay(value) {
    const url = normalizeRelayUrl(value);
    if (!url || this.relays[url] || this.pubkeys.length === 0) return;
    const generation = this.generation;
    this.relays[url] = this.createSocket(url, {
      onOpen: socket => socket.send(["REQ", "backup", this.backupFilter()]),
      onMessage: message => {
        if (generation === this.generation && message[0] === "EVENT" && message[1] === "backup") {
          this.handleEvent(message[2]);
        }
      },
    });
  }

  handleEvent(event, { local = false } = {}) {
    let account;
    try {
      account = this.accountForPubkey(event?.pubkey);
      if (!account || !validateEvent(event) || event.id !== getEventHash(event) || !verifySignature(event)) return;
    } catch { return; }
    this.updateRelayList(account, event);
    if (local) return;
    this.status = DISCOVERY_STATUS.IDLE;
    this.firstEventReceived = true;
    account.firstEventReceived = true;
    this.localRelay.send(["EVENT", event]);
  }

  updateRelayList(account, event) {
    if (event.kind !== 3 && event.kind !== 10002) return;
    const previous = account.latestRelays;
    // NIP-65 is authoritative once available. Legacy contact lists remain a fallback.
    if (previous?.kind === 10002 && event.kind === 3) return;
    if (previous?.kind === event.kind && (event.created_at < previous.timestamp ||
      (event.created_at === previous.timestamp && event.id >= previous.id))) return;

    let relays;
    if (event.kind === 10002) {
      // Back up the author's posts from write relays, including unmarked read/write relays.
      relays = event.tags.filter(tag => tag[0] === "r" && (tag[2] === undefined || tag[2] === "write"))
        .map(tag => tag[1]);
    } else {
      try {
        const list = JSON.parse(event.content);
        if (!list || typeof list !== "object" || Array.isArray(list)) return;
        relays = Object.keys(list).filter(url => list[url]?.write !== false);
      } catch { return; }
    }
    relays = normalizeRelays(relays);
    account.latestRelays = { relays, timestamp: event.created_at, id: event.id, kind: event.kind };
    for (const url of this.desiredRelays()) this.connectAndSubscribeToRelay(url);
  }

  accountRelays(account) {
    // Keep discovery possible when an account has an empty or unusable relay list.
    return account.latestRelays?.relays.length ? account.latestRelays.relays : account.seedRelays;
  }

  desiredRelays() {
    return [...new Set(Object.values(this.accounts).flatMap(account => this.accountRelays(account)))];
  }

  startCleanUpInterval() {
    if (this.cleanUpRelaysInterval) return;
    this.cleanUpRelaysInterval = setInterval(() => this.removeOutdatedRelays(), 60 * 60 * 1000);
  }

  removeOutdatedRelays() {
    const wanted = new Set(this.desiredRelays());
    for (const url of Object.keys(this.relays)) {
      if (!wanted.has(url)) this.closeRelay(url);
    }
  }

  closeRelay(url) {
    this.relays[url]?.close();
    delete this.relays[url];
  }

  getConnectionStatus() {
    const relayStates = Object.values(this.relays).map(relay => ({ url: relay.url, readyState: relay.status }));
    const identifiers = this.savedIdentifiers.map(identifier => ({
      identifier,
      // null until the account's NIP-05 lookup has succeeded
      pubkey: this.accounts[identifier]?.pubkey ?? null,
      firstEventReceived: this.accounts[identifier]?.firstEventReceived ?? false,
    }));
    return { identifiers, status: this.status, firstEventReceived: this.firstEventReceived, relayStates };
  }

  async addIdentifier(identifier) {
    if (typeof identifier !== "string" || !identifier.trim()) throw new Error("Enter a NIP-05 or npub address");
    identifier = identifier.trim();

    const identifiers = await readIdentifiersFromFile();
    if (identifiers.includes(identifier)) throw new Error(`${identifier} is already being synced`);

    await validateIdentifier(identifier);
    // The same account could be entered once as a NIP-05 address and once as an npub
    const { pubkey } = await getPublicKeyAndRelaysFromIdentifier(identifier);
    if (this.accountForPubkey(pubkey)) throw new Error("This account is already being synced");

    const updated = [...identifiers, identifier];
    await writeIdentifiersToFile(updated);
    this.savedIdentifiers = updated;
    this.status = DISCOVERY_STATUS.DISCOVERING_RELAYS;
    await this.loadAccount(identifier);
    this.startCleanUpInterval();
  }

  // Stops syncing one account. With no identifier (older clients), stops syncing all of them.
  async removeIdentifier(identifier) {
    const identifiers = await readIdentifiersFromFile();
    const remaining = identifier ? identifiers.filter(id => id !== identifier) : [];
    await writeIdentifiersToFile(remaining);

    if (remaining.length === 0) {
      ++this.generation;
      for (const url of Object.keys(this.relays)) this.closeRelay(url);
      this.localRelay.send(["CLOSE", "relay-metadata"]);
      this.resetState();
      return;
    }

    clearTimeout(this.discoveryTimers[identifier]);
    delete this.discoveryTimers[identifier];
    delete this.accounts[identifier];
    this.savedIdentifiers = remaining;
    this.firstEventReceived = Object.values(this.accounts).some(account => account.firstEventReceived);
    this.updateSubscriptions();
    // Close relays that only the removed account was using
    this.removeOutdatedRelays();
  }

  close() {
    ++this.generation;
    for (const timer of Object.values(this.discoveryTimers)) clearTimeout(timer);
    clearInterval(this.cleanUpRelaysInterval);
    for (const url of Object.keys(this.relays)) this.closeRelay(url);
    this.localRelay.close();
  }
}
