---
name: audit-bot
description: Robot d'audit automatisé en 6 points pour ClairFlux (normes swarm-egm-engineering, compatibilité Baseline modern-web-guidance, ergonomie/accessibilité mobbin/prototype/frontend-ui-engineering, intégrité métier ClairFlux, tests/lint/build et rapport PASS/FAIL). Invocable via /audit-bot ou /run-workflow audit-bot.
---

# Robot d'Audit Automatisé ClairFlux (`audit-bot`)

Ce workflow exécute un contrôle qualité complet en **6 points** sur le dépôt **ClairFlux**. Il peut être exécuté directement étape par étape ou orchestré en parallèle via l'outil `run_workflow` (exemple de script fourni en annexe).

> **Règle d'honnêteté absolue** : Ne jamais déclarer `PASS` sur un point non vérifié directement dans les fichiers ou sorties de commandes actuelles. Si l'application n'est pas encore codée (Phase 0 / Pré-Code), les points manquants doivent être rapportés honnêtement comme `FAIL (Non implémenté / Manquant)` avec la liste précise des prérequis à produire.

---

## Point 1 — Audit de Gouvernance & Normes Pré-Code (`swarm-egm-engineering`)

Vérifier l'existence, la complétude et le respect effectif des artefacts normatifs :
- [ ] `docs/TECHNICAL_STANDARDS.md` présent, non vide, sans marqueurs `DRAFT` / `TODO` bloquants.
- [ ] `docs/ADR/` contient les ADR structurants (Sync Drive exclusive & déduplication, Neon + Drizzle + Checkpoints SQL, Capacitor Offline-First Delta Sync, UI Baseline + Recharts).
- [ ] `docs/DATA_MODEL_DRIZZLE_SPEC.md` présent et aligné avec les schémas réels (s'ils existent).
- [ ] `docs/API_DELTA_SYNC_CONTRACT.md` présent et aligné avec les routes/contrats API réels.
- [ ] Vérifier le respect des standards Matt Pocock (aucun `any` explicite non justifié dans `src/`, validation runtime `zod`, `strict: true` dans `tsconfig.json`).

---

## Point 2 — Audit Compatibilité Navigateur & Standards Baseline (`modern-web-guidance`)

Auditer le code frontend (`src/` CSS/TSX/HTML) contre `.agent/skills/modern-web-guidance/SKILL.md` et `BASELINE_CLAIRFLUX.md` (Desktop Chrome/Safari/Firefox + Android System WebView Capacitor) :
- [ ] **Modales & Popovers** : utilisation native de `<dialog>` (`showModal()`) et `[popover]` plutôt que des div-modales avec `z-index` empirique ; présence de `overscroll-behavior: contain` sur `dialog:modal` et `dialog::backdrop`.
- [ ] **Container Queries & Viewport** : présence de `container-type: inline-size` / `@container` pour les composants adaptatifs ; usage de `dvh`/`dvw` plutôt que `100vh`/`100vw` sur mobile.
- [ ] **Sélecteurs modernes** : usage approprié et borné de `:has()` (jamais `body:has(...)`) et validation formulaire via `:user-valid` / `:user-invalid` avec synchronisation `aria-invalid`.
- [ ] **Transitions & Rendu différé** : usage gardé de `document.startViewTransition` (avec test de support + `@media (prefers-reduced-motion: reduce)`) et `content-visibility: auto` couplé à `contain-intrinsic-size` sur les longues listes sous le fold.
- [ ] **Core Web Vitals** :
  - Budget **INP <= 200ms** protégé (découpage des tâches longues via `scheduler.yield()` + fallback ou Web Worker pour traitements lourds, zéro layout thrashing).
  - Polices bundlées localement pour Offline-First et préchargées proprement (LCP).
  - Aucun polyfill importé inconditionnellement (toujours derrière détection de fonctionnalité).

---

## Point 3 — Audit Ergonomie & Accessibilité (`mobbin`, `prototype`, `frontend-ui-engineering`)

Vérifier les gabarits Desktop (`1440×900`) et Mobile Android (`390×844`) dans le code UI et CSS :
- [ ] **Typographie exacte** : `Plus Jakarta Sans` (titres), `DM Sans` (corps), `JetBrains Mono` avec `font-variant-numeric: tabular-nums` sur **tous** les montants, soldes et pourcentages.
- [ ] **Élévation unique** : zéro cartes imbriquées (*nested cards*), zéro *pills* statiques décoratives.
- [ ] **Cibles tactiles** : tous les contrôles interactifs (boutons, tiroirs, liens nav, filtres) >= `44×44px`.
- [ ] **Plafond sticky mobile <= 15 %** : somme des hauteurs `sticky`/`fixed` simultanées sur mobile `390×844` `<= 126px` (<= 15 % de 844px).
- [ ] **Zéro débordement horizontal mobile** : aucun élément ne dépasse `390px` (ni `320px`) en largeur (`scrollWidth <= clientWidth`).
- [ ] **Accessibilité WCAG 2.1 AA** : contrastes >= 4.5:1 / 3:1, navigation clavier complète, labels explicites sur champs et boutons icônes, états vides/erreurs/hors-ligne gérés sans couleur seule.

---

## Point 4 — Audit d'Intégrité des Fonctionnalités Métier ClairFlux

Vérifier par inspection directe du code (et des tests associés) la présence exacte de chaque exigence métier :
- [ ] **2 dossiers Google Drive exclusifs** :
  - BoursoBank : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
  - Revolut : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
  - Aucun autre dossier Drive accepté (contrôle côté backend/worker + SQL `CHECK` ou validation stricte).
- [ ] **Colonnes Banque & Type de compte** : présentes dans le modèle Drizzle, l'API et affichées dans les vues Transactions Desktop & Mobile.
- [ ] **Notes personnalisées** : modèle, API delta sync, stockage offline Android et tiroir d'édition rapide en UI.
- [ ] **Onglet dédié aux règles de catégorisation** : route/onglet complet (CRUD règles, priorité, test/aperçu, validation `:user-valid`/`:user-invalid`).
- [ ] **Graphiques Recharts obligatoires** :
  - **Solde cumulé 6M** (données 6 derniers mois, `tabular-nums` dans tooltip/axes),
  - **Dépenses M-1 / Moyenne 3M** (comparatif clair par catégorie ou période).
- [ ] **Sécurité APK / Docker** : aucun secret (`GEMINI_API_KEY`, credentials Drive, `DATABASE_URL` Neon) présent dans le bundle frontend ou les assets Android Capacitor.

---

## Point 5 — Exécution Automatisée Tests, Lint & Build

Exécuter dans le workspace `d:\Applications\Clairflux` (si `package.json` existe) :
1. `npm test` (tous les tests unitaires/intégration — 0 test skippé ou relâché)
2. `npm run lint` (typage strict / linter — 0 erreur)
3. `npm run build` (build production propre — 0 erreur)

*(Si `package.json` ou l'un des scripts n'existe pas encore, noter explicitement `FAIL — script ou projet absent` dans le rapport).*

---

## Point 6 — Rapport d'Audit Synthétique & Verdict (`PASS` / `FAIL`)

Écrire le rapport consolidé dans `docs/AUDIT_REPORT.md` (ou dans le répertoire d'artefacts si en lecture seule pré-projet) et afficher un résumé clair en français pour le Product Owner :

```markdown
# Rapport d'Audit ClairFlux — [YYYY-MM-DD HH:MM]

**Verdict global : PASS | FAIL**

| # | Axe d'audit | Statut | Points bloquants / Constats clés |
|---|---|---|---|
| 1 | Normes & EGM (`swarm-egm-engineering`) | PASS / FAIL | ... |
| 2 | Baseline & WebView (`modern-web-guidance`) | PASS / FAIL | ... |
| 3 | Ergonomie & A11y (`mobbin`, `prototype`, `frontend-ui`) | PASS / FAIL | ... |
| 4 | Fonctionnalités métier ClairFlux | PASS / FAIL | ... |
| 5 | Tests (`npm test`), Lint (`npm run lint`), Build (`npm run build`) | PASS / FAIL | ... |

## Corrections requises (par priorité)
1. **[BLOQUANT]** ...
2. **[MAJEUR]** ...
3. **[MINEUR]** ...
```

---

## Annexe — Orchestration Parallèle via `run_workflow`

Lorsqu'un audit complet est lancé via l'outil `run_workflow`, utiliser le canevas Python ci-dessous pour paralléliser les axes 1 à 4 pendant l'exécution des checks 5, puis agréger le rapport final (Point 6) :

```python
phase("Audits parallèles ClairFlux (Axes 1 à 4) + Checks CLI (Axe 5)")

schema_axe = {
    "type": "object",
    "properties": {
        "statut": {"type": "string", "enum": ["PASS", "FAIL"]},
        "constats": {"type": "array", "items": {"type": "string"}},
        "corrections": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["statut", "constats", "corrections"],
}

axes = [
    ("Axe 1 — Normes EGM & Standards", "Vérifie Point 1 de .agent/workflows/audit-bot.md dans le workspace."),
    ("Axe 2 — Baseline & Modern Web Guidance", "Vérifie Point 2 de .agent/workflows/audit-bot.md contre .agent/skills/modern-web-guidance/."),
    ("Axe 3 — Ergonomie Fintech & Accessibilité", "Vérifie Point 3 de .agent/workflows/audit-bot.md contre mobbin, prototype et frontend-ui-engineering."),
    ("Axe 4 — Intégrité Métier ClairFlux", "Vérifie Point 4 de .agent/workflows/audit-bot.md (2 dossiers Drive exacts, Banque/Type de compte, Notes, Règles, Recharts 6M & M-1/3M, zéro secret client)."),
]

resultats_axes = await parallel(
    axes,
    lambda item: agent(
        f"{item[1]} Inspecte les fichiers réels et appelle finish avec le bilan factuel.",
        schema=schema_axe,
        role=item[0],
        model="flash",
    ),
)

check_cli = await agent(
    "Exécute Point 5 de .agent/workflows/audit-bot.md (npm test, npm run lint, npm run build si package.json existe) et retourne la sortie factuelle exacte.",
    schema=schema_axe,
    role="Axe 5 — Tests, Lint & Build",
)

phase("Synthèse & Rapport Final (Axe 6)")
rapport = await agent(
    f"Génère le rapport final Point 6 dans docs/AUDIT_REPORT.md à partir de : axes={resultats_axes}, cli={check_cli}. Verdict PASS uniquement si tous les axes sont PASS.",
    schema={"type": "string"},
    role="Rapporteur Audit ClairFlux",
)
log(rapport)
```
