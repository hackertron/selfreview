// GitHub never retries a failed webhook delivery by itself (ARCHITECTURE §8.2). Every cron run asks
// GitHub for recent deliveries and resends those that failed and that we never recorded.
// This is GitHub's own documented pattern ("automatically redelivering failed deliveries").
import type { Octokit } from "@octokit/rest";
import type { Pool } from "../db/pool";
import type { Logger } from "../log";

export type HookDelivery = {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  status_code: number;
  event: string;
};

export const LOOKBACK_MS = 6 * 60 * 60 * 1000;
// One resend per cron run (every 10 min): 12 attempts cover an outage of about 2 hours. M3 showed
// a 4-attempt cap gives up after ~30 minutes, which is too short for a real incident.
const MAX_ATTEMPTS = 12;
const MAX_PER_RUN = 25;

/** Pure: which deliveries to resend. Latest failed attempt per guid that we don't already have. */
export function pickRedeliveries(deliveries: HookDelivery[], recorded: Set<string>, now = Date.now()): HookDelivery[] {
  const byGuid = new Map<string, HookDelivery[]>();
  for (const d of deliveries) {
    if (now - Date.parse(d.delivered_at) > LOOKBACK_MS) continue;
    byGuid.set(d.guid, [...(byGuid.get(d.guid) ?? []), d]);
  }
  const picks: HookDelivery[] = [];
  for (const [guid, attempts] of byGuid) {
    if (recorded.has(guid)) continue; // we accepted it (on some attempt)
    if (attempts.some((a) => a.status_code >= 200 && a.status_code < 300)) continue;
    if (attempts.length >= MAX_ATTEMPTS) continue;
    picks.push(attempts.reduce((a, b) => (Date.parse(a.delivered_at) > Date.parse(b.delivered_at) ? a : b)));
  }
  return picks.slice(0, MAX_PER_RUN);
}

export async function redeliverFailedWebhooks(app: Octokit, pool: Pool, log: Logger) {
  const since = Date.now() - LOOKBACK_MS;
  const deliveries = await app.paginate(
    "GET /app/hook/deliveries",
    { per_page: 100 },
    (res, done) => {
      const page = res.data as HookDelivery[];
      if (page.some((d) => Date.parse(d.delivered_at) < since)) done(); // newest first; stop when past the window
      return page;
    },
  );
  const guids = [...new Set(deliveries.map((d) => d.guid))];
  const { rows } = await pool.query<{ delivery_id: string }>(
    "SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ANY($1::uuid[])",
    [guids],
  );
  const picks = pickRedeliveries(deliveries, new Set(rows.map((r) => r.delivery_id)));
  for (const d of picks) {
    await app.request("POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: d.id });
    log.info("redelivered webhook", { guid: d.guid, event: d.event, failedWith: d.status_code });
  }
  log.info("chore done: webhook redelivery", { checked: guids.length, redelivered: picks.length });
}
