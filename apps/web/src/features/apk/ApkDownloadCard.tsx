import { assertNever } from '@clairflux/shared';
import { memo, useCallback, useEffect, useState, type ReactElement } from 'react';
import { z } from 'zod';
import { buildApiEndpointUrl } from '../../offline/apiUrl';
import type { FetchLike } from '../../offline/deltaSyncEngine';
import { createAuthAwareFetcher } from '../auth/authClient';

// ============================================================================
// Zod Schema & Discriminated State Union
// ============================================================================

export const ApkStatusSchema = z.object({
  available: z.boolean(),
  version: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  builtAt: z.string().nullable(),
});

export type ApkStatus = z.infer<typeof ApkStatusSchema>;

export type ApkCardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly version: string | null }
  | { readonly kind: 'available'; readonly status: ApkStatus }
  | { readonly kind: 'error'; readonly message: string };

export interface ResolveApkStatusOptions {
  readonly isOnline: boolean;
  readonly apiBaseUrl?: string | undefined;
  readonly fetcher?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onUnauthorized?: (() => void) | undefined;
}

// ============================================================================
// Pure Formatting, Parsing & Safe URL Builders
// ============================================================================

const BYTES_PER_MIB = 1024 * 1024;

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function resolveEnvApiBaseUrl(): string {
  if (typeof import.meta !== 'undefined' && 'env' in import.meta) {
    const envObj: unknown = Reflect.get(import.meta, 'env');
    if (typeof envObj === 'object' && envObj !== null) {
      const apiUrl: unknown = Reflect.get(envObj, 'VITE_API_BASE_URL');
      if (typeof apiUrl === 'string' && apiUrl.trim().length > 0) {
        return apiUrl.trim();
      }
    }
  }
  return '';
}

export function parseApkStatus(raw: unknown): ApkStatus {
  return ApkStatusSchema.parse(raw);
}

export function formatApkSizeMb(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return '—';
  }
  const mb = sizeBytes / BYTES_PER_MIB;
  const formatted = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: mb > 0 && mb < 0.1 ? 2 : 1,
  }).format(mb);
  return `${formatted} Mo`;
}

export const formatSizeMb = formatApkSizeMb;

export function formatApkBuiltAt(builtAt: string | null): string {
  if (builtAt === null || builtAt.trim().length === 0) {
    return '—';
  }
  const parsed = new Date(builtAt);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

export function buildApkStatusUrl(apiBaseUrl?: string): string {
  return buildApiEndpointUrl(apiBaseUrl ?? resolveEnvApiBaseUrl(), '/api/apk/status');
}

export function buildApkDownloadUrl(apiBaseUrl?: string): string {
  return buildApiEndpointUrl(apiBaseUrl ?? resolveEnvApiBaseUrl(), '/api/apk/download');
}

export async function resolveApkCardState(
  options: ResolveApkStatusOptions,
): Promise<ApkCardState> {
  if (!options.isOnline) {
    return { kind: 'offline' };
  }

  const fetcher = options.fetcher ?? createAuthAwareFetcher(defaultFetch);
  const url = buildApkStatusUrl(options.apiBaseUrl);

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Clairflux-Client': 'web',
      },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    response = await fetcher(url, init);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { kind: 'loading' };
    }
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Impossible de joindre le serveur API.';
    return { kind: 'error', message };
  }

  if (response.status === 404) {
    return {
      kind: 'unavailable',
      reason: 'Aucun APK compilé sur le serveur pour le moment (404).',
      version: null,
    };
  }

  if (response.status === 401 || response.status === 403) {
    if (response.status === 401) {
      options.onUnauthorized?.();
    }
    return {
      kind: 'error',
      message: `Authentification requise pour consulter le statut APK (HTTP ${response.status}).`,
    };
  }

  if (!response.ok) {
    return {
      kind: 'error',
      message: `Erreur serveur lors de la vérification APK (HTTP ${response.status}).`,
    };
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    return {
      kind: 'error',
      message: 'Réponse JSON invalide reçue depuis /api/apk/status.',
    };
  }

  const parsed = ApkStatusSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      kind: 'error',
      message: 'Format de statut APK invalide reçu du serveur.',
    };
  }

  if (!parsed.data.available) {
    return {
      kind: 'unavailable',
      reason: 'L’APK Android n’est pas encore disponible sur le serveur.',
      version: parsed.data.version.trim().length > 0 ? parsed.data.version : null,
    };
  }

  return { kind: 'available', status: parsed.data };
}

// ============================================================================
// Presentation Helpers & Memoized Component
// ============================================================================

interface ApkViewSummary {
  readonly statusText: string;
  readonly statusColor: string;
  readonly versionText: string;
  readonly sizeText: string;
  readonly builtAtText: string;
  readonly sha256Text: string;
  readonly canDownload: boolean;
}

function deriveApkViewSummary(state: ApkCardState, isOnline: boolean): ApkViewSummary {
  switch (state.kind) {
    case 'loading':
      return {
        statusText: 'Vérification de la disponibilité de l’APK…',
        statusColor: 'var(--text-secondary)',
        versionText: '—',
        sizeText: '—',
        builtAtText: '—',
        sha256Text: '—',
        canDownload: false,
      };
    case 'offline':
      return {
        statusText: 'Hors-ligne — Téléchargement APK indisponible sans réseau.',
        statusColor: 'var(--warning)',
        versionText: '—',
        sizeText: '—',
        builtAtText: '—',
        sha256Text: '—',
        canDownload: false,
      };
    case 'unavailable':
      return {
        statusText: state.reason,
        statusColor: 'var(--warning)',
        versionText: state.version ?? '—',
        sizeText: '—',
        builtAtText: '—',
        sha256Text: '—',
        canDownload: false,
      };
    case 'error':
      return {
        statusText: state.message,
        statusColor: 'var(--danger)',
        versionText: '—',
        sizeText: '—',
        builtAtText: '—',
        sha256Text: '—',
        canDownload: false,
      };
    case 'available':
      return {
        statusText: 'Disponible — Prêt pour installation sur Android',
        statusColor: 'var(--accent)',
        versionText: state.status.version.trim().length > 0 ? state.status.version : '—',
        sizeText: formatApkSizeMb(state.status.sizeBytes),
        builtAtText: formatApkBuiltAt(state.status.builtAt),
        sha256Text: state.status.sha256 ?? '—',
        canDownload: isOnline && state.status.available,
      };
    default:
      return assertNever(state);
  }
}

export interface ApkDownloadCardProps {
  readonly isOnline: boolean;
  readonly apiBaseUrl?: string | undefined;
  readonly fetcher?: FetchLike | undefined;
  readonly onUnauthorized?: (() => void) | undefined;
}

export const ApkDownloadCard = memo(function ApkDownloadCard({
  isOnline,
  apiBaseUrl,
  fetcher,
  onUnauthorized,
}: ApkDownloadCardProps): ReactElement {
  const [state, setState] = useState<ApkCardState>(() =>
    isOnline ? { kind: 'loading' } : { kind: 'offline' },
  );
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!isOnline) {
      setState({ kind: 'offline' });
      return undefined;
    }

    const controller = new AbortController();
    setState({ kind: 'loading' });

    void resolveApkCardState({
      isOnline,
      apiBaseUrl,
      fetcher,
      signal: controller.signal,
      onUnauthorized,
    }).then((nextState) => {
      if (!controller.signal.aborted) {
        setState(nextState);
      }
    });

    return () => {
      controller.abort();
    };
  }, [isOnline, apiBaseUrl, fetcher, onUnauthorized, refreshTick]);

  const handleRefresh = useCallback((): void => {
    setRefreshTick((prev) => prev + 1);
  }, []);

  const summary = deriveApkViewSummary(state, isOnline);
  const downloadUrl = buildApkDownloadUrl(apiBaseUrl);

  return (
    <section
      className="cf-surface"
      style={{ padding: '16px', display: 'grid', gap: '16px' }}
      aria-labelledby="apk-download-heading"
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          paddingBlockEnd: '14px',
          borderBlockEnd: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ minInlineSize: 0, display: 'grid', gap: '4px' }}>
          <h2 id="apk-download-heading" style={{ fontSize: '1.125rem' }}>
            Application Android (APK Offline-First)
          </h2>
          <p role="status" style={{ color: summary.statusColor, fontWeight: 600 }}>
            {summary.statusText}
          </p>
        </div>

        <div className="cf-header-actions">
          <button
            type="button"
            className="cf-btn"
            disabled={!isOnline || state.kind === 'loading'}
            onClick={handleRefresh}
          >
            Actualiser
          </button>
          {summary.canDownload ? (
            <a
              href={downloadUrl}
              download="clairflux-release.apk"
              className="cf-btn cf-btn-primary"
              style={{ textDecoration: 'none' }}
            >
              Télécharger clairflux-release.apk
            </a>
          ) : (
            <button
              type="button"
              className="cf-btn cf-btn-primary"
              disabled
              aria-disabled="true"
            >
              Télécharger clairflux-release.apk
            </button>
          )}
        </div>
      </div>

      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '12px 16px',
          paddingBlockEnd: '14px',
          borderBlockEnd: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ minInlineSize: 0, display: 'grid', gap: '2px' }}>
          <dt style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>Version</dt>
          <dd className="tabular-amount" style={{ margin: 0, fontWeight: 600 }}>
            {summary.versionText}
          </dd>
        </div>
        <div style={{ minInlineSize: 0, display: 'grid', gap: '2px' }}>
          <dt style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>Taille</dt>
          <dd className="tabular-amount" style={{ margin: 0, fontWeight: 600 }}>
            {summary.sizeText}
          </dd>
        </div>
        <div style={{ minInlineSize: 0, display: 'grid', gap: '2px' }}>
          <dt style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>Compilé le</dt>
          <dd className="tabular-amount" style={{ margin: 0, fontWeight: 600 }}>
            {summary.builtAtText}
          </dd>
        </div>
        <div style={{ minInlineSize: 0, display: 'grid', gap: '2px', gridColumn: '1 / -1' }}>
          <dt style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
            Empreinte SHA-256
          </dt>
          <dd style={{ margin: 0, minInlineSize: 0 }}>
            <code
              className="tabular-amount"
              style={{
                display: 'block',
                fontSize: '0.8125rem',
                overflowWrap: 'anywhere',
                minInlineSize: 0,
                color: 'var(--text-primary)',
              }}
            >
              {summary.sha256Text}
            </code>
          </dd>
        </div>
      </dl>

      <div style={{ display: 'grid', gap: '6px', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        <p style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          Installation sur Android et connexion à votre serveur
        </p>
        <ol style={{ margin: 0, paddingInlineStart: '18px', display: 'grid', gap: '4px' }}>
          <li>
            Téléchargez <strong>clairflux-release.apk</strong> sur votre smartphone Android (et vérifiez
            si besoin l’empreinte SHA-256 ci-dessus).
          </li>
          <li>
            Ouvrez le fichier téléchargé et autorisez l’installation depuis votre navigateur (« Sources
            inconnues ») pour installer ClairFlux.
          </li>
          <li>
            Connectez l’application avec l’URL HTTPS de votre API ClairFlux et votre secret personnel :
            vos comptes, graphiques et notes rapides restent disponibles hors-ligne puis synchronisés dès
            le retour du réseau.
          </li>
        </ol>
      </div>
    </section>
  );
});
