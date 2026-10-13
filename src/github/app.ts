// The GitHub App this deployment owns: created once via the manifest flow (ARCHITECTURE §7),
// stored encrypted in `app_credentials`, cached in memory after the first read.
import { z } from "zod";
import { decrypt, encrypt } from "../crypto";
import type { Pool } from "../db/pool";

export type AppCredentials = {
  appId: number;
  slug: string;
  owner: string;
  ownerType: "User" | "Organization";
  clientId: string;
  privateKey: string;
  webhookSecret: string;
  clientSecret: string;
};

/** What GitHub returns from POST /app-manifests/{code}/conversions. */
export const ManifestConversion = z.object({
  id: z.number(),
  slug: z.string(),
  html_url: z.string(),
  owner: z.object({ login: z.string(), type: z.enum(["User", "Organization"]) }),
  client_id: z.string(),
  client_secret: z.string(),
  webhook_secret: z.string(),
  pem: z.string(),
});
export type ManifestConversion = z.infer<typeof ManifestConversion>;

/**
 * `isPublic` is true when ALLOWED_ACCOUNTS lists other accounts: a private app can only be
 * installed on the account that owns it. Reviews for accounts not on the list are refused anyway.
 */
export function buildManifest(publicUrl: string, org?: string, isPublic = false) {
  return {
    // GitHub lets the person rename it on the next page; names are globally unique.
    name: org ? `selfreview-${org}`.slice(0, 34) : "selfreview",
    url: publicUrl,
    hook_attributes: { url: `${publicUrl}/webhooks/github`, active: true },
    redirect_url: `${publicUrl}/setup/callback`,
    public: isPublic,
    default_permissions: {
      pull_requests: "write", // read diffs, post reviews and comments
      contents: "read", // read files and .selfreview.yml
      metadata: "read", // required by GitHub for every app
      issues: "read", // receive /selfreview comments
      checks: "write", // the "Selfreview" check on each commit
    },
    default_events: ["pull_request", "issue_comment"],
  };
}

export async function exchangeManifestCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`manifest exchange failed: HTTP ${res.status}`);
  return ManifestConversion.parse(await res.json());
}

export class AppCredentialStore {
  private cached: AppCredentials | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer,
  ) {}

  async get(): Promise<AppCredentials | null> {
    if (this.cached) return this.cached;
    const { rows } = await this.pool.query(
      `SELECT app_id, slug, owner, owner_type, client_id, private_key_enc, webhook_secret_enc, client_secret_enc
       FROM app_credentials WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return null; // not set up yet; don't cache, setup may happen on another replica
    this.cached = {
      appId: Number(row.app_id),
      slug: row.slug,
      owner: row.owner,
      ownerType: row.owner_type,
      clientId: row.client_id,
      privateKey: decrypt(this.key, row.private_key_enc),
      webhookSecret: decrypt(this.key, row.webhook_secret_enc),
      clientSecret: decrypt(this.key, row.client_secret_enc),
    };
    return this.cached;
  }

  /** First setup wins; afterwards setup is locked. Returns false if an app already exists. */
  async save(app: ManifestConversion): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO app_credentials
         (id, app_id, slug, owner, owner_type, client_id, private_key_enc, webhook_secret_enc, client_secret_enc)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        app.id,
        app.slug,
        app.owner.login,
        app.owner.type,
        app.client_id,
        encrypt(this.key, app.pem),
        encrypt(this.key, app.webhook_secret),
        encrypt(this.key, app.client_secret),
      ],
    );
    return rowCount === 1;
  }
}
