import { PgBoss, type Queue } from "pg-boss";
import { log } from "./log";

export const REVIEW_QUEUE = "review";

// A job is a PR, not a commit (ARCHITECTURE §4.1). The worker reviews whatever the PR's latest
// commit is when the job runs.
export type ReviewJob = {
  installationId: number;
  repo: string; // "owner/name"
  pr: number;
  trigger: string; // webhook action or "command"
  force: boolean; // re-review even if this commit was already reviewed
  // Set when the webhook couldn't prove this user may trigger reviews (author_association can
  // under-report, e.g. private org membership). The worker checks their repo permission first.
  verifyUser?: string;
};

const queues: Queue[] = [
  {
    name: REVIEW_QUEUE,
    policy: "stately", // ≤ 1 waiting + ≤ 1 running job per singletonKey ("owner/name#42")
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    heartbeatSeconds: 30, // a crashed worker's job returns to the queue after missed heartbeats
    expireInSeconds: 15 * 60,
    // Finished jobs (completed or failed) are kept a week, so the dashboard can retry a failure.
    deleteAfterSeconds: 7 * 24 * 60 * 60,
  },
];

export function reviewJobKey(repo: string, pr: number) {
  return `${repo}#${pr}`;
}

export function createBoss(connectionString: string, options: { supervise?: boolean; schedule?: boolean } = {}) {
  const boss = new PgBoss({ connectionString, max: 5, ...options });
  boss.on("error", (err) => log.error("pg-boss error", { err }));
  return boss;
}

// Runs in the pre-deploy step, so queue settings live in code like the rest of the schema.
export async function defineQueues(boss: PgBoss) {
  for (const queue of queues) {
    if (!(await boss.getQueue(queue.name))) {
      await boss.createQueue(queue.name, queue);
      log.info("queue created", { queue: queue.name });
      continue;
    }
    // policy and heartbeat are fixed at creation; the rest can be updated in place
    const { name, policy, partition, deadLetter, heartbeatSeconds, retryDelayMax, ...mutable } = queue;
    await boss.updateQueue(name, mutable);
  }
}
