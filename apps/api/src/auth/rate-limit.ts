export interface LoginRateLimiterOptions {
  readonly maxAttempts?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

export type RateLimitCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface LoginRateLimiter {
  check(ip: string): RateLimitCheckResult;
  recordFailure(ip: string): void;
  reset(ip: string): void;
}

interface FailureWindow {
  readonly count: number;
  readonly expiresAtMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_KEYS = 2048;

export function createLoginRateLimiter(
  options: LoginRateLimiterOptions = {},
): LoginRateLimiter {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const getNowMs = options.now ?? (() => Date.now());
  const windows = new Map<string, FailureWindow>();

  const pruneExpired = (nowMs: number): void => {
    for (const [key, entry] of windows.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        windows.delete(key);
      }
    }
  };

  const normalizeKey = (ip: string): string => {
    const trimmed = ip.trim();
    return trimmed.length > 0 ? trimmed : 'direct';
  };

  return {
    check(ip: string): RateLimitCheckResult {
      const nowMs = getNowMs();
      pruneExpired(nowMs);
      const key = normalizeKey(ip);
      const entry = windows.get(key);
      if (entry === undefined || entry.count < maxAttempts) {
        return { allowed: true };
      }
      const remainingMs = Math.max(1000, entry.expiresAtMs - nowMs);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(remainingMs / 1000),
      };
    },

    recordFailure(ip: string): void {
      const nowMs = getNowMs();
      pruneExpired(nowMs);
      const key = normalizeKey(ip);
      const current = windows.get(key);

      if (current === undefined || current.expiresAtMs <= nowMs) {
        if (windows.size >= MAX_TRACKED_KEYS) {
          const oldestKey = windows.keys().next().value;
          if (oldestKey !== undefined) {
            windows.delete(oldestKey);
          }
        }
        windows.set(key, {
          count: 1,
          expiresAtMs: nowMs + windowMs,
        });
        return;
      }

      windows.set(key, {
        count: current.count + 1,
        expiresAtMs: current.expiresAtMs,
      });
    },

    reset(ip: string): void {
      windows.delete(normalizeKey(ip));
    },
  };
}
