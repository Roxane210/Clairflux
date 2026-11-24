# ClairFlux

Application personnelle de suivi financier multi-banques et multi-comptes (**BoursoBank** & **Revolut**), conçue selon la gouvernance **EGM (Elephant-and-Goldfish Model)** : spécifications normatives verrouillées avant code, arithmétique comptable exacte en centimes entiers, ingestion PDF manuelle via Google Drive & Gemini, et application Web / APK Android **Offline-First**.

- **Version cible** : `v1.0.0-rc1` (Jalon 3 — Prête pour mise en production)
- **Dépôt GitHub officiel** : <https://github.com/Roxane210/Clairflux>
- **Guide de mise en production (pas-à-pas Product Owner)** : [./PRODUCTION_DEPLOY.md](./PRODUCTION_DEPLOY.md)
- **Modèle de variables d'environnement** : [./.env.example](./.env.example)

---

## Vue d'ensemble fonctionnelle & invariants (`v1.0.0-rc1`)

### 1. Périmètre Google Drive exclusif, extraction PDF & reprise Gemini
- **Lecture seule stricte (`drive.readonly`)** limitée à **deux dossiers Google Drive codés en dur** (validés dans `@clairflux/shared`, `@clairflux/api`, `@clairflux/sync-worker` et par contrainte SQL `CHECK` dans PostgreSQL Neon) :
  - **BoursoBank** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
  - **Revolut** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
- **Déclenchement 100 % manuel** (`POST /api/sync/drive` → `POST /internal/runs` authentifié par `INTERNAL_WORKER_TOKEN` avec `timingSafeEqual`) : aucun cron, aucun webhook, aucun polling automatique en arrière-plan.
- **Pipeline PDF `pdfjs-dist` + Chaîne de fallback Gemini** : découpage PDF avec suppression du boilerplate bancaire en lots bornés (`drive-pdf.ts`), extraction structurée validée par Zod sur la chaîne ordonnée **`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`** (clé transmise via en-tête HTTP `x-goog-api-key`), résolution `fx_rate_micro` et reprise granulaire par checkpoints SQL PostgreSQL Neon (`pending | skipped | extracting | parsed | committing | committed | failed`, contrôle `md5_checksum` et `dedup_hash`).

### 2. Multi-comptes, multi-devises EUR / USD, budgets SQL & grand livre
- **Multi-comptes par banque** : prise en charge de plusieurs comptes et poches par banque (`courant`, `epargne`, `carte_differee`, `multi_devises`, `coffre`, `autre`), librement renommables (`nickname`).
- **Zéro flottant & conversion historique figée** : montants en centimes entiers (`amount_cents`, `amount_eur_cents`) et taux `USD → EUR` en micro-unités (`fx_rate_micro`, `1.000000 = 1_000_000`) figés à `booking_date`.
- **Synthèse Recharts 6M & Dépenses 3 modes + Alertes Budgets SQL** :
  - **Solde cumulé 6M** (`AreaChart`) avec périmètre `Tous les comptes` / `BoursoBank` / `Revolut` et bascule `EUR consolidé` / `USD seul`.
  - **Dépenses mensuelles** (`AreaChart`) avec sélecteur 3 modes (`Sans comparaison`, `Mois précédent (M-1)`, `Moyenne 3 mois`) excluant strictement les transferts internes.
  - **Alertes budgets mensuels** (`/api/budgets`) persistés dans la table SQL Neon **`budget_limits`** (plus aucune `Map` provisoire en production) avec seuils visuels + textuels explicites (`ok < 80 %`, `warning 80–99 %`, `exceeded >= 100 %`).
- **Grand livre, Règles & Export CSV sécurisé** :
  - Sous-onglets `Opérations` (filtre *« Avec notes »*, recherche, colonnes *Banque* & *Type de compte*, Export CSV `;` UTF-8 BOM avec neutralisation anti-injection de formule) et `Règles de catégorisation` (CRUD, priorité `Monter`/`Descendre`, réapplication globale protégée).
  - Protection absolue des choix manuels : `is_manual_category = true`, `transfer_group_id !== null` et `is_manual_transfer_override = true` ne sont jamais écrasés par les règles.

### 3. Android APK Capacitor Offline-First, Outbox SQL & Distribution
- **Configuration Capacitor (`apps/web/capacitor.config.ts`)** : cible `com.clairflux.finance` (`webDir: 'dist'`, `androidScheme: 'https'`, `allowMixedContent: false`), polices `@fontsource/*` bundlées localement, interception bouton retour Android sur `<dialog open>` et retour haptique léger.
- **Consultation intégrale + Notes rapides hors-ligne (`apps/web/src/offline/`)** :
  - Cache local `IndexedDB` (`clairflux_offline_v1`) avec fallback mémoire, conservant comptes, transactions, notes, règles, budgets et statuts Drive.
  - **Outbox hors-ligne** (`outbox_mutations`) : ajout/modification de notes rapides (et recatégorisations manuelles) via le tiroir `<dialog>` (`BottomSheetNoteDialog`) même sans réseau, bouton de synchronisation immédiate dans `OfflineStatusBanner` / `SyncDrivePanel`, rejeu idempotent par `client_mutation_id` (`POST /api/sync/delta`) garanti durablement côté serveur par la table SQL Neon **`applied_client_mutations`** (`payload_hash` SHA-256), et tirage incrémental (`GET /api/sync/delta?since=...`).
  - **Garde stricte Drive/Gemini hors-ligne** : la synchronisation Drive/Gemini reste explicitement bloquée hors connexion (`canTriggerDriveSync(false)`).
- **Compilation & distribution APK (`v1.0.0-rc1`)** :
  - Conteneur dédié **`apk-builder`** ([`./Dockerfile.apk-builder`](./Dockerfile.apk-builder) + [`./scripts/build-apk.sh`](./scripts/build-apk.sh)) produisant `clairflux-release.apk` et `clairflux-release.apk.sha256` dans le volume `apk-artifacts:/shared-apk`.
  - Endpoints API authentifiés **`GET /api/apk/status`** et **`GET /api/apk/download`** consommés par le composant UI **`ApkDownloadCard`**.
  - Workflow CI alternatif sans Docker local : [`.github/workflows/build-apk.yml`](./.github/workflows/build-apk.yml) (`workflow_dispatch` et tags `v*`).

### 4. Déploiement Docker Multi-Stage & Isolation Réseau
- **4 services orchestrés (`docker-compose.yml`)** :
  - `web` ([`./apps/web/Dockerfile`](./apps/web/Dockerfile)) : build Vite multi-stage → `nginxinc/nginx-unprivileged:1.27-alpine` non-root (`8080`), fallback SPA `try_files $uri /index.html`, `immutable` sur `/assets/`, `no-cache` sur `index.html`, headers sécurité, zéro secret serveur.
  - `api` ([`./apps/api/Dockerfile`](./apps/api/Dockerfile)) : multi-stage `node:22-alpine`, exécution non-root `USER node` sur `apps/api/src/server.ts`, `HEALTHCHECK` `/healthz` (`3000`), volume `apk-artifacts:/shared-apk:ro`, connecté à `frontend_net` et `backend_net`.
  - `sync-worker` ([`./apps/sync-worker/Dockerfile`](./apps/sync-worker/Dockerfile)) : multi-stage `node:22-alpine`, exécution non-root `USER node` sur `apps/sync-worker/src/gemini-pipeline.ts`, `HEALTHCHECK` `/healthz` (`4001`), isolé exclusivement sur `backend_net` (aucun port hôte exposé).
  - `apk-builder` ([`./Dockerfile.apk-builder`](./Dockerfile.apk-builder)) : JDK 21, Android SDK 35, Node 22, Capacitor et Gradle générant l'APK dans `apk-artifacts:/shared-apk` sans aucun secret Neon/Gemini/Drive.

---

## Index des packages (EGM Blueprint)

| Workspace / Artefact | Rôle (`v1.0.0-rc1`) | Documentation EGM |
| :--- | :--- | :--- |
| **`@clairflux/shared`** | Contrats Zod partagés, Branded Types, constantes Drive, arithmétique centimes/FX et utilitaires purs (zéro secret, zéro dépendance Node/DOM). | [./packages/shared/README.md](./packages/shared/README.md) |
| **`@clairflux/api`** | API HTTP Node 22 (`Hono` + `apps/api/src/server.ts`), auth HMAC-SHA256 + CSRF fail-closed, routes métier (`/api/transactions`, `/api/rules`, `/api/budgets`, `/api/analytics/overview`, `GET/POST /api/sync/delta`, `POST /api/sync/drive`, `GET /api/apk/status`, `GET /api/apk/download`), persistance Drizzle Neon (`budget_limits`, `applied_client_mutations`, `db:push`) & `Dockerfile` multi-stage. | [./apps/api/README.md](./apps/api/README.md) |
| **`@clairflux/sync-worker`** | Worker isolé Drive (`drive.readonly` sur 2 dossiers exclusifs) + découpage `pdfjs-dist` + fallback Gemini 3 modèles (`x-goog-api-key`) + `fx_rate_micro` + checkpoints SQL Neon & `Dockerfile` multi-stage (`backend_net`). | [./apps/sync-worker/README.md](./apps/sync-worker/README.md) |
| **`@clairflux/web`** | Frontend React 19 + Vite + Recharts 6M & Dépenses 3 modes + alertes budgets 80%/100% + Grand Livre/Règles + Export CSV sécurisé + Bottom Sheet `<dialog>` + moteur Offline IndexedDB/Outbox avec bouton de synchronisation immédiate + `ApkDownloadCard` + tests E2E `e2e-audit.test.ts` + `capacitor.config.ts` & `Dockerfile` Nginx non-root. | [./apps/web/README.md](./apps/web/README.md) |

---

## Documentation normative & exploitation

- [Guide de Mise en Production (`PRODUCTION_DEPLOY.md`)](./PRODUCTION_DEPLOY.md)
- [Standards techniques & normes d'ingénierie](./docs/TECHNICAL_STANDARDS.md)
- [Modèle de données Neon PostgreSQL & Drizzle ORM](./docs/DATA_MODEL_DRIZZLE_SPEC.md)
- [Contrat formel d'API, Delta Sync & Infrastructure](./docs/API_DELTA_SYNC_CONTRACT.md)
- **ADRs** :
  - [0001 — Exclusivité Drive & Déduplication](./docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)
  - [0002 — Ledger Neon/Drizzle & Checkpoints](./docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)
  - [0003 — Capacitor Offline-First & Delta Sync](./docs/ADR/0003-capacitor-offline-first-delta-sync.md)
  - [0004 — UI Baseline & Architecture Recharts](./docs/ADR/0004-ui-baseline-and-recharts-architecture.md)

---

## Commandes de vérification & mise en service

Exécuter depuis la racine du monorepo :

```bash
# 1. Bootstrap initial du schéma Drizzle sur une base Neon vierge (v1.0.0-rc1, sslmode=require)
#    Note : pour toute évolution ultérieure du schéma en production avec données existantes,
#    utiliser les migrations SQL versionnées (`db:generate` + `db:migrate`, cf. DATA_MODEL_DRIZZLE_SPEC.md).
npm --workspace apps/api run db:push

# 2. Vérification TypeScript stricte sur tous les workspaces
npm run typecheck

# 3. Exécution de la suite de tests Vitest (inclut apps/web/src/e2e-audit.test.ts)
npm test

# 4. Contrôle statique & build de production Frontend (@clairflux/web)
npm run lint
npm run build

# 5. Audit automatisé complet en 6 points (scripts/run-audit-bot.mjs)
npm run audit

# 6. Validation Docker Compose & lancement production (inclut apk-builder)
docker compose config
docker compose up -d --build
```
