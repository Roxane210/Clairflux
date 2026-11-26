# Affinage des Flux Critiques — Catégories IA, Budget Rollover & Analytique (`idea-refine`)

- **Date** : 2026-11-26
- **Statut** : Convergé et prêt pour conception technique (`swarm-egm-engineering`)
- **Intention liée** : [ai-categories-budget-analytics.md](file:///d:/Applications/Clairflux/docs/intent/ai-categories-budget-analytics.md)
- **Références** : [critical-flows.md](file:///d:/Applications/Clairflux/docs/ideas/critical-flows.md), [design_draft_ai_budget_analytics.md](file:///d:/Applications/Clairflux/docs/architecture/design_draft_ai_budget_analytics.md)

## Problème ciblé

Comment doter **ClairFlux** d'une catégorisation assistée par Gemini sur ~2 940 opérations historiques et futurs relevés, d'un budget Monarch à 2 niveaux avec report (*rollover*) multi-mois, et d'un pack analytique complet avec projections locales — **sans jamais perdre le contrôle des coûts Gemini, sans doublon ni double-comptage comptable, sans casser le hors-ligne Android, et en gardant chaque geste faisable en moins de 30 secondes** ?

---

## 1. Flux 1 — Lots IA Gemini & Reprise sur Erreur / Coûts

### Défi produit
*« Comment catégoriser par lots près de 2 940 opérations existantes (et les futures opérations sans règle) via Gemini sans jamais dépasser les quotas, sans tout recommencer en cas de coupure réseau, et sans exposer ClairFlux à des libellés bancaires pièges ? »*

### Pensée divergente & Direction retenue : **Pipeline par lots bornés avec pré-filtrage gratuit, checkpoint par lot et annulation propre**

1. **Pré-filtrage déterministe gratuit (0 EUR / 0 token)** :
   - Avant tout appel Gemini, le serveur applique dans l'ordre strict :
     1. `is_manual_category = true` → **ignoré** (verrou humain absolu),
     2. `is_internal_transfer = true` (ou paire `transfer_group_id`) → **ignoré**,
     3. `categorization_rules` actives (du plus prioritaire au moins prioritaire) → **classé gratuitement** (`rule`),
     4. Déjà catégorisé avec source `ai_auto >= 8500 bp` ou `ai_validated` (sauf demande explicite de ré-analyse forcée) → **ignoré**.
   - **Déduplication de libellés dans le lot** : si `CARREFOUR MARKET 4812` apparaît 45 fois dans l'historique, le serveur ne l'envoie qu'une seule fois en tant que motif représentatif (ou regroupe par `clean_label` normalisé + tranche de montant/sens débit-crédit) pour diviser le volume d'appels IA par 3 à 5.
2. **Lots bornés & chaîne de repli Gemini** :
   - Découpage en lots fixes de **40 à 50 motifs/opérations maximum** par requête Gemini (pour tenir largement sous les timeouts HTTP et limiter la taille du JSON retourné).
   - Chaîne de modèles ordonnée : **`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`**, avec clé API transmise uniquement par l'en-tête HTTP **`x-goog-api-key`**.
   - Un seul lot est enregistré dans `ai_categorization_runs` à la fois (`409` si un run est déjà en cours, avec suivi d'avancement en direct : `processed / total`, `auto_applied`, `pending_review`, `failed`).
3. **Défense anti-injection sur `raw_label`** :
   - Les libellés bancaires (`raw_label` / `clean_label`) sont encapsulés dans un bloc de données JSON strictement délimité et assaini (suppression de caractères de contrôle / balises) avec consigne système explicite de les traiter comme données non fiables.
   - La réponse Gemini est validée par **Zod strict** : l'identifiant de catégorie retourné doit impérativement exister dans la table `categories` active (aucune création sauvage de catégorie par l'IA), et le score de confiance doit être un entier borné `0..10000` (basis points).
4. **Reprise sur erreur & Arrêt utilisateur** :
   - Chaque lot validé est commité immédiatement en transaction SQL Neon avant de passer au lot suivant.
   - Si le lot 18 sur 60 échoue (quota HTTP 429, timeout), les lots 1 à 17 restent acquis ; le run passe en `partial_error` ou `failed` et un nouveau clic sur *« Lancer / Reprendre le rattrapage IA »* reprend uniquement sur les opérations encore non catégorisées.
   - Le bouton *« Annuler »* (`POST /api/ai/categorize/cancel`) demande un arrêt propre entre deux lots sans corrompre le lot en cours.

---

## 2. Flux 2 — Boîte de Révision & Conversion en Règles Gratuites

### Défi produit
*« Comment faire en sorte que l'utilisateur valide en 2 minutes les cas douteux de l'IA tout en apprenant au système à ne plus jamais payer pour ces mêmes libellés ? »*

### Direction retenue : **Seuil 85 % (`8500 bp`) + File de révision 1-geste + Suggestions de règles (`ai_rule_suggestions`)**

1. **Aiguillage automatique par seuil de confiance (`8500 bp`)** :
   - **Score >= 85 % (`8500 bp`)** : la catégorie proposée est appliquée directement sur la transaction (source `ai_auto`), visible dans le grand livre avec possibilité de correction manuelle à tout instant.
   - **Score < 85 % (`< 8500 bp`)** : la transaction reste provisoirement non validée dans la **Boîte de révision rapide** (`ai_review_status_enum = pending_review`) avec la top suggestion de Gemini et le pourcentage de confiance affiché en texte clair.
2. **Gestes rapides dans la Boîte de révision (`/api/ai/review-queue`)** :
   - **Accepter** (`accept`) : valide la proposition IA (`is_manual_category = true`, source `ai_validated`, `ai_review_status = 'accepted'`).
   - **Corriger** (`override`) : choisit une autre sous-catégorie en 1 clic/tap (`is_manual_category = true`, source `manual`, `ai_review_status = 'rejected'`).
   - **Rejeter** (`reject`) : laisse en *Non catégorisé* sans suggestion en attente.
   - **Action par lot** : cocher plusieurs lignes similaires ou cliquer sur *« Accepter tout (>= 70 %) »* pour vider la file rapidement.
   - **Option « Créer une règle durable »** intégrée dans la validation : case à cocher pré-remplissant le motif du marchand (`clean_label`) pour créer immédiatement une règle dans `categorization_rules` et l'appliquer à l'historique non manuel.
3. **Moteur de suggestions de règles gratuites (`ai_rule_suggestions`)** :
   - Dès que 3 opérations (ou plus) partagent un motif marchand récurrent classé par IA ou corrigé manuellement sans règle existante, ClairFlux génère une suggestion dans `ai_rule_suggestions` (ex. *« Créer la règle `SPOTIFY` → Abonnements / Streaming (couvre 14 opérations) ? »*).
   - En 1 clic (*Accepter* / *Ignorer*), la règle devient permanente et **gratuite** pour tous les prochains relevés PDF.

---

## 3. Flux 3 — Calcul de Rollover Multi-Mois & Sous-Plafonds / Overrides

### Défi produit
*« Comment combiner le budget par catégorie avec des sous-plafonds optionnels en sous-catégorie, des exceptions mensuelles et un report multi-mois (rollover) sans jamais compter une dépense deux fois ni produire d'écarts d'un mois à l'autre ? »*

### Direction retenue : **Moteur déterministe en centimes entiers avec règle stricte de non-double-comptage**

1. **Structure d'une enveloppe budgétaire** :
   - Chaque catégorie parente peut avoir une configuration dans `budget_configs` : groupe (`budget_group_enum` : Revenus, Charges fixes, Dépenses variables, Non-mensuelles), montant mensuel par défaut (`monthly_limit_cents`), activation du report (`rollover_enabled`), éventuel plafond maximal de report positif (`rollover_cap_cents` ou illimité), et mois de départ du rollover (`rollover_start_month`).
   - Chaque sous-catégorie hérite par défaut de l'enveloppe de sa catégorie parente. L'utilisateur peut **optionnellement** définir un sous-plafond (`monthly_limit_cents`) et/ou un rollover propre sur une sous-catégorie précise (ex. *Transports* = `300 EUR`, dont sous-plafond *Essence* = `150 EUR`).
2. **Règle d'or anti-double-comptage (Parent vs Sous-catégorie)** :
   - Une dépense enregistrée sur une sous-catégorie `S` (enfant de `P`) est comptabilisée **dans `S`** pour le suivi du sous-plafond `S`, et **dans `P`** pour le suivi du plafond global `P`.
   - Dans les totaux globaux du mois (**Dépenses totales prévues** et **Reste à épargner**), **seuls les plafonds de niveau Catégorie parente `P` sont additionnés** (les sous-plafonds `S` sont des ventilations internes de `P`, jamais ajoutés en plus de `P`).
   - Garde de cohérence UI & API : si la somme des sous-plafonds configurés dépasse le plafond parent `P`, ClairFlux affiche un avertissement explicite (*« La somme des sous-plafonds dépasse le budget de la catégorie parente »*) sans bloquer la saisie mais en préservant la justesse du total global.
3. **Calcul exact du mois `M` (zéro flottant, en centimes)** :
   - `effective_limit_cents(C, M)` = `override_limit_cents` de `budget_monthly_overrides` pour `(C, M)` s'il est renseigné, sinon `budget_configs.monthly_limit_cents`.
   - `spent_cents(C, M)` = somme des valeurs absolues des opérations de dépenses (`amount_eur_cents < 0`, `is_internal_transfer = false`, `deleted_at IS NULL`) affectées à `C` (ou à ses sous-catégories si `C` est une catégorie parente) sur le mois calendaire `M`. *(Les éventuels remboursements positifs rattachés à une catégorie de dépense viennent en déduction nette de `spent_cents`, bornés à `0` minimum).*
   - Si `rollover_enabled = false` : `carried_rollover_cents(C, M) = 0`.
   - Si `rollover_enabled = true` et `M > rollover_start_month` :
     - `prev_available = available_cents(C, M-1) = effective_limit_cents(C, M-1) + carried_rollover_cents(C, M-1) - spent_cents(C, M-1)`.
     - Un déficit négatif (`prev_available < 0`) est reporté par défaut pour ne pas masquer un dépassement réel, tandis qu'un excédent positif est borné par `rollover_cap_cents` s'il est défini ; tout ajustement ponctuel ou remise à zéro passe par `budget_monthly_overrides.rollover_adjustment_cents` (ajouté au report de base).
   - **Disponible du mois** :
     `available_cents(C, M) = effective_limit_cents(C, M) + carried_rollover_cents(C, M) - spent_cents(C, M)`.
   - Un override ponctuel sur `M` (`PUT /api/budgets/overrides/:categoryId/:month`) recalcule en chaîne `carried_rollover_cents` pour `M+1 .. M_courant` de façon déterministe et instantanée côté serveur et côté Web Worker client.

---

## 4. Flux 4 — Moteur de Projection Future 3/6/12 Mois + Détection Récurrents Sans Faux Positifs

### Défi produit
*« Comment projeter la trésorerie à 3, 6 et 12 mois avec simulateur "Et si..." fluide (INP <= 200 ms, 100 % hors-ligne sur Android) et repérer les vrais abonnements/charges fixes sans confondre un plein d'essence ou les courses hebdomadaires avec un abonnement ? »*

### Direction retenue : **Détecteur statistique multi-critères (`recurring_series`) + Simulateur local déterministe en Web Worker**

1. **Détection des récurrents sans faux positifs (`recurring_series`)** :
   - Regroupement par **marchand normalisé** (`clean_label` canonisé : suppression numéros de facture, dates, villes, numéros de terminal CB).
   - Un groupe devient candidat `recurring_series` uniquement s'il vérifie **tous** les garde-fous suivants :
     1. **Minimum d'occurrences** : au moins **3 occurrences** pour une cadence hebdomadaire/mensuelle, ou **2 occurrences** espacées d'environ 90 jours (trimestriel) ou 365 jours (annuel).
     2. **Régularité calendaire** : écart médian entre dates compatible avec une cadence (`7 ± 2 j`, `30 ± 5 j`, `90 ± 10 j`, `365 ± 15 j`) et variance d'intervalle faible.
     3. **Stabilité du montant** : tolérance serrée sur l'écart de montant (ex. variation `<= 15 %` autour de la médiane pour les abonnements/loyers, ou `<= 25 %` pour les factures d'énergie/télécom) — ce qui **élimine automatiquement** les passages fréquents au supermarché ou au restaurant aux montants très variables.
     4. **Exclusion des transferts internes** (`is_internal_transfer = false`).
   - L'utilisateur garde le dernier mot via `PATCH /api/analytics/recurring/:id` : il peut **confirmer**, **mettre en pause** ou **ignorer** une série détectée (ce choix manuel est protégé contre les ré-analyses futures).
2. **Projection 3 / 6 / 12 mois & Simulateur « Et si... » 100 % hors-ligne** :
   - **Point de départ** : solde consolidé réel en EUR à la date du jour (issu du delta cache local sur Android ou Neon sur serveur).
   - **Trois composantes projetées mois par mois (`M+1 .. M+H`, `H ∈ {3, 6, 12}`)** :
     1. **Flux certains / connus** : séries récurrentes actives (`recurring_series`) + postes budgétés fixes (`budget_group_enum = fixed` / `non_monthly` aux mois d'échéance prévus via `budget_monthly_overrides`).
     2. **Flux tendanciels variables** : médiane pondérée sur les 3 à 6 derniers mois complets des revenus et dépenses variables (hors mois incomplets et hors transferts internes).
     3. **Fourchette d'incertitude** : bande **Prudente** (revenus -5 % / variables +15 %) et **Optimiste** (revenus +5 % / variables -10 %) calculées sans IA.
   - **Simulateur interactif « Et si... »** :
     - Curseurs locaux (ex. réduire une catégorie variable de `X EUR/mois`, modifier le revenu mensuel, ajouter une dépense exceptionnelle sur un mois donné, ou activer une règle d'épargne).
     - Exécution dans un **Web Worker dédié** (zéro appel réseau, zéro appel Gemini, `INP <= 200 ms`) pour recalculer instantanément la courbe de projection à 3, 6 ou 12 mois même dans le train ou en mode avion sur Android.

---

## 5. Tableau Comparatif des Directions Envisagées

| Flux critique | Option A — **Architecture Hybride Déterministe + IA Ciblée (Retenue)** | Option B — Tout-IA (LLM pour catégoriser, budgéter et projeter) | Option C — 100 % Manuel sans IA ni détection |
| :--- | :--- | :--- | :--- |
| **Expérience utilisateur** | Rattrapage rapide avec filet de sécurité (`>= 85 %` auto, `< 85 %` en file 1-clic), simulateur « Et si... » instantané hors-ligne, zéro friction sur l'existant. | Temps d'attente longs (plusieurs secondes par écran), réponses non reproductibles d'un clic à l'autre, inutilisable hors-ligne. | Très long de classer 2 940 opérations à la main et de repérer tous ses abonnements manuellement. |
| **Fiabilité comptable & Coûts** | **100 % exact** en centimes entiers ; coûts Gemini divisés grâce au pré-filtrage règles + regroupement de libellés + suggestions de règles gratuites. | Risque d'erreurs arithmétiques dans les totaux, rollover et projections ; facture API élevée si déclenchée à chaque ouverture. | Fiabilité manuelle mais coût cognitif élevé et abandon fréquent. |
| **Risques résiduels** | Nécessite une discipline stricte sur les migrations Expand/Contract et la cohérence Worker/Serveur des formules de rollover/projection. | Timeout fréquent, dépendance réseau permanente, injection de texte sur libellés bancaires. | Aucun levier d'automatisation sur les nouveaux relevés. |
| **Verdict** | **Retenue** | Écartée | Écartée |

---

## 6. Stress-Tests de Pannes & Cas Limites

| Scénario de panne / Cas limite | Impact potentiel sans garde-fou | Comportement conçu & invariant de protection |
| :--- | :--- | :--- |
| **1. Quota Gemini épuisé (HTTP 429) au lot 22/60 sur les 2 940 opérations** | Blocage complet ou perte du travail des lots 1..21, boucle infinie payante. | Repli immédiat sur la chaîne `gemini-4-hydrogen → gemini-3.8-flash → gemini-3.1-flash-lite`. Si tous échouent, les lots 1..21 déjà commités sont conservés ; le run passe en `partial_error` avec bouton *« Reprendre le rattrapage »* sans re-traiter les lots réussis. |
| **2. Libellé bancaire contenant une tentative d'injection de prompt** (ex. *"IGNORE PREVIOUS INSTRUCTIONS..."*) | L'IA pourrait renvoyer une catégorie invalide ou tenter une action imprévue. | Données bancaires isolées en bloc JSON échappé ; sortie Gemini validée strictement par **Zod** ; l'ID de catégorie retourné est vérifié contre la table `categories` en base ; aucune instruction d'écriture directe hors schéma autorisé. |
| **3. Suppression ou fusion d'une catégorie utilisée par des budgets, règles et opérations** | Opérations orphelines, budgets cassés ou totaux faux. | `DELETE /api/categories/:id` exige obligatoirement un `reassign_to_category_id` (ou utilise `POST /api/categories/:id/merge` avec `target_category_id`) et réaffecte atomiquement dans une même transaction SQL toutes les transactions, règles et configurations budgétaires rattachées. |
| **4. Modification d'un override budgétaire sur `M-3` avec rollover actif** | Désynchronisation du disponible sur `M-2`, `M-1` et le mois courant `M`. | Le calcul du rollover est une fonction pure déterministe rejouée sur la chaîne chronologique `rollover_start_month .. M_courant` à chaque lecture ou mise à jour du plan, garantissant la cohérence immédiate côté serveur et client. |
| **5. Double-comptage entre catégorie parente et sous-plafond de sous-catégorie** | Total des dépenses prévues gonflé artificiellement dans l'équation `Revenus − Dépenses`. | Seuls les plafonds des catégories de niveau 1 (parentes) contribuent au total budgétaire global ; les sous-plafonds de niveau 2 sont des bornes de suivi internes à leur parente. |
| **6. Coupure réseau Android pendant une annotation ou consultation de projections** | Perte de la note saisie ou blocage des écrans Synthèse / Budget / Projections. | Consultation complète, projections 3/6/12 mois et simulateur « Et si... » 100 % fonctionnels hors-ligne. Les notes rapides et recatégorisations passent par l'outbox locale existante (`POST /api/sync/delta`). Les boutons Gemini et d'édition budgétaire affichent *« Connexion requise »*. |
| **7. Faux positifs sur les courses hebdomadaires dans le Radar des récurrents** | Des achats Carrefour variables apparaissent comme des abonnements fixes. | Le détecteur exige à la fois une périodicité régulière ET une faible dispersion des montants (`<= 15 %` à `25 %`) ; toute série douteuse peut être rejetée en 1 clic (`dismissed`) et reste ignorée par la détection future. |

---

## 7. Liste Explicite « Ce qu'on ne fait PAS » (Not Doing)

1. **Pas de rattrapage IA automatique en tâche de fond** : les 2 940 opérations existantes ne sont analysées par Gemini **que** lorsque l'utilisateur clique explicitement sur le bouton dédié.
2. **Pas d'envoi de notes personnelles ni de pièces PDF à Gemini lors de la catégorisation** : seuls les libellés bancaires nettoyés/bruts, le montant arrondi/sens, la banque et le type de compte strictement nécessaires sont transmis.
3. **Pas de création automatique de nouvelles catégories par Gemini** : l'IA choisit uniquement parmi l'arbre de catégories et sous-catégories défini par l'utilisateur.
4. **Pas d'arbre à 3 niveaux ou plus** : strictement limité à **2 niveaux** (`Catégorie → Sous-catégorie`) pour préserver la lisibilité mobile (`390×844` / `320 px`).
5. **Pas de mode YNAB « base zéro / affecter chaque euro du solde »** : ClairFlux adopte l'approche **Monarch** (plafonds par catégorie + rollover + vue Fixes / Variables / Non-mensuelles).
6. **Pas d'édition de la structure des budgets ou des catégories hors-ligne sur Android** : seule l'outbox existante pour notes rapides et recatégorisations d'opérations est conservée.
7. **Pas de diagramme Sankey sur smartphone (`< 1024 px`)** : réservé au Desktop et à la tablette en mode paysage ; remplacé sur mobile par des barres horizontales empilées lisibles sans défilement horizontal.
8. **Pas de budget séparé en devise USD native** : toutes les vues budgétaires consolident en **EUR** via `amount_eur_cents`.
