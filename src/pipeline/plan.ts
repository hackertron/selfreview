// Step 5: plan the review. Pure functions: which model tier, how to split big PRs into chunks
// that fit the context window, and roughly what it will cost before spending anything.
import { costOf, type Price } from "../llm/models";
import { SYSTEM_PROMPT, buildUserPrompt } from "../llm/prompt";
import type { Reviewer, ReviewFile, ReviewRequest } from "../llm/types";

/** Rough token count (≈ 4 characters per token). Used for budgets, not billing. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export const CHUNK_TOKEN_BUDGET = 60_000;
export const EXPECTED_OUTPUT_TOKENS = 1_500; // per chunk, for the cost estimate

export function pickTier(
  files: { path: string; changedLines: number }[],
  riskyPaths: string[],
  smallDiffLines: number,
): "small" | "large" {
  const risky = files.some((f) => riskyPaths.some((p) => new Bun.Glob(p).match(f.path)));
  const changed = files.reduce((n, f) => n + f.changedLines, 0);
  return risky || changed >= smallDiffLines ? "large" : "small";
}

/**
 * Greedy packing: files in path order, a new chunk when the budget is reached. A file whose full
 * content doesn't fit is sent as a diff only; a diff that alone doesn't fit is skipped.
 */
export function planChunks(
  files: ReviewFile[],
  base: Omit<ReviewRequest, "files">,
  budget = CHUNK_TOKEN_BUDGET,
): { chunks: ReviewFile[][]; tooLarge: string[] } {
  const overhead = estimateTokens(SYSTEM_PROMPT) + estimateTokens(buildUserPrompt({ ...base, files: [] }));
  const room = budget - overhead;
  const chunks: ReviewFile[][] = [];
  const tooLarge: string[] = [];
  let current: ReviewFile[] = [];
  let used = 0;
  // A file's own size, without the PR text and instructions already counted in `overhead`.
  const cost = (f: ReviewFile) => {
    const fileOnly = { ...base, pr: { title: "", body: "" }, alreadyRaised: [], instructions: "", files: [f] };
    return estimateTokens(buildUserPrompt(fileOnly));
  };

  for (const original of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    let file = original;
    if (cost(file) > room && file.content !== undefined) file = { path: file.path, patch: file.patch };
    const size = cost(file);
    if (size > room) {
      tooLarge.push(file.path);
      continue;
    }
    if (used + size > room && current.length) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(file);
    used += size;
  }
  if (current.length) chunks.push(current);
  return { chunks, tooLarge };
}

export function chunkInputTokens(chunk: ReviewFile[], base: Omit<ReviewRequest, "files">): number {
  return estimateTokens(SYSTEM_PROMPT) + estimateTokens(buildUserPrompt({ ...base, files: chunk }));
}

/**
 * Run `fn` over items with at most `limit` in flight (keeps provider rate limits happy).
 * After the first failure no new item starts, and the calls already running are allowed to
 * finish before the error is thrown, so whatever they spent is known by then.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const errors: unknown[] = [];

  const runner = async () => {
    while (errors.length === 0 && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));

  if (errors.length) throw errors[0];
  return results;
}

/**
 * The most a review can cost, for MONTHLY_BUDGET_USD reservations: every call uses all its output
 * tokens, a retry resends the conversation plus the previous answer, and the input estimate gets a
 * 2× margin (≈ 4 characters per token can undercount, e.g. for dense code).
 */
export function worstCaseCost(chunks: ReviewFile[][], base: Omit<ReviewRequest, "files">, price: Price, limits: Reviewer["limits"]): number {
  let total = 0;
  for (const chunk of chunks) {
    const input = chunkInputTokens(chunk, base) * 2;
    for (let call = 0; call < limits.maxCalls; call++) {
      total += costOf(price, { inputTokens: input + call * limits.maxOutputTokens, outputTokens: limits.maxOutputTokens, cachedInputTokens: 0 });
    }
  }
  return total;
}
