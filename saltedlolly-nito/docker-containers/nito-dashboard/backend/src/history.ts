import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { rpcCall } from "./rpc.js";
import { config } from "./config.js";
import type { BlockchainInfo } from "./widgets.js";
import type { Range } from "./headers.js";

// Things that only exist in the moment, sampled by the dashboard whether or
// not the page is open: the mempool and the node's network traffic (kept for
// 30 days and saved to a file, so they survive restarts and updates), and
// sync progress for the time-left estimate (10 minutes, memory only).

const SAMPLE_MS = 30_000;
const KEEP_EVERY_MS = 60_000; // one saved sample a minute
const KEEP_MS = 30 * 24 * 60 * 60_000;
const SAVE_MS = 5 * 60_000;
const SYNC_WINDOW_MS = 10 * 60_000;

// Bar or point size per range
const BUCKET_MS: Record<Range, number> = {
  "1h": 2 * 60_000,
  "24h": 15 * 60_000,
  "7d": 60 * 60_000,
  "30d": 6 * 60 * 60_000,
};
const RANGE_MS: Record<Range, number> = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

// [time, mempool transactions, mempool bytes, total bytes sent, total bytes received]
type Sample = [number, number, number, number, number];

interface SyncSample {
  time: number;
  progress: number;
}

let samples: Sample[] = [];
const sync: SyncSample[] = [];
let lastKept = 0;
let latest: Sample | null = null;
let saveWarned = false;

async function load() {
  try {
    const data = JSON.parse(await readFile(config.historyFile, "utf8")) as { version: number; samples: Sample[] };
    if (data.version === 1 && Array.isArray(data.samples)) {
      const cutoff = Date.now() - KEEP_MS;
      samples = data.samples.filter((s) => Array.isArray(s) && s.length === 5 && s[0] >= cutoff);
      lastKept = samples[samples.length - 1]?.[0] ?? 0;
      console.log(`Loaded ${samples.length} history samples`);
    }
  } catch {
    // First start, or nothing saved yet
  }
}

async function save() {
  try {
    await mkdir(dirname(config.historyFile), { recursive: true });
    const tmp = `${config.historyFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, samples }));
    await rename(tmp, config.historyFile);
  } catch (err) {
    if (!saveWarned) {
      console.warn(`Can't save history to ${config.historyFile} (${(err as Error).message}); keeping it in memory only`);
      saveWarned = true;
    }
  }
}

async function sample() {
  try {
    const [mempool, chain, totals] = await Promise.all([
      rpcCall<{ size: number; bytes: number }>("getmempoolinfo"),
      rpcCall<BlockchainInfo>("getblockchaininfo"),
      rpcCall<{ totalbytessent: number; totalbytesrecv: number }>("getnettotals"),
    ]);
    const time = Date.now();
    latest = [time, mempool.size, mempool.bytes, totals.totalbytessent, totals.totalbytesrecv];
    if (time - lastKept >= KEEP_EVERY_MS - 5000) {
      samples.push(latest);
      lastKept = time;
      while (samples.length && samples[0][0] < time - KEEP_MS) samples.shift();
    }
    sync.push({ time, progress: chain.verificationprogress });
    while (sync.length && sync[0].time < time - SYNC_WINDOW_MS) sync.shift();
  } catch {
    // The node is busy or restarting: try again next time
  }
}

export async function startSampling() {
  await load();
  sample();
  setInterval(sample, SAMPLE_MS).unref();
  setInterval(save, SAVE_MS).unref();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      save().finally(() => process.exit(0));
    });
  }
}

function inRange(range: Range): Sample[] {
  const cutoff = Date.now() - RANGE_MS[range];
  const list = samples.filter((s) => s[0] >= cutoff);
  if (latest && (!list.length || latest[0] > list[list.length - 1][0])) list.push(latest);
  return list;
}

// The most transactions waiting at any sample in each bar
export function mempoolHistory(range: Range) {
  const size = BUCKET_MS[range];
  const buckets = new Map<number, { time: number; transactions: number; bytes: number }>();
  for (const [time, transactions, bytes] of inRange(range)) {
    const key = Math.floor(time / size);
    const b = buckets.get(key);
    if (!b || transactions > b.transactions) buckets.set(key, { time: (key + 1) * size, transactions, bytes });
  }
  return { range, points: [...buckets.values()].sort((a, b) => a.time - b.time) };
}

// Average upload and download speed in each bar. The node's counters start
// again from zero when it restarts, and the dashboard misses samples while
// it's stopped, so only steps between close, increasing samples count.
export function trafficHistory(range: Range) {
  const size = BUCKET_MS[range];
  const list = inRange(range);
  const buckets = new Map<number, { sent: number; received: number; seconds: number }>();
  for (let i = 1; i < list.length; i++) {
    const [t0, , , s0, r0] = list[i - 1];
    const [t1, , , s1, r1] = list[i];
    const seconds = (t1 - t0) / 1000;
    if (seconds <= 0 || seconds > 5 * 60 || s1 < s0 || r1 < r0) continue;
    const key = Math.floor(t1 / size);
    const b = buckets.get(key) ?? { sent: 0, received: 0, seconds: 0 };
    b.sent += s1 - s0;
    b.received += r1 - r0;
    b.seconds += seconds;
    buckets.set(key, b);
  }
  const points = [...buckets.entries()]
    .filter(([, b]) => b.seconds >= 30)
    .sort(([a], [b]) => a - b)
    .map(([key, b]) => ({ time: Math.min((key + 1) * size, Date.now()), sent: b.sent / b.seconds, received: b.received / b.seconds }));
  return {
    range,
    points,
    // Totals since the node last started
    totalSent: latest?.[3] ?? null,
    totalReceived: latest?.[4] ?? null,
  };
}

// Seconds until the sync finishes at the rate of the last 10 minutes, or null
// until there's enough to go on
export function syncEtaSeconds(): number | null {
  if (sync.length < 4) return null;
  const first = sync[0];
  const last = sync[sync.length - 1];
  const rate = (last.progress - first.progress) / ((last.time - first.time) / 1000);
  if (!(rate > 0)) return null;
  return Math.round((1 - last.progress) / rate);
}
