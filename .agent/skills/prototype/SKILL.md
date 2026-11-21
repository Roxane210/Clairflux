---
name: prototype
description: Méthodologie de prototypage structurel Mock-First couplée à Google Stitch pour ClairFlux. Définit la géométrie exacte des écrans Desktop (1440×900) et Mobile Android (390×844), les états vides/erreur/hors-ligne et les parcours utilisateur à faire valider visuellement au Product Owner AVANT d'écrire les composants React de production.
---

# Prototype — Prototypage Structurel & Mock-First ClairFlux

## Objectif

Conformément à la gouvernance **Mock-First**, le Product Owner doit voir et valider la structure des écrans et les parcours critiques **avant** l'implémentation lourde en React + Neon + Capacitor. Un prototype répond à une question précise de structure ou de logique, sans dette ni sur-ingénierie.

---

## 1. Géométrie exacte des gabarits cibles

Tout prototype structurel (Google Stitch ou maquette HTML/CSS autonome) doit être conçu et vérifié sur **les 2 gabarits officiels ClairFlux** :

### A. Gabarit Desktop (`1440 × 900`)
- **Structure 2 zones** :
  - **Rail / Barre latérale gauche fixe** (`240px`) : identité ClairFlux, navigation principale (*Tableau de bord*, *Transactions*, *Règles de catégorisation*, *Synchronisation Drive*), état de connexion / dernière synchro BoursoBank & Revolut.
  - **Zone de travail principale** (`1200px` max fluide avec marge confortable, `padding: 24px–32px`) :
    - Bandeau KPI supérieur (Solde total consolidé, Revenus du mois, Dépenses du mois, Épargne nette).
    - Grille analytique : **2 graphiques Recharts côte à côte** (`Solde cumulé 6M` + `Dépenses M-1 / Moyenne 3M`).
    - Table / Grand livre des transactions avec colonnes explicites : **Date**, **Banque**, **Type de compte**, **Libellé**, **Catégorie**, **Note personnalisée**, **Montant (`tabular-nums`)**.
    - Tiroir latéral droit (`420px`, `<dialog>` ou panneau dédié) pour l'annotation rapide et l'édition de règles sans perdre le contexte du tableau.

### B. Gabarit Mobile Android (`390 × 844`, Capacitor)
- **Zéro débordement horizontal** (`scrollWidth <= 390px`).
- **Plafond sticky <= 15 %** (`<= 126px` cumulés entre header sticky éventuel et bottom navigation, safe-area inclus).
- **Flux vertical à une main** :
  - Résumé compact (Solde consolidé + état hors-ligne si applicable).
  - Carrousel ou pile de graphiques Recharts lisibles sans chevauchement d'étiquettes (`Solde cumulé 6M`, `Dépenses M-1 / Moyenne 3M`).
  - Liste de transactions optimisée tactile (lignes >= `56px` de haut, boutons >= `44×44px`).
  - Tiroir tactile inférieur (`bottom sheet` via `<dialog>`) pour ajouter/modifier une note personnalisée ou recatégoriser au pouce.
  - Barre de navigation basse (4 entrées max, >= `44×44px` par cible).

---

## 2. États obligatoires dans chaque prototype

Un écran n'est **jamais** validé uniquement dans son « cas idéal » (avec de belles données). Chaque prototype ClairFlux doit montrer et permettre de basculer entre les **5 états** :
1. **État Peuplé Réaliste** : données réelles simulées **BoursoBank** (Compte Courant, Livret / Carte différée) + **Revolut** (Courant EUR, Multi-devises), montants positifs/négatifs variés, libellés bancaires longs réalistes, notes existantes.
2. **État Vide (Premier démarrage)** : aucun relevé PDF encore importé ; explication claire des 2 dossiers Drive surveillés (`BoursoBank` et `Revolut`) et bouton d'action unique *« Lancer la première synchronisation Drive »*.
3. **État Synchronisation / Chargement** : squelettes (skeletons) dimensionnés à l'identique (CLS = 0) + progression par lot PDF Gemini (ex. `3 / 8 relevés analysés`).
4. **État Hors-Ligne (Offline-First Mobile)** : bandeau discret non-bloquant *« Mode hors-ligne — consultation et notes actives, N modifications en attente d'envoi »*, aucune action de lecture/note bloquée.
5. **État Erreur Partielle (Reprise sur erreur PDF)** : 1 PDF illisible ou en erreur Gemini sur un lot, avec message actionnable (*« 1 relevé n'a pas pu être lu — réessayer ce fichier »*) sans casser le reste des données affichées.

---

## 3. Méthodologie couplée Google Stitch → Validation PO → React

1. **Formuler la question de design** (ex. : *« Comment afficher Banque + Type de compte + Note sur mobile 390px sans surcharger la ligne ? »*).
2. **Générer les wireframes/écrans dans Google Stitch** (ou variantes structurelles HTML/CSS `VariantA` / `VariantB` / `VariantC` strictement différentes en hiérarchie, jamais de simples changements de couleur).
3. **Capturer les états vides, hors-ligne et les 2 viewports** (`1440×900` et `390×844`).
4. **Revue visuelle avec le Product Owner** :
   - Présenter les choix en français clair orienté usage.
   - Recueillir les retours et figer le contrat d'écran (hiérarchie, colonnes, interactions).
5. **Jeter ou archiver le prototype** : ne jamais promouvoir du code jetable de maquette tel quel en production. Les décisions validées alimentent la Phase Pré-Code (`swarm-egm-engineering`) puis les composants React (`frontend-ui-engineering`).
