// The "Selfreview" check on each reviewed commit: the result shows up next to CI, and with
// `fail_on` in .selfreview.yml, branch protection can block the merge. It needs the app's Checks
// permission (read & write). Apps created before v1.1 don't have it; until it's added, the check
// is skipped and the review works as before.
import type { Octokit } from "@octokit/rest";
import type { Severity, ValidationResult } from "./validate";
import type { RepoConfig } from "./repo-config";

// GitHub counts success, neutral and skipped as passing for a required check.
export type CheckConclusion = "success" | "neutral" | "failure" | "skipped";
export type CheckReport = { conclusion: CheckConclusion; title: string; summary: string };

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/**
 * The findings the check counts. `fresh` is everything new, not only what was posted inline: a
 * finding on an unchanged line (listed in the summary) or cut by max_comments counts too.
 * `repeated` are findings raised on an earlier push that the model found again, so they're still
 * in the code: they aren't posted twice, but they keep the check failing. Without them, a
 * /selfreview on an unfixed PR would turn a red check green.
 */
export function checkSeverities(result: ValidationResult): { fresh: Severity[]; repeated: Severity[] } {
  const droppedFor = (reason: string) => result.dropped.filter((d) => d.reason === reason).map((d) => d.finding);
  const fresh = [...result.post, ...result.outsideDiff, ...droppedFor("max_comments reached")];
  return {
    fresh: fresh.map((f) => f.severity),
    repeated: droppedFor("already raised").map((f) => f.severity),
  };
}

/**
 * With incremental reviews, a later push only shows the findings it introduced. So a failed check
 * stays failed until a full review (/selfreview) passes; otherwise pushing unrelated commits would
 * turn it green while the finding is still there.
 */
export function stillFailing(current: CheckConclusion, previous: string | null): boolean {
  return previous === "failure" && current !== "failure";
}

/**
 * The Selfreview check's conclusion on an earlier commit, or null if there's none (or the app
 * can't read checks). Other errors are thrown, so the job is retried instead of mistaking "couldn't
 * read it" for "it didn't fail".
 */
export async function previousConclusion(
  gh: Octokit,
  where: { owner: string; repo: string },
  sha: string,
): Promise<string | null> {
  try {
    const { data } = await gh.checks.listForRef({
      owner: where.owner,
      repo: where.repo,
      ref: sha,
      check_name: "Selfreview",
      per_page: 1,
    });
    return data.check_runs[0]?.conclusion ?? null;
  } catch (err: any) {
    if (err?.status === 403 || err?.status === 404) return null;
    throw err;
  }
}

/** Nothing new: success. A finding at or above `fail_on`: failure. Anything else: neutral. */
export function reviewConclusion(severities: Severity[], failOn: RepoConfig["fail_on"]): CheckConclusion {
  if (severities.length === 0) return "success";
  if (failOn === "never") return "neutral";
  const threshold = RANK[failOn];
  return severities.some((s) => RANK[s] >= threshold) ? "failure" : "neutral";
}

export function reviewTitle(fresh: Severity[], repeatedCount = 0): string {
  const still = repeatedCount ? `, ${repeatedCount} earlier ${repeatedCount === 1 ? "one" : "ones"} still there` : "";
  if (fresh.length === 0) return `No new findings${still}`;
  const count = (s: Severity) => fresh.filter((x) => x === s).length;
  const parts = (["high", "medium", "low"] as const).filter((s) => count(s) > 0).map((s) => `${count(s)} ${s}`);
  const noun = fresh.length === 1 ? "finding" : "findings";
  return `${fresh.length} new ${noun} (${parts.join(", ")})${still}`;
}

const CHECK_ATTEMPTS = 3;

/**
 * Never throws: the review is already posted by now, and a failed check mustn't make the job
 * retry. GitHub errors other than a missing permission are tried again a couple of times, since a
 * required check that never arrives blocks the merge. Returns why it wasn't posted, or null.
 */
export async function publishCheck(
  gh: Octokit,
  where: { owner: string; repo: string; headSha: string },
  report: CheckReport,
  retryDelayMs = 2_000,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      await gh.checks.create({
        owner: where.owner,
        repo: where.repo,
        name: "Selfreview",
        head_sha: where.headSha,
        status: "completed",
        conclusion: report.conclusion,
        output: { title: report.title, summary: report.summary },
      });
      return null;
    } catch (err: any) {
      if (err?.status === 403) return "the GitHub App has no Checks permission";
      if (attempt === CHECK_ATTEMPTS) return String(err?.message ?? err);
      await Bun.sleep(retryDelayMs * attempt);
    }
  }
}
