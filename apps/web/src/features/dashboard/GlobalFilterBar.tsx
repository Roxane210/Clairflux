import { memo, useCallback, useId, type ReactElement } from 'react';
import {
  TIME_RANGE_OPTIONS,
  formatFrenchShortDate,
  type CurrencyViewMode,
  type DashboardBankFilter,
  type ResolvedDateBounds,
  type TimeRangeFilter,
  type TimeRangePreset,
} from './types';

export interface GlobalFilterBarProps {
  readonly bankFilter: DashboardBankFilter;
  readonly currencyMode: CurrencyViewMode;
  readonly timeRange: TimeRangeFilter;
  readonly dateBounds: ResolvedDateBounds;
  readonly isOnline: boolean;
  readonly isSyncingDrive: boolean;
  readonly onChangeBankFilter: (filter: DashboardBankFilter) => void;
  readonly onChangeCurrencyMode: (mode: CurrencyViewMode) => void;
  readonly onChangeTimeRange: (filter: TimeRangeFilter) => void;
  readonly onTriggerDriveSync: () => void;
}

const BANK_OPTIONS: readonly { readonly value: DashboardBankFilter; readonly label: string }[] = [
  { value: 'all', label: 'Tous les comptes' },
  { value: 'boursobank', label: 'BoursoBank' },
  { value: 'revolut', label: 'Revolut' },
];

const CURRENCY_OPTIONS: readonly { readonly value: CurrencyViewMode; readonly label: string }[] = [
  { value: 'eur_consolidated', label: 'EUR consolidé' },
  { value: 'usd_only', label: 'USD seul' },
];

export const GlobalFilterBar = memo(function GlobalFilterBar({
  bankFilter,
  currencyMode,
  timeRange,
  dateBounds,
  isOnline,
  isSyncingDrive,
  onChangeBankFilter,
  onChangeCurrencyMode,
  onChangeTimeRange,
  onTriggerDriveSync,
}: GlobalFilterBarProps): ReactElement {
  const fromInputId = useId();
  const toInputId = useId();
  const rangeErrorId = useId();

  const handleSelectPreset = useCallback(
    (preset: TimeRangePreset): void => {
      if (preset === 'custom') {
        const currentFrom = timeRange.preset === 'custom' ? timeRange.from : dateBounds.from;
        const currentTo = timeRange.preset === 'custom' ? timeRange.to : dateBounds.to;
        onChangeTimeRange({ preset: 'custom', from: currentFrom, to: currentTo });
        return;
      }
      onChangeTimeRange({ preset });
    },
    [timeRange, dateBounds.from, dateBounds.to, onChangeTimeRange],
  );

  const handleCustomDateChange = useCallback(
    (edge: 'from' | 'to', value: string): void => {
      const currentFrom = timeRange.preset === 'custom' ? timeRange.from : dateBounds.from;
      const currentTo = timeRange.preset === 'custom' ? timeRange.to : dateBounds.to;
      onChangeTimeRange({
        preset: 'custom',
        from: edge === 'from' ? value : currentFrom,
        to: edge === 'to' ? value : currentTo,
      });
    },
    [timeRange, dateBounds.from, dateBounds.to, onChangeTimeRange],
  );

  const customFrom = timeRange.preset === 'custom' ? timeRange.from : dateBounds.from;
  const customTo = timeRange.preset === 'custom' ? timeRange.to : dateBounds.to;

  return (
    <section className="cf-surface cf-filter-bar" aria-label="Filtres communs et synchronisation">
      <div className="cf-filter-row">
        <div className="cf-filter-groups">
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

        <button
          type="button"
          className="cf-btn cf-btn-primary"
          disabled={!isOnline || isSyncingDrive}
          onClick={onTriggerDriveSync}
        >
          {!isOnline
            ? 'Hors-ligne'
            : isSyncingDrive
              ? 'Synchronisation…'
              : 'Synchroniser'}
        </button>
      </div>

      <div className="cf-filter-row cf-filter-row-divided">
        <div className="cf-scope-bar" role="group" aria-label="Période d’analyse">
          {TIME_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.preset}
              type="button"
              className="cf-pill-btn"
              aria-pressed={timeRange.preset === opt.preset}
              onClick={() => handleSelectPreset(opt.preset)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
          {formatFrenchShortDate(dateBounds.from)} → {formatFrenchShortDate(dateBounds.to)} ·{' '}
          {dateBounds.granularity === 'day' ? 'Vue journalière' : 'Vue mensuelle'}
        </span>
      </div>

      {timeRange.preset === 'custom' ? (
        <div className="cf-filter-custom-row">
          <div className="cf-field-group" style={{ minInlineSize: '160px', flex: '1 1 160px' }}>
            <label htmlFor={fromInputId} className="cf-field-label" style={{ fontSize: '0.8125rem' }}>
              Date de début
            </label>
            <input
              id={fromInputId}
              type="date"
              className={`cf-field-input tabular-amount ${dateBounds.isCustomRangeInvalid ? 'user-invalid-fallback' : ''}`}
              value={customFrom}
              max={customTo || undefined}
              required
              aria-invalid={dateBounds.isCustomRangeInvalid}
              aria-describedby={dateBounds.isCustomRangeInvalid ? rangeErrorId : undefined}
              onChange={(e) => handleCustomDateChange('from', e.target.value)}
            />
          </div>

          <div className="cf-field-group" style={{ minInlineSize: '160px', flex: '1 1 160px' }}>
            <label htmlFor={toInputId} className="cf-field-label" style={{ fontSize: '0.8125rem' }}>
              Date de fin
            </label>
            <input
              id={toInputId}
              type="date"
              className={`cf-field-input tabular-amount ${dateBounds.isCustomRangeInvalid ? 'user-invalid-fallback' : ''}`}
              value={customTo}
              min={customFrom || undefined}
              required
              aria-invalid={dateBounds.isCustomRangeInvalid}
              aria-describedby={dateBounds.isCustomRangeInvalid ? rangeErrorId : undefined}
              onChange={(e) => handleCustomDateChange('to', e.target.value)}
            />
          </div>

          {dateBounds.isCustomRangeInvalid ? (
            <p
              id={rangeErrorId}
              role="alert"
              style={{ color: 'var(--danger)', fontSize: '0.8125rem', fontWeight: 600 }}
            >
              La date de début doit être antérieure ou égale à la date de fin.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
