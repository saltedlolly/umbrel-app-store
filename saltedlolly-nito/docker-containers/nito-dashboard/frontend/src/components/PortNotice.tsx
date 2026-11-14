import { useState } from "react";
import type { Peers, Status } from "../api.js";
import { readStorage, writeStorage } from "../hooks.js";

const P2P_PORTS: Record<string, number> = { mainnet: 8820, testnet: 8840 };
const SETTLE_SECONDS = 30 * 60;
const HIDE_KEY = "port-notice-hidden";

// Asks people to forward the P2P port on their router when no other node has
// connected in, and confirms it once they do
export function PortNotice({ status, peers }: { status: Status | null; peers: Peers | null }) {
  const [hidden, setHidden] = useState(() => readStorage(HIDE_KEY) === "yes");
  if (!status || !peers) return null;
  const port = P2P_PORTS[status.network];
  if (!port) return null;

  if (peers.inbound > 0) {
    return (
      <div className="port-ok" role="status">
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3 3 7-7" />
        </svg>
        Port {port} is open: other nodes are connecting to yours.
      </div>
    );
  }
  // No outbound peers either means a different problem (no internet, or still
  // starting): this notice would only confuse
  if (hidden || peers.outbound === 0 || status.uptimeSeconds < SETTLE_SECONDS) return null;

  return (
    <aside className="port-notice">
      <div className="port-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <path d="M7 16.5h.01M11 16.5h.01M8 13V9a4 4 0 0 1 8 0v4" />
        </svg>
      </div>
      <div className="port-text">
        <h2>Help the Nito network: open port {port} on your router</h2>
        <p>
          Your node can reach other nodes, but none have connected to it. Forward port <strong>{port}</strong> (TCP) on
          your router to your Umbrel, so other nodes can connect to yours and the network gets stronger.
        </p>
        <p className="port-hint">
          Look for <em>Port forwarding</em> in your router's settings. Give your Umbrel a fixed local address first
          (often called a <em>DHCP reservation</em>), so the rule keeps working. Your router's list of connected
          devices shows the Umbrel's address.
        </p>
      </div>
      <button
        type="button"
        className="port-hide"
        onClick={() => {
          writeStorage(HIDE_KEY, "yes");
          setHidden(true);
        }}
      >
        Don't show again
      </button>
    </aside>
  );
}
