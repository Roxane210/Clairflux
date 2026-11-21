# ADR 0002 — Ledger Neon/Drizzle en Centimes Entiers, Figement FX Historique & Checkpoints SQL

- **Statut** : Accepté
- **Date** : 2026-11-21
- **Décideurs** : Product Owner & Équipe Architecture ClairFlux
- **Documents liés** :
  - [clairflux-mvp.md](file:///d:/Applications/Clairflux/docs/intent/clairflux-mvp.md)
  - [critical-flows.md](file:///d:/Applications/Clairflux/docs/ideas/critical-flows.md)
  - [DATA_MODEL_DRIZZLE_SPEC.md](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md)
  - [ADR 0001 — Exclusivité Drive & Déduplication](file:///d:/Applications/Clairflux/docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)

---

## 1. Contexte

ClairFlux repose sur PostgreSQL Serverless (**Neon**) piloté par **Drizzle ORM**, avec une ingestion asynchrone de relevés PDF via l'API **Gemini** et une consultation complète hors-ligne sur Android (APK Capacitor).

Trois problématiques d'architecture financière et de résilience se posent :
1. **Précision arithmétique** : calculer des soldes multi-comptes, des agrégats `Solde cumulé 6M` et `Dépenses M-1 / Moyenne 3M` sans aucune dérive d'arrondi binaire.
2. **Consolidation multi-devises `EUR / USD`** : afficher les opérations en `USD` dans leur devise native (`$`) tout en consolidant les totaux et graphiques globaux en `EUR` au **taux de change de la date d'opération**, y compris lorsque le téléphone est hors-ligne.
3. **Résilience de l'ingestion PDF Gemini** : un lot peut contenir plusieurs PDF BoursoBank et Revolut ; un timeout API, une réponse JSON malformée ou une coupure Neon sur 1 fichier ne doit jamais bloquer les autres relevés ni corrompre le grand livre.

---

## 2. Contraintes

- **Zéro erreur d'arrondi** sur les soldes, totaux et graphiques Recharts.
- **Stabilité historique & lecture hors-ligne** : une fois une opération `USD` ingérée, sa contre-valeur en `EUR` doit être immédiatement disponible hors-ligne sur Android et ne doit pas fluctuer ultérieurement au gré du cours du jour.
- **Reprise granulaire par fichier PDF** : bouton *« Réessayer ce fichier »* sans retraiter les PDF déjà committés, et sans transaction SQL ouverte pendant les appels réseau Gemini.
- **Compatibilité Neon Serverless** : distinguer requêtes unitaires rapides (HTTP) et transactions ACID multi-tables (WebSocket `Pool`).

---

## 3. Options Considérées

### Axe A — Représentation des Montants & Taux de Change

1. **Option A1 — `numeric(12, 2)` en SQL converti en `string` ou `float` côté TypeScript**
   - *Inconvénients* : `node-postgres` / Neon retourne `numeric` sous forme de chaîne ; risque d'usage accidentel de `parseFloat()` et erreurs `0.1 + 0.2 !== 0.3` dans les agrégations TypeScript et Recharts. **Rejetée.**
2. **Option A2 — Calcul dynamique du taux `USD -> EUR` au moment de la requête ou côté client**
   - *Inconvénients* : impossible hors-ligne sur Android sans embarquer tout l'historique de cours quotidiens et risque d'instabilité des graphiques `M-1 / 3M`. **Rejetée.**
3. **Option A3 — Centimes entiers `bigint({ mode: 'number' })` + cache `fx_rates` en micro-unités (`rate_micro`) + contre-valeur `amount_eur_cents` figée à l'ingestion** *(Retenue)*
   - *Avantages* : arithmétique 100 % entière en SQL et en TypeScript, cohérence exacte avec la contrainte `CHECK (currency <> 'EUR' OR amount_eur_cents = amount_cents)`, lecture offline immédiate sur Android et stabilité historique garantie.

### Axe B — Granularité des Checkpoints d'Ingestion PDF Gemini

1. **Option B1 — Transaction SQL globale pour tout le lot de fichiers d'un clic « Synchroniser maintenant »**
   - *Inconvénients* : si le 8e PDF sur 10 échoue, les 7 premiers sont perdus (rollback global) et Gemini doit être rappelé pour tout le lot. **Rejetée.**
2. **Option B2 — Checkpoint page par page intra-PDF avec commits intermédiaires**
   - *Inconvénients* : un relevé bancaire forme un tout comptable (le solde d'ouverture/clôture et les compteurs d'occurrences intra-relevé nécessitent le PDF complet) ; un commit partiel page 2/4 laisserait des soldes incohérents. **Rejetée.**
3. **Option B3 — Checkpoint SQL individuel par fichier PDF (`pdf_ingestion_checkpoints`) avec machine à états et sauvegarde intermédiaire `parsed_payload_json`** *(Retenue)*
   - *Avantages* : chaque PDF valide est commité immédiatement dans sa propre `db.transaction(...)` ACID ; en cas d'erreur de commit SQL après un parsing Gemini réussi, le retry reprend à partir de `parsed_payload_json` sans rappel Gemini ; un fichier en échec passe à `'failed'` de manière isolée.

---

## 4. Décision Retenue

1. **Stockage Comptable en Centimes Entiers (`bigint`)** :
   - Toutes les colonnes monétaires (`accounts.current_balance_cents`, `transactions.amount_cents`, `transactions.amount_eur_cents`) utilisent `bigint(..., { mode: 'number' })` accompagné de `currency_enum ('EUR' | 'USD')`.
   - Aucune colonne flottante (`real`, `doublePrecision`) n'est autorisée dans le schéma Drizzle.
   - Les taux de change sont stockés dans `fx_rates` en `rate_micro` (`bigint`, facteur `1_000_000`) avec clé unique `(rate_date, base_currency, quote_currency)`.

2. **Figement du Taux Historique à l'Ingestion** :
   - À l'ingestion d'une opération `USD`, le serveur résout `fx_rate_micro` à `booking_date` (priorité au taux exact présent sur le relevé Revolut, sinon taux de référence BCE mis en cache dans `fx_rates`, avec fallback sur le jour ouvré précédent le plus proche `nearest_business_day`).
   - Il calcule et persiste `fx_rate_micro` et `amount_eur_cents = Math.round((amount_cents * fx_rate_micro) / 1_000_000)` directement sur la ligne `transactions`.
   - Ainsi, la vue consolidée `EUR` et la vue filtrée `USD seul` lisent directement des entiers pré-calculés, en ligne comme hors-ligne.

3. **Pipeline à 2 Phases & Checkpoints SQL par Fichier** :
   - **Lectures rapides** via `drizzle-orm/neon-http` ; **commits ACID par fichier** via `drizzle-orm/neon-serverless` (`Pool` WebSocket).
   - Cycle d'état dans `pdf_ingestion_checkpoints` :
     `pending -> skipped | (extracting -> parsed -> committing -> committed)` (ou `-> failed` avec un code canonique parmi `GEMINI_TIMEOUT | GEMINI_SCHEMA_INVALID | GEMINI_QUOTA_EXCEEDED | PDF_UNREADABLE | DRIVE_DOWNLOAD_ERROR` et `error_message` explicite).
   - Le payload JSON validé par **Zod** est conservé temporairement dans `parsed_payload_json` à l'étape `'parsed'`, puis purgé (`NULL`) dès le passage à `'committed'` dans la même transaction que l'insertion des `transactions`, la mise à jour conditionnelle du solde de clôture (`statement_period_end >= last_statement_closing_date`) et la passe d'appariement des transferts internes.

---

## 5. Conséquences & Risques

### Conséquences Positives
- **Intégrité financière garantie** : aucune perte de centime sur les sommes 6M ou les moyennes 3M ; rollback complet d'un PDF défaillant sans jamais contaminer les autres relevés.
- **Performance & Coût maîtrisés** : séparation nette entre I/O réseau longues (Drive/Gemini hors transaction) et transactions SQL brèves sur Neon ; réutilisation du payload parsé si seul le commit DB a échoué.
- **Expérience Mobile Offline transparente** : l'APK Android reçoit des montants `amount_cents` et `amount_eur_cents` prêts à afficher et agréger sans dépendance FX externe.

### Risques & Mitigations

| Risque identifié | Probabilité | Impact | Mitigation retenue |
| :--- | :--- | :--- | :--- |
| Dépassement de `Number.MAX_SAFE_INTEGER` avec `bigint({ mode: 'number' })` | Quasi nulle (`90 trillions €`) | Élevé si dépassé | Validation Zod bornant tout montant unitaire à des seuils bancaires réalistes et vérification lors de l'ingestion. |
| Absence de taux BCE publié les week-ends et jours fériés pour une opération `USD` datée d'un samedi/dimanche | Élevée | Faible (si non géré, bloquerait l'ingestion) | Fallback déterministe sur le dernier jour ouvré disponible (`source = 'nearest_business_day'`), enregistré dans `fx_rates` pour reproductibilité totale. |
| Croissance de la base Neon due au champ `parsed_payload_json` | Faible | Faible | Purge systématique (`parsed_payload_json = NULL`) incluse dans la transaction de passage au statut `'committed'`. |
| Blocage d'un checkpoint en statut `'extracting'` ou `'committing'` suite à un crash brutal du conteneur worker | Faible | Moyen (fichier semblant bloqué) | Détection de timeout sur `started_at` (ex. `> 5 min`) au démarrage d'un nouveau run ou via *« Réessayer ce fichier »*, permettant de repasser proprement à `'failed'` puis de relancer. |
