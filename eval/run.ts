// Benchmark: review every case in eval/cases with every model, several times, using the exact
// production prompt + validation (src/llm, src/pipeline/validate). Posts nothing anywhere.
//
//   bun eval/run.ts                       # all default models, 3 runs each
//   bun eval/run.ts --runs 1 --models openrouter:z-ai/glm-5.3
//
// Results are appended to eval/results/raw.jsonl as they arrive, so an interrupted run resumes
// where it stopped. OPENROUTER_API_KEY comes from .env (Bun loads it automatically).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ModelRegistry, costOf, parseModelId, priceFor } from "../src/llm/models";
import type { Finding, ReviewFile } from "../src/llm/types";
import { parsePatch } from "../src/pipeline/diff";
import { mapLimit } from "../src/pipeline/plan";
import { RepoConfig } from "../src/pipeline/repo-config";
import { validateFindings } from "../src/pipeline/validate";

export const DEFAULT_MODELS = [
  "openrouter:z-ai/glm-5.3",
  "openrouter:z-ai/glm-5.3-flash",
  "openrouter:deepseek/deepseek-v4-flash",
  "openrouter:deepseek/deepseek-v4-pro",
  "openrouter:qwen/qwen3-coder-next",
  "openrouter:openai/gpt-oss-120b",
];
export const LINE_TOLERANCE = 3; // a finding within ±3 lines of the planted bug counts as caught

const CASES_DIR = path.join(import.meta.dir, "cases");
export const RESULTS_FILE = path.join(import.meta.dir, "results", "raw.jsonl");

export type CaseMeta = {
  id: string;
  category: string;
  title: string;
  description: string;
  files: { path: string; isNew: boolean }[];
  bug: { path: string; snippets: string[]; summary: string } | null;
};

export type ResultLine = {
  model: string;
  case: string;
  category: string;
  run: number;
  ok: boolean;
  error?: string;
  ms: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  found: number; // findings the model returned
  posted: Pick<Finding, "path" | "line" | "end_line" | "severity" | "category" | "title">[]; // after validation
  caught: boolean | null; // null for clean cases
};

function unifiedPatch(before: string | null, after: string): string {
  const res = Bun.spawnSync(["git", "diff", "--no-index", "-U3", "--", before ?? "/dev/null", after]);
  const text = res.stdout.toString();
  const start = text.indexOf("\n@@");
  if (start < 0) throw new Error(`no diff for ${after}`);
  return text.slice(start + 1).replace(/\n$/, "");
}

export async function loadCases() {
  const ids = (await readdir(CASES_DIR)).sort();
  return Promise.all(
    ids.map(async (id) => {
      const dir = path.join(CASES_DIR, id);
      const meta = JSON.parse(readFileSync(path.join(dir, "case.json"), "utf8")) as CaseMeta;
      const files: ReviewFile[] = meta.files.map((f) => {
        const after = path.join(dir, "after", f.path);
        return {
          path: f.path,
          patch: unifiedPatch(f.isNew ? null : path.join(dir, "before", f.path), after),
          content: readFileSync(after, "utf8"),
        };
      });
      let bugRange: [number, number] | null = null;
      if (meta.bug) {
        const lines = readFileSync(path.join(dir, "after", meta.bug.path), "utf8").split("\n");
        const bugPath = meta.bug.path;
        const hits = meta.bug.snippets.map((snippet) => {
          const index = lines.findIndex((line) => line.includes(snippet));
          // A stale snippet would silently score this case as never caught.
          if (index === -1) throw new Error(`${id}: snippet not found in ${bugPath}: ${snippet}`);
          return index + 1;
        });
        bugRange = [Math.min(...hits) - LINE_TOLERANCE, Math.max(...hits) + LINE_TOLERANCE];
      }
      return { meta, files, bugRange };
    }),
  );
}

export function isCaught(posted: ResultLine["posted"], bug: CaseMeta["bug"], range: [number, number] | null): boolean {
  if (!bug || !range) return false;
  return posted.some((f) => f.path === bug.path && f.line <= range[1] && (f.end_line ?? f.line) >= range[0]);
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const runs = Number(arg("runs") ?? 3);
  const models = arg("models")?.split(",") ?? DEFAULT_MODELS;
  const concurrency = Number(arg("concurrency") ?? 10);

  const cases = await loadCases();
  const registry = new ModelRegistry({ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }, { allowed: models.join(",") });
  const defaults = RepoConfig.parse({});

  mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  const done = new Set(
    existsSync(RESULTS_FILE)
      ? readFileSync(RESULTS_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => {
          const r = JSON.parse(l) as ResultLine;
          return `${r.model}|${r.case}|${r.run}`;
        })
      : [],
  );

  // run-major order spreads each model's calls over the whole run (kinder to rate limits)
  const tasks = [];
  for (let run = 1; run <= runs; run++)
    for (const c of cases) for (const model of models) if (!done.has(`${model}|${c.meta.id}|${run}`)) tasks.push({ run, c, model });
  console.log(`${cases.length} cases × ${models.length} models × ${runs} runs: ${tasks.length} to do (${done.size} already done)`);

  let finished = 0;
  await mapLimit(tasks, concurrency, async ({ run, c, model }) => {
    const spec = parseModelId(model);
    const started = Date.now();
    const line: ResultLine = {
      model, case: c.meta.id, category: c.meta.category, run, ok: true, ms: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, found: 0, posted: [],
      caught: c.meta.bug ? false : null,
    };
    try {
      const result = await registry.reviewer(spec).review({
        pr: { title: c.meta.title, body: c.meta.description },
        instructions: "",
        alreadyRaised: [],
        files: c.files,
      });
      const diffs = new Map(c.files.map((f) => [f.path, parsePatch(f.patch)]));
      const validated = validateFindings(result.findings, diffs, [], { minSeverity: defaults.min_severity, maxComments: defaults.max_comments });
      const price = await priceFor(spec);
      line.costUsd = result.costUsd ?? (price ? costOf(price, result.usage) : 0);
      line.tokensIn = result.usage.inputTokens;
      line.tokensOut = result.usage.outputTokens;
      line.found = result.findings.length;
      line.posted = validated.post.map(({ path, line, end_line, severity, category, title }) => ({ path, line, end_line, severity, category, title }));
      if (c.meta.bug) line.caught = isCaught(line.posted, c.meta.bug, c.bugRange);
    } catch (err) {
      line.ok = false;
      line.error = String((err as Error).message ?? err).slice(0, 300);
    }
    line.ms = Date.now() - started;
    appendFileSync(RESULTS_FILE, `${JSON.stringify(line)}\n`);
    finished++;
    const mark = !line.ok ? "ERR " : line.caught === null ? `clean:${line.posted.length}` : line.caught ? "HIT " : "miss";
    console.log(`[${finished}/${tasks.length}] ${mark} ${model.replace("openrouter:", "")} ${c.meta.id} #${run} ${(line.ms / 1000).toFixed(0)}s $${line.costUsd.toFixed(5)}`);
  });
  console.log("done. Report: bun eval/report.ts");
}
