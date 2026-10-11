// Which webhooks become review jobs (ARCHITECTURE §4.3). Pure functions: payload in, decision out.
// The api only applies rules that a repo can't override (event, PR state, who asked). Repo-level
// skips from .selfreview.yml (drafts, labels, bot authors) are applied by the worker, which can
// read the config file.
import type { ReviewJob } from "../queue";

type Account = { login: string; type?: string };
type Repository = { full_name: string; owner: Account };

export type PullRequestPayload = {
  action: string;
  installation?: { id: number };
  repository: Repository;
  pull_request: { number: number; state: string; user: Account; author_association: string };
};

export type IssueCommentPayload = {
  action: string;
  installation?: { id: number };
  repository: Repository;
  issue: { number: number; state: string; pull_request?: unknown };
  comment: { body: string; user: Account; author_association: string };
};

export type Decision = { kind: "review"; job: ReviewJob } | { kind: "ignore"; reason: string };

const REVIEW_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
// Associations that prove write access. Anyone else may still be a maintainer whose org membership
// is private, so they're queued with `verifyUser` and the worker asks GitHub before spending tokens.
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export const COMMAND = "/selfreview";

export function decidePullRequest(p: PullRequestPayload): Decision {
  if (!REVIEW_ACTIONS.has(p.action)) return { kind: "ignore", reason: `action:${p.action}` };
  if (!p.installation) return { kind: "ignore", reason: "no-installation" };
  if (p.pull_request.state !== "open") return { kind: "ignore", reason: "closed" };
  const author = p.pull_request.user;
  if (author.type === "Bot") return { kind: "ignore", reason: "bot-author" }; // repos can opt in later
  return {
    kind: "review",
    job: {
      installationId: p.installation.id,
      repo: p.repository.full_name,
      pr: p.pull_request.number,
      trigger: p.action,
      force: false,
      ...(TRUSTED.has(p.pull_request.author_association) ? {} : { verifyUser: author.login }),
    },
  };
}

export function isCommand(body: string): boolean {
  const firstLine = body.trim().split("\n")[0]?.trim() ?? "";
  return firstLine === COMMAND || firstLine.startsWith(`${COMMAND} `);
}

export function decideIssueComment(p: IssueCommentPayload): Decision {
  if (p.action !== "created") return { kind: "ignore", reason: `action:${p.action}` };
  if (!p.issue.pull_request) return { kind: "ignore", reason: "not-a-pr" };
  if (!isCommand(p.comment.body)) return { kind: "ignore", reason: "not-a-command" };
  if (!p.installation) return { kind: "ignore", reason: "no-installation" };
  if (p.issue.state !== "open") return { kind: "ignore", reason: "closed" };
  if (p.comment.user.type === "Bot") return { kind: "ignore", reason: "bot-comment" };
  return {
    kind: "review",
    job: {
      installationId: p.installation.id,
      repo: p.repository.full_name,
      pr: p.issue.number,
      trigger: "command",
      force: true,
      ...(TRUSTED.has(p.comment.author_association) ? {} : { verifyUser: p.comment.user.login }),
    },
  };
}
