import { config } from "./config.js";

// The running version, and whether the app store has a newer one (checked at
// most every 10 minutes; the page asks every 5)

const CHECK_MS = 10 * 60_000;
const store = { at: 0, latest: null as string | null };

async function latestStoreVersion(): Promise<string | null> {
  if (Date.now() - store.at > CHECK_MS) {
    store.at = Date.now();
    try {
      const response = await fetch(config.storeManifestUrl, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const match = (await response.text()).match(/^version:\s*"?([^"\s]+)"?/m);
        if (match) store.latest = match[1];
      }
    } catch {
      // Offline: try again next time
    }
  }
  return store.latest;
}

// True if version a is newer than b ("v3.0.1.4" style, any number of parts)
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function getVersion() {
  const latest = await latestStoreVersion();
  return {
    version: config.appVersion,
    latestVersion: latest,
    updateAvailable: !!latest && isNewer(latest, config.appVersion),
  };
}
