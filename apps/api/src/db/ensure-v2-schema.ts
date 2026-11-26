import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FRENCH_CATEGORY_PACK,
  INTERNAL_TRANSFER_SUBCATEGORY_ID,
  TRANSFERS_ROOT_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_ID,
  slugifyCategoryName,
  type Category,
} from '@clairflux/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NeonClients } from './client.js';
import { categories, categorizationRules, transactions } from './schema.js';

type NeonTx = Parameters<Parameters<NeonClients['poolDb']['transaction']>[0]>[0];

interface ActiveCategoryLookup {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly slug: string;
}

const LOT1_DDL_STATEMENTS: readonly string[] = [
  `DO $$
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
END $$;`,
  `DO $$
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
END $$;`,
  `DO $$
BEGIN
  CREATE TYPE ai_review_status_enum AS ENUM (
    'none',
    'pending_review',
    'accepted',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;`,
  `CREATE TABLE IF NOT EXISTS categories (
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
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_active_slug
  ON categories (slug)
  WHERE deleted_at IS NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_active_sibling_name
  ON categories (
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(trim(name))
  )
  WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_categories_parent_sort
  ON categories (parent_id, sort_order)
  WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_categories_budget_group
  ON categories (budget_group)
  WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_categories_revision
  ON categories (revision);`,
  `CREATE OR REPLACE FUNCTION enforce_category_max_depth_2()
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
      RAISE EXCEPTION 'CATEGORY_PARENT_NOT_FOUND: parent category % does not exist or is inactive', NEW.parent_id
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
$$ LANGUAGE plpgsql;`,
  `DO $$
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
END $$;`,
  `ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category_source category_source_enum NOT NULL DEFAULT 'uncategorized',
  ADD COLUMN IF NOT EXISTS ai_suggested_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_suggested_subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_confidence_bp integer,
  ADD COLUMN IF NOT EXISTS ai_review_status ai_review_status_enum NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS ai_reason varchar(240),
  ADD COLUMN IF NOT EXISTS ai_model varchar(64);`,
  `DO $$
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
END $$;`,
  `CREATE INDEX IF NOT EXISTS idx_tx_category_booking
  ON transactions (category_id, subcategory_id, booking_date DESC)
  WHERE deleted_at IS NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_tx_ai_review_queue
  ON transactions (ai_review_status, ai_confidence_bp DESC, booking_date DESC)
  WHERE ai_review_status = 'pending_review' AND deleted_at IS NULL;`,
  `ALTER TABLE categorization_rules
  ADD COLUMN IF NOT EXISTS target_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_subcategory_id uuid REFERENCES categories(id) ON DELETE SET NULL;`,
  `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rules_subcat_requires_cat'
  ) THEN
    ALTER TABLE categorization_rules
      ADD CONSTRAINT chk_rules_subcat_requires_cat
      CHECK (target_subcategory_id IS NULL OR target_category_id IS NOT NULL);
  END IF;
END $$;`,
];

async function insertSeedItem(tx: NeonTx, item: Category): Promise<void> {
  await tx.execute(sql`
    INSERT INTO categories (
      id,
      parent_id,
      name,
      slug,
      budget_group,
      color_token,
      sort_order,
      is_system,
      is_archived,
      revision
    )
    VALUES (
      ${item.id}::uuid,
      ${item.parent_id}::uuid,
      ${item.name},
      ${item.slug},
      ${item.budget_group}::budget_group_enum,
      ${item.color_token},
      ${item.sort_order},
      ${item.is_system},
      false,
      nextval('sync_revision_seq')
    )
    ON CONFLICT (slug) WHERE deleted_at IS NULL DO NOTHING
  `);
}

function buildCategoryResolvers(rows: readonly ActiveCategoryLookup[]): {
  readonly byLowerName: Map<string, ActiveCategoryLookup>;
  readonly bySlug: Map<string, ActiveCategoryLookup>;
} {
  const byLowerName = new Map<string, ActiveCategoryLookup>();
  const bySlug = new Map<string, ActiveCategoryLookup>();

  // Prefer root categories first when multiple nodes share a name, then keep first match.
  const ordered = [...rows].sort((a, b) => {
    if (a.parentId === null && b.parentId !== null) {
      return -1;
    }
    if (a.parentId !== null && b.parentId === null) {
      return 1;
    }
    return a.name.localeCompare(b.name, 'fr');
  });

  for (const row of ordered) {
    const lowerKey = row.name.trim().toLowerCase();
    if (!byLowerName.has(lowerKey)) {
      byLowerName.set(lowerKey, row);
    }
    if (!bySlug.has(row.slug)) {
      bySlug.set(row.slug, row);
    }
  }

  return { byLowerName, bySlug };
}

function resolveCategoryIds(
  label: string,
  resolvers: {
    readonly byLowerName: Map<string, ActiveCategoryLookup>;
    readonly bySlug: Map<string, ActiveCategoryLookup>;
  },
): { readonly categoryId: string; readonly subcategoryId: string | null } {
  const trimmed = label.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length === 0) {
    return { categoryId: UNCATEGORIZED_CATEGORY_ID, subcategoryId: null };
  }

  const direct =
    resolvers.byLowerName.get(lower) ?? resolvers.bySlug.get(slugifyCategoryName(trimmed));

  if (direct !== undefined) {
    if (direct.parentId !== null) {
      return { categoryId: direct.parentId, subcategoryId: direct.id };
    }
    return { categoryId: direct.id, subcategoryId: null };
  }

  return { categoryId: UNCATEGORIZED_CATEGORY_ID, subcategoryId: null };
}

/**
 * Ensures the Lot 1 categories DDL, starter French category pack, custom legacy category
 * migration, and non-destructive backfill of `transactions` / `categorization_rules`
 * are applied idempotently on API startup.
 */
export async function ensureLot1CategoriesSchemaAndSeed(clients: NeonClients): Promise<void> {
  await clients.poolDb.transaction(async (tx) => {
    for (const statement of LOT1_DDL_STATEMENTS) {
      await tx.execute(sql.raw(statement));
    }

    const existingCountRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(categories);
    const totalCategoryRows = existingCountRows[0]?.count ?? 0;

    if (totalCategoryRows === 0) {
      const roots = DEFAULT_FRENCH_CATEGORY_PACK.filter((item) => item.parent_id === null);
      const children = DEFAULT_FRENCH_CATEGORY_PACK.filter((item) => item.parent_id !== null);

      for (const root of roots) {
        await insertSeedItem(tx, root);
      }
      for (const child of children) {
        await insertSeedItem(tx, child);
      }
    } else {
      // Always guarantee protected fallback & internal transfer system categories exist.
      const requiredIds = new Set<string>([
        UNCATEGORIZED_CATEGORY_ID,
        TRANSFERS_ROOT_CATEGORY_ID,
        INTERNAL_TRANSFER_SUBCATEGORY_ID,
      ]);
      const requiredItems = DEFAULT_FRENCH_CATEGORY_PACK.filter((item) =>
        requiredIds.has(item.id),
      ).sort((a, b) => (a.parent_id === null ? -1 : b.parent_id === null ? 1 : 0));

      for (const item of requiredItems) {
        await insertSeedItem(tx, item);
      }
    }

    const [txDistinctRows, ruleDistinctRows] = await Promise.all([
      tx
        .selectDistinct({ label: transactions.category })
        .from(transactions)
        .where(and(isNull(transactions.deletedAt), isNull(transactions.categoryId))),
      tx
        .selectDistinct({ label: categorizationRules.targetCategory })
        .from(categorizationRules)
        .where(and(isNull(categorizationRules.deletedAt), isNull(categorizationRules.targetCategoryId))),
    ]);

    const initialActiveCategories = await tx
      .select({
        id: categories.id,
        parentId: categories.parentId,
        name: categories.name,
        slug: categories.slug,
      })
      .from(categories)
      .where(isNull(categories.deletedAt));

    let resolvers = buildCategoryResolvers(initialActiveCategories);

    const legacyLabels = new Set<string>();
    for (const row of txDistinctRows) {
      const trimmed = row.label.trim();
      if (trimmed.length > 0) {
        legacyLabels.add(trimmed);
      }
    }
    for (const row of ruleDistinctRows) {
      const trimmed = row.label.trim();
      if (trimmed.length > 0) {
        legacyLabels.add(trimmed);
      }
    }

    let createdCustomCategory = false;
    for (const label of legacyLabels) {
      const lower = label.toLowerCase();
      const slug = slugifyCategoryName(label);
      if (resolvers.byLowerName.has(lower) || resolvers.bySlug.has(slug)) {
        continue;
      }

      const customName = label.slice(0, 64);
      await tx.execute(sql`
        INSERT INTO categories (
          id,
          parent_id,
          name,
          slug,
          budget_group,
          color_token,
          sort_order,
          is_system,
          is_archived,
          revision
        )
        VALUES (
          ${randomUUID()}::uuid,
          NULL,
          ${customName},
          ${slug},
          'variable'::budget_group_enum,
          'slate',
          500,
          false,
          false,
          nextval('sync_revision_seq')
        )
        ON CONFLICT (slug) WHERE deleted_at IS NULL DO NOTHING
      `);
      createdCustomCategory = true;
    }

    if (createdCustomCategory) {
      const refreshedActiveCategories = await tx
        .select({
          id: categories.id,
          parentId: categories.parentId,
          name: categories.name,
          slug: categories.slug,
        })
        .from(categories)
        .where(isNull(categories.deletedAt));
      resolvers = buildCategoryResolvers(refreshedActiveCategories);
    }

    for (const row of ruleDistinctRows) {
      const target = resolveCategoryIds(row.label, resolvers);
      await tx
        .update(categorizationRules)
        .set({
          targetCategoryId: target.categoryId,
          targetSubcategoryId: target.subcategoryId,
        })
        .where(
          and(
            isNull(categorizationRules.deletedAt),
            isNull(categorizationRules.targetCategoryId),
            eq(categorizationRules.targetCategory, row.label),
          ),
        );
    }

    for (const row of txDistinctRows) {
      const target = resolveCategoryIds(row.label, resolvers);
      await tx.execute(sql`
        UPDATE transactions
        SET
          category_id = ${target.categoryId}::uuid,
          subcategory_id = ${target.subcategoryId}::uuid,
          category_source = CASE
            WHEN is_manual_category = true THEN 'manual'::category_source_enum
            WHEN matched_rule_id IS NOT NULL THEN 'rule'::category_source_enum
            ELSE 'uncategorized'::category_source_enum
          END
        WHERE deleted_at IS NULL
          AND category_id IS NULL
          AND category = ${row.label}
      `);
    }
  });
}
