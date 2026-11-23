import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../../offline/deltaSyncEngine';
import {
  buildApkDownloadUrl,
  buildApkStatusUrl,
  formatApkBuiltAt,
  formatApkSizeMb,
  formatSizeMb,
  parseApkStatus,
  resolveApkCardState,
} from './ApkDownloadCard';

const VALID_SHA256 = 'a'.repeat(64);

describe('parseApkStatus', () => {
  it('parses a complete available APK status payload', () => {
    const parsed = parseApkStatus({
      available: true,
      version: '1.0.0-rc1',
      sizeBytes: 14_680_064,
      sha256: VALID_SHA256,
      builtAt: '2026-11-21T18:00:00.000Z',
    });

    expect(parsed).toEqual({
      available: true,
      version: '1.0.0-rc1',
      sizeBytes: 14_680_064,
      sha256: VALID_SHA256,
      builtAt: '2026-11-21T18:00:00.000Z',
    });
  });

  it('parses an unavailable APK status payload with nullable fields', () => {
    const parsed = parseApkStatus({
      available: false,
      version: '1.0.0-rc1',
      sizeBytes: null,
      sha256: null,
      builtAt: null,
    });

    expect(parsed.available).toBe(false);
    expect(parsed.sizeBytes).toBeNull();
    expect(parsed.sha256).toBeNull();
    expect(parsed.builtAt).toBeNull();
  });

  it('rejects malformed payloads and negative or non-integer sizes', () => {
    expect(() =>
      parseApkStatus({
        available: true,
        version: '1.0.0',
        sizeBytes: -10,
        sha256: null,
        builtAt: null,
      }),
    ).toThrow();

    expect(() =>
      parseApkStatus({
        available: true,
        version: '1.0.0',
        sizeBytes: 12.5,
        sha256: null,
        builtAt: null,
      }),
    ).toThrow();

    expect(() => parseApkStatus({ available: 'yes' })).toThrow();
  });
});

describe('formatApkSizeMb', () => {
  it('formats byte sizes into French Mo strings and handles invalid or null values', () => {
    expect(formatApkSizeMb(null)).toBe('—');
    expect(formatApkSizeMb(-1)).toBe('—');
    expect(formatApkSizeMb(Number.NaN)).toBe('—');
    expect(formatApkSizeMb(0)).toBe('0,0 Mo');
    expect(formatApkSizeMb(14_680_064)).toBe('14,0 Mo');
    expect(formatApkSizeMb(15_204_352)).toBe('14,5 Mo');
    expect(formatApkSizeMb(51_200)).toBe('0,05 Mo');
    expect(formatSizeMb(14_680_064)).toBe('14,0 Mo');
  });
});

describe('formatApkBuiltAt', () => {
  it('formats valid ISO dates in French and returns em-dash for empty/invalid inputs', () => {
    expect(formatApkBuiltAt(null)).toBe('—');
    expect(formatApkBuiltAt('   ')).toBe('—');
    expect(formatApkBuiltAt('not-a-date')).toBe('—');

    const formatted = formatApkBuiltAt('2026-11-21T18:00:00.000Z');
    expect(formatted).toContain('2026');
    expect(formatted).not.toBe('—');
  });
});

describe('buildApkDownloadUrl & buildApkStatusUrl', () => {
  it('builds safe relative and HTTPS URLs while stripping trailing slashes', () => {
    expect(buildApkDownloadUrl('')).toBe('/api/apk/download');
    expect(buildApkStatusUrl('')).toBe('/api/apk/status');
    expect(buildApkDownloadUrl('https://clairflux.example.com///')).toBe(
      'https://clairflux.example.com/api/apk/download',
    );
    expect(buildApkDownloadUrl('https://clairflux.example.com/subpath/')).toBe(
      'https://clairflux.example.com/subpath/api/apk/download',
    );
    expect(buildApkDownloadUrl('/proxy/')).toBe('/proxy/api/apk/download');
    expect(buildApkDownloadUrl('/api')).toBe('/api/apk/download');
    expect(buildApkStatusUrl('/api')).toBe('/api/apk/status');
    expect(buildApkStatusUrl('/api/')).toBe('/api/apk/status');
    expect(buildApkDownloadUrl('https://clairflux.example.com/api')).toBe(
      'https://clairflux.example.com/api/apk/download',
    );
    expect(buildApkStatusUrl('https://clairflux.example.com/api/')).toBe(
      'https://clairflux.example.com/api/apk/status',
    );
  });

  it('rejects unsafe schemes and protocol-relative bases by falling back to same-origin path', () => {
    expect(buildApkDownloadUrl('javascript:alert(1)')).toBe('/api/apk/download');
    expect(buildApkDownloadUrl('data:text/html,<script>alert(1)</script>')).toBe(
      '/api/apk/download',
    );
    expect(buildApkDownloadUrl('//evil.example.com')).toBe('/api/apk/download');
    expect(buildApkDownloadUrl('ftp://files.example.com')).toBe('/api/apk/download');
    expect(buildApkStatusUrl('javascript:void(0)')).toBe('/api/apk/status');
  });
});

describe('resolveApkCardState', () => {
  it('returns offline immediately without calling fetcher when isOnline is false', async () => {
    const fetcher = vi.fn<FetchLike>();
    const state = await resolveApkCardState({
      isOnline: false,
      apiBaseUrl: 'https://clairflux.example.com',
      fetcher,
    });

    expect(state).toEqual({ kind: 'offline' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('resolves available state when GET /api/apk/status returns a valid available payload', async () => {
    const fetcher = vi.fn<FetchLike>(async () => {
      return new Response(
        JSON.stringify({
          available: true,
          version: '1.0.0-rc1',
          sizeBytes: 15_204_352,
          sha256: VALID_SHA256,
          builtAt: '2026-11-21T18:30:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const state = await resolveApkCardState({
      isOnline: true,
      apiBaseUrl: 'https://clairflux.example.com/',
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://clairflux.example.com/api/apk/status');
    expect(state).toEqual({
      kind: 'available',
      status: {
        available: true,
        version: '1.0.0-rc1',
        sizeBytes: 15_204_352,
        sha256: VALID_SHA256,
        builtAt: '2026-11-21T18:30:00.000Z',
      },
    });
  });

  it('resolves unavailable state on HTTP 404 or when available is false', async () => {
    const fetcher404 = vi.fn<FetchLike>(async () => new Response('Not Found', { status: 404 }));
    const state404 = await resolveApkCardState({ isOnline: true, fetcher: fetcher404 });
    expect(state404.kind).toBe('unavailable');

    const fetcherFalse = vi.fn<FetchLike>(async () => {
      return new Response(
        JSON.stringify({
          available: false,
          version: '1.0.0-rc1',
          sizeBytes: null,
          sha256: null,
          builtAt: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const stateFalse = await resolveApkCardState({ isOnline: true, fetcher: fetcherFalse });
    expect(stateFalse).toEqual({
      kind: 'unavailable',
      reason: 'L’APK Android n’est pas encore disponible sur le serveur.',
      version: '1.0.0-rc1',
    });
  });

  it('resolves error state on network failure, HTTP 500, or invalid Zod payload', async () => {
    const networkFetcher = vi.fn<FetchLike>(async () => {
      throw new Error('Connexion refusée');
    });
    const networkState = await resolveApkCardState({ isOnline: true, fetcher: networkFetcher });
    expect(networkState).toEqual({
      kind: 'error',
      message: 'Connexion refusée',
    });

    const serverErrorFetcher = vi.fn<FetchLike>(
      async () => new Response('Server Error', { status: 500 }),
    );
    const serverErrorState = await resolveApkCardState({
      isOnline: true,
      fetcher: serverErrorFetcher,
    });
    expect(serverErrorState.kind).toBe('error');

    const invalidPayloadFetcher = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ available: 'oui' }), { status: 200 }),
    );
    const invalidPayloadState = await resolveApkCardState({
      isOnline: true,
      fetcher: invalidPayloadFetcher,
    });
    expect(invalidPayloadState.kind).toBe('error');
  });
});
