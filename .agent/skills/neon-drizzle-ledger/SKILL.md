---
name: neon-drizzle-ledger
description: Spécialisation technique ClairFlux pour PostgreSQL Serverless Neon, Drizzle ORM, intégrité comptable en centimes, déduplication BoursoBank/Revolut, checkpoints SQL d'ingestion PDF Gemini et curseurs de synchronisation delta.
---

# Neon + Drizzle Ledger — Spécialisation Base de Données ClairFlux

## 1. Architecture Neon Serverless & Drizzle ORM

- **Driver** : `@neondatabase/serverless` (`neon` HTTP pour requêtes unitaires rapides / `Pool` WebSocket pour transactions multi-étapes `db.transaction`) + `drizzle-orm/neon-http` ou `drizzle-orm/neon-serverless`.
- **Sécurité connexion** : `sslmode=require` obligatoire, `DATABASE_URL` uniquement côté serveur (jamais exposé au client Web ni à l'APK Android).
- **Migrations strictes** : toute évolution de schéma passe par `drizzle-kit generate` puis migration SQL versionnée et rejouable — jamais de `drizzle-kit push` destructeur en production.
- **Typage Matt Pocock** : dériver tous les types applicatifs depuis le schéma Drizzle (`typeof transactions.$inferSelect`, `$inferInsert`) et valider les entrées externes avec `zod` (`drizzle-zod` ou schémas dédiés).

---

## 2. Invariants Comptables & Périmètre Drive Exclusif

1. **Montants en centimes entiers (Zéro Float)** :
   - Stocker tous les montants en centimes (`bigint({ mode: 'number' })` ou `integer`, accompagnés du code devise `currency` ISO 4217 ex. `'EUR'`, `'USD'`).
   - Interdiction absolue d'utiliser `real`, `doublePrecision` ou des calculs flottants JS sur les soldes.
2. **Exclusivité des 2 dossiers Google Drive** :
   - Contrainte SQL (`CHECK`) + validation applicative stricte autorisant uniquement :
     - `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` → Banque `boursobank`
     - `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` → Banque `revolut`
   - Tout autre `drive_folder_id` est rejeté à la frontière d'ingestion et journalisé comme violation de périmètre.
3. **Colonnes obligatoires Banque & Type de compte** :
   - Table `accounts` (et dénormalisation contrôlée ou jointure indexée) portant explicitement :
     - `bank`: enum `'boursobank' | 'revolut'`
     - `accountType`: enum/texte normalisé (`'courant' | 'epargne' | 'carte_differee' | 'multi_devises' | 'autre'`)
     - `accountLabel`, `ibanMask` / `externalAccountRef`, `currency`.

---

## 3. Déduplication & Checkpoints SQL (Reprise sur Erreur Gemini)

Le pipeline d'ingestion Drive → PDF → Gemini → Neon doit être **100 % idempotent et reprenable** :

1. **Suivi des fichiers Drive (`drive_files`)** :
   - Clé unique `drive_file_id` + `md5_checksum` + `drive_folder_id` + `modified_time`.
   - Si `md5_checksum` est identique à un fichier déjà au statut `'committed'`, le fichier est ignoré sans nouvel appel Gemini.
2. **Checkpoints d'ingestion PDF (`pdf_ingestion_checkpoints`)** :
   - Statuts : `'pending' | 'extracting' | 'parsed' | 'committing' | 'committed' | 'failed'`.
   - Champs : `run_id`, `drive_file_id`, `total_pages`, `last_completed_page`, `attempt_count`, `next_retry_at`, `raw_hash`, `error_code`, `error_message`.
   - **Transaction atomique par fichier (ou par lot cohérent)** : l'insertion des transactions extraites, la mise à jour du solde de clôture du relevé et le passage du checkpoint à `'committed'` se font dans une seule `db.transaction(...)`. En cas d'erreur, rien n'est partiellement commité et le checkpoint passe à `'failed'` avec conservation du contexte de reprise.
3. **Empreinte déterministe de transaction (`dedup_hash`)** :
   - Calculée sur : `account_id + booking_date + amount_cents + currency + normalized_label + statement_occurrence_index`.
   - Contrainte `UNIQUE(dedup_hash)` empêchant tout doublon lors du chevauchement de deux relevés PDF ou d'un retraitement manuel.
   - Indexation dédiée pour la détection des transferts internes BoursoBank ↔ Revolut.

---

## 4. Notes Personnalisées, Règles de Catégorisation & Delta Sync

- **`transaction_notes`** : liées à `transaction_id` (`UNIQUE(transaction_id)` ou historique), avec `content`, `updated_at`, `revision` (`bigserial` ou compteur monotone global), `updated_by_device`.
- **`categorization_rules`** : `id`, `name`, `priority`, `bank_filter` (optionnel `'boursobank' | 'revolut'`), `account_type_filter` (optionnel), `pattern` (contient / regex bornée), `target_category`, `is_active`, `revision`, `updated_at`.
- **Support Delta Sync Mobile (`sync_revision`)** :
  - Chaque entité synchronisable (`accounts`, `transactions`, `transaction_notes`, `categorization_rules`, `drive_sync_status`) porte un numéro de révision monotone (`revision`) et `deleted_at` (soft delete) pour que l'APK Android puisse récupérer uniquement le delta depuis `since_revision`.
  - Table `applied_client_mutations (client_mutation_id PRIMARY KEY, applied_at)` garantissant l'idempotence des push offline Android rejoués après coupure réseau.
