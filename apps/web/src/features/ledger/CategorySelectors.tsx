import {
  DEFAULT_FRENCH_CATEGORY_PACK,
  buildCategoryTree,
  type BudgetGroup,
  type Category,
  type CategoryId,
  type CategoryTreeNode,
} from '@clairflux/shared';
import type { MouseEvent, ReactElement } from 'react';
import { LEDGER_CATEGORIES } from './csvExport';

export const BUDGET_GROUP_ORDER: readonly BudgetGroup[] = [
  'income',
  'fixed',
  'variable',
  'non_monthly',
  'savings',
  'transfer',
];

export const BUDGET_GROUP_LABELS: Readonly<Record<BudgetGroup, string>> = {
  income: 'Revenus',
  fixed: 'Charges fixes',
  variable: 'Dépenses variables',
  non_monthly: 'Non-mensuelles',
  savings: 'Épargne & Placements',
  transfer: 'Transferts & Hors budget',
};

export const COLOR_TOKEN_OPTIONS: readonly {
  readonly value: string;
  readonly label: string;
}[] = [
  { value: 'emerald', label: 'Émeraude' },
  { value: 'teal', label: 'Sarcelle' },
  { value: 'indigo', label: 'Indigo' },
  { value: 'blue', label: 'Bleu' },
  { value: 'amber', label: 'Ambre' },
  { value: 'orange', label: 'Orange' },
  { value: 'violet', label: 'Violet' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'rose', label: 'Rose' },
  { value: 'stone', label: 'Pierre' },
  { value: 'slate', label: 'Ardoise' },
  { value: 'neutral', label: 'Neutre' },
];

export interface GroupedCategoryOptionGroup {
  readonly key: string;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface GroupedCategoryOptionsResult {
  readonly groups: readonly GroupedCategoryOptionGroup[];
  readonly standalone: readonly { readonly value: string; readonly label: string }[];
}

export function buildGroupedCategoryOptions(
  categories: readonly Category[] | undefined,
  extraValues: readonly string[] = [],
): GroupedCategoryOptionsResult {
  const source =
    categories !== undefined && categories.length > 0
      ? categories
      : DEFAULT_FRENCH_CATEGORY_PACK;
  const active = source.filter((cat) => !cat.is_archived);
  const tree: readonly CategoryTreeNode[] = buildCategoryTree(active);

  const seenNames = new Set<string>();
  const groups: GroupedCategoryOptionGroup[] = [];
  const standalone: Array<{ readonly value: string; readonly label: string }> = [];

  for (const root of tree) {
    if (root.children.length > 0) {
      const options: Array<{ readonly value: string; readonly label: string }> = [
        { value: root.name, label: `${root.name} (catégorie générale)` },
      ];
      seenNames.add(root.name);
      for (const child of root.children) {
        options.push({ value: child.name, label: child.name });
        seenNames.add(child.name);
      }
      groups.push({
        key: root.id,
        label: root.name,
        options,
      });
    } else {
      standalone.push({ value: root.name, label: root.name });
      seenNames.add(root.name);
    }
  }

  const fallbackOptions: Array<{ readonly value: string; readonly label: string }> = [];
  for (const candidate of [...extraValues, ...LEDGER_CATEGORIES]) {
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !seenNames.has(trimmed)) {
      seenNames.add(trimmed);
      fallbackOptions.push({ value: trimmed, label: trimmed });
    }
  }
  if (fallbackOptions.length > 0) {
    groups.push({
      key: 'legacy-fallback',
      label: 'Autres / Existantes',
      options: fallbackOptions,
    });
  }

  return { groups, standalone };
}

export function GroupedCategorySelectOptions({
  categories,
  selectedValue,
}: {
  readonly categories?: readonly Category[] | undefined;
  readonly selectedValue: string;
}): ReactElement {
  const { groups, standalone } = buildGroupedCategoryOptions(categories, [selectedValue]);

  return (
    <>
      {groups.map((group) => (
        <optgroup key={group.key} label={group.label}>
          {group.options.map((opt) => (
            <option key={`${group.key}-${opt.value}`} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </optgroup>
      ))}
      {standalone.map((opt) => (
        <option key={`standalone-${opt.value}`} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </>
  );
}

/**
 * Resolves a selected category or subcategory UUID into `(category_id, subcategory_id)`
 * matching the 2-level hierarchy invariant.
 */
export interface CategoryTwoLevelPair {
  readonly category_id: CategoryId;
  readonly subcategory_id: CategoryId | null;
}

export function resolveCategoryTwoLevelPair(
  categories: readonly Category[] | undefined,
  selectedId: string,
): CategoryTwoLevelPair | null {
  const source =
    categories !== undefined && categories.length > 0
      ? categories
      : DEFAULT_FRENCH_CATEGORY_PACK;
  const found = source.find((cat) => cat.id === selectedId);
  if (found === undefined) {
    return null;
  }
  if (found.parent_id !== null) {
    return { category_id: found.parent_id, subcategory_id: found.id };
  }
  return { category_id: found.id, subcategory_id: null };
}

export interface CategoryTwoLevelSelectProps {
  readonly id?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly categories?: readonly Category[] | undefined;
  readonly value: string;
  readonly disabled?: boolean | undefined;
  readonly onChange: (selectedId: string, pair: CategoryTwoLevelPair | null) => void;
}

/**
 * 2-level `<select>` (`<optgroup>` root -> subcategory options) returning category IDs.
 */
export function CategoryTwoLevelSelect({
  id,
  ariaLabel,
  categories,
  value,
  disabled = false,
  onChange,
}: CategoryTwoLevelSelectProps): ReactElement {
  const source =
    categories !== undefined && categories.length > 0
      ? categories
      : DEFAULT_FRENCH_CATEGORY_PACK;
  const tree = buildCategoryTree(source.filter((cat) => !cat.is_archived));

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className="cf-field-input"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const nextId = event.target.value;
        onChange(nextId, resolveCategoryTwoLevelPair(source, nextId));
      }}
    >
      <option value="">Choisir une catégorie…</option>
      {tree.map((root) =>
        root.children.length > 0 ? (
          <optgroup key={root.id} label={root.name}>
            <option value={root.id}>{root.name} (catégorie générale)</option>
            {root.children.map((sub) => (
              <option key={sub.id} value={sub.id}>
                {sub.name}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={root.id} value={root.id}>
            {root.name}
          </option>
        ),
      )}
    </select>
  );
}

/**
 * Checks whether a click event on a `<dialog>` landed outside the dialog box (on `::backdrop`).
 */
export function isDialogBackdropClickOutside(
  event: MouseEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement | null,
): boolean {
  if (dialog === null || event.target !== dialog) {
    return false;
  }
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}
