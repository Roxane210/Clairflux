---
name: modern-web-guidance
description: |
  Norme officielle GoogleChrome/modern-web-guidance-src adaptée à ClairFlux (Desktop Chrome/Safari/Firefox + Android System WebView Capacitor).
  OBLIGATOIRE : Consulter AVANT toute conception ou modification HTML/CSS/UI/DOM/Performance client.
  Couvre : Baseline Web features, <dialog> natif, Popover API, CSS Container Queries (@container), :has(), :user-valid/:user-invalid, View Transitions API, content-visibility: auto, et Core Web Vitals (LCP, INP <= 200ms).
---

# Modern Web Guidance — ClairFlux Edition

Source officielle intégrée depuis `https://github.com/GoogleChrome/modern-web-guidance-src` (`guides/` locaux disponibles dans `.agent/skills/modern-web-guidance/guides/`).

## Politique Navigateurs & Android System WebView (ClairFlux Baseline)

ClairFlux cible simultanément :
1. **Desktop moderne** : Chrome, Safari, Firefox (Baseline Widely Available + Newly Available avec détection de fonctionnalité).
2. **Mobile Android (Capacitor APK)** : Android System WebView (Chromium Evergreen sur Android 10+, avec dégradation gracieuse si WebView antérieure).

Consulter impérativement [BASELINE_CLAIRFLUX.md](./BASELINE_CLAIRFLUX.md) pour la matrice de compatibilité et les fallbacks obligatoires.

## Règles Impératives d'Exécution UI / CSS / DOM

1. **Modales et tiroirs natifs (`<dialog>` + Popover API)** :
   - Utiliser `<dialog>` avec `.showModal()` (ou `command="show-modal"` / `commandfor`) pour toute modale bloquante (confirmation, édition, détail). Ne **jamais** réinventer un focus-trap JS manuel ni ajouter `role="dialog"` / `aria-modal` redondants sur un `<dialog>` modal.
   - Verrouiller le scroll d'arrière-plan via `dialog:modal { overscroll-behavior: contain; }` et `dialog::backdrop { overflow: hidden; overscroll-behavior: contain; }` — **jamais** `overflow: hidden` ou `position: fixed` sur `html`/`body`.
   - Utiliser `popover` (`auto` ou `manual`) pour les menus contextuels, info-bulles et filtres flottants (top layer natif, zéro `z-index` artisanal). Détecter `'popover' in HTMLElement.prototype` si fallback requis.
   - Référence locale : `guides/ui-components/dialog/guide.md`, `guides/ui-behaviors/declarative-dialog-popover-control/guide.md`.

2. **Composants adaptatifs (`@container`)** :
   - Utiliser `container-type: inline-size` (ou `container: <name> / inline-size`) et `@container` pour adapter cartes, lignes de relevés et graphiques à leur conteneur réel (sidebar vs plein écran vs Android 390px), plutôt que de multiplier les `@media` viewport.
   - Préférer les unités viewport dynamiques (`100dvh`, `100dvw`) à `100vh`/`100vw` sur mobile Android WebView pour éviter les décalages liés aux barres système.
   - Référence locale : `guides/css/size-aware-styling/guide.md`, `guides/css/css-layout/guide.md`, `guides/css/responsive-design/guide.md`.

3. **Sélecteurs parent & validation post-interaction (`:has()`, `:user-valid`, `:user-invalid`)** :
   - Utiliser `:has()` ciblé sur un conteneur borné (ex. `.field-group:has(:user-invalid)`) pour refléter l'état d'un champ sur son parent sans classes JS redondantes.
   - Utiliser `:user-valid` et `:user-invalid` pour n'afficher les erreurs de formulaire (règles de catégorisation, saisie de notes, filtres) qu'après interaction/blur ou soumission, en synchronisant `aria-invalid` et un texte d'erreur explicite.
   - Référence locale : `guides/css/style-parent-with-has/guide.md`, `guides/forms/validate-input-after-interaction/guide.md`.

4. **Transitions fluides (`View Transitions API`)** :
   - Utiliser `document.startViewTransition(() => updateDOM())` avec garde `if (!document.startViewTransition)` et respect strict de `@media (prefers-reduced-motion: reduce)`.
   - Vérifier l'unicité de `view-transition-name` et gérer le routage du focus après `transition.finished` pour l'accessibilité.
   - Référence locale : `guides/ui-behaviors/same-document-transitions/guide.md`.

5. **Virtualisation & rendu différé (`content-visibility: auto`)** :
   - Appliquer `content-visibility: auto` + `contain-intrinsic-size: auto <hauteur-estimée>` uniquement sur les longues listes sous la ligne de flottaison (ex. grand livre de transactions bancaires, historique d'imports Drive), **jamais** au-dessus du fold.
   - Référence locale : `guides/performance/defer-rendering-heavy-content/guide.md`.

6. **Core Web Vitals (LCP <= 2.5s, CLS <= 0.1, INP <= 200ms)** :
   - Budget INP strict **<= 200ms** (toute tâche JS > 50ms doit céder le thread principal via `scheduler.yield()` avec fallback `setTimeout(..., 0)` ou être déportée en Web Worker).
   - Aucun layout thrashing (grouper lectures DOM puis écritures DOM), `scrollbar-gutter: stable` sur listes scrollables, dimensions explicites / `aspect-ratio` sur médias et conteneurs de graphiques Recharts.
   - Référence locale : `guides/performance/performance/guide.md`, `guides/performance/identify-inp-causes/guide.md`, `guides/performance/break-up-long-tasks/guide.md`.

## Workflow de consultation

1. Lire d'abord le guide local correspondant dans `.agent/skills/modern-web-guidance/guides/`.
2. En complément (si réseau autorisé), interroger le corpus amont via `npx -y modern-web-guidance@latest search "<requête>"` et `retrieve "<id>"`.
3. Vérifier la compatibilité Baseline et Android System WebView dans [BASELINE_CLAIRFLUX.md](./BASELINE_CLAIRFLUX.md).
4. Ne jamais importer un polyfill inconditionnellement : toujours détecter la capacité native (`CSS.supports`, `'commandForElement' in HTMLButtonElement.prototype`, `Object.hasOwn(HTMLElement.prototype, 'popover')`, `document.startViewTransition`).
