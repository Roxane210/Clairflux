import {
  AiCategorizationRunSchema,
  AiReviewItemSchema,
  AiRuleSuggestionSchema,
  ApiErrorEnvelopeSchema,
  CategorySchema,
  parseRuleId,
  toSyncRevision,
  type AccountId,
  type AiCategorizationRun,
  type AiReviewItem,
  type AiRuleSuggestion,
  type Bank,
  type BudgetGroup,
  type CategorizationRule,
  type Category,
  type CategoryId,
  type DriveSyncRunSummary,
  type ResolveAiReviewDecision,
  type RuleId,
  type Transaction,
  type TransactionId,
  type TransactionNote,
} from '@clairflux/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { createAuthAwareFetcher } from '../features/auth/authClient';
import type { ClairFluxDataset } from '../features/dashboard/types';
import { buildApiEndpointUrl } from './apiUrl';
import {
  applyDeltaToDataset,
  canTriggerDriveSync,
  flushOutbox,
  pullDelta,
  reapplyRulesOnTransactions,
  setupAndroidBridge,
  type AndroidBridgeHandle,
  type FetchLike,
} from './deltaSyncEngine';
import {
  createOfflineStore,
  type OfflineStore,
  type OutboxMutation,
} from './indexedDbStore';

// ============================================================================
// Public Types (Contract with main.tsx, TransactionsSection & BottomSheetNoteDialog)
// ============================================================================

export const CATEGORY_OFFLINE_MESSAGE =
  'Gestion des catégories indisponible hors-ligne — connexion requise.' as const;

export const AI_OFFLINE_MESSAGE =
  'Catégorisation IA Gemini indisponible hors-ligne — connexion requise.' as const;

export interface AiBackfillStatusSummary {
  readonly run: AiCategorizationRun | null;
  readonly pending_review_count: number;
  readonly uncategorized_eligible_count: number;
}

export type AiActionResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

export interface CreateCategoryInput {
  readonly parent_id: CategoryId | null;
  readonly name: string;
  readonly budget_group: BudgetGroup;
  readonly color_token?: string | undefined;
  readonly sort_order?: number | undefined;
}

export interface UpdateCategoryInput {
  readonly id: CategoryId;
  readonly name?: string | undefined;
  readonly budget_group?: BudgetGroup | undefined;
  readonly color_token?: string | undefined;
  readonly sort_order?: number | undefined;
  readonly is_archived?: boolean | undefined;
}

export interface MergeCategoryInput {
  readonly sourceCategoryId: CategoryId;
  readonly target_category_id: CategoryId;
  readonly target_subcategory_id?: CategoryId | null | undefined;
}

export interface DeleteCategoryInput {
  readonly id: CategoryId;
  readonly reassign_to_category_id: CategoryId;
  readonly reassign_to_subcategory_id?: CategoryId | null | undefined;
}

export type CategoryActionResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

export interface SaveRuleInput {
  readonly id?: RuleId | undefined;
  readonly name: string;
  readonly pattern: string;
  readonly targetCategory: string;
  readonly bankFilter: Bank | null;
  readonly accountIdFilter: AccountId | null;
}

export interface OfflineStoreApi {
  readonly dataset: ClairFluxDataset;
  readonly isOnline: boolean;
  readonly isSyncingDrive: boolean;
  readonly pendingOutboxCount: number;
  readonly syncMessage: string | null;
  readonly aiBackfillStatus: AiBackfillStatusSummary | null;
  readonly aiReviewItems: readonly AiReviewItem[];
  readonly aiRuleSuggestions: readonly AiRuleSuggestion[];
  readonly isAiLoading: boolean;
  readonly saveQuickNote: (transactionId: TransactionId, content: string) => Promise<void>;
  readonly updateManualCategory: (
    transactionId: TransactionId,
    category: string,
    isInternalTransfer: boolean,
  ) => Promise<void>;
  readonly createCategory: (input: CreateCategoryInput) => Promise<CategoryActionResult>;
  readonly updateCategory: (input: UpdateCategoryInput) => Promise<CategoryActionResult>;
  readonly mergeCategory: (input: MergeCategoryInput) => Promise<CategoryActionResult>;
  readonly deleteCategory: (input: DeleteCategoryInput) => Promise<CategoryActionResult>;
  readonly saveRule: (input: SaveRuleInput) => Promise<void>;
  readonly reorderRule: (ruleId: RuleId, direction: 'up' | 'down') => Promise<void>;
  readonly toggleRule: (ruleId: RuleId) => Promise<void>;
  readonly reapplyRules: () => Promise<void>;
  readonly triggerDriveSync: () => Promise<void>;
  readonly refreshAiStatus: () => Promise<AiBackfillStatusSummary | null>;
  readonly triggerAiBackfill: () => Promise<AiActionResult>;
  readonly cancelAiBackfill: () => Promise<AiActionResult>;
  readonly fetchAiReviewQueue: () => Promise<readonly AiReviewItem[]>;
  readonly resolveAiReviewDecisions: (
    decisions: readonly ResolveAiReviewDecision[],
  ) => Promise<AiActionResult>;
  readonly acceptAiRuleSuggestion: (id: string) => Promise<AiActionResult>;
  readonly dismissAiRuleSuggestion: (id: string) => Promise<AiActionResult>;
  readonly syncFromServer: () => Promise<void>;
  readonly flushNow: () => Promise<void>;
}

export interface OfflineStoreState {
  readonly dataset: ClairFluxDataset;
  readonly isOnline: boolean;
  readonly isSyncingDrive: boolean;
  readonly pendingOutboxCount: number;
  readonly syncMessage: string | null;
  readonly aiBackfillStatus: AiBackfillStatusSummary | null;
  readonly aiReviewItems: readonly AiReviewItem[];
  readonly aiRuleSuggestions: readonly AiRuleSuggestion[];
  readonly isAiLoading: boolean;
}

export interface OfflineControllerOptions {
  readonly store?: OfflineStore | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fetcher?: FetchLike | undefined;
  readonly initialOnline?: boolean | undefined;
  readonly nowProvider?: (() => string) | undefined;
  readonly uuidProvider?: (() => string) | undefined;
  readonly onHaptic?: (() => Promise<void>) | undefined;
  readonly onUnauthorized?: (() => void) | undefined;
}

export interface OfflineController {
  getState(): OfflineStoreState;
  subscribe(listener: (state: OfflineStoreState) => void): () => void;
  hydrate(): Promise<void>;
  setOnline(isOnline: boolean): Promise<void>;
  saveQuickNote(transactionId: TransactionId, content: string): Promise<void>;
  updateManualCategory(
    transactionId: TransactionId,
    category: string,
    isInternalTransfer: boolean,
  ): Promise<void>;
  createCategory(input: CreateCategoryInput): Promise<CategoryActionResult>;
  updateCategory(input: UpdateCategoryInput): Promise<CategoryActionResult>;
  mergeCategory(input: MergeCategoryInput): Promise<CategoryActionResult>;
  deleteCategory(input: DeleteCategoryInput): Promise<CategoryActionResult>;
  saveRule(input: SaveRuleInput): Promise<void>;
  reorderRule(ruleId: RuleId, direction: 'up' | 'down'): Promise<void>;
  toggleRule(ruleId: RuleId): Promise<void>;
  reapplyRules(): Promise<void>;
  triggerDriveSync(): Promise<void>;
  refreshAiStatus(): Promise<AiBackfillStatusSummary | null>;
  triggerAiBackfill(): Promise<AiActionResult>;
  cancelAiBackfill(): Promise<AiActionResult>;
  fetchAiReviewQueue(): Promise<readonly AiReviewItem[]>;
  resolveAiReviewDecisions(decisions: readonly ResolveAiReviewDecision[]): Promise<AiActionResult>;
  acceptAiRuleSuggestion(id: string): Promise<AiActionResult>;
  dismissAiRuleSuggestion(id: string): Promise<AiActionResult>;
  syncFromServer(): Promise<void>;
  flushNow(): Promise<void>;
}

const AiStatusResponseSchema = z.object({
  run: AiCategorizationRunSchema.nullable(),
  pending_review_count: z.number().int().min(0),
  uncategorized_eligible_count: z.number().int().min(0),
});

const AiReviewQueueResponseSchema = z.object({
  items: z.array(AiReviewItemSchema),
  total_pending: z.number().int().min(0).optional(),
});

const AiRuleSuggestionsResponseSchema = z.object({
  suggestions: z.array(AiRuleSuggestionSchema),
});

// ============================================================================
// Pure Dataset Mutation Helpers
// ============================================================================

function defaultNowIso(): string {
  return new Date().toISOString();
}

function defaultUuid(): string {
  return globalThis.crypto.randomUUID();
}

function detectInitialOnlineStatus(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

function resolveApiBaseUrl(): string {
  if (typeof import.meta !== 'undefined' && 'env' in import.meta) {
    const envObj: unknown = Reflect.get(import.meta, 'env');
    if (typeof envObj === 'object' && envObj !== null) {
      const apiUrl: unknown = Reflect.get(envObj, 'VITE_API_BASE_URL');
      if (typeof apiUrl === 'string' && apiUrl.trim().length > 0) {
        return apiUrl.trim();
      }
    }
  }
  return '';
}

function upsertNoteInList(
  notes: readonly TransactionNote[],
  transactionId: TransactionId,
  content: string,
  revision: number,
  updatedAt: string,
): readonly TransactionNote[] {
  const trimmed = content.trim();
  const remaining = notes.filter((note) => note.transaction_id !== transactionId);
  if (trimmed.length === 0) {
    return remaining;
  }
  const nextNote: TransactionNote = {
    transaction_id: transactionId,
    content: trimmed,
    revision: toSyncRevision(revision),
    updated_at: updatedAt,
  };
  return [nextNote, ...remaining];
}

function renumberRulePriorities(
  rules: readonly CategorizationRule[],
): readonly CategorizationRule[] {
  return rules.map((rule, index) => ({
    ...rule,
    priority: Math.min(10000, (index + 1) * 10),
  }));
}

// ============================================================================
// Framework-Agnostic Offline Controller (Testability + React Hook Backing)
// ============================================================================

export function createOfflineController(
  initialSeed: ClairFluxDataset,
  options: OfflineControllerOptions = {},
): OfflineController {
  const store = options.store ?? createOfflineStore();
  const apiBaseUrl = options.apiBaseUrl ?? resolveApiBaseUrl();
  const fetcher: FetchLike =
    options.fetcher ?? createAuthAwareFetcher((input, init) => globalThis.fetch(input, init));
  const nowProvider = options.nowProvider ?? defaultNowIso;
  const uuidProvider = options.uuidProvider ?? defaultUuid;

  let state: OfflineStoreState = {
    dataset: initialSeed,
    isOnline: options.initialOnline ?? detectInitialOnlineStatus(),
    isSyncingDrive: false,
    pendingOutboxCount: 0,
    syncMessage: null,
    aiBackfillStatus: null,
    aiReviewItems: [],
    aiRuleSuggestions: initialSeed.ai_rule_suggestions ?? [],
    isAiLoading: false,
  };

  const listeners = new Set<(next: OfflineStoreState) => void>();

  const emit = (patch: Partial<OfflineStoreState>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
  };

  const persistSnapshot = async (dataset: ClairFluxDataset): Promise<void> => {
    try {
      await store.saveSnapshot(dataset);
    } catch {
      // Keep optimistic state if storage quota is temporarily unavailable
    }
  };

  type PullCompleteResult =
    | {
        readonly ok: true;
        readonly dataset: ClairFluxDataset;
        readonly lastRun: DriveSyncRunSummary | null;
      }
    | {
        readonly ok: false;
        readonly message: string;
        readonly unauthorized: boolean;
      };

  const pullCompleteDelta = async (baseDataset: ClairFluxDataset): Promise<PullCompleteResult> => {
    let workingDataset = baseDataset;
    let cursor = baseDataset.revision;
    let lastRun: DriveSyncRunSummary | null = null;
    const maxPages = 20;

    for (let page = 0; page < maxPages; page += 1) {
      const pullResult = await pullDelta(apiBaseUrl, cursor, fetcher);
      if (!pullResult.ok) {
        return {
          ok: false,
          message: pullResult.message,
          unauthorized: pullResult.status === 401,
        };
      }

      const delta = pullResult.data;
      if (page === 0 && cursor > delta.latest_revision && !delta.full_resync_required) {
        const resyncResult = await pullDelta(apiBaseUrl, 0, fetcher);
        if (!resyncResult.ok) {
          return {
            ok: false,
            message: resyncResult.message,
            unauthorized: resyncResult.status === 401,
          };
        }
        lastRun = resyncResult.data.drive_sync_status.last_run;
        workingDataset = applyDeltaToDataset(workingDataset, {
          ...resyncResult.data,
          full_resync_required: true,
        });
        if (!resyncResult.data.has_more) {
          return { ok: true, dataset: workingDataset, lastRun };
        }
        cursor = resyncResult.data.batch_end_revision;
        continue;
      }

      lastRun = delta.drive_sync_status.last_run;
      workingDataset = applyDeltaToDataset(workingDataset, delta);
      if (!delta.has_more || (delta.batch_end_revision <= cursor && !delta.full_resync_required)) {
        return { ok: true, dataset: workingDataset, lastRun };
      }
      cursor = delta.batch_end_revision;
    }

    return { ok: true, dataset: workingDataset, lastRun };
  };

  const flushNow = async (): Promise<void> => {
    if (!state.isOnline) {
      const pending = await store.listOutbox();
      emit({
        pendingOutboxCount: pending.length,
        syncMessage: 'Synchronisation impossible hors-ligne.',
      });
      return;
    }

    const flushResult = await flushOutbox(store, apiBaseUrl, fetcher);
    if (!flushResult.ok) {
      if (flushResult.status === 401) {
        options.onUnauthorized?.();
      }
      emit({
        pendingOutboxCount: flushResult.remainingCount,
        syncMessage: flushResult.message,
      });
      return;
    }

    let nextDataset = state.dataset;
    const syncedTotal = flushResult.appliedCount + flushResult.duplicateCount;
    const pullOutcome = await pullCompleteDelta(state.dataset);
    if (pullOutcome.ok) {
      nextDataset = pullOutcome.dataset;
      await persistSnapshot(nextDataset);
    } else {
      if (pullOutcome.unauthorized) {
        options.onUnauthorized?.();
      }
      if (flushResult.latestRevision !== null) {
        nextDataset = {
          ...state.dataset,
          revision: Math.max(state.dataset.revision, flushResult.latestRevision),
          syncedAt: nowProvider(),
        };
        await persistSnapshot(nextDataset);
      }
    }

    const nextMessage =
      flushResult.rejectedCount > 0
        ? `${syncedTotal} mutation(s) synchronisée(s), ${flushResult.rejectedCount} rejetée(s).`
        : syncedTotal > 0
          ? `Outbox synchronisée (${syncedTotal} modification(s)).`
          : pullOutcome.ok
            ? `Données à jour (révision #${nextDataset.revision}).`
            : state.syncMessage;

    emit({
      dataset: nextDataset,
      pendingOutboxCount: flushResult.remainingCount,
      syncMessage: nextMessage,
    });
  };

  const syncFromServer = async (): Promise<void> => {
    if (!state.isOnline) {
      return;
    }

    const pending = await store.listOutbox();
    if (pending.length > 0) {
      await flushNow();
      return;
    }

    const pullOutcome = await pullCompleteDelta(state.dataset);
    if (!pullOutcome.ok) {
      if (pullOutcome.unauthorized) {
        options.onUnauthorized?.();
        return;
      }
      emit({ syncMessage: pullOutcome.message });
      return;
    }

    await persistSnapshot(pullOutcome.dataset);
    const failedRunMessage =
      pullOutcome.lastRun?.status === 'failed' && pullOutcome.lastRun.error_summary
        ? `Échec synchronisation Drive : ${pullOutcome.lastRun.error_summary}`
        : null;
    emit({
      dataset: pullOutcome.dataset,
      ...(pullOutcome.dataset.ai_rule_suggestions !== undefined
        ? { aiRuleSuggestions: pullOutcome.dataset.ai_rule_suggestions }
        : {}),
      syncMessage:
        failedRunMessage ??
        (pullOutcome.dataset.revision > 0
          ? `Données synchronisées (révision #${pullOutcome.dataset.revision}).`
          : null),
    });
  };

    const requestJsonApi = async (
      path: `/api/${string}`,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      bodyPayload: Record<string, unknown> | null,
      fallbackError: string,
      offlineMessage: string,
    ): Promise<
      | { readonly ok: true; readonly json: unknown }
      | { readonly ok: false; readonly message: string }
    > => {
      if (!state.isOnline) {
        emit({ syncMessage: offlineMessage });
        return { ok: false, message: offlineMessage };
      }

      try {
        const response = await fetcher(buildApiEndpointUrl(apiBaseUrl, path), {
          method,
          credentials: 'include',
          headers: {
            ...(bodyPayload !== null ? { 'Content-Type': 'application/json' } : {}),
            Accept: 'application/json',
            'X-Clairflux-Client': 'web',
          },
          ...(bodyPayload !== null ? { body: JSON.stringify(bodyPayload) } : {}),
        });

        if (response.status === 401) {
          options.onUnauthorized?.();
          const msg = 'Session expirée — veuillez vous reconnecter.';
          emit({ syncMessage: msg });
          return { ok: false, message: msg };
        }

        if (!response.ok) {
          let detailed = `${fallbackError} (HTTP ${response.status}).`;
          try {
            const parsedErr = ApiErrorEnvelopeSchema.safeParse(await response.json());
            if (parsedErr.success) {
              detailed = parsedErr.data.error.message;
            }
          } catch {
            // Keep HTTP fallback message
          }
          emit({ syncMessage: detailed });
          return { ok: false, message: detailed };
        }

        let json: unknown = null;
        try {
          json = await response.json();
        } catch {
          // Non-JSON body still succeeds
        }
        return { ok: true, json };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : fallbackError;
        emit({ syncMessage: msg });
        return { ok: false, message: msg };
      }
    };

    const requestCategoryApi = (
      path: `/api/${string}`,
      method: 'POST' | 'PATCH' | 'DELETE',
      bodyPayload: Record<string, unknown>,
      fallbackError: string,
    ): Promise<
      | { readonly ok: true; readonly json: unknown }
      | { readonly ok: false; readonly message: string }
    > => requestJsonApi(path, method, bodyPayload, fallbackError, CATEGORY_OFFLINE_MESSAGE);

    const finalizeCategoryDataset = async (
      optimisticDataset: ClairFluxDataset,
      successMessage: string,
    ): Promise<CategoryActionResult> => {
      await persistSnapshot(optimisticDataset);
      let finalDataset = optimisticDataset;
      const pullOutcome = await pullCompleteDelta(optimisticDataset);
      if (pullOutcome.ok) {
        finalDataset = pullOutcome.dataset;
        await persistSnapshot(finalDataset);
      }
      emit({ dataset: finalDataset, syncMessage: successMessage });
      return { ok: true, message: successMessage };
    };

    async function createCategory(input: CreateCategoryInput): Promise<CategoryActionResult> {
      const apiOutcome = await requestCategoryApi(
        '/api/categories',
        'POST',
        {
          parent_id: input.parent_id,
          name: input.name.trim(),
          budget_group: input.budget_group,
          ...(input.color_token !== undefined ? { color_token: input.color_token } : {}),
          ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}),
        },
        'Impossible de créer la catégorie',
      );
      if (!apiOutcome.ok) {
        return apiOutcome;
      }

      let nextDataset = state.dataset;
      if (
        typeof apiOutcome.json === 'object' &&
        apiOutcome.json !== null &&
        'category' in apiOutcome.json
      ) {
        const parsedCat = CategorySchema.safeParse(Reflect.get(apiOutcome.json, 'category'));
        if (parsedCat.success) {
          const existing = (state.dataset.categories ?? []).filter(
            (cat) => cat.id !== parsedCat.data.id,
          );
          nextDataset = {
            ...state.dataset,
            categories: [...existing, parsedCat.data],
            syncedAt: nowProvider(),
          };
        }
      }
      return finalizeCategoryDataset(nextDataset, `Catégorie « ${input.name.trim()} » créée.`);
    }

    async function updateCategory(input: UpdateCategoryInput): Promise<CategoryActionResult> {
      const apiOutcome = await requestCategoryApi(
        `/api/categories/${encodeURIComponent(input.id)}`,
        'PATCH',
        {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.budget_group !== undefined ? { budget_group: input.budget_group } : {}),
          ...(input.color_token !== undefined ? { color_token: input.color_token } : {}),
          ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}),
          ...(input.is_archived !== undefined ? { is_archived: input.is_archived } : {}),
        },
        'Impossible de modifier la catégorie',
      );
      if (!apiOutcome.ok) {
        return apiOutcome;
      }

      let nextDataset = state.dataset;
      if (
        typeof apiOutcome.json === 'object' &&
        apiOutcome.json !== null &&
        'category' in apiOutcome.json
      ) {
        const parsedCat = CategorySchema.safeParse(Reflect.get(apiOutcome.json, 'category'));
        if (parsedCat.success) {
          const prevCat = (state.dataset.categories ?? []).find(
            (cat) => cat.id === parsedCat.data.id,
          );
          nextDataset = {
            ...state.dataset,
            categories: (state.dataset.categories ?? []).map((cat) =>
              cat.id === parsedCat.data.id ? parsedCat.data : cat,
            ),
            transactions:
              prevCat !== undefined && prevCat.name !== parsedCat.data.name
                ? state.dataset.transactions.map((tx) =>
                    tx.category === prevCat.name ? { ...tx, category: parsedCat.data.name } : tx,
                  )
                : state.dataset.transactions,
            syncedAt: nowProvider(),
          };
        }
      }
      return finalizeCategoryDataset(nextDataset, 'Catégorie mise à jour.');
    }

    async function mergeCategory(input: MergeCategoryInput): Promise<CategoryActionResult> {
      const apiOutcome = await requestCategoryApi(
        `/api/categories/${encodeURIComponent(input.sourceCategoryId)}/merge`,
        'POST',
        {
          target_category_id: input.target_category_id,
          ...(input.target_subcategory_id !== undefined
            ? { target_subcategory_id: input.target_subcategory_id }
            : {}),
        },
        'Impossible de fusionner la catégorie',
      );
      if (!apiOutcome.ok) {
        return apiOutcome;
      }

      const targetCat = (state.dataset.categories ?? []).find(
        (cat) => cat.id === (input.target_subcategory_id ?? input.target_category_id),
      );
      const sourceCat = (state.dataset.categories ?? []).find(
        (cat) => cat.id === input.sourceCategoryId,
      );
      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        categories: (state.dataset.categories ?? []).filter(
          (cat) => cat.id !== input.sourceCategoryId,
        ),
        transactions:
          sourceCat !== undefined && targetCat !== undefined
            ? state.dataset.transactions.map((tx) =>
                tx.category === sourceCat.name ? { ...tx, category: targetCat.name } : tx,
              )
            : state.dataset.transactions,
        syncedAt: nowProvider(),
      };
      return finalizeCategoryDataset(nextDataset, 'Catégorie fusionnée et opérations réaffectées.');
    }

    async function deleteCategory(input: DeleteCategoryInput): Promise<CategoryActionResult> {
      const apiOutcome = await requestCategoryApi(
        `/api/categories/${encodeURIComponent(input.id)}`,
        'DELETE',
        {
          reassign_to_category_id: input.reassign_to_category_id,
          ...(input.reassign_to_subcategory_id !== undefined
            ? { reassign_to_subcategory_id: input.reassign_to_subcategory_id }
            : {}),
        },
        'Impossible de supprimer la catégorie',
      );
      if (!apiOutcome.ok) {
        return apiOutcome;
      }

      const targetCat = (state.dataset.categories ?? []).find(
        (cat) => cat.id === (input.reassign_to_subcategory_id ?? input.reassign_to_category_id),
      );
      const sourceCat = (state.dataset.categories ?? []).find((cat) => cat.id === input.id);
      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        categories: (state.dataset.categories ?? []).filter((cat) => cat.id !== input.id),
        transactions:
          sourceCat !== undefined && targetCat !== undefined
            ? state.dataset.transactions.map((tx) =>
                tx.category === sourceCat.name ? { ...tx, category: targetCat.name } : tx,
              )
            : state.dataset.transactions,
        syncedAt: nowProvider(),
      };
      return finalizeCategoryDataset(nextDataset, 'Catégorie supprimée et opérations réaffectées.');
    }

    async function refreshAiStatus(): Promise<AiBackfillStatusSummary | null> {
      if (!state.isOnline) {
        return null;
      }
      const outcome = await requestJsonApi(
        '/api/ai/categorize/status',
        'GET',
        null,
        'Impossible de lire le statut IA',
        AI_OFFLINE_MESSAGE,
      );
      if (!outcome.ok) {
        return null;
      }
      const parsed = AiStatusResponseSchema.safeParse(outcome.json);
      if (!parsed.success) {
        return null;
      }
      emit({
        aiBackfillStatus: parsed.data,
        dataset: {
          ...state.dataset,
          pending_ai_review_count: parsed.data.pending_review_count,
        },
      });
      return parsed.data;
    }

    async function triggerAiBackfill(): Promise<AiActionResult> {
      if (!state.isOnline) {
        emit({ syncMessage: AI_OFFLINE_MESSAGE });
        return { ok: false, message: AI_OFFLINE_MESSAGE };
      }
      emit({ isAiLoading: true });
      try {
        const outcome = await requestJsonApi(
          '/api/ai/categorize/backfill',
          'POST',
          {},
          'Impossible de lancer la catégorisation IA',
          AI_OFFLINE_MESSAGE,
        );
        if (!outcome.ok) {
          return outcome;
        }
        await refreshAiStatus();
        const msg = 'Catégorisation IA Gemini lancée en lots de 50 opérations.';
        emit({ syncMessage: msg });
        return { ok: true, message: msg };
      } finally {
        emit({ isAiLoading: false });
      }
    }

    async function cancelAiBackfill(): Promise<AiActionResult> {
      if (!state.isOnline) {
        emit({ syncMessage: AI_OFFLINE_MESSAGE });
        return { ok: false, message: AI_OFFLINE_MESSAGE };
      }
      emit({ isAiLoading: true });
      try {
        const activeRunId = state.aiBackfillStatus?.run?.id;
        const outcome = await requestJsonApi(
          '/api/ai/categorize/cancel',
          'POST',
          activeRunId ? { run_id: activeRunId } : {},
          'Impossible d’annuler la catégorisation IA',
          AI_OFFLINE_MESSAGE,
        );
        if (!outcome.ok) {
          return outcome;
        }
        await refreshAiStatus();
        const msg = 'Annulation de la catégorisation IA demandée.';
        emit({ syncMessage: msg });
        return { ok: true, message: msg };
      } finally {
        emit({ isAiLoading: false });
      }
    }

    async function fetchAiReviewQueue(): Promise<readonly AiReviewItem[]> {
      if (!state.isOnline) {
        return state.aiReviewItems;
      }
      emit({ isAiLoading: true });
      try {
        const [queueOutcome, suggestionsOutcome] = await Promise.all([
          requestJsonApi(
            '/api/ai/review-queue?limit=50&offset=0',
            'GET',
            null,
            'Impossible de charger la boîte de révision IA',
            AI_OFFLINE_MESSAGE,
          ),
          requestJsonApi(
            '/api/ai/rule-suggestions?status=pending',
            'GET',
            null,
            'Impossible de charger les suggestions de règles',
            AI_OFFLINE_MESSAGE,
          ),
        ]);

        let nextItems = state.aiReviewItems;
        let nextPendingCount = state.dataset.pending_ai_review_count ?? 0;
        if (queueOutcome.ok) {
          const parsedQueue = AiReviewQueueResponseSchema.safeParse(queueOutcome.json);
          if (parsedQueue.success) {
            nextItems = parsedQueue.data.items;
            nextPendingCount = parsedQueue.data.total_pending ?? parsedQueue.data.items.length;
          }
        }

        let nextSuggestions = state.aiRuleSuggestions;
        if (suggestionsOutcome.ok) {
          const parsedSuggestions = AiRuleSuggestionsResponseSchema.safeParse(
            suggestionsOutcome.json,
          );
          if (parsedSuggestions.success) {
            nextSuggestions = parsedSuggestions.data.suggestions;
          }
        }

        emit({
          aiReviewItems: nextItems,
          aiRuleSuggestions: nextSuggestions,
          dataset: {
            ...state.dataset,
            ai_rule_suggestions: nextSuggestions,
            pending_ai_review_count: nextPendingCount,
          },
        });
        return nextItems;
      } finally {
        emit({ isAiLoading: false });
      }
    }

    async function resolveAiReviewDecisions(
      decisions: readonly ResolveAiReviewDecision[],
    ): Promise<AiActionResult> {
      if (!state.isOnline) {
        emit({ syncMessage: AI_OFFLINE_MESSAGE });
        return { ok: false, message: AI_OFFLINE_MESSAGE };
      }
      if (decisions.length === 0) {
        return { ok: true, message: 'Aucune décision à enregistrer.' };
      }
      emit({ isAiLoading: true });
      try {
        const outcome = await requestJsonApi(
          '/api/ai/review-queue/resolve',
          'POST',
          { decisions },
          'Impossible de valider la révision IA',
          AI_OFFLINE_MESSAGE,
        );
        if (!outcome.ok) {
          return outcome;
        }
        const resolvedIds = new Set(decisions.map((d) => d.transaction_id));
        const remainingItems = state.aiReviewItems.filter(
          (item) => !resolvedIds.has(item.transaction_id),
        );
        emit({
          aiReviewItems: remainingItems,
          dataset: {
            ...state.dataset,
            pending_ai_review_count: remainingItems.length,
          },
        });
        await syncFromServer();
        await fetchAiReviewQueue();
        await refreshAiStatus();
        const msg = `${decisions.length} opération(s) traitée(s) dans la boîte de révision IA.`;
        emit({ syncMessage: msg });
        return { ok: true, message: msg };
      } finally {
        emit({ isAiLoading: false });
      }
    }

    async function handleRuleSuggestionAction(
      id: string,
      verb: 'accept' | 'dismiss',
      fallbackError: string,
      successMessage: string,
    ): Promise<AiActionResult> {
      if (!state.isOnline) {
        emit({ syncMessage: AI_OFFLINE_MESSAGE });
        return { ok: false, message: AI_OFFLINE_MESSAGE };
      }
      emit({ isAiLoading: true });
      try {
        const outcome = await requestJsonApi(
          `/api/ai/rule-suggestions/${encodeURIComponent(id)}/${verb}`,
          'POST',
          {},
          fallbackError,
          AI_OFFLINE_MESSAGE,
        );
        if (!outcome.ok) {
          return outcome;
        }
        const nextSuggestions = state.aiRuleSuggestions.filter((sug) => sug.id !== id);
        emit({
          aiRuleSuggestions: nextSuggestions,
          dataset: {
            ...state.dataset,
            ai_rule_suggestions: nextSuggestions,
          },
        });
        await syncFromServer();
        await refreshAiStatus();
        emit({ syncMessage: successMessage });
        return { ok: true, message: successMessage };
      } finally {
        emit({ isAiLoading: false });
      }
    }

    const acceptAiRuleSuggestion = (id: string): Promise<AiActionResult> =>
      handleRuleSuggestionAction(
        id,
        'accept',
        'Impossible d’accepter la suggestion de règle',
        'Règle automatique créée et appliquée aux opérations éligibles.',
      );

    const dismissAiRuleSuggestion = (id: string): Promise<AiActionResult> =>
      handleRuleSuggestionAction(
        id,
        'dismiss',
        'Impossible d’ignorer la suggestion de règle',
        'Suggestion de règle ignorée.',
      );

    return {
      getState(): OfflineStoreState {
      return state;
    },

    subscribe(listener: (next: OfflineStoreState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async hydrate(): Promise<void> {
      try {
        const cached = await store.loadSnapshot();
        const outbox = await store.listOutbox();
        if (cached !== null) {
          emit({
            dataset: cached,
            aiRuleSuggestions: cached.ai_rule_suggestions ?? [],
            pendingOutboxCount: outbox.length,
          });
        } else {
          await persistSnapshot(state.dataset);
          emit({ pendingOutboxCount: outbox.length });
        }
        if (state.isOnline && outbox.length > 0) {
          await flushNow();
        }
      } catch {
        // Fallback cleanly to initialSeed in memory
      }
    },

    async setOnline(isOnline: boolean): Promise<void> {
      const wasOffline = !state.isOnline;
      emit({
        isOnline,
        syncMessage: isOnline
          ? wasOffline
            ? 'Connexion rétablie.'
            : state.syncMessage
          : 'Mode hors-ligne actif — consultation locale disponible.',
      });
      if (isOnline && wasOffline) {
        const outbox = await store.listOutbox();
        if (outbox.length > 0) {
          await flushNow();
        }
      }
    },

    async saveQuickNote(transactionId: TransactionId, content: string): Promise<void> {
      const nowIso = nowProvider();
      const nextRevision = state.dataset.revision + 1;
      const nextNotes = upsertNoteInList(
        state.dataset.notes,
        transactionId,
        content,
        nextRevision,
        nowIso,
      );
      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        notes: nextNotes,
        syncedAt: nowIso,
      };

      const mutation: OutboxMutation = {
        client_mutation_id: uuidProvider(),
        kind: 'upsert_note',
        transactionId,
        payload: { content: content.trim() },
        createdAt: nowIso,
        status: 'pending',
      };

      await persistSnapshot(nextDataset);
      await store.enqueueOutbox(mutation);
      const outbox = await store.listOutbox();

      emit({
        dataset: nextDataset,
        pendingOutboxCount: outbox.length,
        syncMessage: state.isOnline
          ? 'Note enregistrée.'
          : 'Note enregistrée localement dans l’outbox — synchro auto au retour réseau.',
      });

      if (options.onHaptic !== undefined) {
        await options.onHaptic();
      }

      if (state.isOnline) {
        await flushNow();
      }
    },

    async updateManualCategory(
      transactionId: TransactionId,
      category: string,
      isInternalTransfer: boolean,
    ): Promise<void> {
      const trimmedCategory = category.trim();
      if (trimmedCategory.length === 0) {
        return;
      }

      const previousTx = state.dataset.transactions.find((tx) => tx.id === transactionId);
      if (previousTx === undefined) {
        return;
      }

      const categoryChanged = previousTx.category !== trimmedCategory;
      const transferOverrideChanged = previousTx.is_internal_transfer !== isInternalTransfer;
      if (!categoryChanged && !transferOverrideChanged) {
        return;
      }

      const nowIso = nowProvider();

      const nextTransactions = state.dataset.transactions.map((tx): Transaction => {
        if (tx.id !== transactionId) {
          return tx;
        }
        return {
          ...tx,
          category: categoryChanged ? trimmedCategory : tx.category,
          is_manual_category: categoryChanged ? true : tx.is_manual_category,
          matched_rule_id: categoryChanged ? null : tx.matched_rule_id,
          is_internal_transfer: isInternalTransfer,
          is_manual_transfer_override: transferOverrideChanged
            ? true
            : tx.is_manual_transfer_override,
          transfer_group_id:
            transferOverrideChanged && !isInternalTransfer ? null : tx.transfer_group_id,
          updated_at: nowIso,
        };
      });

      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        transactions: nextTransactions,
        syncedAt: nowIso,
      };

      const mutation: OutboxMutation = {
        client_mutation_id: uuidProvider(),
        kind: 'update_category',
        transactionId,
        payload: {
          category: trimmedCategory,
          isInternalTransfer,
          categoryChanged,
          transferOverrideChanged,
        },
        createdAt: nowIso,
        status: 'pending',
      };

      await persistSnapshot(nextDataset);
      await store.enqueueOutbox(mutation);
      const outbox = await store.listOutbox();

      const actionMessage = categoryChanged
        ? state.isOnline
          ? `Catégorie manuelle « ${trimmedCategory} » enregistrée.`
          : 'Catégorie manuelle mise en file locale (outbox).'
        : state.isOnline
          ? 'Statut transfert interne mis à jour.'
          : 'Statut transfert interne mis en file locale (outbox).';

      emit({
        dataset: nextDataset,
        pendingOutboxCount: outbox.length,
        syncMessage: actionMessage,
      });

      if (state.isOnline) {
        await flushNow();
      }
    },

    createCategory,
    updateCategory,
    mergeCategory,
    deleteCategory,

    async saveRule(input: SaveRuleInput): Promise<void> {
      const trimmedName = input.name.trim();
      const trimmedPattern = input.pattern.trim();
      const trimmedCategory = input.targetCategory.trim();
      if (
        trimmedName.length === 0 ||
        trimmedPattern.length === 0 ||
        trimmedCategory.length === 0
      ) {
        return;
      }

      const nowIso = nowProvider();
      const nextRevision = toSyncRevision(state.dataset.revision + 1);
      const existingIndex =
        input.id !== undefined
          ? state.dataset.rules.findIndex((rule) => rule.id === input.id)
          : -1;

      let nextRules: CategorizationRule[];
      if (existingIndex >= 0) {
        nextRules = state.dataset.rules.map((rule, index): CategorizationRule => {
          if (index !== existingIndex) {
            return rule;
          }
          return {
            ...rule,
            name: trimmedName,
            pattern: trimmedPattern,
            target_category: trimmedCategory,
            bank_filter: input.bankFilter,
            account_id_filter: input.accountIdFilter,
            mark_as_internal_transfer: trimmedCategory === 'Transfert interne',
            revision: nextRevision,
            updated_at: nowIso,
          };
        });
      } else {
        const maxPriority = state.dataset.rules.reduce(
          (max, rule) => Math.max(max, rule.priority),
          0,
        );
        const createdRule: CategorizationRule = {
          id: input.id ?? parseRuleId(uuidProvider()),
          name: trimmedName,
          priority: Math.min(10000, maxPriority + 10),
          bank_filter: input.bankFilter,
          account_id_filter: input.accountIdFilter,
          account_type_filter: null,
          match_mode: 'contains',
          pattern: trimmedPattern,
          target_category: trimmedCategory,
          mark_as_internal_transfer: trimmedCategory === 'Transfert interne',
          is_active: true,
          revision: nextRevision,
          updated_at: nowIso,
        };
        nextRules = [...state.dataset.rules, createdRule];
      }

      const reapplied = reapplyRulesOnTransactions(state.dataset.transactions, nextRules);
      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        rules: nextRules,
        transactions: reapplied.transactions,
        syncedAt: nowIso,
      };

      await persistSnapshot(nextDataset);
      emit({
        dataset: nextDataset,
        syncMessage: `Règle « ${trimmedName} » enregistrée (${reapplied.updatedCount} opération(s) mise(s) à jour).`,
      });
    },

    async reorderRule(ruleId: RuleId, direction: 'up' | 'down'): Promise<void> {
      const sorted = [...state.dataset.rules].sort((left, right) => left.priority - right.priority);
      const index = sorted.findIndex((rule) => rule.id === ruleId);
      if (index < 0) {
        return;
      }
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      const currentRule = sorted[index];
      const neighborRule = sorted[targetIndex];
      if (currentRule === undefined || neighborRule === undefined) {
        return;
      }

      sorted[index] = neighborRule;
      sorted[targetIndex] = currentRule;

      const renumbered = renumberRulePriorities(sorted);
      const reapplied = reapplyRulesOnTransactions(state.dataset.transactions, renumbered);
      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        rules: renumbered,
        transactions: reapplied.transactions,
        syncedAt: nowProvider(),
      };

      await persistSnapshot(nextDataset);
      emit({
        dataset: nextDataset,
        syncMessage: 'Ordre de priorité des règles mis à jour.',
      });
    },

    async toggleRule(ruleId: RuleId): Promise<void> {
      const nowIso = nowProvider();
      const nextRules = state.dataset.rules.map((rule): CategorizationRule =>
        rule.id === ruleId
          ? {
              ...rule,
              is_active: !rule.is_active,
              updated_at: nowIso,
            }
          : rule,
      );

      const reapplied = reapplyRulesOnTransactions(state.dataset.transactions, nextRules);
      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        rules: nextRules,
        transactions: reapplied.transactions,
        syncedAt: nowIso,
      };

      await persistSnapshot(nextDataset);
      emit({
        dataset: nextDataset,
        syncMessage: 'Statut de la règle mis à jour.',
      });
    },

    async reapplyRules(): Promise<void> {
      const result = reapplyRulesOnTransactions(
        state.dataset.transactions,
        state.dataset.rules,
      );
      const nextDataset: ClairFluxDataset = {
        ...state.dataset,
        transactions: result.transactions,
        syncedAt: nowProvider(),
      };

      await persistSnapshot(nextDataset);
      emit({
        dataset: nextDataset,
        syncMessage: `Règles réappliquées : ${result.updatedCount} mise(s) à jour, ${result.skippedManualCount} protégée(s) (manuel/transfert).`,
      });
    },

    async triggerDriveSync(): Promise<void> {
      const guard = canTriggerDriveSync(state.isOnline);
      if (!guard.allowed) {
        emit({ syncMessage: guard.reason });
        return;
      }
      if (state.isSyncingDrive) {
        return;
      }

      emit({ isSyncingDrive: true });
      try {
        const response = await fetcher(buildApiEndpointUrl(apiBaseUrl, '/api/sync/drive'), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Clairflux-Client': 'web',
          },
          body: '{}',
        });

        if (response.status === 401) {
          options.onUnauthorized?.();
          emit({
            syncMessage: 'Session expirée — veuillez vous reconnecter.',
          });
          return;
        }

        if (!response.ok) {
          let detailedMessage: string | null = null;
          try {
            const rawError: unknown = await response.json();
            const parsedError = ApiErrorEnvelopeSchema.safeParse(rawError);
            if (parsedError.success) {
              detailedMessage = parsedError.data.error.message;
            }
          } catch {
            // Keep generic fallback message if body is not valid JSON
          }
          emit({
            syncMessage:
              detailedMessage !== null
                ? `${detailedMessage} (HTTP ${response.status}).`
                : `Synchronisation Drive/Gemini indisponible (HTTP ${response.status}).`,
          });
          return;
        }

        const pullOutcome = await pullCompleteDelta(state.dataset);
        if (pullOutcome.ok) {
          await persistSnapshot(pullOutcome.dataset);
          const failedSummary =
            pullOutcome.lastRun?.status === 'failed' && pullOutcome.lastRun.error_summary
              ? `Échec synchronisation Drive : ${pullOutcome.lastRun.error_summary}`
              : null;
          emit({
            dataset: pullOutcome.dataset,
            syncMessage:
              failedSummary ??
              'Synchronisation Drive/Gemini déclenchée sur les 2 dossiers autorisés.',
          });
        } else {
          emit({
            syncMessage: 'Synchronisation Drive/Gemini déclenchée sur les 2 dossiers autorisés.',
          });
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Erreur réseau lors du déclenchement Drive.';
        emit({ syncMessage: message });
      } finally {
        emit({ isSyncingDrive: false });
      }
    },

    refreshAiStatus,
    triggerAiBackfill,
    cancelAiBackfill,
    fetchAiReviewQueue,
    resolveAiReviewDecisions,
    acceptAiRuleSuggestion,
    dismissAiRuleSuggestion,
    syncFromServer,
    flushNow,
  };
}

// ============================================================================
// React Hook (`useOfflineStore`)
// ============================================================================

export function useOfflineStore(
  initialSeed: ClairFluxDataset,
  options?: { readonly onUnauthorized?: (() => void) | undefined },
): OfflineStoreApi {
  const bridgeRef = useRef<AndroidBridgeHandle | null>(null);
  const controllerRef = useRef<OfflineController | null>(null);
  const onUnauthorizedRef = useRef(options?.onUnauthorized);
  onUnauthorizedRef.current = options?.onUnauthorized;

  if (controllerRef.current === null) {
    controllerRef.current = createOfflineController(initialSeed, {
      onHaptic: async () => {
        await bridgeRef.current?.triggerLightHaptic();
      },
      onUnauthorized: () => {
        onUnauthorizedRef.current?.();
      },
    });
  }

  const controller = controllerRef.current;
  const [state, setState] = useState<OfflineStoreState>(() => controller.getState());
  const prevRunStatusRef = useRef<AiCategorizationRun['status'] | null>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    const bridge = setupAndroidBridge({
      onOnlineStatusChange: (nextOnline) => {
        void controller.setOnline(nextOnline);
      },
    });
    bridgeRef.current = bridge;
    void controller.hydrate();

    return () => {
      unsubscribe();
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [controller]);

  const currentRunStatus = state.aiBackfillStatus?.run?.status ?? null;

  useEffect(() => {
    const prevStatus = prevRunStatusRef.current;
    prevRunStatusRef.current = currentRunStatus;

    if (
      prevStatus === 'running' &&
      currentRunStatus !== null &&
      currentRunStatus !== 'running' &&
      state.isOnline
    ) {
      void controller.syncFromServer();
      void controller.fetchAiReviewQueue();
    }
  }, [controller, currentRunStatus, state.isOnline]);

  useEffect(() => {
    if (!state.isOnline || currentRunStatus !== 'running') {
      return undefined;
    }
    const timer = setInterval(() => {
      void controller.refreshAiStatus();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [controller, currentRunStatus, state.isOnline]);

  const saveQuickNote = useCallback(
    (transactionId: TransactionId, content: string) =>
      controller.saveQuickNote(transactionId, content),
    [controller],
  );

  const updateManualCategory = useCallback(
    (transactionId: TransactionId, category: string, isInternalTransfer: boolean) =>
      controller.updateManualCategory(transactionId, category, isInternalTransfer),
    [controller],
  );

  const createCategory = useCallback(
    (input: CreateCategoryInput) => controller.createCategory(input),
    [controller],
  );

  const updateCategory = useCallback(
    (input: UpdateCategoryInput) => controller.updateCategory(input),
    [controller],
  );

  const mergeCategory = useCallback(
    (input: MergeCategoryInput) => controller.mergeCategory(input),
    [controller],
  );

  const deleteCategory = useCallback(
    (input: DeleteCategoryInput) => controller.deleteCategory(input),
    [controller],
  );

  const saveRule = useCallback(
    (input: SaveRuleInput) => controller.saveRule(input),
    [controller],
  );

  const reorderRule = useCallback(
    (ruleId: RuleId, direction: 'up' | 'down') => controller.reorderRule(ruleId, direction),
    [controller],
  );

  const toggleRule = useCallback(
    (ruleId: RuleId) => controller.toggleRule(ruleId),
    [controller],
  );

  const reapplyRules = useCallback(() => controller.reapplyRules(), [controller]);
  const triggerDriveSync = useCallback(() => controller.triggerDriveSync(), [controller]);
  const refreshAiStatus = useCallback(() => controller.refreshAiStatus(), [controller]);
  const triggerAiBackfill = useCallback(() => controller.triggerAiBackfill(), [controller]);
  const cancelAiBackfill = useCallback(() => controller.cancelAiBackfill(), [controller]);
  const fetchAiReviewQueue = useCallback(() => controller.fetchAiReviewQueue(), [controller]);
  const resolveAiReviewDecisions = useCallback(
    (decisions: readonly ResolveAiReviewDecision[]) =>
      controller.resolveAiReviewDecisions(decisions),
    [controller],
  );
  const acceptAiRuleSuggestion = useCallback(
    (id: string) => controller.acceptAiRuleSuggestion(id),
    [controller],
  );
  const dismissAiRuleSuggestion = useCallback(
    (id: string) => controller.dismissAiRuleSuggestion(id),
    [controller],
  );
  const syncFromServer = useCallback(() => controller.syncFromServer(), [controller]);
  const flushNow = useCallback(() => controller.flushNow(), [controller]);

  return {
    dataset: state.dataset,
    isOnline: state.isOnline,
    isSyncingDrive: state.isSyncingDrive,
    pendingOutboxCount: state.pendingOutboxCount,
    syncMessage: state.syncMessage,
    aiBackfillStatus: state.aiBackfillStatus,
    aiReviewItems: state.aiReviewItems,
    aiRuleSuggestions: state.aiRuleSuggestions,
    isAiLoading: state.isAiLoading,
    saveQuickNote,
    updateManualCategory,
    createCategory,
    updateCategory,
    mergeCategory,
    deleteCategory,
    saveRule,
    reorderRule,
    toggleRule,
    reapplyRules,
    triggerDriveSync,
    refreshAiStatus,
    triggerAiBackfill,
    cancelAiBackfill,
    fetchAiReviewQueue,
    resolveAiReviewDecisions,
    acceptAiRuleSuggestion,
    dismissAiRuleSuggestion,
    syncFromServer,
    flushNow,
  };
}

export { reapplyRulesOnTransactions };
