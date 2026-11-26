# ClairFlux

Application personnelle de suivi financier multi-banques et multi-comptes (**BoursoBank** & **Revolut**), conçue selon la gouvernance **EGM (Elephant-and-Goldfish Model)** : spécifications normatives verrouillées avant code, arithmétique comptable exacte en centimes entiers, ingestion PDF manuelle via Google Drive & Gemini, et application Web / APK Android **Offline-First**.

- **Version active** : `v1.1.0-build.1` (Lot 1 — Catégories à 2 niveaux & Google Pixel 8 Portrait/Paysage)
- **Dépôt GitHub officiel** : <https://github.com/Roxane210/Clairflux>
- **Mode d'emploi utilisateur (Product Owner)** : [./docs/USER_GUIDE.md](./docs/USER_GUIDE.md)
- **Journal des versions** : [./CHANGELOG.md](./CHANGELOG.md)
- **Guide de mise en production** : [./PRODUCTION_DEPLOY.md](./PRODUCTION_DEPLOY.md)
- **Modèle de variables d'environnement** : [./.env.example](./.env.example)

---

## Nouveautés Lot 1 (`v1.1.0-build.1`)

### 1. Catégories & Sous-catégories à 2 niveaux (`Transactions > Catégories`)
- **Arborescence libre bornée à 2 niveaux (`Catégorie → Sous-catégorie`)** : chaque catégorie racine porte un groupe budgétaire canonique (`budget_group_enum` : `income`, `fixed`, `variable`, `non_monthly`, `savings`, `transfer`), avec contrainte serveur et SQL interdisant tout 3e niveau.
- **Pack français de démarrage modifiable** : 12 catégories racines en français et leurs sous-catégories (plus le repli protégé *Non catégorisé*), entièrement renommables, fusionnables et supprimables depuis `Transactions > Catégories` (toute suppression impose une réaffectation des opérations et règles existantes).
- **Endpoints API `/api/categories` & Delta Sync** :
  - `GET /api/categories` (filtre `?include_archived=true|false`)
  - `POST /api/categories`, `PATCH /api/categories/:id` (dual-write sur `transactions.category` et `categorization_rules.target_category`)
  - `POST /api/categories/:id/merge` (fusion transactionnelle ACID)
  - `DELETE /api/categories/:id` (réaffectation obligatoire `reassign_to_category_id`, protection des catégories système)
  - Inclusion des `categories` dans `GET /api/sync/delta` et sélecteur groupé 2 niveaux (`<optgroup>`) dans le tiroir d'opération et les règles.
- **Migration SQL additive (Expand)** : `0001_lot1_categories_expand.sql` et `ensure-v2-schema.ts` préservant intégralement les données existantes.

### 2. Optimisation Google Pixel 8 (Portrait & Paysage) & Android 15 Edge-to-Edge
- **Pixel 8 Portrait (`412×915`) & Mobile (`>= 320 px`)** : barre de navigation basse compacte (`64 px + safe-area-bottom <= 15 %`), `interactive-widget=resizes-content` dans `<meta name="viewport">`, `<dialog>` en tiroir bas (`bottom sheet`) avec cibles tactiles `>= 44×44 px`.
- **Pixel 8 Paysage (`915×412`, rotations 90° & 270°)** : sous `@media (orientation: landscape) and (max-height: 500px)`, la barre basse bascule automatiquement vers un **rail latéral gauche compact (`76 px`)** (`0 %` de sticky vertical), absorption complète des 4 `env(safe-area-inset-*)` face au poinçon caméra, graphiques côte à côte via `@container` et `<dialog>` basculé en panneau latéral droit.
- **APK Android 15 / SDK 35** : `adjustMarginsForEdgeToEdge: 'auto'` et `webContentsDebuggingEnabled: false` dans `apps/web/capacitor.config.ts`, plus patch idempotent dans `scripts/build-apk.sh` (`screenOrientation="fullUser"`, `configChanges` évitant tout rechargement à la rotation, `adjustResize`, `windowLayoutInDisplayCutoutMode="shortEdges"`, `windowLightStatusBar` et `windowLightNavigationBar`).

---

## Vue d'ensemble fonctionnelle & invariants du socle

### 1. Périmètre Google Drive exclusif, extraction PDF & reprise Gemini
- **Lecture seule applicative / archivage encadré** limitée à **deux dossiers Google Drive codés en dur** (validés dans `@clairflux/shared`, `@clairflux/api`, `@clairflux/sync-worker` et par contrainte SQL `CHECK` dans PostgreSQL Neon) :
  - **BoursoBank** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
  - **Revolut** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
- **Déclenchement 100 % manuel** (`POST /api/sync/drive` → `POST /internal/runs` authentifié par `INTERNAL_WORKER_TOKEN` avec `timingSafeEqual`) : aucun cron, aucun webhook, aucun polling automatique en arrière-plan.
- **Pipeline PDF `pdfjs-dist` + Chaîne de fallback Gemini** : découpage PDF en sous-processus avec fallback OCR natif Gemini (`drive-pdf.ts`), chaîne ordonnée **`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`** (clé transmise via en-tête HTTP `x-goog-api-key`), résolution `fx_rate_micro` (client FX BCE) et reprise granulaire par checkpoints SQL PostgreSQL Neon (`pending | skipped | extracting | parsed | committing | committed | failed`, contrôle `md5_checksum` et `dedup_hash`).

### 2. Multi-comptes, multi-devises EUR / USD, budgets SQL & grand livre
- **Multi-comptes par banque** : prise en charge de plusieurs comptes et poches par banque (`courant`, `epargne`, `carte_differee`, `multi_devises`, `coffre`, `autre`), librement renommables (`nickname`).
- **Zéro flottant & conversion historique figée** : montants en centimes entiers (`amount_cents`, `amount_eur_cents`) et taux `USD → EUR` en micro-unités (`fx_rate_micro`, `1.000000 = 1_000_000`) figés à `booking_date`.
- **Synthèse Recharts & Alertes Budgets SQL** :
  - **Solde bancaire cumulé** (`AreaChart`) avec périmètre `Tous les comptes` / `BoursoBank` / `Revolut`, filtres temporels communs (`1 semaine` à `Tout` / `Personnalisé`) et bascule `EUR consolidé` / `USD seul`.
  - **Dépenses** (`AreaChart`) avec sélecteur 3 modes (`Sans comparaison`, `Période précédente (M-1)`, `Moyenne 3 mois`) excluant strictement les transferts internes.
  - **Alertes budgets mensuels** (`/api/budgets`) persistés dans la table SQL Neon **`budget_limits`** avec seuils visuels + textuels explicites (`Maîtrisé < 80 %`, `Vigilance >= 80 %`, `Dépassement >= 100 %`).
- **Grand livre, Règles, Catégories & Export CSV sécurisé** :
  - Sous-onglets `Opérations` (filtre *« Avec notes »*, recherche, colonnes *Banque* & *Type de compte*, Export CSV `;` UTF-8 BOM avec neutralisation anti-injection de formule), `Règles de catégorisation` (CRUD, priorité `Monter`/`Descendre`, réapplication globale protégée) et `Catégories` (arbre 2 niveaux).
  - Protection absolue des choix manuels : `is_manual_category = true`, `transfer_group_id !== null` et `is_manual_transfer_override = true` ne sont jamais écrasés par les règles.

### 3. Android APK Capacitor Offline-First, Outbox SQL & Distribution
- **Configuration Capacitor (`apps/web/capacitor.config.ts`)** : cible `com.clairflux.finance` (`webDir: 'dist'`, `androidScheme: 'https'`, `allowMixedContent: false`, `adjustMarginsForEdgeToEdge: 'auto'`), polices `@fontsource/*` bundlées localement, interception bouton retour Android (`[popover]` puis `<dialog open>`) et retour haptique léger.
- **Consultation intégrale + Notes rapides hors-ligne (`apps/web/src/offline/`)** :
  - Cache local `IndexedDB` (`clairflux_offline_v1`) avec fallback mémoire, conservant comptes, transactions, notes, catégories, règles, budgets et statuts Drive.
  - **Outbox hors-ligne** (`outbox_mutations`) : ajout/modification de notes rapides et recatégorisations manuelles via le tiroir `<dialog>` (`BottomSheetNoteDialog`) même sans réseau, bouton de synchronisation immédiate dans `OfflineStatusBanner` / `SyncDrivePanel`, rejeu idempotent par `client_mutation_id` (`POST /api/sync/delta`) garanti côté serveur par **`applied_client_mutations`**, et tirage incrémental (`GET /api/sync/delta?since=...`).
  - **Garde stricte hors-ligne** : la synchronisation Drive/Gemini et l'édition structurelle des catégories (`/api/categories`) sont explicitement bloquées hors connexion.
- **Compilation & distribution APK** :
  - Conteneur dédié **`apk-builder`** ([`./Dockerfile.apk-builder`](./Dockerfile.apk-builder) + [`./scripts/build-apk.sh`](./scripts/build-apk.sh)) produisant `clairflux-release.apk` et `clairflux-release.apk.sha256` dans `apk-artifacts:/shared-apk`.
  - Endpoints API authentifiés **`GET /api/apk/status`** et **`GET /api/apk/download`** consommés par **`ApkDownloadCard`**.
  - Workflow CI alternatif sans Docker local : [`.github/workflows/build-apk.yml`](./.github/workflows/build-apk.yml) (`workflow_dispatch` et tags `v*`).

### 4. Déploiement Docker Multi-Stage & Isolation Réseau
- **4 services orchestrés (`docker-compose.yml`)** :
  - `web` ([`./apps/web/Dockerfile`](./apps/web/Dockerfile)) : build Vite multi-stage → `nginxinc/nginx-unprivileged:1.27-alpine` non-root (`8080`), reverse-proxy `/api/`, fallback SPA `try_files $uri /index.html`, headers sécurité, zéro secret serveur.
  - `api` ([`./apps/api/Dockerfile`](./apps/api/Dockerfile)) : multi-stage `node:22-alpine`, exécution non-root `USER node` sur `apps/api/src/server.ts`, `HEALTHCHECK` `/healthz` (`3000`), volume `apk-artifacts:/shared-apk:ro`, connecté à `frontend_net` et `backend_net`.
  - `sync-worker` ([`./apps/sync-worker/Dockerfile`](./apps/sync-worker/Dockerfile)) : multi-stage `node:22-alpine`, exécution non-root `USER node` sur `apps/sync-worker/src/gemini-pipeline.ts`, `HEALTHCHECK` `/healthz` (`4001`), isolé exclusivement sur `backend_net`.
  - `apk-builder` ([`./Dockerfile.apk-builder`](./Dockerfile.apk-builder)) : JDK 21, Android SDK 35, Node 22, Capacitor et Gradle générant l'APK dans `apk-artifacts:/shared-apk` sans aucun secret Neon/Gemini/Drive.

---

## Index des packages (EGM Blueprint)

| Workspace / Artefact | Rôle (`v1.1.0-build.1`) | Documentation EGM |
| :--- | :--- | :--- |
| **`@clairflux/shared`** | Contrats Zod partagés, Branded Types, constantes Drive, pack français de catégories à 2 niveaux, arithmétique centimes/FX et `CLAIRFLUX_BUILD_VERSION`. | [./packages/shared/README.md](./packages/shared/README.md) |
| **`@clairflux/api`** | API HTTP Node 22 (`Hono` + `apps/api/src/server.ts`), auth Argon2id/HMAC-SHA256 + CSRF fail-closed, routes métier (`/api/categories`, `/api/transactions`, `/api/rules`, `/api/budgets`, `/api/aggregates`, `GET/POST /api/sync/delta`, `POST /api/sync/drive`, `GET /api/apk/status`, `GET /api/apk/download`), persistance Drizzle Neon & migrations Expand. | [./apps/api/README.md](./apps/api/README.md) |
| **`@clairflux/sync-worker`** | Worker isolé Drive (2 dossiers exclusifs) + `pdfjs-dist` en sous-processus + fallback OCR Gemini (`x-goog-api-key`) + resolver FX BCE + checkpoints SQL Neon (`backend_net`). | [./apps/sync-worker/README.md](./apps/sync-worker/README.md) |
| **`@clairflux/web`** | Frontend React 19 + Vite + Recharts + Grand Livre (`Opérations`, `Règles`, `Catégories` 2 niveaux) + Export CSV sécurisé + `<dialog>` adaptatif Pixel 8 Portrait/Paysage + moteur Offline IndexedDB/Outbox + `ApkDownloadCard` + `capacitor.config.ts`. | [./apps/web/README.md](./apps/web/README.md) |

---

## Documentation normative, produit & exploitation

- [Mode d'emploi ClairFlux (`docs/USER_GUIDE.md`)](./docs/USER_GUIDE.md)
- [Journal des versions (`CHANGELOG.md`)](./CHANGELOG.md)
- [Guide de Mise en Production (`PRODUCTION_DEPLOY.md`)](./PRODUCTION_DEPLOY.md)
- [Design Draft EGM v2 — Catégories IA, Budget Monarch & Pack Analytique](./docs/architecture/design_draft_ai_budget_analytics.md)
- [Audit de compatibilité Baseline & WebView Android v2](./docs/architecture/audit_baseline_modern_web_v2.md)
- [Spécification Prototype Mock-First v2](./docs/prototypes/PROTOTYPE_SPEC_V2.md)
- [Standards techniques & normes d'ingénierie](./docs/TECHNICAL_STANDARDS.md)
- [Modèle de données Neon PostgreSQL & Drizzle ORM](./docs/DATA_MODEL_DRIZZLE_SPEC.md)
- [Contrat formel d'API, Delta Sync & Infrastructure](./docs/API_DELTA_SYNC_CONTRACT.md)
- **ADRs** :
  - [0001 — Exclusivité Drive & Déduplication](./docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)
  - [0002 — Ledger Neon/Drizzle & Checkpoints](./docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)
  - [0003 — Capacitor Offline-First & Delta Sync](./docs/ADR/0003-capacitor-offline-first-delta-sync.md)
  - [0004 — UI Baseline & Architecture Recharts](./docs/ADR/0004-ui-baseline-and-recharts-architecture.md)
  - [0005 — Catégories Hiérarchiques à 2 Niveaux & Catégorisation Hybride Gemini](./docs/ADR/0005-categories-hierarchy-and-gemini-hybrid-categorization.md)
  - [0006 — Budget Monarch par Catégorie, Rollover, Projections & Analytique](./docs/ADR/0006-monarch-budget-rollover-and-forecasting.md)

---

## Commandes de vérification & mise en service

Exécuter depuis la racine du monorepo :

```bash
# 1. Bootstrap initial du schéma Drizzle sur une base Neon vierge (sslmode=require)
#    Note : pour toute évolution ultérieure du schéma en production avec données existantes,
#    utiliser les migrations SQL versionnées (`db:generate` + `db:migrate`, cf. DATA_MODEL_DRIZZLE_SPEC.md).
npm --workspace apps/api run db:push

# 2. Vérification TypeScript stricte sur tous les workspaces
npm run typecheck

# 3. Exécution de la suite de tests Vitest
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
