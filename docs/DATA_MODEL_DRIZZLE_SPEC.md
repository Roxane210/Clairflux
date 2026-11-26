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
      '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h',
      '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus'
    ))
    ```
  - `chk_drive_files_folder_bank_match` :
    ```sql
    CHECK (
      (drive_folder_id = '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h' AND bank = 'boursobank')
      OR
      (drive_folder_id = '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus' AND bank = 'revolut')
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

---

## Partie II — Extension v2 : Catégories hiérarchiques, IA Gemini, Budget Monarch & Analytique

- **Statut** : Normatif — Phase Pré-Code EGM v2
- **Date** : 2026-11-26
- **Références associées** :
  - [API_DELTA_SYNC_CONTRACT.md (Section 8)](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)
  - [ADR 0005 — Catégories hiérarchiques & IA Gemini hybride](file:///d:/Applications/Clairflux/docs/ADR/0005-categories-hierarchy-and-gemini-hybrid-categorization.md)
  - [ADR 0006 — Budget Monarch, Rollover & Projections](file:///d:/Applications/Clairflux/docs/ADR/0006-monarch-budget-rollover-and-forecasting.md)

> [!IMPORTANT]
> La Partie I ci-dessus demeure intégralement valide. Cette Partie II étend le modèle de données PostgreSQL Neon / Drizzle ORM sans rupture des entités v1 existantes ni perte de données.

---

### 5. État Réel en Production & Plan de Migration SQL Expand/Contract

#### 5.1 Inventaire Réel de Production (`apps/api/src/db/schema.ts`)

Au-delà des tables 3.1 à 3.9 de la spécification initiale v1, deux tables déjà déployées en production dans [schema.ts](file:///d:/Applications/Clairflux/apps/api/src/db/schema.ts) doivent être explicitement préservées durant toute la phase Expand :

1. **`budget_limits` (`budgetLimits`)** — Plafonds budgétaires mensuels v1 par libellé texte :
   - `id` (`uuid`, PK `defaultRandom()`)
   - `category` (`varchar(80)`, NOT NULL, `UNIQUE`, `CHECK (char_length(trim(category)) > 0)`)
   - `limit_cents` (`bigint({ mode: 'number' })`, NOT NULL, `CHECK (limit_cents > 0)`)
   - `currency` (`currency_enum`, NOT NULL, DEFAULT `'EUR'`)
   - `revision` (`bigint({ mode: 'number' })`, NOT NULL, DEFAULT `nextval('sync_revision_seq')`, index `idx_budget_limits_revision`)
   - `updated_at` (`timestamptz`, NOT NULL, DEFAULT `now()`)
   - *Rôle actuel* : alimentée par `GET/PUT/DELETE /api/budgets` ([register-routes.ts](file:///d:/Applications/Clairflux/apps/api/src/routes/register-routes.ts)) et comptabilisée dans `fetchLatestSyncRevision`.

2. **`applied_client_mutations` (`appliedClientMutations`)** — Journal d'idempotence de l'outbox client :
   - `client_mutation_id` (`uuid`, PK)
   - `payload_hash` (`varchar(64)`, NOT NULL, `CHECK (char_length(trim(payload_hash)) > 0)`)
   - `applied_at` (`timestamptz`, NOT NULL, DEFAULT `now()`, index `idx_applied_client_mutations_applied_at`)
   - `result_status` (`varchar(24)`, NOT NULL, `CHECK (result_status IN ('applied', 'duplicate', 'rejected'))`)
   - `result_revision` (`bigint({ mode: 'number' })`, NOT NULL)
   - *Rôle actuel* : garantit l'idempotence exacte de `POST /api/sync/delta` pour les mutations hors-ligne (`upsert_note`, `set_category`, `set_internal_transfer` issues du store IndexedDB `outbox_mutations` dans [indexedDbStore.ts](file:///d:/Applications/Clairflux/apps/web/src/offline/indexedDbStore.ts)). **Cette table est conservée définitivement en v2** pour garantir la rétrocompatibilité et la continuité de l'outbox existante.

#### 5.2 Stratégie de Migration SQL Versionnée (Expand / Contract)

Conformément à [drizzle.config.ts](file:///d:/Applications/Clairflux/apps/api/drizzle.config.ts) (`out: './src/db/migrations'`, `strict: true`, `sslmode=require`), toute évolution passe exclusivement par `drizzle-kit generate` + `drizzle-kit migrate` (**zéro `drizzle-kit push` destructif en production**) :

| Phase | Opérations SQL | Impact sur la production active |
| :--- | :--- | :--- |
| **1. Expand (Non destructif)** | Création des 6 nouveaux `pgEnum`, création des 7 nouvelles tables (`categories`, `ai_categorization_runs`, `ai_rule_suggestions`, `budget_configs`, `budget_monthly_overrides`, `recurring_series`, `ai_monthly_briefs`), ajout de colonnes `NULL` ou avec `DEFAULT` sûr sur `transactions` et `categorization_rules`, création des index partiels et du trigger de profondeur `<= 2`. | Zéro verrouillage long, zéro suppression de colonne, 100 % compatible avec les binaires API/Worker v1 pendant le déploiement. |
| **2. Backfill Idempotent** | Transaction SQL dédiée : (a) seed du pack de catégories françaises 2 niveaux (`is_system = true`) ; (b) création automatique des éventuelles catégories personnalisées trouvées dans `transactions.category`, `categorization_rules.target_category` ou `budget_limits.category` ; (c) remplissage de `transactions.category_id`, `category_source` (`'manual'` si `is_manual_category = true`, `'rule'` si `matched_rule_id IS NOT NULL`, sinon `'uncategorized'`) et `categorization_rules.target_category_id` ; (d) copie `budget_limits` → `budget_configs` (`rollover_enabled = false`, `ON CONFLICT DO NOTHING`). | Zéro perte d'historique, zéro appel Gemini requis pour le backfill structurel. |
| **3. Dual-Write & Cohabitation** | Les routes v2 écrivent simultanément `category_id` / `subcategory_id` **et** maintiennent synchronisé le libellé texte `transactions.category` / `categorization_rules.target_category` ainsi que la projection miroir `budget_limits` (pour les budgets racines) tant que des clients v1 (`delta_schema_version = '1.0.0'`) peuvent interroger l'API. | Rétrocompatibilité totale Web/APK v1 et v2, rollback applicatif possible sans perte. |
| **4. Contract (Jalon ultérieur v2.1+)** | Uniquement après validation PO et bascule à 100 % des clients sur `CLAIRFLUX_DELTA_SCHEMA_VERSION = '2.0.0'` : dépréciation puis suppression planifiée de `budget_limits` dans une migration SQL versionnée distincte. | Aucune suppression prématurée durant les Lots 1 à 4. |

---

### 6. Nouveaux Types Énumérés PostgreSQL v2 (`pgEnum`)

| Nom SQL `pgEnum` | Nom Drizzle | Valeurs exactes | Usage |
| :--- | :--- | :--- | :--- |
| `budget_group_enum` | `budgetGroupEnum` | `'fixed'`, `'variable'`, `'non_monthly'`, `'income'`, `'savings'`, `'transfer'` | Classement Monarch des catégories pour la synthèse budgétaire et le Cash Flow / Sankey. |
| `category_source_enum` | `categorySourceEnum` | `'manual'`, `'rule'`, `'ai_auto'`, `'ai_validated'`, `'uncategorized'` | Traçabilité exacte de l'origine de la catégorie finale sur `transactions`. |
| `ai_review_status_enum` | `aiReviewStatusEnum` | `'none'`, `'pending_review'`, `'accepted'`, `'rejected'` | Cycle de vie de la Boîte de révision IA sur chaque transaction. |
| `ai_backfill_run_status_enum` | `aiBackfillRunStatusEnum` | `'running'`, `'completed'`, `'partial_error'`, `'failed'`, `'cancelled'` | État d'avancement d'un rattrapage manuel Gemini par lots de 50 opérations. |
| `recurring_cadence_enum` | `recurringCadenceEnum` | `'weekly'`, `'monthly'`, `'quarterly'`, `'yearly'` | Périodicité des abonnements, loyers, charges et revenus récurrents. |
| `recurring_status_enum` | `recurringStatusEnum` | `'detected'`, `'confirmed'`, `'dismissed'`, `'cancelled'` | Statut utilisateur d'une série récurrente dans le Radar & Calendrier (`'cancelled'` = résiliée sans perte d'historique). |
| `recurring_source_enum` | `recurringSourceEnum` | `'auto_detected'`, `'manual'` | Origine de la série : détectée automatiquement depuis les relevés ou ajoutée manuellement en échéance anticipée. |
| `recurring_direction_enum` | `recurringDirectionEnum` | `'expense'`, `'income'` | Sens comptable de la série récurrente (`'expense'` = dépense, `'income'` = revenu récurrent). |

---

### 7. Spécification des Nouvelles Tables & Extensions v2

Toutes les entités synchronisables avec l'APK Android (`categories`, `budget_configs`, `budget_monthly_overrides`, `recurring_series`, `ai_monthly_briefs`, ainsi que les mises à jour de `transactions` et `categorization_rules`) portent une colonne `revision` (`bigint({ mode: 'number' }) NOT NULL DEFAULT nextval('sync_revision_seq')`) et un soft-delete `deleted_at` (`timestamptz`) pour la propagation delta incrémentale.

#### 7.1 `categories` — Arbre Libre à 2 Niveaux (Catégorie → Sous-catégorie)

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant stable de la catégorie ou sous-catégorie. |
| `parent_id` | `uuid` | `uuid('parent_id').references((): AnyPgColumn => categories.id, { onDelete: 'restrict' })` | FK self -> `categories.id`, NULL | `NULL` = Catégorie racine (niveau 1) ; non nul = Sous-catégorie (niveau 2). |
| `name` | `varchar(64)` | `varchar('name', { length: 64 }).notNull()` | NOT NULL, `CHECK (char_length(trim(name)) > 0)` | Libellé affiché à l'utilisateur (ex. `"Alimentation"`, `"Courses"`). |
| `slug` | `varchar(80)` | `varchar('slug', { length: 80 }).notNull()` | NOT NULL, `CHECK (char_length(trim(slug)) > 0)` | Identifiant canonique normalisé (ex. `"alimentation"`, `"alimentation-courses"`). |
| `budget_group` | `budget_group_enum` | `budgetGroupEnum('budget_group').notNull()` | NOT NULL | Groupe Monarch (`'fixed'`, `'variable'`, `'non_monthly'`, `'income'`, `'savings'`, `'transfer'`). |
| `color_token` | `varchar(32)` | `varchar('color_token', { length: 32 }).notNull().default('slate')` | NOT NULL, `CHECK (char_length(trim(color_token)) > 0)` | Token visuel de la palette UI ClairFlux (ex. `'emerald'`, `'amber'`, `'indigo'`, `'slate'`). |
| `sort_order` | `integer` | `integer('sort_order').notNull().default(0)` | NOT NULL, `CHECK (sort_order >= 0)` | Ordre d'affichage personnalisable dans l'arbre et le plan budgétaire. |
| `is_system` | `boolean` | `boolean('is_system').notNull().default(false)` | NOT NULL, DEFAULT `false` | `true` pour les catégories structurelles protégées (`Non catégorisé`, `Transfert interne`) et le pack de départ (seules `Non catégorisé` et `Transfert interne` ne peuvent pas être supprimées). |
| `is_archived` | `boolean` | `boolean('is_archived').notNull().default(false)` | NOT NULL, DEFAULT `false` | Masque une catégorie des nouveaux choix tout en préservant l'historique comptable. |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur delta sync. |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Date de création. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Date de dernière modification. |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true, mode: 'date' })` | NULL | Soft-delete pour propagation mobile après fusion/suppression avec réaffectation. |

- **Contraintes `CHECK` & Règle de Profondeur Max 2 Niveaux** :
  - `chk_categories_name_non_empty` : `CHECK (char_length(trim(name)) > 0)`
  - `chk_categories_slug_non_empty` : `CHECK (char_length(trim(slug)) > 0)`
  - `chk_categories_color_non_empty` : `CHECK (char_length(trim(color_token)) > 0)`
  - `chk_categories_sort_non_negative` : `CHECK (sort_order >= 0)`
  - `chk_categories_no_self_parent` : `CHECK (parent_id IS NULL OR parent_id <> id)`
  - **Verrou SQL strict profondeur `<= 2`** (trigger `BEFORE INSERT OR UPDATE` `enforce_category_max_depth_2`) :
    1. Si `NEW.parent_id IS NOT NULL`, vérifie que la ligne parente existe (`deleted_at IS NULL`) **et** possède `parent_id IS NULL` (interdit le niveau 3).
    2. Si `NEW.parent_id IS NOT NULL`, vérifie qu'aucune ligne active n'a déjà `parent_id = NEW.id` (empêche de rétrograder une racine ayant déjà des enfants).
- **Index & Unicité** :
  - `uq_categories_active_slug` : `UNIQUE INDEX (slug) WHERE deleted_at IS NULL`
  - `uq_categories_active_sibling_name` : `UNIQUE INDEX (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name))) WHERE deleted_at IS NULL`
  - `idx_categories_parent_sort` : `INDEX (parent_id, sort_order) WHERE deleted_at IS NULL`
  - `idx_categories_budget_group` : `INDEX (budget_group) WHERE deleted_at IS NULL`
  - `idx_categories_revision` : `INDEX (revision)`

#### 7.2 `ai_categorization_runs` — Suivi du Rattrapage Manuel Gemini par Lots de 50

Trace chaque rattrapage lancé manuellement par l'utilisateur sur l'historique existant (ex. les ~2 940 opérations non catégorisées) avec reprise sur curseur en cas d'erreur ou d'annulation.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant unique du run de rattrapage IA. |
| `cursor_tx_id` | `uuid` | `uuid('cursor_tx_id')` | NULL | Dernier `transactions.id` traité avec succès (curseur de reprise par lots de 50). |
| `total_target_count` | `integer` | `integer('total_target_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre initial de transactions éligibles identifiées au démarrage du run. |
| `processed_count` | `integer` | `integer('processed_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre cumulé d'opérations évaluées par Gemini. |
| `auto_applied_count` | `integer` | `integer('auto_applied_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Opérations classées automatiquement (`ai_confidence_bp >= 8500`). |
| `queued_review_count` | `integer` | `integer('queued_review_count').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Opérations placées en Boîte de révision (`ai_confidence_bp < 8500`). |
| `failed_batches` | `integer` | `integer('failed_batches').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Nombre de lots de 50 ayant échoué après épuisement de la chaîne de fallback. |
| `model_used` | `varchar(64)` | `varchar('model_used', { length: 64 })` | NULL | Dernier modèle ayant répondu (`gemini-4-hydrogen`, `gemini-3.8-flash`, `gemini-3.1-flash-lite`). |
| `estimated_tokens` | `integer` | `integer('estimated_tokens').notNull().default(0)` | NOT NULL, `CHECK >= 0` | Compteur cumulé de tokens estimés/consommés (suivi coût & plafond de sécurité). |
| `status` | `ai_backfill_run_status_enum` | `aiBackfillRunStatusEnum('status').notNull().default('running')` | NOT NULL | `'running' \| 'completed' \| 'partial_error' \| 'failed' \| 'cancelled'`. |
| `error_summary` | `text` | `text('error_summary')` | NULL | Détail lisible des éventuelles erreurs de lot ou d'arrêt. |
| `started_at` | `timestamptz` | `timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Horodatage de lancement manuel. |
| `finished_at` | `timestamptz` | `timestamp('finished_at', { withTimezone: true, mode: 'date' })` | NULL | Horodatage de fin (`NULL` tant que `'running'`). |

- **Contraintes & Index** :
  - `chk_ai_runs_counts_non_negative` : `CHECK (total_target_count >= 0 AND processed_count >= 0 AND auto_applied_count >= 0 AND queued_review_count >= 0 AND failed_batches >= 0 AND estimated_tokens >= 0)`
  - `chk_ai_runs_sum_bound` : `CHECK (auto_applied_count + queued_review_count <= processed_count)`
  - `chk_ai_runs_finished_ts` : `CHECK (status = 'running' OR finished_at IS NOT NULL)`
  - `uq_ai_runs_single_running` : `UNIQUE INDEX ((true)) WHERE status = 'running'` (garantit au niveau SQL qu'un seul rattrapage manuel peut tourner simultanément — sinon `409 Conflict`).
  - `idx_ai_runs_status_started` : `INDEX (status, started_at DESC)`

#### 7.3 `ai_rule_suggestions` — Suggestions de Règles Déterministes Gratuites

Alimentée lorsqu'un même motif marchand est validé ou corrigé de façon répétée dans la Boîte de révision afin de remplacer à terme les appels Gemini par une règle SQL gratuite.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant de la suggestion. |
| `suggested_pattern` | `varchar(200)` | `varchar('suggested_pattern', { length: 200 }).notNull()` | NOT NULL, `CHECK (char_length(trim(suggested_pattern)) > 0)` | Motif marchand normalisé proposé (ex. `"CARREFOUR CITY"`). |
| `match_mode` | `rule_match_mode_enum` | `ruleMatchModeEnum('match_mode').notNull().default('contains')` | NOT NULL | Mode de correspondance recommandé (`'contains'` ou `'starts_with'`). |
| `target_category_id` | `uuid` | `uuid('target_category_id').notNull().references(() => categories.id, { onDelete: 'restrict' })` | FK -> `categories.id`, NOT NULL | Catégorie cible proposée. |
| `target_subcategory_id` | `uuid` | `uuid('target_subcategory_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Sous-catégorie cible optionnelle. |
| `sample_count` | `integer` | `integer('sample_count').notNull().default(1)` | NOT NULL, `CHECK (sample_count >= 1)` | Nombre d'occurrences concordantes observées. |
| `status` | `varchar(16)` | `varchar('status', { length: 16 }).notNull().default('pending')` | NOT NULL, `CHECK (status IN ('pending', 'accepted', 'dismissed'))` | État de la suggestion. |
| `accepted_rule_id` | `uuid` | `uuid('accepted_rule_id').references(() => categorizationRules.id, { onDelete: 'set null' })` | FK -> `categorization_rules.id`, NULL | Référence de la règle créée lors de l'acceptation. |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur de révision. |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Date de détection. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Date de dernière mise à jour. |

- **Contraintes & Index** :
  - `chk_ai_rule_suggestions_pattern_non_empty` : `CHECK (char_length(trim(suggested_pattern)) > 0)`
  - `chk_ai_rule_suggestions_sample_min` : `CHECK (sample_count >= 1)`
  - `chk_ai_rule_suggestions_status` : `CHECK (status IN ('pending', 'accepted', 'dismissed'))`
  - `chk_ai_rule_suggestions_distinct_subcat` : `CHECK (target_subcategory_id IS NULL OR target_subcategory_id <> target_category_id)`
  - `uq_ai_rule_suggestions_active` : `UNIQUE INDEX (lower(suggested_pattern), match_mode, target_category_id) WHERE status = 'pending'`
  - `idx_ai_rule_suggestions_status` : `INDEX (status, sample_count DESC)`
  - `idx_ai_rule_suggestions_revision` : `INDEX (revision)`

#### 7.4 `budget_configs` — Enveloppes Budgétaires Monarch & Paramètres de Rollover

Remplace/étend `budget_limits` en Expand/Contract. Peut être définie au niveau d'une **Catégorie racine** (`parent_id IS NULL`) et, en option, sur une **Sous-catégorie** (`parent_id IS NOT NULL`) en tant que sous-plafond sans double-comptage parent (cf. §8.1).

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant unique de configuration budgétaire. |
| `category_id` | `uuid` | `uuid('category_id').notNull().references(() => categories.id, { onDelete: 'restrict' })` | FK -> `categories.id`, NOT NULL | Catégorie ou sous-catégorie budgétée (`UNIQUE` active). |
| `monthly_limit_cents` | `bigint` | `bigint('monthly_limit_cents', { mode: 'number' }).notNull()` | NOT NULL, `CHECK (monthly_limit_cents > 0)` | Plafond mensuel récurrent en centimes entiers (`> 0`). |
| `currency` | `currency_enum` | `currencyEnum('currency').notNull().default('EUR')` | NOT NULL, DEFAULT `'EUR'` | Devise de référence de l'enveloppe (`'EUR'` ou `'USD'`). |
| `rollover_enabled` | `boolean` | `boolean('rollover_enabled').notNull().default(false)` | NOT NULL, DEFAULT `false` | Active le report cumulatif mensuel des excédents/déficits. |
| `rollover_start_month` | `varchar(7)` | `varchar('rollover_start_month', { length: 7 })` | NULL, `CHECK (~ '^\d{4}-(0[1-9]\|1[0-2])$')` | Mois `YYYY-MM` d'initialisation du cumul de rollover (obligatoire si `rollover_enabled = true`). |
| `rollover_cap_cents` | `bigint` | `bigint('rollover_cap_cents', { mode: 'number' })` | NULL, `CHECK (rollover_cap_cents IS NULL OR rollover_cap_cents >= 0)` | Plafond maximal optionnel du report positif accumulé (ex. cagnotte vacances). |
| `is_active` | `boolean` | `boolean('is_active').notNull().default(true)` | NOT NULL, DEFAULT `true` | Permet de mettre en pause une enveloppe sans perdre ses overrides historiques. |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur delta sync. |
| `created_at` | `timestamptz` | `timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Date de création. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Date de dernière modification. |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true, mode: 'date' })` | NULL | Soft-delete pour propagation delta mobile. |

- **Contraintes & Index** :
  - `uq_budget_configs_active_category` : `UNIQUE INDEX (category_id) WHERE deleted_at IS NULL`
  - `chk_budget_configs_limit_positive` : `CHECK (monthly_limit_cents > 0)`
  - `chk_budget_configs_rollover_cap_non_negative` : `CHECK (rollover_cap_cents IS NULL OR rollover_cap_cents >= 0)`
  - `chk_budget_configs_rollover_start_format` : `CHECK (rollover_start_month IS NULL OR rollover_start_month ~ '^\d{4}-(0[1-9]|1[0-2])$')`
  - `chk_budget_configs_rollover_requires_start` : `CHECK (rollover_enabled = false OR rollover_start_month IS NOT NULL)`
  - `idx_budget_configs_revision` : `INDEX (revision)`

#### 7.5 `budget_monthly_overrides` — Ajustements Ponctuels & Corrections de Rollover

Permet de surcharger le plafond sur un mois donné (ex. mois de décembre ou vacances) ou d'injecter/remettre à zéro manuellement un solde reporté (`rollover_adjustment_cents`).

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant de la surcharge mensuelle. |
| `budget_config_id` | `uuid` | `uuid('budget_config_id').notNull().references(() => budgetConfigs.id, { onDelete: 'cascade' })` | FK -> `budget_configs.id`, NOT NULL | Enveloppe budgétaire cible. |
| `budget_month` | `varchar(7)` | `varchar('budget_month', { length: 7 }).notNull()` | NOT NULL, `CHECK (~ '^\d{4}-(0[1-9]\|1[0-2])$')` | Mois calendaire concerné (`YYYY-MM`). |
| `override_limit_cents` | `bigint` | `bigint('override_limit_cents', { mode: 'number' })` | NULL, `CHECK (override_limit_cents IS NULL OR override_limit_cents >= 0)` | Plafond exceptionnel du mois (si `NULL`, conserve `budget_configs.monthly_limit_cents`). |
| `rollover_adjustment_cents` | `bigint` | `bigint('rollover_adjustment_cents', { mode: 'number' }).notNull().default(0)` | NOT NULL, DEFAULT `0` | Ajustement manuel **signé** en centimes appliqué au report du mois (`> 0` crédit, `< 0` débit/reset). |
| `note` | `varchar(300)` | `varchar('note', { length: 300 })` | NULL | Justification libre (ex. `"Budget cadeaux Noël"` ou `"Remise à zéro cagnotte"`). |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur delta sync. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Date de mise à jour. |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true, mode: 'date' })` | NULL | Soft-delete pour propagation delta mobile. |

- **Contraintes & Index** :
  - `uq_budget_monthly_overrides_config_month` : `UNIQUE (budget_config_id, budget_month)`
  - `chk_budget_overrides_month_format` : `CHECK (budget_month ~ '^\d{4}-(0[1-9]|1[0-2])$')`
  - `chk_budget_overrides_limit_non_negative` : `CHECK (override_limit_cents IS NULL OR override_limit_cents >= 0)`
  - `idx_budget_overrides_revision` : `INDEX (revision)`

#### 7.6 `recurring_series` — Radar & Calendrier des Abonnements, Charges & Revenus Récurrents

Persiste les séries détectées automatiquement (avec tolérance anti-faux-positifs) ainsi que les échéances anticipées ajoutées manuellement (`source = 'manual'`), et permet leur confirmation, mise à l'écart, résiliation (`cancelled`) ou ajustement ainsi que le suivi des hausses de tarifs.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant unique de la série récurrente. |
| `merchant_key` | `varchar(160)` | `varchar('merchant_key', { length: 160 }).notNull()` | NOT NULL, `CHECK (char_length(trim(merchant_key)) > 0)` | Clé marchand normalisée déterministe (ex. `"spotify"`, `"edf"`, `"cursor ai"`). |
| `display_name` | `varchar(160)` | `varchar('display_name', { length: 160 }).notNull()` | NOT NULL, `CHECK (char_length(trim(display_name)) > 0)` | Libellé lisible affiché dans le Radar & Calendrier Récurrents. |
| `account_id` | `uuid` | `uuid('account_id').references(() => accounts.id, { onDelete: 'set null' })` | FK -> `accounts.id`, NULL | Compte habituellement débité/crédité. |
| `category_id` | `uuid` | `uuid('category_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Catégorie associée à la série. |
| `cadence` | `recurring_cadence_enum` | `recurringCadenceEnum('cadence').notNull()` | NOT NULL | `'weekly' \| 'monthly' \| 'quarterly' \| 'yearly'`. |
| `source` | `recurring_source_enum` | `recurringSourceEnum('source').notNull().default('auto_detected')` | NOT NULL, DEFAULT `'auto_detected'` | `'auto_detected'` (détecteur) ou `'manual'` (échéance anticipée saisie par l'utilisateur). |
| `direction` | `recurring_direction_enum` | `recurringDirectionEnum('direction').notNull().default('expense')` | NOT NULL, DEFAULT `'expense'` | `'expense'` (dépense récurrente) ou `'income'` (revenu récurrent). |
| `expected_amount_cents` | `bigint` | `bigint('expected_amount_cents', { mode: 'number' }).notNull()` | NOT NULL, `CHECK (expected_amount_cents <> 0)` | Montant attendu signé en centimes (`< 0` si `direction = 'expense'`, `> 0` si `direction = 'income'`). |
| `currency` | `currency_enum` | `currencyEnum('currency').notNull()` | NOT NULL | `'EUR'` ou `'USD'`. |
| `tolerance_bp` | `integer` | `integer('tolerance_bp').notNull().default(500)` | NOT NULL, `CHECK (tolerance_bp >= 0 AND tolerance_bp <= 5000)` | Tolérance d'écart de montant en basis points (défaut `500` bp = ±5 %, max `5000` bp = ±50 %). |
| `billing_day` | `integer` | `integer('billing_day')` | NULL, `CHECK (billing_day IS NULL OR (billing_day >= 1 AND billing_day <= 31))` | Jour calendaire théorique d'échéance dans le mois (`1..31`, borné au dernier jour du mois si besoin). |
| `last_seen_date` | `date` | `date('last_seen_date', { mode: 'string' }).notNull()` | NOT NULL | Date comptable de la dernière occurrence observée (ou date d'ancrage initiale si manuelle avant premier relevé). |
| `next_expected_date` | `date` | `date('next_expected_date', { mode: 'string' }).notNull()` | NOT NULL | Prochaine échéance estimée pour le calendrier mensuel et les projections. |
| `previous_amount_cents` | `bigint` | `bigint('previous_amount_cents', { mode: 'number' })` | NULL | Montant de l'avant-dernière occurrence pour détecter une hausse/baisse de tarif. |
| `price_change_pct_bp` | `integer` | `integer('price_change_pct_bp')` | NULL | Évolution relative en basis points (`+1500` = `+15,00 %`). |
| `status` | `recurring_status_enum` | `recurringStatusEnum('status').notNull().default('detected')` | NOT NULL | `'detected' \| 'confirmed' \| 'dismissed' \| 'cancelled'`. |
| `cancelled_at` | `date` | `date('cancelled_at', { mode: 'string' })` | NULL | Date effective de résiliation lorsque `status = 'cancelled'` (aucune échéance future projetée après cette date). |
| `notes` | `varchar(240)` | `varchar('notes', { length: 240 })` | NULL | Mémo utilisateur libre (ex. `"Engagement jusqu'en juin 2027"`, `"Résilié par LRAR"`). |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur delta sync. |
| `updated_at` | `timestamptz` | `timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Dernière mise à jour. |
| `deleted_at` | `timestamptz` | `timestamp('deleted_at', { withTimezone: true, mode: 'date' })` | NULL | Soft-delete pour delta sync mobile. |

- **Contraintes & Index** :
  - `uq_recurring_series_identity` : `UNIQUE INDEX (merchant_key, currency, cadence, direction) WHERE deleted_at IS NULL`
  - `chk_recurring_merchant_non_empty` : `CHECK (char_length(trim(merchant_key)) > 0 AND char_length(trim(display_name)) > 0)`
  - `chk_recurring_amount_nonzero` : `CHECK (expected_amount_cents <> 0)`
  - `chk_recurring_direction_sign` : `CHECK ((direction = 'expense' AND expected_amount_cents < 0) OR (direction = 'income' AND expected_amount_cents > 0))`
  - `chk_recurring_tolerance_bp` : `CHECK (tolerance_bp >= 0 AND tolerance_bp <= 5000)`
  - `chk_recurring_billing_day` : `CHECK (billing_day IS NULL OR (billing_day >= 1 AND billing_day <= 31))`
  - `chk_recurring_cancelled_date` : `CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)`
  - `idx_recurring_status_next` : `INDEX (status, next_expected_date) WHERE deleted_at IS NULL`
  - `idx_recurring_source_status` : `INDEX (source, status) WHERE deleted_at IS NULL`
  - `idx_recurring_revision` : `INDEX (revision)`

#### 7.7 `ai_monthly_briefs` — Cache SQL des Bilans IA Mensuels Manuels

Met en cache le résultat structuré du bilan mensuel généré uniquement sur clic manuel (*« Générer le bilan IA du mois »*) pour éviter tout appel Gemini redondant tant que `data_revision` n'a pas changé et permettre la relecture hors-ligne sur Android.

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `uuid` | `uuid('id').primaryKey().defaultRandom()` | PK, NOT NULL | Identifiant du bilan mis en cache. |
| `month` | `varchar(7)` | `varchar('month', { length: 7 }).notNull()` | NOT NULL, `CHECK (~ '^\d{4}-(0[1-9]\|1[0-2])$')` | Mois analysé (`YYYY-MM`). |
| `scope_key` | `varchar(80)` | `varchar('scope_key', { length: 80 }).notNull()` | NOT NULL, `CHECK (char_length(trim(scope_key)) > 0)` | Périmètre (`'all_eur'`, `'usd_only'`, `'bank:boursobank'`, `'bank:revolut'`, `'account:<uuid>'`). |
| `display_currency` | `currency_enum` | `currencyEnum('display_currency').notNull()` | NOT NULL | `'EUR'` ou `'USD'`. |
| `summary_json` | `jsonb` | `jsonb('summary_json').$type<AiMonthlyBriefPayload>().notNull()` | NOT NULL | JSON structuré validé par Zod (zéro HTML brut, texte pur React). |
| `model_used` | `varchar(64)` | `varchar('model_used', { length: 64 }).notNull()` | NOT NULL | Modèle Gemini ayant produit la synthèse. |
| `data_revision` | `bigint` | `bigint('data_revision', { mode: 'number' }).notNull()` | NOT NULL | Révision du grand livre au moment de la génération (invalidation douce si de nouvelles opérations arrivent). |
| `generated_at` | `timestamptz` | `timestamp('generated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()` | NOT NULL | Horodatage de génération. |
| `revision` | `bigint` | `bigint('revision', { mode: 'number' }).notNull()` | NOT NULL, DEFAULT `nextval('sync_revision_seq')` | Curseur delta sync. |

- **Contraintes & Index** :
  - `uq_ai_monthly_briefs_key` : `UNIQUE (month, scope_key, display_currency)`
  - `chk_ai_briefs_month_format` : `CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$')`
  - `chk_ai_briefs_scope_non_empty` : `CHECK (char_length(trim(scope_key)) > 0)`
  - `idx_ai_monthly_briefs_revision` : `INDEX (revision)`

#### 7.8 Extensions Non-Destructives des Tables Existantes (`transactions` & `categorization_rules`)

##### A. Colonnes ajoutées à `transactions`

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `category_id` | `uuid` | `uuid('category_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Catégorie racine finale (niveau 1). |
| `subcategory_id` | `uuid` | `uuid('subcategory_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Sous-catégorie finale optionnelle (niveau 2). |
| `category_source` | `category_source_enum` | `categorySourceEnum('category_source').notNull().default('uncategorized')` | NOT NULL | Provenance autoritaire (`'manual' \| 'rule' \| 'ai_auto' \| 'ai_validated' \| 'uncategorized'`). |
| `ai_suggested_category_id` | `uuid` | `uuid('ai_suggested_category_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Catégorie proposée par Gemini (conservée pour audit et Boîte de révision). |
| `ai_suggested_subcategory_id` | `uuid` | `uuid('ai_suggested_subcategory_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Sous-catégorie proposée par Gemini. |
| `ai_confidence_bp` | `integer` | `integer('ai_confidence_bp')` | NULL, `CHECK (0..10000)` | Confiance Gemini en basis points (`8500` = `85,00 %`). |
| `ai_review_status` | `ai_review_status_enum` | `aiReviewStatusEnum('ai_review_status').notNull().default('none')` | NOT NULL | État dans la Boîte de révision (`'none' \| 'pending_review' \| 'accepted' \| 'rejected'`). |
| `ai_reason` | `varchar(240)` | `varchar('ai_reason', { length: 240 })` | NULL | Justification courte générée par Gemini (affichée en texte pur dans la Boîte de révision). |
| `ai_model` | `varchar(64)` | `varchar('ai_model', { length: 64 })` | NULL | Nom du modèle Gemini ayant émis la suggestion. |
| `recurring_series_id` | `uuid` | `uuid('recurring_series_id').references(() => recurringSeries.id, { onDelete: 'set null' })` | FK -> `recurring_series.id`, NULL | Lien optionnel vers la série récurrente détectée. |

- **Règle de compatibilité Expand** : la colonne texte v1 `transactions.category` (`varchar(64)`) est **strictement conservée et maintenue synchronisée** à chaque écriture (contient le libellé de la sous-catégorie si présente, sinon celui de la catégorie racine, sinon `'Transfert interne'` ou `'Non catégorisé'`).
- **Contraintes `CHECK` & Index ajoutés sur `transactions`** :
  - `chk_tx_subcat_requires_cat` : `CHECK (subcategory_id IS NULL OR category_id IS NOT NULL)`
  - `chk_tx_ai_subcat_requires_cat` : `CHECK (ai_suggested_subcategory_id IS NULL OR ai_suggested_category_id IS NOT NULL)`
  - `chk_tx_ai_confidence_bp_range` : `CHECK (ai_confidence_bp IS NULL OR (ai_confidence_bp >= 0 AND ai_confidence_bp <= 10000))`
  - `idx_tx_category_booking` : `INDEX (category_id, subcategory_id, booking_date DESC) WHERE deleted_at IS NULL`
  - `idx_tx_ai_review_queue` : `INDEX (ai_review_status, ai_confidence_bp DESC, booking_date DESC) WHERE ai_review_status = 'pending_review' AND deleted_at IS NULL`
  - `idx_tx_ai_backfill_cursor` : `INDEX (id) WHERE deleted_at IS NULL AND is_manual_category = false AND is_internal_transfer = false AND matched_rule_id IS NULL AND category_source = 'uncategorized'`
  - `idx_tx_recurring_series` : `INDEX (recurring_series_id, booking_date DESC) WHERE recurring_series_id IS NOT NULL AND deleted_at IS NULL`

##### B. Colonnes ajoutées à `categorization_rules`

| Colonne SQL | Type SQL | Mapping Drizzle | Contraintes & Défauts | Description fonctionnelle |
| :--- | :--- | :--- | :--- | :--- |
| `target_category_id` | `uuid` | `uuid('target_category_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Catégorie racine cible de la règle. |
| `target_subcategory_id` | `uuid` | `uuid('target_subcategory_id').references(() => categories.id, { onDelete: 'set null' })` | FK -> `categories.id`, NULL | Sous-catégorie cible optionnelle de la règle. |

- **Règle de compatibilité Expand** : `categorization_rules.target_category` (`varchar(64)`) reste renseignée en parallèle lors de toute création/édition de règle.
- **Contrainte ajoutée** : `chk_rules_subcat_requires_cat` : `CHECK (target_subcategory_id IS NULL OR target_category_id IS NOT NULL)`.

---

### 8. Algorithmes Normatifs v2 en Centimes Entiers

#### 8.1 Calcul Exact du Rollover Cumulatif Monarch & Sous-Plafonds Sans Double-Comptage

Tous les calculs s'exécutent exclusivement en **entiers signés en centimes** (`number` safe integer / `bigint`), jamais en flottant.

##### A. Rollover mensuel cumulatif d'une enveloppe `C` au mois `m` (`YYYY-MM`)

Soit une configuration active `budget_configs` (`monthly_limit_cents > 0`, `currency`, `rollover_enabled`, `rollover_start_month`, `rollover_cap_cents`), la suite des mois calendaires depuis `m_0 = rollover_start_month` jusqu'au mois demandé `m`, et la surcharge éventuelle `budget_monthly_overrides(C.id, k)` pour chaque mois `k` :

1. **Plafond effectif du mois `k`** :
   ```text
   effective_limit_cents(k) = COALESCE(override(k).override_limit_cents, C.monthly_limit_cents)
   ```
2. **Dépense nette comptabilisée du mois `k`** (`spent_cents(k) >= 0`) :
   - Somme des débits (`amount < 0`, en valeur absolue) sur `transactions` où `deleted_at IS NULL AND is_internal_transfer = false` et appartenant au périmètre `scope` (dans la devise d'affichage : `amount_eur_cents` en `EUR consolidé`, `amount_cents` en `USD seul`).
   - Note sur les remboursements éventuels sur une catégorie de dépense : si une catégorie de dépense reçoit un crédit explicitement catégorisé sur elle (remboursement), il réduit `spent_cents(k)` sans descendre sous `0` sauf règle dédiée — comportement borné `max(0, sum_debits - sum_refunds)` ; les virements internes (`is_internal_transfer = true`) sont toujours exclus.
3. **Calcul du report entrant (`carried_rollover_cents`)** :
   - Si `C.rollover_enabled = false` ou `m < C.rollover_start_month` :
     ```text
     base_carry_cents(m) = 0
     ```
   - Si `m = C.rollover_start_month` :
     ```text
     base_carry_cents(m_0) = 0
     ```
   - Pour tout mois `k > C.rollover_start_month`, à partir du solde disponible de clôture du mois précédent `prev_available = available_cents(k - 1)` :
     ```text
     base_carry_cents(k) =
       IF C.rollover_cap_cents IS NOT NULL AND prev_available > C.rollover_cap_cents
       THEN C.rollover_cap_cents
       ELSE prev_available
     ```
     *(Le plafond `rollover_cap_cents` borne l'accumulation positive d'excédents, tandis qu'un déficit négatif `prev_available < 0` est reporté intégralement pour ne pas masquer un dépassement réel.)*
   - Application de l'ajustement manuel éventuel du mois `k` :
     ```text
     carried_rollover_cents(k) = base_carry_cents(k) + COALESCE(override(k).rollover_adjustment_cents, 0)
     ```
4. **Disponible exact du mois `m`** :
   ```text
   available_cents(m) = effective_limit_cents(m) + carried_rollover_cents(m) - spent_cents(m)
   ```
   - Exemple vérifiable : plafond `300,00 €` (`30000`), report entrant `+45,00 €` (`4500`), dépensé `210,00 €` (`21000`) → `available_cents = 30000 + 4500 - 21000 = 13500` (`135,00 €`).
   - Les jauges visuelles utilisent les ratios entiers exacts calculés contre la capacité totale positive `capacity_cents = max(1, effective_limit_cents + carried_rollover_cents)` : `ok` (`< 80 %`), `warning` (`80 % .. 99 %`), `exceeded` (`>= 100 %` ou `available_cents < 0`).

##### B. Gestion des sous-plafonds optionnels sans double-comptage parent

Lorsqu'une catégorie racine `P` (`parent_id IS NULL`) et une ou plusieurs de ses sous-catégories `{S_1, ..., S_n}` (`parent_id = P.id`) coexistent :

1. **Périmètre de dépense d'une ligne budgétaire** :
   - Si la ligne porte sur une **Catégorie racine `P`** : `spent_cents(P)` somme toutes les opérations dont `transactions.category_id = P.id` (ce qui inclut à la fois les opérations sans sous-catégorie `subcategory_id IS NULL` et celles classées dans `S_1 .. S_n`).
   - Si la ligne porte sur une **Sous-catégorie `S_i`** : `spent_cents(S_i)` somme uniquement les opérations dont `transactions.subcategory_id = S_i.id`.
2. **Zéro double-comptage dans le Total Global & Totaux de Groupe Monarch (`fixed` / `variable` / `non_monthly`)** :
   - Si `P` possède une `budget_config` active, **seul `P` contribue** au total consolidé du plan (`total_budgeted_cents`, `total_carried_rollover_cents`, `total_spent_cents`, `total_available_cents`). Les sous-plafonds `S_i` sont affichés en **vue imbriquée / détaillée sous `P`** comme des garde-fous internes de répartition, mais ne sont **jamais additionnés une deuxième fois** au total de `P` ni au total global.
   - Si `P` ne possède **pas** de `budget_config` active mais que certaines sous-catégories `S_i` en possèdent une, alors chacune de ces `S_i` contribue de façon disjointe (`subcategory_id = S_i.id`) au total global.
   - Si `sum(effective_limit_cents(S_i)) > effective_limit_cents(P)`, l'API positionne `subcaps_exceed_parent_warning = true` afin d'alerter l'utilisateur sans bloquer la saisie.

#### 8.2 Hiérarchie Stricte de Catégorisation & Protection Anti-Écrasement

L'attribution finale de `(category_id, subcategory_id, category_source)` sur une transaction respecte l'ordre d'autorité décroissant suivant :

```text
1. Choix manuel utilisateur (is_manual_category = true)
   └── category_source IN ('manual', 'ai_validated')
   └── PRIORITÉ ABSOLUE : jamais écrasé par les transferts auto, ni par les règles, ni par l'IA Gemini.
   ▼
2. Transfert interne (is_internal_transfer = true)
   └── Appariement automatique (transfer_group_id IS NOT NULL) ou forçage manuel (is_manual_transfer_override = true).
   └── Exclu de tous les lots IA Gemini et exclu de toutes les dépenses budgétaires/analytiques.
   ▼
3. Règles déterministes utilisateur (categorization_rules actives par priority ASC, created_at ASC, id ASC)
   └── category_source = 'rule', matched_rule_id = <rule.id>.
   └── Gratuit (0 appel Gemini), rejoué rétroactivement dès création/édition/acceptation d'une suggestion.
   ▼
4. IA Gemini Auto-appliquée (ai_confidence_bp >= 8500, soit >= 85 %)
   └── category_source = 'ai_auto', is_manual_category = false, ai_review_status = 'none'.
   └── Catégorie/sous-catégorie appliquée immédiatement ; reste surclassable si l'utilisateur crée ensuite une règle déterministe ou corrige manuellement.
   ▼
5. Boîte de révision IA (ai_confidence_bp < 8500) ou Non catégorisé
   └── ai_suggested_category_id / ai_suggested_subcategory_id / ai_confidence_bp / ai_reason renseignés.
   └── category_source reste 'uncategorized' (et category = 'Non catégorisé') tant que non résolu, avec ai_review_status = 'pending_review'.
   └── Sur résolution utilisateur :
       - accept   → applique suggestion, category_source = 'ai_validated', is_manual_category = true, ai_review_status = 'accepted'.
       - override → applique choix manuel, category_source = 'manual', is_manual_category = true, ai_review_status = 'rejected'.
       - reject   → conserve 'uncategorized', ai_review_status = 'rejected'.
```

- **Règle d'éligibilité au rattrapage manuel Gemini (`POST /api/ai/categorize/backfill`)** :
  Ne sélectionne strictement que les transactions actives vérifiant `deleted_at IS NULL AND is_manual_category = false AND is_internal_transfer = false AND matched_rule_id IS NULL AND category_source = 'uncategorized' AND ai_review_status = 'none'`, traitées par curseur déterministe de `50` opérations par lot via la chaîne de modèles `gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite` (header HTTP `x-goog-api-key`).

#### 8.3 Coût Mensuel Lissé & Rapprochement Automatique des Échéances Récurrentes (`recurring_series`)

##### A. Formule Exacte en Centimes Entiers du Coût Mensuel Lissé

Pour chaque série active (`deleted_at IS NULL` et `status IN ('detected', 'confirmed')`, excluant strictement `'dismissed'` et `'cancelled'`), soit `abs_amount_cents = Math.abs(expected_amount_cents)` (converti en EUR via le dernier taux `fx_rates` si le scope est `all_eur` et la série en `USD`, ou conservé nativement en `USD` si le scope est `usd_only`) :

```text
monthly_smoothed_cents(series) =
  - cadence = 'weekly'    -> Math.round((abs_amount_cents * 52) / 12)
  - cadence = 'monthly'   -> abs_amount_cents
  - cadence = 'quarterly' -> Math.round(abs_amount_cents / 3)
  - cadence = 'yearly'    -> Math.round(abs_amount_cents / 12)
```

- **Compteurs dérivés de `Budget > Récurrents & Calendrier`** :
  - `monthly_smoothed_cents` : somme de `monthly_smoothed_cents(s)` pour les séries actives de `direction = 'expense'` (et, si le filtre `include_income = true` est activé, les revenus récurrents `direction = 'income'` sont exposés distinctement pour éviter toute ambiguïté).
  - `annual_smoothed_part_cents` : somme de `monthly_smoothed_cents(s)` restreinte aux séries de cadence `'quarterly'` et `'yearly'` (alimente la mention explicite *« dont XX,XX € lissés d'échéances annuelles/trimestrielles »*).
  - `paid_this_month_cents` : somme des échéances du mois `YYYY-MM` déjà associées à une transaction réelle (`matched_transaction_id IS NOT NULL`, `status = 'paid'`).
  - `remaining_this_month_cents` : somme des échéances actives du mois `YYYY-MM` non encore prélevées (`status = 'upcoming'`, excluant toute série avec `cancelled_at <= date_echeance`).

##### B. Rapprochement Automatique d'une Série Manuelle (`source = 'manual'`) sans Doublon

Lors de l'ingestion d'un relevé PDF (`commitParsedStatement`) ou d'une passe de détection récurrente sur les opérations actives (`deleted_at IS NULL AND is_internal_transfer = false AND recurring_series_id IS NULL`) :

1. **Priorité absolue aux séries `source = 'manual'` existantes** : le moteur vérifie d'abord toutes les lignes `recurring_series` où `source = 'manual' AND deleted_at IS NULL AND status IN ('detected', 'confirmed')` avant toute création d'une nouvelle série `auto_detected`.
2. **Critères d'appariement déterministe** : une transaction `tx` rapproche une série manuelle `S` si et seulement si :
   - `tx.currency = S.currency` et le sens correspond (`(S.direction = 'expense' AND tx.amount_cents < 0) OR (S.direction = 'income' AND tx.amount_cents > 0)`) ;
   - si `S.account_id IS NOT NULL`, `tx.account_id = S.account_id` ;
   - correspondance lexicale entre `normalizeLabel(tx.clean_label)` / `normalizeLabel(tx.raw_label)` et `S.merchant_key` / `normalizeLabel(S.display_name)` ;
   - écart de montant borné par `S.tolerance_bp` :
     `Math.abs(Math.abs(tx.amount_cents) - Math.abs(S.expected_amount_cents)) <= Math.max(100, Math.round((Math.abs(S.expected_amount_cents) * S.tolerance_bp) / 10000))` ;
   - date `tx.booking_date` comprise dans une fenêtre de `±7` jours calendaires autour de `S.next_expected_date` (ou du `S.billing_day` du mois courant).
3. **Effet transactionnel (zéro doublon)** :
   - Met à jour `transactions.recurring_series_id = S.id` ;
   - Enrichit la ligne `S` existante **sur place** (`last_seen_date = tx.booking_date`, `next_expected_date` avancé selon `S.cadence` et `S.billing_day`, `previous_amount_cents` / `price_change_pct_bp` calculés si le montant évolue, `status = 'confirmed'`, `revision = nextval('sync_revision_seq')`) sans créer de seconde ligne dans `recurring_series`.


