# Spécification Structurelle de Prototypage Mock-First v2 — ClairFlux

- **Date** : 2026-11-26
- **Statut** : Phase Pré-Code EGM / Mock-First — Prêt pour revue visuelle Product Owner (`prototype` + `mobbin` + `frontend-ui-engineering` + `modern-web-guidance`)
- **Spécification précédente (v1)** : [PROTOTYPE_SPEC.md](file:///d:/Applications/Clairflux/docs/prototypes/PROTOTYPE_SPEC.md)
- **Maquette interactive autonome v2 (100 % offline)** : [clairflux-v2-prototype.html](file:///d:/Applications/Clairflux/docs/prototypes/clairflux-v2-prototype.html)
- **Documents d'architecture liés** :
  - [design_draft_ai_budget_analytics.md](file:///d:/Applications/Clairflux/docs/architecture/design_draft_ai_budget_analytics.md)
  - [audit_baseline_modern_web_v2.md](file:///d:/Applications/Clairflux/docs/architecture/audit_baseline_modern_web_v2.md)
  - [TECHNICAL_STANDARDS.md](file:///d:/Applications/Clairflux/docs/TECHNICAL_STANDARDS.md)

---

## 1. Objectif du Prototype Mock-First v2

Valider visuellement et ergonomiquement auprès du Product Owner l'ensemble des nouveautés **ClairFlux v2** (4 onglets, arbre de catégories à 2 niveaux, Boîte de révision IA & suggestions de règles, Budget Monarch + Rollover + vue Fixes/Variables/Non-mensuelles, Pack Monarch Complet dont Sankey Desktop-only et simulateur « Et si... ») sur **Desktop** et **Google Pixel 8 (Portrait & Paysage 90°/270°)** avant toute modification du code applicatif.

- **Autonomie totale** : zéro requête réseau externe, zéro Google Fonts CDN, zéro librairie externe. Tout le CSS, les polices de repli/système ou locales, les SVG et la logique interactive vivent dans un unique fichier HTML ouvrable directement dans le navigateur Windows.

---

## 2. Les 4 Viewports Simulés & Règles Géométriques Exactes

Un **bandeau simulateur discret externe au viewport** (en haut de la page HTML, hors application) permet au Product Owner de basculer en 1 clic entre les 4 gabarits de test (plus un mode **Plein écran responsive réel**) :

| Gabarit simulé | Dimensions CSS | Navigation & Sticky | Safe-Areas & Poinçon caméra | Adaptation des graphiques & `<dialog>` |
| :--- | :--- | :--- | :--- | :--- |
| **1. Desktop** | `1440 × 900` | Rail latéral gauche fixe `240 px` (4 onglets) + zone fluide `max-width: 1200 px`. | N/A | Sankey SVG actif (`>= 1024 px`), 2 graphiques côte à côte, tableau Grand Livre complet, `<dialog>` en **panneau latéral droit** (`420 px`). |
| **2. Google Pixel 8 Portrait** | `412 × 915` *(ratio 20:9)* | Barre basse fixe **4 colonnes égales** (`64 px + env(safe-area-inset-bottom)` ≈ `88 px`, soit **`9,6 % <= 15 %`**). En-tête scrollable. | Poinçon caméra centré haut + barre gestuelle bas simulés (`--sim-sat`, `--sim-sab`). En-tête absorbe `safe-area-top`. | Sankey masqué (`< 1024 px`), remplacé par **barres empilées horizontales** propres ; `<dialog>` en **tiroir bas (`bottom sheet`)** ; `interactive-widget=resizes-content`. |
| **3. Google Pixel 8 Paysage (90° / 270°)** | `915 × 412` | Sous `@media (orientation: landscape) and (max-height: 500px)`, barre basse **masquée** (sinon `> 15 %`) → bascule vers **rail latéral gauche compact** (`76 px + env(safe-area-inset-left)`, **`0 %` sticky vertical**). | Bouton dédié **90° (poinçon à gauche)** / **270° (poinçon à droite)** testant les **4** variables `--sim-sat / --sim-sar / --sim-sab / --sim-sal` pour garantir 0 masquage du rail ou des montants à droite. | KPIs sur **4 colonnes compactes**, **2 graphiques côte à côte** (`@container`), Sankey toujours exclu (`< 1024 px` → barres empilées), tableau Grand Livre complet, `<dialog>` basculé en **panneau latéral droit** (`padding-inline-end` + `safe-area-right`). |
| **4. Mobile Minimal** | `320 × 568` | Barre basse 4 colonnes `>= 44×44 px` par onglet, `overflow-x: clip`, zéro débordement horizontal. | Safe-areas respectées. | Fiches compactes 2 rangs sous `@container`, montants `tabular-nums` sans coupure ni chevauchement. |

---

## 3. Les 5 États Couverts par le Prototype v2

Le bandeau simulateur inclut un sélecteur immédiat des **5 états obligatoires** :

1. **`Peuplé réaliste`** : comptes BoursoBank & Revolut (EUR/USD), transferts internes exclus des dépenses, catégories à 2 niveaux, budget Monarch avec rollover multi-mois, sous-plafond optionnel, séries récurrentes (dont alerte hausse tarifaire `+15 %`), suggestions de règles gratuites et bilan IA mensuel.
2. **`État Vide`** : premier lancement avant synchronisation, présentation pédagogique des 2 dossiers Drive exclusifs et appel à l'action unique *« Synchroniser Drive / Gemini »*.
3. **`Synchronisation / IA en cours`** : squelettes de hauteur fixe anti-CLS + double suivi granulaire : progression PDF par fichier et suivi par lot Gemini (`Lot 12 / 59 — 600 / 2 940 opérations analysées par Gemini`).
4. **`Hors-ligne Android`** : bandeau discret non bloquant, consultation complète des 4 onglets et **simulateur « Et si… » 100 % actif en local**, boutons Gemini et édition budget verrouillés avec mention *« Connexion requise »*, tandis que l'ajout de **note rapide** reste possible via l'outbox locale (`POST /api/sync/delta`).
5. **`Erreur partielle`** : relevés valides committés + 1 relevé PDF en échec Gemini avec bouton dédié *« Réessayer ce fichier »* sans perte ni blocage des autres vues.

---

## 4. Couverture Interactive des 4 Onglets

1. **`Synthèse`** :
   - `GlobalFilterBar` (`Tous / BoursoBank / Revolut`, `EUR consolidé / USD seul`, `1M / 3M / 6M / 1A`).
   - 4 KPIs (`Solde consolidé`, `Revenus`, `Dépenses hors transferts`, `Taux d'épargne`).
   - Solde cumulé + Dépenses vs Moyenne 3M.
   - Dépenses par **Catégorie → Sous-catégorie avec drill-down interactif au clic** (déplie les sous-catégories et leurs montants).
   - **Cash Flow & Taux d'épargne** : diagramme **Sankey SVG uniquement en Desktop (`>= 1024 px`)**, basculant automatiquement en **barres horizontales empilées** sur Pixel 8 Portrait et Paysage (+ `<details>` équivalent tabulaire accessible au clavier).
   - **Projection 3 / 6 / 12 mois + Simulateur « Et si… »** : boutons `3M / 6M / 12M`, vrais curseurs `<input type="range">` (`>= 44 px` de zone tactile) et boutons `-`/`+` recalculant en direct la courbe centrale + bande prudente/optimiste (actif y compris en état `Hors-ligne Android`).
   - **Radar des récurrents & Top Marchands** (dont alerte hausse tarifaire ex. `+15 %` et bouton raccourci **`Gérer le calendrier →`** vers `Budget > Récurrents & Calendrier`).
   - **Bilan IA mensuel Gemini** (synthèse structurée en texte pur React + bouton manuel de régénération).
2. **`Budget`** *(2 sous-onglets : `Plan budgétaire` | `Récurrents & Calendrier`, tout en conservant les 4 onglets principaux)* :
   - **Sous-onglet `Plan budgétaire`** *(Monarch par Catégorie + Rollover)* :
     - Sélecteur de mois (`< Nov. 2026 >`), bascule **Vue Mois / Vue Année (12 mois)**, bandeau `Revenus − Dépenses = Reste à épargner (Prévu vs Réel)`.
     - Répartition synthétique **Charges fixes / Dépenses variables / Non-mensuelles**.
     - Sections `<details>` dépliables avec jauges WCAG 2.1 AA (`< 80 %`, `80–99 %`, `>= 100 %` doublées icône + texte + repère de rythme du mois).
     - Indicateur **Rollover** (ex. `+140,00 EUR reportés`) ouvrant un **`[popover]`** (avec fallback JS si absent) détaillant le calcul multi-mois, sous-plafond optionnel visible sur une sous-catégorie (sans double-comptage parent), et `<dialog>` natif d'édition budget/override.
   - **Sous-onglet `Récurrents & Calendrier`** :
     - **Bandeau supérieur** : sélecteur de mois navigable (`< Oct. 2026 | Nov. 2026 | Déc. 2026 >`), bascule interactive **`Inclure revenus récurrents`** (désactivée par défaut ; identifie les revenus par icône + mention textuelle sans couleur seule) et bouton **`+ Ajouter une échéance`** (verrouillé hors-ligne avec « Connexion requise »).
     - **3 compteurs clés** (`.cf-surface`, `tabular-nums`) recalculés en direct : *Total mensuel lissé* (avec sous-texte explicite précisant la quote-part lissée des échéances annuelles/trimestrielles), *Déjà prélevé ce mois*, *Reste à venir d'ici fin de mois*.
     - **Grille 7 jours (`Lun → Dim`) + Liste chronologique (`@container`)** : **2 colonnes côte à côte** en Desktop (`1440×900`) et Pixel 8 Paysage (`915×412`, `0 %` sticky vertical, 4 safe-areas 90°/270°) ; **empilée** en Portrait (`412×915`) et `320×568` avec cellules tactiles `>= 44×44 px` même à `320 px` (`0` débordement horizontal).
     - **Interactions réelles** : clic sur un jour filtrant la liste (+ bouton *« Tout le mois »*), statuts sans couleur seule (*Prélevé*, *À venir*, *Hausse +15 %*, *Revenu*, *Ajout manuel*, *Résilié*), boutons 1 tap (**Confirmer**, **Ignorer**, **Ajuster**, **Résilier**) recalculant le calendrier et les 3 compteurs, et `<dialog>.showModal()` d'ajout manuel (bottom sheet Portrait / panneau droit Desktop & Paysage) validé par `:user-valid`/`:user-invalid`.
3. **`Transactions`** :
   - 4 sous-onglets interactifs (`>= 44×44 px`) :
     - **`Opérations`** : tableau Desktop / lignes 2 rangs `@container` mobile, clic ouvrant `<dialog>` (note rapide, choix Catégorie/Sous-catégorie, bouton *« Créer une règle »*).
     - **`À réviser (IA)`** *(compteur `4`)* : Boîte de révision rapide (`Accepter`, `Corriger`, `Rejeter`, action par lot) + encart **Suggestions de règles gratuites** en 1 clic.
     - **`Règles`** : liste ordonnée des règles, priorité et cible Catégorie/Sous-catégorie.
     - **`Catégories`** : arbre libre 2 niveaux (pack français modifiable), création, renommage, changement de groupe, fusion et suppression avec réaffectation obligatoire.
4. **`Synchro`** :
   - Suivi exclusif Google Drive (2 dossiers BoursoBank & Revolut + statut archivage `Archives`), outbox notes/catégories, lanceur **manuel** de rattrapage IA Gemini (~2 940 opérations, bouton *Annuler*), et carte APK Android.

---

## 5. Contrats Visuels & Grille de Validation Product Owner

### 5.1 Contrats Baseline obligatoires vérifiés dans le prototype
- Élévation unique (zéro carte dans une carte), **zéro pill statique décorative** (badges passifs en texte sobre).
- `font-variant-numeric: tabular-nums` sur 100 % des montants, écarts et pourcentages.
- Cibles tactiles `>= 44×44 px`, `overflow-x: clip`, zéro URL externe.

### 5.2 Checklist de recette visuelle Product Owner
- [ ] **Lisibilité Desktop (`1440×900`)** : le rail gauche `240 px`, le Sankey, le drill-down, le Budget Monarch et le panneau droit `<dialog>` sont clairs sans surcharge visuelle.
- [ ] **Pixel 8 Portrait (`412×915`)** : la barre basse 4 onglets reste compacte (`<= 15 %`), aucun contenu n'est coupé à droite ni caché par le poinçon haut ou la barre système bas.
- [ ] **Pixel 8 Paysage (`915×412`, 90° & 270°)** : la barre basse disparaît au profit du rail gauche compact `76 px` (`0 %` sticky vertical), les 2 graphiques s'affichent côte à côte, le poinçon (à gauche à 90° ou à droite à 270°) ne cache ni le rail ni les montants, et `<dialog>` s'ouvre à droite.
- [ ] **Minimum `320×568`** : zéro défilement horizontal, boutons exploitables au pouce (`>= 44×44 px`).
- [ ] **Parcours critiques** : drill-down catégorie, curseurs « Et si… » fluides même hors-ligne, `[popover]` du calcul de rollover, Boîte de révision IA (`< 85 %`) + suggestion de règle gratuite en 1 clic.
- [ ] **Récurrents & Calendrier (`Budget > Récurrents & Calendrier`)** : les 3 compteurs lissés sont lisibles, la grille 7 jours reste cliquable sans débordement même à `320 px` (et côte à côte en Desktop / Pixel 8 Paysage), le filtre par jour, la bascule *Inclure revenus récurrents*, les actions *Confirmer / Ignorer / Ajuster / Résilier* et la modale `+ Ajouter une échéance` mettent à jour calendrier et totaux en direct.
