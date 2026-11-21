---
name: frontend-ui-engineering
description: Architecture de composants React production-grade pour ClairFlux. Impose WCAG 2.1 AA, typographie Plus Jakarta Sans + DM Sans + JetBrains Mono (tabular-nums), élévation unique (zéro cartes imbriquées, zéro pills statiques), cibles tactiles >= 44×44px, plafond sticky mobile <= 15 %, graphiques Recharts (Solde cumulé 6M + Dépenses M-1 / Moyenne 3M) et standards Baseline modern-web-guidance.
---

# Frontend UI Engineering — Contrats Production ClairFlux

## Prérequis Obligatoire

Avant d'écrire tout composant UI, vérifier :
1. La validation du prototype Mock-First (`prototype`) et des normes (`swarm-egm-engineering`).
2. Les guides Baseline applicables dans `.agent/skills/modern-web-guidance/SKILL.md` (`<dialog>`, `popover`, `@container`, `:has()`, `:user-valid`, `View Transitions`, `content-visibility: auto`, `INP <= 200ms`).

---

## 1. Identité Typographique & Hiérarchie Numérique

- **Titres (`h1`, `h2`, `h3`, KPIs de tête)** : `Plus Jakarta Sans` (graisses 600/700, `text-wrap: balance`).
- **Corps de texte, libellés, formulaires, navigation** : `DM Sans` (graisses 400/500/600, taille minimale lisible `14px`/`0.875rem` pour le corps).
- **Données financières (montants, soldes, pourcentages, dates chiffrées, compteurs)** : `JetBrains Mono` avec **`font-variant-numeric: tabular-nums`** obligatoire :
  ```css
  .tabular-amount {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
  }
  ```
- **Préchargement des polices** : `<link rel="preload" as="font" type="font/woff2" crossorigin>` pour les polices critiques au-dessus du fold (ou bundling local pour fonctionnement 100 % Offline-First dans l'APK Capacitor !).

---

## 2. Règles Strictes de Surface, Géométrie & Ergonomie

1. **Élévation unique (Zéro cartes imbriquées)** :
   - Une seule couche de cartes/surfaces posée sur le fond de page (`bg-canvas` → `bg-surface` avec bordure fine `1px solid var(--border-subtle)`).
   - **INTERDIT** de mettre une carte bordée/ombrée à l'intérieur d'une autre carte. Structurer l'intérieur d'une surface par de l'espace (`gap`), la typographie ou un filet séparateur `1px`, jamais par une sous-boîte.
2. **Zéro pills statiques** :
   - Ne pas transformer des informations textuelles passives (nom de banque, type de compte, mois, statut statique) en badges arrondis colorés (« pills ») qui saturent la lecture et ressemblent à des boutons.
   - Réserver les formes pilules uniquement aux **contrôles interactifs réels** (filtres cliquables, segments actifs) avec cible tactile conforme.
3. **Cibles tactiles >= 44×44px** :
   - Tout `<button>`, `<a>`, checkbox/switch, déclencheur de note, item de menu ou point de navigation mobile doit avoir une hitbox minimale de `44×44px` (`min-block-size: 44px; min-inline-size: 44px;`). Si l'icône fait `20px`, étendre la zone cliquable par padding ou pseudo-élément.
4. **Plafond sticky mobile <= 15 %** :
   - Sur viewport mobile (`390×844` et plus généralement `< 768px`), la hauteur cumulée de tous les éléments `position: sticky` ou `position: fixed` visibles simultanément (en-tête fixe + barre d'onglets basse + éventuelle barre de filtre) ne doit **jamais dépasser 15 % de la hauteur du viewport** (`<= 126px` sur `844px`).
   - Privilégier des en-têtes qui scrollent avec la page et ne fixer que l'essentiel (ex. barre de navigation basse compacte `56px` + safe-area).
5. **Zéro débordement horizontal mobile** :
   - Tester systématiquement à `320px` et `390px`. Tableaux Desktop convertis en lignes adaptatives via `@container` queries (`container-type: inline-size`) — jamais de tableau large qui force un scroll horizontal de page.

---

## 3. Graphiques Recharts Obligatoires ClairFlux

Les deux visualisations cœur doivent utiliser **Recharts** dans des conteneurs dimensionnés explicitement (pour prévenir tout CLS et bug de redimensionnement WebView) :

1. **Solde cumulé 6M (`CumulativeBalanceChart`)** :
   - Évolution du solde consolidé sur les 6 derniers mois glissants (avec ventilation ou filtrage possible BoursoBank / Revolut et par Type de compte).
   - Tooltip accessible au clavier et au toucher, montants formatés en `JetBrains Mono` (`tabular-nums`) et locale `fr-FR` (`€`).
2. **Dépenses M-1 / Moyenne 3M (`ExpensesComparisonChart`)** :
   - Comparatif par catégorie (ou global mensuel) des dépenses du mois précédent (**M-1**) face à la **moyenne des 3 derniers mois (3M)** pour repérer immédiatement les dérives budgétaires.
   - Respect des seuils d'alerte sans dépendre uniquement de la couleur (motifs, labels directs, écart chiffré `+XX %`).

Règles Recharts :
- Charger le module graphique en import dynamique (`React.lazy`) si hors route initiale ou lourd, avec squelette de hauteur fixe (`aspect-ratio` / `min-block-size`).
- Respecter `prefers-reduced-motion: reduce` (`isAnimationActive={!prefersReducedMotion}`).

---

## 4. Fonctionnalités Métier Obligatoires dans l'UI

- **Tableau / Liste des transactions** : doit afficher explicitement les colonnes/champs **Banque** (`BoursoBank` | `Revolut`) et **Type de compte** (ex. `Courant`, `Épargne`, `Carte différée`, `Multi-devises`), en plus de Date, Libellé, Catégorie, **Note personnalisée** et Montant (`tabular-nums`).
- **Notes personnalisées** : édition/ajout fluide via `<dialog>` (tiroir tactile mobile / panneau latéral Desktop) avec validation optimiste et file Offline-First.
- **Onglet dédié aux Règles de catégorisation** : vue à part entière permettant de créer, tester, ordonner et activer/désactiver des règles automatiques (ex. motif libellé, banque, type de compte → catégorie cible), avec validation `:user-valid` / `:user-invalid` et aperçu du nombre de transactions correspondantes.
- **Synchronisation Drive restreinte** : interface de suivi affichant uniquement l'état des 2 dossiers sources (`BoursoBank` et `Revolut`), la progression des lots PDF Gemini et les éventuels fichiers en erreur à relancer.

---

## 5. Architecture React, Accessibilité WCAG 2.1 AA & Plateforme Web Moderne

- **Séparation Conteneur / Présentation** et composants `< 200` lignes.
- **TypeScript strict (Matt Pocock)** : zéro `any`, props discriminées, validation `zod` des données entrantes.
- **Accessibilité WCAG 2.1 AA** :
  - Contraste >= `4.5:1` (texte normal) et >= `3:1` (grands titres et graphiques/icônes UI).
  - Sémantique HTML native (`<button>`, `<nav>`, `<main>`, `<dialog>`, `<table>` sur Desktop, `aria-labelledby`, `aria-live="polite"` unique pour les annonces).
  - Navigation clavier complète (`Tab`, `Shift+Tab`, `Esc` sur `<dialog>`).
- **Optimisation INP <= 200ms & `content-visibility: auto`** :
  - Appliquer `content-visibility: auto; contain-intrinsic-size: auto 72px;` sur les lignes/blocs de transactions sous le fold.
  - Utiliser `yieldToMain()` (`scheduler.yield()` + fallback `setTimeout`) ou Web Worker pour tout filtrage/tri lourd côté client.
