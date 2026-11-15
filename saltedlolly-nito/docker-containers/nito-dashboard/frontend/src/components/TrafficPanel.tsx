import { useCallback } from "react";
import { api, type Peers, type Range } from "../api.js";
import { usePoll, useRange } from "../hooks.js";
import { RangePicker, rangeName } from "./RangePicker.js";
import { formatBytes } from "../format.js";
import { BarList, LineChart } from "./charts.js";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const RANGES = ["1h", "24h", "7d", "30d"] as const;
const when = (range: Range, ms: number) => (range === "1h" || range === "24h" ? clock : dayClock).format(ms);

const rate = (bytesPerSecond: number) => `${formatBytes(bytesPerSecond)}/s`;

// The node's upload and download speed over the last 24 hours (most of the
// upload is blocks and transactions sent to the peers that connect in), and
// the Nito versions those peers run
export function TrafficPanel({ peers }: { peers: Peers | null }) {
  const [range, setRange] = useRange("traffic", RANGES, "24h");
  const fetcher = useCallback(() => api.traffic(range), [range]);
  const { data } = usePoll(fetcher, 60_000);
  const traffic = data?.range === range ? data : null;
  const points = traffic?.points ?? [];
  return (
    <section className="panel charts" aria-label="Your node's traffic and peers">
      <div className="chart-block">
        <div className="chart-head">
          <h2>Your node's traffic</h2>
          <RangePicker value={range} options={RANGES} onChange={setRange} label="Time range for the traffic chart" />
        </div>
        <p className="chart-sub chart-sub-line">
          {rangeName(range)} · <span className="line-key" aria-hidden="true" /> upload ·{" "}
          <span className="line-key line-key-2" aria-hidden="true" /> download
        </p>
        {points.length >= 3 ? (
          <LineChart
            label={`Upload and download speed, ${rangeName(range)}`}
            tone="accent"
            height={160}
            points={points.map((p) => ({
              x: p.time,
              y: p.sent,
              tip: (
                <>
                  <strong>{when(range, p.time)}</strong>
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
          <p className="chart-empty">{traffic ? "Building up: the dashboard records this every minute and keeps 30 days." : "Loading…"}</p>
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
