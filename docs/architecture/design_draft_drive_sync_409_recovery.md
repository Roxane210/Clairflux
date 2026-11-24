# Design Draft EGM — Résilience Synchronisation Drive/Gemini & Fin du blocage HTTP 409

- **Statut** : En cours d'implémentation suite au diagnostic terrain (`2026-11-24`)
- **Références** :
  - [TECHNICAL_STANDARDS.md](file:///d:/Applications/Clairflux/docs/TECHNICAL_STANDARDS.md)
  - [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)
  - [ADR 0001](file:///d:/Applications/Clairflux/docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)
  - [ADR 0002](file:///d:/Applications/Clairflux/docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)

---

## 1. Diagnostic Factuel (`HTTP 409 SYNC_ALREADY_RUNNING`)

### 1.1 État observé en production (Neon `cool-fog-85317702`, branche `production`)
- La table `drive_sync_runs` contient une ligne bloquée à `status = 'running'` (`id = 8ccd913c-7656-4c85-998b-e9da02c72ddd`, `started_at = 2026-11-24T09:44:30.091Z`, `finished_at = null`, `total_files_discovered = 0`).
- `drive_files`, `pdf_ingestion_checkpoints` et `transactions` sont à `0` ligne.
- Tant que cette ligne reste à `'running'`, `POST /api/sync/drive` renvoie systématiquement `409 SYNC_ALREADY_RUNNING`, affiché dans l'UI par `Synchronisation Drive/Gemini indisponible (HTTP 409).`.

### 1.2 Causes racines dans le code
1. **Exception non capturée hors boucle fichier (`apps/sync-worker/src/gemini-pipeline.ts`)** :
   - `runIngestionPipeline` appelle `discoverAllAllowedPdfs()` sans `try/catch` englobant, et `startWorkerRuntime` avale le rejet (`void promise.catch(() => undefined)`).
   - Tout échec d'accès Google Drive (jeton expiré HTTP 401, erreur réseau, etc.) laisse la ligne `drive_sync_runs` définitivement à `'running'`.
2. **Absence de réconciliation des runs orphelins (`sync-worker` & `api`)** :
   - Si `sync-worker` redémarre ou échoue en plein run, `activeRunId` redevient `null` en mémoire alors que Neon conserve `status = 'running'`.
3. **Fichier `GOOGLE_DRIVE_CREDENTIALS_PATH` ignoré (`apps/sync-worker`)** :
   - `docker-compose.yml` monte `/run/secrets/google_drive_credentials.json`, mais `sync-worker` n'utilisait que `GOOGLE_DRIVE_ACCESS_TOKEN` (jeton OAuth2 statique expirant au bout d'1 heure).
4. **Diagnostic opaque côté interface (`apps/web`)** :
   - `useOfflineStore.ts` ignorait `error.message` sur erreur HTTP et `last_run.error_summary` n'était pas exposé dans `DeltaSyncResponse`.

---

## 2. Contrats & Invariants de Correction

1. **Finalisation garantie de `runIngestionPipeline`** :
   - Tout rejet (découverte Drive, checkpoint, commit, etc.) est capturé au niveau du pipeline et appelle systématiquement `checkpointStore.finalizeRun({ status: 'failed', errorSummary })`.
2. **Réconciliation automatique des runs orphelins** :
   - `sync-worker` expose `GET /internal/runs/active` (protégé par `INTERNAL_WORKER_TOKEN`) retournant `{ active_run_id: string | null }` et réconcilie les runs `'running'` résiduels au démarrage (`reconcileOrphanedRuns`).
   - `api` vérifie auprès de `sync-worker` lorsqu'une ligne DB est `'running'` : si le worker est joignable et n'exécute pas ce run (`active_run_id !== active.id` après un délai de grâce de 5 s), la ligne obsolète est clôturée en `'failed'` avant de lancer le nouveau run.
3. **Authentification Google Drive multi-format sans dépendance externe (`node:crypto`)** :
   - `sync-worker` supporte `GOOGLE_DRIVE_CREDENTIALS_PATH` pour :
     - Compte de service Google (`type: "service_account"`, signature JWT RS256 + échange `https://oauth2.googleapis.com/token` avec cache mémoire et renouvellement anticipé).
     - Client OAuth2 avec `refresh_token` (`client_id`, `client_secret`, `refresh_token`).
   - Fallback sur `GOOGLE_DRIVE_ACCESS_TOKEN` si aucun fichier de credentials auto-renouvelable n'est présent.
   - `docker-compose.yml` rend `GOOGLE_DRIVE_ACCESS_TOKEN` optionnel lorsque `GOOGLE_DRIVE_CREDENTIALS_PATH` est utilisé.
4. **Remontée claire des erreurs côté UI (`apps/web` + `packages/shared`)** :
   - `DriveSyncRunSummarySchema` ajoute `error_summary: z.string().nullable().optional()`.
   - `useOfflineStore.ts` lit `ApiErrorEnvelope` sur erreur HTTP et affiche le message explicite (ainsi que `last_run.error_summary` dans `SyncDrivePanel` si le dernier run a échoué).

---

## 3. Résolution FX BCE & Tolérance Revolut Multi-Devises (`2026-11-24`, v1.0.1-build.3)

### 3.1 Diagnostic sur logs `v1.0.1-build.2` (run `fcf9e07c-e033-4f52-bfe0-663d18b746c0`)
1. **Absence de fournisseur FX externe dans `startWorkerRuntime`** : `createFxRateService({ store })` était instancié sans `fetchReferenceRate`, faisant échouer tout relevé Revolut contenant des opérations USD sans taux en base (`2020-08-10`, `2019-02-13`, `2018-04-13`).
2. **Types & devises hors périmètre dans les relevés annuels Revolut** :
   - Des poches `'investissement'` provoquaient `accounts.1.account_type - Invalid enum value ... received 'investissement'`.
   - Des poches `'GBP'` provoquaient `accounts.0.currency - Invalid enum value ... received 'GBP'`, bloquant l'ensemble du PDF 2021 (76 pages) alors que seules `EUR` et `USD` sont suivies.
   - Les lots intermédiaires sans opération (`accounts: []`, `transactions: []`) échouaient inutilement sur `.min(1)`, déclenchant des fallbacks en cascade.

### 3.2 Contrats ajoutés
1. **`createEcbReferenceFxFetcher` (`apps/sync-worker/src/gemini-pipeline.ts`)** :
   - Branché sur `createFxRateService({ store, fetchReferenceRate, maxLookbackDays: 14 })` dans `startWorkerRuntime`.
   - Interroge par plage annuelle (incluant fin décembre N-1 pour les jours fériés du 1er janvier) avec cache mémoire par `(année, paire)` :
     - Primaire : `api.frankfurter.dev/v1/{start}..{end}` (taux de référence BCE),
     - Secondaire : `api.frankfurter.app/{start}..{end}`,
     - Secours officiel : `data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A` (inversion exacte en `FxRateMicro`).
2. **Normalisation Revolut & lots vides** :
   - `normalizeAccountType` mappe `'investissement'` / `'trading'` / `'crypto'` / libellés non reconnus vers `'autre'`, et `'épargne'`/`'savings'` vers `'epargne'`, `'vault'`/`'poche'` vers `'coffre'`, etc.
   - `normalizeGeminiStatementPayload` filtre proprement les comptes et opérations hors `'EUR' | 'USD'` (`GBP`, etc.) avec log d'avertissement.
   - `GeminiBatchExtractionSchema` autorise `accounts: []` sur un lot multi-lots lorsque `transactions: []`, tandis que `mergeBatchExtractions` exige toujours `>= 1` compte sur le document fusionné complet (et protège le solde de clôture contre l'écrasement par un lot final vide).
