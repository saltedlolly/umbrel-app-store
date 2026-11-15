import { rpcCall } from "./rpc.js";
import type { BlockchainInfo } from "./widgets.js";

// Short histories kept in memory (they start again when the app restarts):
// the mempool for its sparkline, sync progress for the time-left estimate,
// and the node's network traffic for the last 24 hours

const SAMPLE_MS = 30_000;
const MEMPOOL_SAMPLES = 240; // 2 hours
const SYNC_WINDOW_MS = 10 * 60_000;
const TRAFFIC_WINDOW_MS = 24 * 60 * 60_000;
const TRAFFIC_BUCKET_MS = 10 * 60_000;

export interface MempoolSample {
  time: number;
  transactions: number;
  bytes: number;
}

interface SyncSample {
  time: number;
  progress: number;
}

interface TrafficSample {
  time: number;
  sent: number;
  received: number;
}

export interface TrafficPoint {
  time: number; // end of the 10 minutes
  sent: number; // bytes per second, averaged over the 10 minutes
  received: number;
}

const mempool: MempoolSample[] = [];
const traffic: TrafficSample[] = [];
const sync: SyncSample[] = [];

async function sample() {
  try {
    const [info, chain, totals] = await Promise.all([
      rpcCall<{ size: number; bytes: number }>("getmempoolinfo"),
      rpcCall<BlockchainInfo>("getblockchaininfo"),
      rpcCall<{ totalbytessent: number; totalbytesrecv: number }>("getnettotals"),
    ]);
    const time = Date.now();
    mempool.push({ time, transactions: info.size, bytes: info.bytes });
    if (mempool.length > MEMPOOL_SAMPLES) mempool.shift();
    sync.push({ time, progress: chain.verificationprogress });
    while (sync.length && sync[0].time < time - SYNC_WINDOW_MS) sync.shift();
    traffic.push({ time, sent: totals.totalbytessent, received: totals.totalbytesrecv });
    while (traffic.length && traffic[0].time < time - TRAFFIC_WINDOW_MS) traffic.shift();
  } catch {
    // The node is busy or restarting: try again next time
  }
}

export function startSampling() {
  sample();
  setInterval(sample, SAMPLE_MS).unref();
}

export function mempoolHistory(): MempoolSample[] {
  return mempool;
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

// Upload and download speed in 10-minute steps. The node's counters start
// again from zero when it restarts, so a step across a restart is skipped.
export function trafficHistory() {
  const points: TrafficPoint[] = [];
  let start = traffic[0];
  for (let i = 1; i < traffic.length; i++) {
    const sample = traffic[i];
    if (sample.sent < start.sent || sample.received < start.received) {
      start = sample;
      continue;
    }
    if (sample.time - start.time >= TRAFFIC_BUCKET_MS || i === traffic.length - 1) {
      const seconds = (sample.time - start.time) / 1000;
      if (seconds >= 60) {
        points.push({
          time: sample.time,
          sent: (sample.sent - start.sent) / seconds,
          received: (sample.received - start.received) / seconds,
        });
        start = sample;
      }
    }
  }
  const last = traffic[traffic.length - 1];
  return {
    points,
    // Totals since the node last started
    totalSent: last?.sent ?? null,
    totalReceived: last?.received ?? null,
  };
}
