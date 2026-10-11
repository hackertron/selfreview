// The one seam between the pipeline and any model (ARCHITECTURE §5.1). Everything else in the
// pipeline (filtering, validation, posting) is the same whichever reviewer is plugged in.
import { z } from "zod";

export const Finding = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  end_line: z.number().int().positive().optional(),
  severity: z.enum(["low", "medium", "high"]),
  category: z.enum(["bug", "security", "performance", "reliability", "maintainability"]),
  title: z.string().min(1).max(200),
  body: z.string().max(4000),
  suggestion: z.string().max(4000).optional(),
});
export type Finding = z.infer<typeof Finding>;

export type ReviewFile = { path: string; patch: string; content?: string };

export type ReviewRequest = {
  pr: { title: string; body: string };
  instructions: string;
  files: ReviewFile[];
  /** issues already raised on this PR, so the model doesn't repeat itself (M4) */
  alreadyRaised: { path: string; line: number; title: string }[];
};

export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };

export type ReviewResult = {
  findings: Finding[];
  usage: Usage;
  /** exact cost when the provider reports it (OpenRouter does); otherwise priced from the table */
  costUsd?: number;
  /** findings dropped because they didn't match the schema */
  invalid?: number;
};

export interface Reviewer {
  id: string; // "provider:model", recorded on the review
  /** Upper bounds for one review() call, used to reserve the worst-case cost against the budget. */
  limits: { maxOutputTokens: number; maxCalls: number };
  /** `signal` aborts the model call, e.g. when the job ran out of time and was handed to a retry. */
  review(req: ReviewRequest, options?: { signal?: AbortSignal }): Promise<ReviewResult>;
}

/**
 * A review call that failed after the provider had already billed tokens (e.g. an answer that
 * never matched the schema). Carries what was spent, so the monthly budget still counts it.
 */
export class BilledFailure extends Error {
  constructor(
    message: string,
    readonly usage: Usage,
    readonly costUsd?: number,
  ) {
    super(message);
  }
}
