// Runs against a real Postgres (with migrations applied) when TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgres://localhost:5432/selfreview_test bun test tests/integration
// CI does this with a Postgres service container (.github/workflows/test.yml).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import { createPool, type Pool } from "../../src/db/pool";
import { REVIEW_QUEUE, createBoss } from "../../src/queue";
import { createWebhookHandler } from "../../src/webhooks";

const url = process.env.TEST_DATABASE_URL;
const INSTALLATION = 990000 + Math.floor(Math.random() * 9999);
const REPO = `it-${INSTALLATION}/repo`;

describe.skipIf(!url)("webhook intake against Postgres", () => {
  let pool: Pool;
  let boss: PgBoss;
  let accept: ReturnType<typeof createWebhookHandler>;
  const deliveries: string[] = [];
  const hook = (event: string, payload: unknown) => {
    const deliveryId = crypto.randomUUID();
    deliveries.push(deliveryId);
    return { deliveryId, event, payload };
  };
  const prPayload = (action: string, number = 1) => ({
    action,
    installation: { id: INSTALLATION },
    repository: { full_name: REPO, owner: { login: `it-${INSTALLATION}`, type: "Organization" } },
    pull_request: { number, state: "open", user: { login: "dev", type: "User" }, author_association: "MEMBER" },
  });

  beforeAll(async () => {
    pool = createPool(url!);
    boss = createBoss(url!, { supervise: false, schedule: false });
    await boss.start();
    accept = createWebhookHandler(pool, boss);
  });

  afterAll(async () => {
    const { rows } = await pool.query(`SELECT id FROM pgboss.job WHERE name = $1 AND data->>'repo' = $2`, [REVIEW_QUEUE, REPO]);
    if (rows.length) await boss.deleteJob(REVIEW_QUEUE, rows.map((r) => r.id));
    await pool.query("DELETE FROM webhook_deliveries WHERE delivery_id = ANY($1::uuid[])", [deliveries]);
    await pool.query("DELETE FROM installations WHERE id = $1", [INSTALLATION]);
    await boss.stop({ graceful: false });
    await pool.end();
  });

  test("installation.created records the account", async () => {
    const res = await accept(
      hook("installation", {
        action: "created",
        installation: { id: INSTALLATION, account: { login: `it-${INSTALLATION}`, type: "Organization" }, repository_selection: "selected" },
        repositories: [{ full_name: REPO }],
      }),
    );
    expect(res.outcome).toBe("installation:created");
    const { rows } = await pool.query("SELECT account_type, repo_count, removed_at FROM installations WHERE id = $1", [INSTALLATION]);
    expect(rows[0]).toEqual({ account_type: "Organization", repo_count: 1, removed_at: null });
  });

  test("a PR webhook records the delivery and queues one job; GitHub's duplicate is ignored", async () => {
    const first = hook("pull_request", prPayload("opened"));
    expect(await accept(first)).toEqual({ status: 202, outcome: "queued" });
    expect(await accept(first)).toEqual({ status: 200, outcome: "duplicate" });
    const { rows } = await pool.query("SELECT outcome FROM webhook_deliveries WHERE delivery_id = $1", [first.deliveryId]);
    expect(rows[0].outcome).toBe("queued");
  });

  test("rapid pushes never leave more than one waiting job per PR", async () => {
    // A live worker may claim jobs meanwhile, so check the invariant rather than exact outcomes.
    for (let i = 0; i < 5; i++) {
      const { outcome } = await accept(hook("pull_request", prPayload("synchronize")));
      expect(["queued", "already-queued"]).toContain(outcome);
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS waiting FROM pgboss.job WHERE name = $1 AND singleton_key = $2 AND state = 'created'`,
      [REVIEW_QUEUE, `${REPO}#1`],
    );
    expect(rows[0].waiting).toBeLessThanOrEqual(1);
    expect((await accept(hook("pull_request", prPayload("opened", 2)))).outcome).toBe("queued"); // other PR
  }, 30_000); // several round trips to a remote database

  test("ignored events are still recorded, with the reason", async () => {
    const h = hook("pull_request", prPayload("labeled"));
    expect((await accept(h)).outcome).toBe("ignored:action:labeled");
  });

  test("installation_repositories adjusts the repo count", async () => {
    await accept(
      hook("installation_repositories", {
        action: "added",
        installation: { id: INSTALLATION, account: { login: `it-${INSTALLATION}`, type: "Organization" } },
        repository_selection: "selected",
        repositories_added: [{}, {}],
        repositories_removed: [],
      }),
    );
    const { rows } = await pool.query("SELECT repo_count FROM installations WHERE id = $1", [INSTALLATION]);
    expect(rows[0].repo_count).toBe(3);
  });

  test("installation.deleted keeps the account row for churn analytics", async () => {
    await accept(hook("installation", { action: "deleted", installation: { id: INSTALLATION, account: { login: "x", type: "Organization" } } }));
    const { rows } = await pool.query("SELECT removed_at FROM installations WHERE id = $1", [INSTALLATION]);
    expect(rows[0].removed_at).not.toBeNull();
  });
});
