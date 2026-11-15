import { useCallback } from "react";
import { api, type Range } from "../api.js";
import { formatBytes, formatNumber } from "../format.js";
import { usePoll, useRange } from "../hooks.js";
import { BarChart, LineChart } from "./charts.js";
import { RangePicker, rangeName } from "./RangePicker.js";

const RANGES = ["1h", "24h", "7d", "30d"] as const;
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function compact(value: number): string {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`;
  return `${+value.toFixed(1)}`;
}

const when = (range: Range, ms: number) => (range === "1h" || range === "24h" ? clock : dayClock).format(ms);

// Time between blocks, transactions per block and the mempool, all for the
// range picked at the top of the panel
export function BlockCharts() {
  const [range, setRange] = useRange("blocks", RANGES, "1h");
  const blockFetch = useCallback(() => api.blockChart(range), [range]);
  const mempoolFetch = useCallback(() => api.mempool(range), [range]);
  const blocks = usePoll(blockFetch, range === "1h" ? 5000 : 30_000);
  const mempool = usePoll(mempoolFetch, 30_000);
  const chart = blocks.data?.range === range ? blocks.data : null;
  const pool = mempool.data?.range === range ? mempool.data.points : null;
  const buckets = chart?.buckets ?? [];
  const single = chart?.blocksPerBar === 1;
  const waiting = chart && !chart.ready ? "Worked out once your node has caught up…" : "Loading…";

  return (
    <section className="panel charts" aria-label="Block charts">
      <div className="chart-block">
        <div className="chart-head">
          <h2>Time between blocks</h2>
          <RangePicker value={range} options={RANGES} onChange={setRange} label="Time range for the block charts" />
        </div>
        <p className="chart-sub chart-sub-line">
          {rangeName(range)}
          {chart?.overall != null && (
            <>
              {" "}
              · averaged <strong>{Math.round(chart.overall)}s</strong>
            </>
          )}{" "}
          · <span className="target-key" aria-hidden="true" /> 1 minute target ·{" "}
          <span className="avg-key" aria-hidden="true" /> {chart?.averageLabel ?? "average"}
        </p>
        {buckets.length >= 2 ? (
          <BarChart
            label={`Seconds between blocks, ${rangeName(range)}`}
            bars={buckets.map((b) => ({
              key: String(b.toHeight),
              value: b.seconds,
              tip: single ? (
                <>
                  <strong>Block {formatNumber(b.toHeight)}</strong>
                  <span>{Math.round(b.seconds)}s after the one before</span>
                  {b.average !== null && <span>{chart?.averageLabel}: {Math.round(b.average)}s</span>}
                </>
              ) : (
                <>
                  <strong>To {when(range, b.time * 1000)}</strong>
                  <span>
                    Blocks {formatNumber(b.toHeight - b.blocks + 1)} to {formatNumber(b.toHeight)}: average{" "}
                    {Math.round(b.seconds)}s
                  </span>
                  {b.average !== null && <span>{chart?.averageLabel}: {Math.round(b.average)}s</span>}
                </>
              ),
            }))}
            line={buckets.map((b) => b.average)}
            format={(v) => `${Math.round(v)}s`}
            target={60}
          />
        ) : (
          <p className="chart-empty">{waiting}</p>
        )}
      </div>

      <div className="chart-block">
        <div className="chart-head">
          <h2>Transactions per block</h2>
          <span className="chart-sub">
            including each block's reward{chart && !single ? ", average per bar" : ""}
          </span>
        </div>
        {buckets.length >= 2 ? (
          <BarChart
            label={`Transactions per block, ${rangeName(range)}`}
            bars={buckets.map((b) => ({
              key: String(b.toHeight),
              value: b.transactions,
              tip: single ? (
                <>
                  <strong>Block {formatNumber(b.toHeight)}</strong>
                  <span>
                    {formatNumber(b.transactions)} transaction{b.transactions === 1 ? "" : "s"}
                  </span>
                </>
              ) : (
                <>
                  <strong>To {when(range, b.time * 1000)}</strong>
                  <span>{+b.transactions.toFixed(2)} transactions per block on average</span>
                </>
              ),
            }))}
            format={compact}
            integer={single}
          />
        ) : (
          <p className="chart-empty">{waiting}</p>
        )}
      </div>

      <div className="chart-block">
        <div className="chart-head">
          <h2>Mempool</h2>
          <span className="chart-sub">most transactions waiting, {rangeName(range)}</span>
        </div>
        {pool && pool.length >= 3 ? (
          <LineChart
            label={`Transactions waiting in the mempool, ${rangeName(range)}`}
            points={pool.map((s) => ({
              x: s.time,
              y: s.transactions,
              tip: (
                <>
                  <strong>{when(range, s.time)}</strong>
                  <span>
                    {formatNumber(s.transactions)} waiting · {formatBytes(s.bytes)}
                  </span>
                </>
              ),
            }))}
            format={compact}
          />
        ) : (
          <p className="chart-empty">
            {pool
              ? "Building up: the dashboard records this every minute and keeps 30 days."
              : "Loading…"}
          </p>
        )}
      </div>
    </section>
  );
}
