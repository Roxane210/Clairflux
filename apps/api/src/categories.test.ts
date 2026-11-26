import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DRIVE_FOLDERS,
  ApiErrorEnvelopeSchema,
  DEFAULT_FRENCH_CATEGORY_PACK,
  DeltaSyncResponseSchema,
  INTERNAL_TRANSFER_SUBCATEGORY_ID,
  UNCATEGORIZED_CATEGORY_ID,
  isProtectedSystemCategory,
  parseAccountId,
  parseCategoryId,
  parseDriveFileId,
  parseRuleId,
  parseTransactionId,
  slugifyCategoryName,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  validateCategoryParentDepth,
  type AccountId,
  type Category,
  type CategoryId,
  type DeltaSyncResponse,
  type RuleId,
  type SyncRevision,
  type TransactionId,
} from '@clairflux/shared';
import {
  createApp,
  signSessionToken,
  type AppDependencies,
  type CategoriesRepository,
  type CategoryView,
  type RuleView,
  type TransactionDetail,
} from './app.js';

const TEST_SESSION_SECRET = 'clairflux-test-session-secret-minimum-32-chars';
const FIXED_NOW = new Date('2026-11-26T14:00:00.000Z');
const VALID_JTI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ACC_ID = parseAccountId('11111111-1111-4111-8111-111111111111');
const TX_1_ID = parseTransactionId('33333333-3333-4333-8333-333333333331');
const TX_2_ID = parseTransactionId('33333333-3333-4333-8333-333333333332');
const RULE_1_ID = parseRuleId('44444444-4444-4444-8444-444444444441');

const ROOT_ALIM_ID = parseCategoryId('c1000000-0000-4000-8000-000000000040');
const SUB_COURSES_ID = parseCategoryId('c1000000-0000-4000-8000-000000000041');
const SUB_RESTAU_ID = parseCategoryId('c1000000-0000-4000-8000-000000000042');

function createToken(): string {
  const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
  return signSessionToken(
    {
      jti: VALID_JTI,
      client_kind: 'android',
      iat: nowSec - 60,
      exp: nowSec + 3600,
    },
    TEST_SESSION_SECRET,
  );
}

interface StoredCat extends Category {
  deleted_at: string | null;
}

interface StoredTx {
  id: TransactionId;
  account_id: AccountId;
  clean_label: string;
  category: string;
  category_id: CategoryId | null;
  subcategory_id: CategoryId | null;
  revision: SyncRevision;
  updated_at: string;
}

interface StoredRule {
  id: RuleId;
  name: string;
  target_category: string;
  target_category_id: CategoryId | null;
  target_subcategory_id: CategoryId | null;
  revision: SyncRevision;
  updated_at: string;
}

function createCategoriesTestHarness() {
  let rev = 1500;
  const nextRev = (): SyncRevision => {
    rev += 1;
    return toSyncRevision(rev);
  };

  const categoriesMap = new Map<CategoryId, StoredCat>();
  for (const cat of DEFAULT_FRENCH_CATEGORY_PACK) {
    categoriesMap.set(cat.id, { ...cat, revision: toSyncRevision(1), deleted_at: null });
  }

  const txs: StoredTx[] = [
    {
      id: TX_1_ID,
      account_id: ACC_ID,
      clean_label: 'Carrefour City',
      category: 'Courses & Supermarché',
      category_id: ROOT_ALIM_ID,
      subcategory_id: SUB_COURSES_ID,
      revision: toSyncRevision(1490),
      updated_at: FIXED_NOW.toISOString(),
    },
    {
      id: TX_2_ID,
      account_id: ACC_ID,
      clean_label: 'Bistro Paris',
      category: 'Restaurants & Cafés',
      category_id: ROOT_ALIM_ID,
      subcategory_id: SUB_RESTAU_ID,
      revision: toSyncRevision(1491),
      updated_at: FIXED_NOW.toISOString(),
    },
  ];

  const rules: StoredRule[] = [
    {
      id: RULE_1_ID,
      name: 'Règle Carrefour',
      target_category: 'Courses & Supermarché',
      target_category_id: ROOT_ALIM_ID,
      target_subcategory_id: SUB_COURSES_ID,
      revision: toSyncRevision(1492),
      updated_at: FIXED_NOW.toISOString(),
    },
  ];

  const countTxForCategory = (cat: StoredCat): number =>
    txs.filter((t) =>
      cat.parent_id === null ? t.category_id === cat.id : t.subcategory_id === cat.id,
    ).length;

  const toCategoryView = (cat: StoredCat): CategoryView => {
    const { deleted_at: _deleted, ...base } = cat;
    return {
      ...base,
      transaction_count: countTxForCategory(cat),
    };
  };

  const categoriesRepository: CategoriesRepository = {
    async listCategories(options) {
      const includeArchived = options?.include_archived ?? false;
      const items = [...categoriesMap.values()]
        .filter((c) => c.deleted_at === null && (includeArchived || !c.is_archived))
        .sort((a, b) =>
          a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.name.localeCompare(b.name, 'fr'),
        )
        .map(toCategoryView);
      return {
        categories: items,
        latest_revision: toSyncRevision(rev),
      };
    },

    async createCategory(input) {
      const parent = input.parent_id !== null ? categoriesMap.get(input.parent_id) : undefined;
      if (input.parent_id !== null && (parent === undefined || parent.deleted_at !== null)) {
        return { ok: false, reason: 'parent_not_found', message: 'Catégorie parente introuvable.' };
      }

      const depth = validateCategoryParentDepth(parent ?? null);
      if (!depth.ok) {
        return { ok: false, reason: 'depth_exceeded', message: depth.message };
      }

      const slug = slugifyCategoryName(input.name, parent?.slug);
      const lowerName = input.name.trim().toLowerCase();
      for (const other of categoriesMap.values()) {
        if (other.deleted_at !== null) continue;
        if (
          (other.parent_id === input.parent_id && other.name.trim().toLowerCase() === lowerName) ||
          other.slug === slug
        ) {
          return {
            ok: false,
            reason: 'conflict',
            message: 'Une catégorie avec ce nom existe déjà à ce niveau.',
          };
        }
      }

      const newRev = nextRev();
      const id = parseCategoryId(randomUUID());
      const created: StoredCat = {
        id,
        parent_id: input.parent_id,
        name: input.name,
        slug,
        budget_group: input.budget_group,
        color_token: input.color_token,
        sort_order: input.sort_order,
        is_system: false,
        is_archived: false,
        revision: newRev,
        updated_at: FIXED_NOW.toISOString(),
        deleted_at: null,
      };
      categoriesMap.set(id, created);
      return {
        ok: true,
        data: {
          category: toCategoryView(created),
          latest_revision: newRev,
        },
      };
    },

    async updateCategory(id, input) {
      const existing = categoriesMap.get(id);
      if (existing === undefined || existing.deleted_at !== null) {
        return { ok: false, reason: 'not_found', message: 'Catégorie introuvable.' };
      }

      let nextSlug = existing.slug;
      if (input.name !== undefined && input.name.trim().toLowerCase() !== existing.name.trim().toLowerCase()) {
        const parent = existing.parent_id !== null ? categoriesMap.get(existing.parent_id) : undefined;
        nextSlug = existing.is_system
          ? existing.slug
          : slugifyCategoryName(input.name, parent?.slug);
        const lowerName = input.name.trim().toLowerCase();
        for (const other of categoriesMap.values()) {
          if (other.deleted_at !== null || other.id === id) continue;
          if (
            (other.parent_id === existing.parent_id &&
              other.name.trim().toLowerCase() === lowerName) ||
            (!existing.is_system && other.slug === nextSlug)
          ) {
            return {
              ok: false,
              reason: 'conflict',
              message: 'Une catégorie avec ce nom existe déjà à ce niveau.',
            };
          }
        }
      }

      const catRev = nextRev();
      const updated: StoredCat = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        slug: nextSlug,
        ...(input.budget_group !== undefined ? { budget_group: input.budget_group } : {}),
        ...(input.color_token !== undefined ? { color_token: input.color_token } : {}),
        ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}),
        ...(input.is_archived !== undefined ? { is_archived: input.is_archived } : {}),
        revision: catRev,
        updated_at: FIXED_NOW.toISOString(),
      };
      categoriesMap.set(id, updated);

      let updatedTxCount = 0;
      let latestRev = catRev;

      if (input.name !== undefined && updated.name !== existing.name) {
        for (const tx of txs) {
          const matches =
            updated.parent_id === null
              ? tx.category_id === id && tx.subcategory_id === null
              : tx.subcategory_id === id;
          if (matches) {
            latestRev = nextRev();
            tx.category = updated.name;
            tx.revision = latestRev;
            updatedTxCount += 1;
          }
        }
        for (const rule of rules) {
          const matches =
            updated.parent_id === null
              ? rule.target_category_id === id && rule.target_subcategory_id === null
              : rule.target_subcategory_id === id;
          if (matches) {
            latestRev = nextRev();
            rule.target_category = updated.name;
            rule.revision = latestRev;
          }
        }
      }

      return {
        ok: true,
        data: {
          category: toCategoryView(updated),
          updated_transactions_count: updatedTxCount,
          latest_revision: latestRev,
        },
      };
    },

    async mergeCategory(id, input) {
      if (id === input.target_category_id) {
        return {
          ok: false,
          reason: 'same_category',
          message: 'La catégorie cible doit être différente de la catégorie source.',
        };
      }
      const source = categoriesMap.get(id);
      if (source === undefined || source.deleted_at !== null) {
        return { ok: false, reason: 'source_not_found', message: 'Catégorie source introuvable.' };
      }
      if (isProtectedSystemCategory(source)) {
        return {
          ok: false,
          reason: 'protected_or_has_children',
          message: 'Impossible de fusionner une catégorie système protégée.',
        };
      }
      const target = categoriesMap.get(input.target_category_id);
      if (target === undefined || target.deleted_at !== null) {
        return { ok: false, reason: 'target_not_found', message: 'Catégorie cible introuvable.' };
      }

      const targetCatId = target.parent_id !== null ? target.parent_id : target.id;
      const targetSubId = target.parent_id !== null ? target.id : null;
      const targetLabel = target.name;

      const children = [...categoriesMap.values()].filter(
        (c) => c.deleted_at === null && c.parent_id === id,
      );
      if (children.length > 0 && target.parent_id !== null) {
        return {
          ok: false,
          reason: 'depth_exceeded',
          message: 'Impossible de fusionner une catégorie parente avec sous-catégories vers une sous-catégorie.',
        };
      }

      for (const child of children) {
        const childRev = nextRev();
        categoriesMap.set(child.id, {
          ...child,
          parent_id: targetCatId,
          slug: slugifyCategoryName(child.name, target.slug),
          revision: childRev,
        });
        for (const tx of txs) {
          if (tx.subcategory_id === child.id) {
            tx.category_id = targetCatId;
            tx.revision = childRev;
          }
        }
      }

      let reassigned = 0;
      for (const tx of txs) {
        if (tx.category_id === id || tx.subcategory_id === id) {
          tx.category_id = targetCatId;
          tx.subcategory_id = targetSubId;
          tx.category = targetLabel;
          tx.revision = nextRev();
          reassigned += 1;
        }
      }
      for (const rule of rules) {
        if (rule.target_category_id === id || rule.target_subcategory_id === id) {
          rule.target_category_id = targetCatId;
          rule.target_subcategory_id = targetSubId;
          rule.target_category = targetLabel;
          rule.revision = nextRev();
        }
      }

      const delRev = nextRev();
      source.deleted_at = FIXED_NOW.toISOString();
      source.revision = delRev;
      source.updated_at = FIXED_NOW.toISOString();

      return {
        ok: true,
        data: {
          merged_from_id: id,
          target_category_id: input.target_category_id,
          reassigned_transactions_count: reassigned,
          latest_revision: delRev,
        },
      };
    },

    async deleteCategory(id, input) {
      const source = categoriesMap.get(id);
      if (source === undefined || source.deleted_at !== null) {
        return { ok: false, reason: 'not_found', message: 'Catégorie introuvable.' };
      }
      if (isProtectedSystemCategory(source)) {
        return {
          ok: false,
          reason: 'has_children_or_system',
          message: 'Impossible de supprimer une catégorie système protégée.',
        };
      }
      const hasChildren = [...categoriesMap.values()].some(
        (c) => c.deleted_at === null && c.parent_id === id,
      );
      if (hasChildren) {
        return {
          ok: false,
          reason: 'has_children_or_system',
          message: 'Impossible de supprimer une catégorie possédant des sous-catégories actives.',
        };
      }

      const matchingTxs = txs.filter((t) => t.category_id === id || t.subcategory_id === id);
      const matchingRules = rules.filter(
        (r) => r.target_category_id === id || r.target_subcategory_id === id,
      );
      const hasReferences = matchingTxs.length > 0 || matchingRules.length > 0;
      const reassignTargetId = input?.reassign_to_category_id;

      if (reassignTargetId === id) {
        return {
          ok: false,
          reason: 'reassign_required',
          message: 'La catégorie de réaffectation doit être différente.',
        };
      }
      if (hasReferences && reassignTargetId === undefined) {
        return {
          ok: false,
          reason: 'reassign_required',
          message: 'Réaffectation requise avant suppression.',
        };
      }

      let reassigned = 0;
      if (reassignTargetId !== undefined) {
        const target = categoriesMap.get(reassignTargetId);
        if (target === undefined || target.deleted_at !== null) {
          return {
            ok: false,
            reason: 'target_not_found',
            message: 'Catégorie de réaffectation introuvable.',
          };
        }
        const targetCatId = target.parent_id !== null ? target.parent_id : target.id;
        const targetSubId = target.parent_id !== null ? target.id : null;
        for (const tx of matchingTxs) {
          tx.category_id = targetCatId;
          tx.subcategory_id = targetSubId;
          tx.category = target.name;
          tx.revision = nextRev();
          reassigned += 1;
        }
        for (const rule of matchingRules) {
          rule.target_category_id = targetCatId;
          rule.target_subcategory_id = targetSubId;
          rule.target_category = target.name;
          rule.revision = nextRev();
        }
      }

      const delRev = nextRev();
      source.deleted_at = FIXED_NOW.toISOString();
      source.revision = delRev;
      source.updated_at = FIXED_NOW.toISOString();

      return {
        ok: true,
        data: {
          deleted_category_id: id,
          reassigned_transactions_count: reassigned,
          latest_revision: delRev,
        },
      };
    },
  };

  const deps: AppDependencies = {
    sessionSecret: TEST_SESSION_SECRET,
    now: () => FIXED_NOW,
    healthRepository: { async ping() { return true; } },
    accountsRepository: {
      async listAccounts() {
        return { accounts: [], latest_revision: toSyncRevision(rev) };
      },
    },
    categoriesRepository,
    transactionsRepository: {
      async listTransactions() {
        const items: TransactionDetail[] = txs.map((tx) => ({
          id: tx.id,
          account_id: tx.account_id,
          bank: 'boursobank',
          account_type: 'courant',
          account_nickname: 'Perso BoursoBank',
          external_ref_masked: '•••• 4821',
          booking_date: '2026-11-20',
          value_date: '2026-11-20',
          raw_label: tx.clean_label.toUpperCase(),
          clean_label: tx.clean_label,
          amount_cents: toCents(-2500),
          currency: 'EUR',
          fx_rate_micro: toFxRateMicro(1_000_000),
          amount_eur_cents: toCents(-2500),
          category: tx.category,
          category_id: tx.category_id,
          subcategory_id: tx.subcategory_id,
          category_source: 'manual',
          ai_review_status: 'none',
          is_manual_category: true,
          matched_rule_id: null,
          is_internal_transfer: false,
          is_manual_transfer_override: false,
          transfer_group_id: null,
          source_drive_file_id: '88888888-8888-4888-8888-888888888888',
          note: null,
          revision: tx.revision,
          updated_at: tx.updated_at,
        }));
        return { items, total_count: items.length, latest_revision: toSyncRevision(rev) };
      },
      async patchTransaction(id, patch) {
        const found = txs.find((t) => t.id === id);
        if (found === undefined) {
          return { ok: false, reason: 'not_found' };
        }
        if (patch.category !== undefined) {
          found.category = patch.category;
        }
        if (patch.category_id !== undefined) {
          found.category_id = patch.category_id;
        }
        if (patch.subcategory_id !== undefined) {
          found.subcategory_id = patch.subcategory_id;
        }
        found.revision = nextRev();
        return {
          ok: true,
          transaction: {
            id: found.id,
            account_id: found.account_id,
            bank: 'boursobank',
            account_type: 'courant',
            account_nickname: 'Perso BoursoBank',
            external_ref_masked: '•••• 4821',
            booking_date: '2026-11-20',
            value_date: '2026-11-20',
            raw_label: found.clean_label.toUpperCase(),
            clean_label: found.clean_label,
            amount_cents: toCents(-2500),
            currency: 'EUR',
            fx_rate_micro: toFxRateMicro(1_000_000),
            amount_eur_cents: toCents(-2500),
            category: found.category,
            category_id: found.category_id,
            subcategory_id: found.subcategory_id,
            category_source: 'manual',
            ai_review_status: 'none',
            is_manual_category: true,
            matched_rule_id: null,
            is_internal_transfer: false,
            is_manual_transfer_override: false,
            transfer_group_id: null,
            source_drive_file_id: '88888888-8888-4888-8888-888888888888',
            note: null,
            revision: found.revision,
            updated_at: found.updated_at,
          },
          latest_revision: found.revision,
        };
      },
    },
    rulesRepository: {
      async listRules() {
        const mapped: RuleView[] = rules.map((r) => ({
          id: r.id,
          name: r.name,
          priority: 100,
          bank_filter: null,
          account_id_filter: null,
          account_type_filter: null,
          match_mode: 'contains',
          pattern: 'CARREFOUR',
          target_category: r.target_category,
          target_category_id: r.target_category_id,
          target_subcategory_id: r.target_subcategory_id,
          mark_as_internal_transfer: false,
          is_active: true,
          matched_transactions_count: 1,
          revision: r.revision,
          updated_at: r.updated_at,
        }));
        return { rules: mapped, latest_revision: toSyncRevision(rev) };
      },
      async createRule(input) {
        const ruleRev = nextRev();
        const ruleId = parseRuleId(randomUUID());
        const targetLabel = input.target_category;
        const created: StoredRule = {
          id: ruleId,
          name: input.name,
          target_category: targetLabel,
          target_category_id: input.target_category_id ?? null,
          target_subcategory_id: input.target_subcategory_id ?? null,
          revision: ruleRev,
          updated_at: FIXED_NOW.toISOString(),
        };
        rules.push(created);
        return {
          rule: {
            id: ruleId,
            name: input.name,
            priority: input.priority,
            bank_filter: input.bank_filter,
            account_id_filter: input.account_id_filter,
            account_type_filter: input.account_type_filter,
            match_mode: input.match_mode,
            pattern: input.pattern,
            target_category: targetLabel,
            target_category_id: created.target_category_id,
            target_subcategory_id: created.target_subcategory_id,
            mark_as_internal_transfer: input.mark_as_internal_transfer,
            is_active: input.is_active,
            matched_transactions_count: 0,
            revision: ruleRev,
            updated_at: created.updated_at,
          },
          retroactive_stats: { updated_count: 0, skipped_protected_count: 0 },
          latest_revision: ruleRev,
        };
      },
      async updateRule() {
        return { ok: false, reason: 'not_found' };
      },
      async deleteRule() {
        return { ok: false, reason: 'not_found' };
      },
      async reorderRules() {
        return {
          rules: [],
          retroactive_stats: { updated_count: 0, skipped_protected_count: 0 },
          latest_revision: toSyncRevision(rev),
        };
      },
      async reapplyRules() {
        return {
          retroactive_stats: { updated_count: 0, skipped_protected_count: 0 },
          latest_revision: toSyncRevision(rev),
        };
      },
    },
    syncDeltaRepository: {
      async getDelta(query): Promise<DeltaSyncResponse> {
        const upsertedCats: Category[] = [];
        const deletedCatIds: CategoryId[] = [];
        for (const cat of categoriesMap.values()) {
          if (cat.revision <= query.since) continue;
          if (cat.deleted_at !== null) {
            deletedCatIds.push(cat.id);
          } else {
            const { deleted_at: _deleted, ...base } = cat;
            upsertedCats.push(base);
          }
        }
        return {
          since_revision: query.since,
          batch_end_revision: toSyncRevision(rev),
          latest_revision: toSyncRevision(rev),
          has_more: false,
          full_resync_required: false,
          server_time: FIXED_NOW.toISOString(),
          accounts: { upserted: [], deleted_ids: [] },
          transactions: {
            upserted: txs
              .filter((t) => t.revision > query.since)
              .map((t) => ({
                id: t.id,
                account_id: t.account_id,
                bank: 'boursobank',
                account_type: 'courant',
                external_ref_masked: '•••• 4821',
                booking_date: '2026-11-20',
                value_date: '2026-11-20',
                raw_label: t.clean_label.toUpperCase(),
                clean_label: t.clean_label,
                amount_cents: toCents(-2500),
                currency: 'EUR',
                fx_rate_micro: toFxRateMicro(1_000_000),
                amount_eur_cents: toCents(-2500),
                category: t.category,
                category_id: t.category_id,
                subcategory_id: t.subcategory_id,
                category_source: 'manual',
                ai_review_status: 'none',
                is_manual_category: true,
                matched_rule_id: null,
                is_internal_transfer: false,
                is_manual_transfer_override: false,
                transfer_group_id: null,
                source_drive_file_id: '88888888-8888-4888-8888-888888888888',
                revision: t.revision,
                updated_at: t.updated_at,
              })),
            deleted_ids: [],
          },
          transaction_notes: { upserted: [], deleted_transaction_ids: [] },
          categorization_rules: {
            upserted: rules
              .filter((r) => r.revision > query.since)
              .map((r) => ({
                id: r.id,
                name: r.name,
                priority: 100,
                bank_filter: null,
                account_id_filter: null,
                account_type_filter: null,
                match_mode: 'contains',
                pattern: 'CARREFOUR',
                target_category: r.target_category,
                target_category_id: r.target_category_id,
                target_subcategory_id: r.target_subcategory_id,
                mark_as_internal_transfer: false,
                is_active: true,
                revision: r.revision,
                updated_at: r.updated_at,
              })),
            deleted_ids: [],
          },
          categories: {
            upserted: upsertedCats,
            deleted_ids: deletedCatIds,
          },
          drive_sync_status: {
            last_run: null,
            files: [
              {
                drive_file_id: parseDriveFileId('1Bourso_2026_11'),
                drive_folder_id: ALLOWED_DRIVE_FOLDERS.boursobank,
                bank: 'boursobank',
                file_name: 'Bourso_2026_11.pdf',
                status: 'committed',
                attempt_count: 1,
                error_code: null,
                error_message: null,
                revision: toSyncRevision(1495),
                updated_at: FIXED_NOW.toISOString(),
              },
            ],
          },
          aggregates_snapshot: null,
        };
      },
    },
    driveSyncService: {
      async triggerManualSync() {
        return { ok: false, reason: 'upstream_error', message: 'Non utilisé dans ce test' };
      },
    },
  };

  return { app: createApp(deps), txs, rules };
}

describe('ClairFlux API — Lot 1 Catégories & Sous-catégories (/api/categories)', () => {
  it('exige une authentification 401 UNAUTHORIZED sur les 5 endpoints /api/categories', async () => {
    const { app } = createCategoriesTestHarness();
    const endpoints: ReadonlyArray<{ path: string; method?: string }> = [
      { path: '/api/categories' },
      { path: '/api/categories', method: 'POST' },
      { path: `/api/categories/${ROOT_ALIM_ID}`, method: 'PATCH' },
      { path: `/api/categories/${ROOT_ALIM_ID}/merge`, method: 'POST' },
      { path: `/api/categories/${SUB_COURSES_ID}`, method: 'DELETE' },
    ];

    for (const ep of endpoints) {
      const res = await app.request(ep.path, {
        ...(ep.method !== undefined ? { method: ep.method } : {}),
      });
      expect(res.status).toBe(401);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('UNAUTHORIZED');
    }
  });

  it('liste les catégories seedées avec compteurs, crée niveau 1 & 2, rejette profondeur 3 (422) et conflit (409)', async () => {
    const { app } = createCategoriesTestHarness();
    const token = createToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const listRes = await app.request('/api/categories', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      categories: CategoryView[];
      latest_revision: SyncRevision;
    };
    expect(listBody.categories.length).toBe(DEFAULT_FRENCH_CATEGORY_PACK.length);
    const alim = listBody.categories.find((c) => c.id === ROOT_ALIM_ID);
    const courses = listBody.categories.find((c) => c.id === SUB_COURSES_ID);
    expect(alim?.transaction_count).toBe(2);
    expect(courses?.transaction_count).toBe(1);

    // Création niveau 1
    const createRootRes = await app.request('/api/categories', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        parent_id: null,
        name: 'Animaux',
        budget_group: 'variable',
        color_token: 'amber',
        sort_order: 85,
      }),
    });
    expect(createRootRes.status).toBe(201);
    const createdRoot = (await createRootRes.json()) as { category: CategoryView };
    expect(createdRoot.category.slug).toBe('animaux');

    // Création niveau 2
    const createSubRes = await app.request('/api/categories', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        parent_id: createdRoot.category.id,
        name: 'Vétérinaire',
        budget_group: 'variable',
        color_token: 'amber',
        sort_order: 86,
      }),
    });
    expect(createSubRes.status).toBe(201);
    const createdSub = (await createSubRes.json()) as { category: CategoryView };
    expect(createdSub.category.parent_id).toBe(createdRoot.category.id);

    // Profondeur > 2 interdite -> 422 CATEGORY_DEPTH_EXCEEDED
    const depthExceededRes = await app.request('/api/categories', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        parent_id: createdSub.category.id,
        name: 'Vaccins',
        budget_group: 'variable',
      }),
    });
    expect(depthExceededRes.status).toBe(422);
    expect(ApiErrorEnvelopeSchema.parse(await depthExceededRes.json()).error.code).toBe(
      'CATEGORY_DEPTH_EXCEEDED',
    );

    // Conflit doublon -> 409 CATEGORY_CONFLICT
    const conflictRes = await app.request('/api/categories', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        parent_id: createdRoot.category.id,
        name: 'vétérinaire',
        budget_group: 'variable',
      }),
    });
    expect(conflictRes.status).toBe(409);
    expect(ApiErrorEnvelopeSchema.parse(await conflictRes.json()).error.code).toBe(
      'CATEGORY_CONFLICT',
    );
  });

  it('renomme avec dual-write sur transactions et règles, et gère include_archived', async () => {
    const { app, txs, rules } = createCategoriesTestHarness();
    const token = createToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const patchRes = await app.request(`/api/categories/${SUB_COURSES_ID}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Supermarché & Bio' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      category: CategoryView;
      updated_transactions_count: number;
    };
    expect(patchBody.category.name).toBe('Supermarché & Bio');
    expect(patchBody.updated_transactions_count).toBe(1);
    expect(txs.find((t) => t.id === TX_1_ID)?.category).toBe('Supermarché & Bio');
    expect(rules.find((r) => r.id === RULE_1_ID)?.target_category).toBe('Supermarché & Bio');

    // Archivage
    const archiveRes = await app.request(`/api/categories/${SUB_COURSES_ID}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ is_archived: true }),
    });
    expect(archiveRes.status).toBe(200);

    const activeListRes = await app.request('/api/categories', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const activeIds = ((await activeListRes.json()) as { categories: CategoryView[] }).categories.map(
      (c) => c.id,
    );
    expect(activeIds).not.toContain(SUB_COURSES_ID);

    const allListRes = await app.request('/api/categories?include_archived=true', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const allIds = ((await allListRes.json()) as { categories: CategoryView[] }).categories.map(
      (c) => c.id,
    );
    expect(allIds).toContain(SUB_COURSES_ID);
  });

  it('refuse la suppression sans réaffectation (422), protège les systèmes (409), puis supprime avec réaffectation (200) via body et query', async () => {
    const { app, txs, rules } = createCategoriesTestHarness();
    const token = createToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Protégée système -> 409 CATEGORY_HAS_CHILDREN_OR_SYSTEM
    const delProtectedRes = await app.request(`/api/categories/${UNCATEGORIZED_CATEGORY_ID}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ reassign_to_category_id: SUB_RESTAU_ID }),
    });
    expect(delProtectedRes.status).toBe(409);
    expect(ApiErrorEnvelopeSchema.parse(await delProtectedRes.json()).error.code).toBe(
      'CATEGORY_HAS_CHILDREN_OR_SYSTEM',
    );

    const delTransferProtected = await app.request(
      `/api/categories/${INTERNAL_TRANSFER_SUBCATEGORY_ID}`,
      {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ reassign_to_category_id: SUB_RESTAU_ID }),
      },
    );
    expect(delTransferProtected.status).toBe(409);

    // Catégorie parente avec sous-catégories actives -> 409
    const delParentWithKidsRes = await app.request(`/api/categories/${ROOT_ALIM_ID}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delParentWithKidsRes.status).toBe(409);

    // Sous-catégorie référencée sans reassign_to_category_id -> 422 CATEGORY_REASSIGN_REQUIRED
    const delNoReassignRes = await app.request(`/api/categories/${SUB_COURSES_ID}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delNoReassignRes.status).toBe(422);
    expect(ApiErrorEnvelopeSchema.parse(await delNoReassignRes.json()).error.code).toBe(
      'CATEGORY_REASSIGN_REQUIRED',
    );

    // Suppression avec réaffectation via body JSON -> 200
    const delWithBodyRes = await app.request(`/api/categories/${SUB_COURSES_ID}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ reassign_to_category_id: SUB_RESTAU_ID }),
    });
    expect(delWithBodyRes.status).toBe(200);
    const delBodyJson = (await delWithBodyRes.json()) as {
      deleted_category_id: string;
      reassigned_transactions_count: number;
    };
    expect(delBodyJson.deleted_category_id).toBe(SUB_COURSES_ID);
    expect(delBodyJson.reassigned_transactions_count).toBe(1);
    expect(txs.find((t) => t.id === TX_1_ID)?.subcategory_id).toBe(SUB_RESTAU_ID);
    expect(rules.find((r) => r.id === RULE_1_ID)?.target_subcategory_id).toBe(SUB_RESTAU_ID);

    // Suppression avec réaffectation via query param -> 200
    const delWithQueryRes = await app.request(
      `/api/categories/${SUB_RESTAU_ID}?reassign_to_category_id=${UNCATEGORIZED_CATEGORY_ID}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(delWithQueryRes.status).toBe(200);
    const delQueryJson = (await delWithQueryRes.json()) as {
      deleted_category_id: string;
      reassigned_transactions_count: number;
    };
    expect(delQueryJson.deleted_category_id).toBe(SUB_RESTAU_ID);
    expect(delQueryJson.reassigned_transactions_count).toBe(2);
    expect(txs.find((t) => t.id === TX_1_ID)?.category_id).toBe(UNCATEGORIZED_CATEGORY_ID);
    expect(txs.find((t) => t.id === TX_2_ID)?.category_id).toBe(UNCATEGORIZED_CATEGORY_ID);
  });

  it('fusionne une catégorie vers une cible (200) et expose categories + champs v2 dans GET /api/sync/delta', async () => {
    const { app, txs, rules } = createCategoriesTestHarness();
    const token = createToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const mergeRes = await app.request(`/api/categories/${SUB_COURSES_ID}/merge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target_category_id: SUB_RESTAU_ID }),
    });
    expect(mergeRes.status).toBe(200);
    const mergeBody = (await mergeRes.json()) as {
      merged_from_id: string;
      target_category_id: string;
      reassigned_transactions_count: number;
    };
    expect(mergeBody.merged_from_id).toBe(SUB_COURSES_ID);
    expect(mergeBody.target_category_id).toBe(SUB_RESTAU_ID);
    expect(mergeBody.reassigned_transactions_count).toBe(1);
    expect(txs.find((t) => t.id === TX_1_ID)?.subcategory_id).toBe(SUB_RESTAU_ID);
    expect(rules.find((r) => r.id === RULE_1_ID)?.target_subcategory_id).toBe(SUB_RESTAU_ID);

    // Vérifier PATCH /api/transactions/:id avec category_id + subcategory_id et POST /api/rules avec target_category_id
    const txPatchRes = await app.request(`/api/transactions/${TX_2_ID}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        category: 'Restaurants & Cafés',
        category_id: ROOT_ALIM_ID,
        subcategory_id: SUB_RESTAU_ID,
      }),
    });
    expect(txPatchRes.status).toBe(200);

    const ruleCreateRes = await app.request('/api/rules', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Bistro',
        match_mode: 'contains',
        pattern: 'BISTRO',
        target_category: 'Restaurants & Cafés',
        target_category_id: ROOT_ALIM_ID,
        target_subcategory_id: SUB_RESTAU_ID,
      }),
    });
    expect(ruleCreateRes.status).toBe(201);

    // Vérifier GET /api/sync/delta?since=0 inclut categories (upserted + deleted_ids) et champs v2
    const deltaRes = await app.request('/api/sync/delta?since=0&limit=500', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deltaRes.status).toBe(200);
    const deltaBody = DeltaSyncResponseSchema.parse(await deltaRes.json());
    expect(deltaBody.categories).toBeDefined();
    expect(deltaBody.categories?.deleted_ids).toContain(SUB_COURSES_ID);
    expect(deltaBody.categories?.upserted.some((c) => c.id === SUB_RESTAU_ID)).toBe(true);
    expect(deltaBody.transactions.upserted[0]?.category_id).toBe(ROOT_ALIM_ID);
    expect(deltaBody.categorization_rules.upserted[0]?.target_category_id).toBe(ROOT_ALIM_ID);
  });
});
