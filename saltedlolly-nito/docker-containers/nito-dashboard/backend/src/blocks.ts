import { rpcCall } from "./rpc.js";

// The newest blocks, for the chain strip and the block charts. Kept in memory
// and topped up as blocks arrive, by walking back from the tip until a block
// we already have. A reorganisation replaces the blocks above the one where
// the chains meet.

export const RECENT_BLOCKS = 60;
const REFRESH_MS = 5000;

export interface BlockSummary {
  height: number;
  hash: string;
  time: number;
  transactions: number;
  size: number;
  weight: number;
}

interface RawBlock {
  hash: string;
  height: number;
  time: number;
  nTx: number;
  size: number;
  weight: number;
  previousblockhash?: string;
}

let chain: BlockSummary[] = []; // oldest first
let refreshing: Promise<void> | null = null;

async function refresh() {
  let hash = await rpcCall<string>("getbestblockhash");
  if (chain.length && chain[chain.length - 1].hash === hash) return;

  const fresh: BlockSummary[] = [];
  let joinAt = -1;
  while (fresh.length < RECENT_BLOCKS) {
    joinAt = chain.findIndex((block) => block.hash === hash);
    if (joinAt >= 0) break;
    const block = await rpcCall<RawBlock>("getblock", [hash, 1]);
    fresh.push({
      height: block.height,
      hash: block.hash,
      time: block.time,
      transactions: block.nTx,
      size: block.size,
      weight: block.weight,
    });
    if (!block.previousblockhash) break;
    hash = block.previousblockhash;
  }
  fresh.reverse();
  chain = (joinAt >= 0 ? chain.slice(0, joinAt + 1).concat(fresh) : fresh).slice(-RECENT_BLOCKS);
}

export function refreshBlocks(): Promise<void> {
  refreshing ??= refresh()
    .catch(() => {})
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export function startBlockWatch() {
  refreshBlocks();
  setInterval(refreshBlocks, REFRESH_MS).unref();
}

export function recentBlocks(): BlockSummary[] {
  return chain;
}
