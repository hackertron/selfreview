import { required, type Config } from "../config";
import { parseEncryptionKey } from "../crypto";
import { syncOutcomes } from "../cron/outcomes";
import { redeliverFailedWebhooks } from "../cron/redeliver";
import { createPool } from "../db/pool";
import { AppCredentialStore } from "../github/app";
import { GitHubApp } from "../github/client";
import { log } from "../log";

// Railway Cron starts this every 10 minutes; it does its chores and exits. Chores are independent:
// one failing doesn't stop the others.
export async function runCron(config: Config) {
  const pool = createPool(config.DATABASE_URL);
  let failed = 0;
  const chore = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      failed++;
      log.error("chore failed", { chore: name, err });
    }
  };
  try {
    await chore("cleanup", async () => {
      const { rowCount } = await pool.query("DELETE FROM webhook_deliveries WHERE received_at < now() - interval '30 days'");
      log.info("chore done: old webhook deliveries deleted", { deleted: rowCount ?? 0 });
      // A worker killed mid-review leaves its budget reservation 'running'. After an hour, mark it
      // failed; its estimated cost stays counted, since the model may have been called.
      const stale = await pool.query(
        "UPDATE reviews SET status = 'failed', skip_reason = 'interrupted' WHERE status = 'running' AND created_at < now() - interval '1 hour'",
      );
      if (stale.rowCount) log.info("chore done: stale budget reservations closed", { closed: stale.rowCount });
    });

    const credentials = new AppCredentialStore(pool, parseEncryptionKey(required(config, "ENCRYPTION_KEY")));
    const app = await credentials.get();
    if (app) {
      const github = new GitHubApp(async () => app);
      await chore("redeliver", async () => redeliverFailedWebhooks(await github.asApp(), pool, log));
      // Once an hour (the first 10-minute run of each hour) rather than daily, so the dashboard's
      // "acted on" number stays fresh; it only looks at PRs with comments from the last 14 days.
      if (new Date().getUTCMinutes() < 10) await chore("outcomes", async () => syncOutcomes(github, pool, log));
    }
  } finally {
    await pool.end();
  }
  if (failed) process.exitCode = 1;
}
