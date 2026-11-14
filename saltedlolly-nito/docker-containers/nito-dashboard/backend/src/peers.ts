import maxmind, { type CountryResponse, type Reader } from "maxmind";
import { rpcCall } from "./rpc.js";
import { config } from "./config.js";

// Connected peers by country, looked up offline in DB-IP's free country
// database. Only countries and counts leave this file: never peer addresses.

interface PeerInfo {
  addr: string;
  inbound: boolean;
  network?: string;
}

export interface PeerCountry {
  code: string;
  peers: number;
}

export interface PeerSummary {
  total: number;
  inbound: number;
  outbound: number;
  countries: PeerCountry[];
  notLocated: number;
}

const CACHE_MS = 30_000;
let reader: Reader<CountryResponse> | null | undefined;
let cached: { at: number; value: PeerSummary } | null = null;

async function geo(): Promise<Reader<CountryResponse> | null> {
  if (reader === undefined) {
    try {
      reader = await maxmind.open<CountryResponse>(config.geoDatabase);
    } catch (err) {
      console.warn(`Country database not available (${(err as Error).message}); peers won't be placed on the map`);
      reader = null;
    }
  }
  return reader;
}

// "1.2.3.4:8820" or "[2001:db8::1]:8820" -> the address without the port
export function hostOf(addr: string): string {
  const bracketed = addr.match(/^\[([^\]]+)\]/);
  if (bracketed) return bracketed[1];
  const parts = addr.split(":");
  return parts.length === 2 ? parts[0] : addr;
}

export async function getPeers(): Promise<PeerSummary> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const [peers, lookup] = await Promise.all([rpcCall<PeerInfo[]>("getpeerinfo"), geo()]);
  const countries = new Map<string, number>();
  let inbound = 0;
  let notLocated = 0;
  for (const peer of peers) {
    if (peer.inbound) inbound++;
    let code: string | undefined;
    if (lookup && (!peer.network || peer.network === "ipv4" || peer.network === "ipv6")) {
      try {
        code = lookup.get(hostOf(peer.addr))?.country?.iso_code;
      } catch {
        code = undefined;
      }
    }
    if (code) countries.set(code, (countries.get(code) ?? 0) + 1);
    else notLocated++;
  }
  const value: PeerSummary = {
    total: peers.length,
    inbound,
    outbound: peers.length - inbound,
    countries: [...countries.entries()]
      .map(([code, count]) => ({ code, peers: count }))
      .sort((a, b) => b.peers - a.peers || a.code.localeCompare(b.code)),
    notLocated,
  };
  cached = { at: Date.now(), value };
  return value;
}
