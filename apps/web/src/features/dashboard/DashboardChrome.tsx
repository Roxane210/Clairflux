import {
  ALLOWED_DRIVE_FOLDERS,
  formatMoney,
  toCents,
  type CheckpointStatus,
  type Currency,
  type DriveSyncFileStatus,
} from '@clairflux/shared';
import { memo, type ReactElement } from 'react';
import { ApkDownloadCard } from '../apk/ApkDownloadCard';
import { BANK_LABELS, type AppTab, type BudgetLimit } from './types';

// ============================================================================
// Navigation Items (3 Primary Tabs — Responsive < 1024px Bottom Bar / >= 1024px Rail)
// ============================================================================

const NAV_ITEMS: readonly { readonly tab: AppTab; readonly label: string }[] = [
  { tab: { kind: 'overview' }, label: 'Synthèse' },
  { tab: { kind: 'transactions' }, label: 'Transactions' },
  { tab: { kind: 'sync' }, label: 'Synchro Drive' },
];

export interface BottomTabBarProps {
  readonly activeTab: AppTab;
  readonly pendingOutboxCount: number;
  readonly onSelectTab: (tab: AppTab) => void;
}

export const BottomTabBar = memo(function BottomTabBar({
  activeTab,
  pendingOutboxCount,
  onSelectTab,
}: BottomTabBarProps): ReactElement {
  return (
    <nav className="cf-bottom-nav" aria-label="Navigation mobile">
      {NAV_ITEMS.map((item) => {
        const isCurrent = item.tab.kind === activeTab.kind;
        const showOutbox = item.tab.kind === 'sync' && pendingOutboxCount > 0;
        const accessibleLabel = showOutbox
          ? `${item.label} (${pendingOutboxCount} modification(s) en attente)`
          : item.label;

        return (
          <button
            key={item.tab.kind}
            type="button"
            className="cf-nav-btn"
            aria-label={accessibleLabel}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onSelectTab(item.tab)}
          >
            <span>{item.label}</span>
            {showOutbox ? (
              <span className="cf-nav-badge tabular-amount" aria-hidden="true">
                {pendingOutboxCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
});

export interface DesktopSidebarProps {
  readonly activeTab: AppTab;
  readonly isOnline: boolean;
  readonly revision: number;
  readonly pendingOutboxCount: number;
  readonly onSelectTab: (tab: AppTab) => void;
}

export const DesktopSidebar = memo(function DesktopSidebar({
  activeTab,
  isOnline,
  revision,
  pendingOutboxCount,
  onSelectTab,
}: DesktopSidebarProps): ReactElement {
  return (
    <aside className="cf-rail" aria-label="Navigation principale">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div>
          <h2 style={{ fontSize: '1.125rem' }}>ClairFlux</h2>
          <p className="cf-rail-meta">
            BoursoBank · Revolut
          </p>
        </div>

        <nav className="cf-rail-nav">
          {NAV_ITEMS.map((item) => {
            const isCurrent = item.tab.kind === activeTab.kind;
            const showOutbox = item.tab.kind === 'sync' && pendingOutboxCount > 0;
            return (
              <button
                key={item.tab.kind}
                type="button"
                className="cf-nav-btn"
                aria-current={isCurrent ? 'page' : undefined}
                onClick={() => onSelectTab(item.tab)}
              >
                <span>{item.label}</span>
                {showOutbox ? (
                  <span className="cf-nav-badge tabular-amount">{pendingOutboxCount}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="cf-rail-meta">
        <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {isOnline ? 'En ligne' : 'Hors-ligne (notes locales actives)'}
        </p>
        <p className="tabular-amount">Rév. #{revision}</p>
        {pendingOutboxCount > 0 ? (
          <p className="tabular-amount" style={{ color: 'var(--warning)', fontWeight: 600 }}>
            Outbox : {pendingOutboxCount} en attente
          </p>
        ) : null}
      </div>
    </aside>
  );
});

// ============================================================================
// KPI Summary & Offline Banner
// ============================================================================

export interface KpiSummaryCardProps {
  readonly displayCurrency: Currency;
  readonly balanceCents: number;
  readonly incomeCents: number;
  readonly expensesExclTransfersCents: number;
  readonly internalTransfersCents: number;
  readonly periodLabel?: string | undefined;
}

export const KpiSummaryCard = memo(function KpiSummaryCard({
  displayCurrency,
  balanceCents,
  incomeCents,
  expensesExclTransfersCents,
  internalTransfersCents,
  periodLabel,
}: KpiSummaryCardProps): ReactElement {
  const scopeSuffix = periodLabel ? ` (${periodLabel})` : ' du mois';

  return (
    <section className="cf-surface cf-kpi-container" aria-label="Indicateurs clés">
      <div className="cf-kpi-grid">
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Solde consolidé ({displayCurrency})
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.375rem', fontWeight: 700 }}>
            {formatMoney(toCents(balanceCents), displayCurrency)}
          </span>
        </div>
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Revenus{scopeSuffix}
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            {formatMoney(toCents(incomeCents), displayCurrency)}
          </span>
        </div>
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Dépenses hors transferts{scopeSuffix}
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            {formatMoney(toCents(expensesExclTransfersCents), displayCurrency)}
          </span>
        </div>
        <div className="cf-kpi-cell">
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Transferts internes exclus
          </span>
          <span className="tabular-amount" style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            {formatMoney(toCents(internalTransfersCents), displayCurrency)}
          </span>
        </div>
      </div>
    </section>
  );
});

export interface OfflineStatusBannerProps {
  readonly isOnline: boolean;
  readonly pendingOutboxCount: number;
  readonly revision: number;
  readonly syncMessage: string | null;
  readonly onFlushOutbox: () => void;
}

export const OfflineStatusBanner = memo(function OfflineStatusBanner({
  isOnline,
  pendingOutboxCount,
  revision,
  syncMessage,
  onFlushOutbox,
}: OfflineStatusBannerProps): ReactElement | null {
  if (isOnline && pendingOutboxCount === 0 && !syncMessage) {
    return null;
  }

  const isWarning = !isOnline || pendingOutboxCount > 0;

  return (
    <div
      role="status"
      className="cf-surface"
      style={{
        padding: '12px 16px',
        background: isWarning ? 'var(--warning-soft)' : 'var(--accent-soft)',
        borderColor: isWarning ? 'var(--warning)' : 'var(--accent)',
        color: isWarning ? 'var(--warning)' : 'var(--accent)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
      }}
    >
      <div style={{ display: 'grid', gap: '2px', minInlineSize: 0 }}>
        <span style={{ fontWeight: 600 }}>
          {!isOnline
            ? 'Hors-ligne — Consultation et notes rapides locales actives (Synchro Drive/Gemini verrouillée)'
            : syncMessage ?? 'Synchronisation locale active'}
        </span>
        <span className="tabular-amount" style={{ fontSize: '0.8125rem' }}>
          Révision #{revision}
          {pendingOutboxCount > 0
            ? ` · ${pendingOutboxCount} note(s) rapide(s) / recatégorisation(s) en attente dans l’outbox`
            : ''}
        </span>
      </div>
      {isOnline && pendingOutboxCount > 0 ? (
        <button type="button" className="cf-btn" onClick={onFlushOutbox}>
          Synchroniser l'outbox maintenant
        </button>
      ) : null}
    </div>
  );
});

// ============================================================================
// Budget Alerts Panel (Thresholds 80% / 100%, Month Pacing Marker, Icon + Text + Tabular)
// ============================================================================

type BudgetAlertLevel = 'ok' | 'warning' | 'danger';

function getBudgetAlertLevel(ratioPercent: number): BudgetAlertLevel {
  if (ratioPercent >= 100) {
    return 'danger';
  }
  if (ratioPercent >= 80) {
    return 'warning';
  }
  return 'ok';
}

const BudgetStatusIcon = memo(function BudgetStatusIcon({
  level,
}: {
  readonly level: BudgetAlertLevel;
}): ReactElement {
  if (level === 'danger') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 4.2v4.3M8 11.4v.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (level === 'warning') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2L14.5 13.2H1.5L8 2Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M8 6.2v3.3M8 11.4v.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 8.2l2 2 4-4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
});

export interface BudgetAlertsPanelProps {
  readonly budgets: readonly BudgetLimit[];
  readonly monthProgressPercent?: number;
}

export const BudgetAlertsPanel = memo(function BudgetAlertsPanel({
  budgets,
  monthProgressPercent = 70,
}: BudgetAlertsPanelProps): ReactElement {
  const clampedPacing = Math.max(0, Math.min(100, Math.round(monthProgressPercent)));

  return (
    <section className="cf-surface" aria-labelledby="budgets-heading">
      <div
        style={{
          padding: '16px',
          borderBlockEnd: '1px solid var(--border-subtle)',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: '8px',
        }}
      >
        <h2 id="budgets-heading" style={{ fontSize: '1rem' }}>
          Alertes budgets mensuels
        </h2>
        <span className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
          Rythme du mois : {clampedPacing} % · Seuils 80 % / 100 %
        </span>
      </div>

      <div className="cf-budget-list">
        {budgets.map((budget) => {
          const ratioPercent =
            budget.limitCents > 0 ? Math.round((budget.spentCents / budget.limitCents) * 100) : 0;
          const level = getBudgetAlertLevel(ratioPercent);
          const fillPercent = Math.min(100, Math.max(0, ratioPercent));
          const deltaCents = toCents(Math.abs(budget.limitCents - budget.spentCents));
          const statusLabel =
            level === 'danger'
              ? 'Dépassement ≥ 100 %'
              : level === 'warning'
                ? 'Vigilance ≥ 80 %'
                : 'Maîtrisé < 80 %';
          const deltaText =
            budget.spentCents > budget.limitCents
              ? `Dépassé de +${formatMoney(deltaCents, budget.currency)}`
              : `Reste ${formatMoney(deltaCents, budget.currency)}`;

          return (
            <div key={budget.id} className="cf-budget-row">
              <div className="cf-budget-head">
                <span style={{ fontWeight: 600 }}>{budget.category}</span>
                <span className="cf-budget-status" data-level={level}>
                  <BudgetStatusIcon level={level} />
                  <span>{statusLabel}</span>
                  <span className="tabular-amount">({ratioPercent} %)</span>
                </span>
              </div>

              <div
                className="cf-budget-track"
                role="progressbar"
                aria-label={`Budget ${budget.category} : ${ratioPercent} % consommé`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(ratioPercent, 100)}
              >
                <div
                  className="cf-budget-fill"
                  data-level={level}
                  style={{ inlineSize: `${fillPercent}%` }}
                />
                <span
                  className="cf-budget-threshold"
                  title="Seuil vigilance 80 %"
                  aria-hidden="true"
                />
                <span
                  className="cf-budget-pacing"
                  style={{ insetInlineStart: `${clampedPacing}%` }}
                  title={`Rythme du mois : ${clampedPacing} %`}
                  aria-hidden="true"
                />
              </div>

              <div className="cf-budget-foot">
                <span className="tabular-amount">
                  {formatMoney(budget.spentCents, budget.currency)} /{' '}
                  {formatMoney(budget.limitCents, budget.currency)}
                </span>
                <span className="tabular-amount" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {deltaText}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
});

// ============================================================================
// Sync Drive Panel (2 Exclusive Folders, Offline Guard)
// ============================================================================

const CHECKPOINT_STATUS_LABELS: Readonly<Record<CheckpointStatus, string>> = {
  pending: 'En attente',
  skipped: 'Inchangé (ignoré)',
  extracting: 'Extraction Gemini…',
  parsed: 'Analysé',
  committing: 'Enregistrement…',
  committed: 'Importé',
  failed: 'Échec',
};

export interface SyncDrivePanelProps {
  readonly driveFiles: readonly DriveSyncFileStatus[];
  readonly isOnline: boolean;
  readonly isSyncingDrive?: boolean | undefined;
  readonly pendingOutboxCount: number;
  readonly syncMessage: string | null;
  readonly onTriggerDriveSync: () => void;
  readonly onFlushOutbox: () => void;
  readonly onUnauthorized?: (() => void) | undefined;
}

export const SyncDrivePanel = memo(function SyncDrivePanel({
  driveFiles,
  isOnline,
  isSyncingDrive = false,
  pendingOutboxCount,
  syncMessage,
  onTriggerDriveSync,
  onFlushOutbox,
  onUnauthorized,
}: SyncDrivePanelProps): ReactElement {
  return (
    <>
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
          <div style={{ minInlineSize: 0, display: 'grid', gap: '4px' }}>
            <h2 id="sync-heading" tabIndex={-1} style={{ fontSize: '1.125rem' }}>
              Synchronisation Google Drive (manuelle uniquement)
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>
              Périmètre exclusif lecture seule : BoursoBank ({ALLOWED_DRIVE_FOLDERS.boursobank}) et Revolut (
              {ALLOWED_DRIVE_FOLDERS.revolut})
            </p>
            {pendingOutboxCount > 0 ? (
              <p
                className="tabular-amount"
                style={{ color: 'var(--warning)', fontSize: '0.8125rem', fontWeight: 600 }}
              >
                {pendingOutboxCount} note(s) rapide(s) / recatégorisation(s) en attente dans l’outbox
              </p>
            ) : null}
          </div>

          <div className="cf-header-actions">
            {pendingOutboxCount > 0 && isOnline ? (
              <button type="button" className="cf-btn" onClick={onFlushOutbox}>
                Synchroniser l'outbox maintenant
              </button>
            ) : null}
            <button
              type="button"
              className="cf-btn cf-btn-primary"
              disabled={!isOnline || isSyncingDrive}
              onClick={onTriggerDriveSync}
            >
              {!isOnline
                ? 'Connexion requise (hors-ligne)'
                : isSyncingDrive
                  ? 'Synchronisation…'
                  : 'Synchroniser Drive / Gemini'}
            </button>
          </div>
        </div>

        {!isOnline ? (
          <p
            role="note"
            style={{
              paddingBlock: '12px',
              borderBlockEnd: '1px solid var(--border-subtle)',
              color: 'var(--warning)',
              fontWeight: 600,
            }}
          >
            Synchronisation Drive/Gemini indisponible hors-ligne. Vos notes rapides restent consultables et
            enregistrées dans la file locale.
          </p>
        ) : syncMessage ? (
          <p
            role="status"
            style={{
              paddingBlock: '12px',
              borderBlockEnd: '1px solid var(--border-subtle)',
              color: 'var(--accent)',
              fontWeight: 600,
            }}
          >
            {syncMessage}
          </p>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {driveFiles.length === 0 ? (
            <p style={{ paddingBlock: '16px', color: 'var(--text-secondary)' }}>
              Aucun relevé synchronisé pour le moment — cliquez sur « Synchroniser » pour analyser
              vos dossiers BoursoBank et Revolut.
            </p>
          ) : null}
          {driveFiles.map((file, index) => (
            <div
              key={file.drive_file_id}
              className={index >= 8 ? 'cf-tx-row-deferred' : undefined}
              style={{
                paddingBlock: '12px',
                borderBlockEnd: index === driveFiles.length - 1 ? 0 : '1px solid var(--border-subtle)',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div style={{ minInlineSize: 0 }}>
                <p style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{file.file_name}</p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>
                  {BANK_LABELS[file.bank]} · Dossier {file.drive_folder_id}
                </p>
                {file.status === 'failed' && file.error_message ? (
                  <p style={{ color: 'var(--danger)', fontSize: '0.8125rem' }}>{file.error_message}</p>
                ) : null}
              </div>
              <span
                className="tabular-amount"
                style={{
                  color: file.status === 'failed' ? 'var(--danger)' : 'var(--text-secondary)',
                  fontWeight: 600,
                }}
              >
                {CHECKPOINT_STATUS_LABELS[file.status]} · Essai #{file.attempt_count}
              </span>
            </div>
          ))}
        </div>
      </section>
      <ApkDownloadCard isOnline={isOnline} onUnauthorized={onUnauthorized} />
    </>
  );
});

// ============================================================================
// Suspense Skeleton (CLS <= 0.02)
// ============================================================================

export const ChartsSkeleton = memo(function ChartsSkeleton(): ReactElement {
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
