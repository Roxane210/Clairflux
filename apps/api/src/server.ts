import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { z } from 'zod';
import {
  ALLOWED_DRIVE_FOLDERS,
  convertToEurCents,
  getBankForDriveFolder,
  parseAccountId,
  parseDriveFileId,
  parseRuleId,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type Account,
  type AccountId,
  type Bank,
  type Cents,
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
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { createApp, type AppDependencies } from './app.js';
import { EnvValidationError, parseApiEnv, type ApiEnv } from './config/env.js';
import { createNeonClients, type NeonClients } from './db/client.js';
import {
  accounts,
  categorizationRules,
  driveFiles,
  driveSyncRuns,
  fxRates,
  pdfIngestionCheckpoints,
  transactionNotes,
  transactions,
} from './db/schema.js';
import {
  computeAnalyticsOverview,
  computeBudgetAlert,
  computeRuleReapplication,
  isSafeRegexPattern,
  type AnalyticsAccountInput,
  type AnalyticsTransactionInput,
  type BudgetItem,
  type OutboxMutationOutcome,
  type PutBudgetInput,
  type RuleEvalRule,
  type RuleEvalTransaction,
  type RuleView,
  type TransactionDetail,
} from './routes/contracts.js';

interface BudgetConfigEntry {
  readonly category: string;
  readonly monthly_limit_cents: Cents;
  readonly currency: Currency;
  readonly revision: SyncRevision;
  readonly updated_at: string;
}

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
      COALESCE((SELECT MAX(revision) FROM transactions), 0),
      COALESCE((SELECT MAX(revision) FROM transaction_notes), 0),
      COALESCE((SELECT MAX(revision) FROM categorization_rules), 0),
      COALESCE((SELECT MAX(revision) FROM drive_files), 0),
      COALESCE((SELECT MAX(revision) FROM drive_sync_runs), 0)
    )::bigint AS max_rev`,
  );
  const parsed = MaxRevRowSchema.safeParse(rows.rows[0]);
  const rawRev = parsed.success ? parsed.data.max_rev : 0;
  return toSyncRevision(Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0);
}

async function allocateNextRevision(
  tx: Parameters<Parameters<NeonClients['poolDb']['transaction']>[0]>[0],
): Promise<SyncRevision> {
  const result = await tx.execute(sql`SELECT nextval('sync_revision_seq')::bigint AS next_rev`);
  const parsed = NextRevRowSchema.safeParse(result.rows[0]);
  const rev = parsed.success ? parsed.data.next_rev : 1;
  return toSyncRevision(Number.isSafeInteger(rev) && rev >= 0 ? rev : 1);
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

export function createNeonAppDependencies(
  env: ApiEnv,
  clients: NeonClients,
  internalWorkerToken: string = parseInternalWorkerToken(),
): AppDependencies {
  const budgetStore = new Map<string, BudgetConfigEntry>();
  const idempotencyStore = new Map<string, SyncRevision>();
  let localSequenceFallback = 0;

  const nextLocalRevision = async (): Promise<SyncRevision> => {
    const dbRev = await fetchLatestSyncRevision(clients);
    localSequenceFallback = Math.max(localSequenceFallback + 1, dbRev + 1);
    return toSyncRevision(localSequenceFallback);
  };

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
      return clients.poolDb.transaction(async (tx) => {
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
          return { ok: false, reason: 'not_found' } as const;
        }

        const now = new Date();
        let highestRevision = await allocateNextRevision(tx);

        const updatePayload: Partial<typeof transactions.$inferInsert> = {
          updatedAt: now,
          revision: highestRevision,
        };

        if (patch.category !== undefined) {
          updatePayload.category = patch.category;
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
          return { ok: false, reason: 'not_found' } as const;
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
        } as const;
      });
    },
  };

  async function runRuleRecalcInTx(
    tx: Parameters<Parameters<NeonClients['poolDb']['transaction']>[0]>[0],
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
      is_manual_transfer_override: t.isManualTransferOverride,
      transfer_group_id: t.transferGroupId,
      deleted_at: t.deletedAt,
    }));

    const plan = computeRuleReapplication(evalRules, evalTxs);
    const now = new Date();
    let latestRevision: SyncRevision | null = null;

    for (const change of plan.changes) {
      const nextRev = await allocateNextRevision(tx);
      latestRevision = nextRev;
      await tx
        .update(transactions)
        .set({
          category: change.nextCategory,
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
            targetCategory: input.target_category,
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
        if (input.target_category !== undefined) updateSet.targetCategory = input.target_category;
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
        const rows = await tx
          .select()
          .from(categorizationRules)
          .where(isNull(categorizationRules.deletedAt))
          .orderBy(asc(categorizationRules.priority), asc(categorizationRules.createdAt));

        return {
          rules: rows.map((row) => mapRuleView(row, 0)),
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
      const latestRev = await fetchLatestSyncRevision(clients);
      const entries = Array.from(budgetStore.values()).filter((entry) =>
        query.currency === undefined ? true : entry.currency === query.currency,
      );

      const spentEurMap = await computeMonthlySpentByCategory(query.month, 'EUR');
      const spentUsdMap = await computeMonthlySpentByCategory(query.month, 'USD');

      const budgets: BudgetItem[] = entries.map((entry) => {
        const spentRaw =
          entry.currency === 'EUR'
            ? (spentEurMap.get(entry.category) ?? 0)
            : (spentUsdMap.get(entry.category) ?? 0);
        const spentCents = toCents(spentRaw);
        const alert = computeBudgetAlert(spentCents, entry.monthly_limit_cents);
        return {
          category: entry.category,
          monthly_limit_cents: entry.monthly_limit_cents,
          currency: entry.currency,
          spent_cents: spentCents,
          remaining_cents: alert.remaining_cents,
          usage_percent: alert.usage_percent,
          alert_status: alert.status,
          revision: entry.revision,
          updated_at: entry.updated_at,
        };
      });

      return {
        month: query.month,
        budgets,
        latest_revision: toSyncRevision(Math.max(latestRev, localSequenceFallback)),
      };
    },

    async upsertBudget(input: PutBudgetInput) {
      const rev = await nextLocalRevision();
      const nowIso = new Date().toISOString();
      const entry: BudgetConfigEntry = {
        category: input.category,
        monthly_limit_cents: input.monthly_limit_cents,
        currency: input.currency,
        revision: rev,
        updated_at: nowIso,
      };
      budgetStore.set(input.category, entry);

      const currentMonth = nowIso.slice(0, 7);
      const spentMap = await computeMonthlySpentByCategory(currentMonth, input.currency);
      const spentCents = toCents(spentMap.get(input.category) ?? 0);
      const alert = computeBudgetAlert(spentCents, input.monthly_limit_cents);

      return {
        budget: {
          category: entry.category,
          monthly_limit_cents: entry.monthly_limit_cents,
          currency: entry.currency,
          spent_cents: spentCents,
          remaining_cents: alert.remaining_cents,
          usage_percent: alert.usage_percent,
          alert_status: alert.status,
          revision: rev,
          updated_at: nowIso,
        },
        latest_revision: rev,
      };
    },

    async deleteBudget(category: string) {
      if (!budgetStore.has(category)) {
        return null;
      }
      budgetStore.delete(category);
      const rev = await nextLocalRevision();
      return {
        deleted_category: category,
        latest_revision: rev,
      };
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
      const sinceDate =
        query.since_timestamp !== undefined ? new Date(query.since_timestamp) : null;
      const latestRevision = await fetchLatestSyncRevision(clients);
      const usdRateMicro = await fetchLatestUsdToEurMicro(clients);

      const accountFilter =
        sinceDate !== null
          ? or(gt(accounts.revision, query.since), gt(accounts.updatedAt, sinceDate))
          : gt(accounts.revision, query.since);

      const txFilter =
        sinceDate !== null
          ? or(gt(transactions.revision, query.since), gt(transactions.updatedAt, sinceDate))
          : gt(transactions.revision, query.since);

      const noteFilter =
        sinceDate !== null
          ? or(gt(transactionNotes.revision, query.since), gt(transactionNotes.updatedAt, sinceDate))
          : gt(transactionNotes.revision, query.since);

      const ruleFilter =
        sinceDate !== null
          ? or(
              gt(categorizationRules.revision, query.since),
              gt(categorizationRules.updatedAt, sinceDate),
            )
          : gt(categorizationRules.revision, query.since);

      const [accRows, txRows, noteRows, ruleRows, latestRunRows, fileRows] = await Promise.all([
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
          .where(gt(driveFiles.revision, query.since)),
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
      let maxPageRev: number = query.since;

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
            mark_as_internal_transfer: r.markAsInternalTransfer,
            is_active: r.isActive,
            revision: toSyncRevision(r.revision),
            updated_at: r.updatedAt.toISOString(),
          });
        }
      }

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
        full_resync_required: false,
        server_time: new Date().toISOString(),
        accounts: { upserted: upsertedAccounts, deleted_ids: deletedAccountIds },
        transactions: { upserted: upsertedTxs, deleted_ids: deletedTxIds },
        transaction_notes: {
          upserted: upsertedNotes,
          deleted_transaction_ids: deletedNoteTxIds,
        },
        categorization_rules: { upserted: upsertedRules, deleted_ids: deletedRuleIds },
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
                }
              : null,
          files: filesStatus,
        },
        aggregates_snapshot: null,
      };
    },
  };

  const deltaMutationRepository: NonNullable<AppDependencies['deltaMutationRepository']> = {
    async applyOutboxBatch(mutations) {
      const results: OutboxMutationOutcome[] = [];
      let latestRev = await fetchLatestSyncRevision(clients);

      for (const mutation of mutations) {
        const alreadyProcessedRev = idempotencyStore.get(mutation.client_mutation_id);
        if (alreadyProcessedRev !== undefined) {
          results.push({
            client_mutation_id: mutation.client_mutation_id,
            status: 'duplicate',
            revision: alreadyProcessedRev,
          });
          continue;
        }

        const patchResult = await transactionsRepository.patchTransaction(mutation.transaction_id, {
          ...(mutation.kind === 'upsert_note' ? { note: mutation.note } : {}),
          ...(mutation.kind === 'set_category' ? { category: mutation.category } : {}),
          ...(mutation.kind === 'set_internal_transfer'
            ? { is_internal_transfer: mutation.is_internal_transfer }
            : {}),
        });

        if (!patchResult.ok) {
          results.push({
            client_mutation_id: mutation.client_mutation_id,
            status: 'rejected',
            reason: 'RESOURCE_NOT_FOUND',
            message: 'Transaction introuvable.',
          });
          continue;
        }

        idempotencyStore.set(mutation.client_mutation_id, patchResult.latest_revision);
        latestRev = patchResult.latest_revision;
        results.push({
          client_mutation_id: mutation.client_mutation_id,
          status: 'applied',
          revision: patchResult.latest_revision,
        });
      }

      return {
        results,
        latest_revision: latestRev,
      };
    },
  };

  const driveSyncService: AppDependencies['driveSyncService'] = {
    async triggerManualSync() {
      const runningRows = await clients.httpDb
        .select({ id: driveSyncRuns.id })
        .from(driveSyncRuns)
        .where(eq(driveSyncRuns.status, 'running'))
        .limit(1);

      const active = runningRows[0];
      if (active !== undefined) {
        return {
          ok: false,
          reason: 'already_running',
          activeRunId: active.id,
        };
      }

      const [createdRun] = await clients.poolDb.transaction(async (tx) => {
        const rev = await allocateNextRevision(tx);
        return tx
          .insert(driveSyncRuns)
          .values({
            triggerMode: 'manual',
            status: 'running',
            revision: rev,
          })
          .returning();
      });

      if (createdRun === undefined) {
        return {
          ok: false,
          reason: 'upstream_error',
          message: 'Impossible de créer le run de synchronisation Drive.',
        };
      }

      const markRunFailed = async (summary: string): Promise<void> => {
        try {
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
              .where(eq(driveSyncRuns.id, createdRun.id));
          });
        } catch {
          // Best-effort cleanup so failed worker dispatch does not swallow the primary error
        }
      };

      try {
        const response = await fetch(`${env.SYNC_WORKER_URL}/internal/runs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Worker-Token': internalWorkerToken,
          },
          body: JSON.stringify({ run_id: createdRun.id }),
        });

        if (!response.ok) {
          const message = `Le sync-worker a répondu avec le statut HTTP ${response.status}.`;
          await markRunFailed(message);
          return {
            ok: false,
            reason: 'upstream_error',
            message,
          };
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Erreur de communication avec sync-worker.';
        await markRunFailed(message);
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

  return {
    sessionSecret: env.CLAIRFLUX_SESSION_SECRET,
    allowedWebOrigin: env.CLAIRFLUX_WEB_ORIGIN,
    healthRepository,
    accountsRepository,
    syncDeltaRepository,
    driveSyncService,
    transactionsRepository,
    rulesRepository,
    budgetsRepository,
    analyticsRepository,
    deltaMutationRepository,
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
  const deps = createNeonAppDependencies(env, clients, internalWorkerToken);
  const app = createApp(deps);

  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
  });

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
