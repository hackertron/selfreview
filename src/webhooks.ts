// Accepting a webhook = one transaction (ARCHITECTURE §8.2): record the delivery, act on it, and
// queue the job if there is one. Either all of it commits or none of it, so a crash halfway
// leaves no trace and cron's redelivery check (M3) can safely resend it.
import type { PgBoss } from "pg-boss";
import type { Pool } from "./db/pool";
import { withTransaction, type Tx } from "./db/tx";
import { decideIssueComment, decidePullRequest, type Decision } from "./github/triggers";
import { log } from "./log";
import { REVIEW_QUEUE, reviewJobKey } from "./queue";

export type IncomingWebhook = { deliveryId: string; event: string; payload: any };
export type WebhookResult = { status: number; outcome: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a repo owner's PRs may be reviewed (see src/github/accounts.ts). */
export type AccountCheck = (login: string) => Promise<boolean>;

export function createWebhookHandler(pool: Pool, boss: PgBoss, accountAllowed: AccountCheck = async () => true) {
  return async function acceptWebhook(hook: IncomingWebhook): Promise<WebhookResult> {
    if (!UUID.test(hook.deliveryId)) return { status: 400, outcome: "bad-delivery-id" };
    const action = typeof hook.payload?.action === "string" ? hook.payload.action : null;

    const result = await withTransaction(pool, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO webhook_deliveries (delivery_id, event, action, outcome)
         VALUES ($1, $2, $3, 'received') ON CONFLICT (delivery_id) DO NOTHING`,
        [hook.deliveryId, hook.event, action],
      );
      if (inserted.rowCount === 0) return { status: 200, outcome: "duplicate" };

      const outcome = await route(tx, boss, hook, accountAllowed);
      await tx.query("UPDATE webhook_deliveries SET outcome = $2 WHERE delivery_id = $1", [hook.deliveryId, outcome]);
      return { status: 202, outcome };
    });

    log.info("webhook", {
      deliveryId: hook.deliveryId,
      event: hook.event,
      action,
      outcome: result.outcome,
      repo: hook.payload?.repository?.full_name,
    });
    return result;
  };
}

async function route(tx: Tx, boss: PgBoss, hook: IncomingWebhook, accountAllowed: AccountCheck): Promise<string> {
  const p = hook.payload;
  switch (hook.event) {
    case "ping":
      return "ping";
    case "installation":
      return handleInstallation(tx, p);
    case "installation_repositories":
      return handleInstallationRepositories(tx, p);
    case "pull_request":
    case "issue_comment": {
      const repoOwner = p.repository?.owner?.login;
      if (typeof repoOwner === "string" && !(await accountAllowed(repoOwner))) {
        return "ignored:account-not-allowed";
      }
      const decision = hook.event === "pull_request" ? decidePullRequest(p) : decideIssueComment(p);
      return queueReview(tx, boss, p, decision);
    }
    default:
      return `ignored:event`;
  }
}

async function queueReview(tx: Tx, boss: PgBoss, p: any, decision: Decision): Promise<string> {
  if (decision.kind === "ignore") return `ignored:${decision.reason}`;
  const { job } = decision;
  // reviews.installation_id references installations; make sure the row exists even if the
  // installation webhook was missed.
  await tx.query(
    `INSERT INTO installations (id, account, account_type) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [job.installationId, p.repository.owner.login, p.repository.owner.type ?? "unknown"],
  );
  const id = await boss.send(REVIEW_QUEUE, job, {
    singletonKey: reviewJobKey(job.repo, job.pr), // ≤ 1 waiting job per PR
    group: { id: String(job.installationId) }, // per-org concurrency cap
    db: { executeSql: (text, values) => tx.query(text, values as unknown[]) }, // same transaction
  });
  // null = a job for this PR is already waiting; it will review the newest commit anyway
  return id ? "queued" : "already-queued";
}

async function handleInstallation(tx: Tx, p: any): Promise<string> {
  const inst = p.installation;
  switch (p.action) {
    case "created":
    case "new_permissions_accepted":
    case "unsuspend": {
      const repoCount = inst.repository_selection === "selected" && Array.isArray(p.repositories) ? p.repositories.length : null;
      await tx.query(
        `INSERT INTO installations (id, account, account_type, repo_count) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET account = EXCLUDED.account, account_type = EXCLUDED.account_type,
           repo_count = COALESCE(EXCLUDED.repo_count, installations.repo_count), removed_at = NULL`,
        [inst.id, inst.account.login, inst.account.type, repoCount],
      );
      return `installation:${p.action}`;
    }
    case "deleted":
      // Keep the installation row (churn analytics); delete what we stored about its reviews.
      await tx.query("UPDATE installations SET removed_at = now() WHERE id = $1", [inst.id]);
      await tx.query("DELETE FROM reviews WHERE installation_id = $1", [inst.id]); // findings cascade
      return "installation:deleted";
    default:
      return `ignored:installation:${p.action}`;
  }
}

async function handleInstallationRepositories(tx: Tx, p: any): Promise<string> {
  const inst = p.installation;
  const delta = (p.repositories_added?.length ?? 0) - (p.repositories_removed?.length ?? 0);
  await tx.query(
    `INSERT INTO installations (id, account, account_type, repo_count) VALUES ($1, $2, $3, NULL)
     ON CONFLICT (id) DO UPDATE SET repo_count =
       CASE WHEN $4 = 'all' THEN NULL ELSE GREATEST(COALESCE(installations.repo_count, 0) + $5, 0) END`,
    [inst.id, inst.account.login, inst.account.type, p.repository_selection, delta],
  );
  return `installation_repositories:${p.action}`;
}
