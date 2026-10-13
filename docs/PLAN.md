# Selfreview — Build plan

Each milestone ends with something working you can try, a "done when" test, and one piece of content to post while building in public. The design is in [ARCHITECTURE.md](ARCHITECTURE.md).

**Needed before starting:** a Railway account (Hobby is enough), a throwaway GitHub repo or test org, and an [OpenRouter](https://openrouter.ai) API key.

## Repo layout

```
src/
  main.ts       picks the role: api, worker or cron (the Railway service name)
  roles/        api.ts · worker.ts · cron.ts: startup for each service
  webhooks.ts   accepting a webhook: record + decide + enqueue, one transaction
  queue.ts      the pg-boss queue and its settings
  github/       app auth (JWT → installation token), webhook signature, trigger rules
  pipeline/     run.ts (the steps in order) · diff · filter · repo-config · plan · validate · render · publish · record
  llm/          types (the Reviewer interface) · prompt · schema · models (ids, prices) · openai-compatible · anthropic
  cron/         redeliver.ts (missed webhooks) · outcomes.ts (what happened to comments)
  web/          login tokens, HTML pages, dashboard queries
  db/           connection pool, transactions, migration runner
  crypto.ts     AES-256-GCM for the app's secrets, constant-time compare
migrations/     plain SQL, numbered
eval/           benchmark: 30 seeded-bug cases + runner + report
.railway/       railway.ts: the whole Railway project as code
```

## Milestones

### M0: Risk checks ✅ (2026-10-09)
Prove the assumptions the design depends on, before writing real code, with throwaway scripts (deleted once M0 passed).
- [x] **pg-boss v12 on Bun 1.3:** 12/12 checks pass:
  - `stately` + `singletonKey` allows one queued and one active job per PR;
  - a rejected send returns `null`, not an error;
  - `send({ db })` inside our transaction rolls back together with our own row;
  - `stop({ graceful: true })` waits for the running job;
  - a crashed worker's job is reclaimed after missed heartbeats (10 s heartbeat, reclaimed inside the 90 s test window).
- [x] **SIGTERM on Railway:** Bun runs as PID 1 and gets the signal. With `drainingSeconds: 120` the old worker finished an 88-second job and exited cleanly. **Default without the setting: ~11 s** before force-stop (measured twice).
- [x] **One image, three roles via `.railway/railway.ts`:** api (healthcheck `/health`, public domain), worker (draining 120 s) and cron (`*/5 * * * *`, restart NEVER) deployed from one Dockerfile.
  - Reference variable `DATABASE_URL` works.
  - `ctx.randomString()` secrets stay stable across applies.
  - Cron fired on schedule and exited.
- [x] **GitHub App manifest round trip (personal account):** setup page → GitHub → callback → code exchanged for app ID, private key and webhook secret. GitHub lets the user rename the app on its page, so we must read the real name/slug from the exchange, not assume our own.
- [ ] **Org variant:** same code with the org URL (`/organizations/<org>/settings/apps/new`). Carried to M2, where the test org is set up anyway.

**Learned along the way:**
- `railway.json` is deprecated (stops being read 2026-12-01). Railway IaC (`.railway/railway.ts`) replaces it and is a better story anyway.
- Railway Postgres has no public URL by default; M0 added a temporary TCP proxy for laptop testing, to be removed.
- A config change (e.g. draining) triggers a redeploy by itself.
- pg-boss v12 has `groupConcurrency`, which gives per-org fairness across workers for free, so it moved into v1.

**Content:** "4 things I verified before building a self-hosted AI code reviewer on Railway."

### M1: Skeleton ✅ (2026-10-09)
- [x] Bun + TypeScript project, `ROLE` switch (`src/main.ts`), structured JSON logger, graceful shutdown, `/health` (checks the database).
- [x] Postgres, migration runner (advisory lock, checksums) as the pre-deploy command, `001_init.sql` with all tables, pg-boss schema + `review` queue (`stately`, heartbeat 30 s) declared pre-deploy.
- [x] `.railway/railway.ts`: three services from the GitHub repo, shared watch patterns + pre-deploy, api healthcheck, worker draining 120 s, cron every 10 min, generated `ADMIN_PASSWORD` + `ENCRYPTION_KEY` (`ENCRYPTION_KEY` shared to worker/cron by reference).
- [x] Tests: config, migration planning, `/health` (8 passing). `bun run typecheck` clean.

**Verified:** locally, a queued job reaches the worker and both roles shut down cleanly on SIGTERM. On Railway, all three services build from GitHub. Pushing `002_table_comments.sql` ran pre-deploy on all three: the worker applied it, api and cron found it already applied.

**Learned:**
- Railway's GitHub App must be granted access to the (private) repo.
- Setting `source: github(...)` in `.railway/railway.ts` stores the source but **doesn't create the push-to-deploy trigger**. `railway service source connect --repo … --branch main --service …` does, once per service. The template and README must account for this.
- Changing deploy config in IaC redeploys by itself; connecting a source deploys the branch's latest commit.

**Content:** the architecture diagram + "one image, three roles, one TypeScript file for the whole infrastructure."

### M2: GitHub App ✅ (2026-10-09)
- [x] `ADMIN_PASSWORD` login (signed `HttpOnly` cookie, no sessions table), `/setup` with personal-or-org choice, manifest flow with a signed `state`, code exchange, credentials **AES-256-GCM encrypted**, setup locks after the first app.
- [x] `POST /webhooks/github`: HMAC check before anything else, trigger rules (`src/github/triggers.ts`), delivery record + enqueue in **one transaction**, duplicate deliveries ignored.
- [x] `installation` / `installation_repositories` events keep `installations` in sync; uninstall keeps the account row (churn) and deletes its reviews and findings.
- [x] Tests: 34 unit (crypto, tokens, signatures, trigger rules, routes) + 6 integration against the real Postgres.

**Verified live:**
- App `selfreview-selfreviewhq` was created on the `selfreviewhq` org through `/setup` and installed. This covers the org variant carried over from M0.
- PR [playground#1](https://github.com/selfreviewhq/playground/pull/1) produced a delivery recorded as `queued`, and the worker received the job with the org group.
- Forged and unsigned webhooks → **401**.
- The org avatar and app logo are set to the Selfreview icon.

**Learned:**
- The webhook didn't mark the org's own owner as `MEMBER`, because org membership is private by default. The `verifyUser` path is needed in practice, not just in theory.
- Org avatars and app logos have no API; they were set through the browser.

**Content:** "Zero-copy-paste GitHub App setup with the manifest flow," including the private-membership gotcha.

### M3: Pipeline without AI ✅ (2026-10-10)
- [x] Worker (`src/pipeline/`):
  - App JWT → installation token (`src/github/client.ts`, hand-rolled in ~40 lines).
  - Resolves the PR's latest commit, checks "already reviewed", and verifies `verifyUser` via repo permission.
  - Loads `.selfreview.yml` from the base branch, applies repo skips, filters noise.
  - No-AI stand-in reviewer (removed before release) → diff-line validation, sanitising, dedupe → one review + one summary comment → record.
- [x] Idempotency: hidden `sha` marker on reviews and `fp` markers on comments. A retry adopts an already-posted review instead of reposting or re-reviewing.
- [x] Cron: redelivers failed webhooks (`src/cron/redeliver.ts`), plus 30-day cleanup.
- [x] Tests: 50 unit (diff parsing, filters, config, validation, sanitising, rendering, JWT, redelivery selection) + 6 integration.

**Verified live on `selfreviewhq/playground`:**
- **First comment:** PR #1 got a review, an inline comment on `src/users.ts:12` and a summary, all from `selfreview-selfreviewhq[bot]`.
- **Rapid pushes:** 5 pushes 2 s apart → 3 reviews. There was never more than 1 waiting + 1 running, and the last review covered the newest commit. "≤ 2 reviews" was the wrong target: pushes spread over longer than one review legitimately produce more.
- **Nothing new → no new review:** a push after the dedupe fix → `no_new_findings`, no new review, and the summary edited in place.
- **Crash after posting, before recording** (simulated by deleting the DB row): the retry *adopted* the existing review (same review id, findings rebuilt from markers). Still exactly 1 review on GitHub.
- **`/selfreview` command:** queued, forced review ran. The bot editing its own summary fires `issue_comment.edited`, which is correctly ignored.
- **Webhook missed during an outage** (app webhook URL pointed at a 404 for ~20 min): Railway Cron resent it at 08:51 and 09:01 (still failing), and again at 09:10 after the URL was restored, when it was accepted → review ran. No human involved.

**Bugs found and fixed:**
- GitHub's *per-review* comments endpoint returns `line: null` (only the legacy `position`), so no findings were recorded and the stand-in's finding was re-posted on every push. Fixed by reading the PR-wide comments endpoint. Dedupe now also reads our comments' fingerprints live from GitHub, so a lost DB row can't cause repeats.
- Redelivery gave up after 4 attempts (~30 min of outage). Raised to 12 (~2 h).

**Content:** "How not to lose a webhook: GitHub never retries, so I built the retry," with the outage test as the story.

### M4: The reviewer ✅ (2026-10-10)
- [x] Providers: `anthropic` (official SDK, native structured output) and an OpenAI-compatible one that serves `openai`, **`openrouter`**, DeepSeek's API and self-hosted vLLM/Ollama (`src/llm/`).
- [x] Model ids `provider:model`; defaults follow whichever key is set; repos may only pick `ALLOWED_MODELS`.
  - **Default: `openrouter:z-ai/glm-5.3` for both tiers**, a cheap open-weight model.
- [x] Prompt:
  - diffs with new-file line numbers, plus full changed files for context;
  - "already raised" list;
  - PR text fenced as untrusted;
  - each finding must state the failure scenario, impact and fix.
- [x] Strict JSON-schema output; a single bad finding is dropped, a bad answer gets one retry.
- [x] Chunking (files packed under ~60k tokens; full-file context dropped before a file is), 2 chunks in parallel, small/large routing (`SMALL_DIFF_LINES`, `risky_paths`).
- [x] Cost:
  - OpenRouter reports the exact cost per call; otherwise a price table.
  - Estimate before calling against `MAX_REVIEW_COST_USD`, plus `MONTHLY_BUDGET_USD`.
- [x] Suggestions kept only if they preserve the lines they replace.
- [x] Tests: 65 unit + 6 integration.

**Verified live:**
- First real review on playground#2: DeepSeek v4 Flash, $0.00026.
- Public demo PR with 2 planted bugs (custom slug overwrites a link; seconds added to a ms timestamp). Same PR and prompt, three cheap models:

  | Model | Hijack bug | Seconds/ms bug | Time | Cost |
  |---|---|---|---|---|
  | GLM 5.3 | ✅ | ✅ | 7 s | $0.0072 |
  | GLM 5.3 Flash | ✅ | ❌ | 5 s | $0.0006 |
  | DeepSeek v4 Flash | ✅ | ❌ | 97 s | $0.0006 |

- [demo#2](https://github.com/selfreviewhq/demo/pull/2) reviewed by GLM 5.3: 3 well-explained findings, 11 s, **$0.0071**. Run-to-run variance is real: that run didn't post the seconds/ms bug. M5 measures this properly over many PRs and runs.

**Bugs found and fixed:**
- **GLM 5.3 spent its entire 8k output budget "thinking" and returned nothing.** Fixed with OpenRouter's `reasoning: { effort: "low" }` and a 16k output budget. Failures now log finish reason, answer length and output tokens (never content).
- **One-click suggestions that would delete code:** the model wrote "add this check before the line" as a replacement for the line. Unsafe suggestions are now dropped, the prompt explains the replacement rule, and the 3 unsafe ones already on demo#2 were stripped.
- My first prompt's example title described the planted bug, which leaked the answer. Replaced with unrelated examples before any comparison was trusted.

**Content:** short video of a real review appearing on demo#2, with "$0.0071" in the summary.

### M5: Eval ✅ v1 (2026-10-10)
- [x] `eval/cases/`: 30 mini-PRs (25 with one planted bug across security/logic/async/data/performance, 5 clean). Grading info is never shown to the model.
- [x] `eval/run.ts`: production prompt + validation, 6 cheap open models × 3 runs, resumable, parallel. `eval/report.ts` → [`eval/RESULTS.md`](../eval/RESULTS.md).
- [x] Default model chosen: GLM 5.3. It scored 100% here with the lowest false-alarm rate among the top scorers and a 3 s median, and on the real demo PR it was the only cheap model that caught the subtle seconds/ms bug.
- [ ] Hard set (multi-file, subtle, large noisy diffs). v1 is saturated, so this comes before publishing the benchmark post.

**Results v1 ($0.70 for 540 reviews):** GLM 5.3 Flash / GLM 5.3 / DeepSeek v4 Pro 100%, DeepSeek v4 Flash 99%, gpt-oss-120b 95% (zero false alarms, $0.0001/review), Qwen3 Coder Next 83%.

**Bug found:** OpenRouter's `reasoning` setting + `require_parameters` → "no endpoints" (404) for models without reasoning support (Qwen3 Coder Next). The provider now retries once without it.

**Content:** "Cheap open models review code surprisingly well: $0.0002 per review." The hard-set numbers make the ranking.

### M6: Ship ✅ (2026-10-11)
- [x] Dashboard: spend vs budget, recent reviews, "acted on" per model, webhook log, failed jobs with Retry (`/`, behind `ADMIN_PASSWORD`).
- [x] Cron: hourly sync of comment outcomes (resolved / code changed) and 👍/👎 via GraphQL. Verified live: resolving a thread and adding 👍 → `resolved`, reaction +1.
- [x] Cleanup:
  - dev Postgres TCP proxy deleted (database is private-network only);
  - full-history secret scan clean;
  - commit author email rewritten to the GitHub noreply address;
  - `ROLE` comes from the Railway service name, and model defaults live in code (fewer template variables);
  - M3's no-AI stand-in reviewer and the M0 spike scripts removed: with no model key the worker refuses to start and says which variable to set.
- [x] Public README with Deploy button, setup steps, config, benchmark link.
- [x] Railway template draft:
  - generated from the project, then fixed in the template editor:
    - `secret()` generators for `ADMIN_PASSWORD` / `ENCRYPTION_KEY`;
    - `OPENROUTER_API_KEY` user-supplied with a hint;
    - worker drain 120 s, cron `*/10 * * * *`, Postgres defaults.
  - Verified through the API.
- [x] Clean-room test: the template deployed into a fresh project in ~1.5 min. Then setup → GitHub App on a personal account → install on a fresh repo → first PR reviewed in 6 s for $0.0008, correctly flagging the planted missing-auth bug.
- [x] Repo public, template published at [railway.com/deploy/selfreview](https://railway.com/deploy/selfreview), README button pointing at it.

**Learned:**
- Railway's "Generate template" copies references and `secret()` functions but **drops every literal value** (even `ROLE=api`, `PGPORT`), and there's no API to edit a template. Design for it: derive what you can (service name → role, defaults in code) and use the editor's raw JSON for the rest.
- Template variables generate fresh secrets per deploy with `${{ secret(64, "abcdef0123456789") }}`.

**Content:** launch video + blog post + X thread, then the Railway application.

### Independent review (Codex, 2026-10-11)
Every finding was checked against the code before fixing; all five were real:
1. **High: per-review cost cap skipped for unpriced models.** Unpriced models are now skipped, never run uncapped. `MODEL_PRICES` prices any model, and an OpenRouter price-list outage retries the job.
2. **Medium: one bad multi-line range from the model failed the whole GitHub review.** Ranges are validated; a bad one falls back to a single-line comment without its suggestion.
3. **Medium: outcome sync read only the first 100 review threads.** It now paginates.
4. **Medium: concurrent workers could overshoot `MONTHLY_BUDGET_USD`.** Reviews reserve their estimate under an advisory lock, then settle to the actual cost. An integration test confirms that of 5 concurrent $0.30 reservations against $1, exactly 3 pass.
5. **Low: "price unknown models by env var" was documented but missing.** Now implemented (`MODEL_PRICES`).

**Second pass:** the five fixes were confirmed, plus three new findings, all real:
1. **High: the monthly reservation used the typical estimate**, so unusually long answers could still overshoot. It now reserves the worst case that each provider declares (`Reviewer.limits`: max output tokens × calls, 2× input margin).
2. **Medium: `openai-compatible:` defaulted to free**, so a paid endpoint without `MODEL_PRICES` was uncapped. Every model now needs a known price (0 for self-hosted).
3. **Low: crash between posting and recording left the reservation unsettled.** It was later closed as failed with its estimate still counted, a permanent double count. The adopt path now settles it; an integration test shows one row, nothing left running.

**Final pass (2026-10-11):** two more independent reviews, one of the code and one checking every doc claim against the code. Code findings, all verified and fixed:
1. **High: `ctx.randomString()` is not random.** Railway's IaC SDK computes it as `sha256("railway-iac:<environment>:<label>")`, so the dev project's `ADMIN_PASSWORD` and `ENCRYPTION_KEY` could be recomputed by anyone reading `railway.ts` (checked: both matched the formula). `railway.ts` now uses `preserve()`, and secrets are set once by hand. The template was never affected (`${{ secret() }}` is random). Reported to Railway in [railwayapp/railway-ts-sdk#98](https://github.com/railwayapp/railway-ts-sdk/issues/98), since the name suggests randomness.
2. **High: a failed review counted $0 against the monthly budget** even when its model calls were billed (an answer that never matched the schema costs two full calls). Reviewers now report what a failed call spent, and after one chunk fails no new chunk starts, while running ones finish so their cost is known.
3. **Medium: an attempt that ran past the job's 15-minute limit kept going** while pg-boss started a retry, so both could post. The job's abort signal now reaches the model calls and is checked before posting, and each call times out after 3 minutes.
4. **Medium: open redirect after login** (`/login?next=/\evil.com`). Only paths on this site are accepted now.
5. **Low:** made-up file paths could inject markdown into the summary (now dropped); a suggestion containing a code fence could break out of its block (now dropped); a PR with thousands of skipped files made the summary too long for GitHub (lists are capped at 50); multi-line titles were never recognised as already raised (now one line); a long PR description was counted once per file when packing chunks (now once).

Not changed, by choice: uninstalling the app deletes that account's review rows, which also lowers this month's counted spend. Only the owner can install their private app, so this can't be abused by others.

Docs: 24 places in ARCHITECTURE.md described a planned detail as built or gave a stale number; all corrected.

Also added CI (`.github/workflows/test.yml`): typecheck plus all unit and integration tests against Postgres 17 on every push to main and every PR.

### v1.1: everyday use ✅ (2026-10-13)

What came up in the first days of using it on real repos:

- **One-click fixes rarely appeared.** A fix that edits a line was always dropped, so only about 1 review in 6 had one. Edited lines are now allowed when each replaced line is still recognisable (similarity ≥ 0.6). A guard that replaces the line it guards (0.42 in the M4 case) is still dropped.
- **Every push re-reviewed the whole PR.** Now only the commits since the last successful review are sent to the model. A rebase or force-push, a cut-off file list, or `/selfreview` falls back to a full review.
- **No status next to CI.** Each review posts a Selfreview check; `fail_on` in `.selfreview.yml` can make it fail.
- **One deployment couldn't cover a personal account and an org.** `ALLOWED_ACCOUNTS` plus a public app does, and PRs from anyone else are refused at the webhook.
- **No budget by default.** Now $10 a month unless set.
- **Deployed copies fell behind.** Railway already shows template updates in the project; the dashboard now says it too.

Selfreview reviewed this release's own PR (#1: 20 files, $0.06) and found a real bug in it: the check only counted findings posted inline, so a high-severity finding on an unchanged line left it green even with `fail_on: high`. It now counts every new finding (inline, outside the changed lines, or cut by `max_comments`), not repeats. Its second pass ($0.04) found one more: a push that only touched ignored files got no check at all, which blocks a required check forever. Every skip now posts a check, and a failed check stays failed on incremental pushes until a full review passes (otherwise unrelated pushes would turn it green).

Tests: 19 new unit tests (tests/v1_1.test.ts) and one integration test (a PR from an account that isn't allowed is never queued). 124 pass.

## Testing approach

- **Unit tests** for the pure steps (filter, chunking, diff-line mapping, validation, dedupe, fingerprint, cost math). These hold most of the logic.
- **Integration tests** on a real Postgres: webhook acceptance (one transaction, duplicates, queue collapse) with small hand-written payloads, and the budget reservation race.
- **No model calls in CI:** the model step is the only one not unit-tested; it is measured by the eval instead.
- **The eval (M5)** is the only thing that calls real models, and it runs on demand.
