# Énoncé d'Intention Validé — Catégories IA, Budget Monarch & Analytique ClairFlux (v2)

- **Date de validation** : 2026-11-26
- **Statut** : Confirmé par le Product Owner — Phase Pré-Code EGM (`swarm-egm-engineering`)
- **Document parent** : [clairflux-mvp.md](file:///d:/Applications/Clairflux/docs/intent/clairflux-mvp.md)
- **Flux critiques affinés** : [ai-categorization-budget-flows.md](file:///d:/Applications/Clairflux/docs/ideas/ai-categorization-budget-flows.md)
- **Design Draft associé** : [design_draft_ai_budget_analytics.md](file:///d:/Applications/Clairflux/docs/architecture/design_draft_ai_budget_analytics.md)

> [!NOTE]
> Ce document prolonge et unifie les orientations fonctionnelles v2 validées par le Product Owner. Il fait foi sur les brouillons antérieurs ([budget-monarch-ai.md](file:///d:/Applications/Clairflux/docs/intent/budget-monarch-ai.md) et [concepts_brief.md](file:///d:/Applications/Clairflux/docs/architecture/concepts_brief.md)) qui excluaient encore le report de budget (*rollover*), la hiérarchie à 2 niveaux et le Pack Monarch Complet.

---

## 1. Résultat attendu

Faire évoluer **ClairFlux** (`v1.0.1-build.3+`) d'un suivi bancaire multi-comptes vers un véritable **pilote financier personnel tout-en-un** sur Desktop (`1440×900`) et Android APK Capacitor (`390×844` jusqu'à `320 px` de largeur), structuré autour de **4 onglets** (**Synthèse**, **Budget**, **Transactions**, **Synchro**) et de **4 capacités intégrées** :

1. **Arbre libre de Catégories & Sous-catégories à 2 niveaux (Lot 1)** :
   - Organisation hiérarchique claire **`Catégorie → Sous-catégorie`** (strictement limitée à 2 niveaux pour rester lisible sur smartphone).
   - Fourniture d'un **pack de démarrage en français** couvrant la vie courante, les charges fixes, les dépenses non-mensuelles, les revenus et les transferts, entièrement **modifiable, fusionnable et supprimable** (avec réaffectation obligatoire des opérations existantes en cas de suppression).
   - Classement de chaque catégorie dans un groupe budgétaire clair (**Revenus**, **Charges fixes**, **Dépenses variables**, **Non-mensuelles**, **Hors budget / Transferts**).

2. **Catégorisation Hybride IA Gemini & Boîte de révision rapide (Lot 2)** :
   - Respect absolu de la hiérarchie de priorité : **`Manuel > Transfert interne > Règle utilisateur > IA Gemini`**. Une correction manuelle ou un transfert interne apparié n'est **jamais** écrasé.
   - Lorsqu'aucune règle existante ne s'applique, l'IA Gemini propose une sous-catégorie avec un **score de confiance** :
     - **Confiance >= 85 % (`8500 bp`)** : application automatique immédiate (modifiable à tout moment).
     - **Confiance < 85 %** : mise en attente dans une **Boîte de révision rapide** permettant d'accepter, corriger ou rejeter en 1 geste (unitaire ou par lot).
   - **Conversion en règles gratuites** : lorsque l'IA ou l'utilisateur classe des libellés récurrents, ClairFlux propose des **suggestions de règles durables** (validables en 1 clic) pour ne plus jamais consommer de crédit IA sur les futurs relevés contenant ces marchands.
   - **Rattrapage manuel des ~2 940 opérations existantes** : déclenché **exclusivement sur clic manuel** (jamais en tâche de fond), par lots maîtrisés avec suivi d'avancement, pause/annulation et reprise sur erreur via la chaîne **`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`** (en-tête HTTP `x-goog-api-key`).

3. **Budget « Monarch » par Catégorie, Rollover & Groupes Fixes / Variables / Non-mensuelles (Lot 3)** :
   - Pilotage mensuel et annuel autour de l'équation lisible : **`Revenus − Dépenses = Reste à épargner`**.
   - **Vue synthétique à 3 piliers de dépenses** : **Charges fixes** / **Dépenses variables** / **Non-mensuelles** (vacances, impôts, entretien annuel), plus **Revenus**.
   - **Budget par défaut au niveau Catégorie**, avec possibilité optionnelle d'activer un **sous-plafond** et un **report de solde (*Rollover*) multi-mois** sur une sous-catégorie précise (sans double-comptage vis-à-vis de la catégorie parente).
   - **Exceptions mensuelles ciblées** : ajuster un mois donné (ex. août ou décembre) sans altérer la règle mensuelle des autres mois.
   - Le report (*rollover*) permet aux économies ou dépassements d'une enveloppe de se reporter sur les mois suivants (avec plafond ou remise à zéro optionnelle) pour lisser les dépenses irrégulières.

4. **Pack Analytique Monarch Complet & Bilan IA Mensuel (Lot 4)** :
   - **1. Dépenses par Catégorie / Sous-catégorie** avec exploration hiérarchique (*drill-down* en 1 clic/tap de la catégorie vers ses sous-catégories et opérations).
   - **2. Cash Flow, Taux d'épargne & Diagramme Sankey** : flux *Revenus → Groupes → Catégories → Épargne*, avec diagramme **Sankey réservé au Desktop / tablette (`>= 1024 px`)** et vue mobile en barres empilées sans débordement.
   - **3. Projection future 3 / 6 / 12 mois & Simulateur « Et si... »** : projection de trésorerie (tendance centrale + fourchette prudente/optimiste) et curseurs interactifs locaux (*« Et si je réduis tel poste de X EUR/mois ? »*, *« Et si j'ajoute une dépense ponctuelle ? »*) calculés **100 % localement et hors-ligne**.
   - **4. Radar des récurrents & Top Marchands** : détection automatique des abonnements et échéances périodiques sans faux positifs sur les courses fréquentes, calendrier des prochaines échéances et classement des principaux marchands.
   - **5. Bilan IA mensuel** : synthèse rédigée en français clair des points marquants du mois, anomalies et pistes d'action, générée **uniquement sur clic manuel** et mémorisée en base pour lecture hors-ligne.

---

## 2. Utilisateur, Déclenchement & Modes Connecté / Hors-Ligne

- **Usage personnel unique** : un seul espace financier privé consolidant **BoursoBank** et **Revolut** (EUR et USD convertis en EUR consolidé au taux historique `fx_rate_micro`, avec bascule **Vue USD seul** sur le grand livre et les graphiques compatibles).
- **Navigation unifiée en 4 onglets** :
  1. **Synthèse** (indicateurs clés, graphiques d'évolution, Cash Flow & taux d'épargne, projections « Et si... », radar récurrents, Top Marchands, Bilan IA).
  2. **Budget** (plan Monarch par catégorie, vue Fixes / Variables / Non-mensuelles, rollover multi-mois, overrides mensuels, alertes 80 % / 100 %).
  3. **Transactions** (grand livre multi-banques/multi-comptes, notes rapides, sous-vue Règles de catégorisation, gestionnaire de Catégories/Sous-catégories, Boîte de révision IA et suggestions de règles).
  4. **Synchro** (synchronisation manuelle Google Drive 2 dossiers exclusifs + statut d'archivage `Archives`, rattrapage IA Gemini manuel des opérations existantes, téléchargement APK Android).
- **Comportement Android Offline-First (Capacitor)** :
  - **100 % consultable hors-ligne** : Synthèse, Budget, Transactions, Catégories, Projections 3/6/12 mois et simulateur « Et si... », Radar des récurrents, Top Marchands et dernier Bilan IA mémorisé.
  - **Écritures & IA en ligne uniquement** : tous les appels Gemini (rattrapage par lots, bilan IA mensuel) et toutes les éditions budgétaires ou de structure de catégories exigent une connexion active (contrôles verrouillés hors-ligne avec mention *« Connexion requise »*).
  - **Outbox existante conservée** : l'outbox locale (`IndexedDB`) reste maintenue pour l'ajout/modification de **notes rapides** et les **recatégorisations manuelles** d'opérations déjà synchronisées, avec rejeu idempotent dès le retour réseau.

---

## 3. Critères de réussite mesurables

1. **Zéro écrasement humain** : 100 % des catégories choisies manuellement et des transferts internes appariés restent intacts après tout rattrapage IA ou réapplication de règles.
2. **Maîtrise des coûts Gemini** : aucun appel IA automatique au chargement d'écran ; les libellés récurrents déjà couverts par une règle (y compris issue des suggestions validées) ne sont jamais envoyés à Gemini.
3. **Exactitude comptable au centime près** : zéro flottant dans le calcul des budgets, du rollover multi-mois, du sous-plafond sans double-comptage parent/enfant et des projections ; exclusion stricte des transferts internes (`is_internal_transfer = true`).
4. **Fluidité & Ergonomie** : zéro débordement horizontal sur `390×844` et `320 px`, cibles tactiles `>= 44×44 px`, barre basse mobile `<= 15 %` de la hauteur d'écran, `INP <= 200 ms` même lors de la manipulation des curseurs « Et si... ».
5. **Migration sans perte** : passage progressif Lot 1 → Lot 4 via migrations Neon **Expand/Contract** préservant intégralement les ~2 940 opérations, les notes, les règles et les plafonds existants (`budget_limits`).

---

## 4. Hors périmètre (Ce qu'on ne fait PAS)

- Pas de synchronisation bancaire ouverte automatique (Open Banking / DSP2) : les relevés PDF sur les 2 dossiers Google Drive restent l'unique source.
- Pas de catégorisation IA en arrière-plan par cron ou webhook : tout rattrapage historique se lance manuellement.
- Pas d'édition budgétaire, de fusion de catégories ou d'appel Gemini hors-ligne sur Android (lecture et simulation locale « Et si... » uniquement).
- Pas d'arbre à plus de 2 niveaux (pas de sous-sous-catégories) ni de méthode YNAB « base zéro ».
- Pas de diagramme Sankey sur écran mobile (`< 1024 px`).
- Pas de budget distinct en devise USD native : le pilotage budgétaire fonctionne en **EUR consolidé**.
