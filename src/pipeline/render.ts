// What we post on GitHub. Each piece ends with an invisible marker so the worker can recognise
// its own work later without storing any text (§4.4).
import type { Finding } from "../llm/types";
import type { ValidatedFinding } from "./validate";

export const markers = {
  review: (sha: string) => `<!-- selfreview:sha=${sha} -->`,
  finding: (fp: string) => `<!-- selfreview:fp=${fp} -->`,
  summary: "<!-- selfreview:summary -->",
};

export const findingMarkerPattern = /<!-- selfreview:fp=([0-9a-f]{12}) -->/;

const SEVERITY_ICON = { high: "🔴", medium: "🟠", low: "🟡" } as const;
const ICON_SEVERITY = { "🔴": "high", "🟠": "medium", "🟡": "low" } as const;
const CATEGORIES = ["bug", "security", "performance", "reliability", "maintainability"] as const;

/** Reads back the metadata we rendered into a comment (used when adopting a review after a crash). */
export function parseRenderedComment(body: string) {
  const fp = findingMarkerPattern.exec(body)?.[1];
  const head = /^(🔴|🟠|🟡) \*\*(.*)\*\* · _([a-z]+)_/u.exec(body);
  if (!fp || !head) return null;
  const category = CATEGORIES.find((c) => c === head[3]);
  if (!category) return null;
  return { fingerprint: fp, severity: ICON_SEVERITY[head[1] as keyof typeof ICON_SEVERITY], category, title: head[2] ?? "" };
}

export function renderComment(f: ValidatedFinding): string {
  const parts = [`${SEVERITY_ICON[f.severity]} **${f.title}** · _${f.category}_`, "", f.body];
  if (f.suggestion) parts.push("", "```suggestion", f.suggestion, "```");
  parts.push("", markers.finding(f.fingerprint));
  return parts.join("\n");
}

export function renderReviewBody(sha: string, count: number): string {
  return `**Selfreview** found ${count} new ${count === 1 ? "issue" : "issues"} in \`${sha.slice(0, 7)}\`.\n\n${markers.review(sha)}`;
}

export type SummaryData = {
  sha: string;
  posted: ValidatedFinding[];
  outsideDiff: Finding[];
  skippedFiles: { path: string; reason: string }[];
  filesReviewed: number;
  model: string;
  costUsd: number;
  warning?: string;
  skipReason?: string;
};

// GitHub rejects comments over 65,536 characters; a PR with thousands of vendored files would
// otherwise fail every attempt at this step.
const MAX_LIST_ITEMS = 50;

function capped(items: string[]): string[] {
  if (items.length <= MAX_LIST_ITEMS) return items;
  const more = items.length - MAX_LIST_ITEMS;
  return [...items.slice(0, MAX_LIST_ITEMS), `- …and ${more} more`];
}

export function renderSummary(d: SummaryData): string {
  const lines = [markers.summary, "### Selfreview", ""];
  if (d.skipReason) {
    lines.push(`Skipped \`${d.sha.slice(0, 7)}\`: ${d.skipReason}.`);
  } else {
    const n = d.posted.length;
    const bySeverity = (["high", "medium", "low"] as const)
      .map((s) => [s, d.posted.filter((f) => f.severity === s).length] as const)
      .filter(([, c]) => c > 0)
      .map(([s, c]) => `${c} ${s}`)
      .join(", ");
    lines.push(
      `Reviewed \`${d.sha.slice(0, 7)}\` · ${d.filesReviewed} ${d.filesReviewed === 1 ? "file" : "files"} · ` +
        (n ? `**${n} new ${n === 1 ? "finding" : "findings"}** (${bySeverity})` : "no new findings") +
        ` · \`${d.model}\` · $${d.costUsd.toFixed(4)}`,
    );
  }
  if (d.outsideDiff.length) {
    lines.push("", "<details><summary>Also noticed, outside the changed lines</summary>", "");
    const items = d.outsideDiff.map((f) => `- \`${f.path}:${f.line}\` ${f.title}`);
    lines.push(...capped(items), "", "</details>");
  }
  if (d.skippedFiles.length) {
    lines.push("", `<details><summary>Not reviewed (${d.skippedFiles.length})</summary>`, "");
    const items = d.skippedFiles.map((s) => `- \`${s.path}\`: ${s.reason}`);
    lines.push(...capped(items), "", "</details>");
  }
  if (d.warning) lines.push("", `> ⚠️ ${d.warning}`);
  lines.push("", "<sub>Self-hosted on Railway. Comment `/selfreview` to re-run.</sub>");
  return lines.join("\n");
}
