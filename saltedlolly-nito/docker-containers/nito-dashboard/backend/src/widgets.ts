import { rpcCall } from "./rpc.js";

interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  verificationprogress: number;
  initialblockdownload: boolean;
  size_on_disk: number;
  difficulty: number;
}

interface NetworkInfo {
  subversion: string;
  connections: number;
}

interface MempoolInfo {
  size: number;
  bytes: number;
}

export async function getSyncWidget() {
  const info = await rpcCall<BlockchainInfo>("getblockchaininfo");
  return {
    blocks: info.blocks,
    headers: info.headers,
    progressPercent: Math.round(info.verificationprogress * 10000) / 100,
    syncing: info.initialblockdownload,
  };
}

export async function getStatsWidget() {
  const [chain, network, mempool] = await Promise.all([
    rpcCall<BlockchainInfo>("getblockchaininfo"),
    rpcCall<NetworkInfo>("getnetworkinfo"),
    rpcCall<MempoolInfo>("getmempoolinfo"),
  ]);
  return {
    chain: chain.chain,
    blockHeight: chain.blocks,
    difficulty: chain.difficulty,
    chainSizeBytes: chain.size_on_disk,
    peerCount: network.connections,
    subversion: network.subversion,
    mempoolTransactions: mempool.size,
    mempoolBytes: mempool.bytes,
  };
}

export async function getUptimeWidget() {
  const seconds = await rpcCall<number>("uptime");
  return { seconds };
}
