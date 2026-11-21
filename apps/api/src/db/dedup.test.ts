import { describe, expect, it } from 'vitest';
import { assertValidNeonDatabaseUrl } from './client.js';
import {
  assignStatementDedupHashes,
  computeDedupHash,
  detectInternalTransferPair,
  isEligibleForRuleRecalc,
  matchInternalTransferPairs,
  normalizeLabel,
  type RuleRecalcCandidate,
  type TransferCandidate,
} from './dedup.js';

const ACCOUNT_BOURSO_EUR = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_REVOLUT_EUR = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_REVOLUT_USD = '33333333-3333-4333-8333-333333333333';

function makeCandidate(overrides: Partial<TransferCandidate> = {}): TransferCandidate {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accountId: ACCOUNT_BOURSO_EUR,
    bank: 'boursobank',
    currency: 'EUR',
    bookingDate: '2026-11-10',
    amountCents: -50000,
    amountEurCents: -50000,
    rawLabel: 'VIR INSTANTANE REVOLUT',
    cleanLabel: 'Virement Revolut',
    transferGroupId: null,
    isManualTransferOverride: false,
    deletedAt: null,
    ...overrides,
  };
}

describe('normalizeLabel', () => {
  it('lowercases, strips diacritics via NFKD, collapses whitespace, and trims', () => {
    expect(normalizeLabel('  Café   Crème\t\nÉLYSÉES  ')).toBe('cafe creme elysees');
  });
});

describe('computeDedupHash & assignStatementDedupHashes', () => {
  it('produces a deterministic 64-char sha256 hex digest regardless of accent/spacing noise', () => {
    const h1 = computeDedupHash({
      accountId: ACCOUNT_BOURSO_EUR,
      currency: 'EUR',
      bookingDate: '2026-11-10',
      amountCents: -250,
      rawLabel: 'BOULANGERIE   LÉON',
      occurrenceIndex: 1,
    });
    const h2 = computeDedupHash({
      accountId: ACCOUNT_BOURSO_EUR,
      currency: 'EUR',
      bookingDate: '2026-11-10',
      amountCents: -250,
      rawLabel: 'boulangerie leon',
      occurrenceIndex: 1,
    });

    expect(h1).toMatch(/^[a-f0-9]{64}$/);
    expect(h1).toBe(h2);
  });

  it('distinguishes identical same-day purchases via occurrenceIndex while staying idempotent across overlapping statements', () => {
    const octoberStatement = assignStatementDedupHashes([
      {
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: -250,
        rawLabel: 'CB BOULANGERIE DU COIN',
      },
      {
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: -250,
        rawLabel: 'CB BOULANGERIE DU COIN',
      },
    ]);

    expect(octoberStatement).toHaveLength(2);
    expect(octoberStatement[0]?.statementOccurrenceIndex).toBe(1);
    expect(octoberStatement[1]?.statementOccurrenceIndex).toBe(2);
    expect(octoberStatement[0]?.dedupHash).not.toBe(octoberStatement[1]?.dedupHash);

    const overlappingNovemberStatement = assignStatementDedupHashes([
      {
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: -250,
        rawLabel: 'CB Boulangerie du Coin',
      },
      {
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: -250,
        rawLabel: 'CB Boulangerie du Coin',
      },
    ]);

    expect(overlappingNovemberStatement[0]?.dedupHash).toBe(octoberStatement[0]?.dedupHash);
    expect(overlappingNovemberStatement[1]?.dedupHash).toBe(octoberStatement[1]?.dedupHash);
  });

  it('separates accounts and currencies cleanly', () => {
    const eurHash = computeDedupHash({
      accountId: ACCOUNT_REVOLUT_EUR,
      currency: 'EUR',
      bookingDate: '2026-11-10',
      amountCents: -2000,
      rawLabel: 'CURSOR AI',
      occurrenceIndex: 1,
    });
    const usdHash = computeDedupHash({
      accountId: ACCOUNT_REVOLUT_USD,
      currency: 'USD',
      bookingDate: '2026-11-10',
      amountCents: -2000,
      rawLabel: 'CURSOR AI',
      occurrenceIndex: 1,
    });

    expect(eurHash).not.toBe(usdHash);
  });

  it('rejects zero amounts, floats, invalid dates, and non-positive occurrenceIndex', () => {
    expect(() =>
      computeDedupHash({
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: 0,
        rawLabel: 'ZERO',
        occurrenceIndex: 1,
      }),
    ).toThrow();

    expect(() =>
      computeDedupHash({
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-02-30',
        amountCents: -100,
        rawLabel: 'BAD DATE',
        occurrenceIndex: 1,
      }),
    ).toThrow();

    expect(() =>
      computeDedupHash({
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: -10.5,
        rawLabel: 'FLOAT',
        occurrenceIndex: 1,
      }),
    ).toThrow();

    expect(() =>
      computeDedupHash({
        accountId: ACCOUNT_BOURSO_EUR,
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: -100,
        rawLabel: 'BAD OCC',
        occurrenceIndex: 0,
      }),
    ).toThrow();
  });
});

describe('detectInternalTransferPair', () => {
  it('matches BoursoBank <-> Revolut same-currency transfers within +/- 3 days', () => {
    const debit = makeCandidate({
      id: 'tx-1',
      accountId: ACCOUNT_BOURSO_EUR,
      bank: 'boursobank',
      currency: 'EUR',
      bookingDate: '2026-11-10',
      amountCents: -50000,
      amountEurCents: -50000,
    });
    const credit = makeCandidate({
      id: 'tx-2',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      currency: 'EUR',
      bookingDate: '2026-11-13',
      amountCents: 50000,
      amountEurCents: 50000,
      rawLabel: 'Top-up from BoursoBank',
    });

    const result = detectInternalTransferPair(debit, credit);
    expect(result).toEqual({
      matched: true,
      kind: 'same_currency',
      dateDeltaDays: 3,
      eurDeltaCents: 0,
    });
  });

  it('rejects same-currency transfers beyond 3 days or on the same account', () => {
    const debit = makeCandidate({ bookingDate: '2026-11-10', amountCents: -50000 });
    const tooLate = makeCandidate({
      id: 'tx-late',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      bookingDate: '2026-11-14',
      amountCents: 50000,
      amountEurCents: 50000,
    });
    expect(detectInternalTransferPair(debit, tooLate)).toEqual({
      matched: false,
      reason: 'DATE_WINDOW_EXCEEDED',
    });

    const sameAccount = makeCandidate({
      id: 'tx-same-acct',
      accountId: ACCOUNT_BOURSO_EUR,
      bookingDate: '2026-11-10',
      amountCents: 50000,
      amountEurCents: 50000,
    });
    expect(detectInternalTransferPair(debit, sameAccount)).toEqual({
      matched: false,
      reason: 'SAME_ACCOUNT',
    });
  });

  it('matches Revolut EUR <-> USD internal currency exchanges within +/- 1 day and FX spread tolerance', () => {
    const eurOut = makeCandidate({
      id: 'fx-eur',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      currency: 'EUR',
      bookingDate: '2026-11-15',
      amountCents: -10000,
      amountEurCents: -10000,
      rawLabel: 'Exchanged to USD',
      cleanLabel: 'Exchanged to USD',
    });
    const usdIn = makeCandidate({
      id: 'fx-usd',
      accountId: ACCOUNT_REVOLUT_USD,
      bank: 'revolut',
      currency: 'USD',
      bookingDate: '2026-11-16',
      amountCents: 10800,
      amountEurCents: 9920,
      rawLabel: 'Exchanged from EUR',
      cleanLabel: 'Exchanged from EUR',
    });

    const result = detectInternalTransferPair(eurOut, usdIn);
    expect(result).toEqual({
      matched: true,
      kind: 'revolut_fx_exchange',
      dateDeltaDays: 1,
      eurDeltaCents: 80,
    });
  });

  it('applies the 200-cent minimum EUR spread floor on small Revolut conversions and rejects excessive spreads', () => {
    const microOut = makeCandidate({
      id: 'micro-eur',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      currency: 'EUR',
      bookingDate: '2026-11-15',
      amountCents: -500,
      amountEurCents: -500,
      rawLabel: 'Exchanged to USD',
    });
    const microIn = makeCandidate({
      id: 'micro-usd',
      accountId: ACCOUNT_REVOLUT_USD,
      bank: 'revolut',
      currency: 'USD',
      bookingDate: '2026-11-15',
      amountCents: 400,
      amountEurCents: 350, // 150 cents delta <= 200 cents floor
      rawLabel: 'Exchanged from EUR',
    });
    expect(detectInternalTransferPair(microOut, microIn).matched).toBe(true);

    const excessiveSpread = makeCandidate({
      id: 'bad-spread-usd',
      accountId: ACCOUNT_REVOLUT_USD,
      bank: 'revolut',
      currency: 'USD',
      bookingDate: '2026-11-15',
      amountCents: 10800,
      amountEurCents: 9000, // 1000 cents delta > max(200, 300)
      rawLabel: 'Exchanged from EUR',
    });
    const largeOut = makeCandidate({
      ...microOut,
      amountCents: -10000,
      amountEurCents: -10000,
    });
    expect(detectInternalTransferPair(largeOut, excessiveSpread)).toEqual({
      matched: false,
      reason: 'FX_SPREAD_TOLERANCE_EXCEEDED',
    });
  });

  it('requires Revolut on both legs, <= 1 day gap, and valid FX lexical hint without false positives', () => {
    const revolutEur = makeCandidate({
      id: 'rev-eur',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      currency: 'EUR',
      bookingDate: '2026-11-15',
      amountCents: -5000,
      amountEurCents: -5000,
      rawLabel: 'COIFFEUR PARIS',
      cleanLabel: 'Coiffeur Paris',
    });
    const revolutUsd = makeCandidate({
      id: 'rev-usd',
      accountId: ACCOUNT_REVOLUT_USD,
      bank: 'revolut',
      currency: 'USD',
      bookingDate: '2026-11-15',
      amountCents: 5400,
      amountEurCents: 5000,
      rawLabel: 'REFUND MERCHANT',
      cleanLabel: 'Refund Merchant',
    });
    expect(detectInternalTransferPair(revolutEur, revolutUsd)).toEqual({
      matched: false,
      reason: 'MISSING_FX_LEXICAL_HINT',
    });

    const boursoEur = makeCandidate({
      ...revolutEur,
      accountId: ACCOUNT_BOURSO_EUR,
      bank: 'boursobank',
      rawLabel: 'Conversion EUR',
    });
    expect(detectInternalTransferPair(boursoEur, revolutUsd)).toEqual({
      matched: false,
      reason: 'NOT_REVOLUT_BOTH',
    });
  });

  it('skips already paired, manually overridden, or soft-deleted transactions', () => {
    const a = makeCandidate({ transferGroupId: '99999999-9999-4999-8999-999999999999' });
    const b = makeCandidate({
      id: 'tx-b',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      amountCents: 50000,
      amountEurCents: 50000,
    });
    expect(detectInternalTransferPair(a, b)).toEqual({
      matched: false,
      reason: 'NOT_ELIGIBLE',
    });

    const overridden = makeCandidate({ isManualTransferOverride: true });
    expect(detectInternalTransferPair(overridden, b)).toEqual({
      matched: false,
      reason: 'NOT_ELIGIBLE',
    });
  });
});

describe('matchInternalTransferPairs', () => {
  it('prefers the closest booking date when multiple candidates share the same amount', () => {
    const debit = makeCandidate({
      id: 'debit-nov-10',
      accountId: ACCOUNT_BOURSO_EUR,
      bank: 'boursobank',
      bookingDate: '2026-11-10',
      amountCents: -25000,
      amountEurCents: -25000,
    });
    const creditFar = makeCandidate({
      id: 'credit-nov-12',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      bookingDate: '2026-11-12',
      amountCents: 25000,
      amountEurCents: 25000,
    });
    const creditExact = makeCandidate({
      id: 'credit-nov-10',
      accountId: ACCOUNT_REVOLUT_EUR,
      bank: 'revolut',
      bookingDate: '2026-11-10',
      amountCents: 25000,
      amountEurCents: 25000,
    });

    const pairs = matchInternalTransferPairs([debit, creditFar, creditExact]);
    expect(pairs).toEqual([
      {
        debitTxId: 'debit-nov-10',
        creditTxId: 'credit-nov-10',
        kind: 'same_currency',
        dateDeltaDays: 0,
        eurDeltaCents: 0,
      },
    ]);
  });
});

describe('isEligibleForRuleRecalc', () => {
  const base: RuleRecalcCandidate = {
    deletedAt: null,
    isManualCategory: false,
    transferGroupId: null,
    isManualTransferOverride: false,
  };

  it('allows recalculation when unlocked (including rule-tagged internal transfers without group)', () => {
    expect(isEligibleForRuleRecalc(base)).toBe(true);
  });

  it('protects manual categories, paired transfer groups, manual transfer overrides, and deleted rows', () => {
    expect(isEligibleForRuleRecalc({ ...base, isManualCategory: true })).toBe(false);
    expect(
      isEligibleForRuleRecalc({
        ...base,
        transferGroupId: '99999999-9999-4999-8999-999999999999',
      }),
    ).toBe(false);
    expect(isEligibleForRuleRecalc({ ...base, isManualTransferOverride: true })).toBe(false);
    expect(isEligibleForRuleRecalc({ ...base, deletedAt: new Date('2026-11-21T00:00:00Z') })).toBe(
      false,
    );
  });
});

describe('assertValidNeonDatabaseUrl', () => {
  it('accepts Neon URLs with sslmode=require and rejects insecure or malformed URLs', () => {
    const valid = 'postgresql://user:pass@ep-cool-sky.eu-central-1.aws.neon.tech/clairflux?sslmode=require';
    expect(assertValidNeonDatabaseUrl(valid)).toBe(valid);

    expect(() =>
      assertValidNeonDatabaseUrl('postgresql://user:pass@localhost:5432/clairflux'),
    ).toThrow(/sslmode=require/u);

    expect(() =>
      assertValidNeonDatabaseUrl('postgresql://user:pass@localhost:5432/clairflux?sslmode=disable'),
    ).toThrow(/sslmode=require/u);

    expect(() => assertValidNeonDatabaseUrl('not-a-url')).toThrow();
  });
});
