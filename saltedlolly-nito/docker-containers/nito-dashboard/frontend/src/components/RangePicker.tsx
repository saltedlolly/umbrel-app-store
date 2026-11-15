import type { Range } from "../api.js";

const LABELS: Record<Range, string> = { "1h": "1H", "24h": "24H", "7d": "7D", "30d": "30D" };
const NAMES: Record<Range, string> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

export function rangeName(range: Range): string {
  return NAMES[range];
}

// Small segmented control for a chart's time range
export function RangePicker<T extends Range>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="range-picker" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={option === value ? "active" : undefined}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
