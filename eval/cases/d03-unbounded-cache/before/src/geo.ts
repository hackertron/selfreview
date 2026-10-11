import type { GeoResult } from "./types";

const GEO_KEY = process.env.GEO_KEY!;

export async function lookupIp(ip: string): Promise<GeoResult> {
  const res = await fetch(`https://geo.example.com/v1/${ip}`, { headers: { authorization: `Bearer ${GEO_KEY}` } });
  return (await res.json()) as GeoResult;
}
