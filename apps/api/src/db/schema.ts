import {
  ALLOWED_DRIVE_FOLDERS,
  AccountTypeSchema,
  BankSchema,
  CheckpointErrorCodeSchema,
  CheckpointStatusSchema,
  CurrencySchema,
  FxSourceSchema,
  RuleMatchModeSchema,
  SyncRunStatusSchema,
  SyncTriggerSchema,
  type CheckpointErrorCode,
} from '@clairflux/shared';
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export {
  ALLOWED_DRIVE_FOLDERS,
  AccountTypeSchema,
  BankSchema,
  CheckpointErrorCodeSchema,
  CheckpointStatusSchema,
  CurrencySchema,
  FxSourceSchema,
  RuleMatchModeSchema,
  SyncRunStatusSchema,
  SyncTriggerSchema,
};

export const CHECKPOINT_ERROR_CODES = CheckpointErrorCodeSchema.options;

// ============================================================================
// PostgreSQL Sequence & Enums
// ============================================================================

export const syncRevisionSeq = pgSequence('sync_revision_seq', {
  startWith: 1,
  increment: 1,
  cache: 1,
});

export const bankEnum = pgEnum('bank_enum', ['boursobank', 'revolut']);

export const accountTypeEnum = pgEnum('account_type_enum', [
  'courant',
  'epargne',
  'carte_differee',
  'multi_devises',
  'coffre',
  'autre',
]);

export const currencyEnum = pgEnum('currency_enum', ['EUR', 'USD']);

export const fxSourceEnum = pgEnum('fx_source_enum', [
  'revolut_statement',
  'ecb_reference',
  'nearest_business_day',
  'manual_override',
]);

export const ruleMatchModeEnum = pgEnum('rule_match_mode_enum', [
  'contains',
  'starts_with',
  'exact',
  'regex',
]);

export const syncTriggerEnum = pgEnum('sync_trigger_enum', ['manual']);

export const syncRunStatusEnum = pgEnum('sync_run_status_enum', [
  'running',
  'completed',
  'partial_error',
  'failed',
]);

export const checkpointStatusEnum = pgEnum('checkpoint_status_enum', [
  'pending',
  'skipped',
  'extracting',
  'parsed',
  'committing',
  'committed',
  'failed',
]);

const nextRevisionDefault = sql`nextval('sync_revision_seq')`;

// ============================================================================
// Tables (Fat-Database Constraints & Targeted Indexes)
// ============================================================================

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bank: bankEnum('bank').notNull(),
    accountType: accountTypeEnum('account_type').notNull(),
    nickname: varchar('nickname', { length: 80 }).notNull(),
    detectedName: varchar('detected_name', { length: 120 }).notNull(),
    externalRefMasked: varchar('external_ref_masked', { length: 64 }).notNull(),
    currency: currencyEnum('currency').notNull(),
    currentBalanceCents: bigint('current_balance_cents', { mode: 'number' }).notNull().default(0),
    balanceUpdatedAt: timestamp('balance_updated_at', { withTimezone: true, mode: 'date' }),
    lastStatementClosingDate: date('last_statement_closing_date', { mode: 'string' }),
    isArchived: boolean('is_archived').notNull().default(false),
    revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    unique('uq_accounts_identity').on(t.bank, t.externalRefMasked, t.currency),
    check('chk_accounts_nickname_non_empty', sql`char_length(trim(nickname)) > 0`),
    check('chk_accounts_external_ref_non_empty', sql`char_length(trim(external_ref_masked)) > 0`),
    index('idx_accounts_revision').on(t.revision),
    index('idx_accounts_bank_currency')
      .on(t.bank, t.currency)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rateDate: date('rate_date', { mode: 'string' }).notNull(),
    baseCurrency: currencyEnum('base_currency').notNull(),
    quoteCurrency: currencyEnum('quote_currency').notNull(),
    rateMicro: bigint('rate_micro', { mode: 'number' }).notNull(),
    source: fxSourceEnum('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_fx_rates_pair_date').on(t.rateDate, t.baseCurrency, t.quoteCurrency),
    check('chk_fx_rates_positive', sql`rate_micro > 0`),
    check('chk_fx_rates_distinct_currencies', sql`base_currency <> quote_currency`),
    index('idx_fx_rates_lookup').on(t.baseCurrency, t.quoteCurrency, t.rateDate.desc()),
  ],
);

export const driveSyncRuns = pgTable(
  'drive_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    triggerMode: syncTriggerEnum('trigger_mode').notNull().default('manual'),
    status: syncRunStatusEnum('status').notNull().default('running'),
    totalFilesDiscovered: integer('total_files_discovered').notNull().default(0),
    filesSkippedUnchanged: integer('files_skipped_unchanged').notNull().default(0),
    filesCommitted: integer('files_committed').notNull().default(0),
    filesFailed: integer('files_failed').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    errorSummary: text('error_summary'),
    revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
  },
  (t) => [
    check('chk_drive_sync_runs_manual_only', sql`trigger_mode = 'manual'`),
    check(
      'chk_drive_sync_runs_counts_non_negative',
      sql`total_files_discovered >= 0 AND files_skipped_unchanged >= 0 AND files_committed >= 0 AND files_failed >= 0`,
    ),
    index('idx_drive_sync_runs_started').on(t.startedAt.desc()),
    index('idx_drive_sync_runs_revision').on(t.revision),
  ],
);

export const driveFiles = pgTable(
  'drive_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driveFileId: varchar('drive_file_id', { length: 128 }).notNull(),
    driveFolderId: varchar('drive_folder_id', { length: 64 }).notNull(),
    bank: bankEnum('bank').notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    md5Checksum: varchar('md5_checksum', { length: 64 }).notNull(),
    fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
    driveModifiedTime: timestamp('drive_modified_time', { withTimezone: true, mode: 'date' }).notNull(),
    isMissingOnDrive: boolean('is_missing_on_drive').notNull().default(false),
    lastSeenInRunId: uuid('last_seen_in_run_id')
      .notNull()
      .references(() => driveSyncRuns.id, { onDelete: 'restrict' }),
    firstCommittedAt: timestamp('first_committed_at', { withTimezone: true, mode: 'date' }),
    revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_drive_files_file_md5').on(t.driveFileId, t.md5Checksum),
    check('chk_drive_files_file_size_non_negative', sql`file_size_bytes >= 0`),
    check(
      'chk_drive_files_exclusive_folders',
      sql`drive_folder_id IN ('1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h', '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus')`,
    ),
    check(
      'chk_drive_files_folder_bank_match',
      sql`(drive_folder_id = '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h' AND bank = 'boursobank') OR (drive_folder_id = '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus' AND bank = 'revolut')`,
    ),
    index('idx_drive_files_folder_missing').on(t.driveFolderId, t.isMissingOnDrive),
    index('idx_drive_files_revision').on(t.revision),
  ],
);

export const pdfIngestionCheckpoints = pgTable(
  'pdf_ingestion_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driveFileRecordId: uuid('drive_file_record_id')
      .notNull()
      .unique()
      .references(() => driveFiles.id, { onDelete: 'restrict' }),
    lastRunId: uuid('last_run_id')
      .notNull()
      .references(() => driveSyncRuns.id, { onDelete: 'restrict' }),
    status: checkpointStatusEnum('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    totalPages: integer('total_pages'),
    parsedPayloadHash: varchar('parsed_payload_hash', { length: 64 }),
    parsedPayloadJson: jsonb('parsed_payload_json').$type<Record<string, unknown>>(),
    statementPeriodStart: date('statement_period_start', { mode: 'string' }),
    statementPeriodEnd: date('statement_period_end', { mode: 'string' }),
    detectedAccountsCount: integer('detected_accounts_count').notNull().default(0),
    insertedTxCount: integer('inserted_tx_count').notNull().default(0),
    dedupSkippedTxCount: integer('dedup_skipped_tx_count').notNull().default(0),
    errorCode: varchar('error_code', { length: 64 }).$type<CheckpointErrorCode>(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    committedAt: timestamp('committed_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'chk_checkpoint_counts_non_negative',
      sql`attempt_count >= 0 AND detected_accounts_count >= 0 AND inserted_tx_count >= 0 AND dedup_skipped_tx_count >= 0`,
    ),
    check('chk_checkpoint_total_pages_positive', sql`total_pages IS NULL OR total_pages > 0`),
    check('chk_checkpoint_committed_ts', sql`status <> 'committed' OR committed_at IS NOT NULL`),
    check('chk_checkpoint_failed_code', sql`status <> 'failed' OR error_code IS NOT NULL`),
    check(
      'chk_checkpoint_error_code_enum',
      sql`error_code IS NULL OR error_code IN ('GEMINI_TIMEOUT', 'GEMINI_SCHEMA_INVALID', 'GEMINI_QUOTA_EXCEEDED', 'PDF_UNREADABLE', 'DRIVE_DOWNLOAD_ERROR')`,
    ),
    index('idx_checkpoints_status').on(t.status, t.updatedAt.desc()),
  ],
);

export const categorizationRules = pgTable(
  'categorization_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    priority: integer('priority').notNull().default(100),
    bankFilter: bankEnum('bank_filter'),
    accountIdFilter: uuid('account_id_filter').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    accountTypeFilter: accountTypeEnum('account_type_filter'),
    pattern: varchar('pattern', { length: 200 }).notNull(),
    matchMode: ruleMatchModeEnum('match_mode').notNull().default('contains'),
    targetCategory: varchar('target_category', { length: 64 }).notNull(),
    markAsInternalTransfer: boolean('mark_as_internal_transfer').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('chk_rules_name_non_empty', sql`char_length(trim(name)) > 0`),
    check('chk_rules_priority_range', sql`priority >= 1 AND priority <= 10000`),
    check('chk_rules_pattern_non_empty', sql`char_length(trim(pattern)) > 0`),
    check('chk_rules_target_category_non_empty', sql`char_length(trim(target_category)) > 0`),
    index('idx_rules_evaluation')
      .on(t.priority.asc(), t.createdAt.asc(), t.id.asc())
      .where(sql`is_active = true AND deleted_at IS NULL`),
    index('idx_rules_revision').on(t.revision),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    sourceDriveFileId: uuid('source_drive_file_id')
      .notNull()
      .references(() => driveFiles.id, { onDelete: 'restrict' }),
    bookingDate: date('booking_date', { mode: 'string' }).notNull(),
    valueDate: date('value_date', { mode: 'string' }),
    rawLabel: text('raw_label').notNull(),
    cleanLabel: varchar('clean_label', { length: 255 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: currencyEnum('currency').notNull(),
    fxRateMicro: bigint('fx_rate_micro', { mode: 'number' }).notNull(),
    amountEurCents: bigint('amount_eur_cents', { mode: 'number' }).notNull(),
    category: varchar('category', { length: 64 }).notNull().default('Non catégorisé'),
    matchedRuleId: uuid('matched_rule_id').references(() => categorizationRules.id, {
      onDelete: 'set null',
    }),
    isManualCategory: boolean('is_manual_category').notNull().default(false),
    isInternalTransfer: boolean('is_internal_transfer').notNull().default(false),
    isManualTransferOverride: boolean('is_manual_transfer_override').notNull().default(false),
    transferGroupId: uuid('transfer_group_id'),
    statementOccurrenceIndex: integer('statement_occurrence_index').notNull().default(1),
    dedupHash: varchar('dedup_hash', { length: 64 }).notNull().unique(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('chk_tx_amount_nonzero', sql`amount_cents <> 0`),
    check('chk_tx_fx_positive', sql`fx_rate_micro > 0`),
    check(
      'chk_tx_eur_identity',
      sql`currency <> 'EUR' OR (fx_rate_micro = 1000000 AND amount_eur_cents = amount_cents)`,
    ),
    check('chk_tx_occurrence_min', sql`statement_occurrence_index >= 1`),
    index('idx_tx_account_date')
      .on(t.accountId, t.bookingDate.desc())
      .where(sql`deleted_at IS NULL`),
    index('idx_tx_booking_date')
      .on(t.bookingDate.desc())
      .where(sql`deleted_at IS NULL`),
    index('idx_tx_aggregates')
      .on(t.isInternalTransfer, t.bookingDate, t.category)
      .where(sql`deleted_at IS NULL`),
    index('idx_tx_transfer_group')
      .on(t.transferGroupId)
      .where(sql`transfer_group_id IS NOT NULL AND deleted_at IS NULL`),
    index('idx_tx_transfer_candidates')
      .on(t.currency, t.bookingDate, t.amountCents)
      .where(
        sql`transfer_group_id IS NULL AND is_manual_transfer_override = false AND deleted_at IS NULL`,
      ),
    index('idx_tx_rules_recalc')
      .on(t.isManualCategory, t.isManualTransferOverride)
      .where(sql`deleted_at IS NULL AND transfer_group_id IS NULL`),
    index('idx_tx_revision').on(t.revision),
  ],
);

export const transactionNotes = pgTable(
  'transaction_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .unique()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check(
      'chk_tx_notes_content_length',
      sql`char_length(trim(content)) > 0 AND char_length(content) <= 2000`,
    ),
    index('idx_tx_notes_revision').on(t.revision),
  ],
);

export const syncMeta = pgTable('sync_meta', {
  key: varchar('key', { length: 64 }).primaryKey(),
  lastRecalculationRevision: bigint('last_recalculation_revision', { mode: 'number' })
    .notNull()
    .default(0),
  schemaVersion: varchar('schema_version', { length: 32 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const budgetLimits = pgTable(
  'budget_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    category: varchar('category', { length: 80 }).notNull().unique(),
    limitCents: bigint('limit_cents', { mode: 'number' }).notNull(),
    currency: currencyEnum('currency').notNull().default('EUR'),
    revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('chk_budget_limits_category_non_empty', sql`char_length(trim(category)) > 0`),
    check('chk_budget_limits_positive', sql`limit_cents > 0`),
    index('idx_budget_limits_revision').on(t.revision),
  ],
);

export const appliedClientMutations = pgTable(
  'applied_client_mutations',
  {
    clientMutationId: uuid('client_mutation_id').primaryKey(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    resultStatus: varchar('result_status', { length: 24 }).notNull(),
    resultRevision: bigint('result_revision', { mode: 'number' }).notNull(),
  },
  (t) => [
    check(
      'chk_applied_client_mutations_payload_hash_non_empty',
      sql`char_length(trim(payload_hash)) > 0`,
    ),
    check(
      'chk_applied_client_mutations_result_status',
      sql`result_status IN ('applied', 'duplicate', 'rejected')`,
    ),
    index('idx_applied_client_mutations_applied_at').on(t.appliedAt.desc()),
  ],
);

// ============================================================================
// Drizzle Relations
// ============================================================================

export const accountsRelations = relations(accounts, ({ many }) => ({
  transactions: many(transactions),
  categorizationRules: many(categorizationRules),
}));

export const driveSyncRunsRelations = relations(driveSyncRuns, ({ many }) => ({
  driveFiles: many(driveFiles),
  checkpoints: many(pdfIngestionCheckpoints),
}));

export const driveFilesRelations = relations(driveFiles, ({ one, many }) => ({
  lastSeenInRun: one(driveSyncRuns, {
    fields: [driveFiles.lastSeenInRunId],
    references: [driveSyncRuns.id],
  }),
  checkpoint: one(pdfIngestionCheckpoints, {
    fields: [driveFiles.id],
    references: [pdfIngestionCheckpoints.driveFileRecordId],
  }),
  transactions: many(transactions),
}));

export const pdfIngestionCheckpointsRelations = relations(pdfIngestionCheckpoints, ({ one }) => ({
  driveFile: one(driveFiles, {
    fields: [pdfIngestionCheckpoints.driveFileRecordId],
    references: [driveFiles.id],
  }),
  lastRun: one(driveSyncRuns, {
    fields: [pdfIngestionCheckpoints.lastRunId],
    references: [driveSyncRuns.id],
  }),
}));

export const categorizationRulesRelations = relations(categorizationRules, ({ one, many }) => ({
  accountFilter: one(accounts, {
    fields: [categorizationRules.accountIdFilter],
    references: [accounts.id],
  }),
  matchedTransactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(accounts, {
    fields: [transactions.accountId],
    references: [accounts.id],
  }),
  sourceDriveFile: one(driveFiles, {
    fields: [transactions.sourceDriveFileId],
    references: [driveFiles.id],
  }),
  matchedRule: one(categorizationRules, {
    fields: [transactions.matchedRuleId],
    references: [categorizationRules.id],
  }),
  note: one(transactionNotes, {
    fields: [transactions.id],
    references: [transactionNotes.transactionId],
  }),
}));

export const transactionNotesRelations = relations(transactionNotes, ({ one }) => ({
  transaction: one(transactions, {
    fields: [transactionNotes.transactionId],
    references: [transactions.id],
  }),
}));

// ============================================================================
// Single Source of Truth Inferred Row Types
// ============================================================================

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;

export type FxRateRow = typeof fxRates.$inferSelect;
export type NewFxRateRow = typeof fxRates.$inferInsert;

export type DriveSyncRunRow = typeof driveSyncRuns.$inferSelect;
export type NewDriveSyncRunRow = typeof driveSyncRuns.$inferInsert;

export type DriveFileRow = typeof driveFiles.$inferSelect;
export type NewDriveFileRow = typeof driveFiles.$inferInsert;

export type PdfIngestionCheckpointRow = typeof pdfIngestionCheckpoints.$inferSelect;
export type NewPdfIngestionCheckpointRow = typeof pdfIngestionCheckpoints.$inferInsert;

export type CategorizationRuleRow = typeof categorizationRules.$inferSelect;
export type NewCategorizationRuleRow = typeof categorizationRules.$inferInsert;

export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransactionRow = typeof transactions.$inferInsert;

export type TransactionNoteRow = typeof transactionNotes.$inferSelect;
export type NewTransactionNoteRow = typeof transactionNotes.$inferInsert;

export type SyncMetaRow = typeof syncMeta.$inferSelect;
export type NewSyncMetaRow = typeof syncMeta.$inferInsert;

export type BudgetLimitRow = typeof budgetLimits.$inferSelect;
export type NewBudgetLimitRow = typeof budgetLimits.$inferInsert;

export type AppliedClientMutationRow = typeof appliedClientMutations.$inferSelect;
export type NewAppliedClientMutationRow = typeof appliedClientMutations.$inferInsert;

export const schema = {
  syncRevisionSeq,
  bankEnum,
  accountTypeEnum,
  currencyEnum,
  fxSourceEnum,
  ruleMatchModeEnum,
  syncTriggerEnum,
  syncRunStatusEnum,
  checkpointStatusEnum,
  accounts,
  fxRates,
  driveSyncRuns,
  driveFiles,
  pdfIngestionCheckpoints,
  categorizationRules,
  transactions,
  transactionNotes,
  syncMeta,
  budgetLimits,
  appliedClientMutations,
  accountsRelations,
  driveSyncRunsRelations,
  driveFilesRelations,
  pdfIngestionCheckpointsRelations,
  categorizationRulesRelations,
  transactionsRelations,
  transactionNotesRelations,
} as const;
