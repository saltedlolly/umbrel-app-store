import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { rpcCall } from "./rpc.js";
import { config } from "./config.js";
import type { BlockchainInfo } from "./widgets.js";
import type { Range } from "./headers.js";

// Things that only exist in the moment, sampled by the dashboard whether or
// not the page is open: the mempool and the node's network traffic (kept for
// 30 days and saved to a file, so they survive restarts and updates), and
// sync progress for the time-left estimate (10 minutes, memory only).
//
// The file has one sample per line. New samples are added to the end every
// 5 minutes (about 200 bytes), and once a day it's rewritten without the
// ones older than 30 days, so it never grows past about 1.7 MB and the disk
// sees about 60 KB of writes a day.

const SAMPLE_MS = 30_000;
const KEEP_EVERY_MS = 60_000; // one saved sample a minute
const KEEP_MS = 30 * 24 * 60 * 60_000;
const SAVE_MS = 5 * 60_000;
const COMPACT_MS = 24 * 60 * 60_000;
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
let unsaved: Sample[] = [];
let fileLines = 0;
const sync: SyncSample[] = [];
let lastKept = 0;
let latest: Sample | null = null;
let saveWarned = false;

function valid(s: unknown): s is Sample {
  return Array.isArray(s) && s.length === 5 && s.every((v) => typeof v === "number" && Number.isFinite(v));
}

async function load() {
  try {
    const text = await readFile(config.historyFile, "utf8");
    const cutoff = Date.now() - KEEP_MS;
    const lines = text.split("\n").filter(Boolean);
    fileLines = lines.length;
    for (const line of lines) {
      try {
        const s = JSON.parse(line) as unknown;
        // A line cut short by a power cut is skipped
        if (valid(s) && s[0] >= cutoff) samples.push(s);
      } catch {
        /* skip */
      }
    }
    samples.sort((a, b) => a[0] - b[0]);
    lastKept = samples[samples.length - 1]?.[0] ?? 0;
    console.log(`Loaded ${samples.length} history samples`);
  } catch {
    // First start, or nothing saved yet
  }
  // Drop old or damaged lines straight away if there are any
  if (fileLines > samples.length) await compact();
}

function warnOnce(err: unknown) {
  if (!saveWarned) {
    console.warn(`Can't save history to ${config.historyFile} (${(err as Error).message}); keeping it in memory only`);
    saveWarned = true;
  }
}

// Add the samples taken since the last save to the end of the file
async function save() {
  if (!unsaved.length) return;
  const batch = unsaved;
  unsaved = [];
  try {
    await mkdir(dirname(config.historyFile), { recursive: true });
    await appendFile(config.historyFile, batch.map((s) => JSON.stringify(s)).join("\n") + "\n");
    fileLines += batch.length;
  } catch (err) {
    warnOnce(err);
  }
}

// Rewrite the file with only the last 30 days
async function compact() {
  try {
    await save();
    await mkdir(dirname(config.historyFile), { recursive: true });
    const tmp = `${config.historyFile}.tmp`;
    await writeFile(tmp, samples.map((s) => JSON.stringify(s)).join("\n") + (samples.length ? "\n" : ""));
    await rename(tmp, config.historyFile);
    fileLines = samples.length;
  } catch (err) {
    warnOnce(err);
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
      unsaved.push(latest);
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
  setInterval(compact, COMPACT_MS).unref();
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
