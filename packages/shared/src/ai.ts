import { z } from 'zod';
import { AiReviewStatusSchema } from './categories.js';

// ============================================================================
// Normative Constants (Lot 2 — Gemini Hybrid Categorization)
// ============================================================================

export const AI_AUTO_APPLY_CONFIDENCE_BP = 8500;
export const AI_BATCH_SIZE = 50;
export const AI_RULE_SUGGESTION_MIN_SAMPLES = 3;
export const AI_MAX_REASON_LENGTH = 240;
export const AI_MAX_LABEL_LENGTH = 160;

// ============================================================================
// Normative Enums & Zod Schemas
// ============================================================================

const AiSafeIntSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

const AiIsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected ISO calendar date YYYY-MM-DD');

const AiIsoDateTimeSchema = z.string().datetime({ offset: true });
const AiCurrencySchema = z.enum(['EUR', 'USD']);
const AiRuleMatchModeSchema = z.enum(['contains', 'starts_with', 'exact', 'regex']);

export const AiBackfillRunStatusSchema = z.enum([
  'running',
  'completed',
  'partial_error',
  'failed',
  'cancelled',
]);
export type AiBackfillRunStatus = z.infer<typeof AiBackfillRunStatusSchema>;

export const AiRuleSuggestionStatusSchema = z.enum([
  'pending',
  'accepted',
  'dismissed',
]);
export type AiRuleSuggestionStatus = z.infer<typeof AiRuleSuggestionStatusSchema>;

export const AiTriggerSourceSchema = z.enum(['manual_backfill', 'post_pdf_sync']);
export type AiTriggerSource = z.infer<typeof AiTriggerSourceSchema>;

export const AiCategorizationRunSchema = z.object({
  id: z.string().uuid(),
  status: AiBackfillRunStatusSchema,
  trigger_source: AiTriggerSourceSchema,
  model_used: z.string().trim().min(1).max(80).nullable(),
  total_candidates: z.number().int().min(0),
  processed_count: z.number().int().min(0),
  auto_applied_count: z.number().int().min(0),
  queued_review_count: z.number().int().min(0),
  failed_count: z.number().int().min(0),
  last_error: z.string().max(1000).nullable(),
  started_at: AiIsoDateTimeSchema,
  finished_at: AiIsoDateTimeSchema.nullable(),
  updated_at: AiIsoDateTimeSchema,
});
export type AiCategorizationRun = z.infer<typeof AiCategorizationRunSchema>;

export const AiReviewItemSchema = z.object({
  transaction_id: z.string().uuid(),
  date: AiIsoDateSchema,
  clean_label: z.string().trim().min(1).max(255),
  amount_cents: AiSafeIntSchema,
  currency: AiCurrencySchema,
  amount_eur_cents: AiSafeIntSchema,
  account_id: z.string().uuid(),
  suggested_category_id: z.string().uuid(),
  suggested_subcategory_id: z.string().uuid().nullable(),
  suggested_category_name: z.string().trim().min(1).max(64),
  suggested_subcategory_name: z.string().trim().min(1).max(64).nullable(),
  ai_confidence_bp: z.number().int().min(0).max(10000),
  ai_reason: z.string().max(AI_MAX_REASON_LENGTH).nullable(),
  ai_model: z.string().max(80).nullable(),
  ai_review_status: AiReviewStatusSchema,
  updated_at: AiIsoDateTimeSchema,
});
export type AiReviewItem = z.infer<typeof AiReviewItemSchema>;

export const AiRuleSuggestionSchema = z.object({
  id: z.string().uuid(),
  merchant_pattern: z.string().trim().min(1).max(200),
  match_mode: AiRuleMatchModeSchema,
  target_category_id: z.string().uuid(),
  target_subcategory_id: z.string().uuid().nullable(),
  target_category_name: z.string().trim().min(1).max(64),
  target_subcategory_name: z.string().trim().min(1).max(64).nullable(),
  sample_count: z.number().int().min(1),
  status: AiRuleSuggestionStatusSchema,
  created_at: AiIsoDateTimeSchema,
  updated_at: AiIsoDateTimeSchema,
  revision: AiSafeIntSchema.nonnegative(),
});
export type AiRuleSuggestion = z.infer<typeof AiRuleSuggestionSchema>;

export const AiReviewActionSchema = z.enum(['accept', 'override', 'reject']);
export type AiReviewAction = z.infer<typeof AiReviewActionSchema>;

export const ResolveAiReviewDecisionSchema = z
  .object({
    transaction_id: z.string().uuid(),
    action: AiReviewActionSchema,
    category_id: z.string().uuid().optional(),
    subcategory_id: z.string().uuid().nullable().optional(),
    create_rule: z.boolean().optional(),
    rule_pattern: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((decision, ctx) => {
    if (decision.action === 'override' && decision.category_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category_id'],
        message: "category_id est requis lorsque action vaut 'override'.",
      });
    }
    if (
      decision.action === 'override' &&
      decision.subcategory_id !== undefined &&
      decision.subcategory_id !== null &&
      decision.category_id === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category_id'],
        message: 'category_id est requis lorsqu’une sous-catégorie est précisée.',
      });
    }
  });
export type ResolveAiReviewDecision = z.infer<typeof ResolveAiReviewDecisionSchema>;

export const ResolveAiReviewBatchSchema = z.object({
  decisions: z.array(ResolveAiReviewDecisionSchema).min(1).max(100),
});
export type ResolveAiReviewBatch = z.infer<typeof ResolveAiReviewBatchSchema>;

export const AiErrorCodeSchema = z.enum([
  'AI_BACKFILL_ALREADY_RUNNING',
  'AI_BACKFILL_NOT_RUNNING',
  'AI_SUGGESTION_NOT_FOUND',
  'AI_WORKER_UNAVAILABLE',
  'AI_INVALID_DECISION',
]);
export type AiErrorCode = z.infer<typeof AiErrorCodeSchema>;

// ============================================================================
// Pure Anti-Prompt-Injection, Confidence & Pattern Helpers
// ============================================================================

const CONTROL_CHARS_TO_SPACE_PATTERN = /[\t\r\n]+/gu;
const OTHER_CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu;
const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)(?:\s+instructions?)?/giu,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)(?:\s+instructions?)?/giu,
  /\b(?:system|assistant|developer|user)\s*:/giu,
  /```+/gu,
  /<\s*\/[^>]*>?/gu,
  /<\s*\//gu,
];

/**
 * Strips control characters, collapses whitespace, neutralizes prompt-injection markers
 * (`ignore previous`, `system:`, `assistant:`, `</`, triple backticks), and bounds length
 * to `AI_MAX_LABEL_LENGTH` before passing bank labels as passive JSON data to Gemini.
 */
export function sanitizeBankLabelForAi(rawLabel: string): string {
  let cleaned = rawLabel
    .replace(CONTROL_CHARS_TO_SPACE_PATTERN, ' ')
    .replace(OTHER_CONTROL_CHARS_PATTERN, '');

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }

  cleaned = cleaned.replace(/\s+/gu, ' ').trim();
  if (cleaned.length <= AI_MAX_LABEL_LENGTH) {
    return cleaned;
  }

  return cleaned.slice(0, AI_MAX_LABEL_LENGTH).trim();
}

/**
 * Returns true if and only if `confidenceBp` is an integer >= `AI_AUTO_APPLY_CONFIDENCE_BP` (8500).
 */
export function shouldAutoApplyAiSuggestion(confidenceBp: number): boolean {
  return Number.isInteger(confidenceBp) && confidenceBp >= AI_AUTO_APPLY_CONFIDENCE_BP;
}

const BANKING_PREFIX_PATTERN =
  /^(?:carte(?:\s+bancaire)?|cb|prlv(?:\s+sepa)?|prelevement(?:\s+sepa)?|sepa|vir(?:ement)?(?:\s+sepa)?|paiement(?:\s+cb)?|achat(?:\s+cb)?|retrait(?:\s+dab)?|dab|avoir)\b/iu;
const ISO_DATE_TOKEN_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/gu;
const SLASH_DATE_TOKEN_PATTERN = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gu;
const STANDALONE_DIGITS_OR_REF_PATTERN = /(?:^|\s)[*#]?\d+(?:[*#/-]\d+)*(?=\s|$)/gu;
const EDGE_PUNCTUATION_PATTERN = /^[*#/:;,\-_.\s]+|[*#/:;,\-_.\s]+$/gu;
const PURELY_NUMERIC_OR_SYMBOL_PATTERN = /^[\d\s*#/:;,\-_.]+$/u;

/**
 * Normalizes a cleaned bank label into a deterministic merchant rule pattern by stripping
 * banking prefixes (`CARTE`, `CB`, `PRLV`, `SEPA`, `VIR`), calendar dates, and isolated
 * reference digits. Returns `null` if the resulting pattern is < 3 chars or purely numeric.
 */
export function extractMerchantPatternForRule(cleanLabel: string): string | null {
  let working = cleanLabel
    .replace(CONTROL_CHARS_TO_SPACE_PATTERN, ' ')
    .replace(OTHER_CONTROL_CHARS_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim();

  if (working.length === 0) {
    return null;
  }

  // Strip repeated leading banking tokens (e.g. "PRLV SEPA ..." or "CARTE 12/04 ...").
  for (let i = 0; i < 4; i += 1) {
    const prev = working;
    working = working
      .replace(BANKING_PREFIX_PATTERN, ' ')
      .replace(ISO_DATE_TOKEN_PATTERN, ' ')
      .replace(SLASH_DATE_TOKEN_PATTERN, ' ')
      .replace(STANDALONE_DIGITS_OR_REF_PATTERN, ' ')
      .replace(EDGE_PUNCTUATION_PATTERN, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (working === prev) {
      break;
    }
  }

  working = working
    .replace(ISO_DATE_TOKEN_PATTERN, ' ')
    .replace(SLASH_DATE_TOKEN_PATTERN, ' ')
    .replace(STANDALONE_DIGITS_OR_REF_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .replace(EDGE_PUNCTUATION_PATTERN, '')
    .toLowerCase()
    .trim();

  if (working.length < 3 || PURELY_NUMERIC_OR_SYMBOL_PATTERN.test(working)) {
    return null;
  }

  return working.slice(0, 200).trim();
}
