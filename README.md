# ClairFlux

Application personnelle de suivi financier multi-banques et multi-comptes (**BoursoBank** & **Revolut**), conçue selon la gouvernance **EGM (Elephant-and-Goldfish Model)** : spécifications normatives verrouillées avant code, arithmétique comptable exacte en centimes entiers, ingestion PDF manuelle via Google Drive & Gemini, et application Web / APK Android **Offline-First**.

- **Dépôt GitHub officiel** : <https://github.com/Roxane210/Clairflux>

---

## Vue d'ensemble fonctionnelle & invariants (Jalon 2)

### 1. Périmètre Google Drive exclusif, extraction PDF & reprise Gemini
- **Lecture seule stricte (`drive.readonly`)** limitée à **deux dossiers Google Drive codés en dur** (validés dans `@clairflux/shared`, `@clairflux/api`, `@clairflux/sync-worker` et par contrainte SQL `CHECK` dans PostgreSQL Neon) :
  - **BoursoBank** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
  - **Revolut** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
- **Déclenchement 100 % manuel** (`POST /api/sync/drive` -> `POST /internal/runs` authentifié par `INTERNAL_WORKER_TOKEN` avec `timingSafeEqual`) : aucun cron, aucun webhook, aucun polling automatique en arrière-plan.
- **Pipeline PDF `pdfjs-dist` + Chaîne de fallback Gemini** : découpage PDF avec suppression du boilerplate bancaire en lots bornés (`drive-pdf.ts`), extraction structurée validée par Zod sur la chaîne ordonnée **`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`**, résolution `fx_rate_micro` et reprise granulaire par checkpoints SQL PostgreSQL Neon (`pending | skipped | extracting | parsed | committing | committed | failed`, contrôle `md5_checksum` et `dedup_hash`).

### 2. Multi-comptes, multi-devises EUR / USD, budgets & grand livre
- **Multi-comptes par banque** : prise en charge de plusieurs comptes et poches par banque (`courant`, `epargne`, `carte_differee`, `multi_devises`, `coffre`, `autre`), librement renommables (`nickname`).
- **Zéro flottant & conversion historique figée** : montants en centimes entiers (`amount_cents`, `amount_eur_cents`) et taux `USD -> EUR` en micro-unités (`fx_rate_micro`, `1.000000 = 1_000_000`) figés à `booking_date`.
- **Synthèse Recharts 6M & Dépenses 3 modes + Alertes Budgets** :
  - **Solde cumulé 6M** (`AreaChart`) avec périmètre `Tous les comptes` / `BoursoBank` / `Revolut` et bascule `EUR consolidé` / `USD seul`.
  - **Dépenses mensuelles** (`AreaChart`) avec sélecteur 3 modes (`Sans comparaison`, `Mois précédent (M-1)`, `Moyenne 3 mois`) excluant strictement les transferts internes.
  - **Alertes budgets mensuels** (`/api/budgets`) avec seuils visuels + textuels explicites (`ok < 80 %`, `warning 80–99 %`, `exceeded >= 100 %`).
- **Grand livre, Règles & Export CSV sécurisé** :
  - Sous-onglets `Opérations` (filtre *« Avec notes »*, recherche, colonnes *Banque* & *Type de compte*, Export CSV `;` UTF-8 BOM avec neutralisation anti-injection de formule) et `Règles de catégorisation` (CRUD, priorité `Monter`/`Descendre`, réapplication globale protégée).
  - Protection absolue des choix manuels : `is_manual_category = true`, `transfer_group_id !== null` et `is_manual_transfer_override = true` ne sont jamais écrasés par les règles.

### 3. Android APK Capacitor Offline-First & Outbox Notes Rapides
- **Configuration Capacitor (`apps/web/capacitor.config.ts`)** : cible `com.clairflux.finance` (`webDir: 'dist'`, `androidScheme: 'https'`, `allowMixedContent: false`), polices `@fontsource/*` bundlées localement, interception bouton retour Android sur `<dialog open>` et retour haptique léger.
- **Consultation intégrale + Notes rapides hors-ligne (`apps/web/src/offline/`)** :
  - Cache local `IndexedDB` (`clairflux_offline_v1`) avec fallback mémoire, conservant comptes, transactions, notes, règles, budgets et statuts Drive.
  - **Outbox hors-ligne** (`outbox_mutations`) : ajout/modification de notes rapides (et recatégorisations manuelles) via le tiroir `<dialog>` (`BottomSheetNoteDialog`) même sans réseau, avec rejeu automatique idempotent par `client_mutation_id` (`POST /api/sync/delta`) et tirage incrémental (`GET /api/sync/delta?since=...`) au retour réseau.
  - **Garde stricte Drive/Gemini hors-ligne** : la synchronisation Drive/Gemini reste explicitement bloquée hors connexion (`canTriggerDriveSync(false)`).

### 4. Déploiement Docker Multi-Stage & Isolation Réseau
- **3 services orchestrés (`docker-compose.yml`)** :
  - `web` ([`./apps/web/Dockerfile`](./apps/web/Dockerfile)) : build Vite multi-stage -> `nginxinc/nginx-unprivileged:1.27-alpine` non-root (`8080`), fallback SPA `try_files $uri /index.html`, `immutable` sur `/assets/`, `no-cache` sur `index.html` (bfcache préservé), headers sécurité, zéro secret serveur.
  - `api` ([`./apps/api/Dockerfile`](./apps/api/Dockerfile)) : multi-stage `node:22-alpine`, exécution non-root `USER node` sur `apps/api/src/server.ts`, `HEALTHCHECK` `/healthz` (`3000`), connecté à `frontend_net` et `backend_net`.
  - `sync-worker` ([`./apps/sync-worker/Dockerfile`](./apps/sync-worker/Dockerfile)) : multi-stage `node:22-alpine`, exécution non-root `USER node` sur `apps/sync-worker/src/gemini-pipeline.ts`, `HEALTHCHECK` `/healthz` (`4001`), isolé exclusivement sur `backend_net` (aucun port hôte exposé).

---

## Index des packages (EGM Blueprint)

| Workspace / Artefact | Rôle en Jalon 2 | Documentation EGM |
| :--- | :--- | :--- |
| **`@clairflux/shared`** | Contrats Zod partagés, Branded Types, constantes Drive, arithmétique centimes/FX et utilitaires purs (zéro secret, zéro dépendance Node/DOM). | [./packages/shared/README.md](./packages/shared/README.md) |
| **`@clairflux/api`** | API HTTP Node 22 (`Hono` + `apps/api/src/server.ts`), auth HMAC-SHA256 + CSRF fail-closed, routes complètes (`/api/transactions`, `/api/rules`, `/api/budgets`, `/api/analytics/overview`, `GET/POST /api/sync/delta`, `POST /api/sync/drive`), Drizzle Neon & `Dockerfile` multi-stage. | [./apps/api/README.md](./apps/api/README.md) |
| **`@clairflux/sync-worker`** | Worker isolé Drive (`drive.readonly` sur 2 dossiers exclusifs) + découpage `pdfjs-dist` + fallback Gemini 3 modèles + `fx_rate_micro` + checkpoints SQL Neon & `Dockerfile` multi-stage (`backend_net`). | [./apps/sync-worker/README.md](./apps/sync-worker/README.md) |
| **`@clairflux/web`** | Frontend React 19 + Vite + Recharts 6M & Dépenses 3 modes + alertes budgets 80%/100% + Grand Livre/Règles + Export CSV sécurisé + Bottom Sheet `<dialog>` + moteur Offline IndexedDB/Outbox + `capacitor.config.ts` & `Dockerfile` Nginx non-root. | [./apps/web/README.md](./apps/web/README.md) |

---

## Documentation normative (Source de vérité Pré-Code)

- [Standards techniques & normes d'ingénierie](./docs/TECHNICAL_STANDARDS.md)
- [Modèle de données Neon PostgreSQL & Drizzle ORM](./docs/DATA_MODEL_DRIZZLE_SPEC.md)
- [Contrat formel d'API, Delta Sync & Infrastructure](./docs/API_DELTA_SYNC_CONTRACT.md)
- **ADRs** :
  - [0001 — Exclusivité Drive & Déduplication](./docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)
  - [0002 — Ledger Neon/Drizzle & Checkpoints](./docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)
  - [0003 — Capacitor Offline-First & Delta Sync](./docs/ADR/0003-capacitor-offline-first-delta-sync.md)
  - [0004 — UI Baseline & Architecture Recharts](./docs/ADR/0004-ui-baseline-and-recharts-architecture.md)

---

## Commandes de vérification

Exécuter depuis la racine du monorepo :

```bash
# 1. Vérification TypeScript stricte sur tous les workspaces
npm run typecheck

# 2. Exécution de la suite de tests Vitest (zéro test skippé)
npm test

# 3. Contrôle statique & build de production Frontend (@clairflux/web)
npm run lint
npm run build

# 4. Validation de la configuration Docker Compose
docker compose config
```
