export interface Status {
  network: string;
  blocks: number;
  headers: number;
  progress: number;
  syncing: boolean;
  syncEtaSeconds: number | null;
  chainSizeBytes: number;
  difficulty: number;
  peers: number;
  peersIn: number | null;
  peersOut: number | null;
  nodeVersion: string;
  mempoolTransactions: number;
  mempoolBytes: number;
  uptimeSeconds: number;
}

export interface Block {
  height: number;
  hash: string;
  time: number;
  transactions: number;
  size: number;
  weight: number;
}

export interface MempoolSample {
  time: number;
  transactions: number;
  bytes: number;
}

export interface Peers {
  total: number;
  inbound: number;
  outbound: number;
  countries: { code: string; peers: number }[];
  notLocated: number;
  versions: { version: string; peers: number }[];
}

export interface Mining {
  blocks: number;
  fromHeight: number | null;
  toHeight: number | null;
  miners: { miner: string; named: boolean; blocks: number }[];
  hashrate: { height: number; time: number; hashrate: number }[];
}

export interface Traffic {
  points: { time: number; sent: number; received: number }[];
  totalSent: number | null;
  totalReceived: number | null;
}

export interface Fact {
  number: number;
  content: string;
  url: string | null;
}

export interface VersionInfo {
  version: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => getJson<Status>("/api/status"),
  blocks: () => getJson<Block[]>("/api/blocks"),
  mempool: () => getJson<MempoolSample[]>("/api/mempool-history"),
  peers: () => getJson<Peers>("/api/peers"),
  version: () => getJson<VersionInfo>("/api/version"),
  facts: () => getJson<Fact[]>("/api/facts"),
  mining: () => getJson<Mining>("/api/mining"),
  traffic: () => getJson<Traffic>("/api/traffic"),
};
