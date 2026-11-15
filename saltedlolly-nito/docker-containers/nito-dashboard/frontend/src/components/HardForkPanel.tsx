import type { HardFork } from "../api.js";
import { formatNumber } from "../format.js";
import { useNow } from "../hooks.js";

const LEARN_URL = "https://nito.network/en/network/#orchard";
const NOTES_URL = "https://github.com/NitoNetwork/Nito-core/releases/tag/v4.0.0";
const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const shortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });

function daysAgo(seconds: number): string {
  const days = Math.floor(Math.max(0, seconds) / 86400);
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function Countdown({ seconds }: { seconds: number }) {
  const s = Math.max(0, Math.floor(seconds));
  const parts = [
    { value: Math.floor(s / 86400), label: "days" },
    { value: Math.floor((s % 86400) / 3600), label: "hours" },
    { value: Math.floor((s % 3600) / 60), label: "min" },
    { value: s % 60, label: "sec" },
  ];
  return (
    <div className="fork-countdown" role="timer" aria-label="Estimated time until the hard fork">
      {parts.map((p) => (
        <div key={p.label} className="fork-unit">
          <span className="fork-num">{p.label === "days" ? p.value : String(p.value).padStart(2, "0")}</span>
          <span className="fork-label">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

function PeerSupport({ peers }: { peers: HardFork["peers"] }) {
  if (!peers || peers.total === 0) return <p className="fork-note">No peers connected yet.</p>;
  const pct = Math.round((peers.ready / peers.total) * 100);
  return (
    <div className="fork-peers">
      <div className="fork-peers-head">
        <span>Your peers already running v4</span>
        <strong>{pct}%</strong>
      </div>
      <div className="fork-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="fork-note">
        {peers.ready} of {peers.total} nodes connected to yours support Orchard
      </p>
    </div>
  );
}

// The Orchard hard fork: what it adds, a countdown, how many peers are ready,
// then for 30 days after activation, that it happened
export function HardForkPanel({ fork }: { fork: HardFork | null }) {
  const now = useNow(1000) / 1000;
  if (!fork || !fork.show || fork.activationHeight === undefined) return null;
  const live = fork.activated && fork.activatedAt !== null;

  return (
    <section className={`panel fork ${live ? "fork-live" : ""}`} aria-label="Orchard hard fork">
      <div className="fork-main">
        <div className="chart-head">
          <h2>{live ? "Upgrade complete" : "Upcoming network upgrade"}</h2>
          <span className="fork-chip">Hard fork · block {formatNumber(fork.activationHeight)}</span>
        </div>
        <h3 className="fork-title">{live ? "Orchard private transfers are live" : "Orchard: optional private transfers"}</h3>
        <p className="fork-text">
          {live ? "Since" : "At"} block {formatNumber(fork.activationHeight)}, Nito {live ? "has" : "adds"} Orchard, a way
          to send NITO privately. A fully private transfer hides who sent it, who received it and how much, while every
          node can still check it follows the rules. Private funds use a new address type, Bech32x, starting with{" "}
          <code>nito1x</code>. It's optional: ordinary transfers, mining and block rewards carry on as before.
        </p>
        <p className="fork-ready">
          <span className="fork-tick" aria-hidden="true">✓</span> Your node runs Nito 4, so it's ready
          {live ? " and following the upgraded network." : ". Nothing else to do."}
        </p>
        <p className="fork-links">
          <a href={LEARN_URL} target="_blank" rel="noopener noreferrer">
            Learn about Orchard and Bech32x
          </a>
          <span aria-hidden="true">·</span>
          <a href={NOTES_URL} target="_blank" rel="noopener noreferrer">
            Nito Core 4.0.0 release notes
          </a>
        </p>
      </div>

      <div className="fork-side">
        {live ? (
          <>
            <div className="fork-done">
              <span className="fork-done-label">Activated</span>
              <strong>{shortDate.format(fork.activatedAt! * 1000)}</strong>
              <span className="fork-note">
                block {formatNumber(fork.activationHeight)} · {daysAgo(now - fork.activatedAt!)}
              </span>
            </div>
            <PeerSupport peers={fork.peers} />
          </>
        ) : (
          <>
            <Countdown seconds={(fork.estimatedAt ?? now) - now} />
            <p className="fork-eta">
              {formatNumber(fork.remaining ?? 0)} blocks to go · expected around{" "}
              <strong>{longDate.format((fork.estimatedAt ?? now) * 1000)}</strong>
            </p>
            <p className="fork-note">
              {fork.syncing || fork.averageSeconds == null
                ? "Estimated at one block a minute until your node has caught up."
                : `Estimated from the last 1,440 blocks (${Math.round(fork.averageSeconds)}s each on average), so it moves a little as the pace changes.`}
            </p>
            <PeerSupport peers={fork.peers} />
          </>
        )}
      </div>
    </section>
  );
}
