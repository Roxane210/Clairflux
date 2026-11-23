/**
 * Normalise l'URL de base API et construit une URL d'endpoint `/api/...`
 * sans jamais dupliquer le préfixe `/api` (ex. lorsque `VITE_API_BASE_URL=/api`).
 */
export function normalizeSafeApiBaseUrl(rawBaseUrl?: string): string {
  const trimmed = (rawBaseUrl ?? '').trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed.replace(/\/+$/, '');
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

export function buildApiEndpointUrl(
  rawBaseUrl: string | undefined,
  endpointPath: `/api/${string}`,
): string {
  const safeBase = normalizeSafeApiBaseUrl(rawBaseUrl);
  const withoutTrailingApi = safeBase.endsWith('/api') ? safeBase.slice(0, -4) : safeBase;
  return `${withoutTrailingApi}${endpointPath}`;
}
