import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import {
  ALLOWED_DRIVE_FOLDERS,
  assertNever,
  convertToEurCents,
  formatMoney,
  parseAccountId,
  parseDriveFileId,
  parseRuleId,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type Account,
  type AccountId,
  type AccountType,
  type Bank,
  type CategorizationRule,
  type Cents,
  type CumulativeBalancePoint,
  type Currency,
  type DriveSyncFileStatus,
  type ExpenseComparisonItem,
  type Transaction,
  type TransactionId,
  type TransactionNote,
} from '@clairflux/shared';
import {
  lazy,
  memo,
  StrictMode,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { createRoot } from 'react-dom/client';

// ============================================================================
// Discriminated Unions (Matt Pocock Standard — Zero `any`)
// ============================================================================

type AppTab =
  | { readonly kind: 'overview' }
  | { readonly kind: 'transactions' }
  | { readonly kind: 'rules' }
  | { readonly kind: 'sync' };

type NetworkState =
  | { readonly kind: 'online'; readonly lastSyncedAt: string; readonly revision: number }
  | { readonly kind: 'offline_readonly'; readonly cachedAt: string; readonly revision: number };

type CurrencyScope =
  | { readonly kind: 'all_eur' }
  | { readonly kind: 'usd_only' }
  | { readonly kind: 'bank'; readonly bank: Bank }
  | { readonly kind: 'account'; readonly accountId: AccountId };

type DialogState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'edit_transaction'; readonly transactionId: TransactionId };

// ============================================================================
// Baseline Platform Helpers (INP yield, View Transitions, Reduced Motion)
// ============================================================================

interface SchedulerWithYield {
  readonly yield: () => Promise<void>;
}

function hasSchedulerYield(value: unknown): value is SchedulerWithYield {
  return (
    typeof value === 'object' &&
    value !== null &&
    'yield' in value &&
    typeof value.yield === 'function'
  );
}

export async function yieldToMain(): Promise<void> {
  if (typeof window !== 'undefined' && 'scheduler' in window) {
    const maybeScheduler: unknown = Reflect.get(window, 'scheduler');
    if (hasSchedulerYield(maybeScheduler)) {
      await maybeScheduler.yield();
      return;
    }
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    mediaQuery.addEventListener('change', onChange);
    return () => {
      mediaQuery.removeEventListener('change', onChange);
    };
  }, []);

  return reduced;
}

function runWithViewTransition(updateDom: () => void, reducedMotion: boolean, focusHeadingId: string): void {
  const focusTarget = (): void => {
    requestAnimationFrame(() => {
      document.getElementById(focusHeadingId)?.focus();
    });
  };

  if (reducedMotion || typeof document === 'undefined' || !('startViewTransition' in document)) {
    updateDom();
    focusTarget();
    return;
  }

  const transition = document.startViewTransition(() => {
    updateDom();
  });
  void transition.finished.finally(() => {
    focusTarget();
  });
}

// ============================================================================
// Formatting Helpers (Pure UI presentation, tabular-nums cents only)
// ============================================================================

const BANK_LABELS: Readonly<Record<Bank, string>> = {
  boursobank: 'BoursoBank',
  revolut: 'Revolut',
};

const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>> = {
  courant: 'Courant',
  epargne: 'Épargne',
  carte_differee: 'Carte différée',
  multi_devises: 'Multi-devises',
  coffre: 'Coffre',
  autre: 'Autre',
};

function formatSignedDeltaPercent(delta: number): string {
  const rounded = Math.round(delta);
  return rounded >= 0 ? `+${rounded} %` : `${rounded} %`;
}

function formatBudgetAlertLabel(m1Cents: Cents, avg3mCents: Cents): string {
  if (avg3mCents <= 0) {
    return 'Référence nulle';
  }
  const ratio = (m1Cents / avg3mCents) * 100;
  if (ratio >= 100) {
    return `Alerte >= 100 % (${Math.round(ratio)} %)`;
  }
  if (ratio >= 75) {
    return `Vigilance 75–99 % (${Math.round(ratio)} %)`;
  }
  return `Maîtrisé < 75 % (${Math.round(ratio)} %)`;
}

// ============================================================================
// Mock-First Initial Seed (Multi-comptes BoursoBank & Revolut EUR/USD)
// ============================================================================

const ACC_BOURSO_PERSO = parseAccountId('11111111-1111-4111-8111-111111111111');
const ACC_BOURSO_JOINT = parseAccountId('11111111-1111-4111-8111-111111111112');
const ACC_BOURSO_CARD = parseAccountId('11111111-1111-4111-8111-111111111113');
const ACC_REVOLUT_EUR = parseAccountId('22222222-2222-4222-8222-222222222221');
const ACC_REVOLUT_USD = parseAccountId('22222222-2222-4222-8222-222222222222');

const RULE_ID_CURSOR = parseRuleId('44444444-4444-4444-8444-444444444441');
const RULE_ID_BIOCOOP = parseRuleId('44444444-4444-4444-8444-444444444442');

const TX_ID_1 = parseTransactionId('33333333-3333-4333-8333-333333333331');
const TX_ID_2 = parseTransactionId('33333333-3333-4333-8333-333333333332');
const TX_ID_3 = parseTransactionId('33333333-3333-4333-8333-333333333333');
const TX_ID_4 = parseTransactionId('33333333-3333-4333-8333-333333333334');
const TX_ID_5 = parseTransactionId('33333333-3333-4333-8333-333333333335');
const TX_ID_6 = parseTransactionId('33333333-3333-4333-8333-333333333336');

const INITIAL_ACCOUNTS: ReadonlyArray<Account> = [
  {
    id: ACC_BOURSO_PERSO,
    bank: 'boursobank',
    account_type: 'courant',
    nickname: 'Perso BoursoBank',
    external_ref_masked: '•••• 4821',
    currency: 'EUR',
    current_balance_cents: toCents(412840),
    current_balance_eur_cents: toCents(412840),
    balance_updated_at: '2026-11-20T23:59:59.000Z',
    revision: toSyncRevision(1410),
    updated_at: '2026-11-20T18:02:11.000Z',
  },
  {
    id: ACC_BOURSO_JOINT,
    bank: 'boursobank',
    account_type: 'courant',
    nickname: 'Compte Joint',
    external_ref_masked: '•••• 9104',
    currency: 'EUR',
    current_balance_cents: toCents(318500),
    current_balance_eur_cents: toCents(318500),
    balance_updated_at: '2026-11-20T23:59:59.000Z',
    revision: toSyncRevision(1412),
    updated_at: '2026-11-20T18:02:11.000Z',
  },
  {
    id: ACC_BOURSO_CARD,
    bank: 'boursobank',
    account_type: 'carte_differee',
    nickname: 'Carte Ultim Différée',
    external_ref_masked: '•••• 7712',
    currency: 'EUR',
    current_balance_cents: toCents(-64210),
    current_balance_eur_cents: toCents(-64210),
    balance_updated_at: '2026-11-20T23:59:59.000Z',
    revision: toSyncRevision(1414),
    updated_at: '2026-11-20T18:02:12.000Z',
  },
  {
    id: ACC_REVOLUT_EUR,
    bank: 'revolut',
    account_type: 'courant',
    nickname: 'Courant EUR',
    external_ref_masked: 'EUR •• 3310',
    currency: 'EUR',
    current_balance_cents: toCents(194500),
    current_balance_eur_cents: toCents(194500),
    balance_updated_at: '2026-11-20T23:59:59.000Z',
    revision: toSyncRevision(1450),
    updated_at: '2026-11-20T18:02:15.000Z',
  },
  {
    id: ACC_REVOLUT_USD,
    bank: 'revolut',
    account_type: 'multi_devises',
    nickname: 'Courant USD',
    external_ref_masked: 'USD •• 9012',
    currency: 'USD',
    current_balance_cents: toCents(185000),
    current_balance_eur_cents: convertToEurCents(toCents(185000), toFxRateMicro(924500)),
    balance_updated_at: '2026-11-20T23:59:59.000Z',
    revision: toSyncRevision(1455),
    updated_at: '2026-11-20T18:02:15.000Z',
  },
];

const INITIAL_TRANSACTIONS: ReadonlyArray<Transaction> = [
  {
    id: TX_ID_1,
    account_id: ACC_REVOLUT_USD,
    bank: 'revolut',
    account_type: 'multi_devises',
    external_ref_masked: 'USD •• 9012',
    booking_date: '2026-11-18',
    value_date: '2026-11-18',
    raw_label: 'CURSOR AI *MONTHLY SAN FRANCISCO US',
    clean_label: 'Cursor AI',
    amount_cents: toCents(-2000),
    currency: 'USD',
    fx_rate_micro: toFxRateMicro(924500),
    amount_eur_cents: convertToEurCents(toCents(-2000), toFxRateMicro(924500)),
    category: 'Logiciels & Cloud',
    is_manual_category: false,
    matched_rule_id: RULE_ID_CURSOR,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: '88888888-8888-4888-8888-888888888881',
    revision: toSyncRevision(1460),
    updated_at: '2026-11-19T09:10:00.000Z',
  },
  {
    id: TX_ID_2,
    account_id: ACC_REVOLUT_USD,
    bank: 'revolut',
    account_type: 'multi_devises',
    external_ref_masked: 'USD •• 9012',
    booking_date: '2026-11-15',
    value_date: '2026-11-15',
    raw_label: 'EXCHANGE EUR TO USD REVOLUT',
    clean_label: 'Change Revolut EUR → USD',
    amount_cents: toCents(60000),
    currency: 'USD',
    fx_rate_micro: toFxRateMicro(923000),
    amount_eur_cents: convertToEurCents(toCents(60000), toFxRateMicro(923000)),
    category: 'Transfert interne',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: true,
    is_manual_transfer_override: false,
    transfer_group_id: '99999999-9999-4999-8999-999999999991',
    source_drive_file_id: '88888888-8888-4888-8888-888888888881',
    revision: toSyncRevision(1458),
    updated_at: '2026-11-15T12:00:00.000Z',
  },
  {
    id: TX_ID_3,
    account_id: ACC_REVOLUT_EUR,
    bank: 'revolut',
    account_type: 'courant',
    external_ref_masked: 'EUR •• 3310',
    booking_date: '2026-11-15',
    value_date: '2026-11-15',
    raw_label: 'EXCHANGE EUR TO USD REVOLUT',
    clean_label: 'Change Revolut EUR → USD',
    amount_cents: toCents(-55380),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-55380),
    category: 'Transfert interne',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: true,
    is_manual_transfer_override: false,
    transfer_group_id: '99999999-9999-4999-8999-999999999991',
    source_drive_file_id: '88888888-8888-4888-8888-888888888882',
    revision: toSyncRevision(1457),
    updated_at: '2026-11-15T12:00:00.000Z',
  },
  {
    id: TX_ID_4,
    account_id: ACC_BOURSO_CARD,
    bank: 'boursobank',
    account_type: 'carte_differee',
    external_ref_masked: '•••• 7712',
    booking_date: '2026-11-14',
    value_date: '2026-11-14',
    raw_label: 'CARTE 12/11 BIOCOOP PARIS 11',
    clean_label: 'Biocoop Paris 11',
    amount_cents: toCents(-6840),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-6840),
    category: 'Alimentation',
    is_manual_category: false,
    matched_rule_id: RULE_ID_BIOCOOP,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: '88888888-8888-4888-8888-888888888883',
    revision: toSyncRevision(1445),
    updated_at: '2026-11-14T19:00:00.000Z',
  },
  {
    id: TX_ID_5,
    account_id: ACC_BOURSO_JOINT,
    bank: 'boursobank',
    account_type: 'courant',
    external_ref_masked: '•••• 9104',
    booking_date: '2026-11-05',
    value_date: '2026-11-05',
    raw_label: 'PRLV SEPA EDF SERVICE CLIENT',
    clean_label: 'EDF Électricité',
    amount_cents: toCents(-11400),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-11400),
    category: 'Logement & Charges',
    is_manual_category: true,
    matched_rule_id: null,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: '88888888-8888-4888-8888-888888888884',
    revision: toSyncRevision(1430),
    updated_at: '2026-11-05T10:15:00.000Z',
  },
  {
    id: TX_ID_6,
    account_id: ACC_BOURSO_PERSO,
    bank: 'boursobank',
    account_type: 'courant',
    external_ref_masked: '•••• 4821',
    booking_date: '2026-11-02',
    value_date: '2026-11-02',
    raw_label: 'VIR SALAIRE NOVEMBRE',
    clean_label: 'Salaire Novembre',
    amount_cents: toCents(385000),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(385000),
    category: 'Revenus',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: '88888888-8888-4888-8888-888888888885',
    revision: toSyncRevision(1420),
    updated_at: '2026-11-02T08:00:00.000Z',
  },
];

const INITIAL_NOTES: ReadonlyArray<TransactionNote> = [
  {
    transaction_id: TX_ID_1,
    content: 'Abonnement dev annuel à basculer',
    revision: toSyncRevision(1460),
    updated_at: '2026-11-19T09:10:00.000Z',
  },
  {
    transaction_id: TX_ID_5,
    content: 'Régularisation trimestrielle incluse',
    revision: toSyncRevision(1431),
    updated_at: '2026-11-05T10:20:00.000Z',
  },
];

const INITIAL_RULES: ReadonlyArray<CategorizationRule> = [
  {
    id: RULE_ID_CURSOR,
    name: 'Outils IA & Dev',
    priority: 10,
    bank_filter: 'revolut',
    account_id_filter: ACC_REVOLUT_USD,
    account_type_filter: null,
    match_mode: 'contains',
    pattern: 'CURSOR AI',
    target_category: 'Logiciels & Cloud',
    mark_as_internal_transfer: false,
    is_active: true,
    revision: toSyncRevision(1200),
    updated_at: '2026-11-01T09:00:00.000Z',
  },
  {
    id: RULE_ID_BIOCOOP,
    name: 'Courses Biocoop',
    priority: 20,
    bank_filter: 'boursobank',
    account_id_filter: null,
    account_type_filter: null,
    match_mode: 'contains',
    pattern: 'BIOCOOP',
    target_category: 'Alimentation',
    mark_as_internal_transfer: false,
    is_active: true,
    revision: toSyncRevision(1201),
    updated_at: '2026-11-01T09:05:00.000Z',
  },
];

const INITIAL_DRIVE_FILES: ReadonlyArray<DriveSyncFileStatus> = [
  {
    drive_file_id: parseDriveFileId('1AbCdEfBoursoNov2026'),
    drive_folder_id: ALLOWED_DRIVE_FOLDERS.boursobank,
    bank: 'boursobank',
    file_name: 'BoursoBank_Releve_2026_11.pdf',
    status: 'committed',
    attempt_count: 1,
    error_code: null,
    error_message: null,
    revision: toSyncRevision(1445),
    updated_at: '2026-11-20T18:02:11.000Z',
  },
  {
    drive_file_id: parseDriveFileId('1XyZRevolutUsdNov2026'),
    drive_folder_id: ALLOWED_DRIVE_FOLDERS.revolut,
    bank: 'revolut',
    file_name: 'Revolut_Statement_USD_2026_11.pdf',
    status: 'committed',
    attempt_count: 1,
    error_code: null,
    error_message: null,
    revision: toSyncRevision(1460),
    updated_at: '2026-11-20T18:02:15.000Z',
  },
];

const CUMULATIVE_6M_EUR: ReadonlyArray<CumulativeBalancePoint> = [
  { month: '2026-06', label: 'Juin', closing_balance_cents: toCents(712000), net_change_cents: toCents(14200) },
  { month: '2026-07', label: 'Juil.', closing_balance_cents: toCents(768500), net_change_cents: toCents(56500) },
  { month: '2026-08', label: 'Août', closing_balance_cents: toCents(749000), net_change_cents: toCents(-19500) },
  { month: '2026-09', label: 'Sept.', closing_balance_cents: toCents(832400), net_change_cents: toCents(83400) },
  { month: '2026-10', label: 'Oct.', closing_balance_cents: toCents(911800), net_change_cents: toCents(79400) },
  { month: '2026-11', label: 'Nov.', closing_balance_cents: toCents(1032663), net_change_cents: toCents(120863) },
];

const CUMULATIVE_6M_USD: ReadonlyArray<CumulativeBalancePoint> = [
  { month: '2026-06', label: 'Juin', closing_balance_cents: toCents(92000), net_change_cents: toCents(12000) },
  { month: '2026-07', label: 'Juil.', closing_balance_cents: toCents(114000), net_change_cents: toCents(22000) },
  { month: '2026-08', label: 'Août', closing_balance_cents: toCents(108500), net_change_cents: toCents(-5500) },
  { month: '2026-09', label: 'Sept.', closing_balance_cents: toCents(131000), net_change_cents: toCents(22500) },
  { month: '2026-10', label: 'Oct.', closing_balance_cents: toCents(127000), net_change_cents: toCents(-4000) },
  { month: '2026-11', label: 'Nov.', closing_balance_cents: toCents(185000), net_change_cents: toCents(58000) },
];

const EXPENSES_M1_VS_AVG3M_EUR: ReadonlyArray<ExpenseComparisonItem> = [
  {
    category: 'Alimentation',
    m_minus_1_cents: toCents(48200),
    avg_3m_cents: toCents(43800),
    delta_percent: 10.05,
    transaction_count_m1: 19,
  },
  {
    category: 'Logement & Charges',
    m_minus_1_cents: toCents(92000),
    avg_3m_cents: toCents(92000),
    delta_percent: 0,
    transaction_count_m1: 3,
  },
  {
    category: 'Logiciels & Cloud',
    m_minus_1_cents: toCents(7400),
    avg_3m_cents: toCents(6200),
    delta_percent: 19.35,
    transaction_count_m1: 4,
  },
];

const EXPENSES_M1_VS_AVG3M_USD: ReadonlyArray<ExpenseComparisonItem> = [
  {
    category: 'Logiciels & Cloud',
    m_minus_1_cents: toCents(6400),
    avg_3m_cents: toCents(5900),
    delta_percent: 8.47,
    transaction_count_m1: 3,
  },
  {
    category: 'Déplacements',
    m_minus_1_cents: toCents(14200),
    avg_3m_cents: toCents(19500),
    delta_percent: -27.18,
    transaction_count_m1: 2,
  },
];

// ============================================================================
// Lazy-Loaded Recharts Analytics Module (Vite manualChunks: vendor-recharts)
// ============================================================================

interface AnalyticsChartsProps {
  readonly displayCurrency: Currency;
  readonly cumulative6m: ReadonlyArray<CumulativeBalancePoint>;
  readonly expensesComparison: ReadonlyArray<ExpenseComparisonItem>;
  readonly prefersReducedMotion: boolean;
}

interface CustomTooltipPayloadEntry {
  readonly name?: string | number | undefined;
  readonly value?: number | string | ReadonlyArray<number | string> | undefined;
  readonly color?: string | undefined;
}

interface ChartTooltipProps {
  readonly active?: boolean | undefined;
  readonly label?: string | number | undefined;
  readonly payload?: ReadonlyArray<CustomTooltipPayloadEntry> | undefined;
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
    <div
      className="cf-surface"
      style={{
        padding: '10px 12px',
        minInlineSize: '160px',
      }}
    >
      <p style={{ fontWeight: 600, marginBlockEnd: '4px' }}>{String(label ?? '')}</p>
      {payload.map((entry, idx) => {
        const numericValue = typeof entry.value === 'number' ? Math.round(entry.value) : 0;
        const formatted = formatMoney(toCents(numericValue), currency);
        return (
          <div
            key={`${String(entry.name ?? 'serie')}-${idx}`}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '12px',
              fontSize: '0.8125rem',
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>{String(entry.name ?? '')}</span>
            <span className="tabular-amount" style={{ fontWeight: 600 }}>
              {formatted}
            </span>
          </div>
        );
      })}
    </div>
  );
});

const LazyAnalyticsCharts = lazy(async () => {
  const recharts = await import('recharts');
  const {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
  } = recharts;

  const AnalyticsChartsInner = memo(function AnalyticsChartsInner({
    displayCurrency,
    cumulative6m,
    expensesComparison,
    prefersReducedMotion,
  }: AnalyticsChartsProps): ReactElement {
    const balanceData = useMemo(
      () =>
        cumulative6m.map((point) => ({
          label: point.label,
          solde: point.closing_balance_cents,
        })),
      [cumulative6m],
    );

    const expensesData = useMemo(
      () =>
        expensesComparison.map((item) => ({
          category: item.category,
          m1: item.m_minus_1_cents,
          avg3m: item.avg_3m_cents,
          deltaPercent: item.delta_percent,
        })),
      [expensesComparison],
    );

    const formatAxisMoney = useCallback(
      (cents: number): string => {
        const symbol = displayCurrency === 'USD' ? '$' : '€';
        return `${Math.round(cents / 100)} ${symbol}`;
      },
      [displayCurrency],
    );

    return (
      <div className="cf-charts-container">
        <div className="cf-charts-grid">
          <section className="cf-surface cf-chart-card" aria-labelledby="chart-balance-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <h2 id="chart-balance-title" style={{ fontSize: '1rem' }}>
                Solde cumulé 6M ({displayCurrency})
              </h2>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                Taux historique figé
              </span>
            </div>
            <div className="cf-chart-frame">
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={balanceData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
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
                    dataKey="solde"
                    name="Solde cumulé"
                    stroke="#0f5c4d"
                    fill="#e6f2ef"
                    strokeWidth={2}
                    isAnimationActive={!prefersReducedMotion}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="cf-surface cf-chart-card" aria-labelledby="chart-expenses-title">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <h2 id="chart-expenses-title" style={{ fontSize: '1rem' }}>
                Dépenses M-1 / Moyenne 3M ({displayCurrency})
              </h2>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                Hors transferts internes
              </span>
            </div>
            <div className="cf-chart-frame">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={expensesData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#dedad0" />
                  <XAxis dataKey="category" tick={{ fill: '#4a515a', fontSize: 11 }} />
                  <YAxis
                    tickFormatter={formatAxisMoney}
                    tick={{ fill: '#4a515a', fontSize: 11 }}
                    width={64}
                  />
                  <Tooltip content={<ChartTooltip currency={displayCurrency} />} />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar
                    dataKey="m1"
                    name="Mois M-1"
                    fill="#0f5c4d"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={!prefersReducedMotion}
                  />
                  <Bar
                    dataKey="avg3m"
                    name="Moyenne 3M"
                    fill="#64748b"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={!prefersReducedMotion}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                borderBlockStart: '1px solid var(--border-subtle)',
                paddingBlockStart: '10px',
              }}
            >
              {expensesComparison.map((item) => (
                <div
                  key={item.category}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '0.8125rem',
                  }}
                >
                  <span>{item.category}</span>
                  <span className="tabular-amount" style={{ color: 'var(--text-secondary)' }}>
                    {formatSignedDeltaPercent(item.delta_percent)} ·{' '}
                    {formatBudgetAlertLabel(item.m_minus_1_cents, item.avg_3m_cents)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  });

  return { default: AnalyticsChartsInner };
});

// ============================================================================
// Memoized Presentational Components (< 200 lines each, single elevation)
// ============================================================================

const ChartsSkeleton = memo(function ChartsSkeleton(): ReactElement {
  return (
    <div className="cf-charts-container" aria-busy="true" aria-label="Chargement des graphiques">
      <div className="cf-charts-grid">
        <div className="cf-surface cf-chart-card">
          <div className="cf-chart-frame" style={{ background: 'var(--bg-subtle)', borderRadius: '8px' }} />
        </div>
        <div className="cf-surface cf-chart-card">
          <div className="cf-chart-frame" style={{ background: 'var(--bg-subtle)', borderRadius: '8px' }} />
        </div>
      </div>
    </div>
  );
});

interface OfflineBannerProps {
  readonly networkState: NetworkState;
}

const OfflineBanner = memo(function OfflineBanner({ networkState }: OfflineBannerProps): ReactElement | null {
  if (networkState.kind === 'online') {
    return null;
  }

  return (
    <div
      role="status"
      className="cf-surface"
      style={{
        padding: '12px 16px',
        background: 'var(--warning-soft)',
        borderColor: 'var(--warning)',
        color: 'var(--warning)',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        gap: '8px',
      }}
    >
      <span style={{ fontWeight: 600 }}>
        Hors-ligne — Consultation active (édition indisponible sans réseau)
      </span>
      <span className="tabular-amount" style={{ fontSize: '0.8125rem' }}>
        Révision locale #{networkState.revision}
      </span>
    </div>
  );
});

interface NavProps {
  readonly activeTab: AppTab;
  readonly onSelectTab: (tab: AppTab) => void;
  readonly networkState: NetworkState;
}

const NAV_ITEMS: ReadonlyArray<{ readonly tab: AppTab; readonly label: string }> = [
  { tab: { kind: 'overview' }, label: 'Synthèse' },
  { tab: { kind: 'transactions' }, label: 'Transactions' },
  { tab: { kind: 'rules' }, label: 'Règles' },
  { tab: { kind: 'sync' }, label: 'Synchro Drive' },
];

const NavSidebar = memo(function NavSidebar({
  activeTab,
  onSelectTab,
  networkState,
}: NavProps): ReactElement {
  return (
    <aside className="cf-rail" aria-label="Navigation principale">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div>
          <h2 style={{ fontSize: '1.125rem' }}>ClairFlux</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            BoursoBank · Revolut
          </p>
        </div>
        <nav className="cf-rail-nav">
          {NAV_ITEMS.map((item) => {
            const isCurrent = item.tab.kind === activeTab.kind;
            return (
              <button
                key={item.tab.kind}
                type="button"
                className="cf-nav-btn"
                aria-current={isCurrent ? 'page' : undefined}
                onClick={() => onSelectTab(item.tab)}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>
      <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {networkState.kind === 'online' ? 'En ligne' : 'Hors-ligne (lecture seule)'}
        </p>
        <p className="tabular-amount">Rév. #{networkState.revision}</p>
      </div>
    </aside>
  );
});

const MobileBottomNav = memo(function MobileBottomNav({
  activeTab,
  onSelectTab,
}: Omit<NavProps, 'networkState'>): ReactElement {
  return (
    <nav className="cf-bottom-nav" aria-label="Navigation mobile">
      {NAV_ITEMS.map((item) => {
        const isCurrent = item.tab.kind === activeTab.kind;
        return (
          <button
            key={item.tab.kind}
            type="button"
            className="cf-nav-btn"
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onSelectTab(item.tab)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
});

interface ScopeFilterBarProps {
  readonly scope: CurrencyScope;
  readonly accounts: ReadonlyArray<Account>;
  readonly onSelectScope: (nextScope: CurrencyScope) => void;
}

const ScopeFilterBar = memo(function ScopeFilterBar({
  scope,
  accounts,
  onSelectScope,
}: ScopeFilterBarProps): ReactElement {
  const usdAccount = accounts.find((acc) => acc.currency === 'USD');

  return (
    <div className="cf-scope-bar" role="group" aria-label="Périmètre de devise et comptes">
      <button
        type="button"
        className="cf-pill-btn"
        aria-pressed={scope.kind === 'all_eur'}
        onClick={() => onSelectScope({ kind: 'all_eur' })}
      >
        Tous les comptes (EUR consolidé)
      </button>
      <button
        type="button"
        className="cf-pill-btn"
        aria-pressed={scope.kind === 'bank' && scope.bank === 'boursobank'}
        onClick={() => onSelectScope({ kind: 'bank', bank: 'boursobank' })}
      >
        BoursoBank
      </button>
      <button
        type="button"
        className="cf-pill-btn"
        aria-pressed={scope.kind === 'bank' && scope.bank === 'revolut'}
        onClick={() => onSelectScope({ kind: 'bank', bank: 'revolut' })}
      >
        Revolut
      </button>
      <button
        type="button"
        className="cf-pill-btn"
        aria-pressed={scope.kind === 'usd_only'}
        onClick={() => onSelectScope({ kind: 'usd_only' })}
      >
        Vue USD seul ($)
      </button>
      {usdAccount ? (
        <button
          type="button"
          className="cf-pill-btn"
          aria-pressed={scope.kind === 'account' && scope.accountId === usdAccount.id}
          onClick={() => onSelectScope({ kind: 'account', accountId: usdAccount.id })}
        >
          {usdAccount.nickname}
        </button>
      ) : null}
    </div>
  );
});

interface KpiSummaryProps {
  readonly displayCurrency: Currency;
  readonly balanceCents: Cents;
  readonly incomeCents: Cents;
  readonly expensesExclTransfersCents: Cents;
  readonly internalTransfersCents: Cents;
}

const KpiSummaryCard = memo(function KpiSummaryCard({
  displayCurrency,
  balanceCents,
  incomeCents,
  expensesExclTransfersCents,
  internalTransfersCents,
}: KpiSummaryProps): ReactElement {
  return (
    <section className="cf-surface cf-kpi-container" aria-label="Indicateurs clés">
      <div className="cf-kpi-grid">
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Solde consolidé ({displayCurrency})
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.375rem', fontWeight: 700 }}>
            {formatMoney(balanceCents, displayCurrency)}
          </span>
        </div>
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Revenus du mois
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            {formatMoney(incomeCents, displayCurrency)}
          </span>
        </div>
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Dépenses hors transferts
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            {formatMoney(expensesExclTransfersCents, displayCurrency)}
          </span>
        </div>
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Transferts internes exclus
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            {formatMoney(internalTransfersCents, displayCurrency)}
          </span>
        </div>
      </div>
    </section>
  );
});

interface LedgerViewProps {
  readonly transactions: ReadonlyArray<Transaction>;
  readonly accountsById: ReadonlyMap<AccountId, Account>;
  readonly notesByTxId: ReadonlyMap<TransactionId, TransactionNote>;
  readonly displayCurrency: Currency;
  readonly searchQuery: string;
  readonly onSearchChange: (nextQuery: string) => void;
  readonly onOpenTransaction: (id: TransactionId) => void;
}

const LedgerView = memo(function LedgerView({
  transactions,
  accountsById,
  notesByTxId,
  displayCurrency,
  searchQuery,
  onSearchChange,
  onOpenTransaction,
}: LedgerViewProps): ReactElement {
  return (
    <section className="cf-surface cf-ledger-container" aria-labelledby="ledger-heading">
      <div
        style={{
          padding: '16px',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          borderBlockEnd: '1px solid var(--border-subtle)',
        }}
      >
        <div>
          <h2 id="ledger-heading" tabIndex={-1} style={{ fontSize: '1.125rem' }}>
            Grand livre des opérations
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            {transactions.length} opérations affichées · Cliquer pour annoter ou catégoriser
          </p>
        </div>
        <label className="cf-field-group" style={{ minInlineSize: 'min(280px, 100%)' }}>
          <span className="cf-field-label" style={{ fontSize: '0.8125rem' }}>
            Rechercher libellé ou note
          </span>
          <input
            type="search"
            className="cf-field-input"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Ex. Cursor, Biocoop, EDF…"
          />
        </label>
      </div>

      {/* Tableau Desktop (>= 760px container) */}
      <div className="cf-ledger-table-wrap">
        <table className="cf-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Banque</th>
              <th>Type de compte</th>
              <th>Libellé</th>
              <th>Catégorie</th>
              <th>Note personnalisée</th>
              <th style={{ textAlign: 'end' }}>Montant</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx, index) => {
              const account = accountsById.get(tx.account_id);
              const note = notesByTxId.get(tx.id);
              const deferredClass = index >= 8 ? 'cf-tx-row-deferred' : undefined;
              const accountDesc = account
                ? `${account.nickname} (${ACCOUNT_TYPE_LABELS[account.account_type]})`
                : ACCOUNT_TYPE_LABELS[tx.account_type];

              return (
                <tr key={tx.id} className={deferredClass}>
                  <td className="tabular-amount">{tx.booking_date}</td>
                  <td>{BANK_LABELS[tx.bank]}</td>
                  <td>{accountDesc}</td>
                  <td>
                    <button
                      type="button"
                      className="cf-touch-target"
                      onClick={() => onOpenTransaction(tx.id)}
                      style={{
                        border: 0,
                        background: 'transparent',
                        color: 'inherit',
                        font: 'inherit',
                        fontWeight: 600,
                        padding: 0,
                        textAlign: 'start',
                        cursor: 'pointer',
                      }}
                    >
                      {tx.clean_label}
                    </button>
                  </td>
                  <td>{tx.category}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{note ? note.content : '—'}</td>
                  <td style={{ textAlign: 'end' }} className="tabular-amount">
                    <div>{formatMoney(tx.amount_cents, tx.currency)}</div>
                    {tx.currency === 'USD' && displayCurrency === 'EUR' ? (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        ≈ {formatMoney(tx.amount_eur_cents, 'EUR')}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Liste compacte Mobile (< 760px container, zéro débordement horizontal) */}
      <div className="cf-ledger-mobile-list">
        {transactions.map((tx, index) => {
          const account = accountsById.get(tx.account_id);
          const note = notesByTxId.get(tx.id);
          const deferredClass = index >= 8 ? 'cf-tx-row-deferred' : undefined;
          const accountName = account ? account.nickname : ACCOUNT_TYPE_LABELS[tx.account_type];

          return (
            <button
              key={tx.id}
              type="button"
              className={`cf-tx-trigger ${deferredClass ?? ''}`}
              onClick={() => onOpenTransaction(tx.id)}
            >
              <span className="cf-row-line">
                <span className="cf-truncate" style={{ fontWeight: 600 }}>
                  {tx.clean_label}
                </span>
                <span className="tabular-amount" style={{ fontWeight: 600, flexShrink: 0 }}>
                  {formatMoney(tx.amount_cents, tx.currency)}
                </span>
              </span>
              <span
                className="cf-row-line"
                style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}
              >
                <span className="cf-truncate">
                  {tx.booking_date} · {BANK_LABELS[tx.bank]} · {accountName} · {tx.category}
                </span>
                {tx.currency === 'USD' && displayCurrency === 'EUR' ? (
                  <span className="tabular-amount" style={{ flexShrink: 0 }}>
                    ≈ {formatMoney(tx.amount_eur_cents, 'EUR')}
                  </span>
                ) : null}
              </span>
              {note ? (
                <span className="cf-truncate" style={{ fontSize: '0.8125rem', color: 'var(--accent)' }}>
                  Note : {note.content}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
});

interface RulesViewProps {
  readonly rules: ReadonlyArray<CategorizationRule>;
  readonly transactions: ReadonlyArray<Transaction>;
  readonly isOffline: boolean;
  readonly onCreateRule: (input: {
    readonly name: string;
    readonly pattern: string;
    readonly targetCategory: string;
  }) => void;
}

const RulesView = memo(function RulesView({
  rules,
  transactions,
  isOffline,
  onCreateRule,
}: RulesViewProps): ReactElement {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [targetCategory, setTargetCategory] = useState('Alimentation');
  const [nameTouched, setNameTouched] = useState(false);
  const [patternTouched, setPatternTouched] = useState(false);
  const [submittedInvalid, setSubmittedInvalid] = useState(false);

  const isNameInvalid = (nameTouched || submittedInvalid) && name.trim().length < 2;
  const isPatternInvalid = (patternTouched || submittedInvalid) && pattern.trim().length < 2;

  const previewMatchCount = useMemo(() => {
    const normalized = pattern.trim().toUpperCase();
    if (normalized.length < 2) {
      return 0;
    }
    return transactions.filter(
      (tx) =>
        !tx.is_manual_category &&
        !tx.is_internal_transfer &&
        tx.raw_label.toUpperCase().includes(normalized),
    ).length;
  }, [pattern, transactions]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isOffline) {
      return;
    }
    if (name.trim().length < 2 || pattern.trim().length < 2) {
      setSubmittedInvalid(true);
      return;
    }
    setSubmittedInvalid(false);
    setNameTouched(false);
    setPatternTouched(false);
    onCreateRule({
      name: name.trim(),
      pattern: pattern.trim(),
      targetCategory,
    });
    setName('');
    setPattern('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section className="cf-surface" style={{ padding: '16px' }} aria-labelledby="rules-heading">
        <h2 id="rules-heading" tabIndex={-1} style={{ fontSize: '1.125rem', marginBlockEnd: '12px' }}>
          Règles de catégorisation automatique
        </h2>
        <form
          onSubmit={handleSubmit}
          noValidate
          style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
        >
          <div className="cf-field-group">
            <label htmlFor="rule-name" className="cf-field-label">
              Nom de la règle
            </label>
            <input
              id="rule-name"
              type="text"
              required
              minLength={2}
              maxLength={100}
              disabled={isOffline}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setNameTouched(true)}
              aria-invalid={isNameInvalid}
              aria-describedby={isNameInvalid ? 'rule-name-error' : undefined}
              className={`cf-field-input ${isNameInvalid ? 'user-invalid-fallback' : ''}`}
              placeholder="Ex. Abonnements IA"
            />
            <span id="rule-name-error" className="cf-field-error">
              Erreur : Saisir au moins 2 caractères pour le nom de règle.
            </span>
          </div>

          <div className="cf-field-group">
            <label htmlFor="rule-pattern" className="cf-field-label">
              Motif dans le libellé bancaire
            </label>
            <input
              id="rule-pattern"
              type="text"
              required
              minLength={2}
              maxLength={200}
              disabled={isOffline}
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              onBlur={() => setPatternTouched(true)}
              aria-invalid={isPatternInvalid}
              aria-describedby={isPatternInvalid ? 'rule-pattern-error' : undefined}
              className={`cf-field-input ${isPatternInvalid ? 'user-invalid-fallback' : ''}`}
              placeholder="Ex. BIOCOOP"
            />
            <span id="rule-pattern-error" className="cf-field-error">
              Erreur : Indiquer un motif de libellé d'au moins 2 caractères.
            </span>
          </div>

          <div className="cf-field-group">
            <label htmlFor="rule-category" className="cf-field-label">
              Catégorie cible
            </label>
            <select
              id="rule-category"
              disabled={isOffline}
              value={targetCategory}
              onChange={(event) => setTargetCategory(event.target.value)}
              className="cf-field-input"
            >
              <option value="Alimentation">Alimentation</option>
              <option value="Logiciels & Cloud">Logiciels & Cloud</option>
              <option value="Logement & Charges">Logement & Charges</option>
              <option value="Déplacements">Déplacements</option>
            </select>
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <span className="tabular-amount" style={{ color: 'var(--text-secondary)' }}>
              Aperçu rétroactif : {previewMatchCount} opération(s) éligible(s) (catégories manuelles préservées)
            </span>
            <button type="submit" className="cf-btn cf-btn-primary" disabled={isOffline}>
              {isOffline ? 'Connexion requise pour modifier' : 'Enregistrer la règle'}
            </button>
          </div>
        </form>
      </section>

      <section className="cf-surface" style={{ padding: '16px' }} aria-label="Règles actives">
        <h3 style={{ fontSize: '1rem', marginBlockEnd: '12px' }}>Règles actives ({rules.length})</h3>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                paddingBlock: '12px',
                borderBlockEnd: '1px solid var(--border-subtle)',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div>
                <p style={{ fontWeight: 600 }}>{rule.name}</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                  Motif « {rule.pattern} » → {rule.target_category}
                </p>
              </div>
              <span className="tabular-amount" style={{ color: 'var(--text-secondary)' }}>
                Priorité #{rule.priority} · {rule.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
});

interface SyncDriveViewProps {
  readonly files: ReadonlyArray<DriveSyncFileStatus>;
  readonly isOffline: boolean;
  readonly onTriggerManualSync: () => void;
}

const SyncDriveView = memo(function SyncDriveView({
  files,
  isOffline,
  onTriggerManualSync,
}: SyncDriveViewProps): ReactElement {
  return (
    <section className="cf-surface" style={{ padding: '16px' }} aria-labelledby="sync-heading">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          paddingBlockEnd: '16px',
          borderBlockEnd: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ minInlineSize: 0 }}>
          <h2 id="sync-heading" tabIndex={-1} style={{ fontSize: '1.125rem' }}>
            Synchronisation Google Drive (manuelle uniquement)
          </h2>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.8125rem',
              overflowWrap: 'anywhere',
            }}
          >
            Périmètre exclusif lecture seule : BoursoBank ({ALLOWED_DRIVE_FOLDERS.boursobank}) et Revolut (
            {ALLOWED_DRIVE_FOLDERS.revolut})
          </p>
        </div>
        <button
          type="button"
          className="cf-btn cf-btn-primary"
          disabled={isOffline}
          onClick={onTriggerManualSync}
        >
          {isOffline ? 'Connexion requise pour modifier' : 'Synchroniser maintenant'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {files.map((file, index) => (
          <div
            key={file.drive_file_id}
            className={index >= 8 ? 'cf-tx-row-deferred' : undefined}
            style={{
              paddingBlock: '12px',
              borderBlockEnd: '1px solid var(--border-subtle)',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <div style={{ minInlineSize: 0 }}>
              <p style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{file.file_name}</p>
              <p
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '0.8125rem',
                  overflowWrap: 'anywhere',
                }}
              >
                {BANK_LABELS[file.bank]} · Dossier {file.drive_folder_id}
              </p>
            </div>
            <span className="tabular-amount" style={{ color: 'var(--text-secondary)' }}>
              Statut : {file.status}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
});

interface TransactionDrawerProps {
  readonly transaction: Transaction | null;
  readonly note: TransactionNote | null;
  readonly isOffline: boolean;
  readonly onClose: () => void;
  readonly onSave: (input: {
    readonly transactionId: TransactionId;
    readonly category: string;
    readonly noteContent: string;
  }) => void;
}

const TransactionDrawerDialog = memo(function TransactionDrawerDialog({
  transaction,
  note,
  isOffline,
  onClose,
  onSave,
}: TransactionDrawerProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [category, setCategory] = useState(transaction?.category ?? 'Alimentation');
  const [noteText, setNoteText] = useState(note?.content ?? '');

  useEffect(() => {
    setCategory(transaction?.category ?? 'Alimentation');
    setNoteText(note?.content ?? '');
  }, [transaction, note]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (transaction !== null && !dialog.open) {
      dialog.showModal();
    } else if (transaction === null && dialog.open) {
      dialog.close();
    }
  }, [transaction]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!transaction || isOffline) {
      return;
    }
    onSave({
      transactionId: transaction.id,
      category,
      noteContent: noteText.trim(),
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className="cf-dialog"
      aria-labelledby="tx-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      {transaction ? (
        <form
          onSubmit={handleSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <h2 id="tx-dialog-title" style={{ fontSize: '1.125rem' }}>
              {transaction.clean_label}
            </h2>
            <button type="button" className="cf-btn" onClick={onClose}>
              Fermer
            </button>
          </div>

          <div
            style={{
              paddingBlock: '12px',
              borderBlock: '1px solid var(--border-subtle)',
              display: 'flex',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>
              {BANK_LABELS[transaction.bank]} · {transaction.booking_date}
            </span>
            <span className="tabular-amount" style={{ fontWeight: 700 }}>
              {formatMoney(transaction.amount_cents, transaction.currency)}
            </span>
          </div>

          <div className="cf-field-group">
            <label htmlFor="tx-category" className="cf-field-label">
              Catégorie (verrouillée manuellement après édition)
            </label>
            <select
              id="tx-category"
              disabled={isOffline}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="cf-field-input"
            >
              <option value="Alimentation">Alimentation</option>
              <option value="Logiciels & Cloud">Logiciels & Cloud</option>
              <option value="Logement & Charges">Logement & Charges</option>
              <option value="Revenus">Revenus</option>
              <option value="Transfert interne">Transfert interne</option>
            </select>
          </div>

          <div className="cf-field-group">
            <label htmlFor="tx-note" className="cf-field-label">
              Note personnalisée
            </label>
            <textarea
              id="tx-note"
              rows={3}
              maxLength={2000}
              disabled={isOffline}
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              className="cf-field-input"
              placeholder="Ajouter une précision comptable ou personnelle…"
            />
          </div>

          <button type="submit" className="cf-btn cf-btn-primary" disabled={isOffline}>
            {isOffline ? 'Connexion requise pour modifier' : 'Enregistrer les modifications'}
          </button>
        </form>
      ) : null}
    </dialog>
  );
});

// ============================================================================
// Root Application Container
// ============================================================================

function ClairFluxApp(): ReactElement {
  const prefersReducedMotion = usePrefersReducedMotion();

  const [activeTab, setActiveTab] = useState<AppTab>({ kind: 'overview' });
  const [scope, setScope] = useState<CurrencyScope>({ kind: 'all_eur' });
  const [networkState, setNetworkState] = useState<NetworkState>(() => {
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return isOffline
      ? { kind: 'offline_readonly', cachedAt: '2026-11-21T14:00:00.000Z', revision: 1482 }
      : { kind: 'online', lastSyncedAt: '2026-11-21T14:00:00.000Z', revision: 1482 };
  });

  const [accounts] = useState<ReadonlyArray<Account>>(INITIAL_ACCOUNTS);
  const [transactions, setTransactions] = useState<ReadonlyArray<Transaction>>(INITIAL_TRANSACTIONS);
  const [notes, setNotes] = useState<ReadonlyArray<TransactionNote>>(INITIAL_NOTES);
  const [rules, setRules] = useState<ReadonlyArray<CategorizationRule>>(INITIAL_RULES);
  const [driveFiles] = useState<ReadonlyArray<DriveSyncFileStatus>>(INITIAL_DRIVE_FILES);
  const [dialogState, setDialogState] = useState<DialogState>({ kind: 'closed' });
  const [searchQuery, setSearchQuery] = useState('');
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  const deferredSearch = useDeferredValue(searchQuery);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleOnline = (): void => {
      setNetworkState((prev) => ({
        kind: 'online',
        lastSyncedAt: new Date().toISOString(),
        revision: prev.revision,
      }));
      setLiveAnnouncement('Connexion rétablie. Édition réactivée.');
    };
    const handleOffline = (): void => {
      setNetworkState((prev) => ({
        kind: 'offline_readonly',
        cachedAt: new Date().toISOString(),
        revision: prev.revision,
      }));
      setLiveAnnouncement('Mode hors-ligne actif : consultation en lecture seule.');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const accountsById = useMemo(() => {
    const map = new Map<AccountId, Account>();
    for (const acc of accounts) {
      map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  const notesByTxId = useMemo(() => {
    const map = new Map<TransactionId, TransactionNote>();
    for (const note of notes) {
      map.set(note.transaction_id, note);
    }
    return map;
  }, [notes]);

  const displayCurrency: Currency = useMemo(() => {
    switch (scope.kind) {
      case 'usd_only':
        return 'USD';
      case 'account': {
        const account = accountsById.get(scope.accountId);
        return account?.currency ?? 'EUR';
      }
      case 'all_eur':
      case 'bank':
        return 'EUR';
      default:
        return assertNever(scope);
    }
  }, [scope, accountsById]);

  const scopedTransactions = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return transactions.filter((tx) => {
      let matchesScope = true;
      switch (scope.kind) {
        case 'all_eur':
          matchesScope = true;
          break;
        case 'usd_only':
          matchesScope = tx.currency === 'USD';
          break;
        case 'bank':
          matchesScope = tx.bank === scope.bank;
          break;
        case 'account':
          matchesScope = tx.account_id === scope.accountId;
          break;
        default:
          return assertNever(scope);
      }

      if (!matchesScope) {
        return false;
      }
      if (query.length === 0) {
        return true;
      }
      const noteContent = notesByTxId.get(tx.id)?.content.toLowerCase() ?? '';
      return (
        tx.clean_label.toLowerCase().includes(query) ||
        tx.raw_label.toLowerCase().includes(query) ||
        tx.category.toLowerCase().includes(query) ||
        noteContent.includes(query)
      );
    });
  }, [transactions, scope, deferredSearch, notesByTxId]);

  const kpiMetrics = useMemo(() => {
    const relevantAccounts = accounts.filter((acc) => {
      switch (scope.kind) {
        case 'all_eur':
          return true;
        case 'usd_only':
          return acc.currency === 'USD';
        case 'bank':
          return acc.bank === scope.bank;
        case 'account':
          return acc.id === scope.accountId;
        default:
          return assertNever(scope);
      }
    });

    let balanceSum = 0;
    for (const acc of relevantAccounts) {
      balanceSum +=
        displayCurrency === 'USD' ? acc.current_balance_cents : acc.current_balance_eur_cents;
    }

    let incomeSum = 0;
    let expenseSum = 0;
    let transferSum = 0;

    for (const tx of scopedTransactions) {
      const value = displayCurrency === 'USD' ? tx.amount_cents : tx.amount_eur_cents;
      if (tx.is_internal_transfer) {
        transferSum += Math.abs(value);
      } else if (value > 0) {
        incomeSum += value;
      } else {
        expenseSum += Math.abs(value);
      }
    }

    return {
      balanceCents: toCents(balanceSum),
      incomeCents: toCents(incomeSum),
      expensesExclTransfersCents: toCents(expenseSum),
      internalTransfersCents: toCents(transferSum),
    };
  }, [accounts, scopedTransactions, scope, displayCurrency]);

  const handleSelectTab = useCallback(
    (nextTab: AppTab): void => {
      const headingIdByKind: Record<AppTab['kind'], string> = {
        overview: 'overview-heading',
        transactions: 'ledger-heading',
        rules: 'rules-heading',
        sync: 'sync-heading',
      };
      runWithViewTransition(
        () => setActiveTab(nextTab),
        prefersReducedMotion,
        headingIdByKind[nextTab.kind],
      );
    },
    [prefersReducedMotion],
  );

  const handleToggleOfflinePreview = useCallback((): void => {
    setNetworkState((prev) => {
      if (prev.kind === 'online') {
        setLiveAnnouncement('Simulation hors-ligne activée : lecture seule.');
        return {
          kind: 'offline_readonly',
          cachedAt: new Date().toISOString(),
          revision: prev.revision,
        };
      }
      setLiveAnnouncement('Mode en ligne rétabli.');
      return {
        kind: 'online',
        lastSyncedAt: new Date().toISOString(),
        revision: prev.revision,
      };
    });
  }, []);

  const handleSaveTransactionEdit = useCallback(
    (input: {
      readonly transactionId: TransactionId;
      readonly category: string;
      readonly noteContent: string;
    }): void => {
      const nowIso = new Date().toISOString();
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.id === input.transactionId
            ? {
                ...tx,
                category: input.category,
                is_manual_category: true,
                updated_at: nowIso,
              }
            : tx,
        ),
      );
      setNotes((prev) => {
        const remaining = prev.filter((n) => n.transaction_id !== input.transactionId);
        if (input.noteContent.length === 0) {
          return remaining;
        }
        return [
          ...remaining,
          {
            transaction_id: input.transactionId,
            content: input.noteContent,
            revision: toSyncRevision(networkState.revision + 1),
            updated_at: nowIso,
          },
        ];
      });
      setDialogState({ kind: 'closed' });
      setLiveAnnouncement('Opération mise à jour.');
    },
    [networkState.revision],
  );

  const handleCreateRule = useCallback(
    (input: {
      readonly name: string;
      readonly pattern: string;
      readonly targetCategory: string;
    }): void => {
      const generatedUuid = crypto.randomUUID();
      const newRule: CategorizationRule = {
        id: parseRuleId(generatedUuid),
        name: input.name,
        priority: 50,
        bank_filter: null,
        account_id_filter: null,
        account_type_filter: null,
        match_mode: 'contains',
        pattern: input.pattern,
        target_category: input.targetCategory,
        mark_as_internal_transfer: false,
        is_active: true,
        revision: toSyncRevision(networkState.revision + 1),
        updated_at: new Date().toISOString(),
      };
      setRules((prev) => [...prev, newRule]);
      setLiveAnnouncement(`Règle « ${input.name} » créée.`);
    },
    [networkState.revision],
  );

  const handleTriggerManualSync = useCallback((): void => {
    void yieldToMain().then(() => {
      setLiveAnnouncement('Synchronisation manuelle Drive demandée.');
    });
  }, []);

  const activeDialogTransaction = useMemo(() => {
    if (dialogState.kind === 'closed') {
      return null;
    }
    return transactions.find((tx) => tx.id === dialogState.transactionId) ?? null;
  }, [dialogState, transactions]);

  const activeDialogNote = useMemo(() => {
    if (!activeDialogTransaction) {
      return null;
    }
    return notesByTxId.get(activeDialogTransaction.id) ?? null;
  }, [activeDialogTransaction, notesByTxId]);

  const isOffline = networkState.kind === 'offline_readonly';

  const renderActiveTab = (): ReactElement => {
    switch (activeTab.kind) {
      case 'overview':
        return (
          <>
            <h2 id="overview-heading" tabIndex={-1} style={{ fontSize: '1.125rem' }}>
              Synthèse financière
            </h2>
            <ScopeFilterBar scope={scope} accounts={accounts} onSelectScope={setScope} />
            <KpiSummaryCard
              displayCurrency={displayCurrency}
              balanceCents={kpiMetrics.balanceCents}
              incomeCents={kpiMetrics.incomeCents}
              expensesExclTransfersCents={kpiMetrics.expensesExclTransfersCents}
              internalTransfersCents={kpiMetrics.internalTransfersCents}
            />
            <Suspense fallback={<ChartsSkeleton />}>
              <LazyAnalyticsCharts
                displayCurrency={displayCurrency}
                cumulative6m={
                  displayCurrency === 'USD' ? CUMULATIVE_6M_USD : CUMULATIVE_6M_EUR
                }
                expensesComparison={
                  displayCurrency === 'USD' ? EXPENSES_M1_VS_AVG3M_USD : EXPENSES_M1_VS_AVG3M_EUR
                }
                prefersReducedMotion={prefersReducedMotion}
              />
            </Suspense>
          </>
        );
      case 'transactions':
        return (
          <>
            <ScopeFilterBar scope={scope} accounts={accounts} onSelectScope={setScope} />
            <LedgerView
              transactions={scopedTransactions}
              accountsById={accountsById}
              notesByTxId={notesByTxId}
              displayCurrency={displayCurrency}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onOpenTransaction={(transactionId) =>
                setDialogState({ kind: 'edit_transaction', transactionId })
              }
            />
          </>
        );
      case 'rules':
        return (
          <RulesView
            rules={rules}
            transactions={transactions}
            isOffline={isOffline}
            onCreateRule={handleCreateRule}
          />
        );
      case 'sync':
        return (
          <SyncDriveView
            files={driveFiles}
            isOffline={isOffline}
            onTriggerManualSync={handleTriggerManualSync}
          />
        );
      default:
        return assertNever(activeTab);
    }
  };

  return (
    <div className="cf-shell">
      <NavSidebar activeTab={activeTab} onSelectTab={handleSelectTab} networkState={networkState} />

      <main className="cf-main">
        <header className="cf-header">
          <div>
            <h1 style={{ fontSize: '1.5rem' }}>ClairFlux</h1>
            <p style={{ color: 'var(--text-secondary)' }}>
              Suivi consolidé BoursoBank & Revolut (EUR / USD)
            </p>
          </div>
          <div className="cf-header-actions">
            <button type="button" className="cf-btn" onClick={handleToggleOfflinePreview}>
              {isOffline ? 'Passer en ligne' : 'Simuler hors-ligne'}
            </button>
          </div>
        </header>

        <OfflineBanner networkState={networkState} />

        {renderActiveTab()}

        <div
          aria-live="polite"
          style={{
            position: 'absolute',
            inlineSize: '1px',
            blockSize: '1px',
            overflow: 'hidden',
            clipPath: 'inset(50%)',
          }}
        >
          {liveAnnouncement}
        </div>
      </main>

      <MobileBottomNav activeTab={activeTab} onSelectTab={handleSelectTab} />

      <TransactionDrawerDialog
        transaction={activeDialogTransaction}
        note={activeDialogNote}
        isOffline={isOffline}
        onClose={() => setDialogState({ kind: 'closed' })}
        onSave={handleSaveTransactionEdit}
      />
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Élément #root introuvable dans index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <ClairFluxApp />
  </StrictMode>,
);
