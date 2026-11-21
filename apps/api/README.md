# `@clairflux/api`

Backend HTTP Node 22 LTS (Hono) et couche de persistance PostgreSQL Serverless Neon + Drizzle ORM pour ClairFlux (`v1.0.0-rc1`).

> Guide complet de mise en production et de déploiement Neon / Docker / APK : [../../PRODUCTION_DEPLOY.md](../../PRODUCTION_DEPLOY.md)

---

## Interface

### 1. Configuration, Application Hono & Serveur ([`src/config/env.ts`](./src/config/env.ts), [`src/app.ts`](./src/app.ts), [`src/server.ts`](./src/server.ts))
- **Validation d'environnement fail-fast (`src/config/env.ts`)** :
  - `ApiEnvSchema`, `parseApiEnv(rawEnv)`, `EnvValidationError` : valide `DATABASE_URL` (`postgres://` ou `postgresql://` avec `sslmode=require` obligatoire dans tous les environnements), `CLAIRFLUX_ACCESS_SECRET_HASH`, `CLAIRFLUX_SESSION_SECRET` (`>= 32` car.), `PORT`, `NODE_ENV`, `CLAIRFLUX_WEB_ORIGIN`, `SYNC_WORKER_URL`.
- **Factory HTTP & sécurité de session (`src/app.ts`)** :
  - `createApp(deps)` : factory Hono à injection de dépendances (`AppDependencies`), testable à 100 % sans base Neon active.
  - `signSessionToken(payload, sessionSecret)` & `verifySessionToken(token, sessionSecret, now)` : jetons HMAC-SHA256 (`cfx_v1.*`) vérifiés avec `timingSafeEqual`, contrôle d'expiration `exp` et révocation `jti` (`SessionRepository`).
  - Garde CSRF **fail-closed** sur toute mutation authentifiée par cookie `clairflux_session` (`X-Clairflux-Client: web` + `Origin === allowedWebOrigin`).
  - Enveloppe d'erreur JSON normalisée `{ error: { code, message, details?, retryable, request_id } }` et propagation de l'en-tête `X-Request-Id`.
- **Serveur de production & adaptateurs Neon (`src/server.ts`)** :
  - `createNeonAppDependencies(env, clients)` : implémentation Drizzle/Neon 100 % persistante des repositories injectés dans `createApp` :
    - `budgetsRepository` persisté dans la table SQL **`budget_limits`** (plus aucune `Map` mémoire provisoire en production),
    - `rulesRepository` persisté dans **`categorization_rules`**,
    - `deltaMutationRepository` idempotent persisté dans **`applied_client_mutations`** (`payload_hash` SHA-256 + `client_mutation_id`, survivant aux redémarrages du serveur API),
    - `createFilesystemApkRepository(apkPath, version)` (`apk`) lisant `APK_OUTPUT_PATH` (défaut `/shared-apk/clairflux-release.apk`) et son sidecar `.sha256` sans jamais échouer au démarrage si l'APK n'est pas encore compilé (`available: false`).
  - `startServer(rawEnv)` : démarrage `@hono/node-server` avec arrêt gracieux `SIGTERM`/`SIGINT` et fermeture propre du pool WebSocket Neon.

### 2. Contrats Zod & Routes Métier ([`src/routes/contracts.ts`](./src/routes/contracts.ts), [`src/routes/register-routes.ts`](./src/routes/register-routes.ts))
- **Sondes techniques publiques** :
  - `GET /healthz`, `GET /api/healthz` (`200 { status: "ok" }`)
  - `GET /readyz`, `GET /api/readyz` (`200 { status: "ready", db: "ok" }` ou `503 { status: "degraded", db: "error" }`)
- **Comptes bancaires** :
  - `GET /api/accounts` (`AccountsQuerySchema` : filtres optionnels `bank`, `currency`, calcul de `current_balance_eur_cents`).
- **Grand livre & annotations / catégorisation manuelle** :
  - `GET /api/transactions` (`TransactionsQuerySchema` : filtres `bank`, `account_id`, `currency`, `has_notes`, `search`, `from`, `to`, `limit` `1..200`).
  - `PATCH /api/transactions/:id` (`PatchTransactionBodySchema` : mise à jour atomique de `note` `1..2000` ou `null` pour suppression soft-delete, `category` forçant `is_manual_category = true` et `matched_rule_id = null`, `is_manual_category`, et `is_internal_transfer` positionnant `is_manual_transfer_override = true` sans écraser `is_manual_category`).
- **Règles de catégorisation & recalcul rétroactif** :
  - `GET /api/rules` : liste triée par priorité avec compteur `matched_transactions_count`.
  - `POST /api/rules` (`CreateRuleBodySchema` avec garde anti-ReDoS `isSafeRegexPattern` sur `match_mode: 'regex'`), `PATCH /api/rules/:id` (`UpdateRuleBodySchema`), `DELETE /api/rules/:id`.
  - `POST /api/rules/reorder` (`ReorderRulesBodySchema`) & `POST /api/rules/reapply` (`ReapplyRulesBodySchema`).
  - Moteur pur `evaluateRuleMatch` & `computeRuleReapplication` retournant `retroactive_stats: { updated_count, skipped_protected_count }`.
- **Budgets & alertes (80 % / 100 %)** :
  - `GET /api/budgets`, `PUT /api/budgets`, `DELETE /api/budgets` (et `DELETE /api/budgets/:category`), persistés en SQL dans `budget_limits`.
  - Calcul pur `computeBudgetAlert(spentCents, limitCents)` : statuts `'ok'` (`< 80 %`), `'warning'` (`80..99 %`), `'exceeded'` (`>= 100 %`) hors transferts internes.
- **Analytique Dashboard (6M & Dépenses 3 modes)** :
  - `GET /api/analytics/overview` (`AnalyticsOverviewQuerySchema` & `computeAnalyticsOverview`) : supporte `scope` (`'all' | 'boursobank' | 'revolut'`), `currency_mode` (`'eur_consolidated' | 'usd_only'`), `expense_comparison` (`'none' | 'prev_month' | 'avg_3m'`), `reference_month` (`YYYY-MM`), retournant `kpis`, `cumulative_balance_6m`, `monthly_expenses`, `expense_comparison_summary`, `expenses_m1_vs_avg3m` et `recurrences`.
- **Synchronisation Delta Offline-First & Outbox idempotente** :
  - `GET /api/sync/delta` (`DeltaSyncQuerySchema` : `since >= 0`, `since_timestamp` optionnel, `limit` `50..1000`).
  - `POST /api/sync/delta` (`PostSyncDeltaBodySchema` : traitement idempotent par `client_mutation_id` + table SQL `applied_client_mutations` d'un lot de mutations Outbox `upsert_note | set_category | set_internal_transfer`, retournant `applied | duplicate | rejected` par mutation et `latest_revision`).
- **Déclenchement manuel Google Drive** :
  - `POST /api/sync/drive` : corps vide `{}` exclusif, rejet `403 INVALID_DRIVE_FOLDER_SCOPE` sur tout `folder_id` hors des 2 dossiers autorisés, `409 SYNC_ALREADY_RUNNING`, `502 UPSTREAM_DRIVE_ERROR`, `202 Accepted` avec `EXCLUSIVE_DRIVE_FOLDERS`.
- **Distribution de l'APK Android (`ApkStatusSchema`, `ApkArtifactRepository`)** :
  - `GET /api/apk/status` (authentifié) : retourne `{ available, version, sizeBytes, sha256, builtAt }`.
  - `GET /api/apk/download` (authentifié) : sert le binaire avec `Content-Type: application/vnd.android.package-archive`, `Content-Disposition: attachment; filename="clairflux-release.apk"`, `Content-Length` et `Cache-Control: no-store`, ou `404` JSON structuré (`RESOURCE_NOT_FOUND`) si l'APK n'est pas encore compilé.

### 3. Schéma Drizzle Neon & Déduplication ([`drizzle.config.ts`](./drizzle.config.ts), [`src/db/schema.ts`](./src/db/schema.ts), [`src/db/client.ts`](./src/db/client.ts), [`src/db/dedup.ts`](./src/db/dedup.ts))
- **Schéma Fat-Database (`src/db/schema.ts`)** : séquence `sync_revision_seq`, `pgEnum` normatifs et **11 tables** : `accounts`, `fx_rates`, `drive_sync_runs`, `drive_files`, `pdf_ingestion_checkpoints`, `categorization_rules`, `transactions`, `transaction_notes`, `sync_meta`, **`budget_limits`** (`budgetLimits`, contrainte `CHECK (limit_cents > 0)`) et **`applied_client_mutations`** (`appliedClientMutations`, PK `client_mutation_id` + `payload_hash`).
- **Gestion du schéma (`package.json`)** : script `db:push` (`drizzle-kit push`) pour le bootstrap initial `v1.0.0-rc1` sur une base Neon vierge, et scripts `db:generate` (`drizzle-kit generate`) + `db:migrate` (`drizzle-kit migrate`) via [`drizzle.config.ts`](./drizzle.config.ts) (`sslmode=require` obligatoire) pour les migrations SQL versionnées recommandées lors de toute évolution ultérieure en production (cf. [../../docs/DATA_MODEL_DRIZZLE_SPEC.md](../../docs/DATA_MODEL_DRIZZLE_SPEC.md)).
- **Client Neon (`src/db/client.ts`)** : `assertValidNeonDatabaseUrl`, `createNeonClients`, `createNeonClientsFromEnv` (`httpDb` + `poolDb` + `close()`).
- **Déduplication & appariement transferts (`src/db/dedup.ts`)** : `normalizeLabel`, `computeDedupHash`, `assignStatementDedupHashes`, `detectInternalTransferPair`, `matchInternalTransferPairs` (même devise `±3j` et change Revolut `EUR ↔ USD` `±1j`), `isEligibleForRuleRecalc`.

---

## Invariants

1. **Exclusivité Drive & déclenchement manuel** :
   - Contraintes SQL `CHECK` sur `drive_files` limitant `drive_folder_id` à `'1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus'` (`boursobank`) et `'1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h'` (`revolut`), et `drive_sync_runs.trigger_mode = 'manual'`.
2. **Zéro flottant & intégrité comptable** :
   - Tous les montants, soldes et plafonds `budget_limits.limit_cents` sont des entiers en centimes (`Cents`, `bigint({ mode: 'number' })`), et les taux FX des entiers en micro-unités (`FxRateMicro`, `1_000_000` pour `EUR`).
   - Les transferts internes (`is_internal_transfer = true`) sont systématiquement exclus des dépenses mensuelles, des comparaisons `M-1 / 3M` et de la consommation des budgets.
3. **Protection absolue des choix manuels** :
   - `isEligibleForRuleRecalc` et `computeRuleReapplication` excluent strictement toute transaction ayant `is_manual_category = true`, `transfer_group_id !== null` ou `is_manual_transfer_override = true`.
4. **Idempotence Outbox persistante en SQL & monotonie des révisions** :
   - Toute mutation appliquée via `PATCH /api/transactions/:id`, `/api/rules*`, `/api/budgets*` ou `POST /api/sync/delta` alloue une révision monotone (`sync_revision_seq`).
   - Les mutations Outbox acquittées sont persistées dans `applied_client_mutations` (`client_mutation_id` + `payload_hash` SHA-256) : un même `client_mutation_id` rejoué après coupure réseau ou redémarrage du conteneur `api` retourne `status: 'duplicate'` sans ré-exécuter l'écriture.
5. **Sécurité connexion & isolation des secrets** :
   - `sslmode=require` obligatoire sur `DATABASE_URL`, CSRF fail-closed sur les mutations par cookie, `timingSafeEqual` sur la vérification HMAC, et absence totale de `GEMINI_API_KEY` ou de credentials Drive dans `@clairflux/api`.

---

## Side Effects

- **Base de données PostgreSQL Neon** : lectures HTTP stateless (`httpDb`) et transactions WebSocket ACID (`poolDb.transaction`) sur les 11 tables du grand livre, budgets et idempotence Outbox.
- **Lecture système de fichiers APK (lecture seule)** : lecture de `APK_OUTPUT_PATH` (volume Docker partagé `apk-artifacts:/shared-apk:ro`) et du sidecar `.sha256` pour `GET /api/apk/status` et `GET /api/apk/download`.
- **Appel réseau interne vers `sync-worker`** : `POST ${SYNC_WORKER_URL}/internal/runs` avec `X-Internal-Worker-Token` lors d'un déclenchement manuel `POST /api/sync/drive`.
- **Serveur HTTP Node 22 (`src/server.ts`)** : écoute sur `PORT` (`3000` par défaut) et drainage des connexions sur `SIGTERM`/`SIGINT`.

---

## Verification

```bash
# Bootstrap initial du schéma Drizzle vers une base Neon vierge (v1.0.0-rc1, sslmode=require)
npm --workspace apps/api run db:push

# Évolutions ultérieures en production (migrations SQL versionnées recommandées)
npm --workspace apps/api run db:generate
npm --workspace apps/api run db:migrate

# Vérification TypeScript stricte dans @clairflux/api
npm run typecheck --workspace=@clairflux/api

# Suite de tests Vitest (src/app.test.ts + src/routes.test.ts + src/db/dedup.test.ts)
npm test --workspace=@clairflux/api
```
