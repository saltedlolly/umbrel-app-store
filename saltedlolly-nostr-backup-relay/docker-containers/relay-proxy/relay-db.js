import { DatabaseSync } from "node:sqlite";

// Direct access to the relay's SQLite database, to delete what the relay
// itself can't: events from accounts that aren't synced (Nostr deletion
// requests only work for the author's own events). The relay keeps running;
// the database is in WAL mode, so this waits briefly if the relay is writing.
export const RELAY_DB = process.env.RELAY_DB_PATH || "/app/relay-db/nostr.db";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

function open(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
  return db;
}

// Deletes every event whose author isn't in keepPubkeys (or, with author,
// only that author's events, which must not be a kept pubkey). Tags go with
// their events. Returns the number of events deleted.
export function deleteEventsNotBy(keepPubkeys, { author, file = RELAY_DB } = {}) {
  if (!keepPubkeys.every(pubkey => HEX_PUBKEY.test(pubkey))) throw new Error("Invalid pubkey");
  if (author !== undefined && (!HEX_PUBKEY.test(author) || keepPubkeys.includes(author))) {
    throw new Error("That account is synced; remove it from Sync from public relays first");
  }
  const db = open(file);
  try {
    let statement;
    if (author) {
      statement = db.prepare("DELETE FROM event WHERE author = ?");
      return Number(statement.run(Buffer.from(author, "hex")).changes);
    }
    const placeholders = keepPubkeys.map(() => "?").join(", ");
    statement = db.prepare(
      keepPubkeys.length ? `DELETE FROM event WHERE author NOT IN (${placeholders})` : "DELETE FROM event",
    );
    return Number(statement.run(...keepPubkeys.map(pubkey => Buffer.from(pubkey, "hex"))).changes);
  } finally {
    db.close();
  }
}
