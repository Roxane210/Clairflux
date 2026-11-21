import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DRIVE_FOLDERS,
  ApiErrorEnvelopeSchema,
  DeltaSyncResponseSchema,
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
  createApp,
  signSessionToken,
  type AppDependencies,
  type BudgetItem,
  type DeltaMutationRepository,
  type DeltaSyncQuery,
  type OutboxMutationOutcome,
  type RuleView,
  type TransactionDetail,
} from './app.js';
import {
  AnalyticsOverviewResponseSchema,
  ApkStatusSchema,
  PostSyncDeltaResponseSchema,
  computeAnalyticsOverview,
  computeBudgetAlert,
  computeRuleReapplication,
  isSafeRegexPattern,
  type AnalyticsAccountInput,
  type AnalyticsTransactionInput,
  type ApkArtifactRepository,
  type RuleEvalRule,
  type RuleEvalTransaction,
} from './routes/contracts.js';
import {
  computeCanonicalMutationPayloadHash,
  createFilesystemApkRepository,
  createIdempotentDeltaMutationRepository,
  type AppliedClientMutationRecord,
} from './server.js';

const TEST_SESSION_SECRET = 'clairflux-test-session-secret-minimum-32-chars';
const FIXED_NOW = new Date('2026-11-21T14:00:00.000Z');
const VALID_JTI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const ACC_BOURSO_ID = parseAccountId('11111111-1111-4111-8111-111111111111');
const ACC_REV_USD_ID = parseAccountId('22222222-2222-4222-8222-222222222222');

const TX_CURSOR_ID = parseTransactionId('33333333-3333-4333-8333-333333333333');
const TX_CARREFOUR_ID = parseTransactionId('33333333-3333-4333-8333-333333333334');
const TX_MANUAL_CAT_ID = parseTransactionId('33333333-3333-4333-8333-333333333335');
const TX_TRANSFER_PAIRED_ID = parseTransactionId('33333333-3333-4333-8333-333333333336');
const TX_TRANSFER_OVERRIDE_ID = parseTransactionId('33333333-3333-4333-8333-333333333337');
const TX_NETFLIX_OCT_ID = parseTransactionId('33333333-3333-4333-8333-333333333338');
const TX_NETFLIX_NOV_ID = parseTransactionId('33333333-3333-4333-8333-333333333339');
const TX_SALARY_ID = parseTransactionId('33333333-3333-4333-8333-333333333340');
const TX_CURSOR_OCT_ID = parseTransactionId('33333333-3333-4333-8333-333333333341');
const TX_UNKNOWN_ID = parseTransactionId('99999999-9999-4999-8999-999999999999');

const RULE_CURSOR_ID = parseRuleId('44444444-4444-4444-8444-444444444444');
const RULE_LOW_PRIO_ID = parseRuleId('44444444-4444-4444-8444-444444444445');
const RULE_NETFLIX_ID = parseRuleId('44444444-4444-4444-8444-444444444446');
const RULE_SALARY_ID = parseRuleId('44444444-4444-4444-8444-444444444447');

function createToken(clientKind: 'web' | 'android' = 'android'): string {
  const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
  return signSessionToken(
    {
      jti: VALID_JTI,
      client_kind: clientKind,
      iat: nowSec - 60,
      exp: nowSec + 3600,
    },
    TEST_SESSION_SECRET,
  );
}

interface StoredTransaction {
  id: TransactionId;
  account_id: AccountId;
  bank: Bank;
  account_type: Account['account_type'];
  account_nickname: string;
  external_ref_masked: string;
  booking_date: string;
  value_date: string | null;
  raw_label: string;
  clean_label: string;
  amount_cents: Cents;
  currency: Currency;
  fx_rate_micro: ReturnType<typeof toFxRateMicro>;
  amount_eur_cents: Cents;
  category: string;
  is_manual_category: boolean;
  matched_rule_id: RuleId | null;
  is_internal_transfer: boolean;
  is_manual_transfer_override: boolean;
  transfer_group_id: string | null;
  source_drive_file_id: string;
  note: { content: string; updated_at: string } | null;
  revision: SyncRevision;
  updated_at: string;
  deleted_at: Date | null;
}

interface StoredRule {
  id: RuleId;
  name: string;
  priority: number;
  bank_filter: Bank | null;
  account_id_filter: AccountId | null;
  account_type_filter: Account['account_type'] | null;
  match_mode: 'contains' | 'starts_with' | 'exact' | 'regex';
  pattern: string;
  target_category: string;
  mark_as_internal_transfer: boolean;
  is_active: boolean;
  revision: SyncRevision;
  updated_at: string;
  deleted_at: Date | null;
  created_at_ms: number;
}

interface StoredBudget {
  category: string;
  monthly_limit_cents: Cents;
  currency: Currency;
  revision: SyncRevision;
  updated_at: string;
}

function createStatefulTestHarness(options?: {
  readonly allowedWebOrigin?: string | undefined;
  readonly onGetDelta?: (query: DeltaSyncQuery) => void;
  readonly apk?: ApkArtifactRepository | undefined;
  readonly deltaMutationRepository?: DeltaMutationRepository | undefined;
}) {
  let currentRev = 1495;
  const nextRevision = (): SyncRevision => {
    currentRev += 1;
    return toSyncRevision(currentRev);
  };

  const accountsList: Account[] = [
    {
      id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      currency: 'EUR',
      current_balance_cents: toCents(400000),
      current_balance_eur_cents: toCents(400000),
      balance_updated_at: '2026-11-20T23:59:59.000Z',
      revision: toSyncRevision(1410),
      updated_at: '2026-11-20T18:02:11.000Z',
    },
    {
      id: ACC_REV_USD_ID,
      bank: 'revolut',
      account_type: 'multi_devises',
      nickname: 'Courant USD',
      external_ref_masked: 'USD •• 9012',
      currency: 'USD',
      current_balance_cents: toCents(200000),
      current_balance_eur_cents: toCents(184900),
      balance_updated_at: '2026-11-20T23:59:59.000Z',
      revision: toSyncRevision(1455),
      updated_at: '2026-11-20T18:02:15.000Z',
    },
  ];

  const txs: StoredTransaction[] = [
    {
      id: TX_CURSOR_ID,
      account_id: ACC_REV_USD_ID,
      bank: 'revolut',
      account_type: 'multi_devises',
      account_nickname: 'Courant USD',
      external_ref_masked: 'USD •• 9012',
      booking_date: '2026-11-18',
      value_date: '2026-11-18',
      raw_label: 'CURSOR AI *MONTHLY SAN FRANCISCO US',
      clean_label: 'Cursor AI',
      amount_cents: toCents(-2000),
      currency: 'USD',
      fx_rate_micro: toFxRateMicro(924500),
      amount_eur_cents: toCents(-1849),
      category: 'Logiciels & Cloud',
      is_manual_category: false,
      matched_rule_id: RULE_CURSOR_ID,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888888',
      note: { content: 'Abonnement dev', updated_at: '2026-11-19T09:10:00.000Z' },
      revision: toSyncRevision(1486),
      updated_at: '2026-11-19T09:10:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_CURSOR_OCT_ID,
      account_id: ACC_REV_USD_ID,
      bank: 'revolut',
      account_type: 'multi_devises',
      account_nickname: 'Courant USD',
      external_ref_masked: 'USD •• 9012',
      booking_date: '2026-10-18',
      value_date: '2026-10-18',
      raw_label: 'CURSOR AI *MONTHLY SAN FRANCISCO US',
      clean_label: 'Cursor AI',
      amount_cents: toCents(-2000),
      currency: 'USD',
      fx_rate_micro: toFxRateMicro(924500),
      amount_eur_cents: toCents(-1849),
      category: 'Logiciels & Cloud',
      is_manual_category: false,
      matched_rule_id: RULE_CURSOR_ID,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888888',
      note: null,
      revision: toSyncRevision(1480),
      updated_at: '2026-10-19T09:10:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_CARREFOUR_ID,
      account_id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      account_nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-15',
      value_date: '2026-11-15',
      raw_label: 'CARREFOUR MARKET PARIS 15',
      clean_label: 'Carrefour Market',
      amount_cents: toCents(-8000),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-8000),
      category: 'Divers Courses',
      is_manual_category: false,
      matched_rule_id: RULE_LOW_PRIO_ID,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888889',
      note: null,
      revision: toSyncRevision(1487),
      updated_at: '2026-11-15T12:00:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_MANUAL_CAT_ID,
      account_id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      account_nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-14',
      value_date: '2026-11-14',
      raw_label: 'CARREFOUR CITY VOYAGE',
      clean_label: 'Carrefour City',
      amount_cents: toCents(-2500),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-2500),
      category: 'Cadeaux',
      is_manual_category: true,
      matched_rule_id: null,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888889',
      note: null,
      revision: toSyncRevision(1488),
      updated_at: '2026-11-14T12:00:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_TRANSFER_PAIRED_ID,
      account_id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      account_nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-10',
      value_date: '2026-11-10',
      raw_label: 'CARREFOUR VIREMENT INTERNE',
      clean_label: 'Virement interne Revolut',
      amount_cents: toCents(-50000),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-50000),
      category: 'Transfert interne',
      is_manual_category: false,
      matched_rule_id: null,
      is_internal_transfer: true,
      is_manual_transfer_override: false,
      transfer_group_id: '77777777-7777-4777-8777-777777777771',
      source_drive_file_id: '88888888-8888-4888-8888-888888888889',
      note: null,
      revision: toSyncRevision(1489),
      updated_at: '2026-11-10T12:00:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_TRANSFER_OVERRIDE_ID,
      account_id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      account_nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-09',
      value_date: '2026-11-09',
      raw_label: 'CARREFOUR TRANSFER OVERRIDE',
      clean_label: 'Carrefour Override',
      amount_cents: toCents(-1500),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-1500),
      category: 'Non catégorisé',
      is_manual_category: false,
      matched_rule_id: null,
      is_internal_transfer: false,
      is_manual_transfer_override: true,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888889',
      note: null,
      revision: toSyncRevision(1490),
      updated_at: '2026-11-09T12:00:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_NETFLIX_OCT_ID,
      account_id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      account_nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-10-05',
      value_date: '2026-10-05',
      raw_label: 'NETFLIX.COM PARIS',
      clean_label: 'Netflix',
      amount_cents: toCents(-1349),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-1349),
      category: 'Abonnements',
      is_manual_category: false,
      matched_rule_id: RULE_NETFLIX_ID,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888889',
      note: null,
      revision: toSyncRevision(1491),
      updated_at: '2026-10-05T12:00:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_NETFLIX_NOV_ID,
      account_id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      account_nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-05',
      value_date: '2026-11-05',
      raw_label: 'NETFLIX.COM PARIS',
      clean_label: 'Netflix',
      amount_cents: toCents(-1349),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(-1349),
      category: 'Abonnements',
      is_manual_category: false,
      matched_rule_id: RULE_NETFLIX_ID,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888889',
      note: null,
      revision: toSyncRevision(1492),
      updated_at: '2026-11-05T12:00:00.000Z',
      deleted_at: null,
    },
    {
      id: TX_SALARY_ID,
      account_id: ACC_BOURSO_ID,
      bank: 'boursobank',
      account_type: 'courant',
      account_nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      booking_date: '2026-11-01',
      value_date: '2026-11-01',
      raw_label: 'VIR SALAIRE ACME CORP',
      clean_label: 'Salaire ACME',
      amount_cents: toCents(350000),
      currency: 'EUR',
      fx_rate_micro: toFxRateMicro(1_000_000),
      amount_eur_cents: toCents(350000),
      category: 'Revenus',
      is_manual_category: false,
      matched_rule_id: RULE_SALARY_ID,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      source_drive_file_id: '88888888-8888-4888-8888-888888888889',
      note: null,
      revision: toSyncRevision(1493),
      updated_at: '2026-11-01T12:00:00.000Z',
      deleted_at: null,
    },
  ];

  const rules: StoredRule[] = [
    {
      id: RULE_CURSOR_ID,
      name: 'Cursor AI',
      priority: 10,
      bank_filter: 'revolut',
      account_id_filter: ACC_REV_USD_ID,
      account_type_filter: null,
      match_mode: 'contains',
      pattern: 'CURSOR AI',
      target_category: 'Logiciels & Cloud',
      mark_as_internal_transfer: false,
      is_active: true,
      revision: toSyncRevision(1402),
      updated_at: '2026-11-15T10:00:00.000Z',
      deleted_at: null,
      created_at_ms: 1000,
    },
    {
      id: RULE_LOW_PRIO_ID,
      name: 'Fallback Market',
      priority: 200,
      bank_filter: 'boursobank',
      account_id_filter: null,
      account_type_filter: null,
      match_mode: 'contains',
      pattern: 'MARKET',
      target_category: 'Divers Courses',
      mark_as_internal_transfer: false,
      is_active: true,
      revision: toSyncRevision(1403),
      updated_at: '2026-11-15T10:00:00.000Z',
      deleted_at: null,
      created_at_ms: 2000,
    },
    {
      id: RULE_NETFLIX_ID,
      name: 'Netflix',
      priority: 300,
      bank_filter: 'boursobank',
      account_id_filter: null,
      account_type_filter: null,
      match_mode: 'contains',
      pattern: 'NETFLIX',
      target_category: 'Abonnements',
      mark_as_internal_transfer: false,
      is_active: true,
      revision: toSyncRevision(1404),
      updated_at: '2026-11-15T10:00:00.000Z',
      deleted_at: null,
      created_at_ms: 3000,
    },
    {
      id: RULE_SALARY_ID,
      name: 'Salaire',
      priority: 400,
      bank_filter: 'boursobank',
      account_id_filter: null,
      account_type_filter: null,
      match_mode: 'contains',
      pattern: 'SALAIRE',
      target_category: 'Revenus',
      mark_as_internal_transfer: false,
      is_active: true,
      revision: toSyncRevision(1405),
      updated_at: '2026-11-15T10:00:00.000Z',
      deleted_at: null,
      created_at_ms: 4000,
    },
  ];

  const budgets = new Map<string, StoredBudget>();
  const idempotencyMap = new Map<string, SyncRevision>();

  const toTxDetail = (t: StoredTransaction): TransactionDetail => ({
    id: t.id,
    account_id: t.account_id,
    bank: t.bank,
    account_type: t.account_type,
    account_nickname: t.account_nickname,
    external_ref_masked: t.external_ref_masked,
    booking_date: t.booking_date,
    value_date: t.value_date,
    raw_label: t.raw_label,
    clean_label: t.clean_label,
    amount_cents: t.amount_cents,
    currency: t.currency,
    fx_rate_micro: t.fx_rate_micro,
    amount_eur_cents: t.amount_eur_cents,
    category: t.category,
    is_manual_category: t.is_manual_category,
    matched_rule_id: t.matched_rule_id,
    is_internal_transfer: t.is_internal_transfer,
    is_manual_transfer_override: t.is_manual_transfer_override,
    transfer_group_id: t.transfer_group_id,
    source_drive_file_id: t.source_drive_file_id,
    note: t.note,
    revision: t.revision,
    updated_at: t.updated_at,
  });

  const applyRecalc = (): { updated_count: number; skipped_protected_count: number; rev: SyncRevision } => {
    const evalRules: RuleEvalRule[] = rules.map((r) => ({ ...r }));
    const evalTxs: RuleEvalTransaction[] = txs.map((t) => ({ ...t }));
    const plan = computeRuleReapplication(evalRules, evalTxs);
    let latestRev = toSyncRevision(currentRev);
    for (const change of plan.changes) {
      const target = txs.find((t) => t.id === change.transactionId);
      if (target !== undefined) {
        latestRev = nextRevision();
        target.category = change.nextCategory;
        target.matched_rule_id = change.nextMatchedRuleId;
        target.is_internal_transfer = change.nextIsInternalTransfer;
        target.revision = latestRev;
        target.updated_at = FIXED_NOW.toISOString();
      }
    }
    return {
      updated_count: plan.changes.length,
      skipped_protected_count: plan.skippedProtectedCount,
      rev: latestRev,
    };
  };

  const toRuleView = (r: StoredRule): RuleView => ({
    id: r.id,
    name: r.name,
    priority: r.priority,
    bank_filter: r.bank_filter,
    account_id_filter: r.account_id_filter,
    account_type_filter: r.account_type_filter,
    match_mode: r.match_mode,
    pattern: r.pattern,
    target_category: r.target_category,
    mark_as_internal_transfer: r.mark_as_internal_transfer,
    is_active: r.is_active,
    matched_transactions_count: txs.filter((t) => t.deleted_at === null && t.matched_rule_id === r.id).length,
    revision: r.revision,
    updated_at: r.updated_at,
  });

  const patchTxInternal = (
    id: TransactionId,
    patch: {
      readonly note?: string | null;
      readonly category?: string;
      readonly is_manual_category?: boolean;
      readonly is_internal_transfer?: boolean;
    },
  ) => {
    const found = txs.find((t) => t.id === id && t.deleted_at === null);
    if (found === undefined) {
      return { ok: false as const, reason: 'not_found' as const };
    }

    let rev = nextRevision();
    if (patch.category !== undefined) {
      found.category = patch.category;
      found.is_manual_category = true;
      found.matched_rule_id = null;
    } else if (patch.is_manual_category !== undefined) {
      found.is_manual_category = patch.is_manual_category;
    }

    if (patch.is_internal_transfer !== undefined) {
      found.is_internal_transfer = patch.is_internal_transfer;
      found.is_manual_transfer_override = true;
      if (!patch.is_internal_transfer) {
        found.transfer_group_id = null;
      }
    }

    if (patch.note !== undefined) {
      rev = nextRevision();
      found.note =
        patch.note === null
          ? null
          : { content: patch.note, updated_at: FIXED_NOW.toISOString() };
    }

    found.revision = rev;
    found.updated_at = FIXED_NOW.toISOString();

    return {
      ok: true as const,
      transaction: toTxDetail(found),
      latest_revision: rev,
    };
  };

  let ruleSeq = 10;

  const defaultDeltaMutationRepository: DeltaMutationRepository = {
    async applyOutboxBatch(mutations) {
      const results: OutboxMutationOutcome[] = [];
      for (const mutation of mutations) {
        const existingRev = idempotencyMap.get(mutation.client_mutation_id);
        if (existingRev !== undefined) {
          results.push({
            client_mutation_id: mutation.client_mutation_id,
            status: 'duplicate',
            revision: existingRev,
          });
          continue;
        }
        const patchRes = patchTxInternal(mutation.transaction_id, {
          ...(mutation.kind === 'upsert_note' ? { note: mutation.note } : {}),
          ...(mutation.kind === 'set_category' ? { category: mutation.category } : {}),
          ...(mutation.kind === 'set_internal_transfer'
            ? { is_internal_transfer: mutation.is_internal_transfer }
            : {}),
        });
        if (!patchRes.ok) {
          results.push({
            client_mutation_id: mutation.client_mutation_id,
            status: 'rejected',
            reason: 'RESOURCE_NOT_FOUND',
            message: 'Transaction introuvable.',
          });
          continue;
        }
        idempotencyMap.set(mutation.client_mutation_id, patchRes.latest_revision);
        results.push({
          client_mutation_id: mutation.client_mutation_id,
          status: 'applied',
          revision: patchRes.latest_revision,
        });
      }
      return {
        results,
        latest_revision: toSyncRevision(currentRev),
      };
    },
  };

  const deps: AppDependencies & { readonly apk?: ApkArtifactRepository | undefined } = {
    sessionSecret: TEST_SESSION_SECRET,
    ...(options?.allowedWebOrigin !== undefined
      ? { allowedWebOrigin: options.allowedWebOrigin }
      : {}),
    now: () => FIXED_NOW,
    healthRepository: {
      async ping() {
        return true;
      },
    },
    accountsRepository: {
      async listAccounts() {
        return {
          accounts: accountsList,
          latest_revision: toSyncRevision(currentRev),
        };
      },
    },
    syncDeltaRepository: {
      async getDelta(query): Promise<DeltaSyncResponse> {
        options?.onGetDelta?.(query);
        return {
          since_revision: query.since,
          batch_end_revision: toSyncRevision(currentRev),
          latest_revision: toSyncRevision(currentRev),
          has_more: false,
          full_resync_required: false,
          server_time: FIXED_NOW.toISOString(),
          accounts: { upserted: accountsList, deleted_ids: [] },
          transactions: { upserted: [], deleted_ids: [] },
          transaction_notes: { upserted: [], deleted_transaction_ids: [] },
          categorization_rules: { upserted: [], deleted_ids: [] },
          drive_sync_status: {
            last_run: null,
            files: [
              {
                drive_file_id: parseDriveFileId('1Rev_2026_10_usd'),
                drive_folder_id: ALLOWED_DRIVE_FOLDERS.revolut,
                bank: 'revolut',
                file_name: 'Revolut_Statement_2026_10.pdf',
                status: 'committed',
                attempt_count: 1,
                error_code: null,
                error_message: null,
                revision: toSyncRevision(1495),
                updated_at: FIXED_NOW.toISOString(),
              },
            ],
          },
          aggregates_snapshot: null,
        };
      },
    },
    driveSyncService: {
      async triggerManualSync() {
        return {
          ok: true,
          run: {
            id: '77777777-7777-4777-8777-777777777777',
            status: 'running',
            trigger_mode: 'manual',
            allowed_folders: [
              { folder_id: ALLOWED_DRIVE_FOLDERS.boursobank, bank: 'boursobank' },
              { folder_id: ALLOWED_DRIVE_FOLDERS.revolut, bank: 'revolut' },
            ],
            started_at: FIXED_NOW.toISOString(),
          },
        };
      },
    },
    transactionsRepository: {
      async listTransactions(filter) {
        const filtered = txs.filter((t) => {
          if (t.deleted_at !== null) return false;
          if (filter.bank !== undefined && t.bank !== filter.bank) return false;
          if (filter.account_id !== undefined && t.account_id !== filter.account_id) return false;
          if (filter.currency !== undefined && t.currency !== filter.currency) return false;
          if (filter.has_notes === true && t.note === null) return false;
          if (filter.has_notes === false && t.note !== null) return false;
          if (filter.from !== undefined && t.booking_date < filter.from) return false;
          if (filter.to !== undefined && t.booking_date > filter.to) return false;
          if (filter.search !== undefined) {
            const q = filter.search.toLowerCase();
            const match =
              t.clean_label.toLowerCase().includes(q) ||
              t.raw_label.toLowerCase().includes(q) ||
              (t.note?.content.toLowerCase().includes(q) ?? false);
            if (!match) return false;
          }
          return true;
        });

        return {
          items: filtered.slice(0, filter.limit).map(toTxDetail),
          total_count: filtered.length,
          latest_revision: toSyncRevision(currentRev),
        };
      },
      async patchTransaction(id, patch) {
        return patchTxInternal(id, patch);
      },
    },
    rulesRepository: {
      async listRules() {
        const active = rules
          .filter((r) => r.deleted_at === null)
          .slice()
          .sort((a, b) => a.priority - b.priority);
        return {
          rules: active.map(toRuleView),
          latest_revision: toSyncRevision(currentRev),
        };
      },
      async createRule(input) {
        ruleSeq += 1;
        const rev = nextRevision();
        const created: StoredRule = {
          id: parseRuleId(`44444444-4444-4444-8444-4444444444${String(ruleSeq).padStart(2, '0')}`),
          name: input.name,
          priority: input.priority,
          bank_filter: input.bank_filter,
          account_id_filter: input.account_id_filter,
          account_type_filter: input.account_type_filter,
          match_mode: input.match_mode,
          pattern: input.pattern,
          target_category: input.target_category,
          mark_as_internal_transfer: input.mark_as_internal_transfer,
          is_active: input.is_active,
          revision: rev,
          updated_at: FIXED_NOW.toISOString(),
          deleted_at: null,
          created_at_ms: ruleSeq * 1000,
        };
        rules.push(created);
        const stats = applyRecalc();
        return {
          rule: toRuleView(created),
          retroactive_stats: {
            updated_count: stats.updated_count,
            skipped_protected_count: stats.skipped_protected_count,
          },
          latest_revision: stats.rev,
        };
      },
      async updateRule(id, input) {
        const found = rules.find((r) => r.id === id && r.deleted_at === null);
        if (found === undefined) {
          return { ok: false, reason: 'not_found' };
        }
        const nextMode = input.match_mode ?? found.match_mode;
        const nextPattern = input.pattern ?? found.pattern;
        if (nextMode === 'regex' && !isSafeRegexPattern(nextPattern)) {
          return { ok: false, reason: 'invalid_regex' };
        }
        if (input.name !== undefined) found.name = input.name;
        if (input.priority !== undefined) found.priority = input.priority;
        if (input.bank_filter !== undefined) found.bank_filter = input.bank_filter;
        if (input.account_id_filter !== undefined) found.account_id_filter = input.account_id_filter;
        if (input.account_type_filter !== undefined) found.account_type_filter = input.account_type_filter;
        if (input.match_mode !== undefined) found.match_mode = input.match_mode;
        if (input.pattern !== undefined) found.pattern = input.pattern;
        if (input.target_category !== undefined) found.target_category = input.target_category;
        if (input.mark_as_internal_transfer !== undefined) {
          found.mark_as_internal_transfer = input.mark_as_internal_transfer;
        }
        if (input.is_active !== undefined) found.is_active = input.is_active;
        found.revision = nextRevision();
        found.updated_at = FIXED_NOW.toISOString();

        const stats = applyRecalc();
        return {
          ok: true,
          data: {
            rule: toRuleView(found),
            retroactive_stats: {
              updated_count: stats.updated_count,
              skipped_protected_count: stats.skipped_protected_count,
            },
            latest_revision: stats.rev,
          },
        };
      },
      async deleteRule(id) {
        const found = rules.find((r) => r.id === id && r.deleted_at === null);
        if (found === undefined) {
          return { ok: false, reason: 'not_found' };
        }
        found.deleted_at = FIXED_NOW;
        found.revision = nextRevision();
        const stats = applyRecalc();
        return {
          ok: true,
          data: {
            deleted_rule_id: found.id,
            retroactive_stats: {
              updated_count: stats.updated_count,
              skipped_protected_count: stats.skipped_protected_count,
            },
            latest_revision: stats.rev,
          },
        };
      },
      async reorderRules(items) {
        for (const item of items) {
          const found = rules.find((r) => r.id === item.id && r.deleted_at === null);
          if (found !== undefined) {
            found.priority = item.priority;
            found.revision = nextRevision();
          }
        }
        const stats = applyRecalc();
        const active = rules
          .filter((r) => r.deleted_at === null)
          .slice()
          .sort((a, b) => a.priority - b.priority);
        return {
          rules: active.map(toRuleView),
          retroactive_stats: {
            updated_count: stats.updated_count,
            skipped_protected_count: stats.skipped_protected_count,
          },
          latest_revision: stats.rev,
        };
      },
      async reapplyRules() {
        const stats = applyRecalc();
        return {
          retroactive_stats: {
            updated_count: stats.updated_count,
            skipped_protected_count: stats.skipped_protected_count,
          },
          latest_revision: stats.rev,
        };
      },
    },
    budgetsRepository: {
      async listBudgets(query) {
        const items: BudgetItem[] = [];
        for (const entry of budgets.values()) {
          if (query.currency !== undefined && entry.currency !== query.currency) {
            continue;
          }
          const spent = txs
            .filter(
              (t) =>
                t.deleted_at === null &&
                !t.is_internal_transfer &&
                t.booking_date.slice(0, 7) === query.month &&
                t.category === entry.category &&
                t.amount_cents < 0,
            )
            .reduce(
              (sum, t) =>
                sum + Math.abs(entry.currency === 'EUR' ? t.amount_eur_cents : t.amount_cents),
              0,
            );
          const spentCents = toCents(spent);
          const alert = computeBudgetAlert(spentCents, entry.monthly_limit_cents);
          items.push({
            category: entry.category,
            monthly_limit_cents: entry.monthly_limit_cents,
            currency: entry.currency,
            spent_cents: spentCents,
            remaining_cents: alert.remaining_cents,
            usage_percent: alert.usage_percent,
            alert_status: alert.status,
            revision: entry.revision,
            updated_at: entry.updated_at,
          });
        }
        return {
          month: query.month,
          budgets: items,
          latest_revision: toSyncRevision(currentRev),
        };
      },
      async upsertBudget(input) {
        const rev = nextRevision();
        const entry: StoredBudget = {
          category: input.category,
          monthly_limit_cents: input.monthly_limit_cents,
          currency: input.currency,
          revision: rev,
          updated_at: FIXED_NOW.toISOString(),
        };
        budgets.set(input.category, entry);
        const spent = txs
          .filter(
            (t) =>
              t.deleted_at === null &&
              !t.is_internal_transfer &&
              t.booking_date.slice(0, 7) === '2026-11' &&
              t.category === entry.category &&
              t.amount_cents < 0,
          )
          .reduce(
            (sum, t) =>
              sum + Math.abs(entry.currency === 'EUR' ? t.amount_eur_cents : t.amount_cents),
            0,
          );
        const spentCents = toCents(spent);
        const alert = computeBudgetAlert(spentCents, entry.monthly_limit_cents);
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
            updated_at: entry.updated_at,
          },
          latest_revision: rev,
        };
      },
      async deleteBudget(category) {
        if (!budgets.has(category)) {
          return null;
        }
        budgets.delete(category);
        return {
          deleted_category: category,
          latest_revision: nextRevision(),
        };
      },
    },
    analyticsRepository: {
      async getOverview(query) {
        const accInputs: AnalyticsAccountInput[] = accountsList.map((a) => ({
          id: a.id,
          bank: a.bank,
          currency: a.currency,
          current_balance_cents: a.current_balance_cents,
          current_balance_eur_cents: a.current_balance_eur_cents,
        }));
        const txInputs: AnalyticsTransactionInput[] = txs
          .filter((t) => t.deleted_at === null)
          .map((t) => ({
            id: t.id,
            account_id: t.account_id,
            bank: t.bank,
            booking_date: t.booking_date,
            raw_label: t.raw_label,
            clean_label: t.clean_label,
            amount_cents: t.amount_cents,
            currency: t.currency,
            amount_eur_cents: t.amount_eur_cents,
            category: t.category,
            is_internal_transfer: t.is_internal_transfer,
          }));
        return computeAnalyticsOverview({
          query,
          accounts: accInputs,
          transactions: txInputs,
          dataRevision: toSyncRevision(currentRev),
          now: FIXED_NOW,
        });
      },
    },
    deltaMutationRepository: options?.deltaMutationRepository ?? defaultDeltaMutationRepository,
    ...(options?.apk !== undefined ? { apk: options.apk } : {}),
  };

  return { app: createApp(deps), txs };
}

describe('ClairFlux API — Jalon 2 Routes Complètes & Sync Delta', () => {
  describe('Sécurité : Auth 401 & CSRF fail-closed 403', () => {
    it('rejette 401 UNAUTHORIZED sur toutes les nouvelles routes sans session', async () => {
      const { app } = createStatefulTestHarness({ allowedWebOrigin: 'http://localhost:5173' });

      const endpoints: ReadonlyArray<{ path: string; method?: string }> = [
        { path: '/api/transactions' },
        { path: `/api/transactions/${TX_CURSOR_ID}`, method: 'PATCH' },
        { path: '/api/rules' },
        { path: '/api/rules', method: 'POST' },
        { path: `/api/rules/${RULE_CURSOR_ID}`, method: 'PATCH' },
        { path: `/api/rules/${RULE_CURSOR_ID}`, method: 'DELETE' },
        { path: '/api/rules/reorder', method: 'POST' },
        { path: '/api/rules/reapply', method: 'POST' },
        { path: '/api/budgets' },
        { path: '/api/budgets', method: 'PUT' },
        { path: '/api/budgets', method: 'DELETE' },
        { path: '/api/analytics/overview' },
        { path: '/api/sync/delta', method: 'POST' },
        { path: '/api/apk/status' },
        { path: '/api/apk/download' },
      ];

      for (const endpoint of endpoints) {
        const res = await app.request(endpoint.path, {
          ...(endpoint.method !== undefined ? { method: endpoint.method } : {}),
        });
        expect(res.status).toBe(401);
        const body = ApiErrorEnvelopeSchema.parse(await res.json());
        expect(body.error.code).toBe('UNAUTHORIZED');
      }
    });

    it('applique CSRF fail-closed 403 sur les mutations par cookie Web (PATCH/POST/PUT/DELETE)', async () => {
      const webToken = createToken('web');

      // Case 1: allowedWebOrigin omitted -> fail-closed 403 even with Origin header
      const { app: noOriginApp } = createStatefulTestHarness();
      const noConfigRes = await noOriginApp.request(`/api/transactions/${TX_CURSOR_ID}`, {
        method: 'PATCH',
        headers: {
          Cookie: `clairflux_session=${webToken}`,
          Origin: 'http://localhost:5173',
          'X-Clairflux-Client': 'web',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ note: 'Test' }),
      });
      expect(noConfigRes.status).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(await noConfigRes.json()).error.code).toBe(
        'CSRF_ORIGIN_MISMATCH',
      );

      // Case 2: wrong Origin or missing X-Clairflux-Client -> 403
      const { app } = createStatefulTestHarness({ allowedWebOrigin: 'http://localhost:5173' });
      const evilOriginRes = await app.request('/api/budgets', {
        method: 'PUT',
        headers: {
          Cookie: `clairflux_session=${webToken}`,
          Origin: 'https://attacker.invalid',
          'X-Clairflux-Client': 'web',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ category: 'Alimentation', monthly_limit_cents: 50000 }),
      });
      expect(evilOriginRes.status).toBe(403);

      // Case 3: valid CSRF headers -> succeeds 200
      const okCsrfRes = await app.request('/api/budgets', {
        method: 'PUT',
        headers: {
          Cookie: `clairflux_session=${webToken}`,
          Origin: 'http://localhost:5173',
          'X-Clairflux-Client': 'web',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ category: 'Alimentation', monthly_limit_cents: 50000 }),
      });
      expect(okCsrfRes.status).toBe(200);
    });
  });

  describe('Validation Zod 400 aux frontières HTTP', () => {
    it('rejette 400 BAD_REQUEST sur les paramètres et corps invalides', async () => {
      const { app } = createStatefulTestHarness();
      const token = createToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const badGetUrls = [
        '/api/transactions?bank=unknown',
        '/api/transactions?account_id=not-a-uuid',
        '/api/transactions?from=2026-02-30',
        '/api/transactions?from=2026-11-20&to=2026-11-01',
        '/api/transactions?limit=250',
        '/api/analytics/overview?scope=invalid',
        '/api/analytics/overview?currency_mode=gbp',
        '/api/analytics/overview?expense_comparison=year',
        '/api/sync/delta?since=0&since_timestamp=not-iso-date',
      ];

      for (const url of badGetUrls) {
        const res = await app.request(url, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status).toBe(400);
        expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('BAD_REQUEST');
      }

      const emptyPatchRes = await app.request(`/api/transactions/${TX_CURSOR_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({}),
      });
      expect(emptyPatchRes.status).toBe(400);

      const badRuleRegexRes = await app.request('/api/rules', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'ReDoS attempt',
          match_mode: 'regex',
          pattern: '(a+)+',
          target_category: 'Test',
        }),
      });
      expect(badRuleRegexRes.status).toBe(400);

      const badReorderRes = await app.request('/api/rules/reorder', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [{ id: RULE_CURSOR_ID, priority: 10001 }],
        }),
      });
      expect(badReorderRes.status).toBe(400);

      const badBudgetRes = await app.request('/api/budgets', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          category: 'Alimentation',
          monthly_limit_cents: 0,
        }),
      });
      expect(badBudgetRes.status).toBe(400);

      const badDeltaPostRes = await app.request('/api/sync/delta', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mutations: [] }),
      });
      expect(badDeltaPostRes.status).toBe(400);
    });
  });

  describe('Transactions (GET /api/transactions & PATCH /api/transactions/:id)', () => {
    it('filtre par bank, account_id, currency, has_notes, search, from, to et limit', async () => {
      const { app } = createStatefulTestHarness();
      const token = createToken();

      const res = await app.request(
        `/api/transactions?bank=revolut&account_id=${ACC_REV_USD_ID}&currency=USD&has_notes=true&search=Abonnement&from=2026-11-01&to=2026-11-30&limit=10`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: TransactionDetail[]; total_count: number };
      expect(body.total_count).toBe(1);
      expect(body.items[0]?.id).toBe(TX_CURSOR_ID);
      expect(body.items[0]?.note?.content).toBe('Abonnement dev');
    });

    it('met à jour note + category (pose is_manual_category=true) et is_internal_transfer (sans toucher is_manual_category)', async () => {
      const { app } = createStatefulTestHarness();
      const token = createToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      // 1. Toggle is_internal_transfer on TX_CARREFOUR_ID -> sets is_manual_transfer_override=true, leaves is_manual_category=false
      const transferPatchRes = await app.request(`/api/transactions/${TX_CARREFOUR_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_internal_transfer: true }),
      });
      expect(transferPatchRes.status).toBe(200);
      const transferBody = (await transferPatchRes.json()) as { transaction: TransactionDetail };
      expect(transferBody.transaction.is_internal_transfer).toBe(true);
      expect(transferBody.transaction.is_manual_transfer_override).toBe(true);
      expect(transferBody.transaction.is_manual_category).toBe(false);

      // 2. Patch note + category on TX_CURSOR_ID -> sets is_manual_category=true, matched_rule_id=null
      const patchRes = await app.request(`/api/transactions/${TX_CURSOR_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          note: 'Facture remboursable client',
          category: 'Matériel & Pro',
        }),
      });
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as { transaction: TransactionDetail };
      expect(patchBody.transaction.note?.content).toBe('Facture remboursable client');
      expect(patchBody.transaction.category).toBe('Matériel & Pro');
      expect(patchBody.transaction.is_manual_category).toBe(true);
      expect(patchBody.transaction.matched_rule_id).toBeNull();

      // 3. Reapply rules -> TX_CURSOR_ID MUST NOT be overwritten back to 'Logiciels & Cloud'
      const reapplyRes = await app.request('/api/rules/reapply', {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(reapplyRes.status).toBe(200);

      const verifyRes = await app.request(`/api/transactions?search=Cursor&from=2026-11-01`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const verifyBody = (await verifyRes.json()) as { items: TransactionDetail[] };
      expect(verifyBody.items[0]?.category).toBe('Matériel & Pro');
      expect(verifyBody.items[0]?.is_manual_category).toBe(true);
    });
  });

  describe('Règles de catégorisation (CRUD, reorder & reapply avec protection manuelle)', () => {
    it('crée, modifie, réordonne, réapplique et supprime en protégeant is_manual_category, transfer_group_id et is_manual_transfer_override', async () => {
      const { app, txs } = createStatefulTestHarness();
      const token = createToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      // Create high-priority rule matching 'CARREFOUR'
      const createRes = await app.request('/api/rules', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Courses Carrefour',
          priority: 50,
          bank_filter: 'boursobank',
          match_mode: 'contains',
          pattern: 'CARREFOUR',
          target_category: 'Alimentation',
        }),
      });
      expect(createRes.status).toBe(201);
      const createdBody = (await createRes.json()) as {
        rule: RuleView;
        retroactive_stats: { updated_count: number; skipped_protected_count: number };
      };
      // Only TX_CARREFOUR_ID is eligible; TX_MANUAL_CAT_ID (manual), TX_TRANSFER_PAIRED_ID (transfer_group_id), TX_TRANSFER_OVERRIDE_ID (override) are protected!
      expect(createdBody.retroactive_stats.updated_count).toBe(1);
      expect(createdBody.retroactive_stats.skipped_protected_count).toBe(3);
      expect(txs.find((t) => t.id === TX_CARREFOUR_ID)?.category).toBe('Alimentation');
      expect(txs.find((t) => t.id === TX_MANUAL_CAT_ID)?.category).toBe('Cadeaux');
      expect(txs.find((t) => t.id === TX_TRANSFER_PAIRED_ID)?.category).toBe('Transfert interne');
      expect(txs.find((t) => t.id === TX_TRANSFER_OVERRIDE_ID)?.category).toBe('Non catégorisé');

      // Reorder RULE_LOW_PRIO_ID ('MARKET' -> 'Divers Courses') above the new rule (priority 5 < 50)
      const reorderRes = await app.request('/api/rules/reorder', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [
            { id: RULE_LOW_PRIO_ID, priority: 5 },
            { id: createdBody.rule.id, priority: 50 },
          ],
        }),
      });
      expect(reorderRes.status).toBe(200);
      expect(txs.find((t) => t.id === TX_CARREFOUR_ID)?.category).toBe('Divers Courses');

      // Update RULE_LOW_PRIO_ID target category
      const patchRuleRes = await app.request(`/api/rules/${RULE_LOW_PRIO_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ target_category: 'Supermarchés' }),
      });
      expect(patchRuleRes.status).toBe(200);
      expect(txs.find((t) => t.id === TX_CARREFOUR_ID)?.category).toBe('Supermarchés');

      // Delete RULE_LOW_PRIO_ID -> falls back to 'Alimentation' (rule priority 50)
      const deleteRuleRes = await app.request(`/api/rules/${RULE_LOW_PRIO_ID}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(deleteRuleRes.status).toBe(200);
      expect(txs.find((t) => t.id === TX_CARREFOUR_ID)?.category).toBe('Alimentation');
    });
  });

  describe('Budgets mensuels & seuils d’alerte (ok < 80%, warning 80..99%, exceeded >= 100%)', () => {
    it('calcule exactement ok (<80%), warning (80%..99%) et exceeded (>=100%) et gère PUT/GET/DELETE', async () => {
      // Exact pure threshold checks
      expect(computeBudgetAlert(toCents(7999), toCents(10000)).status).toBe('ok');
      expect(computeBudgetAlert(toCents(8000), toCents(10000)).status).toBe('warning');
      expect(computeBudgetAlert(toCents(9999), toCents(10000)).status).toBe('warning');
      expect(computeBudgetAlert(toCents(10000), toCents(10000)).status).toBe('exceeded');

      const { app } = createStatefulTestHarness();
      const token = createToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      // TX_CARREFOUR_ID is -8000 cents (80.00 EUR) in 2026-11; first categorize it as Alimentation
      await app.request(`/api/transactions/${TX_CARREFOUR_ID}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ category: 'Alimentation' }),
      });

      // Set Alimentation budget to 10000 cents -> 8000/10000 = 80% -> warning
      await app.request('/api/budgets', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ category: 'Alimentation', monthly_limit_cents: 10000, currency: 'EUR' }),
      });

      // TX_NETFLIX_NOV_ID is -1349 cents in Abonnements; set budget to 1000 -> 134.9% -> exceeded
      await app.request('/api/budgets', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ category: 'Abonnements', monthly_limit_cents: 1000, currency: 'EUR' }),
      });

      // Cadeaux is -2500 cents; set budget to 5000 -> 50% -> ok
      await app.request('/api/budgets', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ category: 'Cadeaux', monthly_limit_cents: 5000, currency: 'EUR' }),
      });

      const listRes = await app.request('/api/budgets?month=2026-11', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { budgets: BudgetItem[] };
      const byCat = new Map(listBody.budgets.map((b) => [b.category, b]));
      expect(byCat.get('Alimentation')?.alert_status).toBe('warning');
      expect(byCat.get('Alimentation')?.usage_percent).toBe(80);
      expect(byCat.get('Abonnements')?.alert_status).toBe('exceeded');
      expect(byCat.get('Cadeaux')?.alert_status).toBe('ok');

      const delRes = await app.request('/api/budgets?category=Cadeaux', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delRes.status).toBe(200);

      const delMissingRes = await app.request('/api/budgets?category=Inexistante', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(delMissingRes.status).toBe(404);
    });
  });

  describe('Analytics Overview (GET /api/analytics/overview)', () => {
    it('retourne les agrégats EUR consolidés, USD seul, exclusions transferts et récurrences détectées', async () => {
      const { app } = createStatefulTestHarness();
      const token = createToken();

      // EUR consolidated (all banks)
      const eurRes = await app.request(
        '/api/analytics/overview?scope=all&currency_mode=eur_consolidated&expense_comparison=avg_3m&reference_month=2026-11',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(eurRes.status).toBe(200);
      const eurBody = AnalyticsOverviewResponseSchema.parse(await eurRes.json());
      expect(eurBody.display_currency).toBe('EUR');
      expect(eurBody.kpis.consolidated_balance_cents).toBe(584900); // 400000 + 184900
      expect(eurBody.kpis.month_income_cents).toBe(350000);
      // Expenses in 2026-11 excluding TX_TRANSFER_PAIRED_ID (-50000): 1849 + 8000 + 2500 + 1500 + 1349 = 15198
      expect(eurBody.kpis.month_expenses_excl_transfers_cents).toBe(15198);
      expect(eurBody.kpis.month_internal_transfers_cents).toBe(50000);
      expect(eurBody.cumulative_balance_6m).toHaveLength(6);
      expect(eurBody.expense_comparison_summary.avg_3m_expenses_cents).not.toBeNull();

      // Detected recurrences: Netflix (Oct 5 + Nov 5) and Cursor AI (Oct 18 + Nov 18)
      const recurrenceNames = eurBody.recurrences.map((r) => r.clean_label);
      expect(recurrenceNames).toContain('Netflix');
      expect(recurrenceNames).toContain('Cursor AI');

      // USD only mode (native USD without EUR conversion)
      const usdRes = await app.request(
        '/api/analytics/overview?scope=revolut&currency_mode=usd_only&expense_comparison=none&reference_month=2026-11',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(usdRes.status).toBe(200);
      const usdBody = AnalyticsOverviewResponseSchema.parse(await usdRes.json());
      expect(usdBody.display_currency).toBe('USD');
      expect(usdBody.kpis.consolidated_balance_cents).toBe(200000);
      expect(usdBody.kpis.month_expenses_excl_transfers_cents).toBe(2000);
      expect(usdBody.expense_comparison_summary.prev_month_expenses_cents).toBeNull();
      expect(usdBody.expense_comparison_summary.avg_3m_expenses_cents).toBeNull();
      expect(usdBody.recurrences.map((r) => r.clean_label)).toEqual(['Cursor AI']);
    });
  });

  describe('Delta Sync (GET /api/sync/delta avec since_timestamp & POST /api/sync/delta idempotent)', () => {
    it('accepte since + since_timestamp sur GET /api/sync/delta', async () => {
      let captured: DeltaSyncQuery | undefined;
      const { app } = createStatefulTestHarness({
        onGetDelta: (q) => {
          captured = q;
        },
      });
      const token = createToken();

      const res = await app.request(
        '/api/sync/delta?since=1400&since_timestamp=2026-11-20T00:00:00.000Z&limit=250',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      DeltaSyncResponseSchema.parse(await res.json());
      expect(captured).toEqual({
        since: toSyncRevision(1400),
        limit: 250,
        since_timestamp: '2026-11-20T00:00:00.000Z',
      });
    });

    it('traite un batch Outbox de façon idempotente par client_mutation_id (applied / duplicate / rejected)', async () => {
      const { app, txs } = createStatefulTestHarness();
      const token = createToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const mutNoteId = '10000000-0000-4000-8000-000000000001';
      const mutCatId = '10000000-0000-4000-8000-000000000002';
      const mutUnknownId = '10000000-0000-4000-8000-000000000003';

      const firstRes = await app.request('/api/sync/delta', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mutations: [
            {
              client_mutation_id: mutNoteId,
              kind: 'upsert_note',
              transaction_id: TX_CARREFOUR_ID,
              note: 'Courses semaine hors-ligne',
            },
            {
              client_mutation_id: mutCatId,
              kind: 'set_category',
              transaction_id: TX_CARREFOUR_ID,
              category: 'Alimentation',
            },
            {
              client_mutation_id: mutUnknownId,
              kind: 'upsert_note',
              transaction_id: TX_UNKNOWN_ID,
              note: 'Introuvable',
            },
          ],
        }),
      });
      expect(firstRes.status).toBe(200);
      const firstBody = PostSyncDeltaResponseSchema.parse(await firstRes.json());
      const firstResult0 = firstBody.results[0];
      const firstResult1 = firstBody.results[1];
      const firstResult2 = firstBody.results[2];
      expect(firstResult0?.status).toBe('applied');
      expect(firstResult1?.status).toBe('applied');
      expect(firstResult2?.status).toBe('rejected');

      if (firstResult0?.status !== 'applied' || firstResult1?.status !== 'applied') {
        throw new Error('Expected first two outbox mutations to be applied');
      }

      // Verify category manual protection & note persisted
      const updatedTx = txs.find((t) => t.id === TX_CARREFOUR_ID);
      expect(updatedTx?.note?.content).toBe('Courses semaine hors-ligne');
      expect(updatedTx?.category).toBe('Alimentation');
      expect(updatedTx?.is_manual_category).toBe(true);

      // Replay same client_mutation_id -> must return duplicate with identical revision
      const replayRes = await app.request('/api/sync/delta', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mutations: [
            {
              client_mutation_id: mutNoteId,
              kind: 'upsert_note',
              transaction_id: TX_CARREFOUR_ID,
              note: 'Courses semaine hors-ligne',
            },
            {
              client_mutation_id: mutCatId,
              kind: 'set_category',
              transaction_id: TX_CARREFOUR_ID,
              category: 'Alimentation',
            },
          ],
        }),
      });
      expect(replayRes.status).toBe(200);
      const replayBody = PostSyncDeltaResponseSchema.parse(await replayRes.json());
      expect(replayBody.results[0]).toEqual({
        client_mutation_id: mutNoteId,
        status: 'duplicate',
        revision: firstResult0.revision,
      });
      expect(replayBody.results[1]).toEqual({
        client_mutation_id: mutCatId,
        status: 'duplicate',
        revision: firstResult1.revision,
      });
    });

    it('persiste client_mutation_id + payload_hash et retourne duplicate après redémarrage serveur API (applied_client_mutations)', async () => {
      const persistedAppliedMutations = new Map<string, AppliedClientMutationRecord>();
      let persistedRevision = 2000;
      let applyCalls = 0;

      const buildRestartableServer = () => {
        const deltaRepo = createIdempotentDeltaMutationRepository({
          async findAppliedMutation(clientMutationId) {
            return persistedAppliedMutations.get(clientMutationId) ?? null;
          },
          async getLatestRevision() {
            return toSyncRevision(persistedRevision);
          },
          async applyAndRecordMutation({ mutation, payloadHash }) {
            const existing = persistedAppliedMutations.get(mutation.client_mutation_id);
            if (existing !== undefined) {
              return existing.payloadHash === payloadHash
                ? { kind: 'duplicate', revision: toSyncRevision(existing.resultRevision) }
                : { kind: 'conflict' };
            }
            if (mutation.transaction_id === TX_UNKNOWN_ID) {
              return { kind: 'not_found' };
            }
            applyCalls += 1;
            persistedRevision += 1;
            const rev = toSyncRevision(persistedRevision);
            persistedAppliedMutations.set(mutation.client_mutation_id, {
              clientMutationId: mutation.client_mutation_id,
              payloadHash,
              appliedAt: FIXED_NOW,
              resultStatus: 'applied',
              resultRevision: rev,
            });
            return { kind: 'applied', revision: rev };
          },
        });

        return createStatefulTestHarness({ deltaMutationRepository: deltaRepo }).app;
      };

      const token = createToken();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const mutId = '20000000-0000-4000-8000-000000000001';

      const mutationPayload = {
        client_mutation_id: mutId,
        kind: 'upsert_note' as const,
        transaction_id: TX_CARREFOUR_ID,
        note: 'Persistance SQL après redémarrage',
      };

      // Server instance #1 applies the mutation and records payload_hash in applied_client_mutations
      const serverInstance1 = buildRestartableServer();
      const firstRes = await serverInstance1.request('/api/sync/delta', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mutations: [
            {
              ...mutationPayload,
              client_updated_at: '2026-11-21T14:00:00.000Z',
            },
          ],
        }),
      });
      expect(firstRes.status).toBe(200);
      const firstBody = PostSyncDeltaResponseSchema.parse(await firstRes.json());
      expect(firstBody.results[0]).toEqual({
        client_mutation_id: mutId,
        status: 'applied',
        revision: toSyncRevision(2001),
      });
      expect(applyCalls).toBe(1);

      const storedRecord = persistedAppliedMutations.get(mutId);
      expect(storedRecord).toBeDefined();
      expect(storedRecord?.payloadHash).toBe(computeCanonicalMutationPayloadHash(mutationPayload));
      expect(storedRecord?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(storedRecord?.resultStatus).toBe('applied');
      expect(storedRecord?.resultRevision).toBe(2001);

      // Server instance #2 (fresh process, zero in-memory cache) replays the same mutation -> 'duplicate'
      const serverInstance2 = buildRestartableServer();
      const replayRes = await serverInstance2.request('/api/sync/delta', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mutations: [
            {
              ...mutationPayload,
              client_updated_at: '2026-11-21T15:30:00.000Z',
            },
          ],
        }),
      });
      expect(replayRes.status).toBe(200);
      const replayBody = PostSyncDeltaResponseSchema.parse(await replayRes.json());
      expect(replayBody.results[0]).toEqual({
        client_mutation_id: mutId,
        status: 'duplicate',
        revision: toSyncRevision(2001),
      });
      expect(applyCalls).toBe(1);

      // Replaying the same client_mutation_id with a different payload -> 'rejected' CONFLICT
      const conflictRes = await serverInstance2.request('/api/sync/delta', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mutations: [
            {
              client_mutation_id: mutId,
              kind: 'upsert_note',
              transaction_id: TX_CARREFOUR_ID,
              note: 'Payload altéré avec le même UUID',
            },
          ],
        }),
      });
      expect(conflictRes.status).toBe(200);
      const conflictBody = PostSyncDeltaResponseSchema.parse(await conflictRes.json());
      expect(conflictBody.results[0]?.status).toBe('rejected');
      if (conflictBody.results[0]?.status === 'rejected') {
        expect(conflictBody.results[0].reason).toBe('CONFLICT');
      }
      expect(applyCalls).toBe(1);
    });
  });

  describe('Android APK Endpoints (GET /api/apk/status & GET /api/apk/download)', () => {
    it('retourne 401 sans auth, available:false + 404 JSON si absent, puis available:true + 200 binaire si présent', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'clairflux-apk-test-'));
      try {
        const apkPath = join(tmpDir, 'clairflux-release.apk');
        const apkRepo = createFilesystemApkRepository(apkPath, '1.4.0-test');
        const { app } = createStatefulTestHarness({ apk: apkRepo });
        const token = createToken();

        // 1. Unauthenticated requests -> 401 UNAUTHORIZED
        const unauthStatusRes = await app.request('/api/apk/status');
        expect(unauthStatusRes.status).toBe(401);
        expect(ApiErrorEnvelopeSchema.parse(await unauthStatusRes.json()).error.code).toBe(
          'UNAUTHORIZED',
        );

        const unauthDownloadRes = await app.request('/api/apk/download');
        expect(unauthDownloadRes.status).toBe(401);
        expect(ApiErrorEnvelopeSchema.parse(await unauthDownloadRes.json()).error.code).toBe(
          'UNAUTHORIZED',
        );

        // 2. APK absent -> status available: false, download 404 structured JSON
        const missingStatusRes = await app.request('/api/apk/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(missingStatusRes.status).toBe(200);
        const missingStatus = ApkStatusSchema.parse(await missingStatusRes.json());
        expect(missingStatus).toEqual({
          available: false,
          version: '1.4.0-test',
          sizeBytes: null,
          sha256: null,
          builtAt: null,
        });

        const missingDownloadRes = await app.request('/api/apk/download', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(missingDownloadRes.status).toBe(404);
        const missingDownloadBody = ApiErrorEnvelopeSchema.parse(await missingDownloadRes.json());
        expect(missingDownloadBody.error.code).toBe('RESOURCE_NOT_FOUND');
        expect(missingDownloadBody.error.message).toBe('APK ClairFlux non encore compilé.');
        expect(missingDownloadBody.error.retryable).toBe(false);
        expect(missingDownloadBody.error.request_id).toBeTruthy();

        // 3. APK present without sidecar -> on-the-fly SHA-256 + binary download 200
        const fakeApkBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x43, 0x46, 0x58, 0x01]);
        const expectedSha256 = createHash('sha256').update(fakeApkBytes).digest('hex');
        await writeFile(apkPath, fakeApkBytes);

        const presentStatusRes = await app.request('/api/apk/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(presentStatusRes.status).toBe(200);
        const presentStatus = ApkStatusSchema.parse(await presentStatusRes.json());
        expect(presentStatus.available).toBe(true);
        expect(presentStatus.version).toBe('1.4.0-test');
        expect(presentStatus.sizeBytes).toBe(fakeApkBytes.byteLength);
        expect(presentStatus.sha256).toBe(expectedSha256);
        expect(presentStatus.builtAt).not.toBeNull();
        expect(Number.isNaN(Date.parse(presentStatus.builtAt ?? ''))).toBe(false);

        const presentDownloadRes = await app.request('/api/apk/download', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(presentDownloadRes.status).toBe(200);
        expect(presentDownloadRes.headers.get('Content-Type')).toBe(
          'application/vnd.android.package-archive',
        );
        expect(presentDownloadRes.headers.get('Content-Disposition')).toBe(
          'attachment; filename="clairflux-release.apk"',
        );
        expect(presentDownloadRes.headers.get('Content-Length')).toBe(
          String(fakeApkBytes.byteLength),
        );
        expect(presentDownloadRes.headers.get('Cache-Control')).toBe('no-store');
        const downloadedBytes = new Uint8Array(await presentDownloadRes.arrayBuffer());
        expect(downloadedBytes).toEqual(fakeApkBytes);

        // 4. Sidecar .sha256 present -> read directly by createFilesystemApkRepository
        const sidecarDigest = 'a'.repeat(64);
        await writeFile(`${apkPath}.sha256`, `${sidecarDigest}  clairflux-release.apk\n`, 'utf8');
        const sidecarStatus = await apkRepo.getStatus();
        expect(sidecarStatus.available).toBe(true);
        expect(sidecarStatus.sha256).toBe(sidecarDigest);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
