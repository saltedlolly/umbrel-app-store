import { config } from "./config.js";

// NitoFacts ("Did you know..." facts about Nito) for the card under the
// panels. Fetched here rather than in the browser, so the page only talks to
// this Umbrel. Refreshed every 6 hours; the last good copy is kept if the
// site can't be reached.

export interface Fact {
  number: number;
  content: string;
  url: string | null;
}

const REFRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 10 * 60_000;
const cache = { at: 0, facts: [] as Fact[] };

function parse(data: unknown): Fact[] {
  if (!data || typeof data !== "object") return [];
  const facts: Fact[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { content, url } = value as { content?: unknown; url?: unknown };
    if (typeof content !== "string" || !content.trim() || content.length > 2000) continue;
    const number = Number(key.match(/(\d+)$/)?.[1] ?? facts.length + 1);
    // Only plain https links are shown
    const link = typeof url === "string" && /^https:\/\/[^\s"<>]+$/.test(url) ? url : null;
    facts.push({ number, content: content.trim(), url: link });
  }
  return facts.sort((a, b) => a.number - b.number);
}

export async function getFacts(): Promise<Fact[]> {
  const age = Date.now() - cache.at;
  if (age > (cache.facts.length ? REFRESH_MS : RETRY_MS)) {
    cache.at = Date.now();
    try {
      const response = await fetch(config.factsUrl, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const facts = parse(await response.json());
        if (facts.length) cache.facts = facts;
      }
    } catch {
      // Offline: keep what we have and try again later
    }
  }
  return cache.facts;
}
