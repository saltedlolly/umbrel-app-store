// Running version and the latest version in the saltedlolly App Store, for the footer's
// version badge and update notice. The store is checked at most every 10 minutes and any
// failure is silent (latestVersion is then the last value seen, or null).

export const APP_VERSION = process.env.APP_VERSION || "dev";
export const STORE_MANIFEST_URL =
  "https://raw.githubusercontent.com/saltedlolly/umbrel-app-store/master/saltedlolly-nostr-backup-relay/umbrel-app.yml";
export const UPDATE_CHECK_MS = 10 * 60 * 1000;

// Reads the top-level `version:` line of an umbrel-app.yml
export function parseStoreVersion(yml) {
  if (typeof yml !== "string") return null;
  const match = yml.match(/^version:\s*["']?([^"'\s#]+)["']?/m);
  return match ? match[1] : null;
}

// True if version a is newer than b ("v1.2.1.3" style, any number of parts)
export function isNewer(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchText(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

export function createVersionChecker({
  version = APP_VERSION,
  url = STORE_MANIFEST_URL,
  intervalMs = UPDATE_CHECK_MS,
  fetchManifest = fetchText,
  now = Date.now,
} = {}) {
  let latest = null;
  let checkedAt = null;
  let pending = null;

  async function latestVersion() {
    if (checkedAt === null || now() - checkedAt >= intervalMs) {
      checkedAt = now();
      // Concurrent requests share one fetch
      pending ??= fetchManifest(url)
        .then(parseStoreVersion)
        .catch(() => null)
        .finally(() => { pending = null; });
      const found = await pending;
      if (found) latest = found;
    }
    return latest;
  }

  return async function getVersion() {
    const latestFound = await latestVersion();
    return {
      version,
      latestVersion: latestFound,
      updateAvailable: !!latestFound && isNewer(latestFound, version),
    };
  };
}
