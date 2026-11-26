-- ClairFlux v1.1.0-build.2 — Lot 2 Expand Migration (100% additive, idempotent, non-destructive)
-- Creates AI categorization enums, ai_categorization_runs, ai_rule_suggestions, and pending review index.

DO $$
BEGIN
  CREATE TYPE ai_backfill_run_status AS ENUM (
    'running',
    'completed',
    'partial_error',
    'failed',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE ai_rule_suggestion_status AS ENUM (
    'pending',
    'accepted',
    'dismissed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ai_categorization_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status ai_backfill_run_status NOT NULL DEFAULT 'running',
  trigger_source varchar(32) NOT NULL DEFAULT 'manual_backfill',
  cursor_tx_id uuid,
  model_used varchar(80),
  total_candidates integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  auto_applied_count integer NOT NULL DEFAULT 0,
  queued_review_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  estimated_tokens integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ai_runs_counts_non_negative CHECK (
    total_candidates >= 0
    AND processed_count >= 0
    AND auto_applied_count >= 0
    AND queued_review_count >= 0
    AND failed_count >= 0
    AND estimated_tokens >= 0
  ),
  CONSTRAINT chk_ai_runs_trigger_source CHECK (
    trigger_source IN ('manual_backfill', 'post_pdf_sync')
  ),
  CONSTRAINT chk_ai_runs_finished_ts CHECK (
    status = 'running' OR finished_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_runs_single_running
  ON ai_categorization_runs (status)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_ai_runs_status_started
  ON ai_categorization_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_rule_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_pattern varchar(200) NOT NULL,
  match_mode rule_match_mode_enum NOT NULL DEFAULT 'contains',
  target_category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  target_subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  sample_count integer NOT NULL DEFAULT 1,
  status ai_rule_suggestion_status NOT NULL DEFAULT 'pending',
  accepted_rule_id uuid REFERENCES categorization_rules(id) ON DELETE SET NULL,
  revision bigint NOT NULL DEFAULT nextval('sync_revision_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ai_rule_suggestions_pattern_non_empty CHECK (char_length(trim(merchant_pattern)) > 0),
  CONSTRAINT chk_ai_rule_suggestions_sample_min CHECK (sample_count >= 1),
  CONSTRAINT chk_ai_rule_suggestions_distinct_subcat CHECK (
    target_subcategory_id IS NULL OR target_subcategory_id <> target_category_id
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_rule_suggestions_merchant_pattern
  ON ai_rule_suggestions (merchant_pattern);

CREATE INDEX IF NOT EXISTS idx_ai_rule_suggestions_status
  ON ai_rule_suggestions (status, sample_count DESC);

CREATE INDEX IF NOT EXISTS idx_ai_rule_suggestions_revision
  ON ai_rule_suggestions (revision);

CREATE INDEX IF NOT EXISTS idx_tx_ai_review_status_pending
  ON transactions (ai_review_status)
  WHERE ai_review_status = 'pending_review' AND deleted_at IS NULL;
