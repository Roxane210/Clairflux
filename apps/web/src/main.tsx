import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import { CLAIRFLUX_BUILD_VERSION, type TransactionId } from '@clairflux/shared';
import {
  lazy,
  StrictMode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createRoot } from 'react-dom/client';
import { AuthUnlockScreen } from './features/auth/AuthUnlockScreen';
import {
  checkAuthSession,
  submitLogout,
  type AuthSessionState,
  type LoginResponse,
} from './features/auth/authClient';
import {
  BottomTabBar,
  BudgetAlertsPanel,
  ChartsSkeleton,
  DesktopSidebar,
  KpiSummaryCard,
  OfflineStatusBanner,
  SyncDrivePanel,
} from './features/dashboard/DashboardChrome';
import { GlobalFilterBar } from './features/dashboard/GlobalFilterBar';
import {
  assertTabExhaustive,
  computeKpiMetrics,
  DEFAULT_TIME_RANGE,
  EMPTY_LIVE_DATASET,
  resolveDateBounds,
  resolveSelectedTransactionContext,
  runWithViewTransition,
  usePrefersReducedMotion,
  type AppTab,
  type CurrencyViewMode,
  type DashboardBankFilter,
  type ExpenseComparisonMode,
  type TimeRangeFilter,
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
  const [authState, setAuthState] = useState<AuthSessionState>({ kind: 'checking' });

  const handleUnauthorized = useCallback((): void => {
    setAuthState({
      kind: 'unauthenticated',
      message: 'Session expirée ou absente. Veuillez vous reconnecter.',
    });
  }, []);

  const store = useOfflineStore(EMPTY_LIVE_DATASET, {
    onUnauthorized: handleUnauthorized,
  });
  const {
    dataset,
    isOnline,
    isSyncingDrive,
    pendingOutboxCount,
    syncMessage,
    flushNow,
    syncFromServer,
    triggerDriveSync,
  } = store;

  const hasCachedData =
    dataset.revision > 0 || dataset.transactions.length > 0 || dataset.accounts.length > 0;
  const hasCachedDataRef = useRef(hasCachedData);
  hasCachedDataRef.current = hasCachedData;

  useEffect(() => {
    const controller = new AbortController();

    void checkAuthSession({
      isOnline,
      signal: controller.signal,
    }).then((outcome) => {
      if (controller.signal.aborted) {
        return;
      }
      switch (outcome.kind) {
        case 'authenticated':
          setAuthState({
            kind: 'authenticated',
            clientKind: outcome.session.client_kind,
            sessionId: outcome.session.session_id,
            expiresAt: outcome.session.expires_at,
          });
          void syncFromServer();
          break;
        case 'unauthenticated':
          setAuthState({ kind: 'unauthenticated', message: outcome.message });
          break;
        case 'offline':
          setAuthState(
            hasCachedDataRef.current
              ? { kind: 'offline_cached' }
              : { kind: 'unauthenticated', message: null },
          );
          break;
        case 'error':
          setAuthState({ kind: 'unauthenticated', message: outcome.message });
          break;
      }
    });

    return () => {
      controller.abort();
    };
  }, [isOnline, syncFromServer]);

  const [activeTab, setActiveTab] = useState<AppTab>({ kind: 'overview' });
  const [activeSubTab, setActiveSubTab] = useState<TransactionsSubTab>('operations');
  const [bankFilter, setBankFilter] = useState<DashboardBankFilter>('all');
  const [currencyMode, setCurrencyMode] = useState<CurrencyViewMode>('eur_consolidated');
  const [comparisonMode, setComparisonMode] = useState<ExpenseComparisonMode>('prev_month');
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>(DEFAULT_TIME_RANGE);
  const [selectedTxId, setSelectedTxId] = useState<TransactionId | null>(null);
  const [hasOpenedDialog, setHasOpenedDialog] = useState(false);
  const [rulePrefillPattern, setRulePrefillPattern] = useState('');

  const dateBounds = useMemo(
    () => resolveDateBounds(timeRange, dataset.transactions),
    [timeRange, dataset.transactions],
  );

  const kpiMetrics = useMemo(
    () =>
      computeKpiMetrics(
        dataset.accounts,
        dataset.transactions,
        bankFilter,
        currencyMode,
        dateBounds,
      ),
    [dataset.accounts, dataset.transactions, bankFilter, currencyMode, dateBounds],
  );

  const { selectedTx, selectedAccount, currentNote } = useMemo(
    () => resolveSelectedTransactionContext(dataset, selectedTxId),
    [dataset, selectedTxId],
  );

  const handleAuthenticated = useCallback(
    (session: LoginResponse): void => {
      setAuthState({
        kind: 'authenticated',
        clientKind: session.client_kind,
        sessionId: session.session_id,
        expiresAt: session.expires_at,
      });
      void syncFromServer();
    },
    [syncFromServer],
  );

  const handleContinueOffline = useCallback((): void => {
    setAuthState({ kind: 'offline_cached' });
  }, []);

  const handleLogout = useCallback(async (): Promise<void> => {
    await submitLogout({});
    setAuthState({ kind: 'unauthenticated', message: 'Vous avez été déconnecté.' });
  }, []);

  const handleSelectTab = useCallback(
    (nextTab: AppTab): void => {
      runWithViewTransition(
        () => setActiveTab(nextTab),
        prefersReducedMotion,
        HEADING_BY_TAB[nextTab.kind],
      );
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
      runWithViewTransition(
        () => setActiveTab({ kind: 'transactions' }),
        prefersReducedMotion,
        HEADING_BY_TAB.transactions,
      );
    },
    [prefersReducedMotion],
  );

  const handleFlushOutbox = useCallback((): void => {
    void flushNow();
  }, [flushNow]);

  const handleTriggerDriveSync = useCallback((): void => {
    void triggerDriveSync();
  }, [triggerDriveSync]);

  if (authState.kind === 'checking') {
    return (
      <div className="cf-auth-shell">
        <main className="cf-surface cf-auth-card" aria-busy="true">
          <h1 style={{ fontSize: '1.5rem' }}>ClairFlux</h1>
          <p role="status" style={{ color: 'var(--text-secondary)' }}>
            Vérification de votre session en cours…
          </p>
        </main>
      </div>
    );
  }

  if (authState.kind === 'unauthenticated') {
    return (
      <AuthUnlockScreen
        isOnline={isOnline}
        initialMessage={authState.message}
        hasCachedData={hasCachedData}
        onAuthenticated={handleAuthenticated}
        onContinueOffline={handleContinueOffline}
      />
    );
  }

  const showGlobalFilterBar =
    activeTab.kind === 'overview' || activeTab.kind === 'transactions';

  const renderTabContent = (): ReactElement => {
    switch (activeTab.kind) {
      case 'overview':
        return (
          <>
            <h2 id="overview-heading" tabIndex={-1} style={{ fontSize: '1.125rem' }}>
              Synthèse financière
            </h2>
            <KpiSummaryCard {...kpiMetrics} periodLabel={dateBounds.label} />
            <Suspense fallback={<ChartsSkeleton />}>
              <DashboardCharts
                accounts={dataset.accounts}
                transactions={dataset.transactions}
                bankFilter={bankFilter}
                currencyMode={currencyMode}
                comparisonMode={comparisonMode}
                dateBounds={dateBounds}
                prefersReducedMotion={prefersReducedMotion}
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
              dateBounds={dateBounds}
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
            isSyncingDrive={isSyncingDrive}
            pendingOutboxCount={pendingOutboxCount}
            syncMessage={syncMessage}
            onTriggerDriveSync={handleTriggerDriveSync}
            onFlushOutbox={handleFlushOutbox}
            onUnauthorized={handleUnauthorized}
          />
        );
      default:
        return assertTabExhaustive(activeTab);
    }
  };

  return (
    <div className="cf-shell">
      <DesktopSidebar
        activeTab={activeTab}
        isOnline={isOnline}
        revision={dataset.revision}
        pendingOutboxCount={pendingOutboxCount}
        onSelectTab={handleSelectTab}
      />
      <main className="cf-main">
        <header className="cf-header">
          <div>
            <h1 style={{ fontSize: '1.5rem' }}>ClairFlux</h1>
            <p style={{ color: 'var(--text-secondary)' }}>
              Suivi consolidé BoursoBank &amp; Revolut (EUR / USD) · v{CLAIRFLUX_BUILD_VERSION}
            </p>
          </div>
          <div className="cf-header-actions">
            {authState.kind === 'authenticated' && isOnline ? (
              <button type="button" className="cf-btn" onClick={() => void handleLogout()}>
                Déconnexion
              </button>
            ) : authState.kind === 'offline_cached' && isOnline ? (
              <button
                type="button"
                className="cf-btn"
                onClick={() => setAuthState({ kind: 'unauthenticated', message: null })}
              >
                Se connecter
              </button>
            ) : null}
          </div>
        </header>

        <OfflineStatusBanner
          isOnline={isOnline}
          pendingOutboxCount={pendingOutboxCount}
          revision={dataset.revision}
          syncMessage={syncMessage}
          onFlushOutbox={handleFlushOutbox}
        />

        {showGlobalFilterBar ? (
          <GlobalFilterBar
            bankFilter={bankFilter}
            currencyMode={currencyMode}
            timeRange={timeRange}
            dateBounds={dateBounds}
            isOnline={isOnline}
            isSyncingDrive={isSyncingDrive}
            onChangeBankFilter={setBankFilter}
            onChangeCurrencyMode={setCurrencyMode}
            onChangeTimeRange={setTimeRange}
            onTriggerDriveSync={handleTriggerDriveSync}
          />
        ) : null}

        {renderTabContent()}

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
          {syncMessage ?? ''}
        </div>
      </main>
      <BottomTabBar
        activeTab={activeTab}
        pendingOutboxCount={pendingOutboxCount}
        onSelectTab={handleSelectTab}
      />
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
