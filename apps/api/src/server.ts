import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { z } from 'zod';
import {
  ALLOWED_DRIVE_FOLDERS,
  AiCategorizationRunSchema,
  AiReviewItemSchema,
  AiRuleSuggestionSchema,
  CLAIRFLUX_BUILD_VERSION,
  UNCATEGORIZED_CATEGORY_ID,
  convertToEurCents,
  extractMerchantPatternForRule,
  getBankForDriveFolder,
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
  type Account,
  type AccountId,
  type AiCategorizationRun,
  type AiReviewItem,
  type AiRuleSuggestion,
  type Bank,
  type Category,
  type CategoryId,
  type Currency,
  type DeltaSyncResponse,
  type RuleId,
  type SyncRevision,
  type TransactionId,
} from '@clairflux/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { createApp, type AppDependencies } from './app.js';
import { EnvValidationError, parseApiEnv, type ApiEnv } from './config/env.js';
import { createNeonClients, type NeonClients } from './db/client.js';
import {
  ensureLot1CategoriesSchemaAndSeed,
  ensureLot2AiSchema,
} from './db/ensure-v2-schema.js';
import {
  accounts,
  aiCategorizationRuns,
  aiRuleSuggestions,
  appliedClientMutations,
  budgetLimits,
  categories,
  categorizationRules,
  driveFiles,
  driveSyncRuns,
  fxRates,
  pdfIngestionCheckpoints,
  transactionNotes,
  transactions,
} from './db/schema.js';
import {
  ApkStatusSchema,
  computeAnalyticsOverview,
  computeBudgetAlert,
  computeRuleReapplication,
  isSafeRegexPattern,
  type AiBackfillDispatcher,
  type AiCategorizationRepository,
  type AnalyticsAccountInput,
  type AnalyticsTransactionInput,
  type ApkArtifactRepository,
  type ApkStatus,
  type BudgetItem,
  type CategoriesRepository,
  type CategoryView,
  type DeltaMutationRepository,
  type OutboxMutation,
  type OutboxMutationOutcome,
  type PatchTransactionResult,
  type PostSyncDeltaResponse,
  type PutBudgetInput,
  type RuleEvalRule,
  type RuleEvalTransaction,
  type RuleView,
  type SessionRepository,
  type TransactionDetail,
  type TransactionPatchInput,
} from './routes/contracts.js';

const DEFAULT_USD_TO_EUR_MICRO = 924_500;

const InternalWorkerTokenEnvSchema = z.object({
  INTERNAL_WORKER_TOKEN: z
    .string({ required_error: 'INTERNAL_WORKER_TOKEN est requis.' })
    .trim()
    .min(16, 'INTERNAL_WORKER_TOKEN doit contenir au moins 16 caractères.'),
});

export function parseInternalWorkerToken(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const parsed = InternalWorkerTokenEnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'INTERNAL_WORKER_TOKEN',
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }
  return parsed.data.INTERNAL_WORKER_TOKEN;
}

const MaxRevRowSchema = z.object({
  max_rev: z.union([z.number(), z.string()]).transform((value) => Number(value)),
});

const NextRevRowSchema = z.object({
  next_rev: z.union([z.number(), z.string()]).transform((value) => Number(value)),
});

async function fetchLatestUsdToEurMicro(clients: NeonClients): Promise<number> {
  const rows = await clients.httpDb
    .select({ rateMicro: fxRates.rateMicro })
    .from(fxRates)
    .where(and(eq(fxRates.baseCurrency, 'USD'), eq(fxRates.quoteCurrency, 'EUR')))
    .orderBy(desc(fxRates.rateDate))
    .limit(1);

  return rows[0]?.rateMicro ?? DEFAULT_USD_TO_EUR_MICRO;
}

async function fetchLatestSyncRevision(clients: NeonClients): Promise<SyncRevision> {
  const rows = await clients.httpDb.execute(
    sql`SELECT GREATEST(
      COALESCE((SELECT MAX(revision) FROM accounts), 0),
      COALESCE((SELECT MAX(revision) FROM categories), 0),
      COALESCE((SELECT MAX(revision) FROM transactions), 0),
      COALESCE((SELECT MAX(revision) FROM transaction_notes), 0),
      COALESCE((SELECT MAX(revision) FROM categorization_rules), 0),
      COALESCE((SELECT MAX(revision) FROM ai_rule_suggestions), 0),
      COALESCE((SELECT MAX(revision) FROM budget_limits), 0),
      COALESCE((SELECT MAX(revision) FROM drive_files), 0),
      COALESCE((SELECT MAX(revision) FROM drive_sync_runs), 0)
    )::bigint AS max_rev`,
  );
  const parsed = MaxRevRowSchema.safeParse(rows.rows[0]);
  const rawRev = parsed.success ? parsed.data.max_rev : 0;
  return toSyncRevision(Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0);
}

type NeonTx = Parameters<Parameters<NeonClients['poolDb']['transaction']>[0]>[0];

async function allocateNextRevision(tx: NeonTx): Promise<SyncRevision> {
  const result = await tx.execute(sql`SELECT nextval('sync_revision_seq')::bigint AS next_rev`);
  const parsed = NextRevRowSchema.safeParse(result.rows[0]);
  const rev = parsed.success ? parsed.data.next_rev : 1;
  return toSyncRevision(Number.isSafeInteger(rev) && rev >= 0 ? rev : 1);
}

// ============================================================================
// Outbox Idempotency (Canonical Payload SHA-256 + SQL Persistence)
// ============================================================================

export interface AppliedClientMutationRecord {
  readonly clientMutationId: string;
  readonly payloadHash: string;
  readonly appliedAt: Date;
  readonly resultStatus: string;
  readonly resultRevision: number;
}

export interface OutboxMutationPersistence {
  findAppliedMutation(clientMutationId: string): Promise<AppliedClientMutationRecord | null>;
  applyAndRecordMutation(params: {
    readonly mutation: OutboxMutation;
    readonly payloadHash: string;
  }): Promise<
    | { readonly kind: 'applied'; readonly revision: SyncRevision }
    | { readonly kind: 'duplicate'; readonly revision: SyncRevision }
    | { readonly kind: 'not_found' }
    | { readonly kind: 'conflict' }
  >;
  getLatestRevision(): Promise<SyncRevision>;
}

export function computeCanonicalMutationPayloadHash(mutation: OutboxMutation): string {
  const canonicalPayload = (() => {
    switch (mutation.kind) {
      case 'upsert_note':
        return {
          kind: mutation.kind,
          transaction_id: mutation.transaction_id,
          note: mutation.note,
        };
      case 'set_category':
        return {
          kind: mutation.kind,
          transaction_id: mutation.transaction_id,
          category: mutation.category,
          ...(mutation.category_id !== undefined ? { category_id: mutation.category_id } : {}),
          ...(mutation.subcategory_id !== undefined
            ? { subcategory_id: mutation.subcategory_id }
            : {}),
        };
      case 'set_internal_transfer':
        return {
          kind: mutation.kind,
          transaction_id: mutation.transaction_id,
          is_internal_transfer: mutation.is_internal_transfer,
        };
    }
  })();

  return createHash('sha256')
    .update(JSON.stringify(canonicalPayload), 'utf8')
    .digest('hex');
}

export function createIdempotentDeltaMutationRepository(
  persistence: OutboxMutationPersistence,
): DeltaMutationRepository {
  return {
    async applyOutboxBatch(mutations): Promise<PostSyncDeltaResponse> {
      const results: OutboxMutationOutcome[] = [];
      let latestRev = await persistence.getLatestRevision();

      for (const mutation of mutations) {
        const payloadHash = computeCanonicalMutationPayloadHash(mutation);
        const existing = await persistence.findAppliedMutation(mutation.client_mutation_id);
        if (existing !== null) {
          if (existing.payloadHash !== payloadHash) {
            results.push({
              client_mutation_id: mutation.client_mutation_id,
              status: 'rejected',
              reason: 'CONFLICT',
              message: 'client_mutation_id déjà enregistré avec un payload différent.',
            });
            continue;
          }
          const existingRev = toSyncRevision(existing.resultRevision);
          latestRev = toSyncRevision(Math.max(latestRev, existingRev));
          results.push({
            client_mutation_id: mutation.client_mutation_id,
            status: 'duplicate',
            revision: existingRev,
          });
          continue;
        }

        const applied = await persistence.applyAndRecordMutation({ mutation, payloadHash });
        switch (applied.kind) {
          case 'applied':
            latestRev = toSyncRevision(Math.max(latestRev, applied.revision));
            results.push({
              client_mutation_id: mutation.client_mutation_id,
              status: 'applied',
              revision: applied.revision,
            });
            break;
          case 'duplicate':
            latestRev = toSyncRevision(Math.max(latestRev, applied.revision));
            results.push({
              client_mutation_id: mutation.client_mutation_id,
              status: 'duplicate',
              revision: applied.revision,
            });
            break;
          case 'not_found':
            results.push({
              client_mutation_id: mutation.client_mutation_id,
              status: 'rejected',
              reason: 'RESOURCE_NOT_FOUND',
              message: 'Transaction introuvable.',
            });
            break;
          case 'conflict':
            results.push({
              client_mutation_id: mutation.client_mutation_id,
              status: 'rejected',
              reason: 'CONFLICT',
              message: 'client_mutation_id déjà enregistré avec un payload différent.',
            });
            break;
        }
      }

      return {
        results,
        latest_revision: latestRev,
      };
    },
  };
}

// ============================================================================
// Filesystem Android APK Artifact Repository
// ============================================================================

const DEFAULT_APK_PATH = '/shared-apk/clairflux-release.apk';
const DEFAULT_APK_VERSION = CLAIRFLUX_BUILD_VERSION;
const APK_DOWNLOAD_FILENAME = 'clairflux-release.apk';

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('end', () => {
      resolveHash(hash.digest('hex'));
    });
    stream.on('error', rejectHash);
  });
}

async function resolveApkSha256(apkPath: string): Promise<string> {
  try {
    const sidecarRaw = await readFile(`${apkPath}.sha256`, 'utf8');
    const match = /^([a-f0-9]{64})(?:\s|$)/i.exec(sidecarRaw.trim());
    if (match !== null && match[1] !== undefined) {
      return match[1].toLowerCase();
    }
  } catch {
    // Sidecar missing or unreadable: fall back to streaming SHA-256 of the APK file
  }
  return computeFileSha256(apkPath);
}

export function createFilesystemApkRepository(
  apkPath: string = process.env['APK_OUTPUT_PATH']?.trim() || DEFAULT_APK_PATH,
  version: string = process.env['CLAIRFLUX_APP_VERSION']?.trim() || DEFAULT_APK_VERSION,
): ApkArtifactRepository {
  const unavailableStatus = (): ApkStatus => ({
    available: false,
    version,
    sizeBytes: null,
    sha256: null,
    builtAt: null,
  });

  return {
    async getStatus(): Promise<ApkStatus> {
      try {
        const fileStat = await stat(apkPath);
        if (!fileStat.isFile()) {
          return unavailableStatus();
        }
        const sha256 = await resolveApkSha256(apkPath);
        return ApkStatusSchema.parse({
          available: true,
          version,
          sizeBytes: fileStat.size,
          sha256,
          builtAt: fileStat.mtime.toISOString(),
        });
      } catch {
        return unavailableStatus();
      }
    },

    async readBinary() {
      try {
        const fileStat = await stat(apkPath);
        if (!fileStat.isFile()) {
          return null;
        }
        const buf = await readFile(apkPath);
        return {
          bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          sizeBytes: buf.byteLength,
          filename: APK_DOWNLOAD_FILENAME,
        };
      } catch {
        return null;
      }
    },
  };
}

function mapAccountRow(row: typeof accounts.$inferSelect, usdRateMicro: number): Account {
  const nativeBalance = toCents(row.currentBalanceCents);
  const eurBalance =
    row.currency === 'EUR'
      ? nativeBalance
      : convertToEurCents(nativeBalance, toFxRateMicro(usdRateMicro));

  return {
    id: parseAccountId(row.id),
    bank: row.bank,
    account_type: row.accountType,
    nickname: row.nickname,
    external_ref_masked: row.externalRefMasked,
    currency: row.currency,
    current_balance_cents: nativeBalance,
    current_balance_eur_cents: eurBalance,
    balance_updated_at: row.balanceUpdatedAt !== null ? row.balanceUpdatedAt.toISOString() : null,
    revision: toSyncRevision(row.revision),
    updated_at: row.updatedAt.toISOString(),
  };
}

class ConcurrentMutationConflictError extends Error {
  public constructor() {
    super('Concurrent client_mutation_id conflict');
    this.name = 'ConcurrentMutationConflictError';
  }
}

export function createInMemorySessionRepository(): SessionRepository {
  const revokedJtis = new Set<string>();
  let revokedBeforeEpochSeconds: number | null = null;

  return {
    async isSessionRevoked(jti: string, iat?: number): Promise<boolean> {
      if (revokedJtis.has(jti)) {
        return true;
      }
      if (
        revokedBeforeEpochSeconds !== null &&
        iat !== undefined &&
        iat <= revokedBeforeEpochSeconds
      ) {
        return true;
      }
      return false;
    },
    async revokeSession(jti: string): Promise<void> {
      revokedJtis.add(jti);
    },
    async revokeAllSessions(beforeEpochSeconds: number): Promise<void> {
      revokedBeforeEpochSeconds =
        revokedBeforeEpochSeconds === null
          ? beforeEpochSeconds
          : Math.max(revokedBeforeEpochSeconds, beforeEpochSeconds);
    },
  };
}

const WorkerActiveRunResponseSchema = z.object({
  active_run_id: z.string().uuid().nullable(),
});

const WorkerConflictResponseSchema = z.object({
  error: z
    .object({
      details: z
        .object({
          active_run_id: z.string().uuid().optional(),
        })
        .optional(),
    })
    .optional(),
});

const ORPHAN_RUN_GRACE_MS = 5_000;
const WORKER_UNREACHABLE_STALE_MS = 300_000;
const WORKER_CONTROL_TIMEOUT_MS = 3_000;

export interface DriveSyncRunStore {
  findActiveRunningRuns(): Promise<ReadonlyArray<{ readonly id: string; readonly startedAt: Date }>>;
  createRunningRun(): Promise<{ readonly id: string; readonly startedAt: Date } | null>;
  markRunFailed(runId: string, summary: string): Promise<void>;
}

export function createResilientDriveSyncService(options: {
  readonly store: DriveSyncRunStore;
  readonly syncWorkerUrl: string;
  readonly internalWorkerToken: string;
  readonly fetchFn?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
}): AppDependencies['driveSyncService'] {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const getNow = options.now ?? (() => new Date());

  async function probeWorkerActiveRunId(): Promise<
    { readonly ok: true; readonly activeRunId: string | null } | { readonly ok: false }
  > {
    try {
      const res = await fetchFn(`${options.syncWorkerUrl}/internal/runs/active`, {
        method: 'GET',
        headers: {
          'X-Internal-Worker-Token': options.internalWorkerToken,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(WORKER_CONTROL_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false };
      }
      const parsed = WorkerActiveRunResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        return { ok: false };
      }
      return { ok: true, activeRunId: parsed.data.active_run_id };
    } catch {
      return { ok: false };
    }
  }

  return {
    async triggerManualSync() {
      const runningRows = await options.store.findActiveRunningRuns();
      const firstActive = runningRows[0];

      if (firstActive !== undefined) {
        const probe = await probeWorkerActiveRunId();
        const nowMs = getNow().getTime();

        if (probe.ok) {
          if (probe.activeRunId !== null) {
            return {
              ok: false,
              reason: 'already_running',
              activeRunId: probe.activeRunId,
            };
          }

          const stillInGrace = runningRows.find(
            (row) => nowMs - row.startedAt.getTime() < ORPHAN_RUN_GRACE_MS,
          );
          if (stillInGrace !== undefined) {
            return {
              ok: false,
              reason: 'already_running',
              activeRunId: stillInGrace.id,
            };
          }

          for (const orphan of runningRows) {
            await options.store.markRunFailed(
              orphan.id,
              'Synchronisation précédente interrompue (aucun traitement actif dans sync-worker).',
            );
          }
        } else if (nowMs - firstActive.startedAt.getTime() < WORKER_UNREACHABLE_STALE_MS) {
          return {
            ok: false,
            reason: 'already_running',
            activeRunId: firstActive.id,
          };
        } else {
          return {
            ok: false,
            reason: 'upstream_error',
            message:
              'Le service sync-worker est injoignable pour vérifier la synchronisation précédente.',
          };
        }
      }

      const createdRun = await options.store.createRunningRun();
      if (createdRun === null) {
        return {
          ok: false,
          reason: 'upstream_error',
          message: 'Impossible de créer le run de synchronisation Drive.',
        };
      }

      const safeMarkFailed = async (summary: string): Promise<void> => {
        try {
          await options.store.markRunFailed(createdRun.id, summary);
        } catch {
          // Best-effort cleanup so failed worker dispatch does not swallow the primary error
        }
      };

      try {
        const response = await fetchFn(`${options.syncWorkerUrl}/internal/runs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Worker-Token': options.internalWorkerToken,
          },
          body: JSON.stringify({ run_id: createdRun.id }),
        });

        if (response.status === 409) {
          let activeRunId = createdRun.id;
          try {
            const parsedConflict = WorkerConflictResponseSchema.safeParse(await response.json());
            if (parsedConflict.success && parsedConflict.data.error?.details?.active_run_id) {
              activeRunId = parsedConflict.data.error.details.active_run_id;
            }
          } catch {
            // Keep createdRun.id fallback
          }
          await safeMarkFailed('Synchronisation déjà active côté sync-worker (HTTP 409).');
          return {
            ok: false,
            reason: 'already_running',
            activeRunId,
          };
        }

        if (!response.ok) {
          const message = `Le sync-worker a répondu avec le statut HTTP ${response.status}.`;
          await safeMarkFailed(message);
          return {
            ok: false,
            reason: 'upstream_error',
            message,
          };
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Erreur de communication avec sync-worker.';
        await safeMarkFailed(message);
        return {
          ok: false,
          reason: 'upstream_error',
          message,
        };
      }

      return {
        ok: true,
        run: {
          id: createdRun.id,
          status: 'running',
          trigger_mode: 'manual',
          allowed_folders: [
            { folder_id: ALLOWED_DRIVE_FOLDERS.boursobank, bank: 'boursobank' as Bank },
            { folder_id: ALLOWED_DRIVE_FOLDERS.revolut, bank: 'revolut' as Bank },
          ],
          started_at: createdRun.startedAt.toISOString(),
        },
      };
    },
  };
}

const WorkerAiBackfillAcceptedSchema = z.object({
  run_id: z.string().uuid(),
  status: z.literal('running'),
  accepted_at: z.string().datetime({ offset: true }),
});

const WorkerAiCancelResponseSchema = z.object({
  run_id: z.string().uuid(),
  status: z.enum(['cancelling', 'cancelled']),
  cancelled_at: z.string().datetime({ offset: true }),
});

export interface AiBackfillRunStore {
  findActiveRunningRuns(): Promise<ReadonlyArray<{ readonly id: string; readonly startedAt: Date }>>;
  markRunFailed(runId: string, summary: string): Promise<void>;
  markRunCancelled(runId: string): Promise<void>;
}

export function createHttpAiBackfillDispatcher(options: {
  readonly syncWorkerUrl: string;
  readonly internalWorkerToken: string;
  readonly store?: AiBackfillRunStore | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
}): AiBackfillDispatcher {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const getNow = options.now ?? (() => new Date());

  async function probeActiveWorkerAiRun(): Promise<
    { readonly ok: true; readonly activeRunId: string | null } | { readonly ok: false }
  > {
    try {
      const res = await fetchFn(`${options.syncWorkerUrl}/internal/ai/categorize/active`, {
        method: 'GET',
        headers: {
          'X-Internal-Worker-Token': options.internalWorkerToken,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(WORKER_CONTROL_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false };
      }
      const parsed = WorkerActiveRunResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        return { ok: false };
      }
      return { ok: true, activeRunId: parsed.data.active_run_id };
    } catch {
      return { ok: false };
    }
  }

  return {
    async triggerBackfill(input) {
      if (options.store !== undefined) {
        const runningRows = await options.store.findActiveRunningRuns();
        const firstActive = runningRows[0];
        if (firstActive !== undefined) {
          const probe = await probeActiveWorkerAiRun();
          const nowMs = getNow().getTime();
          if (probe.ok) {
            if (probe.activeRunId !== null) {
              return {
                ok: false,
                reason: 'already_running',
                activeRunId: probe.activeRunId,
              };
            }
            const inGrace = runningRows.find(
              (row) => nowMs - row.startedAt.getTime() < ORPHAN_RUN_GRACE_MS,
            );
            if (inGrace !== undefined) {
              return {
                ok: false,
                reason: 'already_running',
                activeRunId: inGrace.id,
              };
            }
            for (const orphan of runningRows) {
              await options.store.markRunFailed(
                orphan.id,
                'Lot IA précédent interrompu (aucun traitement actif dans sync-worker).',
              );
            }
          } else if (nowMs - firstActive.startedAt.getTime() < WORKER_UNREACHABLE_STALE_MS) {
            return {
              ok: false,
              reason: 'already_running',
              activeRunId: firstActive.id,
            };
          } else {
            return {
              ok: false,
              reason: 'worker_unavailable',
              message: 'Le service sync-worker est injoignable pour lancer le rattrapage IA.',
            };
          }
        }
      }

      try {
        const response = await fetchFn(`${options.syncWorkerUrl}/internal/ai/categorize/backfill`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Worker-Token': options.internalWorkerToken,
          },
          body: JSON.stringify({
            triggerSource: 'manual_backfill',
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          }),
          signal: AbortSignal.timeout(WORKER_CONTROL_TIMEOUT_MS),
        });

        if (response.status === 409) {
          let activeRunId = '00000000-0000-4000-8000-000000000000';
          try {
            const parsedConflict = WorkerConflictResponseSchema.safeParse(await response.json());
            if (parsedConflict.success && parsedConflict.data.error?.details?.active_run_id) {
              activeRunId = parsedConflict.data.error.details.active_run_id;
            }
          } catch {
            // Keep fallback activeRunId
          }
          return { ok: false, reason: 'already_running', activeRunId };
        }

        if (!response.ok) {
          return {
            ok: false,
            reason: 'worker_unavailable',
            message: `Le sync-worker IA a répondu avec le statut HTTP ${response.status}.`,
          };
        }

        const parsedAccepted = WorkerAiBackfillAcceptedSchema.safeParse(await response.json());
        if (!parsedAccepted.success) {
          return {
            ok: false,
            reason: 'worker_unavailable',
            message: 'Réponse invalide du sync-worker lors du lancement IA.',
          };
        }

        return {
          ok: true,
          run_id: parsedAccepted.data.run_id,
          status: parsedAccepted.data.status,
          accepted_at: parsedAccepted.data.accepted_at,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Erreur de communication avec sync-worker IA.';
        return {
          ok: false,
          reason: 'worker_unavailable',
          message,
        };
      }
    },

    async cancelBackfill(input) {
      try {
        const response = await fetchFn(`${options.syncWorkerUrl}/internal/ai/categorize/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Worker-Token': options.internalWorkerToken,
          },
          body: JSON.stringify({
            ...(input.run_id !== undefined ? { run_id: input.run_id } : {}),
          }),
          signal: AbortSignal.timeout(WORKER_CONTROL_TIMEOUT_MS),
        });

        if (response.status === 409) {
          return {
            ok: false,
            reason: 'not_running',
            message: 'Aucun traitement de catégorisation IA actif à annuler.',
          };
        }

        if (response.ok) {
          const parsedCancel = WorkerAiCancelResponseSchema.safeParse(await response.json());
          if (parsedCancel.success) {
            return {
              ok: true,
              run_id: parsedCancel.data.run_id,
              status: parsedCancel.data.status,
              cancelled_at: parsedCancel.data.cancelled_at,
            };
          }
        }
      } catch {
        // Fallback to DB cancellation below if store has an active run
      }

      if (options.store !== undefined) {
        const activeRuns = await options.store.findActiveRunningRuns();
        const target =
          input.run_id !== undefined
            ? activeRuns.find((row) => row.id === input.run_id)
            : activeRuns[0];
        if (target !== undefined) {
          await options.store.markRunCancelled(target.id);
          return {
            ok: true,
            run_id: target.id,
            status: 'cancelled',
            cancelled_at: getNow().toISOString(),
          };
        }
      }

      return {
        ok: false,
        reason: 'worker_unavailable',
        message: 'Le service sync-worker est injoignable pour annuler le traitement IA.',
      };
    },
  };
}

export function createNeonAppDependencies(
  env: ApiEnv,
  clients: NeonClients,
  internalWorkerToken: string = parseInternalWorkerToken(),
  apkRepository: ApkArtifactRepository = createFilesystemApkRepository(),
): AppDependencies & { readonly apk: ApkArtifactRepository } {
  const healthRepository: AppDependencies['healthRepository'] = {
    async ping(): Promise<boolean> {
      try {
        await clients.httpDb.execute(sql`SELECT 1`);
        return true;
      } catch {
        return false;
      }
    },
  };

  const accountsRepository: AppDependencies['accountsRepository'] = {
    async listAccounts(filter) {
      const conditions = [isNull(accounts.deletedAt)];
      if (filter.bank !== undefined) {
        conditions.push(eq(accounts.bank, filter.bank));
      }
      if (filter.currency !== undefined) {
        conditions.push(eq(accounts.currency, filter.currency));
      }

      const [rows, usdRateMicro, latestRevision] = await Promise.all([
        clients.httpDb
          .select()
          .from(accounts)
          .where(and(...conditions))
          .orderBy(asc(accounts.bank), asc(accounts.nickname)),
        fetchLatestUsdToEurMicro(clients),
        fetchLatestSyncRevision(clients),
      ]);

      return {
        accounts: rows.map((row) => mapAccountRow(row, usdRateMicro)),
        latest_revision: latestRevision,
      };
    },
  };

  async function resolveCategoryDualWriteInTx(
    tx: NeonTx,
    input: {
      readonly categoryId?: CategoryId | null | undefined;
      readonly subcategoryId?: CategoryId | null | undefined;
      readonly categoryLabel?: string | undefined;
    },
  ): Promise<{
    readonly categoryId: CategoryId | null;
    readonly subcategoryId: CategoryId | null;
    readonly label: string;
  }> {
    if (input.subcategoryId !== undefined && input.subcategoryId !== null) {
      const subRows = await tx
        .select()
        .from(categories)
        .where(and(eq(categories.id, input.subcategoryId), isNull(categories.deletedAt)))
        .limit(1);
      const sub = subRows[0];
      if (sub !== undefined) {
        const resolvedCatId =
          sub.parentId !== null
            ? parseCategoryId(sub.parentId)
            : input.categoryId !== undefined && input.categoryId !== null
              ? input.categoryId
              : parseCategoryId(sub.id);
        return {
          categoryId: resolvedCatId,
          subcategoryId: sub.parentId !== null ? parseCategoryId(sub.id) : null,
          label: input.categoryLabel?.trim() || sub.name,
        };
      }
    }

    if (input.categoryId !== undefined && input.categoryId !== null) {
      const catRows = await tx
        .select()
        .from(categories)
        .where(and(eq(categories.id, input.categoryId), isNull(categories.deletedAt)))
        .limit(1);
      const cat = catRows[0];
      if (cat !== undefined) {
        if (cat.parentId !== null) {
          return {
            categoryId: parseCategoryId(cat.parentId),
            subcategoryId: parseCategoryId(cat.id),
            label: input.categoryLabel?.trim() || cat.name,
          };
        }
        return {
          categoryId: parseCategoryId(cat.id),
          subcategoryId: null,
          label: input.categoryLabel?.trim() || cat.name,
        };
      }
    }

    if (input.categoryId === null) {
      return {
        categoryId: null,
        subcategoryId: null,
        label: input.categoryLabel?.trim() || 'Non catégorisé',
      };
    }

    const trimmedLabel = input.categoryLabel?.trim();
    if (trimmedLabel !== undefined && trimmedLabel.length > 0) {
      const matchingRows = await tx
        .select()
        .from(categories)
        .where(
          and(
            isNull(categories.deletedAt),
            sql`lower(trim(${categories.name})) = lower(trim(${trimmedLabel}))`,
          ),
        )
        .orderBy(asc(categories.sortOrder))
        .limit(5);
      const match = matchingRows.find((r) => r.parentId === null) ?? matchingRows[0];
      if (match !== undefined) {
        if (match.parentId !== null) {
          return {
            categoryId: parseCategoryId(match.parentId),
            subcategoryId: parseCategoryId(match.id),
            label: trimmedLabel,
          };
        }
        return {
          categoryId: parseCategoryId(match.id),
          subcategoryId: null,
          label: trimmedLabel,
        };
      }
      return {
        categoryId: null,
        subcategoryId: null,
        label: trimmedLabel,
      };
    }

    return {
      categoryId: UNCATEGORIZED_CATEGORY_ID,
      subcategoryId: null,
      label: 'Non catégorisé',
    };
  }

  async function patchTransactionInTx(
    tx: NeonTx,
    id: TransactionId,
    patch: TransactionPatchInput,
  ): Promise<PatchTransactionResult> {
    const existingRows = await tx
      .select({
        txRow: transactions,
        account: accounts,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
      .limit(1);

    const existing = existingRows[0];
    if (existing === undefined) {
      return { ok: false, reason: 'not_found' };
    }

    const now = new Date();
    let highestRevision = await allocateNextRevision(tx);

    const updatePayload: Partial<typeof transactions.$inferInsert> = {
      updatedAt: now,
      revision: highestRevision,
    };

    if (
      patch.category !== undefined ||
      patch.category_id !== undefined ||
      patch.subcategory_id !== undefined
    ) {
      const resolved = await resolveCategoryDualWriteInTx(tx, {
        categoryId: patch.category_id,
        subcategoryId: patch.subcategory_id,
        categoryLabel: patch.category,
      });
      updatePayload.category = resolved.label;
      updatePayload.categoryId = resolved.categoryId;
      updatePayload.subcategoryId = resolved.subcategoryId;
      updatePayload.categorySource = 'manual';
      updatePayload.isManualCategory = true;
      updatePayload.matchedRuleId = null;
    } else if (patch.is_manual_category !== undefined) {
      updatePayload.isManualCategory = patch.is_manual_category;
    }

    if (patch.is_internal_transfer !== undefined) {
      updatePayload.isInternalTransfer = patch.is_internal_transfer;
      updatePayload.isManualTransferOverride = true;
      if (!patch.is_internal_transfer) {
        updatePayload.transferGroupId = null;
      }
    }

    const [updatedTx] = await tx
      .update(transactions)
      .set(updatePayload)
      .where(eq(transactions.id, id))
      .returning();

    if (updatedTx === undefined) {
      return { ok: false, reason: 'not_found' };
    }

    let noteView: { content: string; updated_at: string } | null = null;
    if (patch.note !== undefined) {
      const noteRev = await allocateNextRevision(tx);
      highestRevision = noteRev;
      if (patch.note === null) {
        await tx
          .update(transactionNotes)
          .set({ deletedAt: now, updatedAt: now, revision: noteRev })
          .where(eq(transactionNotes.transactionId, id));
        noteView = null;
      } else {
        const [upsertedNote] = await tx
          .insert(transactionNotes)
          .values({
            transactionId: id,
            content: patch.note,
            revision: noteRev,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoUpdate({
            target: transactionNotes.transactionId,
            set: {
              content: patch.note,
              revision: noteRev,
              updatedAt: now,
              deletedAt: null,
            },
          })
          .returning();
        if (upsertedNote !== undefined) {
          noteView = {
            content: upsertedNote.content,
            updated_at: upsertedNote.updatedAt.toISOString(),
          };
        }
      }
    } else {
      const currentNoteRows = await tx
        .select()
        .from(transactionNotes)
        .where(and(eq(transactionNotes.transactionId, id), isNull(transactionNotes.deletedAt)))
        .limit(1);
      const currentNote = currentNoteRows[0];
      if (currentNote !== undefined) {
        noteView = {
          content: currentNote.content,
          updated_at: currentNote.updatedAt.toISOString(),
        };
      }
    }

    const detail: TransactionDetail = {
      id: parseTransactionId(updatedTx.id),
      account_id: parseAccountId(updatedTx.accountId),
      bank: existing.account.bank,
      account_type: existing.account.accountType,
      account_nickname: existing.account.nickname,
      external_ref_masked: existing.account.externalRefMasked,
      booking_date: updatedTx.bookingDate,
      value_date: updatedTx.valueDate,
      raw_label: updatedTx.rawLabel,
      clean_label: updatedTx.cleanLabel,
      amount_cents: toCents(updatedTx.amountCents),
      currency: updatedTx.currency,
      fx_rate_micro: toFxRateMicro(updatedTx.fxRateMicro),
      amount_eur_cents: toCents(updatedTx.amountEurCents),
      category: updatedTx.category,
      category_id: updatedTx.categoryId !== null ? parseCategoryId(updatedTx.categoryId) : null,
      subcategory_id:
        updatedTx.subcategoryId !== null ? parseCategoryId(updatedTx.subcategoryId) : null,
      category_source: updatedTx.categorySource,
      ai_review_status: updatedTx.aiReviewStatus,
      is_manual_category: updatedTx.isManualCategory,
      matched_rule_id:
        updatedTx.matchedRuleId !== null ? parseRuleId(updatedTx.matchedRuleId) : null,
      is_internal_transfer: updatedTx.isInternalTransfer,
      is_manual_transfer_override: updatedTx.isManualTransferOverride,
      transfer_group_id: updatedTx.transferGroupId,
      source_drive_file_id: updatedTx.sourceDriveFileId,
      note: noteView,
      revision: toSyncRevision(updatedTx.revision),
      updated_at: updatedTx.updatedAt.toISOString(),
    };

    return {
      ok: true,
      transaction: detail,
      latest_revision: highestRevision,
    };
  }

  const transactionsRepository: NonNullable<AppDependencies['transactionsRepository']> = {
    async listTransactions(filter) {
      const conditions = [isNull(transactions.deletedAt), isNull(accounts.deletedAt)];

      if (filter.bank !== undefined) {
        conditions.push(eq(accounts.bank, filter.bank));
      }
      if (filter.account_id !== undefined) {
        conditions.push(eq(transactions.accountId, filter.account_id));
      }
      if (filter.currency !== undefined) {
        conditions.push(eq(transactions.currency, filter.currency));
      }
      if (filter.from !== undefined) {
        conditions.push(gte(transactions.bookingDate, filter.from));
      }
      if (filter.to !== undefined) {
        conditions.push(lte(transactions.bookingDate, filter.to));
      }
      if (filter.has_notes === true) {
        const hasNoteCond = and(
          isNotNull(transactionNotes.id),
          isNull(transactionNotes.deletedAt),
        );
        if (hasNoteCond !== undefined) {
          conditions.push(hasNoteCond);
        }
      } else if (filter.has_notes === false) {
        const noNoteCond = or(
          isNull(transactionNotes.id),
          isNotNull(transactionNotes.deletedAt),
        );
        if (noNoteCond !== undefined) {
          conditions.push(noNoteCond);
        }
      }
      if (filter.search !== undefined) {
        const pattern = `%${filter.search}%`;
        const searchCond = or(
          ilike(transactions.cleanLabel, pattern),
          ilike(transactions.rawLabel, pattern),
          ilike(transactionNotes.content, pattern),
        );
        if (searchCond !== undefined) {
          conditions.push(searchCond);
        }
      }

      const rows = await clients.httpDb
        .select({
          tx: transactions,
          account: accounts,
          note: transactionNotes,
        })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .leftJoin(
          transactionNotes,
          and(
            eq(transactionNotes.transactionId, transactions.id),
            isNull(transactionNotes.deletedAt),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(transactions.bookingDate), desc(transactions.revision))
        .limit(filter.limit);

      const latestRevision = await fetchLatestSyncRevision(clients);

      const items: TransactionDetail[] = rows.map(({ tx, account, note }) => ({
        id: parseTransactionId(tx.id),
        account_id: parseAccountId(tx.accountId),
        bank: account.bank,
        account_type: account.accountType,
        account_nickname: account.nickname,
        external_ref_masked: account.externalRefMasked,
        booking_date: tx.bookingDate,
        value_date: tx.valueDate,
        raw_label: tx.rawLabel,
        clean_label: tx.cleanLabel,
        amount_cents: toCents(tx.amountCents),
        currency: tx.currency,
        fx_rate_micro: toFxRateMicro(tx.fxRateMicro),
        amount_eur_cents: toCents(tx.amountEurCents),
        category: tx.category,
        category_id: tx.categoryId !== null ? parseCategoryId(tx.categoryId) : null,
        subcategory_id: tx.subcategoryId !== null ? parseCategoryId(tx.subcategoryId) : null,
        category_source: tx.categorySource,
        ai_review_status: tx.aiReviewStatus,
        is_manual_category: tx.isManualCategory,
        matched_rule_id: tx.matchedRuleId !== null ? parseRuleId(tx.matchedRuleId) : null,
        is_internal_transfer: tx.isInternalTransfer,
        is_manual_transfer_override: tx.isManualTransferOverride,
        transfer_group_id: tx.transferGroupId,
        source_drive_file_id: tx.sourceDriveFileId,
        note:
          note !== null && note.deletedAt === null
            ? { content: note.content, updated_at: note.updatedAt.toISOString() }
            : null,
        revision: toSyncRevision(tx.revision),
        updated_at: tx.updatedAt.toISOString(),
      }));

      return {
        items,
        total_count: items.length,
        latest_revision: latestRevision,
      };
    },

    async patchTransaction(id, patch) {
      return clients.poolDb.transaction((tx) => patchTransactionInTx(tx, id, patch));
    },
  };

  async function runRuleRecalcInTx(
    tx: Parameters<Parameters<NeonClients['poolDb']['transaction']>[0]>[0],
    options?: { readonly protectInternalTransfers?: boolean | undefined },
  ): Promise<{ updatedCount: number; skippedProtectedCount: number; latestRevision: SyncRevision | null }> {
    const [ruleRows, txRows] = await Promise.all([
      tx
        .select()
        .from(categorizationRules)
        .where(isNull(categorizationRules.deletedAt))
        .orderBy(
          asc(categorizationRules.priority),
          asc(categorizationRules.createdAt),
          asc(categorizationRules.id),
        ),
      tx
        .select({
          tx: transactions,
          account: accounts,
        })
        .from(transactions)
        .innerJoin(accounts, eq(transactions.accountId, accounts.id))
        .where(isNull(transactions.deletedAt)),
    ]);

    const evalRules: RuleEvalRule[] = ruleRows.map((r) => ({
      id: parseRuleId(r.id),
      priority: r.priority,
      bank_filter: r.bankFilter,
      account_id_filter: r.accountIdFilter !== null ? parseAccountId(r.accountIdFilter) : null,
      account_type_filter: r.accountTypeFilter,
      match_mode: r.matchMode,
      pattern: r.pattern,
      target_category: r.targetCategory,
      target_category_id: r.targetCategoryId !== null ? parseCategoryId(r.targetCategoryId) : null,
      target_subcategory_id:
        r.targetSubcategoryId !== null ? parseCategoryId(r.targetSubcategoryId) : null,
      mark_as_internal_transfer: r.markAsInternalTransfer,
      is_active: r.isActive,
      deleted_at: r.deletedAt,
      created_at_ms: r.createdAt.getTime(),
    }));

    const evalTxs: RuleEvalTransaction[] = txRows.map(({ tx: t, account }) => ({
      id: parseTransactionId(t.id),
      account_id: parseAccountId(t.accountId),
      bank: account.bank,
      account_type: account.accountType,
      raw_label: t.rawLabel,
      clean_label: t.cleanLabel,
      category: t.category,
      matched_rule_id: t.matchedRuleId !== null ? parseRuleId(t.matchedRuleId) : null,
      is_manual_category: t.isManualCategory,
      is_internal_transfer: t.isInternalTransfer,
      is_manual_transfer_override:
        t.isManualTransferOverride ||
        (options?.protectInternalTransfers === true && t.isInternalTransfer),
      transfer_group_id: t.transferGroupId,
      deleted_at: t.deletedAt,
    }));

    const plan = computeRuleReapplication(evalRules, evalTxs);
    const now = new Date();
    let latestRevision: SyncRevision | null = null;

    for (const change of plan.changes) {
      const nextRev = await allocateNextRevision(tx);
      latestRevision = nextRev;
      const nextCategoryId =
        change.nextMatchedRuleId !== null
          ? (change.nextTargetCategoryId ?? null)
          : UNCATEGORIZED_CATEGORY_ID;
      const nextSubcategoryId =
        change.nextMatchedRuleId !== null ? (change.nextTargetSubcategoryId ?? null) : null;
      await tx
        .update(transactions)
        .set({
          category: change.nextCategory,
          categoryId: nextCategoryId,
          subcategoryId: nextSubcategoryId,
          categorySource: change.nextMatchedRuleId !== null ? 'rule' : 'uncategorized',
          matchedRuleId: change.nextMatchedRuleId,
          isInternalTransfer: change.nextIsInternalTransfer,
          revision: nextRev,
          updatedAt: now,
        })
        .where(eq(transactions.id, change.transactionId));
    }

    return {
      updatedCount: plan.changes.length,
      skippedProtectedCount: plan.skippedProtectedCount,
      latestRevision,
    };
  }

  function mapRuleView(
    row: typeof categorizationRules.$inferSelect,
    matchedCount: number,
  ): RuleView {
    return {
      id: parseRuleId(row.id),
      name: row.name,
      priority: row.priority,
      bank_filter: row.bankFilter,
      account_id_filter: row.accountIdFilter !== null ? parseAccountId(row.accountIdFilter) : null,
      account_type_filter: row.accountTypeFilter,
      match_mode: row.matchMode,
      pattern: row.pattern,
      target_category: row.targetCategory,
      target_category_id:
        row.targetCategoryId !== null ? parseCategoryId(row.targetCategoryId) : null,
      target_subcategory_id:
        row.targetSubcategoryId !== null ? parseCategoryId(row.targetSubcategoryId) : null,
      mark_as_internal_transfer: row.markAsInternalTransfer,
      is_active: row.isActive,
      matched_transactions_count: matchedCount,
      revision: toSyncRevision(row.revision),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  const rulesRepository: NonNullable<AppDependencies['rulesRepository']> = {
    async listRules() {
      const [rows, countRows, latestRevision] = await Promise.all([
        clients.httpDb
          .select()
          .from(categorizationRules)
          .where(isNull(categorizationRules.deletedAt))
          .orderBy(
            asc(categorizationRules.priority),
            asc(categorizationRules.createdAt),
            asc(categorizationRules.id),
          ),
        clients.httpDb
          .select({
            ruleId: transactions.matchedRuleId,
            count: sql<number>`count(*)::int`,
          })
          .from(transactions)
          .where(and(isNull(transactions.deletedAt), isNotNull(transactions.matchedRuleId)))
          .groupBy(transactions.matchedRuleId),
        fetchLatestSyncRevision(clients),
      ]);

      const countMap = new Map<string, number>();
      for (const cRow of countRows) {
        if (cRow.ruleId !== null) {
          countMap.set(cRow.ruleId, cRow.count);
        }
      }

      return {
        rules: rows.map((row) => mapRuleView(row, countMap.get(row.id) ?? 0)),
        latest_revision: latestRevision,
      };
    },

    async createRule(input) {
      return clients.poolDb.transaction(async (tx) => {
        const ruleRev = await allocateNextRevision(tx);
        const now = new Date();
        const resolvedTarget = await resolveCategoryDualWriteInTx(tx, {
          categoryId: input.target_category_id,
          subcategoryId: input.target_subcategory_id,
          categoryLabel: input.target_category,
        });
        const [inserted] = await tx
          .insert(categorizationRules)
          .values({
            name: input.name,
            priority: input.priority,
            bankFilter: input.bank_filter,
            accountIdFilter: input.account_id_filter,
            accountTypeFilter: input.account_type_filter,
            matchMode: input.match_mode,
            pattern: input.pattern,
            targetCategory: resolvedTarget.label,
            targetCategoryId: resolvedTarget.categoryId,
            targetSubcategoryId: resolvedTarget.subcategoryId,
            markAsInternalTransfer: input.mark_as_internal_transfer,
            isActive: input.is_active,
            revision: ruleRev,
            updatedAt: now,
          })
          .returning();

        if (inserted === undefined) {
          throw new Error('Failed to insert categorization rule');
        }

        const recalc = await runRuleRecalcInTx(tx);
        const matchedCountRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(and(eq(transactions.matchedRuleId, inserted.id), isNull(transactions.deletedAt)));

        const matchedCount = matchedCountRows[0]?.count ?? 0;

        return {
          rule: mapRuleView(inserted, matchedCount),
          retroactive_stats: {
            updated_count: recalc.updatedCount,
            skipped_protected_count: recalc.skippedProtectedCount,
          },
          latest_revision: recalc.latestRevision ?? ruleRev,
        };
      });
    },

    async updateRule(id, input) {
      return clients.poolDb.transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(categorizationRules)
          .where(and(eq(categorizationRules.id, id), isNull(categorizationRules.deletedAt)))
          .limit(1);

        const existing = existingRows[0];
        if (existing === undefined) {
          return { ok: false, reason: 'not_found' } as const;
        }

        const nextMode = input.match_mode ?? existing.matchMode;
        const nextPattern = input.pattern ?? existing.pattern;
        if (nextMode === 'regex' && !isSafeRegexPattern(nextPattern)) {
          return { ok: false, reason: 'invalid_regex' } as const;
        }

        const ruleRev = await allocateNextRevision(tx);
        const now = new Date();
        const updateSet: Partial<typeof categorizationRules.$inferInsert> = {
          revision: ruleRev,
          updatedAt: now,
        };
        if (input.name !== undefined) updateSet.name = input.name;
        if (input.priority !== undefined) updateSet.priority = input.priority;
        if (input.bank_filter !== undefined) updateSet.bankFilter = input.bank_filter;
        if (input.account_id_filter !== undefined) updateSet.accountIdFilter = input.account_id_filter;
        if (input.account_type_filter !== undefined) updateSet.accountTypeFilter = input.account_type_filter;
        if (input.match_mode !== undefined) updateSet.matchMode = input.match_mode;
        if (input.pattern !== undefined) updateSet.pattern = input.pattern;
        if (
          input.target_category !== undefined ||
          input.target_category_id !== undefined ||
          input.target_subcategory_id !== undefined
        ) {
          const resolvedTarget = await resolveCategoryDualWriteInTx(tx, {
            categoryId:
              input.target_category_id !== undefined
                ? input.target_category_id
                : existing.targetCategoryId !== null
                  ? parseCategoryId(existing.targetCategoryId)
                  : undefined,
            subcategoryId:
              input.target_subcategory_id !== undefined
                ? input.target_subcategory_id
                : existing.targetSubcategoryId !== null
                  ? parseCategoryId(existing.targetSubcategoryId)
                  : undefined,
            categoryLabel: input.target_category,
          });
          updateSet.targetCategory = resolvedTarget.label;
          updateSet.targetCategoryId = resolvedTarget.categoryId;
          updateSet.targetSubcategoryId = resolvedTarget.subcategoryId;
        }
        if (input.mark_as_internal_transfer !== undefined) {
          updateSet.markAsInternalTransfer = input.mark_as_internal_transfer;
        }
        if (input.is_active !== undefined) updateSet.isActive = input.is_active;

        const [updated] = await tx
          .update(categorizationRules)
          .set(updateSet)
          .where(eq(categorizationRules.id, id))
          .returning();

        if (updated === undefined) {
          return { ok: false, reason: 'not_found' } as const;
        }

        const recalc = await runRuleRecalcInTx(tx);
        const matchedCountRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(and(eq(transactions.matchedRuleId, updated.id), isNull(transactions.deletedAt)));

        return {
          ok: true,
          data: {
            rule: mapRuleView(updated, matchedCountRows[0]?.count ?? 0),
            retroactive_stats: {
              updated_count: recalc.updatedCount,
              skipped_protected_count: recalc.skippedProtectedCount,
            },
            latest_revision: recalc.latestRevision ?? ruleRev,
          },
        } as const;
      });
    },

    async deleteRule(id) {
      return clients.poolDb.transaction(async (tx) => {
        const delRev = await allocateNextRevision(tx);
        const now = new Date();
        const [deleted] = await tx
          .update(categorizationRules)
          .set({ deletedAt: now, updatedAt: now, revision: delRev })
          .where(and(eq(categorizationRules.id, id), isNull(categorizationRules.deletedAt)))
          .returning();

        if (deleted === undefined) {
          return { ok: false, reason: 'not_found' } as const;
        }

        const recalc = await runRuleRecalcInTx(tx);

        return {
          ok: true,
          data: {
            deleted_rule_id: parseRuleId(deleted.id),
            retroactive_stats: {
              updated_count: recalc.updatedCount,
              skipped_protected_count: recalc.skippedProtectedCount,
            },
            latest_revision: recalc.latestRevision ?? delRev,
          },
        } as const;
      });
    },

    async reorderRules(items) {
      return clients.poolDb.transaction(async (tx) => {
        const now = new Date();
        let latestRevision = await allocateNextRevision(tx);

        for (const item of items) {
          const rev = await allocateNextRevision(tx);
          latestRevision = rev;
          await tx
            .update(categorizationRules)
            .set({ priority: item.priority, revision: rev, updatedAt: now })
            .where(and(eq(categorizationRules.id, item.id), isNull(categorizationRules.deletedAt)));
        }

        const recalc = await runRuleRecalcInTx(tx);
        const [rows, countRows] = await Promise.all([
          tx
            .select()
            .from(categorizationRules)
            .where(isNull(categorizationRules.deletedAt))
            .orderBy(asc(categorizationRules.priority), asc(categorizationRules.createdAt)),
          tx
            .select({
              ruleId: transactions.matchedRuleId,
              count: sql<number>`count(*)::int`,
            })
            .from(transactions)
            .where(and(isNull(transactions.deletedAt), isNotNull(transactions.matchedRuleId)))
            .groupBy(transactions.matchedRuleId),
        ]);

        const countMap = new Map<string, number>();
        for (const cRow of countRows) {
          if (cRow.ruleId !== null) {
            countMap.set(cRow.ruleId, cRow.count);
          }
        }

        return {
          rules: rows.map((row) => mapRuleView(row, countMap.get(row.id) ?? 0)),
          retroactive_stats: {
            updated_count: recalc.updatedCount,
            skipped_protected_count: recalc.skippedProtectedCount,
          },
          latest_revision: recalc.latestRevision ?? latestRevision,
        };
      });
    },

    async reapplyRules() {
      return clients.poolDb.transaction(async (tx) => {
        const recalc = await runRuleRecalcInTx(tx);
        const latestRevision =
          recalc.latestRevision ?? (await fetchLatestSyncRevision(clients));
        return {
          retroactive_stats: {
            updated_count: recalc.updatedCount,
            skipped_protected_count: recalc.skippedProtectedCount,
          },
          latest_revision: latestRevision,
        };
      });
    },
  };

  function mapCategoryRow(row: typeof categories.$inferSelect): Category {
    return {
      id: parseCategoryId(row.id),
      parent_id: row.parentId !== null ? parseCategoryId(row.parentId) : null,
      name: row.name,
      slug: row.slug,
      budget_group: row.budgetGroup,
      color_token: row.colorToken,
      sort_order: row.sortOrder,
      is_system: row.isSystem,
      is_archived: row.isArchived,
      revision: toSyncRevision(row.revision),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  function mapCategoryView(
    row: typeof categories.$inferSelect,
    transactionCount: number,
  ): CategoryView {
    return {
      ...mapCategoryRow(row),
      transaction_count: transactionCount,
    };
  }

  async function resolveCategoryTargetInTx(
    tx: NeonTx,
    targetCategoryId: CategoryId,
    targetSubcategoryId: CategoryId | null | undefined,
  ): Promise<
    | {
        readonly ok: true;
        readonly categoryId: CategoryId;
        readonly subcategoryId: CategoryId | null;
        readonly label: string;
      }
    | { readonly ok: false }
  > {
    const [target] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.id, targetCategoryId), isNull(categories.deletedAt)))
      .limit(1);

    if (target === undefined) {
      return { ok: false };
    }

    if (targetSubcategoryId !== undefined && targetSubcategoryId !== null) {
      const [sub] = await tx
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.id, targetSubcategoryId),
            eq(categories.parentId, target.id),
            isNull(categories.deletedAt),
          ),
        )
        .limit(1);
      if (sub === undefined) {
        return { ok: false };
      }
      return {
        ok: true,
        categoryId: parseCategoryId(target.id),
        subcategoryId: parseCategoryId(sub.id),
        label: sub.name,
      };
    }

    if (target.parentId !== null) {
      return {
        ok: true,
        categoryId: parseCategoryId(target.parentId),
        subcategoryId: parseCategoryId(target.id),
        label: target.name,
      };
    }

    return {
      ok: true,
      categoryId: parseCategoryId(target.id),
      subcategoryId: null,
      label: target.name,
    };
  }

  async function reassignCategoryReferencesInTx(
    tx: NeonTx,
    sourceIds: readonly string[],
    target: {
      readonly categoryId: CategoryId;
      readonly subcategoryId: CategoryId | null;
      readonly label: string;
    },
    now: Date,
  ): Promise<number> {
    if (sourceIds.length === 0) {
      return 0;
    }

    const txCond = and(
      isNull(transactions.deletedAt),
      or(
        inArray(transactions.categoryId, [...sourceIds]),
        inArray(transactions.subcategoryId, [...sourceIds]),
      ),
    );
    const matchingTxs = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(txCond);

    if (matchingTxs.length > 0) {
      const txRev = await allocateNextRevision(tx);
      await tx
        .update(transactions)
        .set({
          category: target.label,
          categoryId: target.categoryId,
          subcategoryId: target.subcategoryId,
          revision: txRev,
          updatedAt: now,
        })
        .where(txCond);
    }

    await tx
      .update(transactions)
      .set({
        aiSuggestedCategoryId: null,
        aiSuggestedSubcategoryId: null,
      })
      .where(
        and(
          isNull(transactions.deletedAt),
          or(
            inArray(transactions.aiSuggestedCategoryId, [...sourceIds]),
            inArray(transactions.aiSuggestedSubcategoryId, [...sourceIds]),
          ),
        ),
      );

    const ruleCond = and(
      isNull(categorizationRules.deletedAt),
      or(
        inArray(categorizationRules.targetCategoryId, [...sourceIds]),
        inArray(categorizationRules.targetSubcategoryId, [...sourceIds]),
      ),
    );
    const matchingRules = await tx
      .select({ id: categorizationRules.id })
      .from(categorizationRules)
      .where(ruleCond);

    if (matchingRules.length > 0) {
      const ruleRev = await allocateNextRevision(tx);
      await tx
        .update(categorizationRules)
        .set({
          targetCategory: target.label,
          targetCategoryId: target.categoryId,
          targetSubcategoryId: target.subcategoryId,
          revision: ruleRev,
          updatedAt: now,
        })
        .where(ruleCond);
    }

    return matchingTxs.length;
  }

  const categoriesRepository: CategoriesRepository = {
    async listCategories(options) {
      const includeArchived = options?.include_archived ?? false;
      const catConditions = [isNull(categories.deletedAt)];
      if (!includeArchived) {
        catConditions.push(eq(categories.isArchived, false));
      }

      const [rows, txCountRows, latestRevision] = await Promise.all([
        clients.httpDb
          .select()
          .from(categories)
          .where(and(...catConditions))
          .orderBy(asc(categories.sortOrder), asc(categories.name)),
        clients.httpDb
          .select({
            categoryId: transactions.categoryId,
            subcategoryId: transactions.subcategoryId,
            count: sql<number>`count(*)::int`,
          })
          .from(transactions)
          .where(isNull(transactions.deletedAt))
          .groupBy(transactions.categoryId, transactions.subcategoryId),
        fetchLatestSyncRevision(clients),
      ]);

      const rootCounts = new Map<string, number>();
      const subCounts = new Map<string, number>();
      for (const row of txCountRows) {
        if (row.categoryId !== null) {
          rootCounts.set(row.categoryId, (rootCounts.get(row.categoryId) ?? 0) + row.count);
        }
        if (row.subcategoryId !== null) {
          subCounts.set(row.subcategoryId, (subCounts.get(row.subcategoryId) ?? 0) + row.count);
        }
      }

      return {
        categories: rows.map((row) =>
          mapCategoryView(
            row,
            row.parentId === null ? (rootCounts.get(row.id) ?? 0) : (subCounts.get(row.id) ?? 0),
          ),
        ),
        latest_revision: latestRevision,
      };
    },

    async createCategory(input) {
      return clients.poolDb.transaction(async (tx) => {
        let parentSlug: string | undefined;
        if (input.parent_id !== null) {
          const [parent] = await tx
            .select()
            .from(categories)
            .where(and(eq(categories.id, input.parent_id), isNull(categories.deletedAt)))
            .limit(1);

          if (parent === undefined) {
            return {
              ok: false,
              reason: 'parent_not_found',
              message: 'Catégorie parente introuvable.',
            } as const;
          }

          const depthCheck = validateCategoryParentDepth({ parent_id: parent.parentId });
          if (!depthCheck.ok) {
            return {
              ok: false,
              reason: 'depth_exceeded',
              message: depthCheck.message,
            } as const;
          }
          parentSlug = parent.slug;
        }

        const slug = slugifyCategoryName(input.name, parentSlug);
        const siblingCond =
          input.parent_id === null
            ? isNull(categories.parentId)
            : eq(categories.parentId, input.parent_id);

        const conflicts = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(
              isNull(categories.deletedAt),
              or(
                eq(categories.slug, slug),
                and(
                  siblingCond,
                  sql`lower(trim(${categories.name})) = lower(trim(${input.name}))`,
                ),
              ),
            ),
          )
          .limit(1);

        if (conflicts.length > 0) {
          return {
            ok: false,
            reason: 'conflict',
            message: 'Une catégorie avec ce nom ou ce slug existe déjà à ce niveau.',
          } as const;
        }

        const rev = await allocateNextRevision(tx);
        const now = new Date();
        const [inserted] = await tx
          .insert(categories)
          .values({
            parentId: input.parent_id,
            name: input.name,
            slug,
            budgetGroup: input.budget_group,
            colorToken: input.color_token,
            sortOrder: input.sort_order,
            isSystem: false,
            isArchived: false,
            revision: rev,
            updatedAt: now,
          })
          .returning();

        if (inserted === undefined) {
          throw new Error('Failed to insert category');
        }

        return {
          ok: true,
          data: {
            category: mapCategoryView(inserted, 0),
            latest_revision: rev,
          },
        } as const;
      });
    },

    async updateCategory(id, input) {
      return clients.poolDb.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(categories)
          .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
          .limit(1);

        if (existing === undefined) {
          return {
            ok: false,
            reason: 'not_found',
            message: 'Catégorie introuvable.',
          } as const;
        }

        const now = new Date();
        const updateSet: Partial<typeof categories.$inferInsert> = {
          updatedAt: now,
        };

        if (input.name !== undefined) {
          let nextSlug = existing.slug;
          if (!existing.isSystem) {
            let parentSlug: string | undefined;
            if (existing.parentId !== null) {
              const [parent] = await tx
                .select({ slug: categories.slug })
                .from(categories)
                .where(eq(categories.id, existing.parentId))
                .limit(1);
              parentSlug = parent?.slug;
            }
            nextSlug = slugifyCategoryName(input.name, parentSlug);
          }

          const siblingCond =
            existing.parentId === null
              ? isNull(categories.parentId)
              : eq(categories.parentId, existing.parentId);

          const conflicts = await tx
            .select({ id: categories.id })
            .from(categories)
            .where(
              and(
                isNull(categories.deletedAt),
                ne(categories.id, id),
                or(
                  ...(!existing.isSystem ? [eq(categories.slug, nextSlug)] : []),
                  and(
                    siblingCond,
                    sql`lower(trim(${categories.name})) = lower(trim(${input.name}))`,
                  ),
                ),
              ),
            )
            .limit(1);

          if (conflicts.length > 0) {
            return {
              ok: false,
              reason: 'conflict',
              message: 'Une catégorie avec ce nom ou ce slug existe déjà à ce niveau.',
            } as const;
          }

          updateSet.name = input.name;
          updateSet.slug = nextSlug;
        }

        if (input.budget_group !== undefined) updateSet.budgetGroup = input.budget_group;
        if (input.color_token !== undefined) updateSet.colorToken = input.color_token;
        if (input.sort_order !== undefined) updateSet.sortOrder = input.sort_order;
        if (input.is_archived !== undefined) updateSet.isArchived = input.is_archived;

        const catRev = await allocateNextRevision(tx);
        updateSet.revision = catRev;

        const [updated] = await tx
          .update(categories)
          .set(updateSet)
          .where(eq(categories.id, id))
          .returning();

        if (updated === undefined) {
          return {
            ok: false,
            reason: 'not_found',
            message: 'Catégorie introuvable.',
          } as const;
        }

        let updatedTxCount = 0;
        let latestRevision = catRev;

        if (input.name !== undefined && updated.name !== existing.name) {
          const txCond =
            updated.parentId === null
              ? and(
                  isNull(transactions.deletedAt),
                  eq(transactions.categoryId, id),
                  isNull(transactions.subcategoryId),
                )
              : and(isNull(transactions.deletedAt), eq(transactions.subcategoryId, id));

          const matchingTxs = await tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(txCond);

          if (matchingTxs.length > 0) {
            const txRev = await allocateNextRevision(tx);
            latestRevision = txRev;
            await tx
              .update(transactions)
              .set({ category: updated.name, revision: txRev, updatedAt: now })
              .where(txCond);
            updatedTxCount = matchingTxs.length;
          }

          const ruleCond =
            updated.parentId === null
              ? and(
                  isNull(categorizationRules.deletedAt),
                  eq(categorizationRules.targetCategoryId, id),
                  isNull(categorizationRules.targetSubcategoryId),
                )
              : and(
                  isNull(categorizationRules.deletedAt),
                  eq(categorizationRules.targetSubcategoryId, id),
                );

          const matchingRules = await tx
            .select({ id: categorizationRules.id })
            .from(categorizationRules)
            .where(ruleCond);

          if (matchingRules.length > 0) {
            const ruleRev = await allocateNextRevision(tx);
            latestRevision = ruleRev;
            await tx
              .update(categorizationRules)
              .set({ targetCategory: updated.name, revision: ruleRev, updatedAt: now })
              .where(ruleCond);
          }
        }

        const countWhere =
          updated.parentId === null
            ? and(isNull(transactions.deletedAt), eq(transactions.categoryId, id))
            : and(isNull(transactions.deletedAt), eq(transactions.subcategoryId, id));
        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(countWhere);

        return {
          ok: true,
          data: {
            category: mapCategoryView(updated, countRow?.count ?? 0),
            updated_transactions_count: updatedTxCount,
            latest_revision: latestRevision,
          },
        } as const;
      });
    },

    async mergeCategory(id, input) {
      if (id === input.target_category_id) {
        return {
          ok: false,
          reason: 'same_category',
          message: 'La catégorie cible doit être différente de la catégorie source.',
        } as const;
      }

      return clients.poolDb.transaction(async (tx) => {
        const [source] = await tx
          .select()
          .from(categories)
          .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
          .limit(1);

        if (source === undefined) {
          return {
            ok: false,
            reason: 'source_not_found',
            message: 'Catégorie source introuvable.',
          } as const;
        }

        if (isProtectedSystemCategory(source)) {
          return {
            ok: false,
            reason: 'protected_or_has_children',
            message: 'Impossible de fusionner une catégorie système protégée.',
          } as const;
        }

        const resolvedTarget = await resolveCategoryTargetInTx(
          tx,
          input.target_category_id,
          input.target_subcategory_id,
        );
        if (!resolvedTarget.ok) {
          return {
            ok: false,
            reason: 'target_not_found',
            message: 'Catégorie cible introuvable.',
          } as const;
        }

        const activeChildren = await tx
          .select()
          .from(categories)
          .where(and(eq(categories.parentId, id), isNull(categories.deletedAt)));

        const now = new Date();
        const extraReassignIds: string[] = [];

        if (activeChildren.length > 0) {
          if (resolvedTarget.subcategoryId !== null) {
            return {
              ok: false,
              reason: 'depth_exceeded',
              message: 'Impossible de fusionner une catégorie parente avec sous-catégories vers une sous-catégorie.',
            } as const;
          }

          const [targetRoot] = await tx
            .select()
            .from(categories)
            .where(eq(categories.id, resolvedTarget.categoryId))
            .limit(1);
          const targetChildren = await tx
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.parentId, resolvedTarget.categoryId),
                isNull(categories.deletedAt),
              ),
            );
          const targetChildrenByLowerName = new Map(
            targetChildren.map((c) => [c.name.trim().toLowerCase(), c]),
          );

          for (const child of activeChildren) {
            const colliding = targetChildrenByLowerName.get(child.name.trim().toLowerCase());
            if (colliding !== undefined) {
              await reassignCategoryReferencesInTx(
                tx,
                [child.id],
                {
                  categoryId: resolvedTarget.categoryId,
                  subcategoryId: parseCategoryId(colliding.id),
                  label: colliding.name,
                },
                now,
              );
              const childDelRev = await allocateNextRevision(tx);
              await tx
                .update(categories)
                .set({ deletedAt: now, updatedAt: now, revision: childDelRev })
                .where(eq(categories.id, child.id));
            } else {
              const reparentRev = await allocateNextRevision(tx);
              const nextChildSlug = slugifyCategoryName(child.name, targetRoot?.slug);
              await tx
                .update(categories)
                .set({
                  parentId: resolvedTarget.categoryId,
                  slug: nextChildSlug,
                  revision: reparentRev,
                  updatedAt: now,
                })
                .where(eq(categories.id, child.id));
              // Also keep parent category_id aligned on transactions belonging to reparented child
              await tx
                .update(transactions)
                .set({
                  categoryId: resolvedTarget.categoryId,
                  revision: reparentRev,
                  updatedAt: now,
                })
                .where(and(isNull(transactions.deletedAt), eq(transactions.subcategoryId, child.id)));
              await tx
                .update(categorizationRules)
                .set({
                  targetCategoryId: resolvedTarget.categoryId,
                  revision: reparentRev,
                  updatedAt: now,
                })
                .where(
                  and(
                    isNull(categorizationRules.deletedAt),
                    eq(categorizationRules.targetSubcategoryId, child.id),
                  ),
                );
            }
          }
        }

        const reassignedCount = await reassignCategoryReferencesInTx(
          tx,
          [source.id, ...extraReassignIds],
          resolvedTarget,
          now,
        );

        const delRev = await allocateNextRevision(tx);
        await tx
          .update(categories)
          .set({ deletedAt: now, updatedAt: now, revision: delRev })
          .where(eq(categories.id, id));

        return {
          ok: true,
          data: {
            merged_from_id: id,
            target_category_id: input.target_category_id,
            reassigned_transactions_count: reassignedCount,
            latest_revision: delRev,
          },
        } as const;
      });
    },

    async deleteCategory(id, input) {
      return clients.poolDb.transaction(async (tx) => {
        const [source] = await tx
          .select()
          .from(categories)
          .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
          .limit(1);

        if (source === undefined) {
          return {
            ok: false,
            reason: 'not_found',
            message: 'Catégorie introuvable.',
          } as const;
        }

        if (isProtectedSystemCategory(source)) {
          return {
            ok: false,
            reason: 'has_children_or_system',
            message: 'Impossible de supprimer une catégorie système protégée.',
          } as const;
        }

        const activeChildren = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.parentId, id), isNull(categories.deletedAt)))
          .limit(1);

        if (activeChildren.length > 0) {
          return {
            ok: false,
            reason: 'has_children_or_system',
            message: 'Impossible de supprimer une catégorie possédant des sous-catégories actives.',
          } as const;
        }

        const [txRefRows, ruleRefRows] = await Promise.all([
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(transactions)
            .where(
              and(
                isNull(transactions.deletedAt),
                or(eq(transactions.categoryId, id), eq(transactions.subcategoryId, id)),
              ),
            ),
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(categorizationRules)
            .where(
              and(
                isNull(categorizationRules.deletedAt),
                or(
                  eq(categorizationRules.targetCategoryId, id),
                  eq(categorizationRules.targetSubcategoryId, id),
                ),
              ),
            ),
        ]);

        const hasReferences =
          (txRefRows[0]?.count ?? 0) > 0 || (ruleRefRows[0]?.count ?? 0) > 0;
        const reassignTargetId = input?.reassign_to_category_id;

        if (reassignTargetId === id) {
          return {
            ok: false,
            reason: 'reassign_required',
            message: 'La catégorie de réaffectation doit être différente de la catégorie supprimée.',
          } as const;
        }

        if (hasReferences && reassignTargetId === undefined) {
          return {
            ok: false,
            reason: 'reassign_required',
            message: 'Cette catégorie est référencée : fournissez reassign_to_category_id.',
          } as const;
        }

        const now = new Date();
        let reassignedCount = 0;

        if (reassignTargetId !== undefined) {
          const resolvedTarget = await resolveCategoryTargetInTx(
            tx,
            reassignTargetId,
            input?.reassign_to_subcategory_id,
          );
          if (!resolvedTarget.ok) {
            return {
              ok: false,
              reason: 'target_not_found',
              message: 'Catégorie de réaffectation introuvable.',
            } as const;
          }
          reassignedCount = await reassignCategoryReferencesInTx(tx, [id], resolvedTarget, now);
        }

        const delRev = await allocateNextRevision(tx);
        await tx
          .update(categories)
          .set({ deletedAt: now, updatedAt: now, revision: delRev })
          .where(eq(categories.id, id));

        return {
          ok: true,
          data: {
            deleted_category_id: id,
            reassigned_transactions_count: reassignedCount,
            latest_revision: delRev,
          },
        } as const;
      });
    },
  };

  function mapAiRunRow(row: typeof aiCategorizationRuns.$inferSelect): AiCategorizationRun {
    const triggerSource = row.triggerSource === 'post_pdf_sync' ? 'post_pdf_sync' : 'manual_backfill';
    return AiCategorizationRunSchema.parse({
      id: row.id,
      status: row.status,
      trigger_source: triggerSource,
      model_used: row.modelUsed,
      total_candidates: row.totalCandidates,
      processed_count: row.processedCount,
      auto_applied_count: row.autoAppliedCount,
      queued_review_count: row.queuedReviewCount,
      failed_count: row.failedCount,
      last_error: row.lastError,
      started_at: row.startedAt.toISOString(),
      finished_at: row.finishedAt !== null ? row.finishedAt.toISOString() : null,
      updated_at: row.updatedAt.toISOString(),
    });
  }

  function mapAiRuleSuggestionRow(
    row: typeof aiRuleSuggestions.$inferSelect,
    catNamesById: ReadonlyMap<string, string>,
  ): AiRuleSuggestion {
    const targetCategoryName = catNamesById.get(row.targetCategoryId) ?? 'Non catégorisé';
    const targetSubcategoryName =
      row.targetSubcategoryId !== null ? (catNamesById.get(row.targetSubcategoryId) ?? null) : null;
    return AiRuleSuggestionSchema.parse({
      id: row.id,
      merchant_pattern: row.merchantPattern,
      match_mode: row.matchMode,
      target_category_id: row.targetCategoryId,
      target_subcategory_id: row.targetSubcategoryId,
      target_category_name: targetCategoryName,
      target_subcategory_name: targetSubcategoryName,
      sample_count: row.sampleCount,
      status: row.status,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      revision: toSyncRevision(row.revision),
    });
  }

  const aiCategorizationRepository: AiCategorizationRepository = {
    async getStatus(options) {
      const [runRows, pendingRows, eligibleRows] = await Promise.all([
        options?.run_id !== undefined
          ? clients.httpDb
              .select()
              .from(aiCategorizationRuns)
              .where(eq(aiCategorizationRuns.id, options.run_id))
              .limit(1)
          : clients.httpDb
              .select()
              .from(aiCategorizationRuns)
              .orderBy(desc(aiCategorizationRuns.startedAt))
              .limit(1),
        clients.httpDb
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(and(isNull(transactions.deletedAt), eq(transactions.aiReviewStatus, 'pending_review'))),
        clients.httpDb
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(
            and(
              isNull(transactions.deletedAt),
              eq(transactions.isManualCategory, false),
              eq(transactions.isInternalTransfer, false),
              isNull(transactions.matchedRuleId),
              eq(transactions.categorySource, 'uncategorized'),
              eq(transactions.aiReviewStatus, 'none'),
            ),
          ),
      ]);

      const runRow = runRows[0];
      return {
        run: runRow !== undefined ? mapAiRunRow(runRow) : null,
        pending_review_count: pendingRows[0]?.count ?? 0,
        uncategorized_eligible_count: eligibleRows[0]?.count ?? 0,
      };
    },

    async getReviewQueue(options) {
      const [txRows, pendingRows, catRows] = await Promise.all([
        clients.httpDb
          .select()
          .from(transactions)
          .where(and(isNull(transactions.deletedAt), eq(transactions.aiReviewStatus, 'pending_review')))
          .orderBy(desc(transactions.bookingDate), desc(transactions.revision))
          .limit(options.limit)
          .offset(options.offset),
        clients.httpDb
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(and(isNull(transactions.deletedAt), eq(transactions.aiReviewStatus, 'pending_review'))),
        clients.httpDb
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(isNull(categories.deletedAt)),
      ]);

      const catNamesById = new Map<string, string>(catRows.map((c) => [c.id, c.name]));
      const items: AiReviewItem[] = txRows.map((tx) => {
        const suggestedCatId = tx.aiSuggestedCategoryId ?? UNCATEGORIZED_CATEGORY_ID;
        const suggestedSubId = tx.aiSuggestedSubcategoryId;
        return AiReviewItemSchema.parse({
          transaction_id: tx.id,
          date: tx.bookingDate,
          clean_label: tx.cleanLabel,
          amount_cents: tx.amountCents,
          currency: tx.currency,
          amount_eur_cents: tx.amountEurCents,
          account_id: tx.accountId,
          suggested_category_id: suggestedCatId,
          suggested_subcategory_id: suggestedSubId,
          suggested_category_name: catNamesById.get(suggestedCatId) ?? 'Non catégorisé',
          suggested_subcategory_name:
            suggestedSubId !== null ? (catNamesById.get(suggestedSubId) ?? null) : null,
          ai_confidence_bp: tx.aiConfidenceBp ?? 0,
          ai_reason: tx.aiReason,
          ai_model: tx.aiModel,
          ai_review_status: tx.aiReviewStatus,
          updated_at: tx.updatedAt.toISOString(),
        });
      });

      return {
        items,
        total_pending: pendingRows[0]?.count ?? 0,
        limit: options.limit,
        offset: options.offset,
      };
    },

    async resolveReviewDecisions(decisions) {
      return clients.poolDb.transaction(async (tx) => {
        const activeCategories = await tx
          .select()
          .from(categories)
          .where(isNull(categories.deletedAt));
        const catById = new Map(activeCategories.map((c) => [c.id, c]));

        const now = new Date();
        let resolvedCount = 0;
        let createdRulesCount = 0;
        let latestRevision = toSyncRevision(0);

        for (const decision of decisions) {
          const [txRow] = await tx
            .select()
            .from(transactions)
            .where(and(eq(transactions.id, decision.transaction_id), isNull(transactions.deletedAt)))
            .limit(1);

          if (txRow === undefined) {
            return {
              ok: false,
              reason: 'not_found',
              message: `Transaction introuvable : ${decision.transaction_id}.`,
            } as const;
          }

          if (decision.action === 'reject') {
            const rev = await allocateNextRevision(tx);
            latestRevision = toSyncRevision(Math.max(latestRevision, rev));
            await tx
              .update(transactions)
              .set({
                category: 'Non catégorisé',
                categoryId: UNCATEGORIZED_CATEGORY_ID,
                subcategoryId: null,
                categorySource: 'uncategorized',
                aiReviewStatus: 'rejected',
                revision: rev,
                updatedAt: now,
              })
              .where(eq(transactions.id, txRow.id));
            resolvedCount += 1;
            continue;
          }

          let targetCatId: string | null = null;
          let targetSubId: string | null = null;
          let targetLabel = 'Non catégorisé';

          if (decision.action === 'accept') {
            if (txRow.aiSuggestedCategoryId === null) {
              return {
                ok: false,
                reason: 'invalid_decision',
                message: `Aucune suggestion IA à accepter pour ${txRow.id}.`,
              } as const;
            }
            const cat = catById.get(txRow.aiSuggestedCategoryId);
            if (cat === undefined) {
              return {
                ok: false,
                reason: 'invalid_decision',
                message: 'La catégorie suggérée par l’IA n’est plus active.',
              } as const;
            }
            if (txRow.aiSuggestedSubcategoryId !== null) {
              const sub = catById.get(txRow.aiSuggestedSubcategoryId);
              if (sub === undefined || sub.parentId !== cat.id) {
                return {
                  ok: false,
                  reason: 'invalid_decision',
                  message: 'La sous-catégorie suggérée par l’IA n’est plus valide.',
                } as const;
              }
              targetCatId = cat.id;
              targetSubId = sub.id;
              targetLabel = sub.name;
            } else if (cat.parentId !== null) {
              targetCatId = cat.parentId;
              targetSubId = cat.id;
              targetLabel = cat.name;
            } else {
              targetCatId = cat.id;
              targetSubId = null;
              targetLabel = cat.name;
            }
          } else {
            // decision.action === 'override'
            const requestedCatId = decision.category_id;
            if (requestedCatId === undefined) {
              return {
                ok: false,
                reason: 'invalid_decision',
                message: 'category_id est requis pour corriger la suggestion.',
              } as const;
            }
            const cat = catById.get(requestedCatId);
            if (cat === undefined) {
              return {
                ok: false,
                reason: 'invalid_decision',
                message: `Catégorie cible introuvable : ${requestedCatId}.`,
              } as const;
            }
            const requestedSubId = decision.subcategory_id ?? null;
            if (requestedSubId !== null) {
              const sub = catById.get(requestedSubId);
              if (sub === undefined || sub.parentId !== cat.id) {
                return {
                  ok: false,
                  reason: 'invalid_decision',
                  message: `Sous-catégorie cible invalide pour ${cat.name}.`,
                } as const;
              }
              targetCatId = cat.id;
              targetSubId = sub.id;
              targetLabel = sub.name;
            } else if (cat.parentId !== null) {
              targetCatId = cat.parentId;
              targetSubId = cat.id;
              targetLabel = cat.name;
            } else {
              targetCatId = cat.id;
              targetSubId = null;
              targetLabel = cat.name;
            }
          }

          const txRev = await allocateNextRevision(tx);
          latestRevision = toSyncRevision(Math.max(latestRevision, txRev));
          await tx
            .update(transactions)
            .set({
              category: targetLabel,
              categoryId: targetCatId,
              subcategoryId: targetSubId,
              categorySource: decision.action === 'accept' ? 'ai_validated' : 'manual',
              isManualCategory: true,
              matchedRuleId: null,
              aiReviewStatus: decision.action === 'accept' ? 'accepted' : 'rejected',
              revision: txRev,
              updatedAt: now,
            })
            .where(eq(transactions.id, txRow.id));
          resolvedCount += 1;

          if (decision.create_rule === true && targetCatId !== null) {
            const rawPattern =
              decision.rule_pattern?.trim() ||
              extractMerchantPatternForRule(txRow.cleanLabel) ||
              txRow.cleanLabel.trim();
            const pattern = rawPattern.slice(0, 200);
            if (pattern.length > 0) {
              const ruleRev = await allocateNextRevision(tx);
              latestRevision = toSyncRevision(Math.max(latestRevision, ruleRev));
              const [insertedRule] = await tx
                .insert(categorizationRules)
                .values({
                  name: pattern.slice(0, 100),
                  priority: 100,
                  bankFilter: null,
                  accountIdFilter: null,
                  accountTypeFilter: null,
                  matchMode: 'contains',
                  pattern,
                  targetCategory: targetLabel,
                  targetCategoryId: targetCatId,
                  targetSubcategoryId: targetSubId,
                  markAsInternalTransfer: false,
                  isActive: true,
                  revision: ruleRev,
                  updatedAt: now,
                })
                .returning();

              if (insertedRule !== undefined) {
                createdRulesCount += 1;
                const sugRev = await allocateNextRevision(tx);
                latestRevision = toSyncRevision(Math.max(latestRevision, sugRev));
                await tx
                  .update(aiRuleSuggestions)
                  .set({
                    status: 'accepted',
                    acceptedRuleId: insertedRule.id,
                    revision: sugRev,
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(aiRuleSuggestions.status, 'pending'),
                      sql`lower(trim(${aiRuleSuggestions.merchantPattern})) = lower(trim(${pattern}))`,
                    ),
                  );
              }
            }
          }
        }

        let retroactiveUpdatedCount = 0;
        if (createdRulesCount > 0) {
          const recalc = await runRuleRecalcInTx(tx, { protectInternalTransfers: true });
          retroactiveUpdatedCount = recalc.updatedCount;
          if (recalc.latestRevision !== null) {
            latestRevision = toSyncRevision(Math.max(latestRevision, recalc.latestRevision));
          }
        }

        const [pendingRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(and(isNull(transactions.deletedAt), eq(transactions.aiReviewStatus, 'pending_review')));

        return {
          ok: true,
          data: {
            resolved_count: resolvedCount,
            created_rules_count: createdRulesCount,
            retroactive_updated_count: retroactiveUpdatedCount,
            current_revision: latestRevision,
            pending_review_count: pendingRow?.count ?? 0,
          },
        } as const;
      });
    },

    async listRuleSuggestions(options) {
      const targetStatus = options?.status ?? 'pending';
      const [rows, catRows] = await Promise.all([
        clients.httpDb
          .select()
          .from(aiRuleSuggestions)
          .where(eq(aiRuleSuggestions.status, targetStatus))
          .orderBy(desc(aiRuleSuggestions.sampleCount), desc(aiRuleSuggestions.updatedAt)),
        clients.httpDb
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(isNull(categories.deletedAt)),
      ]);

      const catNamesById = new Map<string, string>(catRows.map((c) => [c.id, c.name]));
      return {
        suggestions: rows.map((row) => mapAiRuleSuggestionRow(row, catNamesById)),
      };
    },

    async acceptRuleSuggestion(id) {
      return clients.poolDb.transaction(async (tx) => {
        const [suggestion] = await tx
          .select()
          .from(aiRuleSuggestions)
          .where(eq(aiRuleSuggestions.id, id))
          .limit(1);

        if (suggestion === undefined) {
          return {
            ok: false,
            reason: 'not_found',
            message: 'Suggestion de règle IA introuvable.',
          } as const;
        }

        if (suggestion.status !== 'pending') {
          return {
            ok: false,
            reason: 'already_resolved',
            message: 'Cette suggestion de règle IA a déjà été traitée.',
          } as const;
        }

        const activeCats = await tx
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(isNull(categories.deletedAt));
        const catNamesById = new Map<string, string>(activeCats.map((c) => [c.id, c.name]));

        const targetLabel =
          (suggestion.targetSubcategoryId !== null
            ? catNamesById.get(suggestion.targetSubcategoryId)
            : undefined) ??
          catNamesById.get(suggestion.targetCategoryId) ??
          'Non catégorisé';

        const now = new Date();
        const ruleRev = await allocateNextRevision(tx);
        const [createdRuleRow] = await tx
          .insert(categorizationRules)
          .values({
            name: suggestion.merchantPattern.slice(0, 100),
            priority: 100,
            bankFilter: null,
            accountIdFilter: null,
            accountTypeFilter: null,
            matchMode: suggestion.matchMode,
            pattern: suggestion.merchantPattern,
            targetCategory: targetLabel,
            targetCategoryId: suggestion.targetCategoryId,
            targetSubcategoryId: suggestion.targetSubcategoryId,
            markAsInternalTransfer: false,
            isActive: true,
            revision: ruleRev,
            updatedAt: now,
          })
          .returning();

        if (createdRuleRow === undefined) {
          throw new Error('Failed to create categorization rule from AI suggestion');
        }

        const recalc = await runRuleRecalcInTx(tx, { protectInternalTransfers: true });
        const sugRev = await allocateNextRevision(tx);
        const [updatedSuggestion] = await tx
          .update(aiRuleSuggestions)
          .set({
            status: 'accepted',
            acceptedRuleId: createdRuleRow.id,
            revision: sugRev,
            updatedAt: now,
          })
          .where(eq(aiRuleSuggestions.id, id))
          .returning();

        if (updatedSuggestion === undefined) {
          throw new Error('Failed to update AI rule suggestion');
        }

        const [matchedCountRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(
            and(eq(transactions.matchedRuleId, createdRuleRow.id), isNull(transactions.deletedAt)),
          );

        const latestRev = toSyncRevision(
          Math.max(sugRev, recalc.latestRevision ?? ruleRev),
        );

        return {
          ok: true,
          data: {
            suggestion: mapAiRuleSuggestionRow(updatedSuggestion, catNamesById),
            created_rule: mapRuleView(createdRuleRow, matchedCountRow?.count ?? 0),
            retroactive_updated_count: recalc.updatedCount,
            current_revision: latestRev,
          },
        } as const;
      });
    },

    async dismissRuleSuggestion(id) {
      return clients.poolDb.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(aiRuleSuggestions)
          .where(eq(aiRuleSuggestions.id, id))
          .limit(1);

        if (existing === undefined) {
          return {
            ok: false,
            reason: 'not_found',
            message: 'Suggestion de règle IA introuvable.',
          } as const;
        }

        const now = new Date();
        const rev = await allocateNextRevision(tx);
        const [updated] = await tx
          .update(aiRuleSuggestions)
          .set({ status: 'dismissed', revision: rev, updatedAt: now })
          .where(eq(aiRuleSuggestions.id, id))
          .returning();

        if (updated === undefined) {
          return {
            ok: false,
            reason: 'not_found',
            message: 'Suggestion de règle IA introuvable.',
          } as const;
        }

        const catRows = await tx
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(isNull(categories.deletedAt));
        const catNamesById = new Map<string, string>(catRows.map((c) => [c.id, c.name]));

        return {
          ok: true,
          data: {
            suggestion: mapAiRuleSuggestionRow(updated, catNamesById),
            current_revision: rev,
          },
        } as const;
      });
    },
  };

  async function computeMonthlySpentByCategory(
    month: string,
    currency: Currency,
  ): Promise<ReadonlyMap<string, number>> {
    const startDate = `${month}-01`;
    const [yStr, mStr] = month.split('-');
    const lastDay = new Date(Date.UTC(Number(yStr), Number(mStr), 0)).getUTCDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    const rows = await clients.httpDb
      .select({
        category: transactions.category,
        amountCents: transactions.amountCents,
        amountEurCents: transactions.amountEurCents,
      })
      .from(transactions)
      .where(
        and(
          isNull(transactions.deletedAt),
          eq(transactions.isInternalTransfer, false),
          gte(transactions.bookingDate, startDate),
          lte(transactions.bookingDate, endDate),
        ),
      );

    const totals = new Map<string, number>();
    for (const row of rows) {
      const amount = currency === 'EUR' ? row.amountEurCents : row.amountCents;
      if (amount < 0) {
        totals.set(row.category, (totals.get(row.category) ?? 0) + Math.abs(amount));
      }
    }
    return totals;
  }

  const budgetsRepository: NonNullable<AppDependencies['budgetsRepository']> = {
    async listBudgets(query) {
      const rowsPromise =
        query.currency !== undefined
          ? clients.httpDb
              .select()
              .from(budgetLimits)
              .where(eq(budgetLimits.currency, query.currency))
              .orderBy(asc(budgetLimits.category))
          : clients.httpDb
              .select()
              .from(budgetLimits)
              .orderBy(asc(budgetLimits.category));

      const [rows, latestRev, spentEurMap, spentUsdMap] = await Promise.all([
        rowsPromise,
        fetchLatestSyncRevision(clients),
        computeMonthlySpentByCategory(query.month, 'EUR'),
        computeMonthlySpentByCategory(query.month, 'USD'),
      ]);

      const budgets: BudgetItem[] = rows.map((row) => {
        const limitCents = toCents(row.limitCents);
        const spentRaw =
          row.currency === 'EUR'
            ? (spentEurMap.get(row.category) ?? 0)
            : (spentUsdMap.get(row.category) ?? 0);
        const spentCents = toCents(spentRaw);
        const alert = computeBudgetAlert(spentCents, limitCents);
        return {
          category: row.category,
          monthly_limit_cents: limitCents,
          currency: row.currency,
          spent_cents: spentCents,
          remaining_cents: alert.remaining_cents,
          usage_percent: alert.usage_percent,
          alert_status: alert.status,
          revision: toSyncRevision(row.revision),
          updated_at: row.updatedAt.toISOString(),
        };
      });

      return {
        month: query.month,
        budgets,
        latest_revision: latestRev,
      };
    },

    async upsertBudget(input: PutBudgetInput) {
      const now = new Date();
      const upserted = await clients.poolDb.transaction(async (tx) => {
        const rev = await allocateNextRevision(tx);
        const [row] = await tx
          .insert(budgetLimits)
          .values({
            category: input.category,
            limitCents: input.monthly_limit_cents,
            currency: input.currency,
            revision: rev,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: budgetLimits.category,
            set: {
              limitCents: input.monthly_limit_cents,
              currency: input.currency,
              revision: rev,
              updatedAt: now,
            },
          })
          .returning();

        if (row === undefined) {
          throw new Error('Failed to upsert budget limit');
        }
        return row;
      });

      const currentMonth = now.toISOString().slice(0, 7);
      const spentMap = await computeMonthlySpentByCategory(currentMonth, upserted.currency);
      const spentCents = toCents(spentMap.get(upserted.category) ?? 0);
      const limitCents = toCents(upserted.limitCents);
      const alert = computeBudgetAlert(spentCents, limitCents);
      const rev = toSyncRevision(upserted.revision);

      return {
        budget: {
          category: upserted.category,
          monthly_limit_cents: limitCents,
          currency: upserted.currency,
          spent_cents: spentCents,
          remaining_cents: alert.remaining_cents,
          usage_percent: alert.usage_percent,
          alert_status: alert.status,
          revision: rev,
          updated_at: upserted.updatedAt.toISOString(),
        },
        latest_revision: rev,
      };
    },

    async deleteBudget(category: string) {
      return clients.poolDb.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(budgetLimits)
          .where(eq(budgetLimits.category, category))
          .returning();

        if (deleted === undefined) {
          return null;
        }

        const rev = await allocateNextRevision(tx);
        return {
          deleted_category: deleted.category,
          latest_revision: rev,
        };
      });
    },
  };

  const analyticsRepository: NonNullable<AppDependencies['analyticsRepository']> = {
    async getOverview(query) {
      const [accountRows, txRows, usdRateMicro, latestRevision] = await Promise.all([
        clients.httpDb.select().from(accounts).where(isNull(accounts.deletedAt)),
        clients.httpDb
          .select({
            tx: transactions,
            bank: accounts.bank,
          })
          .from(transactions)
          .innerJoin(accounts, eq(transactions.accountId, accounts.id))
          .where(and(isNull(transactions.deletedAt), isNull(accounts.deletedAt))),
        fetchLatestUsdToEurMicro(clients),
        fetchLatestSyncRevision(clients),
      ]);

      const accountInputs: AnalyticsAccountInput[] = accountRows.map((row) => {
        const mapped = mapAccountRow(row, usdRateMicro);
        return {
          id: mapped.id,
          bank: mapped.bank,
          currency: mapped.currency,
          current_balance_cents: mapped.current_balance_cents,
          current_balance_eur_cents: mapped.current_balance_eur_cents,
        };
      });

      const txInputs: AnalyticsTransactionInput[] = txRows.map(({ tx, bank }) => ({
        id: parseTransactionId(tx.id),
        account_id: parseAccountId(tx.accountId),
        bank,
        booking_date: tx.bookingDate,
        raw_label: tx.rawLabel,
        clean_label: tx.cleanLabel,
        amount_cents: toCents(tx.amountCents),
        currency: tx.currency,
        amount_eur_cents: toCents(tx.amountEurCents),
        category: tx.category,
        is_internal_transfer: tx.isInternalTransfer,
      }));

      return computeAnalyticsOverview({
        query,
        accounts: accountInputs,
        transactions: txInputs,
        dataRevision: latestRevision,
        now: new Date(),
      });
    },
  };

  const syncDeltaRepository: AppDependencies['syncDeltaRepository'] = {
    async getDelta(query): Promise<DeltaSyncResponse> {
      const latestRevision = await fetchLatestSyncRevision(clients);
      const fullResyncRequired = query.since > latestRevision;
      const effectiveSince = fullResyncRequired ? 0 : query.since;
      const sinceDate =
        !fullResyncRequired && query.since_timestamp !== undefined
          ? new Date(query.since_timestamp)
          : null;
      const usdRateMicro = await fetchLatestUsdToEurMicro(clients);

      const accountFilter =
        sinceDate !== null
          ? or(gt(accounts.revision, effectiveSince), gt(accounts.updatedAt, sinceDate))
          : gt(accounts.revision, effectiveSince);

      const txFilter =
        sinceDate !== null
          ? or(gt(transactions.revision, effectiveSince), gt(transactions.updatedAt, sinceDate))
          : gt(transactions.revision, effectiveSince);

      const noteFilter =
        sinceDate !== null
          ? or(gt(transactionNotes.revision, effectiveSince), gt(transactionNotes.updatedAt, sinceDate))
          : gt(transactionNotes.revision, effectiveSince);

      const ruleFilter =
        sinceDate !== null
          ? or(
              gt(categorizationRules.revision, effectiveSince),
              gt(categorizationRules.updatedAt, sinceDate),
            )
          : gt(categorizationRules.revision, effectiveSince);

      const categoryFilter =
        sinceDate !== null
          ? or(gt(categories.revision, effectiveSince), gt(categories.updatedAt, sinceDate))
          : gt(categories.revision, effectiveSince);

      const aiSuggestionFilter =
        sinceDate !== null
          ? or(
              gt(aiRuleSuggestions.revision, effectiveSince),
              gt(aiRuleSuggestions.updatedAt, sinceDate),
            )
          : gt(aiRuleSuggestions.revision, effectiveSince);

      const [
        accRows,
        txRows,
        noteRows,
        ruleRows,
        categoryRows,
        allActiveCategoryNames,
        aiSuggestionRows,
        pendingReviewRows,
        latestRunRows,
        fileRows,
      ] = await Promise.all([
        clients.httpDb.select().from(accounts).where(accountFilter),
        clients.httpDb
          .select({ tx: transactions, account: accounts })
          .from(transactions)
          .innerJoin(accounts, eq(transactions.accountId, accounts.id))
          .where(txFilter)
          .orderBy(asc(transactions.revision))
          .limit(query.limit + 1),
        clients.httpDb.select().from(transactionNotes).where(noteFilter),
        clients.httpDb.select().from(categorizationRules).where(ruleFilter),
        clients.httpDb
          .select()
          .from(categories)
          .where(categoryFilter)
          .orderBy(asc(categories.sortOrder), asc(categories.name)),
        clients.httpDb
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(isNull(categories.deletedAt)),
        clients.httpDb
          .select()
          .from(aiRuleSuggestions)
          .where(aiSuggestionFilter)
          .orderBy(desc(aiRuleSuggestions.sampleCount)),
        clients.httpDb
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(
            and(
              isNull(transactions.deletedAt),
              eq(transactions.aiReviewStatus, 'pending_review'),
            ),
          ),
        clients.httpDb
          .select()
          .from(driveSyncRuns)
          .orderBy(desc(driveSyncRuns.startedAt))
          .limit(1),
        clients.httpDb
          .select({ file: driveFiles, checkpoint: pdfIngestionCheckpoints })
          .from(driveFiles)
          .leftJoin(
            pdfIngestionCheckpoints,
            eq(pdfIngestionCheckpoints.driveFileRecordId, driveFiles.id),
          )
          .where(gt(driveFiles.revision, effectiveSince)),
      ]);

      const hasMore = txRows.length > query.limit;
      const pageTxRows = hasMore ? txRows.slice(0, query.limit) : txRows;

      const upsertedAccounts: Account[] = [];
      const deletedAccountIds: AccountId[] = [];
      for (const row of accRows) {
        if (row.deletedAt !== null) {
          deletedAccountIds.push(parseAccountId(row.id));
        } else {
          upsertedAccounts.push(mapAccountRow(row, usdRateMicro));
        }
      }

      const upsertedTxs: DeltaSyncResponse['transactions']['upserted'] = [];
      const deletedTxIds: TransactionId[] = [];
      let maxPageRev: number = effectiveSince;

      for (const { tx, account } of pageTxRows) {
        maxPageRev = Math.max(maxPageRev, tx.revision);
        if (tx.deletedAt !== null) {
          deletedTxIds.push(parseTransactionId(tx.id));
        } else {
          upsertedTxs.push({
            id: parseTransactionId(tx.id),
            account_id: parseAccountId(tx.accountId),
            bank: account.bank,
            account_type: account.accountType,
            external_ref_masked: account.externalRefMasked,
            booking_date: tx.bookingDate,
            value_date: tx.valueDate,
            raw_label: tx.rawLabel,
            clean_label: tx.cleanLabel,
            amount_cents: toCents(tx.amountCents),
            currency: tx.currency,
            fx_rate_micro: toFxRateMicro(tx.fxRateMicro),
            amount_eur_cents: toCents(tx.amountEurCents),
            category: tx.category,
            category_id: tx.categoryId !== null ? parseCategoryId(tx.categoryId) : null,
            subcategory_id: tx.subcategoryId !== null ? parseCategoryId(tx.subcategoryId) : null,
            category_source: tx.categorySource,
            ai_review_status: tx.aiReviewStatus,
            ai_confidence_bp: tx.aiConfidenceBp,
            ai_suggested_category_id: tx.aiSuggestedCategoryId,
            ai_suggested_subcategory_id: tx.aiSuggestedSubcategoryId,
            ai_reason: tx.aiReason,
            ai_model: tx.aiModel,
            is_manual_category: tx.isManualCategory,
            matched_rule_id: tx.matchedRuleId !== null ? parseRuleId(tx.matchedRuleId) : null,
            is_internal_transfer: tx.isInternalTransfer,
            is_manual_transfer_override: tx.isManualTransferOverride,
            transfer_group_id: tx.transferGroupId,
            source_drive_file_id: tx.sourceDriveFileId,
            revision: toSyncRevision(tx.revision),
            updated_at: tx.updatedAt.toISOString(),
          });
        }
      }

      const upsertedNotes: DeltaSyncResponse['transaction_notes']['upserted'] = [];
      const deletedNoteTxIds: TransactionId[] = [];
      for (const n of noteRows) {
        maxPageRev = Math.max(maxPageRev, n.revision);
        if (n.deletedAt !== null) {
          deletedNoteTxIds.push(parseTransactionId(n.transactionId));
        } else {
          upsertedNotes.push({
            transaction_id: parseTransactionId(n.transactionId),
            content: n.content,
            revision: toSyncRevision(n.revision),
            updated_at: n.updatedAt.toISOString(),
          });
        }
      }

      const upsertedRules: DeltaSyncResponse['categorization_rules']['upserted'] = [];
      const deletedRuleIds: RuleId[] = [];
      for (const r of ruleRows) {
        maxPageRev = Math.max(maxPageRev, r.revision);
        if (r.deletedAt !== null) {
          deletedRuleIds.push(parseRuleId(r.id));
        } else {
          upsertedRules.push({
            id: parseRuleId(r.id),
            name: r.name,
            priority: r.priority,
            bank_filter: r.bankFilter,
            account_id_filter: r.accountIdFilter !== null ? parseAccountId(r.accountIdFilter) : null,
            account_type_filter: r.accountTypeFilter,
            match_mode: r.matchMode,
            pattern: r.pattern,
            target_category: r.targetCategory,
            target_category_id:
              r.targetCategoryId !== null ? parseCategoryId(r.targetCategoryId) : null,
            target_subcategory_id:
              r.targetSubcategoryId !== null ? parseCategoryId(r.targetSubcategoryId) : null,
            mark_as_internal_transfer: r.markAsInternalTransfer,
            is_active: r.isActive,
            revision: toSyncRevision(r.revision),
            updated_at: r.updatedAt.toISOString(),
          });
        }
      }

      const upsertedCategories: Category[] = [];
      const deletedCategoryIds: CategoryId[] = [];
      for (const cat of categoryRows) {
        maxPageRev = Math.max(maxPageRev, cat.revision);
        if (cat.deletedAt !== null) {
          deletedCategoryIds.push(parseCategoryId(cat.id));
        } else {
          upsertedCategories.push(mapCategoryRow(cat));
        }
      }

      const catNamesById = new Map<string, string>(
        allActiveCategoryNames.map((c) => [c.id, c.name]),
      );
      const upsertedAiSuggestions: AiRuleSuggestion[] = [];
      for (const s of aiSuggestionRows) {
        maxPageRev = Math.max(maxPageRev, s.revision);
        upsertedAiSuggestions.push(mapAiRuleSuggestionRow(s, catNamesById));
      }
      const pendingAiReviewCount = pendingReviewRows[0]?.count ?? 0;

      const lastRunRow = latestRunRows[0];
      const filesStatus: DeltaSyncResponse['drive_sync_status']['files'] = [];
      for (const { file, checkpoint } of fileRows) {
        const bankFromFolder = getBankForDriveFolder(file.driveFolderId);
        if (bankFromFolder === null) {
          continue;
        }
        const folderId =
          file.driveFolderId === ALLOWED_DRIVE_FOLDERS.boursobank
            ? ALLOWED_DRIVE_FOLDERS.boursobank
            : ALLOWED_DRIVE_FOLDERS.revolut;

        filesStatus.push({
          drive_file_id: parseDriveFileId(file.driveFileId),
          drive_folder_id: folderId,
          bank: bankFromFolder,
          file_name: file.fileName,
          status: checkpoint?.status ?? 'pending',
          attempt_count: checkpoint?.attemptCount ?? 0,
          error_code: checkpoint?.errorCode ?? null,
          error_message: checkpoint?.errorMessage ?? null,
          revision: toSyncRevision(file.revision),
          updated_at: file.updatedAt.toISOString(),
        });
      }

      const batchEndRevision = hasMore
        ? toSyncRevision(maxPageRev)
        : toSyncRevision(Math.max(latestRevision, maxPageRev));

      return {
        since_revision: query.since,
        batch_end_revision: batchEndRevision,
        latest_revision: latestRevision,
        has_more: hasMore,
        full_resync_required: fullResyncRequired,
        server_time: new Date().toISOString(),
        accounts: { upserted: upsertedAccounts, deleted_ids: deletedAccountIds },
        transactions: { upserted: upsertedTxs, deleted_ids: deletedTxIds },
        transaction_notes: {
          upserted: upsertedNotes,
          deleted_transaction_ids: deletedNoteTxIds,
        },
        categorization_rules: { upserted: upsertedRules, deleted_ids: deletedRuleIds },
        categories: { upserted: upsertedCategories, deleted_ids: deletedCategoryIds },
        ai_rule_suggestions: upsertedAiSuggestions,
        pending_ai_review_count: pendingAiReviewCount,
        drive_sync_status: {
          last_run:
            lastRunRow !== undefined
              ? {
                  id: lastRunRow.id,
                  status: lastRunRow.status,
                  trigger_mode: lastRunRow.triggerMode,
                  started_at: lastRunRow.startedAt.toISOString(),
                  finished_at:
                    lastRunRow.finishedAt !== null ? lastRunRow.finishedAt.toISOString() : null,
                  total_files_discovered: lastRunRow.totalFilesDiscovered,
                  files_committed: lastRunRow.filesCommitted,
                  files_skipped_unchanged: lastRunRow.filesSkippedUnchanged,
                  files_failed: lastRunRow.filesFailed,
                  error_summary: lastRunRow.errorSummary,
                }
              : null,
          files: filesStatus,
        },
        aggregates_snapshot: null,
      };
    },
  };

  const findAppliedMutationInDb = async (
    clientMutationId: string,
  ): Promise<AppliedClientMutationRecord | null> => {
    const rows = await clients.httpDb
      .select()
      .from(appliedClientMutations)
      .where(eq(appliedClientMutations.clientMutationId, clientMutationId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      clientMutationId: row.clientMutationId,
      payloadHash: row.payloadHash,
      appliedAt: row.appliedAt,
      resultStatus: row.resultStatus,
      resultRevision: row.resultRevision,
    };
  };

  const deltaMutationRepository = createIdempotentDeltaMutationRepository({
    findAppliedMutation: findAppliedMutationInDb,
    getLatestRevision: () => fetchLatestSyncRevision(clients),
    async applyAndRecordMutation({ mutation, payloadHash }) {
      const patch: TransactionPatchInput = {
        ...(mutation.kind === 'upsert_note' ? { note: mutation.note } : {}),
        ...(mutation.kind === 'set_category'
          ? {
              category: mutation.category,
              ...(mutation.category_id !== undefined ? { category_id: mutation.category_id } : {}),
              ...(mutation.subcategory_id !== undefined
                ? { subcategory_id: mutation.subcategory_id }
                : {}),
            }
          : {}),
        ...(mutation.kind === 'set_internal_transfer'
          ? { is_internal_transfer: mutation.is_internal_transfer }
          : {}),
      };

      try {
        return await clients.poolDb.transaction(async (tx) => {
          const existingRows = await tx
            .select()
            .from(appliedClientMutations)
            .where(eq(appliedClientMutations.clientMutationId, mutation.client_mutation_id))
            .limit(1);

          const existing = existingRows[0];
          if (existing !== undefined) {
            if (existing.payloadHash !== payloadHash) {
              return { kind: 'conflict' } as const;
            }
            return {
              kind: 'duplicate',
              revision: toSyncRevision(existing.resultRevision),
            } as const;
          }

          const patchResult = await patchTransactionInTx(tx, mutation.transaction_id, patch);
          if (!patchResult.ok) {
            return { kind: 'not_found' } as const;
          }

          const [inserted] = await tx
            .insert(appliedClientMutations)
            .values({
              clientMutationId: mutation.client_mutation_id,
              payloadHash,
              appliedAt: new Date(),
              resultStatus: 'applied',
              resultRevision: patchResult.latest_revision,
            })
            .onConflictDoNothing({ target: appliedClientMutations.clientMutationId })
            .returning();

          if (inserted === undefined) {
            throw new ConcurrentMutationConflictError();
          }

          return {
            kind: 'applied',
            revision: patchResult.latest_revision,
          } as const;
        });
      } catch (err) {
        if (err instanceof ConcurrentMutationConflictError) {
          const winner = await findAppliedMutationInDb(mutation.client_mutation_id);
          if (winner !== null) {
            if (winner.payloadHash !== payloadHash) {
              return { kind: 'conflict' };
            }
            return {
              kind: 'duplicate',
              revision: toSyncRevision(winner.resultRevision),
            };
          }
        }
        throw err;
      }
    },
  });

  const driveSyncService = createResilientDriveSyncService({
    syncWorkerUrl: env.SYNC_WORKER_URL,
    internalWorkerToken,
    store: {
      async findActiveRunningRuns() {
        return clients.httpDb
          .select({ id: driveSyncRuns.id, startedAt: driveSyncRuns.startedAt })
          .from(driveSyncRuns)
          .where(eq(driveSyncRuns.status, 'running'))
          .orderBy(desc(driveSyncRuns.startedAt));
      },
      async createRunningRun() {
        const [createdRun] = await clients.poolDb.transaction(async (tx) => {
          const rev = await allocateNextRevision(tx);
          return tx
            .insert(driveSyncRuns)
            .values({
              triggerMode: 'manual',
              status: 'running',
              revision: rev,
            })
            .returning({ id: driveSyncRuns.id, startedAt: driveSyncRuns.startedAt });
        });
        return createdRun ?? null;
      },
      async markRunFailed(runId: string, summary: string) {
        await clients.poolDb.transaction(async (tx) => {
          const failRev = await allocateNextRevision(tx);
          await tx
            .update(driveSyncRuns)
            .set({
              status: 'failed',
              finishedAt: new Date(),
              errorSummary: summary,
              revision: failRev,
            })
            .where(eq(driveSyncRuns.id, runId));
        });
      },
    },
  });

  const aiBackfillDispatcher = createHttpAiBackfillDispatcher({
    syncWorkerUrl: env.SYNC_WORKER_URL,
    internalWorkerToken,
    store: {
      async findActiveRunningRuns() {
        return clients.httpDb
          .select({ id: aiCategorizationRuns.id, startedAt: aiCategorizationRuns.startedAt })
          .from(aiCategorizationRuns)
          .where(eq(aiCategorizationRuns.status, 'running'))
          .orderBy(desc(aiCategorizationRuns.startedAt));
      },
      async markRunFailed(runId: string, summary: string) {
        const now = new Date();
        await clients.poolDb
          .update(aiCategorizationRuns)
          .set({
            status: 'failed',
            lastError: summary,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(aiCategorizationRuns.id, runId));
      },
      async markRunCancelled(runId: string) {
        const now = new Date();
        await clients.poolDb
          .update(aiCategorizationRuns)
          .set({
            status: 'cancelled',
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(aiCategorizationRuns.id, runId));
      },
    },
  });

  return {
    sessionSecret: env.CLAIRFLUX_SESSION_SECRET,
    allowedWebOrigin: env.CLAIRFLUX_WEB_ORIGIN,
    accessSecretHash: env.CLAIRFLUX_ACCESS_SECRET_HASH,
    sessionRepository: createInMemorySessionRepository(),
    getLatestRevision: () => fetchLatestSyncRevision(clients),
    healthRepository,
    accountsRepository,
    syncDeltaRepository,
    driveSyncService,
    transactionsRepository,
    rulesRepository,
    categoriesRepository,
    aiCategorizationRepository,
    aiBackfillDispatcher,
    budgetsRepository,
    analyticsRepository,
    deltaMutationRepository,
    apk: apkRepository,
  };
}

export interface RunningApiServer {
  readonly server: ServerType;
  readonly shutdown: () => Promise<void>;
}

export function startServer(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
): RunningApiServer {
  const env = parseApiEnv(rawEnv);
  const internalWorkerToken = parseInternalWorkerToken(rawEnv);
  const clients = createNeonClients(env.DATABASE_URL);
  void (async () => {
    await ensureLot1CategoriesSchemaAndSeed(clients);
    await ensureLot2AiSchema(clients);
  })().catch((err: unknown) => {
    const errName = err instanceof Error ? err.name : 'UnknownError';
    console.error(`[api] Échec initialisation schéma Lot 1/2 (${errName}).`);
  });
  const deps = createNeonAppDependencies(env, clients, internalWorkerToken);
  const app = createApp(deps);

  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
  });
  console.info(`[api] ClairFlux API v${CLAIRFLUX_BUILD_VERSION} prête sur le port ${env.PORT}.`);

  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    shutdownPromise = new Promise<void>((resolveShutdown) => {
      const forceTimer = setTimeout(() => {
        void clients.close().finally(resolveShutdown);
      }, 10_000);
      forceTimer.unref();

      server.close(() => {
        clearTimeout(forceTimer);
        void clients.close().finally(resolveShutdown);
      });
    });

    return shutdownPromise;
  };

  const handleSignal = (_signal: NodeJS.Signals): void => {
    void shutdown().then(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  return { server, shutdown };
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  startServer();
}
