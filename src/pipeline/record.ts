// Step 9: the usage ledger. Metadata only: no code, no comment text (§6).
import type { Pool } from "../db/pool";
import { withTransaction } from "../db/tx";
import type { Usage } from "../llm/types";
import type { PostedComment } from "./publish";

export type ReviewRecord = {
  reviewId?: string; // set when a budget reservation row already exists: update it instead of inserting
  installationId: number;
  repo: string;
  pr: number;
  headSha: string;
  baseSha: string | null;
  trigger: string;
  status: "posted" | "no_new_findings" | "skipped" | "failed";
  skipReason?: string;
  githubReviewId?: number | null;
  model?: string;
  filesReviewed?: number;
  linesReviewed?: number;
  usage?: Usage;
  costUsd?: number;
  durationMs: number;
  findings?: PostedComment[];
};

export async function recordReview(pool: Pool, r: ReviewRecord) {
  return withTransaction(pool, async (tx) => {
    const values = [
      r.status, r.skipReason ?? null, r.githubReviewId ?? null, r.model ?? null, r.filesReviewed ?? 0, r.linesReviewed ?? 0,
      r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0, r.usage?.cachedInputTokens ?? 0, r.costUsd ?? 0, r.durationMs,
    ];
    let reviewId: string;
    if (r.reviewId) {
      await tx.query(
        `UPDATE reviews SET status = $2, skip_reason = $3, github_review_id = $4, model = $5, files_reviewed = $6,
           lines_reviewed = $7, tokens_in = $8, tokens_out = $9, tokens_cached = $10, cost_usd = $11, duration_ms = $12
         WHERE id = $1`,
        [r.reviewId, ...values],
      );
      reviewId = r.reviewId;
    } else {
      const { rows } = await tx.query(
        `INSERT INTO reviews (installation_id, repo, pr, head_sha, base_sha, trigger, status, skip_reason,
           github_review_id, model, files_reviewed, lines_reviewed, tokens_in, tokens_out, tokens_cached, cost_usd, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [r.installationId, r.repo, r.pr, r.headSha, r.baseSha, r.trigger, ...values],
      );
      reviewId = rows[0].id;
    }
    for (const f of r.findings ?? []) {
      await tx.query(
        `INSERT INTO findings (review_id, path, line, severity, category, fingerprint, comment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [reviewId, f.path, f.line, f.severity, f.category, f.fingerprint, f.commentId],
      );
    }
    return reviewId;
  });
}

const BUDGET_LOCK = 7283111; // serialises budget checks across all workers

/**
 * MONTHLY_BUDGET_USD as a real cap: under a lock, check this month's spend (including other
 * reviews' reservations) plus this review's estimate, and if it fits, reserve it as a 'running'
 * row. Returns the row id, or null when the budget would be exceeded.
 */
export async function reserveBudget(
  pool: Pool,
  r: Pick<ReviewRecord, "installationId" | "repo" | "pr" | "headSha" | "baseSha" | "trigger"> & { model: string },
  estimateUsd: number,
  budgetUsd: number,
): Promise<string | null> {
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [BUDGET_LOCK]);
    const { rows } = await tx.query(
      "SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent FROM reviews WHERE created_at >= date_trunc('month', now())",
    );
    if (Number(rows[0].spent) + estimateUsd > budgetUsd) return null;
    const inserted = await tx.query(
      `INSERT INTO reviews (installation_id, repo, pr, head_sha, base_sha, trigger, status, model, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8) RETURNING id`,
      [r.installationId, r.repo, r.pr, r.headSha, r.baseSha, r.trigger, r.model, estimateUsd],
    );
    return inserted.rows[0].id as string;
  });
}

/** A reserved review failed: keep what was actually spent (0 if the model call itself failed). */
export async function failReservation(pool: Pool, reviewId: string, spentUsd: number, reason: string) {
  await pool.query("UPDATE reviews SET status = 'failed', skip_reason = $3, cost_usd = $2 WHERE id = $1 AND status = 'running'", [
    reviewId, spentUsd, reason.slice(0, 200),
  ]);
}

/** Has this exact commit already been reviewed successfully? */
export async function alreadyReviewed(pool: Pool, repo: string, pr: number, sha: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM reviews WHERE repo = $1 AND pr = $2 AND head_sha = $3 AND status IN ('posted', 'no_new_findings') LIMIT 1`,
    [repo, pr, sha],
  );
  return (rowCount ?? 0) > 0;
}

/** The newest commit of this PR that was reviewed successfully, if any (for incremental reviews). */
export async function lastReviewedSha(pool: Pool, repo: string, pr: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT head_sha FROM reviews
     WHERE repo = $1 AND pr = $2 AND status IN ('posted', 'no_new_findings')
     ORDER BY created_at DESC LIMIT 1`,
    [repo, pr],
  );
  return (rows[0]?.head_sha as string | undefined) ?? null;
}

/** Findings already posted on this PR, for dedupe across pushes. */
export async function priorFindings(pool: Pool, repo: string, pr: number) {
  const { rows } = await pool.query(
    `SELECT f.path, f.line, f.category, f.fingerprint FROM findings f JOIN reviews r ON r.id = f.review_id
     WHERE r.repo = $1 AND r.pr = $2`,
    [repo, pr],
  );
  return rows as { path: string; line: number; category: string; fingerprint: string }[];
}

/** A budget reservation left 'running' for this exact commit (e.g. by an attempt that crashed). */
export async function runningReservation(pool: Pool, repo: string, pr: number, sha: string) {
  const { rows } = await pool.query(
    `SELECT id, cost_usd::float8 AS cost FROM reviews
     WHERE repo = $1 AND pr = $2 AND head_sha = $3 AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
    [repo, pr, sha],
  );
  return rows[0] ? { id: rows[0].id as string, costUsd: Number(rows[0].cost) } : null;
}
