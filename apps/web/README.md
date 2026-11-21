# `@clairflux/web`

Interface utilisateur React 19 + Vite + CSS natif Baseline + Recharts pour ClairFlux, ciblant le Web Desktop (`1440×900`) et l'application mobile Android APK Capacitor (`390×844` / `320px`, Offline-First lecture seule).

---

## Interface

Fichiers du socle Jalon 1 : [`index.html`](./index.html), [`vite.config.ts`](./vite.config.ts), [`src/main.tsx`](./src/main.tsx).

- **Architecture à 4 onglets via union discriminée `AppTab` (`'overview' | 'transactions' | 'rules' | 'sync'`)** :
  - **Synthèse (`overview`)** : 4 KPIs financiers, sélecteur de périmètre `CurrencyScope` (`EUR consolidé` par défaut ou `Vue USD seul`, ou par banque/compte) et 2 graphiques Recharts chargés paresseusement via `React.lazy` + `Suspense` (`Solde cumulé 6M` et `Dépenses M-1 / Moyenne 3M` excluant les transferts internes).
  - **Transactions (`transactions`)** : grand livre multi-comptes BoursoBank & Revolut exposant sur Desktop les colonnes *Date*, *Banque*, *Type de compte* (avec nom renommable & devise), *Libellé*, *Catégorie*, *Note personnalisée* et *Montant* (`tabular-nums`), et sur mobile des lignes compactes à 2 rangs via `@container`. Ouvre un tiroir natif `<dialog>` (`TransactionDrawerDialog`) pour annoter et recatégoriser.
  - **Règles (`rules`)** : création de règles de catégorisation (`RulesView`) avec validation `:user-valid`/`:user-invalid` + `aria-invalid` synchronisé au `onBlur` et aperçu rétroactif local préservant `is_manual_category = true`.
  - **Synchro Drive (`sync`)** : affichage du périmètre exclusif (`ALLOWED_DRIVE_FOLDERS`), déclenchement manuel (`Synchroniser maintenant`) et liste des statuts par fichier PDF (`SyncDriveView`).
- **État réseau & simulation Offline-First Jalon 1** :
  - Union discriminée `NetworkState` (`online` | `offline_readonly`) permettant de valider visuellement le passage en mode lecture seule hors-ligne depuis l'interface Mock-First.
  - Helper `yieldToMain()` (`scheduler.yield()` avec fallback `setTimeout`) et `useDeferredValue` pour préserver la réactivité (`INP <= 200 ms`).

### Prévu aux jalons suivants
- Branchement HTTP sur `@clairflux/api` (remplacement du jeu de données Mock-First par les appels API réels, polling borné sur `GET /api/sync/drive/status` uniquement pendant un run `running`, bouton *« Réessayer ce fichier »*, appel `POST /api/rules/preview` et bascule `is_internal_transfer`).
- Couche de réplication locale (`src/offline/`) via `GET /api/sync/delta?since=<revision>` (IndexedDB / `@capacitor-community/sqlite` avec `PRAGMA defer_foreign_keys = ON` au bootstrap `since=0`) et stockage du Bearer token dans Android Keystore.
- Web Worker dédié (`src/workers/`) pour le filtrage/tri au-delà de 500 opérations.
- Primitives et intégrations natives complémentaires : Popover API (`[popover]`), `capacitor.config.ts` et interception `App.addListener('backButton')` sous Capacitor pour fermer le `<dialog>` ouvert.

---

## Invariants

1. **Consultation complète hors-ligne / Écritures en ligne uniquement** :
   - En état `offline_readonly`, 100 % des vues de consultation (KPIs, graphiques, grand livre, notes, règles, statuts Drive) restent accessibles.
   - Zéro outbox locale : tous les contrôles de mutation passent désactivés avec libellé explicite *« Connexion requise pour modifier »*.
2. **Zéro secret & zéro CDN externe** :
   - Le plugin Vite `guardNoServerSecretsPlugin` bloque au build toute variable `VITE_*` contenant un motif sensible (`DATABASE_URL`, `GEMINI_API_KEY`, `CLAIRFLUX_ACCESS_SECRET_HASH`, `CLAIRFLUX_SESSION_SECRET`, `GOOGLE_DRIVE`, `SERVICE_ACCOUNT`, `INTERNAL_WORKER_TOKEN`, `PRIVATE_KEY`).
   - Polices **Plus Jakarta Sans** (600, 700), **DM Sans** (400, 500, 600) et **JetBrains Mono** (400, 500, 600 avec `.tabular-amount` `font-variant-numeric: tabular-nums`) bundlées localement via `@fontsource/*` (zéro requête vers `fonts.googleapis.com`).
3. **Primitives Web Baseline & Android System WebView** :
   - `<dialog>` + `.showModal()` avec `overscroll-behavior: contain` sur `dialog:modal` et `dialog::backdrop`.
   - CSS Container Queries (`@container`), `:has()` borné à `.cf-field-group` (jamais `body:has`/`:root:has`), `:user-valid`/`:user-invalid`, `content-visibility: auto` couplé à `contain-intrinsic-size: auto 72px` sous le fold, View Transitions désactivées sous `@media (prefers-reduced-motion: reduce)`.
   - Unités `100dvh` / `100dvw` et `env(safe-area-inset-*)` (zéro `100vh`/`100vw`).
4. **Ergonomie, géométrie & accessibilité WCAG 2.1 AA** :
   - Élévation unique (`.cf-surface`, zéro cartes imbriquées), zéro pills statiques sur les métadonnées passives.
   - Cibles tactiles `>= 44×44 px`, plafond sticky mobile `<= 15 %` (barre basse `64px + env(safe-area-inset-bottom)` sur `844 px`, en-tête scrollable), `overflow-x: clip`, zéro débordement horizontal à `390px` et `320px`.
   - Contraste `>= 4.5:1` (texte) / `>= 3:1` (graphiques Recharts), aucune information par couleur seule, zéro `dangerouslySetInnerHTML`.
5. **Code-Splitting & Performance** :
   - `React.memo` sur composants de présentation, `React.lazy` + `Suspense` pour `recharts`, `manualChunks` Vite séparant `vendor-react`, `vendor-d3` et `vendor-recharts`.

---

## Side Effects

- **Rendu DOM & chargement paresseux** : manipulation du DOM via React 19, ouverture/fermeture modale via `HTMLDialogElement.showModal()` / `.close()`, et chargement asynchrone des chunks JS Recharts.
- **Écoute système navigateur** : abonnement `window.matchMedia('(prefers-reduced-motion: reduce)')` pour désactiver les View Transitions et animations Recharts.
- *(Aucune requête réseau ni écriture SQLite/Keystore n'est encore émise dans le socle Mock-First de Jalon 1.)*

---

## Verification

```bash
# Vérification TypeScript stricte dans @clairflux/web
npm run typecheck --workspace=@clairflux/web

# Build Vite production (séparation des chunks vendor-react / vendor-d3 / vendor-recharts et garde secrets VITE_*)
npm run build
```
