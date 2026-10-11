// Step 8: post to GitHub, idempotently. A retry after a crash must never double-post (or pay for
// a second LLM call), so the worker first looks for its own marker for this commit and, if a
// previous attempt already posted, adopts that review instead.
import type { Octokit } from "@octokit/rest";
import { markers, parseRenderedComment, renderComment, renderReviewBody } from "./render";
import type { ValidatedFinding } from "./validate";

export type PrRef = { owner: string; repo: string; pull_number: number };

export type PostedComment = {
  commentId: number;
  path: string;
  line: number;
  severity: ValidatedFinding["severity"];
  category: ValidatedFinding["category"];
  fingerprint: string;
  title: string; // read back from the comment, used to tell the model what's already raised
};

/**
 * Our inline comments on this PR, read back with their metadata. Uses the PR-wide comments
 * endpoint: the per-review endpoint returns `line: null` (only legacy `position`), found in M3.
 */
export async function botComments(gh: Octokit, pr: PrRef, botLogin: string, reviewId?: number): Promise<PostedComment[]> {
  const comments = await gh.paginate(gh.pulls.listReviewComments, { ...pr, per_page: 100 });
  const out: PostedComment[] = [];
  for (const c of comments) {
    if (c.user?.login !== botLogin) continue;
    if (reviewId !== undefined && c.pull_request_review_id !== reviewId) continue;
    const parsed = parseRenderedComment(c.body);
    const line = c.line ?? c.original_line;
    if (parsed && line) out.push({ commentId: c.id, path: c.path, line, ...parsed });
  }
  return out;
}

/** Our review for exactly this commit, if a previous attempt already posted one. */
export async function findExistingReview(gh: Octokit, pr: PrRef, sha: string, botLogin: string) {
  const reviews = await gh.paginate(gh.pulls.listReviews, { ...pr, per_page: 100 });
  const review = reviews.find((r) => r.user?.login === botLogin && r.body?.includes(markers.review(sha)));
  return review ? { reviewId: review.id, comments: await botComments(gh, pr, botLogin, review.id) } : null;
}

export async function postReview(gh: Octokit, pr: PrRef, sha: string, botLogin: string, findings: ValidatedFinding[]) {
  const { data: review } = await gh.pulls.createReview({
    ...pr,
    commit_id: sha, // comments anchor to the commit we actually reviewed
    event: "COMMENT", // never APPROVE or REQUEST_CHANGES
    body: renderReviewBody(sha, findings.length),
    comments: findings.map((f) => {
      const multiLine = f.end_line !== undefined && f.end_line > f.line;
      return {
        path: f.path,
        body: renderComment(f),
        side: "RIGHT" as const,
        line: multiLine ? f.end_line! : f.line,
        ...(multiLine ? { start_line: f.line, start_side: "RIGHT" as const } : {}),
      };
    }),
  });
  return { reviewId: review.id, comments: await botComments(gh, pr, botLogin, review.id) };
}

/** One summary comment per PR, edited in place on every run instead of piling up. */
export async function upsertSummary(gh: Octokit, pr: PrRef, botLogin: string, body: string) {
  const issue = { owner: pr.owner, repo: pr.repo, issue_number: pr.pull_number };
  const comments = await gh.paginate(gh.issues.listComments, { ...issue, per_page: 100 });
  const mine = comments.find((c) => c.user?.login === botLogin && c.body?.includes(markers.summary));
  if (mine) await gh.issues.updateComment({ owner: pr.owner, repo: pr.repo, comment_id: mine.id, body });
  else await gh.issues.createComment({ ...issue, body });
}
