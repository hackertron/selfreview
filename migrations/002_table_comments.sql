-- Self-documenting schema: anyone opening the database (psql \d+, a GUI) sees what each table is
-- for and what it must never contain.
COMMENT ON TABLE app_credentials IS 'The GitHub App created by the manifest flow. One row. Secrets are AES-256-GCM encrypted with ENCRYPTION_KEY.';
COMMENT ON TABLE installations IS 'Accounts that installed the app. Kept after uninstall (removed_at) for churn analytics.';
COMMENT ON TABLE webhook_deliveries IS 'Accepted GitHub webhooks, keyed by delivery id for dedupe and redelivery checks. Deleted after 30 days.';
COMMENT ON TABLE reviews IS 'One row per review attempt: usage, cost and outcome. Never stores code, diffs, prompts or responses.';
COMMENT ON TABLE findings IS 'Metadata of posted comments (path, line, severity, fingerprint, outcome). Comment text lives only on GitHub.';
