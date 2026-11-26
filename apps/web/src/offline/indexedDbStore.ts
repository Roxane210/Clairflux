import {
  AccountSchema,
  AiRuleSuggestionSchema,
  CategorizationRuleSchema,
  CategorySchema,
  CentsSchema,
  DriveSyncFileStatusSchema,
  TransactionIdSchema,
  TransactionNoteSchema,
  TransactionSchema,
  type TransactionId,
} from '@clairflux/shared';
import { z } from 'zod';
import type { ClairFluxDataset } from '../features/dashboard/types';

// ============================================================================
// Constants & Zod Schemas (Boundary Validation for Local Storage)
// ============================================================================

export const CLAIRFLUX_OFFLINE_DB_NAME = 'clairflux_offline_v1' as const;
export const CLAIRFLUX_OFFLINE_DB_VERSION = 1 as const;
export const SNAPSHOT_STORE_NAME = 'snapshots' as const;
export const OUTBOX_STORE_NAME = 'outbox_mutations' as const;
const SNAPSHOT_KEY = 'current' as const;

export const BudgetLimitSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  limitCents: CentsSchema,
  spentCents: CentsSchema,
  currency: z.literal('EUR'),
});

export const ClairFluxDatasetSchema = z.object({
  accounts: z.array(AccountSchema),
  transactions: z.array(TransactionSchema),
  notes: z.array(TransactionNoteSchema),
  rules: z.array(CategorizationRuleSchema),
  categories: z.array(CategorySchema).optional(),
  ai_rule_suggestions: z.array(AiRuleSuggestionSchema).optional(),
  pending_ai_review_count: z.number().int().min(0).optional(),
  budgets: z.array(BudgetLimitSchema),
  driveFiles: z.array(DriveSyncFileStatusSchema),
  revision: z.number().int().nonnegative(),
  syncedAt: z.string().min(1),
});

export const OutboxMutationStatusSchema = z.enum(['pending', 'syncing', 'failed']);
export type OutboxMutationStatus = z.infer<typeof OutboxMutationStatusSchema>;

export const OutboxMutationKindSchema = z.enum(['upsert_note', 'update_category']);
export type OutboxMutationKind = z.infer<typeof OutboxMutationKindSchema>;

export const UpsertNotePayloadSchema = z.object({
  content: z.string().max(2000),
});
export type UpsertNotePayload = z.infer<typeof UpsertNotePayloadSchema>;

export const UpdateCategoryPayloadSchema = z.object({
  category: z.string().trim().min(1).max(64),
  isInternalTransfer: z.boolean(),
  categoryChanged: z.boolean().optional(),
  transferOverrideChanged: z.boolean().optional(),
});
export type UpdateCategoryPayload = z.infer<typeof UpdateCategoryPayloadSchema>;

export const OutboxMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    client_mutation_id: z.string().uuid(),
    kind: z.literal('upsert_note'),
    transactionId: TransactionIdSchema,
    payload: UpsertNotePayloadSchema,
    createdAt: z.string().min(1),
    status: OutboxMutationStatusSchema,
    lastError: z.string().optional(),
  }),
  z.object({
    client_mutation_id: z.string().uuid(),
    kind: z.literal('update_category'),
    transactionId: TransactionIdSchema,
    payload: UpdateCategoryPayloadSchema,
    createdAt: z.string().min(1),
    status: OutboxMutationStatusSchema,
    lastError: z.string().optional(),
  }),
]);

export type OutboxMutation =
  | {
      readonly client_mutation_id: string;
      readonly kind: 'upsert_note';
      readonly transactionId: TransactionId;
      readonly payload: { readonly content: string };
      readonly createdAt: string;
      readonly status: OutboxMutationStatus;
      readonly lastError?: string | undefined;
    }
  | {
      readonly client_mutation_id: string;
      readonly kind: 'update_category';
      readonly transactionId: TransactionId;
      readonly payload: {
        readonly category: string;
        readonly isInternalTransfer: boolean;
        readonly categoryChanged?: boolean | undefined;
        readonly transferOverrideChanged?: boolean | undefined;
      };
      readonly createdAt: string;
      readonly status: OutboxMutationStatus;
      readonly lastError?: string | undefined;
    };

const SnapshotEnvelopeSchema = z.object({
  id: z.literal(SNAPSHOT_KEY),
  dataset: ClairFluxDatasetSchema,
});

export interface OfflineStore {
  readonly mode: 'indexeddb' | 'memory';
  loadSnapshot(): Promise<ClairFluxDataset | null>;
  saveSnapshot(dataset: ClairFluxDataset): Promise<void>;
  listOutbox(): Promise<readonly OutboxMutation[]>;
  enqueueOutbox(mutation: OutboxMutation): Promise<void>;
  updateOutboxStatus(
    clientMutationIds: readonly string[],
    status: OutboxMutationStatus,
    lastError?: string,
  ): Promise<void>;
  removeOutboxMutations(clientMutationIds: readonly string[]): Promise<void>;
  clearAll(): Promise<void>;
}

// ============================================================================
// Normalization Helpers (exactOptionalPropertyTypes safe)
// ============================================================================

function normalizeOutboxMutation(raw: z.infer<typeof OutboxMutationSchema>): OutboxMutation {
  const baseError = raw.lastError !== undefined ? { lastError: raw.lastError } : {};
  if (raw.kind === 'upsert_note') {
    return {
      client_mutation_id: raw.client_mutation_id,
      kind: 'upsert_note',
      transactionId: raw.transactionId,
      payload: { content: raw.payload.content },
      createdAt: raw.createdAt,
      status: raw.status,
      ...baseError,
    };
  }
  return {
    client_mutation_id: raw.client_mutation_id,
    kind: 'update_category',
    transactionId: raw.transactionId,
    payload: {
      category: raw.payload.category,
      isInternalTransfer: raw.payload.isInternalTransfer,
      ...(raw.payload.categoryChanged !== undefined
        ? { categoryChanged: raw.payload.categoryChanged }
        : {}),
      ...(raw.payload.transferOverrideChanged !== undefined
        ? { transferOverrideChanged: raw.payload.transferOverrideChanged }
        : {}),
    },
    createdAt: raw.createdAt,
    status: raw.status,
    ...baseError,
  };
}

function sortOutboxChronologically(items: readonly OutboxMutation[]): readonly OutboxMutation[] {
  return [...items].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.client_mutation_id.localeCompare(right.client_mutation_id);
  });
}

function withUpdatedMutationStatus(
  mutation: OutboxMutation,
  status: OutboxMutationStatus,
  lastError?: string,
): OutboxMutation {
  const errorProps =
    lastError !== undefined
      ? { lastError }
      : status === 'pending' || status === 'syncing'
        ? {}
        : mutation.lastError !== undefined
          ? { lastError: mutation.lastError }
          : {};

  if (mutation.kind === 'upsert_note') {
    return {
      client_mutation_id: mutation.client_mutation_id,
      kind: 'upsert_note',
      transactionId: mutation.transactionId,
      payload: { content: mutation.payload.content },
      createdAt: mutation.createdAt,
      status,
      ...errorProps,
    };
  }

  return {
    client_mutation_id: mutation.client_mutation_id,
    kind: 'update_category',
    transactionId: mutation.transactionId,
    payload: { ...mutation.payload },
    createdAt: mutation.createdAt,
    status,
    ...errorProps,
  };
}

// ============================================================================
// In-Memory Fallback Store (Vitest Node / SSR / Restricted WebView)
// ============================================================================

export function createMemoryOfflineStore(): OfflineStore {
  let snapshot: ClairFluxDataset | null = null;
  const outboxMap = new Map<string, OutboxMutation>();

  return {
    mode: 'memory',

    async loadSnapshot(): Promise<ClairFluxDataset | null> {
      if (snapshot === null) {
        return null;
      }
      const parsed = ClairFluxDatasetSchema.safeParse(snapshot);
      return parsed.success ? parsed.data : null;
    },

    async saveSnapshot(dataset: ClairFluxDataset): Promise<void> {
      snapshot = ClairFluxDatasetSchema.parse(dataset);
    },

    async listOutbox(): Promise<readonly OutboxMutation[]> {
      const valid: OutboxMutation[] = [];
      for (const item of outboxMap.values()) {
        const parsed = OutboxMutationSchema.safeParse(item);
        if (parsed.success) {
          valid.push(normalizeOutboxMutation(parsed.data));
        }
      }
      return sortOutboxChronologically(valid);
    },

    async enqueueOutbox(mutation: OutboxMutation): Promise<void> {
      const validated = normalizeOutboxMutation(OutboxMutationSchema.parse(mutation));
      outboxMap.set(validated.client_mutation_id, validated);
    },

    async updateOutboxStatus(
      clientMutationIds: readonly string[],
      status: OutboxMutationStatus,
      lastError?: string,
    ): Promise<void> {
      for (const id of clientMutationIds) {
        const existing = outboxMap.get(id);
        if (existing !== undefined) {
          outboxMap.set(id, withUpdatedMutationStatus(existing, status, lastError));
        }
      }
    },

    async removeOutboxMutations(clientMutationIds: readonly string[]): Promise<void> {
      for (const id of clientMutationIds) {
        outboxMap.delete(id);
      }
    },

    async clearAll(): Promise<void> {
      snapshot = null;
      outboxMap.clear();
    },
  };
}

// ============================================================================
// IndexedDB Store (`clairflux_offline_v1`)
// ============================================================================

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

function openOfflineDatabase(
  idbFactory: IDBFactory,
  dbName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = idbFactory.open(dbName, CLAIRFLUX_OFFLINE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
        const outboxStore = db.createObjectStore(OUTBOX_STORE_NAME, {
          keyPath: 'client_mutation_id',
        });
        outboxStore.createIndex('createdAt', 'createdAt', { unique: false });
        outboxStore.createIndex('status', 'status', { unique: false });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to open IndexedDB ${dbName}`));
    };
  });
}

function getIndexedDbFactory(): IDBFactory | null {
  if (typeof globalThis === 'undefined' || !('indexedDB' in globalThis)) {
    return null;
  }
  const maybeIdb: unknown = Reflect.get(globalThis, 'indexedDB');
  if (
    typeof maybeIdb === 'object' &&
    maybeIdb !== null &&
    'open' in maybeIdb &&
    typeof maybeIdb.open === 'function'
  ) {
    return maybeIdb as IDBFactory;
  }
  return null;
}

export function createIndexedDbOfflineStore(
  idbFactory: IDBFactory,
  dbName: string = CLAIRFLUX_OFFLINE_DB_NAME,
): OfflineStore {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const getDb = async (): Promise<IDBDatabase> => {
    if (dbPromise === null) {
      dbPromise = openOfflineDatabase(idbFactory, dbName);
    }
    return dbPromise;
  };

  return {
    mode: 'indexeddb',

    async loadSnapshot(): Promise<ClairFluxDataset | null> {
      const db = await getDb();
      const tx = db.transaction(SNAPSHOT_STORE_NAME, 'readonly');
      const txDone = waitForTransaction(tx);
      const store = tx.objectStore(SNAPSHOT_STORE_NAME);
      const raw: unknown = await promisifyRequest(store.get(SNAPSHOT_KEY));
      await txDone;

      if (raw === undefined || raw === null) {
        return null;
      }

      const envelope = SnapshotEnvelopeSchema.safeParse(raw);
      if (envelope.success) {
        return envelope.data.dataset;
      }

      const direct = ClairFluxDatasetSchema.safeParse(raw);
      return direct.success ? direct.data : null;
    },

    async saveSnapshot(dataset: ClairFluxDataset): Promise<void> {
      const validated = ClairFluxDatasetSchema.parse(dataset);
      const db = await getDb();
      const tx = db.transaction(SNAPSHOT_STORE_NAME, 'readwrite');
      const txDone = waitForTransaction(tx);
      const store = tx.objectStore(SNAPSHOT_STORE_NAME);
      store.put({ id: SNAPSHOT_KEY, dataset: validated });
      await txDone;
    },

    async listOutbox(): Promise<readonly OutboxMutation[]> {
      const db = await getDb();
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly');
      const txDone = waitForTransaction(tx);
      const store = tx.objectStore(OUTBOX_STORE_NAME);
      const rows: unknown = await promisifyRequest(store.getAll());
      await txDone;

      if (!Array.isArray(rows)) {
        return [];
      }

      const valid: OutboxMutation[] = [];
      for (const row of rows) {
        const parsed = OutboxMutationSchema.safeParse(row);
        if (parsed.success) {
          valid.push(normalizeOutboxMutation(parsed.data));
        }
      }
      return sortOutboxChronologically(valid);
    },

    async enqueueOutbox(mutation: OutboxMutation): Promise<void> {
      const validated = normalizeOutboxMutation(OutboxMutationSchema.parse(mutation));
      const db = await getDb();
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
      const txDone = waitForTransaction(tx);
      const store = tx.objectStore(OUTBOX_STORE_NAME);
      store.put(validated);
      await txDone;
    },

    async updateOutboxStatus(
      clientMutationIds: readonly string[],
      status: OutboxMutationStatus,
      lastError?: string,
    ): Promise<void> {
      if (clientMutationIds.length === 0) {
        return;
      }
      const db = await getDb();
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
      const txDone = waitForTransaction(tx);
      const store = tx.objectStore(OUTBOX_STORE_NAME);

      for (const id of clientMutationIds) {
        const raw: unknown = await promisifyRequest(store.get(id));
        const parsed = OutboxMutationSchema.safeParse(raw);
        if (parsed.success) {
          const updated = withUpdatedMutationStatus(
            normalizeOutboxMutation(parsed.data),
            status,
            lastError,
          );
          store.put(updated);
        }
      }

      await txDone;
    },

    async removeOutboxMutations(clientMutationIds: readonly string[]): Promise<void> {
      if (clientMutationIds.length === 0) {
        return;
      }
      const db = await getDb();
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
      const txDone = waitForTransaction(tx);
      const store = tx.objectStore(OUTBOX_STORE_NAME);
      for (const id of clientMutationIds) {
        store.delete(id);
      }
      await txDone;
    },

    async clearAll(): Promise<void> {
      const db = await getDb();
      const tx = db.transaction([SNAPSHOT_STORE_NAME, OUTBOX_STORE_NAME], 'readwrite');
      const txDone = waitForTransaction(tx);
      tx.objectStore(SNAPSHOT_STORE_NAME).clear();
      tx.objectStore(OUTBOX_STORE_NAME).clear();
      await txDone;
    },
  };
}

export function createOfflineStore(
  dbName: string = CLAIRFLUX_OFFLINE_DB_NAME,
): OfflineStore {
  const idbFactory = getIndexedDbFactory();
  if (idbFactory === null) {
    return createMemoryOfflineStore();
  }
  return createIndexedDbOfflineStore(idbFactory, dbName);
}
