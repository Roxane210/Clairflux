import type {
  Account,
  AccountId,
  Bank,
  CategorizationRule,
  RuleId,
  Transaction,
} from '@clairflux/shared';
import { memo, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { BANK_LABELS } from '../dashboard/types';
import { LEDGER_CATEGORIES } from './csvExport';

export interface SaveRuleInput {
  readonly id?: RuleId;
  readonly name: string;
  readonly pattern: string;
  readonly targetCategory: string;
  readonly bankFilter: Bank | null;
  readonly accountIdFilter: AccountId | null;
}

export interface RulesTabProps {
  readonly accounts: readonly Account[];
  readonly transactions: readonly Transaction[];
  readonly rules: readonly CategorizationRule[];
  readonly isOnline: boolean;
  readonly rulePrefillPattern: string;
  readonly onSaveRule: (input: SaveRuleInput) => void;
  readonly onReorderRule: (ruleId: RuleId, direction: 'up' | 'down') => void;
  readonly onToggleRule: (ruleId: RuleId) => void;
  readonly onReapplyRules: () => void;
}

const SECTION_STYLE = {
  padding: '16px',
  borderBlockEnd: '1px solid var(--border-subtle)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
} as const;

export const RulesTab = memo(function RulesTab({
  accounts,
  transactions,
  rules,
  isOnline,
  rulePrefillPattern,
  onSaveRule,
  onReorderRule,
  onToggleRule,
  onReapplyRules,
}: RulesTabProps): ReactElement {
  const [editingRuleId, setEditingRuleId] = useState<RuleId | null>(null);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState(rulePrefillPattern);
  const [targetCategory, setTargetCategory] = useState(LEDGER_CATEGORIES[0] ?? 'Alimentation');
  const [bankFilter, setBankFilter] = useState<Bank | null>(null);
  const [accountIdFilter, setAccountIdFilter] = useState<AccountId | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [patternTouched, setPatternTouched] = useState(false);
  const [submittedInvalid, setSubmittedInvalid] = useState(false);

  useEffect(() => {
    const trimmed = rulePrefillPattern.trim();
    if (trimmed.length > 0) {
      setEditingRuleId(null);
      setPattern(trimmed);
      setPatternTouched(false);
    }
  }, [rulePrefillPattern]);

  const sortedRules = useMemo(
    () => [...rules].sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id))),
    [rules],
  );

  const visibleAccounts = useMemo(
    () => (bankFilter ? accounts.filter((acc) => acc.bank === bankFilter) : accounts),
    [accounts, bankFilter],
  );

  const previewMatchCount = useMemo(() => {
    const query = pattern.trim().toUpperCase();
    if (query.length < 2) return 0;
    return transactions.filter((tx) => {
      if (tx.is_manual_category || tx.is_internal_transfer) return false;
      if (bankFilter && tx.bank !== bankFilter) return false;
      if (accountIdFilter && tx.account_id !== accountIdFilter) return false;
      return tx.raw_label.toUpperCase().includes(query) || tx.clean_label.toUpperCase().includes(query);
    }).length;
  }, [pattern, transactions, bankFilter, accountIdFilter]);

  const isNameInvalid = (nameTouched || submittedInvalid) && name.trim().length < 2;
  const isPatternInvalid = (patternTouched || submittedInvalid) && pattern.trim().length < 2;

  const resetForm = (): void => {
    setEditingRuleId(null);
    setName('');
    setPattern('');
    setTargetCategory(LEDGER_CATEGORIES[0] ?? 'Alimentation');
    setBankFilter(null);
    setAccountIdFilter(null);
    setNameTouched(false);
    setPatternTouched(false);
    setSubmittedInvalid(false);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!isOnline) return;
    if (name.trim().length < 2 || pattern.trim().length < 2) {
      setSubmittedInvalid(true);
      return;
    }
    const payload = { name: name.trim(), pattern: pattern.trim(), targetCategory, bankFilter, accountIdFilter };
    onSaveRule(editingRuleId !== null ? { id: editingRuleId, ...payload } : payload);
    resetForm();
  };

  const startEdit = (rule: CategorizationRule): void => {
    setEditingRuleId(rule.id);
    setName(rule.name);
    setPattern(rule.pattern);
    setTargetCategory(rule.target_category);
    setBankFilter(rule.bank_filter);
    setAccountIdFilter(rule.account_id_filter);
    setNameTouched(false);
    setPatternTouched(false);
    setSubmittedInvalid(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <form onSubmit={handleSubmit} noValidate style={SECTION_STYLE}>
        <h3 style={{ fontSize: '1rem' }}>
          {editingRuleId ? 'Modifier la règle sélectionnée' : 'Nouvelle règle automatique'}
        </h3>
        <div className="cf-field-group">
          <label htmlFor="cf-rule-name" className="cf-field-label">Nom de la règle</label>
          <input
            id="cf-rule-name"
            type="text"
            required
            minLength={2}
            maxLength={100}
            disabled={!isOnline}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setNameTouched(true)}
            aria-invalid={isNameInvalid}
            aria-describedby={isNameInvalid ? 'cf-rule-name-error' : undefined}
            className={`cf-field-input ${isNameInvalid ? 'user-invalid-fallback' : ''}`}
            placeholder="Ex. Courses Biocoop"
          />
          <span id="cf-rule-name-error" className="cf-field-error">
            Saisir au moins 2 caractères pour le nom de règle.
          </span>
        </div>

        <div className="cf-field-group">
          <label htmlFor="cf-rule-pattern" className="cf-field-label">Motif dans le libellé</label>
          <input
            id="cf-rule-pattern"
            type="text"
            required
            minLength={2}
            maxLength={200}
            disabled={!isOnline}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onBlur={() => setPatternTouched(true)}
            aria-invalid={isPatternInvalid}
            aria-describedby={isPatternInvalid ? 'cf-rule-pattern-error' : undefined}
            className={`cf-field-input ${isPatternInvalid ? 'user-invalid-fallback' : ''}`}
            placeholder="Ex. BIOCOOP"
          />
          <span id="cf-rule-pattern-error" className="cf-field-error">
            Indiquer un motif d'au moins 2 caractères.
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
          <div className="cf-field-group">
            <label htmlFor="cf-rule-cat" className="cf-field-label">Catégorie cible</label>
            <select id="cf-rule-cat" disabled={!isOnline} value={targetCategory} onChange={(e) => setTargetCategory(e.target.value)} className="cf-field-input">
              {LEDGER_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </div>
          <div className="cf-field-group">
            <label htmlFor="cf-rule-bank" className="cf-field-label">Banque (optionnel)</label>
            <select
              id="cf-rule-bank"
              disabled={!isOnline}
              value={bankFilter ?? ''}
              onChange={(e) => {
                const next = e.target.value;
                setBankFilter(next === 'boursobank' || next === 'revolut' ? next : null);
                setAccountIdFilter(null);
              }}
              className="cf-field-input"
            >
              <option value="">Toutes les banques</option>
              <option value="boursobank">BoursoBank</option>
              <option value="revolut">Revolut</option>
            </select>
          </div>
          <div className="cf-field-group">
            <label htmlFor="cf-rule-account" className="cf-field-label">Compte (optionnel)</label>
            <select
              id="cf-rule-account"
              disabled={!isOnline}
              value={accountIdFilter ?? ''}
              onChange={(e) => {
                const selected = visibleAccounts.find((a) => a.id === e.target.value);
                setAccountIdFilter(selected ? selected.id : null);
              }}
              className="cf-field-input"
            >
              <option value="">Tous les comptes</option>
              {visibleAccounts.map((acc) => <option key={acc.id} value={acc.id}>{acc.nickname}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          <span className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Aperçu : {previewMatchCount} opération(s) éligible(s) (hors catégories manuelles)
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {editingRuleId ? <button type="button" className="cf-btn" onClick={resetForm}>Annuler</button> : null}
            <button type="submit" className="cf-btn cf-btn-primary" disabled={!isOnline}>
              {!isOnline ? 'Connexion requise pour modifier' : editingRuleId ? 'Mettre à jour' : 'Enregistrer la règle'}
            </button>
          </div>
        </div>
      </form>

      <div style={{ padding: '16px', borderBlockEnd: '1px solid var(--border-subtle)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div>
          <h3 style={{ fontSize: '1rem' }}>Ordre de priorité ({sortedRules.length})</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Les catégories manuelles (is_manual_category) ne sont jamais écrasées lors de la réapplication globale.
          </p>
        </div>
        <button type="button" className="cf-btn" disabled={!isOnline} onClick={onReapplyRules}>
          {!isOnline ? 'Connexion requise pour modifier' : 'Réappliquer globalement'}
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {sortedRules.map((rule, index) => (
          <div
            key={rule.id}
            style={{ padding: '12px 16px', borderBlockEnd: '1px solid var(--border-subtle)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}
          >
            <div style={{ minInlineSize: 0 }}>
              <p style={{ fontWeight: 600 }}><span className="tabular-amount">#{rule.priority}</span> · {rule.name}</p>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>
                Motif « {rule.pattern} » → {rule.target_category}
                {rule.bank_filter ? ` · ${BANK_LABELS[rule.bank_filter]}` : ''}
                {' · '}
                {rule.is_active ? 'Active' : 'Inactive'}
              </p>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              <button type="button" className="cf-btn" disabled={!isOnline || index === 0} aria-label={`Monter la règle ${rule.name}`} onClick={() => onReorderRule(rule.id, 'up')}>
                Monter
              </button>
              <button type="button" className="cf-btn" disabled={!isOnline || index === sortedRules.length - 1} aria-label={`Descendre la règle ${rule.name}`} onClick={() => onReorderRule(rule.id, 'down')}>
                Descendre
              </button>
              <button type="button" className="cf-btn" disabled={!isOnline} aria-pressed={rule.is_active} onClick={() => onToggleRule(rule.id)}>
                {rule.is_active ? 'Désactiver' : 'Activer'}
              </button>
              <button type="button" className="cf-btn" disabled={!isOnline} onClick={() => startEdit(rule)}>
                Modifier
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

export default RulesTab;
