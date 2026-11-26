import {
  DEFAULT_FRENCH_CATEGORY_PACK,
  buildCategoryTree,
  isProtectedSystemCategory,
  type BudgetGroup,
  type Category,
  type CategoryTreeNode,
} from '@clairflux/shared';
import { memo, useMemo, useState, type ReactElement } from 'react';
import type {
  CategoryActionResult,
  CreateCategoryInput,
  DeleteCategoryInput,
  MergeCategoryInput,
  UpdateCategoryInput,
} from '../../offline/useOfflineStore';
import { CategoryFormDialog, type CategoryDialogRequest } from './CategoryFormDialog';
import { BUDGET_GROUP_LABELS, BUDGET_GROUP_ORDER } from './CategorySelectors';

export interface CategoriesTabProps {
  readonly categories?: readonly Category[] | undefined;
  readonly isOnline: boolean;
  readonly onCreateCategory: (input: CreateCategoryInput) => Promise<CategoryActionResult>;
  readonly onUpdateCategory: (input: UpdateCategoryInput) => Promise<CategoryActionResult>;
  readonly onMergeCategory: (input: MergeCategoryInput) => Promise<CategoryActionResult>;
  readonly onDeleteCategory: (input: DeleteCategoryInput) => Promise<CategoryActionResult>;
}

export const CategoriesTab = memo(function CategoriesTab({
  categories,
  isOnline,
  onCreateCategory,
  onUpdateCategory,
  onMergeCategory,
  onDeleteCategory,
}: CategoriesTabProps): ReactElement {
  const [dialogRequest, setDialogRequest] = useState<CategoryDialogRequest | null>(null);

  const effectiveCategories = useMemo(
    () =>
      categories !== undefined && categories.length > 0
        ? categories
        : DEFAULT_FRENCH_CATEGORY_PACK,
    [categories],
  );

  const activeCategories = useMemo(
    () => effectiveCategories.filter((cat) => !cat.is_archived),
    [effectiveCategories],
  );

  const groupedRoots = useMemo(() => {
    const tree = buildCategoryTree(activeCategories);
    const byGroup = new Map<BudgetGroup, CategoryTreeNode[]>();
    for (const group of BUDGET_GROUP_ORDER) {
      byGroup.set(group, []);
    }
    for (const root of tree) {
      byGroup.get(root.budget_group)?.push(root);
    }
    return BUDGET_GROUP_ORDER.map((group) => ({
      group,
      label: BUDGET_GROUP_LABELS[group],
      roots: byGroup.get(group) ?? [],
    })).filter((entry) => entry.roots.length > 0);
  }, [activeCategories]);

  const totalSubcategories = useMemo(
    () => activeCategories.filter((cat) => cat.parent_id !== null).length,
    [activeCategories],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '16px',
          borderBlockEnd: '1px solid var(--border-subtle)',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <div>
          <h3 style={{ fontSize: '1rem' }}>Catégories &amp; Sous-catégories (2 niveaux)</h3>
          <p className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            {activeCategories.length - totalSubcategories} catégories principales · {totalSubcategories} sous-catégories
          </p>
        </div>
        <button
          type="button"
          className="cf-btn cf-btn-primary"
          disabled={!isOnline}
          onClick={() => setDialogRequest({ kind: 'create', parentCategory: null })}
        >
          {isOnline ? '+ Nouvelle catégorie' : 'Connexion requise pour modifier'}
        </button>
      </div>

      {!isOnline ? (
        <p role="note" style={{ padding: '12px 16px', borderBlockEnd: '1px solid var(--border-subtle)', color: 'var(--warning)', fontWeight: 600 }}>
          Mode hors-ligne : consultation locale active. Connexion requise pour créer, modifier, fusionner ou supprimer une catégorie.
        </p>
      ) : null}

      <div>
        {groupedRoots.map(({ group, label, roots }) => (
          <details key={group} open className="cf-cat-group-details">
            <summary className="cf-cat-group-summary">
              <span>{label}</span>
              <span className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                {roots.length} catégorie(s)
              </span>
            </summary>

            <div>
              {roots.map((root) => {
                const isRootProtected = isProtectedSystemCategory(root);
                const hasChildren = root.children.length > 0;
                return (
                  <details key={root.id} open className="cf-cat-root-details">
                    <summary className="cf-cat-root-summary">
                      <span>{root.name}{isRootProtected ? ' · Protégée' : ''}</span>
                      <span className="tabular-amount" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                        {root.children.length} sous-catégorie(s)
                      </span>
                    </summary>

                    <div className="cf-cat-children">
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        <button type="button" className="cf-btn" disabled={!isOnline} onClick={() => setDialogRequest({ kind: 'create', parentCategory: root })}>
                          + Sous-catégorie
                        </button>
                        <button type="button" className="cf-btn" disabled={!isOnline} onClick={() => setDialogRequest({ kind: 'edit', category: root })}>
                          Modifier
                        </button>
                        <button type="button" className="cf-btn" disabled={!isOnline || isRootProtected} onClick={() => setDialogRequest({ kind: 'merge', category: root })}>
                          Fusionner
                        </button>
                        <button
                          type="button"
                          className="cf-btn"
                          disabled={!isOnline || isRootProtected || hasChildren}
                          title={hasChildren ? "Supprimez d'abord les sous-catégories." : undefined}
                          onClick={() => setDialogRequest({ kind: 'delete', category: root })}
                        >
                          Supprimer
                        </button>
                      </div>

                      {root.children.map((sub) => {
                        const isSubProtected = isProtectedSystemCategory(sub);
                        return (
                          <div key={sub.id} className="cf-cat-child-row">
                            <span style={{ fontWeight: 500 }}>{sub.name}{isSubProtected ? ' · Protégée' : ''}</span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                              <button type="button" className="cf-btn" disabled={!isOnline} onClick={() => setDialogRequest({ kind: 'edit', category: sub })}>
                                Modifier
                              </button>
                              <button type="button" className="cf-btn" disabled={!isOnline || isSubProtected} onClick={() => setDialogRequest({ kind: 'merge', category: sub })}>
                                Fusionner
                              </button>
                              <button type="button" className="cf-btn" disabled={!isOnline || isSubProtected} onClick={() => setDialogRequest({ kind: 'delete', category: sub })}>
                                Supprimer
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                );
              })}
            </div>
          </details>
        ))}
      </div>

      <CategoryFormDialog
        request={dialogRequest}
        categories={effectiveCategories}
        isOnline={isOnline}
        onClose={() => setDialogRequest(null)}
        onCreateCategory={onCreateCategory}
        onUpdateCategory={onUpdateCategory}
        onMergeCategory={onMergeCategory}
        onDeleteCategory={onDeleteCategory}
      />
    </div>
  );
});

export default CategoriesTab;
