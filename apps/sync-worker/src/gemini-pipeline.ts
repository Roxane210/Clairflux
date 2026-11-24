import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { Pool, neon } from '@neondatabase/serverless';
import {
  AccountTypeSchema,
  BankSchema,
  CentsSchema,
  CheckpointErrorCodeSchema,
  CurrencySchema,
  EUR_FX_RATE_MICRO,
  FxRateMicroSchema,
  FxSourceSchema,
  IsoDateSchema,
  RuleMatchModeSchema,
  assertNever,
  convertToEurCents,
  isAllowedDriveFolderId,
  toCents,
  toFxRateMicro,
  type AccountType,
  type AllowedDriveFolderId,
  type Bank,
  type Cents,
  type CheckpointErrorCode,
  type CheckpointStatus,
  type Currency,
  type FxRateMicro,
  type FxSource,
  type RuleMatchMode,
  type SyncRunStatus,
} from '@clairflux/shared';
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { drizzle as drizzleHttp, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as drizzleServerless, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ALLOWED_DRIVE_FOLDER_ENTRIES,
  DriveDownloadError,
  InvalidDriveFolderScopeError,
  PdfUnreadableError,
  assertAllowedDriveFolderId,
  createDriveAccessTokenProvider,
  createGoogleDriveClient,
  prepareDrivePdfBatches,
  type DiscoveredDrivePdf,
  type FetchLike,
  type GoogleDriveClient,
  type PdfTextBatch,
  type PdfTextExtractor,
} from './drive-pdf.js';

// ============================================================================
// Constants & Canonical Error Types
// ============================================================================

export const GEMINI_FALLBACK_MODELS = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
] as const;

export type GeminiModelName = (typeof GEMINI_FALLBACK_MODELS)[number];

const DEFAULT_GEMINI_TIMEOUT_MS = 45_000;
const MS_PER_DAY = 86_400_000;
const SAME_CURRENCY_TRANSFER_MAX_DAYS = 3;
const REVOLUT_FX_TRANSFER_MAX_DAYS = 1;
const REVOLUT_FX_MIN_TOLERANCE_CENTS = 200;
const REVOLUT_FX_TOLERANCE_RATIO = 0.03;
const FX_EXCHANGE_HINT_PATTERN = /\b(?:exchanged\s+to|conversion|fx|change|eur|usd)\b/u;
const MAX_REGEX_PATTERN_LENGTH = 120;

export class PipelineStepError extends Error {
  public readonly code: CheckpointErrorCode;

  public constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = 'PipelineStepError';
    this.code = code;
  }
}

export function mapUnknownToCheckpointError(err: unknown): {
  readonly code: CheckpointErrorCode;
  readonly message: string;
} {
  if (err instanceof PipelineStepError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof DriveDownloadError || err instanceof InvalidDriveFolderScopeError) {
    return { code: 'DRIVE_DOWNLOAD_ERROR', message: err.message };
  }
  if (err instanceof PdfUnreadableError) {
    return { code: 'PDF_UNREADABLE', message: err.message };
  }
  if (err instanceof Error) {
    return { code: 'GEMINI_SCHEMA_INVALID', message: err.message };
  }
  return { code: 'GEMINI_SCHEMA_INVALID', message: String(err) };
}

// ============================================================================
// Worker Environment Validation (Zod Boundary)
// ============================================================================

const emptyStringToUndefined = (value: unknown): unknown => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
};

const NeonDatabaseUrlSchema = z
  .string({ required_error: 'DATABASE_URL est requis.' })
  .trim()
  .min(1, 'DATABASE_URL ne peut pas être vide.')
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
          Boolean(parsed.hostname) &&
          parsed.searchParams.get('sslmode') === 'require'
        );
      } catch {
        return false;
      }
    },
    {
      message:
        'DATABASE_URL doit être une URL PostgreSQL valide incluant sslmode=require.',
    },
  );

export const WorkerEnvSchema = z
  .object({
    DATABASE_URL: NeonDatabaseUrlSchema,
    GEMINI_API_KEY: z
      .string({ required_error: 'GEMINI_API_KEY est requis.' })
      .trim()
      .min(1, 'GEMINI_API_KEY ne peut pas être vide.'),
    GOOGLE_DRIVE_ACCESS_TOKEN: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().min(1).optional(),
    ),
    GOOGLE_DRIVE_CREDENTIALS_PATH: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().min(1).optional(),
    ),
    INTERNAL_WORKER_TOKEN: z
      .string({ required_error: 'INTERNAL_WORKER_TOKEN est requis.' })
      .min(16, 'INTERNAL_WORKER_TOKEN doit contenir au moins 16 caractères.'),
    PORT: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(65535).default(4001),
    ),
    NODE_ENV: z.preprocess(
      emptyStringToUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
  })
  .superRefine((env, ctx) => {
    if (
      env.GOOGLE_DRIVE_ACCESS_TOKEN === undefined &&
      env.GOOGLE_DRIVE_CREDENTIALS_PATH === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_DRIVE_ACCESS_TOKEN'],
        message:
          'GOOGLE_DRIVE_ACCESS_TOKEN ou GOOGLE_DRIVE_CREDENTIALS_PATH est requis.',
      });
    }
  });

export type WorkerEnv = Readonly<z.infer<typeof WorkerEnvSchema>>;

export class WorkerEnvValidationError extends Error {
  public readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;

  public constructor(
    issues: ReadonlyArray<{ readonly path: string; readonly message: string }>,
  ) {
    const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    super(`Configuration worker invalide : ${summary}`);
    this.name = 'WorkerEnvValidationError';
    this.issues = issues;
  }
}

export function parseWorkerEnv(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
): WorkerEnv {
  const parsed = WorkerEnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : 'env',
      message: issue.message,
    }));
    throw new WorkerEnvValidationError(issues);
  }
  return parsed.data;
}

// ============================================================================
// Gemini Extraction Zod Schemas (Zero Float, Strict Calendar Dates)
// ============================================================================

export const CalendarIsoDateSchema = IsoDateSchema.refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Date calendaire ISO invalide');

export const GeminiExtractedAccountSchema = z.object({
  detected_name: z.string().trim().min(1).max(120),
  external_ref_masked: z.string().trim().min(1).max(64),
  account_type: AccountTypeSchema,
  currency: CurrencySchema,
  opening_balance_cents: CentsSchema.nullable().optional(),
  closing_balance_cents: CentsSchema,
});
export type GeminiExtractedAccount = z.infer<typeof GeminiExtractedAccountSchema>;

export const GeminiExtractedTransactionSchema = z.object({
  account_ref_masked: z.string().trim().min(1).max(64),
  currency: CurrencySchema,
  booking_date: CalendarIsoDateSchema,
  value_date: CalendarIsoDateSchema.nullable().optional(),
  raw_label: z.string().trim().min(1),
  clean_label: z.string().trim().min(1).max(255),
  amount_cents: CentsSchema.refine((v) => v !== 0, {
    message: 'Le montant en centimes ne peut pas être égal à 0',
  }),
  statement_fx_rate_micro: FxRateMicroSchema.nullable().optional(),
});
export type GeminiExtractedTransaction = z.infer<typeof GeminiExtractedTransactionSchema>;

export const GeminiStatementExtractionSchema = z.object({
  statement_period_start: CalendarIsoDateSchema,
  statement_period_end: CalendarIsoDateSchema,
  accounts: z.array(GeminiExtractedAccountSchema).min(1),
  transactions: z.array(GeminiExtractedTransactionSchema),
});
export type GeminiStatementExtraction = z.infer<typeof GeminiStatementExtractionSchema>;

export const CheckpointBatchRecordSchema = z.object({
  batchIndex: z.number().int().nonnegative(),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  extraction: GeminiStatementExtractionSchema,
});
export type CheckpointBatchRecord = z.infer<typeof CheckpointBatchRecordSchema>;

export const CheckpointPayloadEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('partial_batches'),
    totalBatches: z.number().int().positive(),
    completedBatches: z.array(CheckpointBatchRecordSchema),
  }),
  z.object({
    kind: z.literal('complete_statement'),
    statement: GeminiStatementExtractionSchema,
  }),
]);
export type CheckpointPayloadEnvelope = z.infer<typeof CheckpointPayloadEnvelopeSchema>;

// ============================================================================
// Gemini Client & 3-Model Fallback Extraction Engine
// ============================================================================

export type GeminiCallErrorCode = Extract<
  CheckpointErrorCode,
  'GEMINI_TIMEOUT' | 'GEMINI_SCHEMA_INVALID' | 'GEMINI_QUOTA_EXCEEDED'
>;

export interface GeminiGenerateRequest {
  readonly model: GeminiModelName;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export type GeminiModelResponse =
  | { readonly ok: true; readonly rawJsonText: string }
  | {
      readonly ok: false;
      readonly errorCode: GeminiCallErrorCode;
      readonly message: string;
    };

export interface GeminiModelClient {
  generateStructuredStatement(
    request: GeminiGenerateRequest,
  ): Promise<GeminiModelResponse>;
}

const GeminiRestApiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  text: z.string().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export function createHttpGeminiClient(options: {
  readonly apiKey: string;
  readonly fetchFn?: FetchLike | undefined;
}): GeminiModelClient {
  const fetchFn: FetchLike = options.fetchFn ?? globalThis.fetch;

  return {
    async generateStructuredStatement(
      request: GeminiGenerateRequest,
    ): Promise<GeminiModelResponse> {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`;

      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': options.apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
            },
          }),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError' || /timed?\s*out/iu.test(message))
        ) {
          return {
            ok: false,
            errorCode: 'GEMINI_TIMEOUT',
            message: `Timeout Gemini (${request.model}) : ${message}`,
          };
        }
        return {
          ok: false,
          errorCode: 'GEMINI_TIMEOUT',
          message: `Erreur réseau Gemini (${request.model}) : ${message}`,
        };
      }

      if (response.status === 429) {
        return {
          ok: false,
          errorCode: 'GEMINI_QUOTA_EXCEEDED',
          message: `Quota Gemini dépassé sur ${request.model} (HTTP 429).`,
        };
      }

      if (response.status === 504 || response.status === 408) {
        return {
          ok: false,
          errorCode: 'GEMINI_TIMEOUT',
          message: `Délai Gemini dépassé sur ${request.model} (HTTP ${response.status}).`,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          errorCode: 'GEMINI_SCHEMA_INVALID',
          message: `Erreur HTTP Gemini ${response.status} sur ${request.model}.`,
        };
      }

      let rawBody: unknown;
      try {
        rawBody = await response.json();
      } catch {
        return {
          ok: false,
          errorCode: 'GEMINI_SCHEMA_INVALID',
          message: `Réponse HTTP non-JSON reçue de ${request.model}.`,
        };
      }

      const envelope = GeminiRestApiResponseSchema.safeParse(rawBody);
      const rawText = envelope.success
        ? envelope.data.candidates?.[0]?.content?.parts?.[0]?.text
        : undefined;

      if (rawText === undefined || rawText.trim().length === 0) {
        return {
          ok: false,
          errorCode: 'GEMINI_SCHEMA_INVALID',
          message: `Aucun texte JSON structuré retourné par ${request.model}.`,
        };
      }

      return { ok: true, rawJsonText: rawText };
    },
  };
}

export function buildStatementExtractionPrompt(input: {
  readonly bank: Bank;
  readonly fileName: string;
  readonly inferredAccountType: AccountType;
  readonly inferredCurrency: Currency;
  readonly batch: PdfTextBatch;
}): string {
  return [
    'Tu es un extracteur comptable strict pour ClairFlux.',
    `Banque: ${input.bank}`,
    `Fichier: ${input.fileName}`,
    `Type de compte pressenti: ${input.inferredAccountType}`,
    `Devise pressentie: ${input.inferredCurrency}`,
    `Lot ${input.batch.batchIndex + 1}/${input.batch.totalBatches} (pages ${input.batch.pageStart}-${input.batch.pageEnd})`,
    'Retourne UNIQUEMENT un JSON valide respectant :',
    '- statement_period_start, statement_period_end (YYYY-MM-DD)',
    '- accounts: [{ detected_name, external_ref_masked, account_type, currency (EUR|USD), opening_balance_cents (entier), closing_balance_cents (entier) }]',
    '- transactions: [{ account_ref_masked, currency (EUR|USD), booking_date (YYYY-MM-DD), value_date (YYYY-MM-DD|null), raw_label, clean_label, amount_cents (entier signe non nul, jamais de float), statement_fx_rate_micro (entier positif|null) }]',
    'INTERDICTION ABSOLUE de retourner des nombres décimaux (floats) pour les montants.',
    '',
    input.batch.text,
  ].join('\n');
}

export interface BatchExtractionResult {
  readonly extraction: GeminiStatementExtraction;
  readonly modelUsed: GeminiModelName;
  readonly attempts: ReadonlyArray<{
    readonly model: GeminiModelName;
    readonly errorCode?: GeminiCallErrorCode | undefined;
    readonly message?: string | undefined;
  }>;
}

export async function extractBatchWithFallback(input: {
  readonly client: GeminiModelClient;
  readonly bank: Bank;
  readonly fileName: string;
  readonly inferredAccountType: AccountType;
  readonly inferredCurrency: Currency;
  readonly batch: PdfTextBatch;
  readonly timeoutMs?: number | undefined;
}): Promise<BatchExtractionResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const prompt = buildStatementExtractionPrompt({
    bank: input.bank,
    fileName: input.fileName,
    inferredAccountType: input.inferredAccountType,
    inferredCurrency: input.inferredCurrency,
    batch: input.batch,
  });

  const attempts: Array<{
    readonly model: GeminiModelName;
    readonly errorCode?: GeminiCallErrorCode | undefined;
    readonly message?: string | undefined;
  }> = [];

  for (const model of GEMINI_FALLBACK_MODELS) {
    const response = await input.client.generateStructuredStatement({
      model,
      prompt,
      timeoutMs,
    });

    if (!response.ok) {
      attempts.push({
        model,
        errorCode: response.errorCode,
        message: response.message,
      });
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.rawJsonText);
    } catch {
      attempts.push({
        model,
        errorCode: 'GEMINI_SCHEMA_INVALID',
        message: `JSON invalide retourné par ${model}.`,
      });
      continue;
    }

    const validated = GeminiStatementExtractionSchema.safeParse(parsedJson);
    if (!validated.success) {
      const firstIssue = validated.error.issues[0];
      attempts.push({
        model,
        errorCode: 'GEMINI_SCHEMA_INVALID',
        message: `Validation Zod échouée (${model}) : ${firstIssue?.path.join('.') ?? 'root'} - ${firstIssue?.message ?? 'invalid'}`,
      });
      continue;
    }

    attempts.push({ model });
    return {
      extraction: validated.data,
      modelUsed: model,
      attempts,
    };
  }

  const lastAttempt = attempts[attempts.length - 1];
  const fallbackCode: GeminiCallErrorCode =
    lastAttempt?.errorCode ?? 'GEMINI_SCHEMA_INVALID';
  const summary = attempts
    .map((a) => `${a.model}: ${a.errorCode ?? 'ok'} (${a.message ?? ''})`)
    .join(' | ');

  throw new PipelineStepError(
    fallbackCode,
    `Échec d'extraction Gemini après fallback complet [${GEMINI_FALLBACK_MODELS.join(' -> ')}] : ${summary}`,
  );
}

export function mergeBatchExtractions(
  batchRecords: readonly CheckpointBatchRecord[],
): GeminiStatementExtraction {
  const sorted = [...batchRecords].sort((a, b) => a.batchIndex - b.batchIndex);
  const first = sorted[0];
  if (first === undefined) {
    throw new PipelineStepError(
      'GEMINI_SCHEMA_INVALID',
      'Aucun lot extrait à fusionner.',
    );
  }

  let periodStart = first.extraction.statement_period_start;
  let periodEnd = first.extraction.statement_period_end;
  const accountByKey = new Map<string, GeminiExtractedAccount>();
  const allTransactions: GeminiExtractedTransaction[] = [];

  for (const record of sorted) {
    const ext = record.extraction;
    if (ext.statement_period_start < periodStart) {
      periodStart = ext.statement_period_start;
    }
    if (ext.statement_period_end > periodEnd) {
      periodEnd = ext.statement_period_end;
    }
    for (const account of ext.accounts) {
      const key = `${account.external_ref_masked}|${account.currency}`;
      const existing = accountByKey.get(key);
      if (existing === undefined) {
        accountByKey.set(key, account);
      } else {
        accountByKey.set(key, {
          ...existing,
          closing_balance_cents: account.closing_balance_cents,
          opening_balance_cents:
            existing.opening_balance_cents ?? account.opening_balance_cents,
        });
      }
    }
    allTransactions.push(...ext.transactions);
  }

  return GeminiStatementExtractionSchema.parse({
    statement_period_start: periodStart,
    statement_period_end: periodEnd,
    accounts: [...accountByKey.values()],
    transactions: allTransactions,
  });
}

// ============================================================================
// FX Rate Conversion & Date-Based Cache/Fallback (fx_rate_micro EUR <-> USD)
// ============================================================================

export interface FxRateLookupHit {
  readonly rateDate: string;
  readonly rateMicro: FxRateMicro;
  readonly source: FxSource;
}

export interface FxRateStore {
  getExactRate(
    rateDate: string,
    baseCurrency: Currency,
    quoteCurrency: Currency,
  ): Promise<{ readonly rateMicro: FxRateMicro; readonly source: FxSource } | null>;
  getNearestPriorRate(
    rateDate: string,
    baseCurrency: Currency,
    quoteCurrency: Currency,
    maxLookbackDays: number,
  ): Promise<FxRateLookupHit | null>;
  saveRate(entry: {
    readonly rateDate: string;
    readonly baseCurrency: Currency;
    readonly quoteCurrency: Currency;
    readonly rateMicro: FxRateMicro;
    readonly source: FxSource;
  }): Promise<void>;
}

export type ExternalFxRateFetcher = (
  rateDate: string,
  baseCurrency: Currency,
  quoteCurrency: Currency,
) => Promise<{ readonly rateDate: string; readonly rateMicro: FxRateMicro; readonly source: FxSource } | null>;

const MICRO_UNIT_NUMERATOR = 1_000_000_000_000n;

export function invertFxRateMicro(rateMicro: FxRateMicro): FxRateMicro {
  const divisor = BigInt(rateMicro);
  const quotient = MICRO_UNIT_NUMERATOR / divisor;
  const remainder = MICRO_UNIT_NUMERATOR % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const numeric = Number(rounded);
  return toFxRateMicro(Math.max(1, numeric));
}

/**
 * Converts integer cents between `EUR` and `USD` using `rateMicro` (where `rateMicro`
 * expresses `1 fromCurrency = rateMicro / 1_000_000 toCurrency`) without floats.
 */
export function convertAmountCents(
  amountCents: Cents,
  fromCurrency: Currency,
  toCurrency: Currency,
  rateMicro: FxRateMicro,
): Cents {
  if (fromCurrency === toCurrency) {
    return amountCents;
  }
  return convertToEurCents(amountCents, rateMicro);
}

export interface FxRateService {
  resolveRateMicro(input: {
    readonly rateDate: string;
    readonly baseCurrency: Currency;
    readonly quoteCurrency: Currency;
    readonly statementFxRateMicro?: FxRateMicro | null | undefined;
  }): Promise<{ readonly rateMicro: FxRateMicro; readonly source: FxSource }>;
}

export function createFxRateService(options: {
  readonly store: FxRateStore;
  readonly fetchReferenceRate?: ExternalFxRateFetcher | undefined;
  readonly maxLookbackDays?: number | undefined;
}): FxRateService {
  const memoryCache = new Map<string, { readonly rateMicro: FxRateMicro; readonly source: FxSource }>();
  const maxLookbackDays = options.maxLookbackDays ?? 7;

  function cacheKey(dateStr: string, base: Currency, quote: Currency): string {
    return `${dateStr}|${base}|${quote}`;
  }

  function rememberBothDirections(
    dateStr: string,
    base: Currency,
    quote: Currency,
    rateMicro: FxRateMicro,
    source: FxSource,
  ): void {
    memoryCache.set(cacheKey(dateStr, base, quote), { rateMicro, source });
    memoryCache.set(cacheKey(dateStr, quote, base), {
      rateMicro: invertFxRateMicro(rateMicro),
      source,
    });
  }

  return {
    async resolveRateMicro(input): Promise<{
      readonly rateMicro: FxRateMicro;
      readonly source: FxSource;
    }> {
      const validDate = CalendarIsoDateSchema.parse(input.rateDate);

      if (input.baseCurrency === input.quoteCurrency) {
        return { rateMicro: EUR_FX_RATE_MICRO, source: 'revolut_statement' };
      }

      if (
        input.statementFxRateMicro !== undefined &&
        input.statementFxRateMicro !== null
      ) {
        rememberBothDirections(
          validDate,
          input.baseCurrency,
          input.quoteCurrency,
          input.statementFxRateMicro,
          'revolut_statement',
        );
        await options.store.saveRate({
          rateDate: validDate,
          baseCurrency: input.baseCurrency,
          quoteCurrency: input.quoteCurrency,
          rateMicro: input.statementFxRateMicro,
          source: 'revolut_statement',
        });
        return {
          rateMicro: input.statementFxRateMicro,
          source: 'revolut_statement',
        };
      }

      const cached = memoryCache.get(
        cacheKey(validDate, input.baseCurrency, input.quoteCurrency),
      );
      if (cached !== undefined) {
        return cached;
      }

      const exactDirect = await options.store.getExactRate(
        validDate,
        input.baseCurrency,
        input.quoteCurrency,
      );
      if (exactDirect !== null) {
        rememberBothDirections(
          validDate,
          input.baseCurrency,
          input.quoteCurrency,
          exactDirect.rateMicro,
          exactDirect.source,
        );
        return exactDirect;
      }

      const exactInverse = await options.store.getExactRate(
        validDate,
        input.quoteCurrency,
        input.baseCurrency,
      );
      if (exactInverse !== null) {
        const inverted = invertFxRateMicro(exactInverse.rateMicro);
        rememberBothDirections(
          validDate,
          input.baseCurrency,
          input.quoteCurrency,
          inverted,
          exactInverse.source,
        );
        return { rateMicro: inverted, source: exactInverse.source };
      }

      if (options.fetchReferenceRate !== undefined) {
        const fetched = await options.fetchReferenceRate(
          validDate,
          input.baseCurrency,
          input.quoteCurrency,
        );
        if (fetched !== null) {
          const resolvedSource: FxSource =
            fetched.rateDate === validDate ? fetched.source : 'nearest_business_day';
          rememberBothDirections(
            validDate,
            input.baseCurrency,
            input.quoteCurrency,
            fetched.rateMicro,
            resolvedSource,
          );
          await options.store.saveRate({
            rateDate: validDate,
            baseCurrency: input.baseCurrency,
            quoteCurrency: input.quoteCurrency,
            rateMicro: fetched.rateMicro,
            source: resolvedSource,
          });
          return { rateMicro: fetched.rateMicro, source: resolvedSource };
        }
      }

      const nearestDirect = await options.store.getNearestPriorRate(
        validDate,
        input.baseCurrency,
        input.quoteCurrency,
        maxLookbackDays,
      );
      if (nearestDirect !== null) {
        rememberBothDirections(
          validDate,
          input.baseCurrency,
          input.quoteCurrency,
          nearestDirect.rateMicro,
          'nearest_business_day',
        );
        await options.store.saveRate({
          rateDate: validDate,
          baseCurrency: input.baseCurrency,
          quoteCurrency: input.quoteCurrency,
          rateMicro: nearestDirect.rateMicro,
          source: 'nearest_business_day',
        });
        return {
          rateMicro: nearestDirect.rateMicro,
          source: 'nearest_business_day',
        };
      }

      const nearestInverse = await options.store.getNearestPriorRate(
        validDate,
        input.quoteCurrency,
        input.baseCurrency,
        maxLookbackDays,
      );
      if (nearestInverse !== null) {
        const inverted = invertFxRateMicro(nearestInverse.rateMicro);
        rememberBothDirections(
          validDate,
          input.baseCurrency,
          input.quoteCurrency,
          inverted,
          'nearest_business_day',
        );
        await options.store.saveRate({
          rateDate: validDate,
          baseCurrency: input.baseCurrency,
          quoteCurrency: input.quoteCurrency,
          rateMicro: inverted,
          source: 'nearest_business_day',
        });
        return { rateMicro: inverted, source: 'nearest_business_day' };
      }

      throw new Error(
        `Aucun taux FX disponible pour ${input.baseCurrency}/${input.quoteCurrency} à la date ${validDate} (fenêtre ${maxLookbackDays} jours).`,
      );
    },
  };
}

// ============================================================================
// Pure Dedup Hash, Categorization Rules & Internal Transfer / FX Matching
// ============================================================================

export function normalizeLabel(rawLabel: string): string {
  return rawLabel
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function computeDedupHash(input: {
  readonly accountId: string;
  readonly currency: Currency;
  readonly bookingDate: string;
  readonly amountCents: number;
  readonly rawLabel: string;
  readonly occurrenceIndex: number;
}): string {
  const normalizedLabel = normalizeLabel(input.rawLabel);
  if (normalizedLabel.length === 0) {
    throw new Error('rawLabel must not be blank after normalization');
  }
  const canonical = `${input.accountId}|${input.currency}|${input.bookingDate}|${input.amountCents}|${normalizedLabel}|${input.occurrenceIndex}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface ActiveRuleRecord {
  readonly id: string;
  readonly priority: number;
  readonly bankFilter: Bank | null;
  readonly accountIdFilter: string | null;
  readonly accountTypeFilter: AccountType | null;
  readonly pattern: string;
  readonly matchMode: RuleMatchMode;
  readonly targetCategory: string;
  readonly markAsInternalTransfer: boolean;
}

function matchesRulePattern(
  rule: ActiveRuleRecord,
  rawLabel: string,
  cleanLabel: string,
): boolean {
  const candidates = [normalizeLabel(rawLabel), normalizeLabel(cleanLabel)];
  const normalizedPattern = normalizeLabel(rule.pattern);

  switch (rule.matchMode) {
    case 'contains':
      return candidates.some((c) => c.includes(normalizedPattern));
    case 'starts_with':
      return candidates.some((c) => c.startsWith(normalizedPattern));
    case 'exact':
      return candidates.some((c) => c === normalizedPattern);
    case 'regex': {
      if (rule.pattern.length > MAX_REGEX_PATTERN_LENGTH) {
        return false;
      }
      try {
        const regex = new RegExp(rule.pattern, 'iu');
        return regex.test(rawLabel) || regex.test(cleanLabel);
      } catch {
        return false;
      }
    }
    default:
      return assertNever(rule.matchMode);
  }
}

export function evaluateCategorizationRules(input: {
  readonly rules: readonly ActiveRuleRecord[];
  readonly bank: Bank;
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly rawLabel: string;
  readonly cleanLabel: string;
}): {
  readonly category: string;
  readonly matchedRuleId: string | null;
  readonly isInternalTransfer: boolean;
} {
  for (const rule of input.rules) {
    if (rule.bankFilter !== null && rule.bankFilter !== input.bank) {
      continue;
    }
    if (rule.accountIdFilter !== null && rule.accountIdFilter !== input.accountId) {
      continue;
    }
    if (
      rule.accountTypeFilter !== null &&
      rule.accountTypeFilter !== input.accountType
    ) {
      continue;
    }
    if (matchesRulePattern(rule, input.rawLabel, input.cleanLabel)) {
      return {
        category: rule.targetCategory,
        matchedRuleId: rule.id,
        isInternalTransfer: rule.markAsInternalTransfer,
      };
    }
  }

  return {
    category: 'Non catégorisé',
    matchedRuleId: null,
    isInternalTransfer: false,
  };
}

export interface TransferCandidateRecord {
  readonly id: string;
  readonly accountId: string;
  readonly bank: Bank;
  readonly currency: Currency;
  readonly bookingDate: string;
  readonly amountCents: number;
  readonly amountEurCents: number;
  readonly rawLabel: string;
  readonly cleanLabel?: string | null | undefined;
  readonly transferGroupId: string | null;
  readonly isManualTransferOverride: boolean;
  readonly deletedAt: Date | null;
}

export interface MatchedTransferPairRecord {
  readonly debitTxId: string;
  readonly creditTxId: string;
  readonly kind: 'same_currency' | 'revolut_fx_exchange';
  readonly dateDeltaDays: number;
  readonly eurDeltaCents: number;
}

function calendarDaysApart(dateA: string, dateB: string): number {
  const msA = Date.parse(`${CalendarIsoDateSchema.parse(dateA)}T00:00:00.000Z`);
  const msB = Date.parse(`${CalendarIsoDateSchema.parse(dateB)}T00:00:00.000Z`);
  return Math.round(Math.abs(msA - msB) / MS_PER_DAY);
}

function isTransferEligible(tx: TransferCandidateRecord): boolean {
  return (
    tx.deletedAt === null &&
    tx.transferGroupId === null &&
    tx.isManualTransferOverride === false
  );
}

function hasFxLexicalHint(tx: TransferCandidateRecord): boolean {
  if (FX_EXCHANGE_HINT_PATTERN.test(normalizeLabel(tx.rawLabel))) {
    return true;
  }
  if (tx.cleanLabel !== undefined && tx.cleanLabel !== null) {
    return FX_EXCHANGE_HINT_PATTERN.test(normalizeLabel(tx.cleanLabel));
  }
  return false;
}

export function matchInternalTransferPairs(
  candidates: readonly TransferCandidateRecord[],
): readonly MatchedTransferPairRecord[] {
  interface ScoredPair {
    readonly i: number;
    readonly j: number;
    readonly debitTxId: string;
    readonly creditTxId: string;
    readonly kind: 'same_currency' | 'revolut_fx_exchange';
    readonly dateDeltaDays: number;
    readonly eurDeltaCents: number;
  }

  const scored: ScoredPair[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    if (a === undefined || !isTransferEligible(a)) {
      continue;
    }

    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      if (b === undefined || !isTransferEligible(b)) {
        continue;
      }

      if (a.accountId === b.accountId) {
        continue;
      }

      const oppositeSigns =
        (a.amountCents < 0 && b.amountCents > 0) ||
        (a.amountCents > 0 && b.amountCents < 0);
      if (!oppositeSigns) {
        continue;
      }

      const dateDeltaDays = calendarDaysApart(a.bookingDate, b.bookingDate);
      const debit = a.amountCents < 0 ? a : b;
      const credit = a.amountCents > 0 ? a : b;

      if (a.currency === b.currency) {
        if (
          a.amountCents === -b.amountCents &&
          dateDeltaDays <= SAME_CURRENCY_TRANSFER_MAX_DAYS
        ) {
          scored.push({
            i,
            j,
            debitTxId: debit.id,
            creditTxId: credit.id,
            kind: 'same_currency',
            dateDeltaDays,
            eurDeltaCents: Math.abs(a.amountEurCents + b.amountEurCents),
          });
        }
        continue;
      }

      // Case B: Revolut EUR <-> USD internal exchange
      if (a.bank !== 'revolut' || b.bank !== 'revolut') {
        continue;
      }
      if (dateDeltaDays > REVOLUT_FX_TRANSFER_MAX_DAYS) {
        continue;
      }
      if (!hasFxLexicalHint(a) && !hasFxLexicalHint(b)) {
        continue;
      }

      const maxAbsEur = Math.max(
        Math.abs(a.amountEurCents),
        Math.abs(b.amountEurCents),
      );
      const tolerance = Math.max(
        REVOLUT_FX_MIN_TOLERANCE_CENTS,
        Math.round(REVOLUT_FX_TOLERANCE_RATIO * maxAbsEur),
      );
      const eurDeltaCents = Math.abs(a.amountEurCents + b.amountEurCents);
      if (eurDeltaCents <= tolerance) {
        scored.push({
          i,
          j,
          debitTxId: debit.id,
          creditTxId: credit.id,
          kind: 'revolut_fx_exchange',
          dateDeltaDays,
          eurDeltaCents,
        });
      }
    }
  }

  scored.sort((left, right) => {
    if (left.dateDeltaDays !== right.dateDeltaDays) {
      return left.dateDeltaDays - right.dateDeltaDays;
    }
    if (left.eurDeltaCents !== right.eurDeltaCents) {
      return left.eurDeltaCents - right.eurDeltaCents;
    }
    if (left.i !== right.i) {
      return left.i - right.i;
    }
    return left.j - right.j;
  });

  const used = new Set<number>();
  const matched: MatchedTransferPairRecord[] = [];
  for (const pair of scored) {
    if (used.has(pair.i) || used.has(pair.j)) {
      continue;
    }
    used.add(pair.i);
    used.add(pair.j);
    matched.push({
      debitTxId: pair.debitTxId,
      creditTxId: pair.creditTxId,
      kind: pair.kind,
      dateDeltaDays: pair.dateDeltaDays,
      eurDeltaCents: pair.eurDeltaCents,
    });
  }

  return matched;
}

// ============================================================================
// Neon Drizzle Schema & CheckpointStore Contract
// ============================================================================

const bankEnum = pgEnum('bank_enum', ['boursobank', 'revolut']);
const accountTypeEnum = pgEnum('account_type_enum', [
  'courant',
  'epargne',
  'carte_differee',
  'multi_devises',
  'coffre',
  'autre',
]);
const currencyEnum = pgEnum('currency_enum', ['EUR', 'USD']);
const fxSourceEnum = pgEnum('fx_source_enum', [
  'revolut_statement',
  'ecb_reference',
  'nearest_business_day',
  'manual_override',
]);
const ruleMatchModeEnum = pgEnum('rule_match_mode_enum', [
  'contains',
  'starts_with',
  'exact',
  'regex',
]);
const syncTriggerEnum = pgEnum('sync_trigger_enum', ['manual']);
const syncRunStatusEnum = pgEnum('sync_run_status_enum', [
  'running',
  'completed',
  'partial_error',
  'failed',
]);
const checkpointStatusEnum = pgEnum('checkpoint_status_enum', [
  'pending',
  'skipped',
  'extracting',
  'parsed',
  'committing',
  'committed',
  'failed',
]);

const nextRevisionDefault = sql`nextval('sync_revision_seq')`;

export const accountsTable = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  bank: bankEnum('bank').notNull(),
  accountType: accountTypeEnum('account_type').notNull(),
  nickname: varchar('nickname', { length: 80 }).notNull(),
  detectedName: varchar('detected_name', { length: 120 }).notNull(),
  externalRefMasked: varchar('external_ref_masked', { length: 64 }).notNull(),
  currency: currencyEnum('currency').notNull(),
  currentBalanceCents: bigint('current_balance_cents', { mode: 'number' }).notNull().default(0),
  balanceUpdatedAt: timestamp('balance_updated_at', { withTimezone: true, mode: 'date' }),
  lastStatementClosingDate: date('last_statement_closing_date', { mode: 'string' }),
  isArchived: boolean('is_archived').notNull().default(false),
  revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});

export const fxRatesTable = pgTable('fx_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  rateDate: date('rate_date', { mode: 'string' }).notNull(),
  baseCurrency: currencyEnum('base_currency').notNull(),
  quoteCurrency: currencyEnum('quote_currency').notNull(),
  rateMicro: bigint('rate_micro', { mode: 'number' }).notNull(),
  source: fxSourceEnum('source').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const driveSyncRunsTable = pgTable('drive_sync_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggerMode: syncTriggerEnum('trigger_mode').notNull().default('manual'),
  status: syncRunStatusEnum('status').notNull().default('running'),
  totalFilesDiscovered: integer('total_files_discovered').notNull().default(0),
  filesSkippedUnchanged: integer('files_skipped_unchanged').notNull().default(0),
  filesCommitted: integer('files_committed').notNull().default(0),
  filesFailed: integer('files_failed').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  errorSummary: text('error_summary'),
  revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
});

export const driveFilesTable = pgTable('drive_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  driveFileId: varchar('drive_file_id', { length: 128 }).notNull(),
  driveFolderId: varchar('drive_folder_id', { length: 64 }).notNull(),
  bank: bankEnum('bank').notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  md5Checksum: varchar('md5_checksum', { length: 64 }).notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }).notNull(),
  driveModifiedTime: timestamp('drive_modified_time', { withTimezone: true, mode: 'date' }).notNull(),
  isMissingOnDrive: boolean('is_missing_on_drive').notNull().default(false),
  lastSeenInRunId: uuid('last_seen_in_run_id').notNull(),
  firstCommittedAt: timestamp('first_committed_at', { withTimezone: true, mode: 'date' }),
  revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const pdfIngestionCheckpointsTable = pgTable('pdf_ingestion_checkpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  driveFileRecordId: uuid('drive_file_record_id').notNull().unique(),
  lastRunId: uuid('last_run_id').notNull(),
  status: checkpointStatusEnum('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  totalPages: integer('total_pages'),
  parsedPayloadHash: varchar('parsed_payload_hash', { length: 64 }),
  parsedPayloadJson: jsonb('parsed_payload_json').$type<Record<string, unknown>>(),
  statementPeriodStart: date('statement_period_start', { mode: 'string' }),
  statementPeriodEnd: date('statement_period_end', { mode: 'string' }),
  detectedAccountsCount: integer('detected_accounts_count').notNull().default(0),
  insertedTxCount: integer('inserted_tx_count').notNull().default(0),
  dedupSkippedTxCount: integer('dedup_skipped_tx_count').notNull().default(0),
  errorCode: varchar('error_code', { length: 64 }).$type<CheckpointErrorCode>(),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
  committedAt: timestamp('committed_at', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const categorizationRulesTable = pgTable('categorization_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  priority: integer('priority').notNull().default(100),
  bankFilter: bankEnum('bank_filter'),
  accountIdFilter: uuid('account_id_filter'),
  accountTypeFilter: accountTypeEnum('account_type_filter'),
  pattern: varchar('pattern', { length: 200 }).notNull(),
  matchMode: ruleMatchModeEnum('match_mode').notNull().default('contains'),
  targetCategory: varchar('target_category', { length: 64 }).notNull(),
  markAsInternalTransfer: boolean('mark_as_internal_transfer').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});

export const transactionsTable = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull(),
  sourceDriveFileId: uuid('source_drive_file_id').notNull(),
  bookingDate: date('booking_date', { mode: 'string' }).notNull(),
  valueDate: date('value_date', { mode: 'string' }),
  rawLabel: text('raw_label').notNull(),
  cleanLabel: varchar('clean_label', { length: 255 }).notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  currency: currencyEnum('currency').notNull(),
  fxRateMicro: bigint('fx_rate_micro', { mode: 'number' }).notNull(),
  amountEurCents: bigint('amount_eur_cents', { mode: 'number' }).notNull(),
  category: varchar('category', { length: 64 }).notNull().default('Non catégorisé'),
  matchedRuleId: uuid('matched_rule_id'),
  isManualCategory: boolean('is_manual_category').notNull().default(false),
  isInternalTransfer: boolean('is_internal_transfer').notNull().default(false),
  isManualTransferOverride: boolean('is_manual_transfer_override').notNull().default(false),
  transferGroupId: uuid('transfer_group_id'),
  statementOccurrenceIndex: integer('statement_occurrence_index').notNull().default(1),
  dedupHash: varchar('dedup_hash', { length: 64 }).notNull().unique(),
  revision: bigint('revision', { mode: 'number' }).notNull().default(nextRevisionDefault),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});

const workerSchema = {
  accounts: accountsTable,
  fxRates: fxRatesTable,
  driveSyncRuns: driveSyncRunsTable,
  driveFiles: driveFilesTable,
  pdfIngestionCheckpoints: pdfIngestionCheckpointsTable,
  categorizationRules: categorizationRulesTable,
  transactions: transactionsTable,
} as const;

export interface CheckpointStateRecord {
  readonly checkpointId: string;
  readonly driveFileRecordId: string;
  readonly lastRunId: string;
  readonly status: CheckpointStatus;
  readonly attemptCount: number;
  readonly totalPages: number | null;
  readonly parsedPayloadHash: string | null;
  readonly parsedPayload: CheckpointPayloadEnvelope | null;
  readonly errorCode: CheckpointErrorCode | null;
  readonly errorMessage: string | null;
}

export interface FileCommitOutcome {
  readonly detectedAccountsCount: number;
  readonly insertedTxCount: number;
  readonly dedupSkippedTxCount: number;
  readonly matchedTransferPairsCount: number;
}

export interface ResolvedTransactionFx {
  readonly fxRateMicro: FxRateMicro;
  readonly amountEurCents: Cents;
  readonly fxSource: FxSource;
}

export interface CheckpointStore extends FxRateStore {
  ensureRun(runId?: string): Promise<{ readonly runId: string }>;
  reconcileOrphanedRuns?(reason: string): Promise<number>;
  finalizeRun(input: {
    readonly runId: string;
    readonly status: Exclude<SyncRunStatus, 'running'>;
    readonly totalFilesDiscovered: number;
    readonly filesSkippedUnchanged: number;
    readonly filesCommitted: number;
    readonly filesFailed: number;
    readonly errorSummary: string | null;
  }): Promise<void>;
  upsertDriveFileAndLoadCheckpoint(input: {
    readonly runId: string;
    readonly file: DiscoveredDrivePdf;
  }): Promise<CheckpointStateRecord>;
  markFileSkipped(input: {
    readonly checkpointId: string;
    readonly runId: string;
  }): Promise<void>;
  markFileExtracting(input: {
    readonly checkpointId: string;
    readonly runId: string;
    readonly totalPages?: number | undefined;
  }): Promise<void>;
  savePartialBatch(input: {
    readonly checkpointId: string;
    readonly totalPages: number;
    readonly totalBatches: number;
    readonly batchRecord: CheckpointBatchRecord;
  }): Promise<void>;
  markFileParsed(input: {
    readonly checkpointId: string;
    readonly totalPages: number;
    readonly statement: GeminiStatementExtraction;
    readonly payloadHash: string;
  }): Promise<void>;
  markFileFailed(input: {
    readonly checkpointId: string;
    readonly runId: string;
    readonly errorCode: CheckpointErrorCode;
    readonly errorMessage: string;
  }): Promise<void>;
  commitParsedStatement(input: {
    readonly checkpointId: string;
    readonly driveFileRecordId: string;
    readonly bank: Bank;
    readonly statement: GeminiStatementExtraction;
    readonly fxByTxIndex: ReadonlyMap<number, ResolvedTransactionFx>;
  }): Promise<FileCommitOutcome>;
}

function parseEnvelopeSafely(
  rawJson: Record<string, unknown> | null,
): CheckpointPayloadEnvelope | null {
  if (rawJson === null) {
    return null;
  }
  const parsed = CheckpointPayloadEnvelopeSchema.safeParse(rawJson);
  return parsed.success ? parsed.data : null;
}

export function computeStatementPayloadHash(
  statement: GeminiStatementExtraction,
): string {
  return createHash('sha256')
    .update(JSON.stringify(statement), 'utf8')
    .digest('hex');
}

// ============================================================================
// Neon PostgreSQL + Drizzle Implementation of CheckpointStore
// ============================================================================

export class NeonCheckpointStore implements CheckpointStore {
  private readonly httpDb: NeonHttpDatabase<typeof workerSchema>;
  private readonly poolDb: NeonDatabase<typeof workerSchema>;
  private readonly pool: Pool;

  public constructor(databaseUrl: string) {
    const validatedUrl = NeonDatabaseUrlSchema.parse(databaseUrl);
    const sqlClient = neon(validatedUrl);
    this.httpDb = drizzleHttp(sqlClient, { schema: workerSchema });
    this.pool = new Pool({ connectionString: validatedUrl });
    this.poolDb = drizzleServerless(this.pool, { schema: workerSchema });
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async ensureRun(runId?: string): Promise<{ readonly runId: string }> {
    const targetId = runId ?? randomUUID();
    const existing = await this.httpDb
      .select({ id: driveSyncRunsTable.id })
      .from(driveSyncRunsTable)
      .where(eq(driveSyncRunsTable.id, targetId))
      .limit(1);

    if (existing[0] !== undefined) {
      return { runId: existing[0].id };
    }

    const inserted = await this.httpDb
      .insert(driveSyncRunsTable)
      .values({
        id: targetId,
        triggerMode: 'manual',
        status: 'running',
      })
      .returning({ id: driveSyncRunsTable.id });

    const created = inserted[0];
    if (created === undefined) {
      throw new Error('Impossible de créer la ligne drive_sync_runs dans Neon.');
    }
    return { runId: created.id };
  }

  public async finalizeRun(input: {
    readonly runId: string;
    readonly status: Exclude<SyncRunStatus, 'running'>;
    readonly totalFilesDiscovered: number;
    readonly filesSkippedUnchanged: number;
    readonly filesCommitted: number;
    readonly filesFailed: number;
    readonly errorSummary: string | null;
  }): Promise<void> {
    await this.httpDb
      .update(driveSyncRunsTable)
      .set({
        status: input.status,
        totalFilesDiscovered: input.totalFilesDiscovered,
        filesSkippedUnchanged: input.filesSkippedUnchanged,
        filesCommitted: input.filesCommitted,
        filesFailed: input.filesFailed,
        finishedAt: new Date(),
        errorSummary: input.errorSummary,
        revision: sql`nextval('sync_revision_seq')`,
      })
      .where(eq(driveSyncRunsTable.id, input.runId));
  }

  public async reconcileOrphanedRuns(reason: string): Promise<number> {
    const updated = await this.httpDb
      .update(driveSyncRunsTable)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorSummary: reason,
        revision: sql`nextval('sync_revision_seq')`,
      })
      .where(eq(driveSyncRunsTable.status, 'running'))
      .returning({ id: driveSyncRunsTable.id });
    return updated.length;
  }

  public async getExactRate(
    rateDate: string,
    baseCurrency: Currency,
    quoteCurrency: Currency,
  ): Promise<{ readonly rateMicro: FxRateMicro; readonly source: FxSource } | null> {
    const rows = await this.httpDb
      .select({
        rateMicro: fxRatesTable.rateMicro,
        source: fxRatesTable.source,
      })
      .from(fxRatesTable)
      .where(
        and(
          eq(fxRatesTable.rateDate, rateDate),
          eq(fxRatesTable.baseCurrency, baseCurrency),
          eq(fxRatesTable.quoteCurrency, quoteCurrency),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      rateMicro: toFxRateMicro(row.rateMicro),
      source: FxSourceSchema.parse(row.source),
    };
  }

  public async getNearestPriorRate(
    rateDate: string,
    baseCurrency: Currency,
    quoteCurrency: Currency,
    maxLookbackDays: number,
  ): Promise<FxRateLookupHit | null> {
    const targetMs = Date.parse(`${rateDate}T00:00:00.000Z`);
    const minDate = new Date(targetMs - maxLookbackDays * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);

    const rows = await this.httpDb
      .select({
        rateDate: fxRatesTable.rateDate,
        rateMicro: fxRatesTable.rateMicro,
        source: fxRatesTable.source,
      })
      .from(fxRatesTable)
      .where(
        and(
          eq(fxRatesTable.baseCurrency, baseCurrency),
          eq(fxRatesTable.quoteCurrency, quoteCurrency),
          lte(fxRatesTable.rateDate, rateDate),
          sql`${fxRatesTable.rateDate} >= ${minDate}`,
        ),
      )
      .orderBy(desc(fxRatesTable.rateDate))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      rateDate: row.rateDate,
      rateMicro: toFxRateMicro(row.rateMicro),
      source: FxSourceSchema.parse(row.source),
    };
  }

  public async saveRate(entry: {
    readonly rateDate: string;
    readonly baseCurrency: Currency;
    readonly quoteCurrency: Currency;
    readonly rateMicro: FxRateMicro;
    readonly source: FxSource;
  }): Promise<void> {
    await this.httpDb
      .insert(fxRatesTable)
      .values({
        rateDate: entry.rateDate,
        baseCurrency: entry.baseCurrency,
        quoteCurrency: entry.quoteCurrency,
        rateMicro: entry.rateMicro,
        source: entry.source,
      })
      .onConflictDoNothing();
  }

  public async upsertDriveFileAndLoadCheckpoint(input: {
    readonly runId: string;
    readonly file: DiscoveredDrivePdf;
  }): Promise<CheckpointStateRecord> {
    assertAllowedDriveFolderId(input.file.driveFolderId);

    return this.poolDb.transaction(async (tx) => {
      const fileRows = await tx
        .insert(driveFilesTable)
        .values({
          driveFileId: input.file.driveFileId,
          driveFolderId: input.file.driveFolderId,
          bank: input.file.bank,
          fileName: input.file.fileName,
          md5Checksum: input.file.md5Checksum,
          fileSizeBytes: input.file.fileSizeBytes,
          driveModifiedTime: input.file.driveModifiedTime,
          isMissingOnDrive: false,
          lastSeenInRunId: input.runId,
        })
        .onConflictDoUpdate({
          target: [driveFilesTable.driveFileId, driveFilesTable.md5Checksum],
          set: {
            fileName: input.file.fileName,
            fileSizeBytes: input.file.fileSizeBytes,
            driveModifiedTime: input.file.driveModifiedTime,
            isMissingOnDrive: false,
            lastSeenInRunId: input.runId,
            updatedAt: new Date(),
          },
        })
        .returning({ id: driveFilesTable.id });

      const driveFileRecord = fileRows[0];
      if (driveFileRecord === undefined) {
        throw new Error('Échec upsert drive_files.');
      }

      await tx
        .insert(pdfIngestionCheckpointsTable)
        .values({
          driveFileRecordId: driveFileRecord.id,
          lastRunId: input.runId,
          status: 'pending',
          attemptCount: 0,
        })
        .onConflictDoNothing();

      const checkpointRows = await tx
        .select()
        .from(pdfIngestionCheckpointsTable)
        .where(eq(pdfIngestionCheckpointsTable.driveFileRecordId, driveFileRecord.id))
        .limit(1);

      const cp = checkpointRows[0];
      if (cp === undefined) {
        throw new Error('Checkpoint introuvable après insertion.');
      }

      return {
        checkpointId: cp.id,
        driveFileRecordId: cp.driveFileRecordId,
        lastRunId: cp.lastRunId,
        status: cp.status,
        attemptCount: cp.attemptCount,
        totalPages: cp.totalPages,
        parsedPayloadHash: cp.parsedPayloadHash,
        parsedPayload: parseEnvelopeSafely(cp.parsedPayloadJson),
        errorCode:
          cp.errorCode !== null
            ? CheckpointErrorCodeSchema.parse(cp.errorCode)
            : null,
        errorMessage: cp.errorMessage,
      };
    });
  }

  public async markFileSkipped(input: {
    readonly checkpointId: string;
    readonly runId: string;
  }): Promise<void> {
    await this.httpDb
      .update(pdfIngestionCheckpointsTable)
      .set({
        lastRunId: input.runId,
        updatedAt: new Date(),
      })
      .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId));
  }

  public async markFileExtracting(input: {
    readonly checkpointId: string;
    readonly runId: string;
    readonly totalPages?: number | undefined;
  }): Promise<void> {
    const now = new Date();
    await this.httpDb
      .update(pdfIngestionCheckpointsTable)
      .set({
        lastRunId: input.runId,
        status: 'extracting',
        attemptCount: sql`${pdfIngestionCheckpointsTable.attemptCount} + 1`,
        ...(input.totalPages !== undefined ? { totalPages: input.totalPages } : {}),
        errorCode: null,
        errorMessage: null,
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId));
  }

  public async savePartialBatch(input: {
    readonly checkpointId: string;
    readonly totalPages: number;
    readonly totalBatches: number;
    readonly batchRecord: CheckpointBatchRecord;
  }): Promise<void> {
    await this.poolDb.transaction(async (tx) => {
      const existingRows = await tx
        .select({ parsedPayloadJson: pdfIngestionCheckpointsTable.parsedPayloadJson })
        .from(pdfIngestionCheckpointsTable)
        .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId))
        .limit(1);

      const existingEnvelope = parseEnvelopeSafely(
        existingRows[0]?.parsedPayloadJson ?? null,
      );
      const priorBatches: CheckpointBatchRecord[] =
        existingEnvelope?.kind === 'partial_batches' &&
        existingEnvelope.totalBatches === input.totalBatches
          ? existingEnvelope.completedBatches.filter(
              (b) => b.batchIndex !== input.batchRecord.batchIndex,
            )
          : [];

      const nextEnvelope: CheckpointPayloadEnvelope = {
        kind: 'partial_batches',
        totalBatches: input.totalBatches,
        completedBatches: [...priorBatches, input.batchRecord].sort(
          (a, b) => a.batchIndex - b.batchIndex,
        ),
      };

      await tx
        .update(pdfIngestionCheckpointsTable)
        .set({
          totalPages: input.totalPages,
          parsedPayloadJson: nextEnvelope,
          updatedAt: new Date(),
        })
        .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId));
    });
  }

  public async markFileParsed(input: {
    readonly checkpointId: string;
    readonly totalPages: number;
    readonly statement: GeminiStatementExtraction;
    readonly payloadHash: string;
  }): Promise<void> {
    const envelope: CheckpointPayloadEnvelope = {
      kind: 'complete_statement',
      statement: input.statement,
    };
    await this.httpDb
      .update(pdfIngestionCheckpointsTable)
      .set({
        status: 'parsed',
        totalPages: input.totalPages,
        parsedPayloadHash: input.payloadHash,
        parsedPayloadJson: envelope,
        statementPeriodStart: input.statement.statement_period_start,
        statementPeriodEnd: input.statement.statement_period_end,
        detectedAccountsCount: input.statement.accounts.length,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId));
  }

  public async markFileFailed(input: {
    readonly checkpointId: string;
    readonly runId: string;
    readonly errorCode: CheckpointErrorCode;
    readonly errorMessage: string;
  }): Promise<void> {
    await this.httpDb
      .update(pdfIngestionCheckpointsTable)
      .set({
        lastRunId: input.runId,
        status: 'failed',
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId));
  }

  public async commitParsedStatement(input: {
    readonly checkpointId: string;
    readonly driveFileRecordId: string;
    readonly bank: Bank;
    readonly statement: GeminiStatementExtraction;
    readonly fxByTxIndex: ReadonlyMap<number, ResolvedTransactionFx>;
  }): Promise<FileCommitOutcome> {
    return this.poolDb.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(pdfIngestionCheckpointsTable)
        .set({ status: 'committing', updatedAt: now })
        .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId));

      const accountMap = new Map<
        string,
        { readonly id: string; readonly accountType: AccountType }
      >();

      for (const acct of input.statement.accounts) {
        const defaultNickname = `${acct.detected_name.slice(0, 60)}`.trim();
        const upsertedAccounts = await tx
          .insert(accountsTable)
          .values({
            bank: input.bank,
            accountType: acct.account_type,
            nickname: defaultNickname,
            detectedName: acct.detected_name,
            externalRefMasked: acct.external_ref_masked,
            currency: acct.currency,
            currentBalanceCents: acct.closing_balance_cents,
            balanceUpdatedAt: now,
            lastStatementClosingDate: input.statement.statement_period_end,
          })
          .onConflictDoUpdate({
            target: [
              accountsTable.bank,
              accountsTable.externalRefMasked,
              accountsTable.currency,
            ],
            set: {
              detectedName: acct.detected_name,
              accountType: acct.account_type,
              currentBalanceCents: sql`CASE WHEN ${input.statement.statement_period_end} >= COALESCE(${accountsTable.lastStatementClosingDate}, '1900-01-01') THEN ${acct.closing_balance_cents} ELSE ${accountsTable.currentBalanceCents} END`,
              balanceUpdatedAt: sql`CASE WHEN ${input.statement.statement_period_end} >= COALESCE(${accountsTable.lastStatementClosingDate}, '1900-01-01') THEN ${now} ELSE ${accountsTable.balanceUpdatedAt} END`,
              lastStatementClosingDate: sql`CASE WHEN ${input.statement.statement_period_end} >= COALESCE(${accountsTable.lastStatementClosingDate}, '1900-01-01') THEN ${input.statement.statement_period_end} ELSE ${accountsTable.lastStatementClosingDate} END`,
              revision: sql`nextval('sync_revision_seq')`,
              updatedAt: now,
            },
          })
          .returning({
            id: accountsTable.id,
            accountType: accountsTable.accountType,
          });

        const savedAccount = upsertedAccounts[0];
        if (savedAccount === undefined) {
          throw new Error(`Échec upsert du compte ${acct.external_ref_masked}.`);
        }
        accountMap.set(
          `${acct.external_ref_masked}|${acct.currency}`,
          {
            id: savedAccount.id,
            accountType: AccountTypeSchema.parse(savedAccount.accountType),
          },
        );
      }

      const rawRules = await tx
        .select()
        .from(categorizationRulesTable)
        .where(
          and(
            eq(categorizationRulesTable.isActive, true),
            isNull(categorizationRulesTable.deletedAt),
          ),
        )
        .orderBy(
          asc(categorizationRulesTable.priority),
          asc(categorizationRulesTable.createdAt),
          asc(categorizationRulesTable.id),
        );

      const activeRules: ActiveRuleRecord[] = rawRules.map((r) => ({
        id: r.id,
        priority: r.priority,
        bankFilter: r.bankFilter !== null ? BankSchema.parse(r.bankFilter) : null,
        accountIdFilter: r.accountIdFilter,
        accountTypeFilter:
          r.accountTypeFilter !== null
            ? AccountTypeSchema.parse(r.accountTypeFilter)
            : null,
        pattern: r.pattern,
        matchMode: RuleMatchModeSchema.parse(r.matchMode),
        targetCategory: r.targetCategory,
        markAsInternalTransfer: r.markAsInternalTransfer,
      }));

      const occurrenceCounters = new Map<string, number>();
      let insertedTxCount = 0;
      let dedupSkippedTxCount = 0;

      for (let i = 0; i < input.statement.transactions.length; i += 1) {
        const entry = input.statement.transactions[i];
        if (entry === undefined) {
          continue;
        }
        const resolvedAccount = accountMap.get(
          `${entry.account_ref_masked}|${entry.currency}`,
        );
        if (resolvedAccount === undefined) {
          throw new PipelineStepError(
            'GEMINI_SCHEMA_INVALID',
            `Transaction référençant un compte absent du relevé : ${entry.account_ref_masked} (${entry.currency}).`,
          );
        }

        const fx = input.fxByTxIndex.get(i);
        if (fx === undefined) {
          throw new Error(`Taux FX manquant pour la transaction d'index ${i}.`);
        }

        const normalizedLabel = normalizeLabel(entry.raw_label);
        const bucketKey = `${resolvedAccount.id}|${entry.currency}|${entry.booking_date}|${entry.amount_cents}|${normalizedLabel}`;
        const occurrenceIndex = (occurrenceCounters.get(bucketKey) ?? 0) + 1;
        occurrenceCounters.set(bucketKey, occurrenceIndex);

        const dedupHash = computeDedupHash({
          accountId: resolvedAccount.id,
          currency: entry.currency,
          bookingDate: entry.booking_date,
          amountCents: entry.amount_cents,
          rawLabel: entry.raw_label,
          occurrenceIndex,
        });

        const ruleMatch = evaluateCategorizationRules({
          rules: activeRules,
          bank: input.bank,
          accountId: resolvedAccount.id,
          accountType: resolvedAccount.accountType,
          rawLabel: entry.raw_label,
          cleanLabel: entry.clean_label,
        });

        const inserted = await tx
          .insert(transactionsTable)
          .values({
            accountId: resolvedAccount.id,
            sourceDriveFileId: input.driveFileRecordId,
            bookingDate: entry.booking_date,
            valueDate: entry.value_date ?? null,
            rawLabel: entry.raw_label,
            cleanLabel: entry.clean_label,
            amountCents: entry.amount_cents,
            currency: entry.currency,
            fxRateMicro: fx.fxRateMicro,
            amountEurCents: fx.amountEurCents,
            category: ruleMatch.category,
            matchedRuleId: ruleMatch.matchedRuleId,
            isManualCategory: false,
            isInternalTransfer: ruleMatch.isInternalTransfer,
            isManualTransferOverride: false,
            transferGroupId: null,
            statementOccurrenceIndex: occurrenceIndex,
            dedupHash,
          })
          .onConflictDoNothing({ target: transactionsTable.dedupHash })
          .returning({ id: transactionsTable.id });

        if (inserted.length > 0) {
          insertedTxCount += 1;
        } else {
          dedupSkippedTxCount += 1;
        }
      }

      // Reconcile internal transfers & Revolut EUR <-> USD currency exchanges
      const candidateRows = await tx
        .select({
          id: transactionsTable.id,
          accountId: transactionsTable.accountId,
          bank: accountsTable.bank,
          currency: transactionsTable.currency,
          bookingDate: transactionsTable.bookingDate,
          amountCents: transactionsTable.amountCents,
          amountEurCents: transactionsTable.amountEurCents,
          rawLabel: transactionsTable.rawLabel,
          cleanLabel: transactionsTable.cleanLabel,
          transferGroupId: transactionsTable.transferGroupId,
          isManualTransferOverride: transactionsTable.isManualTransferOverride,
          deletedAt: transactionsTable.deletedAt,
        })
        .from(transactionsTable)
        .innerJoin(accountsTable, eq(transactionsTable.accountId, accountsTable.id))
        .where(
          and(
            isNull(transactionsTable.deletedAt),
            isNull(transactionsTable.transferGroupId),
            eq(transactionsTable.isManualTransferOverride, false),
          ),
        );

      const pairs = matchInternalTransferPairs(
        candidateRows.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          bank: BankSchema.parse(row.bank),
          currency: CurrencySchema.parse(row.currency),
          bookingDate: row.bookingDate,
          amountCents: row.amountCents,
          amountEurCents: row.amountEurCents,
          rawLabel: row.rawLabel,
          cleanLabel: row.cleanLabel,
          transferGroupId: row.transferGroupId,
          isManualTransferOverride: row.isManualTransferOverride,
          deletedAt: row.deletedAt,
        })),
      );

      for (const pair of pairs) {
        const groupId = randomUUID();
        for (const txId of [pair.debitTxId, pair.creditTxId]) {
          await tx
            .update(transactionsTable)
            .set({
              transferGroupId: groupId,
              isInternalTransfer: true,
              category: sql`CASE WHEN ${transactionsTable.isManualCategory} THEN ${transactionsTable.category} ELSE 'Transfert interne' END`,
              matchedRuleId: sql`CASE WHEN ${transactionsTable.isManualCategory} THEN ${transactionsTable.matchedRuleId} ELSE NULL END`,
              revision: sql`nextval('sync_revision_seq')`,
              updatedAt: now,
            })
            .where(eq(transactionsTable.id, txId));
        }
      }

      await tx
        .update(pdfIngestionCheckpointsTable)
        .set({
          status: 'committed',
          committedAt: now,
          parsedPayloadJson: null,
          statementPeriodStart: input.statement.statement_period_start,
          statementPeriodEnd: input.statement.statement_period_end,
          detectedAccountsCount: accountMap.size,
          insertedTxCount,
          dedupSkippedTxCount,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(pdfIngestionCheckpointsTable.id, input.checkpointId));

      await tx
        .update(driveFilesTable)
        .set({
          firstCommittedAt: sql`COALESCE(${driveFilesTable.firstCommittedAt}, ${now})`,
          revision: sql`nextval('sync_revision_seq')`,
          updatedAt: now,
        })
        .where(eq(driveFilesTable.id, input.driveFileRecordId));

      return {
        detectedAccountsCount: accountMap.size,
        insertedTxCount,
        dedupSkippedTxCount,
        matchedTransferPairsCount: pairs.length,
      };
    });
  }
}

// ============================================================================
// Pipeline Orchestrator (Checkpoint Resume per File & Batch, Zero Duplicate)
// ============================================================================

export interface SyncRunFileResult {
  readonly driveFileId: string;
  readonly fileName: string;
  readonly status: 'committed' | 'skipped' | 'failed';
  readonly insertedTxCount: number;
  readonly dedupSkippedTxCount: number;
  readonly errorCode: CheckpointErrorCode | null;
  readonly errorMessage: string | null;
}

export interface SyncRunResult {
  readonly runId: string;
  readonly status: Exclude<SyncRunStatus, 'running'>;
  readonly totalFilesDiscovered: number;
  readonly filesSkippedUnchanged: number;
  readonly filesCommitted: number;
  readonly filesFailed: number;
  readonly fileResults: readonly SyncRunFileResult[];
}

export interface IngestionPipelineDependencies {
  readonly driveClient: GoogleDriveClient;
  readonly geminiClient: GeminiModelClient;
  readonly checkpointStore: CheckpointStore;
  readonly fxRateService: FxRateService;
  readonly extractPdfPages?: PdfTextExtractor | undefined;
  readonly geminiTimeoutMs?: number | undefined;
}

async function resolveTransactionsFx(
  statement: GeminiStatementExtraction,
  fxRateService: FxRateService,
): Promise<ReadonlyMap<number, ResolvedTransactionFx>> {
  const result = new Map<number, ResolvedTransactionFx>();
  for (let i = 0; i < statement.transactions.length; i += 1) {
    const tx = statement.transactions[i];
    if (tx === undefined) {
      continue;
    }
    if (tx.currency === 'EUR') {
      result.set(i, {
        fxRateMicro: EUR_FX_RATE_MICRO,
        amountEurCents: toCents(tx.amount_cents),
        fxSource: 'revolut_statement',
      });
      continue;
    }
    const resolved = await fxRateService.resolveRateMicro({
      rateDate: tx.booking_date,
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      statementFxRateMicro: tx.statement_fx_rate_micro ?? null,
    });
    const eurCents = convertAmountCents(
      toCents(tx.amount_cents),
      'USD',
      'EUR',
      resolved.rateMicro,
    );
    result.set(i, {
      fxRateMicro: resolved.rateMicro,
      amountEurCents: eurCents,
      fxSource: resolved.source,
    });
  }
  return result;
}

export async function runIngestionPipeline(
  deps: IngestionPipelineDependencies,
  options?: {
    readonly runId?: string | undefined;
    readonly targetDriveFileId?: string | undefined;
  },
): Promise<SyncRunResult> {
  const { runId } = await deps.checkpointStore.ensureRun(options?.runId);

  let totalFilesDiscovered = 0;
  let filesSkippedUnchanged = 0;
  let filesCommitted = 0;
  let filesFailed = 0;
  const fileResults: SyncRunFileResult[] = [];

  try {
    const discovered = await deps.driveClient.discoverAllAllowedPdfs();

    const filesToProcess =
      options?.targetDriveFileId !== undefined
        ? discovered.filter((f) => f.driveFileId === options.targetDriveFileId)
        : discovered;
    totalFilesDiscovered = filesToProcess.length;

    for (const file of filesToProcess) {
      assertAllowedDriveFolderId(file.driveFolderId);

      const checkpoint =
        await deps.checkpointStore.upsertDriveFileAndLoadCheckpoint({
          runId,
          file,
        });

      if (checkpoint.status === 'committed') {
        await deps.checkpointStore.markFileSkipped({
          checkpointId: checkpoint.checkpointId,
          runId,
        });
        filesSkippedUnchanged += 1;
        fileResults.push({
          driveFileId: file.driveFileId,
          fileName: file.fileName,
          status: 'skipped',
          insertedTxCount: 0,
          dedupSkippedTxCount: 0,
          errorCode: null,
          errorMessage: null,
        });
        continue;
      }

      try {
        let statementToCommit: GeminiStatementExtraction;

        // Exact resume from already-parsed statement (e.g., DB failure during Phase 2 commit)
        if (checkpoint.parsedPayload?.kind === 'complete_statement') {
          statementToCommit = checkpoint.parsedPayload.statement;
        } else {
          await deps.checkpointStore.markFileExtracting({
            checkpointId: checkpoint.checkpointId,
            runId,
          });

          const pdfBytes = await deps.driveClient.downloadPdfFile({
            driveFileId: file.driveFileId,
            driveFolderId: file.driveFolderId,
          });

          const prepared = await prepareDrivePdfBatches({
            file,
            pdfBytes,
            extractPdfPages: deps.extractPdfPages,
          });

          const existingCompletedBatches =
            checkpoint.parsedPayload?.kind === 'partial_batches' &&
            checkpoint.parsedPayload.totalBatches === prepared.batches.length
              ? checkpoint.parsedPayload.completedBatches
              : [];

          const batchMap = new Map<number, CheckpointBatchRecord>();
          for (const prior of existingCompletedBatches) {
            batchMap.set(prior.batchIndex, prior);
          }

          for (const batch of prepared.batches) {
            if (batchMap.has(batch.batchIndex)) {
              continue;
            }

            const batchExtraction = await extractBatchWithFallback({
              client: deps.geminiClient,
              bank: file.bank,
              fileName: file.fileName,
              inferredAccountType: prepared.metadata.accountType,
              inferredCurrency: prepared.metadata.currency,
              batch,
              timeoutMs: deps.geminiTimeoutMs,
            });

            const batchRecord: CheckpointBatchRecord = {
              batchIndex: batch.batchIndex,
              pageStart: batch.pageStart,
              pageEnd: batch.pageEnd,
              extraction: batchExtraction.extraction,
            };

            batchMap.set(batch.batchIndex, batchRecord);
            await deps.checkpointStore.savePartialBatch({
              checkpointId: checkpoint.checkpointId,
              totalPages: prepared.totalPages,
              totalBatches: prepared.batches.length,
              batchRecord,
            });
          }

          statementToCommit = mergeBatchExtractions([...batchMap.values()]);
          const payloadHash = computeStatementPayloadHash(statementToCommit);

          await deps.checkpointStore.markFileParsed({
            checkpointId: checkpoint.checkpointId,
            totalPages: prepared.totalPages,
            statement: statementToCommit,
            payloadHash,
          });
        }

        const fxByTxIndex = await resolveTransactionsFx(
          statementToCommit,
          deps.fxRateService,
        );

        const commitOutcome = await deps.checkpointStore.commitParsedStatement({
          checkpointId: checkpoint.checkpointId,
          driveFileRecordId: checkpoint.driveFileRecordId,
          bank: file.bank,
          statement: statementToCommit,
          fxByTxIndex,
        });

        filesCommitted += 1;
        fileResults.push({
          driveFileId: file.driveFileId,
          fileName: file.fileName,
          status: 'committed',
          insertedTxCount: commitOutcome.insertedTxCount,
          dedupSkippedTxCount: commitOutcome.dedupSkippedTxCount,
          errorCode: null,
          errorMessage: null,
        });
      } catch (err) {
        const mapped = mapUnknownToCheckpointError(err);
        await deps.checkpointStore.markFileFailed({
          checkpointId: checkpoint.checkpointId,
          runId,
          errorCode: mapped.code,
          errorMessage: mapped.message,
        });
        filesFailed += 1;
        fileResults.push({
          driveFileId: file.driveFileId,
          fileName: file.fileName,
          status: 'failed',
          insertedTxCount: 0,
          dedupSkippedTxCount: 0,
          errorCode: mapped.code,
          errorMessage: mapped.message,
        });
      }
    }

    let runStatus: Exclude<SyncRunStatus, 'running'>;
    if (filesFailed === 0) {
      runStatus = 'completed';
    } else if (filesCommitted > 0 || filesSkippedUnchanged > 0) {
      runStatus = 'partial_error';
    } else {
      runStatus = 'failed';
    }

    const errorSummary =
      filesFailed > 0
        ? `${filesFailed} fichier(s) PDF en échec lors de la synchronisation.`
        : null;

    await deps.checkpointStore.finalizeRun({
      runId,
      status: runStatus,
      totalFilesDiscovered,
      filesSkippedUnchanged,
      filesCommitted,
      filesFailed,
      errorSummary,
    });

    return {
      runId,
      status: runStatus,
      totalFilesDiscovered,
      filesSkippedUnchanged,
      filesCommitted,
      filesFailed,
      fileResults,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const errorSummary = rawMessage.trim().slice(0, 500) || 'Erreur interne lors de la synchronisation Drive/Gemini.';
    try {
      await deps.checkpointStore.finalizeRun({
        runId,
        status: 'failed',
        totalFilesDiscovered,
        filesSkippedUnchanged,
        filesCommitted,
        filesFailed,
        errorSummary,
      });
    } catch (finalizeErr) {
      console.error('[sync-worker] Impossible de finaliser le run en échec:', finalizeErr);
    }

    return {
      runId,
      status: 'failed',
      totalFilesDiscovered,
      filesSkippedUnchanged,
      filesCommitted,
      filesFailed,
      fileResults,
    };
  }
}

// ============================================================================
// Internal HTTP Server (createWorkerApp) & Graceful Shutdown Entrypoint
// ============================================================================

const InternalRunRequestSchema = z
  .object({
    run_id: z.string().uuid().optional(),
    drive_file_id: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type TriggerWorkerRunResult =
  | { readonly ok: true; readonly runId: string; readonly acceptedAt: string }
  | { readonly ok: false; readonly reason: 'already_running'; readonly activeRunId: string }
  | { readonly ok: false; readonly reason: 'upstream_error'; readonly message: string };

export interface WorkerAppDependencies {
  readonly internalWorkerToken: string;
  readonly now?: (() => Date) | undefined;
  readonly getActiveRunId?: (() => string | null) | undefined;
  readonly triggerSync: (input: {
    readonly runId?: string | undefined;
    readonly driveFileId?: string | undefined;
  }) => Promise<TriggerWorkerRunResult>;
}

function verifyInternalWorkerToken(provided: string, expected: string): boolean {
  if (provided.length === 0 || expected.length === 0) {
    return false;
  }
  const hmacKey = randomBytes(32);
  const providedDigest = createHmac('sha256', hmacKey)
    .update(provided, 'utf8')
    .digest();
  const expectedDigest = createHmac('sha256', hmacKey)
    .update(expected, 'utf8')
    .digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function extractInternalBearerToken(c: Context): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const token = match?.[1]?.trim();
    return token !== undefined && token.length > 0 ? token : null;
  }
  const customHeader = c.req.header('X-Internal-Worker-Token')?.trim();
  return customHeader !== undefined && customHeader.length > 0 ? customHeader : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorizedInternalRequest(c: Context, expectedToken: string): boolean {
  const providedToken = extractInternalBearerToken(c);
  return providedToken !== null && verifyInternalWorkerToken(providedToken, expectedToken);
}

export function createWorkerApp(deps: WorkerAppDependencies): Hono {
  const app = new Hono();
  const getNow = deps.now ?? (() => new Date());

  app.get('/healthz', (c) => {
    return c.json({ status: 'ok' as const, service: 'sync-worker' as const }, 200);
  });

  app.get('/internal/runs/active', (c) => {
    if (!isAuthorizedInternalRequest(c, deps.internalWorkerToken)) {
      return c.json(
        {
          error: {
            code: 'UNAUTHORIZED' as const,
            message: 'Jeton interne sync-worker absent ou invalide.',
          },
        },
        401,
      );
    }

    return c.json(
      {
        active_run_id: deps.getActiveRunId?.() ?? null,
      },
      200,
    );
  });

  app.post('/internal/runs', async (c) => {
    if (!isAuthorizedInternalRequest(c, deps.internalWorkerToken)) {
      return c.json(
        {
          error: {
            code: 'UNAUTHORIZED' as const,
            message: 'Jeton interne sync-worker absent ou invalide.',
          },
        },
        401,
      );
    }

    const rawText = await c.req.text();
    let parsedJson: unknown = {};
    if (rawText.trim().length > 0) {
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        return c.json(
          {
            error: {
              code: 'BAD_REQUEST' as const,
              message: 'Corps JSON malformé.',
            },
          },
          400,
        );
      }
    }

    if (isPlainRecord(parsedJson)) {
      const folderCandidate =
        typeof parsedJson['folder_id'] === 'string'
          ? parsedJson['folder_id']
          : typeof parsedJson['drive_folder_id'] === 'string'
            ? parsedJson['drive_folder_id']
            : undefined;

      if (folderCandidate !== undefined && !isAllowedDriveFolderId(folderCandidate)) {
        return c.json(
          {
            error: {
              code: 'INVALID_DRIVE_FOLDER_SCOPE' as const,
              message:
                'Périmètre Google Drive interdit : seuls les 2 dossiers configurés sont autorisés.',
              details: { folder_id: folderCandidate },
            },
          },
          403,
        );
      }
    }

    const validated = InternalRunRequestSchema.safeParse(parsedJson);
    if (!validated.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR' as const,
            message: 'Paramètres de lancement sync-worker invalides.',
            details: {
              issues: validated.error.issues.map((issue) => ({
                path: issue.path.join('.'),
                message: issue.message,
              })),
            },
          },
        },
        422,
      );
    }

    const result = await deps.triggerSync({
      runId: validated.data.run_id,
      driveFileId: validated.data.drive_file_id,
    });

    if (result.ok) {
      return c.json(
        {
          run_id: result.runId,
          status: 'running' as const,
          allowed_folders: ALLOWED_DRIVE_FOLDER_ENTRIES.map((e) => ({
            folder_id: e.folderId,
            bank: e.bank,
          })),
          accepted_at: result.acceptedAt ?? getNow().toISOString(),
        },
        202,
      );
    }

    switch (result.reason) {
      case 'already_running':
        return c.json(
          {
            error: {
              code: 'SYNC_ALREADY_RUNNING' as const,
              message: 'Une ingestion PDF est déjà en cours dans le sync-worker.',
              details: { active_run_id: result.activeRunId },
            },
          },
          409,
        );
      case 'upstream_error':
        return c.json(
          {
            error: {
              code: 'UPSTREAM_DRIVE_ERROR' as const,
              message: result.message,
            },
          },
          502,
        );
      default:
        return assertNever(result);
    }
  });

  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: 'RESOURCE_NOT_FOUND' as const,
          message: 'Route interne introuvable.',
        },
      },
      404,
    );
  });

  return app;
}

function isMainEntrypoint(importMetaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.trim().length === 0) {
    return false;
  }
  return pathToFileURL(argv1).href === importMetaUrl;
}

export function startWorkerRuntime(rawEnv: Readonly<Record<string, string | undefined>> = process.env): {
  close(): Promise<void>;
} {
  const env = parseWorkerEnv(rawEnv);
  const store = new NeonCheckpointStore(env.DATABASE_URL);
  const driveClient = createGoogleDriveClient({
    getAccessToken: createDriveAccessTokenProvider({
      credentialsPath: env.GOOGLE_DRIVE_CREDENTIALS_PATH,
      staticAccessToken: env.GOOGLE_DRIVE_ACCESS_TOKEN,
    }),
  });
  const geminiClient = createHttpGeminiClient({
    apiKey: env.GEMINI_API_KEY,
  });
  const fxRateService = createFxRateService({ store });

  const startupReconcilePromise = store
    .reconcileOrphanedRuns('Synchronisation interrompue (redémarrage du service sync-worker).')
    .catch((err: unknown) => {
      console.error('[sync-worker] Échec réconciliation des runs orphelins au démarrage:', err);
      return 0;
    });

  let activeRunId: string | null = null;
  let activePromise: Promise<SyncRunResult> | null = null;

  const app = createWorkerApp({
    internalWorkerToken: env.INTERNAL_WORKER_TOKEN,
    getActiveRunId: () => activeRunId,
    async triggerSync(input): Promise<TriggerWorkerRunResult> {
      await startupReconcilePromise;

      if (activeRunId !== null) {
        return {
          ok: false,
          reason: 'already_running',
          activeRunId,
        };
      }

      const runId = input.runId ?? randomUUID();
      await store.ensureRun(runId);
      activeRunId = runId;

      const promise = runIngestionPipeline(
        {
          driveClient,
          geminiClient,
          checkpointStore: store,
          fxRateService,
        },
        {
          runId,
          targetDriveFileId: input.driveFileId,
        },
      ).finally(() => {
        activeRunId = null;
        activePromise = null;
      });

      activePromise = promise;
      void promise.catch((err: unknown) => {
        console.error(`[sync-worker] Erreur fatale sur le run ${runId}:`, err);
      });

      return {
        ok: true,
        runId,
        acceptedAt: new Date().toISOString(),
      };
    },
  });

  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
  });

  let shuttingDown = false;
  const close = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (activePromise !== null) {
      await activePromise.catch(() => undefined);
    }
    await store.close();
  };

  const handleSignal = (): void => {
    void close().finally(() => {
      process.exit(0);
    });
  };

  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);

  return { close };
}

if (isMainEntrypoint(import.meta.url, process.argv[1])) {
  startWorkerRuntime(process.env);
}
