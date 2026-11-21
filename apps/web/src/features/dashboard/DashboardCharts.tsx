import { formatMoney, toCents, type Account, type Currency, type Transaction } from '@clairflux/shared';
import { memo, useCallback, useMemo, type ReactElement } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildCumulativeBalanceSeries,
  buildMonthlyExpenseSeries,
  type CurrencyViewMode,
  type DashboardBankFilter,
  type ExpenseComparisonMode,
} from './types';

export interface DashboardChartsProps {
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly bankFilter: DashboardBankFilter;
  readonly currencyMode: CurrencyViewMode;
  readonly comparisonMode: ExpenseComparisonMode;
  readonly prefersReducedMotion: boolean;
  readonly onChangeBankFilter: (filter: DashboardBankFilter) => void;
  readonly onChangeCurrencyMode: (mode: CurrencyViewMode) => void;
  readonly onChangeComparisonMode: (mode: ExpenseComparisonMode) => void;
}

interface TooltipPayloadEntry {
  readonly name?: string | number | undefined;
  readonly value?: number | string | readonly (number | string)[] | undefined;
  readonly color?: string | undefined;
}

interface ChartTooltipProps {
  readonly active?: boolean | undefined;
  readonly label?: string | number | undefined;
  readonly payload?: readonly TooltipPayloadEntry[] | undefined;
  readonly currency: Currency;
}

const ChartTooltip = memo(function ChartTooltip({
  active,
  label,
  payload,
  currency,
}: ChartTooltipProps): ReactElement | null {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  return (
    <div className="cf-surface" style={{ padding: '10px 12px', minInlineSize: '180px' }}>
      <p style={{ fontWeight: 700, marginBlockEnd: '6px' }}>{String(label ?? '')}</p>
      {payload.map((entry, index) => {
        const numericCents = typeof entry.value === 'number' ? Math.round(entry.value) : 0;
        return (
          <div
            key={`${String(entry.name ?? 'serie')}-${index}`}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '12px',
              fontSize: '0.8125rem',
            }}
          >
            <span style={{ color: entry.color ?? 'var(--text-secondary)', fontWeight: 500 }}>
              {String(entry.name ?? '')}
            </span>
            <span className="tabular-amount" style={{ fontWeight: 600 }}>
              {formatMoney(toCents(numericCents), currency)}
            </span>
          </div>
        );
      })}
    </div>
  );
});

const BANK_OPTIONS: readonly { readonly value: DashboardBankFilter; readonly label: string }[] = [
  { value: 'all', label: 'Tous les comptes' },
  { value: 'boursobank', label: 'BoursoBank' },
  { value: 'revolut', label: 'Revolut' },
];

const CURRENCY_OPTIONS: readonly { readonly value: CurrencyViewMode; readonly label: string }[] = [
  { value: 'eur_consolidated', label: 'EUR consolidé' },
  { value: 'usd_only', label: 'USD seul' },
];

const COMPARISON_OPTIONS: readonly { readonly value: ExpenseComparisonMode; readonly label: string }[] = [
  { value: 'none', label: 'Sans comparaison' },
  { value: 'prev_month', label: 'Mois précédent (M-1)' },
  { value: 'avg_3m', label: 'Moyenne 3 mois' },
];

function formatSignedPercentDelta(current: number, baseline: number): string {
  if (baseline <= 0) {
    return 'Réf. nulle';
  }
  const pct = Math.round(((current - baseline) / baseline) * 100);
  return pct >= 0 ? `+${pct} %` : `${pct} %`;
}

export const DashboardCharts = memo(function DashboardCharts({
  accounts,
  transactions,
  bankFilter,
  currencyMode,
  comparisonMode,
  prefersReducedMotion,
  onChangeBankFilter,
  onChangeCurrencyMode,
  onChangeComparisonMode,
}: DashboardChartsProps): ReactElement {
  const displayCurrency: Currency = currencyMode === 'usd_only' ? 'USD' : 'EUR';

  const balanceSeries = useMemo(
    () => buildCumulativeBalanceSeries(accounts, transactions, bankFilter, currencyMode),
    [accounts, transactions, bankFilter, currencyMode],
  );

  const expenseSeries = useMemo(
    () => buildMonthlyExpenseSeries(transactions, bankFilter, currencyMode),
    [transactions, bankFilter, currencyMode],
  );

  const formatAxisMoney = useCallback(
    (cents: number): string => {
      const symbol = displayCurrency === 'USD' ? '$' : '€';
      return `${Math.round(cents / 100)} ${symbol}`;
    },
    [displayCurrency],
  );

  const latestExpensePoint = expenseSeries[expenseSeries.length - 1];
  const latestBaselineCents =
    comparisonMode === 'prev_month'
      ? (latestExpensePoint?.prevMonthCents ?? 0)
      : comparisonMode === 'avg_3m'
        ? (latestExpensePoint?.avg3mCents ?? 0)
        : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="cf-chart-controls" role="region" aria-label="Filtres des graphiques">
        <div className="cf-scope-bar" role="group" aria-label="Périmètre bancaire">
          {BANK_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="cf-pill-btn"
              aria-pressed={bankFilter === opt.value}
              onClick={() => onChangeBankFilter(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="cf-scope-bar" role="group" aria-label="Affichage de devise">
          {CURRENCY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="cf-pill-btn"
              aria-pressed={currencyMode === opt.value}
              onClick={() => onChangeCurrencyMode(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="cf-charts-container">
        <div className="cf-charts-grid">
          <section className="cf-surface cf-chart-card" aria-labelledby="chart-balance-title">
            <div className="cf-chart-controls">
              <h2 id="chart-balance-title" style={{ fontSize: '1rem' }}>
                Solde bancaire cumulé 6M ({displayCurrency})
              </h2>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                {currencyMode === 'usd_only' ? 'Natifs USD uniquement' : 'Taux historique figé'}
              </span>
            </div>

            <div className="cf-chart-frame">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={[...balanceSeries]} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#dedad0" />
                  <XAxis dataKey="label" tick={{ fill: '#4a515a', fontSize: 12 }} />
                  <YAxis
                    tickFormatter={formatAxisMoney}
                    tick={{ fill: '#4a515a', fontSize: 11 }}
                    width={68}
                  />
                  <Tooltip content={<ChartTooltip currency={displayCurrency} />} />
                  <Area
                    type="monotone"
                    dataKey="closing_balance_cents"
                    name="Solde cumulé"
                    stroke="#0f5c4d"
                    fill="#e6f2ef"
                    fillOpacity={0.75}
                    strokeWidth={2.25}
                    isAnimationActive={!prefersReducedMotion}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="cf-surface cf-chart-card" aria-labelledby="chart-expenses-title">
            <div className="cf-chart-controls">
              <h2 id="chart-expenses-title" style={{ fontSize: '1rem' }}>
                Dépenses mensuelles ({displayCurrency})
              </h2>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                Hors transferts internes
              </span>
            </div>

            <div className="cf-scope-bar" role="group" aria-label="Mode de comparaison des dépenses">
              {COMPARISON_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="cf-pill-btn"
                  aria-pressed={comparisonMode === opt.value}
                  onClick={() => onChangeComparisonMode(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="cf-chart-frame">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={[...expenseSeries]} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#dedad0" />
                  <XAxis dataKey="label" tick={{ fill: '#4a515a', fontSize: 12 }} />
                  <YAxis
                    tickFormatter={formatAxisMoney}
                    tick={{ fill: '#4a515a', fontSize: 11 }}
                    width={68}
                  />
                  <Tooltip content={<ChartTooltip currency={displayCurrency} />} />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Area
                    type="monotone"
                    dataKey="amountCents"
                    name="Dépenses du mois"
                    stroke="#b42318"
                    fill="#fef3f2"
                    fillOpacity={0.75}
                    strokeWidth={2.25}
                    isAnimationActive={!prefersReducedMotion}
                  />
                  {comparisonMode === 'prev_month' ? (
                    <Area
                      type="monotone"
                      dataKey="prevMonthCents"
                      name="Mois précédent (M-1)"
                      stroke="#64748b"
                      fill="#64748b"
                      fillOpacity={0.14}
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      isAnimationActive={!prefersReducedMotion}
                    />
                  ) : null}
                  {comparisonMode === 'avg_3m' ? (
                    <Area
                      type="monotone"
                      dataKey="avg3mCents"
                      name="Moyenne 3 mois"
                      stroke="#0f5c4d"
                      fill="#e6f2ef"
                      fillOpacity={0.35}
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      isAnimationActive={!prefersReducedMotion}
                    />
                  ) : null}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {latestExpensePoint ? (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: '8px',
                  paddingBlockStart: '8px',
                  borderBlockStart: '1px solid var(--border-subtle)',
                  fontSize: '0.8125rem',
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>
                  Dernier mois ({latestExpensePoint.label}) :{' '}
                  <strong className="tabular-amount" style={{ color: 'var(--text-primary)' }}>
                    {formatMoney(latestExpensePoint.amountCents, displayCurrency)}
                  </strong>
                </span>
                {comparisonMode !== 'none' ? (
                  <span className="tabular-amount" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                    Écart vs {comparisonMode === 'prev_month' ? 'M-1' : 'moy. 3M'} :{' '}
                    {formatSignedPercentDelta(latestExpensePoint.amountCents, latestBaselineCents)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
});

export default DashboardCharts;
