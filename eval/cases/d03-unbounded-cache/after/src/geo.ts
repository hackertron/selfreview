import type { GeoResult } from "./types";

const GEO_KEY = process.env.GEO_KEY!;
const cache = new Map<string, GeoResult>();

export async function lookupIp(ip: string): Promise<GeoResult> {
  const hit = cache.get(ip);
  if (hit) return hit;
  const res = await fetch(`https://geo.example.com/v1/${ip}`, { headers: { authorization: `Bearer ${GEO_KEY}` } });
  const result = (await res.json()) as GeoResult;
  cache.set(ip, result);
  return result;
}
