<p align="center"><img src="brand/icon.svg" width="88" alt=""></p>

<h1 align="center">Selfreview</h1>

<p align="center"><b>A self-hosted AI code reviewer for GitHub.</b><br>
Deploy it to your own Railway project in one click. Your infrastructure, your model, your keys.<br>
About <b>$5–10 a month</b> for a 10-person team, instead of $240–480 for per-seat review SaaS.</p>

<p align="center"><a href="https://railway.com/deploy/selfreview"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a></p>

---

Open a pull request and Selfreview posts a review: specific, line-level comments on real bugs (security holes, broken logic, async mistakes, money math) that say what breaks, when, and how to fix it. One review per push, one summary comment edited in place, and nothing repeated on the next push.

See it on a live PR: **[selfreviewhq/demo#2](https://github.com/selfreviewhq/demo/pull/2)**. That review took 11 seconds and cost $0.0071.

## Why self-host a reviewer?

- **Cheap by default.** It uses open-weight models through [OpenRouter](https://openrouter.ai): GLM 5.3 costs about $0.002–0.007 per review. The whole Railway project idles at about $3/month.
- **Your code stays yours.** Diffs are processed in memory and never stored. The database keeps metadata only (which PR, which commit, cost, where comments went), never code or comment text.
- **Any model.** OpenRouter (GLM, DeepSeek, Qwen, Claude, GPT…), Anthropic, OpenAI, or your own vLLM/Ollama box: set the model and its provider's key.
- **Measured, not vibes.** [`eval/`](eval) is a reproducible benchmark: 30 small PRs (25 with a planted bug, 5 clean), 6 models × 3 runs, bugs caught and cost per bug. [Results](eval/RESULTS.md).

## Set up in two minutes

1. **Deploy on Railway** with the button above. Paste an [OpenRouter API key](https://openrouter.ai/keys) when asked. Everything else, including the database, secrets and domain, is created for you.
2. **Open your new app's URL**, log in with the `ADMIN_PASSWORD` shown in the api service's *Variables* tab, and click **Create GitHub App**. Choose your personal account or an organization.
3. **Install the app** on the repositories you want reviewed. Open a pull request.

That's it. The dashboard on the same URL shows spend, recent reviews, and how often comments get acted on.

## How it works

```mermaid
flowchart LR
    GH[GitHub] -- webhook --> API[api]
    API -- "one transaction:<br/>record + enqueue" --> PG[(Postgres<br/>queue + metadata)]
    W[worker] -- claim job --> PG
    W -- read PR, post review --> GH
    W -- "diff → JSON findings" --> LLM[Model via OpenRouter]
    C[cron] -- "resend missed webhooks,<br/>track outcomes" --> GH
```

One Docker image runs as three Railway services (api, worker, cron; each takes its role from its service name), with Postgres as both the job queue and the database. The whole project is defined in one TypeScript file, [`.railway/railway.ts`](.railway/railway.ts).

Highlights from building it:

- **A job is a PR, not a commit.** Rapid pushes collapse into at most one running and one waiting review, and the last review always covers the newest commit.
- **Incremental reviews.** After the first review, each push only gets the commits since the last review, which costs less on long-running PRs. A rebase or force-push, or a `/selfreview` comment, gets a full review.
- **Webhooks are never lost.** GitHub doesn't retry failed deliveries, so cron resends them (tested with a simulated outage).
- **Idempotent posting.** A crash after posting can't double-post; the retry adopts the existing review.
- **Safe by default.** Strangers' PRs aren't reviewed automatically (no running up your bill), a PR can't change its own review rules, and one-click suggestions that would delete code are dropped.

Read the full design in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** and the build log, including everything that broke on the way, in **[docs/PLAN.md](docs/PLAN.md)**.

## Configuration

Railway variables on the **worker** service:

| Variable | Default | |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Required unless you use another provider below |
| `MODEL_SMALL`, `MODEL_LARGE` | `openrouter:z-ai/glm-5.3` | `provider:model`. PRs under 400 changed lines get `MODEL_SMALL` |
| `ALLOWED_MODELS` | the two above + a few cheap OpenRouter models | Extra models a repo may choose |
| `MAX_REVIEW_COST_USD` | `1` | Skip PRs estimated to cost more |
| `MONTHLY_BUDGET_USD` | `10` | Hard monthly cap: each review reserves its worst-case cost first, then settles to the actual cost, so neither parallel workers nor long answers can overshoot. Set it on the api too, so the dashboard shows the same number |
| `MODEL_PRICES` | — | JSON prices ($/1M tokens) for models without a built-in (Anthropic) or OpenRouter price, e.g. `{"openai:gpt-5-mini": {"input": 0.25, "output": 2}}`. Self-hosted models need `{"input": 0, "output": 0}`. A model with no price is skipped, never run uncapped. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` | — | Other providers |

Railway variables on the **api** service:

| Variable | Default | |
|---|---|---|
| `ALLOWED_ACCOUNTS` | — | Other GitHub users or orgs whose repos you want reviewed, comma-separated, e.g. `acme,my-side-project-org`. The app's owner is always allowed; PRs from any other account are ignored. See [More than one account](#more-than-one-account) |

Per repository, an optional **`.selfreview.yml`**. It's read from the base branch, so a PR can't loosen its own review:

```yaml
instructions: |
  We use Zod for validation; flag unvalidated request bodies.
ignore: ["**/*.snap", "migrations/**"]
risky_paths: ["src/auth/**"]   # always use MODEL_LARGE
min_severity: medium           # low | medium | high
max_comments: 15
skip_labels: ["no-review"]
fail_on: never                 # the Selfreview check fails at this severity: never | medium | high
```

Comment **`/selfreview`** on a PR to re-run a full review. Maintainers can use it to review PRs from outside contributors.

### The Selfreview check

Each review also posts a **Selfreview** check on the commit: green with no new findings, grey (neutral) with findings, and red only when a finding reaches `fail_on`. With `fail_on` set, branch protection can block the merge. Apps created before v1.1 need one change first: in the GitHub App's settings, under *Permissions*, set **Checks** to *Read and write*, then accept the new permission on each installation. Until then, reviews work as before without the check.

### More than one account

A GitHub App can only be installed by the account that owns it unless it's public. To review your personal repos and an org's with one deployment:

1. Set `ALLOWED_ACCOUNTS` on the api to the other accounts, e.g. `acme`.
2. Make the app public: GitHub App settings → *Advanced* → **Make public**. Apps created after `ALLOWED_ACCOUNTS` is set are public from the start.
3. Install it on each account's repos.

Anyone can install a public app, but Selfreview only reviews PRs in the owner's and the listed accounts' repos, so nobody else can spend your budget.

### Updating

When a new version is out, Railway shows an update notice in your project, and the dashboard says how many commits you're behind. Apply the update from the Railway notice, or redeploy the latest commit of each service (api, worker, cron).

## Development

```bash
bun install
bun test                 # unit tests; integration tests run when TEST_DATABASE_URL is set (CI does both)
bun run typecheck
bun eval/run.ts          # benchmark (needs OPENROUTER_API_KEY in .env)
```

Built with Bun, Hono, pg-boss, Octokit and Zod. [MIT licensed](LICENSE).
