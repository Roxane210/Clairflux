import {
  formatMoney,
  type Account,
  type Category,
  type Transaction,
  type TransactionId,
} from '@clairflux/shared';
import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { ACCOUNT_TYPE_LABELS, BANK_LABELS } from '../dashboard/types';
import {
  GroupedCategorySelectOptions,
  isDialogBackdropClickOutside,
} from './CategorySelectors';

export interface BottomSheetNoteDialogProps {
  readonly transaction: Transaction | null;
  readonly account: Account | null;
  readonly categories?: readonly Category[] | undefined;
  readonly currentNote: string;
  readonly isOnline: boolean;
  readonly onClose: () => void;
  readonly onSaveQuickNote: (transactionId: TransactionId, content: string) => void;
  readonly onUpdateCategory: (
    transactionId: TransactionId,
    category: string,
    isInternalTransfer: boolean,
  ) => void;
  readonly onCreateRuleFromLabel: (label: string) => void;
}

export const BottomSheetNoteDialog = memo(function BottomSheetNoteDialog({
  transaction,
  account,
  categories,
  currentNote,
  isOnline,
  onClose,
  onSaveQuickNote,
  onUpdateCategory,
  onCreateRuleFromLabel,
}: BottomSheetNoteDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const noteInputId = useId();
  const categorySelectId = useId();

  const [noteText, setNoteText] = useState(currentNote);
  const [category, setCategory] = useState(transaction?.category ?? 'Alimentation');
  const [isInternalTransfer, setIsInternalTransfer] = useState(transaction?.is_internal_transfer ?? false);
  const [noteSavedOffline, setNoteSavedOffline] = useState(false);

  useEffect(() => {
    setNoteText(currentNote);
    setCategory(transaction?.category ?? 'Alimentation');
    setIsInternalTransfer(transaction?.is_internal_transfer ?? false);
    setNoteSavedOffline(false);
  }, [transaction, currentNote]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (transaction !== null && !dialog.open) {
      dialog.returnValue = '';
      dialog.showModal();
    } else if (transaction === null && dialog.open) {
      dialog.returnValue = '';
      dialog.close();
    }
  }, [transaction]);

  const closeSafely = (): void => {
    if (dialogRef.current) {
      dialogRef.current.returnValue = '';
    }
    onClose();
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>): void => {
    if (isDialogBackdropClickOutside(event, dialogRef.current)) {
      closeSafely();
    }
  };

  const handleNoteSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!transaction) return;
    onSaveQuickNote(transaction.id, noteText.trim());
    setNoteSavedOffline(!isOnline);
  };

  const handleCategorySubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!transaction) return;
    onUpdateCategory(transaction.id, category, isInternalTransfer);
  };

  const accountLabel = account
    ? `${account.nickname} (${ACCOUNT_TYPE_LABELS[account.account_type]})`
    : transaction
      ? ACCOUNT_TYPE_LABELS[transaction.account_type]
      : '';

  return (
    <dialog
      ref={dialogRef}
      className="cf-dialog"
      style={{ padding: 0 }}
      aria-labelledby={titleId}
      onClick={handleBackdropClick}
      onCancel={(e) => {
        e.preventDefault();
        closeSafely();
      }}
      onClose={closeSafely}
    >
      {transaction ? (
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <h2 id={titleId} style={{ fontSize: '1.125rem', minInlineSize: 0, overflowWrap: 'anywhere' }}>
              {transaction.clean_label}
            </h2>
            <button type="button" className="cf-btn" onClick={closeSafely}>Fermer</button>
          </div>

          <div
            style={{
              paddingBlock: '12px',
              borderBlock: '1px solid var(--border-subtle)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
              <div>{BANK_LABELS[transaction.bank]} · {accountLabel}</div>
              <div className="tabular-amount">{transaction.booking_date}</div>
              <div style={{ marginBlockStart: '4px', overflowWrap: 'anywhere' }}>
                Libellé relevé : {transaction.raw_label}
              </div>
            </div>
            <div style={{ textAlign: 'end' }} className="tabular-amount">
              <div style={{ fontSize: '1.125rem', fontWeight: 700 }}>
                {formatMoney(transaction.amount_cents, transaction.currency)}
              </div>
              {transaction.currency === 'USD' ? (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  ≈ {formatMoney(transaction.amount_eur_cents, 'EUR')}
                </div>
              ) : null}
            </div>
          </div>

          <form onSubmit={handleNoteSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div className="cf-field-group">
              <label htmlFor={noteInputId} className="cf-field-label">Note rapide</label>
              <textarea
                id={noteInputId}
                rows={3}
                maxLength={2000}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                className="cf-field-input"
                placeholder="Ajouter une précision comptable ou personnelle…"
              />
            </div>
            <button type="submit" className="cf-btn cf-btn-primary">Enregistrer la note</button>
            {!isOnline ? (
              <p role="status" style={{ fontSize: '0.8125rem', color: 'var(--warning)' }}>
                {noteSavedOffline
                  ? "Enregistré localement dans l'outbox — synchro auto au retour réseau"
                  : "Mode hors-ligne : enregistré localement dans l'outbox — synchro auto au retour réseau"}
              </p>
            ) : null}
          </form>

          <form
            onSubmit={handleCategorySubmit}
            style={{
              paddingBlockStart: '12px',
              borderBlockStart: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div className="cf-field-group">
              <label htmlFor={categorySelectId} className="cf-field-label">
                Catégorie manuelle (protégée contre l'écrasement par les règles)
              </label>
              <select
                id={categorySelectId}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="cf-field-input"
              >
                <GroupedCategorySelectOptions categories={categories} selectedValue={category} />
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', minBlockSize: '44px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isInternalTransfer}
                onChange={(e) => setIsInternalTransfer(e.target.checked)}
                style={{ inlineSize: '20px', blockSize: '20px' }}
              />
              <span>Marquer comme transfert interne (exclu des dépenses)</span>
            </label>
            <button type="submit" className="cf-btn">Mettre à jour la catégorie</button>
          </form>

          <button type="button" className="cf-btn" onClick={() => onCreateRuleFromLabel(transaction.clean_label)}>
            Créer une règle depuis ce libellé
          </button>
        </div>
      ) : null}
    </dialog>
  );
});

export default BottomSheetNoteDialog;
