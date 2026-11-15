import type { Mining } from "../api.js";
import { formatHashrate, formatNumber, shortAddress } from "../format.js";
import { BarList, LineChart, type ListBar } from "./charts.js";

const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const TOP_MINERS = 5;

function percent(part: number, whole: number): string {
  const p = (part / whole) * 100;
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

function Hashrate({ mining }: { mining: Mining | null }) {
  const points = mining?.hashrate ?? [];
  const latest = points[points.length - 1];
  return (
    <div className="chart-block">
      <div className="chart-head">
        <h2>Network hashrate</h2>
        <span className="chart-sub">
          last 7 days{latest ? ` · now ${formatHashrate(latest.hashrate)}` : ""}
        </span>
      </div>
      {points.length >= 3 ? (
        <LineChart
          label="The Nito network's hashrate over the last 7 days"
          tone="accent"
          height={140}
          points={points.map((p) => ({
            x: p.time * 1000,
            y: p.hashrate,
            tip: (
              <>
                <strong>{dayTime.format(p.time * 1000)}</strong>
                <span>
                  {formatHashrate(p.hashrate)} · block {formatNumber(p.height)}
                </span>
              </>
            ),
          }))}
          format={(v) => (v === 0 ? "0" : formatHashrate(v).replace(/\/s$/, ""))}
        />
      ) : (
        <p className="chart-empty">
          {mining ? "Worked out once your node has caught up…" : "Loading…"}
        </p>
      )}
    </div>
  );
}

// Who found the blocks of the last 24 hours: pools by the name in their
// blocks, other miners by the address they're paid to
function Miners({ mining }: { mining: Mining | null }) {
  if (!mining || mining.blocks === 0) {
    return (
      <div className="chart-block">
        <div className="chart-head">
          <h2>Who found the blocks</h2>
        </div>
        <p className="chart-empty">{mining ? "Worked out once your node has caught up…" : "Loading…"}</p>
      </div>
    );
  }
  const top = mining.miners.slice(0, mining.miners.length > TOP_MINERS + 1 ? TOP_MINERS : TOP_MINERS + 1);
  const rest = mining.miners.slice(top.length);
  const rows: ListBar[] = top.map((m) => ({
    key: m.miner,
    label: m.named ? (
      m.miner
    ) : (
      <a href={`https://explorer.nito.network/address/${m.miner}`} target="_blank" rel="noopener noreferrer">
        {shortAddress(m.miner)}
      </a>
    ),
    title: m.named ? `${m.miner}: ${m.blocks} blocks` : `Paid to ${m.miner}: ${m.blocks} blocks`,
    value: m.blocks,
    detail: percent(m.blocks, mining.blocks),
  }));
  if (rest.length) {
    const blocks = rest.reduce((sum, m) => sum + m.blocks, 0);
    rows.push({
      key: "others",
      label: `${rest.length} others`,
      title: `${rest.length} other miners: ${blocks} blocks`,
      value: blocks,
      detail: percent(blocks, mining.blocks),
      muted: true,
    });
  }
  return (
    <div className="chart-block">
      <div className="chart-head">
        <h2>Who found the blocks</h2>
        <span className="chart-sub">last {formatNumber(mining.blocks)} blocks, about 24 hours</span>
      </div>
      <BarList rows={rows} label="Share of the last day's blocks found by each miner" />
    </div>
  );
}

export function MiningPanel({ mining }: { mining: Mining | null }) {
  return (
    <section className="panel charts" aria-label="Mining">
      <Hashrate mining={mining} />
      <Miners mining={mining} />
    </section>
  );
}
