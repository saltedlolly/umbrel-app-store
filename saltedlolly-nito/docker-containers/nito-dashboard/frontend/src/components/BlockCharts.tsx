import type { Block, MempoolSample } from "../api.js";
import { formatBytes, formatNumber } from "../format.js";
import { BarChart, LineChart } from "./charts.js";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

function compact(value: number): string {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`;
  return `${+value.toFixed(1)}`;
}

export function BlockCharts({ blocks, mempool }: { blocks: Block[]; mempool: MempoolSample[] | null }) {
  const timed = blocks.slice(1).map((block, i) => ({ block, seconds: Math.max(0, block.time - blocks[i].time) }));

  return (
    <section className="panel charts" aria-label="Block charts">
      <div className="chart-block">
        <div className="chart-head">
          <h2>Time between blocks</h2>
          <span className="chart-sub">
            last {timed.length} blocks, in seconds ·{" "}
            <span className="target-key" aria-hidden="true" /> 1 minute target
          </span>
        </div>
        {timed.length >= 2 ? (
          <BarChart
            label="Seconds between each of the latest blocks"
            bars={timed.map(({ block, seconds }) => ({
              key: block.hash,
              value: seconds,
              tip: (
                <>
                  <strong>Block {formatNumber(block.height)}</strong>
                  <span>{seconds}s after the one before</span>
                </>
              ),
            }))}
            format={(v) => `${Math.round(v)}s`}
            target={60}
          />
        ) : (
          <p className="chart-empty">Waiting for blocks…</p>
        )}
      </div>

      <div className="chart-block">
        <div className="chart-head">
          <h2>Transactions per block</h2>
          <span className="chart-sub">including each block's reward</span>
        </div>
        {blocks.length >= 2 ? (
          <BarChart
            label="Transactions in each of the latest blocks"
            bars={blocks.map((block) => ({
              key: block.hash,
              value: block.transactions,
              tip: (
                <>
                  <strong>Block {formatNumber(block.height)}</strong>
                  <span>
                    {formatNumber(block.transactions)} transaction{block.transactions === 1 ? "" : "s"} ·{" "}
                    {formatBytes(block.size)}
                  </span>
                </>
              ),
            }))}
            format={compact}
            integer
          />
        ) : (
          <p className="chart-empty">Waiting for blocks…</p>
        )}
      </div>

      <div className="chart-block">
        <div className="chart-head">
          <h2>Mempool</h2>
          <span className="chart-sub">transactions waiting, last 2 hours</span>
        </div>
        {mempool && mempool.length >= 3 ? (
          <LineChart
            label="Transactions waiting in the mempool over the last 2 hours"
            points={mempool.map((s) => ({
              x: s.time,
              y: s.transactions,
              tip: (
                <>
                  <strong>{timeFormat.format(s.time)}</strong>
                  <span>
                    {formatNumber(s.transactions)} waiting · {formatBytes(s.bytes)}
                  </span>
                </>
              ),
            }))}
            format={compact}
          />
        ) : (
          <p className="chart-empty">Collecting… this chart fills in over the next few minutes.</p>
        )}
      </div>
    </section>
  );
}
