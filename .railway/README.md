# Railway configuration

[`railway.ts`](railway.ts) defines the Railway project in code: Postgres (private network only), and the `api`, `worker` and `cron` services, all built from the repo's one Dockerfile. Each service takes its role from its name. The api's public domain isn't in the file: create it once with `railway domain --service api` (the template does this for you).

You don't need this file to run Selfreview: the Deploy button in the main README creates the same project from a template. It's for working on Selfreview itself:

```bash
bun install                 # installs the `railway` SDK that railway.ts imports
railway config plan         # preview what would change (read-only)
railway config apply        # apply it
```

Secrets are never in this file, and never derived in it. After the first `railway config apply` creates the services, set them once with real random values:

```bash
openssl rand -hex 16 | railway variable set ADMIN_PASSWORD --stdin --service api
openssl rand -hex 32 | railway variable set ENCRYPTION_KEY --stdin --service api
railway variable set OPENROUTER_API_KEY --stdin --service worker   # paste your key
```

`railway.ts` marks them `preserve()`, so later applies keep them, and worker and cron read `ENCRYPTION_KEY` from the api by reference.

Don't use `ctx.randomString()` for secrets. It isn't random: it's a SHA-256 of the environment name and a label, so anyone who can read this file can recompute it. (The Deploy-button template is not affected: it generates real secrets with `${{ secret() }}`.)
