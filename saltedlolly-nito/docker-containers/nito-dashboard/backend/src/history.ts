import { rpcCall } from "./rpc.js";
import type { BlockchainInfo } from "./widgets.js";

// Short histories kept in memory (they start again when the app restarts):
// the mempool for its sparkline, and sync progress for the time-left estimate

const SAMPLE_MS = 30_000;
const MEMPOOL_SAMPLES = 240; // 2 hours
const SYNC_WINDOW_MS = 10 * 60_000;

export interface MempoolSample {
  time: number;
  transactions: number;
  bytes: number;
}

interface SyncSample {
  time: number;
  progress: number;
}

const mempool: MempoolSample[] = [];
const sync: SyncSample[] = [];

async function sample() {
  try {
    const [info, chain] = await Promise.all([
      rpcCall<{ size: number; bytes: number }>("getmempoolinfo"),
      rpcCall<BlockchainInfo>("getblockchaininfo"),
    ]);
    const time = Date.now();
    mempool.push({ time, transactions: info.size, bytes: info.bytes });
    if (mempool.length > MEMPOOL_SAMPLES) mempool.shift();
    sync.push({ time, progress: chain.verificationprogress });
    while (sync.length && sync[0].time < time - SYNC_WINDOW_MS) sync.shift();
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
