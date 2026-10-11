import { describe, expect, test } from "bun:test";
import {
  decideIssueComment,
  decidePullRequest,
  isCommand,
  type IssueCommentPayload,
  type PullRequestPayload,
} from "../src/github/triggers";

const pr = (over: Partial<PullRequestPayload["pull_request"]> = {}, action = "opened"): PullRequestPayload => ({
  action,
  installation: { id: 42 },
  repository: { full_name: "acme/api", owner: { login: "acme", type: "Organization" } },
  pull_request: { number: 7, state: "open", user: { login: "dev", type: "User" }, author_association: "MEMBER", ...over },
});

describe("pull_request", () => {
  test("a member's new PR becomes a review job for the PR (no commit SHA)", () => {
    expect(decidePullRequest(pr())).toEqual({
      kind: "review",
      job: { installationId: 42, repo: "acme/api", pr: 7, trigger: "opened", force: false },
    });
  });

  test("pushes, reopen and ready-for-review trigger; other actions don't", () => {
    for (const a of ["synchronize", "reopened", "ready_for_review"]) expect(decidePullRequest(pr({}, a)).kind).toBe("review");
    for (const a of ["closed", "labeled", "edited", "assigned"]) expect(decidePullRequest(pr({}, a))).toEqual({ kind: "ignore", reason: `action:${a}` });
  });

  test("bot authors (Dependabot, Renovate) are skipped", () => {
    expect(decidePullRequest(pr({ user: { login: "dependabot[bot]", type: "Bot" } }))).toEqual({ kind: "ignore", reason: "bot-author" });
  });

  test("outside contributors are queued only with a permission check, never trusted outright", () => {
    const d = decidePullRequest(pr({ author_association: "FIRST_TIME_CONTRIBUTOR", user: { login: "stranger", type: "User" } }));
    expect(d.kind === "review" && d.job.verifyUser).toBe("stranger");
  });
});

const comment = (body: string, over: Partial<IssueCommentPayload["comment"]> = {}): IssueCommentPayload => ({
  action: "created",
  installation: { id: 42 },
  repository: { full_name: "acme/api", owner: { login: "acme", type: "Organization" } },
  issue: { number: 7, state: "open", pull_request: {} },
  comment: { body, user: { login: "lead", type: "User" }, author_association: "OWNER", ...over },
});

describe("/selfreview command", () => {
  test("recognises the command only at the start of the comment", () => {
    expect(isCommand("/selfreview")).toBe(true);
    expect(isCommand("  /selfreview please\nthanks")).toBe(true);
    expect(isCommand("/selfreviewer")).toBe(false);
    expect(isCommand("can someone run /selfreview?")).toBe(false);
  });

  test("a maintainer's command forces a re-review", () => {
    const d = decideIssueComment(comment("/selfreview"));
    expect(d.kind === "review" && d.job).toEqual({ installationId: 42, repo: "acme/api", pr: 7, trigger: "command", force: true });
  });

  test("comments on issues (not PRs), edits and bots are ignored", () => {
    expect(decideIssueComment({ ...comment("/selfreview"), issue: { number: 7, state: "open" } }).kind).toBe("ignore");
    expect(decideIssueComment({ ...comment("/selfreview"), action: "edited" }).kind).toBe("ignore");
    expect(decideIssueComment(comment("/selfreview", { user: { login: "x[bot]", type: "Bot" } })).kind).toBe("ignore");
  });

  test("a non-maintainer's command needs a permission check", () => {
    const d = decideIssueComment(comment("/selfreview", { author_association: "CONTRIBUTOR", user: { login: "someone", type: "User" } }));
    expect(d.kind === "review" && d.job.verifyUser).toBe("someone");
  });
});
