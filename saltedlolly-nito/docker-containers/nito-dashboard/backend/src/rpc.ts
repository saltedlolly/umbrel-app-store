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

// Several calls in one request (JSON-RPC batch), results in the same order.
// Used for reading many block headers at once.
export async function rpcBatch<T>(calls: { method: string; params?: unknown[] }[]): Promise<T[]> {
  if (!calls.length) return [];
  const first = nextId;
  nextId += calls.length;
  const response = await fetch(`http://${config.rpcHost}:${config.rpcPort}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${config.rpcUser}:${config.rpcPassword}`).toString("base64")}`,
    },
    body: JSON.stringify(
      calls.map((call, i) => ({ jsonrpc: "1.0", id: first + i, method: call.method, params: call.params ?? [] })),
    ),
  });
  if (!response.ok) throw new RpcError(`RPC HTTP ${response.status} calling a batch of ${calls[0].method}`);
  const body = (await response.json()) as { id: number; result: T; error: { message: string; code: number } | null }[];
  const byId = new Map(body.map((item) => [item.id, item]));
  return calls.map((call, i) => {
    const item = byId.get(first + i);
    if (!item) throw new RpcError(`No answer for ${call.method} in a batch`);
    if (item.error) throw new RpcError(item.error.message, item.error.code);
    return item.result;
  });
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
