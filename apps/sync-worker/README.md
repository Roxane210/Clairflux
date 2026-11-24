# `@clairflux/sync-worker`

Service isolé Node 22 LTS (Hono) dédié à l'ingestion manuelle des relevés PDF depuis les 2 dossiers exclusifs Google Drive, à l'extraction structurée via Gemini (chaîne de fallback à 3 modèles) et au commit transactionnel atomique dans PostgreSQL Serverless Neon.

---

## Interface

### 1. Découverte Drive, extraction PDF & découpage borné ([`src/drive-pdf.ts`](./src/drive-pdf.ts))
- **Périmètre Drive exclusif** :
  - `ALLOWED_DRIVE_FOLDER_ENTRIES` & `assertAllowedDriveFolderId(folderId)` : verrouille strictement `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` (`boursobank`) et `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` (`revolut`), lève `InvalidDriveFolderScopeError` (`INVALID_DRIVE_FOLDER_SCOPE`) sur tout autre dossier.
  - `createGoogleDriveClient(options)` : `listFolderPdfFiles(folderId)`, `discoverAllAllowedPdfs()`, `downloadPdfFile({ driveFileId, driveFolderId })` avec timeout réseau et erreurs typées (`DriveDownloadError`).
- **Identification automatique Banque / Type de compte / Devise** :
  - `inferAccountMetadata({ bank, fileName, textSample })` (`AccountMetadataInferenceSchema`) : infère `accountType` (`courant`, `epargne`, `carte_differee`, `multi_devises`, `coffre`) et `currency` (`EUR` | `USD`).
- **Extraction texte & préparation par lots bornés** :
  - `extractPdfPagesWithPdfjs(pdfBytes)` : lecture page par page via `pdfjs-dist` (`PdfUnreadableError` si PDF vide ou corrompu).
  - `stripBankingBoilerplate(pages)` : élimine les mentions légales répétitives (RCS, ORIAS, FGDR, RGPD, Bank of Lithuania, IBAN/BIC de pied de page, pagination) tout en préservant 100 % des lignes d'opérations et de soldes.
  - `splitPagesIntoBatches(pages, options)` & `prepareDrivePdfBatches(...)` : découpe les pages nettoyées en lots bornés (`maxPagesPerBatch = 4`, `maxCharsPerBatch = 8_000`) pour prévenir tout timeout Gemini `504`.

### 2. Pipeline Gemini, FX, Checkpoints SQL & Serveur Interne ([`src/gemini-pipeline.ts`](./src/gemini-pipeline.ts))
- **Validation d'environnement fail-fast** :
  - `WorkerEnvSchema`, `parseWorkerEnv(rawEnv)`, `WorkerEnvValidationError` (`DATABASE_URL` avec `sslmode=require`, `GEMINI_API_KEY`, `GOOGLE_DRIVE_ACCESS_TOKEN`, `INTERNAL_WORKER_TOKEN >= 16 car.`, `PORT = 4001`, `NODE_ENV`).
- **Extraction Gemini structurée avec fallback 3 modèles** :
  - `GEMINI_FALLBACK_MODELS` : `['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']`.
  - `createHttpGeminiClient`, `buildStatementExtractionPrompt`, `extractBatchWithFallback`, `mergeBatchExtractions`.
  - Schémas Zod zéro-float : `GeminiExtractedAccountSchema`, `GeminiExtractedTransactionSchema`, `GeminiStatementExtractionSchema`, `CheckpointPayloadEnvelopeSchema` (`partial_batches` | `complete_statement`).
- **Conversion FX & cache historique (`fx_rate_micro`)** :
  - `invertFxRateMicro`, `convertAmountCents`, `createFxRateService({ store, fetchReferenceRate, maxLookbackDays })` : résout et met en cache les taux `EUR <-> USD` à la date d'opération (`revolut_statement`, `ecb_reference`, `nearest_business_day`).
- **Checkpoints SQL, déduplication & commit atomique Neon** :
  - `NeonCheckpointStore` (et `InMemoryCheckpointStore` pour tests) : `ensureRun`, `upsertDriveFileAndLoadCheckpoint`, `markFileSkipped`, `markFileExtracting`, `savePartialBatch`, `markFileParsed`, `commitParsedStatement`, `markFileFailed`, `finalizeRun`.
  - `runIngestionPipeline(deps, options)` : orchestrateur complet avec reprise exacte au lot/fichier (`partial_batches` ou `complete_statement`) sans ré-exécuter Gemini sur les lots déjà validés ni sur les fichiers déjà `committed` avec le même `md5_checksum`.
- **Serveur HTTP interne (`createWorkerApp`, `startWorkerRuntime`)** :
  - `GET /healthz` : sonde de santé Docker (`200 { status: "ok", service: "sync-worker" }`).
  - `POST /internal/runs` : déclenchement manuel interne protégé par `Authorization: Bearer <INTERNAL_WORKER_TOKEN>` ou `X-Internal-Worker-Token` (comparaison HMAC en temps constant `timingSafeEqual`), rejetant tout dossier non autorisé (`403 INVALID_DRIVE_FOLDER_SCOPE`) et tout run concurrent (`409 SYNC_ALREADY_RUNNING`).

---

## Invariants

1. **Exclusivité absolue des 2 dossiers Google Drive** :
   - Aucune découverte ni aucun téléchargement PDF ne peut cibler un parent hors de `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` (`boursobank`) et `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` (`revolut`), vérifié à la fois dans `drive-pdf.ts`, sur `/internal/runs` et par contrainte `CHECK` SQL dans `drive_files`.
2. **Zéro flottant comptable** :
   - Les soldes et montants extraits par Gemini sont validés par `CentsSchema` (entiers signés non nuls en centimes) et les taux de change par `FxRateMicroSchema` (`1.000000 = 1_000_000`). Tout float dans la réponse JSON Gemini est rejeté par Zod.
3. **Idempotence & reprise granulaire par lot et par fichier** :
   - Un fichier déjà `committed` avec le même `md5_checksum` passe immédiatement à `skipped` (zéro téléchargement PDF, zéro appel Gemini).
   - En cas d'échec sur le lot `k` ou lors du commit SQL, les lots `0..k-1` déjà sauvegardés dans `parsed_payload_json` (`partial_batches` / `complete_statement`) sont réutilisés lors de la relance, et l'échec d'un fichier n'interrompt pas les autres PDF du run (`partial_error`).
   - L'insertion SQL utilise `ON CONFLICT (dedup_hash) DO NOTHING` et ne supprime jamais l'historique existant ni le `nickname` personnalisé des comptes.
4. **Isolation réseau & secrets** :
   - Le service écoute uniquement sur le réseau Docker interne `backend_net` (port `4001`, aucun port hôte exposé), exige `sslmode=require` sur `DATABASE_URL` et protège `/internal/runs` par `INTERNAL_WORKER_TOKEN`.

---

## Side Effects

- **Appels HTTPS sortants Google Drive API v3** (`files.list`, `files.get?alt=media`) en lecture seule sur les 2 dossiers autorisés.
- **Appels HTTPS sortants Google Gemini API** (`v1beta/models/<model>:generateContent`) avec bascule automatique sur la chaîne `gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.1-flash-lite`.
- **Lectures et transactions SQL ACID sur Neon PostgreSQL** (`neon-http` + `Pool` WebSocket `drizzle-orm/neon-serverless`) mettant à jour `drive_sync_runs`, `drive_files`, `pdf_ingestion_checkpoints`, `fx_rates`, `accounts`, `transactions` et la séquence monotone `sync_revision_seq`.
- **Serveur HTTP interne Hono** sur le port `4001` avec arrêt gracieux (`SIGTERM`/`SIGINT`) attendant la fin du run en cours avant fermeture du pool Neon.

---

## Verification

```bash
# Vérification TypeScript stricte dans @clairflux/sync-worker
npm run typecheck --workspace=@clairflux/sync-worker

# Suite de tests unitaires et d'intégration du pipeline (src/pipeline.test.ts)
npm test --workspace=@clairflux/sync-worker
```
