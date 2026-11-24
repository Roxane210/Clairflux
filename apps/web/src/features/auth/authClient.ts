import { z } from 'zod';
import { buildApiEndpointUrl } from '../../offline/apiUrl';
import type { FetchLike } from '../../offline/deltaSyncEngine';

// ============================================================================
// Zod Schemas & Discriminated Auth State
// ============================================================================

export const AuthSessionResponseSchema = z.object({
  authenticated: z.literal(true),
  client_kind: z.enum(['web', 'android']),
  session_id: z.string().uuid(),
  expires_at: z.string(),
  latest_revision: z.number().int().nonnegative(),
});

export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const LoginWebResponseSchema = z.object({
  authenticated: z.literal(true),
  client_kind: z.literal('web'),
  session_id: z.string().uuid(),
  expires_at: z.string(),
});

export const LoginAndroidResponseSchema = z.object({
  authenticated: z.literal(true),
  client_kind: z.literal('android'),
  session_id: z.string().uuid(),
  token_type: z.literal('Bearer'),
  access_token: z.string().min(1),
  expires_at: z.string(),
});

export const LoginResponseSchema = z.discriminatedUnion('client_kind', [
  LoginWebResponseSchema,
  LoginAndroidResponseSchema,
]);

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const LogoutResponseSchema = z.object({
  authenticated: z.literal(false),
  revoked: z.literal(true),
});

export type AuthSessionState =
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'authenticated';
      readonly clientKind: 'web' | 'android';
      readonly sessionId: string;
      readonly expiresAt: string;
    }
  | { readonly kind: 'unauthenticated'; readonly message: string | null }
  | { readonly kind: 'offline_cached' };

export type CheckAuthSessionOutcome =
  | { readonly kind: 'authenticated'; readonly session: AuthSessionResponse }
  | { readonly kind: 'unauthenticated'; readonly message: string | null }
  | { readonly kind: 'offline' }
  | { readonly kind: 'error'; readonly message: string };

export type SubmitLoginOutcome =
  | { readonly ok: true; readonly session: LoginResponse }
  | {
      readonly ok: false;
      readonly message: string;
      readonly retryAfterSeconds?: number | undefined;
    };

// ============================================================================
// Environment & Bearer Token Store (Android APK Native Fallback)
// ============================================================================

let activeBearerToken: string | null = null;

export function getActiveBearerToken(): string | null {
  return activeBearerToken;
}

export function setActiveBearerToken(token: string | null): void {
  activeBearerToken = token !== null && token.trim().length > 0 ? token.trim() : null;
}

export function detectClientKind(): 'web' | 'android' {
  if (typeof globalThis === 'undefined') {
    return 'web';
  }
  const capacitor: unknown = Reflect.get(globalThis, 'Capacitor');
  if (typeof capacitor === 'object' && capacitor !== null) {
    const isNative: unknown = Reflect.get(capacitor, 'isNativePlatform');
    if (typeof isNative === 'function') {
      try {
        if (Boolean((isNative as () => unknown)())) {
          return 'android';
        }
      } catch {
        return 'web';
      }
    }
  }
  return 'web';
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

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

export function createAuthAwareFetcher(baseFetcher: FetchLike = defaultFetch): FetchLike {
  return (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has('X-Clairflux-Client')) {
      headers.set('X-Clairflux-Client', 'web');
    }
    if (activeBearerToken !== null && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${activeBearerToken}`);
    }
    return baseFetcher(input, {
      ...init,
      credentials: init?.credentials ?? 'include',
      headers,
    });
  };
}

// ============================================================================
// Auth HTTP Operations
// ============================================================================

export async function checkAuthSession(options: {
  readonly isOnline: boolean;
  readonly apiBaseUrl?: string | undefined;
  readonly fetcher?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<CheckAuthSessionOutcome> {
  if (!options.isOnline) {
    return { kind: 'offline' };
  }

  const fetcher = createAuthAwareFetcher(options.fetcher ?? defaultFetch);
  const url = buildApiEndpointUrl(
    options.apiBaseUrl ?? resolveEnvApiBaseUrl(),
    '/api/auth/session',
  );

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Clairflux-Client': 'web',
      },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { kind: 'error', message: 'Vérification de session interrompue.' };
    }
    return {
      kind: 'error',
      message: 'Impossible de joindre le serveur API pour vérifier votre session.',
    };
  }

  if (response.status === 401 || response.status === 403) {
    setActiveBearerToken(null);
    return {
      kind: 'unauthenticated',
      message: null,
    };
  }

  if (!response.ok) {
    return {
      kind: 'error',
      message: `Erreur serveur lors de la vérification de session (HTTP ${response.status}).`,
    };
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    return { kind: 'error', message: 'Réponse JSON invalide depuis /api/auth/session.' };
  }

  const parsed = AuthSessionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    return { kind: 'error', message: 'Format de session invalide reçu du serveur.' };
  }

  return { kind: 'authenticated', session: parsed.data };
}

export async function submitLogin(options: {
  readonly secret: string;
  readonly clientKind?: 'web' | 'android' | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fetcher?: FetchLike | undefined;
}): Promise<SubmitLoginOutcome> {
  const trimmedSecret = options.secret;
  if (trimmedSecret.length === 0) {
    return { ok: false, message: 'Veuillez saisir votre secret personnel.' };
  }

  const fetcher = options.fetcher ?? defaultFetch;
  const url = buildApiEndpointUrl(
    options.apiBaseUrl ?? resolveEnvApiBaseUrl(),
    '/api/auth/login',
  );
  const clientKind = options.clientKind ?? detectClientKind();

  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Clairflux-Client': 'web',
      },
      body: JSON.stringify({
        secret: trimmedSecret,
        client_kind: clientKind,
      }),
    });
  } catch {
    return {
      ok: false,
      message: 'Serveur API injoignable. Vérifiez votre connexion réseau.',
    };
  }

  if (response.status === 429) {
    const retryHeader = response.headers.get('Retry-After');
    const retrySec = retryHeader !== null ? Number.parseInt(retryHeader, 10) : Number.NaN;
    const retryAfterSeconds = Number.isFinite(retrySec) && retrySec > 0 ? retrySec : undefined;
    return {
      ok: false,
      message:
        retryAfterSeconds !== undefined
          ? `Trop de tentatives. Réessayez dans ${Math.ceil(retryAfterSeconds / 60)} minute(s).`
          : 'Trop de tentatives. Veuillez patienter avant de réessayer.',
      retryAfterSeconds,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: 'Secret personnel incorrect.',
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `Échec de connexion (HTTP ${response.status}).`,
    };
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch {
    return { ok: false, message: 'Réponse JSON invalide reçue lors de la connexion.' };
  }

  const parsed = LoginResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    return { ok: false, message: 'Réponse de connexion non conforme au contrat.' };
  }

  if (parsed.data.client_kind === 'android') {
    setActiveBearerToken(parsed.data.access_token);
  } else {
    setActiveBearerToken(null);
  }

  return { ok: true, session: parsed.data };
}

export async function submitLogout(options: {
  readonly apiBaseUrl?: string | undefined;
  readonly fetcher?: FetchLike | undefined;
  readonly revokeAll?: boolean | undefined;
}): Promise<void> {
  const fetcher = createAuthAwareFetcher(options.fetcher ?? defaultFetch);
  const url = buildApiEndpointUrl(
    options.apiBaseUrl ?? resolveEnvApiBaseUrl(),
    '/api/auth/logout',
  );

  try {
    await fetcher(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Clairflux-Client': 'web',
      },
      body: JSON.stringify({ revoke_all: options.revokeAll ?? false }),
    });
  } catch {
    // Clear client token even if server is temporarily unreachable
  } finally {
    setActiveBearerToken(null);
  }
}
