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
}

export type Range = "1h" | "24h" | "7d" | "30d";

export interface BlockChartData {
  range: Range;
  ready: boolean;
  blocksPerBar: number;
  averageLabel: string;
  overall: number | null;
  buckets: {
    toHeight: number;
    blocks: number;
    time: number;
    seconds: number;
    transactions: number;
    average: number | null;
  }[];
}

export interface HashrateData {
  range: Range;
  ready: boolean;
  points: { height: number; time: number; hashrate: number }[];
}

export interface MempoolData {
  range: Range;
  points: MempoolSample[];
}

export interface Traffic {
  range: Range;
  points: { time: number; sent: number; received: number }[];
  totalSent: number | null;
  totalReceived: number | null;
}

export interface Fact {
  number: number;
  content: string;
  url: string | null;
}

export interface HardFork {
  show: boolean;
  activationHeight?: number;
  height?: number;
  syncing?: boolean;
  activated?: boolean;
  activatedAt?: number | null;
  remaining?: number;
  averageSeconds?: number | null;
  estimatedAt?: number | null;
  peers?: { total: number; ready: number };
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
  mempool: (range: Range) => getJson<MempoolData>(`/api/mempool-history?range=${range}`),
  blockChart: (range: Range) => getJson<BlockChartData>(`/api/block-chart?range=${range}`),
  hashrate: (range: Range) => getJson<HashrateData>(`/api/hashrate?range=${range}`),
  peers: () => getJson<Peers>("/api/peers"),
  version: () => getJson<VersionInfo>("/api/version"),
  facts: () => getJson<Fact[]>("/api/facts"),
  hardfork: () => getJson<HardFork>("/api/hardfork"),
  mining: () => getJson<Mining>("/api/mining"),
  traffic: (range: Range) => getJson<Traffic>(`/api/traffic?range=${range}`),
};
