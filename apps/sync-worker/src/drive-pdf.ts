import {
  ALLOWED_DRIVE_FOLDERS,
  AccountTypeSchema,
  CurrencySchema,
  getBankForDriveFolder,
  isAllowedDriveFolderId,
  parseDriveFileId,
  type AccountType,
  type AllowedDriveFolderId,
  type Bank,
  type Currency,
  type DriveFileId,
} from '@clairflux/shared';
import { z } from 'zod';

// ============================================================================
// Constants & Domain Errors
// ============================================================================

const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DEFAULT_DRIVE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES_PER_BATCH = 4;
const DEFAULT_MAX_CHARS_PER_BATCH = 16_000;
const MAX_DRIVE_PAGES = 50;

export const ALLOWED_DRIVE_FOLDER_ENTRIES: ReadonlyArray<{
  readonly bank: Bank;
  readonly folderId: AllowedDriveFolderId;
}> = [
  { bank: 'boursobank', folderId: ALLOWED_DRIVE_FOLDERS.boursobank },
  { bank: 'revolut', folderId: ALLOWED_DRIVE_FOLDERS.revolut },
] as const;

export class InvalidDriveFolderScopeError extends Error {
  public readonly code = 'INVALID_DRIVE_FOLDER_SCOPE' as const;
  public readonly folderId: string;

  public constructor(folderId: string) {
    super(
      `Périmètre Google Drive interdit : le dossier "${folderId}" ne fait pas partie des 2 dossiers exclusifs autorisés.`,
    );
    this.name = 'InvalidDriveFolderScopeError';
    this.folderId = folderId;
  }
}

export class DriveDownloadError extends Error {
  public readonly code = 'DRIVE_DOWNLOAD_ERROR' as const;
  public readonly statusCode: number | undefined;

  public constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'DriveDownloadError';
    this.statusCode = statusCode;
  }
}

export class PdfUnreadableError extends Error {
  public readonly code = 'PDF_UNREADABLE' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'PdfUnreadableError';
  }
}

/**
 * Verifies that `folderId` matches one of the 2 exclusive Google Drive folders
 * (`boursobank` or `revolut`). Rejects any other folder immediately.
 */
export function assertAllowedDriveFolderId(folderId: string): {
  readonly folderId: AllowedDriveFolderId;
  readonly bank: Bank;
} {
  const trimmed = folderId.trim();
  if (!isAllowedDriveFolderId(trimmed)) {
    throw new InvalidDriveFolderScopeError(folderId);
  }
  const bank = getBankForDriveFolder(trimmed);
  if (bank === null) {
    throw new InvalidDriveFolderScopeError(folderId);
  }
  return { folderId: trimmed, bank };
}

// ============================================================================
// Google Drive v3 Zod Schemas & Client
// ============================================================================

const DriveApiFileSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1),
  md5Checksum: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{32,64}$/u, 'Invalid md5Checksum from Google Drive')
    .optional(),
  size: z
    .union([z.string().regex(/^\d+$/u), z.number().int().nonnegative()])
    .optional(),
  modifiedTime: z.string().datetime({ offset: true }),
  parents: z.array(z.string().trim().min(1)).optional(),
});

const DriveApiListResponseSchema = z.object({
  nextPageToken: z.string().min(1).optional(),
  files: z.array(DriveApiFileSchema).default([]),
});

export interface DiscoveredDrivePdf {
  readonly driveFileId: DriveFileId;
  readonly driveFolderId: AllowedDriveFolderId;
  readonly bank: Bank;
  readonly fileName: string;
  readonly md5Checksum: string;
  readonly fileSizeBytes: number;
  readonly driveModifiedTime: Date;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GoogleDriveClientOptions {
  readonly getAccessToken: () => Promise<string> | string;
  readonly fetchFn?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface GoogleDriveClient {
  listFolderPdfFiles(folderId: string): Promise<readonly DiscoveredDrivePdf[]>;
  discoverAllAllowedPdfs(): Promise<readonly DiscoveredDrivePdf[]>;
  downloadPdfFile(file: {
    readonly driveFileId: string;
    readonly driveFolderId: string;
  }): Promise<Uint8Array>;
}

function parseFileSizeBytes(rawSize: string | number | undefined): number {
  if (rawSize === undefined) {
    return 0;
  }
  const parsed = typeof rawSize === 'number' ? rawSize : Number(rawSize);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DriveDownloadError(`Taille de fichier Drive invalide : ${String(rawSize)}`);
  }
  return parsed;
}

export function createGoogleDriveClient(
  options: GoogleDriveClientOptions,
): GoogleDriveClient {
  const fetchFn: FetchLike = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRIVE_TIMEOUT_MS;

  async function resolveToken(): Promise<string> {
    const token = (await options.getAccessToken()).trim();
    if (token.length === 0) {
      throw new DriveDownloadError('Jeton Google Drive vide ou manquant.', 401);
    }
    return token;
  }

  async function listFolderPdfFiles(
    folderId: string,
  ): Promise<readonly DiscoveredDrivePdf[]> {
    const scope = assertAllowedDriveFolderId(folderId);
    const token = await resolveToken();
    const collected: DiscoveredDrivePdf[] = [];
    let pageToken: string | undefined;

    for (let pageCount = 0; pageCount < MAX_DRIVE_PAGES; pageCount += 1) {
      const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files`);
      url.searchParams.set(
        'q',
        `'${scope.folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
      );
      url.searchParams.set(
        'fields',
        'nextPageToken, files(id, name, mimeType, md5Checksum, size, modifiedTime, parents)',
      );
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('orderBy', 'modifiedTime desc');
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
      if (pageToken !== undefined) {
        url.searchParams.set('pageToken', pageToken);
      }

      let response: Response;
      try {
        response = await fetchFn(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new DriveDownloadError(
          `Erreur réseau Google Drive lors du scan du dossier ${scope.folderId} : ${message}`,
        );
      }

      if (!response.ok) {
        throw new DriveDownloadError(
          `Google Drive API a répondu HTTP ${response.status} lors du scan du dossier ${scope.folderId}.`,
          response.status,
        );
      }

      let rawJson: unknown;
      try {
        rawJson = await response.json();
      } catch {
        throw new DriveDownloadError(
          `Réponse JSON invalide reçue de Google Drive pour le dossier ${scope.folderId}.`,
          response.status,
        );
      }

      const parsed = DriveApiListResponseSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new DriveDownloadError(
          `Schéma Google Drive invalide pour le dossier ${scope.folderId} : ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          response.status,
        );
      }

      for (const file of parsed.data.files) {
        if (file.mimeType !== 'application/pdf') {
          continue;
        }
        if (file.parents !== undefined && !file.parents.includes(scope.folderId)) {
          throw new InvalidDriveFolderScopeError(file.parents[0] ?? 'unknown');
        }
        if (file.md5Checksum === undefined) {
          throw new DriveDownloadError(
            `Empreinte md5Checksum absente pour le PDF Drive "${file.name}" (${file.id}).`,
          );
        }

        collected.push({
          driveFileId: parseDriveFileId(file.id),
          driveFolderId: scope.folderId,
          bank: scope.bank,
          fileName: file.name,
          md5Checksum: file.md5Checksum.toLowerCase(),
          fileSizeBytes: parseFileSizeBytes(file.size),
          driveModifiedTime: new Date(file.modifiedTime),
        });
      }

      if (parsed.data.nextPageToken === undefined) {
        break;
      }
      pageToken = parsed.data.nextPageToken;
    }

    return collected;
  }

  async function discoverAllAllowedPdfs(): Promise<readonly DiscoveredDrivePdf[]> {
    const allFiles: DiscoveredDrivePdf[] = [];
    for (const entry of ALLOWED_DRIVE_FOLDER_ENTRIES) {
      const folderFiles = await listFolderPdfFiles(entry.folderId);
      allFiles.push(...folderFiles);
    }
    return allFiles;
  }

  async function downloadPdfFile(file: {
    readonly driveFileId: string;
    readonly driveFolderId: string;
  }): Promise<Uint8Array> {
    assertAllowedDriveFolderId(file.driveFolderId);
    const driveFileId = parseDriveFileId(file.driveFileId);
    const token = await resolveToken();

    const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');

    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DriveDownloadError(
        `Erreur réseau lors du téléchargement du PDF Drive ${driveFileId} : ${message}`,
      );
    }

    if (!response.ok) {
      throw new DriveDownloadError(
        `Échec téléchargement PDF Drive ${driveFileId} (HTTP ${response.status}).`,
        response.status,
      );
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new DriveDownloadError(`Le fichier PDF Drive ${driveFileId} est vide.`);
    }
    return new Uint8Array(buffer);
  }

  return {
    listFolderPdfFiles,
    discoverAllAllowedPdfs,
    downloadPdfFile,
  };
}

// ============================================================================
// Automatic Bank / Account Type / Currency Identification
// ============================================================================

export const AccountMetadataInferenceSchema = z.object({
  bank: z.enum(['boursobank', 'revolut']),
  accountType: AccountTypeSchema,
  currency: CurrencySchema,
  confidence: z.enum(['high', 'medium']),
});

export type AccountMetadataInference = z.infer<typeof AccountMetadataInferenceSchema>;

function normalizeForClassification(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const BOURSOBANK_DEFERRED_CARD_PATTERN =
  /\b(?:carte\s*a?\s*debit\s*differe|debit\s*differe|carte\s*differee|cb\s*differe|releve\s*carte)\b/u;
const BOURSOBANK_SAVINGS_PATTERN =
  /\b(?:livret\s*a|livret\s*developpement|ldds|lep|cel|pel|epargne|bourso\s*\+|compte\s*sur\s*livret|csl)\b/u;
const BOURSOBANK_CHECKING_PATTERN =
  /\b(?:compte\s*courant|compte\s*de\s*cheques|compte\s*bancaire|releve\s*de\s*compte)\b/u;

const REVOLUT_VAULT_PATTERN = /\b(?:coffre|vault|pockets?)\b/u;
const REVOLUT_SAVINGS_PATTERN = /\b(?:epargne|savings|flexible\s*cash\s*funds?|interest)\b/u;
const REVOLUT_MULTI_CURRENCY_PATTERN =
  /\b(?:multi\s*devises?|multi\s*currency|currency\s*account)\b/u;

const EXPLICIT_USD_FILENAME_PATTERN = /\b(?:usd|dollar)\b/u;
const EXPLICIT_EUR_FILENAME_PATTERN = /\b(?:eur|euro)\b/u;
const EXPLICIT_USD_HEADER_PATTERN =
  /\b(?:currency\s*:\s*usd|devise\s*:\s*usd|account\s*statement\s*(?:in\s*)?usd|releve\s*(?:de\s*compte\s*)?usd|opening\s*balance\s*\$|closing\s*balance\s*\$|balance\s*summary\s*\(?\s*usd\s*\)?|solde\s*en\s*usd)\b/u;
const EXPLICIT_EUR_HEADER_PATTERN =
  /\b(?:currency\s*:\s*eur|devise\s*:\s*eur|account\s*statement\s*(?:in\s*)?eur|releve\s*(?:de\s*compte\s*)?eur|balance\s*summary\s*\(?\s*eur\s*\)?|solde\s*en\s*eur)\b/u;

/**
 * Infers `accountType` (`courant`, `epargne`, `carte_differee`, `multi_devises`, `coffre`)
 * and `currency` (`EUR` | `USD`) from the bank folder scope, PDF filename, and statement header text.
 */
export function inferAccountMetadata(input: {
  readonly bank: Bank;
  readonly fileName: string;
  readonly textSample?: string | undefined;
}): AccountMetadataInference {
  const normalizedFileName = normalizeForClassification(input.fileName);
  const normalizedHeader = normalizeForClassification(
    (input.textSample ?? '').slice(0, 2500),
  );
  const combined = `${normalizedFileName} ${normalizedHeader}`.trim();

  if (input.bank === 'boursobank') {
    let accountType: AccountType = 'courant';
    let confidence: 'high' | 'medium' = 'medium';

    if (BOURSOBANK_DEFERRED_CARD_PATTERN.test(combined)) {
      accountType = 'carte_differee';
      confidence = 'high';
    } else if (BOURSOBANK_SAVINGS_PATTERN.test(combined)) {
      accountType = 'epargne';
      confidence = 'high';
    } else if (BOURSOBANK_CHECKING_PATTERN.test(combined)) {
      accountType = 'courant';
      confidence = 'high';
    }

    const currency: Currency =
      EXPLICIT_USD_HEADER_PATTERN.test(normalizedHeader) &&
      !EXPLICIT_EUR_HEADER_PATTERN.test(normalizedHeader)
        ? 'USD'
        : 'EUR';

    return AccountMetadataInferenceSchema.parse({
      bank: input.bank,
      accountType,
      currency,
      confidence,
    });
  }

  // Revolut branch
  let currency: Currency = 'EUR';
  const hasUsdFilename = EXPLICIT_USD_FILENAME_PATTERN.test(normalizedFileName);
  const hasEurFilename = EXPLICIT_EUR_FILENAME_PATTERN.test(normalizedFileName);
  const hasUsdHeader = EXPLICIT_USD_HEADER_PATTERN.test(normalizedHeader);
  const hasEurHeader = EXPLICIT_EUR_HEADER_PATTERN.test(normalizedHeader);

  if (hasUsdHeader && !hasEurHeader) {
    currency = 'USD';
  } else if (hasEurHeader && !hasUsdHeader) {
    currency = 'EUR';
  } else if (hasUsdFilename && !hasEurFilename) {
    currency = 'USD';
  }

  let accountType: AccountType = currency === 'USD' ? 'multi_devises' : 'courant';
  let confidence: 'high' | 'medium' = currency === 'USD' ? 'high' : 'medium';

  if (REVOLUT_VAULT_PATTERN.test(combined)) {
    accountType = 'coffre';
    confidence = 'high';
  } else if (REVOLUT_SAVINGS_PATTERN.test(combined)) {
    accountType = 'epargne';
    confidence = 'high';
  } else if (REVOLUT_MULTI_CURRENCY_PATTERN.test(combined) || currency === 'USD') {
    accountType = 'multi_devises';
    confidence = 'high';
  } else if (/\b(?:courant|main\s*account|eur\s*statement|compte\s*eur)\b/u.test(combined)) {
    accountType = 'courant';
    confidence = 'high';
  }

  return AccountMetadataInferenceSchema.parse({
    bank: input.bank,
    accountType,
    currency,
    confidence,
  });
}

// ============================================================================
// PDF Text Extraction via pdfjs-dist (with optional test injection)
// ============================================================================

export interface PdfPageText {
  readonly pageNumber: number;
  readonly rawText: string;
}

export type PdfTextExtractor = (
  pdfBytes: Uint8Array,
) => Promise<readonly PdfPageText[]>;

function isTextItemWithStr(
  item: unknown,
): item is { readonly str: string; readonly hasEOL?: boolean } {
  return (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof item.str === 'string'
  );
}

/**
 * Extracts per-page text from raw PDF bytes using `pdfjs-dist` (legacy Node build).
 */
export async function extractPdfPagesWithPdfjs(
  pdfBytes: Uint8Array,
): Promise<readonly PdfPageText[]> {
  if (pdfBytes.byteLength === 0) {
    throw new PdfUnreadableError('Le contenu binaire du PDF est vide.');
  }

  let docToDestroy: { destroy(): Promise<void> } | null = null;

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: pdfBytes,
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    const doc = await loadingTask.promise;
    docToDestroy = doc;

    if (doc.numPages <= 0) {
      throw new PdfUnreadableError('Le document PDF ne contient aucune page.');
    }

    const pages: PdfPageText[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const parts: string[] = [];

      for (const item of content.items) {
        if (!isTextItemWithStr(item)) {
          continue;
        }
        parts.push(item.str);
        if (item.hasEOL === true) {
          parts.push('\n');
        } else if (item.str.length > 0 && !item.str.endsWith(' ')) {
          parts.push(' ');
        }
      }

      const rawText = parts
        .join('')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();

      pages.push({ pageNumber, rawText });
    }

    return pages;
  } catch (err) {
    if (err instanceof PdfUnreadableError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new PdfUnreadableError(`Impossible de lire le PDF via pdfjs-dist : ${message}`);
  } finally {
    if (docToDestroy !== null) {
      await docToDestroy.destroy().catch(() => undefined);
    }
  }
}

// ============================================================================
// Banking Boilerplate Removal & Bounded Batch Splitting
// ============================================================================

const TRANSACTION_OR_BALANCE_GUARD_PATTERN =
  /(?:\b\d{2}[/.]\d{2}(?:[/.]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b).*(?:[+-]?\d[\d\s.,]*\d\s*(?:€|\$|EUR|USD)|solde|balance)/iu;

const BOILERPLATE_LINE_PATTERNS: readonly RegExp[] = [
  /^page\s+\d+(?:\s*(?:\/|sur|of)\s*\d+)?$/iu,
  /^\d+\s*\/\s*\d+$/u,
  /\bsa\s+au\s+capital\s+de\b/iu,
  /\brcs\s+nanterre\b/iu,
  /\borias\s+n[°o]?\s*\d+/iu,
  /\bfonds\s+de\s+garantie\s+des\s+depots\b/iu,
  /\bmediateur\s+(?:de\s+la\s+consommation|bancaire|fne|boursobank)\b/iu,
  /\bsiege\s+social\s*:/iu,
  /\brevolut\s+bank\s+uab\b/iu,
  /\bkonstitucijos\s+ave\b/iu,
  /\bbank\s+of\s+lithuania\b/iu,
  /\bdeposit\s+guarantee\s+scheme\b/iu,
  /\breport\s+lost\s+or\s+stolen\s+card\b/iu,
  /\bget\s+help\s+directly\s+in\s+the\s+app\b/iu,
  /^(?:©|\(c\))\s*\d{4}\s+revolut\b/iu,
  /^generated\s+on\s+\d{1,2}\s+\w+\s+\d{4}\b/iu,
  /\breglement\s+(?:ue|general)\s+sur\s+la\s+protection\s+des\s+donnees\b/iu,
  /\brgpd\b.*\bdonnees\s+personnelles\b/iu,
  /\bdocument\s+a\s+conserver\s+(?:sans\s+limitation|pendant)\b/iu,
  /^(?:iban|bic)\s*:\s*[A-Z0-9\s]{8,}$/iu,
  /^sous\s+reserve\s+d['’]operations\s+en\s+cours\b/iu,
  /^les\s+ecritures\s+ci-dessus\s+sauf\s+erreur\b/iu,
] as const;

function normalizeLineForBoilerplateMatch(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/\s+/gu, ' ');
}

function isExplicitBoilerplateLine(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (TRANSACTION_OR_BALANCE_GUARD_PATTERN.test(trimmed)) {
    return false;
  }
  const normalized = normalizeLineForBoilerplateMatch(trimmed);
  return BOILERPLATE_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface CleanedPdfPages {
  readonly pages: readonly PdfPageText[];
  readonly totalPages: number;
  readonly removedLineCount: number;
}

/**
 * Strips repetitive legal headers/footers, GDPR/RGPD notices, repeated IBAN/RIB footers,
 * and pagination lines from extracted PDF pages while keeping operations and balances intact.
 */
export function stripBankingBoilerplate(
  pages: readonly PdfPageText[],
): CleanedPdfPages {
  const pageLinesList = pages.map((page) =>
    page.rawText
      .replace(/\r\n/gu, '\n')
      .split('\n')
      .map((line) => line.trim()),
  );

  // Count how many distinct pages each non-transaction line appears on (top/bottom repeats)
  const linePageFrequency = new Map<string, number>();
  if (pages.length >= 2) {
    for (const lines of pageLinesList) {
      const seenOnThisPage = new Set<string>();
      for (const line of lines) {
        if (line.length < 12) {
          continue;
        }
        if (TRANSACTION_OR_BALANCE_GUARD_PATTERN.test(line)) {
          continue;
        }
        const normalized = normalizeLineForBoilerplateMatch(line);
        if (!seenOnThisPage.has(normalized)) {
          seenOnThisPage.add(normalized);
          linePageFrequency.set(normalized, (linePageFrequency.get(normalized) ?? 0) + 1);
        }
      }
    }
  }

  let removedLineCount = 0;
  const cleanedPages: PdfPageText[] = [];

  for (let idx = 0; idx < pages.length; idx += 1) {
    const originalPage = pages[idx];
    const lines = pageLinesList[idx];
    if (originalPage === undefined || lines === undefined) {
      continue;
    }

    const keptLines: string[] = [];
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      const normalized = normalizeLineForBoilerplateMatch(line);
      const repeatedAcrossPages =
        pages.length >= 2 &&
        (linePageFrequency.get(normalized) ?? 0) >= 2 &&
        !/\b(?:ouverture|cloture|opening|closing|solde|balance|periode|period)\b/iu.test(
          normalized,
        );

      if (isExplicitBoilerplateLine(line) || repeatedAcrossPages) {
        removedLineCount += 1;
        continue;
      }

      keptLines.push(line);
    }

    cleanedPages.push({
      pageNumber: originalPage.pageNumber,
      rawText: keptLines.join('\n'),
    });
  }

  return {
    pages: cleanedPages,
    totalPages: pages.length,
    removedLineCount,
  };
}

export const BatchingOptionsSchema = z.object({
  maxPagesPerBatch: z.number().int().min(1).max(20).default(DEFAULT_MAX_PAGES_PER_BATCH),
  maxCharsPerBatch: z
    .number()
    .int()
    .min(200)
    .max(100_000)
    .default(DEFAULT_MAX_CHARS_PER_BATCH),
});

export type BatchingOptions = z.input<typeof BatchingOptionsSchema>;

export interface PdfTextBatch {
  readonly batchIndex: number;
  readonly totalBatches: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly text: string;
  readonly charCount: number;
}

function splitOversizedPageByLine(
  pageText: string,
  maxCharsPerBatch: number,
): readonly string[] {
  const lines = pageText.split('\n');
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of lines) {
    const candidate = currentChunk.length === 0 ? line : `${currentChunk}\n${line}`;
    if (candidate.length > maxCharsPerBatch && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}

/**
 * Splits cleaned PDF pages into bounded batches (`maxPagesPerBatch` & `maxCharsPerBatch`)
 * to prevent Gemini 504 timeouts and network fetch failures on large bank statements.
 */
export function splitPagesIntoBatches(
  pages: readonly PdfPageText[],
  options: BatchingOptions = {},
): readonly PdfTextBatch[] {
  const parsedOptions = BatchingOptionsSchema.parse(options);
  const nonEmptyPages = pages.filter((p) => p.rawText.trim().length > 0);
  if (nonEmptyPages.length === 0) {
    throw new PdfUnreadableError('Aucun texte exploitable extrait après nettoyage du PDF.');
  }

  interface DraftBatch {
    readonly pageStart: number;
    readonly pageEnd: number;
    readonly segments: string[];
    readonly charCount: number;
  }

  const drafts: Array<{
    pageStart: number;
    pageEnd: number;
    pageCount: number;
    segments: string[];
    charCount: number;
  }> = [];

  for (const page of nonEmptyPages) {
    const labeledPage = `--- PAGE ${page.pageNumber} ---\n${page.rawText}`;

    if (labeledPage.length > parsedOptions.maxCharsPerBatch) {
      const subChunks = splitOversizedPageByLine(
        labeledPage,
        parsedOptions.maxCharsPerBatch,
      );
      for (const chunk of subChunks) {
        drafts.push({
          pageStart: page.pageNumber,
          pageEnd: page.pageNumber,
          pageCount: 1,
          segments: [chunk],
          charCount: chunk.length,
        });
      }
      continue;
    }

    const lastDraft = drafts[drafts.length - 1];
    const separatorLength = lastDraft !== undefined ? 2 : 0;
    const fitsExisting =
      lastDraft !== undefined &&
      lastDraft.pageCount < parsedOptions.maxPagesPerBatch &&
      lastDraft.charCount + separatorLength + labeledPage.length <=
        parsedOptions.maxCharsPerBatch;

    if (fitsExisting) {
      lastDraft.segments.push(labeledPage);
      lastDraft.pageEnd = page.pageNumber;
      lastDraft.pageCount += 1;
      lastDraft.charCount += separatorLength + labeledPage.length;
    } else {
      const nextDraft: DraftBatch & { pageCount: number } = {
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
        pageCount: 1,
        segments: [labeledPage],
        charCount: labeledPage.length,
      };
      drafts.push(nextDraft);
    }
  }

  const totalBatches = drafts.length;
  return drafts.map((draft, index) => {
    const text = draft.segments.join('\n\n');
    return {
      batchIndex: index,
      totalBatches,
      pageStart: draft.pageStart,
      pageEnd: draft.pageEnd,
      text,
      charCount: text.length,
    };
  });
}

export interface PreparedPdfStatement {
  readonly file: DiscoveredDrivePdf;
  readonly metadata: AccountMetadataInference;
  readonly totalPages: number;
  readonly removedBoilerplateLines: number;
  readonly batches: readonly PdfTextBatch[];
}

export async function prepareDrivePdfBatches(input: {
  readonly file: DiscoveredDrivePdf;
  readonly pdfBytes: Uint8Array;
  readonly extractPdfPages?: PdfTextExtractor | undefined;
  readonly batchingOptions?: BatchingOptions | undefined;
}): Promise<PreparedPdfStatement> {
  assertAllowedDriveFolderId(input.file.driveFolderId);

  const extractor = input.extractPdfPages ?? extractPdfPagesWithPdfjs;
  const rawPages = await extractor(input.pdfBytes);
  const cleaned = stripBankingBoilerplate(rawPages);
  const batches = splitPagesIntoBatches(cleaned.pages, input.batchingOptions);
  const sampleText = cleaned.pages
    .slice(0, 2)
    .map((p) => p.rawText)
    .join('\n');

  const metadata = inferAccountMetadata({
    bank: input.file.bank,
    fileName: input.file.fileName,
    textSample: sampleText,
  });

  return {
    file: input.file,
    metadata,
    totalPages: cleaned.totalPages,
    removedBoilerplateLines: cleaned.removedLineCount,
    batches,
  };
}
