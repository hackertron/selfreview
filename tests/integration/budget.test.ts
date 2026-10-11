// MONTHLY_BUDGET_USD under concurrency: reservations are serialised, so concurrent workers can't
// all pass the check. Runs when TEST_DATABASE_URL points at a migrated Postgres.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPool, type Pool } from "../../src/db/pool";
import { failReservation, recordReview, reserveBudget, runningReservation } from "../../src/pipeline/record";

const url = process.env.TEST_DATABASE_URL;
const INSTALLATION = 880000 + Math.floor(Math.random() * 9999);
const REPO = `budget-${INSTALLATION}/repo`;

describe.skipIf(!url)("budget reservations against Postgres", () => {
  let pool: Pool;
  const base = { installationId: INSTALLATION, repo: REPO, pr: 1, headSha: "abc", baseSha: null, trigger: "opened", model: "openrouter:z-ai/glm-5.3" };
  // Isolate from other rows this month by measuring what's already spent and budgeting on top of it.
  let already = 0;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query("INSERT INTO installations (id, account, account_type) VALUES ($1, 'budget-test', 'User')", [INSTALLATION]);
    const { rows } = await pool.query("SELECT COALESCE(SUM(cost_usd), 0)::float8 AS s FROM reviews WHERE created_at >= date_trunc('month', now())");
    already = Number(rows[0].s);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM reviews WHERE installation_id = $1", [INSTALLATION]);
    await pool.query("DELETE FROM installations WHERE id = $1", [INSTALLATION]);
    await pool.end();
  });

  test("five concurrent $0.30 reviews against $1 of budget: exactly three get through", async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => reserveBudget(pool, base, 0.3, already + 1)));
    expect(ids.filter(Boolean)).toHaveLength(3);
  });

  test("finishing a reserved review replaces the estimate with the actual cost", async () => {
    const id = (await reserveBudget(pool, { ...base, pr: 2 }, 0.05, already + 100))!;
    await recordReview(pool, { ...base, pr: 2, reviewId: id, status: "posted", costUsd: 0.01, durationMs: 5 });
    const { rows } = await pool.query("SELECT status, cost_usd::float8 AS cost FROM reviews WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ status: "posted", cost: 0.01 });
  });

  test("a crashed attempt's reservation is found and settled by the retry that adopts the posted review", async () => {
    const id = (await reserveBudget(pool, { ...base, pr: 4, headSha: "def" }, 0.2, already + 100))!;
    const found = await runningReservation(pool, REPO, 4, "def");
    expect(found).toEqual({ id, costUsd: 0.2 });
    await recordReview(pool, { ...base, pr: 4, headSha: "def", reviewId: found!.id, status: "posted", costUsd: found!.costUsd, durationMs: 1 });
    const { rows } = await pool.query("SELECT count(*)::int AS n, max(status) AS status FROM reviews WHERE repo = $1 AND pr = 4", [REPO]);
    expect(rows[0]).toEqual({ n: 1, status: "posted" }); // one row, settled: no duplicate, nothing left running
    expect(await runningReservation(pool, REPO, 4, "def")).toBeNull();
  });

  test("a failed review releases its reservation down to what was actually spent", async () => {
    const id = (await reserveBudget(pool, { ...base, pr: 3 }, 0.5, already + 100))!;
    await failReservation(pool, id, 0, "model timed out");
    const { rows } = await pool.query("SELECT status, cost_usd::float8 AS cost, skip_reason FROM reviews WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ status: "failed", cost: 0, skip_reason: "model timed out" });
  });
});
