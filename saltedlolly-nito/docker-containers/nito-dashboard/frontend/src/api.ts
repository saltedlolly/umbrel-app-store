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
};
