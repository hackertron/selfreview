// Step 7: every rule here exists because skipping it produces noise or broken code (§4.2).
import { createHash } from "node:crypto";
import type { Finding } from "../llm/types";
import { surroundingCode, type FileDiff } from "./diff";

export type Severity = Finding["severity"];
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export type PriorFinding = { path: string; line: number; category: string; fingerprint: string };

export type ValidatedFinding = Finding & { fingerprint: string };

export type ValidationResult = {
  post: ValidatedFinding[]; // inline comments to publish
  outsideDiff: Finding[]; // real but not commentable: mentioned in the summary
  dropped: { finding: Finding; reason: string }[];
};

export function fingerprint(f: Pick<Finding, "path" | "category" | "title">, code: string): string {
  const title = f.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(`${f.path}\n${f.category}\n${title}\n${code}`).digest("hex").slice(0, 12);
}

/** Model output is untrusted: no @mentions (no pinging people), no images or raw HTML. */
export function sanitize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "") // our markers are ours alone
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images can leak data via their URLs
    .replace(/<\/?[a-z][^>]*>/gi, "") // raw HTML
    .replace(/@(?=[A-Za-z0-9-])/g, "@​"); // break mentions with a zero-width space
}

export function validateFindings(
  findings: Finding[],
  diffs: Map<string, FileDiff>,
  prior: PriorFinding[],
  opts: { minSeverity: Severity; maxComments: number },
): ValidationResult {
  const result: ValidationResult = { post: [], outsideDiff: [], dropped: [] };
  const seen = new Set(prior.map((p) => p.fingerprint));
  const ranked = [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  for (const raw of ranked) {
    // One-line title: the comment's first line is read back later to recognise it (render.ts).
    const title = sanitize(raw.title).replace(/\s+/g, " ").trim();
    let f: Finding = { ...raw, title, body: sanitize(raw.body) };
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[opts.minSeverity]) {
      result.dropped.push({ finding: f, reason: "below min_severity" });
      continue;
    }
    const diff = diffs.get(f.path);
    if (!diff) {
      // Not a file this review looked at: the model made the path up.
      result.dropped.push({ finding: f, reason: "unknown file" });
      continue;
    }
    if (!diff.commentable.has(f.line)) {
      result.outsideDiff.push(f);
      continue;
    }
    // A multi-line comment needs every line of its range in the diff, or GitHub rejects the whole
    // review (and the retry would pay for the model again). Fall back to a single-line comment; drop
    // the suggestion too, since it was written to replace the whole range.
    if (f.end_line !== undefined && !rangeInDiff(diff, f.line, f.end_line)) {
      f = { ...f, end_line: undefined, suggestion: undefined };
    }
    const fp = fingerprint(f, surroundingCode(diff, f.line));
    const nearbyRepeat = prior.some((p) => p.path === f.path && p.category === f.category && Math.abs(p.line - f.line) <= 3);
    if (seen.has(fp) || nearbyRepeat) {
      result.dropped.push({ finding: f, reason: "already raised" });
      continue;
    }
    if (result.post.length >= opts.maxComments) {
      result.dropped.push({ finding: f, reason: "max_comments reached" });
      continue;
    }
    if (f.suggestion) f = { ...f, suggestion: dropCopiedLines(f.suggestion, f, diff) };
    const suggestion = safeSuggestion(f, diff) ? f.suggestion : undefined;
    seen.add(fp);
    result.post.push({ ...f, suggestion, fingerprint: fp });
  }
  return result;
}

/**
 * GitHub's "Commit suggestion" REPLACES lines line..end_line. Models often write "add this before
 * the line" instead, and accepting that would delete the original code (seen in M4: a suggested
 * guard replaced `this.links.set(...)`). Keep a suggestion only if it is short, its range is in
 * the diff, and it still contains every non-blank line it replaces.
 */
export function safeSuggestion(f: Finding, diff: FileDiff): boolean {
  if (!f.suggestion) return false;
  if (f.suggestion.includes("```")) return false; // would close the suggestion block early
  const end = f.end_line ?? f.line;
  if (end < f.line || end - f.line >= 6) return false;
  const kept = new Set(f.suggestion.split("\n").map((l) => l.trim()));
  const replaced: string[] = [];
  for (let n = f.line; n <= end; n++) {
    const original = diff.commentable.get(n);
    if (original === undefined) return false;
    if (original.trim() && !kept.has(original.trim())) return false;
    replaced.push(original.trim());
  }
  // Accepting it would change nothing.
  const proposed = f.suggestion.split("\n").map((l) => l.trim());
  if (proposed.join("\n") === replaced.join("\n")) return false;
  return true;
}

/**
 * Models often copy a few lines from just before or after the range into the suggestion, and
 * accepting it would then add those lines a second time (seen at launch: the fix for a missing
 * admin check repeated the line after the route). Remove such copies. A copy made only of
 * brackets stays, since a lone "}" is often new code that closes a block the suggestion opened.
 */
export function dropCopiedLines(suggestion: string, f: Finding, diff: FileDiff): string {
  const lines = suggestion.split("\n");
  const end = f.end_line ?? f.line;
  const matches = (text: string, n: number) => diff.commentable.get(n)?.trim() === text.trim();
  const hasCode = (run: string[]) => run.some((text) => /[A-Za-z0-9]/.test(text));

  // The last k lines repeat the k lines after the range.
  let tail = 0;
  for (let k = 1; k < lines.length; k++) {
    const run = lines.slice(lines.length - k);
    if (hasCode(run) && run.every((text, i) => matches(text, end + 1 + i))) tail = k;
  }

  // The first k lines repeat the k lines before the range.
  let head = 0;
  for (let k = 1; k < lines.length - tail; k++) {
    const run = lines.slice(0, k);
    if (hasCode(run) && run.every((text, i) => matches(text, f.line - k + i))) head = k;
  }

  return lines.slice(head, lines.length - tail).join("\n");
}

const MAX_COMMENT_RANGE = 30;

export function rangeInDiff(diff: FileDiff, start: number, end: number): boolean {
  if (end < start || end - start >= MAX_COMMENT_RANGE) return false;
  for (let n = start; n <= end; n++) if (!diff.commentable.has(n)) return false; // also rejects ranges spanning two hunks
  return true;
}
