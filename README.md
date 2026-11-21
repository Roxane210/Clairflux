# ClairFlux

Application personnelle de suivi financier multi-banques et multi-comptes (**BoursoBank** & **Revolut**), conçue selon la gouvernance **EGM (Elephant-and-Goldfish Model)** : spécifications normatives verrouillées avant code, arithmétique comptable exacte en centimes entiers, ingestion PDF manuelle via Google Drive & Gemini, et consultation mobile Android **Offline-First en lecture seule**.

---

## Vue d'ensemble fonctionnelle & invariants

### 1. Périmètre Google Drive exclusif & déclenchement manuel
- **Lecture seule stricte (`drive.readonly`)** limitée à **deux dossiers Google Drive codés en dur** (validés dans `@clairflux/shared`, dans `@clairflux/api` et par contrainte SQL `CHECK` dans PostgreSQL Neon) :
  - **BoursoBank** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
  - **Revolut** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
- **Déclenchement 100 % manuel** (`POST /api/sync/drive`) : aucun cron, aucun webhook, aucun polling automatique en arrière-plan.
- **Reprise granulaire & conservation historique** : chaque PDF dispose d'un checkpoint SQL individuel (`pending | skipped | extracting | parsed | committing | committed | failed`), d'un contrôle d'empreinte `md5_checksum` (les fichiers inchangés sont ignorés sans appel Gemini) et d'une conservation définitive des transactions même si un PDF est retiré ultérieurement de Drive (`is_missing_on_drive`).

### 2. Multi-comptes, multi-devises EUR / USD & grand livre
- **Multi-comptes par banque** : prise en charge de plusieurs comptes et poches par banque (`courant`, `epargne`, `carte_differee`, `multi_devises`, `coffre`, `autre`), identifiés par `(bank, external_ref_masked, currency)` et librement renommables (`nickname`).
- **Zéro flottant & conversion historique figée** : tous les montants sont stockés et échangés en centimes entiers (`amount_cents`, `amount_eur_cents`) ; les taux de change `USD -> EUR` sont stockés en micro-unités entières (`fx_rate_micro`, `1.000000 = 1_000_000`) et figés à la date d'opération (`booking_date`).
- **Vue consolidée EUR & Vue USD seul** : synthèse financière (`Solde cumulé 6M`, `Dépenses M-1 / Moyenne 3M`) en EUR consolidé par défaut ou en USD natif (`usd_only`).
- **Déduplication & transferts internes** : empreinte SHA-256 déterministe (`dedup_hash` avec rang d'occurrence `statement_occurrence_index`) et appariement automatique (`transfer_group_id`) des virements inter-comptes (`±3j`) et des changes internes Revolut `EUR ↔ USD` (`±1j`), exclus des totaux de dépenses (`is_internal_transfer = true`).
- **Règles rétroactives protégées** : le recalcul rétroactif des règles de catégorisation préserve strictement les corrections manuelles (`is_manual_category = true`), les paires appariées (`transfer_group_id IS NOT NULL`) et les overrides manuels de transfert (`is_manual_transfer_override = true`).

### 3. Android APK Offline-First (lecture seule) & écritures en ligne
- **Consultation hors-ligne intégrale** : l'application Android Capacitor réplique localement comptes, transactions, notes, règles, statuts Drive et agrégats pré-calculés (`aggregates_snapshot`) via delta pull incrémental (`GET /api/sync/delta?since=<revision>`).
- **Écritures en ligne uniquement** : aucune file locale de mutations ni résolution de conflits hors-ligne ; hors connexion, toutes les actions d'édition (notes, catégories, règles, synchro Drive) sont explicitement désactivées.

---

## Index des packages (EGM Peanuts)

| Workspace | Rôle en Jalon 1 | Documentation EGM |
| :--- | :--- | :--- |
| **`@clairflux/shared`** | Contrats Zod partagés, Branded Types, constantes Drive, arithmétique centimes/FX et utilitaires purs (zéro secret, zéro dépendance Node/DOM). | [./packages/shared/README.md](./packages/shared/README.md) |
| **`@clairflux/api`** | API HTTP Node 22 (Hono) + schéma Drizzle Neon PostgreSQL, déduplication/appariement pur (`dedup.ts`), sondes Docker et premières routes validées par Zod. | [./apps/api/README.md](./apps/api/README.md) |
| **`@clairflux/web`** | Frontend React 19 + Vite + CSS natif Baseline + Recharts + polices `@fontsource/*` bundlées localement (socle Mock-First Desktop `1440×900` & Mobile `390×844`). | [./apps/web/README.md](./apps/web/README.md) |

### Architecture cible associée (hors Jalon 1 — jalons suivants)
- **`apps/sync-worker`** : service Docker isolé (`backend_net` interne uniquement, orchestré dans `docker-compose.yml`) prévu pour le téléchargement Drive en lecture seule, l'extraction PDF Gemini validée par Zod et les commits transactionnels Neon.
- **`android/`** : projet natif Android Capacitor/Gradle synchronisé depuis `apps/web/dist`.

---

## Documentation normative (Source de vérité Pré-Code)

- [Standards techniques & normes d'ingénierie](./docs/TECHNICAL_STANDARDS.md)
- [Modèle de données Neon PostgreSQL & Drizzle ORM](./docs/DATA_MODEL_DRIZZLE_SPEC.md)
- [Contrat formel d'API, Delta Sync & Infrastructure](./docs/API_DELTA_SYNC_CONTRACT.md)
- **ADRs** :
  - [0001 — Exclusivité Drive & Déduplication](./docs/ADR/0001-drive-exclusive-sync-and-deduplication.md)
  - [0002 — Ledger Neon/Drizzle & Checkpoints](./docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md)
  - [0003 — Capacitor Offline-First & Delta Sync](./docs/ADR/0003-capacitor-offline-first-delta-sync.md)
  - [0004 — UI Baseline & Architecture Recharts](./docs/ADR/0004-ui-baseline-and-recharts-architecture.md)

---

## Commandes de vérification

Exécuter depuis la racine du monorepo :

```bash
# 1. Vérification TypeScript stricte sur tous les workspaces
npm run typecheck

# 2. Exécution de la suite de tests Vitest (zéro test skippé)
npm test

# 3. Contrôle statique & build de production Frontend (@clairflux/web)
npm run lint
npm run build
```
