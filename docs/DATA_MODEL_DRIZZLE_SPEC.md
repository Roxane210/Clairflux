# Spécification du Modèle de Données & Ledger — Neon PostgreSQL + Drizzle ORM

- **Projet** : ClairFlux
- **Statut** : Normatif — Phase Pré-Code (EGM)
- **Date** : 2026-11-21
- **Sources de vérité associées** :
  - [clairflux-mvp.md](file:///d:/Applications/Clairflux/docs/intent/clairflux-mvp.md)
  - [critical-flows.md](file:///d:/Applications/Clairflux/docs/ideas/critical-flows.md)
  - [ADR 0001 — Exclusivité Drive & Déduplication](file:///d:/Applications/Clairflux/docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)
  - [ADR 0002 — Ledger Neon/Drizzle & Checkpoints](file:///d:/Applications/Clairflux/docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)

> [!IMPORTANT]
> Ce document est une spécification normative pré-code. Aucun fichier `.ts` ou `.sql` exécutable ne doit être généré dans `src/` avant validation complète des 4 artefacts normatifs et du prototype visuel.

---

## 1. Architecture Connexion Neon Serverless & Conventions Drizzle ORM

### 1.1 Stratégie Driver (`@neondatabase/serverless` + `drizzle-orm`)

| Usage | Driver Neon | Adaptateur Drizzle | Justification |
| :--- | :--- | :--- | :--- |
| Requêtes unitaires de lecture (API REST, `GET /api/sync/delta`, KPIs) | `neon(DATABASE_URL)` (HTTP stateless) | `drizzle-orm/neon-http` | Latence minimale sans handshake TCP/TLS persistant en environnement serverless/conteneur. |
| Transactions ACID multi-tables (commit d'un PDF, recalcul rétroactif de règles, mutations avec révision) | `Pool({ connectionString: DATABASE_URL })` (WebSocket) | `drizzle-orm/neon-serverless` | Indispensable pour `db.transaction(...)` avec rollback atomique complet. |
| Génération et application des migrations | `drizzle-kit generate` + `drizzle-kit migrate` | Migrations SQL versionnées | **Interdiction absolue** de `drizzle-kit push` en production. |

### 1.2 Invariants Généraux de Modélisation

1. **Sécurité connexion** : `sslmode=require` obligatoire dans `DATABASE_URL` ; variable strictement confinée aux services serveur (`api` et `sync-worker`), jamais exposée au client Web ni à l'APK Android.
2. **Zéro Float comptable** : tous les montants sont stockés en **centimes entiers signés** via `bigint('...', { mode: 'number' })` (plage sûre JavaScript `±9 007 199 254 740 991` centimes ≈ `±90 000 milliards €/$`). Interdiction stricte de `real`, `doublePrecision` ou `float`.
3. **Taux de change en micro-unités entières** : `fx_rate_micro` stocké en `bigint({ mode: 'number' })` où `1.000000` = `1_000_000` (précision à 6 décimales exacte sans arithmétique flottante).
4. **Horodatage & Dates** :
   - Événements système : `timestamp('...', { withTimezone: true, mode: 'date' })` (`timestamptz` UTC).
   - Dates comptables d'opération et taux journaliers : `date('...', { mode: 'string' })` (format ISO `YYYY-MM-DD`, indépendant du fuseau horaire du téléphone ou du serveur).
5. **Révision monotone globale (`sync_revision_seq`)** :
   - Chaque entité synchronisable vers l'APK Android (`accounts`, `transactions`, `transaction_notes`, `categorization_rules`, `drive_files`, `drive_sync_runs`) porte une colonne `revision` (`bigint` NOT NULL) alimentée à chaque `INSERT`, `UPDATE` ou soft-delete par `nextval('sync_revision_seq')`.
6. **Typage strict Matt Pocock** :
   - Les types TypeScript applicatifs sont dérivés exclusivement de `$inferSelect` et `$inferInsert` des définitions Drizzle et validés aux frontières par schémas `zod` (via `drizzle-zod`).

---

## 2. Séquence & Types Énumérés PostgreSQL (`pgEnum`)

### 2.1 Séquence Globale de Révision

```sql
CREATE SEQUENCE IF NOT EXISTS sync_revision_seq
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;
```

### 2.2 Énumérations Normatives

| Nom SQL `pgEnum` | Nom Drizzle | Valeurs exactes | Usage |
| :--- | :--- | :--- | :--- |
| `bank_enum` | `bankEnum` | `'boursobank'`, `'revolut'` | Banque d'origine (dossiers Drive exclusifs). |
| `account_type_enum` | `accountTypeEnum` | `'courant'`, `'epargne'`, `'carte_differee'`, `'multi_devises'`, `'coffre'`, `'autre'` | Typologie normalisée affichée dans la colonne obligatoire *Type de compte*. |
| `currency_enum` | `currencyEnum` | `'EUR'`, `'USD'` | Devise ISO 4217 supportée par le MVP. |
| `fx_source_enum` | `fxSourceEnum` | `'revolut_statement'`, `'ecb_reference'`, `'nearest_business_day'`, `'manual_override'` | Provenance du taux historique EUR/USD mis en cache. |
| `rule_match_mode_enum` | `ruleMatchModeEnum` | `'contains'`, `'starts_with'`, `'exact'`, `'regex'` | Mode de correspondance sur le libellé normalisé/brut. |
| `sync_trigger_enum` | `syncTriggerEnum` | `'manual'` | Verrouille l'absence de synchronisation automatique. |
| `sync_run_status_enum` | `syncRunStatusEnum` | `'running'`, `'completed'`, `'partial_error'`, `'failed'` | État global d'un run déclenché par l'utilisateur. |
| `checkpoint_status_enum` | `checkpointStatusEnum` | `'pending'`, `'skipped'`, `'extracting'`, `'parsed'`, `'committing'`, `'committed'`, `'failed'` | Machine à états granulaire par fichier PDF Gemini (`'skipped'` = déjà commité avec même `md5_checksum`). |

---

## 3. Spécification Exhaustive des Tables

### 3.1 `accounts` — Comptes bancaires détectés et renommables

Gère plusieurs comptes par banque (ex. plusieurs comptes courants, cartes différées, livrets chez BoursoBank ; poches EUR, USD et coffres chez Revolut).

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant interne stable du compte. |
| `bank` | `bank_enum` | `bankEnum('bank').notNull()` | NOT NULL | `'boursobank'` ou `'revolut'`. |
| `account_type` | `account_type_enum` | `accountTypeEnum('account_type').notNull()` | NOT NULL | Type de compte détecté par Gemini (ex. `'courant'`, `'carte_differee'`). |
| `nickname` | `varchar(80)` | `varchar('nickname', { length: 80 }).notNull()` | NOT NULL, `CHECK (char_length(trim(nickname)) > 0)` | Nom affiché dans l'UI, **renommable librement** par l'utilisateur (ex. `"Perso •4821"`). |
| `detected_name` | `varchar(120)` | `varchar('detected_name', { length: 120 }).notNull()` | NOT NULL | Libellé d'origine extrait du relevé PDF. |
| `external_ref_masked` | `varchar(64)` | `varchar('external_ref_masked', { length: 64 }).notNull()` | NOT NULL | Référence masquée normalisée de rapprochement inter-relevés (ex. `FR76****4821`, `CB****7712`, `REV-USD-MAIN`). |
| `currency` | `currency_enum` | `currencyEnum('currency').notNull()` | NOT NULL | Devise native du compte (`'EUR'` ou `'USD'`). |
| `current_balance_cents` | `bigint` | `bigint('current_balance_cents', { mode: 'number' }).notNull().default(0)` | NOT NULL, DEFAULT `0` | Dernier solde connu dans la devise native du compte. |
| `balance_updated_at` | `timestamptz` | `timestamp('balance_updated_at', { withTimezone: true })` | NULL | Horodatage de la dernière mise à jour du solde. |
| `last_statement_closing_date` | `date` | `date('last_statement_closing_date', { mode: 'string' })` | NULL | Date de fin du relevé le plus récent ayant mis à jour le solde (empêche un vieux relevé d'écraser un solde plus récent). |
| `is_archived` | `boolean` | `boolean('is_archived').notNull().default(false)` | NOT NULL, DEFAULT `false` | Masquage éventuel d'un compte clos sans perte d'historique. |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur monotone pour delta pull Android. |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Date de création. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Dernière modification (renommage ou solde). |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true })` | NULL | Soft delete pour propagation delta mobile. |

- **Contraintes `UNIQUE`** :
  - `uq_accounts_identity` : `UNIQUE (bank, external_ref_masked, currency)` (permet à Revolut d'avoir `REV-MAIN` en `EUR` et en `USD` comme deux comptes distincts sans collision, et à BoursoBank d'avoir plusieurs comptes/cartes).
- **Contraintes `CHECK`** :
  - `chk_accounts_nickname_non_empty` : `CHECK (char_length(trim(nickname)) > 0)`
  - `chk_accounts_external_ref_non_empty` : `CHECK (char_length(trim(external_ref_masked)) > 0)`
- **Index** :
  - `idx_accounts_revision` : `INDEX (revision)`
  - `idx_accounts_bank_currency` : `INDEX (bank, currency) WHERE deleted_at IS NULL`
- **Champ calculé API (`current_balance_eur_cents`, non stocké en table)** :
  - Pour les réponses API (`GET /api/accounts`, `GET /api/sync/delta`), la contre-valeur consolidée `current_balance_eur_cents` est dérivée côté serveur :
    - Si `currency = 'EUR'` : `current_balance_eur_cents = current_balance_cents`.
    - Si `currency = 'USD'` : `current_balance_eur_cents = Math.round((current_balance_cents * latest_rate_micro) / 1_000_000)`, où `latest_rate_micro` provient de la ligne la plus récente de `fx_rates` (`WHERE base_currency = 'USD' AND quote_currency = 'EUR' ORDER BY rate_date DESC LIMIT 1`).

---

### 3.2 `fx_rates` — Cache des taux historiques EUR / USD

Évite tout appel réseau tiers lors des ré-ingestions ou lectures, et fournit la table de vérité de conversion à la date d'opération.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant unique. |
| `rate_date` | `date` | `date('rate_date', { mode: 'string' }).notNull()` | NOT NULL | Date de référence du taux (`YYYY-MM-DD`). |
| `base_currency` | `currency_enum` | `currencyEnum('base_currency').notNull()` | NOT NULL | Devise source (ex. `'USD'`). |
| `quote_currency` | `currency_enum` | `currencyEnum('quote_currency').notNull()` | NOT NULL | Devise cible (ex. `'EUR'`). |
| `rate_micro` | `bigint` | `bigint('rate_micro', { mode: 'number' }).notNull()` | NOT NULL, `CHECK (rate_micro > 0)` | Taux multiplié par `1_000_000` (`1 USD = 0.921500 EUR` → `921500`). |
| `source` | `fx_source_enum` | `fxSourceEnum('source').notNull()` | NOT NULL | Origine du taux (`'revolut_statement'`, `'ecb_reference'`, `'nearest_business_day'`, `'manual_override'`). |
| `fetched_at` | `timestamptz` | `timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Date de mise en cache. |

- **Contraintes `UNIQUE`** :
  - `uq_fx_rates_pair_date` : `UNIQUE (rate_date, base_currency, quote_currency)`
- **Contraintes `CHECK`** :
  - `chk_fx_rates_positive` : `CHECK (rate_micro > 0)`
  - `chk_fx_rates_distinct_currencies` : `CHECK (base_currency <> quote_currency)`
- **Index** :
  - `idx_fx_rates_lookup` : `INDEX (base_currency, quote_currency, rate_date DESC)`

---

### 3.3 `drive_sync_runs` — Historique des synchronisations manuelles

Trace chaque exécution lancée par l'utilisateur via le bouton *« Synchroniser maintenant »*.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant du run de synchronisation. |
| `trigger_mode` | `sync_trigger_enum` | `syncTriggerEnum('trigger_mode').notNull().default('manual')` | NOT NULL, `CHECK (trigger_mode = 'manual')` | Preuve d'audit que le déclenchement est exclusivement manuel. |
| `status` | `sync_run_status_enum` | `syncRunStatusEnum('status').notNull().default('running')` | NOT NULL | Statut global du run. |
| `total_files_discovered` | `integer` | `integer('total_files_discovered').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre de PDF vus dans les 2 dossiers autorisés. |
| `files_skipped_unchanged` | `integer` | `integer('files_skipped_unchanged').notNull().default(0)` | NOT NULL, `CHECK >= 0` | PDF déjà au statut `'committed'` avec le même `md5_checksum`. |
| `files_committed` | `integer` | `integer('files_committed').notNull().default(0)` | NOT NULL, `CHECK >= 0` | PDF nouvellement committés durant ce run. |
| `files_failed` | `integer` | `integer('files_failed').notNull().default(0)` | NOT NULL, `CHECK >= 0` | PDF en échec lors de ce run. |
| `started_at` | `timestamptz` | `timestamp('started_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Début du run. |
| `finished_at` | `timestamptz` | `timestamp('finished_at', { withTimezone: true })` | NULL | Fin du run (`NULL` tant que `'running'`). |
| `error_summary` | `text` | `text('error_summary')` | NULL | Résumé lisible en cas d'erreur globale (ex. token Drive expiré). |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Permet à l'APK de récupérer l'état de synchro le plus récent via delta pull. |

- **Index** :
  - `idx_drive_sync_runs_started` : `INDEX (started_at DESC)`
  - `idx_drive_sync_runs_revision` : `INDEX (revision)`

---

### 3.4 `drive_files` — Registre des PDF Drive des 2 dossiers exclusifs

Verrouille en base l'exclusivité des deux dossiers Google Drive autorisés et conserve la trace des fichiers même s'ils disparaissent ultérieurement de Drive.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Clé interne de la version `(drive_file_id, md5_checksum)`. |
| `drive_file_id` | `varchar(128)` | `varchar('drive_file_id', { length: 128 }).notNull()` | NOT NULL | ID natif du fichier dans Google Drive. |
| `drive_folder_id` | `varchar(64)` | `varchar('drive_folder_id', { length: 64 }).notNull()` | NOT NULL, CHECK strict | ID du dossier parent (restreint aux 2 dossiers autorisés). |
| `bank` | `bank_enum` | `bankEnum('bank').notNull()` | NOT NULL, CHECK croisé | Banque déduite et vérifiée contre `drive_folder_id`. |
| `file_name` | `varchar(255)` | `varchar('file_name', { length: 255 }).notNull()` | NOT NULL | Nom du PDF sur Google Drive. |
| `md5_checksum` | `varchar(64)` | `varchar('md5_checksum', { length: 64 }).notNull()` | NOT NULL | Empreinte MD5 fournie par l'API Google Drive (détection de modification/skip sans appel Gemini). |
| `file_size_bytes` | `bigint` | `bigint('file_size_bytes', { mode: 'number' }).notNull()` | NOT NULL, `CHECK (file_size_bytes >= 0)` | Taille du PDF en octets. |
| `drive_modified_time` | `timestamptz` | `timestamp('drive_modified_time', { withTimezone: true }).notNull()` | NOT NULL | Date de modification sur Drive. |
| `is_missing_on_drive` | `boolean` | `boolean('is_missing_on_drive').notNull().default(false)` | NOT NULL, DEFAULT `false` | Passe à `true` si absent lors d'un scan ultérieur ; **aucune suppression** des transactions liées. |
| `last_seen_in_run_id` | `uuid` | `uuid('last_seen_in_run_id').notNull().references(() => driveSyncRuns.id)` | FK -> `drive_sync_runs.id` | Dernier run ayant observé ce fichier. |
| `first_committed_at` | `timestamptz` | `timestamp('first_committed_at', { withTimezone: true })` | NULL | Date du premier commit SQL réussi. |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur delta sync (statut Drive). |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Création de l'enregistrement. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Mise à jour métadonnées. |

- **Contraintes `UNIQUE`** :
  - `uq_drive_files_file_md5` : `UNIQUE (drive_file_id, md5_checksum)`
- **Contraintes `CHECK` critiques (Exclusivité Drive)** :
  - `chk_drive_files_exclusive_folders` :
    ```sql
    CHECK (drive_folder_id IN (
      '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus',
      '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h'
    ))
    ```
  - `chk_drive_files_folder_bank_match` :
    ```sql
    CHECK (
      (drive_folder_id = '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus' AND bank = 'boursobank')
      OR
      (drive_folder_id = '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h' AND bank = 'revolut')
    )
    ```
- **Index** :
  - `idx_drive_files_folder_missing` : `INDEX (drive_folder_id, is_missing_on_drive)`
  - `idx_drive_files_revision` : `INDEX (revision)`

---

### 3.5 `pdf_ingestion_checkpoints` — Checkpoints granulaires d'ingestion PDF Gemini

Garantit qu'un échec sur 1 PDF n'impacte aucun autre fichier et permet le bouton *« Réessayer ce fichier »* sans re-consommer Gemini si le parsing a déjà réussi.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant du checkpoint. |
| `drive_file_record_id` | `uuid` | `uuid('drive_file_record_id').notNull().unique().references(() => driveFiles.id, { onDelete: 'restrict' })` | UNIQUE, FK -> `drive_files.id` | 1 checkpoint par couple `(drive_file_id, md5_checksum)`. |
| `last_run_id` | `uuid` | `uuid('last_run_id').notNull().references(() => driveSyncRuns.id, { onDelete: 'restrict' })` | FK -> `drive_sync_runs.id` | Dernier run ayant tenté de traiter ce fichier. |
| `status` | `checkpoint_status_enum` | `checkpointStatusEnum('status').notNull().default('pending')` | NOT NULL | `'pending' \| 'skipped' \| 'extracting' \| 'parsed' \| 'committing' \| 'committed' \| 'failed'`. |
| `attempt_count` | `integer` | `integer('attempt_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre de tentatives d'extraction/commit. |
| `total_pages` | `integer` | `integer('total_pages')` | NULL, `CHECK (total_pages IS NULL OR total_pages > 0)` | Nombre de pages du PDF analysé. |
| `parsed_payload_hash` | `varchar(64)` | `varchar('parsed_payload_hash', { length: 64 })` | NULL | Empreinte SHA-256 du JSON validé par Zod. |
| `parsed_payload_json` | `jsonb` | `jsonb('parsed_payload_json')` | NULL | Résultat structuré Gemini validé par Zod au statut `'parsed'` ; purgé (`NULL`) une fois `'committed'` pour alléger la base. |
| `statement_period_start` | `date` | `date('statement_period_start', { mode: 'string' })` | NULL | Date min couverte par le relevé. |
| `statement_period_end` | `date` | `date('statement_period_end', { mode: 'string' })` | NULL | Date max couverte par le relevé. |
| `detected_accounts_count` | `integer` | `integer('detected_accounts_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre de sous-comptes extraits du PDF. |
| `inserted_tx_count` | `integer` | `integer('inserted_tx_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre d'opérations nouvellement insérées. |
| `dedup_skipped_tx_count` | `integer` | `integer('dedup_skipped_tx_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre d'opérations ignorées car déjà présentes (`dedup_hash`). |
| `error_code` | `varchar(64)` | `varchar('error_code', { length: 64 })` | NULL | Liste canonique unique : `'GEMINI_TIMEOUT' \| 'GEMINI_SCHEMA_INVALID' \| 'GEMINI_QUOTA_EXCEEDED' \| 'PDF_UNREADABLE' \| 'DRIVE_DOWNLOAD_ERROR'`. |
| `error_message` | `text` | `text('error_message')` | NULL | Message détaillé affiché dans l'onglet *Synchro Drive*. |
| `started_at` | `timestamptz` | `timestamp('started_at', { withTimezone: true })` | NULL | Début de la tentative en cours/dernière. |
| `committed_at` | `timestamptz` | `timestamp('committed_at', { withTimezone: true })` | NULL | Date de commit définitif. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Dernier changement d'état. |

- **Contraintes `CHECK`** :
  - `chk_checkpoint_committed_ts` : `CHECK (status <> 'committed' OR committed_at IS NOT NULL)`
  - `chk_checkpoint_failed_code` : `CHECK (status <> 'failed' OR error_code IS NOT NULL)`
  - `chk_checkpoint_error_code_enum` : `CHECK (error_code IS NULL OR error_code IN ('GEMINI_TIMEOUT', 'GEMINI_SCHEMA_INVALID', 'GEMINI_QUOTA_EXCEEDED', 'PDF_UNREADABLE', 'DRIVE_DOWNLOAD_ERROR'))`
- **Index** :
  - `idx_checkpoints_status` : `INDEX (status, updated_at DESC)`

---

### 3.6 `transactions` — Grand Livre Comptable Consolidé

Table centrale des opérations bancaires, en centimes entiers dans la devise du compte + équivalent EUR figé à l'ingestion.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant unique de l'opération. |
| `account_id` | `uuid` | `uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' })` | FK -> `accounts.id`, NOT NULL | Compte propriétaire (porte `bank` et `account_type`). |
| `source_drive_file_id` | `uuid` | `uuid('source_drive_file_id').notNull().references(() => driveFiles.id, { onDelete: 'restrict' })` | FK -> `drive_files.id`, NOT NULL | PDF d'origine ayant inséré cette ligne en premier. |
| `booking_date` | `date` | `date('booking_date', { mode: 'string' }).notNull()` | NOT NULL | Date d'opération (sert au taux FX et aux graphiques). |
| `value_date` | `date` | `date('value_date', { mode: 'string' })` | NULL | Date de valeur si présente sur le relevé. |
| `raw_label` | `text` | `text('raw_label').notNull()` | NOT NULL | Libellé complet brut extrait du relevé PDF. |
| `clean_label` | `varchar(255)` | `varchar('clean_label', { length: 255 }).notNull()` | NOT NULL | Libellé nettoyé lisible (utilisé pour l'affichage liste et le pré-remplissage de règles). |
| `amount_cents` | `bigint` | `bigint('amount_cents', { mode: 'number' }).notNull()` | NOT NULL, `CHECK (amount_cents <> 0)` | Montant signé en centimes dans `currency` (`< 0` débit, `> 0` crédit). |
| `currency` | `currency_enum` | `currencyEnum('currency').notNull()` | NOT NULL | `'EUR'` ou `'USD'` (doit correspondre à `accounts.currency`). |
| `fx_rate_micro` | `bigint` | `bigint('fx_rate_micro', { mode: 'number' }).notNull()` | NOT NULL, `CHECK (fx_rate_micro > 0)` | `1_000_000` si `currency = 'EUR'` ; sinon taux `USD -> EUR` figé à `booking_date`. |
| `amount_eur_cents` | `bigint` | `bigint('amount_eur_cents', { mode: 'number' }).notNull()` | NOT NULL | Contre-valeur figée en centimes EUR : `amount_cents` si EUR, sinon `ROUND(amount_cents * fx_rate_micro / 1_000_000)`. |
| `category` | `varchar(64)` | `varchar('category', { length: 64 }).notNull().default('Non catégorisé')` | NOT NULL | Catégorie affichée (ex. `'Alimentation'`, `'Logement'`, `'Transport'`, `'Transfert interne'`, `'Revenus'`, etc.). |
| `matched_rule_id` | `uuid` | `uuid('matched_rule_id').references(() => categorizationRules.id, { onDelete: 'set null' })` | FK -> `categorization_rules.id`, NULL | Règle ayant attribué `category` (`NULL` si choix manuel, défaut ou transfert interne auto). |
| `is_manual_category` | `boolean` | `boolean('is_manual_category').notNull().default(false)` | NOT NULL, DEFAULT `false` | **Verrou anti-écrasement** : si `true`, aucune règle rétroactive ne peut modifier `category`. |
| `is_internal_transfer` | `boolean` | `boolean('is_internal_transfer').notNull().default(false)` | NOT NULL, DEFAULT `false` | `true` pour virements internes BoursoBank ↔ Revolut, inter-comptes, épargne et changes EUR ↔ USD. Exclu des totaux de dépenses. |
| `is_manual_transfer_override` | `boolean` | `boolean('is_manual_transfer_override').notNull().default(false)` | NOT NULL, DEFAULT `false` | `true` si l'utilisateur a explicitement forcé ou retiré le statut `is_internal_transfer`. |
| `transfer_group_id` | `uuid` | `uuid('transfer_group_id')` | NULL | UUID partagé par les deux jambes d'un transfert interne apparié (ou d'un change EUR ↔ USD). |
| `statement_occurrence_index` | `integer` | `integer('statement_occurrence_index').notNull().default(1)` | NOT NULL, `CHECK (statement_occurrence_index >= 1)` | Rang d'occurrence intra-journée/relevé pour opérations identiques le même jour. |
| `dedup_hash` | `varchar(64)` | `varchar('dedup_hash', { length: 64 }).notNull().unique()` | UNIQUE, NOT NULL | SHA-256 hex déterministe anti-doublon (cf. §4). |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur monotone delta sync. |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Date d'insertion en base. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Dernière modification. |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true })` | NULL | Soft delete pour delta sync mobile. |

- **Contraintes `CHECK`** :
  - `chk_tx_amount_nonzero` : `CHECK (amount_cents <> 0)`
  - `chk_tx_fx_positive` : `CHECK (fx_rate_micro > 0)`
  - `chk_tx_eur_identity` : `CHECK (currency <> 'EUR' OR (fx_rate_micro = 1000000 AND amount_eur_cents = amount_cents))`
  - `chk_tx_occurrence_min` : `CHECK (statement_occurrence_index >= 1)`
- **Index de performance (Grand Livre, Recharts 6M & M-1/3M, Appariement Transferts, Delta Pull)** :
  - `idx_tx_account_date` : `INDEX (account_id, booking_date DESC) WHERE deleted_at IS NULL`
  - `idx_tx_booking_date` : `INDEX (booking_date DESC) WHERE deleted_at IS NULL`
  - `idx_tx_aggregates` : `INDEX (is_internal_transfer, booking_date, category) WHERE deleted_at IS NULL`
  - `idx_tx_transfer_group` : `INDEX (transfer_group_id) WHERE transfer_group_id IS NOT NULL AND deleted_at IS NULL`
  - `idx_tx_transfer_candidates` : `INDEX (currency, booking_date, amount_cents) WHERE transfer_group_id IS NULL AND is_manual_transfer_override = false AND deleted_at IS NULL`
  - `idx_tx_rules_recalc` : `INDEX (is_manual_category, is_manual_transfer_override) WHERE deleted_at IS NULL AND transfer_group_id IS NULL`
  - `idx_tx_revision` : `INDEX (revision)`

---

### 3.7 `transaction_notes` — Notes personnalisées

Liées à une transaction (`1:0..1` via `UNIQUE(transaction_id)`), synchronisées en delta avec soft-delete en cas de suppression.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant unique de la note. |
| `transaction_id` | `uuid` | `uuid('transaction_id').notNull().unique().references(() => transactions.id, { onDelete: 'cascade' })` | UNIQUE, FK -> `transactions.id` | Une seule note active (ou soft-deleted) par opération. |
| `content` | `text` | `text('content').notNull()` | NOT NULL, `CHECK (char_length(trim(content)) > 0 AND char_length(content) <= 2000)` | Contenu texte brut (sanitizé à l'affichage). |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur monotone delta sync. |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Date de création. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Date de dernière édition. |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true })` | NULL | Soft delete quand l'utilisateur efface la note. |

- **Index** :
  - `idx_tx_notes_revision` : `INDEX (revision)`

---

### 3.8 `categorization_rules` — Règles de catégorisation automatiques & rétroactives

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant de la règle. |
| `name` | `varchar(100)` | `varchar('name', { length: 100 }).notNull()` | NOT NULL, `CHECK (char_length(trim(name)) > 0)` | Nom lisible dans l'onglet *Règles*. |
| `priority` | `integer` | `integer('priority').notNull().default(100)` | NOT NULL, `CHECK (priority >= 1 AND priority <= 10000)` | Plus petit = plus prioritaire (`ORDER BY priority ASC, created_at ASC, id ASC`). |
| `bank_filter` | `bank_enum` | `bankEnum('bank_filter')` | NULL | Filtre optionnel `'boursobank'` ou `'revolut'`. |
| `account_id_filter` | `uuid` | `uuid('account_id_filter').references(() => accounts.id, { onDelete: 'set null' })` | FK -> `accounts.id`, NULL | Filtre optionnel sur un compte précis. |
| `account_type_filter` | `account_type_enum` | `accountTypeEnum('account_type_filter')` | NULL | Filtre optionnel sur un type de compte (`'courant'`, `'carte_differee'`, etc.). |
| `pattern` | `varchar(200)` | `varchar('pattern', { length: 200 }).notNull()` | NOT NULL, `CHECK (char_length(trim(pattern)) > 0)` | Motif recherché sur `raw_label` / `clean_label` (insensible à la casse). |
| `match_mode` | `rule_match_mode_enum` | `ruleMatchModeEnum('match_mode').notNull().default('contains')` | NOT NULL | `'contains'`, `'starts_with'`, `'exact'` ou `'regex'` (validée sans backtracking catastrophique via RE2/borne de longueur). |
| `target_category` | `varchar(64)` | `varchar('target_category', { length: 64 }).notNull()` | NOT NULL, `CHECK (char_length(trim(target_category)) > 0)` | Catégorie appliquée en cas de correspondance. |
| `mark_as_internal_transfer` | `boolean` | `boolean('mark_as_internal_transfer').notNull().default(false)` | NOT NULL, DEFAULT `false` | Optionnel : permet aussi à une règle explicite de marquer un virement vers épargne externe comme transfert interne. |
| `is_active` | `boolean` | `boolean('is_active').notNull().default(true)` | NOT NULL, DEFAULT `true` | Activation/désactivation immédiate. |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur monotone delta sync. |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Date de création. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Date de dernière modification. |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true })` | NULL | Soft delete pour delta sync mobile. |

- **Index** :
  - `idx_rules_evaluation` : `INDEX (priority ASC, created_at ASC, id ASC) WHERE is_active = true AND deleted_at IS NULL`
  - `idx_rules_revision` : `INDEX (revision)`

---

### 3.9 `sync_meta` — Métadonnées de Synchronisation Delta Android

L'APK Android fonctionne exclusivement en lecture seule hors-ligne et en écritures strictement en ligne (zéro file locale de mutations, zéro table d'outbox ou de résolution de conflits). La table serveur `sync_meta` expose la révision de référence et la version de schéma pour le delta pull (`GET /api/sync/delta?since=<revision>`).

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `key` | `varchar(64)` | `varchar('key', { length: 64 }).primaryKey()` | PK, NOT NULL | Ex. `'ledger_state'`. |
| `last_recalculation_revision` | `bigint` | `bigint('last_recalculation_revision', { mode: 'number' }).notNull().default(0)` | NOT NULL | Dernière révision ayant déclenché un recalcul global. |
| `schema_version` | `varchar(32)` | `varchar('schema_version', { length: 32 }).notNull()` | NOT NULL | Version du contrat de données delta (`'1.0.0'`). |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()` | NOT NULL | Horodatage de mise à jour. |

---

## 4. Algorithmes & Invariants Métier Normatifs

### 4.1 Calcul du `dedup_hash` (Zéro Doublon Multi-Comptes / Multi-Devises)

1. **Normalisation du libellé (`normalizeLabel(rawLabel)`)** :
   - Passage en minuscules (`toLowerCase()`),
   - Décomposition Unicode NFKD et suppression des diacritiques (`[\u0300-\u036f]`),
   - Remplacement de toute séquence d'espaces/retours ligne/tabulations par un espace simple `' '`, puis `.trim()`.
2. **Compteur `statement_occurrence_index`** :
   - Lors du parsing d'un relevé PDF pour un compte `account_id`, les transactions extraites sont triées de façon déterministe par ordre d'apparition dans le relevé.
   - Pour chaque clé locale `(account_id, currency, booking_date, amount_cents, normalized_label)`, le compteur démarre à `1` et s'incrémente (`1, 2, 3...`) pour chaque ligne identique dans le même relevé.
   - Exemple : 2 achats carte identiques de `-250` cents (`-2,50 €`) chez le même boulanger le `2026-11-10` sur le même compte reçoivent les index `1` et `2` (deux `dedup_hash` distincts). Si le relevé du mois suivant chevauche le `2026-11-10` et contient à nouveau ces 2 lignes, elles produisent exactement les index `1` et `2` → **ignorées silencieusement** par `ON CONFLICT (dedup_hash) DO NOTHING`.
3. **Formule SHA-256 hex (64 caractères)** :
   ```text
   dedup_hash = SHA256(
     `${account_id}|${currency}|${booking_date}|${amount_cents}|${normalized_label}|${statement_occurrence_index}`
   )
   ```
4. **Règle de frontière de relevé chevauchant** :
   - Si deux relevés partiels se chevauchent sur une même journée avec exactement les mêmes opérations identiques depuis le début de la journée, les occurrences `1..k` coïncident parfaitement. Ce choix est garanti pour les relevés mensuels complets BoursoBank et Revolut (qui couvrent des journées calendaires entières).

---

### 4.2 Flux Transactionnel Atomique Drizzle (`commitParsedStatement`)

L'ingestion d'un PDF est scindée en **2 phases** afin de ne jamais maintenir de transaction SQL ouverte pendant le téléchargement Drive ou l'appel réseau Gemini :

1. **Phase hors-transaction SQL (`pending -> skipped | extracting -> parsed`)** :
   - Lecture `drive_files` + `pdf_ingestion_checkpoints`. Si `md5_checksum` existe déjà avec `status = 'committed'`, le fichier est marqué `'skipped'` dans le suivi du run (`files_skipped_unchanged + 1`) sans appel Gemini.
   - Passage atomique court `status = 'extracting'`, `attempt_count = attempt_count + 1`, `started_at = now()`, `last_run_id = runId`.
   - Téléchargement du PDF depuis Drive **uniquement** si `drive_folder_id` appartient à `{ '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus', '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h' }`.
   - Appel Gemini + validation stricte **Zod** du schéma de sortie (comptes détectés, soldes d'ouverture/clôture, opérations, taux FX éventuel sur relevé Revolut).
   - Résolution des taux manquants `USD -> EUR` via le cache `fx_rates` ou API de référence BCE (avec fallback `nearest_business_day` si week-end/jour férié).
   - Passage court à `status = 'parsed'`, sauvegarde de `parsed_payload_json` et `parsed_payload_hash`.
   - *(En cas de retry manuel après une panne DB survenue pendant le commit, si `status = 'parsed'` ou `'failed'` avec `parsed_payload_json IS NOT NULL` et même `md5_checksum`, le worker reprend directement à la Phase 2 sans rappeler Gemini !)*

2. **Phase transactionnelle SQL ACID (`db.transaction` sur Neon `Pool` WebSocket)** :
   - Mise à jour checkpoint `status = 'committing'`.
   - Pour chaque sous-compte extrait :
     - `INSERT INTO accounts (...) ON CONFLICT (bank, external_ref_masked, currency) DO UPDATE` :
       - Ne **jamais** écraser `nickname` si le compte existe déjà (respect du renommage utilisateur).
       - Mettre à jour `current_balance_cents`, `balance_updated_at` et `last_statement_closing_date` **uniquement si** `statement_period_end >= COALESCE(accounts.last_statement_closing_date, '1900-01-01')`.
       - Incrémenter `revision = nextval('sync_revision_seq')` si le compte est créé ou son solde modifié.
   - `INSERT INTO fx_rates (...) ON CONFLICT (rate_date, base_currency, quote_currency) DO NOTHING`.
   - Calcul de `amount_eur_cents` pour chaque opération :
     - Si `EUR` : `fx_rate_micro = 1_000_000`, `amount_eur_cents = amount_cents`.
     - Si `USD` : `amount_eur_cents = Math.round((amount_cents * fx_rate_micro) / 1_000_000)`.
   - Application en mémoire des `categorization_rules` actives sur les transactions candidates avant insertion (sauf statut transfert interne).
   - `INSERT INTO transactions (...) ON CONFLICT (dedup_hash) DO NOTHING RETURNING id`.
   - Exécution de la passe d'appariement des transferts internes & changes EUR ↔ USD (cf. §4.4) dans la même transaction.
   - Mise à jour checkpoint : `status = 'committed'`, `committed_at = now()`, `parsed_payload_json = NULL`, compteurs `inserted_tx_count` / `dedup_skipped_tx_count`, `error_code = NULL`, `error_message = NULL`.
   - Mise à jour `drive_files.first_committed_at = COALESCE(first_committed_at, now())`, `revision = nextval('sync_revision_seq')`.
   - Si une exception survient (téléchargement Drive, quota/timeout/schéma Gemini, PDF illisible ou erreur de persistance) : rollback intégral automatique de toute transaction SQL ouverte, puis requête courte hors-transaction pour passer le checkpoint à `'failed'` avec l'un des codes canoniques (`GEMINI_TIMEOUT`, `GEMINI_SCHEMA_INVALID`, `GEMINI_QUOTA_EXCEEDED`, `PDF_UNREADABLE`, `DRIVE_DOWNLOAD_ERROR`) et `error_message`.

---

### 4.3 Recalcul Rétroactif des Règles de Catégorisation (`reapplyRulesRetroactively`)

Exécuté dans une `db.transaction(...)` à chaque création, modification, activation, désactivation ou suppression de règle (et via le bouton explicite *« Appliquer à l'historique »*) :

1. Charger toutes les règles actives triées par `priority ASC, created_at ASC, id ASC`.
2. Sélectionner les transactions éligibles :
   ```sql
   WHERE deleted_at IS NULL
     AND is_manual_category = false
     AND transfer_group_id IS NULL
     AND is_manual_transfer_override = false
   ```
   > [!IMPORTANT]
   > **Protection absolue des choix manuels & des paires appariées** : toute transaction dont `is_manual_category = true` est **strictement exclue** du recalcul rétroactif. Les paires de transferts appariées (`transfer_group_id IS NOT NULL`) et les statuts forcés manuellement (`is_manual_transfer_override = true`) sont également préservés. En revanche, une transaction marquée `is_internal_transfer = true` par une règle (`mark_as_internal_transfer = true`, avec `transfer_group_id IS NULL` et `is_manual_transfer_override = false`) est bien réévaluée si la règle est modifiée, désactivée ou supprimée.
3. Évaluer les règles pour chaque transaction éligible (première règle correspondante gagnante ; si aucune règle ne correspond et que la transaction avait `matched_rule_id IS NOT NULL`, elle revient à `'Non catégorisé'`, `matched_rule_id = NULL`, et `is_internal_transfer = false`).
4. **Optimisation delta sync** : n'exécuter `UPDATE transactions` (et n'allouer un nouveau `revision = nextval('sync_revision_seq')`) **que pour les lignes** dont `(category, matched_rule_id, is_internal_transfer)` a réellement changé (`IS DISTINCT FROM`). Cela évite de gonfler artificiellement le payload delta Android lors de l'édition d'une règle ciblée.

---

### 4.4 Appariement des Transferts Internes & Changes `EUR ↔ USD` (`reconcileInternalTransfers`)

Exécuté dans la transaction de commit PDF (et rejouable à la demande) sur les transactions sans groupe (`transfer_group_id IS NULL`) et sans verrou manuel (`is_manual_transfer_override = false`) :

#### Cas A — Transfert interne même devise (BoursoBank ↔ Revolut, inter-comptes BoursoBank, Courant ↔ Coffre)

Deux transactions `A` et `B` actives (`deleted_at IS NULL`) sont appariées en 1-to-1 si :
1. `A.account_id <> B.account_id` (deux comptes distincts de l'utilisateur) ;
2. `A.currency = B.currency` ;
3. `A.amount_cents = -B.amount_cents` (l'un négatif, l'autre positif, montant exact au centime près) ;
4. `ABS(A.booking_date - B.booking_date) <= 3` jours (tolérance délai virement SEPA interbancaire) ;
5. En cas d'ambiguïté (plusieurs candidats de même montant dans la fenêtre), priorité à l'écart de date minimal `ABS(A.booking_date - B.booking_date)` puis à la proximité d'insertion.

#### Cas B — Change interne Revolut `EUR ↔ USD`

Deux transactions `A` et `B` actives sont appariées en 1-to-1 si :
1. `A.bank = 'revolut' AND B.bank = 'revolut'` (via jointure `accounts`) ;
2. `A.currency <> B.currency` (l'une en `'EUR'`, l'autre en `'USD'`) ;
3. Signes opposés : `(A.amount_cents < 0 AND B.amount_cents > 0) OR (A.amount_cents > 0 AND B.amount_cents < 0)` ;
4. `ABS(A.booking_date - B.booking_date) <= 1` jour ;
5. Indice lexical de change sur au moins un des deux libellés normalisés (`'exchanged to'`, `'conversion'`, `'fx'`, `'change'`, `'eur'`, `'usd'`) **ET** cohérence de contre-valeur EUR :
   ```text
   |A.amount_eur_cents + B.amount_eur_cents| <= max(200, round(0.03 * max(|A.amount_eur_cents|, |B.amount_eur_cents|)))
   ```
   *(Tolérance de 2,00 € minimum ou 3 % absorbant la majoration week-end / écart de cours entre taux instantané Revolut et taux journalier BCE.)*

#### Effet de l'appariement (Cas A & Cas B)

- Génération d'un `groupId = crypto.randomUUID()`.
- Mise à jour atomique des deux lignes :
  - `transfer_group_id = groupId`
  - `is_internal_transfer = true`
  - `category = CASE WHEN is_manual_category THEN category ELSE 'Transfert interne' END`
  - `matched_rule_id = CASE WHEN is_manual_category THEN matched_rule_id ELSE NULL END`
  - `revision = nextval('sync_revision_seq')`, `updated_at = now()`
- **Impact comptable** :
  - `accounts.current_balance_cents` reflète toujours les soldes réels de chaque poche/compte.
  - Les agrégats de dépenses (`Dépenses M-1 / Moyenne 3M` et KPI *Dépenses hors transferts*) filtrent strictement `WHERE is_internal_transfer = false AND amount_cents < 0 AND deleted_at IS NULL`.
  - Si l'utilisateur corrige manuellement une opération (`PATCH /api/transactions/:id` avec `is_internal_transfer = false`), `is_manual_transfer_override` passe à `true`, `transfer_group_id` est dissocié sur la paire si nécessaire, et la réconciliation automatique ne retouchera jamais cette transaction.
