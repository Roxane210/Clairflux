# Document de Reprise de Session — ClairFlux (`v1.0.0-rc1+`)

> **Objectif de ce document** : Fournir à la nouvelle conversation tout le contexte technique, métier, infrastructurel et de gouvernance pour reprendre immédiatement la mise en production, la recette terrain, la correction de bugs et l'ajout de nouvelles fonctionnalités sur **ClairFlux**.

---

## 1. Profil Utilisateur & Règles de Gouvernance

- **Product Owner** : Non-développeur. Toujours communiquer en **français clair, orienté usage et résultat fonctionnel** (sans jargon inutile).
- **Cadrage obligatoire** : Pour toute nouvelle idée ou fonctionnalité non spécifiée, utiliser `.agent/skills/interview-me/SKILL.md` (une question à la fois avec hypothèse argumentée et options pré-calculées) avant de proposer un plan, puis `.agent/skills/idea-refine/SKILL.md` et `.agent/skills/prototype/SKILL.md` (validation visuelle Mock-First) si nécessaire.
- **Ingénierie & `/swarm`** :
  - Appliquer `.agent/skills/swarm-egm-engineering/SKILL.md` (documentation normative avant code, Standard Matt Pocock TypeScript strict sans `any`, Zod aux frontières, Branded Types, Standard Addy Osmani, Git Atomique + Conventional Commits).
  - Autorisation permanente d'utiliser **`/swarm`** dès que la parallélisation apporte un gain, avec **max 5 fichiers par worker**, modèle **Gemini 4 Hydrogen (High)** (bascule temporaire sur **Argon (High)** uniquement si quota Hydrogen < 5 %), et double validation obligatoire par `optimizer_agent` + `reviewer_agent`.
- **Diagnostic de bugs** : Appliquer `.agent/skills/diagnosing-bugs` (ou skill global `diagnosing-bugs`) avec boucle de reproduction rouge-capable avant toute correction, et respect du Standard Matt Pocock.
- **Écosystème de Skills & Audit installés dans `.agent/`** :
  - `.agent/skills/modern-web-guidance/` (26 guides officiels Baseline Chrome/Safari/Firefox + Android System WebView)
  - `.agent/skills/frontend-ui-engineering/`, `.agent/skills/mobbin/`, `.agent/skills/prototype/`
  - `.agent/skills/neon-drizzle-ledger/`, `.agent/skills/docker-capacitor-apk/`
  - `.agent/workflows/audit-bot.md` (exécutable via `npm run audit` → `scripts/run-audit-bot.mjs`)

---

## 2. État Actuel du Dépôt & Documentation Normative

- **Workspace local** : `d:/Applications/Clairflux`
- **Dépôt GitHub** : `https://github.com/Roxane210/Clairflux.git`
- **Branche & Tags synchronisés** : `main` sur commit **`2a17d60`** (`fix(web): ajouter le reverse-proxy /api dans Nginx et corriger le double prefixe /api`) · Tags : `v0.1.0-m1`, `v0.2.0-m2`, `v1.0.0-rc1`.
- **État qualité vérifié à `2a17d60`** :
  - `npm run audit` : **PASS (100 %)**
  - `npm run typecheck` : **PASS** (4 workspaces `@clairflux/shared`, `@clairflux/api`, `@clairflux/sync-worker`, `@clairflux/web` + `apps/web/capacitor.config.ts`)
  - `npm test` : **86 / 86 tests PASS** (8 fichiers Vitest, incluant les tests de non-régression `/api` et `ApkDownloadCard`)
  - `npm run build` : **PASS** (476 modules, zéro fuite de secret dans `apps/web/dist/`)
- **Documents normatifs de référence** :
  - `docs/intent/clairflux-mvp.md` & `docs/ideas/critical-flows.md`
  - `docs/TECHNICAL_STANDARDS.md`
  - `docs/DATA_MODEL_DRIZZLE_SPEC.md`
  - `docs/API_DELTA_SYNC_CONTRACT.md`
  - `docs/ADR/0001..0004`
  - `PRODUCTION_DEPLOY.md` & `.env.example`

---

## 3. Contrats Métier & Techniques Verrouillés (Ne Pas Casser)

1. **Sources Google Drive exclusives (Déclenchement 100 % manuel)** :
   - **BoursoBank** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
   - **Revolut** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
   - Zéro polling automatique en arrière-plan ; conservation définitive de l'historique même si un PDF quitte Drive.
2. **Multi-comptes & Multi-devises (EUR / USD)** :
   - Plusieurs comptes par banque détectés et renommables (`courant`, `epargne`, `carte_differee`, `multi_devises`, `coffre`, `autre`).
   - Montants en **centimes entiers** (`bigint` / `Cents`, zéro flottant) et taux de change figé en micro-unités (`fx_rate_micro`).
   - Consolidation en EUR + bascule **« Vue USD seul »** ; virements internes et paires de change `EUR ↔ USD` marqués `Transfert interne` et exclus des dépenses.
3. **Ingestion PDF Gemini & Checkpoints SQL** (`apps/sync-worker`) :
   - Extraction `pdfjs-dist` + suppression du boilerplate bancaire + découpage en lots bornés.
   - Chaîne de fallback Gemini : `gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite` (clé passée via header `x-goog-api-key`).
   - Checkpoints SQL persistants dans Neon (`pdf_ingestion_checkpoints`) pour reprise granulaire par fichier/lot sans doublon (`dedup_hash`).
4. **Règles, Budgets & Notes Rapides Offline-First** :
   - Réapplication globale des règles respectant strictement `is_manual_category = true`, `transfer_group_id !== null` et `is_manual_transfer_override = true`.
   - Alertes budgets avec seuils `80 %` et `100 %` persistées dans Neon (`budget_limits`).
   - Mode hors-ligne (`IndexedDB` `clairflux_offline_v1`) : consultation complète des tableaux de bord, budgets et opérations **+** ajout/modification de notes rapides et recatégorisations via `outbox_mutations`, avec flush idempotent vers `POST /api/sync/delta` (`applied_client_mutations` dans Neon). La synchro Drive/Gemini reste désactivée hors-ligne.
5. **UI / Ergonomie & Baseline** :
   - Typographie locale offline `@fontsource/*` : `Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono` (`tabular-nums`).
   - Élévation unique (zéro cartes imbriquées, zéro pills statiques), cibles tactiles `>= 44×44px`, Bottom Tab Bar fixe `< 1024px` (`64px` = `7.6 % <= 15 %` du viewport), `<dialog>` natif (`overscroll-behavior: contain`), `@container`, `:has()` borné, `:user-valid/:user-invalid`, `content-visibility: auto; contain-intrinsic-size: auto 72px`.
   - Graphiques Recharts : **Solde cumulé 6M** et **Dépenses mensuelles** (3 modes : `Sans comparaison`, `M-1`, `Moyenne 3 mois`).
6. **Routage Reverse-Proxy Nginx & URLs API (`/api`)** :
   - `apps/web/Dockerfile` expose le port `8080` et doit impérativement proxifier `location /api/` vers `http://api:3000` (sans slash final sur `proxy_pass`, `Host $http_host`, `proxy_read_timeout 300s`).
   - Tous les appels API du client passent par `buildApiEndpointUrl` (`apps/web/src/offline/apiUrl.ts`) afin de supporter `VITE_API_BASE_URL=/api` (Docker) comme `https://domaine` ou `""` sans jamais générer `/api/api/...`.

---

## 4. Infrastructure Production (NAS Synology & Neon)

- **Serveur / NAS** : Synology `SynHugLib` — **DS220+** (`DSM 7.4.1-90080 Update 2`), CPU Intel Celeron J4025 (`x86_64`), **18 Go RAM**, IP LAN **`192.168.1.118`**.
- **Base de données Neon PostgreSQL** :
  - Org `org-spring-leaf-34062468`, Projet `cool-fog-85317702`, Branche `production`.
  - Variables tirées localement dans `.env.local` *(git-ignoré)*.
  - Les **11 tables Drizzle** sont déjà créées sur la branche `production` (`drizzle-kit push --force` exécuté avec succès).
  - **Règle d'évolution future du schéma** : utiliser `npm --workspace apps/api run db:generate` puis `db:migrate` (migrations SQL versionnées).
- **Portainer & Docker Compose** :
  - Ports utilisés ailleurs sur le NAS : `2222`, `3010`, `3030`, `3080`, `4000`, `8000`, `8005`, `8085`, `8086`, `8087`, `8088`, `8090`, `8110`, `8642`, `9000`, `9119`.
  - Port ClairFlux : **`CLAIRFLUX_WEB_PORT=8080`** (`CLAIRFLUX_WEB_ORIGIN=http://192.168.1.118:8080`). `api` (`3000`) et `sync-worker` (`4001`) restent internes.
  - État connu de la stack `depense_budget` :
    - `api-1` : **`healthy`**.
    - `apk-builder-1` : **`exited - code 0`** (`clairflux-release.apk` généré dans `apk-artifacts:/shared-apk`, SHA-256 : `165422ac9c2291a860e7cdeb8bf00aefb8b58a8040434a0d39ac5ac7ae3e1da8`).
    - `web-1` : tournait sur la version pré-`2a17d60` (sans proxy `/api/` dans Nginx et avec double `/api/api/` côté bundle), provoquant `HTTP 405` sur `POST /api/sync/drive` et réponse HTML sur `GET /api/apk/status`. Le correctif **`2a17d60`** est poussé sur `origin/main` ; redéploiement Portainer (`Update the stack` + rebuild de `web`) à vérifier.
    - `sync-worker-1` : nécessite `/volume1/docker/clairflux/google_drive_credentials.json` (`GOOGLE_DRIVE_CREDENTIALS_HOST_PATH=/volume1/docker/clairflux/google_drive_credentials.json`) et un jeton/credentials Drive valides. Un nouveau PDF a été déposé par le PO dans l'un des 2 dossiers Drive pour test réel.

---

## 5. Point de Départ pour la Nouvelle Conversation

1. Vérifier auprès du PO le résultat du redéploiement Portainer (commit `2a17d60`) sur `http://192.168.1.118:8080` : disparition des erreurs `HTTP 405` et `Réponse JSON invalide reçue depuis /api/apk/status`, et affichage des métadonnées APK.
2. Vérifier l'état de `sync-worker-1` et déclencher la synchronisation manuelle (`POST /api/sync/drive`) pour ingérer le nouveau PDF déposé dans Google Drive (BoursoBank / Revolut).
3. Valider la connexion (`CLAIRFLUX_ACCESS_SECRET_HASH`), la qualité du parsing PDF réel (EUR/USD) et l'installation/usage hors-ligne de `clairflux-release.apk` sur Android.
4. Traiter les éventuels retours terrain (parsing PDF réel, ergonomie, nouvelles fonctionnalités via `interview-me` + `/swarm`).
