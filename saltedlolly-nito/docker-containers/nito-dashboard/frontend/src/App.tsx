import { api } from "./api.js";
import { usePoll } from "./hooks.js";
import { useTheme } from "./theme.js";
import { Header } from "./components/Header.js";
import { StatCards } from "./components/StatCards.js";
import { ChainStrip } from "./components/ChainStrip.js";
import { SyncRing } from "./components/SyncRing.js";
import { PortNotice } from "./components/PortNotice.js";
import { BlockCharts } from "./components/BlockCharts.js";
import { PeerMap } from "./components/PeerMap.js";
import { Footer } from "./components/Footer.js";
import "./app.css";

export function App() {
  const [theme, setTheme] = useTheme();
  const status = usePoll(api.status, 5000);
  const blocks = usePoll(api.blocks, 5000);
  const mempool = usePoll(api.mempool, 30_000);
  const peers = usePoll(api.peers, 30_000);
  const version = usePoll(api.version, 5 * 60_000);

  const s = status.data;
  return (
    <>
      <main>
        <Header network={s?.network ?? null} theme={theme} onTheme={setTheme} />

        {status.error && (
          <p className="error" role="alert">
            Can't reach your Nito node right now. It may still be starting: this page keeps trying.
          </p>
        )}

        <PortNotice status={s} peers={peers.data} />

        {s?.syncing ? <SyncRing status={s} /> : <ChainStrip blocks={blocks.data ?? []} />}

        <StatCards status={s} />

        <div className="panels">
          <BlockCharts blocks={blocks.data ?? []} mempool={mempool.data} />
          <PeerMap peers={peers.data} />
        </div>
      </main>
      <Footer version={version.data} />
    </>
  );
}
