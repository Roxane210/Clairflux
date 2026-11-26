# Design Draft EGM — Catégories IA Gemini, Budget Monarch Rollover & Pack Analytique v2

- **Statut** : Phase Pré-Code EGM — Document d'architecture produit validé avec le PO (strictement aucun code applicatif modifié)
- **Date** : 2026-11-26
- **Références normatives associées** :
  - Intention v2 : [ai-categories-budget-analytics.md](file:///d:/Applications/Clairflux/docs/intent/ai-categories-budget-analytics.md)
  - Flux critiques v2 : [ai-categorization-budget-flows.md](file:///d:/Applications/Clairflux/docs/ideas/ai-categorization-budget-flows.md)
  - Standards techniques : [TECHNICAL_STANDARDS.md](file:///d:/Applications/Clairflux/docs/TECHNICAL_STANDARDS.md)
  - Modèle de données : [DATA_MODEL_DRIZZLE_SPEC.md](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md)
  - Contrat API & Delta Sync : [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)
  - ADRs v2 : [0005 — Catégories & IA Hybride](file:///d:/Applications/Clairflux/docs/ADR/0005-categories-hierarchy-and-gemini-hybrid-categorization.md), [0006 — Budget Monarch, Rollover & Projections](file:///d:/Applications/Clairflux/docs/ADR/0006-monarch-budget-rollover-and-forecasting.md)
  - Audit Baseline WebView : [audit_baseline_modern_web_v2.md](file:///d:/Applications/Clairflux/docs/architecture/audit_baseline_modern_web_v2.md)
  - Spécification Prototype Mock-First v2 : [PROTOTYPE_SPEC_V2.md](file:///d:/Applications/Clairflux/docs/prototypes/PROTOTYPE_SPEC_V2.md)
  - Chantier Drive Archives existant : [design_draft_drive_archives_and_md5_dedup.md](file:///d:/Applications/Clairflux/docs/architecture/design_draft_drive_archives_and_md5_dedup.md)

---

## 1. Intention Validée & Hors Périmètre

### 1.1 Vision consolidée v2 (Décisions PO verrouillées)
1. **Arbre de catégories libre à 2 niveaux (`Catégorie → Sous-catégorie`)** avec un **pack français de départ** modifiable/supprimable/fusionnable, classé par `budget_group_enum` (**Revenus**, **Charges fixes**, **Dépenses variables**, **Non-mensuelles**, **Hors budget / Transferts**).
2. **Catégorisation Hybride IA Gemini** :
   - Ordre de priorité strict : **`Manuel > Transfert interne > Règle > IA Gemini`**.
   - Seuil d'application automatique : **`>= 85 %` (`8500 bp`)**. En dessous, passage dans une **Boîte de révision rapide** + génération de **suggestions de règles gratuites** (`ai_rule_suggestions`).
   - Rattrapage par lots des **~2 940 opérations existantes uniquement sur clic manuel**, via la chaîne **`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`** (en-tête HTTP `x-goog-api-key`).
3. **Budget Monarch par Catégorie + Rollover + vue synthétique Fixes / Variables / Non-mensuelles** :
   - Budget par défaut au niveau **Catégorie**, avec **sous-plafond** et **rollover** optionnels au niveau **Sous-catégorie** (sans double-comptage parent/enfant) et **surcharges mensuelles ciblées** (`budget_monthly_overrides`).
4. **Pack Monarch Complet** :
   - (1) Dépenses par Catégorie/Sous-catégorie (*drill-down*),
   - (2) Cash Flow + Taux d'épargne + **Sankey Desktop/tablette uniquement (`>= 1024 px`)**,
   - (3) Projection future **3 / 6 / 12 mois** + simulateur **« Et si... »** 100 % local/hors-ligne,
   - (4) Radar des récurrents (`recurring_series`) & Top Marchands,
   - (5) Bilan IA mensuel sur clic manuel (`ai_monthly_briefs`, mis en cache SQL).
5. **4 onglets** : **Synthèse**, **Budget**, **Transactions**, **Synchro**.
6. **Offline-First Android** : consultation complète et projections « Et si... » 100 % hors-ligne ; appels Gemini et éditions budgétaires/catégories en ligne uniquement ; **outbox existante conservée** pour les notes rapides et recatégorisations d'opérations (`POST /api/sync/delta`).

### 1.2 Hors périmètre (`Not Doing`)
- Aucun code applicatif dans `apps/`, `packages/`, `android/`, `scripts/` ou `docker-compose.yml` durant la phase Pré-Code EGM.
- Pas d'appels IA automatiques à l'ouverture de l'app ni par tâche planifiée.
- Pas de 3e niveau d'arborescence de catégories, pas de budget YNAB base zéro, pas de Sankey sur mobile (`< 1024 px`), pas de budget natif en USD.

---

## 2. Architecture des 4 Écrans (`Desktop 1440×900`, `Pixel 8 Portrait 412×915 / 320px` & `Pixel 8 Paysage 915×412`)

### 2.1 Règles visuelles, gabarits Google Pixel 8 & invariants Baseline
- **Typographie** : `Plus Jakarta Sans` (titres & KPIs), `DM Sans` (corps & contrôles), `JetBrains Mono` (`tabular-nums` sur 100 % des montants, soldes, taux et pourcentages), bundlées localement via `@fontsource/*`.
- **Élévation unique** : fond canvas (`#f7f6f2`) + surfaces planes (`.cf-surface`, bordure `1 px`), **zéro carte imbriquée**, **zéro pill statique** (les étiquettes passives de banque, compte, groupe budgétaire ou statut IA restent en texte sobre ; le style pilule est réservé aux filtres cliquables).
- **Navigation 4 onglets & adaptation orientation (Desktop vs Pixel 8 Portrait / Paysage)** :
  - **Desktop (`1440×900`)** : rail latéral gauche fixe `240 px` (`Synthèse`, `Budget`, `Transactions`, `Synchro`) + zone de contenu fluide (`max-width: 1200 px`).
  - **Google Pixel 8 Portrait (`412×915 CSS px`, et jusqu'à `320×568`)** : barre de navigation basse fixe en grille **4 colonnes égales** (`height: 64 px + env(safe-area-inset-bottom)`, soit ~`88 px / 915 px = 9,6 % <= 15 %`), en-tête supérieur scrollable absorbant `env(safe-area-inset-top)` (poinçon caméra centré haut), cibles tactiles **`>= 44×44 px`**, **zéro débordement horizontal** (`overflow-x: clip`), `<dialog>` ancré en tiroir bas (`bottom sheet`), et `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />` pour préserver les champs de saisie lors de l'ouverture du clavier virtuel.
  - **Google Pixel 8 Paysage (`915×412 CSS px`, rotations 90° poinçon à gauche et 270° poinçon à droite)** : sous `@media (orientation: landscape) and (max-height: 500px)`, la barre basse est **masquée** (sinon `> 15 %` de `412 px`) et bascule automatiquement vers un **rail latéral gauche compact** (`76 px + env(safe-area-inset-left)`, `block-size: 100dvh`, 4 onglets `>= 44×44 px`, **0 % de sticky vertical**). Les **4** `env(safe-area-inset-top/right/bottom/left)` sont absorbées pour que le poinçon caméra en 90° comme en 270° ne masque jamais ni le rail gauche ni les montants à droite. En paysage : KPIs sur 4 colonnes compactes, **2 graphiques côte à côte** (`@container`), Sankey toujours exclu (`< 1024 px` → barres empilées), tableau Grand Livre complet, et `<dialog>` basculé en **panneau latéral droit** (`padding-inline-end` incluant `env(safe-area-inset-right)`).
- **Couche native APK Android 15 / SDK 35 (`capacitor.config.ts` & `scripts/build-apk.sh` lors de l'implémentation)** :
  - `capacitor.config.ts` : `adjustMarginsForEdgeToEdge: 'auto'` et `webContentsDebuggingEnabled: false` en release.
  - `AndroidManifest.xml` / `styles.xml` (patchés dans `scripts/build-apk.sh` après `cap add android`) : `android:screenOrientation="fullUser"`, `android:configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"` (zéro rechargement WebView à la rotation), `android:windowSoftInputMode="adjustResize"`, `android:windowLayoutInDisplayCutoutMode="shortEdges"`, et barres système claires (`windowLightStatusBar="true"`, `windowLightNavigationBar="true"`).
- **Primitifs natifs** : `<dialog>.showModal()` (tiroir bas portrait / panneau latéral droit Desktop & paysage + modales d'édition budget/catégorie), `[popover]` avec détection `'popover' in HTMLElement.prototype`, `@container (inline-size)`, `:user-valid` / `:user-invalid`, `content-visibility: auto` + `contain-intrinsic-size: auto 72px` sous le fold, et Web Worker dédié pour calculs rollover / projections / filtrage afin de garantir **`INP <= 200 ms`**.

### 2.2 Structure détaillée des 4 onglets

#### Écran 1 — `Synthèse` (Analytique & Projections Monarch)
- **Bandeau de filtres global (`GlobalFilterBar`)** : périmètre (`Tous les comptes`, `BoursoBank`, `Revolut`, compte précis), devise (`EUR consolidé` / `USD seul`), période (`1 semaine`, `1 mois`, `3 mois`, `6 mois`, `1 an`, `Tout`, `Personnalisé`).
- **Surface KPIs** : Solde consolidé, Revenus, Dépenses hors transferts, Taux d'épargne net (`%` et `EUR`), Transferts internes exclus.
- **Bloc 1 — Évolution & Dépenses hiérarchiques** :
  - Graphiques Recharts existants (`Solde cumulé` + `Dépenses` M-1 / Moyenne 3M).
  - **Dépenses par Catégorie → Sous-catégorie (drill-down)** : barres horizontales Recharts ; toucher/cliquer une catégorie déplie ses sous-catégories et permet d'ouvrir les opérations filtrées.
- **Bloc 2 — Cash Flow, Taux d'épargne & Sankey (Desktop/tablette `>= 1024 px`)** :
  - Sur `>= 1024 px` : diagramme Sankey Recharts paresseux (`React.lazy` séparé) visualisant *Revenus → Groupes budgétaires → Top Catégories → Épargne nette*, accompagné d'un résumé tabulaire accessible au clavier.
  - Sur mobile (`< 1024 px`) : **fallback automatique en barres empilées comparatives** (Revenus vs Fixes vs Variables vs Non-mensuelles vs Épargne), zéro scroll horizontal.
- **Bloc 3 — Projection 3 / 6 / 12 mois & Simulateur « Et si... » (100 % local/hors-ligne)** :
  - Sélecteur d'horizon `3M` / `6M` / `12M`, courbe centrale tendancielle + aire d'incertitude (Prudent / Optimiste).
  - Curseurs `<input type="range">` (`>= 44 px` de zone tactile) : ajuster une catégorie variable, tester un revenu ou un achat ponctuel ; recalcul instantané via Web Worker (`useDeferredValue`).
- **Bloc 4 — Radar des récurrents & Top Marchands** :
  - Prochaines échéances détectées (`recurring_series`), montant total mensuel engagé, actions rapides *Confirmer* / *Ignorer* / *Résilier* (en ligne), raccourci direct **`Gérer le calendrier →`** vers `Budget > Récurrents & Calendrier`, et classement des Top Marchands sur la période.
- **Bloc 5 — Bilan IA mensuel (manuel)** :
  - Dernier bilan mémorisé lisible hors-ligne (`aria-live="polite"`, rendu texte React pur sans HTML brut) + bouton **« Générer le bilan IA du mois »** (`POST /api/ai/monthly-brief`, désactivé hors-ligne).

#### Écran 2 — `Budget` (2 sous-onglets : `Plan budgétaire` | `Récurrents & Calendrier`)
Les **4 onglets principaux** (`Synthèse`, `Budget`, `Transactions`, `Synchro`) sont strictement conservés ; `Budget` propose une navigation segmentée sobre (`>= 44×44 px`) entre deux sous-vues :

##### Sous-onglet 2.1 — `Plan budgétaire` (Monarch + Rollover + Groupes)
- **En-tête Mois & Mode** : sélecteur `< Mois YYYY >`, bascule **Vue Mois** / **Vue Année (12 mois)**, bandeau synthétique **`Revenus − Dépenses = Reste à épargner` (prévu vs réel)**.
- **Synthèse par piliers de dépenses** : barre de répartition claire **Charges fixes** / **Dépenses variables** / **Non-mensuelles** (avec part en `%` et total `EUR`).
- **Sections repliables par groupe (`budget_group_enum`)** :
  - Pour chaque Catégorie : nom, jauge WCAG 2.1 AA (icône + texte `Maîtrisé < 80 %` / `Vigilance >= 80 %` / `Dépassement >= 100 %`), `Réel / Disponible (Budget + Rollover)` en `tabular-nums`, badge texte sobre si **Rollover actif** (ex. `+42,00 EUR reportés`) avec `[popover]` détaillant le calcul mois par mois.
  - Dépliage d'une Catégorie : affiche ses **Sous-catégories** (avec sous-plafond et rollover optionnels si activés, ou répartition libre sinon).
  - Édition en ligne via `<dialog>` (Desktop panneau droit / Mobile bottom sheet) : modifier le **défaut mensuel**, poser un **override pour ce mois seul**, activer/désactiver le **rollover** ou un **sous-plafond**.
- **Vue Année (12 mois)** :
  - Desktop (`>= 1024 px`) : tableau 12 mois + Total Année avec mise en évidence des overrides mensuels.
  - Mobile (`< 1024 px`) : fiches compactes par catégorie (total annuel prévu vs réel + liste des mois avec exception), dépliables au toucher.
- **Hors-ligne Android** : consultation 100 % active des vues Mois et Année ; boutons d'édition désactivés avec mention *« Connexion requise pour modifier le budget »*.

##### Sous-onglet 2.2 — `Récurrents & Calendrier` (Abonnements, Échéances lissées & Ajout manuel)
- **Bandeau supérieur** : sélecteur de mois (`< Oct. 2026 | Nov. 2026 | Déc. 2026 >`), bascule **`Inclure revenus récurrents`** (`include_income=true|false`, désactivée par défaut ; si activée, identifie les revenus par icône et texte explicite sans couleur seule), et bouton **`+ Ajouter une échéance`** (désactivé hors-ligne avec mention *« Connexion requise »*).
- **3 compteurs clés** (en surface plane `.cf-surface`, `tabular-nums`, calculés en centimes entiers) :
  1. **Total mensuel lissé** (`monthly_smoothed_cents`, avec sous-texte explicite précisant la quote-part lissée des échéances annuelles/trimestrielles `annual_smoothed_part_cents` selon la formule : `weekly = round(amount * 52 / 12)`, `monthly = amount`, `quarterly = round(amount / 3)`, `yearly = round(amount / 12)`),
  2. **Déjà prélevé ce mois** (`paid_this_month_cents`),
  3. **Reste à venir** (`remaining_this_month_cents`).
- **Grille Calendrier + Liste chronologique (`@container`)** :
  - **Desktop (`1440×900`) et Google Pixel 8 Paysage (`915×412`, `0 %` sticky vertical, 4 `safe-area-inset-*` 90°/270°)** : **2 colonnes côte à côte** — grille calendrier 7 colonnes (`Lun → Dim`) à gauche, liste chronologique des échéances du mois à droite.
  - **Google Pixel 8 Portrait (`412×915`) et `320×568`** : calendrier empilé au-dessus de la liste, chaque cellule jour (`<button type="button">`) conservant une zone tactile `>= 44×44 px` même à `320 px` (`overflow-x: clip`, zéro débordement horizontal).
  - **Filtrage par jour** : cliquer sur un jour du calendrier filtre la liste des échéances de ce jour avec bouton *« Tout le mois »*.
- **Actions 1-tap & Ajout manuel (`<dialog>`)** :
  - Chaque échéance affiche statut sans couleur seule (*Prélevé*, *À venir*, *Hausse +XX %*, *Revenu*, *Ajout manuel*, *Résilié*) et actions en ligne **Confirmer**, **Ignorer**, **Ajuster fréquence/jour**, **Résilier** (`PATCH /api/analytics/recurring/:id`, plus `DELETE` pour les séries manuelles).
  - **`+ Ajouter une échéance`** ouvre un `<dialog>.showModal()` natif (bottom sheet en Portrait, panneau latéral droit en Desktop et Pixel 8 Paysage) alimentant `POST /api/analytics/recurring` (`source = 'manual'`, `direction = 'expense' | 'income'`, `billing_day`, `cadence`, `notes`). Une échéance ajoutée manuellement est **rapprochée automatiquement** dès qu'un relevé réel importé contient le prélèvement correspondant (`matched_transaction_id`), sans créer de doublon de série.

#### Écran 3 — `Transactions` (Grand Livre, Règles, Catégories & Boîte de révision IA)
- **Sous-onglets internes** (navigation segmentée sobre `>= 44 px`) :
  1. **Opérations** : tableau Desktop (`Date`, `Banque`, `Type de compte`, `Libellé`, `Catégorie / Sous-catégorie`, `Source` sobre — Manuel / Transfert / Règle / IA %, `Note`, `Montant`), cartes 2 rangs sous `@container` sur mobile, clic 1-tap ouvrant le tiroir `<dialog>` (note rapide, choix catégorie/sous-catégorie à 2 niveaux, bouton *« Créer une règle depuis ce libellé »*).
  2. **À réviser (IA)** *(compteur dynamique si > 0)* : **Boîte de révision rapide** listant les opérations `< 85 %` (`pending_review`) + encart **Suggestions de règles gratuites** (`ai_rule_suggestions`) avec validation/correction en 1 geste ou par lot.
  3. **Règles** : CRUD des `categorization_rules` existantes ciblant désormais un `category_id` (catégorie ou sous-catégorie), priorité Monter/Descendre, réapplication protégée.
  4. **Catégories** : gestionnaire d'arbre à 2 niveaux (`Catégorie → Sous-catégorie`), création, renommage, changement de groupe (`budget_group_enum`), **fusion** (`POST /api/categories/:id/merge`) et **suppression avec réaffectation obligatoire** (`DELETE /api/categories/:id`).

#### Écran 4 — `Synchro` (Drive Archives, Rattrapage IA Gemini & APK)
- **Bloc 1 — Synchronisation Google Drive (existant enrichi)** : 2 dossiers exclusifs (`1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` BoursoBank, `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` Revolut), bouton manuel *« Synchroniser Drive / Gemini »*, statut fichier par fichier incluant le statut d'archivage `Archives` (`Importé · Archivé sur Drive` / alerte si `archive_failed`), plus flush manuel de l'outbox locale.
- **Bloc 2 — Catégorisation IA Gemini des opérations existantes (manuel)** :
  - Compteur factuel des opérations non catégorisées sans règle (ex. sur les ~2 940 opérations existantes).
  - Bouton explicite **« Catégoriser par IA les opérations sans règle »** (`POST /api/ai/categorize/backfill`), suivi temps réel du lot en cours (`GET /api/ai/categorize/status`), et bouton **« Annuler »** (`POST /api/ai/categorize/cancel`).
  - Rappel visible des règles de priorité (`Manuel > Transfert interne > Règle > IA >= 85 %`) et du modèle utilisé dans la chaîne (`gemini-4-hydrogen → gemini-3.8-flash → gemini-3.1-flash-lite`).
- **Bloc 3 — Distribution APK Android** : `ApkDownloadCard` existant inchangé.

---

## 3. Contrats Fonctionnels des 4 Lots & Noms Canoniques

Pour garantir l'alignement strict avec [DATA_MODEL_DRIZZLE_SPEC.md](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md) et [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md) :

| Élément canonique | Lot | Rôle contractuel |
| :--- | :--- | :--- |
| **Enums PostgreSQL** | Lot 1–4 | `budget_group_enum`, `category_source_enum`, `ai_review_status_enum`, `ai_backfill_run_status_enum`, `recurring_cadence_enum`, `recurring_status_enum` (`'detected' \| 'confirmed' \| 'dismissed' \| 'cancelled'`), `recurring_source_enum` (`'auto_detected' \| 'manual'`), `recurring_direction_enum` (`'expense' \| 'income'`) |
| **Table `categories`** | Lot 1 | Arbre libre à 2 niveaux (`parent_id` nullable ; contrainte empêchant un enfant d'avoir lui-même un enfant), `budget_group_enum`, nom éditable, couleur/ordre sobre, protection anti-suppression si non réaffectée. |
| **Table `ai_categorization_runs`** | Lot 2 | Suivi persistant des rattrapages manuels (`ai_backfill_run_status_enum`, compteurs lots/opérations traitées/auto-appliquées/à réviser/erreurs, modèle retenu, annulation). |
| **Table `ai_rule_suggestions`** | Lot 2 | Propositions de règles durables extraites des opérations récurrentes sans règle, acceptables ou ignorables en 1 clic. |
| **Table `budget_configs`** | Lot 3 | Configuration par catégorie (et optionnellement sous-catégorie) : montant mensuel par défaut (`monthly_limit_cents`), activation rollover (`rollover_enabled`), mois de départ (`rollover_start_month`), plafond maximal positif (`rollover_cap_cents`). Les déficits négatifs sont reportés par défaut pour ne pas masquer un dépassement, et tout ajustement ou remise à zéro passe par `budget_monthly_overrides.rollover_adjustment_cents`. |
| **Table `budget_monthly_overrides`** | Lot 3 | Exceptions mensuelles `(category_id, month)` écrasant uniquement le mois ciblé sans toucher au défaut. |
| **Table `recurring_series`** | Lot 4 | Séries récurrentes détectées ou ajoutées manuellement (`recurring_cadence_enum`, `recurring_status_enum` incluant `'cancelled'`, `recurring_source_enum`, `recurring_direction_enum`, `billing_day`, `cancelled_at`, `notes`), montant médian en centimes, prochaine date estimée, verrou manuel utilisateur et rapprochement automatique des séries manuelles. |
| **Table `ai_monthly_briefs`** | Lot 4 | Cache SQL du bilan IA mensuel généré à la demande (`month`, texte structuré, indicateurs figés, synchronisé en delta pour lecture hors-ligne). |
| **Routes API Lot 1** | Lot 1 | `GET /api/categories`, `POST /api/categories`, `PATCH /api/categories/:id`, `POST /api/categories/:id/merge`, `DELETE /api/categories/:id` |
| **Routes API Lot 2** | Lot 2 | `POST /api/ai/categorize/backfill`, `GET /api/ai/categorize/status`, `POST /api/ai/categorize/cancel`, `GET /api/ai/review-queue`, `POST /api/ai/review-queue/resolve`, `GET /api/ai/rule-suggestions`, `POST /api/ai/rule-suggestions/:id/accept`, `POST /api/ai/rule-suggestions/:id/dismiss` |
| **Routes API Lot 3** | Lot 3 | `GET /api/budgets/plan?month=YYYY-MM&scope=...`, `PUT /api/budgets/configs/:categoryId`, `DELETE /api/budgets/configs/:categoryId`, `PUT /api/budgets/overrides/:categoryId/:month` |
| **Routes API Lot 4** | Lot 4 | `GET /api/analytics/categories`, `GET /api/analytics/cashflow` (inclut `sankey_nodes` & `sankey_links`), `GET /api/analytics/forecast?horizon=3\|6\|12`, `GET /api/analytics/recurring?month=YYYY-MM&include_income=true\|false`, `POST /api/analytics/recurring`, `PATCH /api/analytics/recurring/:id`, `DELETE /api/analytics/recurring/:id`, `GET /api/analytics/merchants`, `POST /api/ai/monthly-brief` |
| **Delta Sync v2** | Lot 1–4 | Extension rétrocompatible de `GET /api/sync/delta` (`CLAIRFLUX_DELTA_SCHEMA_VERSION = '2.0.0'`) + maintien réel de `POST /api/sync/delta` et `applied_client_mutations` pour l'outbox notes/catégories. |

---

## 4. Pack de Catégories Françaises de Départ (2 Niveaux, Modifiable & Supprimable)

Ce pack initial est inséré par migration idempotente au démarrage si `categories` est vide (et reste 100 % modifiable, renommable, fusionnable ou supprimable par le PO) :

| Catégorie parente (Niveau 1) | Groupe budgétaire (`budget_group_enum`) | Sous-catégories par défaut (Niveau 2) |
| :--- | :--- | :--- |
| **Revenus** | Revenus | Salaire & Primes · Remboursements & Notes de frais · Aides & Divers |
| **Logement** | Charges fixes | Loyer / Crédit immobilier · Charges & Copropriété · Énergie (Électricité / Gaz) · Assurance habitation |
| **Abonnements & Télécoms** | Charges fixes | Internet & Mobile · Streaming & Musique · Logiciels & Cloud |
| **Banque & Assurances** | Charges fixes | Frais bancaires · Mutuelle & Santé fixe · Prévoyance & Autres assurances |
| **Alimentation** | Dépenses variables | Courses & Supermarché · Restaurants & Cafés · Livraisons & À emporter |
| **Transports** | Dépenses variables | Carburant & Recharge · Transports en commun · Péages, Parking & VTC |
| **Vie quotidienne & Achats** | Dépenses variables | Shopping & Équipement · Pharmacie & Soins · Maison & Bricolage |
| **Loisirs & Culture** | Dépenses variables | Sorties & Cinéma · Sport & Bien-être · Cadeaux & Dons |
| **Voyages & Vacances** | Non-mensuelles | Transports longue distance · Hébergement · Activités sur place |
| **Impôts & Taxes** | Non-mensuelles | Impôt sur le revenu · Taxes locales & Foncières |
| **Entretien & Imprévus** | Non-mensuelles | Entretien véhicule · Réparations logement · Dépenses exceptionnelles |
| **Transferts & Hors budget** | Hors budget / Transferts | Transfert interne · Épargne & Placements |

*(Plus la catégorie système protégée ou repli `Non catégorisé` pour les opérations en attente d'affectation.)*

---

## 5. Articulation avec les 2 Chantiers Existants

### 5.1 Chantier 1 — Archivage Google Drive (`Archives`) & Déduplication MD5
Référence : [design_draft_drive_archives_and_md5_dedup.md](file:///d:/Applications/Clairflux/docs/architecture/design_draft_drive_archives_and_md5_dedup.md).
- **Indépendance des pipelines** : l'ingestion PDF Drive (`sync-worker`) commit d'abord les transactions en base Neon, puis range le PDF dans `Archives` sur Drive. La catégorisation IA des nouvelles transactions sans règle s'exécute **après** ou en étape post-commit découplée, sans jamais bloquer ni annuler le déplacement vers `Archives`.
- **Zéro double appel Gemini** : un PDF déjà `committed` ou doublon par `(bank, md5_checksum)` est ignoré (`skipped`) sans aucune extraction PDF ni ré-catégorisation IA.
- **Même écran `Synchro`** : le statut d'archivage Drive par fichier (`Importé · Archivé sur Drive` / `archive_failed`) et le panneau de rattrapage IA des opérations existantes cohabitent proprement dans l'onglet **Synchro** en surfaces séparées (zéro carte imbriquée).

### 5.2 Chantier 2 — Fragmentation des 27 Comptes Revolut
- **Constat factuel** : lors d'ingestions de relevés multi-périodes/multi-lots Revolut, des variations d'`external_ref_masked` retournées par Gemini ont pu générer jusqu'à **27 sous-comptes distincts** dans `accounts` pour les poches Revolut (au lieu de quelques comptes consolidés par devise/type).
- **Compatibilité totale de l'architecture v2** :
  - Les catégories (`categories`), la catégorisation IA Gemini, les budgets Monarch (`budget_configs`, `budget_monthly_overrides`) et le Pack Analytique fonctionnent par **catégorie** et par **périmètre consolidé EUR** (`account_id` utilisé pour le rattachement d'origine, sans dépendre du nombre de comptes Revolut).
  - Les transferts internes appariés (`transfer_group_id`) restent strictement exclus des dépenses et des budgets même entre comptes Revolut fragmentés.
- **Facilitation mutuelle lors de la future consolidation des comptes Revolut** :
  - Lorsque le chantier de fusion/déduplication des comptes Revolut réaffectera les transactions des comptes doublons vers le compte Revolut canonique (`account_id` cible), **aucune donnée v2 ne sera perdue** :
    - `transactions.category_id`, `ai_review_status`, et les notes restent attachés à `transaction.id` (inchangé).
    - `budget_configs` et `budget_monthly_overrides` sont liés à `category_id` (indépendant de `account_id`).
    - Seul `aggregates_snapshot` et les séries `recurring_series` se recalculent automatiquement à la révision suivante sans reprise manuelle.

---

## 6. Plan de Développement Incrémental (Lot 1 → Lot 4) & Commits Atomiques

Chaque lot est livré avec **migrations Drizzle versionnées (`db:generate` + `db:migrate`)**, tests Vitest verts, `npm run typecheck`, `npm run lint`, `npm run build` et `npm run audit` à **100 % PASS**.

### Lot 1 — Catégories & Sous-catégories (Arbre à 2 niveaux + Pack français)
- *Commit 1* (`feat(shared,db): ajouter enums et table categories 2 niveaux + migration expand`): enums `budget_group_enum`, `category_source_enum`, table `categories`, colonnes expand sur `transactions` (`category_id`, `category_source`, etc.) et `categorization_rules` (`target_category_id`), script de seed idempotent du pack français + backfill SQL liant les `transactions.category` existantes.
- *Commit 2* (`feat(api): exposer CRUD, fusion et suppression avec réaffectation /api/categories`): routes `/api/categories` + mise à jour `GET /api/sync/delta` (avec `categories`).
- *Commit 3* (`feat(web): ajouter gestionnaire Catégories 2 niveaux et sélecteur dans Transactions`): onglet `Transactions > Catégories`, sélecteur parent/enfant dans le tiroir `<dialog>` et dans les Règles, mise à jour `<meta viewport>` (`viewport-fit=cover, interactive-widget=resizes-content`) + socle CSS Pixel 8 Portrait/Paysage (4 `safe-area-inset-*`, `@media (orientation: landscape) and (max-height: 500px)` avec rail compact `76px` et `<dialog>` panneau droit).

### Lot 2 — IA Gemini Hybride, Boîte de révision & Suggestions de règles
- *Commit 4* (`feat(db,shared): ajouter tables ai_categorization_runs, ai_rule_suggestions et file de révision`): enums `ai_review_status_enum`, `ai_backfill_run_status_enum`, colonnes IA sur `transactions`.
- *Commit 5* (`feat(sync-worker,api): implémenter pipeline lots IA Gemini anti-injection et endpoints révision`): chaîne `gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.1-flash-lite` (`x-goog-api-key`), seuil `8500 bp`, routes `/api/ai/categorize/*`, `/api/ai/review-queue*`, `/api/ai/rule-suggestions*`, respect strict `Manuel > Transfert > Règle > IA`.
- *Commit 6* (`feat(web): ajouter Boîte de révision IA, suggestions de règles et lanceur Synchro`): sous-onglet `Transactions > À réviser (IA)` et panneau de rattrapage manuel dans `Synchro`.

### Lot 3 — Budget Monarch + Rollover + Groupes Fixes / Variables / Non-mensuelles
- *Commit 7* (`feat(db,shared): ajouter budget_configs, budget_monthly_overrides et moteur pur rollover`): migration Expand depuis `budget_limits` sans perte, moteur pur centimes entiers (`available_cents`, rollover multi-mois, sous-plafonds sans double-comptage).
- *Commit 8* (`feat(api): exposer /api/budgets/plan, configs et overrides + delta sync v2`): calcul serveur cohérent, compatibilité lecture `budget_limits` conservée durant transition.
- *Commit 9* (`feat(web,android): ajouter 4e onglet Budget Monarch (Vue Mois, Vue Année, Rollover) et durcissement APK Pixel 8`): barre 4 onglets adaptative (`Synthèse`, `Budget`, `Transactions`, `Synchro` : barre basse `64px + safe-area-bottom <= 15 %` en portrait, rail gauche `76px + safe-area-left` et `0 %` sticky vertical en paysage `915×412`), vues Mois/Année adaptatives, `[popover]` détail Rollover, mode hors-ligne lecture seule, et configuration Capacitor/APK (`adjustMarginsForEdgeToEdge: 'auto'`, `webContentsDebuggingEnabled: false` en release, `fullUser`, `configChanges`, `adjustResize`, `shortEdges` et barres système claires dans `scripts/build-apk.sh` / `capacitor.config.ts`).

### Lot 4 — Pack Analytique Monarch, Projections « Et si... », Récurrents & Calendrier et Bilan IA
- *Commit 10* (`feat(db,shared,api): ajouter recurring_series, ai_monthly_briefs et /api/analytics/*`): enums (`recurring_status_enum` avec `'cancelled'`, `recurring_source_enum`, `recurring_direction_enum`), colonnes `source`, `direction`, `billing_day`, `cancelled_at`, `notes`, détecteur anti-faux-positifs + rapprochement automatique des séries manuelles, formule de lissage mensuel en centimes (`weekly`/`monthly`/`quarterly`/`yearly`), endpoint Cash Flow + Sankey, endpoint Forecast, endpoints `GET/POST /api/analytics/recurring` & `PATCH/DELETE /api/analytics/recurring/:id`, endpoint Top Marchands, endpoint manuel `POST /api/ai/monthly-brief` avec cache SQL, finalisation `CLAIRFLUX_DELTA_SCHEMA_VERSION = '2.0.0'`.
- *Commit 11* (`feat(web): ajouter Web Worker projections Et si..., Sankey Desktop-only, Récurrents & Calendrier et Bilan IA`): chargement paresseux `React.lazy` Sankey (`>= 1024 px`) + fallback mobile, sous-onglet `Budget > Récurrents & Calendrier` (3 compteurs lissés, grille 7 jours `>= 44×44 px`, bascule revenus récurrents, `<dialog>` d'ajout manuel, actions Confirmer/Ignorer/Ajuster/Résilier) + raccourci depuis le radar `Synthèse`, simulateur local hors-ligne (`INP <= 200 ms`), documentation (`README.md`, `CHANGELOG.md`, `USER_GUIDE.md`) et bump `CLAIRFLUX_BUILD_VERSION`.

---

## 7. Pyramide de Tests Vitest (100 % Logique Critique)

1. **Tests unitaires purs (`packages/shared`, `apps/api`, `apps/sync-worker`, `apps/web`) — Couverture 100 % obligatoire** :
   - **Hiérarchie & Règles** : validation de l'ordre `Manuel > Transfert interne > Règle > IA Gemini` (aucun écrasement sur `is_manual_category = true` ou `is_internal_transfer = true`).
   - **Catégories 2 niveaux** : blocage d'un 3e niveau, réaffectation obligatoire lors de `DELETE` / `merge`.
   - **Seuil IA & Sécurité** : aiguillage `>= 8500 bp` vs `< 8500 bp`, rejet Zod si catégorie inconnue ou tentative d'injection dans `raw_label`, regroupement de libellés identiques.
   - **Moteur Budget & Rollover** : calcul exact en centimes sur 12 mois avec overrides (`override_limit_cents`, `rollover_adjustment_cents`), report multi-mois (excédent plafonné par `rollover_cap_cents`, déficit reporté par défaut), sous-plafonds sans double-comptage du parent.
   - **Détection récurrents & Projections** : détection mensuelle/annuelle validée vs rejet des courses hebdomadaires à montant variable, calcul local « Et si... » identique entre serveur et Web Worker client.
2. **Tests d'intégration API & Drizzle (`apps/api`, `apps/sync-worker`)** :
   - Contrats HTTP de tous les endpoints `/api/categories`, `/api/ai/*`, `/api/budgets/*`, `/api/analytics/*`, codes `409` sur backfill concurrent, `422` sur suppression sans réaffectation.
   - Simulation de panne Gemini sur lot intermédiaire + reprise propre sans doublon ni perte des lots validés.
   - Delta sync `GET /api/sync/delta` v2 + idempotence maintenue de `POST /api/sync/delta` (`applied_client_mutations`).
3. **Tests UI & Responsive Baseline (`apps/web`)** :
   - Vérification barre 4 onglets portrait `<= 15 %` (`64 px + safe-area-bottom`, soit `9,6 %` sur `412×915`), rail compact paysage `76 px + safe-area-left` (`0 %` sticky vertical sur `915×412`), zéro débordement horizontal à `412 px`, `320 px` et `915×412`, absorption des 4 `safe-area-inset-*` et hitboxes `>= 44×44 px`.
   - Sankey monté uniquement à `>= 1024 px` avec fallback barres empilées en portrait comme en paysage Pixel 8 (`915×412`).
   - Comportement hors-ligne : projections « Et si... » et consultation actives, appels Gemini et éditions budgétaires désactivés, outbox notes/catégories opérationnelle.

---

## 8. Plan de Migration Neon **Expand/Contract** (Zéro Perte, Zéro Suppression)

1. **Phase 1 — Expand (Lot 1 à Lot 4, sans aucune suppression)** :
   - Créer les nouveaux enums et tables (`categories`, `ai_categorization_runs`, `ai_rule_suggestions`, `budget_configs`, `budget_monthly_overrides`, `recurring_series`, `ai_monthly_briefs`).
   - Ajouter les nouvelles colonnes en **nullable / avec valeur par défaut** sur `transactions` (`category_id`, `subcategory_id`, `category_source`, `ai_suggested_category_id`, `ai_suggested_subcategory_id`, `ai_confidence_bp`, `ai_review_status`, `ai_reason`, `ai_model`, `recurring_series_id`) et `categorization_rules` (`target_category_id`, `target_subcategory_id`).
   - **Conserver intactes** les colonnes/tables v1 (`transactions.category`, `categorization_rules.target_category`, `budget_limits`, `applied_client_mutations`).
2. **Phase 2 — Backfill idempotent & Double-lecture / Double-écriture transitoire** :
   - Une migration de données SQL idempotente crée les catégories du pack français (+ toute catégorie personnalisée déjà existante dans `transactions.category`, `categorization_rules.target_category` ou `budget_limits`), remplit `transactions.category_id` et copie chaque ligne de `budget_limits` vers `budget_configs` sans rien effacer.
   - Tant que tous les clients APK n'ont pas migré vers la version v2, les écritures sur catégories/budgets continuent de synchroniser le libellé `transactions.category` et `budget_limits` par compatibilité descendante.
3. **Phase 3 — Contract (Ultérieure, après validation PO en production)** :
   - Uniquement après confirmation que Web et APK Android tournent en v2 (`CLAIRFLUX_DELTA_SCHEMA_VERSION = '2.0.0'`), verrouiller `NOT NULL` sur les clés étrangères devenues obligatoires et archiver/déprécier `budget_limits` via une migration dédiée.

---

## 9. Critères d'Acceptation Product Owner (Recette Finale)

- [ ] **Lot 1** : Je peux créer, renommer, fusionner et supprimer une catégorie ou sous-catégorie (avec réaffectation), et je retrouve le pack français de départ prêt à l'emploi.
- [ ] **Lot 2** : Mes corrections manuelles, transferts internes et règles existantes ne sont jamais écrasés. Un clic sur *« Catégoriser par IA »* traite par lots mes ~2 940 opérations existantes, applique automatiquement ce qui dépasse 85 %, place le reste dans *À réviser*, et me propose des règles gratuites en 1 clic.
- [ ] **Lot 3** : L'onglet *Budget* affiche mes revenus, charges fixes, dépenses variables et dépenses non-mensuelles, le reste à épargner, mes reports de solde (*rollover*) multi-mois, mes exceptions sur un mois précis, et mes sous-plafonds éventuels sans double-comptage.
- [ ] **Lot 4** : L'onglet *Synthèse* affiche le drill-down par catégorie, le Cash Flow + Taux d'épargne (avec Sankey sur ordinateur et barres empilées sur téléphone), les projections 3/6/12 mois avec simulateur *« Et si... »* fluide même en mode avion sur Android, le radar des récurrents sans faux positifs sur les courses, les Top Marchands et le Bilan IA généré à la demande. Depuis `Budget > Récurrents & Calendrier` (ou le raccourci du radar), je consulte les 3 compteurs (*Total mensuel lissé* avec quote-part annuelle/trimestrielle, *Déjà prélevé*, *Reste à venir*), le calendrier mensuel cliquable par jour, je confirme/ajuste/résilie une série ou j'ajoute manuellement une échéance anticipée (rapprochée automatiquement au prochain relevé), et j'active si besoin la bascule *Inclure revenus récurrents*.
- [ ] **Pixel 8 Portrait, Paysage 90°/270° & Offline** : Sur Google Pixel 8 en portrait (`412×915`) comme en paysage (`915×412`), la rotation ne recharge pas l'application, le poinçon caméra et les gestes système ne masquent aucun bouton ni montant, le rail compact paysage libère toute la hauteur (`0 %` sticky vertical), le clavier virtuel ne cache pas les champs dans `<dialog>`, je consulte tous les onglets hors réseau, je joue avec le simulateur *« Et si... »*, j'ajoute des notes rapides via l'outbox, et `npm run audit` + tous les tests Vitest passent à **100 %**.
