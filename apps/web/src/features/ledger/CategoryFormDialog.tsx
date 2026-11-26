import {
  buildCategoryTree,
  type BudgetGroup,
  type Category,
  type CategoryId,
} from '@clairflux/shared';
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import type {
  CategoryActionResult,
  CreateCategoryInput,
  DeleteCategoryInput,
  MergeCategoryInput,
  UpdateCategoryInput,
} from '../../offline/useOfflineStore';
import {
  BUDGET_GROUP_LABELS,
  BUDGET_GROUP_ORDER,
  COLOR_TOKEN_OPTIONS,
  isDialogBackdropClickOutside,
} from './CategorySelectors';

export type CategoryDialogRequest =
  | { readonly kind: 'create'; readonly parentCategory: Category | null }
  | { readonly kind: 'edit'; readonly category: Category }
  | { readonly kind: 'merge'; readonly category: Category }
  | { readonly kind: 'delete'; readonly category: Category };

export interface CategoryFormDialogProps {
  readonly request: CategoryDialogRequest | null;
  readonly categories: readonly Category[];
  readonly isOnline: boolean;
  readonly onClose: () => void;
  readonly onCreateCategory: (input: CreateCategoryInput) => Promise<CategoryActionResult>;
  readonly onUpdateCategory: (input: UpdateCategoryInput) => Promise<CategoryActionResult>;
  readonly onMergeCategory: (input: MergeCategoryInput) => Promise<CategoryActionResult>;
  readonly onDeleteCategory: (input: DeleteCategoryInput) => Promise<CategoryActionResult>;
}

export const CategoryFormDialog = memo(function CategoryFormDialog({
  request,
  categories,
  isOnline,
  onClose,
  onCreateCategory,
  onUpdateCategory,
  onMergeCategory,
  onDeleteCategory,
}: CategoryFormDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const nameInputId = useId();
  const nameErrorId = useId();
  const groupSelectId = useId();
  const colorSelectId = useId();
  const targetSelectId = useId();
  const targetErrorId = useId();

  const [name, setName] = useState('');
  const [budgetGroup, setBudgetGroup] = useState<BudgetGroup>('variable');
  const [colorToken, setColorToken] = useState('emerald');
  const [targetId, setTargetId] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [targetTouched, setTargetTouched] = useState(false);
  const [submittedInvalid, setSubmittedInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const tree = useMemo(
    () => buildCategoryTree(categories.filter((cat) => !cat.is_archived)),
    [categories],
  );

  const sourceId =
    request !== null && request.kind !== 'create' ? request.category.id : null;

  const targetCandidates = useMemo(() => {
    return tree
      .filter((root) => root.id !== sourceId)
      .map((root) => ({
        root,
        children: root.children.filter((sub) => sub.id !== sourceId),
      }));
  }, [tree, sourceId]);

  useEffect(() => {
    setServerError(null);
    setSubmittedInvalid(false);
    setNameTouched(false);
    setTargetTouched(false);
    setSubmitting(false);

    if (request === null) {
      return;
    }

    if (request.kind === 'create') {
      setName('');
      setBudgetGroup(request.parentCategory?.budget_group ?? 'variable');
      setColorToken(request.parentCategory?.color_token ?? 'emerald');
      setTargetId('');
    } else if (request.kind === 'edit') {
      setName(request.category.name);
      setBudgetGroup(request.category.budget_group);
      setColorToken(request.category.color_token);
      setTargetId('');
    } else {
      const firstRoot = targetCandidates[0]?.root;
      setName(request.category.name);
      setTargetId(firstRoot?.id ?? '');
    }
  }, [request, targetCandidates]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (request !== null && !dialog.open) {
      dialog.returnValue = '';
      dialog.showModal();
    } else if (request === null && dialog.open) {
      dialog.returnValue = '';
      dialog.close();
    }
  }, [request]);

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

  const isNameInvalid =
    (request?.kind === 'create' || request?.kind === 'edit') &&
    (nameTouched || submittedInvalid) &&
    name.trim().length < 1;

  const isTargetInvalid =
    (request?.kind === 'merge' || request?.kind === 'delete') &&
    (targetTouched || submittedInvalid) &&
    targetId.trim().length === 0;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!request || !isOnline || submitting) {
      return;
    }
    setServerError(null);

    if (request.kind === 'create' || request.kind === 'edit') {
      if (name.trim().length < 1) {
        setSubmittedInvalid(true);
        return;
      }
    } else if (targetId.trim().length === 0) {
      setSubmittedInvalid(true);
      return;
    }

    setSubmitting(true);
    let outcome: CategoryActionResult;
    if (request.kind === 'create') {
      outcome = await onCreateCategory({
        parent_id: request.parentCategory?.id ?? null,
        name: name.trim(),
        budget_group: budgetGroup,
        color_token: colorToken,
      });
    } else if (request.kind === 'edit') {
      outcome = await onUpdateCategory({
        id: request.category.id,
        name: name.trim(),
        budget_group: budgetGroup,
        color_token: colorToken,
      });
    } else {
      const selectedCat = categories.find((cat) => cat.id === targetId);
      const targetRootId: CategoryId =
        selectedCat?.parent_id ?? (targetId as CategoryId);
      const targetSubId: CategoryId | null =
        selectedCat !== undefined && selectedCat.parent_id !== null
          ? selectedCat.id
          : null;

      if (request.kind === 'merge') {
        outcome = await onMergeCategory({
          sourceCategoryId: request.category.id,
          target_category_id: targetRootId,
          target_subcategory_id: targetSubId,
        });
      } else {
        outcome = await onDeleteCategory({
          id: request.category.id,
          reassign_to_category_id: targetRootId,
          reassign_to_subcategory_id: targetSubId,
        });
      }
    }

    setSubmitting(false);
    if (!outcome.ok) {
      setServerError(outcome.message);
      return;
    }
    closeSafely();
  };

  const title =
    request?.kind === 'create'
      ? request.parentCategory
        ? `Nouvelle sous-catégorie de « ${request.parentCategory.name} »`
        : 'Nouvelle catégorie principale'
      : request?.kind === 'edit'
        ? `Modifier « ${request.category.name} »`
        : request?.kind === 'merge'
          ? `Fusionner « ${request.category.name} »`
          : request?.kind === 'delete'
            ? `Supprimer « ${request.category.name} »`
            : '';

  return (
    <dialog
      ref={dialogRef}
      className="cf-dialog cf-dialog--modal"
      style={{ padding: 0 }}
      aria-labelledby={titleId}
      onClick={handleBackdropClick}
      onCancel={(e) => {
        e.preventDefault();
        closeSafely();
      }}
      onClose={closeSafely}
    >
      {request ? (
        <form
          noValidate
          onSubmit={(e) => void handleSubmit(e)}
          style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
            <h3 id={titleId} style={{ fontSize: '1.125rem' }}>{title}</h3>
            <button type="button" className="cf-btn" onClick={closeSafely}>Fermer</button>
          </div>

          {!isOnline ? (
            <p role="note" style={{ color: 'var(--warning)', fontWeight: 600 }}>
              Connexion requise pour modifier les catégories.
            </p>
          ) : null}

          {request.kind === 'create' || request.kind === 'edit' ? (
            <>
              <div className="cf-field-group">
                <label htmlFor={nameInputId} className="cf-field-label">Nom</label>
                <input
                  id={nameInputId}
                  type="text"
                  required
                  minLength={1}
                  maxLength={64}
                  disabled={!isOnline || submitting}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  aria-invalid={isNameInvalid}
                  aria-describedby={isNameInvalid ? nameErrorId : undefined}
                  className={`cf-field-input ${isNameInvalid ? 'user-invalid-fallback' : ''}`}
                  placeholder="Ex. Marchés & Primeurs"
                />
                <span id={nameErrorId} className="cf-field-error">
                  Veuillez saisir un nom de catégorie (1 à 64 caractères).
                </span>
              </div>

              <div className="cf-field-group">
                <label htmlFor={groupSelectId} className="cf-field-label">Groupe budgétaire</label>
                <select
                  id={groupSelectId}
                  disabled={!isOnline || submitting}
                  value={budgetGroup}
                  onChange={(e) => setBudgetGroup(e.target.value as BudgetGroup)}
                  className="cf-field-input"
                >
                  {BUDGET_GROUP_ORDER.map((group) => (
                    <option key={group} value={group}>{BUDGET_GROUP_LABELS[group]}</option>
                  ))}
                </select>
              </div>

              <div className="cf-field-group">
                <label htmlFor={colorSelectId} className="cf-field-label">Couleur d'accentuation</label>
                <select
                  id={colorSelectId}
                  disabled={!isOnline || submitting}
                  value={colorToken}
                  onChange={(e) => setColorToken(e.target.value)}
                  className="cf-field-input"
                >
                  {COLOR_TOKEN_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div className="cf-field-group">
              <label htmlFor={targetSelectId} className="cf-field-label">
                {request.kind === 'merge'
                  ? 'Catégorie cible (les opérations et règles y seront transférées)'
                  : 'Réaffecter obligatoirement les opérations existantes vers'}
              </label>
              <select
                id={targetSelectId}
                required
                disabled={!isOnline || submitting}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                onBlur={() => setTargetTouched(true)}
                aria-invalid={isTargetInvalid}
                aria-describedby={isTargetInvalid ? targetErrorId : undefined}
                className={`cf-field-input ${isTargetInvalid ? 'user-invalid-fallback' : ''}`}
              >
                <option value="">Sélectionner une catégorie cible…</option>
                {targetCandidates.map(({ root, children }) =>
                  children.length > 0 ? (
                    <optgroup key={root.id} label={root.name}>
                      <option value={root.id}>{root.name} (catégorie générale)</option>
                      {children.map((sub) => (
                        <option key={sub.id} value={sub.id}>{sub.name}</option>
                      ))}
                    </optgroup>
                  ) : (
                    <option key={root.id} value={root.id}>{root.name}</option>
                  ),
                )}
              </select>
              <span id={targetErrorId} className="cf-field-error">
                Une catégorie cible de réaffectation est obligatoire.
              </span>
            </div>
          )}

          {serverError ? (
            <p role="alert" style={{ color: 'var(--danger)', fontWeight: 600 }}>
              {serverError}
            </p>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="cf-btn" onClick={closeSafely}>Annuler</button>
            <button
              type="submit"
              className="cf-btn cf-btn-primary"
              disabled={!isOnline || submitting}
            >
              {submitting
                ? 'Enregistrement…'
                : request.kind === 'create'
                  ? 'Créer'
                  : request.kind === 'edit'
                    ? 'Enregistrer'
                    : request.kind === 'merge'
                      ? 'Fusionner'
                      : 'Supprimer et réaffecter'}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
});

export default CategoryFormDialog;
