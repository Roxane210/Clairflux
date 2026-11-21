# Matrice Baseline & Compatibilité ClairFlux (Desktop + Android WebView)

Ce document fixe les règles de compatibilité navigateur issues de `GoogleChrome/modern-web-guidance-src` pour **ClairFlux** (Chrome, Safari, Firefox récents + **Android System WebView** embarquée par Capacitor).

## 1. Fonctionnalités Baseline exigées & Statut

| Fonctionnalité | Statut Baseline | Support WebView Android (Capacitor) | Règle d'usage & Fallback obligatoire |
| :--- | :--- | :--- | :--- |
| `<dialog>` + `showModal()` + `::backdrop` | Baseline Widely Available | Chromium WebView >= 37 (natif) | **Obligatoire** pour toutes les modales. Ajouter `overscroll-behavior: contain` sur `dialog:modal` et `dialog::backdrop`. |
| `<dialog closedby="...">` | Newly / Progressif | Chromium >= 134 | Dégradation gracieuse (`Esc` / bouton retour Android déjà actifs) ; ajouter le listener `pointerdown`/`pointerup` si `closedby="any"` requis sans support natif (`!('closedBy' in HTMLDialogElement.prototype)`). |
| Popover API (`[popover]`, `popovertarget`) | Baseline Newly/Widely | Chromium >= 114 | Utiliser pour menus/info-bulles légères. Si cible Android WebView < 114 possible, importer `@oddbird/popover-polyfill` uniquement si `!Object.hasOwn(HTMLElement.prototype, 'popover')`. |
| Invoker Commands (`command`, `commandfor`) | Progressif | Chromium >= 135 | Garder le markup déclaratif avec `type="button"` ; charger `invokers-polyfill` conditionnellement si `!('commandForElement' in HTMLButtonElement.prototype)` ou doubler avec handler React propre. |
| CSS Container Queries (`@container`, `inline-size`) | Baseline Widely Available | Chromium >= 105 | **Obligatoire** pour composants adaptatifs. Définir `container-type: inline-size` (ou shorthand `container: nom / inline-size`) et ne jamais utiliser `block-size` comme `container-type`. |
| Sélecteur `:has()` | Baseline Widely Available | Chromium >= 105 | **Autorisé et encouragé**, toujours borné à un conteneur précis (`.field-group:has(...)`, jamais `body:has(...)`) pour préserver l'INP. |
| `:user-valid` / `:user-invalid` | Baseline Newly Available | Chromium >= 119 | Utiliser avec `:is(:user-invalid, .user-invalid-fallback)` et synchroniser `aria-invalid` + `aria-describedby` en JS. |
| View Transitions API (`startViewTransition`) | Same-document Baseline | Chromium >= 111 | Toujours tester `if (!document.startViewTransition)` et désactiver via `@media (prefers-reduced-motion: reduce)`. Nettoyer `view-transition-name` après `finished`. |
| `content-visibility: auto` | Baseline Newly Available | Chromium >= 85 | Toujours coupler avec `contain-intrinsic-size: auto <hauteur>` ; interdit au-dessus du fold. |
| `scheduler.yield()` | Progressif | Chromium >= 129 | Wrapper obligatoire `yieldToMain()` testant `'scheduler' in window && 'yield' in scheduler`, fallback `setTimeout(resolve, 0)`. |
| Unités viewport dynamiques (`dvh`, `dvw`) | Baseline Widely Available | Chromium >= 108 | Préférer `100dvh` à `100vh` sur mobile/Capacitor ; éviter `100vw` (préférer `100%` ou `100dvw`). |

## 2. Objectifs Core Web Vitals ClairFlux

- **LCP (Largest Contentful Paint)** : `<= 2.5s` (et `< 1.2s` en mode Offline-First local sur Android). Polices préchargées (`<link rel="preload" as="font" crossorigin>`), zéro `@import` CSS bloquant, code-splitting des vues secondaires et graphiques lourds.
- **INP (Interaction to Next Paint)** : **`<= 200ms` impératif**.
  - Toute opération de filtrage/tri sur > 500 transactions ou calcul d'agrégats doit soit tourner dans un Web Worker, soit découper les itérations avec `yieldToMain()` toutes les <= 50ms.
  - Aucune lecture géométrique (`getBoundingClientRect`, `offsetHeight`) entrelacée avec des mutations DOM.
- **CLS (Cumulative Layout Shift)** : `<= 0.1` (`<= 0.02` visé). Dimensions réservées sur graphiques Recharts (`min-height` / `aspect-ratio`), `contain-intrinsic-size` avec `content-visibility: auto`, `scrollbar-gutter: stable`, `font-variant-numeric: tabular-nums` pour éviter le tremblement horizontal des chiffres.

## 3. Spécificités Android System WebView (Capacitor)

- Respecter `env(safe-area-inset-top)` et `env(safe-area-inset-bottom)` pour les encoches et barres système Android (inclus dans le calcul du plafond sticky mobile <= 15%).
- Désactiver les appels réseau bloquants au démarrage : l'application shell doit rendre immédiatement depuis le bundle local Capacitor + cache offline.
- Tester tout polyfill ou CSS moderne sur Chromium WebView cible (minimum recommandé : Android System WebView >= 114, fallback propre si < 114).
