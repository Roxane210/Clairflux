# `@clairflux/web`

Interface utilisateur React 19 + Vite 7 + CSS natif Baseline + Recharts pour ClairFlux (`v1.0.0-rc1`), ciblant le Web Desktop (`>= 1024px` / `1440×900`) et l'application mobile Android APK Capacitor (`< 1024px` / `390×844` / `320px`, Offline-First avec Outbox locale).

> Guide de compilation APK (`Dockerfile.apk-builder`, `.github/workflows/build-apk.yml`) et d'installation Android : [../../PRODUCTION_DEPLOY.md](../../PRODUCTION_DEPLOY.md)

---

## Interface

### 1. Entrée, Shell & Configuration ([`index.html`](./index.html), [`vite.config.ts`](./vite.config.ts), [`capacitor.config.ts`](./capacitor.config.ts), [`src/main.tsx`](./src/main.tsx))
- **`src/main.tsx`** : composant racine `ClairFluxApp` (`< 200` lignes) orchestrant la navigation par union discriminée `AppTab` (`'overview' | 'transactions' | 'sync'`), le sous-onglet `TransactionsSubTab` (`'operations' | 'rules'`), les filtres (`DashboardBankFilter`, `CurrencyViewMode`, `ExpenseComparisonMode`), le chargement paresseux `React.lazy` + `Suspense` (`DashboardCharts`, `TransactionsSection`, `BottomSheetNoteDialog`), la région `aria-live="polite"`, les transitions `runWithViewTransition` et le câblage `onFlushOutbox={() => void store.flushNow()}` vers `OfflineStatusBanner` et `SyncDrivePanel`.
- **`capacitor.config.ts`** : configuration Capacitor Android (`appId: 'com.clairflux.finance'`, `appName: 'ClairFlux'`, `webDir: 'dist'`, `server.androidScheme: 'https'`, `android.allowMixedContent: false`, `captureInput: true`).
- **`vite.config.ts`** : découpage `manualChunks` en `vendor-react`, `vendor-d3` et `vendor-recharts`, et garde de sécurité `guardNoServerSecretsPlugin` bloquant toute variable serveur sensible préfixée `VITE_`.

### 2. Module Dashboard, Graphiques Recharts & Distribution APK ([`src/features/dashboard/`](./src/features/dashboard/), [`src/features/apk/`](./src/features/apk/))
- **[`types.ts`](./src/features/dashboard/types.ts)** : contrats UI partagés (`AppTab`, `TransactionsSubTab`, `ExpenseComparisonMode`, `DashboardBankFilter`, `CurrencyViewMode`, `BudgetLimit`, `ClairFluxDataset`, `KpiMetricsSummary`), `INITIAL_SEED_DATASET`, helpers `yieldToMain()`, `usePrefersReducedMotion()`, `runWithViewTransition()`, `computeKpiMetrics()`, `buildCumulativeBalanceSeries()`, `buildMonthlyExpenseSeries()`, `resolveSelectedTransactionContext()`.
- **[`DashboardChrome.tsx`](./src/features/dashboard/DashboardChrome.tsx)** :
  - `DesktopSidebar` (rail latéral Desktop `>= 1024px`) & `BottomTabBar` (barre de navigation basse mobile `< 1024px` avec badge du compteur Outbox).
  - `OfflineStatusBanner` (bandeau d'état en ligne / hors-ligne affichant `pendingOutboxCount` et le bouton de synchronisation immédiate **`Synchroniser l'outbox maintenant`** `>= 44×44px` dès que `isOnline && pendingOutboxCount > 0`).
  - `KpiSummaryCard` (4 KPIs en `JetBrains Mono tabular-nums` : solde consolidé, revenus, dépenses hors transferts, transferts internes).
  - `BudgetAlertsPanel` : jauges de suivi budgétaire par catégorie avec alertes visuelles et textuelles aux seuils **80 %** (vigilance) et **100 %** (dépassement).
  - `SyncDrivePanel` : affichage des 2 dossiers Drive exclusifs (`ALLOWED_DRIVE_FOLDERS`), statut des PDF, synchronisation manuelle de l'Outbox (`onFlushOutbox`), bouton *« Synchroniser Drive / Gemini »* (automatiquement désactivé hors-ligne avec libellé *« Connexion requise (hors-ligne) »*) et intégration de `ApkDownloadCard` dans une surface `.cf-surface` distincte (zéro carte imbriquée).
- **[`ApkDownloadCard.tsx`](./src/features/apk/ApkDownloadCard.tsx)** (`React.memo`) :
  - Interroge `GET /api/apk/status` (avec validation Zod stricte de `{ available, version, sizeBytes, sha256, builtAt }` et gestion des états par union discriminée : `loading` / `available` / `unavailable` / `offline` / `error`).
  - Affiche version, taille formatée en Mo (`formatApkSizeMb`), empreinte SHA-256 en `JetBrains Mono tabular-nums`, date de compilation FR, bouton de téléchargement direct `clairflux-release.apk` (`>= 44×44px`, `GET /api/apk/download`, désactivé hors-ligne ou si indisponible) et notice concise d'installation Android.
- **[`DashboardCharts.tsx`](./src/features/dashboard/DashboardCharts.tsx)** :
  - Contrôles de périmètre banque (`Tous les comptes`, `BoursoBank`, `Revolut`), mode devise (`EUR consolidé` / `USD seul`) et mode de comparaison des dépenses (`Sans comparaison`, `Mois précédent (M-1)`, `Moyenne 3 mois`).
  - Graphique 1 : **Solde bancaire cumulé 6M** (`AreaChart` Recharts).
  - Graphique 2 : **Dépenses mensuelles** (`AreaChart` Recharts sur 6 mois supportant les 3 modes `'none' | 'prev_month' | 'avg_3m'`, hors transferts internes).

### 3. Module Grand Livre, Règles, Tiroir `<dialog>` & Export CSV ([`src/features/ledger/`](./src/features/ledger/))
- **[`TransactionsSection.tsx`](./src/features/ledger/TransactionsSection.tsx)** :
  - Bascule entre les sous-onglets **Opérations** (`operations`) et **Règles de catégorisation** (`rules`).
  - Recherche instantanée différée (`useDeferredValue`), filtre rapide **« Avec notes »** (`onlyWithNotes`), bouton d'export CSV, tableau complet sur Desktop (colonnes *Date*, *Banque*, *Type de compte*, *Libellé*, *Catégorie*, *Note personnalisée*, *Montant*) et cartes compactes à 2 rangs sur mobile via `@container`.
- **[`BottomSheetNoteDialog.tsx`](./src/features/ledger/BottomSheetNoteDialog.tsx)** :
  - Tiroir modal natif `<dialog>` (`.showModal()`) permettant l'ajout/édition de **notes rapides y compris hors-ligne** (enregistrées dans l'Outbox locale avec confirmation immédiate), la modification de catégorie manuelle / statut `Transfert interne`, et le raccourci *« Créer une règle depuis ce libellé »*.
- **[`RulesTab.tsx`](./src/features/ledger/RulesTab.tsx)** :
  - Création/édition de règles de catégorisation (filtres banque et compte, validation `:user-valid`/`:user-invalid` + `aria-invalid` au `onBlur`), réordonnancement de priorité (`up`/`down`), activation/désactivation et bouton *« Réappliquer à l'historique »* respectant `is_manual_category = true`.
- **[`csvExport.ts`](./src/features/ledger/csvExport.ts)** :
  - `neutralizeCsvFormula` & `exportTransactionsToCsv` : génération CSV RFC 4180 avec préfixe UTF-8 BOM et neutralisation anti-injection de formules tableur (`=`, `+`, `-`, `@`, `\t`, `\r`) sur les cellules textuelles tout en conservant les montants numériques signés exacts.

### 4. Moteur Offline-First, Outbox & Pont Android Capacitor ([`src/offline/`](./src/offline/))
- **[`indexedDbStore.ts`](./src/offline/indexedDbStore.ts)** :
  - Persistance locale `IndexedDB` (`clairflux_offline_v1`) avec les stores `snapshots` et `outbox_mutations` (`client_mutation_id` UUID, `kind: 'upsert_note' | 'update_category'`, statut `'pending' | 'syncing' | 'failed'`), validation Zod stricte (`ClairFluxDatasetSchema`, `OutboxMutationSchema`) à la lecture, et fallback mémoire automatique (`createMemoryOfflineStore`).
- **[`deltaSyncEngine.ts`](./src/offline/deltaSyncEngine.ts)** :
  - `pullDelta` (`GET /api/sync/delta?since=...`), `applyDeltaToDataset`, `flushOutbox` (`POST /api/sync/delta` idempotent par `client_mutation_id`, suppression uniquement après acquittement `applied | duplicate`), garde `canTriggerDriveSync` bloquant la synchro Drive/Gemini hors-ligne, `reapplyRulesOnTransactions`, et pont Android `setupAndroidBridge` (écoute réseau `online`/`offline` + plugin Capacitor `Network`, bouton matériel `backButton` fermant `<dialog open>` en priorité, retour haptique léger `Haptics.impact`).
- **[`useOfflineStore.ts`](./src/offline/useOfflineStore.ts)** :
  - Hook React `useOfflineStore(initialSeed)` et contrôleur `createOfflineController` fournissant l'optimistic UI hors-ligne, le flush immédiat `flushNow()` et la synchronisation automatique au retour de la connexion.

### 5. Suite de recette E2E & Audit ([`src/e2e-audit.test.ts`](./src/e2e-audit.test.ts))
- **`src/e2e-audit.test.ts`** : vérifie les invariants Desktop (`1440×900`) et Mobile (`390×844`) dans [`index.html`](./index.html) (`1024px`, sticky `<= 15 %`, `44px`, `<dialog>`, `content-visibility: auto`), le pipeline fonctionnel (6M, Dépenses 3 modes, Budgets 80%/100%, Règles respectant `is_manual_category`) et le scénario E2E complet Mobile Offline Outbox branché sur `createApp(...)` (`POST /api/sync/delta` idempotent : `applied` puis `duplicate`).

---

## Invariants

1. **Offline-First avec Outbox locale & garde Drive hors-ligne** :
   - Hors connexion, 100 % des vues (KPIs, graphiques Recharts 6M & Dépenses, grand livre, notes, règles, budgets) restent consultables depuis le snapshot local.
   - Les notes rapides et recatégorisations manuelles effectuées hors-ligne sont persistées dans `outbox_mutations` avec `client_mutation_id` UUID et synchronisées de manière idempotente dès le retour réseau (automatiquement ou via le bouton de synchronisation immédiate).
   - La synchronisation Google Drive / Gemini (`triggerDriveSync`) est strictement interdite et désactivée hors-ligne.
2. **Protection des choix manuels** :
   - `reapplyRulesOnTransactions` exclut toute transaction ayant `is_manual_category = true`, `transfer_group_id !== null` ou `is_manual_transfer_override = true`.
3. **Zéro secret & polices 100 % locales** :
   - Aucune clé serveur (`DATABASE_URL`, `GEMINI_API_KEY`, `CLAIRFLUX_ACCESS_SECRET_HASH`, `CLAIRFLUX_SESSION_SECRET`, `GOOGLE_DRIVE`, `SERVICE_ACCOUNT`, `INTERNAL_WORKER_TOKEN`, `PRIVATE_KEY`) ne peut entrer dans le bundle `VITE_*`.
   - Polices **Plus Jakarta Sans** (600, 700), **DM Sans** (400, 500, 600) et **JetBrains Mono** (400, 500, 600 avec `font-variant-numeric: tabular-nums`) bundlées en `.woff2` via `@fontsource/*` (zéro CDN externe).
4. **Ergonomie Baseline, Géométrie & WCAG 2.1 AA** :
   - Élévation unique (`.cf-surface`, zéro cartes imbriquées), zéro pills statiques sur les métadonnées passives, cibles tactiles `>= 44×44 px`, plafond sticky mobile `<= 15 %` (`BottomTabBar` `64px + env(safe-area-inset-bottom)` sous `< 1024px`, en-tête scrollable), zéro débordement horizontal à `390px` et `320px`.
   - `<dialog>` natif avec `overscroll-behavior: contain` sur `dialog:modal` et `dialog::backdrop`, `@container` queries, `:has()` borné à `.cf-field-group`, `:user-valid`/`:user-invalid`, `content-visibility: auto` + `contain-intrinsic-size: auto 72px` sous le fold, View Transitions et animations Recharts désactivées sous `prefers-reduced-motion: reduce`.

---

## Side Effects

- **Stockage local `IndexedDB` (`clairflux_offline_v1`)** : lecture/écriture validée par Zod des snapshots et de la file `outbox_mutations`.
- **Requêtes HTTP delta sync, Drive & APK** : appels `GET /api/sync/delta`, `POST /api/sync/delta` (flush Outbox), `POST /api/sync/drive`, `GET /api/apk/status` et téléchargement `GET /api/apk/download` via `fetch` / lien authentifié.
- **DOM, Blob CSV & Pont Capacitor Android** : manipulation modale `<dialog>.showModal()` / `.close()`, génération de fichier CSV local (`URL.createObjectURL`), écoute `navigator.onLine` / événements `online`/`offline` et listeners optionnels Capacitor (`Network`, `App.addListener('backButton')`, `Haptics`).

---

## Verification

```bash
# Vérification TypeScript stricte (@clairflux/web + capacitor.config.ts)
npm run typecheck --workspace=@clairflux/web

# Tests Frontend, Offline, APK & Recette E2E (ledger.test.ts + offline.test.ts + apk.test.ts + e2e-audit.test.ts)
npm test --workspace=@clairflux/web

# Build Vite de production (vérification des chunks vendor-react / vendor-d3 / vendor-recharts et garde secrets)
npm run build --workspace=@clairflux/web

# Audit complet du dépôt depuis la racine (inclut e2e-audit.test.ts)
npm run audit
```
