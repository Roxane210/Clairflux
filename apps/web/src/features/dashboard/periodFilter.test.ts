import {
  parseAccountId,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type Account,
  type Transaction,
} from '@clairflux/shared';
import { describe, expect, it } from 'vitest';
import {
  enumerateDaySlots,
  enumerateMonthSlots,
  isTransactionInBounds,
  resolveDateBounds,
} from './periodFilter';
import {
  buildCumulativeBalanceSeries,
  buildMonthlyExpenseSeries,
  computeKpiMetrics,
} from './types';

const ACC_EUR = parseAccountId('11111111-1111-4111-8111-111111111111');

function makeAccount(balanceCents: number): Account {
  return {
    id: ACC_EUR,
    bank: 'boursobank',
    account_type: 'courant',
    nickname: 'Courant Test',
    external_ref_masked: '•••• 1234',
    currency: 'EUR',
    current_balance_cents: toCents(balanceCents),
    current_balance_eur_cents: toCents(balanceCents),
    balance_updated_at: '2026-11-24T10:00:00.000Z',
    revision: toSyncRevision(10),
    updated_at: '2026-11-24T10:00:00.000Z',
  };
}

function makeTx(
  suffix: string,
  bookingDate: string,
  amountCents: number,
  isInternalTransfer = false,
): Transaction {
  return {
    id: parseTransactionId(`33333333-3333-4333-8333-33333333${suffix.padStart(4, '0')}`),
    account_id: ACC_EUR,
    bank: 'boursobank',
    account_type: 'courant',
    external_ref_masked: '•••• 1234',
    booking_date: bookingDate,
    value_date: bookingDate,
    raw_label: `OP ${bookingDate}`,
    clean_label: `Opération ${bookingDate}`,
    amount_cents: toCents(amountCents),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(amountCents),
    category: isInternalTransfer ? 'Transfert interne' : 'Alimentation',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: isInternalTransfer,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: '88888888-8888-4888-8888-888888888881',
    revision: toSyncRevision(10),
    updated_at: '2026-11-24T10:00:00.000Z',
  };
}

describe('periodFilter & adaptive granularity', () => {
  const sampleTxs: readonly Transaction[] = [
    makeTx('1', '2025-10-05', -4000),
    makeTx('2', '2026-09-10', -10000),
    makeTx('3', '2026-10-20', -6000),
    makeTx('4', '2026-11-18', -2500),
    makeTx('5', '2026-11-20', 200000),
    makeTx('6', '2026-11-22', -5000, true),
    makeTx('7', '2026-11-24', -1500),
  ];

  it('résout les 7 presets et bascule la granularité à <= 45 jours (jour) vs > 45 jours (mois)', () => {
    const ref = '2026-11-24';

    const w1 = resolveDateBounds({ preset: '1w' }, sampleTxs, ref);
    expect(w1.from).toBe('2026-11-18');
    expect(w1.to).toBe('2026-11-24');
    expect(w1.daySpan).toBe(7);
    expect(w1.granularity).toBe('day');

    const m1 = resolveDateBounds({ preset: '1m' }, sampleTxs, ref);
    expect(m1.from).toBe('2026-10-24');
    expect(m1.to).toBe('2026-11-24');
    expect(m1.granularity).toBe('day');

    const m3 = resolveDateBounds({ preset: '3m' }, sampleTxs, ref);
    expect(m3.from).toBe('2026-08-24');
    expect(m3.granularity).toBe('month');

    const m6 = resolveDateBounds({ preset: '6m' }, sampleTxs, ref);
    expect(m6.from).toBe('2026-05-24');
    expect(m6.granularity).toBe('month');

    const y1 = resolveDateBounds({ preset: '1y' }, sampleTxs, ref);
    expect(y1.from).toBe('2025-11-24');
    expect(y1.granularity).toBe('month');

    const all = resolveDateBounds({ preset: 'all' }, sampleTxs, ref);
    expect(all.from).toBe('2025-10-05');
    expect(all.to).toBe('2026-11-24');
    expect(all.granularity).toBe('month');

    // Exact boundary: 45 days -> 'day', 46 days -> 'month'
    const custom45 = resolveDateBounds(
      { preset: 'custom', from: '2026-10-10', to: '2026-11-23' },
      sampleTxs,
      ref,
    );
    expect(custom45.daySpan).toBe(45);
    expect(custom45.granularity).toBe('day');
    expect(custom45.isCustomRangeInvalid).toBe(false);

    const custom46 = resolveDateBounds(
      { preset: 'custom', from: '2026-10-09', to: '2026-11-23' },
      sampleTxs,
      ref,
    );
    expect(custom46.daySpan).toBe(46);
    expect(custom46.granularity).toBe('month');
    expect(custom46.isCustomRangeInvalid).toBe(false);
  });

  it('protège les plages personnalisées invalides (from > to) sans planter', () => {
    const invalid = resolveDateBounds(
      { preset: 'custom', from: '2026-11-24', to: '2026-11-01' },
      sampleTxs,
      '2026-11-24',
    );
    expect(invalid.isCustomRangeInvalid).toBe(true);
    expect(invalid.from <= invalid.to).toBe(true);
    expect(invalid.granularity).toBe('day');
  });

  it('calcule KPIs, solde cumulé et dépenses jour par jour en excluant les transferts internes', () => {
    const bounds = resolveDateBounds({ preset: '1w' }, sampleTxs, '2026-11-24');
    const accounts = [makeAccount(300000)];

    expect(sampleTxs.filter((tx) => isTransactionInBounds(tx, bounds))).toHaveLength(4);

    const kpis = computeKpiMetrics(accounts, sampleTxs, 'all', 'eur_consolidated', bounds);
    expect(kpis.balanceCents).toBe(300000);
    expect(kpis.incomeCents).toBe(200000);
    expect(kpis.expensesExclTransfersCents).toBe(4000); // 2500 + 1500 (5000 transfer excluded)
    expect(kpis.internalTransfersCents).toBe(5000);

    const daySlots = enumerateDaySlots(bounds.from, bounds.to);
    expect(daySlots).toHaveLength(7);

    const balanceSeries = buildCumulativeBalanceSeries(
      accounts,
      sampleTxs,
      'all',
      'eur_consolidated',
      bounds,
    );
    expect(balanceSeries).toHaveLength(7);
    expect(balanceSeries.at(-1)?.closing_balance_cents).toBe(300000);
    expect(balanceSeries[0]?.month).toBe('2026-11-18');

    const expenseSeries = buildMonthlyExpenseSeries(
      sampleTxs,
      'all',
      'eur_consolidated',
      bounds,
    );
    expect(expenseSeries).toHaveLength(7);
    expect(expenseSeries.find((p) => p.month === '2026-11-18')?.amountCents).toBe(2500);
    expect(expenseSeries.find((p) => p.month === '2026-11-22')?.amountCents).toBe(0);
    expect(expenseSeries.find((p) => p.month === '2026-11-24')?.amountCents).toBe(1500);
  });

  it('calcule les séries mensuelles sur 3 mois avec comparaison M-1 et moyenne 3M', () => {
    const bounds = resolveDateBounds({ preset: '3m' }, sampleTxs, '2026-11-24');
    const monthSlots = enumerateMonthSlots(bounds.from, bounds.to);
    expect(monthSlots.map((s) => s.key)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);

    const expenseSeries = buildMonthlyExpenseSeries(
      sampleTxs,
      'all',
      'eur_consolidated',
      bounds,
    );
    const novPoint = expenseSeries.find((p) => p.month === '2026-11');
    expect(novPoint?.amountCents).toBe(4000);
    expect(novPoint?.prevMonthCents).toBe(6000);
    expect(novPoint?.avg3mCents).toBe(Math.round((0 + 10000 + 6000) / 3));
  });
});
