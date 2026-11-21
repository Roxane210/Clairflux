import { createHash } from 'node:crypto';
import {
  AccountIdSchema,
  BankSchema,
  CentsSchema,
  CurrencySchema,
  IsoDateSchema,
  type Bank,
  type Currency,
} from '@clairflux/shared';
import { z } from 'zod';

const MS_PER_DAY = 86_400_000;
const SAME_CURRENCY_TRANSFER_MAX_DAYS = 3;
const REVOLUT_FX_TRANSFER_MAX_DAYS = 1;
const REVOLUT_FX_MIN_TOLERANCE_CENTS = 200;
const REVOLUT_FX_TOLERANCE_RATIO = 0.03;

/**
 * Lexical clues for Revolut EUR <-> USD internal currency exchanges.
 * Word boundaries avoid false positives such as "coiffeur" matching "eur".
 */
const FX_EXCHANGE_HINT_PATTERN = /\b(?:exchanged\s+to|conversion|fx|change|eur|usd)\b/u;

export const CalendarIsoDateSchema = IsoDateSchema.refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');

export const DedupHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, 'Expected 64-char lowercase SHA-256 hex digest')
  .brand<'DedupHash'>();
export type DedupHash = z.infer<typeof DedupHashSchema>;

export const DedupHashInputSchema = z.object({
  accountId: AccountIdSchema,
  currency: CurrencySchema,
  bookingDate: CalendarIsoDateSchema,
  amountCents: CentsSchema.refine((v) => v !== 0, 'amountCents must be non-zero'),
  rawLabel: z.string().min(1),
  occurrenceIndex: z.number().int().min(1),
});

export type DedupHashInput = z.input<typeof DedupHashInputSchema>;

export interface StatementTransactionSeed {
  readonly accountId: string;
  readonly currency: Currency;
  readonly bookingDate: string;
  readonly amountCents: number;
  readonly rawLabel: string;
}

export interface StatementTransactionWithDedup<T extends StatementTransactionSeed> {
  readonly item: T;
  readonly normalizedLabel: string;
  readonly statementOccurrenceIndex: number;
  readonly dedupHash: DedupHash;
}

export interface TransferCandidate {
  readonly id: string;
  readonly accountId: string;
  readonly bank: Bank;
  readonly currency: Currency;
  readonly bookingDate: string;
  readonly amountCents: number;
  readonly amountEurCents: number;
  readonly rawLabel: string;
  readonly cleanLabel?: string | null | undefined;
  readonly transferGroupId: string | null;
  readonly isManualTransferOverride: boolean;
  readonly deletedAt: Date | null;
}

export type TransferRejectionReason =
  | 'NOT_ELIGIBLE'
  | 'SAME_ACCOUNT'
  | 'SAME_SIGN_OR_ZERO'
  | 'DATE_WINDOW_EXCEEDED'
  | 'NOT_REVOLUT_BOTH'
  | 'MISSING_FX_LEXICAL_HINT'
  | 'FX_SPREAD_TOLERANCE_EXCEEDED';

export type TransferPairMatchResult =
  | {
      readonly matched: true;
      readonly kind: 'same_currency' | 'revolut_fx_exchange';
      readonly dateDeltaDays: number;
      readonly eurDeltaCents: number;
    }
  | {
      readonly matched: false;
      readonly reason: TransferRejectionReason;
    };

export interface MatchedTransferPair {
  readonly debitTxId: string;
  readonly creditTxId: string;
  readonly kind: 'same_currency' | 'revolut_fx_exchange';
  readonly dateDeltaDays: number;
  readonly eurDeltaCents: number;
}

export interface RuleRecalcCandidate {
  readonly deletedAt: Date | null;
  readonly isManualCategory: boolean;
  readonly transferGroupId: string | null;
  readonly isManualTransferOverride: boolean;
}

/**
 * Normalizes a bank statement label deterministically for deduplication:
 * lowercase -> NFKD decomposition -> strip diacritics -> collapse whitespace -> trim.
 */
export function normalizeLabel(rawLabel: string): string {
  return rawLabel
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Computes the deterministic 64-character SHA-256 `dedup_hash` protecting against
 * multi-PDF statement overlaps while preserving identical intra-day purchases via `occurrenceIndex`.
 */
export function computeDedupHash(input: DedupHashInput): DedupHash {
  const parsed = DedupHashInputSchema.parse(input);
  const normalizedLabel = normalizeLabel(parsed.rawLabel);
  if (normalizedLabel.length === 0) {
    throw new Error('rawLabel must not be blank after normalization');
  }

  const canonical = `${parsed.accountId}|${parsed.currency}|${parsed.bookingDate}|${parsed.amountCents}|${normalizedLabel}|${parsed.occurrenceIndex}`;
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return DedupHashSchema.parse(digest);
}

/**
 * Assigns deterministic 1-based `statementOccurrenceIndex` values per
 * `(accountId, currency, bookingDate, amountCents, normalizedLabel)` and computes `dedupHash`.
 */
export function assignStatementDedupHashes<T extends StatementTransactionSeed>(
  entries: readonly T[],
): ReadonlyArray<StatementTransactionWithDedup<T>> {
  const occurrenceCounters = new Map<string, number>();

  return entries.map((entry) => {
    const normalizedLabel = normalizeLabel(entry.rawLabel);
    if (normalizedLabel.length === 0) {
      throw new Error('Statement transaction rawLabel must not be blank after normalization');
    }

    const bucketKey = `${entry.accountId}|${entry.currency}|${entry.bookingDate}|${entry.amountCents}|${normalizedLabel}`;
    const nextIndex = (occurrenceCounters.get(bucketKey) ?? 0) + 1;
    occurrenceCounters.set(bucketKey, nextIndex);

    const dedupHash = computeDedupHash({
      accountId: entry.accountId,
      currency: entry.currency,
      bookingDate: entry.bookingDate,
      amountCents: entry.amountCents,
      rawLabel: entry.rawLabel,
      occurrenceIndex: nextIndex,
    });

    return {
      item: entry,
      normalizedLabel,
      statementOccurrenceIndex: nextIndex,
      dedupHash,
    };
  });
}

function parseIsoUtcDayMs(isoDate: string): number {
  const validated = CalendarIsoDateSchema.parse(isoDate);
  return Date.parse(`${validated}T00:00:00.000Z`);
}

function calendarDaysApart(dateA: string, dateB: string): number {
  const msA = parseIsoUtcDayMs(dateA);
  const msB = parseIsoUtcDayMs(dateB);
  return Math.round(Math.abs(msA - msB) / MS_PER_DAY);
}

function isTransferCandidateEligible(tx: TransferCandidate): boolean {
  return (
    tx.deletedAt === null &&
    tx.transferGroupId === null &&
    tx.isManualTransferOverride === false
  );
}

function hasFxLexicalHint(tx: TransferCandidate): boolean {
  const normalizedRaw = normalizeLabel(tx.rawLabel);
  if (FX_EXCHANGE_HINT_PATTERN.test(normalizedRaw)) {
    return true;
  }
  if (tx.cleanLabel !== undefined && tx.cleanLabel !== null) {
    const normalizedClean = normalizeLabel(tx.cleanLabel);
    return FX_EXCHANGE_HINT_PATTERN.test(normalizedClean);
  }
  return false;
}

/**
 * Evaluates whether two transactions form a 1-to-1 internal transfer pair:
 * - Case A (same currency, distinct accounts, exact opposite `amountCents`, `<= 3` days)
 * - Case B (Revolut EUR <-> USD, opposite signs, `<= 1` day, FX lexical clue, EUR spread within `max(200, 3%)`)
 */
export function detectInternalTransferPair(
  a: TransferCandidate,
  b: TransferCandidate,
): TransferPairMatchResult {
  BankSchema.parse(a.bank);
  BankSchema.parse(b.bank);
  CurrencySchema.parse(a.currency);
  CurrencySchema.parse(b.currency);

  if (!isTransferCandidateEligible(a) || !isTransferCandidateEligible(b)) {
    return { matched: false, reason: 'NOT_ELIGIBLE' };
  }

  if (a.accountId === b.accountId) {
    return { matched: false, reason: 'SAME_ACCOUNT' };
  }

  const oppositeSigns =
    (a.amountCents < 0 && b.amountCents > 0) || (a.amountCents > 0 && b.amountCents < 0);
  if (!oppositeSigns) {
    return { matched: false, reason: 'SAME_SIGN_OR_ZERO' };
  }

  const dateDeltaDays = calendarDaysApart(a.bookingDate, b.bookingDate);

  if (a.currency === b.currency) {
    if (a.amountCents !== -b.amountCents) {
      return { matched: false, reason: 'FX_SPREAD_TOLERANCE_EXCEEDED' };
    }
    if (dateDeltaDays > SAME_CURRENCY_TRANSFER_MAX_DAYS) {
      return { matched: false, reason: 'DATE_WINDOW_EXCEEDED' };
    }
    return {
      matched: true,
      kind: 'same_currency',
      dateDeltaDays,
      eurDeltaCents: Math.abs(a.amountEurCents + b.amountEurCents),
    };
  }

  // Case B: Revolut EUR <-> USD internal currency conversion
  if (a.bank !== 'revolut' || b.bank !== 'revolut') {
    return { matched: false, reason: 'NOT_REVOLUT_BOTH' };
  }

  if (dateDeltaDays > REVOLUT_FX_TRANSFER_MAX_DAYS) {
    return { matched: false, reason: 'DATE_WINDOW_EXCEEDED' };
  }

  if (!hasFxLexicalHint(a) && !hasFxLexicalHint(b)) {
    return { matched: false, reason: 'MISSING_FX_LEXICAL_HINT' };
  }

  const maxAbsEurCents = Math.max(Math.abs(a.amountEurCents), Math.abs(b.amountEurCents));
  const toleranceCents = Math.max(
    REVOLUT_FX_MIN_TOLERANCE_CENTS,
    Math.round(REVOLUT_FX_TOLERANCE_RATIO * maxAbsEurCents),
  );
  const eurDeltaCents = Math.abs(a.amountEurCents + b.amountEurCents);

  if (eurDeltaCents > toleranceCents) {
    return { matched: false, reason: 'FX_SPREAD_TOLERANCE_EXCEEDED' };
  }

  return {
    matched: true,
    kind: 'revolut_fx_exchange',
    dateDeltaDays,
    eurDeltaCents,
  };
}

/**
 * Greedily pairs unmatched transfer candidates 1-to-1, prioritizing minimal date delta,
 * then minimal EUR counter-value delta, then deterministic index order.
 */
export function matchInternalTransferPairs(
  candidates: readonly TransferCandidate[],
): ReadonlyArray<MatchedTransferPair> {
  interface ScoredCandidatePair {
    readonly i: number;
    readonly j: number;
    readonly debitTxId: string;
    readonly creditTxId: string;
    readonly kind: 'same_currency' | 'revolut_fx_exchange';
    readonly dateDeltaDays: number;
    readonly eurDeltaCents: number;
  }

  const scoredPairs: ScoredCandidatePair[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const txA = candidates[i];
    if (!txA || !isTransferCandidateEligible(txA)) {
      continue;
    }

    for (let j = i + 1; j < candidates.length; j += 1) {
      const txB = candidates[j];
      if (!txB || !isTransferCandidateEligible(txB)) {
        continue;
      }

      const result = detectInternalTransferPair(txA, txB);
      if (!result.matched) {
        continue;
      }

      const debitTx = txA.amountCents < 0 ? txA : txB;
      const creditTx = txA.amountCents > 0 ? txA : txB;

      scoredPairs.push({
        i,
        j,
        debitTxId: debitTx.id,
        creditTxId: creditTx.id,
        kind: result.kind,
        dateDeltaDays: result.dateDeltaDays,
        eurDeltaCents: result.eurDeltaCents,
      });
    }
  }

  scoredPairs.sort((left, right) => {
    if (left.dateDeltaDays !== right.dateDeltaDays) {
      return left.dateDeltaDays - right.dateDeltaDays;
    }
    if (left.eurDeltaCents !== right.eurDeltaCents) {
      return left.eurDeltaCents - right.eurDeltaCents;
    }
    if (left.i !== right.i) {
      return left.i - right.i;
    }
    return left.j - right.j;
  });

  const usedIndices = new Set<number>();
  const matched: MatchedTransferPair[] = [];

  for (const pair of scoredPairs) {
    if (usedIndices.has(pair.i) || usedIndices.has(pair.j)) {
      continue;
    }
    usedIndices.add(pair.i);
    usedIndices.add(pair.j);
    matched.push({
      debitTxId: pair.debitTxId,
      creditTxId: pair.creditTxId,
      kind: pair.kind,
      dateDeltaDays: pair.dateDeltaDays,
      eurDeltaCents: pair.eurDeltaCents,
    });
  }

  return matched;
}

/**
 * Enforces the normative protection invariant for retroactive rule recalculation:
 * excludes soft-deleted rows, manual category locks, paired internal transfers, and manual transfer overrides.
 * Transactions marked `is_internal_transfer = true` solely by a rule remain eligible when `transferGroupId === null`.
 */
export function isEligibleForRuleRecalc(tx: RuleRecalcCandidate): boolean {
  return (
    tx.deletedAt === null &&
    tx.isManualCategory === false &&
    tx.transferGroupId === null &&
    tx.isManualTransferOverride === false
  );
}
