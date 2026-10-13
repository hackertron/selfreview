// The review pipeline (ARCHITECTURE §4.2): a straight line of small steps. Each early `return`
// is a normal outcome (skipped, nothing new); a thrown error makes pg-boss retry the job.
import type { Octokit } from "@octokit/rest";
import type { Pool } from "../db/pool";
import type { GitHubApp } from "../github/client";
import { costOf, priceFor, type ModelRegistry } from "../llm/models";
import { BilledFailure, type Finding, type ReviewFile, type ReviewResult, type Usage } from "../llm/types";
import type { Logger } from "../log";
import type { ReviewJob } from "../queue";
import { parsePatch, type FileDiff } from "./diff";
import { filterFiles, type ChangedFile } from "./filter";
import { newChangesFrom } from "./incremental";
import { EXPECTED_OUTPUT_TOKENS, chunkInputTokens, mapLimit, pickTier, planChunks, worstCaseCost } from "./plan";
import { botComments, findExistingReview, postReview, upsertSummary, type PrRef } from "./publish";
import { publishCheck, reviewConclusion, reviewTitle } from "./check";
import {
  alreadyReviewed,
  failReservation,
  lastReviewedSha,
  priorFindings,
  recordReview,
  reserveBudget,
  runningReservation,
  type ReviewRecord,
} from "./record";
import { renderSummary } from "./render";
import { CONFIG_PATH, parseRepoConfig, skipReason } from "./repo-config";
import { validateFindings } from "./validate";

export type Limits = { maxReviewCostUsd: number; monthlyBudgetUsd?: number; smallDiffLines: number };
export type PipelineDeps = { pool: Pool; github: GitHubApp; models: ModelRegistry; limits: Limits };
export type PipelineOutcome = { status: ReviewRecord["status"]; reason?: string; findings?: number };

const WRITE_PERMISSIONS = new Set(["admin", "write"]);
const MAX_CONTEXT_FILE_BYTES = 40_000; // full-file context only for files up to ~1000 lines
const MAX_CONTEXT_FILES = 25;
const PARALLEL_CHUNKS = 2;

/**
 * `signal` is pg-boss's: it aborts when this attempt no longer owns the job (it ran past its time
 * limit and was handed to a retry). The model calls stop, and nothing is posted after that.
 */
export async function runReview(
  deps: PipelineDeps,
  job: ReviewJob,
  log: Logger,
  signal?: AbortSignal,
): Promise<PipelineOutcome> {
  const started = Date.now();
  const [owner, repo] = job.repo.split("/") as [string, string];
  const prRef: PrRef = { owner, repo, pull_number: job.pr };

  // 1. Authenticate as this installation
  const gh = await deps.github.forInstallation(job.installationId);
  const botLogin = await deps.github.botLogin();

  // 2. Resolve: the PR's latest commit, whatever it is now
  const { data: pr } = await gh.pulls.get(prRef);
  const headSha = pr.head.sha;
  const base = { installationId: job.installationId, repo: job.repo, pr: job.pr, headSha, baseSha: pr.base.sha, trigger: job.trigger };
  const skipped = async (reason: string, summary?: Parameters<typeof renderSummary>[0]): Promise<PipelineOutcome> => {
    await recordReview(deps.pool, { ...base, status: "skipped", skipReason: reason, durationMs: Date.now() - started });
    if (summary) {
      const text = renderSummary(summary);
      await upsertSummary(gh, prRef, botLogin, text);
      const report = { conclusion: "neutral" as const, title: `Skipped: ${reason}`, summary: text };
      const notPosted = await publishCheck(gh, { owner, repo, headSha }, report);
      if (notPosted) log.info("check not posted", { reason: notPosted });
    }
    log.info("review skipped", { sha: headSha.slice(0, 7), reason });
    return { status: "skipped", reason };
  };

  if (pr.state !== "open") return { status: "skipped", reason: "closed" };
  if (!job.force) {
    if (await alreadyReviewed(deps.pool, job.repo, job.pr, headSha)) return { status: "skipped", reason: "already reviewed" };
    // A previous attempt may have posted and then crashed before recording: adopt, don't redo.
    const existing = await findExistingReview(gh, prRef, headSha, botLogin);
    if (existing) {
      // Settle the crashed attempt's budget reservation (if any) instead of leaving it running.
      // Its actual cost is unknown, so the reserved worst case stays counted.
      const reservation = await runningReservation(deps.pool, job.repo, job.pr, headSha);
      await recordReview(deps.pool, {
        ...base, reviewId: reservation?.id, status: "posted", githubReviewId: existing.reviewId, findings: existing.comments,
        costUsd: reservation?.costUsd ?? 0, durationMs: Date.now() - started,
      });
      log.info("adopted review posted by an earlier attempt", { sha: headSha.slice(0, 7), reviewId: existing.reviewId });
      return { status: "posted", reason: "adopted", findings: existing.comments.length };
    }
  }
  if (job.verifyUser && !(await hasWriteAccess(gh, owner, repo, job.verifyUser))) {
    return skipped(`${job.verifyUser} has no write access`);
  }

  // 3. Load: config from the base branch, so a PR can't change its own rules
  const { config, warning: configWarning } = parseRepoConfig(await readFile(gh, owner, repo, CONFIG_PATH, pr.base.ref));
  const skip = skipReason(config, { draft: pr.draft ?? false, author: pr.user.login, labels: pr.labels.map((l) => l.name) });
  if (skip) return skipped(skip);
  const changed: ChangedFile[] = await gh.paginate(gh.pulls.listFiles, { ...prRef, per_page: 100 });

  // Incremental: after a successful review, only the commits since then are reviewed. Not after
  // a /selfreview command (a full re-run was asked for), or when the history was rewritten.
  const since = job.force ? null : await lastReviewedSha(deps.pool, job.repo, job.pr);
  const newChanges = since ? await changesSince(gh, owner, repo, since, headSha) : null;

  // 4. Filter out noise. Comments must land on lines of the whole PR's diff, so that's what
  // they're checked against, even when only the newest changes are reviewed.
  const prFiles = filterFiles(changed, config.ignore);
  const diffs = new Map<string, FileDiff>(prFiles.review.map((f) => [f.filename, parsePatch(f.patch!)]));
  const { review: files, skipped: skippedFiles } = newChanges
    ? filterFiles(newChanges.filter((f) => diffs.has(f.filename)), config.ignore)
    : prFiles;
  if (newChanges && files.length === 0) return skipped(`no reviewable changes since ${since!.slice(0, 7)}`);

  // 5. Plan: model tier, context, chunks, cost estimate
  const tier = pickTier(
    files.map((f) => ({ path: f.filename, changedLines: f.additions + f.deletions })),
    config.risky_paths,
    deps.limits.smallDiffLines,
  );
  const { spec, note: modelNote } = deps.models.pick(tier, tier === "small" ? config.models.small : config.models.large);
  const reviewer = deps.models.reviewer(spec);
  const ourComments = await botComments(gh, prRef, botLogin);
  const prior = [...(await priorFindings(deps.pool, job.repo, job.pr)), ...ourComments];
  const request = {
    pr: { title: pr.title, body: pr.body ?? "" },
    instructions: config.instructions,
    alreadyRaised: ourComments.map((c) => ({ path: c.path, line: c.line, title: c.title })),
  };
  const reviewFiles = await withContext(gh, owner, repo, headSha, files);
  const { chunks, tooLarge } = planChunks(reviewFiles, request);
  for (const path of tooLarge) skippedFiles.push({ path, reason: "too large for one model request" });

  const summaryBase = {
    sha: headSha, since: newChanges ? since! : undefined,
    posted: [], outsideDiff: [], skippedFiles, filesReviewed: 0, model: spec.id, costUsd: 0,
    warning: [configWarning, modelNote].filter(Boolean).join(" · ") || undefined,
  };
  // Cost limits are only enforceable with a price, so an unpriced model is never run (it would be
  // uncapped). OpenRouter's price list being down throws instead, and the job is retried later.
  const price = await priceFor(spec, deps.models.prices);
  if (!price) {
    return skipped(`no price known for ${spec.id}`, {
      ...summaryBase, skipReason: `no price is known for \`${spec.id}\`, so cost limits can't be enforced (add it to MODEL_PRICES)`,
    });
  }
  const estimate = chunks.reduce(
    (sum, c) => sum + costOf(price, { inputTokens: chunkInputTokens(c, request), outputTokens: EXPECTED_OUTPUT_TOKENS, cachedInputTokens: 0 }),
    0,
  );
  if (estimate > deps.limits.maxReviewCostUsd) {
    return skipped(`estimated $${estimate.toFixed(2)} is over MAX_REVIEW_COST_USD ($${deps.limits.maxReviewCostUsd})`, {
      ...summaryBase, skipReason: `this PR would cost about $${estimate.toFixed(2)} to review, over the $${deps.limits.maxReviewCostUsd} per-review limit`,
    });
  }
  // Reserve the WORST case under a lock, so neither concurrent workers nor unusually long answers
  // can take spend past the budget. Settled to the actual cost when the review finishes.
  let reservation: string | undefined;
  if (deps.limits.monthlyBudgetUsd !== undefined) {
    const worstCase = worstCaseCost(chunks, request, price, reviewer.limits);
    const id = await reserveBudget(deps.pool, { ...base, model: spec.id }, worstCase, deps.limits.monthlyBudgetUsd);
    if (!id) return skipped("monthly budget reached", { ...summaryBase, skipReason: `the monthly budget ($${deps.limits.monthlyBudgetUsd}) is used up` });
    reservation = id;
  }

  // What the model calls actually cost so far, including calls that failed after being billed.
  // If any step fails, the budget reservation is settled to this.
  let spentUsd = 0;
  const reviewChunk = async (chunk: ReviewFile[]): Promise<ReviewResult> => {
    try {
      const result = await reviewer.review({ ...request, files: chunk }, { signal });
      spentUsd += result.costUsd ?? costOf(price, result.usage);
      return result;
    } catch (err) {
      if (err instanceof BilledFailure) spentUsd += err.costUsd ?? costOf(price, err.usage);
      throw err;
    }
  };

  try {
    // 6. Review each chunk (a few in parallel)
    const results = await mapLimit(chunks, PARALLEL_CHUNKS, reviewChunk);
    const findings: Finding[] = results.flatMap((r) => r.findings);
    const usage: Usage = {
      inputTokens: results.reduce((n, r) => n + r.usage.inputTokens, 0),
      outputTokens: results.reduce((n, r) => n + r.usage.outputTokens, 0),
      cachedInputTokens: results.reduce((n, r) => n + r.usage.cachedInputTokens, 0),
    };
    const costUsd = spentUsd;
    const invalid = results.reduce((n, r) => n + (r.invalid ?? 0), 0);

    // 7. Validate against the diff, dedupe, sanitize, cap
    const result = validateFindings(findings, diffs, prior, { minSeverity: config.min_severity, maxComments: config.max_comments });

    // 8. Publish: one review only if there's something new, and one summary edited in place.
    // If this attempt lost the job (too slow, already handed to a retry), stop before posting.
    signal?.throwIfAborted();
    const posted = result.post.length ? await postReview(gh, prRef, headSha, botLogin, result.post) : null;
    const reviewedCount = chunks.reduce((n, c) => n + c.length, 0);
    const summary = renderSummary({
      ...summaryBase, posted: result.post, outsideDiff: result.outsideDiff, filesReviewed: reviewedCount, costUsd,
    });
    await upsertSummary(gh, prRef, botLogin, summary);
    const severities = result.post.map((f) => f.severity);
    const report = {
      conclusion: reviewConclusion(severities, config.fail_on),
      title: reviewTitle(severities),
      summary,
    };
    const checkNotPosted = await publishCheck(gh, { owner, repo, headSha }, report);

    // 9. Record (settles the reservation with the actual cost, if there was one)
    const status = posted ? "posted" : "no_new_findings";
    await recordReview(deps.pool, {
      ...base, reviewId: reservation, status, githubReviewId: posted?.reviewId ?? null, model: spec.id,
      filesReviewed: reviewedCount, linesReviewed: files.reduce((n, f) => n + f.additions + f.deletions, 0),
      usage, costUsd, durationMs: Date.now() - started, findings: posted?.comments ?? [],
    });
    log.info("review done", {
      sha: headSha.slice(0, 7), status, model: spec.id, tier, chunks: chunks.length, found: findings.length, invalid,
      posted: result.post.length, outsideDiff: result.outsideDiff.length, since: since?.slice(0, 7),
      check: checkNotPosted ? `not posted: ${checkNotPosted}` : report.conclusion,
      dropped: Object.fromEntries([...new Set(result.dropped.map((d) => d.reason))].map((r) => [r, result.dropped.filter((d) => d.reason === r).length])),
      tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, costUsd: Number(costUsd.toFixed(6)), durationMs: Date.now() - started,
    });
    return { status, findings: result.post.length };
  } catch (err) {
    if (reservation) await failReservation(deps.pool, reservation, spentUsd, String((err as Error).message ?? err));
    throw err; // pg-boss retries the job
  }
}

/** Files changed since the last reviewed commit, or null for a full review (incremental.ts). */
async function changesSince(gh: Octokit, owner: string, repo: string, since: string, head: string) {
  try {
    const { data } = await gh.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${since}...${head}` });
    return newChangesFrom({ status: data.status, files: data.files as ChangedFile[] | undefined });
  } catch (err: any) {
    if (err?.status === 404) return null; // the old commit is gone (force-pushed away)
    throw err;
  }
}

/** Full post-change file content for context, for reasonably small files. */
async function withContext(gh: Octokit, owner: string, repo: string, sha: string, files: ChangedFile[]): Promise<ReviewFile[]> {
  return mapLimit(files, 5, async (f): Promise<ReviewFile> => {
    const base = { path: f.filename, patch: f.patch! };
    if (files.indexOf(f) >= MAX_CONTEXT_FILES) return base;
    const content = await readFile(gh, owner, repo, f.filename, sha).catch(() => null);
    return content !== null && content.length <= MAX_CONTEXT_FILE_BYTES ? { ...base, content } : base;
  });
}

async function hasWriteAccess(gh: Octokit, owner: string, repo: string, username: string) {
  try {
    const { data } = await gh.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return WRITE_PERMISSIONS.has(data.permission);
  } catch {
    return false; // not a collaborator at all
  }
}

async function readFile(gh: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const { data } = await gh.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err: any) {
    if (err?.status === 404) return null;
    throw err;
  }
}
