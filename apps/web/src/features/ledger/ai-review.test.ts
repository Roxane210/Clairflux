import {
  DEFAULT_FRENCH_CATEGORY_PACK,
  toSyncRevision,
  type AiCategorizationRun,
  type AiReviewItem,
  type AiRuleSuggestion,
  type DeltaSyncResponse,
} from '@clairflux/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INITIAL_SEED_DATASET } from '../dashboard/types';
import { applyDeltaToDataset, type FetchLike } from '../../offline/deltaSyncEngine';
import { ClairFluxDatasetSchema, createMemoryOfflineStore } from '../../offline/indexedDbStore';
import {
  AI_OFFLINE_MESSAGE,
  createOfflineController,
} from '../../offline/useOfflineStore';
import { AiReviewTab } from './AiReviewTab';

function makeReviewItem(overrides: Partial<AiReviewItem> = {}): AiReviewItem {
  return {
    transaction_id: '33333333-3333-4333-8333-333333333401',
    date: '2026-11-12',
    clean_label: 'Pharmacie Lafayette',
    amount_cents: -2840,
    currency: 'EUR',
    amount_eur_cents: -2840,
    account_id: '11111111-1111-4111-8111-111111111111',
    suggested_category_id: 'c1000000-0000-4000-8000-000000000060',
    suggested_subcategory_id: 'c1000000-0000-4000-8000-000000000062',
    suggested_category_name: 'Vie quotidienne & Achats',
    suggested_subcategory_name: 'Pharmacie & Soins',
    ai_confidence_bp: 8200,
    ai_reason: 'Libellé pharmacie <script>alert(1)</script>',
    ai_model: 'gemini-4-hydrogen',
    ai_review_status: 'pending_review',
    updated_at: '2026-11-26T12:00:00.000Z',
    ...overrides,
  };
}

function makeRuleSuggestion(overrides: Partial<AiRuleSuggestion> = {}): AiRuleSuggestion {
  return {
    id: 'a2000000-0000-4000-8000-000000000001',
    merchant_pattern: 'carrefour city',
    match_mode: 'contains',
    target_category_id: 'c1000000-0000-4000-8000-000000000040',
    target_subcategory_id: 'c1000000-0000-4000-8000-000000000041',
    target_category_name: 'Alimentation',
    target_subcategory_name: 'Courses & Supermarché',
    sample_count: 5,
    status: 'pending',
    created_at: '2026-11-26T12:00:00.000Z',
    updated_at: '2026-11-26T12:00:00.000Z',
    revision: 1510,
    ...overrides,
  };
}

function makeRunningBackfillRun(overrides: Partial<AiCategorizationRun> = {}): AiCategorizationRun {
  return {
    id: 'a1000000-0000-4000-8000-000000000001',
    status: 'running',
    trigger_source: 'manual_backfill',
    model_used: 'gemini-4-hydrogen',
    total_candidates: 150,
    processed_count: 50,
    auto_applied_count: 42,
    queued_review_count: 8,
    failed_count: 0,
    last_error: null,
    started_at: '2026-11-26T12:00:00.000Z',
    finished_at: null,
    updated_at: '2026-11-26T12:01:00.000Z',
    ...overrides,
  };
}

describe('Lot 2 — Boîte de révision IA, Suggestions de règles & Garde Hors-Ligne', () => {
  it('valide ClairFluxDatasetSchema et fusionne ai_rule_suggestions & pending_ai_review_count via applyDeltaToDataset', () => {
    const suggestion = makeRuleSuggestion();
    const delta: DeltaSyncResponse = {
      since_revision: toSyncRevision(1482),
      batch_end_revision: toSyncRevision(1510),
      latest_revision: toSyncRevision(1510),
      has_more: false,
      full_resync_required: false,
      server_time: '2026-11-26T12:05:00.000Z',
      accounts: { upserted: [], deleted_ids: [] },
      transactions: { upserted: [], deleted_ids: [] },
      transaction_notes: { upserted: [], deleted_transaction_ids: [] },
      categorization_rules: { upserted: [], deleted_ids: [] },
      ai_rule_suggestions: [suggestion],
      pending_ai_review_count: 4,
      drive_sync_status: { last_run: null, files: [] },
      aggregates_snapshot: null,
    };

    const next = applyDeltaToDataset(INITIAL_SEED_DATASET, delta);
    expect(next.ai_rule_suggestions).toHaveLength(1);
    expect(next.ai_rule_suggestions?.[0]?.merchant_pattern).toBe('carrefour city');
    expect(next.pending_ai_review_count).toBe(4);

    const parsed = ClairFluxDatasetSchema.safeParse(next);
    expect(parsed.success).toBe(true);
  });

  it('refuse proprement toutes les actions IA hors-ligne sans aucun appel réseau', async () => {
    const store = createMemoryOfflineStore();
    const calls: Array<{ method: string; path: string }> = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(input, 'https://api.clairflux.local');
      calls.push({ method: init?.method ?? 'GET', path: url.pathname });
      return new Response(null, { status: 200 });
    };

    const controller = createOfflineController(INITIAL_SEED_DATASET, {
      store,
      apiBaseUrl: 'https://api.clairflux.local',
      fetcher,
      initialOnline: false,
    });

    expect(await controller.refreshAiStatus()).toBeNull();
    expect(await controller.fetchAiReviewQueue()).toEqual([]);
    expect(await controller.triggerAiBackfill()).toEqual({ ok: false, message: AI_OFFLINE_MESSAGE });
    expect(await controller.cancelAiBackfill()).toEqual({ ok: false, message: AI_OFFLINE_MESSAGE });
    expect(
      await controller.resolveAiReviewDecisions([
        { transaction_id: '33333333-3333-4333-8333-333333333401', action: 'accept' },
      ]),
    ).toEqual({ ok: false, message: AI_OFFLINE_MESSAGE });
    expect(
      await controller.acceptAiRuleSuggestion('a2000000-0000-4000-8000-000000000001'),
    ).toEqual({ ok: false, message: AI_OFFLINE_MESSAGE });
    expect(
      await controller.dismissAiRuleSuggestion('a2000000-0000-4000-8000-000000000001'),
    ).toEqual({ ok: false, message: AI_OFFLINE_MESSAGE });
    expect(calls).toHaveLength(0);
  });

  it('pilote les endpoints /api/ai/* en ligne (backfill, status, queue, resolve, accept suggestion)', async () => {
    const store = createMemoryOfflineStore();
    const calls: Array<{ method: string; path: string }> = [];
    const item = makeReviewItem();
    const suggestion = makeRuleSuggestion();
    const run = makeRunningBackfillRun();

    const fetcher: FetchLike = async (input, init) => {
      const url = new URL(input, 'https://api.clairflux.local');
      calls.push({ method: init?.method ?? 'GET', path: url.pathname });

      if (init?.method === 'POST' && url.pathname === '/api/ai/categorize/backfill') {
        return new Response(
          JSON.stringify({ run_id: run.id, status: 'running', accepted_at: run.started_at }),
          { status: 202 },
        );
      }
      if (url.pathname === '/api/ai/categorize/status') {
        return new Response(
          JSON.stringify({
            run,
            pending_review_count: 1,
            uncategorized_eligible_count: 149,
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/api/ai/review-queue') {
        return new Response(
          JSON.stringify({ items: [item], total_pending: 1, limit: 50, offset: 0 }),
          { status: 200 },
        );
      }
      if (url.pathname === '/api/ai/rule-suggestions') {
        return new Response(JSON.stringify({ suggestions: [suggestion] }), { status: 200 });
      }
      if (init?.method === 'POST' && url.pathname === '/api/ai/review-queue/resolve') {
        return new Response(
          JSON.stringify({
            resolved_count: 1,
            created_rules_count: 0,
            retroactive_updated_count: 0,
            current_revision: 1511,
            pending_review_count: 0,
          }),
          { status: 200 },
        );
      }
      if (init?.method === 'POST' && url.pathname.endsWith('/accept')) {
        return new Response(
          JSON.stringify({
            suggestion: { ...suggestion, status: 'accepted' },
            retroactive_updated_count: 5,
            current_revision: 1512,
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/api/sync/delta') {
        const delta: DeltaSyncResponse = {
          since_revision: toSyncRevision(1482),
          batch_end_revision: toSyncRevision(1512),
          latest_revision: toSyncRevision(1512),
          has_more: false,
          full_resync_required: false,
          server_time: '2026-11-26T12:10:00.000Z',
          accounts: { upserted: [], deleted_ids: [] },
          transactions: { upserted: [], deleted_ids: [] },
          transaction_notes: { upserted: [], deleted_transaction_ids: [] },
          categorization_rules: { upserted: [], deleted_ids: [] },
          ai_rule_suggestions: [],
          pending_ai_review_count: 0,
          drive_sync_status: { last_run: null, files: [] },
          aggregates_snapshot: null,
        };
        return new Response(JSON.stringify(delta), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const controller = createOfflineController(INITIAL_SEED_DATASET, {
      store,
      apiBaseUrl: 'https://api.clairflux.local',
      fetcher,
      initialOnline: true,
    });

    const backfill = await controller.triggerAiBackfill();
    expect(backfill.ok).toBe(true);
    expect(controller.getState().aiBackfillStatus?.run?.id).toBe(run.id);

    const queue = await controller.fetchAiReviewQueue();
    expect(queue).toHaveLength(1);
    expect(controller.getState().aiRuleSuggestions).toHaveLength(1);

    const resolved = await controller.resolveAiReviewDecisions([
      { transaction_id: item.transaction_id, action: 'accept' },
    ]);
    expect(resolved.ok).toBe(true);
    expect(calls.some((c) => c.path === '/api/ai/review-queue/resolve')).toBe(true);

    const accepted = await controller.acceptAiRuleSuggestion(suggestion.id);
    expect(accepted.ok).toBe(true);
    expect(controller.getState().aiRuleSuggestions).toHaveLength(0);
  });

  it('rend AiReviewTab en HTML échappé sûr avec bouton Tout accepter >= 80 %, 4 actions, suggestions et état vide/hors-ligne', () => {
    const item = makeReviewItem({ ai_confidence_bp: 8200 });
    const suggestion = makeRuleSuggestion();

    const populatedHtml = renderToStaticMarkup(
      createElement(AiReviewTab, {
        items: [item],
        suggestions: [suggestion],
        categories: DEFAULT_FRENCH_CATEGORY_PACK,
        isOnline: true,
        isAiLoading: false,
        onRefreshQueue: () => undefined,
        onResolveDecisions: async () => ({ ok: true, message: 'OK' }),
        onAcceptSuggestion: async () => ({ ok: true, message: 'OK' }),
        onDismissSuggestion: async () => ({ ok: true, message: 'OK' }),
      }),
    );

    expect(populatedHtml).toContain('Tout accepter &gt;= 80 % (1)');
    expect(populatedHtml).toContain('Pharmacie Lafayette');
    expect(populatedHtml).toContain('Vie quotidienne &amp; Achats › Pharmacie &amp; Soins');
    expect(populatedHtml).toContain('82 %');
    expect(populatedHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(populatedHtml).not.toContain('<script>alert(1)</script>');
    expect(populatedHtml).toContain('Valider');
    expect(populatedHtml).toContain('Corriger');
    expect(populatedHtml).toContain('Valider + Règle');
    expect(populatedHtml).toContain('Ignorer');
    expect(populatedHtml).toContain('carrefour city');
    expect(populatedHtml).toContain('Accepter la règle');

    const emptyOfflineHtml = renderToStaticMarkup(
      createElement(AiReviewTab, {
        items: [],
        suggestions: [],
        categories: DEFAULT_FRENCH_CATEGORY_PACK,
        isOnline: false,
        isAiLoading: false,
        onRefreshQueue: () => undefined,
        onResolveDecisions: async () => ({ ok: true, message: 'OK' }),
        onAcceptSuggestion: async () => ({ ok: true, message: 'OK' }),
        onDismissSuggestion: async () => ({ ok: true, message: 'OK' }),
      }),
    );

    expect(emptyOfflineHtml).toContain('Tout est classé ! Aucune suggestion IA en attente de validation.');
    expect(emptyOfflineHtml).toContain('Mode hors-ligne');
    expect(emptyOfflineHtml).not.toContain('Tout accepter');
  });
});
