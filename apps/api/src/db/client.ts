import { Pool, neon } from '@neondatabase/serverless';
import { drizzle as drizzleHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as drizzleServerless, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { z } from 'zod';
import { schema } from './schema.js';

export type ClairfluxSchema = typeof schema;
export type ClairfluxHttpDb = NeonHttpDatabase<ClairfluxSchema>;
export type ClairfluxPoolDb = NeonDatabase<ClairfluxSchema>;

export interface NeonClients {
  /** Stateless HTTP Drizzle client for fast single reads & delta pull queries. */
  readonly httpDb: ClairfluxHttpDb;
  /** WebSocket Pool Drizzle client for multi-table ACID `db.transaction(...)` commits. */
  readonly poolDb: ClairfluxPoolDb;
  /** Underlying Neon Pool for graceful shutdown in Docker/Node. */
  readonly pool: Pool;
  /** Closes the WebSocket pool cleanly. */
  close(): Promise<void>;
}

const NeonDatabaseUrlSchema = z
  .string()
  .trim()
  .min(1, 'DATABASE_URL must not be empty')
  .superRefine((raw, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL must be a valid PostgreSQL connection URL',
      });
      return;
    }

    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL must use the postgres:// or postgresql:// scheme',
      });
    }

    if (!parsed.hostname) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL must include a target hostname',
      });
    }

    if (parsed.searchParams.get('sslmode') !== 'require') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL must enforce sslmode=require for Neon Serverless security',
      });
    }
  });

/**
 * Validates that a Neon connection string uses postgres/postgresql and strictly enforces `sslmode=require`.
 */
export function assertValidNeonDatabaseUrl(databaseUrl: string): string {
  return NeonDatabaseUrlSchema.parse(databaseUrl);
}

/**
 * Creates both the stateless Neon HTTP Drizzle client (reads) and the WebSocket Pool Drizzle client (ACID transactions).
 */
export function createNeonClients(databaseUrl: string): NeonClients {
  const validatedUrl = assertValidNeonDatabaseUrl(databaseUrl);

  const sqlClient = neon(validatedUrl);
  const httpDb = drizzleHttp(sqlClient, { schema });

  const pool = new Pool({ connectionString: validatedUrl });
  pool.on('error', (err: unknown) => {
    console.error('[api] Erreur Neon Pool (non bloquante):', err);
  });
  const poolDb = drizzleServerless(pool, { schema });

  return {
    httpDb,
    poolDb,
    pool,
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Instantiates Neon clients from `process.env.DATABASE_URL` with fail-fast Zod + SSL validation.
 */
export function createNeonClientsFromEnv(env: NodeJS.ProcessEnv = process.env): NeonClients {
  const rawUrl = env['DATABASE_URL'] ?? '';
  return createNeonClients(rawUrl);
}
