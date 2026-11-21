import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  AccountsQuerySchema,
  ClientKindSchema,
  DeltaSyncQuerySchema,
  EXCLUSIVE_DRIVE_FOLDERS,
  SessionTokenPayloadSchema,
  errorResponse,
  resolveRequestId,
  type AccountsFilter,
  type AccountsListResult,
  type AccountsRepository,
  type AllowedDriveFolderDescriptor,
  type AnalyticsOverviewQuery,
  type AnalyticsOverviewResponse,
  type AnalyticsRepository,
  type AppEnv,
  type BudgetDeleteResult,
  type BudgetItem,
  type BudgetUpsertResult,
  type BudgetsListResult,
  type BudgetsRepository,
  type ClientKind,
  type CreateRuleInput,
  type DeleteRuleOutcome,
  type DeleteRuleResult,
  type DeltaMutationRepository,
  type DeltaSyncQuery,
  type DriveSyncRunStarted,
  type DriveSyncService,
  type HealthRepository,
  type OutboxMutation,
  type OutboxMutationOutcome,
  type PatchTransactionResult,
  type PostSyncDeltaResponse,
  type PutBudgetInput,
  type ReapplyRulesResult,
  type ReorderRuleItem,
  type ReorderRulesResult,
  type RetroactiveStats,
  type RuleMutationResult,
  type RuleView,
  type RulesListResult,
  type RulesRepository,
  type SessionRepository,
  type SessionTokenPayload,
  type SyncDeltaRepository,
  type TransactionDetail,
  type TransactionPatchInput,
  type TransactionsFilter,
  type TransactionsListResult,
  type TransactionsRepository,
  type TriggerDriveSyncResult,
  type UpdateRuleInput,
  type UpdateRuleResult,
} from './routes/contracts.js';
import { registerDomainRoutes } from './routes/register-routes.js';

export {
  AccountsQuerySchema,
  ClientKindSchema,
  DeltaSyncQuerySchema,
  EXCLUSIVE_DRIVE_FOLDERS,
  SessionTokenPayloadSchema,
};

export type {
  AccountsFilter,
  AccountsListResult,
  AccountsRepository,
  AllowedDriveFolderDescriptor,
  AnalyticsOverviewQuery,
  AnalyticsOverviewResponse,
  AnalyticsRepository,
  AppEnv,
  BudgetDeleteResult,
  BudgetItem,
  BudgetUpsertResult,
  BudgetsListResult,
  BudgetsRepository,
  ClientKind,
  CreateRuleInput,
  DeleteRuleOutcome,
  DeleteRuleResult,
  DeltaMutationRepository,
  DeltaSyncQuery,
  DriveSyncRunStarted,
  DriveSyncService,
  HealthRepository,
  OutboxMutation,
  OutboxMutationOutcome,
  PatchTransactionResult,
  PostSyncDeltaResponse,
  PutBudgetInput,
  ReapplyRulesResult,
  ReorderRuleItem,
  ReorderRulesResult,
  RetroactiveStats,
  RuleMutationResult,
  RuleView,
  RulesListResult,
  RulesRepository,
  SessionRepository,
  SessionTokenPayload,
  SyncDeltaRepository,
  TransactionDetail,
  TransactionPatchInput,
  TransactionsFilter,
  TransactionsListResult,
  TransactionsRepository,
  TriggerDriveSyncResult,
  UpdateRuleInput,
  UpdateRuleResult,
};

// ============================================================================
// Session Token Signing & Verification (HMAC-SHA256)
// ============================================================================

const TOKEN_PREFIX = 'cfx_v1' as const;

export type VerifySessionTokenResult =
  | { readonly ok: true; readonly payload: SessionTokenPayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'invalid_signature' | 'expired' };

function computeTokenSignature(signingInput: string, sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(signingInput).digest();
}

export function signSessionToken(
  payload: SessionTokenPayload,
  sessionSecret: string,
): string {
  const validated = SessionTokenPayloadSchema.parse(payload);
  const encodedPayload = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
  const signingInput = `${TOKEN_PREFIX}.${encodedPayload}`;
  const signature = computeTokenSignature(signingInput, sessionSecret).toString('base64url');
  return `${signingInput}.${signature}`;
}

export function verifySessionToken(
  token: string,
  sessionSecret: string,
  now: Date = new Date(),
): VerifySessionTokenResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  const [prefix, encodedPayload, encodedSignature] = parts;
  if (
    prefix !== TOKEN_PREFIX ||
    encodedPayload === undefined ||
    encodedPayload.length === 0 ||
    encodedSignature === undefined ||
    encodedSignature.length === 0
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const signingInput = `${prefix}.${encodedPayload}`;
  const expectedSig = computeTokenSignature(signingInput, sessionSecret);

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  let rawJson: unknown;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    rawJson = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const parsedPayload = SessionTokenPayloadSchema.safeParse(rawJson);
  if (!parsedPayload.success) {
    return { ok: false, reason: 'malformed' };
  }

  const nowEpochSeconds = Math.floor(now.getTime() / 1000);
  if (parsedPayload.data.exp <= nowEpochSeconds) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload: parsedPayload.data };
}

// ============================================================================
// Dependency Injection Contracts (Deep Modules Boundary)
// ============================================================================

export interface AppDependencies {
  readonly sessionSecret: string;
  readonly allowedWebOrigin?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly healthRepository: HealthRepository;
  readonly sessionRepository?: SessionRepository | undefined;
  readonly accountsRepository: AccountsRepository;
  readonly syncDeltaRepository: SyncDeltaRepository;
  readonly driveSyncService: DriveSyncService;
  readonly transactionsRepository?: TransactionsRepository | undefined;
  readonly rulesRepository?: RulesRepository | undefined;
  readonly budgetsRepository?: BudgetsRepository | undefined;
  readonly analyticsRepository?: AnalyticsRepository | undefined;
  readonly deltaMutationRepository?: DeltaMutationRepository | undefined;
}

// ============================================================================
// Hono Application Factory
// ============================================================================

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type ExtractedCredential =
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed_header' }
  | { readonly kind: 'token'; readonly token: string; readonly transport: 'bearer' | 'cookie' };

function extractCredential(c: Context<AppEnv>): ExtractedCredential {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match === null) {
      return { kind: 'malformed_header' };
    }
    const token = match[1]?.trim();
    if (token === undefined || token.length === 0) {
      return { kind: 'malformed_header' };
    }
    return { kind: 'token', token, transport: 'bearer' };
  }

  const cookieToken = getCookie(c, 'clairflux_session');
  if (cookieToken !== undefined && cookieToken.trim().length > 0) {
    return { kind: 'token', token: cookieToken.trim(), transport: 'cookie' };
  }

  return { kind: 'none' };
}

export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const getNow = deps.now ?? (() => new Date());

  // Request-Id propagation on every response
  app.use('*', async (c, next) => {
    const requestId = resolveRequestId(c);
    c.set('requestId', requestId);
    await next();
    c.header('X-Request-Id', requestId);
  });

  // Public Docker healthcheck & readiness probes (root and /api aliases)
  const handleHealthz = (c: Context<AppEnv>): Response => {
    return c.json({ status: 'ok' as const }, 200);
  };

  const handleReadyz = async (c: Context<AppEnv>): Promise<Response> => {
    try {
      const dbHealthy = await deps.healthRepository.ping();
      if (!dbHealthy) {
        return c.json({ status: 'degraded' as const, db: 'error' as const }, 503);
      }
      return c.json({ status: 'ready' as const, db: 'ok' as const }, 200);
    } catch {
      return c.json({ status: 'degraded' as const, db: 'error' as const }, 503);
    }
  };

  app.get('/healthz', handleHealthz);
  app.get('/api/healthz', handleHealthz);
  app.get('/readyz', handleReadyz);
  app.get('/api/readyz', handleReadyz);

  // Personal single-user authentication middleware for all /api/* routes (except public probes)
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/healthz' || c.req.path === '/api/readyz') {
      await next();
      return;
    }

    const credential = extractCredential(c);
    if (credential.kind !== 'token') {
      return errorResponse(
        c,
        401,
        'UNAUTHORIZED',
        'Authentification requise : session absente ou invalide.',
      );
    }

    const verification = verifySessionToken(
      credential.token,
      deps.sessionSecret,
      getNow(),
    );
    if (!verification.ok) {
      return errorResponse(
        c,
        401,
        'UNAUTHORIZED',
        'Session expirée ou signature invalide.',
        { details: { reason: verification.reason } },
      );
    }

    if (deps.sessionRepository !== undefined) {
      const revoked = await deps.sessionRepository.isSessionRevoked(
        verification.payload.jti,
      );
      if (revoked) {
        return errorResponse(
          c,
          401,
          'UNAUTHORIZED',
          'Session révoquée. Veuillez vous reconnecter.',
        );
      }
    }

    if (
      credential.transport === 'cookie' &&
      MUTATING_METHODS.has(c.req.method)
    ) {
      const origin = c.req.header('Origin');
      const clientHeader = c.req.header('X-Clairflux-Client');
      const allowedOrigin = deps.allowedWebOrigin;
      if (
        allowedOrigin === undefined ||
        allowedOrigin.trim().length === 0 ||
        clientHeader !== 'web' ||
        origin !== allowedOrigin
      ) {
        return errorResponse(
          c,
          403,
          'CSRF_ORIGIN_MISMATCH',
          'Origine ou en-tête client Web invalide.',
        );
      }
    }

    c.set('session', {
      payload: verification.payload,
      transport: credential.transport,
    });

    await next();
  });

  // Register all validated business & delta sync routes
  registerDomainRoutes(app, deps, getNow);

  app.notFound((c) => {
    return errorResponse(c, 404, 'RESOURCE_NOT_FOUND', 'Route API introuvable.');
  });

  app.onError((_err, c) => {
    return errorResponse(
      c,
      500,
      'INTERNAL_ERROR',
      'Erreur interne inattendue du serveur.',
    );
  });

  return app;
}
