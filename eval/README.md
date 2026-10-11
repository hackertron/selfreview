# Benchmark

How well does each (cheap) model review code, and what does a caught bug cost?

- **`cases/`**: 30 small, realistic PRs. 25 contain exactly one planted bug (security, logic, async, data/money, performance); 5 are clean changes that should get no comments. Each case has `after/` files, `before/` files unless the PR only adds new files, and a `case.json`. The bug's location and summary in `case.json` are used only for grading and are never shown to the model.
- **`run.ts`**: reviews every case with every model, several times. It uses the production prompt, structured output and validation (`min_severity: medium`, comment cap), and posts nothing anywhere. Results are appended to `results/raw.jsonl` as they arrive, so an interrupted run resumes where it stopped.
- **`report.ts`**: turns the raw results into [`RESULTS.md`](RESULTS.md).

```bash
# needs OPENROUTER_API_KEY in .env (Bun loads it automatically)
caffeinate -i bun eval/run.ts                # all default models, 3 runs each (macOS: stay awake)
bun eval/run.ts --runs 1 --models openrouter:z-ai/glm-5.3,openrouter:openai/gpt-oss-120b
bun eval/report.ts
```

## How it's scored

- **Caught:** a posted comment on the bug's file, within ±3 lines of it. This checks location, not wording, so a comment on the right line about a different problem would still count; spot-check `raw.jsonl` when it matters.
- **Comments on clean PRs:** the noise measure. Everything there is unwanted.
- **Other comments per bug PR:** comments that aren't about the planted bug. Some are real issues, some are noise.
- **Cost:** what OpenRouter reported for each call.

## Limits worth knowing

- The PRs are small and single-file, and each has one clear bug. Real PRs are bigger and messier, so treat these numbers as an upper bound on recall and a comparison *between* models.
- Each model runs 3 times because answers vary from run to run; the report shows the range.

## What v1 showed (2026-10-10)

- **Too easy to rank models:** four of six models caught 99–100% of the planted bugs. Small single-file PRs with one clear bug are saturated. A **hard set** (multi-file changes, subtle bugs, bugs buried in large diffs) is next.
- **Still a real result:** open models at $0.0001–$0.0002 a review reliably catch obvious security, logic and async bugs, and rarely comment on clean PRs.
- **Location grading flatters weaker models a little.** In a spot-check of 12 hits, 11 were about the planted bug; one (Qwen) was a different comment on the right line.
- Total cost of the run: $0.70 for 540 reviews.
