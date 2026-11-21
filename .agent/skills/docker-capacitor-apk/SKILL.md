---
name: docker-capacitor-apk
description: Spécialisation technique ClairFlux pour le déploiement Docker Compose multi-services (API, Worker ingestion Drive/Gemini, Frontend), l'application Android Capacitor Offline-First (Android System WebView + outbox delta sync) et le build reproductible d'APK via Gradle.
---

# Docker Compose + Capacitor Android APK (Offline-First) — ClairFlux

## 1. Architecture Docker Compose Multi-Services

Séparer clairement les responsabilités pour permettre la montée en charge, la reprise sur erreur des lots PDF et l'isolation des secrets :

1. **Services cibles (`docker-compose.yml`)** :
   - **`web` / `frontend`** : sert le bundle statique SPA optimisé (Nginx/Caddy léger non-root, compression Brotli/Gzip, headers cache immutables sur assets hashés, `Cache-Control: no-cache` sur `index.html`, zéro `no-store` pour préserver le bfcache).
   - **`api`** : serveur HTTP/JSON (authentification, endpoints delta sync mobile `GET /sync/delta` & `POST /sync/mutations`, CRUD notes & règles de catégorisation, consultation grand livre & agrégats Recharts, `/healthz` + `/readyz`).
   - **`sync-worker`** : processus dédié au scan périodique/à la demande des **2 dossiers Google Drive exclusifs** (`1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` BoursoBank et `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` Revolut), appel Gemini par lot avec backoff exponentiel et écriture des checkpoints SQL dans Neon.
   - *(Optionnel profil `dev`)* **`postgres-local`** : instance Postgres pour tests d'intégration hors-ligne sans toucher à Neon production.
2. **Bonnes pratiques conteneurs** :
   - Images multi-stage (`node:22-alpine` / `distroless`), exécution en utilisateur non-root (`USER node`).
   - Healthchecks explicites (`depends_on: condition: service_healthy`) et arrêt gracieux (`SIGTERM` géré par le worker pour ne pas couper un lot PDF en plein commit).
   - Tous les secrets (`DATABASE_URL` Neon, `GEMINI_API_KEY`, credentials Google Drive OAuth/Service Account) injectés par variables d'environnement ou fichiers montés en lecture seule — **jamais** dans les Dockerfiles ni dans les images frontend.

---

## 2. Capacitor Android Offline-First & WebView Compatibility

1. **Principe Offline-First absolu** :
   - Au lancement sur Android (y compris en mode avion), l'application charge immédiatement depuis le bundle local Capacitor (`dist/`) et lit le cache local persistant (IndexedDB structurée / SQLite Capacitor `@capacitor-community/sqlite`).
   - L'utilisateur peut consulter immédiatement :
     - ses **graphiques Recharts** (`Solde cumulé 6M` et `Dépenses M-1 / Moyenne 3M`),
     - ses **transactions** (avec **Banque**, **Type de compte**, **Notes personnalisées**),
     - son **onglet Règles de catégorisation**.
2. **Moteur de synchronisation Delta (`Outbox + Cursor`)** :
   - **Outbox locale** : toute création/modification de note personnalisée ou de règle hors-ligne génère une mutation locale avec `client_mutation_id` (UUID v4) et `base_revision`, appliquée immédiatement en UI (*Optimistic UI*).
   - **Rejeu automatique** : écoute `@capacitor/network` (`networkStatusChange`) + reprise d'app (`@capacitor/app` `appStateChange`) pour envoyer `POST /sync/mutations` puis tirer `GET /sync/delta?since=<last_revision>`.
   - **État visuel transparent** : afficher le statut de synchro sans bloquer l'utilisateur (ex. *« Hors-ligne · 2 notes en attente »*).
3. **Contraintes Android System WebView** :
   - Respecter `modern-web-guidance` Baseline (`.agent/skills/modern-web-guidance/BASELINE_CLAIRFLUX.md`) : `<dialog>`, `@container`, `100dvh`, `env(safe-area-inset-*)`.
   - **Polices bundlées localement** (`Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono`) dans les assets Vite : ne jamais dépendre de Google Fonts CDN pour l'APK Android Offline-First.
   - **Bouton Retour matériel Android** (`App.addListener('backButton')`) : fermer en priorité un `<dialog>` ouvert (tiroir de note/filtre) avant de naviguer en arrière ou quitter l'application.
   - **Zéro secret dans l'APK** : vérifier systématiquement que `VITE_*` / `android/app/src/main/assets` ne contiennent ni clé Gemini, ni token Google Drive Service Account, ni chaîne de connexion Neon.

---

## 3. Gradle APK Builder (Build Reproductible)

Pipeline standard pour produire l'APK Android :
1. Build frontend strict : `npm run build` (sans variables sensibles embarquées).
2. Synchronisation Capacitor : `npx cap sync android`.
3. Compilation Gradle (depuis `android/`) :
   - Debug testable : `./gradlew assembleDebug` → `android/app/build/outputs/apk/debug/app-debug.apk`.
   - Release signée : `./gradlew assembleRelease` (keystore référencé via variables d'environnement / `keystore.properties` ignoré par `.gitignore`).
4. Vérifications pré-livraison APK :
   - `minSdkVersion` / `targetSdkVersion` conformes aux exigences Android modernes et Capacitor.
   - `usesCleartextTraffic` désactivé en production (`HTTPS` obligatoire vers l'API Docker, configurable uniquement pour tests locaux explicites).
   - Test de smoke-check sur émulateur/appareil : démarrage en mode avion, ajout d'une note rapide, retour réseau et vérification de la remontée vers Neon.
