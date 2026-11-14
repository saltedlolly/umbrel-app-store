import type { Status } from "../api.js";
import { formatBytes, formatNumber, formatUptime, networkLabel } from "../format.js";

function Card({ label, value, detail, accent }: { label: string; value: string; detail?: string; accent?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${accent ?? ""}`}>{value}</div>
      {detail && <div className="stat-detail">{detail}</div>}
    </div>
  );
}

export function StatCards({ status }: { status: Status | null }) {
  const dash = "–";
  const peerDetail =
    status && status.peersIn !== null && status.peersOut !== null
      ? `${status.peersIn} in · ${status.peersOut} out`
      : undefined;
  return (
    <section className="stats" aria-label="Node summary">
      <Card label="Block height" value={status ? formatNumber(status.blocks) : dash} accent="accent" />
      <Card label="Peers" value={status ? formatNumber(status.peers) : dash} detail={peerDetail} />
      <Card
        label="Mempool"
        value={status ? formatNumber(status.mempoolTransactions) : dash}
        detail={status ? `${formatBytes(status.mempoolBytes)} waiting` : undefined}
      />
      <Card label="Chain size" value={status ? formatBytes(status.chainSizeBytes) : dash} />
      <Card label="Uptime" value={status ? formatUptime(status.uptimeSeconds) : dash} />
      <Card label="Version" value={status ? status.nodeVersion : dash} />
      <Card
        label="Chain"
        value={status ? networkLabel(status.network) : dash}
        accent={status ? `chain-text chain-${status.network}` : undefined}
      />
    </section>
  );
}
