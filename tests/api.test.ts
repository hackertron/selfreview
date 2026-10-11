import { describe, expect, test } from "bun:test";
import { hmacHex } from "../src/crypto";
import type { AppCredentials, ManifestConversion } from "../src/github/app";
import { createApp, type ApiDeps } from "../src/roles/api";
import { createSessionToken, createStateToken } from "../src/web/tokens";
import type { IncomingWebhook } from "../src/webhooks";

const signingKey = Buffer.alloc(32, 7);
const app: AppCredentials = {
  appId: 1,
  slug: "selfreview-acme",
  owner: "acme",
  ownerType: "Organization",
  clientId: "Iv1.x",
  privateKey: "pem",
  webhookSecret: "whsec",
  clientSecret: "cs",
};

function setup(overrides: Partial<ApiDeps> & { configured?: boolean } = {}) {
  const received: IncomingWebhook[] = [];
  const saved: ManifestConversion[] = [];
  const retried: string[] = [];
  const deps: ApiDeps = {
    checkDb: async () => {},
    dashboard: async () => ({
      month: { spentUsd: 0.0123, reviews: 3, posted: 2, findings: 4 },
      quality: [{ model: "openrouter:z-ai/glm-5.3", findings: 4, addressed: 2, resolved: 1, reactions: 1 }],
      reviews: [{ repo: "acme/api", pr: 7, sha: "abcdef1234", status: "posted", skipReason: null, model: "openrouter:z-ai/glm-5.3", findings: 2, costUsd: 0.007, durationMs: 11000, createdAt: new Date() }],
      installations: [{ account: "acme", accountType: "Organization", repoCount: null, installedAt: new Date(), removedAt: null }],
      deliveries: [{ receivedAt: new Date(), event: "pull_request", action: "opened", outcome: "queued" }],
      failedJobs: [{ id: "job-1", repo: "acme/api", pr: 8, failedAt: new Date(), error: "<script>alert(1)</script>" }],
    }),
    retryJob: async (id) => void retried.push(id),
    publicUrl: "https://selfreview.example",
    adminPassword: "correct-horse-battery",
    signingKey,
    credentials: {
      get: async () => (overrides.configured === false ? null : app),
      save: async (c) => (saved.push(c), true),
    },
    exchangeManifestCode: async () => {
      throw new Error("not in this test");
    },
    acceptWebhook: async (hook) => (received.push(hook), { status: 202, outcome: "queued" }),
    ...overrides,
  };
  return { http: createApp(deps), received, saved, retried };
}

const cookie = () => `selfreview_session=${createSessionToken(signingKey)}`;

describe("GET /health", () => {
  test("200 when the database answers", async () => {
    const res = await setup().http.request("/health");
    expect(res.status).toBe(200);
  });

  test("503 when the database is down, so Railway won't route traffic to this deployment", async () => {
    const res = await setup({ checkDb: async () => Promise.reject(new Error("down")) }).http.request("/health");
    expect(res.status).toBe(503);
  });
});

describe("login", () => {
  test("setup pages redirect to login without a session", async () => {
    const res = await setup({ configured: false }).http.request("/setup");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fsetup");
  });

  test("wrong password is rejected", async () => {
    const res = await setup().http.request("/login", {
      method: "POST",
      body: new URLSearchParams({ password: "nope", next: "/setup" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("right password sets a session cookie and redirects to a local path only", async () => {
    const res = await setup().http.request("/login", {
      method: "POST",
      body: new URLSearchParams({ password: "correct-horse-battery", next: "//evil.example" }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("after 10 wrong passwords, even the right one is refused for a while", async () => {
    const { http } = setup();
    const login = (password: string) =>
      http.request("/login", { method: "POST", body: new URLSearchParams({ password }) });

    for (let i = 0; i < 10; i++) {
      expect((await login("nope")).status).toBe(401);
    }

    const res = await login("correct-horse-battery");
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("never redirects off-site, even with paths browsers read as another host", async () => {
    for (const next of ["/\\evil.example", "/\t/evil.example", "https://evil.example"]) {
      const res = await setup().http.request("/login", {
        method: "POST",
        body: new URLSearchParams({ password: "correct-horse-battery", next }),
      });
      expect(res.headers.get("location")).toBe("/");
    }
  });
});

describe("setup", () => {
  test("org setup posts the manifest to the org's app page, with a state", async () => {
    const res = await setup({ configured: false }).http.request("/setup/create?owner=org&org=selfreviewhq", {
      headers: { cookie: cookie() },
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("https://github.com/organizations/selfreviewhq/settings/apps/new?state=");
    expect(body).toContain("https://selfreview.example/webhooks/github");
  });

  test("callback refuses a forged or missing state", async () => {
    const res = await setup({ configured: false }).http.request("/setup/callback?code=abc&state=forged", {
      headers: { cookie: cookie() },
    });
    expect(res.status).toBe(400);
  });

  test("callback with a valid state exchanges the code and saves the app", async () => {
    const t = setup({
      configured: false,
      exchangeManifestCode: async () => ({
        id: 9,
        slug: "selfreview-acme",
        html_url: "https://github.com/apps/selfreview-acme",
        owner: { login: "acme", type: "Organization" },
        client_id: "Iv1.x",
        client_secret: "cs",
        webhook_secret: "whsec",
        pem: "pem",
      }),
    });
    const state = encodeURIComponent(createStateToken(signingKey));
    const res = await t.http.request(`/setup/callback?code=abc&state=${state}`, { headers: { cookie: cookie() } });
    expect(res.status).toBe(200);
    expect(t.saved).toHaveLength(1);
    expect(await res.text()).toContain("https://github.com/apps/selfreview-acme/installations/new");
  });
});

describe("POST /webhooks/github", () => {
  const body = JSON.stringify({ action: "opened" });
  const post = (t: ReturnType<typeof setup>, signature: string | null) =>
    t.http.request("/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
        ...(signature ? { "x-hub-signature-256": signature } : {}),
      },
    });

  test("rejects a forged signature without touching the database", async () => {
    const t = setup();
    expect((await post(t, `sha256=${hmacHex("wrong-secret", body)}`)).status).toBe(401);
    expect((await post(t, null)).status).toBe(401);
    expect(t.received).toHaveLength(0);
  });

  test("accepts a correctly signed webhook", async () => {
    const t = setup();
    const res = await post(t, `sha256=${hmacHex("whsec", body)}`);
    expect(res.status).toBe(202);
    expect(t.received[0]?.event).toBe("pull_request");
  });

  test("404 before the app is set up", async () => {
    expect((await post(setup({ configured: false }), "sha256=x")).status).toBe(404);
  });
});

describe("dashboard", () => {
  test("requires login", async () => {
    const res = await setup().http.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2F");
  });

  test("shows spend, reviews and failed jobs, escaping anything that came from outside", async () => {
    const res = await setup().http.request("/", { headers: { cookie: cookie() } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("$0.01"); // spent this month
    expect(body).toContain("acme/api#7");
    expect(body).toContain("75%"); // acted on: (2 addressed + 1 resolved) / 4
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  test("retrying a failed job needs a session", async () => {
    const t = setup();
    expect((await t.http.request("/jobs/job-1/retry", { method: "POST" })).status).toBe(302);
    expect(t.retried).toEqual([]);
    const res = await t.http.request("/jobs/job-1/retry", { method: "POST", headers: { cookie: cookie() } });
    expect(res.headers.get("location")).toBe("/");
    expect(t.retried).toEqual(["job-1"]);
  });
});
