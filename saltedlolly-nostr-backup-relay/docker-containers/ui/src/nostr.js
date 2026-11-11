// Small Nostr helpers for the dashboard: npub encoding (NIP-19), profiles (kind 0)
// and the one-line details shown under each action.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) checksum ^= GENERATOR[i];
    }
  }
  return checksum;
}

function toWords(bytes) {
  const words = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >> bits) & 31);
    }
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  return words;
}

// Hex pubkey -> npub1...
export function npubEncode(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) return "";
  const prefix = "npub";
  const words = toWords(hex.match(/../g).map((pair) => parseInt(pair, 16)));
  const expanded = [
    ...[...prefix].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...prefix].map((c) => c.charCodeAt(0) & 31),
  ];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${prefix}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

// npub1na9s...hugv6
export function shortNpub(value) {
  const npub = value?.startsWith("npub1") ? value : npubEncode(value);
  return npub ? `${npub.slice(0, 9)}...${npub.slice(-5)}` : "";
}

export function parseJson(content) {
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

// The newest kind 0 event for each pubkey -> { name, picture, nip05 }
export function latestProfiles(events) {
  const newest = {};
  for (const event of events) {
    if (event.kind !== 0) continue;
    const previous = newest[event.pubkey];
    if (!previous || event.created_at > previous.created_at)
      newest[event.pubkey] = event;
  }
  const profiles = {};
  for (const [pubkey, event] of Object.entries(newest)) {
    const data = parseJson(event.content) || {};
    const text = (value) =>
      typeof value === "string" && value.trim() ? value.trim() : "";
    profiles[pubkey] = {
      name:
        text(data.display_name) || text(data.displayName) || text(data.name),
      picture: /^https:\/\//i.test(text(data.picture))
        ? text(data.picture)
        : "",
      nip05: text(data.nip05),
    };
  }
  return profiles;
}

// "_@olly.st" or "olly.st" -> "@olly.st"; "olly@olly.st" stays as it is
export function formatNip05(value) {
  if (!value || value.startsWith("npub1")) return "";
  if (value.startsWith("_@")) return `@${value.slice(2)}`;
  return value.includes("@") ? value : `@${value}`;
}

// The name shown for an account: its saved NIP-05, then its profile, then its npub
export function accountLabel(account, profile) {
  return (
    formatNip05(account.identifier) ||
    formatNip05(profile?.nip05) ||
    profile?.name ||
    shortNpub(account.pubkey || account.identifier)
  );
}

function tagValues(event, name) {
  return (event.tags || [])
    .filter((tag) => Array.isArray(tag) && tag[0] === name && tag[1])
    .map((tag) => tag[1]);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function listWithMore(items, shown = 3) {
  if (items.length <= shown) return items.join(", ");
  return `${items.slice(0, shown).join(", ")} and ${items.length - shown} more`;
}

// A short line describing an action, or "" when there's nothing useful to add.
// nameFor(pubkey) gives a display name for someone else's pubkey.
export function actionDetail(event, nameFor) {
  const author = () => {
    const pubkey = tagValues(event, "p").at(-1);
    return pubkey ? nameFor(pubkey) : "";
  };
  switch (event.kind) {
    case 0: {
      const data = parseJson(event.content);
      if (!data) return "";
      const fields = [
        ["picture", data.picture],
        ["banner", data.banner],
        ["about", data.about],
        ["NIP-05", data.nip05],
        ["website", data.website],
        ["lightning address", data.lud16 || data.lud06],
      ].filter(([, value]) => typeof value === "string" && value.trim());
      const name = data.display_name || data.displayName || data.name;
      const summary = fields.length
        ? `Includes ${listWithMore(
            fields.map(([label]) => label),
            4,
          )}`
        : "";
      return [typeof name === "string" ? name.trim() : "", summary]
        .filter(Boolean)
        .join(". ");
    }
    case 2:
      return hostOf(event.content.trim());
    case 3:
      return `Following ${plural(tagValues(event, "p").length, "account")}`;
    case 5:
      return `Deleted ${plural(
        tagValues(event, "e").length + tagValues(event, "a").length,
        "item",
      )}`;
    case 6:
    case 16: {
      const reposted = parseJson(event.content);
      const who = author();
      const text =
        typeof reposted?.content === "string" ? reposted.content.trim() : "";
      const prefix = who ? `Reposted ${who}` : "Reposted a post";
      return text ? `${prefix}: "${text.slice(0, 120)}"` : prefix;
    }
    case 7: {
      const content = event.content.trim();
      const reaction =
        content === "" || content === "+"
          ? "Liked"
          : content === "-"
          ? "Disliked"
          : `Reacted ${content}`;
      const who = author();
      return who ? `${reaction} a post by ${who}` : `${reaction} a post`;
    }
    case 9735: {
      try {
        const request = JSON.parse(tagValues(event, "description")[0] || "");
        const amount = (request.tags || []).find((tag) => tag[0] === "amount");
        const sats = amount ? Math.floor(Number(amount[1]) / 1000) : 0;
        return sats > 0 ? `${sats.toLocaleString()} sats` : "";
      } catch {
        return "";
      }
    }
    case 10002: {
      const relays = [...new Set(tagValues(event, "r").map(hostOf))].filter(
        Boolean,
      );
      return relays.length
        ? `${plural(relays.length, "relay")}: ${listWithMore(relays)}`
        : "";
    }
    default:
      return "";
  }
}

// Colours for the placeholder faces: distinct from each other, and dark enough
// for the white face to show in light and dark mode
const FACE_COLORS = [
  "#e11d48",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
  "#0284c7",
  "#4f46e5",
  "#9333ea",
  "#db2777",
  "#65a30d",
];
let accountColors = {};

function hashOf(value = "") {
  // FNV-1a
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

// Gives each synced account its own colour, in the order they were added: each
// takes the colour its pubkey prefers, or the next free one, so adding an
// account never changes the colours of the accounts already there.
export function setAccountColors(pubkeys) {
  const used = new Set();
  const colors = {};
  for (const pubkey of pubkeys) {
    let index = hashOf(pubkey) % FACE_COLORS.length;
    for (let n = 0; n < FACE_COLORS.length && used.has(index); n++)
      index = (index + 1) % FACE_COLORS.length;
    used.add(index);
    colors[pubkey] = FACE_COLORS[index];
  }
  accountColors = colors;
}

// The colour of an account's placeholder face, the same everywhere on the dashboard
export function colorFor(pubkey = "") {
  return (
    accountColors[pubkey] || FACE_COLORS[hashOf(pubkey) % FACE_COLORS.length]
  );
}

// What changed between two versions of a profile (kind 0). Returns null when
// there is no earlier version to compare with.
export function profileChanges(event, previous) {
  if (!previous) return null;
  const now = parseJson(event.content) || {};
  const before = parseJson(previous.content) || {};
  const text = (data, ...keys) => {
    for (const key of keys) {
      if (typeof data[key] === "string" && data[key].trim())
        return data[key].trim();
    }
    return "";
  };
  const image = (data, key) => {
    const value = text(data, key);
    return /^https:\/\//i.test(value) ? value : "";
  };
  const changes = { images: [], texts: [], others: [] };
  for (const [key, label] of [
    ["picture", "Avatar"],
    ["banner", "Banner"],
  ]) {
    const [from, to] = [image(before, key), image(now, key)];
    if (from !== to) changes.images.push({ key, label, from, to });
  }
  for (const [keys, label] of [
    [["display_name", "displayName", "name"], "Name"],
    [["nip05"], "NIP-05"],
  ]) {
    const [from, to] = [text(before, ...keys), text(now, ...keys)];
    if (from !== to) changes.texts.push({ label, from, to });
  }
  for (const [keys, label] of [
    [["about"], "bio"],
    [["website"], "website"],
    [["lud16", "lud06"], "lightning address"],
  ]) {
    if (text(before, ...keys) !== text(now, ...keys))
      changes.others.push(label);
  }
  return changes;
}

function writeRelays(event) {
  return [...new Set(tagValues(event, "r").map(hostOf).filter(Boolean))];
}

// Relays added to and removed from a relay list (kind 10002), or null when
// there is no earlier version to compare with
export function relayChanges(event, previous) {
  if (!previous || event.kind !== 10002) return null;
  const [now, before] = [writeRelays(event), writeRelays(previous)];
  return {
    added: now.filter((relay) => !before.includes(relay)),
    removed: before.filter((relay) => !now.includes(relay)),
  };
}
