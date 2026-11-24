import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  ALLOWED_DRIVE_FOLDERS,
  EUR_FX_RATE_MICRO,
  parseDriveFileId,
  toCents,
  toFxRateMicro,
  type Bank,
  type CheckpointErrorCode,
  type CheckpointStatus,
  type Currency,
  type FxRateMicro,
  type FxSource,
  type SyncRunStatus,
} from '@clairflux/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  DriveDownloadError,
  InvalidDriveFolderScopeError,
  assertAllowedDriveFolderId,
  createDriveAccessTokenProvider,
  createGoogleDriveClient,
  extractPdfPagesInSubprocess,
  extractPdfPagesWithPdfjs,
  inferAccountMetadata,
  splitPagesIntoBatches,
  stripBankingBoilerplate,
  type DiscoveredDrivePdf,
  type GoogleDriveClient,
  type PdfPageText,
} from './drive-pdf.js';
import {
  GEMINI_FALLBACK_MODELS,
  NeonCheckpointStore,
  PipelineStepError,
  WorkerEnvValidationError,
  computeDedupHash,
  convertAmountCents,
  createFxRateService,
  createHttpGeminiClient,
  createWorkerApp,
  evaluateCategorizationRules,
  extractBatchWithFallback,
  matchInternalTransferPairs,
  normalizeLabel,
  parseWorkerEnv,
  runIngestionPipeline,
  type ActiveRuleRecord,
  type CheckpointBatchRecord,
  type CheckpointPayloadEnvelope,
  type CheckpointStateRecord,
  type CheckpointStore,
  type FileCommitOutcome,
  type FxRateLookupHit,
  type GeminiModelClient,
  type GeminiStatementExtraction,
  type ResolvedTransactionFx,
  type TriggerWorkerRunResult,
} from './gemini-pipeline.js';

// ============================================================================
// In-Memory SQL/Checkpoint Simulator (Faithful to Neon ACID & Dedup Invariants)
// ============================================================================

interface StoredTxRow {
  readonly id: string;
  readonly accountId: string;
  readonly bank: Bank;
  readonly currency: Currency;
  readonly bookingDate: string;
  readonly amountCents: number;
  readonly fxRateMicro: FxRateMicro;
  readonly amountEurCents: number;
  readonly rawLabel: string;
  readonly cleanLabel: string;
  category: string;
  matchedRuleId: string | null;
  readonly isManualCategory: boolean;
  isInternalTransfer: boolean;
  readonly isManualTransferOverride: boolean;
  transferGroupId: string | null;
  readonly statementOccurrenceIndex: number;
  readonly dedupHash: string;
  readonly deletedAt: Date | null;
}

interface StoredCheckpointRow {
  readonly checkpointId: string;
  readonly driveFileRecordId: string;
  lastRunId: string;
  status: CheckpointStatus;
  attemptCount: number;
  totalPages: number | null;
  parsedPayloadHash: string | null;
  parsedPayload: CheckpointPayloadEnvelope | null;
  errorCode: CheckpointErrorCode | null;
  errorMessage: string | null;
  committedAt: Date | null;
}

class InMemoryNeonCheckpointStore implements CheckpointStore {
  public readonly runs = new Map<
    string,
    {
      status: SyncRunStatus;
      totalFilesDiscovered: number;
      filesSkippedUnchanged: number;
      filesCommitted: number;
      filesFailed: number;
      errorSummary: string | null;
    }
  >();
  public readonly driveFilesByComposite = new Map<string, string>();
  public readonly checkpointsByDriveFileRecordId = new Map<string, StoredCheckpointRow>();
  public readonly checkpointsById = new Map<string, StoredCheckpointRow>();
  public readonly accountsByIdentity = new Map<
    string,
    {
      readonly id: string;
      readonly bank: Bank;
      readonly accountType: string;
      nickname: string;
      currentBalanceCents: number;
      lastStatementClosingDate: string | null;
    }
  >();
  public readonly transactionsByDedupHash = new Map<string, StoredTxRow>();
  public readonly fxRates = new Map<
    string,
    { rateDate: string; baseCurrency: Currency; quoteCurrency: Currency; rateMicro: FxRateMicro; source: FxSource }
  >();
  public readonly rules: ActiveRuleRecord[] = [];
  public failNextCommitCount = 0;

  public async ensureRun(runId?: string): Promise<{ readonly runId: string }> {
    const id = runId ?? randomUUID();
    if (!this.runs.has(id)) {
      this.runs.set(id, {
        status: 'running',
        totalFilesDiscovered: 0,
        filesSkippedUnchanged: 0,
        filesCommitted: 0,
        filesFailed: 0,
        errorSummary: null,
      });
    }
    return { runId: id };
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
    this.runs.set(input.runId, {
      status: input.status,
      totalFilesDiscovered: input.totalFilesDiscovered,
      filesSkippedUnchanged: input.filesSkippedUnchanged,
      filesCommitted: input.filesCommitted,
      filesFailed: input.filesFailed,
      errorSummary: input.errorSummary,
    });
  }

  public async reconcileOrphanedRuns(reason: string): Promise<number> {
    let reconciled = 0;
    for (const [id, run] of this.runs.entries()) {
      if (run.status === 'running') {
        this.runs.set(id, {
          ...run,
          status: 'failed',
          errorSummary: reason,
        });
        reconciled += 1;
      }
    }
    for (const cp of this.checkpointsById.values()) {
      if (cp.status === 'extracting' || cp.status === 'committing') {
        cp.status = 'failed';
        cp.errorCode = 'GEMINI_TIMEOUT';
        cp.errorMessage = reason;
      }
    }
    return reconciled;
  }

  public async getExactRate(
    rateDate: string,
    baseCurrency: Currency,
    quoteCurrency: Currency,
  ): Promise<{ readonly rateMicro: FxRateMicro; readonly source: FxSource } | null> {
    const row = this.fxRates.get(`${rateDate}|${baseCurrency}|${quoteCurrency}`);
    return row ? { rateMicro: row.rateMicro, source: row.source } : null;
  }

  public async getNearestPriorRate(
    rateDate: string,
    baseCurrency: Currency,
    quoteCurrency: Currency,
    maxLookbackDays: number,
  ): Promise<FxRateLookupHit | null> {
    const targetMs = Date.parse(`${rateDate}T00:00:00.000Z`);
    const minDate = new Date(targetMs - maxLookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const candidates = [...this.fxRates.values()]
      .filter(
        (r) =>
          r.baseCurrency === baseCurrency &&
          r.quoteCurrency === quoteCurrency &&
          r.rateDate <= rateDate &&
          r.rateDate >= minDate,
      )
      .sort((a, b) => (a.rateDate < b.rateDate ? 1 : -1));

    const hit = candidates[0];
    return hit
      ? { rateDate: hit.rateDate, rateMicro: hit.rateMicro, source: hit.source }
      : null;
  }

  public async saveRate(entry: {
    readonly rateDate: string;
    readonly baseCurrency: Currency;
    readonly quoteCurrency: Currency;
    readonly rateMicro: FxRateMicro;
    readonly source: FxSource;
  }): Promise<void> {
    const key = `${entry.rateDate}|${entry.baseCurrency}|${entry.quoteCurrency}`;
    if (!this.fxRates.has(key)) {
      this.fxRates.set(key, { ...entry });
    }
  }

  public async upsertDriveFileAndLoadCheckpoint(input: {
    readonly runId: string;
    readonly file: DiscoveredDrivePdf;
  }): Promise<CheckpointStateRecord> {
    const composite = `${input.file.driveFileId}|${input.file.md5Checksum}`;
    let recordId = this.driveFilesByComposite.get(composite);
    if (recordId === undefined) {
      recordId = randomUUID();
      this.driveFilesByComposite.set(composite, recordId);
    }

    let cp = this.checkpointsByDriveFileRecordId.get(recordId);
    if (cp === undefined) {
      cp = {
        checkpointId: randomUUID(),
        driveFileRecordId: recordId,
        lastRunId: input.runId,
        status: 'pending',
        attemptCount: 0,
        totalPages: null,
        parsedPayloadHash: null,
        parsedPayload: null,
        errorCode: null,
        errorMessage: null,
        committedAt: null,
      };
      this.checkpointsByDriveFileRecordId.set(recordId, cp);
      this.checkpointsById.set(cp.checkpointId, cp);
    }

    return {
      checkpointId: cp.checkpointId,
      driveFileRecordId: cp.driveFileRecordId,
      lastRunId: cp.lastRunId,
      status: cp.status,
      attemptCount: cp.attemptCount,
      totalPages: cp.totalPages,
      parsedPayloadHash: cp.parsedPayloadHash,
      parsedPayload: cp.parsedPayload,
      errorCode: cp.errorCode,
      errorMessage: cp.errorMessage,
    };
  }

  public async markFileSkipped(input: {
    readonly checkpointId: string;
    readonly runId: string;
  }): Promise<void> {
    const cp = this.checkpointsById.get(input.checkpointId);
    if (cp !== undefined) {
      cp.lastRunId = input.runId;
    }
  }

  public async markFileExtracting(input: {
    readonly checkpointId: string;
    readonly runId: string;
    readonly totalPages?: number | undefined;
  }): Promise<void> {
    const cp = this.checkpointsById.get(input.checkpointId);
    if (cp !== undefined) {
      cp.lastRunId = input.runId;
      cp.status = 'extracting';
      cp.attemptCount += 1;
      if (input.totalPages !== undefined) {
        cp.totalPages = input.totalPages;
      }
      cp.errorCode = null;
      cp.errorMessage = null;
    }
  }

  public async savePartialBatch(input: {
    readonly checkpointId: string;
    readonly totalPages: number;
    readonly totalBatches: number;
    readonly batchRecord: CheckpointBatchRecord;
  }): Promise<void> {
    const cp = this.checkpointsById.get(input.checkpointId);
    if (cp === undefined) {
      return;
    }
    const existing =
      cp.parsedPayload?.kind === 'partial_batches' &&
      cp.parsedPayload.totalBatches === input.totalBatches
        ? cp.parsedPayload.completedBatches.filter(
            (b) => b.batchIndex !== input.batchRecord.batchIndex,
          )
        : [];

    cp.totalPages = input.totalPages;
    cp.parsedPayload = {
      kind: 'partial_batches',
      totalBatches: input.totalBatches,
      completedBatches: [...existing, input.batchRecord].sort(
        (a, b) => a.batchIndex - b.batchIndex,
      ),
    };
  }

  public async markFileParsed(input: {
    readonly checkpointId: string;
    readonly totalPages: number;
    readonly statement: GeminiStatementExtraction;
    readonly payloadHash: string;
  }): Promise<void> {
    const cp = this.checkpointsById.get(input.checkpointId);
    if (cp !== undefined) {
      cp.status = 'parsed';
      cp.totalPages = input.totalPages;
      cp.parsedPayloadHash = input.payloadHash;
      cp.parsedPayload = {
        kind: 'complete_statement',
        statement: input.statement,
      };
      cp.errorCode = null;
      cp.errorMessage = null;
    }
  }

  public async markFileFailed(input: {
    readonly checkpointId: string;
    readonly runId: string;
    readonly errorCode: CheckpointErrorCode;
    readonly errorMessage: string;
  }): Promise<void> {
    const cp = this.checkpointsById.get(input.checkpointId);
    if (cp !== undefined) {
      cp.lastRunId = input.runId;
      cp.status = 'failed';
      cp.errorCode = input.errorCode;
      cp.errorMessage = input.errorMessage;
    }
  }

  public async commitParsedStatement(input: {
    readonly checkpointId: string;
    readonly driveFileRecordId: string;
    readonly bank: Bank;
    readonly statement: GeminiStatementExtraction;
    readonly fxByTxIndex: ReadonlyMap<number, ResolvedTransactionFx>;
  }): Promise<FileCommitOutcome> {
    if (this.failNextCommitCount > 0) {
      this.failNextCommitCount -= 1;
      throw new Error('Simulated Neon pool failure during ACID commit');
    }

    const cp = this.checkpointsById.get(input.checkpointId);
    if (cp === undefined) {
      throw new Error('Missing checkpoint');
    }
    cp.status = 'committing';

    const accountMap = new Map<string, string>();
    for (const acct of input.statement.accounts) {
      const key = `${input.bank}|${acct.external_ref_masked}|${acct.currency}`;
      const existing = this.accountsByIdentity.get(key);
      if (existing === undefined) {
        const id = randomUUID();
        this.accountsByIdentity.set(key, {
          id,
          bank: input.bank,
          accountType: acct.account_type,
          nickname: acct.detected_name,
          currentBalanceCents: acct.closing_balance_cents,
          lastStatementClosingDate: input.statement.statement_period_end,
        });
        accountMap.set(`${acct.external_ref_masked}|${acct.currency}`, id);
      } else {
        if (
          existing.lastStatementClosingDate === null ||
          input.statement.statement_period_end >= existing.lastStatementClosingDate
        ) {
          existing.currentBalanceCents = acct.closing_balance_cents;
          existing.lastStatementClosingDate = input.statement.statement_period_end;
        }
        accountMap.set(`${acct.external_ref_masked}|${acct.currency}`, existing.id);
      }
    }

    const counters = new Map<string, number>();
    let insertedTxCount = 0;
    let dedupSkippedTxCount = 0;

    for (let i = 0; i < input.statement.transactions.length; i += 1) {
      const tx = input.statement.transactions[i];
      if (tx === undefined) {
        continue;
      }
      const accountId = accountMap.get(`${tx.account_ref_masked}|${tx.currency}`);
      if (accountId === undefined) {
        throw new Error('Account missing');
      }
      const fx = input.fxByTxIndex.get(i);
      if (fx === undefined) {
        throw new Error('FX missing');
      }
      const normalized = normalizeLabel(tx.raw_label);
      const bucket = `${accountId}|${tx.currency}|${tx.booking_date}|${tx.amount_cents}|${normalized}`;
      const occ = (counters.get(bucket) ?? 0) + 1;
      counters.set(bucket, occ);

      const dedupHash = computeDedupHash({
        accountId,
        currency: tx.currency,
        bookingDate: tx.booking_date,
        amountCents: tx.amount_cents,
        rawLabel: tx.raw_label,
        occurrenceIndex: occ,
      });

      if (this.transactionsByDedupHash.has(dedupHash)) {
        dedupSkippedTxCount += 1;
        continue;
      }

      const acctRecord = [...this.accountsByIdentity.values()].find((a) => a.id === accountId);
      const ruleEval = evaluateCategorizationRules({
        rules: this.rules,
        bank: input.bank,
        accountId,
        accountType:
          acctRecord?.accountType === 'carte_differee' ||
          acctRecord?.accountType === 'epargne' ||
          acctRecord?.accountType === 'multi_devises' ||
          acctRecord?.accountType === 'coffre' ||
          acctRecord?.accountType === 'courant'
            ? acctRecord.accountType
            : 'autre',
        rawLabel: tx.raw_label,
        cleanLabel: tx.clean_label,
      });

      this.transactionsByDedupHash.set(dedupHash, {
        id: randomUUID(),
        accountId,
        bank: input.bank,
        currency: tx.currency,
        bookingDate: tx.booking_date,
        amountCents: tx.amount_cents,
        fxRateMicro: fx.fxRateMicro,
        amountEurCents: fx.amountEurCents,
        rawLabel: tx.raw_label,
        cleanLabel: tx.clean_label,
        category: ruleEval.category,
        matchedRuleId: ruleEval.matchedRuleId,
        isManualCategory: false,
        isInternalTransfer: ruleEval.isInternalTransfer,
        isManualTransferOverride: false,
        transferGroupId: null,
        statementOccurrenceIndex: occ,
        dedupHash,
        deletedAt: null,
      });
      insertedTxCount += 1;
    }

    const candidates = [...this.transactionsByDedupHash.values()];
    const pairs = matchInternalTransferPairs(candidates);
    for (const pair of pairs) {
      const groupId = randomUUID();
      for (const tx of candidates) {
        if (tx.id === pair.debitTxId || tx.id === pair.creditTxId) {
          tx.transferGroupId = groupId;
          tx.isInternalTransfer = true;
          if (!tx.isManualCategory) {
            tx.category = 'Transfert interne';
            tx.matchedRuleId = null;
          }
        }
      }
    }

    cp.status = 'committed';
    cp.committedAt = new Date();
    cp.parsedPayload = null;
    cp.errorCode = null;
    cp.errorMessage = null;

    return {
      detectedAccountsCount: accountMap.size,
      insertedTxCount,
      dedupSkippedTxCount,
      matchedTransferPairsCount: pairs.length,
    };
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Google Drive exclusive folder scope & discovery', () => {
  it('accepts only the 2 exclusive BoursoBank and Revolut folder IDs and rejects any other folder', () => {
    expect(assertAllowedDriveFolderId(ALLOWED_DRIVE_FOLDERS.boursobank)).toEqual({
      folderId: ALLOWED_DRIVE_FOLDERS.boursobank,
      bank: 'boursobank',
    });
    expect(assertAllowedDriveFolderId(ALLOWED_DRIVE_FOLDERS.revolut)).toEqual({
      folderId: ALLOWED_DRIVE_FOLDERS.revolut,
      bank: 'revolut',
    });

    expect(() => assertAllowedDriveFolderId('1SomeArbitraryFolderId')).toThrowError(
      InvalidDriveFolderScopeError,
    );
    expect(() => assertAllowedDriveFolderId('')).toThrowError(
      InvalidDriveFolderScopeError,
    );
  });

  it('rejects listFolderPdfFiles and downloadPdfFile when folderId is outside the 2 allowed folders', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const client = createGoogleDriveClient({
      getAccessToken: () => 'test-drive-token',
      fetchFn: fetchSpy,
    });

    await expect(client.listFolderPdfFiles('unauthorized-folder-id')).rejects.toThrowError(
      InvalidDriveFolderScopeError,
    );
    await expect(
      client.downloadPdfFile({
        driveFileId: 'file-123',
        driveFolderId: 'unauthorized-folder-id',
      }),
    ).rejects.toThrowError(InvalidDriveFolderScopeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('discovers PDFs strictly from the 2 exclusive folders with Zod validation & pagination', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const q = url.searchParams.get('q') ?? '';
      if (q.includes(ALLOWED_DRIVE_FOLDERS.boursobank)) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'drive-bourso-1',
                name: 'BoursoBank_2026_11.pdf',
                mimeType: 'application/pdf',
                md5Checksum: 'A1B2C3D4E5F60718293A4B5C6D7E8F90',
                size: '20480',
                modifiedTime: '2026-11-20T10:00:00.000Z',
                parents: [ALLOWED_DRIVE_FOLDERS.boursobank],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (q.includes(ALLOWED_DRIVE_FOLDERS.revolut)) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'drive-rev-1',
                name: 'Revolut_USD_2026_11.pdf',
                mimeType: 'application/pdf',
                md5Checksum: '00112233445566778899AABBCCDDEEFF',
                size: '15360',
                modifiedTime: '2026-11-20T11:00:00.000Z',
                parents: [ALLOWED_DRIVE_FOLDERS.revolut],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    });

    const client = createGoogleDriveClient({
      getAccessToken: () => 'drive-access-token',
      fetchFn: fetchMock,
    });

    const discovered = await client.discoverAllAllowedPdfs();
    expect(discovered).toHaveLength(2);
    expect(discovered[0]).toMatchObject({
      driveFileId: 'drive-bourso-1',
      driveFolderId: ALLOWED_DRIVE_FOLDERS.boursobank,
      bank: 'boursobank',
      md5Checksum: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    });
    expect(discovered[1]).toMatchObject({
      driveFileId: 'drive-rev-1',
      driveFolderId: ALLOWED_DRIVE_FOLDERS.revolut,
      bank: 'revolut',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Automatic bank, account type & currency inference', () => {
  it('classifies BoursoBank courant, epargne, carte_differee and Revolut multi_devises / coffre / USD', () => {
    expect(
      inferAccountMetadata({
        bank: 'boursobank',
        fileName: 'Releve_Compte_Courant_2026_10.pdf',
      }),
    ).toMatchObject({ bank: 'boursobank', accountType: 'courant', currency: 'EUR' });

    expect(
      inferAccountMetadata({
        bank: 'boursobank',
        fileName: 'Releve_Carte_Debit_Differe_4821.pdf',
      }),
    ).toMatchObject({ bank: 'boursobank', accountType: 'carte_differee', currency: 'EUR' });

    expect(
      inferAccountMetadata({
        bank: 'boursobank',
        fileName: 'Livret_A_BoursoBank_2026.pdf',
      }),
    ).toMatchObject({ bank: 'boursobank', accountType: 'epargne', currency: 'EUR' });

    expect(
      inferAccountMetadata({
        bank: 'revolut',
        fileName: 'Revolut_Statement_USD_2026_11.pdf',
        textSample: 'Account Statement USD\nOpening balance $1,200.00',
      }),
    ).toMatchObject({ bank: 'revolut', accountType: 'multi_devises', currency: 'USD' });

    expect(
      inferAccountMetadata({
        bank: 'revolut',
        fileName: 'Revolut_Vault_Vacances_2026.pdf',
      }),
    ).toMatchObject({ bank: 'revolut', accountType: 'coffre', currency: 'EUR' });
  });
});

describe('PDF boilerplate removal, bounded batching & pdfjs guard', () => {
  it('strips repetitive legal headers, RGPD notices, pagination and repeated RIB lines while preserving transactions', () => {
    const pages: readonly PdfPageText[] = [
      {
        pageNumber: 1,
        rawText: [
          'BoursoBank - SA au capital de 51 171 597,60 EUR - RCS Nanterre 351 058 151',
          'IBAN : FR76 4061 8802 9000 0401 2345 678',
          'Relevé de compte courant - Période du 01/11/2026 au 30/11/2026',
          '10/11/2026 CB CARREFOUR MARKET -45,20 EUR',
          '12/11/2026 VIR SALAIRE ACME +2850,00 EUR',
          'Document à conserver sans limitation de durée - RGPD données personnelles',
          'Page 1 / 2',
        ].join('\n'),
      },
      {
        pageNumber: 2,
        rawText: [
          'BoursoBank - SA au capital de 51 171 597,60 EUR - RCS Nanterre 351 058 151',
          'IBAN : FR76 4061 8802 9000 0401 2345 678',
          '15/11/2026 PRLV EDF PART -82,10 EUR',
          '30/11/2026 Solde de clôture +4128,40 EUR',
          'Médiateur de la consommation - ORIAS n° 07 022 916',
          'Page 2 / 2',
        ].join('\n'),
      },
    ];

    const cleaned = stripBankingBoilerplate(pages);
    expect(cleaned.totalPages).toBe(2);
    expect(cleaned.removedLineCount).toBeGreaterThanOrEqual(8);

    const combined = cleaned.pages.map((p) => p.rawText).join('\n');
    expect(combined).toContain('10/11/2026 CB CARREFOUR MARKET -45,20 EUR');
    expect(combined).toContain('12/11/2026 VIR SALAIRE ACME +2850,00 EUR');
    expect(combined).toContain('15/11/2026 PRLV EDF PART -82,10 EUR');
    expect(combined).toContain('30/11/2026 Solde de clôture +4128,40 EUR');
    expect(combined).not.toContain('RCS Nanterre');
    expect(combined).not.toContain('ORIAS');
    expect(combined).not.toContain('Page 1 / 2');
    expect(combined).not.toContain('RGPD');
  });

  it('splits large statements into resilient bounded batches without splitting lines', () => {
    const pages: PdfPageText[] = Array.from({ length: 7 }, (_, i) => ({
      pageNumber: i + 1,
      rawText: `2026-11-0${i + 1} OPERATION ${i + 1} -1000 EUR\n`.repeat(8).trim(),
    }));

    const batches = splitPagesIntoBatches(pages, {
      maxPagesPerBatch: 3,
      maxCharsPerBatch: 650,
    });

    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < batches.length; i += 1) {
      const b = batches[i];
      expect(b?.batchIndex).toBe(i);
      expect(b?.totalBatches).toBe(batches.length);
      expect(b?.charCount).toBeLessThanOrEqual(650);
    }

    const joined = batches.map((b) => b.text).join('\n');
    for (let i = 1; i <= 7; i += 1) {
      expect(joined).toContain(`OPERATION ${i}`);
    }
  });

  it('rejects empty or invalid PDF binary bytes cleanly with PdfUnreadableError', async () => {
    await expect(extractPdfPagesWithPdfjs(new Uint8Array())).rejects.toThrow(
      /vide|PDF_UNREADABLE|pdfjs/iu,
    );
  });
});

describe('Gemini 3-model fallback chain & strict Zod zero-float validation', () => {
  const sampleBatch = {
    batchIndex: 0,
    totalBatches: 1,
    pageStart: 1,
    pageEnd: 1,
    text: '18/11/2026 CURSOR AI -20.00 USD',
    charCount: 31,
  };

  it('falls back across gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.1-flash-lite and succeeds on 3rd model', async () => {
    const calledModels: string[] = [];
    const client: GeminiModelClient = {
      async generateStructuredStatement(req) {
        calledModels.push(req.model);
        if (req.model === 'gemini-4-hydrogen') {
          return {
            ok: false,
            errorCode: 'GEMINI_TIMEOUT',
            message: '504 Gateway Timeout',
          };
        }
        if (req.model === 'gemini-3.8-flash') {
          // Return invalid float to verify Zod rejection triggers fallback to 3rd model
          return {
            ok: true,
            rawJsonText: JSON.stringify({
              statement_period_start: '2026-11-01',
              statement_period_end: '2026-11-30',
              accounts: [
                {
                  detected_name: 'Revolut USD',
                  external_ref_masked: 'REV-USD-01',
                  account_type: 'multi_devises',
                  currency: 'USD',
                  closing_balance_cents: 185000,
                },
              ],
              transactions: [
                {
                  account_ref_masked: 'REV-USD-01',
                  currency: 'USD',
                  booking_date: '2026-11-18',
                  value_date: '2026-11-18',
                  raw_label: 'CURSOR AI',
                  clean_label: 'Cursor AI',
                  amount_cents: -20.5,
                },
              ],
            }),
          };
        }
        return {
          ok: true,
          rawJsonText: JSON.stringify({
            statement_period_start: '2026-11-01',
            statement_period_end: '2026-11-30',
            accounts: [
              {
                detected_name: 'Revolut USD',
                external_ref_masked: 'REV-USD-01',
                account_type: 'multi_devises',
                currency: 'USD',
                closing_balance_cents: 185000,
              },
            ],
            transactions: [
              {
                account_ref_masked: 'REV-USD-01',
                currency: 'USD',
                booking_date: '2026-11-18',
                value_date: '2026-11-18',
                raw_label: 'CURSOR AI *MONTHLY',
                clean_label: 'Cursor AI',
                amount_cents: -2000,
              },
            ],
          }),
        };
      },
    };

    const result = await extractBatchWithFallback({
      client,
      bank: 'revolut',
      fileName: 'Revolut_USD_2026_11.pdf',
      inferredAccountType: 'multi_devises',
      inferredCurrency: 'USD',
      batch: sampleBatch,
    });

    expect(calledModels).toEqual([...GEMINI_FALLBACK_MODELS]);
    expect(result.modelUsed).toBe('gemini-3.1-flash-lite');
    expect(result.extraction.transactions[0]?.amount_cents).toBe(-2000);
  });

  it('throws PipelineStepError with canonical code when all 3 models fail', async () => {
    const client: GeminiModelClient = {
      async generateStructuredStatement() {
        return {
          ok: false,
          errorCode: 'GEMINI_QUOTA_EXCEEDED',
          message: '429 Too Many Requests',
        };
      },
    };

    await expect(
      extractBatchWithFallback({
        client,
        bank: 'boursobank',
        fileName: 'Bourso_2026_11.pdf',
        inferredAccountType: 'courant',
        inferredCurrency: 'EUR',
        batch: sampleBatch,
      }),
    ).rejects.toMatchObject({
      name: 'PipelineStepError',
      code: 'GEMINI_QUOTA_EXCEEDED',
    } satisfies Partial<PipelineStepError>);
  });

  it('sends GEMINI_API_KEY via x-goog-api-key header rather than URL query string', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const httpClient = createHttpGeminiClient({
      apiKey: 'secret-gemini-api-key',
      fetchFn: fetchMock,
    });

    const res = await httpClient.generateStructuredStatement({
      model: 'gemini-4-hydrogen',
      prompt: 'extract',
      timeoutMs: 5000,
    });

    expect(res).toEqual({ ok: true, rawJsonText: '{"ok":true}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const requestedUrl = typeof call?.[0] === 'string' ? call[0] : String(call?.[0]);
    expect(requestedUrl).not.toContain('key=');
    expect(requestedUrl).not.toContain('secret-gemini-api-key');
    expect(call?.[1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'secret-gemini-api-key',
    });
  });
});

describe('fx_rate_micro conversion & Revolut EUR <-> USD internal transfer detection', () => {
  it('resolves exact cached rate, ECB fetch, and nearest business day fallback for weekends without float drift', async () => {
    const store = new InMemoryNeonCheckpointStore();
    await store.saveRate({
      rateDate: '2026-11-13', // Friday
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rateMicro: toFxRateMicro(924500),
      source: 'ecb_reference',
    });

    const fxService = createFxRateService({ store });

    // Weekend Sunday 2026-11-15 falls back to Friday 2026-11-13
    const weekendRate = await fxService.resolveRateMicro({
      rateDate: '2026-11-15',
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
    });
    expect(weekendRate).toEqual({
      rateMicro: toFxRateMicro(924500),
      source: 'nearest_business_day',
    });

    // Bidirectional EUR -> USD via inverse rate
    const inverseRate = await fxService.resolveRateMicro({
      rateDate: '2026-11-13',
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
    });
    expect(inverseRate.rateMicro).toBe(toFxRateMicro(1081666));

    // Exact integer cents conversion: -$20.00 at 0.924500 = -1849 cents (-18.49 EUR)
    const eurCents = convertAmountCents(
      toCents(-2000),
      'USD',
      'EUR',
      weekendRate.rateMicro,
    );
    expect(eurCents).toBe(toCents(-1849));

    // Identity EUR -> EUR
    const sameRate = await fxService.resolveRateMicro({
      rateDate: '2026-11-15',
      baseCurrency: 'EUR',
      quoteCurrency: 'EUR',
    });
    expect(sameRate.rateMicro).toBe(EUR_FX_RATE_MICRO);
  });

  it('pairs BoursoBank <-> Revolut transfers and Revolut EUR <-> USD internal FX conversions', () => {
    const pairs = matchInternalTransferPairs([
      {
        id: 'tx-bourso-out',
        accountId: 'acc-bourso',
        bank: 'boursobank',
        currency: 'EUR',
        bookingDate: '2026-11-10',
        amountCents: -50000,
        amountEurCents: -50000,
        rawLabel: 'VIR INSTANTANE REVOLUT',
        cleanLabel: 'Virement Revolut',
        transferGroupId: null,
        isManualTransferOverride: false,
        deletedAt: null,
      },
      {
        id: 'tx-rev-in',
        accountId: 'acc-rev-eur',
        bank: 'revolut',
        currency: 'EUR',
        bookingDate: '2026-11-11',
        amountCents: 50000,
        amountEurCents: 50000,
        rawLabel: 'Top-up from BoursoBank',
        cleanLabel: 'Top-up BoursoBank',
        transferGroupId: null,
        isManualTransferOverride: false,
        deletedAt: null,
      },
      {
        id: 'tx-rev-fx-eur',
        accountId: 'acc-rev-eur',
        bank: 'revolut',
        currency: 'EUR',
        bookingDate: '2026-11-15',
        amountCents: -10000,
        amountEurCents: -10000,
        rawLabel: 'Exchanged to USD',
        cleanLabel: 'Exchanged to USD',
        transferGroupId: null,
        isManualTransferOverride: false,
        deletedAt: null,
      },
      {
        id: 'tx-rev-fx-usd',
        accountId: 'acc-rev-usd',
        bank: 'revolut',
        currency: 'USD',
        bookingDate: '2026-11-15',
        amountCents: 10800,
        amountEurCents: 9936,
        rawLabel: 'Exchanged from EUR',
        cleanLabel: 'Exchanged from EUR',
        transferGroupId: null,
        isManualTransferOverride: false,
        deletedAt: null,
      },
    ]);

    expect(pairs).toHaveLength(2);
    expect(pairs.find((p) => p.kind === 'same_currency')).toMatchObject({
      debitTxId: 'tx-bourso-out',
      creditTxId: 'tx-rev-in',
      dateDeltaDays: 1,
    });
    expect(pairs.find((p) => p.kind === 'revolut_fx_exchange')).toMatchObject({
      debitTxId: 'tx-rev-fx-eur',
      creditTxId: 'tx-rev-fx-usd',
      eurDeltaCents: 64,
    });
  });
});

describe('Checkpoint SQL persistence & exact resume without loss or duplicates', () => {
  it('resumes a failed multi-batch PDF from the exact failed batch, skips committed files by md5, and avoids duplicate transactions', async () => {
    const store = new InMemoryNeonCheckpointStore();
    await store.saveRate({
      rateDate: '2026-11-15',
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rateMicro: toFxRateMicro(920000),
      source: 'ecb_reference',
    });

    const boursoPdfBytes = new TextEncoder().encode('bourso-pdf');
    const revolutPdfBytes = new TextEncoder().encode('revolut-multi-batch-pdf');

    const discoveredFiles: readonly DiscoveredDrivePdf[] = [
      {
        driveFileId: parseDriveFileId('file-bourso-nov'),
        driveFolderId: ALLOWED_DRIVE_FOLDERS.boursobank,
        bank: 'boursobank',
        fileName: 'Bourso_2026_11.pdf',
        md5Checksum: createHash('md5').update('bourso-v1').digest('hex'),
        fileSizeBytes: boursoPdfBytes.byteLength,
        driveModifiedTime: new Date('2026-11-20T10:00:00.000Z'),
      },
      {
        driveFileId: parseDriveFileId('file-revolut-nov'),
        driveFolderId: ALLOWED_DRIVE_FOLDERS.revolut,
        bank: 'revolut',
        fileName: 'Revolut_Multi_2026_11.pdf',
        md5Checksum: createHash('md5').update('revolut-v1').digest('hex'),
        fileSizeBytes: revolutPdfBytes.byteLength,
        driveModifiedTime: new Date('2026-11-20T10:05:00.000Z'),
      },
    ];

    const driveClient = {
      listFolderPdfFiles: vi.fn(async () => discoveredFiles),
      discoverAllAllowedPdfs: vi.fn(async () => discoveredFiles),
      downloadPdfFile: vi.fn(async ({ driveFileId }: { driveFileId: string }) =>
        driveFileId === 'file-bourso-nov' ? boursoPdfBytes : revolutPdfBytes,
      ),
    };

    // Revolut PDF has 5 pages -> 2 batches (maxPagesPerBatch=4 in pipeline)
    const extractPdfPages = vi.fn(async (bytes: Uint8Array) => {
      if (bytes === boursoPdfBytes) {
        return [{ pageNumber: 1, rawText: '10/11/2026 VIR REVOLUT -500,00 EUR' }];
      }
      return Array.from({ length: 5 }, (_, idx) => ({
        pageNumber: idx + 1,
        rawText: `2026-11-15 REVOLUT PAGE ${idx + 1} LINE`,
      }));
    });

    let failRevolutBatch2 = true;
    const geminiPromptsSeen: string[] = [];
    const geminiClient: GeminiModelClient = {
      async generateStructuredStatement(req) {
        geminiPromptsSeen.push(req.prompt);
        if (req.prompt.includes('Bourso_2026_11.pdf')) {
          return {
            ok: true,
            rawJsonText: JSON.stringify({
              statement_period_start: '2026-11-01',
              statement_period_end: '2026-11-30',
              accounts: [
                {
                  detected_name: 'BoursoBank Courant',
                  external_ref_masked: 'FR76****4821',
                  account_type: 'courant',
                  currency: 'EUR',
                  closing_balance_cents: 412840,
                },
              ],
              transactions: [
                {
                  account_ref_masked: 'FR76****4821',
                  currency: 'EUR',
                  booking_date: '2026-11-10',
                  value_date: '2026-11-10',
                  raw_label: 'VIR INSTANTANE REVOLUT',
                  clean_label: 'Virement Revolut',
                  amount_cents: -50000,
                },
              ],
            }),
          };
        }

        if (req.prompt.includes('Lot 1/2')) {
          return {
            ok: true,
            rawJsonText: JSON.stringify({
              statement_period_start: '2026-11-01',
              statement_period_end: '2026-11-15',
              accounts: [
                {
                  detected_name: 'Revolut EUR',
                  external_ref_masked: 'REV-EUR-MAIN',
                  account_type: 'courant',
                  currency: 'EUR',
                  closing_balance_cents: 120000,
                },
              ],
              transactions: [
                {
                  account_ref_masked: 'REV-EUR-MAIN',
                  currency: 'EUR',
                  booking_date: '2026-11-11',
                  value_date: '2026-11-11',
                  raw_label: 'Top-up from BoursoBank',
                  clean_label: 'Top-up BoursoBank',
                  amount_cents: 50000,
                },
                {
                  account_ref_masked: 'REV-EUR-MAIN',
                  currency: 'EUR',
                  booking_date: '2026-11-15',
                  value_date: '2026-11-15',
                  raw_label: 'Exchanged to USD',
                  clean_label: 'Exchanged to USD',
                  amount_cents: -10000,
                },
              ],
            }),
          };
        }

        // Lot 2/2 fails on Run 1 across all 3 models, succeeds on Run 2
        if (failRevolutBatch2) {
          return {
            ok: false,
            errorCode: 'GEMINI_TIMEOUT',
            message: 'Simulated 504 timeout on batch 2',
          };
        }

        return {
          ok: true,
          rawJsonText: JSON.stringify({
            statement_period_start: '2026-11-15',
            statement_period_end: '2026-11-30',
            accounts: [
              {
                detected_name: 'Revolut USD',
                external_ref_masked: 'REV-USD-MAIN',
                account_type: 'multi_devises',
                currency: 'USD',
                closing_balance_cents: 10800,
              },
            ],
            transactions: [
              {
                account_ref_masked: 'REV-USD-MAIN',
                currency: 'USD',
                booking_date: '2026-11-15',
                value_date: '2026-11-15',
                raw_label: 'Exchanged from EUR',
                clean_label: 'Exchanged from EUR',
                amount_cents: 10800,
              },
            ],
          }),
        };
      },
    };

    const fxRateService = createFxRateService({ store });

    // RUN 1: Bourso commits, Revolut fails at Lot 2/2 (Lot 1/2 saved in checkpoint!)
    const run1 = await runIngestionPipeline({
      driveClient,
      geminiClient,
      checkpointStore: store,
      fxRateService,
      extractPdfPages,
    });

    expect(run1.status).toBe('partial_error');
    expect(run1.filesCommitted).toBe(1);
    expect(run1.filesFailed).toBe(1);
    expect(run1.fileResults[1]).toMatchObject({
      driveFileId: 'file-revolut-nov',
      status: 'failed',
      errorCode: 'GEMINI_TIMEOUT',
    });

    const revRecordId = store.driveFilesByComposite.get(
      `file-revolut-nov|${discoveredFiles[1]?.md5Checksum}`,
    );
    const revCheckpoint = revRecordId
      ? store.checkpointsByDriveFileRecordId.get(revRecordId)
      : undefined;
    expect(revCheckpoint?.status).toBe('failed');
    expect(revCheckpoint?.parsedPayload).toMatchObject({
      kind: 'partial_batches',
      totalBatches: 2,
    });

    // RUN 2: Retry -> Bourso is skipped by md5, Revolut resumes ONLY at Lot 2/2!
    geminiPromptsSeen.length = 0;
    failRevolutBatch2 = false;

    const run2 = await runIngestionPipeline({
      driveClient,
      geminiClient,
      checkpointStore: store,
      fxRateService,
      extractPdfPages,
    });

    expect(run2.status).toBe('completed');
    expect(run2.filesSkippedUnchanged).toBe(1);
    expect(run2.filesCommitted).toBe(1);
    expect(run2.filesFailed).toBe(0);

    // Verify Gemini was ONLY called for Lot 2/2 of Revolut (zero re-call for Bourso or Lot 1/2)
    expect(geminiPromptsSeen).toHaveLength(1);
    expect(geminiPromptsSeen[0]).toContain('Lot 2/2');

    // Verify checkpoint purged payload after commit & internal transfers were paired!
    expect(revCheckpoint?.status).toBe('committed');
    expect(revCheckpoint?.parsedPayload).toBeNull();
    expect(store.transactionsByDedupHash.size).toBe(4);
    for (const tx of store.transactionsByDedupHash.values()) {
      expect(tx.isInternalTransfer).toBe(true);
      expect(tx.category).toBe('Transfert interne');
      expect(tx.transferGroupId).not.toBeNull();
    }

    // RUN 3: Overlapping file (new md5) containing same Bourso transaction -> dedup_hash prevents duplicate!
    const firstFile = discoveredFiles[0];
    if (firstFile === undefined) {
      throw new Error('Expected first discovered file');
    }
    const overlappingBoursoFile: DiscoveredDrivePdf = {
      ...firstFile,
      md5Checksum: createHash('md5').update('bourso-v2-overlap').digest('hex'),
    };
    driveClient.discoverAllAllowedPdfs.mockResolvedValueOnce([overlappingBoursoFile]);

    // First simulate DB failure during Phase 2 commit -> checkpoint stays 'parsed'
    store.failNextCommitCount = 1;
    const run3FailCommit = await runIngestionPipeline({
      driveClient,
      geminiClient,
      checkpointStore: store,
      fxRateService,
      extractPdfPages,
    });
    expect(run3FailCommit.status).toBe('failed');

    // Retry after DB recovery: checkpoint resumes straight from 'parsed' with 0 Gemini calls and 0 duplicate rows!
    geminiPromptsSeen.length = 0;
    driveClient.discoverAllAllowedPdfs.mockResolvedValueOnce([overlappingBoursoFile]);
    const run4ResumeParsed = await runIngestionPipeline({
      driveClient,
      geminiClient,
      checkpointStore: store,
      fxRateService,
      extractPdfPages,
    });

    expect(run4ResumeParsed.status).toBe('completed');
    expect(geminiPromptsSeen).toHaveLength(0);
    expect(run4ResumeParsed.fileResults[0]?.dedupSkippedTxCount).toBe(1);
    expect(run4ResumeParsed.fileResults[0]?.insertedTxCount).toBe(0);
    expect(store.transactionsByDedupHash.size).toBe(4);
  });

  it('refuses out-of-scope folders before touching PDF extraction', async () => {
    const driveClient = createGoogleDriveClient({
      getAccessToken: () => 'drive-token',
      fetchFn: async () => new Response(JSON.stringify({ files: [] }), { status: 200 }),
    });

    await expect(
      driveClient.downloadPdfFile({
        driveFileId: 'file-bad',
        driveFolderId: 'other-folder',
      }),
    ).rejects.toThrowError(InvalidDriveFolderScopeError);

    expect(() => assertAllowedDriveFolderId('other-folder')).toThrowError(
      InvalidDriveFolderScopeError,
    );
  });

  it('validates NeonCheckpointStore requires sslmode=require', () => {
    expect(
      () => new NeonCheckpointStore('postgresql://user:pass@ep.neon.tech/clairflux'),
    ).toThrow(/sslmode=require/u);

    const store = new NeonCheckpointStore(
      'postgresql://user:pass@ep.neon.tech/clairflux?sslmode=require',
    );
    expect(store).toBeInstanceOf(NeonCheckpointStore);
    return store.close();
  });
});

describe('Worker internal HTTP server & INTERNAL_WORKER_TOKEN auth', () => {
  const VALID_WORKER_TOKEN = 'internal-worker-secret-token-32-chars';

  it('validates WorkerEnvSchema strictly with Zod', () => {
    expect(() =>
      parseWorkerEnv({
        DATABASE_URL: 'postgresql://user:pass@ep.neon.tech/clairflux',
        GEMINI_API_KEY: 'gem-key',
        GOOGLE_DRIVE_ACCESS_TOKEN: 'drive-token',
        INTERNAL_WORKER_TOKEN: VALID_WORKER_TOKEN,
      }),
    ).toThrowError(WorkerEnvValidationError);

    const env = parseWorkerEnv({
      DATABASE_URL: 'postgresql://user:pass@ep.neon.tech/clairflux?sslmode=require',
      GEMINI_API_KEY: 'gem-key',
      GOOGLE_DRIVE_ACCESS_TOKEN: 'drive-token',
      INTERNAL_WORKER_TOKEN: VALID_WORKER_TOKEN,
      PORT: '4001',
    });
    expect(env.PORT).toBe(4001);
  });

  it('serves /healthz publicly and enforces INTERNAL_WORKER_TOKEN + folder scope + concurrency on POST /internal/runs', async () => {
    const triggerSync = vi.fn<
      (input: { readonly runId?: string | undefined; readonly driveFileId?: string | undefined }) => Promise<TriggerWorkerRunResult>
    >(async (input) => ({
      ok: true,
      runId: input.runId ?? '11111111-1111-4111-8111-111111111111',
      acceptedAt: '2026-11-21T15:00:00.000Z',
    }));

    const app = createWorkerApp({
      internalWorkerToken: VALID_WORKER_TOKEN,
      triggerSync,
    });

    const healthRes = await app.request('/healthz');
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({
      status: 'ok',
      service: 'sync-worker',
    });

    const unauthRes = await app.request('/internal/runs', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(unauthRes.status).toBe(401);

    const wrongTokenRes = await app.request('/internal/runs', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token-value',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(wrongTokenRes.status).toBe(401);

    const forbiddenScopeRes = await app.request('/internal/runs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_WORKER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folder_id: 'unauthorized-folder' }),
    });
    expect(forbiddenScopeRes.status).toBe(403);

    const okRes = await app.request('/internal/runs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_WORKER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        run_id: '22222222-2222-4222-8222-222222222222',
        drive_file_id: 'file-rev-1',
      }),
    });
    expect(okRes.status).toBe(202);
    expect(triggerSync).toHaveBeenCalledWith({
      runId: '22222222-2222-4222-8222-222222222222',
      driveFileId: 'file-rev-1',
    });

    triggerSync.mockResolvedValueOnce({
      ok: false,
      reason: 'already_running',
      activeRunId: '22222222-2222-4222-8222-222222222222',
    });
    const conflictRes = await app.request('/internal/runs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VALID_WORKER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(conflictRes.status).toBe(409);
  });

  it('finalise le run en statut failed quand discoverAllAllowedPdfs échoue (évite le verrou HTTP 409 permanent)', async () => {
    const store = new InMemoryNeonCheckpointStore();
    const fxRateService = createFxRateService({ store });
    const runId = '33333333-3333-4333-8333-333333333333';

    const failingDriveClient: GoogleDriveClient = {
      listFolderPdfFiles: vi.fn(async () => []),
      discoverAllAllowedPdfs: vi.fn(async () => {
        throw new DriveDownloadError(
          'Google Drive API a répondu HTTP 401 lors du scan du dossier 1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h.',
          401,
        );
      }),
      downloadPdfFile: vi.fn(async () => new Uint8Array()),
    };

    const geminiClient: GeminiModelClient = {
      generateStructuredStatement: vi.fn(async () => ({
        ok: true as const,
        rawJsonText: '{}',
      })),
    };

    const result = await runIngestionPipeline(
      {
        driveClient: failingDriveClient,
        geminiClient,
        checkpointStore: store,
        fxRateService,
      },
      { runId },
    );

    expect(result.status).toBe('failed');
    expect(result.totalFilesDiscovered).toBe(0);
    const storedRun = store.runs.get(runId);
    expect(storedRun?.status).toBe('failed');
    expect(storedRun?.errorSummary).toContain('HTTP 401');
  });

  it('expose GET /internal/runs/active protégé par token et valide WorkerEnvSchema avec GOOGLE_DRIVE_CREDENTIALS_PATH', async () => {
    const app = createWorkerApp({
      internalWorkerToken: VALID_WORKER_TOKEN,
      getActiveRunId: () => '44444444-4444-4444-8444-444444444444',
      triggerSync: vi.fn(async () => ({
        ok: true as const,
        runId: '44444444-4444-4444-8444-444444444444',
        acceptedAt: '2026-11-24T10:00:00.000Z',
      })),
    });

    const unauthActive = await app.request('/internal/runs/active');
    expect(unauthActive.status).toBe(401);

    const authActive = await app.request('/internal/runs/active', {
      headers: { 'X-Internal-Worker-Token': VALID_WORKER_TOKEN },
    });
    expect(authActive.status).toBe(200);
    expect(await authActive.json()).toEqual({
      active_run_id: '44444444-4444-4444-8444-444444444444',
    });

    const envFromCredsPath = parseWorkerEnv({
      DATABASE_URL: 'postgresql://user:pass@ep.neon.tech/clairflux?sslmode=require',
      GEMINI_API_KEY: 'gem-key',
      GOOGLE_DRIVE_CREDENTIALS_PATH: '/run/secrets/google_drive_credentials.json',
      INTERNAL_WORKER_TOKEN: VALID_WORKER_TOKEN,
    });
    expect(envFromCredsPath.GOOGLE_DRIVE_CREDENTIALS_PATH).toBe(
      '/run/secrets/google_drive_credentials.json',
    );

    expect(() =>
      parseWorkerEnv({
        DATABASE_URL: 'postgresql://user:pass@ep.neon.tech/clairflux?sslmode=require',
        GEMINI_API_KEY: 'gem-key',
        INTERNAL_WORKER_TOKEN: VALID_WORKER_TOKEN,
      }),
    ).toThrowError(WorkerEnvValidationError);
  });

  it('génère et met en cache les jetons Google Drive depuis un Service Account JSON ou OAuth2 refresh_token', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    let tokenCalls = 0;
    const saProvider = createDriveAccessTokenProvider({
      credentialsPath: '/run/secrets/google_drive_credentials.json',
      staticAccessToken: 'CHANGE_ME_PLACEHOLDER',
      readCredentialsFile: async () =>
        JSON.stringify({
          type: 'service_account',
          client_email: 'clairflux@example.iam.gserviceaccount.com',
          private_key: privateKeyPem,
        }),
      fetchFn: async (input, init) => {
        tokenCalls += 1;
        expect(String(input)).toBe('https://oauth2.googleapis.com/token');
        expect(String(init?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
        return new Response(JSON.stringify({ access_token: 'sa-access-token', expires_in: 3600 }), {
          status: 200,
        });
      },
    });

    expect(await saProvider()).toBe('sa-access-token');
    expect(await saProvider()).toBe('sa-access-token');
    expect(tokenCalls).toBe(1);

    const refreshProvider = createDriveAccessTokenProvider({
      credentialsPath: '/run/secrets/oauth.json',
      readCredentialsFile: async () =>
        JSON.stringify({
          type: 'authorized_user',
          client_id: 'cid',
          client_secret: 'csec',
          refresh_token: 'rtok',
        }),
      fetchFn: async (_input, init) => {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        return new Response(JSON.stringify({ access_token: 'oauth-refreshed-token' }), {
          status: 200,
        });
      },
    });
    expect(await refreshProvider()).toBe('oauth-refreshed-token');

    const incompleteClientProvider = createDriveAccessTokenProvider({
      credentialsPath: '/run/secrets/installed.json',
      staticAccessToken: 'CHANGE_ME_GOOGLE_DRIVE_READONLY_TOKEN',
      readCredentialsFile: async () =>
        JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csec' } }),
    });
    await expect(incompleteClientProvider()).rejects.toThrowError(DriveDownloadError);
  });

  it('associe physiquement BoursoBank à 1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h et Revolut à 1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus', () => {
    expect(ALLOWED_DRIVE_FOLDERS.boursobank).toBe('1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h');
    expect(ALLOWED_DRIVE_FOLDERS.revolut).toBe('1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus');
  });

  it('remonte le message détaillé du corps HTTP Gemini en cas d erreur API et tolère les blocs JSON markdown', async () => {
    const errorClient = createHttpGeminiClient({
      apiKey: 'secret-gemini-api-key',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error: { code: 400, message: 'API key not valid. Please pass a valid API key.' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const errRes = await errorClient.generateStructuredStatement({
      model: 'gemini-4-hydrogen',
      prompt: 'test',
      timeoutMs: 5000,
    });
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) {
      expect(errRes.message).toContain('API key not valid');
      expect(errRes.message).not.toContain('secret-gemini-api-key');
    }

    const markdownClient: GeminiModelClient = {
      generateStructuredStatement: vi.fn(async () => ({
        ok: true as const,
        rawJsonText: [
          '```json',
          JSON.stringify({
            statement_period_start: '2026-10-01',
            statement_period_end: '2026-10-31',
            accounts: [
              {
                detected_name: 'Revolut EUR',
                external_ref_masked: 'REV-****1234',
                account_type: 'multi_devises',
                currency: 'EUR',
                opening_balance_cents: 10000,
                closing_balance_cents: 9000,
              },
            ],
            transactions: [
              {
                account_ref_masked: 'REV-****1234',
                currency: 'EUR',
                booking_date: '2026-10-05',
                value_date: '2026-10-05',
                raw_label: 'CARREFOUR',
                clean_label: 'Carrefour',
                amount_cents: -1000,
                statement_fx_rate_micro: null,
              },
            ],
          }),
          '```',
        ].join('\n'),
      })),
    };

    const extracted = await extractBatchWithFallback({
      client: markdownClient,
      bank: 'revolut',
      fileName: 'account-statement.pdf',
      inferredAccountType: 'multi_devises',
      inferredCurrency: 'EUR',
      batch: {
        batchIndex: 0,
        totalBatches: 1,
        pageStart: 1,
        pageEnd: 1,
        text: '05/10/2026 CARREFOUR -10.00 EUR',
        charCount: 31,
      },
    });
    expect(extracted.extraction.transactions).toHaveLength(1);
  });

  it('reconcileOrphanedRuns débloque aussi les checkpoints bloqués en extracting / committing', async () => {
    const store = new InMemoryNeonCheckpointStore();
    const runId = '55555555-5555-4555-8555-555555555555';
    await store.ensureRun(runId);

    const cp = await store.upsertDriveFileAndLoadCheckpoint({
      runId,
      file: {
        driveFileId: parseDriveFileId('1V1tPjIT2Fw6dSTXVfdg59hP4kMiaJUK8'),
        driveFolderId: ALLOWED_DRIVE_FOLDERS.revolut,
        bank: 'revolut',
        fileName: 'account-statement_2021-01-01_2021-12-31_fr-fr_2a7eb1.pdf',
        md5Checksum: 'cd73286388abe47eb280669dfbfc0568',
        fileSizeBytes: 597266,
        driveModifiedTime: new Date('2026-11-19T11:55:26.583Z'),
      },
    });
    await store.markFileExtracting({ checkpointId: cp.checkpointId, runId });

    const reconciled = await store.reconcileOrphanedRuns(
      'Synchronisation interrompue (redémarrage du service sync-worker).',
    );
    expect(reconciled).toBe(1);
    expect(store.runs.get(runId)?.status).toBe('failed');
    expect(store.checkpointsById.get(cp.checkpointId)?.status).toBe('failed');
    expect(store.checkpointsById.get(cp.checkpointId)?.errorCode).toBe('GEMINI_TIMEOUT');
    expect(store.checkpointsById.get(cp.checkpointId)?.errorMessage).toContain('redémarrage');
  });

  it('bascule sur l extraction OCR native Gemini (inlineData PDF) quand pdfjs échoue ou détecte un PDF scanné', async () => {
    const store = new InMemoryNeonCheckpointStore();
    const fxRateService = createFxRateService({ store });
    const runId = '66666666-6666-4666-8666-666666666666';
    const rawPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

    const driveClient: GoogleDriveClient = {
      listFolderPdfFiles: vi.fn(async () => []),
      discoverAllAllowedPdfs: vi.fn(async () => [
        {
          driveFileId: parseDriveFileId('1c_UHG0yek3m5-IAsOuSXUiZfPCuVTCeH'),
          driveFolderId: ALLOWED_DRIVE_FOLDERS.boursobank,
          bank: 'boursobank' as const,
          fileName: 'Releve-compte-principal-31-08-2026.pdf',
          md5Checksum: createHash('md5').update(rawPdfBytes).digest('hex'),
          fileSizeBytes: rawPdfBytes.byteLength,
          driveModifiedTime: new Date('2026-11-24T12:00:00.000Z'),
        },
      ]),
      downloadPdfFile: vi.fn(async () => rawPdfBytes),
    };

    const requestsSeen: Array<{ readonly pdfInlineBase64?: string | undefined; readonly prompt: string }> = [];
    const geminiClient: GeminiModelClient = {
      generateStructuredStatement: vi.fn(async (req) => {
        requestsSeen.push({ pdfInlineBase64: req.pdfInlineBase64, prompt: req.prompt });
        return {
          ok: true as const,
          rawJsonText: JSON.stringify({
            statement_period_start: '2026-08-01',
            statement_period_end: '2026-08-31',
            accounts: [
              {
                detected_name: 'Compte Principal BoursoBank',
                external_ref_masked: 'FR76****8899',
                account_type: 'courant',
                currency: 'EUR',
                opening_balance_cents: 250000,
                closing_balance_cents: 245000,
              },
            ],
            transactions: [
              {
                account_ref_masked: 'FR76****8899',
                currency: 'EUR',
                booking_date: '2026-08-15',
                value_date: '2026-08-15',
                raw_label: 'CB BOULANGERIE',
                clean_label: 'Boulangerie',
                amount_cents: -5000,
                statement_fx_rate_micro: null,
              },
            ],
          }),
        };
      }),
    };

    const failingPdfjs = vi.fn(async () => {
      throw new Error('Simulated pdfjs worker crash or scanned image PDF');
    });

    const result = await runIngestionPipeline(
      {
        driveClient,
        geminiClient,
        checkpointStore: store,
        fxRateService,
        extractPdfPages: failingPdfjs,
      },
      { runId },
    );

    expect(result.status).toBe('completed');
    expect(result.filesCommitted).toBe(1);
    expect(requestsSeen).toHaveLength(1);
    expect(requestsSeen[0]?.pdfInlineBase64).toBe(Buffer.from(rawPdfBytes).toString('base64'));
    expect(store.transactionsByDedupHash.size).toBe(1);

    // Also verify createHttpGeminiClient sends inlineData in HTTP body when pdfInlineBase64 is set
    let sentBody = '';
    const httpClient = createHttpGeminiClient({
      apiKey: 'secret-key',
      fetchFn: async (_input, init) => {
        sentBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{}' }] } }],
          }),
          { status: 200 },
        );
      },
    });
    await httpClient.generateStructuredStatement({
      model: 'gemini-4-hydrogen',
      prompt: 'Extract OCR',
      timeoutMs: 5000,
      pdfInlineBase64: 'JVBERi0xLjQ=',
    });
    expect(sentBody).toContain('"mimeType":"application/pdf"');
    expect(sentBody).toContain('"data":"JVBERi0xLjQ="');
  });

  it('exécute pdfjs dans un sous-processus isolé et protège le worker si le PDF est corrompu', async () => {
    const minimalPdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 58>>stream\nBT /F1 12 Tf 72 720 Td (12/01/2026 Carrefour -42,50 EUR) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \n0000000212 00000 n \n0000000319 00000 n \ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n387\n%%EOF',
    );
    const pages = await extractPdfPagesInSubprocess(new Uint8Array(minimalPdf));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.rawText).toContain('Carrefour');

    await expect(
      extractPdfPagesInSubprocess(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrowError();
  });
});
