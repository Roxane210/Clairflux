# Standards Techniques & Normes d'Ingénierie — ClairFlux

- **Statut** : Normatif — Source de vérité (Exploitation & Évolutions `v1.0.0-rc1+`)
- **Date** : 2026-11-24
- **Gouvernance** : `swarm-egm-engineering` (Documentation normative continue avant toute évolution)
- **Références liées** :
  - Énoncé d'intention : [clairflux-mvp.md](file:///d:/Applications/Clairflux/docs/intent/clairflux-mvp.md)
  - Flux critiques : [critical-flows.md](file:///d:/Applications/Clairflux/docs/ideas/critical-flows.md)
  - Prototype Mock-First : [PROTOTYPE_SPEC.md](file:///d:/Applications/Clairflux/docs/prototypes/PROTOTYPE_SPEC.md)
  - Modèle de données : [DATA_MODEL_DRIZZLE_SPEC.md](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md)
  - Contrat API & Delta Sync : [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)
  - ADRs : [0001](file:///d:/Applications/Clairflux/docs/ADR/0001-drive-exclusive-sync-and-deduplication.md), [0002](file:///d:/Applications/Clairflux/docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md), [0003](file:///d:/Applications/Clairflux/docs/ADR/0003-capacitor-offline-first-delta-sync.md), [0004](file:///d:/Applications/Clairflux/docs/ADR/0004-ui-baseline-and-recharts-architecture.md)

> **Règle d'Or EGM (Porte bloquante)** : Toute nouvelle fonctionnalité structurelle ou modification de contrat exige d'abord le cadrage (`interview-me` / `prototype` si UI) et la mise à jour des livrables normatifs concernés (`TECHNICAL_STANDARDS.md`, `ADR/0001..0004`, `DATA_MODEL_DRIZZLE_SPEC.md`, `API_DELTA_SYNC_CONTRACT.md`) avant modification du code applicatif.

---

## 1. Stack Technique Verrouillée

Toute déviation de cette stack exige un nouvel ADR validé avant introduction d'une dépendance.

| Couche | Technologie verrouillée | Version / Cible | Rôle & Contrainte |
| :--- | :--- | :--- | :--- |
| **Runtime serveur** | Node.js | **22 LTS** (`node:22-alpine`) | Exécution `api` et `sync-worker`, ESM natif, `fetch` / `crypto` standard |
| **Langage** | TypeScript | **5.7+** (mode strict absolu) | Partagé sur `apps/web`, `apps/api`, `apps/sync-worker`, `packages/shared` |
| **Frontend Web / Shell APK** | React + Vite | **React 19** + **Vite 6** | SPA statique servie en Docker (`web`) et embarquée dans Capacitor (`dist/`) |
| **Styling UI** | Tailwind CSS v4 + CSS moderne | **Tailwind CSS 4** + CSS Baseline | Tokens CSS (`@theme`), `@container`, `:has()`, `:user-valid/:user-invalid` |
| **Visualisation** | Recharts | **Recharts 2.15+ / 3.x** | Graphiques `Solde cumulé 6M` et `Dépenses M-1 / Moyenne 3M` uniquement |
| **Validation / Contrats** | Zod | **Zod 3.24+** | Validation stricte aux frontières (API, Gemini JSON, env, cache offline) |
| **Base de données** | PostgreSQL Serverless **Neon** | PostgreSQL 16+ (Neon) | `sslmode=require` obligatoire, calculs comptables en centimes entiers (`bigint`) |
| **ORM & Migrations** | Drizzle ORM + `@neondatabase/serverless` | **Drizzle ORM** + `drizzle-kit` | Requêtes paramétrées, transactions atomiques, migrations versionnées |
| **Ingestion IA & Drive** | Google Drive API v3 + Google Gemini API | SDK officiel Gemini | Lecture seule exclusive sur les 2 dossiers Drive autorisés |
| **Auth & Hachage** | `@noble/hashes` (Argon2id pur JS) + `node:crypto` | Node 22 Alpine | Vérification `CLAIRFLUX_ACCESS_SECRET_HASH` sans addon natif C++ (`--ignore-scripts`) |
| **Tests** | Vitest (+ Testing Library) | **Vitest 3+** | Tests unitaires (100 % logique critique), intégration API/SQL, tests UI |
| **Qualité statique** | ESLint (flat config) + Prettier | TypeScript-ESLint strict | Zéro warning toléré sur règles de typage et accessibilité (`jsx-a11y`) |
| **Conteneurisation** | Docker + Docker Compose | Compose v2 | 3 services isolés : `web`, `api`, `sync-worker` (+ profil `dev` optionnel) |
| **Mobile Android** | Capacitor + Gradle | **Capacitor 7** + Android Gradle | APK Offline-First (consultation complète hors-ligne, écritures en ligne uniquement) |

---

## 2. Structure Cible du Futur Dépôt

Le dépôt utilise une architecture verrouillée en workspaces NPM (`workspaces: ["apps/*", "packages/*"]`) articulée autour de `apps/web`, `apps/api`, `apps/sync-worker`, `packages/shared` et `android/` (alignée avec le nom de service Docker `sync-worker`), permettant de partager les schémas Zod et types métier sans dupliquer de logique ni fuiter de secrets serveur dans le client.

```text
clairflux/
├── docs/                                # Documentation normative, ADR, prototypes (seul dossier actif en Pré-Code)
│   ├── intent/
│   ├── ideas/
│   ├── prototypes/
│   ├── architecture/                    # Design drafts EGM par chantier
│   ├── ADR/
│   ├── TECHNICAL_STANDARDS.md
│   ├── DATA_MODEL_DRIZZLE_SPEC.md
│   └── API_DELTA_SYNC_CONTRACT.md
├── packages/
│   └── shared/                          # Code pur partagé (ZÉRO secret, ZÉRO dépendance Node/DOM exclusive)
│       ├── src/
│       │   ├── schemas/                 # Schémas Zod (API, comptes, transactions, règles, delta sync)
│       │   ├── money/                   # Arithmétique centimes entiers, conversion FX (fx_rate_micro), formatage fr-FR
│       │   ├── rules/                   # Moteur pur d'évaluation de règles de catégorisation
│       │   └── constants/               # IDs Drive autorisés, enums banques/devises/statuts
│       └── tests/
├── apps/
│   ├── web/                             # Frontend React + Vite + Tailwind + Recharts + Shell Capacitor
│   │   ├── public/fonts/                # Polices .woff2 bundlées localement (ou @fontsource)
│   │   ├── src/
│   │   │   ├── app/                     # Shell, routeur/onglets, gestionnaire réseau & bouton Retour Android
│   │   │   ├── features/
│   │   │   │   ├── apk/                 # Carte de statut & téléchargement APK (`GET /api/apk/status`, `/download`)
│   │   │   │   ├── dashboard/           # Synthèse, KPIs, graphiques Recharts 6M & M-1/3M
│   │   │   │   └── ledger/              # Grand livre, filtres, tiroir `<dialog>` note/catégorie, onglet Règles
│   │   │   ├── offline/                 # Cache local (IndexedDB `clairflux_offline_v1`), outbox, delta sync & `apiUrl.ts`
│   │   │   ├── ui/                      # Primitives accessibles (`<Dialog>`, `<Popover>`, `<Surface>`, `<Amount>`)
│   │   │   └── workers/                 # Web Worker filtrage/tri/agrégats (> 500 opérations)
│   │   ├── Dockerfile                   # Build Vite + Nginx unprivileged (port 8080, reverse-proxy `/api/` -> `api:3000`)
│   │   └── capacitor.config.ts          # Pointe webDir: "dist" vers le projet natif racine android/
│   ├── api/                             # Serveur HTTP Node 22 (Auth, lecture, écritures en ligne, delta pull)
│   │   └── src/
│   │       ├── config/                  # Validation Zod des env vars (DATABASE_URL, CLAIRFLUX_ACCESS_SECRET_HASH, CLAIRFLUX_SESSION_SECRET)
│   │       ├── db/                      # Client Neon/Drizzle + schéma + migrations SQL
│   │       ├── auth/                    # Auth personnelle unique (secret + session/bearer token)
│   │       ├── modules/                 # Deep modules métier (ledger, accounts, rules, sync-delta, drive-trigger)
│   │       └── routes/                  # Couche HTTP fine validée par Zod
│   └── sync-worker/                     # Worker d'ingestion Drive → PDF → Gemini → Neon (service Docker sync-worker, manuel)
│       └── src/
│           ├── drive/                   # Client Drive API verrouillé sur les 2 folder IDs exclusifs
│           ├── gemini/                  # Extraction structurée PDF multi-comptes/devises + validation Zod
│           ├── pipeline/                # Checkpoints SQL, déduplication, appariement transferts/FX EUR↔USD
│           └── fx/                      # Résolution & mise en cache taux historiques EUR/USD (`fx_rates`)
├── android/                             # Projet Android Capacitor + Gradle (synchronisé depuis apps/web/dist)
├── Dockerfile.apk-builder               # Build Gradle Android reproductible vers volume partagé `apk-artifacts`
├── docker-compose.yml                   # Orchestration web + api + sync-worker + apk-builder
└── package.json                         # Scripts racine CI (typecheck, test, lint, build, audit)
```

> **Note d'alignement** : La structure ci-dessus reflète le dépôt actif (`v1.0.0-rc1+`, commit `2a17d60`) ; les Dockerfiles de service résident dans `apps/web/Dockerfile`, `apps/api/Dockerfile`, `apps/sync-worker/Dockerfile` et `Dockerfile.apk-builder`.

---

## 3. Conventions TypeScript & Architecture (Standard Matt Pocock)

### 3.1 Configuration `tsconfig` minimale obligatoire

Chaque `tsconfig.json` du dépôt doit hériter d'une base racine imposant :

- `"strict": true`
- `"noUncheckedIndexedAccess": true` (tout accès tableau/dictionnaire renvoie `T | undefined`)
- `"exactOptionalPropertyTypes": true` (distinction nette entre propriété absente et `undefined`)
- `"noImplicitOverride": true`
- `"noFallthroughCasesInSwitch": true`
- `"verbatimModuleSyntax": true`
- `"isolatedModules": true`
- `"noEmit": true` pour la vérification CI (hors compilation build dédiée)

### 3.2 Discipline de Typage

1. **Zéro `any`, zéro assertion `as` non justifiée** :
   - Utiliser `unknown` sur toute donnée non fiable, suivi d'un parsing **Zod** ou d'un type guard explicite.
   - Les seules assertions autorisées sont les narrowing triviaux documentés ou `as const` / `satisfies`.
2. **Unions discriminées pour tous les états et variantes métier** :
   - Interdiction de modéliser un état asynchrone ou métier via des booléens combinés (`isLoading`, `isError`, `isPartial`).
   - Exemple normatif :
     ```ts
     type DriveFileStatus =
       | { readonly kind: 'pending' }
       | { readonly kind: 'extracting'; readonly attempt: number }
       | { readonly kind: 'committed'; readonly committedAt: string; readonly txCount: number }
       | { readonly kind: 'failed'; readonly attempt: number; readonly errorCode: string; readonly errorMessage: string };
     ```
   - Exhaustivité obligatoire dans les `switch` via helper `assertNever(value: never): never`.
3. **Validation Zod aux frontières** :
   - Frontière 1 : Variables d'environnement au démarrage (`apps/api`, `apps/sync-worker`). Fail-fast immédiat si variable manquante.
   - Frontière 2 : Corps de requêtes, paramètres de route et query strings HTTP (`apps/api`).
   - Frontière 3 : Réponses JSON brutes de Gemini lors de l'extraction de relevés PDF (`apps/sync-worker`).
   - Frontière 4 : Données lues depuis le stockage local Android (IndexedDB/SQLite) au démarrage offline (`apps/web`).
4. **Dérivation de types (Single Source of Truth)** :
   - Dériver les types de base depuis Drizzle (`typeof transactions.$inferSelect`) et les types d'échange depuis Zod (`z.infer<typeof DeltaSyncResponseSchema>`).
5. **Arithmétique monétaire & conventions de champs canoniques** :
   - Tout montant en mémoire, en base et sur l'API est un **entier en centimes** (`amount_cents`, `amount_eur_cents`, `number` sûr ou `bigint` sérialisé), jamais un flottant en euros/dollars.
   - Les taux de change utilisent exclusivement **`fx_rate_micro`** (entier en micro-unités côté DB et API, ex. `924500` pour `0.924500`) ; la conversion décimale (`fx_rate_micro / 1_000_000`) est réservée uniquement au formatage UI.
   - Les contrats partagés (`packages/shared`, `apps/api`, `apps/sync-worker`, `apps/web`) utilisent strictement les identifiants canoniques **`matched_rule_id`** (lien vers la règle appliquée) et **`transfer_group_id`** (lien d'appariement des transferts internes et changes `EUR ↔ USD`).

### 3.3 Deep Modules & Lisibilité

- **Deep Modules** : Encapsuler la complexité technique (checksum + checkpoint PDF, appariement transferts internes EUR↔USD, recalcul rétroactif respectant `is_manual_category`, merge du delta pull) derrière des interfaces courtes, testables unitairement sans base de données lorsque la logique est pure.
- **Composants React `< 200` lignes** : Séparer strictement les conteneurs de données / hooks d'état des composants de présentation purs.
- **Fonctions pures en priorité** : Le moteur de règles, le calcul de `dedup_hash`, la détection de paires `Transfert interne` et les transformations d'agrégats pour Recharts doivent être des fonctions pures dans `packages/shared` ou des modules domaine isolés.
- **Gestion d'erreurs explicite** : Retourner des résultats typés (`{ ok: true; data: T } | { ok: false; error: DomainError }`) aux frontières métier, puis traduire proprement vers les codes HTTP normalisés dans la couche route.

---

## 4. Standards Web, Performance & Android System WebView (Addy Osmani + Modern Web Guidance)

Référence normative complète : [SKILL.md](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/SKILL.md) et [BASELINE_CLAIRFLUX.md](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/BASELINE_CLAIRFLUX.md).

### 4.1 Compatibilité Cible

- **Desktop** : Chrome, Safari, Firefox (versions courantes supportant Baseline Widely/Newly Available).
- **Mobile Android (APK Capacitor)** : Android System WebView (Chromium Evergreen sur Android 10+, cible recommandée WebView `>= 114` avec détection de capacité et dégradation gracieuse si antérieure).

### 4.2 Primitives Plate-forme Obligatoires (`Platform-First`)

| Primitive | Règle d'usage ClairFlux | Garde / Fallback obligatoire |
| :--- | :--- | :--- |
| **`<dialog>` + `.showModal()`** | Obligatoire pour le panneau latéral Desktop (`420px`) et le tiroir bas mobile (`bottom sheet`) d'annotation/catégorie, ainsi que les modales de confirmation. | **Jamais** de focus-trap JS maison ni `role="dialog"` redondant. Bloquer le scroll arrière-plan par `dialog:modal { overscroll-behavior: contain; }` et `dialog::backdrop { overflow: hidden; overscroll-behavior: contain; }` (jamais `overflow: hidden` sur `html`/`body`). Intercepter `App.addListener('backButton')` sous Capacitor pour fermer le `<dialog>` ouvert en priorité. |
| **Popover API (`[popover]`)** | Obligatoire pour menus contextuels, infobulles de taux de change FX et popovers de filtres légers (top layer natif, zéro `z-index` artisanal). | Tester `Object.hasOwn(HTMLElement.prototype, 'popover')` ; chargement conditionnel de `@oddbird/popover-polyfill` uniquement si absent. |
| **CSS Container Queries (`@container`)** | Obligatoire pour adapter cartes KPI, lignes du grand livre et graphiques selon leur conteneur réel (`container-type: inline-size` ou `container: <nom> / inline-size`). | Ne jamais utiliser `block-size` comme `container-type`. |
| **Sélecteur `:has()`** | Autorisé pour refléter l'état d'un champ sur son groupe parent (ex. `.field-group:has(:user-invalid)`). | Toujours **borné** à un conteneur local précis ; strictement interdit au niveau `body:has(...)` ou `:root:has(...)` (protection INP). |
| **`:user-valid` / `:user-invalid`** | Obligatoire sur les formulaires (création de règle de catégorisation, renommage de compte, note, connexion) pour n'afficher les erreurs qu'après interaction/blur ou soumission. | Doubler avec classe fallback `.user-invalid-fallback` si besoin et synchroniser `aria-invalid` + `aria-describedby` pointant vers un message d'erreur explicite. |
| **View Transitions API** | Autorisée pour les transitions douces entre onglets et filtres (`document.startViewTransition`). | Tester `if (!document.startViewTransition)`, désactiver totalement sous `@media (prefers-reduced-motion: reduce)`, nettoyer `view-transition-name` après `transition.finished` et gérer le focus après transition. |
| **`content-visibility: auto`** | Obligatoire sur les longues listes de transactions et l'historique des fichiers Drive situés **sous la ligne de flottaison**. | Toujours coupler avec `contain-intrinsic-size: auto 72px` (ou hauteur réelle estimée) pour éviter tout saut de scrollbar/CLS. Interdit au-dessus du fold. |
| **Unités viewport & Safe Areas** | Utiliser `100dvh` / `100dvw` et `env(safe-area-inset-top)` / `env(safe-area-inset-bottom)`. | Interdiction de `100vh` et `100vw` sur mobile Android WebView. |

### 4.3 Budgets Core Web Vitals & Chargement

| Métrique | Budget ClairFlux | Règles d'exécution obligatoires |
| :--- | :--- | :--- |
| **INP** (Interaction to Next Paint) | **`<= 200 ms`** (impératif) | Toute tâche JS `> 50 ms` (filtrage/tri sur `> 500` transactions, calcul d'agrégats locaux, prévisualisation de règles) doit soit s'exécuter dans un **Web Worker**, soit céder le thread principal via `yieldToMain()` (`scheduler.yield()` avec fallback `setTimeout(resolve, 0)`). Aucun layout thrashing (grouper lectures géométriques puis écritures DOM). |
| **LCP** (Largest Contentful Paint) | **`<= 2.5 s`** Web / **`< 1.2 s`** Offline Android | Zéro appel réseau bloquant au rendu initial (shell + cache local immédiat). Polices critiques préchargées localement (`<link rel="preload" as="font" type="font/woff2" crossorigin>`). Zéro `@import` CSS bloquant. Code-splitting via `React.lazy` pour Recharts et les onglets secondaires (`Règles`, `Synchro Drive`). |
| **CLS** (Cumulative Layout Shift) | **`<= 0.1`** (`<= 0.02` visé) | Dimensions réservées explicites (`min-block-size` / `aspect-ratio`) sur les conteneurs Recharts et squelettes de chargement. `scrollbar-gutter: stable` sur zones scrollables. `tabular-nums` sur tous les nombres dynamiques. |

### 4.4 Polices Bundlées Localement (100 % Offline-First)

- **Interdiction absolue** de charger `fonts.googleapis.com` ou tout CDN externe à l'exécution (garantit le fonctionnement Offline-First dans l'APK Android et évite toute fuite réseau vers un tiers).
- Les fichiers `.woff2` de **Plus Jakarta Sans** (600, 700), **DM Sans** (400, 500, 600) et **JetBrains Mono** (400, 500, 600) sont bundlés localement dans les assets Vite (`dist/assets/`).

---

## 5. Règles UI, Ergonomie & Recharts

Références normatives : [frontend-ui-engineering/SKILL.md](file:///d:/Applications/Clairflux/.agent/skills/frontend-ui-engineering/SKILL.md), [mobbin/SKILL.md](file:///d:/Applications/Clairflux/.agent/skills/mobbin/SKILL.md) et [PROTOTYPE_SPEC.md](file:///d:/Applications/Clairflux/docs/prototypes/PROTOTYPE_SPEC.md).

### 5.1 Identité Typographique & Alignement Numérique

- **Titres & KPIs de tête (`h1`–`h3`, grands soldes)** : `Plus Jakarta Sans` (600/700, `text-wrap: balance`).
- **Corps de texte, libellés, formulaires, navigation** : `DM Sans` (400/500/600, taille minimale `14px` / `0.875rem`).
- **Montants, soldes, dates chiffrées, taux FX et pourcentages** : `JetBrains Mono` avec **`font-variant-numeric: tabular-nums`** obligatoire sur 100 % des valeurs numériques financières.

### 5.2 Contrats de Surface, Géométrie & Ergonomie Mobile/Desktop

1. **Élévation unique (Zéro cartes imbriquées)** :
   - Deux niveaux visuels maximum : fond de page (`bg-canvas`) et surfaces de contenu (`bg-surface` avec bordure `1px solid`).
   - Interdiction absolue d'imbriquer une carte bordée/ombrée dans une autre carte. Structurer l'intérieur d'une surface par l'espace (`gap`), la hiérarchie typographique et des filets séparateurs `1px`.
2. **Zéro pills statiques** :
   - Les métadonnées passives (nom de banque `BoursoBank`/`Revolut`, type de compte, mois, catégorie en ligne de tableau, statut passif) s'affichent en typographie sobre ou texte structuré, **jamais** sous forme de badges arrondis colorés (« pills »).
   - Réserver l'aspect pilule exclusivement aux **contrôles interactifs réels** (boutons filtres cliquables, sélecteur de périmètre actif).
3. **Hitboxes tactiles `>= 44×44 px`** :
   - Tout bouton, lien, onglet de navigation, ligne cliquable d'opération, interrupteur ou déclencheur de note doit avoir une zone interactive minimale de `44×44 px` (`min-block-size: 44px; min-inline-size: 44px;`).
4. **Plafond sticky mobile `<= 15 %`** :
   - Sur mobile (`390×844` et viewports `< 768px`), la hauteur cumulée de tous les éléments `position: sticky` ou `position: fixed` simultanément visibles ne doit **jamais dépasser 15 % de la hauteur du viewport** (`<= 126 px` sur `844 px`, incluant `env(safe-area-inset-bottom)`).
   - L'en-tête supérieur défile naturellement avec la page ; seule la barre de navigation basse (`4` onglets : *Synthèse*, *Transactions*, *Règles*, *Synchro Drive*, hauteur `~64 px` + safe area) reste fixe.
5. **Zéro débordement horizontal (`390px` et `320px`)** :
   - Largeur strictement bornée (`overflow-x: clip`).
   - Sur Desktop (`1440×900`), rail latéral fixe `240 px` + tableau complet exposant obligatoirement les colonnes **Date**, **Banque**, **Type de compte** (avec nom renommable & devise), **Libellé**, **Catégorie**, **Note personnalisée**, **Montant (`tabular-nums`)**.
   - Sur Mobile (`390×844` / `320px`), conversion via `@container` en lignes compactes à 2 rangs (jamais de tableau horizontal forcé).
6. **Écriture en ligne uniquement & Mode Hors-Ligne Android transparent** :
   - Sur Android hors-ligne, 100 % des vues de consultation (graphiques, grand livre, notes existantes, règles, dernier état Drive) restent accessibles depuis le cache local.
   - Aucune file d'écriture hors-ligne : les contrôles de mutation (ajout/édition de note, règle, catégorie manuelle, renommage compte, bouton *« Synchroniser maintenant »*) passent à l'état désactivé avec mention explicite *« Connexion requise pour modifier »* et un bandeau discret non bloquant informe du mode hors-ligne.

### 5.3 Graphiques Recharts, Bandeau Commun de Filtres & Mode Multi-Devises

1. **Bandeau commun de filtres (`GlobalFilterBar`) sur *Synthèse* et *Transactions*** :
   - Regroupe en une surface unique non-sticky sur mobile : le périmètre bancaire (`Tous les comptes`, `BoursoBank`, `Revolut`), le mode de devise (`EUR consolidé`, `USD seul`), le sélecteur de période (`1 semaine`, `1 mois` par défaut, `3 mois`, `6 mois`, `1 an`, `Tout`, `Personnalisé` début/fin) et un bouton manuel **« Synchroniser »** (`POST /api/sync/drive`, désactivé hors-ligne).
   - **Granularité adaptative** : les deux graphiques Recharts s'adaptent automatiquement à la plage sélectionnée — affichage **jour par jour** lorsque la période couvre `<= 45` jours calendaires, et **mois par mois** au-delà (`> 45` jours).
2. **Solde cumulé (`CumulativeBalanceChart`)** :
   - Courbe/aire sur la période sélectionnée (par défaut 1 mois en vue journalière, ou 6M/mensuelle selon le filtre), tooltip accessible clavier/tactile en `JetBrains Mono tabular-nums`.
3. **Dépenses (`ExpensesComparisonChart`)** :
   - Comparaison des dépenses (mode `Sans comparaison`, `Mois/Période précédente`, `Moyenne 3 mois`) à la granularité de la période active.
   - Les opérations marquées `Transfert interne` (y compris les conversions Revolut `EUR ↔ USD`) sont **strictement exclues** des totaux de dépenses.
4. **Modes de devise** :
   - **Mode par défaut (`EUR consolidé`)** : toutes les opérations USD sont converties en `EUR (€)` via `amount_eur_cents` / `fx_rate_micro` figés à la date d'opération ; chaque ligne USD affiche son montant natif (`$`) et son équivalent discret (`≈ €`).
   - **Mode filtre (`Vue USD seul`)** : bascule les KPIs et les 2 graphiques Recharts en `$ USD` natif sans conversion EUR.
5. **Accessibilité & Rendu Recharts** :
   - Conteneur avec hauteur explicite (`aspect-ratio` / `min-block-size`) pour éviter `CLS` et boucle `ResizeObserver` dans Android WebView.
   - Désactiver les animations Recharts sous préférence système : `isAnimationActive={!prefersReducedMotion}`.

### 5.4 Accessibilité WCAG 2.1 AA

- Contraste minimal **`4.5:1`** pour tout texte normal, **`3:1`** pour grands titres, icônes fonctionnelles et séries graphiques.
- Aucune information transmise par la couleur seule (paliers budgétaires `< 75 %`, `75–99 %`, `>= 100 %` doublés par icône et texte chiffré explicite).
- Sémantique HTML native (`<main>`, `<nav>`, `<header>`, `<table>` sur Desktop, `<button type="button">`), navigation clavier complète (`Tab`, `Shift+Tab`, `Échap` sur `<dialog>`), et région `aria-live="polite"` unique pour les annonces d'état.

---

## 6. Git Atomique, Tests & Seuils CI

### 6.1 Stratégie Git Atomique

- **1 commit = 1 intention logique cohérente et compilable** (jamais de commit mélangeant schéma SQL, logique worker, refonte UI et configuration Docker).
- Format recommandé (Conventional Commits) : `<type>(<scope>): <description concise>` (`feat(ledger):`, `fix(worker):`, `docs(adr):`, `test(rules):`, `chore(ci):`).
- Interdiction de commiter des fichiers `.env`, clés privées, keystores Android (`*.jks`, `keystore.properties`) ou artefacts générés (`dist/`, `android/app/build/`).

### 6.2 Pyramide de Tests (Vitest)

1. **Tests unitaires — Couverture 100 % obligatoire sur la logique critique** :
   - Arithmétique monétaire en centimes entiers et conversion FX historique `EUR ↔ USD` sans perte d'arrondi flottant.
   - Calcul déterministe de `dedup_hash` (chevauchement de relevés, occurrences multiples identiques même jour).
   - Détection et appariement des transferts internes (`BoursoBank ↔ Revolut`, inter-comptes, changes `EUR ↔ USD`).
   - Moteur de règles de catégorisation et recalcul rétroactif préservant `is_manual_category = true`.
   - Validation Zod des schémas d'extraction PDF Gemini et des payloads de delta sync.
   - Logique de merge et persistance du cache lecture seule Android.
2. **Tests d'intégration** :
   - Contrats HTTP de `api` (statuts, formats d'erreur, auth, endpoints `/api/sync/delta`, `/api/sync/drive`, CRUD notes/règles).
   - Transactions atomiques Drizzle et reprise sur erreur de checkpoint SQL par fichier PDF (y compris simulation d'échec Gemini sur 1 fichier au milieu d'un lot).
3. **Tests UI & Responsive** :
   - Rendu des 5 états clés (peuplé, vide, synchronisation granulaire, hors-ligne Android, erreur partielle).
   - Vérification non-régression géométrique à `1440×900`, `390×844` et `320px` (zéro débordement horizontal, hitboxes `>= 44px`, sticky `<= 15 %`, ouverture/fermeture `<dialog>`).

### 6.3 Porte CI Obligatoire

Tout PR/merge ou fin de lot `/swarm` exige le passage vert sans contournement (`--no-verify` interdit, zéro `@ts-ignore` / `eslint-disable` non justifié) des commandes racine :

1. `npm run typecheck` (et `npm run lint`, vérification TypeScript stricte sur les 4 workspaces)
2. `npm test` (tous tests unitaires et d'intégration verts, 0 test skippé)
3. `npm run build` (build Vite `apps/web`, zéro fuite de secret client)
4. `npm run audit` (`scripts/run-audit-bot.mjs`, conformité EGM / Baseline / Mobbin / YAML PASS 100 %)

---

## 7. Règles de Sécurité & Périmètre Drive

1. **Zéro secret dans le client Web et l'APK Android** :
   - Les secrets `DATABASE_URL` (Neon), `GEMINI_API_KEY`, credentials Google Drive (OAuth/Service Account), `CLAIRFLUX_ACCESS_SECRET_HASH` et `CLAIRFLUX_SESSION_SECRET` résident **exclusivement** dans les variables d'environnement / secrets montés des conteneurs `api` et `sync-worker`.
   - Aucune variable `VITE_*` ne doit contenir de clé API, token Drive ou URL de base de données. Contrôle automatisé dans le pipeline de build APK avant `npx cap sync android`.
2. **Exclusivité absolue des 2 dossiers Google Drive** :
   - Périmètre codé en dur et vérifié à la fois par validation applicative (`packages/shared`) et contrainte SQL `CHECK` dans Neon :
     - **BoursoBank** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
     - **Revolut** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
   - Scope Google Drive limité au strict **lecture seule** (`drive.readonly`), **déclenchement manuel uniquement** via `POST /api/sync/drive` (zéro cron/polling automatique).
   - Tout autre ID de dossier est rejeté et journalisé comme violation de périmètre.
3. **Authentification personnelle & Transport** :
   - Accès privé personnel protégé par secret/mot de passe haché (`scrypt`/`argon2`) et jeton de session/bearer signé avec expiration et révocation.
   - HTTPS obligatoire en production pour l'APK Android (`usesCleartextTraffic="false"` dans le manifeste Android release).
4. **Hygiène des données & SQL** :
   - Requêtes Drizzle paramétrées uniquement (zéro concaténation SQL).
   - Traitement des libellés bruts PDF et notes personnalisées comme texte brut échappé par React (interdiction stricte de `dangerouslySetInnerHTML` ou injection HTML).
   - Aucun PDF bancaire brut n'est envoyé dans le payload `GET /api/sync/delta` ni stocké sur le terminal Android.
5. **Routage Reverse-Proxy Nginx & Convention `VITE_API_BASE_URL`** :
   - Dans `apps/web/Dockerfile`, le serveur Nginx (port `8080`) doit impérativement proxifier `location /api/` vers `http://api:3000` (sans slash final sur `proxy_pass`, afin de préserver le préfixe `/api/...`), transmettre `Host $http_host` et fixer `proxy_read_timeout 300s` / `proxy_send_timeout 300s` pour absorber les synchronisations Drive/Gemini.
   - Côté client (`apps/web`), toute construction d'URL API (`useOfflineStore.ts`, `deltaSyncEngine.ts`, `ApkDownloadCard.tsx`) doit passer par `buildApiEndpointUrl` (`apps/web/src/offline/apiUrl.ts`) afin de valider le schéma (`http:`/`https:` ou chemin relatif sûr) et supprimer tout `/api` final éventuel sur `VITE_API_BASE_URL` (évitant la duplication `/api/api/...`).
