import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  ALLOWED_DRIVE_FOLDERS,
  BankSchema,
  CurrencySchema,
  assertNever,
  isAllowedDriveFolderId,
  toSyncRevision,
  type Account,
  type AllowedDriveFolderId,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  type Bank,
  type Currency,
  type DeltaSyncResponse,
  type SyncRevision,
  type SyncRunStatus,
  type SyncTrigger,
} from '@clairflux/shared';

// ============================================================================
// Session Token Signing & Verification (HMAC-SHA256)
// ============================================================================

const TOKEN_PREFIX = 'cfx_v1' as const;

export const ClientKindSchema = z.enum(['web', 'android']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

export const SessionTokenPayloadSchema = z.object({
  jti: z.string().uuid(),
  client_kind: ClientKindSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type SessionTokenPayload = z.infer<typeof SessionTokenPayloadSchema>;

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

export interface HealthRepository {
  ping(): Promise<boolean>;
}

export interface SessionRepository {
  isSessionRevoked(jti: string): Promise<boolean>;
}

export interface AccountsFilter {
  readonly bank?: Bank;
  readonly currency?: Currency;
}

export interface AccountsListResult {
  readonly accounts: readonly Account[];
  readonly latest_revision: SyncRevision;
}

export interface AccountsRepository {
  listAccounts(filter: AccountsFilter): Promise<AccountsListResult>;
}

export interface DeltaSyncQuery {
  readonly since: SyncRevision;
  readonly limit: number;
}

export interface SyncDeltaRepository {
  getDelta(query: DeltaSyncQuery): Promise<DeltaSyncResponse>;
}

export interface AllowedDriveFolderDescriptor {
  readonly folder_id: AllowedDriveFolderId;
  readonly bank: Bank;
}

export interface DriveSyncRunStarted {
  readonly id: string;
  readonly status: Extract<SyncRunStatus, 'running'>;
  readonly trigger_mode: SyncTrigger;
  readonly allowed_folders: readonly AllowedDriveFolderDescriptor[];
  readonly started_at: string;
}

export type TriggerDriveSyncResult =
  | { readonly ok: true; readonly run: DriveSyncRunStarted }
  | { readonly ok: false; readonly reason: 'already_running'; readonly activeRunId: string }
  | { readonly ok: false; readonly reason: 'upstream_error'; readonly message: string };

export interface DriveSyncService {
  triggerManualSync(): Promise<TriggerDriveSyncResult>;
}

export interface AppDependencies {
  readonly sessionSecret: string;
  readonly allowedWebOrigin?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly healthRepository: HealthRepository;
  readonly sessionRepository?: SessionRepository | undefined;
  readonly accountsRepository: AccountsRepository;
  readonly syncDeltaRepository: SyncDeltaRepository;
  readonly driveSyncService: DriveSyncService;
}

// ============================================================================
// HTTP Boundary Validation Schemas (Zod)
// ============================================================================

export const AccountsQuerySchema = z.object({
  bank: BankSchema.optional(),
  currency: CurrencySchema.optional(),
});

const StrictNonNegativeIntStringSchema = z
  .string({ required_error: 'Le paramètre since est requis.' })
  .regex(/^(0|[1-9]\d*)$/, 'Le paramètre since doit être un entier >= 0.')
  .transform((value) => Number(value))
  .refine(
    (num) => Number.isSafeInteger(num) && num >= 0,
    'Le paramètre since est hors plage.',
  );

const StrictLimitStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'Le paramètre limit doit être un entier entre 50 et 1000.')
  .transform((value) => Number(value))
  .refine(
    (num) => Number.isSafeInteger(num) && num >= 50 && num <= 1000,
    'Le paramètre limit doit être compris entre 50 et 1000.',
  );

export const DeltaSyncQuerySchema = z.object({
  since: StrictNonNegativeIntStringSchema.transform((num) => toSyncRevision(num)),
  limit: StrictLimitStringSchema.optional(),
});

const EmptyTriggerBodySchema = z.object({}).strict();

export const EXCLUSIVE_DRIVE_FOLDERS: readonly AllowedDriveFolderDescriptor[] = [
  { folder_id: ALLOWED_DRIVE_FOLDERS.boursobank, bank: 'boursobank' },
  { folder_id: ALLOWED_DRIVE_FOLDERS.revolut, bank: 'revolut' },
] as const;

// ============================================================================
// Hono Application Factory
// ============================================================================

interface AuthenticatedSession {
  readonly payload: SessionTokenPayload;
  readonly transport: 'bearer' | 'cookie';
}

interface AppEnv {
  Variables: {
    readonly requestId: string;
    readonly session: AuthenticatedSession;
  };
}

type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function resolveRequestId(c: Context<AppEnv>): string {
  const existing = c.get('requestId');
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }
  const incoming = c.req.header('X-Request-Id')?.trim();
  if (incoming !== undefined && incoming.length > 0 && incoming.length <= 64) {
    return incoming;
  }
  return randomUUID();
}

function errorResponse(
  c: Context<AppEnv>,
  status: HttpErrorStatus,
  code: ApiErrorCode,
  message: string,
  options?: {
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  },
): Response {
  const requestId = resolveRequestId(c);
  const body: ApiErrorEnvelope = {
    error: {
      code,
      message,
      retryable: options?.retryable ?? false,
      request_id: requestId,
      ...(options?.details !== undefined ? { details: { ...options.details } } : {}),
    },
  };
  return c.json(body, status);
}

function formatZodIssues(error: z.ZodError): Readonly<Record<string, unknown>> {
  const first = error.issues[0];
  return {
    ...(first !== undefined
      ? {
          field: first.path.length > 0 ? first.path.join('.') : 'query',
          issue: first.code,
        }
      : {}),
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  // GET /api/accounts
  app.get('/api/accounts', async (c) => {
    const rawQuery = {
      bank: c.req.query('bank'),
      currency: c.req.query('currency'),
    };
    const parsedQuery = AccountsQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de filtrage des comptes invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const filter: AccountsFilter = {
      ...(parsedQuery.data.bank !== undefined ? { bank: parsedQuery.data.bank } : {}),
      ...(parsedQuery.data.currency !== undefined
        ? { currency: parsedQuery.data.currency }
        : {}),
    };

    const result = await deps.accountsRepository.listAccounts(filter);
    return c.json(result, 200);
  });

  // GET /api/sync/delta
  app.get('/api/sync/delta', async (c) => {
    const rawQuery = {
      since: c.req.query('since'),
      limit: c.req.query('limit'),
    };
    const parsedQuery = DeltaSyncQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) {
      return errorResponse(
        c,
        400,
        'BAD_REQUEST',
        'Paramètres de synchronisation delta invalides.',
        { details: formatZodIssues(parsedQuery.error) },
      );
    }

    const delta = await deps.syncDeltaRepository.getDelta({
      since: parsedQuery.data.since,
      limit: parsedQuery.data.limit ?? 500,
    });

    return c.json(delta, 200);
  });

  // POST /api/sync/drive (manual trigger strictly scoped to the 2 exclusive folders)
  app.post('/api/sync/drive', async (c) => {
    const rawBody = await c.req.text();
    if (rawBody.trim().length > 0) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody);
      } catch {
        return errorResponse(c, 400, 'BAD_REQUEST', 'Corps JSON malformé.');
      }

      if (isPlainRecord(parsedJson)) {
        const candidateFolderId =
          typeof parsedJson['folder_id'] === 'string'
            ? parsedJson['folder_id']
            : typeof parsedJson['drive_folder_id'] === 'string'
              ? parsedJson['drive_folder_id']
              : undefined;

        if (candidateFolderId !== undefined && !isAllowedDriveFolderId(candidateFolderId)) {
          return errorResponse(
            c,
            403,
            'INVALID_DRIVE_FOLDER_SCOPE',
            'Périmètre Google Drive interdit : seuls les 2 dossiers configurés sont autorisés.',
            { details: { folder_id: candidateFolderId } },
          );
        }
      }

      const validatedBody = EmptyTriggerBodySchema.safeParse(parsedJson);
      if (!validatedBody.success) {
        return errorResponse(
          c,
          422,
          'VALIDATION_ERROR',
          'Le déclenchement manuel Drive n’accepte aucun paramètre arbitraire.',
          { details: formatZodIssues(validatedBody.error) },
        );
      }
    }

    const syncResult = await deps.driveSyncService.triggerManualSync();

    if (syncResult.ok) {
      return c.json(
        {
          run: {
            ...syncResult.run,
            allowed_folders: EXCLUSIVE_DRIVE_FOLDERS,
          },
        },
        202,
      );
    }

    switch (syncResult.reason) {
      case 'already_running':
        return errorResponse(
          c,
          409,
          'SYNC_ALREADY_RUNNING',
          'Une synchronisation Google Drive est déjà en cours.',
          {
            retryable: true,
            details: { active_run_id: syncResult.activeRunId },
          },
        );
      case 'upstream_error':
        return errorResponse(
          c,
          502,
          'UPSTREAM_DRIVE_ERROR',
          syncResult.message,
          { retryable: true },
        );
      default:
        return assertNever(syncResult);
    }
  });

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
