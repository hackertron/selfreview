import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { publicUrl, required, type Config } from "../config";
import { parseEncryptionKey, safeEqual } from "../crypto";
import { createPool } from "../db/pool";
import {
  AppCredentialStore,
  buildManifest,
  exchangeManifestCode,
  type AppCredentials,
  type ManifestConversion,
} from "../github/app";
import { isAllowedAccount } from "../github/accounts";
import { verifyWebhookSignature } from "../github/signature";
import { log } from "../log";
import { createBoss } from "../queue";
import { onShutdown } from "../shutdown";
import * as pages from "../web/pages";
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  createStateToken,
  deriveSigningKey,
  verifySessionToken,
  verifyStateToken,
} from "../web/tokens";
import { createWebhookHandler, type IncomingWebhook, type WebhookResult } from "../webhooks";
import { loadDashboard, type DashboardData } from "../web/dashboard-data";
import { createUpdateCheck } from "../web/updates";
import { REVIEW_QUEUE } from "../queue";

export type ApiDeps = {
  checkDb: () => Promise<void>;
  dashboard: () => Promise<DashboardData>;
  retryJob: (id: string) => Promise<void>;
  publicUrl: string;
  adminPassword: string;
  signingKey: Buffer;
  credentials: { get(): Promise<AppCredentials | null>; save(app: ManifestConversion): Promise<boolean> };
  exchangeManifestCode: (code: string) => Promise<ManifestConversion>;
  acceptWebhook: (hook: IncomingWebhook) => Promise<WebhookResult>;
  /** Create the GitHub App as public (ALLOWED_ACCOUNTS lists other accounts). */
  publicApp?: boolean;
};

const SESSION_COOKIE = "selfreview_session";
const ORG_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// After this many wrong passwords within the window, every login is refused until the window ends.
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60_000;

export function createApp(deps: ApiDeps) {
  const app = new Hono();
  const secure = deps.publicUrl.startsWith("https://");

  const loggedIn = (c: Context) => verifySessionToken(deps.signingKey, getCookie(c, SESSION_COOKIE));
  const toLogin = (c: Context) => c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`);

  // Railway's deploy healthcheck: a new api deployment only takes traffic once this returns 200.
  app.get("/health", async (c) => {
    try {
      await deps.checkDb();
      return c.text("ok");
    } catch (err) {
      log.warn("health check failed", { err });
      return c.text("database unavailable", 503);
    }
  });

  // ---- login (ADMIN_PASSWORD) ----

  app.get("/login", (c) => c.html(pages.loginPage(safeNext(c.req.query("next")))));

  const loginLimit = createLoginLimit(MAX_FAILED_LOGINS, FAILED_LOGIN_WINDOW_MS);

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(String(form.next ?? "/"));

    if (loginLimit.isLocked()) {
      return c.html(pages.loginPage(next, "Too many wrong passwords. Wait 15 minutes and try again."), 429);
    }

    if (!safeEqual(String(form.password ?? ""), deps.adminPassword)) {
      loginLimit.recordFailure();
      log.warn("failed login");
      if (loginLimit.isLocked()) {
        log.warn("login locked after too many wrong passwords", { minutes: FAILED_LOGIN_WINDOW_MS / 60_000 });
      }
      return c.html(pages.loginPage(next, "That password didn't match."), 401);
    }
    setCookie(c, SESSION_COOKIE, createSessionToken(deps.signingKey), {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.redirect(next);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  // ---- one-time GitHub App setup (manifest flow) ----

  app.get("/", async (c) => {
    if (!loggedIn(c)) return toLogin(c);
    const existing = await deps.credentials.get();
    if (!existing) return c.redirect("/setup");
    return c.html(pages.dashboardPage(await deps.dashboard(), existing));
  });

  // Re-queue a review that failed all its attempts (SameSite=Lax cookie: no cross-site POSTs).
  app.post("/jobs/:id/retry", async (c) => {
    if (!loggedIn(c)) return toLogin(c);
    await deps.retryJob(c.req.param("id"));
    log.info("failed review retried from the dashboard", { jobId: c.req.param("id") });
    return c.redirect("/");
  });

  app.get("/setup", async (c) => {
    if (!loggedIn(c)) return toLogin(c);
    const existing = await deps.credentials.get();
    if (existing) return c.html(pages.setupDonePage(existing.slug, existing.owner));
    return c.html(pages.chooseOwnerPage());
  });

  app.get("/setup/create", async (c) => {
    if (!loggedIn(c)) return toLogin(c);
    if (await deps.credentials.get()) return c.redirect("/setup");
    const org = c.req.query("owner") === "org" ? (c.req.query("org") ?? "").trim() : "";
    if (c.req.query("owner") === "org" && !ORG_NAME.test(org)) {
      return c.html(pages.messagePage("Check the organization name", "Use the org's login, e.g. acme.", "error"), 400);
    }
    const state = encodeURIComponent(createStateToken(deps.signingKey));
    const action = org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
      : `https://github.com/settings/apps/new?state=${state}`;
    const manifest = buildManifest(deps.publicUrl, org || undefined, deps.publicApp ?? false);
    return c.html(pages.createAppPage(action, manifest, org || "your personal account"));
  });

  app.get("/setup/callback", async (c) => {
    if (!loggedIn(c)) return toLogin(c);
    const code = c.req.query("code");
    if (!code || !verifyStateToken(deps.signingKey, c.req.query("state"))) {
      return c.html(pages.messagePage("Setup link expired", "Start again from /setup.", "error"), 400);
    }
    if (await deps.credentials.get()) return c.redirect("/setup"); // locked: first setup wins
    const created = await deps.exchangeManifestCode(code);
    const saved = await deps.credentials.save(created);
    log.info("github app created", { appId: created.id, slug: created.slug, owner: created.owner.login, saved });
    if (!saved) return c.redirect("/setup");
    return c.html(pages.setupDonePage(created.slug, created.owner.login));
  });

  // ---- GitHub webhooks ----

  app.post("/webhooks/github", async (c) => {
    const appCreds = await deps.credentials.get();
    if (!appCreds) return c.text("not set up", 404);

    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!verifyWebhookSignature(appCreds.webhookSecret, raw, c.req.header("x-hub-signature-256"))) {
      log.warn("webhook rejected: bad signature", { deliveryId: c.req.header("x-github-delivery") });
      return c.text("bad signature", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return c.text("bad json", 400);
    }
    const result = await deps.acceptWebhook({
      deliveryId: c.req.header("x-github-delivery") ?? "",
      event: c.req.header("x-github-event") ?? "",
      payload,
    });
    return c.text(result.outcome, result.status as 200 | 202 | 400);
  });

  return app;
}

/**
 * Only a path on this site, so the login page can't send anyone elsewhere. Rejects "//host" and
 * anything with a backslash or whitespace: browsers read "/\host" and "/<tab>/host" as "//host".
 */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  if (/[\\\s]/.test(next)) return "/";
  return next;
}

/**
 * Caps password guessing on the public login page.
 *
 * Wrong passwords are counted for all visitors together, not per IP: behind Railway's proxy the
 * visitor's IP comes from a header anyone can fake. The worst an attacker can do is lock the
 * dashboard for one window; reviews keep running. Each api replica keeps its own count.
 */
function createLoginLimit(maxFailures: number, windowMs: number) {
  let failures = 0;
  let windowEndsAt = 0;

  return {
    isLocked(): boolean {
      return failures >= maxFailures && Date.now() < windowEndsAt;
    },

    recordFailure(): void {
      // The first failure after a window ends starts a new window.
      if (Date.now() >= windowEndsAt) {
        failures = 0;
        windowEndsAt = Date.now() + windowMs;
      }
      failures += 1;
    },
  };
}

export async function runApi(config: Config) {
  const encryptionKey = parseEncryptionKey(required(config, "ENCRYPTION_KEY"));
  const adminPassword = required(config, "ADMIN_PASSWORD");
  const pool = createPool(config.DATABASE_URL);
  const boss = createBoss(config.DATABASE_URL, { supervise: false, schedule: false }); // send only
  await boss.start();
  const credentials = new AppCredentialStore(pool, encryptionKey);
  const accountAllowed = async (login: string) => {
    const owner = (await credentials.get())?.owner;
    return isAllowedAccount(login, owner, config.ALLOWED_ACCOUNTS);
  };
  const updates = createUpdateCheck(config.UPDATE_REPO, config.RAILWAY_GIT_COMMIT_SHA);

  const app = createApp({
    checkDb: async () => {
      await pool.query("SELECT 1");
    },
    dashboard: async () => ({
      ...(await loadDashboard(pool, boss, config.MONTHLY_BUDGET_USD)),
      update: await updates(),
    }),
    retryJob: async (id) => {
      await boss.retry(REVIEW_QUEUE, id);
    },
    publicUrl: publicUrl(config),
    adminPassword,
    signingKey: deriveSigningKey(encryptionKey, adminPassword),
    credentials,
    exchangeManifestCode,
    acceptWebhook: createWebhookHandler(pool, boss, accountAllowed),
    publicApp: config.ALLOWED_ACCOUNTS.length > 0,
  });
  const server = Bun.serve({ port: config.PORT, fetch: app.fetch });
  log.info("api listening", { port: server.port, publicUrl: publicUrl(config) });

  onShutdown(
    async () => {
      await server.stop(); // stop accepting, let in-flight requests finish
      await boss.stop({ graceful: false });
      await pool.end();
    },
    { timeoutMs: 8_000 }, // well inside Railway's default ~11 s
  );
}
