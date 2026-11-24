# `@clairflux/shared`

Noyau de contrats et de logique pure partagé entre `@clairflux/api`, `@clairflux/web` et le futur service `apps/sync-worker`.

---

## Interface

Point d'entrée unique : [`src/index.ts`](./src/index.ts).

- **Constantes normatives & helpers Google Drive** :
  - `ALLOWED_DRIVE_FOLDERS` : mapping verrouillé des deux seuls dossiers autorisés :
    - `boursobank`: `'1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h'`
    - `revolut`: `'1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus'`
  - `AllowedDriveFolderIdSchema`, `isAllowedDriveFolderId(folderId)`, `getBankForDriveFolder(folderId)`
  - `EUR_FX_RATE_MICRO` (`1_000_000`), `CLAIRFLUX_DELTA_SCHEMA_VERSION` (`'1.0.0'`)
- **Branded Types Zod & parseurs/constructeurs associés** :
  - Types : `AccountId`, `TransactionId`, `RuleId`, `DriveFileId`, `Cents`, `FxRateMicro`, `SyncRevision`
  - Schémas : `AccountIdSchema`, `TransactionIdSchema`, `RuleIdSchema`, `DriveFileIdSchema`, `CentsSchema`, `FxRateMicroSchema`, `SyncRevisionSchema`
  - Helpers : `parseAccountId`, `parseTransactionId`, `parseRuleId`, `parseDriveFileId`, `toCents`, `toFxRateMicro`, `toSyncRevision`
- **Enums Zod canoniques** :
  - `BankSchema` (`'boursobank' | 'revolut'`)
  - `AccountTypeSchema` (`'courant' | 'epargne' | 'carte_differee' | 'multi_devises' | 'coffre' | 'autre'`)
  - `CurrencySchema` (`'EUR' | 'USD'`)
  - `FxSourceSchema` (`'revolut_statement' | 'ecb_reference' | 'nearest_business_day' | 'manual_override'`)
  - `RuleMatchModeSchema` (`'contains' | 'starts_with' | 'exact' | 'regex'`)
  - `SyncTriggerSchema` (`'manual'`)
  - `SyncRunStatusSchema` (`'running' | 'completed' | 'partial_error' | 'failed'`)
  - `CheckpointStatusSchema` (`'pending' | 'skipped' | 'extracting' | 'parsed' | 'committing' | 'committed' | 'failed'`)
  - `CheckpointErrorCodeSchema` (`'GEMINI_TIMEOUT' | 'GEMINI_SCHEMA_INVALID' | 'GEMINI_QUOTA_EXCEEDED' | 'PDF_UNREADABLE' | 'DRIVE_DOWNLOAD_ERROR'`)
  - `ApiErrorCodeSchema` (codes d'erreur normalisés de `docs/API_DELTA_SYNC_CONTRACT.md`)
- **Schémas Zod d'échange & de domaine** :
  - `IsoDateSchema`, `IsoMonthSchema`, `IsoDateTimeSchema`
  - `AccountSchema`, `TransactionSchema`, `TransactionNoteSchema`, `CategorizationRuleSchema` (incluant `account_id_filter`, `bank_filter`, `account_type_filter`, `match_mode`, `mark_as_internal_transfer`)
  - `DriveSyncRunSummarySchema`, `DriveSyncFileStatusSchema`, `DriveSyncStatusSchema`
  - `AggregateKpisSchema`, `CumulativeBalancePointSchema`, `ExpenseComparisonItemSchema`, `ScopeAggregateViewSchema`, `AggregatesSnapshotSchema`
  - `DeltaSyncResponseSchema`, `ApiErrorEnvelopeSchema`
  - Champs canoniques alignés DB/API : `matched_rule_id`, `transfer_group_id`, `fx_rate_micro`, `is_manual_category`, `is_manual_transfer_override`, `source_drive_file_id`
- **Arithmétique & utilitaires purs** :
  - `convertToEurCents(amountCents, fxRateMicro)` : conversion entière `BigInt` en centimes EUR sans overflow intermédiaire
  - `formatMoney(cents, currency)` : formatage d'affichage `fr-FR` (`EUR` / `USD`)
  - `assertNever(value: never, message?: string): never` : garde d'exhaustivité dans les `switch` sur unions discriminées

### Prévu aux jalons suivants
- Moteur pur d'évaluation des règles de catégorisation (`matchRule`, `evaluateRules`) et helpers d'agrégats partagés.

---

## Invariants

1. **Portabilité absolue (zéro dépendance Node ou DOM exclusive)** : le package s'exécute à l'identique dans Node 22 (`api`), dans les navigateurs Desktop et dans Android System WebView (`web`).
2. **Zéro secret** : aucune variable d'environnement, clé API, URL PostgreSQL ou secret applicatif n'est lu ou embarqué dans ce package.
3. **Zéro flottant comptable** : tout montant manipulé dans les schémas et fonctions de calcul est un entier signé en centimes (`Cents`) et tout taux FX un entier en micro-unités (`FxRateMicro`, où `1.000000` = `1_000_000`).
4. **Typage TypeScript strict (Standard Matt Pocock)** : en Jalon 1, `packages/shared` n'a pas de `tsconfig.json` dédié ; son script `typecheck` passe explicitement les options strictes en CLI (`--strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noFallthroughCasesInSwitch --verbatimModuleSyntax --isolatedModules --target ES2022 --module ESNext --moduleResolution Bundler`) alignées sur `../../tsconfig.base.json`, avec zéro `any`.
5. **Source de vérité des bornes Zod** : les contraintes de validation (`nickname` 1..80, `note.content` 1..2000, `rule.name` 1..100, `priority` 1..10000) restent strictement alignées avec les contraintes SQL de `docs/DATA_MODEL_DRIZZLE_SPEC.md` et `docs/API_DELTA_SYNC_CONTRACT.md`.

---

## Side Effects

- **Aucun** : ce package est purement déclaratif et fonctionnel (aucun accès réseau, aucun accès disque, aucune écriture en base de données, aucun timer ni état global mutable).

---

## Verification

```bash
# Vérification stricte des types sur packages/shared/src/index.ts
npm run typecheck --workspace=@clairflux/shared

# Suite de tests Vitest : en Jalon 1, les tests sont portés dans apps/api/src/*.test.ts
# (couvrant également les constantes, schémas et parseurs de @clairflux/shared)
npm test

# Vérification globale de la consommation par @clairflux/web
npm run build
```
