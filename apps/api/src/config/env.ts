import { z } from 'zod';

const emptyStringToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
};

const DatabaseUrlSchema = z
  .string({ required_error: 'DATABASE_URL est requis.' })
  .trim()
  .min(1, 'DATABASE_URL ne peut pas être vide.')
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
          parsed.searchParams.get('sslmode') === 'require'
        );
      } catch {
        return false;
      }
    },
    {
      message:
        'DATABASE_URL doit être une URL postgres:// ou postgresql:// valide avec sslmode=require.',
    },
  );

export const ApiEnvSchema = z.object({
  DATABASE_URL: DatabaseUrlSchema,
  CLAIRFLUX_ACCESS_SECRET_HASH: z
    .string({ required_error: 'CLAIRFLUX_ACCESS_SECRET_HASH est requis.' })
    .trim()
    .min(16, 'CLAIRFLUX_ACCESS_SECRET_HASH doit contenir au moins 16 caractères.'),
  CLAIRFLUX_SESSION_SECRET: z
    .string({ required_error: 'CLAIRFLUX_SESSION_SECRET est requis.' })
    .min(32, 'CLAIRFLUX_SESSION_SECRET doit contenir au moins 32 caractères.'),
  PORT: z.preprocess(
    emptyStringToUndefined,
    z.coerce
      .number()
      .int('PORT doit être un entier.')
      .min(1, 'PORT doit être compris entre 1 et 65535.')
      .max(65535, 'PORT doit être compris entre 1 et 65535.')
      .default(3000),
  ),
  NODE_ENV: z.preprocess(
    emptyStringToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  CLAIRFLUX_WEB_ORIGIN: z.preprocess(
    emptyStringToUndefined,
    z.string().url('CLAIRFLUX_WEB_ORIGIN doit être une URL valide.').default('http://localhost:5173'),
  ),
  SYNC_WORKER_URL: z.preprocess(
    emptyStringToUndefined,
    z.string().url('SYNC_WORKER_URL doit être une URL valide.').default('http://sync-worker:4001'),
  ),
});

export type ApiEnv = Readonly<z.infer<typeof ApiEnvSchema>>;

export interface EnvValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class EnvValidationError extends Error {
  public readonly issues: readonly EnvValidationIssue[];

  public constructor(issues: readonly EnvValidationIssue[]) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    super(`Configuration d'environnement API invalide : ${summary}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseApiEnv(rawEnv: Readonly<Record<string, string | undefined>> = process.env): ApiEnv {
  const result = ApiEnvSchema.safeParse(rawEnv);

  if (!result.success) {
    const issues: EnvValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'env',
      message: issue.message,
    }));
    throw new EnvValidationError(issues);
  }

  return result.data;
}
