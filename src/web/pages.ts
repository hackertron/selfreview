// Server-rendered pages: login, the one-time GitHub App setup, and the dashboard. `html` escapes
// every interpolated value, so nothing from a URL, GitHub or a model can inject markup.
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { DashboardData } from "./dashboard-data";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const ICON = raw(`<svg viewBox="0 0 512 512" width="40" height="40" aria-hidden="true"><rect width="512" height="512" rx="96" fill="#3B2F8F"/><g fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"><path d="M110 232 L256 108 L402 232"/><path d="M150 204 V372 H206 L182 428 L258 372 H362 V204"/><path d="M204 290 L242 326 L312 252"/></g></svg>`);

function layout(title: string, body: Html, opts: { wide?: boolean } = {}) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Selfreview</title>
<style>
  :root { color-scheme: light dark; --accent: #3B2F8F; --bg: #f7f7fb; --card: #fff; --text: #1c1b29; --muted: #5d5b72; --border: #e3e1ef; }
  @media (prefers-color-scheme: dark) { :root { --accent: #8f82ff; --bg: #121119; --card: #1c1b26; --text: #ecebf5; --muted: #a3a1b8; --border: #2e2c3d; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 560px; margin: 48px auto; padding: 0 16px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; font-weight: 600; font-size: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 8px 0; color: var(--muted); }
  label { display: block; margin: 16px 0 6px; font-weight: 500; }
  input[type=text], input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; }
  .choice { display: flex; gap: 8px; align-items: center; margin: 8px 0; font-weight: 400; }
  button, .button { display: inline-block; margin-top: 20px; padding: 10px 18px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
  .error { color: #d43c3c; }
  code { font-size: 14px; }
  main.wide { max-width: 1100px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .stat { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .label { color: var(--muted); font-size: 14px; }
  .bar { height: 6px; background: var(--border); border-radius: 3px; margin-top: 10px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--accent); }
  section { margin-bottom: 16px; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  .table { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; }
  td.num, th.num { text-align: right; }
  a { color: var(--accent); }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--border); }
  .pill.posted { background: #d8f3e0; color: #166534; } .pill.skipped { background: #fdf0d5; color: #8a5a00; } .pill.failed { background: #fde2e2; color: #9b1c1c; }
  @media (prefers-color-scheme: dark) { .pill.posted { background: #173b25; color: #8ee0a8; } .pill.skipped { background: #3d3013; color: #f0c76b; } .pill.failed { background: #451b1b; color: #f3a3a3; } }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .top form { margin: 0; } .top button { margin: 0; padding: 6px 12px; background: transparent; color: var(--muted); border: 1px solid var(--border); }
  .retry { margin: 0; padding: 4px 10px; font-size: 13px; }
  .empty { color: var(--muted); font-size: 14px; }
</style>
</head>
<body><main class="${opts.wide ? "wide" : ""}"><header>${ICON} Selfreview</header>${opts.wide ? body : html`<div class="card">${body}</div>`}</main></body>
</html>`;
}

export function loginPage(next: string, error?: string) {
  return layout(
    "Log in",
    html`<h1>Log in</h1>
      <p>Use the <code>ADMIN_PASSWORD</code> from the api service's Variables tab in Railway.</p>
      ${error ? html`<p class="error">${error}</p>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${next}">
        <label for="password">Admin password</label>
        <input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
        <button type="submit">Log in</button>
      </form>`,
  );
}

export function chooseOwnerPage() {
  return layout(
    "Set up",
    html`<h1>Create your GitHub App</h1>
      <p>Selfreview reviews pull requests through a GitHub App that you own. A private app can only be
        installed on the account that owns it, so create it where your repositories live.</p>
      <form method="get" action="/setup/create">
        <label class="choice"><input type="radio" name="owner" value="personal" checked> My personal account</label>
        <label class="choice"><input type="radio" name="owner" value="org"> An organization:</label>
        <input type="text" name="org" placeholder="organization name, e.g. acme" pattern="[A-Za-z0-9-]+">
        <button type="submit">Continue</button>
      </form>`,
  );
}

/** `action` already carries `?state=…` (the form verified working in M0). */
export function createAppPage(action: string, manifest: object, ownerLabel: string) {
  return layout(
    "Create GitHub App",
    html`<h1>Create the app on ${ownerLabel}</h1>
      <p>GitHub will show you the app's name and permissions. You can rename it there.</p>
      <form method="post" action="${action}">
        <input type="hidden" name="manifest" value="${JSON.stringify(manifest)}">
        <button type="submit">Create GitHub App</button>
      </form>`,
  );
}

export function setupDonePage(slug: string, owner: string) {
  return layout(
    "Installed",
    html`<h1>Your GitHub App is ready</h1>
      <p><b>${slug}</b> is owned by <b>${owner}</b>. Its keys are stored encrypted, and setup is now locked.</p>
      <p>Next, choose which repositories it should review.</p>
      <a class="button" href="https://github.com/apps/${slug}/installations/new">Install on repositories</a>`,
  );
}

export function messagePage(title: string, message: string, status?: "error") {
  return layout(title, html`<h1>${title}</h1><p class="${status ?? ""}">${message}</p>`);
}

// ---- dashboard ----

const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pct = (n: number) => `${Math.round(n * 100)}%`;

function ago(date: Date | null): string {
  if (!date) return "—";
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const STATUS_LABEL: Record<string, string> = { running: "in progress", posted: "posted", no_new_findings: "nothing new", skipped: "skipped", failed: "failed" };

export function dashboardPage(d: DashboardData, app: { slug: string; owner: string }) {
  const m = d.month;
  const totals = d.quality.reduce((t, q) => ({ findings: t.findings + q.findings, acted: t.acted + q.addressed + q.resolved }), { findings: 0, acted: 0 });
  const prLink = (repo: string, pr: number) => html`<a href="https://github.com/${repo}/pull/${pr}">${repo}#${pr}</a>`;

  return layout(
    "Dashboard",
    html`
    <section class="card top">
      <div><b>${app.slug}</b> <span class="label">· GitHub App owned by ${app.owner} ·</span>
        <a href="https://github.com/apps/${app.slug}/installations/new">install on more repos</a></div>
      <form method="post" action="/logout"><button type="submit">Log out</button></form>
    </section>

    <div class="cards">
      <div class="card"><div class="label">Spent this month</div><div class="stat">${usd(m.spentUsd)}</div>
        ${m.budgetUsd ? html`<div class="label">of ${usd(m.budgetUsd)} budget</div><div class="bar"><div style="width:${Math.min(100, (m.spentUsd / m.budgetUsd) * 100)}%"></div></div>` : html`<div class="label">no monthly budget set</div>`}</div>
      <div class="card"><div class="label">Reviews this month</div><div class="stat">${m.reviews}</div><div class="label">${m.posted} posted comments</div></div>
      <div class="card"><div class="label">Findings this month</div><div class="stat">${m.findings}</div><div class="label">${m.reviews ? usd(m.spentUsd / m.reviews) : "$0"} per review</div></div>
      <div class="card"><div class="label">Acted on (30 days)</div><div class="stat">${totals.findings ? pct(totals.acted / totals.findings) : "—"}</div><div class="label">code changed or thread resolved</div></div>
    </div>

    ${d.failedJobs.length ? html`
    <section class="card"><h2>Failed reviews</h2><div class="table"><table>
      <tr><th>PR</th><th>Failed</th><th>Error</th><th></th></tr>
      ${d.failedJobs.map((j) => html`<tr><td>${prLink(j.repo, j.pr)}</td><td>${ago(j.failedAt)}</td><td>${j.error}</td>
        <td><form method="post" action="/jobs/${j.id}/retry"><button class="retry" type="submit">Retry</button></form></td></tr>`)}
    </table></div></section>` : ""}

    <section class="card"><h2>Recent reviews</h2>
      ${d.reviews.length ? html`<div class="table"><table>
        <tr><th>PR</th><th>Commit</th><th>Result</th><th class="num">Comments</th><th>Model</th><th class="num">Cost</th><th class="num">Time</th><th>When</th></tr>
        ${d.reviews.map((r) => html`<tr>
          <td>${prLink(r.repo, r.pr)}</td><td><code>${r.sha.slice(0, 7)}</code></td>
          <td><span class="pill ${r.status}">${STATUS_LABEL[r.status] ?? r.status}</span>${r.skipReason ? html` <span class="label">${r.skipReason}</span>` : ""}</td>
          <td class="num">${r.findings}</td><td>${r.model ? r.model.replace(/^openrouter:/, "") : "—"}</td>
          <td class="num">${usd(r.costUsd)}</td><td class="num">${r.durationMs ? `${(r.durationMs / 1000).toFixed(0)}s` : "—"}</td><td>${ago(r.createdAt)}</td></tr>`)}
      </table></div>` : html`<p class="empty">No reviews yet. Open a pull request on an installed repo.</p>`}
    </section>

    <section class="card"><h2>Quality by model (last 30 days)</h2>
      ${d.quality.length ? html`<div class="table"><table>
        <tr><th>Model</th><th class="num">Comments</th><th class="num">Code changed after</th><th class="num">Resolved</th><th class="num">Acted on</th><th class="num">👍 − 👎</th></tr>
        ${d.quality.map((q) => html`<tr><td>${q.model.replace(/^openrouter:/, "")}</td><td class="num">${q.findings}</td><td class="num">${q.addressed}</td>
          <td class="num">${q.resolved}</td><td class="num">${pct((q.addressed + q.resolved) / Math.max(q.findings, 1))}</td><td class="num">${q.reactions}</td></tr>`)}
      </table></div>` : html`<p class="empty">Appears once comments have been posted.</p>`}
    </section>

    <div class="cards">
      <section class="card"><h2>Installations</h2>
        ${d.installations.length ? html`<div class="table"><table><tr><th>Account</th><th class="num">Repos</th><th>Installed</th></tr>
          ${d.installations.map((i) => html`<tr><td>${i.account}${i.removedAt ? html` <span class="label">(removed)</span>` : ""}</td><td class="num">${i.repoCount ?? "all"}</td><td>${ago(i.installedAt)}</td></tr>`)}
        </table></div>` : html`<p class="empty">Not installed anywhere yet.</p>`}
      </section>
      <section class="card"><h2>Recent webhooks</h2>
        ${d.deliveries.length ? html`<div class="table"><table><tr><th>Event</th><th>Outcome</th><th>When</th></tr>
          ${d.deliveries.map((w) => html`<tr><td>${w.event}${w.action ? `.${w.action}` : ""}</td><td>${w.outcome}</td><td>${ago(w.receivedAt)}</td></tr>`)}
        </table></div>` : html`<p class="empty">None yet.</p>`}
      </section>
    </div>`,
    { wide: true },
  );
}
