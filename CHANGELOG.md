# Journal des versions (Changelog) — ClairFlux

Toutes les évolutions notables de **ClairFlux** sont consignées dans ce fichier, avec les versions applicatives (`CLAIRFLUX_BUILD_VERSION` / `docker-compose.yml`), la documentation normative associée et l'état vérifié de production.

---

## [1.1.0-build.2] - 2026-11-26 — Lot 2 : Catégorisation hybride IA Gemini, Boîte de révision & Suggestions de règles

### Base de données additive (Expand) & Contrats partagés
- **Migration SQL additive `0002_lot2_ai_categorization_expand.sql` & `ensureLot2AiSchema`** : création idempotente des enums `ai_backfill_run_status` / `ai_rule_suggestion_status`, des tables **`ai_categorization_runs`** (index unique partiel garantissant un seul lot actif à la fois) et **`ai_rule_suggestions`** (index unique par `merchant_pattern`), ainsi que d'un index partiel sur la file de révision `transactions(ai_review_status)` — zéro `DROP`/`TRUNCATE`/`DELETE`.
- **Module partagé `packages/shared/src/ai.ts`** : seuil normatif `AI_AUTO_APPLY_CONFIDENCE_BP = 8500` (`85 %`), taille de lot `AI_BATCH_SIZE = 50`, seuil `AI_RULE_SUGGESTION_MIN_SAMPLES = 3`, défense anti-prompt-injection (`sanitizeBankLabelForAi`), extraction normalisée de motif commerçant (`extractMerchantPatternForRule`) et extension rétrocompatible de `TransactionSchema` / `DeltaSyncResponseSchema`.

### Moteur batch Gemini (`sync-worker`) & API (`/api/ai/*`)
- **Pipeline IA par lots de 50 opérations (`sync-worker`)** : exécution exclusivement manuelle via la chaîne de repli 3 modèles **`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`** (clé `GEMINI_API_KEY` isolée dans `sync-worker` via en-tête `x-goog-api-key`), respect absolu de la priorité **`Manuel > Virement interne > Règle utilisateur > IA Gemini`**.
- **Aiguillage intelligent & détection de règles** : application automatique à `>= 85 %`, placement en file de révision (`pending_review`) sous `< 85 %`, et génération automatique de suggestions de règles gratuites dès 3 opérations similaires sans règle.
- **Routes REST `/api/ai/*`** :
  - `POST /api/ai/categorize/backfill`, `GET /api/ai/categorize/status`, `POST /api/ai/categorize/cancel` (lancement manuel, suivi temps réel et annulation coopérative),
  - `GET /api/ai/review-queue`, `POST /api/ai/review-queue/resolve` (résolution unitaire ou par lot : `accept`, `override`, `reject` + option `create_rule`),
  - `GET /api/ai/rule-suggestions`, `POST /api/ai/rule-suggestions/:id/accept`, `POST /api/ai/rule-suggestions/:id/dismiss`,
  - Extension rétrocompatible de `GET /api/sync/delta` (`ai_rule_suggestions`, `pending_ai_review_count`).

### Interface Web & Mobile
- **Sous-onglet `Transactions > À réviser (IA)`** : liste des opérations `< 85 %` avec explication IA et score de confiance, actions rapides (Valider en 1 clic, Corriger sur 2 niveaux, Ignorer, ou Valider + Créer une règle permanente) et encart **Suggestions de règles gratuites** (Accepter / Ignorer en 1 clic).
- **Panneau de rattrapage IA dans `Synchro`** : lancement manuel sur les opérations sans règle, barre de progression en direct (lots, auto-appliquées, à réviser) et bouton **Annuler** (verrouillé hors-ligne).
- **Infrastructure & Documentation** : passage de `docker-compose.yml` à `1.1.0-build.2` (aucun ajout requis dans `.env`) et mise à jour de [`README.md`](./README.md), [`CHANGELOG.md`](./CHANGELOG.md) et [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md).

---

## [1.1.0-build.1] - 2026-11-26 — Lot 1 : Catégories 2 niveaux & Google Pixel 8 Portrait/Paysage

### Ajouts fonctionnels & API
- **Arbre de Catégories & Sous-catégories à 2 niveaux** :
  - Ajout du référentiel hiérarchique (`Catégorie → Sous-catégorie`, profondeur strictement bornée à 2 niveaux) rattaché aux groupes budgétaires canoniques (`budget_group_enum` : Revenus, Charges fixes, Dépenses variables, Non-mensuelles, Épargne, Transferts).
  - Fourniture d'un **pack français initial** (12 catégories racines + sous-catégories et repli protégé *Non catégorisé*), 100 % modifiable, fusionnable et supprimable.
  - Exposition des routes REST **`/api/categories`** : `GET /api/categories`, `POST /api/categories`, `PATCH /api/categories/:id`, `POST /api/categories/:id/merge` (fusion atomique avec réaffectation), `DELETE /api/categories/:id` (réaffectation obligatoire et protection des catégories système).
  - Extension rétrocompatible de **`GET /api/sync/delta`** incluant les `categories` pour le cache hors-ligne.
- **Interface `Transactions > Catégories` & Sélecteur 2 niveaux** :
  - Nouveau sous-onglet **Catégories** dans le Grand Livre (`TransactionsSection` + `CategoriesTab`) avec arbre natif `<details>`/`<summary>` groupé par type budgétaire et modale `<dialog>` (créer, modifier, fusionner, supprimer avec réaffectation).
  - Sélecteur groupé à 2 niveaux (`<optgroup>`) dans le tiroir d'opération (`BottomSheetNoteDialog`) et dans l'onglet **Règles de catégorisation** (`RulesTab`).
  - Verrouillage propre des mutations structurelles de catégories hors-ligne tout en conservant la consultation complète et l'outbox pour les notes rapides et recatégorisations manuelles.
- **Migration base de données Neon (Expand)** :
  - Ajout additif sans aucune perte de données (`0001_lot1_categories_expand.sql` et `ensure-v2-schema.ts`) avec rétrocompatibilité descendante (`transactions.category` et `categorization_rules.target_category`).

### Améliorations Mobile & Google Pixel 8 (Portrait / Paysage / Android 15)
- **Google Pixel 8 Portrait (`412×915`) & Mobile minimal (`320×568`)** :
  - Ajout de `interactive-widget=resizes-content` dans `<meta name="viewport">` pour préserver l'accès aux champs de saisie lorsque le clavier virtuel s'ouvre.
  - Distinction CSS `.cf-dialog--modal` (modale centrée Desktop / tiroir bas mobile) vs `.cf-dialog--drawer` et correction du focus clavier sur l'onglet *Transactions* (`ledger-heading`).
- **Google Pixel 8 Paysage (`915×412`, rotations 90° & 270°)** :
  - Sous `@media (orientation: landscape) and (max-height: 500px)`, masquage de la barre basse et bascule automatique vers un rail latéral gauche compact (`76 px`), `0 %` de sticky vertical, absorption des 4 `env(safe-area-inset-*)` face au poinçon caméra et bascule de `<dialog>` en panneau latéral droit.
- **APK Android 15 / SDK 35** :
  - Configuration `adjustMarginsForEdgeToEdge: 'auto'` et `webContentsDebuggingEnabled: false` dans `apps/web/capacitor.config.ts`.
  - Patch automatique du manifeste et des styles Android dans `scripts/build-apk.sh` (`screenOrientation="fullUser"`, `configChanges` complet évitant tout rechargement à la rotation, `windowSoftInputMode="adjustResize"`, `windowLayoutInDisplayCutoutMode="shortEdges"`, `windowLightStatusBar` et `windowLightNavigationBar`).
  - Fermeture prioritaire des `[popover]` ouverts avant `<dialog open>` sur le bouton Retour Android.

### Documentation & Gouvernance EGM
- Création de [`CHANGELOG.md`](./CHANGELOG.md) et du mode d'emploi [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md).
- Mise à jour de [`README.md`](./README.md) et de [`docker-compose.yml`](./docker-compose.yml) vers `1.1.0-build.1`.
- Documentation normative v2 de référence : [`docs/architecture/design_draft_ai_budget_analytics.md`](./docs/architecture/design_draft_ai_budget_analytics.md), [`docs/ADR/0005`](./docs/ADR/0005-categories-hierarchy-and-gemini-hybrid-categorization.md), [`docs/ADR/0006`](./docs/ADR/0006-monarch-budget-rollover-and-forecasting.md), [`docs/architecture/audit_baseline_modern_web_v2.md`](./docs/architecture/audit_baseline_modern_web_v2.md) et [`docs/prototypes/PROTOTYPE_SPEC_V2.md`](./docs/prototypes/PROTOTYPE_SPEC_V2.md).

---

## [1.0.1-build.3] - 2026-11-24 — État de production vérifié & Pipeline Multi-Devises

### État de production vérifié
- **Ingestion complète validée sur Neon PostgreSQL** : **17 relevés PDF** traités (BoursoBank & Revolut), **2 940 transactions** consolidées et **40 taux de change FX** historiques enregistrés en base.

### Corrections & Stabilisation (`1.0.1-build.1` → `1.0.1-build.3`)
- **Taux de change BCE & normalisation Revolut** : branchement du resolver FX BCE (taux historiques `USD → EUR` en micro-unités `fx_rate_micro`), filtrage GBP et mapping des opérations d'investissement Revolut.
- **Robustesse pipeline PDF & Gemini** : isolation de `pdfjs-dist` en sous-processus dédié avec encadrement `stdout`, ajout d'un fallback OCR natif Gemini, sécurisation du Pool Neon et des contraintes de checkpoints (`chk_checkpoint_failed_code`), support du compte de service Google Drive.
- **Traçabilité applicative** : exposition et alignement de `CLAIRFLUX_BUILD_VERSION` sur `@clairflux/shared`, `api`, `sync-worker`, `web` et `docker-compose.yml`.

---

## [1.0.0-rc1] - Socle initial ClairFlux (Jalon 3)

### Fondations livrées
- **Architecture EGM & Monorepo** : `@clairflux/shared`, `@clairflux/api`, `@clairflux/sync-worker` et `@clairflux/web`, audit automatisé en 6 points (`npm run audit`), arithmétique stricte en centimes entiers (`bigint` / `Cents`).
- **Authentification & Sécurité** : déverrouillage personnel `/api/auth/*` (hash Argon2id, jeton session HMAC-SHA256, protection CSRF fail-closed, anti-brute-force 5 échecs / 15 min).
- **Synchronisation Google Drive manuelle exclusive** : périmètre verrouillé sur les 2 dossiers **BoursoBank** et **Revolut**, reprise granulaire par checkpoints SQL et déduplication `md5_checksum` / `dedup_hash`.
- **Synthèse, Grand Livre & Export CSV** : filtres globaux temporels (`1 semaine` à `Tout` / `Personnalisé`) et devise (`EUR consolidé` / `USD seul`), graphiques Recharts (*Solde bancaire cumulé* et *Dépenses* avec 3 modes de comparaison), alertes budgets `80 % / 100 %`, règles de catégorisation ordonnées et export CSV UTF-8 BOM anti-injection de formule.
- **Android APK Capacitor Offline-First** : stockage local `IndexedDB` (`clairflux_offline_v1`), file d'attente outbox idempotente (`applied_client_mutations`), conteneur `apk-builder` et workflow GitHub Actions `.github/workflows/build-apk.yml`.
