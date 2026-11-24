import {
  ALLOWED_DRIVE_FOLDERS,
  assertNever,
  convertToEurCents,
  parseAccountId,
  parseDriveFileId,
  parseRuleId,
  parseTransactionId,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  type Account,
  type AccountType,
  type Bank,
  type CategorizationRule,
  type Cents,
  type CumulativeBalancePoint,
  type Currency,
  type DriveSyncFileStatus,
  type Transaction,
  type TransactionNote,
} from '@clairflux/shared';
import { useEffect, useState } from 'react';
import {
  addDaysIso,
  addMonthsClampedIso,
  addMonthsToYm,
  enumerateDaySlots,
  enumerateMonthSlots,
  isTransactionInBounds,
  type ResolvedDateBounds,
} from './periodFilter';

export * from './periodFilter';

// ============================================================================
// Shared UI Contracts (Dashboard, Ledger, Offline Store)
// ============================================================================

export type AppTab =
  | { readonly kind: 'overview' }
  | { readonly kind: 'transactions' }
  | { readonly kind: 'sync' };

export type TransactionsSubTab = 'operations' | 'rules';

export type ExpenseComparisonMode = 'none' | 'prev_month' | 'avg_3m';

export type DashboardBankFilter = 'all' | 'boursobank' | 'revolut';

export type CurrencyViewMode = 'eur_consolidated' | 'usd_only';

export type BudgetLimit = {
  readonly id: string;
  readonly category: string;
  readonly limitCents: Cents;
  readonly spentCents: Cents;
  readonly currency: 'EUR';
};

export type MonthlyExpensePoint = {
  readonly month: string;
  readonly label: string;
  readonly amountCents: Cents;
  readonly prevMonthCents: Cents;
  readonly avg3mCents: Cents;
};

export type ClairFluxDataset = {
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly notes: readonly TransactionNote[];
  readonly rules: readonly CategorizationRule[];
  readonly budgets: readonly BudgetLimit[];
  readonly driveFiles: readonly DriveSyncFileStatus[];
  readonly revision: number;
  readonly syncedAt: string;
};

export interface KpiMetricsSummary {
  readonly displayCurrency: Currency;
  readonly balanceCents: Cents;
  readonly incomeCents: Cents;
  readonly expensesExclTransfersCents: Cents;
  readonly internalTransfersCents: Cents;
}

export const BANK_LABELS: Readonly<Record<Bank, string>> = {
  boursobank: 'BoursoBank',
  revolut: 'Revolut',
};

export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>> = {
  courant: 'Courant',
  epargne: 'Épargne',
  carte_differee: 'Carte différée',
  multi_devises: 'Multi-devises',
  coffre: 'Coffre',
  autre: 'Autre',
};

// ============================================================================
// Baseline Platform Helpers (INP yield, Reduced Motion, View Transitions)
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

export function usePrefersReducedMotion(): boolean {
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

export function runWithViewTransition(
  updateDom: () => void,
  reducedMotion: boolean,
  focusHeadingId: string,
): void {
  const focusTarget = (): void => {
    requestAnimationFrame(() => {
      document.getElementById(focusHeadingId)?.focus();
    });
  };

  if (
    reducedMotion ||
    typeof document === 'undefined' ||
    !('startViewTransition' in document)
  ) {
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
// Pure Financial Aggregators (Integer Cents Only)
// ============================================================================

const MONTH_WINDOW: readonly { readonly month: string; readonly label: string }[] = [
  { month: '2026-06', label: 'Juin' },
  { month: '2026-07', label: 'Juil.' },
  { month: '2026-08', label: 'Août' },
  { month: '2026-09', label: 'Sept.' },
  { month: '2026-10', label: 'Oct.' },
  { month: '2026-11', label: 'Nov.' },
];

function getTxDisplayCents(tx: Transaction, currencyMode: CurrencyViewMode): number {
  return currencyMode === 'usd_only' ? tx.amount_cents : tx.amount_eur_cents;
}

function matchesDashboardScope(
  tx: Transaction,
  bankFilter: DashboardBankFilter,
  currencyMode: CurrencyViewMode,
): boolean {
  if (bankFilter !== 'all' && tx.bank !== bankFilter) {
    return false;
  }
  if (currencyMode === 'usd_only' && tx.currency !== 'USD') {
    return false;
  }
  return true;
}

export function computeKpiMetrics(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  bankFilter: DashboardBankFilter,
  currencyMode: CurrencyViewMode,
  dateBounds?: ResolvedDateBounds,
): KpiMetricsSummary {
  const displayCurrency: Currency = currencyMode === 'usd_only' ? 'USD' : 'EUR';
  const latestMonth = MONTH_WINDOW[MONTH_WINDOW.length - 1]?.month ?? '2026-11';

  let balanceSum = 0;
  for (const acc of accounts) {
    if (bankFilter !== 'all' && acc.bank !== bankFilter) {
      continue;
    }
    if (currencyMode === 'usd_only' && acc.currency !== 'USD') {
      continue;
    }
    balanceSum +=
      displayCurrency === 'USD'
        ? acc.current_balance_cents
        : acc.current_balance_eur_cents;
  }

  let incomeSum = 0;
  let expenseSum = 0;
  let transferSum = 0;

  for (const tx of transactions) {
    if (!matchesDashboardScope(tx, bankFilter, currencyMode)) {
      continue;
    }
    if (dateBounds !== undefined) {
      if (!isTransactionInBounds(tx, dateBounds)) {
        continue;
      }
    } else if (!tx.booking_date.startsWith(latestMonth)) {
      continue;
    }
    const value = getTxDisplayCents(tx, currencyMode);
    if (tx.is_internal_transfer) {
      transferSum += Math.abs(value);
    } else if (value > 0) {
      incomeSum += value;
    } else {
      expenseSum += Math.abs(value);
    }
  }

  return {
    displayCurrency,
    balanceCents: toCents(balanceSum),
    incomeCents: toCents(incomeSum),
    expensesExclTransfersCents: toCents(expenseSum),
    internalTransfersCents: toCents(transferSum),
  };
}

export function buildCumulativeBalanceSeries(
  accounts: readonly Account[],
  transactions: readonly Transaction[],
  bankFilter: DashboardBankFilter,
  currencyMode: CurrencyViewMode,
  dateBounds?: ResolvedDateBounds,
): readonly CumulativeBalancePoint[] {
  let closingBalance = 0;
  for (const acc of accounts) {
    if (bankFilter !== 'all' && acc.bank !== bankFilter) {
      continue;
    }
    if (currencyMode === 'usd_only' && acc.currency !== 'USD') {
      continue;
    }
    closingBalance +=
      currencyMode === 'usd_only'
        ? acc.current_balance_cents
        : acc.current_balance_eur_cents;
  }

  if (dateBounds !== undefined) {
    let postPeriodNet = 0;
    const netBySlot = new Map<string, number>();

    for (const tx of transactions) {
      if (!matchesDashboardScope(tx, bankFilter, currencyMode)) {
        continue;
      }
      const value = getTxDisplayCents(tx, currencyMode);
      if (tx.booking_date > dateBounds.to) {
        postPeriodNet += value;
        continue;
      }
      const key =
        dateBounds.granularity === 'day'
          ? tx.booking_date
          : tx.booking_date.slice(0, 7);
      netBySlot.set(key, (netBySlot.get(key) ?? 0) + value);
    }

    const slots =
      dateBounds.granularity === 'day'
        ? enumerateDaySlots(dateBounds.from, dateBounds.to)
        : enumerateMonthSlots(dateBounds.from, dateBounds.to);

    const points: CumulativeBalancePoint[] = new Array<CumulativeBalancePoint>(slots.length);
    let runningClosing = closingBalance - postPeriodNet;

    for (let idx = slots.length - 1; idx >= 0; idx -= 1) {
      const slot = slots[idx];
      if (!slot) {
        continue;
      }
      const slotNet = netBySlot.get(slot.key) ?? 0;
      points[idx] = {
        month: slot.key,
        label: slot.label,
        closing_balance_cents: toCents(runningClosing),
        net_change_cents: toCents(slotNet),
      };
      runningClosing -= slotNet;
    }

    return points;
  }

  const netByMonth = new Map<string, number>();
  for (const tx of transactions) {
    if (!matchesDashboardScope(tx, bankFilter, currencyMode)) {
      continue;
    }
    const monthKey = tx.booking_date.slice(0, 7);
    const prev = netByMonth.get(monthKey) ?? 0;
    netByMonth.set(monthKey, prev + getTxDisplayCents(tx, currencyMode));
  }

  const points: CumulativeBalancePoint[] = new Array<CumulativeBalancePoint>(MONTH_WINDOW.length);
  let runningClosing = closingBalance;

  for (let idx = MONTH_WINDOW.length - 1; idx >= 0; idx -= 1) {
    const slot = MONTH_WINDOW[idx];
    if (!slot) {
      continue;
    }
    const monthNet = netByMonth.get(slot.month) ?? 0;
    points[idx] = {
      month: slot.month,
      label: slot.label,
      closing_balance_cents: toCents(runningClosing),
      net_change_cents: toCents(monthNet),
    };
    runningClosing -= monthNet;
  }

  return points;
}

export function buildMonthlyExpenseSeries(
  transactions: readonly Transaction[],
  bankFilter: DashboardBankFilter,
  currencyMode: CurrencyViewMode,
  dateBounds?: ResolvedDateBounds,
): readonly MonthlyExpensePoint[] {
  if (dateBounds !== undefined) {
    if (dateBounds.granularity === 'day') {
      const expensesByDay = new Map<string, number>();
      for (const tx of transactions) {
        if (!matchesDashboardScope(tx, bankFilter, currencyMode)) {
          continue;
        }
        if (tx.is_internal_transfer) {
          continue;
        }
        const value = getTxDisplayCents(tx, currencyMode);
        if (value >= 0) {
          continue;
        }
        expensesByDay.set(
          tx.booking_date,
          (expensesByDay.get(tx.booking_date) ?? 0) + Math.abs(value),
        );
      }

      const slots = enumerateDaySlots(dateBounds.from, dateBounds.to);
      const useWeeklyLookback = dateBounds.daySpan <= 7;

      return slots.map((slot) => {
        const currentAmount = expensesByDay.get(slot.key) ?? 0;
        const prevKey = useWeeklyLookback
          ? addDaysIso(slot.key, -7)
          : addMonthsClampedIso(slot.key, -1);
        const prevAmount = expensesByDay.get(prevKey) ?? 0;

        let avgSum = 0;
        for (let step = 1; step <= 3; step += 1) {
          const histKey = useWeeklyLookback
            ? addDaysIso(slot.key, -7 * step)
            : addMonthsClampedIso(slot.key, -step);
          avgSum += expensesByDay.get(histKey) ?? 0;
        }
        const avg3 = Math.round(avgSum / 3);

        return {
          month: slot.key,
          label: slot.label,
          amountCents: toCents(currentAmount),
          prevMonthCents: toCents(prevAmount),
          avg3mCents: toCents(avg3),
        };
      });
    }

    const expensesByMonth = new Map<string, number>();
    for (const tx of transactions) {
      if (!matchesDashboardScope(tx, bankFilter, currencyMode)) {
        continue;
      }
      if (tx.is_internal_transfer || tx.booking_date > dateBounds.to) {
        continue;
      }
      const value = getTxDisplayCents(tx, currencyMode);
      if (value >= 0) {
        continue;
      }
      const monthKey = tx.booking_date.slice(0, 7);
      expensesByMonth.set(monthKey, (expensesByMonth.get(monthKey) ?? 0) + Math.abs(value));
    }

    const slots = enumerateMonthSlots(dateBounds.from, dateBounds.to);
    return slots.map((slot) => {
      const currentAmount = expensesByMonth.get(slot.key) ?? 0;
      const prevAmount = expensesByMonth.get(addMonthsToYm(slot.key, -1)) ?? 0;
      const avgSum =
        (expensesByMonth.get(addMonthsToYm(slot.key, -1)) ?? 0) +
        (expensesByMonth.get(addMonthsToYm(slot.key, -2)) ?? 0) +
        (expensesByMonth.get(addMonthsToYm(slot.key, -3)) ?? 0);
      const avg3m = Math.round(avgSum / 3);

      return {
        month: slot.key,
        label: slot.label,
        amountCents: toCents(currentAmount),
        prevMonthCents: toCents(prevAmount),
        avg3mCents: toCents(avg3m),
      };
    });
  }

  const expensesByMonth = new Map<string, number>();
  for (const tx of transactions) {
    if (!matchesDashboardScope(tx, bankFilter, currencyMode)) {
      continue;
    }
    if (tx.is_internal_transfer) {
      continue;
    }
    const value = getTxDisplayCents(tx, currencyMode);
    if (value >= 0) {
      continue;
    }
    const monthKey = tx.booking_date.slice(0, 7);
    expensesByMonth.set(monthKey, (expensesByMonth.get(monthKey) ?? 0) + Math.abs(value));
  }

  const rawAmounts = MONTH_WINDOW.map((slot) => expensesByMonth.get(slot.month) ?? 0);

  return MONTH_WINDOW.map((slot, index) => {
    const currentAmount = rawAmounts[index] ?? 0;
    const prevAmount = index > 0 ? (rawAmounts[index - 1] ?? 0) : (expensesByMonth.get('2026-05') ?? currentAmount);

    const lookbackStart = Math.max(0, index - 3);
    const lookbackCount = index - lookbackStart;
    let lookbackSum = 0;
    for (let j = lookbackStart; j < index; j += 1) {
      lookbackSum += rawAmounts[j] ?? 0;
    }
    const avg3m = lookbackCount > 0 ? Math.round(lookbackSum / lookbackCount) : currentAmount;

    return {
      month: slot.month,
      label: slot.label,
      amountCents: toCents(currentAmount),
      prevMonthCents: toCents(prevAmount),
      avg3mCents: toCents(avg3m),
    };
  });
}

export function assertTabExhaustive(tab: never): never {
  return assertNever(tab);
}

export function resolveSelectedTransactionContext(
  dataset: ClairFluxDataset,
  selectedTxId: Transaction['id'] | null,
): {
  readonly selectedTx: Transaction | null;
  readonly selectedAccount: Account | null;
  readonly currentNote: string;
} {
  if (selectedTxId === null) {
    return { selectedTx: null, selectedAccount: null, currentNote: '' };
  }
  const selectedTx = dataset.transactions.find((tx) => tx.id === selectedTxId) ?? null;
  if (!selectedTx) {
    return { selectedTx: null, selectedAccount: null, currentNote: '' };
  }
  const selectedAccount = dataset.accounts.find((acc) => acc.id === selectedTx.account_id) ?? null;
  const currentNote = dataset.notes.find((n) => n.transaction_id === selectedTx.id)?.content ?? '';
  return { selectedTx, selectedAccount, currentNote };
}

// ============================================================================
// Mock-First Initial Seed Dataset (Multi-comptes BoursoBank & Revolut EUR/USD)
// ============================================================================

const ACC_BOURSO_PERSO = parseAccountId('11111111-1111-4111-8111-111111111111');
const ACC_BOURSO_JOINT = parseAccountId('11111111-1111-4111-8111-111111111112');
const ACC_BOURSO_CARD = parseAccountId('11111111-1111-4111-8111-111111111113');
const ACC_REVOLUT_EUR = parseAccountId('22222222-2222-4222-8222-222222222221');
const ACC_REVOLUT_USD = parseAccountId('22222222-2222-4222-8222-222222222222');

const RULE_ID_CURSOR = parseRuleId('44444444-4444-4444-8444-444444444441');
const RULE_ID_BIOCOOP = parseRuleId('44444444-4444-4444-8444-444444444442');
const RULE_ID_SNCF = parseRuleId('44444444-4444-4444-8444-444444444443');

const FILE_UUID_BOURSO = '88888888-8888-4888-8888-888888888883';
const FILE_UUID_REVOLUT = '88888888-8888-4888-8888-888888888881';

const TX_ID_1 = parseTransactionId('33333333-3333-4333-8333-333333333331');
const TX_ID_2 = parseTransactionId('33333333-3333-4333-8333-333333333332');
const TX_ID_3 = parseTransactionId('33333333-3333-4333-8333-333333333333');
const TX_ID_4 = parseTransactionId('33333333-3333-4333-8333-333333333334');
const TX_ID_5 = parseTransactionId('33333333-3333-4333-8333-333333333335');
const TX_ID_6 = parseTransactionId('33333333-3333-4333-8333-333333333336');
const TX_ID_7 = parseTransactionId('33333333-3333-4333-8333-333333333337');
const TX_ID_8 = parseTransactionId('33333333-3333-4333-8333-333333333338');
const TX_ID_9 = parseTransactionId('33333333-3333-4333-8333-333333333339');
const TX_ID_10 = parseTransactionId('33333333-3333-4333-8333-333333333340');
const TX_ID_11 = parseTransactionId('33333333-3333-4333-8333-333333333341');
const TX_ID_12 = parseTransactionId('33333333-3333-4333-8333-333333333342');
const TX_ID_13 = parseTransactionId('33333333-3333-4333-8333-333333333343');
const TX_ID_14 = parseTransactionId('33333333-3333-4333-8333-333333333344');

const INITIAL_ACCOUNTS: readonly Account[] = [
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

const INITIAL_TRANSACTIONS: readonly Transaction[] = [
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
    source_drive_file_id: FILE_UUID_REVOLUT,
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
    source_drive_file_id: FILE_UUID_REVOLUT,
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
    amount_cents: toCents(-34200),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-34200),
    category: 'Alimentation',
    is_manual_category: false,
    matched_rule_id: RULE_ID_BIOCOOP,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_BOURSO,
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
    raw_label: 'PRLV SEPA LOYER + EDF SERVICE CLIENT',
    clean_label: 'Loyer & EDF',
    amount_cents: toCents(-94500),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-94500),
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
  {
    id: TX_ID_7,
    account_id: ACC_REVOLUT_EUR,
    bank: 'revolut',
    account_type: 'courant',
    external_ref_masked: 'EUR •• 3310',
    booking_date: '2026-11-08',
    value_date: '2026-11-08',
    raw_label: 'HETZNER CLOUD GMBH',
    clean_label: 'Hetzner Cloud',
    amount_cents: toCents(-5051),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-5051),
    category: 'Logiciels & Cloud',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_REVOLUT,
    revision: toSyncRevision(1418),
    updated_at: '2026-11-08T10:00:00.000Z',
  },
  {
    id: TX_ID_8,
    account_id: ACC_BOURSO_PERSO,
    bank: 'boursobank',
    account_type: 'courant',
    external_ref_masked: '•••• 4821',
    booking_date: '2026-10-03',
    value_date: '2026-10-03',
    raw_label: 'VIR SALAIRE OCTOBRE',
    clean_label: 'Salaire Octobre',
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
    source_drive_file_id: FILE_UUID_BOURSO,
    revision: toSyncRevision(1380),
    updated_at: '2026-10-03T08:00:00.000Z',
  },
  {
    id: TX_ID_9,
    account_id: ACC_BOURSO_CARD,
    bank: 'boursobank',
    account_type: 'carte_differee',
    external_ref_masked: '•••• 7712',
    booking_date: '2026-10-19',
    value_date: '2026-10-19',
    raw_label: 'SNCF CONNECT PARIS LYON',
    clean_label: 'SNCF Connect',
    amount_cents: toCents(-148200),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-148200),
    category: 'Déplacements',
    is_manual_category: false,
    matched_rule_id: RULE_ID_SNCF,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_BOURSO,
    revision: toSyncRevision(1385),
    updated_at: '2026-10-19T14:00:00.000Z',
  },
  {
    id: TX_ID_10,
    account_id: ACC_REVOLUT_USD,
    bank: 'revolut',
    account_type: 'multi_devises',
    external_ref_masked: 'USD •• 9012',
    booking_date: '2026-10-12',
    value_date: '2026-10-12',
    raw_label: 'OPENAI API USAGE SAN FRANCISCO',
    clean_label: 'OpenAI API',
    amount_cents: toCents(-6400),
    currency: 'USD',
    fx_rate_micro: toFxRateMicro(922000),
    amount_eur_cents: convertToEurCents(toCents(-6400), toFxRateMicro(922000)),
    category: 'Logiciels & Cloud',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_REVOLUT,
    revision: toSyncRevision(1375),
    updated_at: '2026-10-12T11:00:00.000Z',
  },
  {
    id: TX_ID_11,
    account_id: ACC_BOURSO_JOINT,
    bank: 'boursobank',
    account_type: 'courant',
    external_ref_masked: '•••• 9104',
    booking_date: '2026-09-10',
    value_date: '2026-09-10',
    raw_label: 'PRLV SEPA LOYER SEPTEMBRE',
    clean_label: 'Loyer Septembre',
    amount_cents: toCents(-136000),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-136000),
    category: 'Logement & Charges',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_BOURSO,
    revision: toSyncRevision(1340),
    updated_at: '2026-09-10T09:00:00.000Z',
  },
  {
    id: TX_ID_12,
    account_id: ACC_REVOLUT_USD,
    bank: 'revolut',
    account_type: 'multi_devises',
    external_ref_masked: 'USD •• 9012',
    booking_date: '2026-08-18',
    value_date: '2026-08-18',
    raw_label: 'DELTA AIR LINES NYC',
    clean_label: 'Delta Air Lines',
    amount_cents: toCents(-14200),
    currency: 'USD',
    fx_rate_micro: toFxRateMicro(918000),
    amount_eur_cents: convertToEurCents(toCents(-14200), toFxRateMicro(918000)),
    category: 'Déplacements',
    is_manual_category: false,
    matched_rule_id: null,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_REVOLUT,
    revision: toSyncRevision(1310),
    updated_at: '2026-08-18T16:00:00.000Z',
  },
  {
    id: TX_ID_13,
    account_id: ACC_BOURSO_CARD,
    bank: 'boursobank',
    account_type: 'carte_differee',
    external_ref_masked: '•••• 7712',
    booking_date: '2026-07-14',
    value_date: '2026-07-14',
    raw_label: 'CARTE BIOCOOP + COURSES ETE',
    clean_label: 'Biocoop Été',
    amount_cents: toCents(-124000),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-124000),
    category: 'Alimentation',
    is_manual_category: false,
    matched_rule_id: RULE_ID_BIOCOOP,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_BOURSO,
    revision: toSyncRevision(1260),
    updated_at: '2026-07-14T18:00:00.000Z',
  },
  {
    id: TX_ID_14,
    account_id: ACC_REVOLUT_EUR,
    bank: 'revolut',
    account_type: 'courant',
    external_ref_masked: 'EUR •• 3310',
    booking_date: '2026-06-21',
    value_date: '2026-06-21',
    raw_label: 'SNCF BILLET JUIN',
    clean_label: 'SNCF Juin',
    amount_cents: toCents(-118500),
    currency: 'EUR',
    fx_rate_micro: toFxRateMicro(1_000_000),
    amount_eur_cents: toCents(-118500),
    category: 'Déplacements',
    is_manual_category: false,
    matched_rule_id: RULE_ID_SNCF,
    is_internal_transfer: false,
    is_manual_transfer_override: false,
    transfer_group_id: null,
    source_drive_file_id: FILE_UUID_REVOLUT,
    revision: toSyncRevision(1210),
    updated_at: '2026-06-21T15:00:00.000Z',
  },
];

const INITIAL_NOTES: readonly TransactionNote[] = [
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

const INITIAL_RULES: readonly CategorizationRule[] = [
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
  {
    id: RULE_ID_SNCF,
    name: 'Train SNCF',
    priority: 30,
    bank_filter: null,
    account_id_filter: null,
    account_type_filter: null,
    match_mode: 'contains',
    pattern: 'SNCF',
    target_category: 'Déplacements',
    mark_as_internal_transfer: false,
    is_active: true,
    revision: toSyncRevision(1202),
    updated_at: '2026-11-01T09:10:00.000Z',
  },
];

const INITIAL_BUDGETS: readonly BudgetLimit[] = [
  {
    id: 'budget-alimentation',
    category: 'Alimentation',
    limitCents: toCents(50000),
    spentCents: toCents(34200),
    currency: 'EUR',
  },
  {
    id: 'budget-logiciels',
    category: 'Logiciels & Cloud',
    limitCents: toCents(8000),
    spentCents: toCents(6900),
    currency: 'EUR',
  },
  {
    id: 'budget-logement',
    category: 'Logement & Charges',
    limitCents: toCents(90000),
    spentCents: toCents(94500),
    currency: 'EUR',
  },
];

const INITIAL_DRIVE_FILES: readonly DriveSyncFileStatus[] = [
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

export const EMPTY_LIVE_DATASET: ClairFluxDataset = {
  accounts: [],
  transactions: [],
  notes: [],
  rules: [],
  budgets: [],
  driveFiles: [],
  revision: 0,
  syncedAt: '',
};

export const INITIAL_SEED_DATASET: ClairFluxDataset = {
  accounts: INITIAL_ACCOUNTS,
  transactions: INITIAL_TRANSACTIONS,
  notes: INITIAL_NOTES,
  rules: INITIAL_RULES,
  budgets: INITIAL_BUDGETS,
  driveFiles: INITIAL_DRIVE_FILES,
  revision: 1482,
  syncedAt: '2026-11-21T14:00:00.000Z',
};
