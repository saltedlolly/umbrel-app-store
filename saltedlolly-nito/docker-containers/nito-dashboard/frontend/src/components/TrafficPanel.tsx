import type { Peers, Traffic } from "../api.js";
import { formatBytes } from "../format.js";
import { BarList, LineChart } from "./charts.js";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const rate = (bytesPerSecond: number) => `${formatBytes(bytesPerSecond)}/s`;

// The node's upload and download speed over the last 24 hours (most of the
// upload is blocks and transactions sent to the peers that connect in), and
// the Nito versions those peers run
export function TrafficPanel({ traffic, peers }: { traffic: Traffic | null; peers: Peers | null }) {
  const points = traffic?.points ?? [];
  return (
    <section className="panel charts" aria-label="Your node's traffic and peers">
      <div className="chart-block">
        <div className="chart-head">
          <h2>Your node's traffic</h2>
          <span className="chart-sub">
            last 24 hours · <span className="line-key" aria-hidden="true" /> upload ·{" "}
            <span className="line-key line-key-2" aria-hidden="true" /> download
          </span>
        </div>
        {points.length >= 3 ? (
          <LineChart
            label="Upload and download speed over the last 24 hours"
            tone="accent"
            height={160}
            points={points.map((p) => ({
              x: p.time,
              y: p.sent,
              tip: (
                <>
                  <strong>{timeFormat.format(p.time)}</strong>
                  <span>
                    Up {rate(p.sent)} · down {rate(p.received)}
                  </span>
                </>
              ),
            }))}
            second={points.map((p) => p.received)}
            format={rate}
          />
        ) : (
          <p className="chart-empty">Collecting… this chart fills in over the next half hour.</p>
        )}
        {traffic && traffic.totalSent !== null && traffic.totalReceived !== null && (
          <p className="traffic-totals">
            Since your node started: <strong>{formatBytes(traffic.totalSent)}</strong> uploaded,{" "}
            <strong>{formatBytes(traffic.totalReceived)}</strong> downloaded
          </p>
        )}
      </div>
      {peers && peers.versions.length > 0 && (
        <div className="chart-block">
          <div className="chart-head">
            <h2>Peer versions</h2>
            <span className="chart-sub">the Nito version each peer runs</span>
          </div>
          <BarList
            label="How many peers run each Nito version"
            rows={peers.versions.map((v) => ({
              key: v.version,
              label: /^\d/.test(v.version) ? `Nito ${v.version}` : v.version,
              value: v.peers,
              detail: String(v.peers),
            }))}
          />
        </div>
      )}
    </section>
  );
}
