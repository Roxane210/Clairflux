---
name: mobbin
description: Bibliothèque de patterns ergonomiques Fintech Tier-1 (Copilot Money, Revolut, Wise, Mercury) adaptée à ClairFlux pour la consultation mobile à une main, les jauges d'alertes budgets et les tiroirs tactiles d'annotation. Utiliser le MCP Mobbin s'il est connecté pour vérifier des écrans réels, sinon appliquer ces contrats ergonomiques de référence.
---

# Mobbin — Patterns Ergonomiques Fintech Tier-1 pour ClairFlux

## Principe d'usage (Preuves, pas copier-coller)

Ce skill rassemble les standards ergonomiques éprouvés des leaders Fintech (**Copilot Money**, **Revolut**, **Wise**, **Mercury**) pour concevoir **ClairFlux** sans recréer une interface générique. Si le serveur MCP `mobbin_mobbin` est actif dans la session, rechercher des écrans réels en complément (`search_screens`, `search_flows`) avant de figer un layout.

> **Règle d'adaptation** : On reprend la *mécanique ergonomique* (hiérarchie, densité, zone du pouce, clarté comptable), jamais les couleurs, marques ou textes propriétaires d'un tiers.

---

## 1. Consultation mobile à une main (Zone du pouce — 390×844)

Inspiré de **Revolut** & **Copilot Money** :
- **Navigation primaire en bas d'écran** (Bottom Navigation <= 4 onglets : *Synthèse*, *Transactions*, *Règles*, *Sync Drive*) avec hauteur `56px–64px` + `env(safe-area-inset-bottom)`.
- **Zone haute réservée à la lecture passive** : solde global, sélecteur de compte/période, statut de synchronisation/hors-ligne.
- **Actions fréquentes dans le tiers inférieur** : filtres rapides, bouton « + Note » ou déclencheur de tiroir d'annotation accessibles au pouce droit ou gauche sans changer la prise en main.
- **Plafond sticky strict <= 15 %** du viewport mobile (soit max `~126px` sur `844px` de hauteur totale) : ne jamais empiler en-tête fixe + barre de filtres fixe + barre de tabs fixe si leur somme dépasse 15 %.
- **Liste de transactions à haute lisibilité** :
  - Ligne 1 : Libellé commerçant nettoyé (tronqué proprement) + Montant aligné à droite en `JetBrains Mono` (`tabular-nums`, signe `+` vert/émeraude ou neutre `-`).
  - Ligne 2 : Banque (`BoursoBank` / `Revolut`) · Type de compte (`Courant`, `Épargne`, etc.) · Catégorie · Indicateur discret si une note personnalisée existe.
  - Pas de carte individuelle par transaction : utiliser des séparateurs fins (`1px solid`) au sein d'une surface unique (zéro cartes imbriquées).

---

## 2. Jauges d'alertes budgets (Lisibilité instantanée)

Inspiré de **Copilot Money** & **Wise** :
- **Barre de progression linéaire à marqueur de rythme (« pacing marker »)** : un repère vertical discret montre où l'on devrait être aujourd'hui dans le mois (ex. jour 18/30) par rapport à la consommation réelle.
- **3 paliers sémantiques (jamais par la couleur seule)** :
  - `< 75 %` : Normal (`Sous le budget`, icône neutre ou coche discrète).
  - `75 % – 99 %` : Vigilance (`Approche du seuil`, icône alerte triangle + texte explicite `Reste XX,XX €`).
  - `>= 100 %` : Dépassement (`Dépassé de +XX,XX €`, icône alerte pleine + bordure d'accentuation).
- **Chiffres toujours tabulaires (`tabular-nums`)** : alignement vertical strict entre montants consommés, plafonds et écarts.
- **Zéro pills statiques décoratives** : n'utiliser des pastilles cliquables que lorsqu'elles déclenchent une action réelle (ex. filtrer la catégorie), jamais pour décorer chaque ligne de budget.

---

## 3. Tiroirs tactiles d'annotation & notes rapides

Inspiré de **Copilot Money** & **Mercury** :
- **Tiroir tactile natif (`<dialog>` ancré en bas sur mobile / panneau latéral sur Desktop)** :
  - Ouverture en **1 tap** sur une transaction (hitbox >= `44×44px`).
  - En-tête du tiroir : Montant exact (`tabular-nums`), date, **Banque** + **Type de compte**, libellé brut du relevé PDF (repliable) et libellé marchand.
  - **Champ Note personnalisée en focus immédiat** (`autofocus` contextuel ou 1 tap sur la zone de texte auto-extensible `field-sizing: content`), avec suggestions rapides facultatives ou clavier prêt à dicter/taper.
  - **Sélecteur de catégorie & création de règle « en un geste »** : action directe *« Créer une règle pour ce libellé »* qui pré-remplit l'onglet Règles sans quitter le flux.
  - **Enregistrement optimiste & Offline-First** : validation immédiate en UI locale avec indicateur discret *« Enregistré localement (en attente de synchro) »* si hors-ligne.
- **Geste de fermeture naturel** : bouton explicite `Fermer` (>= 44×44px), touche `Échap`, ou geste retour Android géré nativement par `<dialog>.showModal()`.

---

## 4. Règles de rejet anti-patterns

- **Rejeter** les tableaux Desktop compressés tels quels sur mobile (scroll horizontal interdit à `390px`).
- **Rejeter** les modales multi-étapes pour ajouter une simple note de 5 mots.
- **Rejeter** l'empilement de cartes ombrées les unes dans les autres (principe d'élévation unique).
