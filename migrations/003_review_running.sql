-- 'running' = budget reserved, review in progress (MONTHLY_BUDGET_USD). Its cost_usd holds the
-- estimate until the review finishes, so concurrent workers can't all pass the budget check.
ALTER TABLE reviews DROP CONSTRAINT reviews_status_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
  CHECK (status IN ('running', 'posted', 'no_new_findings', 'skipped', 'failed'));
