import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import {
  DEFAULT_FRENCH_CATEGORY_PACK,
  assertNever,
  isAllowedDriveFolderId,
  isProtectedSystemCategory,
  parseCategoryId,
  parseRuleId,
  slugifyCategoryName,
  toCents,
  toSyncRevision,
  validateCategoryParentDepth,
  type CategoryId,
  type Currency,
  type DeltaSyncResponse,
} from '@clairflux/shared';
import { z } from 'zod';
import {
  AccountsQuerySchema,
  AnalyticsOverviewQuerySchema,
  ApkStatusSchema,
  CategoriesQuerySchema,
  CategoryIdParamSchema,
  CreateCategoryBodySchema,
  CreateRuleBodySchema,
  DeleteBudgetSchema,
  DeleteCategoryBodySchema,
  DeltaSyncQuerySchema,
  EXCLUSIVE_DRIVE_FOLDERS,
  GetBudgetsQuerySchema,
  MergeCategoryBodySchema,
  PatchTransactionBodySchema,
  PostSyncDeltaBodySchema,
  PutBudgetBodySchema,
  ReapplyRulesBodySchema,
  ReorderRulesBodySchema,
  RuleIdParamSchema,
  TransactionIdParamSchema,
  TransactionsQuerySchema,
  UpdateCategoryBodySchema,
  UpdateRuleBodySchema,
  computeAnalyticsOverview,
  computeBudgetAlert,
  errorResponse,
  formatZodIssues,
  parseJsonBody,
  type AccountsFilter,
  type AccountsRepository,
  type AnalyticsOverviewQuery,
  type AnalyticsRepository,
  type ApkArtifactRepository,
  type AppEnv,
  type BudgetsRepository,
  type CategoriesRepository,
  type CategoryView,
  type DeltaMutationRepository,
  type DeltaSyncQuery,
  type DriveSyncService,
  type RulesRepository,
  type SyncDeltaRepository,
  type TransactionPatchInput,
  type TransactionsFilter,
  type TransactionsRepository,
} from './contracts.js';

export interface RouteDependencies {
  readonly accountsRepository: AccountsRepository;
  readonly syncDeltaRepository: SyncDeltaRepository;
  readonly driveSyncService: DriveSyncService;
  readonly transactionsRepository?: TransactionsRepository | undefined;
  readonly rulesRepository?: RulesRepository | undefined;
  readonly categoriesRepository?: CategoriesRepository | undefined;
  readonly budgetsRepository?: BudgetsRepository | undefined;
  readonly analyticsRepository?: AnalyticsRepository | undefined;
  readonly deltaMutationRepository?: DeltaMutationRepository | undefined;
  readonly apk?: ApkArtifactRepository | undefined;
}

export type M2RouteDependencies = RouteDependencies;

const EmptyTriggerBodySchema = z.object({}).strict();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDefaultTransactionsRepository(): TransactionsRepository {
  return {
    async listTransactions() {
      return {
        items: [],
        total_count: 0,
        latest_revision: toSyncRevision(0),
      };
    },
    async patchTransaction() {
      return { ok: false, reason: 'not_found' };
    },
  };
}

function createDefaultRulesRepository(getNow: () => Date): RulesRepository {
  return {
    async listRules() {
      return {
        rules: [],
        latest_revision: toSyncRevision(0),
      };
    },
    async createRule(input) {
      return {
        rule: {
          id: parseRuleId('00000000-0000-4000-8000-000000000001'),
          name: input.name,
          priority: input.priority,
          bank_filter: input.bank_filter,
          account_id_filter: input.account_id_filter,
          account_type_filter: input.account_type_filter,
          match_mode: input.match_mode,
          pattern: input.pattern,
          target_category: input.target_category,
          ...(input.target_category_id !== undefined
            ? { target_category_id: input.target_category_id }
            : {}),
          ...(input.target_subcategory_id !== undefined
            ? { target_subcategory_id: input.target_subcategory_id }
            : {}),
          mark_as_internal_transfer: input.mark_as_internal_transfer,
          is_active: input.is_active,
          matched_transactions_count: 0,
          revision: toSyncRevision(1),
          updated_at: getNow().toISOString(),
        },
        retroactive_stats: { updated_count: 0, skipped_protected_count: 0 },
        latest_revision: toSyncRevision(1),
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
        latest_revision: toSyncRevision(0),
      };
    },
    async reapplyRules() {
      return {
        retroactive_stats: { updated_count: 0, skipped_protected_count: 0 },
        latest_revision: toSyncRevision(0),
      };
    },
  };
}

function createDefaultBudgetsRepository(getNow: () => Date): BudgetsRepository {
  return {
    async listBudgets(query) {
      return {
        month: query.month,
        budgets: [],
        latest_revision: toSyncRevision(0),
      };
    },
    async upsertBudget(input) {
      const alert = computeBudgetAlert(toCents(0), input.monthly_limit_cents);
      return {
        budget: {
          category: input.category,
          monthly_limit_cents: input.monthly_limit_cents,
          currency: input.currency,
          spent_cents: toCents(0),
          remaining_cents: alert.remaining_cents,
          usage_percent: alert.usage_percent,
          alert_status: alert.status,
          revision: toSyncRevision(1),
          updated_at: getNow().toISOString(),
        },
        latest_revision: toSyncRevision(1),
      };
    },
    async deleteBudget() {
      return null;
    },
  };
}

function createDefaultAnalyticsRepository(getNow: () => Date): AnalyticsRepository {
  return {
    async getOverview(query) {
      return computeAnalyticsOverview({
        query,
        accounts: [],
        transactions: [],
        dataRevision: toSyncRevision(0),
        now: getNow(),
      });
    },
  };
}

function createDefaultDeltaMutationRepository(): DeltaMutationRepository {
  return {
    async applyOutboxBatch(mutations) {
      return {
        results: mutations.map((mutation) => ({
          client_mutation_id: mutation.client_mutation_id,
          status: 'rejected' as const,
          reason: 'RESOURCE_NOT_FOUND' as const,
          message: 'Transaction introuvable pour appliquer la mutation hors-ligne.',
        })),
        latest_revision: toSyncRevision(0),
      };
    },
  };
}

function createDefaultApkRepository(): ApkArtifactRepository {
  return {
    async getStatus() {
      return {
        available: false,
        version: '0.0.0',
        sizeBytes: null,
        sha256: null,
        builtAt: null,
      };
    },
    async readBinary() {
      return null;
    },
  };
}

function createDefaultCategoriesRepository(getNow: () => Date): CategoriesRepository {
  let revCounter = 100;
  const store = new Map<CategoryId, CategoryView & { deleted_at: string | null }>();

  for (const cat of DEFAULT_FRENCH_CATEGORY_PACK) {
    store.set(cat.id, {
      ...cat,
      transaction_count: 0,
      deleted_at: null,
    });
  }

  const nextRev = () => {
    revCounter += 1;
    return toSyncRevision(revCounter);
  };

  const toView = (entry: CategoryView & { deleted_at: string | null }): CategoryView => {
    const { deleted_at: _deleted, ...view } = entry;
    return view;
  };

  return {
    async listCategories(options) {
      const includeArchived = options?.include_archived ?? false;
      const items = [...store.values()]
        .filter((item) => item.deleted_at === null && (includeArchived || !item.is_archived))
        .sort((a, b) => (a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.name.localeCompare(b.name, 'fr')))
        .map(toView);
      return {
        categories: items,
        latest_revision: toSyncRevision(revCounter),
      };
    },

    async createCategory(input) {
      const parent = input.parent_id !== null ? store.get(input.parent_id) : undefined;
      if (input.parent_id !== null && (parent === undefined || parent.deleted_at !== null)) {
        return { ok: false, reason: 'parent_not_found', message: 'Catégorie parente introuvable.' };
      }

      const depthValidation = validateCategoryParentDepth(parent ?? null);
      if (!depthValidation.ok) {
        return { ok: false, reason: 'depth_exceeded', message: depthValidation.message };
      }

      const normalizedName = input.name.trim().toLowerCase();
      const slug = slugifyCategoryName(input.name, parent?.slug);
      for (const existing of store.values()) {
        if (existing.deleted_at !== null) continue;
        if (
          (existing.parent_id === input.parent_id &&
            existing.name.trim().toLowerCase() === normalizedName) ||
          existing.slug === slug
        ) {
          return {
            ok: false,
            reason: 'conflict',
            message: 'Une catégorie avec ce nom existe déjà à ce niveau.',
          };
        }
      }

      const rev = nextRev();
      const id = parseCategoryId(randomUUID());
      const created: CategoryView & { deleted_at: string | null } = {
        id,
        parent_id: input.parent_id,
        name: input.name,
        slug,
        budget_group: input.budget_group,
        color_token: input.color_token,
        sort_order: input.sort_order,
        is_system: false,
        is_archived: false,
        transaction_count: 0,
        revision: rev,
        updated_at: getNow().toISOString(),
        deleted_at: null,
      };
      store.set(id, created);
      return {
        ok: true,
        data: {
          category: toView(created),
          latest_revision: rev,
        },
      };
    },

    async updateCategory(id, input) {
      const existing = store.get(id);
      if (existing === undefined || existing.deleted_at !== null) {
        return { ok: false, reason: 'not_found', message: 'Catégorie introuvable.' };
      }

      let nextSlug = existing.slug;
      if (input.name !== undefined && input.name.trim().toLowerCase() !== existing.name.trim().toLowerCase()) {
        const parent = existing.parent_id !== null ? store.get(existing.parent_id) : undefined;
        const candidateSlug = existing.is_system
          ? existing.slug
          : slugifyCategoryName(input.name, parent?.slug);
        const normalized = input.name.trim().toLowerCase();
        for (const other of store.values()) {
          if (other.deleted_at !== null || other.id === id) continue;
          if (
            (other.parent_id === existing.parent_id &&
              other.name.trim().toLowerCase() === normalized) ||
            (!existing.is_system && other.slug === candidateSlug)
          ) {
            return {
              ok: false,
              reason: 'conflict',
              message: 'Une catégorie avec ce nom existe déjà à ce niveau.',
            };
          }
        }
        nextSlug = candidateSlug;
      }

      const rev = nextRev();
      const updated: CategoryView & { deleted_at: string | null } = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        slug: nextSlug,
        ...(input.budget_group !== undefined ? { budget_group: input.budget_group } : {}),
        ...(input.color_token !== undefined ? { color_token: input.color_token } : {}),
        ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}),
        ...(input.is_archived !== undefined ? { is_archived: input.is_archived } : {}),
        revision: rev,
        updated_at: getNow().toISOString(),
      };
      store.set(id, updated);
      return {
        ok: true,
        data: {
          category: toView(updated),
          updated_transactions_count: 0,
          latest_revision: rev,
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
      const source = store.get(id);
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
      const target = store.get(input.target_category_id);
      if (target === undefined || target.deleted_at !== null) {
        return { ok: false, reason: 'target_not_found', message: 'Catégorie cible introuvable.' };
      }

      const activeChildren = [...store.values()].filter(
        (item) => item.deleted_at === null && item.parent_id === id,
      );
      if (activeChildren.length > 0 && target.parent_id !== null) {
        return {
          ok: false,
          reason: 'depth_exceeded',
          message: 'Impossible de rattacher des sous-catégories sous une sous-catégorie.',
        };
      }

      const nowIso = getNow().toISOString();
      for (const child of activeChildren) {
        const childRev = nextRev();
        store.set(child.id, {
          ...child,
          parent_id: target.id,
          slug: slugifyCategoryName(child.name, target.slug),
          revision: childRev,
          updated_at: nowIso,
        });
      }

      const delRev = nextRev();
      store.set(id, { ...source, deleted_at: nowIso, revision: delRev, updated_at: nowIso });
      return {
        ok: true,
        data: {
          merged_from_id: id,
          target_category_id: input.target_category_id,
          reassigned_transactions_count: 0,
          latest_revision: delRev,
        },
      };
    },

    async deleteCategory(id, input) {
      const source = store.get(id);
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
      const hasChildren = [...store.values()].some(
        (item) => item.deleted_at === null && item.parent_id === id,
      );
      if (hasChildren) {
        return {
          ok: false,
          reason: 'has_children_or_system',
          message: 'Impossible de supprimer une catégorie possédant des sous-catégories actives.',
        };
      }
      const reassignTargetId = input?.reassign_to_category_id;
      if (reassignTargetId === id) {
        return {
          ok: false,
          reason: 'reassign_required',
          message: 'La catégorie de réaffectation doit être différente de la catégorie supprimée.',
        };
      }
      if (source.transaction_count > 0 && reassignTargetId === undefined) {
        return {
          ok: false,
          reason: 'reassign_required',
          message: 'Cette catégorie est référencée : fournissez reassign_to_category_id.',
        };
      }
      if (reassignTargetId !== undefined) {
        const target = store.get(reassignTargetId);
        if (target === undefined || target.deleted_at !== null) {
          return {
            ok: false,
            reason: 'target_not_found',
            message: 'Catégorie de réaffectation introuvable.',
          };
        }
      }

      const delRev = nextRev();
      const nowIso = getNow().toISOString();
      store.set(id, { ...source, deleted_at: nowIso, revision: delRev, updated_at: nowIso });
      return {
        ok: true,
        data: {
          deleted_category_id: id,
          reassigned_transactions_count: 0,
          latest_revision: delRev,
        },
      };
    },
  };
}

export function registerDomainRoutes(
  app: Hono<AppEnv>,
  deps: RouteDependencies,
  getNow: () => Date,
): void {
  const transactionsRepo =
    deps.transactionsRepository ?? createDefaultTransactionsRepository();
  const rulesRepo = deps.rulesRepository ?? createDefaultRulesRepository(getNow);
  const categoriesRepo =
    deps.categoriesRepository ?? createDefaultCategoriesRepository(getNow);
  const budgetsRepo = deps.budgetsRepository ?? createDefaultBudgetsRepository(getNow);
  const analyticsRepo =
    deps.analyticsRepository ?? createDefaultAnalyticsRepository(getNow);
  const deltaMutationRepo =
    deps.deltaMutationRepository ?? createDefaultDeltaMutationRepository();
  const apkRepo = deps.apk ?? createDefaultApkRepository();

  // ==========================================================================
  // GET /api/accounts
  // ==========================================================================
  app.get('/api/accounts', async (c) => {
    const rawQuery = {
      bank: c.req.query('bank'),
      currency: c.req.query('currency'),
    };
    const parsedQuery = AccountsQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de filtrage des comptes invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const filter: AccountsFilter = {
      ...(parsedQuery.data.bank !== undefined ? { bank: parsedQuery.data.bank } : {}),
      ...(parsedQuery.data.currency !== undefined
        ? { currency: parsedQuery.data.currency }
        : {}),
    };

    const result = await deps.accountsRepository.listAccounts(filter);
    return c.json(result, 200);
  });

  // ==========================================================================
  // 1. Transactions: GET /api/transactions & PATCH /api/transactions/:id
  // ==========================================================================
  app.get('/api/transactions', async (c) => {
    const rawQuery = {
      bank: c.req.query('bank'),
      account_id: c.req.query('account_id'),
      currency: c.req.query('currency'),
      has_notes: c.req.query('has_notes'),
      search: c.req.query('search'),
      from: c.req.query('from'),
      to: c.req.query('to'),
      limit: c.req.query('limit'),
    };
    const parsedQuery = TransactionsQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de filtrage des transactions invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const filter: TransactionsFilter = {
      ...(parsedQuery.data.bank !== undefined ? { bank: parsedQuery.data.bank } : {}),
      ...(parsedQuery.data.account_id !== undefined
        ? { account_id: parsedQuery.data.account_id }
        : {}),
      ...(parsedQuery.data.currency !== undefined
        ? { currency: parsedQuery.data.currency }
        : {}),
      ...(parsedQuery.data.has_notes !== undefined
        ? { has_notes: parsedQuery.data.has_notes }
        : {}),
      ...(parsedQuery.data.search !== undefined ? { search: parsedQuery.data.search } : {}),
      ...(parsedQuery.data.from !== undefined ? { from: parsedQuery.data.from } : {}),
      ...(parsedQuery.data.to !== undefined ? { to: parsedQuery.data.to } : {}),
      limit: parsedQuery.data.limit ?? 50,
    };

    const result = await transactionsRepo.listTransactions(filter);
    return c.json(result, 200);
  });

  app.patch('/api/transactions/:id', async (c) => {
    const parsedParam = TransactionIdParamSchema.safeParse({ id: c.req.param('id') });
    if (!parsedParam.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Identifiant de transaction invalide.',
        { details: formatZodIssues(parsedParam.error) },
      );
    }

    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = PatchTransactionBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Corps de mise à jour de transaction invalide.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const patchInput: TransactionPatchInput = {
      ...(parsedBody.data.note !== undefined ? { note: parsedBody.data.note } : {}),
      ...(parsedBody.data.category !== undefined ? { category: parsedBody.data.category } : {}),
      ...(parsedBody.data.category_id !== undefined
        ? { category_id: parsedBody.data.category_id }
        : {}),
      ...(parsedBody.data.subcategory_id !== undefined
        ? { subcategory_id: parsedBody.data.subcategory_id }
        : {}),
      ...(parsedBody.data.is_manual_category !== undefined
        ? { is_manual_category: parsedBody.data.is_manual_category }
        : {}),
      ...(parsedBody.data.is_internal_transfer !== undefined
        ? { is_internal_transfer: parsedBody.data.is_internal_transfer }
        : {}),
    };

    const outcome = await transactionsRepo.patchTransaction(parsedParam.data.id, patchInput);
    if (!outcome.ok) {
      return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', 'Transaction introuvable.');
    }

    return c.json(
      {
        transaction: outcome.transaction,
        latest_revision: outcome.latest_revision,
      },
      200,
    );
  });

  // ==========================================================================
  // 2. Categorization Rules: GET/POST/PATCH/DELETE + reorder + reapply
  // ==========================================================================
  app.get('/api/rules', async (c) => {
    const result = await rulesRepo.listRules();
    return c.json(result, 200);
  });

  app.post('/api/rules', async (c) => {
    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = CreateRuleBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de création de règle invalides.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const result = await rulesRepo.createRule(parsedBody.data);
    return c.json(result, 201);
  });

  app.post('/api/rules/reorder', async (c) => {
    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = ReorderRulesBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Corps de réorganisation des règles invalide.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const result = await rulesRepo.reorderRules(parsedBody.data.items);
    return c.json(result, 200);
  });

  app.post('/api/rules/reapply', async (c) => {
    const rawBody = await c.req.text();
    if (rawBody.trim().length > 0) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody);
      } catch {
        return errorResponse(c, 400, 'BAD_REQUEST', 'Corps JSON malformé.');
      }
      const parsedBody = ReapplyRulesBodySchema.safeParse(parsedJson);
      if (!parsedBody.success) {
        return errorResponse(
          c,
          400,
          'BAD_REQUEST',
          'Paramètres de réapplication invalides.',
          { details: formatZodIssues(parsedBody.error) },
        );
      }
    }

    const result = await rulesRepo.reapplyRules();
    return c.json(result, 200);
  });

  app.patch('/api/rules/:id', async (c) => {
    const parsedParam = RuleIdParamSchema.safeParse({ id: c.req.param('id') });
    if (!parsedParam.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Identifiant de règle invalide.',
        { details: formatZodIssues(parsedParam.error) },
      );
    }

    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = UpdateRuleBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Corps de modification de règle invalide.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const outcome = await rulesRepo.updateRule(parsedParam.data.id, parsedBody.data);
    if (!outcome.ok) {
      if (outcome.reason === 'invalid_regex') {
        return errorResponse(
          c,
          400,
          'BAD_REQUEST',
          'Expression régulière invalide ou non bornée (protection anti-ReDoS).',
        );
      }
      return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', 'Règle introuvable.');
    }

    return c.json(outcome.data, 200);
  });

  app.delete('/api/rules/:id', async (c) => {
    const parsedParam = RuleIdParamSchema.safeParse({ id: c.req.param('id') });
    if (!parsedParam.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Identifiant de règle invalide.',
        { details: formatZodIssues(parsedParam.error) },
      );
    }

    const outcome = await rulesRepo.deleteRule(parsedParam.data.id);
    if (!outcome.ok) {
      return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', 'Règle introuvable.');
    }

    return c.json(outcome.data, 200);
  });

  // ==========================================================================
  // 2bis. Categories & Subcategories: GET/POST/PATCH/MERGE/DELETE
  // ==========================================================================
  app.get('/api/categories', async (c) => {
    const parsedQuery = CategoriesQuerySchema.safeParse({
      include_archived: c.req.query('include_archived'),
    });
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de consultation des catégories invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const result = await categoriesRepo.listCategories({
      ...(parsedQuery.data.include_archived !== undefined
        ? { include_archived: parsedQuery.data.include_archived }
        : {}),
    });
    return c.json(result, 200);
  });

  app.post('/api/categories', async (c) => {
    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = CreateCategoryBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de création de catégorie invalides.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const outcome = await categoriesRepo.createCategory(parsedBody.data);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'parent_not_found':
          return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', outcome.message);
        case 'depth_exceeded':
          return errorResponse(c, 422, 'CATEGORY_DEPTH_EXCEEDED', outcome.message);
        case 'conflict':
          return errorResponse(c, 409, 'CATEGORY_CONFLICT', outcome.message);
      }
    }

    return c.json(outcome.data, 201);
  });

  app.patch('/api/categories/:id', async (c) => {
    const parsedParam = CategoryIdParamSchema.safeParse({ id: c.req.param('id') });
    if (!parsedParam.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Identifiant de catégorie invalide.',
        { details: formatZodIssues(parsedParam.error) },
      );
    }

    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = UpdateCategoryBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Corps de mise à jour de catégorie invalide.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const outcome = await categoriesRepo.updateCategory(parsedParam.data.id, parsedBody.data);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
          return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', outcome.message);
        case 'conflict':
          return errorResponse(c, 409, 'CATEGORY_CONFLICT', outcome.message);
      }
    }

    return c.json(outcome.data, 200);
  });

  app.post('/api/categories/:id/merge', async (c) => {
    const parsedParam = CategoryIdParamSchema.safeParse({ id: c.req.param('id') });
    if (!parsedParam.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Identifiant de catégorie source invalide.',
        { details: formatZodIssues(parsedParam.error) },
      );
    }

    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = MergeCategoryBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de fusion de catégorie invalides.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const outcome = await categoriesRepo.mergeCategory(parsedParam.data.id, parsedBody.data);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'source_not_found':
        case 'target_not_found':
          return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', outcome.message);
        case 'same_category':
          return errorResponse(c, 422, 'VALIDATION_ERROR', outcome.message);
        case 'depth_exceeded':
          return errorResponse(c, 422, 'CATEGORY_DEPTH_EXCEEDED', outcome.message);
        case 'protected_or_has_children':
          return errorResponse(c, 409, 'CATEGORY_HAS_CHILDREN_OR_SYSTEM', outcome.message);
      }
    }

    return c.json(outcome.data, 200);
  });

  app.delete('/api/categories/:id', async (c) => {
    const parsedParam = CategoryIdParamSchema.safeParse({ id: c.req.param('id') });
    if (!parsedParam.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Identifiant de catégorie invalide.',
        { details: formatZodIssues(parsedParam.error) },
      );
    }

    const queryReassign = c.req.query('reassign_to_category_id');
    const queryReassignSub = c.req.query('reassign_to_subcategory_id');
    const rawBody = await c.req.text();
    let candidate: Record<string, unknown> = {};

    if (rawBody.trim().length > 0) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody);
      } catch {
        return errorResponse(c, 400, 'BAD_REQUEST', 'Corps JSON malformé.');
      }
      if (!isPlainRecord(parsedJson)) {
        return errorResponse(
          c,
          400,
          'BAD_REQUEST',
          'Corps de suppression de catégorie invalide.',
        );
      }
      candidate = { ...parsedJson };
    }

    if (queryReassign !== undefined && candidate['reassign_to_category_id'] === undefined) {
      candidate['reassign_to_category_id'] = queryReassign;
    }
    if (queryReassignSub !== undefined && candidate['reassign_to_subcategory_id'] === undefined) {
      candidate['reassign_to_subcategory_id'] = queryReassignSub;
    }

    const parsedBody = DeleteCategoryBodySchema.safeParse(candidate);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de suppression de catégorie invalides.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const outcome = await categoriesRepo.deleteCategory(parsedParam.data.id, parsedBody.data);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
        case 'target_not_found':
          return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', outcome.message);
        case 'reassign_required':
          return errorResponse(c, 422, 'CATEGORY_REASSIGN_REQUIRED', outcome.message);
        case 'has_children_or_system':
          return errorResponse(c, 409, 'CATEGORY_HAS_CHILDREN_OR_SYSTEM', outcome.message);
      }
    }

    return c.json(outcome.data, 200);
  });

  // ==========================================================================
  // 3. Budgets: GET /api/budgets, PUT /api/budgets, DELETE /api/budgets
  // ==========================================================================
  app.get('/api/budgets', async (c) => {
    const parsedQuery = GetBudgetsQuerySchema.safeParse({
      month: c.req.query('month'),
      currency: c.req.query('currency'),
    });
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de consultation des budgets invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const targetMonth =
      parsedQuery.data.month ?? getNow().toISOString().slice(0, 7);

    const query: { readonly month: string; readonly currency?: Currency } = {
      month: targetMonth,
      ...(parsedQuery.data.currency !== undefined
        ? { currency: parsedQuery.data.currency }
        : {}),
    };

    const result = await budgetsRepo.listBudgets(query);
    return c.json(result, 200);
  });

  app.put('/api/budgets', async (c) => {
    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = PutBudgetBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Configuration de budget invalide.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const result = await budgetsRepo.upsertBudget(parsedBody.data);
    return c.json(result, 200);
  });

  app.delete('/api/budgets', async (c) => {
    const queryCategory = c.req.query('category');
    let candidate: unknown;

    if (queryCategory !== undefined) {
      candidate = { category: queryCategory };
    } else {
      const jsonBody = await parseJsonBody(c);
      if (!jsonBody.ok) {
        return jsonBody.response;
      }
      candidate = jsonBody.data;
    }

    const parsed = DeleteBudgetSchema.safeParse(candidate);
    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Catégorie de budget à supprimer invalide.',
        { details: formatZodIssues(parsed.error) },
      );
    }

    const deleted = await budgetsRepo.deleteBudget(parsed.data.category);
    if (deleted === null) {
      return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', 'Budget introuvable pour cette catégorie.');
    }

    return c.json(deleted, 200);
  });

  app.delete('/api/budgets/:category', async (c) => {
    const parsed = DeleteBudgetSchema.safeParse({ category: c.req.param('category') });
    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Catégorie de budget à supprimer invalide.',
        { details: formatZodIssues(parsed.error) },
      );
    }

    const deleted = await budgetsRepo.deleteBudget(parsed.data.category);
    if (deleted === null) {
      return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', 'Budget introuvable pour cette catégorie.');
    }

    return c.json(deleted, 200);
  });

  // ==========================================================================
  // 4. Analytics Overview: GET /api/analytics/overview
  // ==========================================================================
  app.get('/api/analytics/overview', async (c) => {
    const parsedQuery = AnalyticsOverviewQuerySchema.safeParse({
      scope: c.req.query('scope'),
      currency_mode: c.req.query('currency_mode'),
      expense_comparison: c.req.query('expense_comparison'),
      reference_month: c.req.query('reference_month'),
    });
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres analytiques invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const query: AnalyticsOverviewQuery = {
      scope: parsedQuery.data.scope,
      currency_mode: parsedQuery.data.currency_mode,
      expense_comparison: parsedQuery.data.expense_comparison,
      reference_month:
        parsedQuery.data.reference_month ?? getNow().toISOString().slice(0, 7),
    };

    const overview = await analyticsRepo.getOverview(query);
    return c.json(overview, 200);
  });

  // ==========================================================================
  // 5. Delta Sync: GET /api/sync/delta & POST /api/sync/delta
  // ==========================================================================
  app.get('/api/sync/delta', async (c) => {
    const rawQuery = {
      since: c.req.query('since'),
      since_timestamp: c.req.query('since_timestamp'),
      limit: c.req.query('limit'),
    };
    const parsedQuery = DeltaSyncQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de synchronisation delta invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const deltaQuery: DeltaSyncQuery = {
      since: parsedQuery.data.since,
      limit: parsedQuery.data.limit ?? 500,
      ...(parsedQuery.data.since_timestamp !== undefined
        ? { since_timestamp: parsedQuery.data.since_timestamp }
        : {}),
    };

    const delta: DeltaSyncResponse = await deps.syncDeltaRepository.getDelta(deltaQuery);
    return c.json(delta, 200);
  });

  app.post('/api/sync/delta', async (c) => {
    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = PostSyncDeltaBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Lot de mutations Outbox invalide.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const result = await deltaMutationRepo.applyOutboxBatch(parsedBody.data.mutations);
    return c.json(result, 200);
  });

  // ==========================================================================
  // 6. Drive Manual Trigger: POST /api/sync/drive
  // ==========================================================================
  app.post('/api/sync/drive', async (c) => {
    const rawBody = await c.req.text();
    if (rawBody.trim().length > 0) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody);
      } catch {
        return errorResponse(c, 400, 'BAD_REQUEST', 'Corps JSON malformé.');
      }

      if (isPlainRecord(parsedJson)) {
        const candidateFolderId =
          typeof parsedJson['folder_id'] === 'string'
            ? parsedJson['folder_id']
            : typeof parsedJson['drive_folder_id'] === 'string'
              ? parsedJson['drive_folder_id']
              : undefined;

        if (candidateFolderId !== undefined && !isAllowedDriveFolderId(candidateFolderId)) {
          return errorResponse(
            c,
            403,
            'INVALID_DRIVE_FOLDER_SCOPE',
            'Périmètre Google Drive interdit : seuls les 2 dossiers configurés sont autorisés.',
            { details: { folder_id: candidateFolderId } },
          );
        }
      }

      const validatedBody = EmptyTriggerBodySchema.safeParse(parsedJson);
      if (!validatedBody.success) {
        return errorResponse(
          c,
          422,
          'VALIDATION_ERROR',
          'Le déclenchement manuel Drive n’accepte aucun paramètre arbitraire.',
          { details: formatZodIssues(validatedBody.error) },
        );
      }
    }

    const syncResult = await deps.driveSyncService.triggerManualSync();

    if (syncResult.ok) {
      return c.json(
        {
          run: {
            ...syncResult.run,
            allowed_folders: EXCLUSIVE_DRIVE_FOLDERS,
          },
        },
        202,
      );
    }

    switch (syncResult.reason) {
      case 'already_running':
        return errorResponse(
          c,
          409,
          'SYNC_ALREADY_RUNNING',
          'Une synchronisation Google Drive est déjà en cours.',
          {
            retryable: true,
            details: { active_run_id: syncResult.activeRunId },
          },
        );
      case 'upstream_error':
        return errorResponse(
          c,
          502,
          'UPSTREAM_DRIVE_ERROR',
          syncResult.message,
          { retryable: true },
        );
      default:
        return assertNever(syncResult);
    }
  });

  // ==========================================================================
  // 7. Android APK Status & Download: GET /api/apk/status, GET /api/apk/download
  // ==========================================================================
  app.get('/api/apk/status', async (c) => {
    const status = ApkStatusSchema.parse(await apkRepo.getStatus());
    return c.json(status, 200);
  });

  app.get('/api/apk/download', async (c) => {
    const artifact = await apkRepo.readBinary();
    if (artifact === null) {
      return errorResponse(
        c,
        404,
        'RESOURCE_NOT_FOUND',
        'APK ClairFlux non encore compilé.',
      );
    }

    const safeFilename =
      artifact.filename.replace(/["\\\r\n]/g, '').trim() || 'clairflux-release.apk';

    return c.body(Buffer.from(artifact.bytes), 200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
      'Content-Length': String(artifact.sizeBytes),
      'Cache-Control': 'no-store',
    });
  });
}
