import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DRIVE_FOLDERS,
  ApiErrorEnvelopeSchema,
  DEFAULT_FRENCH_CATEGORY_PACK,
  DeltaSyncResponseSchema,
  UNCATEGORIZED_CATEGORY_ID,
  extractMerchantPatternForRule,
  parseAccountId,
  parseCategoryId,
  parseDriveFileId,
  parseRuleId,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type AccountId,
  type AiCategorizationRun,
  type AiReviewItem,
  type AiReviewStatus,
  type AiRuleSuggestion,
  type CategoryId,
  type CategorySource,
  type DeltaSyncResponse,
  type RuleId,
  type SyncRevision,
  type TransactionId,
} from '@clairflux/shared';
import {
  createApp,
  signSessionToken,
  type AiBackfillDispatcher,
  type AiCategorizationRepository,
  type AppDependencies,
  type RuleView,
} from './app.js';
import { computeRuleReapplication, type RuleEvalRule, type RuleEvalTransaction } from './routes/contracts.js';
import { createHttpAiBackfillDispatcher } from './server.js';

const TEST_SESSION_SECRET = 'clairflux-test-session-secret-minimum-32-chars';
const FIXED_NOW = new Date('2026-11-26T18:00:00.000Z');
const VALID_JTI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const ACC_ID = parseAccountId('11111111-1111-4111-8111-111111111111');
const TX_PENDING_ACCEPT_ID = parseTransactionId('33333333-3333-4333-8333-333333333351');
const TX_PENDING_OVERRIDE_ID = parseTransactionId('33333333-3333-4333-8333-333333333352');
const TX_PENDING_REJECT_ID = parseTransactionId('33333333-3333-4333-8333-333333333353');
const TX_ELIGIBLE_BIOCOOP_ID = parseTransactionId('33333333-3333-4333-8333-333333333354');
const TX_MANUAL_PROTECTED_ID = parseTransactionId('33333333-3333-4333-8333-333333333355');
const TX_INTERNAL_TRANSFER_ID = parseTransactionId('33333333-3333-4333-8333-333333333356');
const TX_ELIGIBLE_PHARMACIE_ID = parseTransactionId('33333333-3333-4333-8333-333333333357');

const ROOT_ALIM_ID = parseCategoryId('c1000000-0000-4000-8000-000000000040');
const SUB_COURSES_ID = parseCategoryId('c1000000-0000-4000-8000-000000000041');
const ROOT_SANTE_VIE_ID = parseCategoryId('c1000000-0000-4000-8000-000000000060');
const SUB_PHARMACIE_ID = parseCategoryId('c1000000-0000-4000-8000-000000000062');
const ROOT_LOISIRS_ID = parseCategoryId('c1000000-0000-4000-8000-000000000070');

const SUG_BIOCOOP_ID = '55555555-5555-4555-8555-555555555501';
const SUG_DISMISS_ID = '55555555-5555-4555-8555-555555555502';
const RUN_1_ID = '66666666-6666-4666-8666-666666666601';

function createToken(): string {
  const nowSec = Math.floor(FIXED_NOW.getTime() / 1000);
  return signSessionToken(
    {
      jti: VALID_JTI,
      client_kind: 'web',
      iat: nowSec - 60,
      exp: nowSec + 3600,
    },
    TEST_SESSION_SECRET,
  );
}

interface StoredAiTx {
  id: TransactionId;
  account_id: AccountId;
  booking_date: string;
  raw_label: string;
  clean_label: string;
  amount_cents: number;
  amount_eur_cents: number;
  category: string;
  category_id: CategoryId | null;
  subcategory_id: CategoryId | null;
  category_source: CategorySource;
  is_manual_category: boolean;
  is_internal_transfer: boolean;
  is_manual_transfer_override: boolean;
  transfer_group_id: string | null;
  matched_rule_id: RuleId | null;
  ai_review_status: AiReviewStatus;
  ai_confidence_bp: number | null;
  ai_suggested_category_id: CategoryId | null;
  ai_suggested_subcategory_id: CategoryId | null;
  ai_reason: string | null;
  ai_model: string | null;
  revision: SyncRevision;
  updated_at: string;
}

interface StoredAiRule {
  id: RuleId;
  name: string;
  priority: number;
  match_mode: 'contains' | 'starts_with' | 'exact' | 'regex';
  pattern: string;
  target_category: string;
  target_category_id: CategoryId | null;
  target_subcategory_id: CategoryId | null;
  is_active: boolean;
  revision: SyncRevision;
  updated_at: string;
}

function createAiTestHarness() {
  let rev = 2000;
  const nextRev = (): SyncRevision => {
    rev += 1;
    return toSyncRevision(rev);
  };

  const catById = new Map(DEFAULT_FRENCH_CATEGORY_PACK.map((c) => [c.id, c]));

  let activeRun: AiCategorizationRun | null = null;
  let workerReachable = true;

  const txs: StoredAiTx[] = [
    {
      id: TX_PENDING_ACCEPT_ID,
      account_id: ACC_ID,
      booking_date: '2026-11-22',
      raw_label: 'CARTE 22/11 PHARMACIE CENTRALE LYON',
      clean_label: 'Pharmacie Centrale',
      amount_cents: -2450,
      amount_eur_cents: -2450,
      category: 'Non catégorisé',
      category_id: UNCATEGORIZED_CATEGORY_ID,
      subcategory_id: null,
      category_source: 'uncategorized',
      is_manual_category: false,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      matched_rule_id: null,
      ai_review_status: 'pending_review',
      ai_confidence_bp: 7900,
      ai_suggested_category_id: ROOT_SANTE_VIE_ID,
      ai_suggested_subcategory_id: SUB_PHARMACIE_ID,
      ai_reason: 'Libellé de pharmacie',
      ai_model: 'gemini-4-hydrogen',
      revision: toSyncRevision(1901),
      updated_at: FIXED_NOW.toISOString(),
    },
    {
      id: TX_PENDING_OVERRIDE_ID,
      account_id: ACC_ID,
      booking_date: '2026-11-21',
      raw_label: 'CARTE 21/11 LIBRAIRIE DU COIN',
      clean_label: 'Librairie du Coin',
      amount_cents: -1800,
      amount_eur_cents: -1800,
      category: 'Non catégorisé',
      category_id: UNCATEGORIZED_CATEGORY_ID,
      subcategory_id: null,
      category_source: 'uncategorized',
      is_manual_category: false,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      matched_rule_id: null,
      ai_review_status: 'pending_review',
      ai_confidence_bp: 6200,
      ai_suggested_category_id: ROOT_ALIM_ID,
      ai_suggested_subcategory_id: SUB_COURSES_ID,
      ai_reason: 'Commerce de proximité ambigu',
      ai_model: 'gemini-4-hydrogen',
      revision: toSyncRevision(1902),
      updated_at: FIXED_NOW.toISOString(),
    },
    {
      id: TX_PENDING_REJECT_ID,
      account_id: ACC_ID,
      booking_date: '2026-11-20',
      raw_label: 'CARTE 20/11 DIVERS INCONNU',
      clean_label: 'Divers Inconnu',
      amount_cents: -950,
      amount_eur_cents: -950,
      category: 'Non catégorisé',
      category_id: UNCATEGORIZED_CATEGORY_ID,
      subcategory_id: null,
      category_source: 'uncategorized',
      is_manual_category: false,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      matched_rule_id: null,
      ai_review_status: 'pending_review',
      ai_confidence_bp: 5100,
      ai_suggested_category_id: ROOT_LOISIRS_ID,
      ai_suggested_subcategory_id: null,
      ai_reason: 'Incertain',
      ai_model: 'gemini-3.8-flash',
      revision: toSyncRevision(1903),
      updated_at: FIXED_NOW.toISOString(),
    },
    {
      id: TX_ELIGIBLE_BIOCOOP_ID,
      account_id: ACC_ID,
      booking_date: '2026-11-19',
      raw_label: 'CARTE 19/11 BIOCOOP PARIS',
      clean_label: 'Biocoop Paris',
      amount_cents: -4200,
      amount_eur_cents: -4200,
      category: 'Non catégorisé',
      category_id: UNCATEGORIZED_CATEGORY_ID,
      subcategory_id: null,
      category_source: 'uncategorized',
      is_manual_category: false,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      matched_rule_id: null,
      ai_review_status: 'none',
      ai_confidence_bp: null,
      ai_suggested_category_id: null,
      ai_suggested_subcategory_id: null,
      ai_reason: null,
      ai_model: null,
      revision: toSyncRevision(1904),
      updated_at: FIXED_NOW.toISOString(),
    },
    {
      id: TX_ELIGIBLE_PHARMACIE_ID,
      account_id: ACC_ID,
      booking_date: '2026-11-18',
      raw_label: 'CARTE 18/11 PHARMACIE CENTRALE',
      clean_label: 'Pharmacie Centrale',
      amount_cents: -1200,
      amount_eur_cents: -1200,
      category: 'Non catégorisé',
      category_id: UNCATEGORIZED_CATEGORY_ID,
      subcategory_id: null,
      category_source: 'uncategorized',
      is_manual_category: false,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      matched_rule_id: null,
      ai_review_status: 'none',
      ai_confidence_bp: null,
      ai_suggested_category_id: null,
      ai_suggested_subcategory_id: null,
      ai_reason: null,
      ai_model: null,
      revision: toSyncRevision(1905),
      updated_at: FIXED_NOW.toISOString(),
    },
    {
      id: TX_MANUAL_PROTECTED_ID,
      account_id: ACC_ID,
      booking_date: '2026-11-17',
      raw_label: 'CARTE 17/11 BIOCOOP CADEAU',
      clean_label: 'Biocoop Cadeau',
      amount_cents: -3000,
      amount_eur_cents: -3000,
      category: 'Cadeaux & Dons',
      category_id: ROOT_LOISIRS_ID,
      subcategory_id: parseCategoryId('c1000000-0000-4000-8000-000000000073'),
      category_source: 'manual',
      is_manual_category: true,
      is_internal_transfer: false,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      matched_rule_id: null,
      ai_review_status: 'none',
      ai_confidence_bp: null,
      ai_suggested_category_id: null,
      ai_suggested_subcategory_id: null,
      ai_reason: null,
      ai_model: null,
      revision: toSyncRevision(1906),
      updated_at: FIXED_NOW.toISOString(),
    },
    {
      id: TX_INTERNAL_TRANSFER_ID,
      account_id: ACC_ID,
      booking_date: '2026-11-16',
      raw_label: 'VIR BIOCOOP INTERNE',
      clean_label: 'Virement interne Biocoop',
      amount_cents: -10000,
      amount_eur_cents: -10000,
      category: 'Transfert interne',
      category_id: parseCategoryId('c1000000-0000-4000-8000-000000000110'),
      subcategory_id: parseCategoryId('c1000000-0000-4000-8000-000000000111'),
      category_source: 'rule',
      is_manual_category: false,
      is_internal_transfer: true,
      is_manual_transfer_override: false,
      transfer_group_id: null,
      matched_rule_id: null,
      ai_review_status: 'none',
      ai_confidence_bp: null,
      ai_suggested_category_id: null,
      ai_suggested_subcategory_id: null,
      ai_reason: null,
      ai_model: null,
      revision: toSyncRevision(1907),
      updated_at: FIXED_NOW.toISOString(),
    },
  ];

  const rules: StoredAiRule[] = [];

  const suggestions: AiRuleSuggestion[] = [
    {
      id: SUG_BIOCOOP_ID,
      merchant_pattern: 'biocoop',
      match_mode: 'contains',
      target_category_id: ROOT_ALIM_ID,
      target_subcategory_id: SUB_COURSES_ID,
      target_category_name: 'Alimentation',
      target_subcategory_name: 'Courses & Supermarché',
      sample_count: 5,
      status: 'pending',
      created_at: FIXED_NOW.toISOString(),
      updated_at: FIXED_NOW.toISOString(),
      revision: toSyncRevision(1950),
    },
    {
      id: SUG_DISMISS_ID,
      merchant_pattern: 'sncf',
      match_mode: 'contains',
      target_category_id: parseCategoryId('c1000000-0000-4000-8000-000000000050'),
      target_subcategory_id: parseCategoryId('c1000000-0000-4000-8000-000000000052'),
      target_category_name: 'Transports',
      target_subcategory_name: 'Transports en commun',
      sample_count: 3,
      status: 'pending',
      created_at: FIXED_NOW.toISOString(),
      updated_at: FIXED_NOW.toISOString(),
      revision: toSyncRevision(1951),
    },
  ];

  const applyProtectedAiRecalc = (): number => {
    const evalRules: RuleEvalRule[] = rules.map((r) => ({
      id: r.id,
      priority: r.priority,
      bank_filter: null,
      account_id_filter: null,
      account_type_filter: null,
      match_mode: r.match_mode,
      pattern: r.pattern,
      target_category: r.target_category,
      target_category_id: r.target_category_id,
      target_subcategory_id: r.target_subcategory_id,
      mark_as_internal_transfer: false,
      is_active: r.is_active,
      deleted_at: null,
      created_at_ms: 0,
    }));

    const evalTxs: RuleEvalTransaction[] = txs.map((t) => ({
      id: t.id,
      account_id: t.account_id,
      bank: 'boursobank',
      account_type: 'courant',
      raw_label: t.raw_label,
      clean_label: t.clean_label,
      category: t.category,
      matched_rule_id: t.matched_rule_id,
      is_manual_category: t.is_manual_category,
      is_internal_transfer: t.is_internal_transfer,
      is_manual_transfer_override: t.is_manual_transfer_override || t.is_internal_transfer,
      transfer_group_id: t.transfer_group_id,
      deleted_at: null,
    }));

    const plan = computeRuleReapplication(evalRules, evalTxs);
    for (const change of plan.changes) {
      const target = txs.find((t) => t.id === change.transactionId);
      if (target !== undefined) {
        target.category = change.nextCategory;
        target.category_id =
          change.nextMatchedRuleId !== null
            ? (change.nextTargetCategoryId ?? null)
            : UNCATEGORIZED_CATEGORY_ID;
        target.subcategory_id =
          change.nextMatchedRuleId !== null ? (change.nextTargetSubcategoryId ?? null) : null;
        target.category_source = change.nextMatchedRuleId !== null ? 'rule' : 'uncategorized';
        target.matched_rule_id = change.nextMatchedRuleId;
        target.revision = nextRev();
      }
    }
    return plan.changes.length;
  };

  const aiBackfillDispatcher: AiBackfillDispatcher = {
    async triggerBackfill() {
      if (!workerReachable) {
        return {
          ok: false,
          reason: 'worker_unavailable',
          message: 'sync-worker IA indisponible.',
        };
      }
      if (activeRun !== null && activeRun.status === 'running') {
        return {
          ok: false,
          reason: 'already_running',
          activeRunId: activeRun.id,
        };
      }
      activeRun = {
        id: RUN_1_ID,
        status: 'running',
        trigger_source: 'manual_backfill',
        model_used: 'gemini-4-hydrogen',
        total_candidates: 2,
        processed_count: 0,
        auto_applied_count: 0,
        queued_review_count: 0,
        failed_count: 0,
        last_error: null,
        started_at: FIXED_NOW.toISOString(),
        finished_at: null,
        updated_at: FIXED_NOW.toISOString(),
      };
      return {
        ok: true,
        run_id: activeRun.id,
        status: 'running',
        accepted_at: FIXED_NOW.toISOString(),
      };
    },
    async cancelBackfill() {
      if (activeRun === null || activeRun.status !== 'running') {
        return {
          ok: false,
          reason: 'not_running',
          message: 'Aucun traitement de catégorisation IA actif à annuler.',
        };
      }
      activeRun = {
        ...activeRun,
        status: 'cancelled',
        finished_at: FIXED_NOW.toISOString(),
        updated_at: FIXED_NOW.toISOString(),
      };
      return {
        ok: true,
        run_id: activeRun.id,
        status: 'cancelled',
        cancelled_at: FIXED_NOW.toISOString(),
      };
    },
  };

  const aiCategorizationRepository: AiCategorizationRepository = {
    async getStatus(options) {
      const pendingCount = txs.filter((t) => t.ai_review_status === 'pending_review').length;
      const eligibleCount = txs.filter(
        (t) =>
          !t.is_manual_category &&
          !t.is_internal_transfer &&
          t.matched_rule_id === null &&
          t.category_source === 'uncategorized' &&
          t.ai_review_status === 'none',
      ).length;
      const run =
        options?.run_id !== undefined
          ? activeRun?.id === options.run_id
            ? activeRun
            : null
          : activeRun;
      return {
        run,
        pending_review_count: pendingCount,
        uncategorized_eligible_count: eligibleCount,
      };
    },

    async getReviewQueue(options) {
      const pending = txs
        .filter((t) => t.ai_review_status === 'pending_review')
        .slice()
        .sort((a, b) => b.booking_date.localeCompare(a.booking_date));

      const items: AiReviewItem[] = pending
        .slice(options.offset, options.offset + options.limit)
        .map((t) => {
          const catId = t.ai_suggested_category_id ?? UNCATEGORIZED_CATEGORY_ID;
          const subId = t.ai_suggested_subcategory_id;
          return {
            transaction_id: t.id,
            date: t.booking_date,
            clean_label: t.clean_label,
            amount_cents: t.amount_cents,
            currency: 'EUR',
            amount_eur_cents: t.amount_eur_cents,
            account_id: t.account_id,
            suggested_category_id: catId,
            suggested_subcategory_id: subId,
            suggested_category_name: catById.get(catId)?.name ?? 'Non catégorisé',
            suggested_subcategory_name: subId !== null ? (catById.get(subId)?.name ?? null) : null,
            ai_confidence_bp: t.ai_confidence_bp ?? 0,
            ai_reason: t.ai_reason,
            ai_model: t.ai_model,
            ai_review_status: t.ai_review_status,
            updated_at: t.updated_at,
          };
        });

      return {
        items,
        total_pending: pending.length,
        limit: options.limit,
        offset: options.offset,
      };
    },

    async resolveReviewDecisions(decisions) {
      let resolvedCount = 0;
      let createdRulesCount = 0;
      let latestRev = toSyncRevision(rev);

      for (const decision of decisions) {
        const tx = txs.find((t) => t.id === decision.transaction_id);
        if (tx === undefined) {
          return {
            ok: false,
            reason: 'not_found',
            message: `Transaction introuvable : ${decision.transaction_id}`,
          };
        }

        if (decision.action === 'reject') {
          tx.category = 'Non catégorisé';
          tx.category_id = UNCATEGORIZED_CATEGORY_ID;
          tx.subcategory_id = null;
          tx.category_source = 'uncategorized';
          tx.ai_review_status = 'rejected';
          latestRev = nextRev();
          tx.revision = latestRev;
          resolvedCount += 1;
          continue;
        }

        let targetCatId: CategoryId | null = null;
        let targetSubId: CategoryId | null = null;

        if (decision.action === 'accept') {
          if (tx.ai_suggested_category_id === null) {
            return {
              ok: false,
              reason: 'invalid_decision',
              message: 'Aucune suggestion IA à accepter.',
            };
          }
          targetCatId = tx.ai_suggested_category_id;
          targetSubId = tx.ai_suggested_subcategory_id;
        } else {
          if (decision.category_id === undefined) {
            return {
              ok: false,
              reason: 'invalid_decision',
              message: 'category_id requis pour override.',
            };
          }
          const cat = catById.get(parseCategoryId(decision.category_id));
          if (cat === undefined) {
            return {
              ok: false,
              reason: 'invalid_decision',
              message: 'Catégorie inconnue.',
            };
          }
          targetCatId = cat.id;
          targetSubId = decision.subcategory_id ? parseCategoryId(decision.subcategory_id) : null;
        }

        const label =
          (targetSubId !== null ? catById.get(targetSubId)?.name : undefined) ??
          (targetCatId !== null ? catById.get(targetCatId)?.name : undefined) ??
          'Non catégorisé';

        tx.category = label;
        tx.category_id = targetCatId;
        tx.subcategory_id = targetSubId;
        tx.category_source = decision.action === 'accept' ? 'ai_validated' : 'manual';
        tx.is_manual_category = true;
        tx.matched_rule_id = null;
        tx.ai_review_status = decision.action === 'accept' ? 'accepted' : 'rejected';
        latestRev = nextRev();
        tx.revision = latestRev;
        resolvedCount += 1;

        if (decision.create_rule === true && targetCatId !== null) {
          const pattern =
            decision.rule_pattern?.trim() ||
            extractMerchantPatternForRule(tx.clean_label) ||
            tx.clean_label;
          const ruleId = parseRuleId(randomUUID());
          const ruleRev = nextRev();
          latestRev = ruleRev;
          rules.push({
            id: ruleId,
            name: pattern.slice(0, 100),
            priority: 100,
            match_mode: 'contains',
            pattern,
            target_category: label,
            target_category_id: targetCatId,
            target_subcategory_id: targetSubId,
            is_active: true,
            revision: ruleRev,
            updated_at: FIXED_NOW.toISOString(),
          });
          createdRulesCount += 1;
        }
      }

      const retroactiveUpdated = createdRulesCount > 0 ? applyProtectedAiRecalc() : 0;
      latestRev = toSyncRevision(rev);

      return {
        ok: true,
        data: {
          resolved_count: resolvedCount,
          created_rules_count: createdRulesCount,
          retroactive_updated_count: retroactiveUpdated,
          current_revision: latestRev,
          pending_review_count: txs.filter((t) => t.ai_review_status === 'pending_review').length,
        },
      };
    },

    async listRuleSuggestions(options) {
      const status = options?.status ?? 'pending';
      return {
        suggestions: suggestions.filter((s) => s.status === status),
      };
    },

    async acceptRuleSuggestion(id) {
      const idx = suggestions.findIndex((s) => s.id === id);
      const sug = idx >= 0 ? suggestions[idx] : undefined;
      if (sug === undefined) {
        return { ok: false, reason: 'not_found', message: 'Suggestion introuvable.' };
      }
      if (sug.status !== 'pending') {
        return { ok: false, reason: 'already_resolved', message: 'Suggestion déjà traitée.' };
      }

      const ruleId = parseRuleId(randomUUID());
      const ruleRev = nextRev();
      const targetLabel = sug.target_subcategory_name ?? sug.target_category_name;
      const newRule: StoredAiRule = {
        id: ruleId,
        name: sug.merchant_pattern,
        priority: 100,
        match_mode: sug.match_mode,
        pattern: sug.merchant_pattern,
        target_category: targetLabel,
        target_category_id: parseCategoryId(sug.target_category_id),
        target_subcategory_id:
          sug.target_subcategory_id !== null ? parseCategoryId(sug.target_subcategory_id) : null,
        is_active: true,
        revision: ruleRev,
        updated_at: FIXED_NOW.toISOString(),
      };
      rules.push(newRule);

      const retroactiveUpdated = applyProtectedAiRecalc();
      const sugRev = nextRev();
      const updatedSug: AiRuleSuggestion = {
        ...sug,
        status: 'accepted',
        revision: sugRev,
        updated_at: FIXED_NOW.toISOString(),
      };
      suggestions[idx] = updatedSug;

      const createdRuleView: RuleView = {
        id: newRule.id,
        name: newRule.name,
        priority: newRule.priority,
        bank_filter: null,
        account_id_filter: null,
        account_type_filter: null,
        match_mode: newRule.match_mode,
        pattern: newRule.pattern,
        target_category: newRule.target_category,
        target_category_id: newRule.target_category_id,
        target_subcategory_id: newRule.target_subcategory_id,
        mark_as_internal_transfer: false,
        is_active: true,
        matched_transactions_count: txs.filter((t) => t.matched_rule_id === newRule.id).length,
        revision: newRule.revision,
        updated_at: newRule.updated_at,
      };

      return {
        ok: true,
        data: {
          suggestion: updatedSug,
          created_rule: createdRuleView,
          retroactive_updated_count: retroactiveUpdated,
          current_revision: toSyncRevision(rev),
        },
      };
    },

    async dismissRuleSuggestion(id) {
      const idx = suggestions.findIndex((s) => s.id === id);
      const sug = idx >= 0 ? suggestions[idx] : undefined;
      if (sug === undefined) {
        return { ok: false, reason: 'not_found', message: 'Suggestion introuvable.' };
      }
      const sugRev = nextRev();
      const updated: AiRuleSuggestion = {
        ...sug,
        status: 'dismissed',
        revision: sugRev,
        updated_at: FIXED_NOW.toISOString(),
      };
      suggestions[idx] = updated;
      return {
        ok: true,
        data: {
          suggestion: updated,
          current_revision: sugRev,
        },
      };
    },
  };

  const deps: AppDependencies = {
    sessionSecret: TEST_SESSION_SECRET,
    now: () => FIXED_NOW,
    healthRepository: { async ping() { return true; } },
    accountsRepository: {
      async listAccounts() {
        return { accounts: [], latest_revision: toSyncRevision(rev) };
      },
    },
    aiCategorizationRepository,
    aiBackfillDispatcher,
    syncDeltaRepository: {
      async getDelta(query): Promise<DeltaSyncResponse> {
        return {
          since_revision: query.since,
          batch_end_revision: toSyncRevision(rev),
          latest_revision: toSyncRevision(rev),
          has_more: false,
          full_resync_required: false,
          server_time: FIXED_NOW.toISOString(),
          accounts: { upserted: [], deleted_ids: [] },
          transactions: {
            upserted: txs
              .filter((t) => t.revision > query.since)
              .map((t) => ({
                id: t.id,
                account_id: t.account_id,
                bank: 'boursobank',
                account_type: 'courant',
                external_ref_masked: '•••• 4821',
                booking_date: t.booking_date,
                value_date: t.booking_date,
                raw_label: t.raw_label,
                clean_label: t.clean_label,
                amount_cents: toCents(t.amount_cents),
                currency: 'EUR',
                fx_rate_micro: toFxRateMicro(1_000_000),
                amount_eur_cents: toCents(t.amount_eur_cents),
                category: t.category,
                category_id: t.category_id,
                subcategory_id: t.subcategory_id,
                category_source: t.category_source,
                ai_review_status: t.ai_review_status,
                ai_confidence_bp: t.ai_confidence_bp,
                ai_suggested_category_id: t.ai_suggested_category_id,
                ai_suggested_subcategory_id: t.ai_suggested_subcategory_id,
                ai_reason: t.ai_reason,
                ai_model: t.ai_model,
                is_manual_category: t.is_manual_category,
                matched_rule_id: t.matched_rule_id,
                is_internal_transfer: t.is_internal_transfer,
                is_manual_transfer_override: t.is_manual_transfer_override,
                transfer_group_id: t.transfer_group_id,
                source_drive_file_id: '88888888-8888-4888-8888-888888888888',
                revision: t.revision,
                updated_at: t.updated_at,
              })),
            deleted_ids: [],
          },
          transaction_notes: { upserted: [], deleted_transaction_ids: [] },
          categorization_rules: { upserted: [], deleted_ids: [] },
          ai_rule_suggestions: suggestions.filter((s) => s.revision > query.since),
          pending_ai_review_count: txs.filter((t) => t.ai_review_status === 'pending_review').length,
          drive_sync_status: {
            last_run: null,
            files: [
              {
                drive_file_id: parseDriveFileId('1Bourso_2026_11'),
                drive_folder_id: ALLOWED_DRIVE_FOLDERS.boursobank,
                bank: 'boursobank',
                file_name: 'Bourso_2026_11.pdf',
                status: 'committed',
                attempt_count: 1,
                error_code: null,
                error_message: null,
                revision: toSyncRevision(1900),
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
        return { ok: false, reason: 'upstream_error', message: 'Non utilisé dans ce test' };
      },
    },
  };

  return {
    app: createApp(deps),
    txs,
    rules,
    suggestions,
    setWorkerReachable: (val: boolean) => {
      workerReachable = val;
    },
  };
}

describe('ClairFlux API — Lot 2 Catégorisation IA, Boîte de révision & Suggestions (/api/ai/*)', () => {
  it('exige une authentification 401 UNAUTHORIZED sur les 8 endpoints /api/ai/*', async () => {
    const { app } = createAiTestHarness();
    const endpoints: ReadonlyArray<{ path: string; method?: string }> = [
      { path: '/api/ai/categorize/backfill', method: 'POST' },
      { path: '/api/ai/categorize/status' },
      { path: '/api/ai/categorize/cancel', method: 'POST' },
      { path: '/api/ai/review-queue' },
      { path: '/api/ai/review-queue/resolve', method: 'POST' },
      { path: '/api/ai/rule-suggestions' },
      { path: `/api/ai/rule-suggestions/${SUG_BIOCOOP_ID}/accept`, method: 'POST' },
      { path: `/api/ai/rule-suggestions/${SUG_BIOCOOP_ID}/dismiss`, method: 'POST' },
    ];

    for (const ep of endpoints) {
      const res = await app.request(ep.path, {
        ...(ep.method !== undefined ? { method: ep.method } : {}),
      });
      expect(res.status).toBe(401);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe('UNAUTHORIZED');
    }
  });

  it('gère backfill (202), verrou 409 AI_BACKFILL_ALREADY_RUNNING, status, cancel (200 / 409) et 502 worker indisponible', async () => {
    const { app, setWorkerReachable } = createAiTestHarness();
    const token = createToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Cancel avant tout run -> 409 AI_BACKFILL_NOT_RUNNING
    const cancelIdleRes = await app.request('/api/ai/categorize/cancel', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(cancelIdleRes.status).toBe(409);
    expect(ApiErrorEnvelopeSchema.parse(await cancelIdleRes.json()).error.code).toBe(
      'AI_BACKFILL_NOT_RUNNING',
    );

    // Worker indisponible -> 502 AI_WORKER_UNAVAILABLE
    setWorkerReachable(false);
    const unavailableRes = await app.request('/api/ai/categorize/backfill', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(unavailableRes.status).toBe(502);
    expect(ApiErrorEnvelopeSchema.parse(await unavailableRes.json()).error.code).toBe(
      'AI_WORKER_UNAVAILABLE',
    );
    setWorkerReachable(true);

    // Lancement backfill -> 202
    const startRes = await app.request('/api/ai/categorize/backfill', {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 200 }),
    });
    expect(startRes.status).toBe(202);
    const startJson = (await startRes.json()) as {
      run_id: string;
      status: string;
      accepted_at: string;
    };
    expect(startJson.run_id).toBe(RUN_1_ID);
    expect(startJson.status).toBe('running');

    // Deuxième lancement simultané -> 409 AI_BACKFILL_ALREADY_RUNNING
    const conflictRes = await app.request('/api/ai/categorize/backfill', {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(conflictRes.status).toBe(409);
    const conflictErr = ApiErrorEnvelopeSchema.parse(await conflictRes.json());
    expect(conflictErr.error.code).toBe('AI_BACKFILL_ALREADY_RUNNING');
    expect(conflictErr.error.details?.['active_run_id']).toBe(RUN_1_ID);

    // Status -> run + compteurs
    const statusRes = await app.request('/api/ai/categorize/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      run: AiCategorizationRun | null;
      pending_review_count: number;
      uncategorized_eligible_count: number;
    };
    expect(statusBody.run?.id).toBe(RUN_1_ID);
    expect(statusBody.pending_review_count).toBe(3);
    expect(statusBody.uncategorized_eligible_count).toBe(2);

    // Cancel -> 200
    const cancelRes = await app.request('/api/ai/categorize/cancel', {
      method: 'POST',
      headers,
      body: JSON.stringify({ run_id: RUN_1_ID }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as { run_id: string; status: string };
    expect(cancelBody.run_id).toBe(RUN_1_ID);
    expect(cancelBody.status).toBe('cancelled');
  });

  it('résout la boîte de révision IA par lot (accept, override, reject, create_rule) en protégeant manuel et virement interne', async () => {
    const { app, txs, rules } = createAiTestHarness();
    const token = createToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const queueRes = await app.request('/api/ai/review-queue?limit=2&offset=0', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(queueRes.status).toBe(200);
    const queueBody = (await queueRes.json()) as {
      items: AiReviewItem[];
      total_pending: number;
      limit: number;
      offset: number;
    };
    expect(queueBody.total_pending).toBe(3);
    expect(queueBody.items).toHaveLength(2);
    expect(queueBody.items[0]?.transaction_id).toBe(TX_PENDING_ACCEPT_ID);

    // Validation Zod rejetant override sans category_id (400)
    const badOverrideRes = await app.request('/api/ai/review-queue/resolve', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decisions: [{ transaction_id: TX_PENDING_OVERRIDE_ID, action: 'override' }],
      }),
    });
    expect(badOverrideRes.status).toBe(400);

    // Résolution par lot : accept + create_rule, override, reject
    const resolveRes = await app.request('/api/ai/review-queue/resolve', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decisions: [
          {
            transaction_id: TX_PENDING_ACCEPT_ID,
            action: 'accept',
            create_rule: true,
            rule_pattern: 'pharmacie centrale',
          },
          {
            transaction_id: TX_PENDING_OVERRIDE_ID,
            action: 'override',
            category_id: ROOT_LOISIRS_ID,
            subcategory_id: null,
          },
          {
            transaction_id: TX_PENDING_REJECT_ID,
            action: 'reject',
          },
        ],
      }),
    });
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as {
      resolved_count: number;
      created_rules_count: number;
      retroactive_updated_count: number;
      current_revision: SyncRevision;
      pending_review_count: number;
    };
    expect(resolveBody.resolved_count).toBe(3);
    expect(resolveBody.created_rules_count).toBe(1);
    expect(resolveBody.retroactive_updated_count).toBe(1); // TX_ELIGIBLE_PHARMACIE_ID mis à jour
    expect(resolveBody.pending_review_count).toBe(0);
    expect(rules).toHaveLength(1);

    const acceptedTx = txs.find((t) => t.id === TX_PENDING_ACCEPT_ID);
    expect(acceptedTx?.category_source).toBe('ai_validated');
    expect(acceptedTx?.is_manual_category).toBe(true);
    expect(acceptedTx?.ai_review_status).toBe('accepted');

    const overriddenTx = txs.find((t) => t.id === TX_PENDING_OVERRIDE_ID);
    expect(overriddenTx?.category_source).toBe('manual');
    expect(overriddenTx?.is_manual_category).toBe(true);
    expect(overriddenTx?.ai_review_status).toBe('rejected');
    expect(overriddenTx?.category_id).toBe(ROOT_LOISIRS_ID);

    const rejectedTx = txs.find((t) => t.id === TX_PENDING_REJECT_ID);
    expect(rejectedTx?.category_source).toBe('uncategorized');
    expect(rejectedTx?.ai_review_status).toBe('rejected');
    expect(rejectedTx?.category).toBe('Non catégorisé');

    const retroPharmacieTx = txs.find((t) => t.id === TX_ELIGIBLE_PHARMACIE_ID);
    expect(retroPharmacieTx?.category_source).toBe('rule');
    expect(retroPharmacieTx?.subcategory_id).toBe(SUB_PHARMACIE_ID);
  });

  it('accepte et ignore ai_rule_suggestions sans jamais écraser manuel ni transfert interne, et expose Delta Sync', async () => {
    const { app, txs } = createAiTestHarness();
    const token = createToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const listRes = await app.request('/api/ai/rule-suggestions?status=pending', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { suggestions: AiRuleSuggestion[] };
    expect(listBody.suggestions).toHaveLength(2);

    // Accept BIOCOOP -> crée règle, classe TX_ELIGIBLE_BIOCOOP_ID, mais protège TX_MANUAL_PROTECTED_ID & TX_INTERNAL_TRANSFER_ID
    const acceptRes = await app.request(`/api/ai/rule-suggestions/${SUG_BIOCOOP_ID}/accept`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(acceptRes.status).toBe(200);
    const acceptBody = (await acceptRes.json()) as {
      suggestion: AiRuleSuggestion;
      created_rule: RuleView;
      retroactive_updated_count: number;
      current_revision: SyncRevision;
    };
    expect(acceptBody.suggestion.status).toBe('accepted');
    expect(acceptBody.created_rule.pattern).toBe('biocoop');
    expect(acceptBody.retroactive_updated_count).toBe(1);

    expect(txs.find((t) => t.id === TX_ELIGIBLE_BIOCOOP_ID)?.category_source).toBe('rule');
    expect(txs.find((t) => t.id === TX_MANUAL_PROTECTED_ID)?.category).toBe('Cadeaux & Dons');
    expect(txs.find((t) => t.id === TX_INTERNAL_TRANSFER_ID)?.category).toBe('Transfert interne');

    // Dismiss SNCF
    const dismissRes = await app.request(`/api/ai/rule-suggestions/${SUG_DISMISS_ID}/dismiss`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(dismissRes.status).toBe(200);
    expect(((await dismissRes.json()) as { suggestion: AiRuleSuggestion }).suggestion.status).toBe(
      'dismissed',
    );

    // Suggestion inexistante -> 404 AI_SUGGESTION_NOT_FOUND
    const missingRes = await app.request(
      '/api/ai/rule-suggestions/99999999-9999-4999-8999-999999999999/accept',
      { method: 'POST', headers, body: '{}' },
    );
    expect(missingRes.status).toBe(404);
    expect(ApiErrorEnvelopeSchema.parse(await missingRes.json()).error.code).toBe(
      'AI_SUGGESTION_NOT_FOUND',
    );

    // Delta Sync expose ai_rule_suggestions, pending_ai_review_count et champs AI sur transactions
    const deltaRes = await app.request('/api/sync/delta?since=1900&limit=500', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deltaRes.status).toBe(200);
    const deltaBody = DeltaSyncResponseSchema.parse(await deltaRes.json());
    expect(deltaBody.pending_ai_review_count).toBe(3);
    expect(deltaBody.ai_rule_suggestions?.length).toBeGreaterThanOrEqual(2);
    const pendingTxInDelta = deltaBody.transactions.upserted.find(
      (t) => t.id === TX_PENDING_ACCEPT_ID,
    );
    expect(pendingTxInDelta?.ai_confidence_bp).toBe(7900);
    expect(pendingTxInDelta?.ai_suggested_category_id).toBe(ROOT_SANTE_VIE_ID);
    expect(pendingTxInDelta?.ai_reason).toBe('Libellé de pharmacie');
    expect(pendingTxInDelta?.ai_model).toBe('gemini-4-hydrogen');
  });

  it('createHttpAiBackfillDispatcher réconcilie un run orphelin, transmet X-Internal-Worker-Token et gère 409 / cancel fallback', async () => {
    const staleRunId = '77777777-7777-4777-8777-777777777771';
    const newRunId = '77777777-7777-4777-8777-777777777772';
    const markedFailed: string[] = [];
    const markedCancelled: string[] = [];
    const seenTokens: Array<string | null> = [];

    const dispatcher = createHttpAiBackfillDispatcher({
      syncWorkerUrl: 'http://sync-worker:4001',
      internalWorkerToken: 'internal-worker-token-32-chars-minimum',
      now: () => FIXED_NOW,
      store: {
        async findActiveRunningRuns() {
          return [{ id: staleRunId, startedAt: new Date('2026-11-26T17:00:00.000Z') }];
        },
        async markRunFailed(runId) {
          markedFailed.push(runId);
        },
        async markRunCancelled(runId) {
          markedCancelled.push(runId);
        },
      },
      fetchFn: async (input, init) => {
        const tokenHeader =
          init?.headers instanceof Headers
            ? init.headers.get('X-Internal-Worker-Token')
            : (init?.headers as Record<string, string> | undefined)?.['X-Internal-Worker-Token'] ?? null;
        seenTokens.push(tokenHeader);
        const url = String(input);
        if (url.endsWith('/internal/ai/categorize/active')) {
          return new Response(JSON.stringify({ active_run_id: null }), { status: 200 });
        }
        if (url.endsWith('/internal/ai/categorize/backfill')) {
          return new Response(
            JSON.stringify({
              run_id: newRunId,
              status: 'running',
              accepted_at: FIXED_NOW.toISOString(),
            }),
            { status: 202 },
          );
        }
        if (url.endsWith('/internal/ai/categorize/cancel')) {
          throw new Error('Worker offline');
        }
        return new Response(null, { status: 404 });
      },
    });

    const triggerOutcome = await dispatcher.triggerBackfill({ limit: 100 });
    expect(triggerOutcome).toEqual({
      ok: true,
      run_id: newRunId,
      status: 'running',
      accepted_at: FIXED_NOW.toISOString(),
    });
    expect(markedFailed).toEqual([staleRunId]);
    expect(seenTokens.every((t) => t === 'internal-worker-token-32-chars-minimum')).toBe(true);

    const cancelOutcome = await dispatcher.cancelBackfill({ run_id: staleRunId });
    expect(cancelOutcome).toEqual({
      ok: true,
      run_id: staleRunId,
      status: 'cancelled',
      cancelled_at: FIXED_NOW.toISOString(),
    });
    expect(markedCancelled).toEqual([staleRunId]);
  });
});
