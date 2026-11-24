# Design Draft EGM — Authentification `/api/auth/*` & Bandeau Commun de Filtres Temporels

- **Statut** : Validé par le Product Owner (2026-11-24)
- **Références** :
  - [TECHNICAL_STANDARDS.md](file:///d:/Applications/Clairflux/docs/TECHNICAL_STANDARDS.md)
  - [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)
  - [ADR 0003](file:///d:/Applications/Clairflux/docs/ADR/0003-capacitor-offline-first-delta-sync.md)
  - [ADR 0004](file:///d:/Applications/Clairflux/docs/ADR/0004-ui-baseline-and-recharts-architecture.md)

---

## 1. Résolution des `HTTP 401` — Authentification Personnelle (`/api/auth/*`)

### 1.1 Diagnostic
- `apps/api/src/app.ts` protège toutes les routes `/api/*` (hors `/api/healthz` et `/api/readyz`) par session HMAC-SHA256 (`clairflux_session` cookie HttpOnly ou `Authorization: Bearer <token>`).
- Les endpoints `/api/auth/login`, `/api/auth/session` et `/api/auth/logout` ainsi que l'écran de déverrouillage Web/Android n'étaient pas encore implémentés.
- De plus, `apps/web/src/main.tsx` initialisait `useOfflineStore` avec `INITIAL_SEED_DATASET` (`revision: 1482`), supérieur à la révision réelle de Neon (`0` au démarrage).

### 1.2 Contrats & Décisions d'Architecture
1. **Vérification du secret sans addon natif (`apps/api/src/auth/password.ts`)** :
   - `apps/api/Dockerfile` utilise `node:22-alpine` avec `--ignore-scripts`. Pour éviter toute compilation C++ fragile sur Alpine, la vérification de `CLAIRFLUX_ACCESS_SECRET_HASH` s'appuie sur `@noble/hashes/argon2.js` (pur JS) pour Argon2id PHC, complété par `node:crypto` (`scryptSync` et `sha256` comparés via `timingSafeEqual`).
   - Paramètres Argon2id bornés (`m`: `1024..262144` KiB, `t`: `1..16`, `p`: `1..16`, `dkLen`: `16..64`) contre tout déni de service.
2. **Protection anti-brute-force (`apps/api/src/auth/rate-limit.ts`)** :
   - Limitation stricte à **5 échecs / 15 minutes** par IP (`X-Forwarded-For` ou `'direct'`), réponse `429 RATE_LIMITED` avec en-tête `Retry-After`.
3. **Cookie LAN HTTP vs HTTPS (`clairflux_session`)** :
   - `HttpOnly`, `SameSite=Lax`, `Path=/api`.
   - Attribut `Secure` activé **uniquement** lorsque la requête ou `CLAIRFLUX_WEB_ORIGIN` est en `https://` (omis sur LAN HTTP tel que `http://192.168.1.118:8080`, afin que le navigateur transmette le cookie).
   - Comparaison `Origin` CSRF normalisée (suppression d'un éventuel slash final sur `CLAIRFLUX_WEB_ORIGIN`).
4. **Resynchronisation delta complète (`GET /api/sync/delta`)** :
   - Si `query.since > latest_revision` côté serveur, l'API bascule automatiquement sur une resynchronisation complète depuis `0` avec `full_resync_required: true`.
   - Côté Web (`apps/web/src/main.tsx`), le jeu initial passe à `EMPTY_LIVE_DATASET` (`revision: 0`) et l'authentification déclenche immédiatement `syncFromServer()`. Tout statut `401` remonté par l'API redirige vers l'écran de déverrouillage sans perdre le cache local.

---

## 2. Bandeau Commun de Filtres Temporels & Bouton « Synchroniser »

### 2.1 Contrat du Bandeau (`GlobalFilterBar`)
- Affiché en haut du contenu sur les onglets **Synthèse** et **Transactions** (jamais `position: sticky` / `position: fixed` sur mobile pour préserver le plafond sticky ≤ 15 %).
- Élévation unique (`.cf-surface`) structurée par un filet séparateur `1px solid var(--border-subtle)`, zéro carte imbriquée, cibles tactiles ≥ 44×44 px.
- Contient :
  - **Banque** : `Tous les comptes`, `BoursoBank`, `Revolut`
  - **Devise** : `EUR consolidé`, `USD seul`
  - **Action directe** : bouton principal **« Synchroniser »** déclenchant `POST /api/sync/drive` + `syncFromServer()` (désactivé hors-ligne ou pendant un envoi)
  - **Période** : `1 semaine`, `1 mois` *(défaut)*, `3 mois`, `6 mois`, `1 an`, `Tout`, `Personnalisé` (`Du` / `Au` en `<input type="date">` avec validation `:user-invalid` / `aria-invalid` si `from > to`).

### 2.2 Granularité Adaptative & Agrégats (`periodFilter.ts` + `types.ts`)
- **Règle d'adaptation** :
  - `daySpan <= 45` jours calendaires (`1 semaine`, `1 mois`, ou plage personnalisée courte) → granularité **jour par jour** (`'day'`).
  - `daySpan > 45` jours (`3 mois`, `6 mois`, `1 an`, `Tout` > 45j, ou plage personnalisée longue) → granularité **mois par mois** (`'month'`).
- **Invariants financiers préservés** :
  - `Solde consolidé` : reflète toujours le solde actuel des comptes du périmètre choisi ; le graphique `Solde cumulé` déroule le solde de clôture à `dateBounds.to` en remontant jusqu'à `dateBounds.from`.
  - `Revenus`, `Dépenses hors transferts`, `Transferts internes exclus` et le grand livre `Transactions` (y compris l'export CSV) filtrent strictement sur `dateBounds.from <= booking_date <= dateBounds.to`.
  - Les opérations `is_internal_transfer === true` restent exclues des courbes et totaux de dépenses.
