# Audit de Compatibilité Navigateur & Standards Baseline — ClairFlux v2

- **Statut** : Livré — Audit Pré-Code EGM (`Phase 0`)
- **Date** : 2026-11-26
- **Auteur** : `baseline-auditor`
- **Périmètre analysé** : Existant `v1.0.1-build.3` + Architecture cible **ClairFlux v2** (Catégories 2 niveaux, IA Gemini hybride & Boîte de révision, Budget Monarch + Rollover, Pack Graphiques + Sankey Desktop-only, Simulateur « Et si… » & Projections 3/6/12M, Bilan IA mensuel)
- **Références normatives** :
  - [SKILL.md (modern-web-guidance)](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/SKILL.md)
  - [BASELINE_CLAIRFLUX.md](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/BASELINE_CLAIRFLUX.md)
  - Guides locaux : [dialog](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/ui-components/dialog/guide.md), [declarative-dialog-popover-control](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/ui-behaviors/declarative-dialog-popover-control/guide.md), [size-aware-styling](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/css/size-aware-styling/guide.md), [style-parent-with-has](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/css/style-parent-with-has/guide.md), [validate-input-after-interaction](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/forms/validate-input-after-interaction/guide.md), [same-document-transitions](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/ui-behaviors/same-document-transitions/guide.md), [defer-rendering-heavy-content](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/performance/defer-rendering-heavy-content/guide.md), [identify-inp-causes](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/performance/identify-inp-causes/guide.md), [break-up-long-tasks](file:///d:/Applications/Clairflux/.agent/skills/modern-web-guidance/guides/performance/break-up-long-tasks/guide.md)
  - [ADR-0004](file:///d:/Applications/Clairflux/docs/ADR/0004-ui-baseline-and-recharts-architecture.md)

> **Synthèse exécutive pour le Product Owner** : La base `v1.0.1-build.3` respecte déjà la majorité des fondations *Modern Web Guidance* (polices locales hors-ligne, `<dialog>` natif, `@container`, `content-visibility: auto`, `tabular-nums`, cibles `>= 44 px`, plafond sticky mobile `<= 15 %`). En revanche, **six écarts réels** ont été relevés dans le code existant (dont un défaut silencieux de routage du focus clavier sur l'onglet *Transactions*, l'absence de Web Worker actif, et des styles `<dialog>` non différenciés entre tiroir latéral et modale centrée). Pour la **v2**, les nouvelles briques (Popover API, `:user-invalid`, Sankey Desktop-only, Simulateur « Et si… » et Bilan IA) sont pleinement compatibles avec **Desktop moderne (Chrome, Safari, Firefox)** et **Android System WebView `>= 114`** moyennant des gardes de détection de capacité ciblées et un Web Worker dédié pour maintenir l'**INP `<= 200 ms`**.

---

## 1. État des lieux de l'existant (`v1.0.1-build.3`)

L'audit factuel a porté sur [index.html](file:///d:/Applications/Clairflux/apps/web/index.html), [main.tsx](file:///d:/Applications/Clairflux/apps/web/src/main.tsx), [DashboardCharts.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/dashboard/DashboardCharts.tsx), [capacitor.config.ts](file:///d:/Applications/Clairflux/apps/web/capacitor.config.ts), ainsi que les modules directement couplés ([DashboardChrome.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/dashboard/DashboardChrome.tsx), [types.ts](file:///d:/Applications/Clairflux/apps/web/src/features/dashboard/types.ts), [BottomSheetNoteDialog.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/ledger/BottomSheetNoteDialog.tsx), [TransactionsSection.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/ledger/TransactionsSection.tsx), [RulesTab.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/ledger/RulesTab.tsx), [deltaSyncEngine.ts](file:///d:/Applications/Clairflux/apps/web/src/offline/deltaSyncEngine.ts), [vite.config.ts](file:///d:/Applications/Clairflux/apps/web/vite.config.ts)).

### 1.1 Bilan par fichier audité

| Fichier | Points conformes vérifiés | Écarts et points de vigilance réels constatés |
| :--- | :--- | :--- |
| [index.html](file:///d:/Applications/Clairflux/apps/web/index.html) | • Viewport `viewport-fit=cover` + `env(safe-area-inset-top/bottom)` (L5, L117-150).<br>• Zéro CDN externe (polices bundlées localement).<br>• Unités `100dvh` / `100dvw` et `overflow-x: clip` (zéro `100vh`/`100vw`).<br>• `.tabular-amount` (`JetBrains Mono` + `tabular-nums`, L84-87).<br>• Cibles tactiles `>= 44×44 px` sur tous les contrôles interactifs.<br>• `.cf-bottom-nav` à `64 px` (`7.6 % <= 15 %` sur `844 px`).<br>• `@container` (`kpis`, `charts`, `ledger` en `inline-size` uniquement).<br>• `.cf-field-group:has(...)` borné (jamais `body:has()`).<br>• `:user-valid` / `:is(:user-invalid, .user-invalid-fallback)`.<br>• `content-visibility: auto` + `contain-intrinsic-size: auto 72px`.<br>• `dialog.cf-dialog:modal` + `::backdrop` avec `overscroll-behavior: contain`.<br>• `@media (prefers-reduced-motion: reduce)` couvrant jauges et `::view-transition-*`. | 1. **Grille 3 colonnes figée** : `.cf-bottom-nav` (L148) déclare `repeat(3, minmax(0, 1fr))` ; devra passer à 4 colonnes en v2.<br>2. **Monolithe `<dialog>`** : sur `>= 768 px` (L734-747), *tout* `dialog.cf-dialog:modal` est forcé en tiroir latéral droit (`420 px`, `100dvh`), bloquant l'usage de modales centrées pour le Gestionnaire de Catégories.<br>3. **Sélecteur d'erreur `~` fragile** : `.cf-field-input:is(...) ~ .cf-field-error` (L706) échoue si l'input est encapsulé dans un conteneur flex (cas observé dans [AuthUnlockScreen.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/auth/AuthUnlockScreen.tsx) L75).<br>4. **Absence de fallback `@supports not (container-type: inline-size)`** : sous WebView `< 105`, `.cf-ledger-table-wrap` reste en `display: none` (L585) même sur écran large.<br>5. **Absence de `<link rel="preload" as="font">`** pour les graisses critiques `.woff2`.<br>6. **Divergence `aspect-ratio: 16 / 9` vs `min-block-size: 260px`** sur `.cf-chart-frame` (L477-481) face au `height={260}` fixe de Recharts. |
| [DashboardCharts.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/dashboard/DashboardCharts.tsx) | • Export `memo` compatible `React.lazy`.<br>• `isAnimationActive={!prefersReducedMotion}` appliqué sur les 4 `<Area>` (L185, L238, L250, L263).<br>• Hauteur explicite `height={260}` sur `ResponsiveContainer` (évite l'effondrement `0 px` initial).<br>• Tooltips en `tabular-amount` et centimes entiers (`formatMoney`). | 1. **Aucun équivalent tabulaire accessible clavier** : les séries 6M et Dépenses sont uniquement rendues en SVG Recharts (seule la dernière valeur mensuelle est résumée en texte L270-295).<br>2. **Formatage axe Y artisanal** : `formatAxisMoney` (L134-140) concatène manuellement la valeur arrondie suivie du symbole `€` ou `USD` (symbole placé après le nombre même en USD, sans séparateur `fr-FR`).<br>3. **Recalcul et clonage sur le thread principal** : `buildCumulativeBalanceSeries` et `buildMonthlyExpenseSeries` tournent dans `useMemo` sur le main thread + recréation `[...balanceSeries]` à chaque rendu (risque INP `> 200 ms` au passage à `2 940+` opérations).<br>4. **Écart hauteur conteneur** : `aspect-ratio: 16 / 9` (~`309 px` sur colonne desktop `550 px`) vs `height={260}` crée ~`49 px` d'espace mort sous le graphe. |
| [main.tsx](file:///d:/Applications/Clairflux/apps/web/src/main.tsx) & [types.ts](file:///d:/Applications/Clairflux/apps/web/src/features/dashboard/types.ts) | • 3 familles `@fontsource/*` importées localement en WOFF2 (L1-8).<br>• `React.lazy` + `<Suspense fallback={<ChartsSkeleton />}>` pour graphiques, grand livre et tiroir de notes.<br>• Montage paresseux du `<dialog>` (`hasOpenedDialog \|\| selectedTx`, L400).<br>• Helper `runWithViewTransition` testant `'startViewTransition' in document` et `prefersReducedMotion`.<br>• Helper `yieldToMain()` conforme (`scheduler.yield()` + fallback `setTimeout`) déjà défini dans `types.ts` (L119-130).<br>• Région unique `aria-live="polite"` (L382-393). | 1. **Bug avéré de routage du focus sur `Transactions`** : `HEADING_BY_TAB.transactions` vaut `'ledger-section-heading'` (`main.tsx` L63), alors que [TransactionsSection.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/ledger/TransactionsSection.tsx) L116 pose `id="ledger-heading"`. De plus, au 1er affichage de l'onglet en `React.lazy`, `requestAnimationFrame` s'exécute avant la résolution de `Suspense`, donc le focus est abandonné.<br>2. **`yieldToMain()` mort (non appelé) et zéro Web Worker** : aucune boucle de filtrage, tri ou calcul d'agrégats n'utilise `yieldToMain()` ni `Worker` (`apps/web/src/workers/` absent).<br>3. **Architecture à 3 onglets** : `AppTab` (`types.ts` L40-43) doit être étendu au 4e onglet `budget`.<br>4. **Gestion `<dialog>` v1 à durcir** ([BottomSheetNoteDialog.tsx](file:///d:/Applications/Clairflux/apps/web/src/features/ledger/BottomSheetNoteDialog.tsx)) : fermeture backdrop via `event.target === dialogRef.current` (L73) au lieu de `closedby="any"` + bounding rect ; absence de `dialog.returnValue = ''` après fermeture ; surcharge `style={{ padding: 0 }}` inline (L104). |
| [capacitor.config.ts](file:///d:/Applications/Clairflux/apps/web/capacitor.config.ts) & [deltaSyncEngine.ts](file:///d:/Applications/Clairflux/apps/web/src/offline/deltaSyncEngine.ts) | • `androidScheme: 'https'` (L34) assurant un contexte sécurisé (`SecureContext`) pour IndexedDB, WebCrypto et Web Workers.<br>• `allowMixedContent: false` (L37) et `captureInput: true` (L38).<br>• Pont Android *feature-detected* (`globalThis.Capacitor?.Plugins`) sans dépendance `@capacitor/*` obligatoire dans le bundle Web.<br>• Interception `backButton` fermant le `<dialog open>` actif en priorité (`deltaSyncEngine.ts` L680-693, L755-764). | 1. **Bouton Retour Android incomplet pour v2** : `closeActiveDialogIfPresent()` ne ferme que `dialog[open]` — il ignore les `[popover]:popover-open` ouverts et ne gère pas le retour d'un onglet secondaire vers `Synthèse`.<br>2. **Cible SDK 35 (Android 15 Edge-to-Edge)** : [Dockerfile.apk-builder](file:///d:/Applications/Clairflux/Dockerfile.apk-builder) compile sous `ANDROID_COMPILE_SDK=35` sans configuration explicite de barre système/clavier (`StatusBar` / `Keyboard` / `interactive-widget`) dans `capacitor.config.ts`. En v2 (curseurs range, édition catégories, popovers), le clavier virtuel doit éviter de masquer la barre d'action du tiroir.<br>3. **Durcissement release** : `android.webContentsDebuggingEnabled` n'est pas explicitement fixé à `false` pour les builds release. |

---

## 2. Matrice Baseline & WebView Android pour ClairFlux v2

Politique de ciblage :
- **Desktop** : Chrome / Edge `>= 120`, Safari `>= 16.5`, Firefox `>= 121` (Baseline *Widely* / *Newly Available*).
- **Android System WebView (Capacitor)** : cible nominale **Chromium WebView `>= 114`** (Android 10+ avec mise à jour Google Play / Trichrome) et **dégradation gracieuse systématique pour WebView `< 114`** (`>= 96–113`).
- **Règle de polyfill** : aucun polyfill importé statiquement ; détection de capacité stricte avant `import()` dynamique ou bascule sur fallback natif.

### 2.1 Barre de navigation à 4 onglets (*Synthèse*, *Budget*, *Transactions*, *Synchro*)

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **Grille 4 colonnes** (`grid-template-columns: repeat(4, minmax(0, 1fr))`) | Widely Available | Natif (`>= 57`) | Natif | Remplacer `repeat(3, ...)` par `repeat(4, minmax(0, 1fr))`. Sur `390 px` (`97,5 px/col`) et `320 px` (`80 px/col`), imposer icône empilée au-dessus d'un libellé court (`Synthèse`, `Budget`, `Transactions`, `Synchro`), `font-size: 0.75rem`, `min-inline-size: 0` sur les items pour empêcher tout débordement horizontal. |
| **Hitboxes `>= 44×44 px`** | WCAG 2.1 / 2.2 | Natif | Natif | Chaque `.cf-nav-btn` conserve `min-block-size: 44px; min-inline-size: 44px;`. À `320 px` de large, `80 px × 64 px` satisfait largement `>= 44×44 px`. |
| **Plafond sticky `<= 15 %`** (`64 px` + safe-area) | Widely Available (`env()`) | Natif (`>= 69`) | Natif (`0 px` si absent) | `block-size: calc(64px + env(safe-area-inset-bottom, 0px))`. Sur `390×844` : `64 / 844 = 7,6 %` (avec `34 px` de barre gestuelle Android : `98 / 844 = 11,6 % <= 15 %`). Sur `320×568` : `64 / 568 = 11,3 % <= 15 %`. **Interdit** d'ajouter tout autre bandeau `sticky` ou `fixed` sous `< 1024 px`. |
| **View Transitions API** (`startViewTransition`) | Same-document Baseline (Chrome `111+`, Safari `18+`, Firefox `144+`) | Natif (`>= 111`) | Mise à jour DOM directe (`if (!document.startViewTransition)`) | Conserver `runWithViewTransition`, désactiver sous `@media (prefers-reduced-motion: reduce)`. **Corriger le routage du focus** : attendre le montage post-`Suspense` (via callback `ref` / `useEffect` sur changement d'onglet) et aligner les IDs (`overview-heading`, `budget-heading`, `ledger-heading`, `sync-heading`). |
| **Bouton Retour matériel Android** | N/A (Capacitor) | Capacitor `App.addListener('backButton')` | Idem | Ordre de priorité strict : 1) fermer `[popover]:popover-open` actif, 2) fermer `dialog[open]` actif, 3) revenir de `budget`/`transactions`/`sync` vers `overview` avant de quitter l'app. |

---

### 2.2 Gestionnaire Catégories & Sous-catégories (Arbre libre à 2 niveaux)

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **`<dialog>.showModal()`** (modale centrée Desktop vs bottom-sheet Mobile) | Widely Available (Chrome `37+`, Safari `15.4+`, Firefox `98+`) | Natif (`>= 37`) | Natif | Séparer deux classes CSS : `.cf-dialog--drawer` (panneau latéral `420 px` existant) et `.cf-dialog--modal` (modale centrée `min(600px, calc(100dvw - 32px))` sur Desktop, bottom-sheet `85dvh` sur Mobile). **Interdiction** de `role="dialog"`, `aria-modal`, ou focus-trap JS manuel. Garder `overscroll-behavior: contain` sur `dialog:modal` et `dialog::backdrop` (`overflow: hidden`). Réinitialiser `dialog.returnValue = ''` dans `onClose`. |
| **`closedby="any"` / `closedby="none"`** | Progressif (Chrome `134+`, hors Baseline complet) | Natif uniquement `>= 134` | Listener `pointerdown` + `pointerup` sur `getBoundingClientRect()` si `!('closedBy' in HTMLDialogElement.prototype)` | Pour la modale de consultation/édition simple, utiliser `closedby="any"` avec le fallback bounding-rect (jamais `event.target === dialog` seul). Pour la modale de confirmation de suppression ou formulaire modifié non sauvegardé, utiliser `closedby="none"` + intercepteur `onCancel`. |
| **Invoker Commands (`command` / `commandfor`)** | Progressif (Chrome `135+`) | Natif uniquement `>= 135` | Handlers React `onClick` + `ref.showModal()` (aucun polyfill requis) | **Décision d'audit** : comme ClairFlux utilise React 19, piloter l'ouverture/fermeture des `<dialog>` de gestion des catégories via handlers React + `.showModal()` / `.close()` plutôt que d'embarquer `invokers-polyfill`. Si des attributs `commandfor` sont posés, tester `'commandForElement' in HTMLButtonElement.prototype` et toujours poser `type="button"` dans les `<form>`. |
| **`<details>` / `<summary>`** (arbre 2 niveaux Catégorie → Sous-catégories) | Widely Available (Chrome `12+`, Safari `6+`, Firefox `49+`) | Natif (`>= 37`) | Natif | Utiliser `<details>` + `<summary>` natifs pour déplier/replier les sous-catégories d'une catégorie parente sans JS d'accordéon. Imposer `min-block-size: 44px` sur `<summary>`, indicateur de pliage CSS accessible (`list-style` ou chevron SVG `aria-hidden="true"`), et boutons d'action (Ajouter sous-catégorie / Éditer) hors du `<summary>` ou avec `stopPropagation` hors clic résumé pour éviter les conflits d'activation. |
| **`:user-valid` / `:user-invalid`** | Newly Available (Chrome `119+`, Safari `16.5+`, Firefox `88+`) | Natif `>= 119` (absent en `114–118`) | Classe JS `.user-invalid-fallback` déclenchée sur `onBlur` + `onSubmit` + `invalid` en capture | Ne jamais afficher d'erreur dès la frappe initiale ; combiner `:is(:user-invalid, .user-invalid-fallback)`, synchroniser `aria-invalid` et lier `aria-describedby` vers le message d'erreur explicite uniquement lorsque le champ est invalide. |
| **`.cf-field-group:has(...)` borné** | Widely Available (Chrome `105+`, Safari `15.4+`, Firefox `121+`) | Natif (`>= 105`) | Classe `.has-error-fallback` via `CSS.supports('selector(:has(a))')` | Toujours scoper sur `.cf-field-group:has(:is(:user-invalid, .user-invalid-fallback))`. **Interdit** sur `body` ou `:root`. Pour réparer la fragilité constatée en v1, placer `.cf-field-error` en enfant direct de `.cf-field-group` et l'afficher via `.cf-field-group:has(:is(:user-invalid, .user-invalid-fallback)) .cf-field-error { display: flex; }` (plus robuste que `~`). |

---

### 2.3 Boîte de révision IA (Transactions `< 85 %` confiance & suggestions de règles)

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **Popover API (`[popover]`, top layer natif)** | Newly / Widely Available (Chrome `114+`, Safari `17+`, Firefox `125+`) | Natif (`>= 114`) | Détection `Object.hasOwn(HTMLElement.prototype, 'popover')` → import dynamique conditionnel de `@oddbird/popover-polyfill` uniquement si absent | Utilisé pour les menus rapides de choix de catégorie / prévisualisation de suggestion de règle gratuite dans la Boîte de révision. Ne **jamais** combiner `popovertarget` et `commandfor` sur un même `<button>`. Restituer le focus vers le bouton déclencheur lorsqu'un bouton interne ferme le popover. Prévoir un fallback de positionnement CSS (ancrage simple relatif / `<dialog>` non-modal) si CSS Anchor Positioning (`125+`) est absent. |
| **`content-visibility: auto` + `contain-intrinsic-size`** | Newly Available (Chrome `85+`, Safari `18+`, Firefox `125+`) | Natif (`>= 85`) | Ignoré proprement (rendu standard) | Appliquer `.cf-tx-row-deferred` (`content-visibility: auto; contain-intrinsic-size: auto 96px;`) **uniquement** sur les items de la file de révision IA situés sous la ligne de flottaison (`index >= 8`). **Interdit** au-dessus du fold. Tester obligatoirement la navigation clavier séquentielle (`Tab`) à travers la frontière des items différés. |
| **`yieldToMain()` / `scheduler.yield()`** | Progressif (Chrome `129+`, Firefox `142+`) | Natif `>= 129` (absent en `114–128`) | `setTimeout(resolve, 0)` (déjà implémenté dans `yieldToMain()` de `types.ts`) | Utiliser `yieldToMain()` toutes les `<= 50 ms` (`deadline = performance.now() + 50`) lors d'actions client en lot (ex. « Tout valider >= 80 % » ou recalcul d'aperçu d'une suggestion de règle sur `2 940+` transactions locales) pour garantir **INP `<= 200 ms`**. |

---

### 2.4 Module Budget Monarch + Rollover (Fixes / Variables / Non-mensuelles)

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **`@container inline-size`** (`container: budget-row / inline-size`) | Widely Available (Chrome `105+`, Safari `16+`, Firefox `110+`) | Natif (`>= 105`) | `@supports not (container-type: inline-size)` avec `@media (min-width: 768px)` | Adapter chaque enveloppe (groupe Fixes / Variables / Non-mensuelles, ligne Catégorie, sous-plafond Sous-catégorie) à la largeur disponible de la carte sans multiplication de `@media`. **Interdiction** absolue de `container-type: block-size`. |
| **Jauges WCAG 2.1 AA sans couleur seule** | Widely Available | Natif | Natif | Conserver `role="progressbar"` (`aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-label`), doubler la couleur par icône SVG géométrique distincte (`OK`, `Vigilance >= 80 %`, `Dépassement >= 100 %`) et libellé texte explicite. Contraste minimum `4.5:1` sur les textes (`--warning: #92400e` et `--danger: #b42318` sur `--bg-surface: #ffffff` conformes), `3:1` sur les barres graphiques. Marqueur de rythme du mois (`aria-hidden="true"` + résumé texte). |
| **`font-variant-numeric: tabular-nums`** | Widely Available | Natif (`>= 37`) + `JetBrains Mono` local | Natif | Appliquer `.tabular-amount` sur 100 % des montants Budget prévu, Report Rollover (`+/-`), Consommé et Reste disponible (centimes entiers uniquement). |
| **Popover détail Rollover** (`[popover]`) | Newly / Widely Available (Chrome `114+`, Safari `17+`, Firefox `125+`) | Natif (`>= 114`) | Détection `Object.hasOwn(HTMLElement.prototype, 'popover')` + `@oddbird/popover-polyfill` conditionnel ou `<details>` inline | Bouton déclencheur `>= 44×44 px` affichant le détail du report multi-mois (`Solde reporté M-1 + Enveloppe M - Dépenses M`, sans double-comptage parent/sous-catégorie). Toujours prévoir un bouton `Fermer` visible sur mobile tactile. |

---

### 2.5 Nouveaux graphiques Recharts + Sankey Desktop-only

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **`React.lazy` & garde viewport `>= 1024 px` (Sankey Desktop-only)** | Widely Available (`matchMedia`) | Natif | Natif | Charger le **Sankey** via un chunk `React.lazy` séparé, monté **uniquement** quand `matchMedia('(min-width: 1024px)').matches === true`. Ainsi, l'APK Android sur smartphone (`< 1024 px`) ne télécharge ni n'exécute le code SVG Sankey et affiche le **fallback mobile en barres horizontales empilées / liste proportionnelle**. |
| **`aspect-ratio` + `min-block-size` anti-CLS** | Widely Available (Chrome `88+`, Safari `15+`, Firefox `89+`) | Natif (`>= 88`) | `min-block-size` seul | Harmoniser `.cf-chart-frame` et le `<ChartsSkeleton />` de `Suspense` avec la hauteur réelle de `ResponsiveContainer` (ex. `block-size: 280px` sur mobile / `300px` sur desktop, ou mesurer sans divergence `aspect-ratio` vs `height`). Ne monter Recharts que lorsque le conteneur est visible pour éviter les erreurs `width(-1)/height(-1)` de `ResizeObserver` dans Android WebView. |
| **`isAnimationActive={!prefersReducedMotion}`** | Widely Available | Natif (`>= 74`) | Natif | Obligatoire sur **toutes** les séries Recharts v2 : barres horizontales drill-down Catégories, Cash Flow + Taux d'épargne, Projection 3/6/12M avec bande prudent/optimiste, Radar récurrents, et Sankey. |
| **Équivalent tabulaire accessible au clavier** | Widely Available (HTML `<table>`) | Natif | Natif | Chaque graphique doit être accompagné d'un bouton `>= 44 px` (ou `<details><summary className="cf-touch-target">`) révélant un `<table>` sémantique (`<caption>`, `<thead>`, `<th scope="col">`, montants `.tabular-amount`) navigable au clavier (`Tab`) et lisible par lecteur d'écran. |

---

### 2.6 Simulateur « Et si… » & Projections 3 / 6 / 12 mois

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **`<input type="range">` hitbox `>= 44 px`** | Widely Available | Natif (`>= 37`) | Natif | Styliser `.cf-range-input` avec `inline-size: 100%; min-block-size: 44px; cursor: pointer; touch-action: pan-y;` et un curseur (`::-webkit-slider-thumb` / `::-moz-range-thumb`) `>= 28×28 px` (dans une piste tactile de `44 px` de hauteur). **Doubler obligatoirement** chaque curseur par un contrôle précis (`-` / `+` `>= 44×44 px` ou `<input type="number">`) pour l'accessibilité motrice et la saisie exacte au centime/pourcentage près. |
| **`useDeferredValue` + Web Worker dédié** | React 19 + Web Workers Widely Available (`>= 4`) | Natif | Fallback synchrone découpé par `yieldToMain()` si `typeof Worker === 'undefined'` | Le curseur met à jour l'état local immédiatement (`< 16 ms`), tandis que `useDeferredValue` et le **Web Worker** (`apps/web/src/workers/analytics.worker.ts`) recalculent hors thread principal les séries de projection 3/6/12M, la bande prudent/optimiste et les effets multi-mois sur `2 940+` opérations — garantissant **INP `<= 200 ms`** même lors d'un glissement continu sur mobile Android milieu de gamme. |

---

### 2.7 Bilan IA mensuel (clic manuel, cache SQL)

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **`aria-live="polite"`** | Widely Available (ARIA) | Natif | Natif | Annoncer l'état de génération (« Génération du bilan IA mensuel… », « Bilan mensuel prêt », ou message d'erreur / mode hors-ligne) dans la région `aria-live="polite"` unique (ou statut dédié `role="status"` sans duplication d'annonce). Poser `aria-busy="true"` sur le bloc cible pendant l'appel API manuel. |
| **Rendu texte React pur (zéro `dangerouslySetInnerHTML`)** | Widely Available | Natif | Natif | L'API retourne une structure JSON validée par Zod (`sections`, `bullets`, `highlights_cents`, `month`), rendue exclusivement par des composants React natifs (`<h3>`, `<p>`, `<ul><li>`, `<span className="tabular-amount">`). **Interdiction absolue** d'utiliser `dangerouslySetInnerHTML`, `innerHTML` ou un parseur Markdown HTML non échappé (prévention XSS dans Android System WebView). |

---

### 2.8 Grille Calendrier `Budget > Récurrents & Calendrier`

| Critère / Primitive | Statut Baseline & Desktop | WebView Android `>= 114` | Fallback WebView `< 114` | Exigences d'implémentation v2 |
| :--- | :--- | :--- | :--- | :--- |
| **Grille 7 colonnes (Lun→Dim) & Hitboxes `>= 44×44 px` (`412 px` / `320 px`)** | CSS Grid Widely Available (`>= 57`) | Natif | Natif | Sur **Pixel 8 Portrait (`412 px`)**, avec padding conteneur `16 px` (`380 px` utiles) et `gap: 2px` : `(380 - 12) / 7 ≈ 52,5–54 px >= 44 px`. Sur **largeur minimale `320 px`**, réduire le padding horizontal de la surface calendrier à `4 px` (`padding-inline: 4px`, soit `312 px` utiles, `gap: 0` ou `1px` avec bordures `1px`) pour garantir **`312 / 7 = 44,5 px >= 44 px`** par cellule et **zéro débordement horizontal (`overflow-x: clip`)**. |
| **Bascule `@container` 2 colonnes (Desktop `1440×900` & Pixel 8 Paysage `915×412`)** | Widely Available (`>= 105`) | Natif | `@supports not (container-type: inline-size)` avec `@media (min-width: 720px)` | Encapsuler la vue dans `container: recurring-cal / inline-size`. Dès `@container recurring-cal (min-width: 720px)` (actif en **Desktop `1440×900`** et **Pixel 8 Paysage `915×412`** où la zone utile après rail `76 px` est `~807 px`), basculer sur **2 colonnes côte à côte** : calendrier 7 jours à gauche + liste chronologique des échéances à droite (`0 %` sticky vertical, absorption des 4 `env(safe-area-inset-*)` en `90°`/`270°`). Sous `720 px` (Pixel 8 Portrait `412×915` et `320×568`), empiler calendrier au-dessus de la liste. |
| **Indicateurs WCAG 2.1 AA sans couleur seule** | Widely Available | Natif | Natif | Doubler chaque statut d'échéance par un libellé texte explicite + icône/symbole distinct (`Prélevé`, `À venir`, `Revenu`, `Hausse +XX %`, `Ajout manuel`, `Résilié`) avec contraste `>= 4.5:1` et montants `.tabular-amount`. |
| **Navigation clavier cellules jours (`<button type="button">`)** | Widely Available (HTML natif) | Natif | Natif | Chaque jour du mois est un `<button type="button">` (`min-block-size: 44px; min-inline-size: 44px;`) portant `aria-pressed={isSelected}` et un `aria-label` explicite incluant date, nombre d'échéances et total (ex. `aria-label="15 novembre — 2 échéances, 940,00 EUR"`). Bouton « Tout le mois » `>= 44×44 px` pour réinitialiser le filtre journalier. |
| **Modale `+ Ajouter une échéance` (`<dialog>.showModal()`)** | Widely Available (`>= 37`) + `:user-valid` / `:user-invalid` (`>= 119`) + `:has()` (`>= 105`) | Natif (`:user-invalid` `>= 119`) | `.user-invalid-fallback` + `.has-error-fallback` (`< 119` / `< 105`) + fallback `closedby` (`< 134`) | Ouvrir via `<dialog>.showModal()` en **bottom sheet** en Portrait (`412×915`) et en **panneau latéral droit** en Desktop (`1440×900`) et Pixel 8 Paysage (`915×412`), avec `overscroll-behavior: contain`, validation post-interaction `:user-valid` / `:user-invalid`, `.cf-field-group:has(...)` strictement borné, et reset `dialog.returnValue = ''` à la fermeture. |

---

## 3. Budget Core Web Vitals & Impact Taille Bundle APK Capacitor

### 3.1 Respect des budgets Core Web Vitals

| Métrique | Cible ClairFlux | Risques introduits par la v2 | Mesures d'architecture obligatoires |
| :--- | :--- | :--- | :--- |
| **LCP** | **`<= 2.5 s`** Web<br>**`< 1.2 s`** Offline Android | Augmentation du JS initial si les modules Budget, Catégories, Révision IA, Sankey et Simulateur sont importés statiquement dans `main.tsx`. | 1. **Code-splitting strict par onglet/écran** : garder `BudgetTab`, `CategoriesManagerDialog`, `AiReviewPanel`, `AnalyticsCharts`, `SankeyDesktopChart` et `SimulatorSection` en `React.lazy` avec squelettes dimensionnés.<br>2. **Zéro réseau bloquant au boot** : rendu immédiat du shell + cache IndexedDB (`clairflux_offline_v1`) dès le premier frame.<br>3. **Preload ciblé des polices locales critiques** (`Plus Jakarta Sans 700` et `DM Sans 400/600` `.woff2`) et maintien de la CSS critique dans `index.html`. |
| **INP** | **`<= 200 ms`** (impératif) | 1. Filtrage/agrégats sur `2 940+` opérations et multi-catégories à 2 niveaux.<br>2. Glissement continu des curseurs « Et si… » re-rendant Recharts.<br>3. Boîte de révision IA avec centaines de lignes et sélecteurs CSS. | 1. **Web Worker dédié** (`analytics.worker.ts`) pour rollovers multi-mois, agrégats Catégories/Sous-catégories, détection récurrents et projections 3/6/12M.<br>2. **`useDeferredValue`** entre curseurs du simulateur / recherche et re-rendus Recharts.<br>3. **`yieldToMain()`** (deadline `50 ms`) sur toute boucle client résiduelle.<br>4. **`:has()` strictement borné** à `.cf-field-group` + `content-visibility: auto` sur les listes sous le fold. |
| **CLS** | **`<= 0.1`** (`<= 0.02` visé) | 1. Arrivée asynchrone des nouveaux graphiques Recharts / Sankey.<br>2. Apparition des messages d'erreur de validation ou du Bilan IA.<br>3. Défilement de listes longues avec `content-visibility: auto`. | 1. **`ChartsSkeleton` aligné au pixel près** sur la hauteur réelle des conteneurs Recharts (`min-block-size` cohérent avec `ResponsiveContainer height`).<br>2. **`contain-intrinsic-size: auto <hauteur>`** obligatoire sur toute ligne `.cf-tx-row-deferred` ou item de révision IA.<br>3. **`.tabular-amount`** sur tous les montants, taux d'épargne et curseurs dynamiques.<br>4. **`scrollbar-gutter: stable`** sur les conteneurs scrollables Desktop. |

### 3.2 Impact estimé sur le bundle Vite (`apps/web/dist/`) et l'APK Capacitor

L'architecture `vite.config.ts` existante isole déjà `vendor-react`, `vendor-d3` et `vendor-recharts` et exclut les sourcemaps (`sourcemap: false`) et secrets serveur (`guardNoServerSecretsPlugin`).

| Composant / Dépendance v2 | Impact estimé sur `dist/` (gzip) | Impact sur l'APK Android & Recommandation |
| :--- | :--- | :--- |
| **Vues & logique v2** (`BudgetTab`, `CategoriesDialog`, `AiReview`, `Simulator`, `MonthlyBrief`) | `+20 à +35 Ko` (répartis en chunks `React.lazy`) | **Impact négligeable** sur l'APK (~`+40 Ko` non compressés) et nul sur le TTI/LCP initial grâce au `React.lazy`. |
| **Nouveaux graphiques Recharts + Sankey Desktop-only** | `+0` dépendance npm (`recharts` `^2.15.3` et `d3-*` déjà bundlés), `+8 à +15 Ko` de code wrapper en chunks séparés | Le **Sankey** est isolé dans son propre chunk dynamique jamais chargé sous `< 1024 px` : **0 ms de parse JS ajouté sur smartphone Android**. |
| **Web Worker analytique** (`analytics.worker.ts`) | `+5 à +10 Ko` (chunk worker séparé) | Chargé en arrière-plan hors thread UI ; améliore l'INP sur Android sans pénaliser le LCP. |
| **Polyfills conditionnels** (`@oddbird/popover-polyfill` si WebView `< 114`) | `~10 à 15 Ko` en chunk séparé *conditionnel* | Jamais exécuté ni chargé sur Android WebView `>= 114` ; coût APK négligeable (`< 0,5 %` d'un APK Capacitor ~`5–8 Mo`). Éviter `invokers-polyfill` en conservant les handlers React sur `<button type="button">`. |
| **Polices `.woff2` `@fontsource/*`** (existant) | `~180–300 Ko` (déjà inclus en v1) | Vérifier lors du build Vite que seuls les sous-ensembles `latin` utilisés sont émis dans `dist/assets/` (surveiller toute inflation due aux subsets `latin-ext`/`vietnamese` non nécessaires). |
| **Android 15 Edge-to-Edge & Clavier (`SDK 35`)** | `0 Ko` | Configurer proprement le comportement clavier (`adjustResize` / `interactive-widget=resizes-content` et safe-area) et fixer `webContentsDebuggingEnabled: false` en build release dans `capacitor.config.ts` / manifeste Android lors de la phase d'implémentation. |

---

## 4. Checklist d'audit automatisable pour `scripts/run-audit-bot.mjs`

Sans modifier [scripts/run-audit-bot.mjs](file:///d:/Applications/Clairflux/scripts/run-audit-bot.mjs) durant la phase Pré-Code, les vérifications déterministes suivantes devront être intégrées aux Points 2, 3 et 1/5 du bot lors de l'implémentation v2 :

### 4.1 Ajouts proposés au Point 2 — Standards Chrome Baseline

1. **Détection de capacité Popover & zéro polyfill inconditionnel** :
   - Vérifier que tout usage de `popover=` dans `apps/web/src/` s'accompagne d'une détection `Object.hasOwn(HTMLElement.prototype, 'popover')` ou `'popover' in HTMLElement.prototype`.
   - Vérifier l'absence d'import statique de `@oddbird/popover-polyfill` ou `invokers-polyfill` (seul `import(...)` conditionnel autorisé).
   - Vérifier qu'aucun élément ne combine `popovertarget` et `commandfor` sur le même `<button>`.
2. **Modales `<dialog>` & `closedby`** :
   - Vérifier l'absence de `role="dialog"` ou `aria-modal` sur tout `<dialog` dans `apps/web/src/`.
   - Vérifier la présence de `dialog.returnValue = ''` (reset après fermeture) et d'un fallback bounding-rect si `closedby="any"` est utilisé.
3. **Sélecteur `:has()` et `@container`** :
   - Vérifier l'absence de `body:has(` ou `:root:has(` dans `index.html` et tous les fichiers CSS/TSX.
   - Vérifier l'absence de `container-type: block-size` ou `container-type: size` non justifié (seul `inline-size` autorisé).
4. **Rendu différé & Unités viewport** :
   - Vérifier que chaque occurrence de `content-visibility: auto` est associée à `contain-intrinsic-size`.
   - Vérifier l'absence stricte de `100vh` et `100vw` dans `apps/web/index.html` et `apps/web/src/`.
5. **Performance INP & Sécurité rendu IA** :
   - Vérifier l'existence d'un Web Worker dans `apps/web/src/workers/` et l'utilisation active de `yieldToMain` (hors simple définition).
   - Vérifier l'absence absolue de `dangerouslySetInnerHTML` et `.innerHTML` dans `apps/web/src/` (garantie XSS pour le Bilan IA mensuel).
6. **Sankey Desktop-only & Reduced Motion Recharts** :
   - Vérifier que le composant Sankey est importé en `React.lazy` et gardé par `(min-width: 1024px)`.
   - Vérifier que chaque graphique Recharts (`AreaChart`, `BarChart`, `ComposedChart`, `Sankey`) passe `isAnimationActive={!prefersReducedMotion}`.

### 4.2 Ajouts proposés au Point 3 — Ergonomie Mobbin / Google Stitch, Pixel 8 & Accessibilité

1. **Barre basse mobile à 4 onglets & Plafond sticky `<= 15 %`** :
   - Vérifier `.cf-bottom-nav` avec `grid-template-columns: repeat(4, minmax(0, 1fr))` et `--mobile-nav-height <= 64px` (`<= 15 %` sur `844 px`, `915 px` Pixel 8 et `568 px`).
   - Vérifier qu'aucun autre sélecteur CSS actif sous `< 1024 px` n'utilise `position: sticky` ou `position: fixed` (hors `<dialog>` / `[popover]`).
2. **Adaptation Pixel 8 Paysage (`915×412`), Display Cutout & Clavier virtuel** :
   - Vérifier la présence de `interactive-widget=resizes-content` dans `<meta name="viewport">` de `apps/web/index.html`.
   - Vérifier la présence de `@media (orientation: landscape) and (max-height: 500px)` masquant `.cf-bottom-nav` (`display: none`), activant le rail gauche compact (`76px` + `env(safe-area-inset-left)`) à `0 %` de sticky vertical, et basculant `dialog.cf-dialog:modal` en panneau latéral droit.
   - Vérifier la prise en charge des **4** `env(safe-area-inset-top)`, `env(safe-area-inset-right)`, `env(safe-area-inset-bottom)` et `env(safe-area-inset-left)` dans `apps/web/index.html`.
3. **Configuration native Capacitor 7 & `scripts/build-apk.sh` (SDK 35 / Pixel 8)** :
   - Vérifier dans `apps/web/capacitor.config.ts` la présence de `adjustMarginsForEdgeToEdge: 'auto'` et `webContentsDebuggingEnabled: false`.
   - Vérifier dans `scripts/build-apk.sh` la présence du patch natif post-`cap sync` imposant `screenOrientation="fullUser"`, `configChanges` anti-rechargement à la rotation, `windowSoftInputMode="adjustResize"`, `windowLayoutInDisplayCutoutMode` à `shortEdges`, `windowLightStatusBar` et `windowLightNavigationBar`.
4. **Cohérence routage focus 4 onglets** :
   - Extraire les clés de `HEADING_BY_TAB` dans `main.tsx` et vérifier que chaque identifiant de heading (`overview-heading`, `budget-heading`, `ledger-heading`, `sync-heading`) existe exactement dans les composants cibles.
5. **Hitboxes Simulateur, Calendrier Récurrents & Équivalents tabulaires** :
   - Vérifier que tout `<input type="range">` porte une classe CSS imposant `min-block-size: 44px` et `touch-action: pan-y`.
   - Vérifier que la grille calendrier 7 colonnes (`Budget > Récurrents & Calendrier`) impose des cellules `<button type="button">` avec `min-block-size: 44px`, un padding réduit à `<= 4 px` sous `320–360 px` pour préserver `>= 44 px` par colonne sans débordement horizontal (`overflow-x: clip`), `aria-pressed` + `aria-label` explicite et des statuts doublés texte + icône sans couleur seule.
   - Vérifier la présence d'un équivalent `<table>` accessible dans les nouveaux modules analytiques et d'icônes + textes explicites sur les jauges Budget + Rollover.

### 4.3 Ajouts proposés aux Points 1 & 5 — Bundle APK & Zéro régression Offline

1. **Zéro CDN / URL externe** : étendre le scan `apps/web/dist/` pour interdire toute occurrence de `fonts.googleapis.com`, `fonts.gstatic.com` ou `esm.run`.
2. **Budget taille `dist/`** : vérifier que le chunk d'entrée JS initial reste sous un seuil d'alerte (ex. `<= 180 Ko` brut / `<= 65 Ko` gzip hors `vendor-react`) et que le chunk Sankey reste séparé du chunk principal.

---

## 5. Optimisation Google Pixel 8 (Portrait `412×915` & Paysage `915×412`, Display Cutout, Android 15 SDK 35 Edge-to-Edge)

Profil matériel de référence : **Google Pixel 8** — dalle `1080×2400 px` (ratio `20:9`, densité `2.625`, soit **`412×915 CSS px`** en portrait et **`915×412 CSS px`** en paysage), poinçon caméra centré en haut en portrait, exécutant **Android 15 (`targetSdk 35`)** avec Edge-to-Edge activé par défaut.

### 5.1 Mode Portrait (`412×915 CSS px`)

| Aspect | Spécification normative v2 | Justification Baseline & Ergonomie |
| :--- | :--- | :--- |
| **Barre de navigation basse (4 onglets)** | `block-size: calc(64px + env(safe-area-inset-bottom, 0px))` | Avec une barre gestuelle Android de ~`24 px`, la hauteur totale est ~`88 px`, soit **`88 / 915 = 9,6 % <= 15 %`** (même avec `34 px` de barre système : `98 / 915 = 10,7 % <= 15 %`). Chaque onglet dispose de `103 px × 64 px` (`>= 44×44 px`). |
| **En-tête & Poinçon caméra haut** | En-tête scrollable dans `.cf-main` avec `padding-block-start: calc(16px + env(safe-area-inset-top, 0px))` | Absorbe dynamiquement la zone du poinçon centré haut (~`24–48 px` sous Edge-to-Edge SDK 35) sans ajouter aucun bloc `sticky` supérieur. |
| **Modales & Tiroirs (`<dialog>`)** | Bottom sheet ancré en bas (`max-block-size: 85dvh`, `padding-block-end: calc(20px + env(safe-area-inset-bottom, 0px))`, `overscroll-behavior: contain`) | Adapté à la préhension à une main sur écran `20:9` de `915 px` de haut ; `85dvh` préserve la lisibilité du contexte supérieur. |
| **Clavier virtuel (`<meta name="viewport">`)** | `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />` | `interactive-widget=resizes-content` (natif Chromium Android WebView `>= 108`, donc acquis sur `>= 114`) redimensionne le viewport layout (`100dvh`) à l'ouverture du clavier virtuel afin que les champs de saisie (notes, catégories, simulateur numérique) et boutons de soumission ne soient pas masqués. |

### 5.2 Mode Paysage (`915×412 CSS px` — Rotation 90° et 270°)

En orientation paysage sur Pixel 8 (`412 px` de hauteur totale), conserver la barre basse fixe (`64 px + ~20 px` = `84 px`, soit `84 / 412 = 20,4 % > 15 %`) dépasserait le plafond sticky et écraserait la zone utile de lecture.

1. **Bascule vers un rail latéral gauche compact (`@media (orientation: landscape) and (max-height: 500px)`)** :
   - Masquer la barre basse : `.cf-bottom-nav { display: none; }`.
   - Afficher le rail latéral gauche compact : `inline-size: calc(76px + env(safe-area-inset-left, 0px))`, `padding-inline-start: env(safe-area-inset-left, 0px)`, `block-size: 100dvh`, `position: sticky; inset-block-start: 0;` (largeur fixe latérale = **`0 %` de sticky vertical**).
   - Les 4 onglets du rail compact conservent des cibles tactiles **`>= 44×44 px`** (`min-block-size: 44px; min-inline-size: 44px;`), avec icône + libellé court empilé ou centré verticalement.
2. **Absorption stricte des 4 zones sûres (`env(safe-area-inset-*)`) pour rotations 90° et 270°** :
   - **Rotation 90° (poinçon caméra à gauche)** : `env(safe-area-inset-left)` est absorbé par le rail compact (`76px + safe-area-left`), empêchant le poinçon de recouvrir les icônes des 4 onglets.
   - **Rotation 270° (poinçon caméra à droite)** : `.cf-main` applique `padding-inline-end: calc(16px + env(safe-area-inset-right, 0px))` et `padding-inline-start: calc(16px + env(safe-area-inset-left, 0px))` (ou `16px` après le rail), garantissant que ni le poinçon à droite ni la barre gestuelle en bas (`padding-block-end: calc(16px + env(safe-area-inset-bottom, 0px))`) ne tronquent les montants `tabular-nums` alignés à droite.
   - En haut, `padding-block-start: calc(12px + env(safe-area-inset-top, 0px))` absorbe la barre de statut.
3. **Adaptation des grilles, graphiques et modales en paysage (`915×412`)** :
   - **KPIs** : 4 colonnes compactes sur une rangée (`@container kpis (min-width: 560px)` ou règle paysage dédiée sur `4` colonnes dès `>= 720 px` de conteneur).
   - **Graphiques Recharts** : 2 graphiques côte à côte (`@container charts (min-width: 720px)` ; largeur utile `915 - 76 - 32 = ~807 px >= 720 px`), avec hauteur réduite adaptée (`~220–240 px`) pour garder un graphique lisible dans `412 px` de hauteur.
   - **Sankey Desktop-only** : **toujours exclu** en paysage mobile (`915 px < 1024 px`), conservant automatiquement le **fallback mobile en barres horizontales empilées** pour éviter toute illisibilité verticale sur `412 px` de haut.
   - **Calendrier `Budget > Récurrents & Calendrier`** : en **Paysage (`915×412`)**, le conteneur `@container recurring-cal (min-width: 720px)` affiche le calendrier 7 jours à gauche et la liste chronologique à droite côte à côte (`0 %` sticky vertical, 4 `env(safe-area-inset-*)` absorbées en `90°`/`270°`) ; en **Portrait (`412×915`)**, le calendrier s'empile au-dessus de la liste avec cellules `~54 px >= 44 px` (et `312 / 7 = 44,5 px >= 44 px` à `320 px`).
   - **Modales & Tiroirs (`<dialog>`)** : sous `@media (orientation: landscape) and (max-height: 500px)`, basculer `.cf-dialog:modal` en **panneau latéral droit** (`inset-block: 0; inset-inline-end: 0; inline-size: min(420px, 100dvw); block-size: 100dvh; padding-inline-end: calc(20px + env(safe-area-inset-right, 0px));`) au lieu du bottom sheet (valable également pour la modale `+ Ajouter une échéance`).

### 5.3 Spécification native Capacitor 7 & Android SDK 35 (`capacitor.config.ts` & `scripts/build-apk.sh`)

Dans le dépôt ClairFlux, [scripts/build-apk.sh](file:///d:/Applications/Clairflux/scripts/build-apk.sh) génère le répertoire `apps/web/android/` dynamiquement via `npx --no-install cap add android` puis `cap sync android` (L128-134). La configuration native Pixel 8 / Android 15 doit donc être portée conjointement par [capacitor.config.ts](file:///d:/Applications/Clairflux/apps/web/capacitor.config.ts) et un patch idempotent dans `scripts/build-apk.sh` avant `./gradlew assembleRelease` :

1. **`apps/web/capacitor.config.ts`** :
   - `android.adjustMarginsForEdgeToEdge: 'auto'` (Capacitor 7) : gère proprement les marges Edge-to-Edge imposées par `ANDROID_COMPILE_SDK=35` sans écraser les `env(safe-area-inset-*)` sur les vues plein écran.
   - `android.webContentsDebuggingEnabled: false` explicite pour les builds release (durcissement sécurité bancaire).
   - Conserver `server.androidScheme: 'https'`, `android.allowMixedContent: false`, `android.captureInput: true`.
2. **`scripts/build-apk.sh` — Patch `AndroidManifest.xml` (sur `<activity>` principal `MainActivity`)** :
   - `android:screenOrientation="fullUser"` : autorise portrait (`0°`), paysage gauche (`90°`) et paysage droite (`270°`) selon le réglage utilisateur.
   - `android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"` : empêche la destruction de l'`Activity` et le rechargement à froid de la WebView lors d'une rotation Pixel 8 (préserve l'état React, les `<dialog>` ouverts et les calculs du simulateur en cours).
   - `android:windowSoftInputMode="adjustResize"` : garantit le redimensionnement du conteneur WebView à l'ouverture du clavier virtuel en complément de `interactive-widget=resizes-content`.
3. **`scripts/build-apk.sh` — Patch `res/values/styles.xml` (thème AppCompat / Capacitor)** :
   - `android:windowLayoutInDisplayCutoutMode="shortEdges"` : étend le rendu WebView dans la zone du poinçon caméra Pixel 8 (portrait et paysage 90°/270°) afin que les 4 `env(safe-area-inset-*)` exposent exactement la géométrie du cutout.
   - Barres système claires assorties au canvas ClairFlux (`#f7f6f2`) :
     - `<item name="android:windowLightStatusBar">true</item>`
     - `<item name="android:windowLightNavigationBar">true</item>`
     - `<item name="android:statusBarColor">@android:color/transparent</item>` / fonds clairs compatibles pré-SDK 35 (`#f7f6f2`).

### 5.4 Récapitulatif des contrôles automatisables associés (`scripts/run-audit-bot.mjs`)

Les assertions listées en **§4.2 (points 2 et 3)** couvrent intégralement cette spécification Pixel 8 lors de l'implémentation applicative :
- Détection dans `apps/web/index.html` de `interactive-widget=resizes-content`, de `@media (orientation: landscape) and (max-height: 500px)`, du rail compact `76px` + `env(safe-area-inset-left)`, du panneau droit `<dialog>` en paysage et des **4** `env(safe-area-inset-top/right/bottom/left)`.
- Détection dans `apps/web/capacitor.config.ts` de `adjustMarginsForEdgeToEdge` et `webContentsDebuggingEnabled: false`.
- Détection dans `scripts/build-apk.sh` des directives `fullUser`, `configChanges`, `adjustResize`, `shortEdges`, `windowLightStatusBar` et `windowLightNavigationBar`.
