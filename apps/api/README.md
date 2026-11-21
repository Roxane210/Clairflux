# `@clairflux/api`

Backend HTTP Node 22 LTS (Hono) et couche de persistance PostgreSQL Serverless Neon + Drizzle ORM pour ClairFlux.

---

## Interface

### Couche HTTP Jalon 1 (`src/app.ts`, `src/config/env.ts`)
- **Configuration & démarrage fail-fast (`src/config/env.ts`)** :
  - `ApiEnvSchema`, `parseApiEnv(rawEnv)`, `EnvValidationError` : validation Zod stricte de `DATABASE_URL` (avec `sslmode=require`), `CLAIRFLUX_ACCESS_SECRET_HASH`, `CLAIRFLUX_SESSION_SECRET` (`>= 32` car.), `PORT`, `NODE_ENV`, `CLAIRFLUX_WEB_ORIGIN`, `SYNC_WORKER_URL`.
- **Factory & sécurité de session (`src/app.ts`)** :
  - `createApp(deps)` : factory Hono à injection de dépendances (`HealthRepository`, `SessionRepository`, `AccountsRepository`, `SyncDeltaRepository`, `DriveSyncService`), testable sans base Neon active.
  - `signSessionToken(payload, sessionSecret)` & `verifySessionToken(token, sessionSecret, now)` : jetons HMAC-SHA256 (`cfx_v1.*`) vérifiés par `timingSafeEqual`, contrôle d'expiration et révocation `jti`.
  - Garde CSRF fail-closed sur les mutations authentifiées par cookie `clairflux_session` (`X-Clairflux-Client: web` + correspondance stricte `Origin === allowedWebOrigin`).
  - Enveloppe d'erreur normalisée : `{ error: { code, message, details?, retryable, request_id } }`.
- **Routes HTTP implémentées en Jalon 1** :
  - Sondes techniques publiques : `GET /healthz`, `GET /api/healthz`, `GET /readyz`, `GET /api/readyz` (`200` / `503`).
  - Lecture comptes : `GET /api/accounts` (filtres optionnels validés par Zod `bank`, `currency`).
  - Delta pull Android : `GET /api/sync/delta` (`since >= 0` requis, `limit` optionnel `50..1000`).
  - Déclenchement manuel Drive : `POST /api/sync/drive` (corps vide `{}` exclusif, rejet `403 INVALID_DRIVE_FOLDER_SCOPE` si dossier hors périmètre, `409 SYNC_ALREADY_RUNNING`, `502 UPSTREAM_DRIVE_ERROR`, `202 Accepted` avec les 2 dossiers exclusifs `EXCLUSIVE_DRIVE_FOLDERS`).

### Couche Base de Données & Ledger Jalon 1 (`drizzle.config.ts`, `src/db/schema.ts`, `src/db/client.ts`, `src/db/dedup.ts`)
- **Schéma Drizzle Neon (`src/db/schema.ts`)** : séquence `sync_revision_seq`, `pgEnum` normatifs (`bank_enum`, `account_type_enum` incluant `'coffre'`, `currency_enum`, `fx_source_enum`, `rule_match_mode_enum`, `sync_trigger_enum`, `sync_run_status_enum` incluant `'partial_error'`, `checkpoint_status_enum` incluant `'skipped'`) et 9 tables (`accounts`, `fx_rates`, `drive_sync_runs`, `drive_files`, `pdf_ingestion_checkpoints`, `categorization_rules`, `transactions`, `transaction_notes`, `sync_meta`).
- **Client Neon (`src/db/client.ts`)** : `assertValidNeonDatabaseUrl`, `createNeonClients`, `createNeonClientsFromEnv` exposant `httpDb` (`drizzle-orm/neon-http`) pour les lectures rapides et `poolDb` (`drizzle-orm/neon-serverless` `Pool`) pour les transactions ACID + `close()`.
- **Logique pure de déduplication & réconciliation (`src/db/dedup.ts`)** :
  - `normalizeLabel(rawLabel)` : normalisation déterministe NFKD/minuscules/espaces.
  - `computeDedupHash(input)` & `assignStatementDedupHashes(items)` : SHA-256 hex déterministe incluant `accountId`, `currency`, `bookingDate`, `amountCents`, libellé normalisé et `occurrenceIndex`.
  - `detectInternalTransferPair(a, b)` & `matchInternalTransferPairs(candidates)` : appariement 1-to-1 BoursoBank ↔ Revolut / inter-comptes même devise (`±3j`) et changes internes Revolut `EUR ↔ USD` (`±1j` avec indices lexicaux FX et tolérance `max(200, 3 %)`).
  - `isEligibleForRuleRecalc(candidate)` : garde excluant `deletedAt !== null`, `isManualCategory`, `transferGroupId !== null` et `isManualTransferOverride`.

### Prévu aux jalons suivants
- Point d'entrée serveur HTTP (`src/index.ts`), implémentations Neon concrètes des repositories injectés dans `createApp`.
- Routes d'authentification (`/api/auth/login`, `/api/auth/session`, `/api/auth/logout`).
- Routes grand livre & agrégats (`GET /api/transactions`, `GET /api/aggregates`).
- Routes d'écriture en ligne (`PATCH /api/accounts/:id`, `PUT/DELETE /api/transactions/:id/note`, `PATCH /api/transactions/:id`, `GET/POST/PATCH/DELETE /api/rules`, `POST /api/rules/preview`).
- Suivi & reprise granulaire Drive (`GET /api/sync/drive/status`, `POST /api/sync/drive/files/:fileId/retry`).

---

## Invariants

1. **Exclusivité Drive & déclenchement manuel** :
   - Contraintes SQL `CHECK` sur `drive_files` limitant `drive_folder_id` à `'1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus'` (`boursobank`) et `'1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h'` (`revolut`).
   - `drive_sync_runs.trigger_mode = 'manual'` imposé par `CHECK` ; toute tentative sur un autre dossier est rejetée en `403 INVALID_DRIVE_FOLDER_SCOPE`.
2. **Zéro flottant & immuabilité comptable** :
   - Tous les montants (`amount_cents`, `amount_eur_cents`, `current_balance_cents`) et taux (`fx_rate_micro`) sont modélisés en `bigint({ mode: 'number' })`.
   - `dedup_hash` est `UNIQUE` en base et les transactions historiques ne sont jamais supprimées si un PDF disparaît de Drive (`is_missing_on_drive`).
3. **Protection absolue des choix manuels** :
   - `isEligibleForRuleRecalc` exclut strictement toute transaction ayant `isManualCategory = true`, `transferGroupId !== null` ou `isManualTransferOverride = true`.
4. **Zéro mutation hors-ligne** :
   - Aucune table `applied_client_mutations` ni route d'outbox ; toutes les écritures exigent une session valide en ligne.
5. **Sécurité connexion & isolation des secrets** :
   - `sslmode=require` imposé sur `DATABASE_URL` (`env.ts`, `client.ts`, `drizzle.config.ts`).
   - Le service `api` ne détient jamais `GEMINI_API_KEY` ni les credentials Google Drive (confinés au service `sync-worker`).
   - Migrations SQL versionnées (`drizzle-kit generate` / `migrate`, jamais `drizzle-kit push` en production).

---

## Side Effects

- **Base de données PostgreSQL Neon** : lectures stateless (`neon-http`) et transactions WebSocket ACID (`poolDb`) via `@neondatabase/serverless` (hors tests unitaires/mockés).
- **Déclenchement du worker** : appel au `DriveSyncService` injecté lors de `POST /api/sync/drive` (cible réseau interne Docker `sync-worker` en déploiement).
- **Télémétrie HTTP** : ajout de l'en-tête `X-Request-Id` sur chaque réponse et enveloppe d'erreur JSON sans fuite de secrets ni de stacktrace.

---

## Verification

```bash
# Vérification TypeScript stricte dans @clairflux/api
npm run typecheck --workspace=@clairflux/api

# Tests unitaires (src/db/dedup.test.ts) et tests d'intégration HTTP mockée (src/app.test.ts)
npm test
```
