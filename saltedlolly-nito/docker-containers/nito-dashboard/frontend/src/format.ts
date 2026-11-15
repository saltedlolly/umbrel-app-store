const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

export function formatNumber(value: number): string {
  return integer.format(value);
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// A rough duration: "2 h 10 min", "45 min", "under a minute"
export function formatDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

export function timeAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// "1:05" style timer
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export const NETWORK_LABELS: Record<string, string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
  regtest: "Regtest",
  signet: "Signet",
};

export function networkLabel(network: string): string {
  return NETWORK_LABELS[network] ?? network;
}

// Hashes per second: "393.4 TH/s"
export function formatHashrate(value: number): string {
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let v = value;
  let unit = 0;
  while (v >= 1000 && unit < units.length - 1) {
    v /= 1000;
    unit++;
  }
  return `${+v.toFixed(v >= 100 ? 0 : 1)} ${units[unit]}`;
}

// "nito1q5704v…u4p00c4"
export function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 11)}…${address.slice(-7)}` : address;
}
