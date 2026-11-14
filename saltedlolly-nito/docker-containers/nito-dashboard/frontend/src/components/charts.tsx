import { useState, type ReactNode } from "react";
import { useWidth } from "../hooks.js";

// Small single-series SVG charts: thin bars with rounded tops on a shared
// baseline, a recessive grid, and a tooltip on hover (or tap)

const PAD = { top: 10, right: 8, bottom: 20, left: 40 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
}

// A bar whose top corners are rounded (radius 4) and whose base is square
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 70), width - 70);
  return (
    <div className="chart-tip" style={{ left, top: tip.y }}>
      {tip.content}
    </div>
  );
}

export interface Bar {
  key: string;
  value: number;
  tip: ReactNode;
}

interface BarChartProps {
  bars: Bar[];
  height?: number;
  format: (value: number) => string;
  target?: number;
  label: string;
  // Whole numbers only (counts): the axis then never shows fractions
  integer?: boolean;
}

export function BarChart({ bars, height = 150, format, target, label, integer }: BarChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  let max = niceMax(Math.max(...bars.map((b) => b.value), target ?? 0) * 1.05);
  if (integer) max = Math.max(2, Math.ceil(max / 2) * 2);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const slot = bars.length ? plotW / bars.length : 0;
  const gap = slot > 6 ? 2 : 1;
  const ticks = [0, max / 2, max];
  const hovered = hover !== null ? bars[hover] : null;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="axis" x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {bars.map((bar, i) => {
            const x = PAD.left + i * slot + gap / 2;
            const top = y(bar.value);
            return (
              <path
                key={bar.key}
                className={`bar ${hover === i ? "bar-hover" : ""} ${i === bars.length - 1 ? "bar-latest" : ""}`}
                d={barPath(x, top, Math.max(1, slot - gap), PAD.top + plotH - top)}
              />
            );
          })}
          {target !== undefined && (
            <line className="target" x1={PAD.left} x2={width - PAD.right} y1={y(target)} y2={y(target)} />
          )}
          {/* Hit areas: the full column, wider than the bar */}
          {bars.map((bar, i) => (
            <rect
              key={`hit-${bar.key}`}
              x={PAD.left + i * slot}
              y={PAD.top}
              width={slot}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onClick={() => setHover(i)}
            />
          ))}
        </svg>
      )}
      <Tooltip
        tip={
          hovered && hover !== null
            ? { x: PAD.left + hover * slot + slot / 2, y: y(hovered.value) - 8, content: hovered.tip }
            : null
        }
        width={width}
      />
    </div>
  );
}

export interface Point {
  x: number;
  y: number;
  tip: ReactNode;
}

interface LineChartProps {
  points: Point[];
  height?: number;
  format: (value: number) => string;
  label: string;
}

// A line with a soft area under it, and a crosshair on hover
export function LineChart({ points, height = 120, format, label }: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  // Counts: whole-number ticks, at least 0, 1, 2
  const max = Math.max(2, Math.ceil(niceMax(Math.max(...points.map((p) => p.y), 1) * 1.1) / 2) * 2);
  const minX = points[0]?.x ?? 0;
  const spanX = Math.max(1, (points[points.length - 1]?.x ?? 1) - minX);
  const sx = (x: number) => PAD.left + ((x - minX) / spanX) * plotW;
  const sy = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const area = points.length
    ? `${line}L${sx(points[points.length - 1].x)},${PAD.top + plotH}L${sx(minX)},${PAD.top + plotH}Z`
    : "";
  const hovered = hover !== null ? points[hover] : null;

  function pick(clientX: number, svg: SVGSVGElement) {
    const x = clientX - svg.getBoundingClientRect().left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(sx(p.x) - x) < Math.abs(sx(points[best].x) - x)) best = i;
    });
    setHover(best);
  }

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onMouseMove={(e) => points.length && pick(e.clientX, e.currentTarget)}
          onClick={(e) => points.length && pick(e.clientX, e.currentTarget)}
          onMouseLeave={() => setHover(null)}
        >
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={sy(t)} y2={sy(t)} />
              <text className="axis" x={PAD.left - 6} y={sy(t)} dy="0.32em" textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          <path className="area" d={area} />
          <path className="line" d={line} />
          {hovered && (
            <g>
              <line className="crosshair" x1={sx(hovered.x)} x2={sx(hovered.x)} y1={PAD.top} y2={PAD.top + plotH} />
              <circle className="dot" cx={sx(hovered.x)} cy={sy(hovered.y)} r={4.5} />
            </g>
          )}
        </svg>
      )}
      <Tooltip
        tip={hovered ? { x: sx(hovered.x), y: sy(hovered.y) - 10, content: hovered.tip } : null}
        width={width}
      />
    </div>
  );
}
