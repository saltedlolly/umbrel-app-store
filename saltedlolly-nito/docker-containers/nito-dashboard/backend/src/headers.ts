import { rpcBatch, rpcCall } from "./rpc.js";

// Block headers for the last 30 days (plus a margin for the averages), read
// from the node in batches and topped up as blocks arrive. They give the
// time between blocks, transactions per block and the network hashrate for
// any of the time ranges, without saving anything: the chain is the record.

interface Header {
  height: number;
  hash: string;
  time: number;
  nTx: number;
  chainwork: bigint;
}

interface RawHeader {
  hash: string;
  height: number;
  time: number;
  nTx: number;
  chainwork: string;
}

export type Range = "1h" | "24h" | "7d" | "30d";
export const RANGES: Range[] = ["1h", "24h", "7d", "30d"];

// Blocks per range (one a minute), blocks per bar, and the moving average
const BLOCK_RANGES: Record<Range, { blocks: number; bucket: number; average: number; averageLabel: string }> = {
  "1h": { blocks: 60, bucket: 1, average: 10, averageLabel: "10-block average" },
  "24h": { blocks: 1440, bucket: 15, average: 120, averageLabel: "2-hour average" },
  "7d": { blocks: 10080, bucket: 60, average: 1440, averageLabel: "1-day average" },
  "30d": { blocks: 43200, bucket: 360, average: 4320, averageLabel: "3-day average" },
};

// Hashrate: a point every `step` blocks, each over the last `window` blocks
const HASH_RANGES: Record<Exclude<Range, "1h">, { blocks: number; step: number; window: number }> = {
  "24h": { blocks: 1440, step: 15, window: 60 },
  "7d": { blocks: 10080, step: 60, window: 60 },
  "30d": { blocks: 43200, step: 360, window: 360 },
};

const KEEP = 43200 + 4320 + 1; // the longest range plus its average
const RECHECK = 10; // newest headers read again each time, in case of a reorg
const BATCH = 2000;
const REFRESH_MS = 30_000;

let base = 0; // height of headers[0]
let headers: Header[] = [];
let running = false;
let ready = false;

async function fetchHeaders(heights: number[]): Promise<Header[]> {
  const out: Header[] = [];
  for (let i = 0; i < heights.length; i += BATCH) {
    const chunk = heights.slice(i, i + BATCH);
    const hashes = await rpcBatch<string>(chunk.map((h) => ({ method: "getblockhash", params: [h] })));
    const raws = await rpcBatch<RawHeader>(hashes.map((hash) => ({ method: "getblockheader", params: [hash] })));
    for (const raw of raws) {
      out.push({ height: raw.height, hash: raw.hash, time: raw.time, nTx: raw.nTx, chainwork: BigInt(`0x${raw.chainwork}`) });
    }
  }
  return out;
}

async function refresh() {
  if (running) return;
  running = true;
  try {
    const info = await rpcCall<{ blocks: number; initialblockdownload: boolean }>("getblockchaininfo");
    if (info.initialblockdownload) return;
    const tip = info.blocks;
    const from = Math.max(0, tip - KEEP + 1);
    const top = headers.length ? base + headers.length - 1 : -1;
    // Keep what's still in range and below the recheck zone
    const keepUpTo = Math.min(top, tip) - RECHECK;
    const kept = headers.filter((h) => h.height >= from && h.height <= keepUpTo);
    const have = new Set(kept.map((h) => h.height));
    const missing: number[] = [];
    for (let h = from; h <= tip; h++) if (!have.has(h)) missing.push(h);
    const fresh = await fetchHeaders(missing);
    headers = [...kept, ...fresh].sort((a, b) => a.height - b.height);
    base = headers[0]?.height ?? 0;
    ready = true;
  } catch {
    // The node is busy or restarting: try again next time
  } finally {
    running = false;
  }
}

export function startHeaderWatch() {
  refresh();
  setInterval(refresh, REFRESH_MS).unref();
}

const at = (height: number): Header | undefined => headers[height - base];

export interface BlockBucket {
  toHeight: number;
  blocks: number;
  time: number; // time of the last block in the bar
  seconds: number; // average time between blocks
  transactions: number; // average transactions per block
  average: number | null; // moving average of the time between blocks
}

export function blockChart(range: Range) {
  const spec = BLOCK_RANGES[range];
  const tip = headers.length ? base + headers.length - 1 : 0;
  const buckets: BlockBucket[] = [];
  if (ready) {
    const first = tip - spec.blocks; // the block before the range
    for (let end = tip; end - spec.bucket >= first; end -= spec.bucket) {
      const start = at(end - spec.bucket);
      const last = at(end);
      if (!start || !last) break;
      let tx = 0;
      for (let h = end - spec.bucket + 1; h <= end; h++) tx += at(h)?.nTx ?? 0;
      const back = at(end - spec.average);
      buckets.push({
        toHeight: end,
        blocks: spec.bucket,
        time: last.time,
        seconds: Math.max(0, (last.time - start.time) / spec.bucket),
        transactions: tx / spec.bucket,
        average: back ? (last.time - back.time) / spec.average : null,
      });
    }
    buckets.reverse();
  }
  const firstHeader = at(tip - spec.blocks);
  const lastHeader = at(tip);
  return {
    range,
    ready,
    blocksPerBar: spec.bucket,
    averageLabel: spec.averageLabel,
    // Average time between blocks over the whole range
    overall: firstHeader && lastHeader ? (lastHeader.time - firstHeader.time) / spec.blocks : null,
    buckets,
  };
}

export function hashrateChart(range: Exclude<Range, "1h">) {
  const spec = HASH_RANGES[range];
  const tip = headers.length ? base + headers.length - 1 : 0;
  const points: { height: number; time: number; hashrate: number }[] = [];
  if (ready) {
    for (let end = tip; end > tip - spec.blocks; end -= spec.step) {
      const last = at(end);
      const start = at(end - spec.window);
      if (!last || !start) break;
      const seconds = last.time - start.time;
      if (seconds <= 0) continue;
      points.push({ height: end, time: last.time, hashrate: Number(last.chainwork - start.chainwork) / seconds });
    }
    points.reverse();
  }
  return { range, ready, points };
}

// Average seconds per block over the last `blocks` blocks, or null until the
// headers are loaded
export function averageBlockSeconds(blocks = 1440): number | null {
  if (!ready || !headers.length) return null;
  const tip = base + headers.length - 1;
  const last = at(tip);
  const first = at(tip - blocks);
  if (!last || !first) return null;
  return (last.time - first.time) / blocks;
}
