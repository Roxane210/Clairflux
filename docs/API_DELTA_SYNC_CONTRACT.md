# Contrat Formel d'API, Delta Sync & Infrastructure Docker/APK — ClairFlux

- **Statut** : Spécification normative pré-code (Phase 0 — EGM)
- **Date** : 2026-11-21
- **Périmètre** : Frontend Web Desktop (`1440×900`), Application Android APK Capacitor (`390×844`), Backend API (`api`), Worker d'ingestion (`sync-worker`) et Déploiement Docker Compose.
- **Sources directrices** :
  - [clairflux-mvp.md](file:///d:/Applications/Clairflux/docs/intent/clairflux-mvp.md)
  - [critical-flows.md](file:///d:/Applications/Clairflux/docs/ideas/critical-flows.md)
  - [PROTOTYPE_SPEC.md](file:///d:/Applications/Clairflux/docs/prototypes/PROTOTYPE_SPEC.md)
  - [0003-capacitor-offline-first-delta-sync.md](file:///d:/Applications/Clairflux/docs/ADR/0003-capacitor-offline-first-delta-sync.md)

---

## 1. Invariants Architecturaux & Règles Non Négociables

1. **Usage personnel unique** : pas d'inscription publique, pas de multi-tenant, pas de gestion de rôles. Un seul espace financier privé accessible depuis Desktop Web et Android APK.
2. **Exclusivité stricte des 2 dossiers Google Drive** :
   - `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` → Banque `boursobank`
   - `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` → Banque `revolut`
   - Tout autre `drive_folder_id` est rejeté avec `403 Forbidden` (`INVALID_DRIVE_FOLDER_SCOPE`).
3. **Déclenchement Drive strictement manuel** : aucun cron, aucun webhook, aucun polling automatique en arrière-plan. Seul l'appel explicite à `POST /api/sync/drive` (ou `POST /api/sync/drive/files/:fileId/retry`) lance une ingestion.
4. **Android Offline-First en lecture seule / Écritures en ligne uniquement** :
   - L'APK Android maintient une réplique locale complète via `GET /api/sync/delta?since=<revision>` pour fonctionner hors-ligne (graphiques, grand livre, notes, règles).
   - **Zéro mutation hors-ligne** : toutes les routes d'écriture (`PUT`, `PATCH`, `POST`, `DELETE`) exigent une connectivité réseau active. Il n'existe ni outbox locale ni route `POST /sync/mutations`.
5. **Intégrité monétaire sans flottant** :
   - Tous les montants et soldes échangés en JSON sont des **entiers en centimes** (`integer` / `safe integer` JS, suffixe `_cents`, ex. `-4250` pour `-42,50 €` ou `-42,50 $`).
   - Les opérations conservent leur montant d'origine (`amount_cents`, `currency`) et figent côté serveur leur taux historique de la date d'opération sous forme d'entier en micro-unités (`fx_rate_micro`, ex. `924500` pour `0.924500`, et `1000000` si `EUR`) ainsi que `amount_eur_cents`. L'UI convertit `fx_rate_micro / 1_000_000` uniquement pour l'affichage.
   - Les transferts internes (`is_internal_transfer: true`, incluant les conversions internes Revolut `EUR ↔ USD`) sont **exclus des totaux de dépenses** dans les agrégats, tout en restant visibles dans le grand livre et exacts dans les soldes par compte.
6. **Zéro binaire PDF côté client** : ni le Frontend Web ni l'APK Android ne téléchargent les PDF bancaires bruts. Seules les données structurées et statuts d'ingestion transitent par l'API.

---

## 2. Conventions HTTP, Sécurité & Format d'Erreur Normalisé

### 2.1 Transport, Encodage & Headers

- **Protocole** : HTTPS obligatoire en production (`TLS 1.2+`). HTTP toléré uniquement en boucle locale de développement (`localhost` / `127.0.0.1`).
- **Content-Type** : `application/json; charset=utf-8` pour toutes les requêtes avec corps et toutes les réponses API.
- **Horodatages** : ISO 8601 UTC strict avec suffixe `Z` (ex. `"2026-11-21T13:15:00.000Z"`).
- **Dates comptables** : ISO 8601 date calendaire `YYYY-MM-DD` (ex. `"2026-10-28"`).
- **Identifiants** : UUID v4 pour les entités internes (`accounts`, `transactions`, `categorization_rules`, `drive_sync_runs`) ; identifiant alphanumérique Google Drive pour `drive_file_id` / `drive_folder_id`.
- **Headers client recommandés** :
  - `X-Client-Platform`: `"web"` | `"android-apk"`
  - `X-Client-Version`: version applicative (ex. `"1.0.0"`)
  - `X-Request-Id`: UUID généré par le client (facultatif) ; le serveur retourne toujours `X-Request-Id` dans la réponse.

### 2.2 Format d'Erreur JSON Normalisé

Toutes les réponses HTTP `4xx` et `5xx` respectent strictement cette enveloppe (validée par Zod côté client) :

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Le motif de règle ne peut pas être vide.",
    "details": {
      "field": "pattern",
      "issue": "too_small"
    },
    "retryable": false,
    "request_id": "7f3c8b2a-91d4-4c6e-a8b1-2c1e9d04a112"
  }
}
```

| Code HTTP | `error.code` | Signification & Comportement Client Attendu | `retryable` |
| --- | --- | --- | --- |
| `400` | `BAD_REQUEST` | JSON malformé ou paramètre de requête invalide (`since < 0`, etc.). | `false` |
| `401` | `UNAUTHORIZED` | Session expirée, absente ou Bearer token révoqué. Rediriger vers l'écran de déverrouillage. | `false` |
| `401` | `INVALID_CREDENTIALS` | Secret personnel incorrect sur `POST /api/auth/login`. | `false` |
| `403` | `INVALID_DRIVE_FOLDER_SCOPE` | Tentative d'accès/relance sur un dossier Drive hors des 2 IDs autorisés. | `false` |
| `403` | `CSRF_ORIGIN_MISMATCH` | Origine ou header client invalide sur session cookie Web. | `false` |
| `404` | `RESOURCE_NOT_FOUND` | Compte, transaction, règle ou fichier Drive introuvable. | `false` |
| `409` | `SYNC_ALREADY_RUNNING` | Un run Drive est déjà en cours (`details.active_run_id` fourni). | `true` |
| `409` | `FILE_NOT_RETRYABLE` | Le fichier Drive n'est pas au statut `failed` (déjà `committed` ou en cours). | `false` |
| `422` | `VALIDATION_ERROR` | Échec de validation Zod (ex. regex invalide, libellé trop long, devise inconnue). | `false` |
| `429` | `RATE_LIMITED` | Trop de tentatives d'authentification ou d'appels ; consulter `Retry-After`. | `true` |
| `502` | `UPSTREAM_DRIVE_ERROR` | Échec temporaire Google Drive API lors de l'initialisation d'un run. | `true` |
| `502` | `UPSTREAM_GEMINI_ERROR` | Échec d'extraction Gemini remonté dans le statut de fichier. | `true` |
| `503` | `DATABASE_UNAVAILABLE` | Neon PostgreSQL temporairement injoignable. | `true` |
| `500` | `INTERNAL_ERROR` | Erreur serveur inattendue (sans jamais exposer de stacktrace ni de secret). | `false` |

---

## 3. Authentification Personnelle Unique (`/api/auth/*`)

L'accès repose sur un **secret personnel unique** configuré côté serveur (`CLAIRFLUX_ACCESS_SECRET_HASH`, hashé avec **Argon2id**). Aucun identifiant tiers ni base multi-utilisateurs n'est requis.

### 3.1 Double mode de transport sécurisé (Web vs APK Android)

- **Web Desktop (`client_kind: "web"`)** :
  - L'API pose un cookie `clairflux_session` avec attributs `HttpOnly`, `SameSite=Lax`, `Path=/api`, et `Secure` conditionné au transport HTTPS (omis en HTTP LAN local, ex. `http://192.168.1.118:8080`, afin que le navigateur transmette le cookie).
  - Contenu : jeton signé HMAC-SHA256 (`CLAIRFLUX_SESSION_SECRET`) incluant `jti` (identifiant révocable), `client_kind`, `iat`, `exp` (durée 14 jours, renouvellement glissant au-delà de 7 jours).
  - Protection CSRF : toute mutation Web (`POST`, `PUT`, `PATCH`, `DELETE`) vérifie que l'en-tête `Origin` appartient à `CLAIRFLUX_WEB_ORIGIN` (normalisé sans slash final) et exige le header custom `X-Clairflux-Client: web`.
- **Android APK Capacitor (`client_kind: "android"`)** :
  - L'APK ne s'appuie pas sur les cookies tiers de la WebView ; `POST /api/auth/login` retourne dans le corps JSON un **Bearer Token** signé (`access_token`, durée 30 jours, `jti` révocable en base).
  - L'APK stocke ce token uniquement dans un stockage natif protégé par **Android Keystore** (jamais en clair dans `localStorage` ni dans `assets/`), et l'envoie via `Authorization: Bearer <token>`.
  - CORS API : autorise explicitement `CLAIRFLUX_WEB_ORIGIN`, `capacitor://localhost`, `https://localhost`, et `http://localhost` (uniquement en profil dev).

### 3.2 `POST /api/auth/login`

- **Auth** : Publique (protégée par rate-limit strict : max 5 échecs / 15 min par IP, puis blocage `429`).
- **Requête** :
```json
{
  "secret": "mon-secret-personnel-clairflux",
  "client_kind": "android",
  "device_label": "Pixel 8 Pro"
}
```
  - `client_kind` : `"web" | "android"`
  - `device_label` : chaîne optionnelle (1..64 car.) pour journalisation de session.
- **Réponse `200 OK`** :
  - Si `client_kind === "web"` : pose le cookie `HttpOnly` `clairflux_session` et retourne :
```json
{
  "authenticated": true,
  "client_kind": "web",
  "session_id": "9d8a1c34-6c5f-4b7b-92be-9d3123456789",
  "expires_at": "2026-12-05T13:15:00.000Z"
}
```
  - Si `client_kind === "android"` : retourne en plus `access_token` et `token_type` :
```json
{
  "authenticated": true,
  "client_kind": "android",
  "session_id": "9d8a1c34-6c5f-4b7b-92be-9d3123456789",
  "token_type": "Bearer",
  "access_token": "cfx_v1.eyJqdGkiOiI...",
  "expires_at": "2026-12-21T13:15:00.000Z"
}
```

### 3.3 `GET /api/auth/session`

- **Auth** : Requise (`Cookie` ou `Bearer`).
- **Réponse `200 OK`** :
```json
{
  "authenticated": true,
  "client_kind": "android",
  "session_id": "9d8a1c34-6c5f-4b7b-92be-9d3123456789",
  "expires_at": "2026-12-21T13:15:00.000Z",
  "latest_revision": 1482
}
```

### 3.4 `POST /api/auth/logout`

- **Auth** : Requise.
- **Requête** : `{ "revoke_all": false }` (optionnel ; `revoke_all: true` révoque toutes les sessions Web et Android actives).
- **Réponse `200 OK`** : `{ "authenticated": false, "revoked": true }` (et effacement du cookie `clairflux_session` si Web).

---

## 4. Endpoints de Lecture & Agrégats (En Ligne)

Toutes les routes ci-dessous nécessitent une session valide (`401` sinon). Sur Android hors-ligne, l'UI lit directement le réplica local synchronisé via `GET /api/sync/delta`.

### 4.1 `GET /api/accounts`

Retourne la liste des comptes détectés automatiquement depuis les relevés PDF BoursoBank et Revolut (plusieurs comptes par banque, multi-devises EUR/USD).

- **Query params optionnels** : `bank` (`boursobank` | `revolut`), `currency` (`EUR` | `USD`).
- **Réponse `200 OK`** :
```json
{
  "accounts": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "bank": "boursobank",
      "account_type": "courant",
      "nickname": "Perso BoursoBank",
      "external_ref_masked": "•••• 4821",
      "currency": "EUR",
      "current_balance_cents": 412840,
      "current_balance_eur_cents": 412840,
      "balance_updated_at": "2026-11-20T23:59:59.000Z",
      "revision": 1410,
      "updated_at": "2026-11-20T18:02:11.000Z"
    },
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "bank": "revolut",
      "account_type": "multi_devises",
      "nickname": "Courant USD",
      "external_ref_masked": "USD •• 9012",
      "currency": "USD",
      "current_balance_cents": 185000,
      "current_balance_eur_cents": 171033,
      "balance_updated_at": "2026-11-20T23:59:59.000Z",
      "revision": 1455,
      "updated_at": "2026-11-20T18:02:15.000Z"
    }
  ],
  "latest_revision": 1482
}
```
- **Valeurs normalisées & règles dérivées** :
  - `bank` : `"boursobank" | "revolut"`
  - `account_type` : `"courant" | "epargne" | "carte_differee" | "multi_devises" | "coffre" | "autre"`
  - `currency` : `"EUR" | "USD"`
  - `current_balance_eur_cents` : égal à `current_balance_cents` si `currency === "EUR"`, sinon calculé côté serveur avec le taux le plus récent de `fx_rates` (`Math.round((current_balance_cents * latest_fx_rate_micro) / 1_000_000)`).

### 4.2 `GET /api/transactions`

Retourne le grand livre filtrable avec colonnes obligatoires **Banque**, **Type de compte**, **Note personnalisée** et montants figés.

- **Query params** :
  - `bank` : `"boursobank" | "revolut"`
  - `account_id` : UUID du compte
  - `currency` : `"EUR" | "USD"`
  - `from` : `YYYY-MM-DD` (inclusif sur `booking_date`)
  - `to` : `YYYY-MM-DD` (inclusif sur `booking_date`)
  - `category` : chaîne exacte
  - `is_internal_transfer` : `"true" | "false"`
  - `has_note` : `"true" | "false"`
  - `q` : recherche texte insensible à la casse (`clean_label`, `raw_label`, contenu de `note`)
  - `cursor` : curseur opaque base64 (`booking_date` + `id`)
  - `limit` : entier `1..200` (défaut `50`)
- **Réponse `200 OK`** :
```json
{
  "items": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "account_id": "22222222-2222-4222-8222-222222222222",
      "bank": "revolut",
      "account_type": "multi_devises",
      "account_nickname": "Courant USD",
      "external_ref_masked": "USD •• 9012",
      "booking_date": "2026-11-18",
      "value_date": "2026-11-18",
      "raw_label": "CURSOR AI *MONTHLY SAN FRANCISCO US",
      "clean_label": "Cursor AI",
      "amount_cents": -2000,
      "currency": "USD",
      "fx_rate_micro": 924500,
      "amount_eur_cents": -1849,
      "category": "Logiciels & Cloud",
      "is_manual_category": false,
      "matched_rule_id": "44444444-4444-4444-8444-444444444444",
      "is_internal_transfer": false,
      "is_manual_transfer_override": false,
      "transfer_group_id": null,
      "source_drive_file_id": "88888888-8888-4888-8888-888888888888",
      "drive_file_external_id": "1AbCdEf...",
      "note": {
        "content": "Abonnement dev annuel à basculer",
        "updated_at": "2026-11-19T09:10:00.000Z"
      },
      "revision": 1460,
      "updated_at": "2026-11-19T09:10:00.000Z"
    }
  ],
  "next_cursor": "MjAyNi0xMS0xOHwzMzMzMzMzMy0zMzMzLTQzMzMtODMzMy0zMzMzMzMzMzMzMzM=",
  "total_count": 312,
  "latest_revision": 1482
}
```
- Note : `source_drive_file_id` est l'UUID interne FK vers `drive_files.id` ; `drive_file_external_id` expose en lecture l'identifiant Google Drive du fichier source pour permettre un lien contextuel dans l'UI.

### 4.3 `GET /api/aggregates`

Alimente les 4 KPIs de synthèse et les 2 graphiques Recharts (**Solde cumulé 6M** et **Dépenses M-1 / Moyenne 3M**), en mode **EUR consolidé** ou **Vue USD seul**.

- **Query params** :
  - `scope` : `"all_eur"` (défaut) | `"usd_only"` | `"bank:boursobank"` | `"bank:revolut"` | `"account:<uuid>"`
    - Règle : si `scope === "usd_only"` ou si `scope === "account:<uuid>"` pointe vers un compte en `USD`, `display_currency` vaut `"USD"` et tous les centimes retournés sont en USD natifs sans conversion EUR. Dans tous les autres cas, `display_currency` vaut `"EUR"` et les opérations USD sont converties via leur `amount_eur_cents` figé à la date d'opération.
  - `reference_month` : `YYYY-MM` optionnel (défaut = mois calendaire courant UTC/Europe-Paris).
- **Réponse `200 OK`** :
```json
{
  "scope": "all_eur",
  "display_currency": "EUR",
  "reference_month": "2026-11",
  "kpis": {
    "consolidated_balance_cents": 1245080,
    "month_income_cents": 385000,
    "month_expenses_excl_transfers_cents": 194230,
    "month_internal_transfers_cents": 65000
  },
  "cumulative_balance_6m": [
    { "month": "2026-06", "label": "Juin", "closing_balance_cents": 980200, "net_change_cents": 12400 },
    { "month": "2026-07", "label": "Juil.", "closing_balance_cents": 1034500, "net_change_cents": 54300 },
    { "month": "2026-08", "label": "Août", "closing_balance_cents": 1012000, "net_change_cents": -22500 },
    { "month": "2026-09", "label": "Sept.", "closing_balance_cents": 1105400, "net_change_cents": 93400 },
    { "month": "2026-10", "label": "Oct.", "closing_balance_cents": 1189000, "net_change_cents": 83600 },
    { "month": "2026-11", "label": "Nov.", "closing_balance_cents": 1245080, "net_change_cents": 56080 }
  ],
  "expenses_m1_vs_avg3m": [
    {
      "category": "Alimentation",
      "m_minus_1_cents": 48200,
      "avg_3m_cents": 43800,
      "delta_percent": 10.05,
      "transaction_count_m1": 19
    },
    {
      "category": "Logement & Charges",
      "m_minus_1_cents": 92000,
      "avg_3m_cents": 92000,
      "delta_percent": 0,
      "transaction_count_m1": 3
    }
  ],
  "excluded_internal_transfers_count_3m": 7,
  "computed_at": "2026-11-21T13:15:00.000Z",
  "data_revision": 1482
}
```
- **Invariant de calcul** :
  - `m_minus_1_cents` somme uniquement les débits (`amount < 0`, retournés en valeur positive de dépense) du mois `M-1` où `is_internal_transfer = false`.
  - `avg_3m_cents` est la moyenne arithmétique des dépenses sur `M-1`, `M-2`, `M-3` (arrondie à l'entier le plus proche en centimes).
  - Les paires de change interne Revolut `EUR ↔ USD` (`is_internal_transfer = true`) n'entrent jamais dans `expenses_m1_vs_avg3m` ni dans `month_expenses_excl_transfers_cents`.

---

## 5. Endpoints d'Écriture (En Ligne Uniquement)

> **Rappel Contractuel** : Ces endpoints sont utilisables depuis Desktop Web et Android APK **uniquement lorsqu'une connexion réseau est active**. Aucun endpoint de file hors-ligne n'existe. Sur Android, après chaque réponse `200`/`201`, le client déclenche un pull `GET /api/sync/delta?since=<local_revision>` (ou applique la révision retournée).

### 5.1 Renommage d'un compte — `PATCH /api/accounts/:id`

- **Requête** :
```json
{
  "nickname": "Joint BoursoBank"
}
```
  - Contrainte Zod : chaîne trimée, longueur `1..80`.
- **Réponse `200 OK`** :
```json
{
  "account": {
    "id": "11111111-1111-4111-8111-111111111111",
    "bank": "boursobank",
    "account_type": "courant",
    "nickname": "Joint BoursoBank",
    "external_ref_masked": "•••• 4821",
    "currency": "EUR",
    "current_balance_cents": 412840,
    "current_balance_eur_cents": 412840,
    "balance_updated_at": "2026-11-20T23:59:59.000Z",
    "revision": 1483,
    "updated_at": "2026-11-21T13:20:00.000Z"
  },
  "latest_revision": 1483
}
```

### 5.2 Notes personnalisées — `PUT /api/transactions/:id/note` & `DELETE /api/transactions/:id/note`

#### `PUT /api/transactions/:id/note` (création ou mise à jour idempotente)

- **Requête** :
```json
{
  "content": "Remboursement partagé avec Thomas (50 %)"
}
```
  - Contrainte Zod : chaîne trimée, longueur `1..2000`.
- **Réponse `200 OK`** :
```json
{
  "transaction_id": "33333333-3333-4333-8333-333333333333",
  "note": {
    "content": "Remboursement partagé avec Thomas (50 %)",
    "updated_at": "2026-11-21T13:21:00.000Z",
    "revision": 1484
  },
  "latest_revision": 1484
}
```

#### `DELETE /api/transactions/:id/note`

- **Effet serveur** : marque `deleted_at = now()` sur la note dans la base (soft-delete) et incrémente la révision globale afin que l'APK Android supprime la note de son cache local au prochain delta pull.
- **Réponse `200 OK`** :
```json
{
  "transaction_id": "33333333-3333-4333-8333-333333333333",
  "deleted": true,
  "revision": 1485,
  "latest_revision": 1485
}
```

### 5.3 Catégorie manuelle & Transfert interne — `PATCH /api/transactions/:id`

Permet de corriger manuellement la catégorie d'une opération ou de basculer son statut `Transfert interne`.

- **Requête** :
```json
{
  "category": "Restaurant & Sorties",
  "is_internal_transfer": false
}
```
  - Champs optionnels (au moins un champ requis) :
    - `category` (`string`, `1..64`) : force automatiquement `is_manual_category = true` et `matched_rule_id = null`.
    - `is_manual_category` (`boolean`) : passer explicitement `false` autorise les règles automatiques à re-catégoriser cette transaction.
    - `is_internal_transfer` (`boolean`) : inclut ou exclut l'opération des totaux de dépenses. Positionne `is_manual_transfer_override = true` (et dissocie `transfer_group_id = null` sur la transaction et sa paire éventuelle si passé à `false`) **sans modifier `is_manual_category`** (qui ne passe à `true` que lorsque `category` est explicitement modifié).
- **Réponse `200 OK`** :
```json
{
  "transaction": {
    "id": "33333333-3333-4333-8333-333333333333",
    "category": "Restaurant & Sorties",
    "is_manual_category": true,
    "matched_rule_id": null,
    "is_internal_transfer": false,
    "is_manual_transfer_override": true,
    "transfer_group_id": null,
    "revision": 1486,
    "updated_at": "2026-11-21T13:22:00.000Z"
  },
  "latest_revision": 1486
}
```

### 5.4 Règles de catégorisation (`/api/rules`)

#### Invariant de protection des choix manuels
Toute création, modification ou suppression de règle exécute une réévaluation rétroactive transactionnelle (`db.transaction`) sur l'historique **strictement filtrée par `WHERE is_manual_category = false AND transfer_group_id IS NULL AND is_manual_transfer_override = false`**. Aucune correction manuelle effectuée par l'utilisateur via `PATCH /api/transactions/:id` n'est jamais écrasée.

#### `GET /api/rules`
- **Réponse `200 OK`** :
```json
{
  "rules": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "name": "Abonnements SaaS & IA",
      "priority": 10,
      "bank_filter": null,
      "account_id_filter": null,
      "account_type_filter": null,
      "match_mode": "contains",
      "pattern": "CURSOR AI",
      "target_category": "Logiciels & Cloud",
      "mark_as_internal_transfer": false,
      "is_active": true,
      "matched_transactions_count": 6,
      "revision": 1402,
      "updated_at": "2026-11-15T10:00:00.000Z"
    }
  ],
  "latest_revision": 1486
}
```
- `match_mode` : `"contains" | "starts_with" | "exact" | "regex"` (si `"regex"`, validation stricte anti-ReDoS : longueur `<= 120`, pas de backreferences ni lookbehinds imbriqués, exécution bornée).

#### `POST /api/rules/preview`
Prévisualisation sans écriture en base avant confirmation utilisateur (notamment depuis le geste *« Créer une règle depuis ce libellé »*).

- **Requête** :
```json
{
  "bank_filter": "revolut",
  "account_id_filter": "22222222-2222-4222-8222-222222222222",
  "account_type_filter": null,
  "match_mode": "contains",
  "pattern": "CURSOR AI",
  "target_category": "Logiciels & Cloud",
  "mark_as_internal_transfer": false
}
```
- **Réponse `200 OK`** :
```json
{
  "matching_total": 8,
  "would_update_count": 7,
  "skipped_manual_count": 1,
  "sample_transactions": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "booking_date": "2026-11-18",
      "bank": "revolut",
      "account_nickname": "Courant USD",
      "clean_label": "Cursor AI",
      "current_category": "Non catégorisé",
      "is_manual_category": false,
      "amount_cents": -2000,
      "currency": "USD"
    }
  ]
}
```

#### `POST /api/rules`
- **Requête** : identique au payload de `/preview`, plus `name` (`1..100`), `priority` (`integer 1..10000`, défaut `100`), `is_active` (`boolean`, défaut `true`).
- **Comportement** : insère la règle + recalcule les transactions éligibles (`is_manual_category = false AND transfer_group_id IS NULL AND is_manual_transfer_override = false`) selon l'ordre croissant de `priority` dans une transaction SQL atomique, et régénère `aggregates_snapshot`.
- **Réponse `201 Created`** :
```json
{
  "rule": {
    "id": "55555555-5555-4555-8555-555555555555",
    "name": "Abonnements Cursor",
    "priority": 100,
    "bank_filter": "revolut",
    "account_id_filter": "22222222-2222-4222-8222-222222222222",
    "account_type_filter": null,
    "match_mode": "contains",
    "pattern": "CURSOR AI",
    "target_category": "Logiciels & Cloud",
    "mark_as_internal_transfer": false,
    "is_active": true,
    "matched_transactions_count": 7,
    "revision": 1487,
    "updated_at": "2026-11-21T13:25:00.000Z"
  },
  "retroactive_stats": {
    "updated_count": 7,
    "skipped_manual_count": 1
  },
  "latest_revision": 1487
}
```

#### `PATCH /api/rules/:id`
- **Requête** : mise à jour partielle des champs de la règle (`name`, `priority`, `bank_filter`, `account_id_filter`, `account_type_filter`, `match_mode`, `pattern`, `target_category`, `mark_as_internal_transfer`, `is_active`).
- **Comportement** : met à jour la règle et réévalue l'ensemble des transactions éligibles (`is_manual_category = false AND transfer_group_id IS NULL AND is_manual_transfer_override = false`) dans une transaction SQL atomique.
- **Réponse `200 OK`** : même structure `{ rule, retroactive_stats, latest_revision }`.

#### `DELETE /api/rules/:id`
- **Comportement** : soft-delete (`deleted_at = now()`) de la règle, réévaluation des transactions éligibles (`is_manual_category = false AND transfer_group_id IS NULL AND is_manual_transfer_override = false`) qui étaient liées à cette règle (application de la règle suivante par priorité ou retour à `"Non catégorisé"`), incrément de `revision`.
- **Réponse `200 OK`** :
```json
{
  "deleted_rule_id": "55555555-5555-4555-8555-555555555555",
  "retroactive_stats": {
    "reassigned_count": 2,
    "reset_uncategorized_count": 5,
    "skipped_manual_count": 1
  },
  "latest_revision": 1489
}
```

---

## 6. Endpoints Synchronisation Google Drive Manuelle Exclusive (`/api/sync/drive/*`)

> **Règle absolue** : Aucun scan automatique. Les 2 dossiers Drive autorisés sont figés côté serveur dans `api` et `sync-worker` :
> - `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` (`boursobank`)
> - `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` (`revolut`)

### 6.1 `POST /api/sync/drive`

Lance un run manuel complet sur les 2 dossiers exclusifs.

- **Requête** : corps vide `{}` (aucun `folder_id` arbitraire accepté du client ; le périmètre est imposé serveur).
- **Comportement** :
  1. Vérifie qu'aucun `drive_sync_runs` n'est à `status = 'running'` (sinon `409 SYNC_ALREADY_RUNNING`).
  2. Crée la ligne `drive_sync_runs` (`status: 'running'`, `trigger_mode: 'manual'`).
  3. Envoie un ordre interne HTTP signé (`POST http://sync-worker:4001/internal/runs`) au `sync-worker`.
  4. Le worker liste les PDF des 2 dossiers, saute sans appel Gemini les fichiers déjà `'committed'` avec le même `md5_checksum`, et traite chaque nouveau PDF (ou PDF modifié) avec checkpoint SQL individuel et `db.transaction` atomique par fichier.
- **Réponse `202 Accepted`** :
```json
{
  "run": {
    "id": "66666666-6666-4666-8666-666666666666",
    "status": "running",
    "trigger_mode": "manual",
    "allowed_folders": [
      { "folder_id": "1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h", "bank": "boursobank" },
      { "folder_id": "1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus", "bank": "revolut" }
    ],
    "started_at": "2026-11-21T13:30:00.000Z"
  }
}
```

### 6.2 `GET /api/sync/drive/status`

Retourne l'état détaillé du dernier run (ou d'un run ciblé via `?run_id=<uuid>`) fichier par fichier pour l'écran `Synchro Drive`. Le frontend Web interroge cette route à cadence bornée (ex. toutes les 2 s) **uniquement pendant qu'un run manuel est à `status === "running"`**, puis s'arrête dès que `status` atteint `"completed" | "partial_error" | "failed"`.

- **Réponse `200 OK`** :
```json
{
  "run": {
    "id": "66666666-6666-4666-8666-666666666666",
    "status": "partial_error",
    "trigger_mode": "manual",
    "started_at": "2026-11-21T13:30:00.000Z",
    "finished_at": "2026-11-21T13:30:42.000Z",
    "summary": {
      "total_files_discovered": 10,
      "files_committed": 7,
      "files_skipped_unchanged": 2,
      "files_failed": 1,
      "files_in_progress": 0
    },
    "latest_revision": 1495
  },
  "files": [
    {
      "drive_file_id": "1Bx99_bourso_2026_10",
      "drive_folder_id": "1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h",
      "bank": "boursobank",
      "file_name": "Releve_BoursoBank_2026_10.pdf",
      "md5_checksum": "d41d8cd98f00b204e9800998ecf8427e",
      "status": "committed",
      "attempt_count": 1,
      "inserted_tx_count": 48,
      "dedup_skipped_tx_count": 0,
      "detected_accounts_count": 2,
      "error_code": null,
      "error_message": null,
      "updated_at": "2026-11-21T13:30:18.000Z"
    },
    {
      "drive_file_id": "1Rev_2026_10_usd",
      "drive_folder_id": "1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus",
      "bank": "revolut",
      "file_name": "Revolut_Statement_2026_10.pdf",
      "md5_checksum": "a87ff679a2f3e71d9181a67b7542122c",
      "status": "failed",
      "attempt_count": 1,
      "inserted_tx_count": 0,
      "dedup_skipped_tx_count": 0,
      "detected_accounts_count": 0,
      "error_code": "GEMINI_TIMEOUT",
      "error_message": "Délai Gemini dépassé lors de l'extraction (code 504). Aucune écriture partielle appliquée.",
      "updated_at": "2026-11-21T13:30:42.000Z"
    }
  ]
}
```
- **Statuts possibles par fichier** : `"pending" | "extracting" | "parsed" | "committing" | "committed" | "skipped" | "failed"`.
- **Statuts possibles de run** : `"running" | "completed" | "partial_error" | "failed"`.
- **Codes d'erreur checkpoint PDF unifiés (`error_code`)** : `"GEMINI_TIMEOUT" | "GEMINI_SCHEMA_INVALID" | "GEMINI_QUOTA_EXCEEDED" | "PDF_UNREADABLE" | "DRIVE_DOWNLOAD_ERROR"`.

### 6.3 `POST /api/sync/drive/files/:fileId/retry`

Relance l'extraction Gemini et le commit atomique **uniquement pour le fichier PDF `:fileId` en échec**, sans re-traiter les fichiers déjà `'committed'`.

- **Requête** : `{}`
- **Vérifications serveur** :
  - Le `drive_file_id` existe en base et son `drive_folder_id` appartient strictement aux 2 IDs autorisés (`403 INVALID_DRIVE_FOLDER_SCOPE` sinon).
  - Le checkpoint du fichier est au statut `'failed'` (`409 FILE_NOT_RETRYABLE` sinon).
  - Aucun autre run complet n'est `'running'` (`409 SYNC_ALREADY_RUNNING` sinon).
- **Réponse `202 Accepted`** :
```json
{
  "run_id": "77777777-7777-4777-8777-777777777777",
  "drive_file_id": "1Rev_2026_10_usd",
  "status": "pending",
  "attempt_count": 2,
  "started_at": "2026-11-21T13:32:00.000Z"
}
```

---

## 7. Contrat Delta Sync Android Offline-First (`GET /api/sync/delta`)

### 7.1 Mécanisme de Curseur Monotone (`since`)

- Chaque mutation d'entité (`accounts`, `transactions`, `transaction_notes`, `categorization_rules`, `drive_sync_status`) obtient côté serveur un numéro de révision monotone global `revision` (séquence SQL PostgreSQL `sync_revision_seq`).
- L'APK Android stocke localement `last_synced_revision` (initialisé à `0` lors de la première installation).
- À chaque reconnexion, reprise de l'app au premier plan, ou après une action d'écriture en ligne, l'APK appelle :
  `GET /api/sync/delta?since=<last_synced_revision>&limit=500`
- **Garantie de cohérence de snapshot & Intégrité FK lors du bootstrap (`since=0`)** :
  - Le serveur lit en une transaction `REPEATABLE READ` (ou borne `<= head_revision` capturée au début de la requête) toutes les lignes dont `revision > since` et `revision <= page_max_revision`.
  - Lors d'un bootstrap initial (`since=0`), le serveur livre l'intégralité de `accounts` et `categorization_rules` dès la première page (ou avant les `transactions` paginées). Côté client Android SQLite, le commit local diffère les contraintes de clés étrangères (`PRAGMA defer_foreign_keys = ON`) jusqu'à réception complète de la séquence (`has_more === false`).
  - Si `has_more === true`, le client enchaîne avec `?since=<batch_end_revision>` jusqu'à `has_more === false`, puis met à jour `aggregates_snapshot` et persiste `latest_revision` dans `local_sync_meta`.
  - Si `since > latest_revision` (curseur client obsolète ou issu d'un jeu de démonstration), le serveur bascule automatiquement sur un resync depuis `0` avec `full_resync_required: true` afin de rétablir la cohérence locale.
  - Le serveur ne renvoie **jamais** de PDF bruts, ni de payloads Gemini bruts, ni de secrets.

### 7.2 Paramètres & Réponse JSON Exacte

- **Query params** :
  - `since` (requis, entier `>= 0`)
  - `limit` (optionnel, entier `50..1000`, défaut `500`, plafond d'entités `transactions` par page pour éviter les pics mémoire dans la WebView Android).

- **Réponse `200 OK`** :
```json
{
  "since_revision": 1400,
  "batch_end_revision": 1495,
  "latest_revision": 1495,
  "has_more": false,
  "full_resync_required": false,
  "server_time": "2026-11-21T13:35:00.000Z",
  "accounts": {
    "upserted": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "bank": "boursobank",
        "account_type": "courant",
        "nickname": "Joint BoursoBank",
        "external_ref_masked": "•••• 4821",
        "currency": "EUR",
        "current_balance_cents": 412840,
        "current_balance_eur_cents": 412840,
        "balance_updated_at": "2026-11-20T23:59:59.000Z",
        "revision": 1483,
        "updated_at": "2026-11-21T13:20:00.000Z"
      }
    ],
    "deleted_ids": []
  },
  "transactions": {
    "upserted": [
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "account_id": "22222222-2222-4222-8222-222222222222",
        "bank": "revolut",
        "account_type": "multi_devises",
        "external_ref_masked": "USD •• 9012",
        "booking_date": "2026-11-18",
        "value_date": "2026-11-18",
        "raw_label": "CURSOR AI *MONTHLY SAN FRANCISCO US",
        "clean_label": "Cursor AI",
        "amount_cents": -2000,
        "currency": "USD",
        "fx_rate_micro": 924500,
        "amount_eur_cents": -1849,
        "category": "Logiciels & Cloud",
        "is_manual_category": false,
        "matched_rule_id": "44444444-4444-4444-8444-444444444444",
        "is_internal_transfer": false,
        "is_manual_transfer_override": false,
        "transfer_group_id": null,
        "source_drive_file_id": "88888888-8888-4888-8888-888888888888",
        "revision": 1486,
        "updated_at": "2026-11-21T13:22:00.000Z"
      }
    ],
    "deleted_ids": []
  },
  "transaction_notes": {
    "upserted": [
      {
        "transaction_id": "33333333-3333-4333-8333-333333333333",
        "content": "Remboursement partagé avec Thomas (50 %)",
        "revision": 1484,
        "updated_at": "2026-11-21T13:21:00.000Z"
      }
    ],
    "deleted_transaction_ids": []
  },
  "categorization_rules": {
    "upserted": [
      {
        "id": "55555555-5555-4555-8555-555555555555",
        "name": "Abonnements Cursor",
        "priority": 100,
        "bank_filter": "revolut",
        "account_id_filter": "22222222-2222-4222-8222-222222222222",
        "account_type_filter": null,
        "match_mode": "contains",
        "pattern": "CURSOR AI",
        "target_category": "Logiciels & Cloud",
        "mark_as_internal_transfer": false,
        "is_active": true,
        "revision": 1487,
        "updated_at": "2026-11-21T13:25:00.000Z"
      }
    ],
    "deleted_ids": []
  },
  "drive_sync_status": {
    "last_run": {
      "id": "66666666-6666-4666-8666-666666666666",
      "status": "partial_error",
      "trigger_mode": "manual",
      "started_at": "2026-11-21T13:30:00.000Z",
      "finished_at": "2026-11-21T13:30:42.000Z",
      "total_files_discovered": 10,
      "files_committed": 7,
      "files_skipped_unchanged": 2,
      "files_failed": 1
    },
    "files": [
      {
        "drive_file_id": "1Rev_2026_10_usd",
        "drive_folder_id": "1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus",
        "bank": "revolut",
        "file_name": "Revolut_Statement_2026_10.pdf",
        "status": "failed",
        "attempt_count": 1,
        "error_code": "GEMINI_TIMEOUT",
        "error_message": "Délai Gemini dépassé lors de l'extraction (code 504).",
        "revision": 1495,
        "updated_at": "2026-11-21T13:30:42.000Z"
      }
    ]
  },
  "aggregates_snapshot": {
    "computed_at": "2026-11-21T13:30:43.000Z",
    "data_revision": 1495,
    "by_scope": {
      "all_eur": {
        "display_currency": "EUR",
        "reference_month": "2026-11",
        "kpis": {
          "consolidated_balance_cents": 1245080,
          "month_income_cents": 385000,
          "month_expenses_excl_transfers_cents": 194230,
          "month_internal_transfers_cents": 65000
        },
        "cumulative_balance_6m": [
          { "month": "2026-06", "label": "Juin", "closing_balance_cents": 980200, "net_change_cents": 12400 }
        ],
        "expenses_m1_vs_avg3m": [
          { "category": "Alimentation", "m_minus_1_cents": 48200, "avg_3m_cents": 43800, "delta_percent": 10.05, "transaction_count_m1": 19 }
        ]
      },
      "usd_only": {
        "display_currency": "USD",
        "reference_month": "2026-11",
        "kpis": {
          "consolidated_balance_cents": 185000,
          "month_income_cents": 0,
          "month_expenses_excl_transfers_cents": 2000,
          "month_internal_transfers_cents": 50000
        },
        "cumulative_balance_6m": [],
        "expenses_m1_vs_avg3m": []
      }
    }
  }
}
```
- **Règle d'inclusion de `aggregates_snapshot`** :
  - Lorsque `has_more === false` et que `latest_revision > since_revision` (ou `since === 0`), `aggregates_snapshot` inclut les vues pré-calculées pour `"all_eur"`, `"usd_only"`, `"bank:boursobank"`, `"bank:revolut"` et chaque `"account:<id>"`.
  - Si `latest_revision === since_revision` (aucun changement), le serveur renvoie des tableaux vides et `aggregates_snapshot: null` (réponse ultra-légère `< 1 Ko`).

---

## 8. Contrats API & Delta Sync v2 (Extension Rétrocompatible)

- **Statut** : Normatif — Phase Pré-Code EGM v2
- **Date** : 2026-11-26
- **Références** :
  - [DATA_MODEL_DRIZZLE_SPEC.md (Partie II)](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md)
  - [ADR 0005 — Catégories hiérarchiques & IA Gemini hybride](file:///d:/Applications/Clairflux/docs/ADR/0005-categories-hierarchy-and-gemini-hybrid-categorization.md)
  - [ADR 0006 — Budget Monarch, Rollover & Projections](file:///d:/Applications/Clairflux/docs/ADR/0006-monarch-budget-rollover-and-forecasting.md)

> [!IMPORTANT]
> Toutes les routes v1 des sections 1 à 7 restent intactes et fonctionnelles pendant la transition. Les nouvelles routes v2 d'IA Gemini, de gestion des catégories et de budgets Monarch exigent une connexion réseau active et sont protégées par le middleware d'authentification personnel (`Cookie HttpOnly` + `X-Clairflux-Client: web` + `Origin`, ou `Authorization: Bearer` sur Android).

### 8.1 Extension des Codes d'Erreur Normalisés (`ApiErrorCode`)

| Code HTTP | `error.code` | Signification & Comportement Client Attendu | `retryable` |
| --- | --- | --- | --- |
| `400` / `422` | `CATEGORY_REASSIGN_REQUIRED` | Tentative de `DELETE /api/categories/:id` sans `reassign_to_category_id` actif valide. | `false` |
| `409` | `CATEGORY_HAS_CHILDREN_OR_SYSTEM` | Suppression refusée sur une catégorie système protégée (`Non catégorisé`, `Transfert interne`) ou possédant encore des sous-catégories actives. | `false` |
| `422` | `CATEGORY_DEPTH_EXCEEDED` | Tentative de rattacher une sous-catégorie à une catégorie qui a déjà un `parent_id` (profondeur max 2 niveaux). | `false` |
| `409` | `AI_BACKFILL_ALREADY_RUNNING` | `POST /api/ai/categorize/backfill` refusé car un run `'running'` existe (`details.active_run_id`). | `true` |
| `409` | `AI_BACKFILL_NOT_RUNNING` | `POST /api/ai/categorize/cancel` appelé alors qu'aucun run n'est `'running'`. | `false` |
| `409` | `RECURRING_AUTO_SERIES_USE_DISMISS` | `DELETE /api/analytics/recurring/:id` appelé sur une série `source = 'auto_detected'` (utiliser `PATCH` avec `status: 'dismissed'` ou `'cancelled'`). | `false` |
| `503` | `GEMINI_API_NOT_CONFIGURED` | Variable `GEMINI_API_KEY` absente ou invalide pour le rattrapage ou le bilan mensuel. | `false` |

---

### 8.2 CRUD Catégories & Sous-Catégories (`/api/categories`)

#### `GET /api/categories`
- **Query params optionnels** : `include_archived` (`"true" | "false"`, défaut `"false"`).
- **Réponse `200 OK`** : retourne la liste structurée des catégories racines (niveau 1) et sous-catégories (niveau 2) avec compteurs d'opérations associées et `latest_revision` :
```json
{
  "categories": [
    {
      "id": "c1000000-0000-4000-8000-000000000001",
      "parent_id": null,
      "name": "Alimentation",
      "slug": "alimentation",
      "budget_group": "variable",
      "color_token": "emerald",
      "sort_order": 10,
      "is_system": true,
      "is_archived": false,
      "transaction_count": 142,
      "revision": 1501,
      "updated_at": "2026-11-26T10:00:00.000Z"
    },
    {
      "id": "c1000000-0000-4000-8000-000000000002",
      "parent_id": "c1000000-0000-4000-8000-000000000001",
      "name": "Courses",
      "slug": "alimentation-courses",
      "budget_group": "variable",
      "color_token": "emerald",
      "sort_order": 11,
      "is_system": true,
      "is_archived": false,
      "transaction_count": 98,
      "revision": 1502,
      "updated_at": "2026-11-26T10:00:00.000Z"
    }
  ],
  "latest_revision": 1502
}
```

#### `POST /api/categories`
- **Requête** :
```json
{
  "parent_id": "c1000000-0000-4000-8000-000000000001",
  "name": "Marchés & Primeurs",
  "budget_group": "variable",
  "color_token": "emerald",
  "sort_order": 12
}
```
  - Vérifie côté serveur que si `parent_id !== null`, la catégorie parente existe (`deleted_at IS NULL`) et possède `parent_id === null` (sinon `422 CATEGORY_DEPTH_EXCEEDED`).
- **Réponse `201 Created`** : `{ "category": { ... }, "latest_revision": 1503 }`.

#### `PATCH /api/categories/:id`
- **Requête** : mise à jour partielle (`name`, `budget_group`, `color_token`, `sort_order`, `is_archived`).
- **Comportement** : si `name` change, met à jour atomiquement `transactions.category` et `categorization_rules.target_category` sur les lignes liées et leur alloue un nouveau `revision` (phase Expand).
- **Réponse `200 OK`** : `{ "category": { ... }, "updated_transactions_count": 42, "latest_revision": 1545 }`.

#### `POST /api/categories/:id/merge`
Fusionne la catégorie source `:id` vers une catégorie cible existante et soft-delete la source.
- **Requête** : `{ "target_category_id": "<uuid>", "target_subcategory_id": "<uuid> | null" }`.
- **Comportement transactionnel ACID (`db.transaction`)** :
  1. Réaffecte toutes les `transactions` (et suggestions/règles `categorization_rules`, `ai_rule_suggestions`, `recurring_series`) pointant sur `:id` vers la cible, et synchronise `transactions.category`.
  2. Si la source avait une `budget_config` active et que la cible en a déjà une, soft-delete la `budget_config` source (sinon la transfère sur la cible).
  3. Soft-delete la catégorie source (`deleted_at = now()`, `revision = nextval('sync_revision_seq')`).
- **Réponse `200 OK`** : `{ "merged_from_id": "...", "target_category_id": "...", "reassigned_transactions_count": 19, "latest_revision": 1560 }`.

#### `DELETE /api/categories/:id`
- **Requête** : `{ "reassign_to_category_id": "<uuid>", "reassign_to_subcategory_id": "<uuid> | null" }` (réaffectation **obligatoire** ; `400/422 CATEGORY_REASSIGN_REQUIRED` si absent ou égal à `:id`).
- **Garde-fous** : refuse `409 CATEGORY_HAS_CHILDREN_OR_SYSTEM` si la catégorie est `'Non catégorisé'` / `'Transfert interne'` ou si elle possède encore des sous-catégories actives (`deleted_at IS NULL`).
- **Réponse `200 OK`** : `{ "deleted_category_id": "...", "reassigned_transactions_count": 12, "latest_revision": 1565 }`.

---

### 8.3 IA Gemini : Rattrapage Manuel, Boîte de Révision & Suggestions de Règles (`/api/ai/*`)

> **Invariant de coût & contrôle** : Aucun appel Gemini ne part en tâche de fond non sollicitée. Le rattrapage par lots de 50 opérations (`gemini-4-hydrogen` → `gemini-3.8-flash` → `gemini-3.1-flash-lite`, header `x-goog-api-key`) démarre uniquement sur clic manuel.

#### `POST /api/ai/categorize/backfill`
- **Requête** : `{ "batch_size": 50, "only_uncategorized": true }` (`batch_size` borné `10..50`, défaut `50`).
- **Vérification** : s'il existe une ligne `ai_categorization_runs` avec `status = 'running'`, retourne **`409 AI_BACKFILL_ALREADY_RUNNING`** avec `details.active_run_id`.
- **Réponse `202 Accepted`** :
```json
{
  "run": {
    "id": "a1000000-0000-4000-8000-000000000001",
    "status": "running",
    "total_target_count": 2940,
    "processed_count": 0,
    "auto_applied_count": 0,
    "queued_review_count": 0,
    "failed_batches": 0,
    "started_at": "2026-11-26T12:00:00.000Z"
  }
}
```

#### `GET /api/ai/categorize/status`
- **Query params optionnels** : `run_id` (`uuid`).
- **Réponse `200 OK`** :
```json
{
  "run": {
    "id": "a1000000-0000-4000-8000-000000000001",
    "status": "running",
    "cursor_tx_id": "33333333-3333-4333-8333-333333333399",
    "total_target_count": 2940,
    "processed_count": 450,
    "auto_applied_count": 382,
    "queued_review_count": 68,
    "failed_batches": 0,
    "model_used": "gemini-4-hydrogen",
    "estimated_tokens": 38400,
    "error_summary": null,
    "started_at": "2026-11-26T12:00:00.000Z",
    "finished_at": null
  },
  "pending_review_count": 68,
  "latest_revision": 1820
}
```

#### `POST /api/ai/categorize/cancel`
- **Requête** : `{}`
- **Comportement** : demande l'arrêt coopératif du run `'running'` après finalisation du lot de 50 en cours (les lots déjà committés sont préservés). Passe `status = 'cancelled'`, `finished_at = now()`.
- **Réponse `200 OK`** : retourne `{ "run": { ... } }` (`409 AI_BACKFILL_NOT_RUNNING` si aucun run actif).

#### `GET /api/ai/review-queue`
- **Query params optionnels** : `limit` (`1..100`, défaut `30`), `cursor` (opaque), `min_confidence_bp` (`0..8499`), `category_id` (`uuid`).
- **Réponse `200 OK`** :
```json
{
  "items": [
    {
      "transaction_id": "33333333-3333-4333-8333-333333333401",
      "booking_date": "2026-11-12",
      "account_nickname": "Perso BoursoBank",
      "bank": "boursobank",
      "clean_label": "Pharmacie Lafayette",
      "raw_label": "CARTE 12/11 PHARMACIE LAFAYETTE LYON",
      "amount_cents": -2840,
      "currency": "EUR",
      "amount_eur_cents": -2840,
      "ai_suggested_category_id": "c1000000-0000-4000-8000-000000000030",
      "ai_suggested_subcategory_id": "c1000000-0000-4000-8000-000000000031",
      "ai_confidence_bp": 7800,
      "ai_reason": "Libellé de pharmacie correspondant à Santé > Pharmacie.",
      "ai_model": "gemini-4-hydrogen"
    }
  ],
  "next_cursor": null,
  "total_pending": 68,
  "latest_revision": 1820
}
```

#### `POST /api/ai/review-queue/resolve`
Valide, corrige ou rejette unitaire ou en lot (`1..100` éléments) les propositions en attente, avec option de création immédiate d'une règle durable.
- **Requête** :
```json
{
  "items": [
    {
      "transaction_id": "33333333-3333-4333-8333-333333333401",
      "action": "accept",
      "create_rule": {
        "name": "Pharmacies",
        "pattern": "PHARMACIE",
        "match_mode": "contains",
        "priority": 100
      }
    },
    {
      "transaction_id": "33333333-3333-4333-8333-333333333402",
      "action": "override",
      "category_id": "c1000000-0000-4000-8000-000000000010",
      "subcategory_id": null
    }
  ]
}
```
  - `action` : `"accept" | "override" | "reject"` (`category_id` obligatoire lorsque `action === "override"`).
- **Comportement** :
  - `accept` : applique la suggestion IA, passe `category_source = 'ai_validated'`, `is_manual_category = true`, `ai_review_status = 'accepted'`.
  - `override` : applique `category_id` / `subcategory_id`, passe `category_source = 'manual'`, `is_manual_category = true`, `ai_review_status = 'rejected'`.
  - `reject` : maintient `'Non catégorisé'`, passe `ai_review_status = 'rejected'`.
  - Si `create_rule` est fourni : insère la règle dans `categorization_rules` et exécute le recalcul rétroactif respectant `is_manual_category = false`.
- **Réponse `200 OK`** : `{ "resolved_count": 2, "created_rules_count": 1, "retroactive_updated_count": 14, "latest_revision": 1836 }`.

#### `GET /api/ai/rule-suggestions`
- **Query params optionnels** : `status` (`"pending" | "accepted" | "dismissed"`, défaut `"pending"`).
- **Réponse `200 OK`** :
```json
{
  "suggestions": [
    {
      "id": "s1000000-0000-4000-8000-000000000001",
      "suggested_pattern": "CARREFOUR CITY",
      "match_mode": "contains",
      "target_category_id": "c1000000-0000-4000-8000-000000000001",
      "target_subcategory_id": "c1000000-0000-4000-8000-000000000002",
      "sample_count": 6,
      "status": "pending",
      "created_at": "2026-11-26T12:10:00.000Z"
    }
  ],
  "latest_revision": 1836
}
```

#### `POST /api/ai/rule-suggestions/:id/accept` & `POST /api/ai/rule-suggestions/:id/dismiss`
- **`accept`** : corps optionnel `{ "name"?: string, "pattern"?: string, "match_mode"?: RuleMatchMode, "priority"?: number }`. Crée la règle active dans `categorization_rules`, marque la suggestion `'accepted'` avec `accepted_rule_id`, et applique la règle rétroactivement sur l'historique éligible (`is_manual_category = false`). Retourne `200 OK { rule, retroactive_stats, latest_revision }`.
- **`dismiss`** : corps `{}`. Marque la suggestion `'dismissed'` (`200 OK { id, status: "dismissed", latest_revision }`).

---

### 8.4 Budget Monarch, Rollover & Ajustements Mensuels (`/api/budgets/*`)

> Les routes v1 (`GET/PUT/DELETE /api/budgets`) demeurent opérationnelles en parallèle pendant la phase Expand.

#### `GET /api/budgets/plan`
- **Query params** :
  - `month` (`YYYY-MM`, défaut mois courant).
  - `scope` (`"all_eur"` défaut | `"usd_only"` | `"bank:boursobank"` | `"bank:revolut"` | `"account:<uuid>"`).
- **Réponse `200 OK`** :
```json
{
  "month": "2026-11",
  "scope": "all_eur",
  "display_currency": "EUR",
  "summary": {
    "total_budgeted_cents": 245000,
    "total_carried_rollover_cents": 12500,
    "total_available_cents": 98200,
    "total_spent_cents": 159300,
    "month_income_cents": 385000,
    "unbudgeted_spent_cents": 18400
  },
  "groups": [
    {
      "budget_group": "fixed",
      "budgeted_cents": 120000,
      "carried_rollover_cents": 0,
      "spent_cents": 94500,
      "available_cents": 25500
    },
    {
      "budget_group": "variable",
      "budgeted_cents": 85000,
      "carried_rollover_cents": 4500,
      "spent_cents": 52800,
      "available_cents": 36700
    },
    {
      "budget_group": "non_monthly",
      "budgeted_cents": 40000,
      "carried_rollover_cents": 8000,
      "spent_cents": 12000,
      "available_cents": 36000
    }
  ],
  "items": [
    {
      "budget_config_id": "b1000000-0000-4000-8000-000000000001",
      "category_id": "c1000000-0000-4000-8000-000000000001",
      "parent_id": null,
      "category_name": "Alimentation",
      "budget_group": "variable",
      "currency": "EUR",
      "monthly_limit_cents": 50000,
      "override_limit_cents": null,
      "effective_limit_cents": 50000,
      "rollover_enabled": true,
      "rollover_start_month": "2026-09",
      "rollover_cap_cents": 20000,
      "carried_rollover_cents": 4500,
      "rollover_adjustment_cents": 0,
      "spent_cents": 34200,
      "available_cents": 20300,
      "usage_percent": 62.75,
      "alert_status": "ok",
      "subcaps_exceed_parent_warning": false,
      "override_note": null,
      "revision": 1840
    }
  ],
  "latest_revision": 1840
}
```

#### `PUT /api/budgets/configs/:categoryId`
- **Requête** :
```json
{
  "monthly_limit_cents": 50000,
  "currency": "EUR",
  "rollover_enabled": true,
  "rollover_start_month": "2026-09",
  "rollover_cap_cents": 20000,
  "is_active": true
}
```
- **Comportement** : crée ou met à jour l'enveloppe dans `budget_configs` (`deleted_at = null`), vérifie l'absence de double-comptage dans les totaux de groupe, et retourne `subcaps_exceed_parent_warning` si la somme des sous-plafonds dépasse le plafond du parent.
- **Réponse `200 OK`** : `{ "config": { ... }, "subcaps_exceed_parent_warning": false, "latest_revision": 1841 }`.

#### `DELETE /api/budgets/configs/:categoryId`
- **Comportement** : soft-delete (`deleted_at = now()`) de `budget_configs` pour `:categoryId`, incrément `revision`.
- **Réponse `200 OK`** : `{ "deleted_category_id": "...", "latest_revision": 1842 }`.

#### `PUT /api/budgets/overrides/:categoryId/:month`
- **Requête** :
```json
{
  "override_limit_cents": 65000,
  "rollover_adjustment_cents": -2500,
  "note": "Ajustement vacances + remise à zéro partielle"
}
```
  - `month` validé `YYYY-MM`. `override_limit_cents` (`null` ou entier `>= 0`), `rollover_adjustment_cents` (entier signé, défaut `0`).
- **Réponse `200 OK`** : `{ "override": { ... }, "latest_revision": 1843 }`.

---

### 8.5 Analytique Avancée, Projections, Récurrents & Bilan IA (`/api/analytics/*`, `/api/ai/monthly-brief`)

Toutes les routes analytiques partagent le filtrage `scope` (`all_eur` défaut | `usd_only` | `bank:boursobank` | `bank:revolut` | `account:<uuid>`) et excluent strictement `is_internal_transfer = true`.

#### `GET /api/analytics/categories`
- **Query params** : `scope`, `from` (`YYYY-MM-DD`), `to` (`YYYY-MM-DD`), `parent_category_id` (`uuid` optionnel pour drill-down sous-catégories).
- **Réponse `200 OK`** :
```json
{
  "scope": "all_eur",
  "display_currency": "EUR",
  "from": "2026-11-01",
  "to": "2026-11-30",
  "total_expenses_cents": 194230,
  "categories": [
    {
      "category_id": "c1000000-0000-4000-8000-000000000001",
      "name": "Alimentation",
      "budget_group": "variable",
      "color_token": "emerald",
      "spent_cents": 48200,
      "share_bp": 2482,
      "transaction_count": 19,
      "avg_3m_cents": 43800,
      "subcategories": [
        {
          "category_id": "c1000000-0000-4000-8000-000000000002",
          "name": "Courses",
          "spent_cents": 34200,
          "share_bp": 1761,
          "transaction_count": 12
        }
      ]
    }
  ],
  "data_revision": 1843
}
```

#### `GET /api/analytics/cashflow`
- **Query params** : `scope`, `from` (`YYYY-MM-DD`), `to` (`YYYY-MM-DD`), `months` (`3..12`, défaut `6`).
- **Réponse `200 OK`** : expose les séries mensuelles de Cash Flow / Taux d'épargne **et** le graphe orienté **`sankey_nodes`** + **`sankey_links`** (rendu Desktop/tablette `>= 1024 px`, fallback barres empilées sur mobile) :
```json
{
  "scope": "all_eur",
  "display_currency": "EUR",
  "period_summary": {
    "income_cents": 385000,
    "expenses_cents": 194230,
    "net_savings_cents": 190770,
    "savings_rate_bp": 4955
  },
  "monthly_cashflow": [
    {
      "month": "2026-11",
      "label": "Nov.",
      "income_cents": 385000,
      "expenses_cents": 194230,
      "net_savings_cents": 190770,
      "savings_rate_bp": 4955
    }
  ],
  "sankey_nodes": [
    { "id": "inc:revenus", "label": "Revenus", "kind": "income" },
    { "id": "pool:total", "label": "Revenus nets", "kind": "pool" },
    { "id": "grp:fixed", "label": "Fixes", "kind": "budget_group" },
    { "id": "grp:variable", "label": "Variables", "kind": "budget_group" },
    { "id": "cat:logement", "label": "Logement & Charges", "kind": "category" },
    { "id": "cat:alimentation", "label": "Alimentation", "kind": "category" },
    { "id": "sav:net", "label": "Épargne nette", "kind": "savings" }
  ],
  "sankey_links": [
    { "source": "inc:revenus", "target": "pool:total", "value_cents": 385000 },
    { "source": "pool:total", "target": "grp:fixed", "value_cents": 94500 },
    { "source": "pool:total", "target": "grp:variable", "value_cents": 99730 },
    { "source": "grp:fixed", "target": "cat:logement", "value_cents": 94500 },
    { "source": "grp:variable", "target": "cat:alimentation", "value_cents": 48200 },
    { "source": "pool:total", "target": "sav:net", "value_cents": 190770 }
  ],
  "data_revision": 1843
}
```

#### `GET /api/analytics/forecast`
- **Query params** : `scope`, `horizon` (`3 | 6 | 12`, défaut `6`), `reference_month` (`YYYY-MM` optionnel).
- **Réponse `200 OK`** :
```json
{
  "scope": "all_eur",
  "display_currency": "EUR",
  "horizon": 6,
  "starting_balance_cents": 1245080,
  "assumptions": {
    "baseline_monthly_income_cents": 385000,
    "recurring_monthly_expenses_cents": 112000,
    "variable_monthly_expenses_cents": 82230,
    "uncertainty_band_bp": 1500
  },
  "points": [
    {
      "month": "2026-12",
      "label": "Déc.",
      "projected_balance_cents": 1435850,
      "prudent_balance_cents": 1407234,
      "optimistic_balance_cents": 1464466,
      "projected_income_cents": 385000,
      "projected_expenses_cents": 194230
    }
  ],
  "data_revision": 1843
}
```
> *Note Offline* : Le simulateur interactif *« Et si... »* (ajustement revenus/dépenses/épargne via curseurs) recalcule les trajectoires localement en `< 5 ms` dans le Web Worker client à partir de ces bases sans aucun appel réseau.

#### `GET /api/analytics/recurring`, `POST /api/analytics/recurring`, `PATCH /api/analytics/recurring/:id` & `DELETE /api/analytics/recurring/:id`

- **`GET /api/analytics/recurring`** (`?month=YYYY-MM&include_income=true|false&scope=...&status=detected|confirmed|dismissed|cancelled`) :
  - `month` (`YYYY-MM`, défaut mois calendaire courant) pilote la grille calendrier mensuelle et les compteurs `paid_this_month_cents` / `remaining_this_month_cents`.
  - `include_income` (`"true" | "false"`, défaut `"false"`) inclut ou exclut les séries `direction === "income"` dans `occurrences[]`, `series[]` et le détail de synthèse.
  - **Réponse `200 OK`** :
```json
{
  "month": "2026-11",
  "scope": "all_eur",
  "display_currency": "EUR",
  "include_income": false,
  "summary": {
    "monthly_smoothed_cents": 128450,
    "annual_smoothed_part_cents": 18250,
    "paid_this_month_cents": 94500,
    "remaining_this_month_cents": 23950
  },
  "occurrences": [
    {
      "date": "2026-11-05",
      "status": "paid",
      "matched_transaction_id": "33333333-3333-4333-8333-333333333335",
      "series_id": "r1000000-0000-4000-8000-000000000001",
      "display_name": "Loyer & EDF",
      "cadence": "monthly",
      "source": "auto_detected",
      "direction": "expense",
      "amount_cents": -94500,
      "amount_eur_cents": -94500,
      "currency": "EUR",
      "price_change_pct_bp": null
    },
    {
      "date": "2026-11-28",
      "status": "upcoming",
      "matched_transaction_id": null,
      "series_id": "r1000000-0000-4000-8000-000000000002",
      "display_name": "Assurance Habitation",
      "cadence": "yearly",
      "source": "manual",
      "direction": "expense",
      "amount_cents": -23950,
      "amount_eur_cents": -23950,
      "currency": "EUR",
      "price_change_pct_bp": null
    }
  ],
  "series": [
    {
      "id": "r1000000-0000-4000-8000-000000000001",
      "merchant_key": "loyer edf",
      "display_name": "Loyer & EDF",
      "account_id": "11111111-1111-4111-8111-111111111112",
      "category_id": "c1000000-0000-4000-8000-000000000020",
      "cadence": "monthly",
      "source": "auto_detected",
      "direction": "expense",
      "expected_amount_cents": -94500,
      "currency": "EUR",
      "tolerance_bp": 500,
      "billing_day": 5,
      "last_seen_date": "2026-11-05",
      "next_expected_date": "2026-12-05",
      "previous_amount_cents": -94500,
      "price_change_pct_bp": 0,
      "status": "confirmed",
      "cancelled_at": null,
      "notes": null,
      "revision": 1842
    }
  ],
  "data_revision": 1843
}
```
- **`POST /api/analytics/recurring`** (ajout manuel d'une échéance anticipée) :
  - **Requête** :
```json
{
  "display_name": "Assurance Habitation",
  "expected_amount_cents": -23950,
  "currency": "EUR",
  "cadence": "yearly",
  "direction": "expense",
  "billing_day": 28,
  "next_expected_date": "2026-11-28",
  "account_id": "11111111-1111-4111-8111-111111111111",
  "category_id": "c1000000-0000-4000-8000-000000000020",
  "tolerance_bp": 500,
  "notes": "Échéance annuelle MAIF avant premier prélèvement relevé"
}
```
  - **Comportement** : force `source = 'manual'`, `status = 'confirmed'`, normalise `merchant_key` et garantit la cohérence du signe de `expected_amount_cents` avec `direction` (`< 0` pour `'expense'`, `> 0` pour `'income'`), positionne `last_seen_date = next_expected_date` par défaut si aucun prélèvement passé n'existe encore, et alloue un `revision`. Dès l'ingestion d'un relevé réel correspondant, la série est rapprochée sur place sans doublon (cf. `DATA_MODEL_DRIZZLE_SPEC.md` §8.3).
  - **Réponse `201 Created`** : `{ "series": { ... }, "latest_revision": 1845 }`.
- **`PATCH /api/analytics/recurring/:id`** :
  - Corps partiel `{ "status"?: "detected" | "confirmed" | "dismissed" | "cancelled", "display_name"?: string, "billing_day"?: number | null, "cadence"?: "weekly" | "monthly" | "quarterly" | "yearly", "expected_amount_cents"?: number, "next_expected_date"?: string, "category_id"?: uuid | null, "cancelled_at"?: string | null, "notes"?: string | null }`.
  - Si `status === "cancelled"` et `cancelled_at` est omis, le serveur positionne `cancelled_at` à la date UTC du jour (`YYYY-MM-DD`).
  - Met à jour la série et incrémente `revision` (`200 OK { series, latest_revision }`).
- **`DELETE /api/analytics/recurring/:id`** :
  - Soft-delete (`deleted_at = now()`, `revision = nextval('sync_revision_seq')`) d'une échéance ajoutée manuellement (`source === "manual"`). Retourne `409 RECURRING_AUTO_SERIES_USE_DISMISS` si `source === "auto_detected"`.
  - **Réponse `200 OK`** : `{ "deleted_series_id": "...", "latest_revision": 1846 }`.

#### `GET /api/analytics/merchants`
- **Query params** : `scope`, `from`, `to`, `limit` (`1..50`, défaut `15`).
- **Réponse `200 OK`** :
```json
{
  "scope": "all_eur",
  "display_currency": "EUR",
  "merchants": [
    {
      "merchant_key": "biocoop",
      "display_name": "Biocoop",
      "category_id": "c1000000-0000-4000-8000-000000000001",
      "category_name": "Alimentation",
      "total_spent_cents": 68400,
      "transaction_count": 9,
      "avg_ticket_cents": 7600,
      "last_booking_date": "2026-11-14"
    }
  ],
  "data_revision": 1843
}
```

#### `POST /api/ai/monthly-brief`
- **Déclenchement strictement manuel**.
- **Requête** : `{ "month": "2026-11", "scope": "all_eur", "force_regenerate": false }`.
- **Comportement** :
  1. Consulte `ai_monthly_briefs` pour `(month, scope, display_currency)`. Si présent avec `data_revision === latest_revision` et `force_regenerate === false`, renvoie immédiatement le cache SQL (`cached: true`, 0 appel Gemini).
  2. Sinon, agrège les totaux en centimes anonymisés (catégories, dépassements de budget, variations M-1 vs moyenne 3M, alertes de hausse de récurrents), appelle Gemini (header `x-goog-api-key`), valide le JSON structuré par Zod, enregistre dans `ai_monthly_briefs` avec un nouveau `revision`, et retourne `200 OK` :
```json
{
  "cached": false,
  "brief": {
    "id": "m1000000-0000-4000-8000-000000000001",
    "month": "2026-11",
    "scope_key": "all_eur",
    "display_currency": "EUR",
    "summary_json": {
      "headline": "Taux d'épargne solide à 49,6 % malgré une hausse sur l'Alimentation.",
      "highlights": [
        "Les dépenses hors transferts s'établissent à 1 942,30 € contre 3 850,00 € de revenus.",
        "L'enveloppe Alimentation conserve 203,00 € de disponible grâce à 45,00 € de rollover."
      ],
      "budget_warnings": [
        "Abonnements SaaS : hausse détectée de +12,5 % sur les séries récurrentes USD."
      ],
      "savings_note": "Maintenir le rythme actuel permet d'ajouter ~1 900 € d'épargne nette en décembre."
    },
    "model_used": "gemini-4-hydrogen",
    "data_revision": 1843,
    "generated_at": "2026-11-26T12:30:00.000Z",
    "revision": 1844
  },
  "latest_revision": 1844
}
```

---

### 8.6 Contrat Delta Sync v2 (`CLAIRFLUX_DELTA_SCHEMA_VERSION = '2.0.0'`) & Outbox Existante

#### A. Extension Rétrocompatible de `GET /api/sync/delta`

- **Version de contrat** : `CLAIRFLUX_DELTA_SCHEMA_VERSION` passe de `'1.0.0'` à `'2.0.0'` (exposée via `sync_meta.schema_version` et `schema_version` dans la réponse JSON).
- **Bootstrap propre sur migration client** : lorsque l'APK Android ou le client Web v2 détecte que son `local_schema_version` est absent ou `< '2.0.0'`, il réinitialise son store local et relance `GET /api/sync/delta?since=0&limit=500`.
- **Ordre d'intégrité FK sur `since=0`** : dès la première page (`since=0`), le serveur inclut l'intégralité de `categories` et `accounts` avant les pages de `transactions`.
- **Champs ajoutés dans `GET /api/sync/delta`** (en plus de tous les blocs v1 conservés) :
  - `schema_version`: `"2.0.0"`
  - `categories`: `{ upserted: Category[], deleted_ids: CategoryId[] }`
  - `budget_configs`: `{ upserted: BudgetConfig[], deleted_ids: BudgetConfigId[] }`
  - `budget_monthly_overrides`: `{ upserted: BudgetMonthlyOverride[], deleted_ids: BudgetOverrideId[] }`
  - `recurring_series`: `{ upserted: RecurringSeries[], deleted_ids: RecurringSeriesId[] }` *(inclut `source` `'auto_detected' | 'manual'`, `direction` `'expense' | 'income'`, `billing_day`, `status` `'detected' | 'confirmed' | 'dismissed' | 'cancelled'`, `cancelled_at`, `notes` pour permettre le calcul 100 % hors-ligne du calendrier et des 3 compteurs dans `Budget > Récurrents & Calendrier`)*
  - `ai_review_items`: `{ pending_count: number, upserted: AiReviewQueueItem[], resolved_transaction_ids: TransactionId[] }` *(projection légère pour consultation et tri hors-ligne sur Android ; la résolution reste en ligne uniquement)*
  - `latest_ai_brief`: `AiMonthlyBrief | null` *(dernier bilan mensuel déjà mis en cache sur `all_eur` pour relecture hors-ligne)*
  - Sur chaque objet `transactions.upserted[]` : ajout rétrocompatible de `category_id`, `subcategory_id`, `category_source`, `ai_review_status`, `recurring_series_id` (tout en conservant `category` texte).
  - Sur chaque objet `categorization_rules.upserted[]` : ajout rétrocompatible de `target_category_id`, `target_subcategory_id` (tout en conservant `target_category` texte).
  - Sur `drive_sync_status.files[]` : ajout des champs d'archivage Drive (`archive_status`, `archive_error_message`, `archived_at`).

#### B. Maintien Réel de `POST /api/sync/delta` + `applied_client_mutations` (Outbox Existante)

Contrairement à la formulation initiale v0 de la section 1.4, l'implémentation réelle en production ([register-routes.ts](file:///d:/Applications/Clairflux/apps/api/src/routes/register-routes.ts), [contracts.ts](file:///d:/Applications/Clairflux/apps/api/src/routes/contracts.ts), [server.ts](file:///d:/Applications/Clairflux/apps/api/src/server.ts)) et le stockage client IndexedDB ([indexedDbStore.ts](file:///d:/Applications/Clairflux/apps/web/src/offline/indexedDbStore.ts)) maintiennent une **outbox locale ciblée exclusivement pour les annotations et la catégorisation rapide d'opérations** :

1. **Côté Client (`indexedDbStore.ts`, base `clairflux_offline_v1`)** :
   - Le store `outbox_mutations` enregistre uniquement les deux actions locales légères `upsert_note` et `update_category` (`category`, `isInternalTransfer`, `categoryChanged`, `transferOverrideChanged`).
   - Les fonctionnalités v2 lourdes ou nécessitant le serveur (appels Gemini, Boîte de révision IA, fusion/suppression de catégories, configuration Budget Monarch / Rollover, génération de bilan IA) **n'entrent jamais dans l'outbox** : elles restent strictement en ligne avec mention explicite *« Connexion requise pour modifier »* hors-ligne.
2. **Côté Serveur (`POST /api/sync/delta` + table `applied_client_mutations`)** :
   - Reçoit `{ "mutations": [...] }` (1 à 100 mutations par lot) avec les variantes discriminées :
     - `upsert_note` (`client_mutation_id`, `transaction_id`, `note`)
     - `set_category` (`client_mutation_id`, `transaction_id`, `category`, plus en v2 optionnellement `category_id?`, `subcategory_id?`)
     - `set_internal_transfer` (`client_mutation_id`, `transaction_id`, `is_internal_transfer`)
   - Chaque mutation calcule son SHA-256 canonique `payload_hash` et vérifie `applied_client_mutations` dans la même `db.transaction` :
     - Déjà présente avec même `payload_hash` → `status: "duplicate"`, retourne le `result_revision` initial sans ré-appliquer.
     - Déjà présente avec `payload_hash` différent → `status: "rejected"`, `reason: "CONFLICT"`.
     - Nouvelle mutation appliquée avec succès → met à jour la transaction/note (et synchronise `category_id` / `subcategory_id` / `category_source = 'manual'` pour `set_category` en v2), enregistre dans `applied_client_mutations`, retourne `status: "applied"` et le nouveau `revision`.

---

## 9. Contrat d'Isolation Docker Compose & Sécurité APK

### 9.1 Topologie des Services (`docker-compose.yml` cible)

```text
[Navigateur Desktop] ──HTTPS──▶ [ web (Nginx/Caddy, non-root) ]
[APK Android]        ──HTTPS──▶       │ (proxy /api/* sur frontend_net)
                                      ▼
                                [ api (Node 22 LTS, non-root) ] ──SSL──▶ [Neon PostgreSQL]
                                      │ (ordre manuel uniquement, backend_net interne)
                                      ▼
                                [ sync-worker (Node 22 LTS, non-root) ]
                                  ├──▶ Google Drive API (lecture seule sur 2 folder_id)
                                  ├──▶ Gemini API (extraction structurée PDF)
                                  └──▶ Neon PostgreSQL (checkpoints + transactions atomiques)
```

| Service | Exposition réseau | Utilisateur OS | Secrets autorisés | Secrets strictement interdits | Healthcheck & Arrêt |
| --- | --- | --- | --- | --- | --- |
| **`web`** | `80/443` (ou derrière reverse-proxy TLS hôte) | Non-root (`nginx` / `caddy`) | Aucun (bundle SPA statique uniquement) | `DATABASE_URL`, `GEMINI_API_KEY`, credentials Drive, `CLAIRFLUX_SESSION_SECRET` | `GET /` (status 200), `Cache-Control: immutable` sur `/assets/*`, `no-cache` sur `index.html` |
| **`api`** | Port interne `3000` sur `frontend_net` & `backend_net` | `node` (UID non-root) | `DATABASE_URL` (Neon SSL), `CLAIRFLUX_ACCESS_SECRET_HASH`, `CLAIRFLUX_SESSION_SECRET`, `INTERNAL_WORKER_TOKEN` | `GEMINI_API_KEY`, clés privées/OAuth Google Drive | `GET /healthz` (process) + `GET /readyz` (`SELECT 1` Neon). `SIGTERM` draine les requêtes HTTP en cours. |
| **`sync-worker`** | Port interne `4001` sur `backend_net` (`internal: true` uniquement) | `node` (UID non-root) | `DATABASE_URL`, `GEMINI_API_KEY`, `GOOGLE_DRIVE_CREDENTIALS` (monté RO `/run/secrets/`), `INTERNAL_WORKER_TOKEN` | `CLAIRFLUX_SESSION_SECRET`, `CLAIRFLUX_ACCESS_SECRET_HASH` | `GET /healthz` interne. `SIGTERM` attend la fin de la `db.transaction` du PDF en cours avant exit propre. |
| **`postgres-local`** *(profil `dev` seul)* | Port local dev uniquement | `postgres` | Credentials de test local éphémères | Secrets de production Neon | `pg_isready` |

### 9.2 Endpoints Techniques & Internes (`api` ↔ `sync-worker`)

- **`GET /api/healthz`** (public sans données sensibles) : `{ "status": "ok" }` (`200`).
- **`GET /api/readyz`** (public sans données sensibles) : teste la connexion Neon (`SELECT 1`) et retourne `200 { "status": "ready", "db": "ok" }` ou `503 { "status": "degraded", "db": "error" }`.
- **`POST http://sync-worker:4001/internal/runs`** (réseau interne Docker `backend_net` uniquement, protégé par header `X-Internal-Token: <INTERNAL_WORKER_TOKEN>`) :
  - Payload : `{ "run_id": "<uuid>", "mode": "full_scan" | "retry_file", "drive_file_id"?: "<id>" }`.
  - Le `sync-worker` re-valide en dur que seuls `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` et `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` peuvent être scannés.

### 9.3 Matrice de Sécurité APK Android & Bundle Client

1. **Zéro secret dans le client Web et l'APK** :
   - Les variables `VITE_*` autorisées au build sont strictement limitées à `VITE_API_BASE_URL` et `VITE_APP_VERSION`.
   - Un contrôle automatisé post-build (`scripts/verify-no-secrets` en CI) inspecte `dist/` et `android/app/src/main/assets/` pour échouer immédiatement si un motif `AIza` (clé Google/Gemini), `postgres://`, `BEGIN PRIVATE KEY`, `service_account`, ou `CLAIRFLUX_SESSION_SECRET` apparaît.
2. **Durcissement Android (`AndroidManifest.xml` / `network_security_config.xml`)** :
   - `android:usesCleartextTraffic="false"` obligatoire sur le build `release`.
   - `android:allowBackup="false"` pour éviter qu'un backup cloud Android non chiffré n'exporte la base SQLite financière locale.
   - `WebView` : chargement exclusif depuis les assets locaux Capacitor (`https://localhost`), zéro chargement de scripts/polices CDN externes (polices `Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono` bundlées dans `dist/`).
