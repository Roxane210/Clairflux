import {
  formatMoney,
  type Account,
  type AccountId,
  type CategorizationRule,
  type RuleId,
  type Transaction,
  type TransactionId,
  type TransactionNote,
} from '@clairflux/shared';
import { memo, useCallback, useDeferredValue, useMemo, useState, type ReactElement } from 'react';
import {
  ACCOUNT_TYPE_LABELS,
  BANK_LABELS,
  type CurrencyViewMode,
  type DashboardBankFilter,
  type TransactionsSubTab,
} from '../dashboard/types';
import { exportTransactionsToCsv } from './csvExport';
import { RulesTab, type SaveRuleInput } from './RulesTab';

export interface TransactionsSectionProps {
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly notes: readonly TransactionNote[];
  readonly rules: readonly CategorizationRule[];
  readonly activeSubTab: TransactionsSubTab;
  readonly onChangeSubTab: (subTab: TransactionsSubTab) => void;
  readonly currencyMode: CurrencyViewMode;
  readonly bankFilter: DashboardBankFilter;
  readonly isOnline: boolean;
  readonly rulePrefillPattern: string;
  readonly onSelectTransaction: (transactionId: TransactionId) => void;
  readonly onSaveRule: (input: SaveRuleInput) => void;
  readonly onReorderRule: (ruleId: RuleId, direction: 'up' | 'down') => void;
  readonly onToggleRule: (ruleId: RuleId) => void;
  readonly onReapplyRules: () => void;
}

const BAR_STYLE = {
  padding: '16px',
  borderBlockEnd: '1px solid var(--border-subtle)',
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
} as const;

export const TransactionsSection = memo(function TransactionsSection({
  accounts,
  transactions,
  notes,
  rules,
  activeSubTab,
  onChangeSubTab,
  currencyMode,
  bankFilter,
  isOnline,
  rulePrefillPattern,
  onSelectTransaction,
  onSaveRule,
  onReorderRule,
  onToggleRule,
  onReapplyRules,
}: TransactionsSectionProps): ReactElement {
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyWithNotes, setOnlyWithNotes] = useState(false);
  const deferredSearch = useDeferredValue(searchQuery);

  const accountsById = useMemo(() => new Map(accounts.map((acc) => [acc.id, acc])), [accounts]);
  const notesByTxId = useMemo(() => new Map(notes.map((n) => [n.transaction_id, n])), [notes]);

  const filteredTransactions = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return transactions.filter((tx) => {
      if (bankFilter !== 'all' && tx.bank !== bankFilter) return false;
      if (currencyMode === 'usd_only' && tx.currency !== 'USD') return false;
      const note = notesByTxId.get(tx.id);
      if (onlyWithNotes && !note) return false;
      if (query.length === 0) return true;
      const account = accountsById.get(tx.account_id);
      return (
        tx.clean_label.toLowerCase().includes(query) ||
        tx.raw_label.toLowerCase().includes(query) ||
        tx.category.toLowerCase().includes(query) ||
        BANK_LABELS[tx.bank].toLowerCase().includes(query) ||
        (account?.nickname.toLowerCase().includes(query) ?? false) ||
        (note?.content.toLowerCase().includes(query) ?? false)
      );
    });
  }, [transactions, bankFilter, currencyMode, onlyWithNotes, deferredSearch, notesByTxId, accountsById]);

  const handleExportCsv = useCallback((): void => {
    const csv = exportTransactionsToCsv(filteredTransactions, accounts, notes);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `clairflux-operations-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [filteredTransactions, accounts, notes]);

  return (
    <section className="cf-surface cf-ledger-container" aria-labelledby="ledger-heading">
      <div style={BAR_STYLE}>
        <div>
          <h2 id="ledger-heading" tabIndex={-1} style={{ fontSize: '1.125rem' }}>
            Grand livre des opérations
          </h2>
          <p className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            {filteredTransactions.length} opération(s) affichée(s)
          </p>
        </div>
        <div className="cf-scope-bar" role="group" aria-label="Sous-onglets du grand livre">
          <button type="button" className="cf-pill-btn" aria-pressed={activeSubTab === 'operations'} onClick={() => onChangeSubTab('operations')}>
            Opérations
          </button>
          <button type="button" className="cf-pill-btn" aria-pressed={activeSubTab === 'rules'} onClick={() => onChangeSubTab('rules')}>
            Règles de catégorisation
          </button>
        </div>
      </div>

      {activeSubTab === 'rules' ? (
        <RulesTab
          accounts={accounts}
          transactions={transactions}
          rules={rules}
          isOnline={isOnline}
          rulePrefillPattern={rulePrefillPattern}
          onSaveRule={onSaveRule}
          onReorderRule={onReorderRule}
          onToggleRule={onToggleRule}
          onReapplyRules={onReapplyRules}
        />
      ) : (
        <>
          <div style={{ ...BAR_STYLE, alignItems: 'flex-end' }}>
            <label className="cf-field-group" style={{ flex: '1 1 240px', minInlineSize: 0 }}>
              <span className="cf-field-label" style={{ fontSize: '0.8125rem' }}>Rechercher libellé, catégorie ou note</span>
              <input
                type="search"
                className="cf-field-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Ex. Cursor, Biocoop, EDF…"
              />
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <button type="button" className="cf-pill-btn" aria-pressed={onlyWithNotes} onClick={() => setOnlyWithNotes((prev) => !prev)}>
                Avec notes
              </button>
              <button type="button" className="cf-btn" disabled={filteredTransactions.length === 0} onClick={handleExportCsv}>
                Export CSV
              </button>
            </div>
          </div>

          {filteredTransactions.length === 0 ? (
            <p style={{ padding: '24px 16px', color: 'var(--text-secondary)' }}>
              Aucune opération ne correspond aux filtres sélectionnés.
            </p>
          ) : (
            <>
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
                    {filteredTransactions.map((tx, index) => {
                      const account = accountsById.get(tx.account_id);
                      const note = notesByTxId.get(tx.id);
                      const accountDesc = account ? `${account.nickname} (${ACCOUNT_TYPE_LABELS[account.account_type]})` : ACCOUNT_TYPE_LABELS[tx.account_type];
                      return (
                        <tr key={tx.id} className={index >= 8 ? 'cf-tx-row-deferred' : undefined} onClick={() => onSelectTransaction(tx.id)} style={{ cursor: 'pointer' }}>
                          <td className="tabular-amount">{tx.booking_date}</td>
                          <td>{BANK_LABELS[tx.bank]}</td>
                          <td>{accountDesc}</td>
                          <td>
                            <button
                              type="button"
                              className="cf-touch-target"
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectTransaction(tx.id);
                              }}
                              style={{ border: 0, background: 'transparent', color: 'inherit', font: 'inherit', fontWeight: 600, padding: 0, textAlign: 'start', cursor: 'pointer' }}
                            >
                              {tx.clean_label}
                            </button>
                          </td>
                          <td>{tx.category}{tx.is_manual_category ? ' · Manuel' : ''}</td>
                          <td style={{ color: 'var(--text-secondary)' }}>{note ? note.content : '—'}</td>
                          <td style={{ textAlign: 'end' }} className="tabular-amount">
                            <div>{formatMoney(tx.amount_cents, tx.currency)}</div>
                            {tx.currency === 'USD' && currencyMode === 'eur_consolidated' ? (
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>≈ {formatMoney(tx.amount_eur_cents, 'EUR')}</div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="cf-ledger-mobile-list">
                {filteredTransactions.map((tx, index) => {
                  const account = accountsById.get(tx.account_id);
                  const note = notesByTxId.get(tx.id);
                  const accountLabel = account ? `${account.nickname} · ${ACCOUNT_TYPE_LABELS[account.account_type]}` : ACCOUNT_TYPE_LABELS[tx.account_type];
                  return (
                    <button key={tx.id} type="button" className={`cf-tx-trigger ${index >= 8 ? 'cf-tx-row-deferred' : ''}`} onClick={() => onSelectTransaction(tx.id)}>
                      <span className="cf-row-line">
                        <span className="cf-truncate" style={{ fontWeight: 600 }}>{tx.clean_label}</span>
                        <span className="tabular-amount" style={{ fontWeight: 600, flexShrink: 0 }}>{formatMoney(tx.amount_cents, tx.currency)}</span>
                      </span>
                      <span className="cf-row-line" style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        <span className="cf-truncate">{tx.booking_date} · {BANK_LABELS[tx.bank]} · {accountLabel} · {tx.category}</span>
                        {tx.currency === 'USD' && currencyMode === 'eur_consolidated' ? (
                          <span className="tabular-amount" style={{ flexShrink: 0 }}>≈ {formatMoney(tx.amount_eur_cents, 'EUR')}</span>
                        ) : null}
                      </span>
                      {note ? <span className="cf-truncate" style={{ fontSize: '0.8125rem', color: 'var(--accent)' }}>Note : {note.content}</span> : null}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
});

export default TransactionsSection;
