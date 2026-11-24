import { z } from 'zod';

// ============================================================================
// Branded Primitives & Safe Constructors
// ============================================================================

const SafeIntSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const AccountIdSchema = z.string().uuid().brand<'AccountId'>();
export type AccountId = z.infer<typeof AccountIdSchema>;

export const TransactionIdSchema = z.string().uuid().brand<'TransactionId'>();
export type TransactionId = z.infer<typeof TransactionIdSchema>;

export const RuleIdSchema = z.string().uuid().brand<'RuleId'>();
export type RuleId = z.infer<typeof RuleIdSchema>;

export const DriveFileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .brand<'DriveFileId'>();
export type DriveFileId = z.infer<typeof DriveFileIdSchema>;

export const CentsSchema = SafeIntSchema.brand<'Cents'>();
export type Cents = z.infer<typeof CentsSchema>;

export const FxRateMicroSchema = SafeIntSchema.positive().brand<'FxRateMicro'>();
export type FxRateMicro = z.infer<typeof FxRateMicroSchema>;

export const SyncRevisionSchema = SafeIntSchema.nonnegative().brand<'SyncRevision'>();
export type SyncRevision = z.infer<typeof SyncRevisionSchema>;

export function parseAccountId(value: unknown): AccountId {
  return AccountIdSchema.parse(value);
}

export function parseTransactionId(value: unknown): TransactionId {
  return TransactionIdSchema.parse(value);
}

export function parseRuleId(value: unknown): RuleId {
  return RuleIdSchema.parse(value);
}

export function parseDriveFileId(value: unknown): DriveFileId {
  return DriveFileIdSchema.parse(value);
}

export function toCents(value: number): Cents {
  const normalized = Object.is(value, -0) ? 0 : value;
  return CentsSchema.parse(normalized);
}

export function toFxRateMicro(value: number): FxRateMicro {
  return FxRateMicroSchema.parse(value);
}

export function toSyncRevision(value: number): SyncRevision {
  const normalized = Object.is(value, -0) ? 0 : value;
  return SyncRevisionSchema.parse(normalized);
}

// ============================================================================
// Normative Enums & Drive Scope Constants
// ============================================================================

export const BankSchema = z.enum(['boursobank', 'revolut']);
export type Bank = z.infer<typeof BankSchema>;

export const AccountTypeSchema = z.enum([
  'courant',
  'epargne',
  'carte_differee',
  'multi_devises',
  'coffre',
  'autre',
]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const CurrencySchema = z.enum(['EUR', 'USD']);
export type Currency = z.infer<typeof CurrencySchema>;

export const FxSourceSchema = z.enum([
  'revolut_statement',
  'ecb_reference',
  'nearest_business_day',
  'manual_override',
]);
export type FxSource = z.infer<typeof FxSourceSchema>;

export const RuleMatchModeSchema = z.enum([
  'contains',
  'starts_with',
  'exact',
  'regex',
]);
export type RuleMatchMode = z.infer<typeof RuleMatchModeSchema>;

export const SyncTriggerSchema = z.enum(['manual']);
export type SyncTrigger = z.infer<typeof SyncTriggerSchema>;

export const SyncRunStatusSchema = z.enum([
  'running',
  'completed',
  'partial_error',
  'failed',
]);
export type SyncRunStatus = z.infer<typeof SyncRunStatusSchema>;

export const CheckpointStatusSchema = z.enum([
  'pending',
  'skipped',
  'extracting',
  'parsed',
  'committing',
  'committed',
  'failed',
]);
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;

export const CheckpointErrorCodeSchema = z.enum([
  'GEMINI_TIMEOUT',
  'GEMINI_SCHEMA_INVALID',
  'GEMINI_QUOTA_EXCEEDED',
  'PDF_UNREADABLE',
  'DRIVE_DOWNLOAD_ERROR',
]);
export type CheckpointErrorCode = z.infer<typeof CheckpointErrorCodeSchema>;

export const ApiErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'INVALID_DRIVE_FOLDER_SCOPE',
  'CSRF_ORIGIN_MISMATCH',
  'RESOURCE_NOT_FOUND',
  'SYNC_ALREADY_RUNNING',
  'FILE_NOT_RETRYABLE',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'UPSTREAM_DRIVE_ERROR',
  'UPSTREAM_GEMINI_ERROR',
  'DATABASE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ALLOWED_DRIVE_FOLDERS = {
  boursobank: '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h',
  revolut: '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus',
} as const satisfies Record<Bank, string>;

export type AllowedDriveFolderId =
  (typeof ALLOWED_DRIVE_FOLDERS)[keyof typeof ALLOWED_DRIVE_FOLDERS];

export const AllowedDriveFolderIdSchema = z.enum([
  ALLOWED_DRIVE_FOLDERS.boursobank,
  ALLOWED_DRIVE_FOLDERS.revolut,
]);

export const EUR_FX_RATE_MICRO: FxRateMicro = toFxRateMicro(1_000_000);
export const CLAIRFLUX_DELTA_SCHEMA_VERSION = '1.0.0' as const;
export const CLAIRFLUX_BUILD_VERSION = '1.0.1-build.2' as const;

export function isAllowedDriveFolderId(
  folderId: string,
): folderId is AllowedDriveFolderId {
  return (
    folderId === ALLOWED_DRIVE_FOLDERS.boursobank ||
    folderId === ALLOWED_DRIVE_FOLDERS.revolut
  );
}

export function getBankForDriveFolder(folderId: string): Bank | null {
  if (folderId === ALLOWED_DRIVE_FOLDERS.boursobank) {
    return 'boursobank';
  }
  if (folderId === ALLOWED_DRIVE_FOLDERS.revolut) {
    return 'revolut';
  }
  return null;
}

// ============================================================================
// Core Domain & Delta Sync Zod Schemas
// ============================================================================

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected ISO calendar date YYYY-MM-DD');

export const IsoMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Expected ISO calendar month YYYY-MM');

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const AccountSchema = z.object({
  id: AccountIdSchema,
  bank: BankSchema,
  account_type: AccountTypeSchema,
  nickname: z.string().trim().min(1).max(80),
  external_ref_masked: z.string().trim().min(1).max(64),
  currency: CurrencySchema,
  current_balance_cents: CentsSchema,
  current_balance_eur_cents: CentsSchema,
  balance_updated_at: IsoDateTimeSchema.nullable(),
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type Account = z.infer<typeof AccountSchema>;

export const TransactionSchema = z.object({
  id: TransactionIdSchema,
  account_id: AccountIdSchema,
  bank: BankSchema,
  account_type: AccountTypeSchema,
  external_ref_masked: z.string().trim().min(1).max(64),
  booking_date: IsoDateSchema,
  value_date: IsoDateSchema.nullable(),
  raw_label: z.string().min(1),
  clean_label: z.string().min(1).max(255),
  amount_cents: CentsSchema.refine((value) => value !== 0, {
    message: 'Transaction amount_cents cannot be 0',
  }),
  currency: CurrencySchema,
  fx_rate_micro: FxRateMicroSchema,
  amount_eur_cents: CentsSchema,
  category: z.string().trim().min(1).max(64),
  is_manual_category: z.boolean(),
  matched_rule_id: RuleIdSchema.nullable(),
  is_internal_transfer: z.boolean(),
  is_manual_transfer_override: z.boolean(),
  transfer_group_id: z.string().uuid().nullable(),
  source_drive_file_id: z.string().uuid(),
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const TransactionNoteSchema = z.object({
  transaction_id: TransactionIdSchema,
  content: z.string().trim().min(1).max(2000),
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type TransactionNote = z.infer<typeof TransactionNoteSchema>;

export const CategorizationRuleSchema = z.object({
  id: RuleIdSchema,
  name: z.string().trim().min(1).max(100),
  priority: z.number().int().min(1).max(10000),
  bank_filter: BankSchema.nullable(),
  account_id_filter: AccountIdSchema.nullable(),
  account_type_filter: AccountTypeSchema.nullable(),
  match_mode: RuleMatchModeSchema,
  pattern: z.string().trim().min(1).max(200),
  target_category: z.string().trim().min(1).max(64),
  mark_as_internal_transfer: z.boolean(),
  is_active: z.boolean(),
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type CategorizationRule = z.infer<typeof CategorizationRuleSchema>;

export const DriveSyncRunSummarySchema = z.object({
  id: z.string().uuid(),
  status: SyncRunStatusSchema,
  trigger_mode: SyncTriggerSchema,
  started_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
  total_files_discovered: z.number().int().nonnegative(),
  files_committed: z.number().int().nonnegative(),
  files_skipped_unchanged: z.number().int().nonnegative(),
  files_failed: z.number().int().nonnegative(),
  error_summary: z.string().nullable().optional(),
});
export type DriveSyncRunSummary = z.infer<typeof DriveSyncRunSummarySchema>;

export const DriveSyncFileStatusSchema = z.object({
  drive_file_id: DriveFileIdSchema,
  drive_folder_id: AllowedDriveFolderIdSchema,
  bank: BankSchema,
  file_name: z.string().trim().min(1).max(255),
  status: CheckpointStatusSchema,
  attempt_count: z.number().int().nonnegative(),
  error_code: CheckpointErrorCodeSchema.nullable(),
  error_message: z.string().nullable(),
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type DriveSyncFileStatus = z.infer<typeof DriveSyncFileStatusSchema>;

export const DriveSyncStatusSchema = z.object({
  last_run: DriveSyncRunSummarySchema.nullable(),
  files: z.array(DriveSyncFileStatusSchema),
});
export type DriveSyncStatus = z.infer<typeof DriveSyncStatusSchema>;

export const AggregateKpisSchema = z.object({
  consolidated_balance_cents: CentsSchema,
  month_income_cents: CentsSchema,
  month_expenses_excl_transfers_cents: CentsSchema,
  month_internal_transfers_cents: CentsSchema,
});
export type AggregateKpis = z.infer<typeof AggregateKpisSchema>;

export const CumulativeBalancePointSchema = z.object({
  month: IsoMonthSchema,
  label: z.string().min(1),
  closing_balance_cents: CentsSchema,
  net_change_cents: CentsSchema,
});
export type CumulativeBalancePoint = z.infer<typeof CumulativeBalancePointSchema>;

export const ExpenseComparisonItemSchema = z.object({
  category: z.string().min(1).max(64),
  m_minus_1_cents: CentsSchema,
  avg_3m_cents: CentsSchema,
  delta_percent: z.number().finite(),
  transaction_count_m1: z.number().int().nonnegative(),
});
export type ExpenseComparisonItem = z.infer<typeof ExpenseComparisonItemSchema>;

export const ScopeAggregateViewSchema = z.object({
  display_currency: CurrencySchema,
  reference_month: IsoMonthSchema,
  kpis: AggregateKpisSchema,
  cumulative_balance_6m: z.array(CumulativeBalancePointSchema),
  expenses_m1_vs_avg3m: z.array(ExpenseComparisonItemSchema),
});
export type ScopeAggregateView = z.infer<typeof ScopeAggregateViewSchema>;

export const AggregatesSnapshotSchema = z.object({
  computed_at: IsoDateTimeSchema,
  data_revision: SyncRevisionSchema,
  by_scope: z.record(z.string(), ScopeAggregateViewSchema),
});
export type AggregatesSnapshot = z.infer<typeof AggregatesSnapshotSchema>;

export const DeltaSyncResponseSchema = z.object({
  since_revision: SyncRevisionSchema,
  batch_end_revision: SyncRevisionSchema,
  latest_revision: SyncRevisionSchema,
  has_more: z.boolean(),
  full_resync_required: z.boolean(),
  server_time: IsoDateTimeSchema,
  accounts: z.object({
    upserted: z.array(AccountSchema),
    deleted_ids: z.array(AccountIdSchema),
  }),
  transactions: z.object({
    upserted: z.array(TransactionSchema),
    deleted_ids: z.array(TransactionIdSchema),
  }),
  transaction_notes: z.object({
    upserted: z.array(TransactionNoteSchema),
    deleted_transaction_ids: z.array(TransactionIdSchema),
  }),
  categorization_rules: z.object({
    upserted: z.array(CategorizationRuleSchema),
    deleted_ids: z.array(RuleIdSchema),
  }),
  drive_sync_status: DriveSyncStatusSchema,
  aggregates_snapshot: AggregatesSnapshotSchema.nullable(),
});
export type DeltaSyncResponse = z.infer<typeof DeltaSyncResponseSchema>;

export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    retryable: z.boolean().optional(),
    request_id: z.string().optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

// ============================================================================
// Pure Monetary Arithmetic & Exhaustiveness Helpers
// ============================================================================

const MICRO_UNIT = 1_000_000n;
const HALF_MICRO_UNIT = 500_000n;

/**
 * Converts a signed integer amount in cents into EUR cents using a micro-unit
 * FX rate (`1.000000` = `1_000_000`), avoiding intermediate float overflow and
 * matching `Math.round((amountCents * fxRateMicro) / 1_000_000)` semantics.
 */
export function convertToEurCents(
  amountCents: Cents,
  fxRateMicro: FxRateMicro,
): Cents {
  if (fxRateMicro === EUR_FX_RATE_MICRO) {
    return amountCents;
  }

  const scaled = BigInt(amountCents) * BigInt(fxRateMicro);
  const quotient = scaled / MICRO_UNIT;
  const remainder = scaled % MICRO_UNIT;

  let rounded = quotient;
  if (remainder >= HALF_MICRO_UNIT) {
    rounded += 1n;
  } else if (remainder < -HALF_MICRO_UNIT) {
    rounded -= 1n;
  }

  const numeric = Number(rounded);
  return toCents(numeric === 0 ? 0 : numeric);
}

/**
 * Formats an integer cents amount for display using `fr-FR` locale rules.
 * Division by 100 is strictly confined to UI presentation.
 */
export function formatMoney(cents: Cents, currency: Currency): string {
  const safeValue = cents === 0 ? 0 : cents;
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeValue / 100);
}

/**
 * Compile-time and runtime exhaustiveness guard for discriminated unions and enums.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(
    message ?? `Unexpected value in exhaustive check: ${String(value)}`,
  );
}
