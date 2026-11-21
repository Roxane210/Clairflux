import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DRIVE_FOLDERS,
  AccountSchema,
  ApiErrorEnvelopeSchema,
  DeltaSyncResponseSchema,
  toCents,
  toFxRateMicro,
  toSyncRevision,
  parseAccountId,
  parseTransactionId,
  parseRuleId,
  parseDriveFileId,
  type Account,
  type DeltaSyncResponse,
} from '@clairflux/shared';
import {
  createApp,
  signSessionToken,
  type AccountsFilter,
  type AccountsRepository,
  type AppDependencies,
  type DeltaSyncQuery,
  type DriveSyncService,
  type HealthRepository,
  type SessionRepository,
  type SyncDeltaRepository,
  type TriggerDriveSyncResult,
} from './app.js';
import { EnvValidationError, parseApiEnv } from './config/env.js';

const TEST_SESSION_SECRET = 'clairflux-test-session-secret-minimum-32-chars';
const FIXED_NOW = new Date('2026-11-21T14:00:00.000Z');
const VALID_JTI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVOKED_JTI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createValidToken(options?: {
  readonly jti?: string;
  readonly clientKind?: 'web' | 'android';
  readonly expOffsetSeconds?: number;
  readonly secret?: string;
}): string {
  const nowSeconds = Math.floor(FIXED_NOW.getTime() / 1000);
  return signSessionToken(
    {
      jti: options?.jti ?? VALID_JTI,
      client_kind: options?.clientKind ?? 'android',
      iat: nowSeconds - 60,
      exp: nowSeconds + (options?.expOffsetSeconds ?? 3600),
    },
    options?.secret ?? TEST_SESSION_SECRET,
  );
}

function buildMockAccounts(): readonly Account[] {
  return [
    AccountSchema.parse({
      id: parseAccountId('11111111-1111-4111-8111-111111111111'),
      bank: 'boursobank',
      account_type: 'courant',
      nickname: 'Perso BoursoBank',
      external_ref_masked: '•••• 4821',
      currency: 'EUR',
      current_balance_cents: toCents(412840),
      current_balance_eur_cents: toCents(412840),
      balance_updated_at: '2026-11-20T23:59:59.000Z',
      revision: toSyncRevision(1410),
      updated_at: '2026-11-20T18:02:11.000Z',
    }),
    AccountSchema.parse({
      id: parseAccountId('22222222-2222-4222-8222-222222222222'),
      bank: 'revolut',
      account_type: 'multi_devises',
      nickname: 'Courant USD',
      external_ref_masked: 'USD •• 9012',
      currency: 'USD',
      current_balance_cents: toCents(185000),
      current_balance_eur_cents: toCents(171033),
      balance_updated_at: '2026-11-20T23:59:59.000Z',
      revision: toSyncRevision(1455),
      updated_at: '2026-11-20T18:02:15.000Z',
    }),
  ];
}

function buildMockDeltaResponse(since: number): DeltaSyncResponse {
  const accounts = buildMockAccounts();
  return DeltaSyncResponseSchema.parse({
    since_revision: toSyncRevision(since),
    batch_end_revision: toSyncRevision(1495),
    latest_revision: toSyncRevision(1495),
    has_more: false,
    full_resync_required: false,
    server_time: FIXED_NOW.toISOString(),
    accounts: {
      upserted: [...accounts],
      deleted_ids: [],
    },
    transactions: {
      upserted: [
        {
          id: parseTransactionId('33333333-3333-4333-8333-333333333333'),
          account_id: parseAccountId('22222222-2222-4222-8222-222222222222'),
          bank: 'revolut',
          account_type: 'multi_devises',
          external_ref_masked: 'USD •• 9012',
          booking_date: '2026-11-18',
          value_date: '2026-11-18',
          raw_label: 'CURSOR AI *MONTHLY SAN FRANCISCO US',
          clean_label: 'Cursor AI',
          amount_cents: toCents(-2000),
          currency: 'USD',
          fx_rate_micro: toFxRateMicro(924500),
          amount_eur_cents: toCents(-1849),
          category: 'Logiciels & Cloud',
          is_manual_category: false,
          matched_rule_id: parseRuleId('44444444-4444-4444-8444-444444444444'),
          is_internal_transfer: false,
          is_manual_transfer_override: false,
          transfer_group_id: null,
          source_drive_file_id: '88888888-8888-4888-8888-888888888888',
          revision: toSyncRevision(1486),
          updated_at: '2026-11-21T13:22:00.000Z',
        },
      ],
      deleted_ids: [],
    },
    transaction_notes: {
      upserted: [
        {
          transaction_id: parseTransactionId('33333333-3333-4333-8333-333333333333'),
          content: 'Abonnement dev mensuel',
          revision: toSyncRevision(1487),
          updated_at: '2026-11-21T13:23:00.000Z',
        },
      ],
      deleted_transaction_ids: [],
    },
    categorization_rules: {
      upserted: [
        {
          id: parseRuleId('44444444-4444-4444-8444-444444444444'),
          name: 'Abonnements Cursor',
          priority: 100,
          bank_filter: 'revolut',
          account_id_filter: parseAccountId('22222222-2222-4222-8222-222222222222'),
          account_type_filter: null,
          match_mode: 'contains',
          pattern: 'CURSOR AI',
          target_category: 'Logiciels & Cloud',
          mark_as_internal_transfer: false,
          is_active: true,
          revision: toSyncRevision(1488),
          updated_at: '2026-11-21T13:25:00.000Z',
        },
      ],
      deleted_ids: [],
    },
    drive_sync_status: {
      last_run: {
        id: '66666666-6666-4666-8666-666666666666',
        status: 'partial_error',
        trigger_mode: 'manual',
        started_at: '2026-11-21T13:30:00.000Z',
        finished_at: '2026-11-21T13:30:42.000Z',
        total_files_discovered: 2,
        files_committed: 1,
        files_skipped_unchanged: 0,
        files_failed: 1,
      },
      files: [
        {
          drive_file_id: parseDriveFileId('1Rev_2026_10_usd'),
          drive_folder_id: ALLOWED_DRIVE_FOLDERS.revolut,
          bank: 'revolut',
          file_name: 'Revolut_Statement_2026_10.pdf',
          status: 'failed',
          attempt_count: 1,
          error_code: 'GEMINI_TIMEOUT',
          error_message: 'Délai Gemini dépassé lors de l’extraction.',
          revision: toSyncRevision(1495),
          updated_at: '2026-11-21T13:30:42.000Z',
        },
      ],
    },
    aggregates_snapshot: null,
  });
}

function createTestDeps(overrides?: {
  readonly dbHealthy?: boolean;
  readonly driveResult?: TriggerDriveSyncResult;
  readonly onListAccounts?: (filter: AccountsFilter) => void;
  readonly onGetDelta?: (query: DeltaSyncQuery) => void;
}): AppDependencies {
  const mockAccounts = buildMockAccounts();

  const healthRepository: HealthRepository = {
    async ping(): Promise<boolean> {
      return overrides?.dbHealthy ?? true;
    },
  };

  const sessionRepository: SessionRepository = {
    async isSessionRevoked(jti: string): Promise<boolean> {
      return jti === REVOKED_JTI;
    },
  };

  const accountsRepository: AccountsRepository = {
    async listAccounts(filter: AccountsFilter) {
      overrides?.onListAccounts?.(filter);
      const filtered = mockAccounts.filter((account) => {
        if (filter.bank !== undefined && account.bank !== filter.bank) {
          return false;
        }
        if (filter.currency !== undefined && account.currency !== filter.currency) {
          return false;
        }
        return true;
      });
      return {
        accounts: filtered,
        latest_revision: toSyncRevision(1495),
      };
    },
  };

  const syncDeltaRepository: SyncDeltaRepository = {
    async getDelta(query: DeltaSyncQuery): Promise<DeltaSyncResponse> {
      overrides?.onGetDelta?.(query);
      return buildMockDeltaResponse(query.since);
    },
  };

  const driveSyncService: DriveSyncService = {
    async triggerManualSync(): Promise<TriggerDriveSyncResult> {
      if (overrides?.driveResult !== undefined) {
        return overrides.driveResult;
      }
      return {
        ok: true,
        run: {
          id: '77777777-7777-4777-8777-777777777777',
          status: 'running',
          trigger_mode: 'manual',
          allowed_folders: [
            { folder_id: ALLOWED_DRIVE_FOLDERS.boursobank, bank: 'boursobank' },
            { folder_id: ALLOWED_DRIVE_FOLDERS.revolut, bank: 'revolut' },
          ],
          started_at: FIXED_NOW.toISOString(),
        },
      };
    },
  };

  return {
    sessionSecret: TEST_SESSION_SECRET,
    allowedWebOrigin: 'http://localhost:5173',
    now: () => FIXED_NOW,
    healthRepository,
    sessionRepository,
    accountsRepository,
    syncDeltaRepository,
    driveSyncService,
  };
}

describe('ClairFlux API (@clairflux/api)', () => {
  describe('Probes Docker /healthz et /readyz', () => {
    it('retourne 200 ok sur GET /healthz sans authentification', async () => {
      const app = createApp(createTestDeps());
      const res = await app.request('/healthz');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(res.headers.get('X-Request-Id')).toBeTruthy();

      const apiRes = await app.request('/api/healthz');
      expect(apiRes.status).toBe(200);
      expect(await apiRes.json()).toEqual({ status: 'ok' });
    });

    it('retourne 200 ready sur GET /readyz quand Neon répond et 503 sinon', async () => {
      const readyApp = createApp(createTestDeps({ dbHealthy: true }));
      const okRes = await readyApp.request('/readyz');
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toEqual({ status: 'ready', db: 'ok' });

      const degradedApp = createApp(createTestDeps({ dbHealthy: false }));
      const errRes = await degradedApp.request('/readyz');
      expect(errRes.status).toBe(503);
      expect(await errRes.json()).toEqual({ status: 'degraded', db: 'error' });
    });
  });

  describe('Authentification personnelle unique (401 normalisé)', () => {
    it('rejette 401 UNAUTHORIZED sans session sur les routes /api/*', async () => {
      const app = createApp(createTestDeps());

      const accountsRes = await app.request('/api/accounts');
      expect(accountsRes.status).toBe(401);
      const accountsBody = ApiErrorEnvelopeSchema.parse(await accountsRes.json());
      expect(accountsBody.error.code).toBe('UNAUTHORIZED');

      const deltaRes = await app.request('/api/sync/delta?since=0');
      expect(deltaRes.status).toBe(401);
      const deltaBody = ApiErrorEnvelopeSchema.parse(await deltaRes.json());
      expect(deltaBody.error.code).toBe('UNAUTHORIZED');

      const driveRes = await app.request('/api/sync/drive', { method: 'POST' });
      expect(driveRes.status).toBe(401);
      const driveBody = ApiErrorEnvelopeSchema.parse(await driveRes.json());
      expect(driveBody.error.code).toBe('UNAUTHORIZED');
    });

    it('rejette 401 si le jeton Bearer a une signature invalide, est expiré ou est révoqué', async () => {
      const app = createApp(createTestDeps());

      const wrongSecretToken = createValidToken({
        secret: 'wrong-secret-key-at-least-32-characters-long',
      });
      const wrongSigRes = await app.request('/api/accounts', {
        headers: { Authorization: `Bearer ${wrongSecretToken}` },
      });
      expect(wrongSigRes.status).toBe(401);

      const expiredToken = createValidToken({ expOffsetSeconds: -10 });
      const expiredRes = await app.request('/api/accounts', {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      expect(expiredRes.status).toBe(401);

      const revokedToken = createValidToken({ jti: REVOKED_JTI });
      const revokedRes = await app.request('/api/accounts', {
        headers: { Authorization: `Bearer ${revokedToken}` },
      });
      expect(revokedRes.status).toBe(401);
    });
  });

  describe('Validation Zod aux frontières HTTP', () => {
    it('rejette 400 BAD_REQUEST sur GET /api/sync/delta avec since invalide ou manquant', async () => {
      const app = createApp(createTestDeps());
      const token = createValidToken();

      for (const path of [
        '/api/sync/delta',
        '/api/sync/delta?since=-1',
        '/api/sync/delta?since=abc',
        '/api/sync/delta?since=1.5',
        '/api/sync/delta?since=0&limit=10',
      ]) {
        const res = await app.request(path, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(400);
        const body = ApiErrorEnvelopeSchema.parse(await res.json());
        expect(body.error.code).toBe('BAD_REQUEST');
      }
    });

    it('rejette 400 BAD_REQUEST sur GET /api/accounts avec une banque inconnue', async () => {
      const app = createApp(createTestDeps());
      const token = createValidToken();

      const res = await app.request('/api/accounts?bank=unknown', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = ApiErrorEnvelopeSchema.parse(await res.json());
      expect(body.error.code).toBe('BAD_REQUEST');
    });
  });

  describe('Endpoints contractuels (/api/accounts, /api/sync/delta, /api/sync/drive)', () => {
    it('retourne la liste structurée des comptes via GET /api/accounts avec filtre et cookie session Web', async () => {
      let capturedFilter: AccountsFilter | undefined;
      const app = createApp(
        createTestDeps({
          onListAccounts: (filter) => {
            capturedFilter = filter;
          },
        }),
      );
      const webToken = createValidToken({ clientKind: 'web' });

      const res = await app.request('/api/accounts?bank=revolut&currency=USD', {
        headers: {
          Cookie: `clairflux_session=${webToken}`,
        },
      });
      expect(res.status).toBe(200);
      expect(capturedFilter).toEqual({ bank: 'revolut', currency: 'USD' });

      const json: unknown = await res.json();
      expect(json).toMatchObject({
        latest_revision: 1495,
        accounts: [
          {
            bank: 'revolut',
            currency: 'USD',
            current_balance_cents: 185000,
            current_balance_eur_cents: 171033,
          },
        ],
      });
    });

    it('retourne la réponse delta conforme au contrat sur GET /api/sync/delta?since=0', async () => {
      let capturedQuery: DeltaSyncQuery | undefined;
      const app = createApp(
        createTestDeps({
          onGetDelta: (query) => {
            capturedQuery = query;
          },
        }),
      );
      const token = createValidToken();

      const res = await app.request('/api/sync/delta?since=0&limit=500', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(capturedQuery).toEqual({ since: toSyncRevision(0), limit: 500 });

      const parsed = DeltaSyncResponseSchema.parse(await res.json());
      expect(parsed.accounts.upserted).toHaveLength(2);
      expect(parsed.transactions.upserted).toHaveLength(1);
      expect(parsed.categorization_rules.upserted[0]?.account_id_filter).toBe(
        '22222222-2222-4222-8222-222222222222',
      );
    });

    it('déclenche POST /api/sync/drive exclusivement sur les 2 dossiers autorisés et gère 403 / 409', async () => {
      const app = createApp(createTestDeps());
      const token = createValidToken();

      const okRes = await app.request('/api/sync/drive', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: '{}',
      });
      expect(okRes.status).toBe(202);
      expect(await okRes.json()).toMatchObject({
        run: {
          status: 'running',
          trigger_mode: 'manual',
          allowed_folders: [
            { folder_id: ALLOWED_DRIVE_FOLDERS.boursobank, bank: 'boursobank' },
            { folder_id: ALLOWED_DRIVE_FOLDERS.revolut, bank: 'revolut' },
          ],
        },
      });

      const forbiddenFolderRes = await app.request('/api/sync/drive', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ folder_id: 'unauthorized-drive-folder-id' }),
      });
      expect(forbiddenFolderRes.status).toBe(403);
      const forbiddenBody = ApiErrorEnvelopeSchema.parse(
        await forbiddenFolderRes.json(),
      );
      expect(forbiddenBody.error.code).toBe('INVALID_DRIVE_FOLDER_SCOPE');

      const conflictApp = createApp(
        createTestDeps({
          driveResult: {
            ok: false,
            reason: 'already_running',
            activeRunId: '99999999-9999-4999-8999-999999999999',
          },
        }),
      );
      const conflictRes = await conflictApp.request('/api/sync/drive', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(conflictRes.status).toBe(409);
      const conflictBody = ApiErrorEnvelopeSchema.parse(await conflictRes.json());
      expect(conflictBody.error.code).toBe('SYNC_ALREADY_RUNNING');
    });

    it('applique un contrôle CSRF fail-closed sur les mutations par cookie Web', async () => {
      const webToken = createValidToken({ clientKind: 'web' });

      const baseDeps = createTestDeps();
      const failClosedNoOriginApp = createApp({
        sessionSecret: baseDeps.sessionSecret,
        now: baseDeps.now,
        healthRepository: baseDeps.healthRepository,
        sessionRepository: baseDeps.sessionRepository,
        accountsRepository: baseDeps.accountsRepository,
        syncDeltaRepository: baseDeps.syncDeltaRepository,
        driveSyncService: baseDeps.driveSyncService,
      });

      const noAllowedOriginRes = await failClosedNoOriginApp.request('/api/sync/drive', {
        method: 'POST',
        headers: {
          Cookie: `clairflux_session=${webToken}`,
          Origin: 'http://localhost:5173',
          'X-Clairflux-Client': 'web',
        },
      });
      expect(noAllowedOriginRes.status).toBe(403);
      const noAllowedBody = ApiErrorEnvelopeSchema.parse(await noAllowedOriginRes.json());
      expect(noAllowedBody.error.code).toBe('CSRF_ORIGIN_MISMATCH');

      const configuredApp = createApp(createTestDeps());
      const wrongOriginRes = await configuredApp.request('/api/sync/drive', {
        method: 'POST',
        headers: {
          Cookie: `clairflux_session=${webToken}`,
          Origin: 'https://evil.example',
          'X-Clairflux-Client': 'web',
        },
      });
      expect(wrongOriginRes.status).toBe(403);

      const validCsrfRes = await configuredApp.request('/api/sync/drive', {
        method: 'POST',
        headers: {
          Cookie: `clairflux_session=${webToken}`,
          Origin: 'http://localhost:5173',
          'X-Clairflux-Client': 'web',
        },
      });
      expect(validCsrfRes.status).toBe(202);
    });
  });

  describe('Validation fail-fast de l’environnement (parseApiEnv)', () => {
    it('valide une configuration complète et impose sslmode=require dans tous les environnements', () => {
      const parsed = parseApiEnv({
        DATABASE_URL: 'postgresql://user:pass@ep-cool.neon.tech/clairflux?sslmode=require',
        CLAIRFLUX_ACCESS_SECRET_HASH: '$argon2id$v=19$m=65536,t=3,p=4$test-hash-value',
        CLAIRFLUX_SESSION_SECRET: TEST_SESSION_SECRET,
        PORT: '3000',
        NODE_ENV: 'production',
      });
      expect(parsed.PORT).toBe(3000);
      expect(parsed.NODE_ENV).toBe('production');

      expect(() =>
        parseApiEnv({
          DATABASE_URL: 'postgresql://user:pass@localhost:5432/clairflux',
          CLAIRFLUX_ACCESS_SECRET_HASH: '$argon2id$v=19$m=65536,t=3,p=4$test-hash-value',
          CLAIRFLUX_SESSION_SECRET: TEST_SESSION_SECRET,
          NODE_ENV: 'development',
        }),
      ).toThrow(EnvValidationError);

      expect(() =>
        parseApiEnv({
          DATABASE_URL: 'postgresql://user:pass@localhost:5432/clairflux?sslmode=require',
          CLAIRFLUX_ACCESS_SECRET_HASH: '$argon2id$v=19$m=65536,t=3,p=4$test-hash-value',
          CLAIRFLUX_SESSION_SECRET: 'short',
          NODE_ENV: 'production',
        }),
      ).toThrow(EnvValidationError);
    });
  });
});
