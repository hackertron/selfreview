// The shape we force the model to answer in (structured output). Kept deliberately plain:
// providers' strict JSON-schema modes reject length/number constraints and optional fields, so
// every field is required (null when absent) and the real checks happen afterwards with `Finding`.
import { z } from "zod";
import { Finding } from "./types";

export const ModelFinding = z.object({
  path: z.string(),
  line: z.number().int(),
  end_line: z.number().int().nullable(),
  severity: z.enum(["low", "medium", "high"]),
  category: z.enum(["bug", "security", "performance", "reliability", "maintainability"]),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
});

export const ModelOutput = z.object({ findings: z.array(ModelFinding) });
export type ModelOutput = z.infer<typeof ModelOutput>;

/** Strict modes reject numeric bounds (zod adds safe-integer ones) and `$schema`; drop them. */
function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => !["$schema", "minimum", "maximum"].includes(k))
        .map(([k, v]) => [k, stripUnsupported(v)]),
    );
  }
  return node;
}

/** JSON Schema for OpenAI-style `response_format` (strict mode: all required, no extras). */
export const MODEL_OUTPUT_JSON_SCHEMA = stripUnsupported(z.toJSONSchema(ModelOutput, { target: "draft-7" })) as Record<string, unknown>;

/** Turn model output into findings, dropping (not failing on) any single malformed one. */
export function toFindings(output: ModelOutput): { findings: Finding[]; invalid: number } {
  const findings: Finding[] = [];
  let invalid = 0;
  for (const f of output.findings) {
    const parsed = Finding.safeParse({
      ...f,
      end_line: f.end_line ?? undefined,
      suggestion: f.suggestion ?? undefined,
    });
    if (parsed.success) findings.push(parsed.data);
    else invalid++;
  }
  return { findings, invalid };
}
