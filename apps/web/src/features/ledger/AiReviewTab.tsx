import {
  extractMerchantPatternForRule,
  formatMoney,
  toCents,
  type AiReviewItem,
  type AiRuleSuggestion,
  type Category,
  type ResolveAiReviewDecision,
} from '@clairflux/shared';
import { memo, useMemo, useState, type ReactElement } from 'react';
import type { AiActionResult } from '../../offline/useOfflineStore';
import { CategoryTwoLevelSelect, type CategoryTwoLevelPair } from './CategorySelectors';

export interface AiReviewTabProps {
  readonly items: readonly AiReviewItem[];
  readonly suggestions: readonly AiRuleSuggestion[];
  readonly categories?: readonly Category[] | undefined;
  readonly isOnline: boolean;
  readonly isAiLoading: boolean;
  readonly onRefreshQueue: () => void;
  readonly onResolveDecisions: (decisions: readonly ResolveAiReviewDecision[]) => Promise<AiActionResult>;
  readonly onAcceptSuggestion: (id: string) => Promise<AiActionResult>;
  readonly onDismissSuggestion: (id: string) => Promise<AiActionResult>;
}

const HEADER_ROW_STYLE = {
  padding: '16px',
  borderBlockEnd: '1px solid var(--border-subtle)',
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
} as const;

const WRAP_GAP = { display: 'flex', flexWrap: 'wrap', gap: '8px' } as const;

export const AiReviewTab = memo(function AiReviewTab({
  items,
  suggestions,
  categories,
  isOnline,
  isAiLoading,
  onRefreshQueue,
  onResolveDecisions,
  onAcceptSuggestion,
  onDismissSuggestion,
}: AiReviewTabProps): ReactElement {
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [selectedIdByTx, setSelectedIdByTx] = useState<Readonly<Record<string, string>>>({});
  const [pairByTx, setPairByTx] = useState<Readonly<Record<string, CategoryTwoLevelPair | null>>>({});

  const highConfidenceItems = useMemo(() => items.filter((item) => item.ai_confidence_bp >= 8000), [items]);
  const pendingSuggestions = useMemo(() => suggestions.filter((sug) => sug.status === 'pending'), [suggestions]);
  const isDisabled = !isOnline || isAiLoading;

  const handleBulkAccept = (): void => {
    if (isDisabled || highConfidenceItems.length === 0) return;
    void onResolveDecisions(highConfidenceItems.map((i) => ({ transaction_id: i.transaction_id, action: 'accept' })));
  };

  const handleOpenOverride = (item: AiReviewItem): void => {
    if (editingTxId === item.transaction_id) {
      setEditingTxId(null);
      return;
    }
    setSelectedIdByTx((p) => ({ ...p, [item.transaction_id]: item.suggested_subcategory_id ?? item.suggested_category_id }));
    setPairByTx((p) => ({
      ...p,
      [item.transaction_id]: {
        category_id: item.suggested_category_id as CategoryTwoLevelPair['category_id'],
        subcategory_id: item.suggested_subcategory_id as CategoryTwoLevelPair['subcategory_id'],
      },
    }));
    setEditingTxId(item.transaction_id);
  };

  const handleApplyOverride = (item: AiReviewItem): void => {
    const pair = pairByTx[item.transaction_id];
    if (isDisabled || !pair) return;
    void onResolveDecisions([
      { transaction_id: item.transaction_id, action: 'override', category_id: pair.category_id, subcategory_id: pair.subcategory_id },
    ]).then((res) => {
      if (res.ok) setEditingTxId(null);
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={HEADER_ROW_STYLE}>
        <div>
          <h3 style={{ fontSize: '1rem' }}>Boîte de révision IA (&lt; 85 % de confiance)</h3>
          <p className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            {items.length} opération(s) en attente · {pendingSuggestions.length} suggestion(s) de règle
          </p>
        </div>
        <div style={WRAP_GAP}>
          <button type="button" className="cf-btn" disabled={isDisabled} onClick={onRefreshQueue}>Actualiser</button>
          {highConfidenceItems.length > 0 ? (
            <button type="button" className="cf-btn cf-btn-primary" disabled={isDisabled} onClick={handleBulkAccept}>
              Tout accepter &gt;= 80 % ({highConfidenceItems.length})
            </button>
          ) : null}
        </div>
      </div>

      {!isOnline ? (
        <p role="note" style={{ padding: '12px 16px', borderBlockEnd: '1px solid var(--border-subtle)', color: 'var(--warning)', fontWeight: 600 }}>
          Mode hors-ligne : consultation locale uniquement. Connexion requise pour valider, corriger ou accepter des règles IA.
        </p>
      ) : null}

      {items.length === 0 ? (
        <p style={{ padding: '24px 16px', borderBlockEnd: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
          Tout est classé ! Aucune suggestion IA en attente de validation.
        </p>
      ) : (
        <div>
          {items.map((item) => {
            const proposed = item.suggested_subcategory_name
              ? `${item.suggested_category_name} › ${item.suggested_subcategory_name}`
              : item.suggested_category_name;
            const isEditing = editingTxId === item.transaction_id;
            const pattern = extractMerchantPatternForRule(item.clean_label);

            return (
              <article key={item.transaction_id} className="cf-ai-review-row">
                <div className="cf-row-line">
                  <div style={{ minInlineSize: 0 }}>
                    <span className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{item.date}</span>{' '}
                    <span style={{ fontWeight: 600 }}>{item.clean_label}</span>
                  </div>
                  <div style={{ textAlign: 'end', flexShrink: 0 }} className="tabular-amount">
                    <span style={{ fontWeight: 600 }}>{formatMoney(toCents(item.amount_cents), item.currency)}</span>
                    {item.currency === 'USD' ? (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>≈ {formatMoney(toCents(item.amount_eur_cents), 'EUR')}</div>
                    ) : null}
                  </div>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', fontSize: '0.8125rem' }}>
                  <span>Proposition : <strong>{proposed}</strong></span>
                  <span className="tabular-amount" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                    Confiance : {Math.round(item.ai_confidence_bp / 100)} %
                  </span>
                  {item.ai_model ? <span style={{ color: 'var(--text-muted)' }}>Modèle : {item.ai_model}</span> : null}
                </div>

                {item.ai_reason ? (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', overflowWrap: 'anywhere' }}>{item.ai_reason}</p>
                ) : null}

                {isEditing ? (
                  <div style={{ ...WRAP_GAP, alignItems: 'center' }}>
                    <div style={{ flex: '1 1 220px', minInlineSize: 0 }}>
                      <CategoryTwoLevelSelect
                        ariaLabel={`Catégorie corrigée pour ${item.clean_label}`}
                        categories={categories}
                        value={selectedIdByTx[item.transaction_id] ?? ''}
                        disabled={isDisabled}
                        onChange={(selectedId, pair) => {
                          setSelectedIdByTx((p) => ({ ...p, [item.transaction_id]: selectedId }));
                          setPairByTx((p) => ({ ...p, [item.transaction_id]: pair }));
                        }}
                      />
                    </div>
                    <button type="button" className="cf-btn cf-btn-primary" disabled={isDisabled || !pairByTx[item.transaction_id]} onClick={() => handleApplyOverride(item)}>
                      Appliquer
                    </button>
                  </div>
                ) : null}

                <div style={WRAP_GAP}>
                  <button type="button" className="cf-btn cf-btn-primary" disabled={isDisabled} onClick={() => void onResolveDecisions([{ transaction_id: item.transaction_id, action: 'accept' }])}>
                    Valider
                  </button>
                  <button type="button" className="cf-btn" disabled={isDisabled} aria-expanded={isEditing} onClick={() => handleOpenOverride(item)}>
                    Corriger
                  </button>
                  <button
                    type="button"
                    className="cf-btn"
                    disabled={isDisabled}
                    onClick={() =>
                      void onResolveDecisions([
                        { transaction_id: item.transaction_id, action: 'accept', create_rule: true, ...(pattern !== null ? { rule_pattern: pattern } : {}) },
                      ])
                    }
                  >
                    Valider + Règle
                  </button>
                  <button type="button" className="cf-btn" disabled={isDisabled} onClick={() => void onResolveDecisions([{ transaction_id: item.transaction_id, action: 'reject' }])}>
                    Ignorer
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div style={HEADER_ROW_STYLE}>
        <div>
          <h3 style={{ fontSize: '1rem' }}>Suggestions de règles gratuites</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Transformez les libellés récurrents validés par l'IA en règles gratuites instantanées.
          </p>
        </div>
      </div>

      {pendingSuggestions.length === 0 ? (
        <p style={{ padding: '20px 16px', color: 'var(--text-secondary)' }}>
          Aucune nouvelle suggestion de règle détectée pour le moment.
        </p>
      ) : (
        <div>
          {pendingSuggestions.map((sug) => {
            const target = sug.target_subcategory_name ? `${sug.target_category_name} › ${sug.target_subcategory_name}` : sug.target_category_name;
            return (
              <div key={sug.id} style={HEADER_ROW_STYLE}>
                <div style={{ minInlineSize: 0 }}>
                  <p style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>Motif « {sug.merchant_pattern} » → {target}</p>
                  <p className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                    {sug.sample_count} opération(s) concernée(s)
                  </p>
                </div>
                <div style={WRAP_GAP}>
                  <button type="button" className="cf-btn cf-btn-primary" disabled={isDisabled} onClick={() => void onAcceptSuggestion(sug.id)}>
                    Accepter la règle
                  </button>
                  <button type="button" className="cf-btn" disabled={isDisabled} onClick={() => void onDismissSuggestion(sug.id)}>
                    Ignorer
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default AiReviewTab;
