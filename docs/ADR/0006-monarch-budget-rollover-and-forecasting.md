# ADR-0006 : Budget Monarch par Catégorie, Rollover, Projections & Analytique Décisionnelle

- **Statut** : Proposé (Normatif Pré-Code — EGM v2)
- **Date** : 2026-11-26
- **Décideurs** : Product Owner & Architecte Standards / Produit (`standards-adr-author`)
- **Références** :
  - [TECHNICAL_STANDARDS.md](file:///d:/Applications/Clairflux/docs/TECHNICAL_STANDARDS.md)
  - [DATA_MODEL_DRIZZLE_SPEC.md](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md)
  - [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)
  - [ADR-0002 — Ledger Neon/Drizzle en Centimes Entiers](file:///d:/Applications/Clairflux/docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)
  - [ADR-0004 — Architecture UI Baseline & Recharts](file:///d:/Applications/Clairflux/docs/ADR/0004-ui-baseline-and-recharts-architecture.md)
  - [ADR-0005 — Catégories Hiérarchiques & Catégorisation Hybride](file:///d:/Applications/Clairflux/docs/ADR/0005-categories-hierarchy-and-gemini-hybrid-categorization.md)

---

## 1. Contexte

En v1, ClairFlux dispose d'une table embryonnaire `budget_limits` par libellé texte simple et de deux graphiques Recharts (*Solde cumulé 6M* et *Dépenses M-1 / Moyenne 3M*). Le Product Owner souhaite faire évoluer ClairFlux vers un pilotage budgétaire et prévisionnel complet de niveau Fintech Tier-1 (pack Monarch complet) adapté aux comptes personnels `BoursoBank` et `Revolut` (`EUR` / `USD`) :

1. **Budget mensuel exploitable sur l'année** : absorber les dépenses irrégulières (vacances, impôts, entretien auto) via un **rollover** (report du reliquat ou du dépassement d'un mois sur l'autre) et distinguer clairement charges **Fixes**, **Variables** et **Non-mensuelles**.
2. **Analytique & Anticipation** : visualiser où part chaque euro (drill-down par catégorie/sous-catégorie, Cash Flow & taux d'épargne, diagramme Sankey sur Desktop), repérer automatiquement les abonnements récurrents et leurs hausses de prix, projeter la trésorerie à 3 / 6 / 12 mois avec simulateur *« Et si... »* utilisable hors-ligne sur Android, et obtenir un **Bilan IA mensuel** synthétique à la demande.

---

## 2. Contraintes

- **Précision arithmétique sans flottant** : tous les plafonds, surcharges mensuelles, rollovers, dépenses réelles, projections et simulations restent calculés en **centimes entiers (`bigint`)** et alignés sur le mode `EUR consolidé` (taux historique figé `amount_eur_cents`) ou `USD seul`.
- **Zéro double-comptage hiérarchique** : un budget peut être défini au niveau `Catégorie` avec des sous-plafonds optionnels au niveau `Sous-catégorie` ; les dépenses d'une sous-catégorie ne doivent jamais être comptées deux fois dans le total budgété ou dépensé global.
- **Consultation et simulation 100 % hors-ligne sur Android** : les vues Synthèse, Budget, Radar des récurrents et le simulateur *« Et si... »* doivent fonctionner en mode avion depuis le cache local Delta Sync v2, en respectant `INP <= 200 ms` grâce au déport dans un **Web Worker**.
- **Éditions budgétaires et Bilan IA en ligne uniquement** : la configuration des budgets (`budget_configs`, `budget_monthly_overrides`), la validation des récurrents (`recurring_series`) et la génération manuelle du Bilan IA (`ai_monthly_briefs`) s'exécutent en ligne avec mise en cache SQL pour consultation ultérieure hors-ligne.
- **Ergonomie mobile sans surcharge** : les visualisations denses comme le diagramme **Sankey** restent strictement réservées aux écrans **Desktop / tablette large (`>= 1024 px`)**, avec un équivalent lisible et tactile sur mobile (`390×844` / `320 px`).

---

## 3. Options Considérées

### Axe A — Philosophie Budgétaire (Monarch Catégorie+Rollover vs YNAB Base Zéro vs Monarch Flex Pur)

- **Option A1 — Budget Base Zéro (style YNAB)**
  - *Principe* : chaque euro disponible sur les comptes doit être assigné à des enveloppes jusqu'à atteindre `0 EUR` à assigner, avec réconciliation stricte du disponible bancaire.
  - *Inconvénients* : friction opérationnelle quotidienne élevée pour un usage personnel alimenté par imports PDF périodiques ; incompatible avec l'import asynchrone différé des relevés BoursoBank/Revolut. **Rejetée.**
- **Option A2 — Monarch « Flex Budget » pur (enveloppe variable globale unique)**
  - *Principe* : somme des revenus moins charges fixes et dépenses non-mensuelles, laissant un seul reste à vivre global « Flex » sans plafond par catégorie variable.
  - *Inconvénients* : trop permissif sur les postes dérapants (ex. restaurants vs courses) et ne permet pas de piloter des objectifs par catégorie. **Rejetée.**
- **Option A3 (Retenue) — Budget Monarch par Catégorie + Rollover + Sous-plafonds optionnels + Vue synthétique Fixes / Variables / Non-mensuelles**
  - *Avantages* : combine la simplicité de lecture d'une enveloppe par catégorie, l'agrégation automatique par `budget_group_enum` (`fixed`, `variable`, `non_monthly`), le lissage plurimensuel par rollover bornable et des sous-plafonds facultatifs sur les sous-catégories critiques.

### Axe B — Architecture de Prévision (`3 / 6 / 12 mois`) & Simulateur *« Et si... »*

- **Option B1 — Calcul des projections exclusivement côté serveur à chaque curseur UI**
  - *Inconvénients* : casse le fonctionnement hors-ligne dans l'APK Android et dégrade l'INP si un curseur déclenche des allers-retours HTTP. **Rejetée.**
- **Option B2 (Retenue) — Moteur pur partagé (`packages/shared`) exécuté côté serveur pour `/api/analytics/forecast` et dans un Web Worker local pour le simulateur *« Et si... »***
  - *Avantages* : cohérence mathématique exacte entre serveur et APK offline, réactivité immédiate (`INP <= 200 ms`) lors de la manipulation des curseurs d'hypothèses, et zéro requête réseau pour simuler un scénario.

### Axe C — Sankey Cash Flow sur Mobile vs Desktop

- **Option C1 — Afficher le graphe Sankey Recharts sur tous les écrans y compris `390 px` / `320 px`**
  - *Inconvénients* : nœuds et libellés illisibles sous `768 px`, cibles tactiles `< 44 px`, alourdissement inutile du chunk critique mobile. **Rejetée.**
- **Option C2 (Retenue) — Sankey Desktop-only (`>= 1024 px`) en chunk `React.lazy` séparé + fallback mobile en barres empilées / ventilation par groupes**
  - *Avantages* : le bundle du graphe Sankey n'est chargé que sur viewport large ; le mobile reste lisible, rapide (`LCP < 1.2 s` offline) et conforme WCAG 2.1 AA.

### Axe D — Bilan IA Mensuel

- **Option D1 — Génération automatique à chaque ouverture de l'écran Synthèse**
  - *Inconvénients* : explosion des coûts Gemini et latence au démarrage de l'application. **Rejetée.**
- **Option D2 (Retenue) — Déclenchement 100 % manuel (`POST /api/ai/monthly-brief`) + cache SQL (`ai_monthly_briefs`) indexé sur `(month, scope_key, display_currency)` et `data_revision`**
  - *Avantages* : zéro coût imprévu ; si aucune donnée n'a changé (`data_revision` identique), l'API renvoie immédiatement le bilan mis en cache sans solliciter Gemini ; une fois généré, le bilan est inclus dans le delta v2 pour consultation hors-ligne.

---

## 4. Décision Retenue

### 4.1 Modèle Budgétaire Monarch (`budget_configs` & `budget_monthly_overrides`)
1. La table `budget_configs` remplace et étend `budget_limits` selon un plan **Expand/Contract** sans perte des plafonds v1 existants.
2. Chaque configuration est rattachée à une `category_id` (`categories.id`, racine ou sous-catégorie) avec :
   - `monthly_limit_cents` (`bigint > 0`), `currency` (`EUR` ou `USD`), `is_active`,
   - `rollover_enabled` (`boolean`), `rollover_start_month` (`YYYY-MM`), `rollover_cap_cents` (`bigint | null`, plafond maximal de report positif accumulable).
3. Des ajustements ponctuels par mois sont enregistrés dans `budget_monthly_overrides` (`UNIQUE(budget_config_id, budget_month)`) :
   - `override_limit_cents` (`bigint >= 0`, remplace ponctuellement le plafond du mois),
   - `rollover_adjustment_cents` (`bigint` signé, permet une remise à zéro ou un report manuel exceptionnel).
4. L'écran Budget présente simultanément la vue groupée **Fixes / Variables / Non-mensuelles** (pilotée par `budget_group_enum`) et le détail hiérarchique par catégorie.

### 4.2 Calcul en Centimes Entiers & Non-Double-Comptage Parent / Sous-catégorie
1. **Exclusion des transferts internes** : toute opération `is_internal_transfer = true` est exclue du calcul de `spent_cents`.
2. **Règle stricte de non-double-comptage** :
   - Les dépenses directes d'une catégorie racine sont celles où `category_id = parent.id AND subcategory_id IS NULL`.
   - Les dépenses d'une sous-catégorie sont celles où `category_id = parent.id AND subcategory_id = sub.id`.
   - Le `spent_cents` affiché sur une Catégorie parente vaut : `dépenses directes + somme(dépenses de ses sous-catégories)`.
   - Dans la somme globale du budget mensuel (total alloué et total dépensé du mois), **seule l'enveloppe parente est comptée** lorsque la catégorie parente possède un `budget_config` : un éventuel `budget_config` sur une sous-catégorie agit comme un **sous-plafond de pilotage interne** borné à l'enveloppe parente (et signalé en alerte si `somme(sous-plafonds) > plafond parent`). Si une sous-catégorie est budgétée sans budget sur son parent, elle est comptabilisée directement sans double-comptage.
3. **Formule déterministe du Rollover multi-mois** :
   - Pour chaque mois `m` depuis `rollover_start_month` jusqu'au mois demandé `M` :
     - `effective_limit_cents(m) = override_limit_cents(m) ?? monthly_limit_cents`
     - `carried_in(m) = rollover_enabled ? clamp(previous_available_cents + rollover_adjustment_cents(m), upper: rollover_cap_cents) : 0`
     - `available_cents(m) = effective_limit_cents(m) + carried_in(m) - spent_cents(m)`
   - Aucun flottant n'intervient à aucune étape du calcul.

### 4.3 Projections `3 / 6 / 12 mois`, Bande d'Incertitude & Simulateur *« Et si... »*
1. **Modèle de projection (`GET /api/analytics/forecast?horizon=3|6|12`)** :
   - Combine trois signaux déterministes en centimes : (a) revenus moyens ou récurrents confirmés, (b) séries récurrentes confirmées (`recurring_series` où `status = 'confirmed'`) projetées à leur cadence exacte, et (c) dépenses variables tendancielles (médiane / moyenne glissante robuste sur 3 à 6 mois ou enveloppes budgétaires actives).
   - Calcule trois trajectoires mensuelles : **Prudent** (borne basse revenus / borne haute dépenses basée sur la dispersion historique), **Tendanciel** (scénario central) et **Optimiste** (borne haute revenus / borne basse dépenses), rendues dans Recharts sous forme de courbe centrale + bande d'incertitude.
2. **Simulateur *« Et si... »* 100 % local / hors-ligne** :
   - Paramètres manipulables instantanément côté client (variation mensuelle d'une catégorie en EUR ou en %, ajout/arrêt d'un récurrent, dépense exceptionnelle ponctuelle à un mois `m`).
   - Recalculé intégralement dans le **Web Worker** dédié à partir du snapshot local (zéro appel réseau, zéro écriture SQL), maintenant l'interface interactive (`INP <= 200 ms`).

### 4.4 Radar des Récurrents, Cash Flow, Sankey Desktop-Only & Bilan IA Mensuel
1. **Radar des récurrents (`recurring_series`)** :
   - Regroupe les opérations par `merchant_key` normalisé et `account_id`, détecte les cadences (`weekly`, `monthly`, `quarterly`, `yearly`) avec tolérance de montant (`tolerance_bp`) et de date, et calcule l'évolution tarifaire (`previous_amount_cents`, `price_change_pct_bp`).
   - Cycles d'état (`recurring_status_enum`) : `'detected'` (suggestion automatique) -> `'confirmed'` (validé par l'utilisateur, injecté dans les projections) ou `'dismissed'` (faux positif écarté durablement).
2. **Cash Flow + Taux d'épargne + Sankey Desktop-only** :
   - `GET /api/analytics/cashflow` fournit les totaux mensuels Entrées / Sorties / Épargne nette / Taux d'épargne (en `bp`) ainsi que les nœuds et liens `sankey_nodes` / `sankey_links`.
   - Sur viewport `>= 1024 px`, un chunk `React.lazy` séparé rend le diagramme Sankey (Revenus -> Catégories / Épargne). Sur viewport `< 1024 px`, le composant Sankey n'est jamais monté et laisse place à un fallback mobile tactile (barres empilées + ventilation par groupes).
3. **Bilan IA mensuel manuel (`ai_monthly_briefs`)** :
   - Déclenché uniquement par bouton explicite (*« Générer le bilan IA du mois »*).
   - L'API envoie à Gemini des **agrégats anonymisés en centimes** (jamais d'historique brut massif inutile), impose une sortie JSON validée par Zod (`summary_json`) et persiste le résultat dans `ai_monthly_briefs` avec `model_used` et `data_revision`.
   - Les appels ultérieurs pour le même `(month, scope_key, display_currency)` à `data_revision` inchangée servent le cache SQL instantanément (`0` appel Gemini).

---

## 5. Conséquences & Risques

### Conséquences positives
- **Pilotage financier complet hors-ligne** : l'utilisateur consulte ses budgets, ses rollovers, son radar d'abonnements et teste des scénarios *« Et si... »* dans le métro ou en avion sans perte de précision.
- **Zéro biais de double-comptage** : la règle stricte entre catégorie parente et sous-plafonds empêche les totaux budgétaires gonflés artificiellement.
- **Coût IA maîtrisé** : les projections et simulations sont 100 % algorithmiques locales ; le Bilan IA mensuel ne s'exécute que sur clic manuel avec cache SQL invalidé uniquement par changement de révision.

### Conséquences négatives / Coûts
- **Migration Expand/Contract de `budget_limits` vers `budget_configs`** : nécessite de migrer proprement d'éventuelles lignes v1 existantes et de conserver la compatibilité de lecture pendant la transition.
- **Calibration du radar des récurrents** : certains commerçants fréquents non récurrents (ex. supermarché chaque semaine au même montant approximatif) peuvent générer des candidats `'detected'`.

### Risques identifiés & Mitigations

| Risque | Probabilité | Impact | Mitigation obligatoire |
| :--- | :--- | :--- | :--- |
| **Faux positifs dans le radar des récurrents** (achats fréquents confondus avec abonnements) | Moyenne | Moyen | Critères stricts de régularité de période et faible dispersion de montant (`tolerance_bp`), statut initial `'detected'` séparé de `'confirmed'`, et action 1-tap `'dismissed'` mémorisée sur `merchant_key`. |
| **Somme des sous-plafonds supérieure au plafond parent** | Moyenne | Faible | Autorisé en configuration mais signalé explicitement dans l'UI Budget, et la formule globale ne somme jamais les sous-plafonds par-dessus le plafond parent (zéro double-comptage). |
| **Ralentissement UI (`INP > 200 ms`)** lors du glissement des curseurs du simulateur *« Et si... »* ou recalcul de 12 mois de rollover | Moyenne | Élevé | Déport complet du moteur rollover/projections dans le Web Worker dédié, couplé à `useDeferredValue` et à `isAnimationActive={false}` pendant l'interaction curseur. |
| **Dégradation mobile par chargement du graphe Sankey** | Faible | Moyen | Garde stricte `>= 1024 px` avant l'import dynamique `React.lazy`, fallback mobile léger natif, et équivalent tabulaire accessible clavier. |
