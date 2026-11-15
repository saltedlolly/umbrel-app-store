import { rpcCall } from "./rpc.js";

// Who found the blocks of the last 24 hours, and the network's hashrate over
// the last 7 days. Both are worked out from the chain itself, so they're
// complete as soon as the node is synced. Nothing is worked out while the
// node is still catching up.

const MINER_WINDOW = 1440; // blocks: about 24 hours at one a minute
const HASH_STEP = 60; // blocks between hashrate points: about an hour
const HASH_POINTS = 168; // 7 days
const REFRESH_MS = 60_000;

interface MinedBlock {
  height: number;
  hash: string;
  miner: string; // pool name, or payout address when the block has none
  named: boolean;
}

interface RawBlock {
  hash: string;
  height: number;
  time: number;
  tx: string[];
  previousblockhash?: string;
}

interface RawTx {
  vin: { coinbase?: string }[];
  vout: { value: number; scriptPubKey: { address?: string } }[];
}

export interface MinerShare {
  miner: string;
  named: boolean;
  blocks: number;
}

export interface HashratePoint {
  height: number;
  time: number;
  hashrate: number;
}

let mined: MinedBlock[] = []; // oldest first
const hashrate = new Map<number, HashratePoint>();
let latestPoint: HashratePoint | null = null;
let running = false;

// The pool's name from the coinbase input, if it has one: the longest run of
// readable text, after the block height that opens every coinbase
export function poolTag(coinbaseHex: string): string | null {
  const bytes = Buffer.from(coinbaseHex, "hex");
  const skip = bytes.length ? 1 + bytes[0] : 0;
  const text = bytes.subarray(skip).toString("latin1");
  let best: string | null = null;
  for (const run of text.match(/[\x20-\x7e]{4,}/g) ?? []) {
    const clean = run.replace(/^[\s/\\|_.-]+|[\s/\\|_.-]+$/g, "");
    if ((clean.match(/[A-Za-z]/g)?.length ?? 0) < 3) continue;
    if (!best || clean.length > best.length) best = clean;
  }
  return best ? best.slice(0, 40) : null;
}

async function minerOf(block: RawBlock): Promise<{ miner: string; named: boolean }> {
  const tx = await rpcCall<RawTx>("getrawtransaction", [block.tx[0], true, block.hash]);
  const tag = tx.vin[0]?.coinbase ? poolTag(tx.vin[0].coinbase) : null;
  if (tag) return { miner: tag, named: true };
  const payout = tx.vout.find((out) => out.value > 0 && out.scriptPubKey.address);
  return { miner: payout?.scriptPubKey.address ?? "Unknown", named: false };
}

async function refreshMiners(tipHash: string) {
  if (mined.length && mined[mined.length - 1].hash === tipHash) return;
  const known = new Map(mined.map((b, i) => [b.hash, i]));
  const fresh: MinedBlock[] = [];
  let hash: string | undefined = tipHash;
  let joinAt = -1;
  while (hash && fresh.length < MINER_WINDOW) {
    joinAt = known.get(hash) ?? -1;
    if (joinAt >= 0) break;
    const block: RawBlock = await rpcCall<RawBlock>("getblock", [hash, 1]);
    fresh.push({ height: block.height, hash: block.hash, ...(await minerOf(block)) });
    hash = block.previousblockhash;
  }
  fresh.reverse();
  mined = (joinAt >= 0 ? mined.slice(0, joinAt + 1).concat(fresh) : fresh).slice(-MINER_WINDOW);
}

async function point(height: number): Promise<HashratePoint> {
  const hash = await rpcCall<string>("getblockhash", [height]);
  const [header, rate] = await Promise.all([
    rpcCall<{ time: number }>("getblockheader", [hash]),
    rpcCall<number>("getnetworkhashps", [HASH_STEP, height]),
  ]);
  return { height, time: header.time, hashrate: rate };
}

async function refreshHashrate(tip: number) {
  const last = Math.floor(tip / HASH_STEP) * HASH_STEP;
  const first = last - (HASH_POINTS - 1) * HASH_STEP;
  for (const height of hashrate.keys()) if (height < first) hashrate.delete(height);
  // Points a few hours back are settled; the newest two can still change
  // if a block near the tip is replaced
  for (let height = Math.max(HASH_STEP, first); height <= last; height += HASH_STEP) {
    if (!hashrate.has(height) || height > last - 2 * HASH_STEP) hashrate.set(height, await point(height));
  }
  latestPoint = tip > last ? await point(tip) : null;
}

async function refresh() {
  if (running) return;
  running = true;
  try {
    const info = await rpcCall<{ blocks: number; bestblockhash: string; initialblockdownload: boolean }>(
      "getblockchaininfo",
    );
    if (info.initialblockdownload || info.blocks < HASH_STEP) return;
    await refreshMiners(info.bestblockhash);
    await refreshHashrate(info.blocks);
  } catch {
    // The node is busy or restarting: try again next time
  } finally {
    running = false;
  }
}

export function startMiningWatch() {
  refresh();
  setInterval(refresh, REFRESH_MS).unref();
}

export function getMining() {
  const counts = new Map<string, MinerShare>();
  for (const block of mined) {
    const share = counts.get(block.miner) ?? { miner: block.miner, named: block.named, blocks: 0 };
    share.blocks++;
    counts.set(block.miner, share);
  }
  const points = [...hashrate.values()].sort((a, b) => a.height - b.height);
  if (latestPoint) points.push(latestPoint);
  return {
    blocks: mined.length,
    fromHeight: mined[0]?.height ?? null,
    toHeight: mined[mined.length - 1]?.height ?? null,
    miners: [...counts.values()].sort((a, b) => b.blocks - a.blocks || a.miner.localeCompare(b.miner)),
    hashrate: points,
  };
}
