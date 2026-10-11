// The whole Railway project as code: `railway config plan` previews, `railway config apply` applies.
import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  // Private networking only: the database is never exposed to the internet.
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });

  // One image, three roles: every service builds the same Dockerfile. The role is the service's
  // name (api / worker / cron), which Railway provides as RAILWAY_SERVICE_NAME.
  const shared = {
    source: github("hackertron/selfreview", { branch: "main" }),
    // Docs and tests don't change the image, so they don't trigger deploys.
    build: { watchPatterns: ["src/**", "migrations/**", "Dockerfile", "package.json", "bun.lock"] },
    // Migrations + queue definitions run before a new deployment starts (under an advisory lock).
    preDeploy: "bun src/db/migrate.ts",
  };

  const api = service("api", {
    ...shared,
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      // Secrets are set once in Railway (see .railway/README.md), never derived in code:
      // ctx.randomString() is a hash of the environment name and label, so anyone reading this
      // file could recompute it. preserve() keeps whatever value Railway already has.
      ADMIN_PASSWORD: preserve(), // login for /setup and the dashboard
      ENCRYPTION_KEY: preserve(), // AES-256-GCM key for the GitHub App's credentials
    },
    healthcheck: "/health",
  });

  const worker = service("worker", {
    ...shared,
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      ENCRYPTION_KEY: api.env.ENCRYPTION_KEY,
      // LLM keys are set in Railway (never in git); preserve() keeps whatever value is there.
      OPENROUTER_API_KEY: preserve(),
      // Models: defaults live in src/llm/models.ts (GLM 5.3 via OpenRouter). Override with
      // MODEL_SMALL / MODEL_LARGE / ALLOWED_MODELS if you want something else.
    },
    // A review takes up to ~90 s. Railway's default is ~11 s from SIGTERM to kill
    // (measured in M0), so give a stopping worker time to finish its job.
    deploy: { drainingSeconds: 120 },
  });

  const cron = service("cron", {
    ...shared,
    env: {
      DATABASE_URL: Postgres.env.DATABASE_URL,
      ENCRYPTION_KEY: api.env.ENCRYPTION_KEY,
    },
    deploy: { cronSchedule: "*/10 * * * *", restartPolicyType: "NEVER" },
  });

  return project("selfreview", {
    variables: { managed: true },
    resources: [Postgres, postgresVolume, api, worker, cron],
  });
});
