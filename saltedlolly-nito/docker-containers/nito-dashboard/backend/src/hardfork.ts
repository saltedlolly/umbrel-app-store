import { rpcCall } from "./rpc.js";
import { averageBlockSeconds } from "./headers.js";

// The Orchard hard fork (Nito Core v4.0.0): the activation height and
// whether it has happened come from the node, the estimate from the pace of
// the last 1,440 blocks (as nito.network does), and readiness from this
// node's own peers: a peer that supports it advertises the NITO_PRIVATE
// service (protocol 70017 or later). Shown until 30 days after activation.

const SHOW_AFTER_MS = 30 * 24 * 60 * 60_000;
const TARGET_SECONDS = 60;
const CACHE_MS = 15_000;

interface ChainInfo {
  blocks: number;
  headers: number;
  initialblockdownload: boolean;
  privateTxActivationHeight?: number;
  activated?: boolean;
}

interface PeerInfo {
  version?: number;
  servicesnames?: string[];
}

let cached: { at: number; value: unknown } | null = null;
let activationTime: { height: number; time: number } | null = null;

async function blockTime(height: number): Promise<number> {
  if (activationTime?.height === height) return activationTime.time;
  const hash = await rpcCall<string>("getblockhash", [height]);
  const header = await rpcCall<{ time: number }>("getblockheader", [hash]);
  activationTime = { height, time: header.time };
  return header.time;
}

export async function getHardFork() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const [chain, peers] = await Promise.all([
    rpcCall<ChainInfo>("getblockchaininfo"),
    rpcCall<PeerInfo[]>("getpeerinfo"),
  ]);
  const activationHeight = chain.privateTxActivationHeight;
  let value: unknown;
  if (activationHeight === undefined) {
    // An older node that doesn't know about the fork
    value = { show: false };
  } else {
    const ready = peers.filter((p) => p.servicesnames?.includes("NITO_PRIVATE") || (p.version ?? 0) >= 70017).length;
    const activated = chain.activated ?? chain.blocks >= activationHeight;
    const average = averageBlockSeconds(1440);
    // While catching up, count from the network's height (the headers the
    // node already has), not from how far the node itself has got
    const networkHeight = Math.max(chain.blocks, chain.headers);
    const remaining = Math.max(0, activationHeight - networkHeight);
    const activatedAt = activated && chain.blocks >= activationHeight ? await blockTime(activationHeight) : null;
    value = {
      show: !activatedAt || Date.now() - activatedAt * 1000 < SHOW_AFTER_MS,
      activationHeight,
      height: networkHeight,
      syncing: chain.initialblockdownload,
      activated,
      activatedAt,
      remaining,
      averageSeconds: average,
      // While syncing (or before the headers load) the estimate uses the
      // 60-second target instead
      estimatedAt: activated
        ? null
        : Math.round(Date.now() / 1000 + remaining * (average && !chain.initialblockdownload ? average : TARGET_SECONDS)),
      peers: { total: peers.length, ready },
    };
  }
  cached = { at: Date.now(), value };
  return value;
}
