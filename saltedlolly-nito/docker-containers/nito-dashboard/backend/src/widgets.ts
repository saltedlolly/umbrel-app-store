import { rpcCall } from "./rpc.js";
import { syncEtaSeconds } from "./history.js";

export interface BlockchainInfo {
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
  connections_in?: number;
  connections_out?: number;
}

interface MempoolInfo {
  size: number;
  bytes: number;
}

const NETWORK_NAMES: Record<string, string> = {
  main: "mainnet",
  test: "testnet",
  regtest: "regtest",
  signet: "signet",
};

// "/Nito:3.0.1/" -> "3.0.1"
export function nodeVersion(subversion: string): string {
  const match = subversion.match(/:([\w.-]+)/);
  return match ? match[1] : subversion.replace(/\//g, "");
}

export function networkName(chain: string): string {
  return NETWORK_NAMES[chain] ?? chain;
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

// Everything the dashboard's cards need, in one request
export async function getStatus() {
  const [chain, network, mempool, uptime] = await Promise.all([
    rpcCall<BlockchainInfo>("getblockchaininfo"),
    rpcCall<NetworkInfo>("getnetworkinfo"),
    rpcCall<MempoolInfo>("getmempoolinfo"),
    rpcCall<number>("uptime"),
  ]);
  return {
    network: networkName(chain.chain),
    blocks: chain.blocks,
    headers: chain.headers,
    progress: chain.verificationprogress,
    syncing: chain.initialblockdownload,
    syncEtaSeconds: chain.initialblockdownload ? syncEtaSeconds() : null,
    chainSizeBytes: chain.size_on_disk,
    difficulty: chain.difficulty,
    peers: network.connections,
    peersIn: network.connections_in ?? null,
    peersOut: network.connections_out ?? null,
    nodeVersion: nodeVersion(network.subversion),
    mempoolTransactions: mempool.size,
    mempoolBytes: mempool.bytes,
    uptimeSeconds: uptime,
  };
}
