import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

// Link previews ("share cards") for links in posts. The browser can't read
// other sites' pages itself, so the relay proxy fetches the page and returns
// its Open Graph title, description and image.
//
// The dashboard can be opened without an Umbrel login (Nostr clients need the
// relay port), so only public web addresses are fetched: never this Umbrel,
// the local network or other private addresses, checked again on every
// redirect and after the DNS lookup.

const TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_CONCURRENT = 4;
const CACHE_SIZE = 1000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const FAILED_CACHE_MS = 60 * 60 * 1000;
const USER_AGENT = "Mozilla/5.0 (compatible; NostrBackupRelay; link preview)";

function ipv4Parts(address) {
  return address.split(".").map(Number);
}

// True for loopback, private, link-local, carrier-grade NAT, multicast and
// other addresses that aren't on the public internet
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = ipv4Parts(address);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower === "::" || lower === "::1" ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      /^ff/.test(lower) // multicast
    );
  }
  return true;
}

// dns.lookup, refusing private addresses (used for every connection, so a
// name that later resolves somewhere private is still refused)
export function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      return callback(new Error(`Not a public address: ${hostname}`));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export function checkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only web links have previews");
  if (url.username || url.password) throw new Error("Links with a login are not previewed");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Only standard web ports are previewed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error("Not a public address");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".")) {
    throw new Error("Not a public address");
  }
  url.hash = "";
  return url;
}

function get(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, {
      lookup: publicLookup,
      timeout: TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    }, response => {
      const { statusCode, headers } = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
        let next;
        try {
          next = checkUrl(new URL(headers.location, url).toString());
        } catch (error) {
          return reject(error);
        }
        return resolve(get(next, redirectsLeft - 1));
      }
      if (statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      const type = String(headers["content-type"] || "");
      if (!/text\/html|application\/xhtml/i.test(type)) {
        response.resume();
        return resolve({ url, type, html: "" });
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        chunks.push(chunk);
        // The share card tags are in <head>; stop once we have enough
        if (size >= MAX_BYTES || /<\/head>/i.test(chunk.toString("latin1"))) response.destroy();
      });
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        const charset = (type.match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
        let html;
        try {
          html = new TextDecoder(charset).decode(Buffer.concat(chunks));
        } catch {
          html = Buffer.concat(chunks).toString("utf8");
        }
        resolve({ url, type, html });
      };
      response.on("end", done);
      response.on("close", done);
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Timed out")));
    request.on("error", reject);
  });
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(value); } catch { return match; }
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function attributes(tag) {
  const result = {};
  for (const [, name, , double, single, bare] of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[name.toLowerCase()] = decodeEntities(double ?? single ?? bare ?? "");
  }
  return result;
}

function clean(text, length) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

// The share card details from a page's <head>
export function parsePreview(html, pageUrl) {
  const meta = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = attrs.content;
  }
  const title = meta["og:title"] || meta["twitter:title"] ||
    decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "");
  let image = meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"] || "";
  try {
    image = image ? new URL(image, pageUrl).toString() : "";
    if (!/^https?:/i.test(image)) image = "";
  } catch {
    image = "";
  }
  const preview = {
    url: pageUrl.toString(),
    title: clean(title, 200),
    description: clean(meta["og:description"] || meta["twitter:description"] || meta.description, 300),
    image,
    siteName: clean(meta["og:site_name"] || pageUrl.hostname.replace(/^www\./, ""), 80),
  };
  return preview.title || preview.description || preview.image ? preview : null;
}

export function createPreviewer({ fetchPage = url => get(url, MAX_REDIRECTS), now = () => Date.now() } = {}) {
  const cache = new Map();
  let running = 0;
  const queue = [];

  async function limited(task) {
    if (running >= MAX_CONCURRENT) await new Promise(resolve => queue.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      queue.shift()?.();
    }
  }

  return async function preview(value) {
    const url = checkUrl(value);
    const key = url.toString();
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.result;
    const result = limited(async () => {
      try {
        const page = await fetchPage(url);
        return page.html ? parsePreview(page.html, page.url) : null;
      } catch {
        return null;
      }
    });
    cache.set(key, { result, expires: now() + CACHE_MS });
    const found = await result;
    if (!found) cache.set(key, { result, expires: now() + FAILED_CACHE_MS });
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return found;
  };
}
