import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { waitForRpcReady } from "./rpc.js";
import { getStatsWidget, getStatus, getSyncWidget, getUptimeWidget } from "./widgets.js";
import { recentBlocks, startBlockWatch } from "./blocks.js";
import { mempoolHistory, startSampling } from "./history.js";
import { getPeers } from "./peers.js";
import { getVersion } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function route(handler: () => unknown | Promise<unknown>) {
  return async (_req: Request, res: Response) => {
    try {
      res.set("Cache-Control", "no-store").json(await handler());
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
  startSampling();

  const app = express();

  app.get("/api/widget/sync", route(getSyncWidget));
  app.get("/api/widget/stats", route(getStatsWidget));
  app.get("/api/widget/uptime", route(getUptimeWidget));

  app.get("/api/status", route(getStatus));
  app.get("/api/blocks", route(recentBlocks));
  app.get("/api/mempool-history", route(mempoolHistory));
  app.get("/api/peers", route(getPeers));
  app.get("/api/version", route(getVersion));

  app.use(express.static(join(__dirname, "..", "public")));

  app.listen(config.httpPort, () => {
    console.log(`Dashboard listening on :${config.httpPort}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
