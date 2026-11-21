---
name: swarm-egm-engineering
description: Skill directeur obligatoire pour ClairFlux. Interdit strictement toute écriture de code applicatif tant que la documentation technique normative (TECHNICAL_STANDARDS.md, ADR, DATA_MODEL_DRIZZLE_SPEC.md, API_DELTA_SYNC_CONTRACT.md) et les design drafts EGM ne sont pas générés et validés. Intègre EGM, standards Matt Pocock, Addy Osmani, Git atomique et tests.
---

# Swarm EGM Engineering — Gouvernance & Normes Pré-Code ClairFlux

## Règle d'Or (Porte Bloquante Absolue)

**INTERDICTION STRICTE d'écrire ou de modifier le moindre code applicatif (`src/`, composants React, routes API, schémas exécutables, Dockerfiles, config Capacitor) tant que :**
1. Le cadrage fonctionnel (`interview-me` / `idea-refine`) et la validation visuelle Mock-First (`prototype`) ne sont pas confirmés par le Product Owner ;
2. Les **4 artefacts normatifs pré-code** ne sont pas générés, relus (revue EGM Goldfish en contexte vierge) et validés.

Tout worker `/swarm` démarrant une tâche de développement DOIT d'abord lire ces 4 documents comme source de vérité unique.

---

## Les 4 Piliers de Gouvernance

### 1. Gouvernance EGM (Elephant-and-Goldfish Model)
- **Documenter avant de coder** : tout chantier structurant passe par un brouillon de conception `docs/architecture/design_draft_<sujet>.md` validé section par section avec le PO (en français clair orienté usage), puis revu par des agents critiques indépendants (sans biais de contexte) avant implémentation.
- **Contrats explicites** : chaque module expose une interface claire, ses invariants (ce qui doit toujours être vrai, ex. conservation des centimes, unicité d'empreinte Drive) et ses effets de bord (appels Gemini, écritures Neon, stockage local Android).

### 2. Standard TypeScript & Architecture (Matt Pocock)
- **TypeScript strict absolu** (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` recommandé).
- **Zéro `any`, zéro assertion `as` non justifiée** (utiliser validation runtime `zod` aux frontières API / PDF Gemini / stockage offline).
- **Inférence & types discriminés** : modéliser les états métier par unions discriminées (`type SyncStatus = { kind: 'idle' } | { kind: 'syncing'; progress: number } | { kind: 'error'; retryable: boolean; reason: string }`) plutôt que par booléens imbriqués ambigus (`isLoading`, `isError`, `hasPartial`).
- **Deep Modules** : cacher la complexité technique (parsing PDF Gemini, checkpoints SQL, file delta offline) derrière de petites interfaces métier simples et testables.

### 3. Standard Web, Performance & UI (Addy Osmani + Modern Web Guidance)
- **Budgets stricts** : Core Web Vitals **INP <= 200ms**, **LCP <= 2.5s**, **CLS <= 0.1**, bundle initial allégé par code-splitting par route/onglet (ex. chargement paresseux des graphiques Recharts ou de l'éditeur de règles).
- **Platform-First** : privilégier les APIs natives Baseline (`<dialog>`, `popover`, `@container`, `:has()`, `:user-valid`, `View Transitions API`, `content-visibility: auto`, `scheduler.yield()`).
- **Accessibilité WCAG 2.1 AA** non négociable dès le premier composant.

### 4. Git Atomique & Tests (TDD / Vérification continue)
- **Commits atomiques** : 1 commit = 1 intention logique cohérente et compilable (jamais de commit fourre-tout mêlant schéma SQL, refonte UI et config Docker).
- **Pyramide de tests ciblée** :
  - Logique critique (déduplication BoursoBank/Revolut, calcul centimes, moteur de règles de catégorisation, merge delta offline, parsing schéma Gemini) couverte à **100 % par tests unitaires** déterministes.
  - Contrats API & migrations Drizzle testés en intégration.
  - Aucun code livré sans passage vert de `npm test`, `npm run lint` et `npm run build`.

---

## Artefacts Normatifs Obligatoires à Produire en Phase Pré-Code

Avant de lancer l'implémentation par `/swarm`, produire et faire valider :

### 1. `docs/TECHNICAL_STANDARDS.md`
Contient impérativement :
- Stack exacte verrouillée (versions Node, React, Vite/Next, TypeScript, Drizzle, Neon, Capacitor, Docker, Recharts).
- Règles de nommage, structure des dossiers (`src/`), conventions TypeScript Matt Pocock, gestion d'erreurs typée.
- Règles UI/UX & Baseline (`modern-web-guidance`, typographie Plus Jakarta Sans / DM Sans / JetBrains Mono `tabular-nums`, élévation unique, hitboxes >= 44×44px, sticky mobile <= 15%).
- Règles de sécurité (secrets `.env` hors VCS, Service Account / OAuth Google Drive limité strictement en lecture aux 2 dossiers autorisés, sanitization HTML, requêtes paramétrées Drizzle).
- Stratégie Git atomique et seuils CI (`npm test`, `npm run lint`, `npm run build`).

### 2. `docs/ADR/` (Architecture Decision Records)
Un fichier numéroté par décision structurante (`docs/ADR/0001-<titre>.md`, etc.) au format : Contexte / Contraintes / Options considérées / Décision retenue / Conséquences & Risques.
ADR minimum attendus pour ClairFlux :
- `0001-drive-exclusive-sync-and-deduplication.md` (ingestion exclusive des 2 dossiers Drive `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` et `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` + empreinte déterministe).
- `0002-neon-drizzle-ledger-and-checkpoints.md` (stockage en centimes entiers, checkpoints SQL, reprise sur erreur Gemini).
- `0003-capacitor-offline-first-delta-sync.md` (stratégie de stockage local Android WebView + résolution de conflits sur notes/catégories).
- `0004-ui-baseline-and-recharts-architecture.md` (choix UI sans cartes imbriquées, Baseline WebView, Recharts 6M & M-1/3M).

### 3. `docs/DATA_MODEL_DRIZZLE_SPEC.md`
Spécification exhaustive des tables PostgreSQL Neon + Drizzle ORM (sans code d'application dans `src/`, uniquement la spécification documentaire) :
- Colonnes, types exacts (montants en centimes `bigint`/`integer`, timestamps `timestamptz` UTC, clés étrangères, index, contraintes `UNIQUE`).
- Modélisation explicite de : **Banque** (`boursobank` | `revolut`), **Type de compte** (`courant` | `epargne` | `carte_differee` | `multi_devises` | etc.), **transactions**, **notes personnalisées**, **règles de catégorisation**, **fichiers Drive traités** (`drive_file_id`, `md5_checksum`, `folder_id` restreint aux 2 IDs), **checkpoints SQL de lots PDF Gemini**.

### 4. `docs/API_DELTA_SYNC_CONTRACT.md`
Contrat formel d'API entre Backend, Web Desktop et APK Android Offline-First :
- Endpoints REST/RPC (authentification, sync Drive, statut d'ingestion PDF, delta pull `GET /sync/delta?since=<cursor>`, delta push `POST /sync/mutations` idempotent par `client_mutation_id`).
- Schémas de requête/réponse JSON, codes d'erreur normalisés, gestion de l'idempotence et politique de résolution de conflits (`server_version` / `updated_at`).

---

## Workflow d'alignement des Workers `/swarm`

1. **Vérifier l'existence des 4 livrables** : si l'un manque ou est marqué `DRAFT`, **refuser d'écrire du code** et compléter la phase documentaire.
2. **Assigner des frontières nettes** aux workers (`workspace: "share"` pour auteurs parallèles) : chaque worker reçoit un sous-ensemble de contrats (`DATA_MODEL_DRIZZLE_SPEC.md`, `API_DELTA_SYNC_CONTRACT.md`, etc.) et un périmètre de fichiers exclusif.
3. **Valider avant fusion** : exécuter le robot d'audit (`/audit-bot` / `.agent/workflows/audit-bot.md`) après intégration de chaque lot.
