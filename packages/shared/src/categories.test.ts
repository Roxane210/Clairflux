import { describe, expect, it } from 'vitest';
import {
  AiReviewStatusSchema,
  ApiErrorCodeSchema,
  BudgetGroupSchema,
  CLAIRFLUX_BUILD_VERSION,
  CategorizationRuleSchema,
  CategoryIdSchema,
  CategorySchema,
  CategorySourceSchema,
  DEFAULT_FRENCH_CATEGORY_PACK,
  DeltaSyncResponseSchema,
  INTERNAL_TRANSFER_SUBCATEGORY_ID,
  TRANSFERS_ROOT_CATEGORY_ID,
  TransactionSchema,
  UNCATEGORIZED_CATEGORY_ID,
  buildCategoryTree,
  formatCategoryLabel,
  isProtectedSystemCategory,
  parseCategoryId,
  slugifyCategoryName,
  validateCategoryParentDepth,
  type Category,
} from './index.js';

const ISO_NOW = '2026-11-26T12:00:00.000Z';

function makeCategory(
  overrides: Partial<Category> & { readonly id: string; readonly name: string },
): Category {
  const { id, name, ...rest } = overrides;
  return CategorySchema.parse({
    id,
    parent_id: null,
    name,
    slug: slugifyCategoryName(name),
    budget_group: 'variable',
    color_token: 'slate',
    sort_order: 10,
    is_system: false,
    is_archived: false,
    revision: 1,
    updated_at: ISO_NOW,
    ...rest,
  });
}

describe('Category schemas & branded primitives', () => {
  it('validates and brands UUIDs with parseCategoryId', () => {
    const id = parseCategoryId('c1000000-0000-4000-8000-000000000001');
    expect(id).toBe('c1000000-0000-4000-8000-000000000001');
    expect(CategoryIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(() => parseCategoryId('invalid')).toThrow();
  });

  it('validates normative enums for budget groups, sources, and AI review statuses', () => {
    expect(BudgetGroupSchema.options).toEqual([
      'fixed',
      'variable',
      'non_monthly',
      'income',
      'savings',
      'transfer',
    ]);
    expect(CategorySourceSchema.options).toEqual([
      'manual',
      'rule',
      'ai_auto',
      'ai_validated',
      'uncategorized',
    ]);
    expect(AiReviewStatusSchema.options).toEqual([
      'none',
      'pending_review',
      'accepted',
      'rejected',
    ]);
  });

  it('rejects invalid CategorySchema payloads', () => {
    expect(
      CategorySchema.safeParse({
        id: 'c1000000-0000-4000-8000-000000000001',
        parent_id: null,
        name: '   ',
        slug: 'test',
        budget_group: 'variable',
        color_token: 'teal',
        sort_order: 10,
        is_system: false,
        is_archived: false,
        revision: 1,
        updated_at: ISO_NOW,
      }).success,
    ).toBe(false);

    expect(
      CategorySchema.safeParse({
        id: 'c1000000-0000-4000-8000-000000000001',
        parent_id: null,
        name: 'Courses',
        slug: 'courses',
        budget_group: 'variable',
        color_token: 'teal',
        sort_order: -1,
        is_system: false,
        is_archived: false,
        revision: 1,
        updated_at: ISO_NOW,
      }).success,
    ).toBe(false);
  });

  it('exposes new Lot 1 error codes, valid build version, and backward-compatible v1/v2 schemas', () => {
    expect(CLAIRFLUX_BUILD_VERSION).toMatch(/^\d+\.\d+\.\d+-build\.\d+$/);
    expect(ApiErrorCodeSchema.parse('CATEGORY_DEPTH_EXCEEDED')).toBe('CATEGORY_DEPTH_EXCEEDED');
    expect(ApiErrorCodeSchema.parse('CATEGORY_REASSIGN_REQUIRED')).toBe(
      'CATEGORY_REASSIGN_REQUIRED',
    );
    expect(ApiErrorCodeSchema.parse('CATEGORY_CONFLICT')).toBe('CATEGORY_CONFLICT');

    const v1Transaction = {
      id: '33333333-3333-4333-8333-333333333333',
      account_id: '11111111-1111-4111-8111-111111111111',
      bank: 'boursobank',
      account_type: 'courant',
      external_ref_masked: 'FR76****4821',
      booking_date: '2026-11-20',
      value_date: '2026-11-20',
      raw_label: 'CB CARREFOUR',
      clean_label: 'Carrefour',
      amount_cents: -4250,
      currency: 'EUR',
      fx_rate_micro: 1_000_000,
      amount_eur_cents: -4250,
      category: 'Alimentation',
      is_manual_category: false,
      matched_rule_id: null,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888888',
      revision: 10,
      updated_at: ISO_NOW,
    };
    expect(TransactionSchema.safeParse(v1Transaction).success).toBe(true);
    expect(
      TransactionSchema.safeParse({
        ...v1Transaction,
        category_id: 'c1000000-0000-4000-8000-000000000040',
        subcategory_id: 'c1000000-0000-4000-8000-000000000041',
        category_source: 'rule',
        ai_review_status: 'none',
      }).success,
    ).toBe(true);

    const v1Rule = {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Carrefour',
      priority: 100,
      bank_filter: null,
      account_id_filter: null,
      account_type_filter: null,
      match_mode: 'contains',
      pattern: 'CARREFOUR',
      target_category: 'Courses & Supermarché',
      mark_as_internal_transfer: false,
      is_active: true,
      revision: 12,
      updated_at: ISO_NOW,
    };
    expect(CategorizationRuleSchema.safeParse(v1Rule).success).toBe(true);
    expect(
      CategorizationRuleSchema.safeParse({
        ...v1Rule,
        target_category_id: 'c1000000-0000-4000-8000-000000000040',
        target_subcategory_id: 'c1000000-0000-4000-8000-000000000041',
      }).success,
    ).toBe(true);

    const deltaBase = {
      since_revision: 0,
      batch_end_revision: 1,
      latest_revision: 1,
      has_more: false,
      full_resync_required: false,
      server_time: ISO_NOW,
      accounts: { upserted: [], deleted_ids: [] },
      transactions: { upserted: [], deleted_ids: [] },
      transaction_notes: { upserted: [], deleted_transaction_ids: [] },
      categorization_rules: { upserted: [], deleted_ids: [] },
      drive_sync_status: { last_run: null, files: [] },
      aggregates_snapshot: null,
    };
    expect(DeltaSyncResponseSchema.safeParse(deltaBase).success).toBe(true);
    expect(
      DeltaSyncResponseSchema.safeParse({
        ...deltaBase,
        categories: {
          upserted: [
            makeCategory({
              id: UNCATEGORIZED_CATEGORY_ID,
              name: 'Non catégorisé',
              slug: 'non-categorise',
              is_system: true,
            }),
          ],
          deleted_ids: [],
        },
      }).success,
    ).toBe(true);
  });
});

describe('DEFAULT_FRENCH_CATEGORY_PACK', () => {
  it('contains the 12 starter root categories, their subcategories, and Non catégorisé fallback', () => {
    const roots = DEFAULT_FRENCH_CATEGORY_PACK.filter((item) => item.parent_id === null);
    const children = DEFAULT_FRENCH_CATEGORY_PACK.filter((item) => item.parent_id !== null);

    expect(roots).toHaveLength(13);
    expect(children.length).toBe(35);
    expect(DEFAULT_FRENCH_CATEGORY_PACK).toHaveLength(48);

    const rootIds = new Set(roots.map((r) => r.id));
    expect(rootIds.has(UNCATEGORIZED_CATEGORY_ID)).toBe(true);
    expect(rootIds.has(TRANSFERS_ROOT_CATEGORY_ID)).toBe(true);

    for (const child of children) {
      expect(child.parent_id).not.toBeNull();
      expect(rootIds.has(child.parent_id!)).toBe(true);
    }
  });

  it('has unique deterministic UUIDs, unique slugs, and valid CategorySchema representation', () => {
    const ids = new Set<string>();
    const slugs = new Set<string>();
    const rootById = new Map(
      DEFAULT_FRENCH_CATEGORY_PACK.filter((c) => c.parent_id === null).map((c) => [c.id, c]),
    );

    for (const item of DEFAULT_FRENCH_CATEGORY_PACK) {
      expect(item.id).toMatch(/^c1000000-0000-4000-8000-[0-9a-f]{12}$/);
      expect(ids.has(item.id)).toBe(false);
      expect(slugs.has(item.slug)).toBe(false);
      ids.add(item.id);
      slugs.add(item.slug);

      const parentSlug = item.parent_id !== null ? rootById.get(item.parent_id)?.slug : undefined;
      expect(item.slug).toBe(slugifyCategoryName(item.name, parentSlug));

      const parsed = CategorySchema.safeParse(item);
      expect(parsed.success).toBe(true);
    }

    expect(
      isProtectedSystemCategory({
        id: UNCATEGORIZED_CATEGORY_ID,
        slug: 'non-categorise',
      }),
    ).toBe(true);
    expect(
      isProtectedSystemCategory({
        id: INTERNAL_TRANSFER_SUBCATEGORY_ID,
        slug: 'transferts-hors-budget-transfert-interne',
      }),
    ).toBe(true);
    expect(
      isProtectedSystemCategory({
        id: 'c1000000-0000-4000-8000-000000000040',
        slug: 'alimentation',
      }),
    ).toBe(false);
  });
});

describe('Pure category helpers', () => {
  it('slugifyCategoryName normalizes accents, symbols, parent prefixes, and 80-char bounds', () => {
    expect(slugifyCategoryName('Énergie (Électricité / Gaz)', 'logement')).toBe(
      'logement-energie-electricite-gaz',
    );
    expect(slugifyCategoryName('  Non   catégorisé  ')).toBe('non-categorise');
    expect(slugifyCategoryName('€€€')).toBe('categorie');
    expect(slugifyCategoryName('Café', '   ')).toBe('cafe');

    const longSlug = slugifyCategoryName(
      'Une très longue sous catégorie avec beaucoup de mots pour dépasser quatre vingt caractères',
      'categorie-parente-tres-longue',
    );
    expect(longSlug.length).toBeLessThanOrEqual(80);
    expect(longSlug.endsWith('-')).toBe(false);
    expect(() => slugifyCategoryName('   ')).toThrow();
  });

  it('validateCategoryParentDepth allows root & depth-2 while rejecting depth-3', () => {
    expect(validateCategoryParentDepth(null)).toEqual({ ok: true });
    expect(validateCategoryParentDepth(undefined)).toEqual({ ok: true });
    expect(validateCategoryParentDepth({ parent_id: null })).toEqual({ ok: true });

    const depth3 = validateCategoryParentDepth({
      parent_id: parseCategoryId('c1000000-0000-4000-8000-000000000040'),
    });
    expect(depth3.ok).toBe(false);
    if (!depth3.ok) {
      expect(depth3.code).toBe('CATEGORY_DEPTH_EXCEEDED');
    }
  });

  it('formatCategoryLabel renders root or parent › child cleanly', () => {
    expect(formatCategoryLabel({ name: 'Alimentation' })).toBe('Alimentation');
    expect(formatCategoryLabel({ name: 'Alimentation' }, null)).toBe('Alimentation');
    expect(formatCategoryLabel({ name: 'Courses' }, { name: '  ' })).toBe('Courses');
    expect(formatCategoryLabel({ name: 'Courses' }, { name: 'Alimentation' })).toBe(
      'Alimentation › Courses',
    );
  });

  it('buildCategoryTree sorts roots and children deterministically and strips depth > 2 or orphans', () => {
    const parentB = makeCategory({
      id: 'c1000000-0000-4000-8000-000000000020',
      name: 'Logement',
      sort_order: 20,
    });
    const parentA = makeCategory({
      id: 'c1000000-0000-4000-8000-000000000010',
      name: 'Revenus',
      sort_order: 10,
    });
    const parentSameOrder = makeCategory({
      id: 'c1000000-0000-4000-8000-000000000015',
      name: 'Assurances',
      sort_order: 10,
    });
    const child2 = makeCategory({
      id: 'c1000000-0000-4000-8000-000000000022',
      parent_id: parentB.id,
      name: 'Énergie',
      slug: 'logement-energie',
      sort_order: 22,
    });
    const child1 = makeCategory({
      id: 'c1000000-0000-4000-8000-000000000021',
      parent_id: parentB.id,
      name: 'Loyer',
      slug: 'logement-loyer',
      sort_order: 21,
    });
    const invalidDepth3 = makeCategory({
      id: 'c1000000-0000-4000-8000-000000000099',
      parent_id: child1.id,
      name: 'Niveau 3 interdit',
      slug: 'niveau-3-interdit',
      sort_order: 1,
    });
    const orphanChild = makeCategory({
      id: 'c1000000-0000-4000-8000-000000000098',
      parent_id: parseCategoryId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      name: 'Orphelin',
      slug: 'orphelin',
      sort_order: 1,
    });

    const tree = buildCategoryTree([
      parentB,
      child2,
      orphanChild,
      invalidDepth3,
      parentA,
      parentSameOrder,
      child1,
    ]);

    expect(tree.map((node) => node.name)).toEqual(['Assurances', 'Revenus', 'Logement']);
    expect(tree[2]?.children.map((c) => c.name)).toEqual(['Loyer', 'Énergie']);
  });
});
