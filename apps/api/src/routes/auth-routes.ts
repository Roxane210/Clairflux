import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { toSyncRevision, type SyncRevision } from '@clairflux/shared';
import { verifyAccessSecret } from '../auth/password.js';
import { createLoginRateLimiter, type LoginRateLimiter } from '../auth/rate-limit.js';
import {
  LoginBodySchema,
  LogoutBodySchema,
  errorResponse,
  formatZodIssues,
  parseJsonBody,
  type AppEnv,
  type ClientKind,
  type SessionRepository,
  type SessionTokenPayload,
} from './contracts.js';

export const SESSION_COOKIE_NAME = 'clairflux_session' as const;
const WEB_SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const ANDROID_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AuthRouteDependencies {
  readonly sessionSecret: string;
  readonly allowedWebOrigin?: string | undefined;
  readonly accessSecretHash?: string | undefined;
  readonly sessionRepository?: SessionRepository | undefined;
  readonly getLatestRevision?: (() => Promise<SyncRevision>) | undefined;
  readonly loginRateLimiter?: LoginRateLimiter | undefined;
  readonly signToken: (payload: SessionTokenPayload, secret: string) => string;
}

export function normalizeOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) {
    return undefined;
  }
  const trimmed = origin.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isHttpsTransport(
  c: Context<AppEnv>,
  allowedWebOrigin: string | undefined,
): boolean {
  const forwardedProto = c.req.header('X-Forwarded-Proto');
  if (forwardedProto !== undefined) {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (firstProto === 'https') {
      return true;
    }
    if (firstProto === 'http') {
      return false;
    }
  }

  if (c.req.url.toLowerCase().startsWith('https://')) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(allowedWebOrigin);
  return normalizedOrigin !== undefined && normalizedOrigin.toLowerCase().startsWith('https://');
}

function extractClientIp(c: Context<AppEnv>): string {
  const forwardedFor = c.req.header('X-Forwarded-For');
  if (forwardedFor !== undefined) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  const realIp = c.req.header('X-Real-IP')?.trim();
  if (realIp !== undefined && realIp.length > 0) {
    return realIp;
  }
  return 'direct';
}

export function registerAuthRoutes(
  app: Hono<AppEnv>,
  deps: AuthRouteDependencies,
  getNow: () => Date,
): void {
  const rateLimiter =
    deps.loginRateLimiter ?? createLoginRateLimiter({ now: () => getNow().getTime() });

  app.post('/api/auth/login', async (c) => {
    const clientIp = extractClientIp(c);
    const rateCheck = rateLimiter.check(clientIp);
    if (!rateCheck.allowed) {
      c.header('Retry-After', String(rateCheck.retryAfterSeconds));
      return errorResponse(
        c,
        429,
        'RATE_LIMITED',
        'Trop de tentatives de connexion. Veuillez patienter avant de réessayer.',
        {
          retryable: true,
          details: { retry_after_seconds: rateCheck.retryAfterSeconds },
        },
      );
    }

    const jsonBody = await parseJsonBody(c);
    if (!jsonBody.ok) {
      return jsonBody.response;
    }

    const parsedBody = LoginBodySchema.safeParse(jsonBody.data);
    if (!parsedBody.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de connexion invalides.',
        { details: formatZodIssues(parsedBody.error) },
      );
    }

    const isValid =
      deps.accessSecretHash !== undefined &&
      verifyAccessSecret(parsedBody.data.secret, deps.accessSecretHash);

    if (!isValid) {
      rateLimiter.recordFailure(clientIp);
      return errorResponse(
        c,
        401,
        'INVALID_CREDENTIALS',
        'Secret personnel incorrect.',
      );
    }

    rateLimiter.reset(clientIp);

    const clientKind: ClientKind = parsedBody.data.client_kind;
    const ttlSeconds =
      clientKind === 'android' ? ANDROID_SESSION_TTL_SECONDS : WEB_SESSION_TTL_SECONDS;
    const nowEpoch = Math.floor(getNow().getTime() / 1000);
    const expiresEpoch = nowEpoch + ttlSeconds;
    const sessionId = randomUUID();
    const expiresAtIso = new Date(expiresEpoch * 1000).toISOString();

    const token = deps.signToken(
      {
        jti: sessionId,
        client_kind: clientKind,
        iat: nowEpoch,
        exp: expiresEpoch,
      },
      deps.sessionSecret,
    );

    if (clientKind === 'web') {
      setCookie(c, SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/api',
        maxAge: ttlSeconds,
        secure: isHttpsTransport(c, deps.allowedWebOrigin),
      });

      return c.json(
        {
          authenticated: true as const,
          client_kind: 'web' as const,
          session_id: sessionId,
          expires_at: expiresAtIso,
        },
        200,
      );
    }

    return c.json(
      {
        authenticated: true as const,
        client_kind: 'android' as const,
        session_id: sessionId,
        token_type: 'Bearer' as const,
        access_token: token,
        expires_at: expiresAtIso,
      },
      200,
    );
  });

  app.get('/api/auth/session', async (c) => {
    const session = c.get('session');
    const latestRevision =
      deps.getLatestRevision !== undefined
        ? await deps.getLatestRevision()
        : toSyncRevision(0);

    return c.json(
      {
        authenticated: true as const,
        client_kind: session.payload.client_kind,
        session_id: session.payload.jti,
        expires_at: new Date(session.payload.exp * 1000).toISOString(),
        latest_revision: latestRevision,
      },
      200,
    );
  });

  app.post('/api/auth/logout', async (c) => {
    const rawBody = await c.req.text();
    let revokeAll = false;

    if (rawBody.trim().length > 0) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody);
      } catch {
        return errorResponse(c, 400, 'BAD_REQUEST', 'Corps JSON malformé.');
      }

      const parsedBody = LogoutBodySchema.safeParse(parsedJson);
      if (!parsedBody.success) {
        return errorResponse(
          c,
          400,
          'BAD_REQUEST',
          'Paramètres de déconnexion invalides.',
          { details: formatZodIssues(parsedBody.error) },
        );
      }
      revokeAll = parsedBody.data.revoke_all;
    }

    const session = c.get('session');
    if (revokeAll) {
      const nowEpoch = Math.floor(getNow().getTime() / 1000);
      await deps.sessionRepository?.revokeAllSessions?.(nowEpoch);
    } else {
      await deps.sessionRepository?.revokeSession?.(session.payload.jti);
    }

    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: '/api',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttpsTransport(c, deps.allowedWebOrigin),
    });

    return c.json(
      {
        authenticated: false as const,
        revoked: true as const,
      },
      200,
    );
  });
}
