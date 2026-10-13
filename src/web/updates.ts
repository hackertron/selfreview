// The dashboard's "update available" note. Railway already shows an update notice in the project
// for template deploys; this repeats it where people actually look. It uses GitHub's public API
// without a token (60 requests an hour per IP), so the answer is cached for hours.

export type UpdateInfo = { runningSha: string; newCommits: number; compareUrl: string };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const CACHE_MS = 6 * 60 * 60 * 1000;

export function createUpdateCheck(repo: string, runningSha: string | undefined, fetcher: Fetch = fetch) {
  let cached: { at: number; value: UpdateInfo | null } | null = null;

  return async function checkForUpdate(): Promise<UpdateInfo | null> {
    if (!runningSha) return null; // not deployed from GitHub (local run, or a Docker image)
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const value = await compareWithMain(repo, runningSha, fetcher).catch(() => null);
    cached = { at: Date.now(), value };
    return value;
  };
}

async function compareWithMain(repo: string, runningSha: string, fetcher: Fetch): Promise<UpdateInfo | null> {
  const res = await fetcher(`https://api.github.com/repos/${repo}/compare/${runningSha}...HEAD`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "selfreview" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null; // e.g. a fork whose commits aren't in UPDATE_REPO
  const body = (await res.json()) as { status: string; ahead_by: number; html_url: string };
  // "ahead" means the main branch has commits this deployment doesn't.
  if (body.status !== "ahead" || body.ahead_by === 0) return null;
  return { runningSha, newCommits: body.ahead_by, compareUrl: body.html_url };
}
