// Everything the dashboard shows. Metadata only, like the rest of the database: no code, no
// comment text (ARCHITECTURE §6).
import type { PgBoss } from "pg-boss";
import type { Pool } from "../db/pool";
import { REVIEW_QUEUE, type ReviewJob } from "../queue";

export type DashboardData = {
  month: { spentUsd: number; reviews: number; posted: number; findings: number; budgetUsd?: number };
  quality: { model: string; findings: number; addressed: number; resolved: number; reactions: number }[];
  reviews: {
    repo: string; pr: number; sha: string; status: string; skipReason: string | null; model: string | null;
    findings: number; costUsd: number; durationMs: number | null; createdAt: Date;
  }[];
  installations: { account: string; accountType: string; repoCount: number | null; installedAt: Date; removedAt: Date | null }[];
  deliveries: { receivedAt: Date; event: string; action: string | null; outcome: string }[];
  failedJobs: { id: string; repo: string; pr: number; failedAt: Date | null; error: string }[];
};

export async function loadDashboard(pool: Pool, boss: PgBoss, budgetUsd?: number): Promise<DashboardData> {
  const [month, quality, reviews, installations, deliveries, jobs] = await Promise.all([
    pool.query(`
      SELECT COALESCE(SUM(r.cost_usd), 0)::float8 AS spent, COUNT(*)::int AS reviews,
             COUNT(*) FILTER (WHERE r.status = 'posted')::int AS posted,
             (SELECT COUNT(*)::int FROM findings f WHERE f.posted_at >= date_trunc('month', now())) AS findings
      FROM reviews r WHERE r.created_at >= date_trunc('month', now())`),
    pool.query(`
      SELECT r.model, COUNT(*)::int AS findings,
             COUNT(*) FILTER (WHERE f.outcome = 'addressed')::int AS addressed,
             COUNT(*) FILTER (WHERE f.outcome = 'resolved')::int AS resolved,
             COALESCE(SUM(f.reaction), 0)::int AS reactions
      FROM findings f JOIN reviews r ON r.id = f.review_id
      WHERE f.posted_at > now() - interval '30 days'
      GROUP BY r.model ORDER BY findings DESC`),
    pool.query(`
      SELECT r.repo, r.pr, r.head_sha, r.status, r.skip_reason, r.model, r.cost_usd::float8 AS cost, r.duration_ms,
             r.created_at, (SELECT COUNT(*)::int FROM findings f WHERE f.review_id = r.id) AS findings
      FROM reviews r ORDER BY r.created_at DESC LIMIT 25`),
    pool.query(`SELECT account, account_type, repo_count, installed_at, removed_at FROM installations ORDER BY installed_at DESC`),
    pool.query(`SELECT received_at, event, action, outcome FROM webhook_deliveries ORDER BY received_at DESC LIMIT 15`),
    boss.findJobs<ReviewJob>(REVIEW_QUEUE),
  ]);
  const m = month.rows[0];
  return {
    month: { spentUsd: m.spent, reviews: m.reviews, posted: m.posted, findings: m.findings, budgetUsd },
    quality: quality.rows,
    reviews: reviews.rows.map((r) => ({
      repo: r.repo, pr: r.pr, sha: r.head_sha, status: r.status, skipReason: r.skip_reason, model: r.model,
      findings: r.findings, costUsd: r.cost, durationMs: r.duration_ms, createdAt: r.created_at,
    })),
    installations: installations.rows.map((i) => ({
      account: i.account, accountType: i.account_type, repoCount: i.repo_count, installedAt: i.installed_at, removedAt: i.removed_at,
    })),
    deliveries: deliveries.rows.map((d) => ({ receivedAt: d.received_at, event: d.event, action: d.action, outcome: d.outcome })),
    failedJobs: jobs
      .filter((j) => j.state === "failed")
      .slice(0, 20)
      .map((j) => ({
        id: j.id, repo: j.data.repo, pr: j.data.pr, failedAt: j.completedOn,
        error: String((j.output as { message?: string } | null)?.message ?? "unknown error").slice(0, 200),
      })),
  };
}
