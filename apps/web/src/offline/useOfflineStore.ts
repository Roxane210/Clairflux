import {
  parseRuleId,
  toSyncRevision,
  type AccountId,
  type Bank,
  type CategorizationRule,
  type RuleId,
  type Transaction,
  type TransactionId,
  type TransactionNote,
} from '@clairflux/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClairFluxDataset } from '../features/dashboard/types';
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
  readonly pendingOutboxCount: number;
  readonly syncMessage: string | null;
  readonly saveQuickNote: (transactionId: TransactionId, content: string) => Promise<void>;
  readonly updateManualCategory: (
    transactionId: TransactionId,
    category: string,
    isInternalTransfer: boolean,
  ) => Promise<void>;
  readonly saveRule: (input: SaveRuleInput) => Promise<void>;
  readonly reorderRule: (ruleId: RuleId, direction: 'up' | 'down') => Promise<void>;
  readonly toggleRule: (ruleId: RuleId) => Promise<void>;
  readonly reapplyRules: () => Promise<void>;
  readonly triggerDriveSync: () => Promise<void>;
  readonly flushNow: () => Promise<void>;
}

export interface OfflineStoreState {
  readonly dataset: ClairFluxDataset;
  readonly isOnline: boolean;
  readonly pendingOutboxCount: number;
  readonly syncMessage: string | null;
}

export interface OfflineControllerOptions {
  readonly store?: OfflineStore | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fetcher?: FetchLike | undefined;
  readonly initialOnline?: boolean | undefined;
  readonly nowProvider?: (() => string) | undefined;
  readonly uuidProvider?: (() => string) | undefined;
  readonly onHaptic?: (() => Promise<void>) | undefined;
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
  saveRule(input: SaveRuleInput): Promise<void>;
  reorderRule(ruleId: RuleId, direction: 'up' | 'down'): Promise<void>;
  toggleRule(ruleId: RuleId): Promise<void>;
  reapplyRules(): Promise<void>;
  triggerDriveSync(): Promise<void>;
  flushNow(): Promise<void>;
}

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
    options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const nowProvider = options.nowProvider ?? defaultNowIso;
  const uuidProvider = options.uuidProvider ?? defaultUuid;

  let state: OfflineStoreState = {
    dataset: initialSeed,
    isOnline: options.initialOnline ?? detectInitialOnlineStatus(),
    pendingOutboxCount: 0,
    syncMessage: null,
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
      emit({
        pendingOutboxCount: flushResult.remainingCount,
        syncMessage: flushResult.message,
      });
      return;
    }

    let nextDataset = state.dataset;
    const syncedTotal = flushResult.appliedCount + flushResult.duplicateCount;
    const pullResult = await pullDelta(apiBaseUrl, state.dataset.revision, fetcher);
    if (pullResult.ok) {
      nextDataset = applyDeltaToDataset(state.dataset, pullResult.data);
      await persistSnapshot(nextDataset);
    } else if (flushResult.latestRevision !== null) {
      nextDataset = {
        ...state.dataset,
        revision: Math.max(state.dataset.revision, flushResult.latestRevision),
        syncedAt: nowProvider(),
      };
      await persistSnapshot(nextDataset);
    }

    const nextMessage =
      flushResult.rejectedCount > 0
        ? `${syncedTotal} mutation(s) synchronisée(s), ${flushResult.rejectedCount} rejetée(s).`
        : syncedTotal > 0
          ? `Outbox synchronisée (${syncedTotal} modification(s)).`
          : pullResult.ok
            ? `Données à jour (révision #${nextDataset.revision}).`
            : state.syncMessage;

    emit({
      dataset: nextDataset,
      pendingOutboxCount: flushResult.remainingCount,
      syncMessage: nextMessage,
    });
  };

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

      const normalizedBase = apiBaseUrl.trim().replace(/\/+$/, '');
      try {
        const response = await fetcher(`${normalizedBase}/api/sync/drive`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Clairflux-Client': 'web',
          },
          body: '{}',
        });

        if (!response.ok) {
          emit({
            syncMessage: `Synchronisation Drive/Gemini indisponible (HTTP ${response.status}).`,
          });
          return;
        }

        emit({
          syncMessage: 'Synchronisation Drive/Gemini déclenchée sur les 2 dossiers autorisés.',
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Erreur réseau lors du déclenchement Drive.';
        emit({ syncMessage: message });
      }
    },

    flushNow,
  };
}

// ============================================================================
// React Hook (`useOfflineStore`)
// ============================================================================

export function useOfflineStore(initialSeed: ClairFluxDataset): OfflineStoreApi {
  const bridgeRef = useRef<AndroidBridgeHandle | null>(null);
  const controllerRef = useRef<OfflineController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = createOfflineController(initialSeed, {
      onHaptic: async () => {
        await bridgeRef.current?.triggerLightHaptic();
      },
    });
  }

  const controller = controllerRef.current;
  const [state, setState] = useState<OfflineStoreState>(() => controller.getState());

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
  const flushNow = useCallback(() => controller.flushNow(), [controller]);

  return {
    dataset: state.dataset,
    isOnline: state.isOnline,
    pendingOutboxCount: state.pendingOutboxCount,
    syncMessage: state.syncMessage,
    saveQuickNote,
    updateManualCategory,
    saveRule,
    reorderRule,
    toggleRule,
    reapplyRules,
    triggerDriveSync,
    flushNow,
  };
}

export { reapplyRulesOnTransactions };
