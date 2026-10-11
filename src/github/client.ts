// GitHub App authentication, in two steps (ARCHITECTURE §4.2 step 1):
//  1. Sign a short-lived JWT with the app's private key: proves "I am the app".
//  2. Trade it for an installation token: "act in this one org's repos", valid 1 hour.
// Tokens are cached per installation and refreshed 5 minutes before they expire.
import { createSign } from "node:crypto";
import { Octokit } from "@octokit/rest";
import type { AppCredentials } from "./app";

const USER_AGENT = "selfreview";
// Octokit prints every failed request (e.g. the expected 404 for a repo without .selfreview.yml).
// The pipeline logs its own outcomes as JSON, so keep Octokit quiet.
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export function createAppJwt(appId: number, privateKey: string, now = Date.now()): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000) - 60; // allow for clock drift
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 9 * 60, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export class GitHubApp {
  private tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly credentials: () => Promise<AppCredentials>) {}

  /** Client authenticated as the app itself (for /app/* endpoints like webhook deliveries). */
  async asApp(): Promise<Octokit> {
    const app = await this.credentials();
    return new Octokit({ auth: createAppJwt(app.appId, app.privateKey), userAgent: USER_AGENT, log: quiet });
  }

  /** Client acting inside one installation (an org or user account that installed the app). */
  async forInstallation(installationId: number): Promise<Octokit> {
    return new Octokit({ auth: await this.installationToken(installationId), userAgent: USER_AGENT, log: quiet });
  }

  async botLogin(): Promise<string> {
    return `${(await this.credentials()).slug}[bot]`;
  }

  private async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
    const { data } = await (await this.asApp()).apps.createInstallationAccessToken({ installation_id: installationId });
    this.tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }
}
