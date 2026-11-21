import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import { type TransactionId } from '@clairflux/shared';
import { lazy, StrictMode, Suspense, useCallback, useMemo, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BottomTabBar,
  BudgetAlertsPanel,
  ChartsSkeleton,
  DesktopSidebar,
  KpiSummaryCard,
  OfflineStatusBanner,
  SyncDrivePanel,
} from './features/dashboard/DashboardChrome';
import {
  assertTabExhaustive,
  computeKpiMetrics,
  INITIAL_SEED_DATASET,
  resolveSelectedTransactionContext,
  runWithViewTransition,
  usePrefersReducedMotion,
  type AppTab,
  type CurrencyViewMode,
  type DashboardBankFilter,
  type ExpenseComparisonMode,
  type TransactionsSubTab,
} from './features/dashboard/types';
import { useOfflineStore } from './offline/useOfflineStore';

const DashboardCharts = lazy(() => import('./features/dashboard/DashboardCharts'));
const TransactionsSection = lazy(() => import('./features/ledger/TransactionsSection'));
const BottomSheetNoteDialog = lazy(() => import('./features/ledger/BottomSheetNoteDialog'));

const HEADING_BY_TAB: Readonly<Record<AppTab['kind'], string>> = {
  overview: 'overview-heading',
  transactions: 'ledger-section-heading',
  sync: 'sync-heading',
};

function ClairFluxApp(): ReactElement {
  const prefersReducedMotion = usePrefersReducedMotion();
  const store = useOfflineStore(INITIAL_SEED_DATASET);
  const { dataset, isOnline, pendingOutboxCount, syncMessage, flushNow } = store;

  const [activeTab, setActiveTab] = useState<AppTab>({ kind: 'overview' });
  const [activeSubTab, setActiveSubTab] = useState<TransactionsSubTab>('operations');
  const [bankFilter, setBankFilter] = useState<DashboardBankFilter>('all');
  const [currencyMode, setCurrencyMode] = useState<CurrencyViewMode>('eur_consolidated');
  const [comparisonMode, setComparisonMode] = useState<ExpenseComparisonMode>('prev_month');
  const [selectedTxId, setSelectedTxId] = useState<TransactionId | null>(null);
  const [hasOpenedDialog, setHasOpenedDialog] = useState(false);
  const [rulePrefillPattern, setRulePrefillPattern] = useState('');

  const kpiMetrics = useMemo(
    () => computeKpiMetrics(dataset.accounts, dataset.transactions, bankFilter, currencyMode),
    [dataset.accounts, dataset.transactions, bankFilter, currencyMode],
  );
  const { selectedTx, selectedAccount, currentNote } = useMemo(
    () => resolveSelectedTransactionContext(dataset, selectedTxId),
    [dataset, selectedTxId],
  );

  const handleSelectTab = useCallback(
    (nextTab: AppTab): void => {
      runWithViewTransition(() => setActiveTab(nextTab), prefersReducedMotion, HEADING_BY_TAB[nextTab.kind]);
    },
    [prefersReducedMotion],
  );

  const handleSelectTransaction = useCallback((transactionId: TransactionId): void => {
    setHasOpenedDialog(true);
    setSelectedTxId(transactionId);
  }, []);

  const handleCreateRuleFromLabel = useCallback(
    (label: string): void => {
      setRulePrefillPattern(label);
      setSelectedTxId(null);
      setActiveSubTab('rules');
      runWithViewTransition(() => setActiveTab({ kind: 'transactions' }), prefersReducedMotion, HEADING_BY_TAB.transactions);
    },
    [prefersReducedMotion],
  );

  const handleFlushOutbox = useCallback((): void => { void flushNow(); }, [flushNow]);
  const handleTriggerDriveSync = useCallback((): void => { void store.triggerDriveSync(); }, [store]);

  const renderTabContent = (): ReactElement => {
    switch (activeTab.kind) {
      case 'overview':
        return (
          <>
            <h2 id="overview-heading" tabIndex={-1} style={{ fontSize: '1.125rem' }}>Synthèse financière</h2>
            <KpiSummaryCard {...kpiMetrics} />
            <Suspense fallback={<ChartsSkeleton />}>
              <DashboardCharts
                accounts={dataset.accounts}
                transactions={dataset.transactions}
                bankFilter={bankFilter}
                currencyMode={currencyMode}
                comparisonMode={comparisonMode}
                prefersReducedMotion={prefersReducedMotion}
                onChangeBankFilter={setBankFilter}
                onChangeCurrencyMode={setCurrencyMode}
                onChangeComparisonMode={setComparisonMode}
              />
            </Suspense>
            <BudgetAlertsPanel budgets={dataset.budgets} />
          </>
        );
      case 'transactions':
        return (
          <Suspense fallback={<ChartsSkeleton />}>
            <TransactionsSection
              accounts={dataset.accounts}
              transactions={dataset.transactions}
              notes={dataset.notes}
              rules={dataset.rules}
              activeSubTab={activeSubTab}
              onChangeSubTab={setActiveSubTab}
              currencyMode={currencyMode}
              bankFilter={bankFilter}
              isOnline={isOnline}
              rulePrefillPattern={rulePrefillPattern}
              onSelectTransaction={handleSelectTransaction}
              onSaveRule={store.saveRule}
              onReorderRule={store.reorderRule}
              onToggleRule={store.toggleRule}
              onReapplyRules={store.reapplyRules}
            />
          </Suspense>
        );
      case 'sync':
        return (
          <SyncDrivePanel
            driveFiles={dataset.driveFiles}
            isOnline={isOnline}
            pendingOutboxCount={pendingOutboxCount}
            syncMessage={syncMessage}
            onTriggerDriveSync={handleTriggerDriveSync}
            onFlushOutbox={handleFlushOutbox}
          />
        );
      default:
        return assertTabExhaustive(activeTab);
    }
  };

  return (
    <div className="cf-shell">
      <DesktopSidebar activeTab={activeTab} isOnline={isOnline} revision={dataset.revision} pendingOutboxCount={pendingOutboxCount} onSelectTab={handleSelectTab} />
      <main className="cf-main">
        <header className="cf-header">
          <div>
            <h1 style={{ fontSize: '1.5rem' }}>ClairFlux</h1>
            <p style={{ color: 'var(--text-secondary)' }}>Suivi consolidé BoursoBank & Revolut (EUR / USD)</p>
          </div>
        </header>
        <OfflineStatusBanner isOnline={isOnline} pendingOutboxCount={pendingOutboxCount} revision={dataset.revision} syncMessage={syncMessage} onFlushOutbox={handleFlushOutbox} />
        {renderTabContent()}
        <div aria-live="polite" style={{ position: 'absolute', inlineSize: '1px', blockSize: '1px', overflow: 'hidden', clipPath: 'inset(50%)' }}>
          {syncMessage ?? ''}
        </div>
      </main>
      <BottomTabBar activeTab={activeTab} pendingOutboxCount={pendingOutboxCount} onSelectTab={handleSelectTab} />
      {hasOpenedDialog || selectedTx ? (
        <Suspense fallback={null}>
          <BottomSheetNoteDialog
            transaction={selectedTx}
            account={selectedAccount}
            currentNote={currentNote}
            isOnline={isOnline}
            onClose={() => setSelectedTxId(null)}
            onSaveQuickNote={store.saveQuickNote}
            onUpdateCategory={store.updateManualCategory}
            onCreateRuleFromLabel={handleCreateRuleFromLabel}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Élément #root introuvable dans index.html');
createRoot(rootElement).render(
  <StrictMode>
    <ClairFluxApp />
  </StrictMode>,
);
