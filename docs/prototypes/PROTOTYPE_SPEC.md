# Spécification Structurelle de Prototypage Mock-First — ClairFlux

- **Date** : 2026-11-21
- **Statut** : Prêt pour revue visuelle Product Owner (`prototype` + `mobbin` + `frontend-ui-engineering`)
- **Maquette interactive autonome** : `clairflux-mock-prototype.html` (dans le dossier d'artefacts de session)

## 1. Gabarits & Géométrie Exacte

### A. Gabarit Desktop (`1440 × 900`)
- **Grille principale** : Rail latéral gauche fixe `240px` + Zone de contenu fluide (`max-width: 1200px`, marge interne `24px–32px`).
- **Navigation latérale (4 entrées + bouton synchro)** :
  1. `Synthèse` (KPIs + 2 graphiques Recharts)
  2. `Transactions` (Grand livre complet avec Banque & Type de compte + Notes)
  3. `Règles` (Onglet dédié aux règles de catégorisation + test sur historique)
  4. `Synchro Drive` (Suivi exclusif BoursoBank `1cO74NPb...` & Revolut `1pGDvmce...` + bouton « Synchroniser maintenant »)
- **Zone Synthèse** :
  - Barre de filtre rapide par périmètre : `Tous les comptes (EUR consolidé)`, `BoursoBank`, `Revolut`, ou un compte précis dont **`Revolut · Courant USD ($ seul)`** (qui bascule les KPIs et les 2 graphiques Recharts directement en `$ USD`).
  - 4 indicateurs synthétiques sur une seule surface (Élévation unique, zéro cartes imbriquées) : Solde consolidé, Revenus du mois, Dépenses hors transferts, Transferts internes exclus (incluant les changes EUR ↔ USD).
  - 2 graphiques côte à côte (`grid-template-columns: 1fr 1fr`) :
    - **Solde cumulé 6M** (courbe/aire 6 derniers mois, tooltip `JetBrains Mono tabular-nums`).
    - **Dépenses M-1 / Moyenne 3M** (barres comparatives par catégorie + écart en `%`).
- **Zone Transactions** :
  - Filtres par banque et par compte (avec possibilité de renommer un compte détecté).
  - Colonnes strictes : `Date` | `Banque` (`BoursoBank` / `Revolut`) | `Type de compte` (ex. `Perso •4821 (Courant)`, `Joint •9104 (Courant)`, `Carte différée •7712`, `Courant EUR`, `Courant USD`) | `Libellé` | `Catégorie` | `Note personnalisée` | `Montant (tabular-nums)` affichant la devise d'origine (`$` pour USD) + équivalent discret `≈ €` en vue consolidée.
  - Clic sur une ligne → ouverture d'un panneau latéral droit `<dialog>` (`420px`) pour éditer la note, corriger la catégorie (marquée manuelle) ou cliquer sur *« Créer une règle depuis ce libellé »*.

### B. Gabarit Mobile Android (`390 × 844`, Capacitor WebView)
- **Contraintes géométriques vérifiées** :
  - **Zéro débordement horizontal** : largeur stricte `390px` (`overflow-x: clip`, aucune table large).
  - **Plafond sticky <= 15 %** : seule la barre de navigation basse est fixe (`height: 64px`, soit **7,6 %** de `844px`, bien sous le plafond de `126px` / 15 %). L'en-tête supérieur défile naturellement avec le contenu.
  - **Cibles tactiles >= 44×44px** sur tous les boutons, filtres interactifs, onglets et lignes de transaction.
- **Tiroir tactile d'annotation (`<dialog>`)** : s'ancre en bas de l'écran (`bottom sheet`), avec zone de saisie note immédiate et fermeture native (`Fermer`, `Échap` ou geste retour Android).

---

## 2. Les 5 États Couverts par le Prototype Mock-First

1. **Peuplé réaliste** : opérations BoursoBank & Revolut, transferts internes exclus des dépenses, notes existantes, jauges budget (< 75 %, 75–99 %, >= 100 %).
2. **État Vide** : premier lancement avant toute synchro, présentation claire des 2 dossiers Drive exclusifs et appel à l'action unique *« Synchroniser maintenant »*.
3. **État Synchronisation** : barre de progression granulaire fichier par fichier (`6 / 8 PDF analysés par Gemini`).
4. **État Hors-Ligne (Android)** : bandeau discret non bloquant *« Hors-ligne — Consultation active (édition indisponible sans réseau) »*, boutons d'édition et de synchro proprement verrouillés.
5. **État Erreur Partielle** : 9 relevés committés immédiatement + 1 PDF en erreur Gemini avec bouton *« Réessayer ce fichier »*.

---

## 3. Contrats Visuels Appliqués
- **Typographie** : `Plus Jakarta Sans` (titres), `DM Sans` (corps), `JetBrains Mono` avec `font-variant-numeric: tabular-nums` sur 100 % des montants et pourcentages.
- **Élévation unique** : surfaces planes séparées par filet `1px`, zéro carte dans une carte, zéro pill statique décoratif.
- **Standards Baseline** : `<dialog>` natif avec `overscroll-behavior: contain`, `@container` queries, `:has()` borné, `:user-valid`/`:user-invalid` sur le formulaire de règle.
