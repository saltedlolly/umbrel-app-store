import { useEffect, useState } from "react";
import { api, type StatsWidget, type SyncWidget, type UptimeWidget } from "./api.js";
import "./app.css";

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function App() {
  const [sync, setSync] = useState<SyncWidget | null>(null);
  const [stats, setStats] = useState<StatsWidget | null>(null);
  const [uptime, setUptime] = useState<UptimeWidget | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [syncData, statsData, uptimeData] = await Promise.all([
          api.sync(),
          api.stats(),
          api.uptime(),
        ]);
        if (cancelled) return;
        setSync(syncData);
        setStats(statsData);
        setUptime(uptimeData);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }

    poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <main>
      <h1>Nito Node</h1>

      {error && <p className="error">Unable to reach the node: {error}</p>}

      <div className="cards">
        <div className="card">
          <h2>Block Height</h2>
          <p className="big">{sync?.blocks ?? "—"}</p>
          {sync?.syncing && (
            <p className="detail">
              Syncing — {sync.progressPercent}% ({sync.blocks} / {sync.headers} headers)
            </p>
          )}
        </div>

        <div className="card">
          <h2>Peers</h2>
          <p className="big">{stats?.peerCount ?? "—"}</p>
        </div>

        <div className="card">
          <h2>Mempool</h2>
          <p className="big">{stats?.mempoolTransactions ?? "—"}</p>
          {stats && <p className="detail">{formatBytes(stats.mempoolBytes)}</p>}
        </div>

        <div className="card">
          <h2>Chain Size</h2>
          <p className="big">{stats ? formatBytes(stats.chainSizeBytes) : "—"}</p>
        </div>

        <div className="card">
          <h2>Uptime</h2>
          <p className="big">{uptime ? formatUptime(uptime.seconds) : "—"}</p>
        </div>

        <div className="card">
          <h2>Version</h2>
          <p className="detail">{stats?.subversion ?? "—"}</p>
          <p className="detail">{stats?.chain ?? "—"}</p>
        </div>
      </div>
    </main>
  );
}
