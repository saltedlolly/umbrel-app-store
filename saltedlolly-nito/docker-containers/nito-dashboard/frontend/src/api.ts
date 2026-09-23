export interface SyncWidget {
  blocks: number;
  headers: number;
  progressPercent: number;
  syncing: boolean;
}

export interface StatsWidget {
  chain: string;
  blockHeight: number;
  difficulty: number;
  chainSizeBytes: number;
  peerCount: number;
  subversion: string;
  mempoolTransactions: number;
  mempoolBytes: number;
}

export interface UptimeWidget {
  seconds: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  sync: () => getJson<SyncWidget>("/api/widget/sync"),
  stats: () => getJson<StatsWidget>("/api/widget/stats"),
  uptime: () => getJson<UptimeWidget>("/api/widget/uptime"),
};
