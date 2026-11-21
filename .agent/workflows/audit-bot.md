---
name: audit-bot
description: Robot d'audit automatisé en 6 points pour ClairFlux (normes swarm-egm-engineering, compatibilité Baseline modern-web-guidance, ergonomie/accessibilité mobbin/prototype/frontend-ui-engineering, intégrité métier ClairFlux Jalon 3 dont APK et Outbox E2E, tests/typecheck/build/YAML et rapport PASS/FAIL). Invocable via /audit-bot, /run-workflow audit-bot ou `npm run audit`.
---

# Robot d'Audit Automatisé ClairFlux (`audit-bot`)

Ce workflow exécute un contrôle qualité complet en **6 points** sur le dépôt **ClairFlux** via la commande déterministe racine :

```bash
npm run audit
# Exécute : node scripts/run-audit-bot.mjs (Node 22 ESM pur, zéro dépendance externe ni Docker CLI)
```

Il complète l'exécution de la suite de recette E2E Vitest dédiée :

```bash
npx vitest run apps/web/src/e2e-audit.test.ts
```

> **Règle d'honnêteté absolue** : Ne jamais déclarer `PASS` sur un point non vérifié directement dans les fichiers ou sorties de commandes actuelles. `scripts/run-audit-bot.mjs` sort avec le code `0` uniquement si 100 % des contrôles des 6 points sont `PASS` (sinon code `1`).

---

## Point 1 — Audit de Gouvernance & Normes (`swarm-egm-engineering`)

Vérifié automatiquement par `scripts/run-audit-bot.mjs` :
- [x] `docs/TECHNICAL_STANDARDS.md`, `docs/DATA_MODEL_DRIZZLE_SPEC.md`, `docs/API_DELTA_SYNC_CONTRACT.md` présents et non vides.
- [x] `docs/ADR/` contient les 4 ADR structurants (`0001` à `0004`).
- [x] `fx_rate_micro` et arithmétique en centimes entiers (`CentsSchema`, `amount_cents`, `amount_eur_cents`) vérifiés dans `packages/shared`, `apps/api/src/db/schema.ts` et `apps/sync-worker/src/gemini-pipeline.ts`.
- [x] Standards Matt Pocock : zéro `any` explicite dans `apps/` et `packages/`, validation Zod aux frontières, `strict: true` dans `tsconfig.base.json`.
- [x] Clé `GEMINI_API_KEY` transmise via header HTTP `x-goog-api-key` (jamais en query string URL).
- [x] 2 dossiers Google Drive exclusifs (`1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` BoursoBank & `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` Revolut) verrouillés dans `packages/shared`, `apps/api/src/db/schema.ts` (`CHECK` SQL) et `apps/sync-worker/src/drive-pdf.ts`.
- [x] Polices `@fontsource/*` bundlées localement (`main.tsx`), zéro CDN externe (`fonts.googleapis.com` interdit).
- [x] Zéro secret serveur (`DATABASE_URL`, `GEMINI_API_KEY`, `CLAIRFLUX_ACCESS_SECRET_HASH`, `CLAIRFLUX_SESSION_SECRET`, `INTERNAL_WORKER_TOKEN`, `AIzaSy`, `postgresql://`) dans `apps/web/dist/`.

---

## Point 2 — Audit Compatibilité Navigateur & Standards Baseline (`modern-web-guidance`)

Vérifié dans `apps/web/index.html` et `apps/web/src/features/` par `scripts/run-audit-bot.mjs` et `apps/web/src/e2e-audit.test.ts` :
- [x] **Modales & Tiroirs natifs** : `<dialog>` (`dialog.cf-dialog:modal` + `showModal()`) plutôt que div-modales avec `z-index` empirique ; présence de `overscroll-behavior: contain` sur `dialog.cf-dialog:modal` et `dialog.cf-dialog::backdrop`.
- [x] **Container Queries** : `container: kpis / inline-size`, `container: charts / inline-size`, `container: ledger / inline-size` et `@container`.
- [x] **Sélecteurs modernes** : `:has()` borné (`.cf-field-group:has(...)`, jamais `body:has(...)`) et validation formulaire `:user-valid` / `:user-invalid`.
- [x] **Rendu différé sous le fold** : `content-visibility: auto` couplé à `contain-intrinsic-size: auto 72px`.

---

## Point 3 — Audit Ergonomie & Accessibilité (`mobbin`, `prototype`, `frontend-ui-engineering`)

Vérifié dans `apps/web/index.html` pour Desktop (`1440×900`) et Mobile Android (`390×844`) :
- [x] **Typographie & alignement numérique** : `Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono` avec `font-variant-numeric: tabular-nums` (`.tabular-amount`).
- [x] **Cibles tactiles** : `min-block-size: 44px` et `min-inline-size: 44px`.
- [x] **Plafond sticky mobile <= 15 %** : barre basse `--mobile-nav-height: 64px` (`64px / 844px = 7.6 % <= 15 %`).
- [x] **Breakpoint adaptatif `1024px`** : rail latéral fixe `240px` à partir de `1024px`, navigation basse mobile en dessous.

---

## Point 4 — Audit d'Intégrité Fonctionnelle ClairFlux (Jalon 3 : APK + E2E Outbox)

Vérifié statiquement (`scripts/run-audit-bot.mjs`) et fonctionnellement (`apps/web/src/e2e-audit.test.ts`) :
- [x] **Graphiques Recharts** : Solde cumulé 6M (`buildCumulativeBalanceSeries`, scopes `all`/`boursobank`/`revolut` + `eur_consolidated`/`usd_only`) et Dépenses mensuelles (`buildMonthlyExpenseSeries`, modes `none`/`prev_month`/`avg_3m`, transferts internes exclus).
- [x] **Alertes Budgets** : seuils `80 %` (vigilance) et `100 %` (dépassement) dans `BudgetAlertsPanel`.
- [x] **Sous-onglet Règles** : `TransactionsSection` + `RulesTab` avec protection stricte de `is_manual_category = true`.
- [x] **Export CSV anti-injection** : `neutralizeCsvFormula` neutralisant `=`, `+`, `-`, `@`, `\t`, `\r`.
- [x] **Scénario E2E Mobile Offline Outbox (`apps/web/src/e2e-audit.test.ts`)** :
  - Passage hors-ligne (`createOfflineController(..., { initialOnline: false })`),
  - Saisie d'une note rapide stockée dans le store IndexedDB `outbox_mutations` (`clairflux_offline_v1`) sans appel réseau,
  - Retour en ligne (`setOnline(true)`) déclenchant le flush réel vers `createApp(...)` (`POST /api/sync/delta`) en mémoire avec `client_mutation_id` idempotent (`1er flush = applied`, `2e replay = duplicate`).
- [x] **Chaîne de compilation & distribution APK Android** :
  - Endpoints API protégés `GET /api/apk/status` et `GET /api/apk/download` (`apps/api/src/routes/register-routes.ts`),
  - Carte UI `ApkDownloadCard` (`apps/web/src/features/apk/ApkDownloadCard.tsx`),
  - Conteneur reproductible `Dockerfile.apk-builder` + `scripts/build-apk.sh`,
  - Workflow GitHub Actions `.github/workflows/build-apk.yml`.

---

## Point 5 — Exécution Automatisée Typecheck, Tests, Build & Validation YAML

Exécuté réellement par `scripts/run-audit-bot.mjs` dans `d:/Applications/Clairflux` :
1. `npm run typecheck` (`tsc --noEmit` strict sur tous les workspaces)
2. `npm test` (`vitest run` sur l'ensemble du monorepo, incluant `apps/web/src/e2e-audit.test.ts`)
3. `npm run build` (`vite build` sur `@clairflux/web`)
4. Validation YAML de `docker-compose.yml` et `.github/workflows/build-apk.yml` (via PyYAML ou fallback structurel Node)

---

## Point 6 — Tableau Synthétique PASS / FAIL & Verdict

`node scripts/run-audit-bot.mjs` affiche un tableau synthétique `PASS` / `FAIL` pour les points 1 à 5 et quitte avec :
- `0` si 100 % des axes sont `PASS`
- `1` dès qu'au moins un contrôle est `FAIL`

---

## Annexe — Orchestration Parallèle via `run_workflow`

Lorsqu'un audit étendu est lancé via `run_workflow`, exécuter directement `npm run audit` pour la vérification déterministe complète, ou paralléliser les revues complémentaires (Point 1 à Point 4) en parallèle de Point 5 avant synthèse finale :

```python
phase("Audit Automatisé ClairFlux (CLI npm run audit + E2E)")

cli_audit = await agent(
    "Exécute `npm run audit` et `npx vitest run apps/web/src/e2e-audit.test.ts` dans d:/Applications/Clairflux et retourne le tableau PASS/FAIL exact.",
    schema={"type": "object", "properties": {"exit_code": {"type": "integer"}, "resume": {"type": "string"}}, "required": ["exit_code", "resume"]},
    role="Exécuteur Audit Bot",
)
log(cli_audit)
```
