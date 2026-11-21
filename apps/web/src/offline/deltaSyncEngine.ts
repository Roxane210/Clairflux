import {
  DeltaSyncResponseSchema,
  SyncRevisionSchema,
  type CategorizationRule,
  type DeltaSyncResponse,
  type Transaction,
} from '@clairflux/shared';
import { z } from 'zod';
import type { ClairFluxDataset } from '../features/dashboard/types';
import type { OfflineStore, OutboxMutation } from './indexedDbStore';

// ============================================================================
// Constants & Shared Types
// ============================================================================

export const DRIVE_SYNC_OFFLINE_MESSAGE =
  'Synchronisation Drive/Gemini indisponible hors-ligne.' as const;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PullDeltaResult =
  | { readonly ok: true; readonly data: DeltaSyncResponse }
  | { readonly ok: false; readonly message: string; readonly status?: number | undefined };

export type FlushOutboxResult =
  | {
      readonly ok: true;
      readonly appliedCount: number;
      readonly duplicateCount: number;
      readonly rejectedCount: number;
      readonly remainingCount: number;
      readonly latestRevision: number | null;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly remainingCount: number;
      readonly status?: number | undefined;
    };

export type DriveSyncGuardResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface AndroidBridgeCallbacks {
  readonly onOnlineStatusChange: (isOnline: boolean) => void;
  readonly onBackButtonWithoutDialog?: (() => void) | undefined;
}

export interface AndroidBridgeHandle {
  readonly triggerLightHaptic: () => Promise<void>;
  readonly dispose: () => void;
}

// ============================================================================
// Zod Schemas for POST /api/sync/delta Acknowledgement
// ============================================================================

const OutboxMutationOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    client_mutation_id: z.string().uuid(),
    status: z.literal('applied'),
    revision: SyncRevisionSchema,
  }),
  z.object({
    client_mutation_id: z.string().uuid(),
    status: z.literal('duplicate'),
    revision: SyncRevisionSchema,
  }),
  z.object({
    client_mutation_id: z.string().uuid(),
    status: z.literal('rejected'),
    reason: z.string().optional(),
    message: z.string().optional(),
  }),
]);

const PostSyncDeltaResponseSchema = z.object({
  results: z.array(OutboxMutationOutcomeSchema),
  latest_revision: z.number().int().nonnegative().optional(),
});

// ============================================================================
// Helpers
// ============================================================================

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.trim().replace(/\/+$/, '');
}

function deriveSecondaryMutationUuid(primaryUuid: string): string {
  const lastChar = primaryUuid.at(-1);
  if (lastChar === undefined) {
    return primaryUuid;
  }
  const parsed = Number.parseInt(lastChar, 16);
  const nextHex = Number.isNaN(parsed) ? '0' : ((parsed + 1) % 16).toString(16);
  return `${primaryUuid.slice(0, -1)}${nextHex}`;
}

function toIsoUtcTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

// ============================================================================
// Pull Delta (`GET /api/sync/delta?since=...`)
// ============================================================================

export async function pullDelta(
  apiBaseUrl: string,
  sinceRevision: number,
  fetcher: FetchLike = defaultFetch,
): Promise<PullDeltaResult> {
  const safeSince = Number.isSafeInteger(sinceRevision) && sinceRevision >= 0 ? sinceRevision : 0;
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const url = `${baseUrl}/api/sync/delta?since=${encodeURIComponent(String(safeSince))}`;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Clairflux-Client': 'web',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur réseau lors du pull delta.';
    return { ok: false, message };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `Échec pull delta (HTTP ${response.status}).`,
      status: response.status,
    };
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    return {
      ok: false,
      message: 'Réponse JSON invalide reçue depuis GET /api/sync/delta.',
      status: response.status,
    };
  }

  const parsed = DeltaSyncResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Payload GET /api/sync/delta non conforme au contrat Zod.',
      status: response.status,
    };
  }

  return { ok: true, data: parsed.data };
}

export function applyDeltaToDataset(
  current: ClairFluxDataset,
  delta: DeltaSyncResponse,
): ClairFluxDataset {
  const reset = delta.full_resync_required;

  const accountMap = new Map(
    (reset ? [] : current.accounts).map((acc) => [acc.id, acc] as const),
  );
  for (const deletedId of delta.accounts.deleted_ids) {
    accountMap.delete(deletedId);
  }
  for (const account of delta.accounts.upserted) {
    accountMap.set(account.id, account);
  }

  const txMap = new Map(
    (reset ? [] : current.transactions).map((tx) => [tx.id, tx] as const),
  );
  for (const deletedId of delta.transactions.deleted_ids) {
    txMap.delete(deletedId);
  }
  for (const tx of delta.transactions.upserted) {
    txMap.set(tx.id, tx);
  }

  const noteMap = new Map(
    (reset ? [] : current.notes).map((note) => [note.transaction_id, note] as const),
  );
  for (const deletedTxId of delta.transaction_notes.deleted_transaction_ids) {
    noteMap.delete(deletedTxId);
  }
  for (const note of delta.transaction_notes.upserted) {
    noteMap.set(note.transaction_id, note);
  }

  const ruleMap = new Map(
    (reset ? [] : current.rules).map((rule) => [rule.id, rule] as const),
  );
  for (const deletedId of delta.categorization_rules.deleted_ids) {
    ruleMap.delete(deletedId);
  }
  for (const rule of delta.categorization_rules.upserted) {
    ruleMap.set(rule.id, rule);
  }

  const driveFiles =
    delta.drive_sync_status.files.length > 0 || reset
      ? delta.drive_sync_status.files
      : current.driveFiles;

  const sortedTransactions = [...txMap.values()].sort((left, right) =>
    right.booking_date.localeCompare(left.booking_date),
  );
  const sortedRules = [...ruleMap.values()].sort((left, right) => left.priority - right.priority);

  return {
    accounts: [...accountMap.values()],
    transactions: sortedTransactions,
    notes: [...noteMap.values()],
    rules: sortedRules,
    budgets: current.budgets,
    driveFiles,
    revision: delta.latest_revision,
    syncedAt: delta.server_time,
  };
}

// ============================================================================
// Flush Outbox (`POST /api/sync/delta` with idempotent `client_mutation_id`)
// ============================================================================

interface ApiOutboxMutationWire {
  readonly client_mutation_id: string;
  readonly kind: 'upsert_note' | 'set_category' | 'set_internal_transfer';
  readonly transaction_id: string;
  readonly note?: string | null;
  readonly category?: string;
  readonly is_internal_transfer?: boolean;
  readonly client_updated_at: string;
}

function serializeOutboxBatch(batch: readonly OutboxMutation[]): {
  readonly wireMutations: readonly ApiOutboxMutationWire[];
  readonly wireToParentId: ReadonlyMap<string, string>;
  readonly parentExpectedCount: ReadonlyMap<string, number>;
} {
  const wireMutations: ApiOutboxMutationWire[] = [];
  const wireToParentId = new Map<string, string>();
  const parentExpectedCount = new Map<string, number>();

  for (const item of batch) {
    const timestamp = toIsoUtcTimestamp(item.createdAt);

    if (item.kind === 'upsert_note') {
      const trimmed = item.payload.content.trim();
      wireMutations.push({
        client_mutation_id: item.client_mutation_id,
        kind: 'upsert_note',
        transaction_id: item.transactionId,
        note: trimmed.length > 0 ? trimmed : null,
        client_updated_at: timestamp,
      });
      wireToParentId.set(item.client_mutation_id, item.client_mutation_id);
      parentExpectedCount.set(item.client_mutation_id, 1);
      continue;
    }

    const emitCategory = item.payload.categoryChanged ?? true;
    const emitTransfer = item.payload.transferOverrideChanged ?? false;

    if (emitCategory && emitTransfer) {
      wireMutations.push({
        client_mutation_id: item.client_mutation_id,
        kind: 'set_category',
        transaction_id: item.transactionId,
        category: item.payload.category,
        client_updated_at: timestamp,
      });
      wireToParentId.set(item.client_mutation_id, item.client_mutation_id);

      const secondaryId = deriveSecondaryMutationUuid(item.client_mutation_id);
      wireMutations.push({
        client_mutation_id: secondaryId,
        kind: 'set_internal_transfer',
        transaction_id: item.transactionId,
        is_internal_transfer: item.payload.isInternalTransfer,
        client_updated_at: timestamp,
      });
      wireToParentId.set(secondaryId, item.client_mutation_id);
      parentExpectedCount.set(item.client_mutation_id, 2);
      continue;
    }

    if (emitTransfer && !emitCategory) {
      wireMutations.push({
        client_mutation_id: item.client_mutation_id,
        kind: 'set_internal_transfer',
        transaction_id: item.transactionId,
        is_internal_transfer: item.payload.isInternalTransfer,
        client_updated_at: timestamp,
      });
      wireToParentId.set(item.client_mutation_id, item.client_mutation_id);
      parentExpectedCount.set(item.client_mutation_id, 1);
      continue;
    }

    wireMutations.push({
      client_mutation_id: item.client_mutation_id,
      kind: 'set_category',
      transaction_id: item.transactionId,
      category: item.payload.category,
      client_updated_at: timestamp,
    });
    wireToParentId.set(item.client_mutation_id, item.client_mutation_id);
    parentExpectedCount.set(item.client_mutation_id, 1);
  }

  return { wireMutations, wireToParentId, parentExpectedCount };
}

export async function flushOutbox(
  store: OfflineStore,
  apiBaseUrl: string,
  fetcher: FetchLike = defaultFetch,
): Promise<FlushOutboxResult> {
  const allMutations = await store.listOutbox();
  const batch = allMutations.filter(
    (item) => item.status === 'pending' || item.status === 'failed',
  );

  if (batch.length === 0) {
    return {
      ok: true,
      appliedCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
      remainingCount: allMutations.length,
      latestRevision: null,
    };
  }

  const batchIds = batch.map((item) => item.client_mutation_id);
  await store.updateOutboxStatus(batchIds, 'syncing');

  const { wireMutations, wireToParentId, parentExpectedCount } = serializeOutboxBatch(batch);
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const url = `${baseUrl}/api/sync/delta`;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Clairflux-Client': 'web',
      },
      body: JSON.stringify({ mutations: wireMutations }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur réseau lors du flush outbox.';
    await store.updateOutboxStatus(batchIds, 'pending', message);
    const remaining = await store.listOutbox();
    return {
      ok: false,
      message,
      remainingCount: remaining.length,
    };
  }

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    const message = `Échec synchronisation outbox (HTTP ${response.status}).`;
    await store.updateOutboxStatus(batchIds, retryable ? 'pending' : 'failed', message);
    const remaining = await store.listOutbox();
    return {
      ok: false,
      message,
      remainingCount: remaining.length,
      status: response.status,
    };
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    const message = 'Réponse JSON invalide depuis POST /api/sync/delta.';
    await store.updateOutboxStatus(batchIds, 'pending', message);
    const remaining = await store.listOutbox();
    return {
      ok: false,
      message,
      remainingCount: remaining.length,
      status: response.status,
    };
  }

  const parsed = PostSyncDeltaResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    const message = 'Acquittement POST /api/sync/delta invalide.';
    await store.updateOutboxStatus(batchIds, 'pending', message);
    const remaining = await store.listOutbox();
    return {
      ok: false,
      message,
      remainingCount: remaining.length,
      status: response.status,
    };
  }

  let appliedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;

  const ackedWireByParent = new Map<string, number>();
  const rejectedParents = new Map<string, string>();

  for (const outcome of parsed.data.results) {
    const parentId = wireToParentId.get(outcome.client_mutation_id);
    if (parentId === undefined) {
      continue;
    }
    if (outcome.status === 'applied') {
      appliedCount += 1;
      ackedWireByParent.set(parentId, (ackedWireByParent.get(parentId) ?? 0) + 1);
    } else if (outcome.status === 'duplicate') {
      duplicateCount += 1;
      ackedWireByParent.set(parentId, (ackedWireByParent.get(parentId) ?? 0) + 1);
    } else {
      rejectedCount += 1;
      rejectedParents.set(
        parentId,
        outcome.message ?? outcome.reason ?? 'Mutation rejetée par le serveur.',
      );
    }
  }

  const acknowledgedParentIds: string[] = [];
  const unacknowledgedParentIds: string[] = [];

  for (const parentId of batchIds) {
    const rejectedMessage = rejectedParents.get(parentId);
    if (rejectedMessage !== undefined) {
      await store.updateOutboxStatus([parentId], 'failed', rejectedMessage);
      continue;
    }

    const expected = parentExpectedCount.get(parentId) ?? 1;
    const acked = ackedWireByParent.get(parentId) ?? 0;
    if (acked >= expected) {
      acknowledgedParentIds.push(parentId);
    } else {
      unacknowledgedParentIds.push(parentId);
    }
  }

  if (acknowledgedParentIds.length > 0) {
    await store.removeOutboxMutations(acknowledgedParentIds);
  }
  if (unacknowledgedParentIds.length > 0) {
    await store.updateOutboxStatus(
      unacknowledgedParentIds,
      'pending',
      'Acquittement serveur partiel — en attente de reprise.',
    );
  }

  const remaining = await store.listOutbox();
  return {
    ok: true,
    appliedCount,
    duplicateCount,
    rejectedCount,
    remainingCount: remaining.length,
    latestRevision: parsed.data.latest_revision ?? null,
  };
}

// ============================================================================
// Drive/Gemini Offline Guard
// ============================================================================

export function canTriggerDriveSync(isOnline: boolean): DriveSyncGuardResult {
  if (!isOnline) {
    return {
      allowed: false,
      reason: DRIVE_SYNC_OFFLINE_MESSAGE,
    };
  }
  return { allowed: true };
}

// ============================================================================
// Pure Retroactive Rule Engine (Respects is_manual_category & transfer locks)
// ============================================================================

function matchesRulePattern(rule: CategorizationRule, tx: Transaction): boolean {
  if (rule.bank_filter !== null && rule.bank_filter !== tx.bank) {
    return false;
  }
  if (rule.account_id_filter !== null && rule.account_id_filter !== tx.account_id) {
    return false;
  }
  if (rule.account_type_filter !== null && rule.account_type_filter !== tx.account_type) {
    return false;
  }

  const candidates = [tx.raw_label, tx.clean_label];
  const pattern = rule.pattern.trim();
  if (pattern.length === 0) {
    return false;
  }

  const upperPattern = pattern.toUpperCase();

  switch (rule.match_mode) {
    case 'contains':
      return candidates.some((label) => label.toUpperCase().includes(upperPattern));
    case 'starts_with':
      return candidates.some((label) => label.toUpperCase().startsWith(upperPattern));
    case 'exact':
      return candidates.some((label) => label.toUpperCase() === upperPattern);
    case 'regex': {
      if (pattern.length > 120) {
        return false;
      }
      try {
        const regex = new RegExp(pattern, 'i');
        return candidates.some((label) => regex.test(label));
      } catch {
        return false;
      }
    }
  }
}

export interface ReapplyRulesResult {
  readonly transactions: readonly Transaction[];
  readonly updatedCount: number;
  readonly skippedManualCount: number;
}

export function reapplyRulesOnTransactions(
  transactions: readonly Transaction[],
  rules: readonly CategorizationRule[],
): ReapplyRulesResult {
  const activeSortedRules = [...rules]
    .filter((rule) => rule.is_active)
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.id.localeCompare(right.id);
    });

  let updatedCount = 0;
  let skippedManualCount = 0;

  const nextTransactions = transactions.map((tx): Transaction => {
    if (
      tx.is_manual_category ||
      tx.is_manual_transfer_override ||
      tx.transfer_group_id !== null
    ) {
      skippedManualCount += 1;
      return tx;
    }

    const matchedRule = activeSortedRules.find((rule) => matchesRulePattern(rule, tx));
    if (matchedRule !== undefined) {
      const changed =
        tx.category !== matchedRule.target_category ||
        tx.matched_rule_id !== matchedRule.id ||
        tx.is_internal_transfer !== matchedRule.mark_as_internal_transfer;

      if (!changed) {
        return tx;
      }

      updatedCount += 1;
      return {
        ...tx,
        category: matchedRule.target_category,
        matched_rule_id: matchedRule.id,
        is_internal_transfer: matchedRule.mark_as_internal_transfer,
      };
    }

    if (tx.matched_rule_id !== null) {
      updatedCount += 1;
      return {
        ...tx,
        category: 'Non catégorisé',
        matched_rule_id: null,
        is_internal_transfer: false,
      };
    }

    return tx;
  });

  return {
    transactions: nextTransactions,
    updatedCount,
    skippedManualCount,
  };
}

// ============================================================================
// Capacitor Android Bridge (Feature-Detected, Zero Mandatory @capacitor/* Dep)
// ============================================================================

interface CapacitorPluginHandle {
  readonly remove: () => Promise<void> | void;
}

interface CapacitorNetworkPlugin {
  readonly getStatus?: () => Promise<{ readonly connected: boolean }>;
  readonly addListener?: (
    eventName: 'networkStatusChange',
    listener: (status: { readonly connected: boolean }) => void,
  ) => Promise<CapacitorPluginHandle> | CapacitorPluginHandle;
}

interface CapacitorAppPlugin {
  readonly addListener?: (
    eventName: 'backButton',
    listener: () => void,
  ) => Promise<CapacitorPluginHandle> | CapacitorPluginHandle;
}

interface CapacitorHapticsPlugin {
  readonly impact?: (options: { readonly style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }) => Promise<void>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getCapacitorPlugins(): {
  readonly network: CapacitorNetworkPlugin | null;
  readonly app: CapacitorAppPlugin | null;
  readonly haptics: CapacitorHapticsPlugin | null;
} {
  if (typeof globalThis === 'undefined') {
    return { network: null, app: null, haptics: null };
  }
  const capacitor: unknown = Reflect.get(globalThis, 'Capacitor');
  if (!isObjectRecord(capacitor)) {
    return { network: null, app: null, haptics: null };
  }
  const plugins: unknown = Reflect.get(capacitor, 'Plugins');
  if (!isObjectRecord(plugins)) {
    return { network: null, app: null, haptics: null };
  }

  const rawNetwork = Reflect.get(plugins, 'Network');
  const rawApp = Reflect.get(plugins, 'App');
  const rawHaptics = Reflect.get(plugins, 'Haptics');

  return {
    network: isObjectRecord(rawNetwork) ? (rawNetwork as CapacitorNetworkPlugin) : null,
    app: isObjectRecord(rawApp) ? (rawApp as CapacitorAppPlugin) : null,
    haptics: isObjectRecord(rawHaptics) ? (rawHaptics as CapacitorHapticsPlugin) : null,
  };
}

function closeActiveDialogIfPresent(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const activeDialog = document.querySelector('dialog[open]');
  if (activeDialog === null) {
    return false;
  }
  if ('close' in activeDialog && typeof activeDialog.close === 'function') {
    activeDialog.close();
    return true;
  }
  return false;
}

export function setupAndroidBridge(callbacks: AndroidBridgeCallbacks): AndroidBridgeHandle {
  const cleanups: Array<() => void> = [];
  let disposed = false;

  const { network, app, haptics } = getCapacitorPlugins();

  const registerHandle = (
    maybeHandlePromise: Promise<CapacitorPluginHandle> | CapacitorPluginHandle | undefined,
  ): void => {
    if (maybeHandlePromise === undefined) {
      return;
    }
    void Promise.resolve(maybeHandlePromise)
      .then((handle) => {
        if (disposed) {
          void handle.remove();
          return;
        }
        cleanups.push(() => {
          void handle.remove();
        });
      })
      .catch(() => undefined);
  };

  if (typeof window !== 'undefined') {
    const handleOnline = (): void => {
      callbacks.onOnlineStatusChange(true);
    };
    const handleOffline = (): void => {
      callbacks.onOnlineStatusChange(false);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    cleanups.push(() => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    });
  }

  if (network !== null) {
    if (typeof network.getStatus === 'function') {
      void network
        .getStatus()
        .then((status) => {
          if (!disposed) {
            callbacks.onOnlineStatusChange(status.connected);
          }
        })
        .catch(() => undefined);
    }
    if (typeof network.addListener === 'function') {
      registerHandle(
        network.addListener('networkStatusChange', (status) => {
          callbacks.onOnlineStatusChange(status.connected);
        }),
      );
    }
  }

  if (app !== null && typeof app.addListener === 'function') {
    registerHandle(
      app.addListener('backButton', () => {
        const closedDialog = closeActiveDialogIfPresent();
        if (!closedDialog) {
          callbacks.onBackButtonWithoutDialog?.();
        }
      }),
    );
  }

  return {
    async triggerLightHaptic(): Promise<void> {
      if (haptics !== null && typeof haptics.impact === 'function') {
        try {
          await haptics.impact({ style: 'LIGHT' });
        } catch {
          // Ignore haptic failures on unsupported devices
        }
      }
    },

    dispose(): void {
      disposed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.length = 0;
    },
  };
}
