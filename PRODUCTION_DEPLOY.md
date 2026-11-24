# Guide de Mise en Production — ClairFlux (`v1.0.0-rc1`)

Ce guide explique pas à pas comment mettre en service **ClairFlux** en production, compiler l'application mobile Android (`clairflux-release.apk`) et l'utiliser au quotidien en mode **Offline-First**.

Il s'adresse au Product Owner / exploitant de l'instance personnelle, avec des commandes prêtes à copier-coller.

- **Dépôt officiel** : <https://github.com/Roxane210/Clairflux>
- **Modèle de configuration** : [`.env.example`](./.env.example)

---

## Prérequis

- Un compte **Neon** (<https://neon.tech>) pour la base PostgreSQL Serverless.
- Une clé API **Google Gemini** (`GEMINI_API_KEY`).
- Un accès **Google Drive** en lecture seule (`drive.readonly`) limité aux **deux seuls dossiers autorisés** :
  - **BoursoBank** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
  - **Revolut** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
- **Node.js 22 LTS** et **npm** (pour pousser le schéma SQL et exécuter les vérifications locales).
- **Docker + Docker Compose v2** sur votre serveur/PC (ou, à défaut de Docker local pour compiler l'APK Android, un accès aux **GitHub Actions** du dépôt).

---

## Étape 1 — Créer la base PostgreSQL Serverless Neon et pousser le schéma

1. Connectez-vous à **Neon** (<https://console.neon.tech>) et créez un nouveau projet PostgreSQL (ex. `clairflux-prod`, région Europe de préférence).
2. Récupérez la chaîne de connexion (**Connection string**) et vérifiez qu'elle se termine impérativement par `?sslmode=require` (ou `&sslmode=require`) :
   ```text
   postgresql://<utilisateur>:<mot_de_passe>@<hote-neon>.aws.neon.tech/<base>?sslmode=require
   ```
   > **Important** : l'API, le worker et Drizzle rejettent toute URL sans `sslmode=require`.
3. Configurez temporairement `DATABASE_URL` (ou créez votre fichier `.env` à l'étape 2 avant de lancer la commande), installez les dépendances si nécessaire puis initialisez le schéma Drizzle sur votre base Neon vierge (`v1.0.0-rc1`) :
   ```bash
   npm ci
   npm --workspace apps/api run db:push
   ```
   *(Sous PowerShell Windows, si votre `.env` n'est pas encore chargé dans la session, exportez d'abord `$env:DATABASE_URL="postgresql://...?sslmode=require"`).*
   > **Note pour les évolutions ultérieures en production** : `db:push` convient au bootstrap initial `v1.0.0-rc1` sur une base Neon vierge. Pour toute modification ultérieure du schéma sur une base contenant déjà vos données, utilisez impérativement des migrations SQL versionnées via `npm --workspace apps/api run db:generate` puis `npm --workspace apps/api run db:migrate` (conformément à [`docs/DATA_MODEL_DRIZZLE_SPEC.md`](./docs/DATA_MODEL_DRIZZLE_SPEC.md)).
4. Cette commande crée automatiquement les tables normatives dans Neon, notamment :
   - les comptes (`accounts`), taux de change historiques figés en micro-unités (`fx_rates`), transactions en centimes entiers (`transactions`), notes (`transaction_notes`) et règles (`categorization_rules`),
   - les journaux et checkpoints de reprise PDF (`drive_sync_runs`, `drive_files`, `pdf_ingestion_checkpoints`),
   - la persistance SQL des plafonds de budgets (**`budget_limits`**) et de l'idempotence Outbox mobile (**`applied_client_mutations`**), ainsi que la séquence monotone `sync_revision_seq`.

---

## Étape 2 — Configurer le fichier `.env` de production

1. Copiez le modèle fourni à la racine du dépôt :
   ```bash
   cp .env.example .env
   ```
   > **Sécurité** : le fichier `.env` est exclu du suivi Git (`.gitignore`). Ne le commitez jamais et ne le partagez jamais.

2. Générez des secrets cryptographiques aléatoires uniques :
   - **`CLAIRFLUX_SESSION_SECRET`** (minimum 32 caractères, signe les jetons de session HMAC-SHA256 `cfx_v1.*`) :
     ```bash
     node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
     ```
   - **`INTERNAL_WORKER_TOKEN`** (minimum 16 caractères, authentifie les appels internes `api` → `sync-worker` via `X-Internal-Worker-Token`) :
     ```bash
     node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
     ```
   - **`CLAIRFLUX_ACCESS_SECRET_HASH`** (minimum 16 caractères, hash **Argon2id** de votre mot de passe/secret personnel d'accès tel que prévu par le contrat d'authentification ClairFlux) :
     Générez le hash Argon2id de votre phrase secrète personnelle (format `$argon2id$v=19$m=65536,t=3,p=4$...`) via votre outil `argon2` ou Node, puis collez uniquement le **hash** dans `.env` (jamais le mot de passe en clair).

3. Renseignez les clés d'ingestion côté serveur (`sync-worker` uniquement) :
   - **`GEMINI_API_KEY`** : votre clé Google AI Studio / Gemini. Elle n'est transmise qu'en en-tête HTTP `x-goog-api-key` depuis le conteneur isolé `sync-worker` et n'apparaît jamais dans l'application Web ni dans l'APK Android.
   - **Credentials Google Drive (lecture seule stricte `drive.readonly`)** :
     - Créez un dossier `./secrets/` (ou un chemin sécurisé hors Git) et déposez-y votre fichier JSON de credentials Google Drive (`./secrets/google_drive_credentials.json`).
     - Dans `.env`, vérifiez :
       - `GOOGLE_DRIVE_CREDENTIALS_HOST_PATH=./secrets/google_drive_credentials.json` (monté en lecture seule `:ro` dans `sync-worker`),
       - `GOOGLE_DRIVE_CREDENTIALS_PATH=/run/secrets/google_drive_credentials.json`,
       - `GOOGLE_DRIVE_ACCESS_TOKEN=...` (jeton d'accès OAuth2 `drive.readonly`).
     - **Périmètre verrouillé** : ne partagez avec ce compte/token **que** les deux dossiers autorisés :
       - **BoursoBank** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
       - **Revolut** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
       *(Tout autre dossier Drive est bloqué au niveau applicatif et par contrainte SQL `CHECK` dans Neon).*

4. Renseignez la configuration Web, API et APK :
   - `CLAIRFLUX_WEB_PORT=8080` (ou le port exposé derrière votre reverse proxy HTTPS).
   - `CLAIRFLUX_WEB_ORIGIN=https://clairflux.votre-domaine.fr` (ou `http://localhost:8080` en réseau local/test) — utilisé par la garde CSRF fail-closed de l'API.
   - `VITE_API_BASE_URL=/api` pour le build Web Docker (ou l'URL HTTPS complète `https://clairflux.votre-domaine.fr/api` si l'APK pointe directement vers votre serveur).
   - `VITE_APP_VERSION=1.0.0-rc1`.
   - `APK_OUTPUT_PATH=/shared-apk/clairflux-release.apk`.
   - *(Optionnel pour signature Release Android)* : `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (sans ces variables, `scripts/build-apk.sh` produit un APK fonctionnel avec signature de développement/non signée pour usage personnel).

> **Vérification automatique anti-fuite** : `apps/web/vite.config.ts` bloque le build dès qu'une variable `VITE_*` contient `DATABASE_URL`, `GEMINI_API_KEY`, `CLAIRFLUX_ACCESS_SECRET_HASH`, `CLAIRFLUX_SESSION_SECRET`, `INTERNAL_WORKER_TOKEN`, `GOOGLE_DRIVE`, `SERVICE_ACCOUNT` ou `PRIVATE_KEY`.

---

## Étape 3 — Lancer la stack de production et compiler l'APK Android

Vous disposez de **deux options** pour construire et distribuer l'APK Android `clairflux-release.apk`.

### Option A — Déploiement complet avec Docker Compose (recommandé sur serveur)

1. Avant le premier lancement, vérifiez l'état complet du dépôt avec l'audit automatisé en 6 points :
   ```bash
   npm run audit
   ```
   Toutes les vérifications doivent afficher **`PASS`** (code de sortie `0`).

2. Démarrez l'ensemble des services et compilez l'APK Android dans le conteneur dédié :
   ```bash
   docker compose up -d --build
   ```
   Cette commande orchestre 4 services :
   - **`web`** : interface React + Vite servie par Nginx non-root (`8080`, réseau `frontend_net`).
   - **`api`** : serveur HTTP Node 22 (`3000`, connecté à `frontend_net` et `backend_net`), qui lit l'APK compilé dans le volume monté en lecture seule `apk-artifacts:/shared-apk:ro`.
   - **`sync-worker`** : worker Drive/PDF/Gemini (`4001`), strictement isolé sur `backend_net` (aucun port exposé sur l'hôte).
   - **`apk-builder`** (`Dockerfile.apk-builder`) : conteneur JDK 21 + Android SDK 35 + Node 22 + Capacitor + Gradle exécutant `scripts/build-apk.sh` pour générer `clairflux-release.apk` et `clairflux-release.apk.sha256` dans le volume partagé **`apk-artifacts:/shared-apk`**.

3. Surveillez la fin de compilation de l'APK et l'état de santé des services :
   ```bash
   docker compose ps
   docker compose logs -f apk-builder
   ```
   Vérifiez ensuite que l'API répond et que la base Neon est joignable :
   - `GET /healthz` → `200 { "status": "ok" }`
   - `GET /readyz` → `200 { "status": "ready", "db": "ok" }`

### Option B — Procédure alternative sans Docker local via GitHub Actions

Si votre machine ne dispose pas de Docker (ou si vous souhaitez compiler l'APK dans le cloud sans installer Android SDK ni Gradle localement), utilisez le workflow **`.github/workflows/build-apk.yml`** sur <https://github.com/Roxane210/Clairflux> :

1. **Déclenchement manuel depuis GitHub** :
   - Ouvrez le dépôt <https://github.com/Roxane210/Clairflux> → onglet **Actions** → workflow **Build ClairFlux Android APK** (`.github/workflows/build-apk.yml`).
   - Cliquez sur **Run workflow**, saisissez éventuellement `api_base_url` (l'URL HTTPS publique de votre API ClairFlux, ex. `https://clairflux.votre-domaine.fr/api`), puis validez.
2. **Ou déclenchement automatique par tag Git `v*`** :
   ```bash
   git tag -a v1.0.0-rc1 -m "ClairFlux v1.0.0-rc1"
   git push origin v1.0.0-rc1
   ```
3. Le runner `ubuntu-latest` installe Node 22, Temurin JDK 21 et Android SDK 35, lance `npm ci`, `npm run typecheck`, `npm test`, exécute `bash scripts/build-apk.sh`, puis publie deux fichiers en artefacts téléchargeables :
   - **`clairflux-release.apk`**
   - **`clairflux-release.apk.sha256`**

---

## Étape 4 — Télécharger, vérifier (SHA-256), installer et utiliser l'APK Offline-First

### 4.1 Téléchargement de `clairflux-release.apk`

- **Via l'interface Web ClairFlux** : ouvrez l'onglet **Synchro Drive** → section **Application Android (APK)** (`ApkDownloadCard`). Lorsque `GET /api/apk/status` indique `available: true`, cliquez sur le bouton de téléchargement (qui appelle **`GET /api/apk/download`** avec votre session authentifiée).
- **Ou via GitHub Actions (Option B)** : téléchargez l'artefact depuis la page du workflow terminé sur GitHub, puis décompressez l'archive `.zip`.

### 4.2 Vérification d'intégrité SHA-256 (obligatoire avant installation)

Comparez l'empreinte du fichier téléchargé avec celle affichée dans **`ApkDownloadCard`** ou contenue dans **`clairflux-release.apk.sha256`** :

- **Windows (PowerShell)** :
  ```powershell
  certutil -hashfile clairflux-release.apk SHA256
  ```
- **Linux / macOS** :
  ```bash
  sha256sum clairflux-release.apk
  ```

Les 64 caractères hexadécimaux doivent correspondre **à l'identique** avant de transférer le fichier sur votre téléphone.

### 4.3 Installation sur smartphone Android

1. Transférez `clairflux-release.apk` sur votre smartphone Android (câble USB, Drive personnel ou téléchargement direct depuis le navigateur mobile connecté en HTTPS).
2. Ouvrez le fichier depuis l'application **Fichiers** d'Android. Si Android demande l'autorisation d'installer des applications depuis cette source, activez-la temporairement puis confirmez l'installation de **ClairFlux** (`com.clairflux.finance`).
3. Ouvrez **ClairFlux** alors que le téléphone est connecté au réseau : l'application récupère automatiquement votre snapshot complet via `GET /api/sync/delta` et le sauvegarde en local dans `IndexedDB` (`clairflux_offline_v1`).
   > **Note sécurité Android** : en release, `androidScheme` est verrouillé sur `'https'` et `allowMixedContent` sur `false`. Utilisez impérativement une URL HTTPS valide pour votre serveur API en production.

### 4.4 Utilisation du mode Offline-First au quotidien

1. **Consultation 100 % hors-ligne** :
   - Même en mode avion ou sans réseau, tous les écrans restent utilisables depuis le snapshot local : indicateurs KPI, graphiques Recharts (**Solde cumulé 6M** et **Dépenses mensuelles** en 3 modes), **Grand livre** (avec colonnes *Banque* et *Type de compte*), **Règles de catégorisation**, **Alertes budgets** (paliers 80 % / 100 %) et **notes existantes**.
2. **Saisie de notes rapides & recatégorisations hors-ligne (Outbox)** :
   - Appuyez sur une opération pour ouvrir le tiroir tactile (`BottomSheetNoteDialog`), ajoutez ou modifiez une **note rapide** (ou ajustez sa catégorie manuelle / statut *Transfert interne*) et enregistrez.
   - Sans connexion, la modification est immédiatement visible dans votre vue locale et mise en file d'attente sécurisée dans **`outbox_mutations`** avec un identifiant unique `client_mutation_id`.
   - Un bandeau discret (`OfflineStatusBanner`) et le badge sur l'onglet **Synchro Drive** affichent le nombre exact de modifications en attente.
3. **Synchronisation automatique et manuelle au retour du réseau** :
   - Dès que le smartphone retrouve le réseau, l'outbox est envoyée automatiquement vers `POST /api/sync/delta` (avec déduplication SQL idempotente dans `applied_client_mutations` : aucune note n'est jamais dupliquée, même en cas de coupure réseau pendant l'envoi).
   - Vous pouvez aussi déclencher l'envoi immédiatement en appuyant sur le bouton **« Synchroniser l'outbox maintenant »**.
4. **Déclenchement manuel Google Drive / Gemini** :
   - Par conception, la synchronisation Drive / Gemini reste **bloquée hors-ligne** (*« Connexion requise (hors-ligne) »*) et ne s'exécute jamais automatiquement en arrière-plan : elle ne démarre que lorsque vous cliquez manuellement sur **« Synchroniser Drive / Gemini »** avec une connexion active.

---

## Dépannage rapide

| Symptôme | Cause probable | Action recommandée |
| :--- | :--- | :--- |
| `api` ou `sync-worker` refuse de démarrer | `DATABASE_URL` sans `sslmode=require`, `CLAIRFLUX_SESSION_SECRET < 32` car. ou `INTERNAL_WORKER_TOKEN < 16` car. | Vérifier `.env` par rapport à `.env.example` puis relancer `docker compose up -d`. |
| `GET /readyz` renvoie `503` (`db: "error"`) | Base Neon inaccessible ou schéma non poussé | Tester la connectivité Neon et exécuter `npm --workspace apps/api run db:push`. |
| `GET /api/apk/status` affiche `available: false` | Le conteneur `apk-builder` compile encore ou n'a pas été lancé | Consulter `docker compose logs apk-builder` ou vérifier le montage du volume `apk-artifacts:/shared-apk`. |
| Erreur `403 CSRF_ORIGIN_MISMATCH` en Web | `CLAIRFLUX_WEB_ORIGIN` dans `.env` ne correspond pas exactement à l'URL du navigateur | Aligner `CLAIRFLUX_WEB_ORIGIN` (protocole + hôte + port exacts) et redémarrer `api`. |
