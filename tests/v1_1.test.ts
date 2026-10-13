// v1.1: edited one-click fixes, incremental reviews, the check, accounts, the default budget,
// and the dashboard's update notice.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { isAllowedAccount } from "../src/github/accounts";
import type { Finding } from "../src/llm/types";
import { newFindingSeverities, reviewConclusion, reviewTitle, stillFailing } from "../src/pipeline/check";
import { parsePatch } from "../src/pipeline/diff";
import type { ChangedFile } from "../src/pipeline/filter";
import { newChangesFrom } from "../src/pipeline/incremental";
import { renderSummary } from "../src/pipeline/render";
import { parseRepoConfig } from "../src/pipeline/repo-config";
import { lineSimilarity, safeSuggestion } from "../src/pipeline/validate";
import { createUpdateCheck } from "../src/web/updates";

const finding = (over: Partial<Finding>): Finding => ({
  path: "a.ts",
  line: 2,
  severity: "high",
  category: "security",
  title: "Missing admin check",
  body: "Any signed-in user can list every account.",
  ...over,
});

describe("one-click fixes that edit a line", () => {
  const diff = parsePatch(
    '@@ -1,2 +1,3 @@\n import { sql } from "bun";\n+admin.get("/users", async (c) => {\n   return c.json({});',
  );

  test("kept when the line is edited, e.g. a missing middleware added", () => {
    const fix = 'admin.get("/users", requireUser, requireAdmin, async (c) => {';
    expect(safeSuggestion(finding({ suggestion: fix }), diff)).toBe(true);
  });

  test("dropped when the line is replaced by something else (it would delete the route)", () => {
    const fix = 'if (!c.get("user").isAdmin) return c.json({ error: "admins only" }, 403);';
    expect(safeSuggestion(finding({ suggestion: fix }), diff)).toBe(false);
  });

  test("line similarity: edits score high, unrelated lines low", () => {
    expect(lineSimilarity("if (count > 0) {", "if (count >= 0) {")).toBeGreaterThan(0.8);
    expect(lineSimilarity("this.links.set(slug, link);", 'if (this.links.has(slug)) throw new Error("taken");')).toBeLessThan(0.5);
    expect(lineSimilarity("", "")).toBe(1);
  });
});

describe("incremental reviews", () => {
  const file = (filename: string): ChangedFile => ({ filename, status: "modified", additions: 1, deletions: 0, patch: "@@" });

  test("only the files changed since the last review, when the new commits build on it", () => {
    expect(newChangesFrom({ status: "ahead", files: [file("src/a.ts")] })).toEqual([file("src/a.ts")]);
  });

  test("a rewritten history (rebase, force-push) means a full review", () => {
    expect(newChangesFrom({ status: "diverged", files: [file("src/a.ts")] })).toBeNull();
    expect(newChangesFrom({ status: "behind" })).toBeNull();
  });

  test("a file list GitHub may have cut off means a full review", () => {
    const many = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`));
    expect(newChangesFrom({ status: "ahead", files: many })).toBeNull();
  });

  test("the summary says which changes were reviewed", () => {
    const summary = renderSummary({
      sha: "bbbbbbb1234", since: "aaaaaaa5678", posted: [], outsideDiff: [], skippedFiles: [],
      filesReviewed: 1, model: "openrouter:z-ai/glm-5.3", costUsd: 0.001,
    });
    expect(summary).toContain("Reviewed `bbbbbbb` (changes since `aaaaaaa`)");
  });
});

describe("the Selfreview check", () => {
  test("no new findings is a success", () => {
    expect(reviewConclusion([], "high")).toBe("success");
    expect(reviewTitle([])).toBe("No new findings");
  });

  test("findings are neutral unless fail_on is reached", () => {
    expect(reviewConclusion(["high"], "never")).toBe("neutral");
    expect(reviewConclusion(["medium"], "high")).toBe("neutral");
    expect(reviewConclusion(["medium", "low"], "medium")).toBe("failure");
    expect(reviewConclusion(["high"], "medium")).toBe("failure");
  });

  test("counts findings outside the changed lines and ones cut by max_comments, not repeats", () => {
    const high = finding({ severity: "high" });
    const severities = newFindingSeverities({
      post: [{ ...finding({ severity: "low" }), fingerprint: "0123456789ab" }],
      outsideDiff: [high],
      dropped: [
        { finding: finding({ severity: "medium" }), reason: "max_comments reached" },
        { finding: high, reason: "already raised" },
      ],
    });
    expect(severities).toEqual(["low", "high", "medium"]);
    expect(reviewConclusion(severities, "high")).toBe("failure");
  });

  test("a failed check stays failed on later pushes until a full review passes", () => {
    expect(stillFailing("success", "failure")).toBe(true);
    expect(stillFailing("neutral", "failure")).toBe(true);
    expect(stillFailing("failure", "failure")).toBe(false); // already failing
    expect(stillFailing("success", "success")).toBe(false);
    expect(stillFailing("success", null)).toBe(false); // no earlier check
  });

  test("the title counts findings by severity", () => {
    expect(reviewTitle(["high", "medium", "high"])).toBe("3 new findings (2 high, 1 medium)");
    expect(reviewTitle(["low"])).toBe("1 new finding (1 low)");
  });

  test("fail_on comes from .selfreview.yml and defaults to never", () => {
    expect(parseRepoConfig(null).config.fail_on).toBe("never");
    expect(parseRepoConfig("fail_on: high").config.fail_on).toBe("high");
    expect(parseRepoConfig("fail_on: sometimes").warning).toContain("fail_on");
  });
});

describe("accounts", () => {
  test("the app's owner is always allowed; others only when listed (case doesn't matter)", () => {
    expect(isAllowedAccount("Hackertron", "hackertron", [])).toBe(true);
    expect(isAllowedAccount("acme", "hackertron", [])).toBe(false);
    expect(isAllowedAccount("ACME", "hackertron", ["acme"])).toBe(true);
  });

  test("ALLOWED_ACCOUNTS is a comma-separated list", () => {
    const config = loadConfig({ ROLE: "api", DATABASE_URL: "x", ALLOWED_ACCOUNTS: " Acme, selfreviewhq ,," });
    expect(config.ALLOWED_ACCOUNTS).toEqual(["acme", "selfreviewhq"]);
    expect(loadConfig({ ROLE: "api", DATABASE_URL: "x" }).ALLOWED_ACCOUNTS).toEqual([]);
  });
});

describe("monthly budget", () => {
  test("on by default ($10), so a fresh deploy can't run up a bill", () => {
    expect(loadConfig({ ROLE: "worker", DATABASE_URL: "x" }).MONTHLY_BUDGET_USD).toBe(10);
    expect(loadConfig({ ROLE: "worker", DATABASE_URL: "x", MONTHLY_BUDGET_USD: "25" }).MONTHLY_BUDGET_USD).toBe(25);
  });
});

describe("update notice", () => {
  const github = (body: object, ok = true) => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: ok ? 200 : 404 });
    };
    return { calls, fetcher };
  };

  test("shows how many commits the main branch has that this deploy doesn't", async () => {
    const { calls, fetcher } = github({ status: "ahead", ahead_by: 3, html_url: "https://github.com/x/compare" });
    const check = createUpdateCheck("hackertron/selfreview", "abc1234def", fetcher);
    expect(await check()).toEqual({ runningSha: "abc1234def", newCommits: 3, compareUrl: "https://github.com/x/compare" });
    expect(calls[0]).toBe("https://api.github.com/repos/hackertron/selfreview/compare/abc1234def...HEAD");
  });

  test("asks GitHub once, then answers from the cache", async () => {
    const { calls, fetcher } = github({ status: "ahead", ahead_by: 1, html_url: "u" });
    const check = createUpdateCheck("hackertron/selfreview", "abc", fetcher);
    await check();
    await check();
    expect(calls.length).toBe(1);
  });

  test("nothing to show when up to date, unknown, or GitHub fails", async () => {
    const upToDate = github({ status: "identical", ahead_by: 0, html_url: "u" });
    expect(await createUpdateCheck("r/r", "abc", upToDate.fetcher)()).toBeNull();
    expect(await createUpdateCheck("r/r", undefined, upToDate.fetcher)()).toBeNull();
    const fork = github({}, false);
    expect(await createUpdateCheck("r/r", "abc", fork.fetcher)()).toBeNull();
    const broken = async () => {
      throw new Error("offline");
    };
    expect(await createUpdateCheck("r/r", "abc", broken)()).toBeNull();
  });
});
