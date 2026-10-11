// Model ids are "provider:model" (ARCHITECTURE §5.2), e.g. "openrouter:anthropic/claude-haiku-5.5"
// or "anthropic:claude-sonnet-5-5". This turns ids into reviewers and prices their usage.
import { anthropicReviewer } from "./anthropic";
import { openAiCompatibleReviewer } from "./openai-compatible";
import type { Reviewer, Usage } from "./types";

export const PROVIDERS = ["anthropic", "openai", "openrouter", "openai-compatible"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ModelSpec = { id: string; provider: Provider; model: string };

export type ProviderKeys = {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_COMPATIBLE_API_KEY?: string;
  OPENAI_COMPATIBLE_BASE_URL?: string;
};

export function parseModelId(id: string): ModelSpec {
  const colon = id.indexOf(":");
  const provider = id.slice(0, colon) as Provider;
  const model = id.slice(colon + 1);
  if (colon < 1 || !model || !PROVIDERS.includes(provider)) {
    throw new Error(`model "${id}" must look like provider:model, provider one of ${PROVIDERS.join(", ")}`);
  }
  return { id, provider, model };
}

/** Extra models a repo may pick in .selfreview.yml when ALLOWED_MODELS isn't set (all cheap). */
export function defaultAllowed(keys: ProviderKeys): string[] {
  if (!keys.OPENROUTER_API_KEY) return [];
  return ["openrouter:z-ai/glm-5.3-flash", "openrouter:deepseek/deepseek-v4-flash", "openrouter:deepseek/deepseek-v4-pro", "openrouter:openai/gpt-oss-120b"];
}

/** Sensible defaults from whichever key is present: just add a key and it works. */
export function defaultModels(keys: ProviderKeys): { small: string; large: string } {
  // Cheap open-weight model by default. On the first demo PR GLM 5.3 was the only cheap model to
  // catch both planted bugs, at under a cent, and the M5 benchmark kept it for both tiers.
  if (keys.OPENROUTER_API_KEY) return { small: "openrouter:z-ai/glm-5.3", large: "openrouter:z-ai/glm-5.3" };
  if (keys.ANTHROPIC_API_KEY) return { small: "anthropic:claude-haiku-5-5", large: "anthropic:claude-sonnet-5-5" };
  throw new Error("no model configured: set OPENROUTER_API_KEY on the worker service (or ANTHROPIC_API_KEY, or MODEL_SMALL and MODEL_LARGE with their provider's key)");
}

export function createReviewer(spec: ModelSpec, keys: ProviderKeys): Reviewer {
  const need = (key: keyof ProviderKeys) => {
    const value = keys[key];
    if (!value) throw new Error(`${spec.id} needs ${key} on the worker service`);
    return value;
  };
  switch (spec.provider) {
    case "anthropic":
      return anthropicReviewer(spec.model, need("ANTHROPIC_API_KEY"));
    case "openai":
      return openAiCompatibleReviewer({ id: spec.id, model: spec.model, apiKey: need("OPENAI_API_KEY") });
    case "openrouter":
      return openAiCompatibleReviewer({
        id: spec.id, model: spec.model, apiKey: need("OPENROUTER_API_KEY"), baseURL: "https://openrouter.ai/api/v1", openrouter: true,
      });
    case "openai-compatible":
      return openAiCompatibleReviewer({
        id: spec.id, model: spec.model, apiKey: keys.OPENAI_COMPATIBLE_API_KEY ?? "none", baseURL: need("OPENAI_COMPATIBLE_BASE_URL"),
      });
  }
}

// ---- pricing ($ per 1M tokens) ----

export type Price = { input: number; output: number; cachedInput: number };

// Anthropic list prices. OpenRouter prices are fetched from its public model list instead.
const STATIC_PRICES: Record<string, Price> = {
  "anthropic:claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.4 },
};

export type PriceTable = Record<string, Price>;

/** OpenRouter's price list couldn't be fetched. Transient: the job is retried, never run uncapped. */
export class PriceUnavailableError extends Error {}

let openRouterPrices: { at: number; prices: Map<string, Price> } | null = null;

async function openRouterPrice(model: string): Promise<Price | null> {
  if (!openRouterPrices || Date.now() - openRouterPrices.at > 24 * 3600 * 1000) {
    let data: { id: string; pricing?: Record<string, string> }[];
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = ((await res.json()) as { data: typeof data }).data;
    } catch (err) {
      throw new PriceUnavailableError(`OpenRouter price list unavailable: ${(err as Error).message}`);
    }
    const prices = new Map<string, Price>();
    for (const m of data) {
      const per1M = (v?: string) => (v ? Number(v) * 1e6 : 0);
      prices.set(m.id, {
        input: per1M(m.pricing?.prompt),
        output: per1M(m.pricing?.completion),
        cachedInput: per1M(m.pricing?.input_cache_read ?? m.pricing?.prompt),
      });
    }
    openRouterPrices = { at: Date.now(), prices };
  }
  return openRouterPrices.prices.get(model) ?? null;
}

/**
 * $ per 1M tokens for a model, or null when unknown (the pipeline then refuses to run the model:
 * a budget cap must never be silently skipped). Order: the operator's MODEL_PRICES, built-in
 * Anthropic prices, OpenRouter's live list. `openai-compatible:` endpoints have no default, paid
 * or self-hosted, so they must be priced in MODEL_PRICES (use 0 for your own GPU box).
 */
export async function priceFor(spec: ModelSpec, overrides: PriceTable = {}): Promise<Price | null> {
  const override = overrides[spec.id];
  if (override) return override;
  if (spec.provider === "openrouter") return openRouterPrice(spec.model);
  return STATIC_PRICES[spec.id] ?? null;
}

export function costOf(price: Price, usage: Usage): number {
  const uncached = Math.max(usage.inputTokens - usage.cachedInputTokens, 0);
  return (uncached * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) / 1e6;
}

// ---- the worker's registry: tiers, repo overrides, allow-list ----

export class ModelRegistry {
  private reviewers = new Map<string, Reviewer>();
  readonly small: ModelSpec;
  readonly large: ModelSpec;
  readonly allowed: Set<string>;

  readonly prices: PriceTable;

  constructor(
    private readonly keys: ProviderKeys,
    opts: { small?: string; large?: string; allowed?: string; prices?: PriceTable },
  ) {
    this.prices = opts.prices ?? {};
    const defaults = opts.small && opts.large ? { small: opts.small, large: opts.large } : defaultModels(keys);
    this.small = parseModelId(opts.small ?? defaults.small);
    this.large = parseModelId(opts.large ?? defaults.large);
    const extra = opts.allowed !== undefined ? opts.allowed.split(",").map((s) => s.trim()).filter(Boolean) : defaultAllowed(keys);
    this.allowed = new Set([this.small.id, this.large.id, ...extra]);
    // Fail at startup, not mid-review, if a configured model has no key.
    this.reviewer(this.small);
    this.reviewer(this.large);
  }

  /** The tier's model, or the repo's override if the operator allows it. */
  pick(tier: "small" | "large", override?: string): { spec: ModelSpec; note?: string } {
    const fallback = tier === "small" ? this.small : this.large;
    if (!override || override === fallback.id) return { spec: fallback };
    if (!this.allowed.has(override)) return { spec: fallback, note: `.selfreview.yml asked for ${override}, which isn't in ALLOWED_MODELS` };
    return { spec: parseModelId(override) };
  }

  reviewer(spec: ModelSpec): Reviewer {
    let r = this.reviewers.get(spec.id);
    if (!r) {
      r = createReviewer(spec, this.keys);
      this.reviewers.set(spec.id, r);
    }
    return r;
  }
}
