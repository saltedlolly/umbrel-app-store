import express, { type Request, type Response } from "express";
import { RANGES, blockChart, hashrateChart, startHeaderWatch, type Range } from "./headers.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { waitForRpcReady } from "./rpc.js";
import { getStatsWidget, getStatus, getSyncWidget, getUptimeWidget } from "./widgets.js";
import { recentBlocks, startBlockWatch } from "./blocks.js";
import { mempoolHistory, startSampling, trafficHistory } from "./history.js";
import { getMining, startMiningWatch } from "./mining.js";
import { getPeers } from "./peers.js";
import { getVersion } from "./version.js";
import { getFacts } from "./facts.js";

// ?range=1h|24h|7d|30d, falling back to the given default
function rangeOf(req: Request, fallback: Range, allowed: readonly Range[] = RANGES): Range {
  const value = String(req.query.range ?? "");
  return (allowed as string[]).includes(value) ? (value as Range) : fallback;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function route(handler: (req: Request) => unknown | Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.set("Cache-Control", "no-store").json(await handler(req));
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  };
}

async function main() {
  console.log(`Waiting for nito RPC at ${config.rpcHost}:${config.rpcPort}...`);
  await waitForRpcReady();
  console.log("nito RPC ready");

  startBlockWatch();
  await startSampling();
  startHeaderWatch();
  startMiningWatch();

  const app = express();

  app.get("/api/widget/sync", route(getSyncWidget));
  app.get("/api/widget/stats", route(getStatsWidget));
  app.get("/api/widget/uptime", route(getUptimeWidget));

  app.get("/api/status", route(getStatus));
  app.get("/api/blocks", route(recentBlocks));
  app.get("/api/mempool-history", route((req) => mempoolHistory(rangeOf(req, "1h"))));
  app.get("/api/block-chart", route((req) => blockChart(rangeOf(req, "1h"))));
  app.get(
    "/api/hashrate",
    route((req) => hashrateChart(rangeOf(req, "7d", ["24h", "7d", "30d"]) as Exclude<Range, "1h">)),
  );
  app.get("/api/peers", route(getPeers));
  app.get("/api/version", route(getVersion));
  app.get("/api/facts", route(getFacts));
  app.get("/api/mining", route(getMining));
  app.get("/api/traffic", route((req) => trafficHistory(rangeOf(req, "24h"))));

  app.use(express.static(join(__dirname, "..", "public")));

  app.listen(config.httpPort, () => {
    console.log(`Dashboard listening on :${config.httpPort}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
