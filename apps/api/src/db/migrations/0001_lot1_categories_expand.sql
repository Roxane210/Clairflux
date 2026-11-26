-- ClairFlux v1.1.0-build.1 — Lot 1 Expand Migration (100% additive, non-destructive)
-- Creates v2 category enums, 2-level categories table, max-depth-2 trigger, and nullable/defaulted expand columns.

DO $$
BEGIN
  CREATE TYPE budget_group_enum AS ENUM (
    'fixed',
    'variable',
    'non_monthly',
    'income',
    'savings',
    'transfer'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE category_source_enum AS ENUM (
    'manual',
    'rule',
    'ai_auto',
    'ai_validated',
    'uncategorized'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE ai_review_status_enum AS ENUM (
    'none',
    'pending_review',
    'accepted',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES categories(id) ON DELETE RESTRICT,
  name varchar(64) NOT NULL,
  slug varchar(80) NOT NULL,
  budget_group budget_group_enum NOT NULL,
  color_token varchar(32) NOT NULL DEFAULT 'slate',
  sort_order integer NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT nextval('sync_revision_seq'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT chk_categories_name_non_empty CHECK (char_length(trim(name)) > 0),
  CONSTRAINT chk_categories_slug_non_empty CHECK (char_length(trim(slug)) > 0),
  CONSTRAINT chk_categories_color_non_empty CHECK (char_length(trim(color_token)) > 0),
  CONSTRAINT chk_categories_sort_non_negative CHECK (sort_order >= 0),
  CONSTRAINT chk_categories_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_active_slug
  ON categories (slug)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_active_sibling_name
  ON categories (
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(trim(name))
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_categories_parent_sort
  ON categories (parent_id, sort_order)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_categories_budget_group
  ON categories (budget_group)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_categories_revision
  ON categories (revision);

CREATE OR REPLACE FUNCTION enforce_category_max_depth_2()
RETURNS TRIGGER AS $$
DECLARE
  v_parent_parent_id uuid;
  v_parent_found boolean;
BEGIN
  IF NEW.deleted_at IS NULL AND NEW.parent_id IS NOT NULL THEN
    SELECT TRUE, parent_id
      INTO v_parent_found, v_parent_parent_id
      FROM categories
     WHERE id = NEW.parent_id
       AND deleted_at IS NULL;

    IF NOT COALESCE(v_parent_found, FALSE) THEN
      RAISE EXCEPTION 'CATEGORY_PARENT_NOT_FOUND: parent category % does not exist or is archived/removed', NEW.parent_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_parent_parent_id IS NOT NULL THEN
      RAISE EXCEPTION 'CATEGORY_DEPTH_EXCEEDED: maximum category hierarchy depth is 2 levels'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM categories
       WHERE parent_id = NEW.id
         AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'CATEGORY_DEPTH_EXCEEDED: cannot nest a root category that already has children'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'trg_categories_max_depth_2'
       AND tgrelid = 'categories'::regclass
  ) THEN
    CREATE TRIGGER trg_categories_max_depth_2
      BEFORE INSERT OR UPDATE OF parent_id, deleted_at ON categories
      FOR EACH ROW
      EXECUTE FUNCTION enforce_category_max_depth_2();
  END IF;
END $$;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category_source category_source_enum NOT NULL DEFAULT 'uncategorized',
  ADD COLUMN IF NOT EXISTS ai_suggested_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_suggested_subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_confidence_bp integer,
  ADD COLUMN IF NOT EXISTS ai_review_status ai_review_status_enum NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS ai_reason varchar(240),
  ADD COLUMN IF NOT EXISTS ai_model varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_tx_subcat_requires_cat'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT chk_tx_subcat_requires_cat
      CHECK (subcategory_id IS NULL OR category_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_tx_ai_subcat_requires_cat'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT chk_tx_ai_subcat_requires_cat
      CHECK (ai_suggested_subcategory_id IS NULL OR ai_suggested_category_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_tx_ai_confidence_bp_range'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT chk_tx_ai_confidence_bp_range
      CHECK (ai_confidence_bp IS NULL OR (ai_confidence_bp >= 0 AND ai_confidence_bp <= 10000));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tx_category_booking
  ON transactions (category_id, subcategory_id, booking_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tx_ai_review_queue
  ON transactions (ai_review_status, ai_confidence_bp DESC, booking_date DESC)
  WHERE ai_review_status = 'pending_review' AND deleted_at IS NULL;

ALTER TABLE categorization_rules
  ADD COLUMN IF NOT EXISTS target_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rules_subcat_requires_cat'
  ) THEN
    ALTER TABLE categorization_rules
      ADD CONSTRAINT chk_rules_subcat_requires_cat
      CHECK (target_subcategory_id IS NULL OR target_category_id IS NOT NULL);
  END IF;
END $$;
