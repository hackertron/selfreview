import { required, type Config } from "../config";
import { parseEncryptionKey } from "../crypto";
import { createPool } from "../db/pool";
import { AppCredentialStore } from "../github/app";
import { GitHubApp } from "../github/client";
import { ModelRegistry } from "../llm/models";
import { log } from "../log";
import { runReview } from "../pipeline/run";
import { REVIEW_QUEUE, createBoss, type ReviewJob } from "../queue";
import { onShutdown } from "../shutdown";

export async function runWorker(config: Config) {
  const pool = createPool(config.DATABASE_URL);
  const credentials = new AppCredentialStore(pool, parseEncryptionKey(required(config, "ENCRYPTION_KEY")));
  const github = new GitHubApp(async () => {
    const app = await credentials.get();
    if (!app) throw new Error("GitHub App is not set up yet (open /setup on the api)");
    return app;
  });
  const models = new ModelRegistry(config, {
    small: config.MODEL_SMALL,
    large: config.MODEL_LARGE,
    allowed: config.ALLOWED_MODELS,
    prices: config.MODEL_PRICES,
  });
  const deps = {
    pool,
    github,
    models,
    limits: { maxReviewCostUsd: config.MAX_REVIEW_COST_USD, monthlyBudgetUsd: config.MONTHLY_BUDGET_USD, smallDiffLines: config.SMALL_DIFF_LINES },
  };

  const boss = createBoss(config.DATABASE_URL);
  await boss.start();
  await boss.work<ReviewJob>(
    REVIEW_QUEUE,
    {
      localConcurrency: config.WORKER_CONCURRENCY, // reviews in parallel in this replica
      groupConcurrency: config.MAX_REVIEWS_PER_ORG, // per installation, across all replicas
    },
    async ([job]) => {
      if (!job) return;
      const jobLog = log.child({ jobId: job.id, repo: job.data.repo, pr: job.data.pr, attempt: job.retryCount + 1 });
      try {
        return await runReview(deps, job.data, jobLog, job.signal);
      } catch (err) {
        jobLog.error("review failed; pg-boss will retry", { err });
        throw err;
      }
    },
  );
  log.info("worker ready", { concurrency: config.WORKER_CONCURRENCY, small: models.small.id, large: models.large.id });

  onShutdown(
    async () => {
      // stop claiming jobs, wait for running reviews to finish
      await boss.stop({ graceful: true, timeout: 110_000 });
      await pool.end();
    },
    { timeoutMs: 115_000 }, // the worker's drainingSeconds is 120
  );
}
