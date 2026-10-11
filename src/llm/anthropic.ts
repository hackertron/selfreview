// Claude through Anthropic's own SDK, with native structured output (`output_config.format`).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { ModelOutput, toFindings } from "./schema";
import { BilledFailure, type Reviewer, type Usage } from "./types";

const MAX_OUTPUT_TOKENS = 8000;
const REQUEST_TIMEOUT_MS = 3 * 60_000; // keeps even a retried call well inside the job's time limit

export function anthropicReviewer(model: string, apiKey: string): Reviewer {
  // The SDK retries 429/5xx with backoff.
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: REQUEST_TIMEOUT_MS });
  return {
    id: `anthropic:${model}`,
    limits: { maxOutputTokens: MAX_OUTPUT_TOKENS, maxCalls: 1 }, // SDK retries are for failed calls, which aren't billed
    async review(req, options = {}) {
      const res = await client.messages.parse(
        {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(req) }],
          output_config: { format: zodOutputFormat(ModelOutput) },
        },
        { signal: options.signal },
      );
      const usage: Usage = {
        inputTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
        cachedInputTokens: res.usage.cache_read_input_tokens ?? 0,
      };
      // Both failures below come after a billed call, so they carry its usage for the budget.
      if (res.stop_reason === "refusal") {
        throw new BilledFailure("model refused to review this change", usage);
      }
      if (!res.parsed_output) {
        throw new BilledFailure(`no structured output (stop_reason: ${res.stop_reason})`, usage);
      }
      const { findings, invalid } = toFindings(res.parsed_output);
      return { findings, invalid, usage };
    },
  };
}
