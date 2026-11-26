import { z } from 'zod';

// ============================================================================
// Branded Primitives, Normative Enums & Schemas (Lot 1 — Categories v2)
// ============================================================================

const CategorySafeIntSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

const CategorySyncRevisionSchema = CategorySafeIntSchema.nonnegative().brand<'SyncRevision'>();
const CategoryIsoDateTimeSchema = z.string().datetime({ offset: true });

export const CategoryIdSchema = z.string().uuid().brand<'CategoryId'>();
export type CategoryId = z.infer<typeof CategoryIdSchema>;

export function parseCategoryId(value: unknown): CategoryId {
  return CategoryIdSchema.parse(value);
}

export const BudgetGroupSchema = z.enum([
  'fixed',
  'variable',
  'non_monthly',
  'income',
  'savings',
  'transfer',
]);
export type BudgetGroup = z.infer<typeof BudgetGroupSchema>;

export const CategorySourceSchema = z.enum([
  'manual',
  'rule',
  'ai_auto',
  'ai_validated',
  'uncategorized',
]);
export type CategorySource = z.infer<typeof CategorySourceSchema>;

export const AiReviewStatusSchema = z.enum([
  'none',
  'pending_review',
  'accepted',
  'rejected',
]);
export type AiReviewStatus = z.infer<typeof AiReviewStatusSchema>;

export const CategorySchema = z.object({
  id: CategoryIdSchema,
  parent_id: CategoryIdSchema.nullable(),
  name: z.string().trim().min(1).max(64),
  slug: z.string().trim().min(1).max(80),
  budget_group: BudgetGroupSchema,
  color_token: z.string().trim().min(1).max(32),
  sort_order: z.number().int().min(0).max(10000),
  is_system: z.boolean(),
  is_archived: z.boolean(),
  revision: CategorySyncRevisionSchema,
  updated_at: CategoryIsoDateTimeSchema,
});
export type Category = z.infer<typeof CategorySchema>;

export interface CategoryTreeNode extends Category {
  readonly children: readonly Category[];
}

export type CategoryDepthValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'CATEGORY_DEPTH_EXCEEDED';
      readonly message: string;
    };

// ============================================================================
// Pure Category Helpers
// ============================================================================

const MAX_SLUG_LENGTH = 80;
const FALLBACK_SLUG = 'categorie';

function normalizeSlugSegment(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
}

/**
 * Generates a deterministic ASCII kebab-case slug for a category or subcategory,
 * bounded to 80 characters.
 */
export function slugifyCategoryName(name: string, parentSlug?: string | undefined): string {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new Error('Category name must not be empty');
  }

  const baseSegment = normalizeSlugSegment(trimmedName) || FALLBACK_SLUG;
  const trimmedParent = parentSlug?.trim();

  if (trimmedParent === undefined || trimmedParent.length === 0) {
    const truncated = baseSegment.slice(0, MAX_SLUG_LENGTH).replace(/-+$/gu, '');
    return truncated.length > 0 ? truncated : FALLBACK_SLUG;
  }

  const parentSegment = normalizeSlugSegment(trimmedParent);
  if (parentSegment.length === 0) {
    const truncated = baseSegment.slice(0, MAX_SLUG_LENGTH).replace(/-+$/gu, '');
    return truncated.length > 0 ? truncated : FALLBACK_SLUG;
  }

  const combined = `${parentSegment}-${baseSegment}`;
  if (combined.length <= MAX_SLUG_LENGTH) {
    return combined;
  }

  const truncated = combined.slice(0, MAX_SLUG_LENGTH).replace(/-+$/gu, '');
  return truncated.length > 0 ? truncated : FALLBACK_SLUG;
}

/**
 * Enforces the 2-level maximum category hierarchy (`Category -> Subcategory`).
 * A category with a non-null `parent_id` cannot itself become a parent.
 */
export function validateCategoryParentDepth(
  parent: { readonly parent_id: CategoryId | string | null } | null | undefined,
): CategoryDepthValidationResult {
  if (parent === null || parent === undefined) {
    return { ok: true };
  }

  if (parent.parent_id !== null) {
    return {
      ok: false,
      code: 'CATEGORY_DEPTH_EXCEEDED',
      message: 'Une sous-catégorie ne peut pas contenir de sous-catégorie (profondeur max 2 niveaux).',
    };
  }

  return { ok: true };
}

/**
 * Formats a category label for display, prefixing the parent name when present.
 */
export function formatCategoryLabel(
  category: { readonly name: string },
  parent?: { readonly name: string } | null | undefined,
): string {
  const trimmedName = category.name.trim();
  if (parent === null || parent === undefined) {
    return trimmedName;
  }
  const trimmedParent = parent.name.trim();
  if (trimmedParent.length === 0) {
    return trimmedName;
  }
  return `${trimmedParent} › ${trimmedName}`;
}

function compareCategories(a: Category, b: Category): number {
  if (a.sort_order !== b.sort_order) {
    return a.sort_order - b.sort_order;
  }
  return a.name.localeCompare(b.name, 'fr');
}

/**
 * Organizes flat categories into a deterministic 2-level tree sorted by `sort_order` then `name`.
 * Orphan subcategories or depth > 2 entries are omitted to preserve the 2-level tree invariant.
 */
export function buildCategoryTree(categories: readonly Category[]): readonly CategoryTreeNode[] {
  const roots: Category[] = [];
  const rootIds = new Set<CategoryId>();
  const childrenByParentId = new Map<CategoryId, Category[]>();

  for (const cat of categories) {
    if (cat.parent_id === null) {
      roots.push(cat);
      rootIds.add(cat.id);
    }
  }

  for (const cat of categories) {
    if (cat.parent_id !== null && rootIds.has(cat.parent_id)) {
      const existing = childrenByParentId.get(cat.parent_id);
      if (existing !== undefined) {
        existing.push(cat);
      } else {
        childrenByParentId.set(cat.parent_id, [cat]);
      }
    }
  }

  roots.sort(compareCategories);

  return roots.map((root) => {
    const children = [...(childrenByParentId.get(root.id) ?? [])].sort(compareCategories);
    return {
      ...root,
      children,
    };
  });
}

// ============================================================================
// Default French Category Pack (12 Roots + Subcategories + Fallback)
// ============================================================================

export const UNCATEGORIZED_CATEGORY_ID = parseCategoryId('c1000000-0000-4000-8000-000000000999');
export const TRANSFERS_ROOT_CATEGORY_ID = parseCategoryId('c1000000-0000-4000-8000-000000000110');
export const INTERNAL_TRANSFER_SUBCATEGORY_ID = parseCategoryId(
  'c1000000-0000-4000-8000-000000000111',
);

export const PROTECTED_SYSTEM_CATEGORY_IDS: readonly CategoryId[] = [
  UNCATEGORIZED_CATEGORY_ID,
  INTERNAL_TRANSFER_SUBCATEGORY_ID,
];

export const PROTECTED_SYSTEM_CATEGORY_SLUGS = [
  'non-categorise',
  'transferts-hors-budget-transfert-interne',
] as const;

export function isProtectedSystemCategory(
  category: { readonly id: string; readonly slug: string },
): boolean {
  return (
    category.id === UNCATEGORIZED_CATEGORY_ID ||
    category.id === INTERNAL_TRANSFER_SUBCATEGORY_ID ||
    category.slug === 'non-categorise' ||
    category.slug === 'transferts-hors-budget-transfert-interne'
  );
}

interface RootSeedSpec {
  readonly id: string;
  readonly name: string;
  readonly budget_group: BudgetGroup;
  readonly color_token: string;
  readonly sort_order: number;
  readonly children: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly budget_group?: BudgetGroup | undefined;
    readonly sort_order: number;
  }>;
}

const FRENCH_PACK_SPEC: readonly RootSeedSpec[] = [
  {
    id: 'c1000000-0000-4000-8000-000000000001',
    name: 'Revenus',
    budget_group: 'income',
    color_token: 'emerald',
    sort_order: 10,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000002',
        name: 'Salaire & Primes',
        sort_order: 11,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000003',
        name: 'Remboursements & Notes de frais',
        sort_order: 12,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000004',
        name: 'Aides & Divers',
        sort_order: 13,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000010',
    name: 'Logement',
    budget_group: 'fixed',
    color_token: 'indigo',
    sort_order: 20,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000011',
        name: 'Loyer / Crédit immobilier',
        sort_order: 21,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000012',
        name: 'Charges & Copropriété',
        sort_order: 22,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000013',
        name: 'Énergie (Électricité / Gaz)',
        sort_order: 23,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000014',
        name: 'Assurance habitation',
        sort_order: 24,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000020',
    name: 'Abonnements & Télécoms',
    budget_group: 'fixed',
    color_token: 'blue',
    sort_order: 30,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000021',
        name: 'Internet & Mobile',
        sort_order: 31,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000022',
        name: 'Streaming & Musique',
        sort_order: 32,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000023',
        name: 'Logiciels & Cloud',
        sort_order: 33,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000030',
    name: 'Banque & Assurances',
    budget_group: 'fixed',
    color_token: 'slate',
    sort_order: 40,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000031',
        name: 'Frais bancaires',
        sort_order: 41,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000032',
        name: 'Mutuelle & Santé fixe',
        sort_order: 42,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000033',
        name: 'Prévoyance & Autres assurances',
        sort_order: 43,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000040',
    name: 'Alimentation',
    budget_group: 'variable',
    color_token: 'teal',
    sort_order: 50,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000041',
        name: 'Courses & Supermarché',
        sort_order: 51,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000042',
        name: 'Restaurants & Cafés',
        sort_order: 52,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000043',
        name: 'Livraisons & À emporter',
        sort_order: 53,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000050',
    name: 'Transports',
    budget_group: 'variable',
    color_token: 'amber',
    sort_order: 60,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000051',
        name: 'Carburant & Recharge',
        sort_order: 61,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000052',
        name: 'Transports en commun',
        sort_order: 62,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000053',
        name: 'Péages, Parking & VTC',
        sort_order: 63,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000060',
    name: 'Vie quotidienne & Achats',
    budget_group: 'variable',
    color_token: 'orange',
    sort_order: 70,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000061',
        name: 'Shopping & Équipement',
        sort_order: 71,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000062',
        name: 'Pharmacie & Soins',
        sort_order: 72,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000063',
        name: 'Maison & Bricolage',
        sort_order: 73,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000070',
    name: 'Loisirs & Culture',
    budget_group: 'variable',
    color_token: 'violet',
    sort_order: 80,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000071',
        name: 'Sorties & Cinéma',
        sort_order: 81,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000072',
        name: 'Sport & Bien-être',
        sort_order: 82,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000073',
        name: 'Cadeaux & Dons',
        sort_order: 83,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000080',
    name: 'Voyages & Vacances',
    budget_group: 'non_monthly',
    color_token: 'cyan',
    sort_order: 90,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000081',
        name: 'Transports longue distance',
        sort_order: 91,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000082',
        name: 'Hébergement',
        sort_order: 92,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000083',
        name: 'Activités sur place',
        sort_order: 93,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000090',
    name: 'Impôts & Taxes',
    budget_group: 'non_monthly',
    color_token: 'rose',
    sort_order: 100,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000091',
        name: 'Impôt sur le revenu',
        sort_order: 101,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000092',
        name: 'Taxes locales & Foncières',
        sort_order: 102,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000100',
    name: 'Entretien & Imprévus',
    budget_group: 'non_monthly',
    color_token: 'stone',
    sort_order: 110,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000101',
        name: 'Entretien véhicule',
        sort_order: 111,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000102',
        name: 'Réparations logement',
        sort_order: 112,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000103',
        name: 'Dépenses exceptionnelles',
        sort_order: 113,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000110',
    name: 'Transferts & Hors budget',
    budget_group: 'transfer',
    color_token: 'neutral',
    sort_order: 120,
    children: [
      {
        id: 'c1000000-0000-4000-8000-000000000111',
        name: 'Transfert interne',
        budget_group: 'transfer',
        sort_order: 121,
      },
      {
        id: 'c1000000-0000-4000-8000-000000000112',
        name: 'Épargne & Placements',
        budget_group: 'savings',
        sort_order: 122,
      },
    ],
  },
  {
    id: 'c1000000-0000-4000-8000-000000000999',
    name: 'Non catégorisé',
    budget_group: 'variable',
    color_token: 'slate',
    sort_order: 9999,
    children: [],
  },
];

const DEFAULT_SEED_UPDATED_AT = '2026-11-26T00:00:00.000Z';

function buildDefaultFrenchCategoryPack(): readonly Category[] {
  const items: Category[] = [];

  for (const root of FRENCH_PACK_SPEC) {
    const rootId = parseCategoryId(root.id);
    const rootSlug = slugifyCategoryName(root.name);

    items.push(
      CategorySchema.parse({
        id: rootId,
        parent_id: null,
        name: root.name,
        slug: rootSlug,
        budget_group: root.budget_group,
        color_token: root.color_token,
        sort_order: root.sort_order,
        is_system: true,
        is_archived: false,
        revision: 0,
        updated_at: DEFAULT_SEED_UPDATED_AT,
      }),
    );

    for (const child of root.children) {
      items.push(
        CategorySchema.parse({
          id: parseCategoryId(child.id),
          parent_id: rootId,
          name: child.name,
          slug: slugifyCategoryName(child.name, rootSlug),
          budget_group: child.budget_group ?? root.budget_group,
          color_token: root.color_token,
          sort_order: child.sort_order,
          is_system: true,
          is_archived: false,
          revision: 0,
          updated_at: DEFAULT_SEED_UPDATED_AT,
        }),
      );
    }
  }

  return items;
}

export const DEFAULT_FRENCH_CATEGORY_PACK: readonly Category[] =
  buildDefaultFrenchCategoryPack();
