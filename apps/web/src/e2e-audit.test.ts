import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertToEurCents,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type CategorizationRule,
  type DeltaSyncResponse,
  type SyncRevision,
  type Transaction,
  type TransactionId,
  type TransactionNote,
} from '@clairflux/shared';
import { describe, expect, it } from 'vitest';
import {
  EXCLUSIVE_DRIVE_FOLDERS,
  createApp,
  signSessionToken,
  type AppDependencies,
  type OutboxMutationOutcome,
} from '../../api/src/app';
import {
  INITIAL_SEED_DATASET,
  buildCumulativeBalanceSeries,
  buildMonthlyExpenseSeries,
  computeKpiMetrics,
  type ExpenseComparisonMode,
} from './features/dashboard/types';
import { exportTransactionsToCsv, neutralizeCsvFormula } from './features/ledger/csvExport';
import { flushOutbox, type FetchLike } from './offline/deltaSyncEngine';
import {
  OUTBOX_STORE_NAME,
  SNAPSHOT_STORE_NAME,
  createIndexedDbOfflineStore,
} from './offline/indexedDbStore';
import { createOfflineController, reapplyRulesOnTransactions } from './offline/useOfflineStore';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = resolve(CURRENT_DIR, '../index.html');
const DASHBOARD_CHROME_PATH = resolve(CURRENT_DIR, './features/dashboard/DashboardChrome.tsx');

const TEST_SESSION_SECRET = 'clairflux-e2e-audit-session-secret-min-32-chars';
const FIXED_NOW = new Date('2026-11-21T19:00:00.000Z');

// ============================================================================
// Minimal In-Memory IndexedDB Mock (Exercises outbox_mutations Object Store)
// ============================================================================

function createTestIndexedDbFactory(): {
  readonly factory: IDBFactory;
  readonly createdStores: ReadonlySet<string>;
  getOutboxRawRows: () => readonly unknown[];
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
        storeTables.set(name, new Map<string, unknown>());
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
            throw new Error(`Object store ${name} missing from transaction`);
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
    deleteDatabase: () => ({}) as IDBOpenDBRequest,
  };

  return {
    factory,
    createdStores,
    getOutboxRawRows: () => [...(storeTables.get(OUTBOX_STORE_NAME)?.values() ?? [])],
  };
}

// ============================================================================
// In-Memory Hono API Harness (`createApp`) for Real Outbox Flush E2E
// ============================================================================

interface PostSyncRecord {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
}

function createInMemoryApiBridge() {
  let currentRev = INITIAL_SEED_DATASET.revision;
  const serverNotes = new Map<TransactionId, TransactionNote>(
    INITIAL_SEED_DATASET.notes.map((n) => [n.transaction_id, n]),
  );
  const serverTransactions = new Map<TransactionId, Transaction>(
    INITIAL_SEED_DATASET.transactions.map((t) => [t.id, t]),
  );
  const appliedMutations = new Map<string, SyncRevision>();
  let serverApplyExecutions = 0;

  const deps: AppDependencies = {
    sessionSecret: TEST_SESSION_SECRET,
    now: () => FIXED_NOW,
    healthRepository: {
      ping: async () => true,
    },
    accountsRepository: {
      listAccounts: async () => ({
        accounts: [...INITIAL_SEED_DATASET.accounts],
        latest_revision: toSyncRevision(currentRev),
      }),
    },
    driveSyncService: {
      triggerManualSync: async () => ({
        ok: true,
        run: {
          id: '77777777-7777-4777-8777-777777777771',
          status: 'running',
          trigger_mode: 'manual',
          allowed_folders: EXCLUSIVE_DRIVE_FOLDERS,
          started_at: FIXED_NOW.toISOString(),
        },
      }),
    },
    syncDeltaRepository: {
      getDelta: async (query): Promise<DeltaSyncResponse> => {
        const upsertedNotes = [...serverNotes.values()].filter(
          (note) => note.revision > query.since,
        );
        return {
          since_revision: query.since,
          batch_end_revision: toSyncRevision(currentRev),
          latest_revision: toSyncRevision(currentRev),
          has_more: false,
          full_resync_required: false,
          server_time: FIXED_NOW.toISOString(),
          accounts: { upserted: [], deleted_ids: [] },
          transactions: { upserted: [], deleted_ids: [] },
          transaction_notes: { upserted: upsertedNotes, deleted_transaction_ids: [] },
          categorization_rules: { upserted: [], deleted_ids: [] },
          drive_sync_status: {
            last_run: null,
            files: [...INITIAL_SEED_DATASET.driveFiles],
          },
          aggregates_snapshot: null,
        };
      },
    },
    deltaMutationRepository: {
      applyOutboxBatch: async (mutations) => {
        const results: OutboxMutationOutcome[] = [];
        for (const mutation of mutations) {
          const existingRevision = appliedMutations.get(mutation.client_mutation_id);
          if (existingRevision !== undefined) {
            results.push({
              client_mutation_id: mutation.client_mutation_id,
              status: 'duplicate',
              revision: existingRevision,
            });
            continue;
          }

          const targetTx = serverTransactions.get(mutation.transaction_id);
          if (targetTx === undefined) {
            results.push({
              client_mutation_id: mutation.client_mutation_id,
              status: 'rejected',
              reason: 'RESOURCE_NOT_FOUND',
              message: 'Transaction introuvable.',
            });
            continue;
          }

          currentRev += 1;
          const nextRev = toSyncRevision(currentRev);
          serverApplyExecutions += 1;

          if (mutation.kind === 'upsert_note') {
            if (mutation.note === null || mutation.note.trim().length === 0) {
              serverNotes.delete(mutation.transaction_id);
            } else {
              serverNotes.set(mutation.transaction_id, {
                transaction_id: mutation.transaction_id,
                content: mutation.note.trim(),
                revision: nextRev,
                updated_at: FIXED_NOW.toISOString(),
              });
            }
          } else if (mutation.kind === 'set_category') {
            serverTransactions.set(mutation.transaction_id, {
              ...targetTx,
              category: mutation.category,
              is_manual_category: true,
              matched_rule_id: null,
              revision: nextRev,
              updated_at: FIXED_NOW.toISOString(),
            });
          } else {
            serverTransactions.set(mutation.transaction_id, {
              ...targetTx,
              is_internal_transfer: mutation.is_internal_transfer,
              is_manual_transfer_override: true,
              revision: nextRev,
              updated_at: FIXED_NOW.toISOString(),
            });
          }

          appliedMutations.set(mutation.client_mutation_id, nextRev);
          results.push({
            client_mutation_id: mutation.client_mutation_id,
            status: 'applied',
            revision: nextRev,
          });
        }

        return {
          results,
          latest_revision: toSyncRevision(currentRev),
        };
      },
    },
  };

  const app = createApp(deps);
  const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
  const token = signSessionToken(
    {
      jti: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      client_kind: 'android',
      iat: nowSec - 60,
      exp: nowSec + 3600,
    },
    TEST_SESSION_SECRET,
  );

  const calls: PostSyncRecord[] = [];

  const fetcher: FetchLike = async (input, init) => {
    const parsedUrl = new URL(input, 'http://clairflux.local');
    const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);

    const response = await app.request(pathWithQuery, {
      ...(init?.method !== undefined ? { method: init.method } : {}),
      headers,
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });

    const clonedText = await response.clone().text();
    let parsedJson: unknown = clonedText;
    try {
      parsedJson = JSON.parse(clonedText);
    } catch {
      // keep raw text
    }

    calls.push({
      method: init?.method ?? 'GET',
      path: pathWithQuery,
      status: response.status,
      body: parsedJson,
    });

    return response;
  };

  return {
    app,
    token,
    fetcher,
    calls,
    getServerNote: (txId: TransactionId) => serverNotes.get(txId),
    getServerApplyExecutions: () => serverApplyExecutions,
  };
}

// ============================================================================
// Audit Suite E2E — Jalon 3
// ============================================================================

describe('ClairFlux E2E Audit — Jalon 3', () => {
  describe('1. Invariants géométriques Desktop (1440×900) & Mobile (390×844) + Baseline', () => {
    it('respecte breakpoint 1024px, sticky <= 15 %, hitboxes 44px, <dialog> et content-visibility: auto', () => {
      const html = readFileSync(INDEX_HTML_PATH, 'utf8');

      // Desktop 1440x900 rail & breakpoint
      expect(html).toContain('@media (min-width: 1024px)');
      expect(html).toContain('--nav-rail-width: 240px');
      expect(html).toContain('max-inline-size: 1200px');

      // Mobile 390x844 sticky height ceiling: 64px / 844px = 7.58% <= 15%
      const mobileHeightMatch = /--mobile-nav-height:\s*(\d+)px/.exec(html);
      expect(mobileHeightMatch).not.toBeNull();
      const mobileNavPx = Number(mobileHeightMatch?.[1] ?? 0);
      expect(mobileNavPx).toBe(64);
      expect(mobileNavPx / 844).toBeLessThanOrEqual(0.15);
      expect(html).toContain('position: fixed');
      expect(html).toContain('env(safe-area-inset-bottom, 0px)');

      // Touch hitboxes >= 44px
      expect(html).toContain('min-block-size: 44px');
      expect(html).toContain('min-inline-size: 44px');

      // Baseline primitives & Core Web Vitals
      expect(html).toContain('dialog.cf-dialog:modal');
      expect(html).toContain('overscroll-behavior: contain');
      expect(html).toContain('container: kpis / inline-size');
      expect(html).toContain('container: charts / inline-size');
      expect(html).toContain('container: ledger / inline-size');
      expect(html).toContain('@container ledger (min-width: 760px)');
      expect(html).toContain('.cf-field-group:has(');
      expect(html).not.toContain('body:has(');
      expect(html).toContain(':user-valid');
      expect(html).toContain(':user-invalid');
      expect(html).toContain('content-visibility: auto');
      expect(html).toContain('contain-intrinsic-size: auto 72px');

      // Typography & offline font policy (zero Google Fonts CDN)
      expect(html).toContain('Plus Jakarta Sans');
      expect(html).toContain('DM Sans');
      expect(html).toContain('JetBrains Mono');
      expect(html).toContain('font-variant-numeric: tabular-nums');
      expect(html).not.toContain('fonts.googleapis.com');
    });
  });

  describe('2. Pipeline fonctionnel : 6M, Dépenses 3 modes, Budgets 80/100 %, Règles & CSV', () => {
    it('calcule le solde cumulé 6M pour all / boursobank / revolut en EUR consolidé et USD seul', () => {
      const allEur = buildCumulativeBalanceSeries(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'all',
        'eur_consolidated',
      );
      expect(allEur).toHaveLength(6);
      const kpiAllEur = computeKpiMetrics(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'all',
        'eur_consolidated',
      );
      expect(allEur.at(-1)?.closing_balance_cents).toBe(kpiAllEur.balanceCents);

      const boursoEur = buildCumulativeBalanceSeries(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'boursobank',
        'eur_consolidated',
      );
      const kpiBoursoEur = computeKpiMetrics(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'boursobank',
        'eur_consolidated',
      );
      expect(boursoEur.at(-1)?.closing_balance_cents).toBe(kpiBoursoEur.balanceCents);

      const revolutUsd = buildCumulativeBalanceSeries(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'revolut',
        'usd_only',
      );
      const allUsd = buildCumulativeBalanceSeries(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'all',
        'usd_only',
      );
      expect(revolutUsd.at(-1)?.closing_balance_cents).toBe(185000);
      expect(allUsd.at(-1)?.closing_balance_cents).toBe(185000);

      const boursoUsd = buildCumulativeBalanceSeries(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'boursobank',
        'usd_only',
      );
      expect(boursoUsd.at(-1)?.closing_balance_cents).toBe(0);
    });

    it('calcule les dépenses mensuelles (modes none / prev_month / avg_3m) en excluant les transferts internes', () => {
      const modes: readonly ExpenseComparisonMode[] = ['none', 'prev_month', 'avg_3m'];
      expect(modes).toHaveLength(3);

      const seriesEur = buildMonthlyExpenseSeries(
        INITIAL_SEED_DATASET.transactions,
        'all',
        'eur_consolidated',
      );
      expect(seriesEur).toHaveLength(6);

      // Nov 2026 expenses excl. internal transfers: Cursor AI (-20 USD @ 0.9245 = -1849) + Biocoop (-34200) + Loyer (-94500) + Hetzner (-5051) = 135600
      // Revolut EUR<->USD internal transfers (-55380 EUR / +60000 USD) MUST be excluded
      const novPoint = seriesEur.find((p) => p.month === '2026-11');
      const octPoint = seriesEur.find((p) => p.month === '2026-10');
      expect(novPoint).toBeDefined();
      expect(octPoint).toBeDefined();
      expect(novPoint?.amountCents).toBe(135600);
      expect(novPoint?.prevMonthCents).toBe(octPoint?.amountCents);

      // Avg of Aug (14200 USD @ 0.918 = 13036), Sep (136000), Oct (148200 + 6400 USD @ 0.922 = 5901 -> 154101)
      const augAmount = seriesEur.find((p) => p.month === '2026-08')?.amountCents ?? 0;
      const sepAmount = seriesEur.find((p) => p.month === '2026-09')?.amountCents ?? 0;
      const octAmount = octPoint?.amountCents ?? 0;
      expect(novPoint?.avg3mCents).toBe(Math.round((augAmount + sepAmount + octAmount) / 3));

      const kpiNov = computeKpiMetrics(
        INITIAL_SEED_DATASET.accounts,
        INITIAL_SEED_DATASET.transactions,
        'all',
        'eur_consolidated',
      );
      expect(kpiNov.expensesExclTransfersCents).toBe(135600);
      expect(kpiNov.internalTransfersCents).toBeGreaterThan(0);
    });

    it('évalue les seuils d alertes budgets 80 % et 100 % et protège is_manual_category lors de la réapplication des règles', () => {
      const chromeSource = readFileSync(DASHBOARD_CHROME_PATH, 'utf8');
      expect(chromeSource).toContain('ratioPercent >= 100');
      expect(chromeSource).toContain('ratioPercent >= 80');

      const statuses = INITIAL_SEED_DATASET.budgets.map((b) => {
        const pct = Math.round((b.spentCents / b.limitCents) * 100);
        return {
          id: b.id,
          pct,
          level: pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'ok',
        };
      });
      expect(statuses).toEqual([
        { id: 'budget-alimentation', pct: 68, level: 'ok' },
        { id: 'budget-logiciels', pct: 86, level: 'warning' },
        { id: 'budget-logement', pct: 105, level: 'danger' },
      ]);

      // Respect is_manual_category even when a rule matches
      const seedTx0 = INITIAL_SEED_DATASET.transactions[0];
      if (seedTx0 === undefined) {
        throw new Error('Missing seed transaction[0]');
      }
      const txManual: Transaction = {
        ...seedTx0,
        id: parseTransactionId('33333333-3333-4333-8333-333333333391'),
        raw_label: 'CURSOR AI *TEAM PRO',
        clean_label: 'Cursor Pro',
        category: 'Formation Remboursée',
        is_manual_category: true,
        matched_rule_id: null,
        is_internal_transfer: false,
        is_manual_transfer_override: false,
        transfer_group_id: null,
      };
      const txAuto: Transaction = {
        ...txManual,
        id: parseTransactionId('33333333-3333-4333-8333-333333333392'),
        category: 'Non catégorisé',
        is_manual_category: false,
      };
      const rules: readonly CategorizationRule[] = INITIAL_SEED_DATASET.rules;
      const reapplied = reapplyRulesOnTransactions([txManual, txAuto], rules);

      expect(reapplied.transactions[0]?.category).toBe('Formation Remboursée');
      expect(reapplied.transactions[0]?.is_manual_category).toBe(true);
      expect(reapplied.transactions[1]?.category).toBe('Logiciels & Cloud');
      expect(reapplied.updatedCount).toBe(1);
      expect(reapplied.skippedManualCount).toBe(1);

      // CSV anti-injection sanity
      expect(neutralizeCsvFormula('=CMD|"/C calc"!A0')).toBe("'=CMD|\"/C calc\"!A0");
      const csv = exportTransactionsToCsv(
        [{ ...txAuto, clean_label: '+SUM(A1:A2)' }],
        INITIAL_SEED_DATASET.accounts,
        [],
      );
      expect(csv).toContain("'+SUM(A1:A2)");
    });
  });

  describe('3. Scénario E2E Mobile Offline Outbox -> createApp (/api/sync/delta)', () => {
    it('enregistre une note hors-ligne dans outbox_mutations puis flush en ligne avec idempotence applied -> duplicate', async () => {
      const idb = createTestIndexedDbFactory();
      const store = createIndexedDbOfflineStore(idb.factory, 'clairflux_e2e_audit');
      const api = createInMemoryApiBridge();

      const mutationUuid = '90000000-0000-4000-8000-000000000001';
      const targetSeedTx = INITIAL_SEED_DATASET.transactions[3];
      if (targetSeedTx === undefined) {
        throw new Error('Missing seed transaction[3]');
      }
      const targetTxId = targetSeedTx.id; // Biocoop Paris 11 (sans note)

      const controller = createOfflineController(INITIAL_SEED_DATASET, {
        store,
        apiBaseUrl: 'http://clairflux.local',
        fetcher: api.fetcher,
        initialOnline: false,
        nowProvider: () => FIXED_NOW.toISOString(),
        uuidProvider: () => mutationUuid,
      });

      await controller.hydrate();
      expect(idb.createdStores.has(SNAPSHOT_STORE_NAME)).toBe(true);
      expect(idb.createdStores.has(OUTBOX_STORE_NAME)).toBe(true);
      expect(controller.getState().isOnline).toBe(false);

      // 1. Saisie d'une note rapide hors-ligne -> stockage dans outbox_mutations sans appel réseau
      await controller.saveQuickNote(targetTxId, 'Note E2E mobile hors-ligne');
      expect(api.calls).toHaveLength(0);
      expect(controller.getState().pendingOutboxCount).toBe(1);

      const outboxItems = await store.listOutbox();
      expect(outboxItems).toHaveLength(1);
      expect(outboxItems[0]).toMatchObject({
        client_mutation_id: mutationUuid,
        kind: 'upsert_note',
        transactionId: targetTxId,
        payload: { content: 'Note E2E mobile hors-ligne' },
        status: 'pending',
      });
      expect(idb.getOutboxRawRows()).toHaveLength(1);

      // 2. Retour en ligne -> flush automatique réel vers createApp (POST /api/sync/delta + GET /api/sync/delta)
      await controller.setOnline(true);

      const postCalls = api.calls.filter(
        (call) => call.method === 'POST' && call.path === '/api/sync/delta',
      );
      const getCalls = api.calls.filter(
        (call) => call.method === 'GET' && call.path.startsWith('/api/sync/delta'),
      );
      expect(postCalls).toHaveLength(1);
      expect(getCalls).toHaveLength(1);
      expect(postCalls[0]?.status).toBe(200);
      expect(postCalls[0]?.body).toEqual({
        results: [
          {
            client_mutation_id: mutationUuid,
            status: 'applied',
            revision: INITIAL_SEED_DATASET.revision + 1,
          },
        ],
        latest_revision: INITIAL_SEED_DATASET.revision + 1,
      });

      expect(controller.getState().isOnline).toBe(true);
      expect(controller.getState().pendingOutboxCount).toBe(0);
      expect(await store.listOutbox()).toHaveLength(0);
      expect(api.getServerNote(targetTxId)?.content).toBe('Note E2E mobile hors-ligne');
      expect(
        controller.getState().dataset.notes.find((n) => n.transaction_id === targetTxId)?.content,
      ).toBe('Note E2E mobile hors-ligne');
      expect(api.getServerApplyExecutions()).toBe(1);

      // 3. Replay idempotent avec le même client_mutation_id -> status = 'duplicate'
      await store.enqueueOutbox({
        client_mutation_id: mutationUuid,
        kind: 'upsert_note',
        transactionId: targetTxId,
        payload: { content: 'Note E2E mobile hors-ligne' },
        createdAt: FIXED_NOW.toISOString(),
        status: 'pending',
      });
      const replayFlush = await flushOutbox(store, 'http://clairflux.local', api.fetcher);

      expect(replayFlush).toEqual({
        ok: true,
        appliedCount: 0,
        duplicateCount: 1,
        rejectedCount: 0,
        remainingCount: 0,
        latestRevision: INITIAL_SEED_DATASET.revision + 1,
      });
      expect(api.getServerApplyExecutions()).toBe(1);
      expect(convertToEurCents(toCents(-2000), toFxRateMicro(924500))).toBe(-1849);
    });
  });
});
