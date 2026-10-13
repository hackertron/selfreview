// The "Selfreview" check on each reviewed commit: the result shows up next to CI, and with
// `fail_on` in .selfreview.yml, branch protection can block the merge. It needs the app's Checks
// permission (read & write). Apps created before v1.1 don't have it; until it's added, the check
// is skipped and the review works as before.
import type { Octokit } from "@octokit/rest";
import type { Severity } from "./validate";
import type { RepoConfig } from "./repo-config";

export type CheckConclusion = "success" | "neutral" | "failure";
export type CheckReport = { conclusion: CheckConclusion; title: string; summary: string };

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/** Nothing new: success. A finding at or above `fail_on`: failure. Anything else: neutral. */
export function reviewConclusion(severities: Severity[], failOn: RepoConfig["fail_on"]): CheckConclusion {
  if (severities.length === 0) return "success";
  if (failOn === "never") return "neutral";
  const threshold = RANK[failOn];
  return severities.some((s) => RANK[s] >= threshold) ? "failure" : "neutral";
}

export function reviewTitle(severities: Severity[]): string {
  if (severities.length === 0) return "No new findings";
  const count = (s: Severity) => severities.filter((x) => x === s).length;
  const parts = (["high", "medium", "low"] as const).filter((s) => count(s) > 0).map((s) => `${count(s)} ${s}`);
  const noun = severities.length === 1 ? "finding" : "findings";
  return `${severities.length} new ${noun} (${parts.join(", ")})`;
}

/**
 * Never throws: the review is already posted by now, and a failed check mustn't make the job
 * retry. Returns why it wasn't posted (403 = the app lacks the Checks permission), or null.
 */
export async function publishCheck(
  gh: Octokit,
  where: { owner: string; repo: string; headSha: string },
  report: CheckReport,
): Promise<string | null> {
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
    return String(err?.message ?? err);
  }
}
