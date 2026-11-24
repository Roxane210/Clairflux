import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../offline/deltaSyncEngine';
import {
  checkAuthSession,
  createAuthAwareFetcher,
  getActiveBearerToken,
  setActiveBearerToken,
  submitLogin,
  submitLogout,
} from './authClient';

const SESSION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('authClient', () => {
  afterEach(() => {
    setActiveBearerToken(null);
  });

  it('retourne offline sans requête réseau quand isOnline est false', async () => {
    const fetcher = vi.fn<FetchLike>();
    const outcome = await checkAuthSession({ isOnline: false, fetcher });
    expect(outcome).toEqual({ kind: 'offline' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retourne unauthenticated sur HTTP 401 et authenticated sur HTTP 200', async () => {
    const fetcher401: FetchLike = async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
    expect(await checkAuthSession({ isOnline: true, apiBaseUrl: '/api', fetcher: fetcher401 })).toEqual({
      kind: 'unauthenticated',
      message: null,
    });

    const fetcher200: FetchLike = async () =>
      new Response(
        JSON.stringify({
          authenticated: true,
          client_kind: 'web',
          session_id: SESSION_UUID,
          expires_at: '2026-12-08T00:00:00.000Z',
          latest_revision: 12,
        }),
        { status: 200 },
      );

    const okOutcome = await checkAuthSession({
      isOnline: true,
      apiBaseUrl: '/api',
      fetcher: fetcher200,
    });
    expect(okOutcome.kind).toBe('authenticated');
    if (okOutcome.kind === 'authenticated') {
      expect(okOutcome.session.latest_revision).toBe(12);
    }
  });

  it('gère login Web, login Android (Bearer) et limitation 429', async () => {
    const webLogin = await submitLogin({
      secret: 'mon-secret',
      clientKind: 'web',
      apiBaseUrl: '/api',
      fetcher: async (url) => {
        expect(url).toBe('/api/auth/login');
        return new Response(
          JSON.stringify({
            authenticated: true,
            client_kind: 'web',
            session_id: SESSION_UUID,
            expires_at: '2026-12-08T00:00:00.000Z',
          }),
          { status: 200 },
        );
      },
    });
    expect(webLogin.ok).toBe(true);
    expect(getActiveBearerToken()).toBeNull();

    const androidLogin = await submitLogin({
      secret: 'mon-secret',
      clientKind: 'android',
      apiBaseUrl: '/api',
      fetcher: async () =>
        new Response(
          JSON.stringify({
            authenticated: true,
            client_kind: 'android',
            session_id: SESSION_UUID,
            token_type: 'Bearer',
            access_token: 'cfx_v1.payload.sig',
            expires_at: '2026-12-24T00:00:00.000Z',
          }),
          { status: 200 },
        ),
    });
    expect(androidLogin.ok).toBe(true);
    expect(getActiveBearerToken()).toBe('cfx_v1.payload.sig');

    let capturedAuth: string | null = null;
    const authFetcher = createAuthAwareFetcher(async (_url, init) => {
      capturedAuth = new Headers(init?.headers).get('Authorization');
      return new Response('{}', { status: 200 });
    });
    await authFetcher('/api/apk/status');
    expect(capturedAuth).toBe('Bearer cfx_v1.payload.sig');

    const rateLimited = await submitLogin({
      secret: 'bad',
      clientKind: 'web',
      apiBaseUrl: '/api',
      fetcher: async () =>
        new Response('{}', {
          status: 429,
          headers: { 'Retry-After': '180' },
        }),
    });
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) {
      expect(rateLimited.retryAfterSeconds).toBe(180);
    }

    await submitLogout({
      apiBaseUrl: '/api',
      fetcher: async () => new Response(JSON.stringify({ authenticated: false, revoked: true }), { status: 200 }),
    });
    expect(getActiveBearerToken()).toBeNull();
  });
});
