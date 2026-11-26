# ADR-0005 : Catégories Hiérarchiques à 2 Niveaux & Catégorisation Hybride Gemini

- **Statut** : Proposé (Normatif Pré-Code — EGM v2)
- **Date** : 2026-11-26
- **Décideurs** : Product Owner & Architecte Standards / Backend (`standards-adr-author`)
- **Références** :
  - [TECHNICAL_STANDARDS.md](file:///d:/Applications/Clairflux/docs/TECHNICAL_STANDARDS.md)
  - [DATA_MODEL_DRIZZLE_SPEC.md](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md)
  - [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)
  - [ADR-0001 — Exclusivité Drive & Déduplication](file:///d:/Applications/Clairflux/docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)
  - [ADR-0002 — Ledger Neon/Drizzle & Checkpoints SQL](file:///d:/Applications/Clairflux/docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)

---

## 1. Contexte

En v1, chaque opération bancaire porte un simple champ texte libre (`transactions.category`) alimenté par des règles lexicales (`categorization_rules`) ou une saisie manuelle. Avec la montée en volume de l'historique (~2 940 opérations BoursoBank et Revolut existantes) et l'introduction d'un suivi budgétaire structuré (ADR-0006), ce modèle plat atteint ses limites :

1. **Absence d'arborescence analytique et de typologie budgétaire** : impossible de regrouper proprement des sous-postes (ex. *Alimentation -> Courses* vs *Alimentation -> Restaurants*) tout en les rattachant à un groupe budgétaire (`fixed`, `variable`, `non_monthly`, `income`, `savings`, `transfer`).
2. **Coût de maintenance des règles manuelles** : de nombreux libellés bancaires varient légèrement selon les commerçants ou les dates, laissant des opérations non classées sans assistance intelligente.
3. **Risque d'hallucination, d'écrasement et de coût IA** : confier aveuglément toute la catégorisation à un LLM sans garde-fou risquerait d'écraser des choix utilisateur, de reclasser à tort des transferts internes, d'exposer le pipeline à des libellés malveillants (prompt injection) ou de déclencher des appels Gemini incontrôlés.

---

## 2. Contraintes

- **Arborescence simple et maîtrisée** : profondeur strictement bornée à **2 niveaux** (`Catégorie` -> `Sous-catégorie`) pour préserver la lisibilité mobile (`390×844` et `320 px`) et éviter la complexité d'arbres récursifs infinis.
- **Pack français initial non verrouillé** : l'utilisateur doit pouvoir renommer, réordonner, archiver ou supprimer toute catégorie/sous-catégorie du pack de départ français (avec réaffectation obligatoire des opérations et règles liées avant suppression).
- **Respect absolu des décisions humaines et comptables** : une catégorie saisie manuellement ou un transfert interne apparié (`BoursoBank ↔ Revolut`, changes `EUR ↔ USD`) ne doit jamais être écrasé par une règle ou par Gemini.
- **Zéro appel IA automatique en arrière-plan** : le rattrapage des opérations existantes (`~2 940` transactions) s'exécute uniquement sur clic manuel, avec reprise possible, budget maîtrisé et traçabilité complète.
- **Sécurité des secrets et des données bancaires** : la clé `GEMINI_API_KEY` reste strictement côté serveur (`sync-worker` / `api`) via le header HTTP `x-goog-api-key`, et aucune donnée de libellé brut (`raw_label`) ne doit pouvoir détourner le comportement du modèle.
- **Rétrocompatibilité v1 (Expand/Contract)** : conserver le champ texte `transactions.category` synchronisé pendant la phase de transition et préserver le fonctionnement de l'outbox client existante (`upsert_note`, `update_category`).

---

## 3. Options Considérées

### Axe A — Structure des Catégories & Référentiel Français

- **Option A1 — Arbre N niveaux récursif (CTE SQL sans limite de profondeur)**
  - *Inconvénients* : complexifie les agrégats de rollover budgétaire, dégrade l'ergonomie mobile à une main et expose à des boucles parent-enfant. **Rejetée.**
- **Option A2 — Taxonomie figée côté code (enum non modifiable)**
  - *Inconvénients* : empêche le Product Owner d'adapter les postes à ses habitudes de dépenses réelles. **Rejetée.**
- **Option A3 (Retenue) — Arbre à 2 niveaux maximum (`categories.parent_id`) + pack français de départ éditable**
  - *Avantages* : modèle relationnel simple avec contrainte de profondeur `<= 2`, rattachement explicite à `budget_group_enum`, pack français prêt à l'emploi dès le bootstrap et personnalisable sans migration SQL.

### Axe B — Moteur de Catégorisation (Règles vs IA pure vs Hybride)

- **Option B1 — IA Gemini systématique sur 100 % des transactions**
  - *Inconvénients* : latence inutile, coût API récurrent même pour des marchands triviaux (ex. *NAVIGO*, *FREE MOBILE*), et instabilité potentielle d'un mois sur l'autre. **Rejetée.**
- **Option B2 — Règles lexicales manuelles seules**
  - *Inconvénients* : nécessite d'écrire des dizaines de règles pour absorber les ~2 940 opérations historiques et les nouveaux marchands occasionnels. **Rejetée.**
- **Option B3 (Retenue) — Pipeline hybride hiérarchisé (Manuel > Transfert interne > Règle gratuite > IA Gemini avec seuil `8500 bp`) + Boîte de révision + Suggestions de règles durables**
  - *Avantages* : coût nul sur tout ce qui est déjà couvert par une règle ou apparié en transfert interne ; l'IA ne traite que le résiduel inconnu ; les validations humaines dans la Boîte de révision produisent progressivement des règles déterministes permanentes (`ai_rule_suggestions`).

### Axe C — Gestion de l'Incertitude IA & Chaîne de Modèles

- **Option C1 — Auto-application systématique quel que soit le score de confiance**
  - *Inconvénients* : pollue le grand livre et les budgets avec des erreurs silencieuses difficiles à repérer. **Rejetée.**
- **Option C2 (Retenue) — Seuil strict `>= 85 %` (`ai_confidence_bp >= 8500`) + Boîte de révision rapide + chaîne de fallback `gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.1-flash-lite`**
  - *Avantages* : seules les prédictions à haute certitude passent en `ai_auto` ; les cas ambigus (`< 8500 bp`) attendent une validation 1-tap en Boîte de révision ; la chaîne de 3 modèles absorbe les quotas HTTP `429`, timeouts et erreurs de schéma sur un modèle amont sans bloquer le lot.

---

## 4. Décision Retenue

### 4.1 Arbre Libre à 2 Niveaux & Pack Français Modifiable
1. La table `categories` stocke les catégories racines (`parent_id IS NULL`) et leurs sous-catégories (`parent_id REFERENCES categories(id)`).
2. Une contrainte métier et SQL impose une **profondeur maximale de 2 niveaux** : une sous-catégorie ne peut jamais devenir parent d'une troisième strate, et toute suppression d'une catégorie utilisée exige une **réaffectation atomique** (`POST /api/categories/:id/merge` ou cible de transfert lors du `DELETE`) afin qu'aucune transaction ni règle ne devienne orpheline.
3. Chaque catégorie racine porte un groupe budgétaire canonique (`budget_group_enum` : `'fixed' | 'variable' | 'non_monthly' | 'income' | 'savings' | 'transfer'`), un jeton visuel (`color_token`), un ordre (`sort_order`), un drapeau `is_system` (pack initial, néanmoins renommable et archivable) et les métadonnées de synchronisation (`revision`, `deleted_at`).
4. Au premier déploiement (migration Expand), un **pack français de départ** composé des 12 catégories racines éditables (`Revenus`, `Logement`, `Abonnements & Télécoms`, `Banque & Assurances`, `Alimentation`, `Transports`, `Vie quotidienne & Achats`, `Loisirs & Culture`, `Voyages & Vacances`, `Impôts & Taxes`, `Entretien & Imprévus`, `Transferts & Hors budget`, plus le repli `Non catégorisé`) et de leurs sous-catégories est semé de manière idempotente sans écraser les catégories personnalisées déjà créées.

### 4.2 Hiérarchie Stricte de Priorité & Seuil 85 % (`8500 bp`)
Toute évaluation (lors d'une ingestion Drive, d'un recalcul de règle ou d'un rattrapage IA) applique strictement l'ordre de priorité décroissant suivant :
1. **Manuel** (`is_manual_category = true` ou `category_source = 'manual'` / `'ai_validated'`) : **verrouillé**, jamais écrasé par les couches suivantes.
2. **Transfert interne** (`is_internal_transfer = true`, issu de l'appariement `transfer_group_id` ou d'un override manuel `is_manual_transfer_override = true`) : classé dans la catégorie système `Transferts & Hors budget` (sous-catégorie `Transfert interne`, `budget_group = 'transfer'`) et exclu des calculs de dépenses.
3. **Règle déterministe** (`categorization_rules` évaluée par priorité, `category_source = 'rule'`, `matched_rule_id` renseigné) : évaluation 100 % locale, déterministe et gratuite (`0` token Gemini).
4. **IA Gemini** (uniquement sur les opérations restantes non catégorisées ou éligibles au rattrapage) :
   - Score exprimé en **points de base entiers (`ai_confidence_bp` de `0` à `10000`)**, zéro flottant.
   - Si `ai_confidence_bp >= 8500` (`>= 85 %`) : application automatique (`category_source = 'ai_auto'`, `ai_review_status = 'none'`, renseignement de `category_id` / `subcategory_id` / `ai_model` / `ai_reason`).
   - Si `ai_confidence_bp < 8500` (`< 85 %`) : l'opération conserve son statut précédent (`uncategorized`) et entre en **Boîte de révision rapide** (`ai_review_status = 'pending_review'`, avec `ai_suggested_category_id`, `ai_suggested_subcategory_id`, `ai_confidence_bp`, `ai_reason`).

### 4.3 Boîte de Révision Rapide & Suggestions de Règles Durables
1. **Résolution rapide** (`POST /api/ai/review-queue/resolve`, unitaire ou par lot) :
   - `accept` : valide la suggestion IA (`category_source = 'ai_validated'`, `ai_review_status = 'accepted'`).
   - `override` : applique le choix choisi par l'utilisateur (`category_source = 'manual'`, `is_manual_category = true`, `ai_review_status = 'rejected'`).
   - `reject` : écarte la suggestion sans classer (`ai_review_status = 'rejected'`).
   - Option `create_rule` permettant de transformer immédiatement un motif normalisé en règle permanente dans `categorization_rules`.
2. **Suggestions de règles durables (`ai_rule_suggestions`)** :
   - Lorsqu'un même motif normalisé de libellé revient de manière cohérente (`sample_count >= 3` ou validation répétée vers la même catégorie/sous-catégorie), le serveur propose une suggestion dans `ai_rule_suggestions` (`status = 'pending'`).
   - L'acceptation (`POST /api/ai/rule-suggestions/:id/accept`) crée la règle dans `categorization_rules` et déclenche le recalcul rétroactif respectant `is_manual_category = true`, réduisant durablement le recours à Gemini.

### 4.4 Rattrapage par Lots Manuel & Chaîne Gemini
1. **Rattrapage manuel borné (`ai_categorization_runs`)** :
   - Déclenché exclusivement par action explicite de l'utilisateur (`POST /api/ai/categorize/backfill`), jamais par cron.
   - Un seul run `running` actif à la fois (toute relance concurrente retourne HTTP `409 Conflict`).
   - Traitement séquentiel par lots de **50 transactions** (après filtrage préalable des opérations déjà manuelles, transferts internes ou couvertes par les règles locales), avec persistance atomique après chaque lot du curseur `cursor_tx_id`, des compteurs (`processed_count`, `auto_applied_count`, `queued_review_count`, `failed_batches`), du `model_used` et du volume `estimated_tokens`.
   - En cas d'échec partiel sur un lot, d'annulation manuelle (`POST /api/ai/categorize/cancel`) ou de redémarrage, le run suivant reprend proprement à partir du curseur sans re-facturer les transactions déjà traitées.
2. **Chaîne de modèles & Transport sécurisé** :
   - Ordre de fallback verrouillé : `gemini-4-hydrogen` -> `gemini-3.8-flash` -> `gemini-3.1-flash-lite`.
   - Authentification stricte par header HTTP `'x-goog-api-key': GEMINI_API_KEY` (jamais en paramètre d'URL ni dans `apps/web`).
   - Bascule automatique sur le modèle suivant uniquement en cas de timeout, quota HTTP `429` ou JSON non conforme au schéma Zod.

### 4.5 Défense Anti-Prompt-Injection & Validation Zod Stricte
1. **Isolation des données non fiables** : les champs issus des relevés bancaires (`raw_label`, `clean_label`) ou de l'utilisateur (`note`) sont injectés dans le prompt sous forme de tableau JSON strictement sérialisé et délimité comme données passives, accompagnés d'une consigne système interdisant d'exécuter toute directive textuelle trouvée dans un libellé bancaire.
2. **Nettoyage préalable** : troncature bornée, suppression des caractères de contrôle non imprimables et normalisation des retours à la ligne avant envoi à Gemini.
3. **Validation Zod stricte en sortie** :
   - Chaque réponse Gemini est parsée et validée par Zod (`temperature: 0`, `responseMimeType: 'application/json'`).
   - Tout `suggested_category_id` / `suggested_subcategory_id` retourné doit correspondre exactement à un identifiant actif fourni dans la taxonomie du prompt (aucune création spontanée de catégorie par l'IA).
   - `confidence_bp` doit être un entier borné `[0, 10000]`.
   - `reason` (`ai_reason`) est tronqué à une longueur courte (`<= 240` caractères) et affiché uniquement comme texte brut échappé par React (zéro HTML/Markdown brut interprété).

---

## 5. Conséquences & Risques

### Conséquences positives
- **Maîtrise directe des coûts Gemini** : la barrière des règles déterministes et le traitement manuel par lots de 50 opérations évitent les appels répétés sur des marchands connus et rendent le rattrapage des ~2 940 opérations prévisible et interruptible.
- **Zéro corruption comptable** : la priorité stricte `Manuel > Transfert interne > Règle > IA` protège les classements validés par l'utilisateur et garantit que les virements `BoursoBank ↔ Revolut` ne basculent jamais en dépense.
- **Apprentissage progressif sans dépendance IA** : grâce à `ai_rule_suggestions`, chaque correction utilisateur enrichit les règles gratuites pour les prochains relevés.

### Conséquences négatives / Coûts
- **Complexité de transition Expand/Contract** : tant que des vues v1 ou l'outbox client existante lisent `transactions.category` (texte), l'API doit maintenir la cohérence bidirectionnelle entre `category` (nom résolu) et `category_id` / `subcategory_id`.
- **Relecture initiale par l'utilisateur** : lors du premier rattrapage des ~2 940 opérations, les libellés génériques (ex. virements sans motif clair ou paiements multi-usages) alimenteront la Boîte de révision pour arbitrage humain.

### Risques identifiés & Mitigations

| Risque | Probabilité | Impact | Mitigation obligatoire |
| :--- | :--- | :--- | :--- |
| **Prompt injection** via un libellé bancaire ou marchand forçant une mauvaise catégorie ou un texte trompeur | Faible | Élevé | Sérialisation JSON stricte des entrées, troncature/filtrage des caractères de contrôle, liste blanche fermée d'IDs de catégories validés par Zod, et rendu texte pur côté React (`ai_reason`). |
| **Épuisement quota HTTP `429` ou coût excessif** pendant le rattrapage des ~2 940 opérations | Moyenne | Moyen | Pré-filtrage local des règles/transferts, lots de 50 tx, fallback `gemini-4-hydrogen -> gemini-3.8-flash -> gemini-3.1-flash-lite`, plafond max de tokens/lots par run et pause/reprise par `cursor_tx_id`. |
| **Hallucination d'une sous-catégorie rattachée à une mauvaise catégorie parente** | Moyenne | Moyen | Validation Zod + vérification serveur que `subcategory.parent_id === category.id` avant tout commit SQL ; rejet du champ fautif vers `pending_review` / `GEMINI_SCHEMA_INVALID`. |
| **Suppression d'une catégorie déjà référencée** par des budgets ou transactions historiques | Moyenne | Élevé | Interdiction de suppression sèche ; `POST /api/categories/:id/merge` exige `target_category_id` et `DELETE /api/categories/:id` exige `reassign_to_category_id` pour réaffecter atomiquement toutes les références en transaction SQL. |
