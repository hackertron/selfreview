-- Selfreview schema v1. Rule: store metadata, never content (ARCHITECTURE §6).
-- No table holds source code, diffs, PR text, comment text, prompts or LLM responses.

-- The GitHub App this deployment created via the manifest flow. Exactly one row.
CREATE TABLE app_credentials (
  id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_id              bigint NOT NULL,
  slug                text NOT NULL,
  owner               text NOT NULL,
  owner_type          text NOT NULL CHECK (owner_type IN ('User', 'Organization')),
  client_id           text NOT NULL,
  private_key_enc     text NOT NULL,  -- AES-256-GCM with ENCRYPTION_KEY
  webhook_secret_enc  text NOT NULL,
  client_secret_enc   text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Accounts (users or orgs) that installed the app. Kept after uninstall for churn analytics.
CREATE TABLE installations (
  id            bigint PRIMARY KEY,  -- GitHub installation id
  account       text NOT NULL,
  account_type  text NOT NULL,
  repo_count    integer,
  installed_at  timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);

-- Every webhook we accepted. Primary key = GitHub's delivery id, so duplicates are ignored, and
-- cron can tell which failed deliveries we never received. Rows older than 30 days are deleted.
CREATE TABLE webhook_deliveries (
  delivery_id  uuid PRIMARY KEY,
  event        text NOT NULL,
  action       text,
  outcome      text NOT NULL,  -- e.g. queued, ignored:draft, ignored:bot, duplicate
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_received_at ON webhook_deliveries (received_at);

-- One row per review attempt: the usage ledger behind costs, budgets and "already reviewed".
CREATE TABLE reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id   bigint NOT NULL REFERENCES installations (id),
  repo              text NOT NULL,
  pr                integer NOT NULL,
  head_sha          text NOT NULL,
  base_sha          text,
  trigger           text NOT NULL,
  status            text NOT NULL CHECK (status IN ('posted', 'no_new_findings', 'skipped', 'failed')),
  skip_reason       text,
  github_review_id  bigint,
  model             text,
  files_reviewed    integer NOT NULL DEFAULT 0,
  lines_reviewed    integer NOT NULL DEFAULT 0,
  tokens_in         integer NOT NULL DEFAULT 0,
  tokens_out        integer NOT NULL DEFAULT 0,
  tokens_cached     integer NOT NULL DEFAULT 0,
  cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
  duration_ms       integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_pr_head ON reviews (repo, pr, head_sha);
CREATE INDEX reviews_created_at ON reviews (created_at);  -- monthly budget sums
CREATE INDEX reviews_installation ON reviews (installation_id);

-- One row per posted inline comment: metadata only. The comment text lives on GitHub.
CREATE TABLE findings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id    uuid NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  path         text NOT NULL,
  line         integer NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  category     text NOT NULL CHECK (category IN ('bug', 'security', 'performance', 'reliability', 'maintainability')),
  fingerprint  text NOT NULL,
  comment_id   bigint,
  outcome      text NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'addressed', 'resolved')),
  reaction     integer NOT NULL DEFAULT 0,  -- net 👍 minus 👎
  posted_at    timestamptz NOT NULL DEFAULT now(),
  outcome_at   timestamptz
);
CREATE INDEX findings_review ON findings (review_id);
CREATE INDEX findings_fingerprint ON findings (fingerprint);
CREATE INDEX findings_open_recent ON findings (posted_at) WHERE outcome = 'open';
