import {
  ALLOWED_DRIVE_FOLDERS,
  convertToEurCents,
  parseAccountId,
  parseDriveFileId,
  parseRuleId,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type CategorizationRule,
  type DeltaSyncResponse,
  type Transaction,
} from '@clairflux/shared';
import { describe, expect, it, vi } from 'vitest';
import capacitorConfig from '../../capacitor.config';
import type { ClairFluxDataset } from '../features/dashboard/types';
import {
  DRIVE_SYNC_OFFLINE_MESSAGE,
  canTriggerDriveSync,
  flushOutbox,
  pullDelta,
  reapplyRulesOnTransactions,
  setupAndroidBridge,
  type FetchLike,
} from './deltaSyncEngine';
import {
  CLAIRFLUX_OFFLINE_DB_NAME,
  OUTBOX_STORE_NAME,
  SNAPSHOT_STORE_NAME,
  createIndexedDbOfflineStore,
  createMemoryOfflineStore,
  createOfflineStore,
} from './indexedDbStore';
import { createOfflineController } from './useOfflineStore';

// ============================================================================
// Test Fixtures
// ============================================================================

const ACC_BOURSO = parseAccountId('11111111-1111-4111-8111-111111111111');
const ACC_REVOLUT_USD = parseAccountId('22222222-2222-4222-8222-222222222222');

const TX_AUTO = parseTransactionId('33333333-3333-4333-8333-333333333331');
const TX_MANUAL_CAT = parseTransactionId('33333333-3333-4333-8333-333333333332');
const TX_TRANSFER_LOCK = parseTransactionId('33333333-3333-4333-8333-333333333333');
const TX_TRANSFER_GROUP = parseTransactionId('33333333-3333-4333-8333-333333333334');

const RULE_CURSOR = parseRuleId('44444444-4444-4444-8444-444444444441');
const RULE_EDF = parseRuleId('44444444-4444-4444-8444-444444444442');

function buildSeedDataset(): ClairFluxDataset {
  const transactions: readonly Transaction[] = [
    {
      id: TX_AUTO,
      account_id: ACC_REVOLUT_USD,
      bank: 'revolut',
      account_type: 'multi_devises',
      external_ref_masked: 'USD •• 9012',
      booking_date: '2026-11-18',
      value_date: '2026-11-18',
      raw_label: 'CURSOR AI *MONTHLY SAN FRANCISCO US',
      clean_label: 'Cursor AI',
      amount_cents: toCents(-2000),
      currency: 'USD',
      fx_rate_micro: toFxRateMicro(924500),
      amount_eur_cents: convertToEurCents(toCents(-2000), toFxRateMicro(924500)),
      category: 'Non catégorisé',
      is_manual_category: false,
      matched_rule_id: null,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888881',
      revision: toSyncRevision(100),
      updated_at: '2026-11-18T10:00:00.000Z',
    },
    {
      id: TX_MANUAL_CAT,
      account_id: ACC_BOURSO,
      bank: 'boursobank',
      account_type: 'courant',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-16',
      value_date: '2026-11-16',
      raw_label: 'CURSOR AI *TEAM PRO',
      clean_label: 'Cursor Pro (Manuel)',
      amount_cents: toCents(-4000),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-4000),
      category: 'Dépenses Remboursées',
      is_manual_category: true,
      matched_rule_id: null,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888882',
      revision: toSyncRevision(101),
      updated_at: '2026-11-16T10:00:00.000Z',
    },
    {
      id: TX_TRANSFER_LOCK,
      account_id: ACC_BOURSO,
      bank: 'boursobank',
      account_type: 'courant',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-15',
      value_date: '2026-11-15',
      raw_label: 'PRLV SEPA EDF SERVICE CLIENT',
      clean_label: 'EDF Override Transfert',
      amount_cents: toCents(-11000),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-11000),
      category: 'Transfert interne',
      is_manual_category: false,
      matched_rule_id: null,
      is_internal_transfer: true,
      is_manual_transfer_override: true,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888882',
      revision: toSyncRevision(102),
      updated_at: '2026-11-15T10:00:00.000Z',
    },
    {
      id: TX_TRANSFER_GROUP,
      account_id: ACC_BOURSO,
      bank: 'boursobank',
      account_type: 'courant',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-14',
      value_date: '2026-11-14',
      raw_label: 'PRLV SEPA EDF REVOLUT',
      clean_label: 'Virement Apparié',
      amount_cents: toCents(-50000),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-50000),
      category: 'Transfert interne',
      is_manual_category: false,
      matched_rule_id: null,
      is_internal_transfer: true,
      is_manual_transfer_override: false,
      transfer_group_id: '99999999-9999-4999-8999-999999999991',
      source_drive_file_id: '88888888-8888-4888-8888-888888888882',
      revision: toSyncRevision(103),
      updated_at: '2026-11-14T10:00:00.000Z',
    },
  ];

  const rules: readonly CategorizationRule[] = [
    {
      id: RULE_CURSOR,
      name: 'Logiciels IA',
      priority: 10,
      bank_filter: null,
      account_id_filter: null,
      account_type_filter: null,
      match_mode: 'contains',
      pattern: 'CURSOR AI',
      target_category: 'Logiciels & Cloud',
      mark_as_internal_transfer: false,
      is_active: true,
      revision: toSyncRevision(50),
      updated_at: '2026-11-01T08:00:00.000Z',
    },
    {
      id: RULE_EDF,
      name: 'Énergie EDF',
      priority: 20,
      bank_filter: 'boursobank',
      account_id_filter: null,
      account_type_filter: null,
      match_mode: 'contains',
      pattern: 'EDF',
      target_category: 'Logement & Charges',
      mark_as_internal_transfer: false,
      is_active: true,
      revision: toSyncRevision(51),
      updated_at: '2026-11-01T08:05:00.000Z',
    },
  ];

  return {
    accounts: [
      {
        id: ACC_BOURSO,
        bank: 'boursobank',
        account_type: 'courant',
        nickname: 'Perso BoursoBank',
        external_ref_masked: '•••• 4821',
        currency: 'EUR',
        current_balance_cents: toCents(412840),
        current_balance_eur_cents: toCents(412840),
        balance_updated_at: '2026-11-20T23:59:59.000Z',
        revision: toSyncRevision(100),
        updated_at: '2026-11-20T18:00:00.000Z',
      },
      {
        id: ACC_REVOLUT_USD,
        bank: 'revolut',
        account_type: 'multi_devises',
        nickname: 'Courant USD',
        external_ref_masked: 'USD •• 9012',
        currency: 'USD',
        current_balance_cents: toCents(185000),
        current_balance_eur_cents: convertToEurCents(toCents(185000), toFxRateMicro(924500)),
        balance_updated_at: '2026-11-20T23:59:59.000Z',
        revision: toSyncRevision(100),
        updated_at: '2026-11-20T18:00:00.000Z',
      },
    ],
    transactions,
    notes: [],
    rules,
    budgets: [
      {
        id: 'budget-alim',
        category: 'Alimentation',
        limitCents: toCents(50000),
        spentCents: toCents(42000),
        currency: 'EUR',
      },
    ],
    driveFiles: [
      {
        drive_file_id: parseDriveFileId('1AbCdEfBoursoNov2026'),
        drive_folder_id: ALLOWED_DRIVE_FOLDERS.boursobank,
        bank: 'boursobank',
        file_name: 'BoursoBank_2026_11.pdf',
        status: 'committed',
        attempt_count: 1,
        error_code: null,
        error_message: null,
        revision: toSyncRevision(100),
        updated_at: '2026-11-20T18:00:00.000Z',
      },
    ],
    revision: 103,
    syncedAt: '2026-11-20T18:00:00.000Z',
  };
}

// ============================================================================
// Minimal In-Memory IndexedDB Mock (Verifies Object Stores & Zod Boundary)
// ============================================================================

function createFakeIndexedDbFactory(): {
  readonly factory: IDBFactory;
  readonly createdStores: Set<string>;
  corruptOutboxRow: (id: string, corruptValue: unknown) => void;
} {
  const storeTables = new Map<string, Map<string, unknown>>();
  const createdStores = new Set<string>();

  const makeRequest = <T>(executor: () => T): IDBRequest<T> => {
    const req: {
      result: T | undefined;
      error: DOMException | null;
      onsuccess: ((ev: Event) => void) | null;
      onerror: ((ev: Event) => void) | null;
    } = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };

    queueMicrotask(() => {
      try {
        req.result = executor();
        req.onsuccess?.(new Event('success'));
      } catch (err: unknown) {
        req.error = err instanceof DOMException ? err : new DOMException(String(err));
        req.onerror?.(new Event('error'));
      }
    });

    return req as unknown as IDBRequest<T>;
  };

  const fakeDb = {
    objectStoreNames: {
      contains: (name: string) => createdStores.has(name),
    },
    createObjectStore: (name: string) => {
      createdStores.add(name);
      if (!storeTables.has(name)) {
        storeTables.set(name, new Map());
      }
      return {
        createIndex: () => ({}),
      };
    },
    transaction: (storeNames: string | string[]) => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const tx: {
        error: DOMException | null;
        oncomplete: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
        onabort: ((ev: Event) => void) | null;
        objectStore: (name: string) => unknown;
      } = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: (name: string) => {
          if (!names.includes(name)) {
            throw new Error(`Store ${name} not in transaction`);
          }
          const table = storeTables.get(name) ?? new Map<string, unknown>();
          storeTables.set(name, table);
          return {
            get: (key: string) => makeRequest(() => table.get(key)),
            getAll: () => makeRequest(() => [...table.values()]),
            put: (value: Record<string, unknown>) => {
              const key = String(value['id'] ?? value['client_mutation_id'] ?? '');
              table.set(key, value);
              return makeRequest(() => key);
            },
            delete: (key: string) => {
              table.delete(key);
              return makeRequest(() => undefined);
            },
            clear: () => {
              table.clear();
              return makeRequest(() => undefined);
            },
          };
        },
      };

      setTimeout(() => {
        tx.oncomplete?.(new Event('complete'));
      }, 0);

      return tx as unknown as IDBTransaction;
    },
  };

  const factory: IDBFactory = {
    open: () => {
      const openReq: {
        result: unknown;
        error: DOMException | null;
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
        onsuccess: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
      } = {
        result: fakeDb,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };

      queueMicrotask(() => {
        openReq.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
        openReq.onsuccess?.(new Event('success'));
      });

      return openReq as unknown as IDBOpenDBRequest;
    },
    cmp: () => 0,
    databases: async () => [],
    deleteDatabase: () => ({} as IDBOpenDBRequest),
  };

  return {
    factory,
    createdStores,
    corruptOutboxRow: (id: string, corruptValue: unknown) => {
      const outbox = storeTables.get(OUTBOX_STORE_NAME);
      outbox?.set(id, corruptValue);
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ClairFlux Offline-First Engine & Capacitor Bridge', () => {
  it('exposes the strict Capacitor Android configuration without npm @capacitor/cli', () => {
    expect(capacitorConfig.appId).toBe('com.clairflux.finance');
    expect(capacitorConfig.appName).toBe('ClairFlux');
    expect(capacitorConfig.webDir).toBe('dist');
    expect(capacitorConfig.server?.androidScheme).toBe('https');
    expect(capacitorConfig.android?.allowMixedContent).toBe(false);
    expect(capacitorConfig.android?.captureInput).toBe(true);
  });

  it('falls back cleanly to memory store when globalThis.indexedDB is absent (Node/Vitest)', async () => {
    const store = createOfflineStore();
    expect(store.mode).toBe('memory');

    const seed = buildSeedDataset();
    await store.saveSnapshot(seed);
    const loaded = await store.loadSnapshot();

    expect(loaded).not.toBeNull();
    expect(loaded?.revision).toBe(103);
    expect(loaded?.accounts).toHaveLength(2);
    expect(loaded?.budgets).toHaveLength(1);
  });

  it('creates clairflux_offline_v1 object stores (snapshots + outbox_mutations) and validates Zod on read', async () => {
    const fakeIdb = createFakeIndexedDbFactory();
    const store = createIndexedDbOfflineStore(fakeIdb.factory, CLAIRFLUX_OFFLINE_DB_NAME);
    expect(store.mode).toBe('indexeddb');

    const seed = buildSeedDataset();
    await store.saveSnapshot(seed);
    await store.enqueueOutbox({
      client_mutation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      kind: 'upsert_note',
      transactionId: TX_AUTO,
      payload: { content: 'Note stockée en IndexedDB' },
      createdAt: '2026-11-21T12:00:00.000Z',
      status: 'pending',
    });

    // Inject a corrupt record into outbox_mutations: Zod boundary must ignore it cleanly
    fakeIdb.corruptOutboxRow('corrupt-id', {
      client_mutation_id: 'not-a-uuid',
      kind: 'upsert_note',
      payload: 42,
    });

    expect(fakeIdb.createdStores.has(SNAPSHOT_STORE_NAME)).toBe(true);
    expect(fakeIdb.createdStores.has(OUTBOX_STORE_NAME)).toBe(true);

    const loadedSnapshot = await store.loadSnapshot();
    const outbox = await store.listOutbox();

    expect(loadedSnapshot?.revision).toBe(103);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.client_mutation_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(outbox[0]?.status).toBe('pending');
  });

  it('allows adding a quick note offline -> optimistic UI + outbox pending, then flushes idempotently on reconnect', async () => {
    const store = createMemoryOfflineStore();
    const seed = buildSeedDataset();
    const hapticSpy = vi.fn(async () => undefined);
    const postedPayloads: Array<Record<string, unknown>> = [];

    const mockFetcher: FetchLike = vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input.endsWith('/api/sync/delta')) {
        const body = JSON.parse(String(init.body)) as {
          mutations: Array<{ client_mutation_id: string }>;
        };
        postedPayloads.push(body);
        const firstId = body.mutations[0]?.client_mutation_id ?? '';
        return new Response(
          JSON.stringify({
            results: [
              {
                client_mutation_id: firstId,
                status: 'duplicate',
                revision: 108,
              },
            ],
            latest_revision: 108,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (init?.method === 'GET' && input.includes('/api/sync/delta?since=')) {
        const delta: DeltaSyncResponse = {
          since_revision: toSyncRevision(103),
          batch_end_revision: toSyncRevision(108),
          latest_revision: toSyncRevision(108),
          has_more: false,
          full_resync_required: false,
          server_time: '2026-11-21T15:30:00.000Z',
          accounts: { upserted: [], deleted_ids: [] },
          transactions: { upserted: [], deleted_ids: [] },
          transaction_notes: {
            upserted: [
              {
                transaction_id: TX_AUTO,
                content: 'Note saisie en mode avion',
                revision: toSyncRevision(108),
                updated_at: '2026-11-21T15:30:00.000Z',
              },
            ],
            deleted_transaction_ids: [],
          },
          categorization_rules: { upserted: [], deleted_ids: [] },
          drive_sync_status: { last_run: null, files: [] },
          aggregates_snapshot: null,
        };
        return new Response(JSON.stringify(delta), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(null, { status: 404 });
    });

    const controller = createOfflineController(seed, {
      store,
      apiBaseUrl: 'https://api.clairflux.local',
      fetcher: mockFetcher,
      initialOnline: false,
      nowProvider: () => '2026-11-21T15:25:00.000Z',
      uuidProvider: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      onHaptic: hapticSpy,
    });

    await controller.hydrate();
    await controller.saveQuickNote(TX_AUTO, '  Note saisie en mode avion  ');

    // Optimistic UI + Outbox pending + Haptic
    const offlineState = controller.getState();
    expect(offlineState.isOnline).toBe(false);
    expect(offlineState.pendingOutboxCount).toBe(1);
    expect(offlineState.dataset.notes).toHaveLength(1);
    expect(offlineState.dataset.notes[0]?.content).toBe('Note saisie en mode avion');
    expect(hapticSpy).toHaveBeenCalledTimes(1);

    const outboxBeforeReconnect = await store.listOutbox();
    expect(outboxBeforeReconnect).toHaveLength(1);
    expect(outboxBeforeReconnect[0]?.status).toBe('pending');
    expect(outboxBeforeReconnect[0]?.kind).toBe('upsert_note');

    // Persisted in snapshot
    const persistedSnapshot = await store.loadSnapshot();
    expect(persistedSnapshot?.notes[0]?.content).toBe('Note saisie en mode avion');

    // Reconnect -> automatic flushNow() + delta pull
    await controller.setOnline(true);

    const onlineState = controller.getState();
    expect(onlineState.isOnline).toBe(true);
    expect(onlineState.pendingOutboxCount).toBe(0);
    expect(onlineState.dataset.revision).toBe(108);
    expect(postedPayloads).toHaveLength(1);
    expect((await store.listOutbox())).toHaveLength(0);
  });

  it('keeps outbox mutations safe without deleting when server fails or rejects', async () => {
    const store = createMemoryOfflineStore();
    await store.enqueueOutbox({
      client_mutation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      kind: 'upsert_note',
      transactionId: TX_AUTO,
      payload: { content: 'Doit survivre à une panne 503' },
      createdAt: '2026-11-21T15:00:00.000Z',
      status: 'pending',
    });

    const failingFetcher: FetchLike = async () =>
      new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 503 });

    const failFlush = await flushOutbox(store, 'https://api.clairflux.local', failingFetcher);
    expect(failFlush.ok).toBe(false);
    expect(failFlush.remainingCount).toBe(1);

    const after503 = await store.listOutbox();
    expect(after503).toHaveLength(1);
    expect(after503[0]?.status).toBe('pending');

    // Server explicitly rejects mutation -> marked failed, not deleted silently
    const rejectFetcher: FetchLike = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              client_mutation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              status: 'rejected',
              reason: 'CONFLICT',
              message: 'Transaction introuvable',
            },
          ],
          latest_revision: 109,
        }),
        { status: 200 },
      );

    const rejectFlush = await flushOutbox(store, 'https://api.clairflux.local', rejectFetcher);
    expect(rejectFlush.ok).toBe(true);
    if (rejectFlush.ok) {
      expect(rejectFlush.rejectedCount).toBe(1);
      expect(rejectFlush.remainingCount).toBe(1);
    }
    const afterReject = await store.listOutbox();
    expect(afterReject[0]?.status).toBe('failed');
    expect(afterReject[0]?.lastError).toBe('Transaction introuvable');
  });

  it('blocks Drive/Gemini sync offline with explicit message and zero network requests', async () => {
    expect(canTriggerDriveSync(false)).toEqual({
      allowed: false,
      reason: DRIVE_SYNC_OFFLINE_MESSAGE,
    });
    expect(canTriggerDriveSync(true)).toEqual({ allowed: true });

    const store = createMemoryOfflineStore();
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 202 }));
    const controller = createOfflineController(buildSeedDataset(), {
      store,
      fetcher,
      initialOnline: false,
    });

    await controller.triggerDriveSync();
    expect(fetcher).not.toHaveBeenCalled();
    expect(controller.getState().syncMessage).toBe(DRIVE_SYNC_OFFLINE_MESSAGE);
  });

  it('strictly preserves is_manual_category, is_manual_transfer_override and transfer_group_id during reapplyRules', async () => {
    const seed = buildSeedDataset();
    const result = reapplyRulesOnTransactions(seed.transactions, seed.rules);

    expect(result.updatedCount).toBe(1);
    expect(result.skippedManualCount).toBe(3);

    const autoTx = result.transactions.find((tx) => tx.id === TX_AUTO);
    const manualCatTx = result.transactions.find((tx) => tx.id === TX_MANUAL_CAT);
    const transferOverrideTx = result.transactions.find((tx) => tx.id === TX_TRANSFER_LOCK);
    const transferGroupTx = result.transactions.find((tx) => tx.id === TX_TRANSFER_GROUP);

    expect(autoTx?.category).toBe('Logiciels & Cloud');
    expect(autoTx?.matched_rule_id).toBe(RULE_CURSOR);

    // Must remain untouched!
    expect(manualCatTx?.category).toBe('Dépenses Remboursées');
    expect(manualCatTx?.is_manual_category).toBe(true);
    expect(manualCatTx?.matched_rule_id).toBeNull();

    expect(transferOverrideTx?.category).toBe('Transfert interne');
    expect(transferOverrideTx?.is_manual_transfer_override).toBe(true);
    expect(transferOverrideTx?.matched_rule_id).toBeNull();

    expect(transferGroupTx?.category).toBe('Transfert interne');
    expect(transferGroupTx?.transfer_group_id).toBe('99999999-9999-4999-8999-999999999991');

    // Also test via controller.reapplyRules()
    const store = createMemoryOfflineStore();
    const controller = createOfflineController(seed, { store, initialOnline: false });
    await controller.reapplyRules();

    const updated = controller.getState().dataset.transactions;
    expect(updated.find((tx) => tx.id === TX_AUTO)?.category).toBe('Logiciels & Cloud');
    expect(updated.find((tx) => tx.id === TX_MANUAL_CAT)?.category).toBe('Dépenses Remboursées');
  });

  it('validates pullDelta with Zod and handles Capacitor Android bridge safely', async () => {
    const invalidPull = await pullDelta('https://api.clairflux.local', 10, async () =>
      new Response(JSON.stringify({ malformed: true }), { status: 200 }),
    );
    expect(invalidPull.ok).toBe(false);

    // Feature-detected Capacitor Plugins mock
    const listeners: {
      back: (() => void) | null;
      network: ((status: { connected: boolean }) => void) | null;
    } = {
      back: null,
      network: null,
    };
    const impactSpy = vi.fn(async () => undefined);
    const closeSpy = vi.fn();

    Reflect.set(globalThis, 'Capacitor', {
      Plugins: {
        Network: {
          getStatus: async () => ({ connected: true }),
          addListener: (_event: string, cb: (status: { connected: boolean }) => void) => {
            listeners.network = cb;
            return { remove: () => undefined };
          },
        },
        App: {
          addListener: (_event: string, cb: () => void) => {
            listeners.back = cb;
            return { remove: () => undefined };
          },
        },
        Haptics: {
          impact: impactSpy,
        },
      },
    });
    Reflect.set(globalThis, 'document', {
      querySelector: (selector: string) =>
        selector === 'dialog[open]' ? { close: closeSpy } : null,
    });

    try {
      const statusChanges: boolean[] = [];
      const bridge = setupAndroidBridge({
        onOnlineStatusChange: (online) => statusChanges.push(online),
      });

      await bridge.triggerLightHaptic();
      expect(impactSpy).toHaveBeenCalledWith({ style: 'LIGHT' });

      listeners.back?.();
      expect(closeSpy).toHaveBeenCalledTimes(1);

      listeners.network?.({ connected: false });
      expect(statusChanges).toContain(false);

      bridge.dispose();
    } finally {
      Reflect.deleteProperty(globalThis, 'Capacitor');
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('queues manual category/transfer updates offline and supports rule save, reorder and toggle', async () => {
    const store = createMemoryOfflineStore();
    const seed = buildSeedDataset();
    const postedKinds: string[] = [];

    const mockFetcher: FetchLike = async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input.endsWith('/api/sync/delta')) {
        const body = JSON.parse(String(init.body)) as {
          mutations: Array<{ client_mutation_id: string; kind: string }>;
        };
        for (const m of body.mutations) {
          postedKinds.push(m.kind);
        }
        return new Response(
          JSON.stringify({
            results: body.mutations.map((m) => ({
              client_mutation_id: m.client_mutation_id,
              status: 'applied',
              revision: 112,
            })),
            latest_revision: 112,
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    };

    const controller = createOfflineController(seed, {
      store,
      apiBaseUrl: 'https://api.clairflux.local',
      fetcher: mockFetcher,
      initialOnline: false,
      uuidProvider: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });

    await controller.updateManualCategory(TX_AUTO, 'Matériel Pro', true);
    const updatedTx = controller.getState().dataset.transactions.find((t) => t.id === TX_AUTO);
    expect(updatedTx?.category).toBe('Matériel Pro');
    expect(updatedTx?.is_manual_category).toBe(true);
    expect(updatedTx?.is_internal_transfer).toBe(true);
    expect(updatedTx?.is_manual_transfer_override).toBe(true);
    expect(controller.getState().pendingOutboxCount).toBe(1);

    await controller.setOnline(true);
    expect(postedKinds).toEqual(['set_category', 'set_internal_transfer']);
    expect(controller.getState().pendingOutboxCount).toBe(0);

    await controller.reorderRule(RULE_EDF, 'up');
    const reordered = controller.getState().dataset.rules;
    expect(reordered[0]?.id).toBe(RULE_EDF);

    await controller.toggleRule(RULE_EDF);
    expect(
      controller.getState().dataset.rules.find((r) => r.id === RULE_EDF)?.is_active,
    ).toBe(false);

    await controller.saveRule({
      name: 'Nouvelle règle SaaS',
      pattern: 'NOTION',
      targetCategory: 'Productivité',
      bankFilter: null,
      accountIdFilter: null,
    });
    expect(controller.getState().dataset.rules).toHaveLength(3);
  });

  it('toggling isInternalTransfer alone preserves is_manual_category = false and never emits set_category', async () => {
    const store = createMemoryOfflineStore();
    const seed = buildSeedDataset();
    const postedKinds: string[] = [];

    const mockFetcher: FetchLike = async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input.endsWith('/api/sync/delta')) {
        const body = JSON.parse(String(init.body)) as {
          mutations: Array<{ client_mutation_id: string; kind: string }>;
        };
        for (const m of body.mutations) {
          postedKinds.push(m.kind);
        }
        return new Response(
          JSON.stringify({
            results: body.mutations.map((m) => ({
              client_mutation_id: m.client_mutation_id,
              status: 'applied',
              revision: 115,
            })),
            latest_revision: 115,
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    };

    const controller = createOfflineController(seed, {
      store,
      apiBaseUrl: 'https://api.clairflux.local',
      fetcher: mockFetcher,
      initialOnline: false,
      uuidProvider: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });

    // Keep identical category ('Non catégorisé'), only toggle isInternalTransfer -> true
    await controller.updateManualCategory(TX_AUTO, 'Non catégorisé', true);

    const updatedTx = controller.getState().dataset.transactions.find((t) => t.id === TX_AUTO);
    expect(updatedTx?.category).toBe('Non catégorisé');
    expect(updatedTx?.is_manual_category).toBe(false);
    expect(updatedTx?.is_internal_transfer).toBe(true);
    expect(updatedTx?.is_manual_transfer_override).toBe(true);

    const outbox = await store.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe('update_category');
    if (outbox[0]?.kind === 'update_category') {
      expect(outbox[0].payload.categoryChanged).toBe(false);
      expect(outbox[0].payload.transferOverrideChanged).toBe(true);
    }

    await controller.setOnline(true);
    expect(postedKinds).toEqual(['set_internal_transfer']);
    expect(postedKinds).not.toContain('set_category');
    expect(controller.getState().pendingOutboxCount).toBe(0);
  });

  it('ne duplique pas le préfixe /api lorsque apiBaseUrl vaut /api (Docker / PRODUCTION_DEPLOY)', async () => {
    const store = createMemoryOfflineStore();
    const seed = buildSeedDataset();
    const requestedUrls: string[] = [];

    const mockFetcher: FetchLike = async (input: string, init?: RequestInit): Promise<Response> => {
      requestedUrls.push(`${init?.method ?? 'GET'} ${input}`);
      if (input === '/api/sync/drive' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      if (input.startsWith('/api/sync/delta') && init?.method === 'GET') {
        return new Response(
          JSON.stringify({
            revision: seed.revision,
            accounts: [],
            transactions: [],
            notes: [],
            rules: [],
            drive_files: [],
            budgets: [],
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    };

    const controller = createOfflineController(seed, {
      store,
      apiBaseUrl: '/api',
      fetcher: mockFetcher,
      initialOnline: true,
    });

    await controller.triggerDriveSync();
    await controller.flushNow();

    expect(requestedUrls).toContain('POST /api/sync/drive');
    expect(requestedUrls).toContain(`GET /api/sync/delta?since=${seed.revision}`);
    expect(requestedUrls.some((u) => u.includes('/api/api/'))).toBe(false);
  });

  it('déclenche onUnauthorized sur 401 et réinitialise le cache obsolète lors d un full_resync_required', async () => {
    const store = createMemoryOfflineStore();
    const staleSeed = buildSeedDataset();
    let unauthorizedCount = 0;

    const fetcher401: FetchLike = async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });

    const unauthorizedController = createOfflineController(staleSeed, {
      store,
      apiBaseUrl: '/api',
      fetcher: fetcher401,
      initialOnline: true,
      onUnauthorized: () => {
        unauthorizedCount += 1;
      },
    });

    await unauthorizedController.syncFromServer();
    await unauthorizedController.triggerDriveSync();
    expect(unauthorizedCount).toBe(2);

    const serverDelta: DeltaSyncResponse = {
      since_revision: toSyncRevision(staleSeed.revision),
      batch_end_revision: toSyncRevision(5),
      latest_revision: toSyncRevision(5),
      has_more: false,
      full_resync_required: true,
      server_time: '2026-11-24T10:00:00.000Z',
      accounts: { upserted: [], deleted_ids: [] },
      transactions: { upserted: [], deleted_ids: [] },
      transaction_notes: { upserted: [], deleted_transaction_ids: [] },
      categorization_rules: { upserted: [], deleted_ids: [] },
      drive_sync_status: { last_run: null, files: [] },
      aggregates_snapshot: null,
    };

    const resyncController = createOfflineController(staleSeed, {
      store: createMemoryOfflineStore(),
      apiBaseUrl: '/api',
      fetcher: async () => new Response(JSON.stringify(serverDelta), { status: 200 }),
      initialOnline: true,
    });

    await resyncController.syncFromServer();
    expect(resyncController.getState().dataset.revision).toBe(5);
    expect(resyncController.getState().dataset.transactions).toHaveLength(0);
  });
});
