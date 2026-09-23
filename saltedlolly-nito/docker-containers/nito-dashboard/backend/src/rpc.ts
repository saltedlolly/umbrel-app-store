import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
  }
}

let nextId = 0;

export async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(`http://${config.rpcHost}:${config.rpcPort}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${config.rpcUser}:${config.rpcPassword}`).toString("base64")}`,
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: nextId++, method, params }),
  });

  if (!response.ok && response.status !== 500) {
    // nitod returns 500 with a JSON-RPC error body for invalid *parameters*,
    // which is still a well-formed response worth parsing below - only
    // treat other non-2xx statuses (e.g. connection refused while the node
    // container is still starting up) as a hard failure.
    throw new RpcError(`RPC HTTP ${response.status} calling ${method}`);
  }

  const body = (await response.json()) as { result: T; error: { message: string; code: number } | null };
  if (body.error) {
    throw new RpcError(body.error.message, body.error.code);
  }
  return body.result;
}

export async function waitForRpcReady(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpcCall("getnetworkinfo");
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`Could not reach nito RPC at ${config.rpcHost}:${config.rpcPort} within ${timeoutMs}ms`);
}
