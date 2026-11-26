import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FRENCH_CATEGORY_PACK,
  parseCategoryId,
  toSyncRevision,
  type Category,
  type DeltaSyncResponse,
} from '@clairflux/shared';
import { describe, expect, it, vi } from 'vitest';
import capacitorConfig from '../../../capacitor.config';
import { INITIAL_SEED_DATASET } from '../dashboard/types';
import {
  applyDeltaToDataset,
  setupAndroidBridge,
  type FetchLike,
} from '../../offline/deltaSyncEngine';
import { createMemoryOfflineStore } from '../../offline/indexedDbStore';
import {
  CATEGORY_OFFLINE_MESSAGE,
  createOfflineController,
} from '../../offline/useOfflineStore';
import { buildGroupedCategoryOptions } from './CategorySelectors';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = resolve(CURRENT_DIR, '../../../index.html');
const MAIN_TSX_PATH = resolve(CURRENT_DIR, '../../main.tsx');
const BUILD_APK_SH_PATH = resolve(CURRENT_DIR, '../../../../../scripts/build-apk.sh');

function makeCustomCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: parseCategoryId('c2000000-0000-4000-8000-000000000001'),
    parent_id: parseCategoryId('c1000000-0000-4000-8000-000000000040'),
    name: 'Marchés & Primeurs',
    slug: 'alimentation-marches-primeurs',
    budget_group: 'variable',
    color_token: 'teal',
    sort_order: 54,
    is_system: false,
    is_archived: false,
    revision: toSyncRevision(1501),
    updated_at: '2026-11-26T10:00:00.000Z',
    ...overrides,
  };
}

describe('Lot 1 — Pixel 8, Catégories 2 niveaux & Garde Hors-Ligne', () => {
  it('configure index.html pour Pixel 8 Portrait/Paysage (90°/270°) tout en préservant les règles Baseline', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8');

    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('interactive-widget=resizes-content');
    expect(html).toContain('env(safe-area-inset-top, 0px)');
    expect(html).toContain('env(safe-area-inset-right, 0px)');
    expect(html).toContain('env(safe-area-inset-bottom, 0px)');
    expect(html).toContain('env(safe-area-inset-left, 0px)');

    expect(html).toContain('@media (orientation: landscape) and (max-height: 500px)');
    expect(html).toContain('calc(76px + env(safe-area-inset-left, 0px))');
    expect(html).toContain('padding-inline-start: env(safe-area-inset-left, 0px)');
    expect(html).toContain('.cf-rail-meta');
    expect(html).toContain('inline-size: min(420px, 54dvw)');
    expect(html).toContain('padding-inline-end: calc(20px + env(safe-area-inset-right, 0px))');
    expect(html).toContain('@container charts (min-width: 720px)');
    expect(html).toContain('min-block-size: 220px');
    expect(html).toContain('.cf-dialog--modal');

    // Règles Baseline préservées pour run-audit-bot.mjs & e2e-audit.test.ts
    expect(html).toContain('dialog.cf-dialog:modal');
    expect(html).toContain('overscroll-behavior: contain');
    expect(html).toContain('--mobile-nav-height: 64px');
    expect(html).toContain('@media (min-width: 1024px)');
    expect(html).toContain('@container ledger (min-width: 760px)');
    expect(html).toContain('.cf-field-group:has(');
    expect(html).toContain(':user-valid');
    expect(html).toContain(':user-invalid');
    expect(html).toContain('content-visibility: auto');
    expect(html).toContain('contain-intrinsic-size: auto 72px');
  });

  it('configure capacitor.config.ts et scripts/build-apk.sh pour SDK 35 Edge-to-Edge & Pixel 8', () => {
    expect(capacitorConfig.android?.adjustMarginsForEdgeToEdge).toBe('auto');
    expect(capacitorConfig.android?.webContentsDebuggingEnabled).toBe(false);

    const buildScript = readFileSync(BUILD_APK_SH_PATH, 'utf8');
    expect(buildScript).toContain('android:screenOrientation');
    expect(buildScript).toContain('fullUser');
    expect(buildScript).toContain('android:configChanges');
    expect(buildScript).toContain(
      'orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode',
    );
    expect(buildScript).toContain('android:windowSoftInputMode');
    expect(buildScript).toContain('adjustResize');
    expect(buildScript).toContain('android:windowLayoutInDisplayCutoutMode');
    expect(buildScript).toContain('shortEdges');
    expect(buildScript).toContain('android:windowLightStatusBar');
    expect(buildScript).toContain('android:windowLightNavigationBar');
  });

  it('corrige HEADING_BY_TAB.transactions vers ledger-heading dans main.tsx', () => {
    const mainSource = readFileSync(MAIN_TSX_PATH, 'utf8');
    expect(mainSource).toContain("transactions: 'ledger-heading'");
    expect(mainSource).not.toContain('ledger-section-heading');
  });

  it('fusionne delta.categories dans applyDeltaToDataset (upsert, delete, tri)', () => {
    const customCat = makeCustomCategory();
    const removedId = DEFAULT_FRENCH_CATEGORY_PACK[1]?.id;
    expect(removedId).toBeDefined();

    const delta: DeltaSyncResponse = {
      since_revision: toSyncRevision(1482),
      batch_end_revision: toSyncRevision(1501),
      latest_revision: toSyncRevision(1501),
      has_more: false,
      full_resync_required: false,
      server_time: '2026-11-26T10:00:00.000Z',
      accounts: { upserted: [], deleted_ids: [] },
      transactions: { upserted: [], deleted_ids: [] },
      transaction_notes: { upserted: [], deleted_transaction_ids: [] },
      categorization_rules: { upserted: [], deleted_ids: [] },
      categories: {
        upserted: [customCat],
        deleted_ids: removedId ? [removedId] : [],
      },
      drive_sync_status: { last_run: null, files: [] },
      aggregates_snapshot: null,
    };

    const next = applyDeltaToDataset(INITIAL_SEED_DATASET, delta);
    expect(next.categories?.some((c) => c.id === customCat.id)).toBe(true);
    expect(next.categories?.some((c) => c.id === removedId)).toBe(false);
    expect(next.revision).toBe(1501);
  });

  it('ferme [popover]:popover-open en priorité avant dialog[open] sur le bouton retour Android', () => {
    const listeners: { back: (() => void) | null } = { back: null };
    const hidePopoverSpy = vi.fn();
    const closeDialogSpy = vi.fn();

    Reflect.set(globalThis, 'Capacitor', {
      Plugins: {
        App: {
          addListener: (_event: string, cb: () => void) => {
            listeners.back = cb;
            return { remove: () => undefined };
          },
        },
      },
    });
    Reflect.set(globalThis, 'document', {
      querySelector: (selector: string) => {
        if (selector === '[popover]:popover-open') {
          return { hidePopover: hidePopoverSpy };
        }
        if (selector === 'dialog[open]') {
          return { close: closeDialogSpy };
        }
        return null;
      },
    });

    try {
      const bridge = setupAndroidBridge({
        onOnlineStatusChange: () => undefined,
      });
      listeners.back?.();
      expect(hidePopoverSpy).toHaveBeenCalledTimes(1);
      expect(closeDialogSpy).not.toHaveBeenCalled();
      bridge.dispose();
    } finally {
      Reflect.deleteProperty(globalThis, 'Capacitor');
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('refuse proprement create/update/merge/deleteCategory hors-ligne sans requête réseau et exécute en ligne', async () => {
    const store = createMemoryOfflineStore();
    const calls: Array<{ method: string; path: string }> = [];
    const createdCat = makeCustomCategory();

    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(input, 'https://api.clairflux.local');
      calls.push({ method: init?.method ?? 'GET', path: url.pathname });

      if (init?.method === 'POST' && url.pathname === '/api/categories') {
        return new Response(
          JSON.stringify({ category: createdCat, latest_revision: 1502 }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.pathname === '/api/sync/delta') {
        const delta: DeltaSyncResponse = {
          since_revision: toSyncRevision(1482),
          batch_end_revision: toSyncRevision(1502),
          latest_revision: toSyncRevision(1502),
          has_more: false,
          full_resync_required: false,
          server_time: '2026-11-26T10:05:00.000Z',
          accounts: { upserted: [], deleted_ids: [] },
          transactions: { upserted: [], deleted_ids: [] },
          transaction_notes: { upserted: [], deleted_transaction_ids: [] },
          categorization_rules: { upserted: [], deleted_ids: [] },
          categories: { upserted: [createdCat], deleted_ids: [] },
          drive_sync_status: { last_run: null, files: [] },
          aggregates_snapshot: null,
        };
        return new Response(JSON.stringify(delta), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const controller = createOfflineController(INITIAL_SEED_DATASET, {
      store,
      apiBaseUrl: 'https://api.clairflux.local',
      fetcher,
      initialOnline: false,
    });

    const createOffline = await controller.createCategory({
      parent_id: createdCat.parent_id,
      name: createdCat.name,
      budget_group: 'variable',
    });
    const updateOffline = await controller.updateCategory({
      id: createdCat.id,
      name: 'Bio & Marchés',
    });
    const mergeOffline = await controller.mergeCategory({
      sourceCategoryId: createdCat.id,
      target_category_id: parseCategoryId('c1000000-0000-4000-8000-000000000040'),
    });
    const deleteOffline = await controller.deleteCategory({
      id: createdCat.id,
      reassign_to_category_id: parseCategoryId('c1000000-0000-4000-8000-000000000040'),
    });

    expect(createOffline).toEqual({ ok: false, message: CATEGORY_OFFLINE_MESSAGE });
    expect(updateOffline).toEqual({ ok: false, message: CATEGORY_OFFLINE_MESSAGE });
    expect(mergeOffline).toEqual({ ok: false, message: CATEGORY_OFFLINE_MESSAGE });
    expect(deleteOffline).toEqual({ ok: false, message: CATEGORY_OFFLINE_MESSAGE });
    expect(calls).toHaveLength(0);

    await controller.setOnline(true);
    const createOnline = await controller.createCategory({
      parent_id: createdCat.parent_id,
      name: createdCat.name,
      budget_group: 'variable',
    });
    expect(createOnline.ok).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/categories')).toBe(true);
    expect(controller.getState().dataset.categories?.some((c) => c.id === createdCat.id)).toBe(true);
  });

  it('construit les groupes 2 niveaux (<optgroup>) avec repli sur les catégories existantes', () => {
    const grouped = buildGroupedCategoryOptions(DEFAULT_FRENCH_CATEGORY_PACK, ['Logement & Charges']);
    const alimGroup = grouped.groups.find((g) => g.label === 'Alimentation');
    expect(alimGroup?.options.some((o) => o.value === 'Courses & Supermarché')).toBe(true);
    const fallbackGroup = grouped.groups.find((g) => g.key === 'legacy-fallback');
    expect(fallbackGroup?.options.some((o) => o.value === 'Logement & Charges')).toBe(true);
    expect(grouped.standalone.some((o) => o.value === 'Non catégorisé')).toBe(true);
  });
});
