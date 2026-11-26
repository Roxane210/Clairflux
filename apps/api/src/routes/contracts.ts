import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ALLOWED_DRIVE_FOLDERS,
  AccountIdSchema,
  AccountTypeSchema,
  AggregateKpisSchema,
  AiReviewStatusSchema,
  BankSchema,
  BudgetGroupSchema,
  CategoryIdSchema,
  CategorySchema,
  CategorySourceSchema,
  CentsSchema,
  CumulativeBalancePointSchema,
  CurrencySchema,
  ExpenseComparisonItemSchema,
  FxRateMicroSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  IsoMonthSchema,
  RuleIdSchema,
  RuleMatchModeSchema,
  SyncRevisionSchema,
  TransactionIdSchema,
  toCents,
  toSyncRevision,
  type Account,
  type AccountId,
  type AccountType,
  type AiReviewStatus,
  type AllowedDriveFolderId,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type Bank,
  type BudgetGroup,
  type Category,
  type CategoryId,
  type CategorySource,
  type Cents,
  type CumulativeBalancePoint,
  type Currency,
  type DeltaSyncResponse,
  type ExpenseComparisonItem,
  type FxRateMicro,
  type RuleId,
  type RuleMatchMode,
  type SyncRevision,
  type SyncRunStatus,
  type SyncTrigger,
  type TransactionId,
} from '@clairflux/shared';
import { isEligibleForRuleRecalc, normalizeLabel } from '../db/dedup.js';

// ============================================================================
// HTTP Context, Error Envelope & Boundary Helpers
// ============================================================================

export const ClientKindSchema = z.enum(['web', 'android']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

export const LoginBodySchema = z
  .object({
    secret: z.string().min(1, 'Le secret personnel est requis.').max(256),
    client_kind: ClientKindSchema.default('web'),
    device_label: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const LogoutBodySchema = z
  .object({
    revoke_all: z.boolean().default(false),
  })
  .strict();
export type LogoutBody = z.infer<typeof LogoutBodySchema>;

export const SessionTokenPayloadSchema = z.object({
  jti: z.string().uuid(),
  client_kind: ClientKindSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type SessionTokenPayload = z.infer<typeof SessionTokenPayloadSchema>;

export interface AuthenticatedSession {
  readonly payload: SessionTokenPayload;
  readonly transport: 'bearer' | 'cookie';
}

export interface AppEnv {
  Variables: {
    readonly requestId: string;
    readonly session: AuthenticatedSession;
  };
}

export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

export function resolveRequestId(c: Context<AppEnv>): string {
  const existing = c.get('requestId');
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const incoming = c.req.header('X-Request-Id')?.trim();
  if (incoming !== undefined && incoming.length > 0 && incoming.length <= 64) {
    return incoming;
  }
  return randomUUID();
}

export function errorResponse(
  c: Context<AppEnv>,
  status: HttpErrorStatus,
  code: ApiErrorCode,
  message: string,
  options?: {
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  },
): Response {
  const requestId = resolveRequestId(c);
  const body: ApiErrorEnvelope = {
    error: {
      code,
      message,
      retryable: options?.retryable ?? false,
      request_id: requestId,
      ...(options?.details !== undefined ? { details: { ...options.details } } : {}),
    },
  };
  return c.json(body, status);
}

export function formatZodIssues(error: z.ZodError): Readonly<Record<string, unknown>> {
  const first = error.issues[0];
  return {
    ...(first !== undefined
      ? {
          field: first.path.length > 0 ? first.path.join('.') : 'input',
          issue: first.code,
        }
      : {}),
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

export async function parseJsonBody(
  c: Context<AppEnv>,
): Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly response: Response }> {
  const rawBody = await c.req.text();
  if (rawBody.trim().length === 0) {
    return {
      ok: false,
      response: errorResponse(c, 400, 'BAD_REQUEST', 'Corps JSON requis et non vide.'),
    };
  }
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return { ok: true, data: parsed };
  } catch {
    return {
      ok: false,
      response: errorResponse(c, 400, 'BAD_REQUEST', 'Corps JSON malformé.'),
    };
  }
}

// ============================================================================
// Calendar & Shared Query Primitives
// ============================================================================

export const CalendarIsoDateSchema = IsoDateSchema.refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Date calendaire YYYY-MM-DD invalide.');

const StrictNonNegativeIntStringSchema = z
  .string({ required_error: 'Le paramètre since est requis.' })
  .regex(/^(0|[1-9]\d*)$/, 'Le paramètre since doit être un entier >= 0.')
  .transform((value) => Number(value))
  .refine(
    (num) => Number.isSafeInteger(num) && num >= 0,
    'Le paramètre since est hors plage.',
  );

const StrictDeltaLimitStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Le paramètre limit doit être un entier entre 50 et 1000.')
  .transform((value) => Number(value))
  .refine(
    (num) => Number.isSafeInteger(num) && num >= 50 && num <= 1000,
    'Le paramètre limit doit être compris entre 50 et 1000.',
  );

const StrictTxLimitStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Le paramètre limit doit être un entier entre 1 et 200.')
  .transform((value) => Number(value))
  .refine(
    (num) => Number.isSafeInteger(num) && num >= 1 && num <= 200,
    'Le paramètre limit doit être compris entre 1 et 200.',
  );

const BooleanStringSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

// ============================================================================
// 1. Accounts, Delta Sync & Drive Sync Contracts
// ============================================================================

export interface HealthRepository {
  ping(): Promise<boolean>;
}

export interface SessionRepository {
  isSessionRevoked(jti: string, iat?: number): Promise<boolean>;
  revokeSession?(jti: string): Promise<void>;
  revokeAllSessions?(revokedBeforeEpochSeconds: number): Promise<void>;
}

export interface AccountsFilter {
  readonly bank?: Bank;
  readonly currency?: Currency;
}

export interface AccountsListResult {
  readonly accounts: readonly Account[];
  readonly latest_revision: SyncRevision;
}

export interface AccountsRepository {
  listAccounts(filter: AccountsFilter): Promise<AccountsListResult>;
}

export const AccountsQuerySchema = z.object({
  bank: BankSchema.optional(),
  currency: CurrencySchema.optional(),
});

export interface DeltaSyncQuery {
  readonly since: SyncRevision;
  readonly limit: number;
  readonly since_timestamp?: string;
}

export interface SyncDeltaRepository {
  getDelta(query: DeltaSyncQuery): Promise<DeltaSyncResponse>;
}

export const DeltaSyncQuerySchema = z.object({
  since: StrictNonNegativeIntStringSchema.transform((num) => toSyncRevision(num)),
  since_timestamp: IsoDateTimeSchema.optional(),
  limit: StrictDeltaLimitStringSchema.optional(),
});

export const OutboxMutationSchema = z.discriminatedUnion('kind', [
  z.object({
    client_mutation_id: z.string().uuid(),
    kind: z.literal('upsert_note'),
    transaction_id: TransactionIdSchema,
    note: z.string().trim().min(1).max(2000).nullable(),
    client_updated_at: IsoDateTimeSchema.optional(),
  }),
  z.object({
    client_mutation_id: z.string().uuid(),
    kind: z.literal('set_category'),
    transaction_id: TransactionIdSchema,
    category: z.string().trim().min(1).max(64),
    category_id: CategoryIdSchema.nullable().optional(),
    subcategory_id: CategoryIdSchema.nullable().optional(),
    client_updated_at: IsoDateTimeSchema.optional(),
  }),
  z.object({
    client_mutation_id: z.string().uuid(),
    kind: z.literal('set_internal_transfer'),
    transaction_id: TransactionIdSchema,
    is_internal_transfer: z.boolean(),
    client_updated_at: IsoDateTimeSchema.optional(),
  }),
]);
export type OutboxMutation = z.infer<typeof OutboxMutationSchema>;

export const PostSyncDeltaBodySchema = z.object({
  mutations: z.array(OutboxMutationSchema).min(1).max(100),
});
export type PostSyncDeltaBody = z.infer<typeof PostSyncDeltaBodySchema>;

export const OutboxMutationOutcomeSchema = z.discriminatedUnion('status', [
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
    reason: z.enum(['RESOURCE_NOT_FOUND', 'VALIDATION_ERROR', 'CONFLICT']),
    message: z.string().min(1),
  }),
]);
export type OutboxMutationOutcome = z.infer<typeof OutboxMutationOutcomeSchema>;

export const PostSyncDeltaResponseSchema = z.object({
  results: z.array(OutboxMutationOutcomeSchema),
  latest_revision: SyncRevisionSchema,
});
export type PostSyncDeltaResponse = z.infer<typeof PostSyncDeltaResponseSchema>;

export interface DeltaMutationRepository {
  applyOutboxBatch(mutations: readonly OutboxMutation[]): Promise<PostSyncDeltaResponse>;
}

export interface AllowedDriveFolderDescriptor {
  readonly folder_id: AllowedDriveFolderId;
  readonly bank: Bank;
}

export interface DriveSyncRunStarted {
  readonly id: string;
  readonly status: Extract<SyncRunStatus, 'running'>;
  readonly trigger_mode: SyncTrigger;
  readonly allowed_folders: readonly AllowedDriveFolderDescriptor[];
  readonly started_at: string;
}

export type TriggerDriveSyncResult =
  | { readonly ok: true; readonly run: DriveSyncRunStarted }
  | { readonly ok: false; readonly reason: 'already_running'; readonly activeRunId: string }
  | { readonly ok: false; readonly reason: 'upstream_error'; readonly message: string };

export interface DriveSyncService {
  triggerManualSync(): Promise<TriggerDriveSyncResult>;
}

export const EXCLUSIVE_DRIVE_FOLDERS: readonly AllowedDriveFolderDescriptor[] = [
  { folder_id: ALLOWED_DRIVE_FOLDERS.boursobank, bank: 'boursobank' },
  { folder_id: ALLOWED_DRIVE_FOLDERS.revolut, bank: 'revolut' },
] as const;

// ============================================================================
// 2. Transactions Contracts (GET /api/transactions, PATCH /api/transactions/:id)
// ============================================================================

export const TransactionsQuerySchema = z
  .object({
    bank: BankSchema.optional(),
    account_id: AccountIdSchema.optional(),
    currency: CurrencySchema.optional(),
    has_notes: BooleanStringSchema.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    from: CalendarIsoDateSchema.optional(),
    to: CalendarIsoDateSchema.optional(),
    limit: StrictTxLimitStringSchema.optional(),
  })
  .refine(
    (q) => q.from === undefined || q.to === undefined || q.from <= q.to,
    {
      message: 'Le paramètre from doit être antérieur ou égal à to.',
      path: ['from'],
    },
  );

export const TransactionIdParamSchema = z.object({
  id: TransactionIdSchema,
});

export const PatchTransactionBodySchema = z
  .object({
    note: z.string().trim().min(1).max(2000).nullable().optional(),
    category: z.string().trim().min(1).max(64).optional(),
    category_id: CategoryIdSchema.nullable().optional(),
    subcategory_id: CategoryIdSchema.nullable().optional(),
    is_manual_category: z.boolean().optional(),
    is_internal_transfer: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.note !== undefined ||
      body.category !== undefined ||
      body.category_id !== undefined ||
      body.subcategory_id !== undefined ||
      body.is_manual_category !== undefined ||
      body.is_internal_transfer !== undefined,
    {
      message:
        'Au moins un champ (note, category, category_id, subcategory_id, is_manual_category, is_internal_transfer) doit être fourni.',
    },
  )
  .refine(
    (body) =>
      !(
        body.subcategory_id !== undefined &&
        body.subcategory_id !== null &&
        body.category_id === null
      ),
    {
      message: 'subcategory_id nécessite un category_id non nul.',
      path: ['subcategory_id'],
    },
  );

export type PatchTransactionBody = z.infer<typeof PatchTransactionBodySchema>;

export const TransactionDetailSchema = z.object({
  id: TransactionIdSchema,
  account_id: AccountIdSchema,
  bank: BankSchema,
  account_type: AccountTypeSchema,
  account_nickname: z.string().min(1).max(80),
  external_ref_masked: z.string().min(1).max(64),
  booking_date: CalendarIsoDateSchema,
  value_date: CalendarIsoDateSchema.nullable(),
  raw_label: z.string().min(1),
  clean_label: z.string().min(1).max(255),
  amount_cents: CentsSchema,
  currency: CurrencySchema,
  fx_rate_micro: FxRateMicroSchema,
  amount_eur_cents: CentsSchema,
  category: z.string().trim().min(1).max(64),
  category_id: CategoryIdSchema.nullable().optional(),
  subcategory_id: CategoryIdSchema.nullable().optional(),
  category_source: CategorySourceSchema.optional(),
  ai_review_status: AiReviewStatusSchema.optional(),
  is_manual_category: z.boolean(),
  matched_rule_id: RuleIdSchema.nullable(),
  is_internal_transfer: z.boolean(),
  is_manual_transfer_override: z.boolean(),
  transfer_group_id: z.string().uuid().nullable(),
  source_drive_file_id: z.string().uuid(),
  note: z
    .object({
      content: z.string().min(1).max(2000),
      updated_at: IsoDateTimeSchema,
    })
    .nullable(),
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type TransactionDetail = z.infer<typeof TransactionDetailSchema>;

export interface TransactionsFilter {
  readonly bank?: Bank;
  readonly account_id?: AccountId;
  readonly currency?: Currency;
  readonly has_notes?: boolean;
  readonly search?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
}

export interface TransactionsListResult {
  readonly items: readonly TransactionDetail[];
  readonly total_count: number;
  readonly latest_revision: SyncRevision;
}

export interface TransactionPatchInput {
  readonly note?: string | null;
  readonly category?: string;
  readonly category_id?: CategoryId | null;
  readonly subcategory_id?: CategoryId | null;
  readonly is_manual_category?: boolean;
  readonly is_internal_transfer?: boolean;
}

export type PatchTransactionResult =
  | {
      readonly ok: true;
      readonly transaction: TransactionDetail;
      readonly latest_revision: SyncRevision;
    }
  | { readonly ok: false; readonly reason: 'not_found' };

export interface TransactionsRepository {
  listTransactions(filter: TransactionsFilter): Promise<TransactionsListResult>;
  patchTransaction(id: TransactionId, patch: TransactionPatchInput): Promise<PatchTransactionResult>;
}

// ============================================================================
// 3. Categorization Rules Contracts & Pure Engine
// ============================================================================

const MAX_REGEX_LENGTH = 120;

/**
 * Validates that a regex pattern is syntactically valid and free of common ReDoS constructs
 * (nested quantifiers, backreferences, lookbehinds, excessive length).
 */
export function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_REGEX_LENGTH) {
    return false;
  }
  if (/\\[1-9]/u.test(pattern)) {
    return false;
  }
  if (/\(\?<[=!]/u.test(pattern)) {
    return false;
  }
  if (/\([^)]*[+*?][^)]*\)[+*?{]/u.test(pattern)) {
    return false;
  }
  if (/[+*?]\s*[+*?]/u.test(pattern)) {
    return false;
  }
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

export const CreateRuleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    priority: z.number().int().min(1).max(10000).default(100),
    bank_filter: BankSchema.nullable().default(null),
    account_id_filter: AccountIdSchema.nullable().default(null),
    account_type_filter: AccountTypeSchema.nullable().default(null),
    match_mode: RuleMatchModeSchema.default('contains'),
    pattern: z.string().trim().min(1).max(200),
    target_category: z.string().trim().min(1).max(64),
    target_category_id: CategoryIdSchema.nullable().optional(),
    target_subcategory_id: CategoryIdSchema.nullable().optional(),
    mark_as_internal_transfer: z.boolean().default(false),
    is_active: z.boolean().default(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.target_subcategory_id !== undefined &&
      data.target_subcategory_id !== null &&
      data.target_category_id === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_subcategory_id'],
        message: 'target_subcategory_id nécessite un target_category_id non nul.',
      });
    }
    if (data.match_mode === 'regex' && !isSafeRegexPattern(data.pattern)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: 'Expression régulière invalide ou non bornée (protection anti-ReDoS).',
      });
    }
  });
export type CreateRuleInput = z.infer<typeof CreateRuleBodySchema>;

export const UpdateRuleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    priority: z.number().int().min(1).max(10000).optional(),
    bank_filter: BankSchema.nullable().optional(),
    account_id_filter: AccountIdSchema.nullable().optional(),
    account_type_filter: AccountTypeSchema.nullable().optional(),
    match_mode: RuleMatchModeSchema.optional(),
    pattern: z.string().trim().min(1).max(200).optional(),
    target_category: z.string().trim().min(1).max(64).optional(),
    target_category_id: CategoryIdSchema.nullable().optional(),
    target_subcategory_id: CategoryIdSchema.nullable().optional(),
    mark_as_internal_transfer: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasField = Object.values(data).some((value) => value !== undefined);
    if (!hasField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Au moins un champ de règle à modifier est requis.',
      });
    }
    if (
      data.target_subcategory_id !== undefined &&
      data.target_subcategory_id !== null &&
      data.target_category_id === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_subcategory_id'],
        message: 'target_subcategory_id nécessite un target_category_id non nul.',
      });
    }
    if (
      data.match_mode === 'regex' &&
      data.pattern !== undefined &&
      !isSafeRegexPattern(data.pattern)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: 'Expression régulière invalide ou non bornée (protection anti-ReDoS).',
      });
    }
  });
export type UpdateRuleInput = z.infer<typeof UpdateRuleBodySchema>;

export const RuleIdParamSchema = z.object({
  id: RuleIdSchema,
});

export const ReorderRuleItemSchema = z.object({
  id: RuleIdSchema,
  priority: z.number().int().min(1).max(10000),
});
export type ReorderRuleItem = z.infer<typeof ReorderRuleItemSchema>;

export const ReorderRulesBodySchema = z
  .object({
    items: z.array(ReorderRuleItemSchema).min(1).max(500),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of data.items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'id'],
          message: 'Identifiant de règle dupliqué dans reorder.',
        });
      }
      seen.add(item.id);
    }
  });

export const ReapplyRulesBodySchema = z.object({}).strict();

export const RuleViewSchema = z.object({
  id: RuleIdSchema,
  name: z.string().min(1).max(100),
  priority: z.number().int().min(1).max(10000),
  bank_filter: BankSchema.nullable(),
  account_id_filter: AccountIdSchema.nullable(),
  account_type_filter: AccountTypeSchema.nullable(),
  match_mode: RuleMatchModeSchema,
  pattern: z.string().min(1).max(200),
  target_category: z.string().min(1).max(64),
  target_category_id: CategoryIdSchema.nullable().optional(),
  target_subcategory_id: CategoryIdSchema.nullable().optional(),
  mark_as_internal_transfer: z.boolean(),
  is_active: z.boolean(),
  matched_transactions_count: z.number().int().nonnegative(),
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type RuleView = z.infer<typeof RuleViewSchema>;

export interface RetroactiveStats {
  readonly updated_count: number;
  readonly skipped_protected_count: number;
}

export interface RulesListResult {
  readonly rules: readonly RuleView[];
  readonly latest_revision: SyncRevision;
}

export interface RuleMutationResult {
  readonly rule: RuleView;
  readonly retroactive_stats: RetroactiveStats;
  readonly latest_revision: SyncRevision;
}

export interface DeleteRuleResult {
  readonly deleted_rule_id: RuleId;
  readonly retroactive_stats: RetroactiveStats;
  readonly latest_revision: SyncRevision;
}

export interface ReorderRulesResult {
  readonly rules: readonly RuleView[];
  readonly retroactive_stats: RetroactiveStats;
  readonly latest_revision: SyncRevision;
}

export interface ReapplyRulesResult {
  readonly retroactive_stats: RetroactiveStats;
  readonly latest_revision: SyncRevision;
}

export type UpdateRuleResult =
  | { readonly ok: true; readonly data: RuleMutationResult }
  | { readonly ok: false; readonly reason: 'not_found' | 'invalid_regex' };

export type DeleteRuleOutcome =
  | { readonly ok: true; readonly data: DeleteRuleResult }
  | { readonly ok: false; readonly reason: 'not_found' };

export interface RulesRepository {
  listRules(): Promise<RulesListResult>;
  createRule(input: CreateRuleInput): Promise<RuleMutationResult>;
  updateRule(id: RuleId, input: UpdateRuleInput): Promise<UpdateRuleResult>;
  deleteRule(id: RuleId): Promise<DeleteRuleOutcome>;
  reorderRules(items: readonly ReorderRuleItem[]): Promise<ReorderRulesResult>;
  reapplyRules(): Promise<ReapplyRulesResult>;
}

export interface RuleEvalRule {
  readonly id: RuleId;
  readonly priority: number;
  readonly bank_filter: Bank | null;
  readonly account_id_filter: AccountId | null;
  readonly account_type_filter: AccountType | null;
  readonly match_mode: RuleMatchMode;
  readonly pattern: string;
  readonly target_category: string;
  readonly target_category_id?: CategoryId | null | undefined;
  readonly target_subcategory_id?: CategoryId | null | undefined;
  readonly mark_as_internal_transfer: boolean;
  readonly is_active: boolean;
  readonly deleted_at: Date | null;
  readonly created_at_ms?: number;
}

export interface RuleEvalTransaction {
  readonly id: TransactionId;
  readonly account_id: AccountId;
  readonly bank: Bank;
  readonly account_type: AccountType;
  readonly raw_label: string;
  readonly clean_label: string;
  readonly category: string;
  readonly matched_rule_id: RuleId | null;
  readonly is_manual_category: boolean;
  readonly is_internal_transfer: boolean;
  readonly is_manual_transfer_override: boolean;
  readonly transfer_group_id: string | null;
  readonly deleted_at: Date | null;
}

function matchesLabel(label: string, mode: RuleMatchMode, pattern: string): boolean {
  const lowerLabel = label.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  switch (mode) {
    case 'contains':
      return lowerLabel.includes(lowerPattern);
    case 'starts_with':
      return lowerLabel.startsWith(lowerPattern);
    case 'exact':
      return lowerLabel === lowerPattern;
    case 'regex': {
      if (!isSafeRegexPattern(pattern)) {
        return false;
      }
      return new RegExp(pattern, 'i').test(label);
    }
  }
}

export function evaluateRuleMatch(
  rule: RuleEvalRule,
  tx: RuleEvalTransaction,
): boolean {
  if (!rule.is_active || rule.deleted_at !== null) {
    return false;
  }
  if (rule.bank_filter !== null && rule.bank_filter !== tx.bank) {
    return false;
  }
  if (rule.account_id_filter !== null && rule.account_id_filter !== tx.account_id) {
    return false;
  }
  if (rule.account_type_filter !== null && rule.account_type_filter !== tx.account_type) {
    return false;
  }
  return (
    matchesLabel(tx.clean_label, rule.match_mode, rule.pattern) ||
    matchesLabel(tx.raw_label, rule.match_mode, rule.pattern)
  );
}

export interface EvaluatedRuleChange {
  readonly transactionId: TransactionId;
  readonly nextCategory: string;
  readonly nextTargetCategoryId?: CategoryId | null | undefined;
  readonly nextTargetSubcategoryId?: CategoryId | null | undefined;
  readonly nextMatchedRuleId: RuleId | null;
  readonly nextIsInternalTransfer: boolean;
}

export interface RuleReapplyPlan {
  readonly changes: readonly EvaluatedRuleChange[];
  readonly skippedProtectedCount: number;
}

/**
 * Computes deterministic rule reapplication across transactions while strictly
 * enforcing the protection invariant:
 * `is_manual_category = false AND transfer_group_id IS NULL AND is_manual_transfer_override = false`.
 */
export function computeRuleReapplication(
  rules: readonly RuleEvalRule[],
  transactions: readonly RuleEvalTransaction[],
): RuleReapplyPlan {
  const sortedActiveRules = rules
    .filter((rule) => rule.is_active && rule.deleted_at === null)
    .slice()
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      const createdDelta = (a.created_at_ms ?? 0) - (b.created_at_ms ?? 0);
      if (createdDelta !== 0) {
        return createdDelta;
      }
      return a.id.localeCompare(b.id);
    });

  const changes: EvaluatedRuleChange[] = [];
  let skippedProtectedCount = 0;

  for (const tx of transactions) {
    if (
      !isEligibleForRuleRecalc({
        deletedAt: tx.deleted_at,
        isManualCategory: tx.is_manual_category,
        transferGroupId: tx.transfer_group_id,
        isManualTransferOverride: tx.is_manual_transfer_override,
      })
    ) {
      if (tx.deleted_at === null) {
        skippedProtectedCount += 1;
      }
      continue;
    }

    const matchedRule = sortedActiveRules.find((rule) => evaluateRuleMatch(rule, tx));
    const nextCategory = matchedRule !== undefined ? matchedRule.target_category : 'Non catégorisé';
    const nextMatchedRuleId = matchedRule !== undefined ? matchedRule.id : null;
    const nextIsInternalTransfer =
      matchedRule !== undefined ? matchedRule.mark_as_internal_transfer : false;

    if (
      tx.category !== nextCategory ||
      tx.matched_rule_id !== nextMatchedRuleId ||
      tx.is_internal_transfer !== nextIsInternalTransfer
    ) {
      changes.push({
        transactionId: tx.id,
        nextCategory,
        ...(matchedRule?.target_category_id !== undefined
          ? { nextTargetCategoryId: matchedRule.target_category_id }
          : {}),
        ...(matchedRule?.target_subcategory_id !== undefined
          ? { nextTargetSubcategoryId: matchedRule.target_subcategory_id }
          : {}),
        nextMatchedRuleId,
        nextIsInternalTransfer,
      });
    }
  }

  return { changes, skippedProtectedCount };
}

// ============================================================================
// 4. Budgets Contracts (GET/PUT/DELETE /api/budgets)
// ============================================================================

export const BudgetAlertStatusSchema = z.enum(['ok', 'warning', 'exceeded']);
export type BudgetAlertStatus = z.infer<typeof BudgetAlertStatusSchema>;

export const GetBudgetsQuerySchema = z.object({
  month: IsoMonthSchema.optional(),
  currency: CurrencySchema.optional(),
});

export const PutBudgetBodySchema = z
  .object({
    category: z.string().trim().min(1).max(64),
    monthly_limit_cents: CentsSchema.refine((value) => value > 0, {
      message: 'Le plafond mensuel doit être strictement supérieur à 0 centime.',
    }),
    currency: CurrencySchema.default('EUR'),
  })
  .strict();
export type PutBudgetInput = z.infer<typeof PutBudgetBodySchema>;

export const DeleteBudgetSchema = z.object({
  category: z.string().trim().min(1).max(64),
});

export interface BudgetAlertSummary {
  readonly status: BudgetAlertStatus;
  readonly usage_percent: number;
  readonly remaining_cents: Cents;
}

/**
 * Exact integer threshold calculation for budget alerts:
 * - `ok`: `< 80%`
 * - `warning`: `80%..99%` (`>= 80%` and `< 100%`)
 * - `exceeded`: `>= 100%`
 */
export function computeBudgetAlert(spentCents: Cents, limitCents: Cents): BudgetAlertSummary {
  const safeSpent = Math.max(0, spentCents);
  const usagePercent = Math.round((safeSpent * 10000) / limitCents) / 100;
  const remainingCents = toCents(limitCents - safeSpent);

  if (safeSpent * 100 >= limitCents * 100) {
    return { status: 'exceeded', usage_percent: usagePercent, remaining_cents: remainingCents };
  }
  if (safeSpent * 100 >= limitCents * 80) {
    return { status: 'warning', usage_percent: usagePercent, remaining_cents: remainingCents };
  }
  return { status: 'ok', usage_percent: usagePercent, remaining_cents: remainingCents };
}

export const BudgetItemSchema = z.object({
  category: z.string().min(1).max(64),
  monthly_limit_cents: CentsSchema,
  currency: CurrencySchema,
  spent_cents: CentsSchema,
  remaining_cents: CentsSchema,
  usage_percent: z.number().finite(),
  alert_status: BudgetAlertStatusSchema,
  revision: SyncRevisionSchema,
  updated_at: IsoDateTimeSchema,
});
export type BudgetItem = z.infer<typeof BudgetItemSchema>;

export interface BudgetsListResult {
  readonly month: string;
  readonly budgets: readonly BudgetItem[];
  readonly latest_revision: SyncRevision;
}

export interface BudgetUpsertResult {
  readonly budget: BudgetItem;
  readonly latest_revision: SyncRevision;
}

export interface BudgetDeleteResult {
  readonly deleted_category: string;
  readonly latest_revision: SyncRevision;
}

export interface BudgetsRepository {
  listBudgets(query: { readonly month: string; readonly currency?: Currency }): Promise<BudgetsListResult>;
  upsertBudget(input: PutBudgetInput): Promise<BudgetUpsertResult>;
  deleteBudget(category: string): Promise<BudgetDeleteResult | null>;
}

// ============================================================================
// 5. Analytics Overview Contracts (GET /api/analytics/overview)
// ============================================================================

export const AnalyticsScopeSchema = z.enum(['all', 'boursobank', 'revolut']);
export type AnalyticsScope = z.infer<typeof AnalyticsScopeSchema>;

export const CurrencyModeSchema = z.enum(['eur_consolidated', 'usd_only']);
export type CurrencyMode = z.infer<typeof CurrencyModeSchema>;

export const ExpenseComparisonModeSchema = z.enum(['none', 'prev_month', 'avg_3m']);
export type ExpenseComparisonMode = z.infer<typeof ExpenseComparisonModeSchema>;

export const AnalyticsOverviewQuerySchema = z.object({
  scope: AnalyticsScopeSchema.default('all'),
  currency_mode: CurrencyModeSchema.default('eur_consolidated'),
  expense_comparison: ExpenseComparisonModeSchema.default('avg_3m'),
  reference_month: IsoMonthSchema.optional(),
});

export interface AnalyticsOverviewQuery {
  readonly scope: AnalyticsScope;
  readonly currency_mode: CurrencyMode;
  readonly expense_comparison: ExpenseComparisonMode;
  readonly reference_month: string;
}

export const RecurrenceCadenceSchema = z.enum(['weekly', 'monthly', 'quarterly']);
export type RecurrenceCadence = z.infer<typeof RecurrenceCadenceSchema>;

export const DetectedRecurrenceSchema = z.object({
  normalized_label: z.string().min(1),
  clean_label: z.string().min(1).max(255),
  category: z.string().min(1).max(64),
  currency: CurrencySchema,
  average_amount_cents: CentsSchema,
  average_amount_eur_cents: CentsSchema,
  cadence: RecurrenceCadenceSchema,
  occurrences_count: z.number().int().min(2),
  last_booking_date: CalendarIsoDateSchema,
  next_expected_date: CalendarIsoDateSchema,
});
export type DetectedRecurrence = z.infer<typeof DetectedRecurrenceSchema>;

export const MonthlyExpensePointSchema = z.object({
  month: IsoMonthSchema,
  label: z.string().min(1),
  expenses_cents: CentsSchema,
  prev_month_expenses_cents: CentsSchema.nullable(),
  avg_3m_expenses_cents: CentsSchema.nullable(),
});
export type MonthlyExpensePoint = z.infer<typeof MonthlyExpensePointSchema>;

export const ExpenseComparisonSummarySchema = z.object({
  mode: ExpenseComparisonModeSchema,
  current_month_expenses_cents: CentsSchema,
  prev_month_expenses_cents: CentsSchema.nullable(),
  avg_3m_expenses_cents: CentsSchema.nullable(),
  delta_percent: z.number().finite().nullable(),
});
export type ExpenseComparisonSummary = z.infer<typeof ExpenseComparisonSummarySchema>;

export const AnalyticsOverviewResponseSchema = z.object({
  scope: AnalyticsScopeSchema,
  currency_mode: CurrencyModeSchema,
  expense_comparison: ExpenseComparisonModeSchema,
  display_currency: CurrencySchema,
  reference_month: IsoMonthSchema,
  kpis: AggregateKpisSchema,
  cumulative_balance_6m: z.array(CumulativeBalancePointSchema),
  monthly_expenses: z.array(MonthlyExpensePointSchema),
  expense_comparison_summary: ExpenseComparisonSummarySchema,
  expenses_m1_vs_avg3m: z.array(ExpenseComparisonItemSchema),
  recurrences: z.array(DetectedRecurrenceSchema),
  computed_at: IsoDateTimeSchema,
  data_revision: SyncRevisionSchema,
});
export type AnalyticsOverviewResponse = z.infer<typeof AnalyticsOverviewResponseSchema>;

export interface AnalyticsRepository {
  getOverview(query: AnalyticsOverviewQuery): Promise<AnalyticsOverviewResponse>;
}

// ============================================================================
// 6. APK Artifact Contracts (GET /api/apk/status, GET /api/apk/download)
// ============================================================================

export const ApkStatusSchema = z.object({
  available: z.boolean(),
  version: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  builtAt: z.string().nullable(),
});
export type ApkStatus = z.infer<typeof ApkStatusSchema>;

export interface ApkBinaryArtifact {
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly filename: string;
}

export interface ApkArtifactRepository {
  getStatus(): Promise<ApkStatus>;
  readBinary(): Promise<ApkBinaryArtifact | null>;
}

// ============================================================================
// Pure Analytics & Recurrence Computation Helpers
// ============================================================================

const FRENCH_MONTH_LABELS: readonly string[] = [
  'Janv.',
  'Févr.',
  'Mars',
  'Avr.',
  'Mai',
  'Juin',
  'Juil.',
  'Août',
  'Sept.',
  'Oct.',
  'Nov.',
  'Déc.',
] as const;

export interface AnalyticsAccountInput {
  readonly id: AccountId;
  readonly bank: Bank;
  readonly currency: Currency;
  readonly current_balance_cents: Cents;
  readonly current_balance_eur_cents: Cents;
}

export interface AnalyticsTransactionInput {
  readonly id: TransactionId;
  readonly account_id: AccountId;
  readonly bank: Bank;
  readonly booking_date: string;
  readonly raw_label: string;
  readonly clean_label: string;
  readonly amount_cents: Cents;
  readonly currency: Currency;
  readonly amount_eur_cents: Cents;
  readonly category: string;
  readonly is_internal_transfer: boolean;
}

function shiftIsoMonth(baseMonth: string, offsetMonths: number): string {
  const [yearStr, monthStr] = baseMonth.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const date = new Date(Date.UTC(year, month - 1 + offsetMonths, 1));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getFrenchMonthLabel(isoMonth: string): string {
  const monthIndex = Number(isoMonth.slice(5, 7)) - 1;
  return FRENCH_MONTH_LABELS[monthIndex] ?? isoMonth;
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function addMonthsToIsoDate(isoDate: string, months: number): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr) - 1;
  const day = Number(dStr);
  const target = new Date(Date.UTC(year, month + months, 1));
  const maxDaysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, maxDaysInTarget));
  return target.toISOString().slice(0, 10);
}

/**
 * Pure detector for recurring expenses across non-transfer debit transactions.
 */
export function detectRecurringTransactions(
  transactions: readonly AnalyticsTransactionInput[],
): readonly DetectedRecurrence[] {
  const groups = new Map<string, AnalyticsTransactionInput[]>();

  for (const tx of transactions) {
    if (tx.is_internal_transfer || tx.amount_cents >= 0) {
      continue;
    }
    const norm = normalizeLabel(tx.clean_label);
    if (norm.length === 0) {
      continue;
    }
    const key = `${norm}|${tx.currency}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.push(tx);
    } else {
      groups.set(key, [tx]);
    }
  }

  const detected: DetectedRecurrence[] = [];

  for (const [key, items] of groups.entries()) {
    if (items.length < 2) {
      continue;
    }
    const sorted = items
      .slice()
      .sort((a, b) => a.booking_date.localeCompare(b.booking_date));

    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (prev === undefined || curr === undefined) {
        continue;
      }
      const deltaDays = Math.round(
        (Date.parse(`${curr.booking_date}T00:00:00.000Z`) -
          Date.parse(`${prev.booking_date}T00:00:00.000Z`)) /
          86_400_000,
      );
      if (deltaDays > 0) {
        intervals.push(deltaDays);
      }
    }

    if (intervals.length === 0) {
      continue;
    }

    const avgInterval =
      intervals.reduce((sum, val) => sum + val, 0) / intervals.length;

    let cadence: RecurrenceCadence | null = null;
    if (avgInterval >= 5 && avgInterval <= 9) {
      cadence = 'weekly';
    } else if (avgInterval >= 25 && avgInterval <= 35) {
      cadence = 'monthly';
    } else if (avgInterval >= 80 && avgInterval <= 100) {
      cadence = 'quarterly';
    }

    if (cadence === null) {
      continue;
    }

    const absAmounts = sorted.map((t) => Math.abs(t.amount_cents));
    const avgAbsAmount = Math.round(
      absAmounts.reduce((sum, v) => sum + v, 0) / absAmounts.length,
    );
    const avgAbsEurAmount = Math.round(
      sorted.reduce((sum, t) => sum + Math.abs(t.amount_eur_cents), 0) / sorted.length,
    );

    const consistentAmounts = absAmounts.every(
      (amt) => Math.abs(amt - avgAbsAmount) <= Math.max(100, Math.round(avgAbsAmount * 0.2)),
    );
    if (!consistentAmounts) {
      continue;
    }

    const latest = sorted[sorted.length - 1];
    if (latest === undefined) {
      continue;
    }

    let nextExpectedDate: string;
    switch (cadence) {
      case 'weekly':
        nextExpectedDate = addDaysToIsoDate(latest.booking_date, 7);
        break;
      case 'monthly':
        nextExpectedDate = addMonthsToIsoDate(latest.booking_date, 1);
        break;
      case 'quarterly':
        nextExpectedDate = addMonthsToIsoDate(latest.booking_date, 3);
        break;
    }

    const normalizedLabel = key.split('|')[0] ?? normalizeLabel(latest.clean_label);

    detected.push({
      normalized_label: normalizedLabel,
      clean_label: latest.clean_label,
      category: latest.category,
      currency: latest.currency,
      average_amount_cents: toCents(-avgAbsAmount),
      average_amount_eur_cents: toCents(-avgAbsEurAmount),
      cadence,
      occurrences_count: sorted.length,
      last_booking_date: latest.booking_date,
      next_expected_date: nextExpectedDate,
    });
  }

  return detected.sort((a, b) => a.clean_label.localeCompare(b.clean_label));
}

export function computeAnalyticsOverview(params: {
  readonly query: AnalyticsOverviewQuery;
  readonly accounts: readonly AnalyticsAccountInput[];
  readonly transactions: readonly AnalyticsTransactionInput[];
  readonly dataRevision: SyncRevision;
  readonly now: Date;
}): AnalyticsOverviewResponse {
  const { query, accounts, transactions, dataRevision, now } = params;
  const displayCurrency: Currency =
    query.currency_mode === 'usd_only' ? 'USD' : 'EUR';

  const scopedAccounts = accounts.filter((acc) => {
    if (query.scope !== 'all' && acc.bank !== query.scope) {
      return false;
    }
    if (query.currency_mode === 'usd_only' && acc.currency !== 'USD') {
      return false;
    }
    return true;
  });

  const scopedAccountIds = new Set(scopedAccounts.map((acc) => acc.id));

  const scopedTxs = transactions.filter((tx) => {
    if (query.scope !== 'all' && tx.bank !== query.scope) {
      return false;
    }
    if (query.currency_mode === 'usd_only' && tx.currency !== 'USD') {
      return false;
    }
    if (scopedAccounts.length > 0 && !scopedAccountIds.has(tx.account_id)) {
      return false;
    }
    return true;
  });

  const pickTxCents = (tx: AnalyticsTransactionInput): number =>
    query.currency_mode === 'usd_only' ? tx.amount_cents : tx.amount_eur_cents;

  const pickAccBalanceCents = (acc: AnalyticsAccountInput): number =>
    query.currency_mode === 'usd_only'
      ? acc.current_balance_cents
      : acc.current_balance_eur_cents;

  const consolidatedBalanceCents = toCents(
    scopedAccounts.reduce((sum, acc) => sum + pickAccBalanceCents(acc), 0),
  );

  let monthIncome = 0;
  let monthExpensesExclTransfers = 0;
  let monthInternalTransfers = 0;

  for (const tx of scopedTxs) {
    if (tx.booking_date.slice(0, 7) !== query.reference_month) {
      continue;
    }
    const amt = pickTxCents(tx);
    if (tx.is_internal_transfer) {
      if (amt < 0) {
        monthInternalTransfers += Math.abs(amt);
      }
      continue;
    }
    if (amt > 0) {
      monthIncome += amt;
    } else if (amt < 0) {
      monthExpensesExclTransfers += Math.abs(amt);
    }
  }

  // Build 6-month cumulative balance series [M-5 .. M]
  const sixMonths: string[] = [];
  for (let offset = -5; offset <= 0; offset += 1) {
    sixMonths.push(shiftIsoMonth(query.reference_month, offset));
  }

  const netChangeByMonth = new Map<string, number>();
  const expensesByMonth = new Map<string, number>();
  let netAfterReferenceMonth = 0;

  for (const tx of scopedTxs) {
    const month = tx.booking_date.slice(0, 7);
    const amt = pickTxCents(tx);
    netChangeByMonth.set(month, (netChangeByMonth.get(month) ?? 0) + amt);
    if (month > query.reference_month) {
      netAfterReferenceMonth += amt;
    }
    if (!tx.is_internal_transfer && amt < 0) {
      expensesByMonth.set(month, (expensesByMonth.get(month) ?? 0) + Math.abs(amt));
    }
  }

  // Closing balance at reference_month = current balance minus changes strictly after reference_month
  let runningClosing = consolidatedBalanceCents - netAfterReferenceMonth;
  const cumulativeReversed: CumulativeBalancePoint[] = [];

  for (let i = sixMonths.length - 1; i >= 0; i -= 1) {
    const month = sixMonths[i];
    if (month === undefined) {
      continue;
    }
    const netChange = netChangeByMonth.get(month) ?? 0;
    cumulativeReversed.push({
      month,
      label: getFrenchMonthLabel(month),
      closing_balance_cents: toCents(runningClosing),
      net_change_cents: toCents(netChange),
    });
    runningClosing -= netChange;
  }

  const cumulativeBalance6m = cumulativeReversed.reverse();

  // Monthly expenses series with optional prev_month & avg_3m comparison
  const monthlyExpenses: MonthlyExpensePoint[] = sixMonths.map((month) => {
    const expenses = toCents(expensesByMonth.get(month) ?? 0);
    const prevMonth = shiftIsoMonth(month, -1);
    const prevExpenses = toCents(expensesByMonth.get(prevMonth) ?? 0);
    const m2 = shiftIsoMonth(month, -2);
    const m3 = shiftIsoMonth(month, -3);
    const avg3m = toCents(
      Math.round(
        ((expensesByMonth.get(prevMonth) ?? 0) +
          (expensesByMonth.get(m2) ?? 0) +
          (expensesByMonth.get(m3) ?? 0)) /
          3,
      ),
    );

    return {
      month,
      label: getFrenchMonthLabel(month),
      expenses_cents: expenses,
      prev_month_expenses_cents:
        query.expense_comparison === 'none' ? null : prevExpenses,
      avg_3m_expenses_cents:
        query.expense_comparison === 'avg_3m' ? avg3m : null,
    };
  });

  const m1Month = shiftIsoMonth(query.reference_month, -1);
  const m2Month = shiftIsoMonth(query.reference_month, -2);
  const m3Month = shiftIsoMonth(query.reference_month, -3);

  const currentMonthExpensesCents = toCents(
    expensesByMonth.get(query.reference_month) ?? 0,
  );
  const prevMonthExpensesValue = expensesByMonth.get(m1Month) ?? 0;
  const avg3mExpensesValue = Math.round(
    (prevMonthExpensesValue +
      (expensesByMonth.get(m2Month) ?? 0) +
      (expensesByMonth.get(m3Month) ?? 0)) /
      3,
  );

  let summaryDeltaPercent: number | null = null;
  if (query.expense_comparison === 'prev_month' && prevMonthExpensesValue > 0) {
    summaryDeltaPercent =
      Math.round(
        ((currentMonthExpensesCents - prevMonthExpensesValue) /
          prevMonthExpensesValue) *
          10000,
      ) / 100;
  } else if (query.expense_comparison === 'avg_3m' && avg3mExpensesValue > 0) {
    summaryDeltaPercent =
      Math.round(
        ((currentMonthExpensesCents - avg3mExpensesValue) / avg3mExpensesValue) *
          10000,
      ) / 100;
  }

  const expenseComparisonSummary: ExpenseComparisonSummary = {
    mode: query.expense_comparison,
    current_month_expenses_cents: currentMonthExpensesCents,
    prev_month_expenses_cents:
      query.expense_comparison === 'none'
        ? null
        : toCents(prevMonthExpensesValue),
    avg_3m_expenses_cents:
      query.expense_comparison === 'avg_3m'
        ? toCents(avg3mExpensesValue)
        : null,
    delta_percent: summaryDeltaPercent,
  };

  // Per-category breakdown M-1 vs 3M avg (excluding internal transfers)
  const categoryStats = new Map<
    string,
    { m1: number; m2: number; m3: number; countM1: number }
  >();

  for (const tx of scopedTxs) {
    if (tx.is_internal_transfer) {
      continue;
    }
    const amt = pickTxCents(tx);
    if (amt >= 0) {
      continue;
    }
    const txMonth = tx.booking_date.slice(0, 7);
    if (txMonth !== m1Month && txMonth !== m2Month && txMonth !== m3Month) {
      continue;
    }
    const entry = categoryStats.get(tx.category) ?? {
      m1: 0,
      m2: 0,
      m3: 0,
      countM1: 0,
    };
    const absAmt = Math.abs(amt);
    if (txMonth === m1Month) {
      entry.m1 += absAmt;
      entry.countM1 += 1;
    } else if (txMonth === m2Month) {
      entry.m2 += absAmt;
    } else {
      entry.m3 += absAmt;
    }
    categoryStats.set(tx.category, entry);
  }

  const expensesM1VsAvg3m: ExpenseComparisonItem[] = [];
  if (query.expense_comparison !== 'none') {
    for (const [category, stats] of categoryStats.entries()) {
      const avg3m = Math.round((stats.m1 + stats.m2 + stats.m3) / 3);
      const deltaPercent =
        avg3m > 0 ? Math.round(((stats.m1 - avg3m) / avg3m) * 10000) / 100 : 0;
      expensesM1VsAvg3m.push({
        category,
        m_minus_1_cents: toCents(stats.m1),
        avg_3m_cents: toCents(avg3m),
        delta_percent: deltaPercent,
        transaction_count_m1: stats.countM1,
      });
    }
    expensesM1VsAvg3m.sort((a, b) => b.m_minus_1_cents - a.m_minus_1_cents);
  }

  const recurrences = detectRecurringTransactions(scopedTxs);

  return {
    scope: query.scope,
    currency_mode: query.currency_mode,
    expense_comparison: query.expense_comparison,
    display_currency: displayCurrency,
    reference_month: query.reference_month,
    kpis: {
      consolidated_balance_cents: consolidatedBalanceCents,
      month_income_cents: toCents(monthIncome),
      month_expenses_excl_transfers_cents: toCents(monthExpensesExclTransfers),
      month_internal_transfers_cents: toCents(monthInternalTransfers),
    },
    cumulative_balance_6m: cumulativeBalance6m,
    monthly_expenses: monthlyExpenses,
    expense_comparison_summary: expenseComparisonSummary,
    expenses_m1_vs_avg3m: expensesM1VsAvg3m,
    recurrences: [...recurrences],
    computed_at: now.toISOString(),
    data_revision: dataRevision,
  };
}

// ============================================================================
// 7. Categories & Subcategories Contracts (GET/POST/PATCH/MERGE/DELETE)
// ============================================================================

export const CategoryIdParamSchema = z.object({
  id: CategoryIdSchema,
});

export const CategoriesQuerySchema = z.object({
  include_archived: BooleanStringSchema.optional(),
});

export const CreateCategoryBodySchema = z
  .object({
    parent_id: CategoryIdSchema.nullable().default(null),
    name: z.string().trim().min(1).max(64),
    budget_group: BudgetGroupSchema,
    color_token: z.string().trim().min(1).max(32).default('slate'),
    sort_order: z.number().int().min(0).max(10000).default(500),
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof CreateCategoryBodySchema>;

export const UpdateCategoryBodySchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    budget_group: BudgetGroupSchema.optional(),
    color_token: z.string().trim().min(1).max(32).optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    is_archived: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Au moins un champ de catégorie à modifier est requis.',
  });
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryBodySchema>;

export const MergeCategoryBodySchema = z
  .object({
    target_category_id: CategoryIdSchema,
    target_subcategory_id: CategoryIdSchema.nullable().optional(),
  })
  .strict();
export type MergeCategoryInput = z.infer<typeof MergeCategoryBodySchema>;

export const DeleteCategoryBodySchema = z
  .object({
    reassign_to_category_id: CategoryIdSchema.optional(),
    reassign_to_subcategory_id: CategoryIdSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (data) =>
      !(
        data.reassign_to_subcategory_id !== undefined &&
        data.reassign_to_subcategory_id !== null &&
        data.reassign_to_category_id === undefined
      ),
    {
      message: 'reassign_to_subcategory_id nécessite reassign_to_category_id.',
      path: ['reassign_to_subcategory_id'],
    },
  );
export type DeleteCategoryInput = z.infer<typeof DeleteCategoryBodySchema>;

export const CategoryViewSchema = CategorySchema.extend({
  transaction_count: z.number().int().nonnegative(),
});
export type CategoryView = z.infer<typeof CategoryViewSchema>;

export interface CategoriesListResult {
  readonly categories: readonly CategoryView[];
  readonly latest_revision: SyncRevision;
}

export interface CategoryMutationResult {
  readonly category: CategoryView;
  readonly updated_transactions_count?: number | undefined;
  readonly latest_revision: SyncRevision;
}

export interface CategoryMergeResult {
  readonly merged_from_id: CategoryId;
  readonly target_category_id: CategoryId;
  readonly reassigned_transactions_count: number;
  readonly latest_revision: SyncRevision;
}

export interface CategoryDeleteResult {
  readonly deleted_category_id: CategoryId;
  readonly reassigned_transactions_count: number;
  readonly latest_revision: SyncRevision;
}

export type CreateCategoryOutcome =
  | { readonly ok: true; readonly data: CategoryMutationResult }
  | {
      readonly ok: false;
      readonly reason: 'parent_not_found' | 'depth_exceeded' | 'conflict';
      readonly message: string;
    };

export type UpdateCategoryOutcome =
  | { readonly ok: true; readonly data: CategoryMutationResult }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict';
      readonly message: string;
    };

export type MergeCategoryOutcome =
  | { readonly ok: true; readonly data: CategoryMergeResult }
  | {
      readonly ok: false;
      readonly reason:
        | 'source_not_found'
        | 'target_not_found'
        | 'same_category'
        | 'depth_exceeded'
        | 'protected_or_has_children';
      readonly message: string;
    };

export type DeleteCategoryOutcome =
  | { readonly ok: true; readonly data: CategoryDeleteResult }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_found'
        | 'target_not_found'
        | 'reassign_required'
        | 'has_children_or_system';
      readonly message: string;
    };

export interface CategoriesRepository {
  listCategories(options?: {
    readonly include_archived?: boolean | undefined;
  }): Promise<CategoriesListResult>;
  createCategory(input: CreateCategoryInput): Promise<CreateCategoryOutcome>;
  updateCategory(id: CategoryId, input: UpdateCategoryInput): Promise<UpdateCategoryOutcome>;
  mergeCategory(id: CategoryId, input: MergeCategoryInput): Promise<MergeCategoryOutcome>;
  deleteCategory(
    id: CategoryId,
    input?: DeleteCategoryInput | undefined,
  ): Promise<DeleteCategoryOutcome>;
}
