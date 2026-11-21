# ADR-0004 : Architecture UI Baseline (WebView Android & Desktop), Polices Offline et Visualisations Recharts

- **Statut** : Proposé (Normatif Pré-Code)
- **Date** : 2026-11-21
- **Décideurs** : Product Owner & Architecte Standards / Frontend (`standards-author`)
- **Références** :
  - [TECHNICAL_STANDARDS.md](file:///d:/Applications/Clairflux/docs/TECHNICAL_STANDARDS.md)
  - [PROTOTYPE_SPEC.md](file:///d:/Applications/Clairflux/docs/prototypes/PROTOTYPE_SPEC.md)
  - [BASELINE_CLAIRFLUX.md](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/BASELINE_CLAIRFLUX.md)
  - [frontend-ui-engineering/SKILL.md](file:///d:/Applications/Clairflux/.agent/skills/frontend-ui-engineering/SKILL.md)

---

## 1. Contexte

ClairFlux doit offrir une expérience financière homogène, fluide et lisible sur deux environnements très contrastés à partir d'une base de code React unique :
1. **Desktop (`1440 × 900`)** : consultation analytique multi-comptes (BoursoBank et Revolut EUR/USD), grand livre tabulaire complet avec colonnes **Banque**, **Type de compte**, **Note personnalisée**, panneau latéral d'édition, et onglet dédié aux règles de catégorisation.
2. **Mobile Android (`390 × 844`, jusqu'à `320 px` de largeur minimale) via Capacitor APK** : consultation à une main dans **Android System WebView** en mode **100 % Offline-First en lecture seule**, avec ouverture 1-tap d'un tiroir tactile d'annotation et accès aux deux graphiques structurants (**Solde cumulé 6M** et **Dépenses M-1 / Moyenne 3M**).

L'application doit simultanément respecter des budgets stricts de performance (`INP <= 200 ms`, `LCP <= 2.5 s`, `CLS <= 0.1`), les règles ergonomiques Fintech (élévation unique sans cartes imbriquées, zéro pills statiques, hitboxes `>= 44×44 px`, plafond sticky mobile `<= 15 %` soit `<= 126 px`), et le basculement multi-devises entre vue **EUR consolidé** et **Vue USD seul**.

---

## 2. Contraintes

- **Rendu identique hors-ligne dans Capacitor Android** : aucune ressource critique (polices, icônes, styles) ne doit dépendre d'un CDN externe.
- **Compatibilité Android System WebView** : prise en charge des WebViews Chromium récentes (cible `>= 114`) avec dégradation gracieuse si certaines APIs récentes (`popover`, `scheduler.yield`, `startViewTransition`, `closedby`) manquent sur un appareil plus ancien.
- **Zéro débordement horizontal mobile** (`390 px` et `320 px`) malgré la richesse des colonnes attendues sur Desktop (`Date`, `Banque`, `Type de compte`, `Libellé`, `Catégorie`, `Note`, `Montant`).
- **Stabilité visuelle numérique** : comparaison de montants EUR et USD sur 6 mois et sur listes longues sans saut de mise en page ni ambiguïté de devise.
- **Simplicité & Maintenabilité** : éviter d'alourdir le bundle APK avec des bibliothèques UI redondantes alors que la plate-forme Web moderne fournit les primitives nativement.

---

## 3. Options Considérées

### Axe A — Primitives UI & Adaptabilité (`<dialog>`, `@container`, `content-visibility`)
- **Option A1 (Retenue) — Plate-forme Web native Baseline (`modern-web-guidance`)** : utiliser `<dialog>` natif (`.showModal()`), `popover`, `@container` (`inline-size`), `:has()` borné, `:user-valid/:user-invalid`, et `content-visibility: auto` + `contain-intrinsic-size`, avec polyfills conditionnels uniquement sur absence détectée.
- **Option A2 — Suite UI tierce complète (Radix UI / MUI / React-Window partout)** : abstraction JS pour modales, focus traps, popovers, et virtualisation JS complète des listes.
  - *Rejetée* : poids bundle inutile dans l'APK, redondance avec `<dialog>` natif (qui gère nativement focus trap, top layer et touche `Échap` / bouton retour), complexité d'accessibilité accrue pour les listes simples déjà accélérées par `content-visibility: auto` + Web Worker.

### Axe B — Stratégie Typographique (`Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono`)
- **Option B1 (Retenue) — Polices `.woff2` bundlées localement dans Vite (`dist/assets/`)** avec `font-variant-numeric: tabular-nums` et `<link rel="preload">` sur les graisses critiques.
- **Option B2 — Chargement Google Fonts CDN** :
  - *Rejetée* : casse totalement en mode avion Android (objectif Offline-First violé) et génère des requêtes réseau externes non souhaitées.
- **Option B3 — Polices système par défaut (`system-ui`, `monospace`)** :
  - *Rejetée* : ne garantit pas `tabular-nums` homogène sur toutes les WebViews Android et dégrade la hiérarchie visuelle validée dans `PROTOTYPE_SPEC.md`.

### Axe C — Moteur Graphique Multi-Devises (`Solde cumulé 6M` & `Dépenses M-1 / Moyenne 3M`)
- **Option C1 (Retenue) — Recharts en import paresseux (`React.lazy`) avec agrégats pré-calculés en centimes côté serveur / worker** :
  - Deux composants dédiés (`CumulativeBalanceChart` et `ExpensesComparisonChart`) recevant des séries déjà prêtes en `EUR consolidé` (taux historique figé) ou `USD seul`, rendus dans des conteneurs à `aspect-ratio` / `min-block-size` fixes.
- **Option C2 — Chart.js (Canvas) ou ECharts** :
  - *Rejetée* : Canvas moins naturel pour l'accessibilité DOM/clavier et le style React/CSS tokens ; ECharts trop lourd pour le bundle APK pour seulement deux graphiques.
- **Option C3 — SVG artisanal pur** :
  - *Rejetée* : coût élevé pour gérer tooltips tactiles/clavier, axes responsives et maintenance par rapport à Recharts déjà retenu dans l'intention produit.

### Axe D — Gabarits Responsive (`1440×900` vs `390×844`) & Élévation
- **Option D1 (Retenue) — Élévation unique + transformation par `@container` + `<dialog>` adaptatif** :
  - Desktop `1440×900` : rail latéral fixe `240 px`, tableau grand livre complet, `<dialog>` ancré en panneau latéral droit (`420 px`).
  - Mobile `390×844` : en-tête scrollable, barre de navigation basse fixe `<= 64 px + safe-area` (strictement `<= 15 %` de `844 px`), lignes de transaction à 2 rangs sous `@container`, `<dialog>` ancré en tiroir bas (`bottom sheet`).
- **Option D2 — Tableau scrollable horizontalement sur mobile ou cartes empilées par transaction** :
  - *Rejetée* : viole la règle zéro scroll horizontal à `390 px` / `320 px` et le principe d'élévation unique (surcharge visuelle).

---

## 4. Décision Retenue

1. **Adoption de l'architecture Baseline `modern-web-guidance`** :
   - Toutes les modales, le panneau latéral Desktop et le tiroir tactile mobile utilisent un seul composant logique s'appuyant sur `<dialog>.showModal()`, avec `overscroll-behavior: contain` sur `dialog:modal` et `dialog::backdrop`, et interception prioritaire du bouton Retour matériel Android sous Capacitor.
   - Les adaptativités de composants (cartes KPI, lignes du grand livre, filtres) reposent sur `container-type: inline-size` et `@container`, complétés par `100dvh` et `env(safe-area-inset-*)`.
   - Les listes longues de transactions et de fichiers Drive utilisent `content-visibility: auto` couplé à `contain-intrinsic-size: auto 72px` (uniquement sous la ligne de flottaison).
   - Le tri/filtrage sur `> 500` opérations est déporté en Web Worker ou découpé via `yieldToMain()` (`scheduler.yield()` + fallback `setTimeout`) pour tenir `INP <= 200 ms`.
2. **Bundling local des polices WOFF2** :
   - `Plus Jakarta Sans`, `DM Sans` et `JetBrains Mono` (`tabular-nums`) sont embarqués localement dans le build Vite et donc présents dans l'APK Android pour un rendu Offline-First immédiat (`LCP < 1.2 s` local).
3. **Architecture Recharts découplée et multi-devises** :
   - Les graphiques `Solde cumulé 6M` et `Dépenses M-1 / Moyenne 3M` sont chargés en `React.lazy` avec un squelette de hauteur fixe pour garantir `CLS <= 0.1`.
   - Les données d'entrée sont fournies en centimes entiers pré-agrégés (avec exclusion des `Transfert interne` / changes `EUR ↔ USD`) selon le mode actif :
     - **EUR consolidé** : somme convertie via le taux historique figé de chaque transaction (`amount_eur_cents`).
     - **Vue USD seul** : filtrage sur les comptes USD et affichage natif en `$ USD`.
   - Les tooltips et axes formatent les valeurs en `JetBrains Mono tabular-nums` (`fr-FR`), et `isAnimationActive` est désactivé lorsque `@media (prefers-reduced-motion: reduce)` est actif.
4. **Gabarits `1440×900` et `390×844` à élévation unique** :
   - Une seule couche de surface sur fond canvas avec séparateurs `1 px`, zéro carte imbriquée, zéro pill statique décorative, cibles tactiles `>= 44×44 px`, et plafond sticky mobile `<= 126 px` (`<= 15 %` sur `844 px`).

---

## 5. Conséquences & Risques

### Conséquences positives
- **Performance & poids maîtrisé** : suppression des bibliothèques de modales/popovers/virtualisation lourdes, améliorant le `LCP` et le temps d'ouverture de l'APK.
- **Zéro dépendance réseau à l'affichage** : l'APK démarre instantanément en mode avion avec sa typographie exacte et ses deux graphiques Recharts alimentés par les agrégats du delta cache.
- **Cohérence ergonomique** : un même composant `<dialog>` assure l'annotation rapide en 1 tap sur mobile et l'édition contextualisée sur Desktop.

### Conséquences négatives / Coûts
- **Dimensionnement explicite requis pour Recharts** : dans Android System WebView ou lors d'un changement d'onglet masquant le conteneur, `ResponsiveContainer` peut mesurer `0px` transitoirement ; il faut imposer un `min-block-size` / `aspect-ratio` explicite sur le parent et monter le graphique uniquement lorsque le conteneur est visible.
- **Impact taille APK des polices** : embarquer 3 familles en `.woff2` (sous-ensemble latin) ajoute environ `180–300 Ko` à l'APK, ce qui reste largement acceptable pour un gain majeur de lisibilité financière.

### Risques identifiés & Mitigations

| Risque | Probabilité | Impact | Mitigation obligatoire |
| :--- | :--- | :--- | :--- |
| **WebView Android ancienne (< 114)** sur appareil utilisateur sans `popover` ou `scheduler.yield()` | Moyenne | Moyen | Détection de capacité systématique (`Object.hasOwn(HTMLElement.prototype, 'popover')`, `'scheduler' in window`) avec fallback `setTimeout` et chargement conditionnel de `@oddbird/popover-polyfill` uniquement si requis. |
| **Avertissement console / CLS Recharts** sur `ResponsiveContainer` lors des transitions d'onglets | Moyenne | Moyen | Donner une hauteur fixe explicite (`min-block-size`, `aspect-ratio`) au conteneur parent et afficher un squelette de mêmes dimensions pendant le `React.lazy`. |
| **Dépassement de l'INP `> 200 ms`** avec re-rendu Recharts lors de la frappe dans un filtre | Moyenne | Élevé | Débouncer/différer (`useDeferredValue`) le rafraîchissement des graphiques, découper les calculs via Web Worker / `yieldToMain()`, et borner `:has()` aux petits groupes de champs. |
| **Dépassement du plafond sticky `<= 15 %`** sur petits écrans Android avec grande barre système | Faible | Moyen | Calculer la hauteur fixe totale (`64 px` + `env(safe-area-inset-bottom)`) et interdire tout autre élément `sticky`/`fixed` simultané sur mobile ; vérifier en test automatisé à `390×844` et `320×568`. |
