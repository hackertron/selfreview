// What happened to our comments? (ARCHITECTURE §9) For PRs with comments from the last 14 days, ask
// GitHub for each review thread's state and the 👍/👎 on its first comment, and store it:
//   resolved  = someone resolved the thread
//   addressed = the code under the comment changed in a later push (GitHub marks the thread outdated)
// GitHub has no webhook for reactions or thread resolution, so this is polled.
import type { Pool } from "../db/pool";
import type { GitHubApp } from "../github/client";
import type { Logger } from "../log";

export type ThreadState = {
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: { databaseId: number | null; reactionGroups: { content: string; reactors: { totalCount: number } }[] }[] };
};

export function outcomeFor(t: Pick<ThreadState, "isResolved" | "isOutdated">): "resolved" | "addressed" | "open" {
  if (t.isResolved) return "resolved";
  if (t.isOutdated) return "addressed";
  return "open";
}

export function netReactions(groups: ThreadState["comments"]["nodes"][number]["reactionGroups"]): number {
  const count = (content: string) => groups.find((g) => g.content === content)?.reactors.totalCount ?? 0;
  return count("THUMBS_UP") - count("THUMBS_DOWN");
}

const QUERY = `query ($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first: 1) { nodes { databaseId reactionGroups { content reactors { totalCount } } } }
        }
      }
    }
  }
}`;

export async function syncOutcomes(github: GitHubApp, pool: Pool, log: Logger) {
  const { rows: prs } = await pool.query<{ installation_id: string; repo: string; pr: number }>(`
    SELECT DISTINCT r.installation_id, r.repo, r.pr
    FROM findings f JOIN reviews r ON r.id = f.review_id
    JOIN installations i ON i.id = r.installation_id AND i.removed_at IS NULL
    WHERE f.posted_at > now() - interval '14 days' AND f.comment_id IS NOT NULL`);

  let updated = 0;
  for (const { installation_id, repo, pr } of prs) {
    const [owner, name] = repo.split("/") as [string, string];
    try {
      const gh = await github.forInstallation(Number(installation_id));
      const threads: ThreadState[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) { // 100 threads per page; 50 pages is far beyond any real PR
        type Page = { nodes: ThreadState[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        const data: { repository: { pullRequest: { reviewThreads: Page } | null } | null } = await gh.graphql(QUERY, {
          owner, repo: name, pr, after,
        });
        const threadPage = data.repository?.pullRequest?.reviewThreads;
        if (!threadPage) break;
        threads.push(...threadPage.nodes);
        if (!threadPage.pageInfo.hasNextPage) break;
        after = threadPage.pageInfo.endCursor;
      }
      for (const thread of threads) {
        const first = thread.comments.nodes[0];
        if (!first?.databaseId) continue;
        const { rowCount } = await pool.query(
          `UPDATE findings SET outcome = $2, reaction = $3,
             outcome_at = CASE WHEN outcome <> $2 THEN now() ELSE outcome_at END
           WHERE comment_id = $1 AND (outcome <> $2 OR reaction <> $3)`,
          [first.databaseId, outcomeFor(thread), netReactions(first.reactionGroups)],
        );
        updated += rowCount ?? 0;
      }
    } catch (err) {
      log.warn("outcome sync failed for a PR", { repo, pr, err }); // e.g. repo removed from the install
    }
  }
  log.info("chore done: comment outcomes synced", { prs: prs.length, updated });
}
