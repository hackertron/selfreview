// Any OpenAI-compatible chat API: OpenAI itself, OpenRouter (Claude, GPT, DeepSeek, Gemini… behind
// one key), DeepSeek's API, or a self-hosted vLLM/Ollama. Asks for strict JSON-schema output and
// validates it; if a model still answers with bad JSON, it gets one chance to correct itself.
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { MODEL_OUTPUT_JSON_SCHEMA, ModelOutput, toFindings } from "./schema";
import { BilledFailure, type Reviewer, type Usage } from "./types";

const MAX_OUTPUT_TOKENS = 16_000; // includes any reasoning tokens
const MAX_CALLS = 2; // one retry when the answer doesn't match the schema
const REQUEST_TIMEOUT_MS = 3 * 60_000; // keeps even a retried call well inside the job's time limit

export type CompatibleOptions = {
  id: string; // e.g. "openrouter:anthropic/claude-sonnet-5.5"
  model: string;
  apiKey: string;
  baseURL?: string;
  openrouter?: boolean;
};

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(trimmed);
}

export function openAiCompatibleReviewer(opts: CompatibleOptions): Reviewer {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    maxRetries: 2, // SDK retries 429/5xx with backoff
    timeout: REQUEST_TIMEOUT_MS,
    // OpenRouter's optional attribution headers (shows "Selfreview" in their dashboard)
    defaultHeaders: opts.openrouter ? { "HTTP-Referer": "https://github.com/hackertron/selfreview", "X-Title": "Selfreview" } : undefined,
  });

  // Not every model accepts OpenRouter's `reasoning` setting. With require_parameters, sending it
  // to such a model matches no provider (404); then retry without it and remember (M5: Qwen3 Coder).
  let sendReasoning = opts.openrouter ?? false;

  return {
    id: opts.id,
    limits: { maxOutputTokens: MAX_OUTPUT_TOKENS, maxCalls: MAX_CALLS },
    async review(req, options = {}) {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(req) },
      ];
      const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      let costUsd: number | undefined;
      let lastProblem = "";

      for (let attempt = 0; attempt < MAX_CALLS; attempt++) {
        const body = {
          model: opts.model,
          messages,
          max_tokens: MAX_OUTPUT_TOKENS,
          response_format: {
            type: "json_schema" as const,
            json_schema: { name: "review", strict: true, schema: MODEL_OUTPUT_JSON_SCHEMA as Record<string, unknown> },
          },
          // OpenRouter: report the exact cost, only route to providers that honour the schema, and cap
          // "thinking": unbounded, GLM 5.3 spent its whole 8k budget reasoning and never answered (M4).
          ...(opts.openrouter ? { usage: { include: true }, provider: { require_parameters: true } } : {}),
          ...(sendReasoning ? { reasoning: { effort: "low" } } : {}),
        };
        let res: OpenAI.Chat.ChatCompletion;
        try {
          const params = body as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
          res = await client.chat.completions.create(params, { signal: options.signal });
        } catch (err) {
          const noEndpoint = err instanceof OpenAI.APIError && err.status === 404 && /No endpoints found/i.test(err.message);
          if (!sendReasoning || !noEndpoint) throw err;
          sendReasoning = false;
          attempt--; // this try didn't count
          continue;
        }
        usage.inputTokens += res.usage?.prompt_tokens ?? 0;
        usage.outputTokens += res.usage?.completion_tokens ?? 0;
        usage.cachedInputTokens += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const reported = (res.usage as { cost?: number } | undefined)?.cost;
        if (typeof reported === "number") costUsd = (costUsd ?? 0) + reported;

        const text = res.choices[0]?.message?.content ?? "";
        let error: string;
        try {
          const parsed = ModelOutput.safeParse(parseJson(text));
          if (parsed.success) {
            const { findings, invalid } = toFindings(parsed.data);
            return { findings, invalid, usage, costUsd };
          }
          error = parsed.error.message.slice(0, 500);
        } catch {
          error = res.choices[0]?.finish_reason === "length" ? "the answer was cut off" : "not valid JSON";
        }
        // why it failed, without logging the content (it may quote code)
        lastProblem = `${error}; finish_reason=${res.choices[0]?.finish_reason}; answer ${text.length} chars; output tokens ${res.usage?.completion_tokens}`;
        messages.push(
          { role: "assistant", content: text },
          { role: "user", content: `That answer did not match the schema (${error}). Reply with only the JSON object.` },
        );
      }
      // Both calls were billed, so the error carries their usage for the budget.
      const message = `${opts.id}: output did not match the schema after a retry (${lastProblem})`;
      throw new BilledFailure(message, usage, costUsd);
    },
  };
}
