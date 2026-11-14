import type { Status } from "../api.js";
import { formatDuration, formatNumber } from "../format.js";

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Shown instead of the chain strip while the node is catching up
export function SyncRing({ status }: { status: Status }) {
  const percent = Math.min(100, Math.max(0, status.progress * 100));
  const left = Math.max(0, status.headers - status.blocks);
  return (
    <section className="hero sync-hero" aria-label="Sync progress">
      <div className="sync-ring" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(percent)}>
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <linearGradient id="sync-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="var(--gold)" />
            </linearGradient>
          </defs>
          <circle className="sync-track" cx="60" cy="60" r={RADIUS} />
          <circle
            className="sync-bar"
            cx="60"
            cy="60"
            r={RADIUS}
            stroke="url(#sync-gradient)"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
          />
        </svg>
        <div className="sync-center">
          <div className="sync-percent">
            {percent < 10 ? percent.toFixed(2) : percent.toFixed(1)}
            <span>%</span>
          </div>
          <div className="sync-caption">synced</div>
        </div>
      </div>
      <div className="sync-text">
        <h2>Catching up with the Nito network</h2>
        <p>
          Your node is downloading and checking every block since Nito began. It's fully usable once it has caught
          up.
        </p>
        <dl className="sync-facts">
          <div>
            <dt>Block</dt>
            <dd>
              {formatNumber(status.blocks)} <span>of {formatNumber(status.headers)}</span>
            </dd>
          </div>
          <div>
            <dt>Blocks to go</dt>
            <dd>{formatNumber(left)}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd>{status.syncEtaSeconds !== null ? `about ${formatDuration(status.syncEtaSeconds)}` : "Estimating…"}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
