# ADR-0003 : Architecture Capacitor Android Offline-First par Delta Pull et Écritures Strictement En Ligne

- **Statut** : Acceptée (Phase Pré-Code — EGM)
- **Date** : 2026-11-21
- **Décideurs** : Product Owner, Architecte API & Infra
- **Références** :
  - [clairflux-mvp.md](file:///d:/Applications/Clairflux/docs/intent/clairflux-mvp.md)
  - [critical-flows.md](file:///d:/Applications/Clairflux/docs/ideas/critical-flows.md)
  - [API_DELTA_SYNC_CONTRACT.md](file:///d:/Applications/Clairflux/docs/API_DELTA_SYNC_CONTRACT.md)

---

## 1. Contexte

ClairFlux doit fonctionner de manière fluide sur deux cibles :
1. **Web Desktop (`1440×900`)** connecté au serveur Docker Compose hébergeant le frontend et l'API Neon.
2. **Application mobile Android APK (`390×844`)** empaquetée via **Capacitor** (Android System WebView), utilisée en mobilité (métro, avion, zones sans réseau).

Le Product Owner a validé deux exigences structurantes lors du cadrage (`clairflux-mvp.md` & `critical-flows.md`) :
- **Consultation complète 100 % hors-ligne sur Android** : graphiques Recharts (`Solde cumulé 6M` et `Dépenses M-1 / Moyenne 3M`), grand livre complet avec colonnes Banque/Type de compte, vue consolidée EUR ou « Vue USD seul », notes personnalisées et règles de catégorisation doivent s'afficher instantanément sans réseau.
- **Écritures strictement en ligne** : l'ajout ou la modification de notes, de catégories, de règles, le renommage de comptes et le déclenchement manuel de la synchronisation Google Drive nécessitent une connexion réseau active.

> **Note d'alignement normatif** : cette ADR précise et remplace la mention générique d'une *outbox locale avec rejeu de mutations* initialement présente dans les notes générales du skill `docker-capacitor-apk`, conformément à la décision produit explicite de ne pas gérer d'écritures hors-ligne.

---

## 2. Contraintes

1. **Ergonomie & Performance Mobile (Addy Osmani / Modern Web Guidance)** :
   - Budget `INP <= 200 ms`, `LCP <= 2,5 s`, `CLS <= 0,1` sur Android System WebView.
   - Zéro dépendance à un CDN externe (les polices `Plus Jakarta Sans`, `DM Sans` et `JetBrains Mono` doivent être bundlées localement dans l'APK).
   - Bouton retour matériel Android devant fermer proprement un `<dialog>` (tiroir de note ou filtre) avant toute navigation arrière.
2. **Intégrité Comptable & Multi-Devises** :
   - Aucun calcul flottant sur les montants ; centimes entiers et `fx_rate_micro` (entier micro-unités) figé côté serveur.
   - Les graphiques hors-ligne doivent refléter exactement les mêmes chiffres que le serveur (y compris l'exclusion des transferts internes et changes Revolut `EUR ↔ USD`).
3. **Sécurité & Empreinte Mobile** :
   - Aucun PDF bancaire brut stocké sur le téléphone (confidentialité, espace disque, bande passante).
   - Aucun secret serveur (`GEMINI_API_KEY`, `DATABASE_URL`, credentials Google Drive) dans le bundle JS ou les assets Android.
4. **Simplicité Opérationnelle** :
   - Application à usage personnel unique ; l'architecture doit éviter la complexité d'un moteur distribué de résolution de conflits multi-maîtres.

---

## 3. Options Considérées

### Option A : Synchronisation bidirectionnelle complète (Outbox locale + Résolution de conflits)
- **Principe** : autoriser l'édition de notes et règles hors-ligne dans une file `outbox`, puis rejouer `POST /sync/mutations` au retour réseau avec détection de conflits (`base_revision` vs `server_revision`).
- **Avantages** : saisie de note possible dans le métro.
- **Inconvénients majeurs** :
  - Complexité élevée : gestion d'IDs temporaires, rejeu idempotent, UX de résolution de conflits si une règle a été modifiée sur Desktop entre-temps.
  - Les règles de catégorisation déclenchent un recalcul rétroactif sur tout l'historique côté Neon (`is_manual_category = false`) : simuler fidèlement ce moteur hors-ligne puis réconcilier avec le serveur introduit un risque élevé de divergence des agrégats.
  - Explicitement écartée par le Product Owner.

### Option B : Cache HTTP / Service Worker classique sans base structurée
- **Principe** : mettre en cache les réponses JSON de `GET /api/transactions` et `GET /api/aggregates` via Service Worker / Cache API.
- **Avantages** : quasiment aucun code client dédié.
- **Inconvénients majeurs** :
  - Impossible de filtrer dynamiquement hors-ligne par banque, compte, devise (`USD` seul), plage de dates ou texte libre sur les notes.
  - Le cache WebView/CacheStorage peut être évincé de façon imprévisible par Android lorsque le stockage du téléphone diminue.
  - Retéléchargement répétitif de toute l'historique à chaque changement.

### Option C (Retenue) : Delta Pull Unidirectionnel (`since=<revision>`) + Réplica SQLite/IndexedDB + Agrégats Pré-calculés + Écritures En Ligne
- **Principe** :
  - Le serveur est l'unique source de vérité pour les écritures et calculs comptables.
  - L'APK tire uniquement les deltas depuis son dernier curseur monotone `since_revision` via `GET /api/sync/delta?since=<revision>`.
  - Les données structurées sont stockées localement dans une base persistante (SQLite natif sur Android via `@capacitor-community/sqlite`, IndexedDB sur navigateur Web), accompagnées d'un `aggregates_snapshot` pré-calculé par le serveur.
  - Hors-ligne, l'UI affiche un bandeau discret non bloquant et verrouille explicitement les actions d'écriture (*« Connexion requise pour modifier »*).

---

## 4. Décision Retenue

Nous adoptons l'**Option C** avec les choix d'implémentation suivants :

### 4.1 Protocole Delta Pull Unidirectionnel (`since_revision`)
1. **Bootstrap & Incrémental** :
   - Au premier démarrage après authentification (`since=0`), l'APK récupère par lots paginés (`limit=500`, `has_more`) l'intégralité des entités (`accounts`, `transactions`, `transaction_notes`, `categorization_rules`, `drive_sync_status`) ainsi que `aggregates_snapshot` et persiste `latest_revision`.
   - Pour éviter tout échec d'intégrité référentielle si un lot intermédiaire contient des `transactions` avant d'autres tables, le serveur livre `accounts` en priorité dès la première page **et** le client SQLite local diffère l'évaluation des clés étrangères (`PRAGMA defer_foreign_keys = ON`) jusqu'à ce que `has_more === false` avant de commiter le curseur `last_synced_revision`.
   - Aux démarrages suivants, lors du retour au premier plan (`@capacitor/app` `appStateChange`), au retour réseau (`@capacitor/network` `networkStatusChange`), et immédiatement après toute écriture en ligne réussie, l'APK appelle `GET /api/sync/delta?since=<last_synced_revision>`.
2. **Zéro outbox, zéro conflit** :
   - Les actions d'écriture (`PUT/DELETE /api/transactions/:id/note`, `PATCH /api/transactions/:id`, `POST/PATCH/DELETE /api/rules`, `PATCH /api/accounts/:id`, `POST /api/sync/drive`) s'exécutent directement en ligne contre l'API.
   - Si l'appareil est hors-ligne (détecté par `@capacitor/network` et confirmé sur erreur réseau), l'UI n'enregistre aucune file différée : elle conserve les contrôles d'édition désactivés avec le libellé explicite *« Connexion requise pour modifier »* et ne perd aucune saisie inachevée (brouillon conservé en mémoire de dialogue tant qu'il n'est pas fermé).

### 4.2 Stratégie de Stockage Local Android WebView (`LocalStore`)
1. **Moteur de persistance** :
   - **Sur Android APK (Capacitor natif)** : `@capacitor-community/sqlite` stockant la base dans le répertoire privé applicatif Android (`Context.getFilesDir()` / SQLite natif), résistant aux purges de cache WebView et indexé sur `(booking_date DESC, account_id, bank, currency)` pour filtrer instantanément des milliers d'opérations hors-ligne.
   - **Sur Web Desktop (et tests navigateur)** : abstraction identique implémentée sur **IndexedDB** pour partager la même couche de requêtes client.
   - **Protection au repos** : `android:allowBackup="false"` dans `AndroidManifest.xml` pour empêcher l'export cloud non chiffré des données financières locales ; le Bearer token d'authentification est isolé dans un stockage chiffré par **Android Keystore** (hors de la base SQLite des transactions).
2. **Agrégats pré-calculés (`aggregates_snapshot`)** :
   - Les séries Recharts (`Solde cumulé 6M` et `Dépenses M-1 / Moyenne 3M`) et les 4 KPIs par périmètre (`all_eur`, `usd_only`, par banque, par compte) sont pré-calculés côté serveur à chaque changement de `revision` et transmis dans le delta.
   - L'APK rend l'écran Synthèse directement depuis ce snapshot local en `< 50 ms`, sans recalcul lourd sur le thread UI Android.
   - Sur l'écran Transactions filtré sur une période personnalisée hors-ligne, SQLite local exécute des requêtes indexées par lots ou via `scheduler.yield()` pour respecter `INP <= 200 ms`.
3. **Versionnage du schéma local** :
   - La table locale `local_sync_meta` (distincte de `sync_meta` côté serveur Neon) stocke `local_schema_version` et `last_synced_revision`. Lors d'une mise à jour d'APK modifiant le schéma local, `local_schema_version` déclenche une réinitialisation propre de la base locale suivie d'un pull `since=0`.

### 4.3 Cycle de Vie Android System WebView
- **Polices & Assets offline** : `Plus Jakarta Sans`, `DM Sans`, `JetBrains Mono` (avec `font-variant-numeric: tabular-nums`) et tous les icônes SVG sont bundlés dans `dist/`. Aucune requête vers Google Fonts ou CDN externe.
- **Bouton Retour matériel** : un listener unique `@capacitor/app` (`backButton`) inspecte d'abord la pile de `<dialog>` natifs ouverts (tiroir d'annotation mobile, modale de confirmation) et appelle `.close()` avant de déléguer au routeur ou de quitter l'app.
- **Clôture de session (`logout`)** : la déconnexion explicite révoque le token côté API (si en ligne), efface le token du Keystore et purge les données financières SQLite locales.

### 4.4 Build Gradle APK Reproductible
Pipeline strict et déterministe pour chaque livraison APK :
1. **Installation verrouillée** : `npm ci` (lockfile strict, zéro dépendance flottante).
2. **Build & Audit Frontend** : `npm run build` avec uniquement `VITE_API_BASE_URL` et `VITE_APP_VERSION`, suivi d'un script de contrôle vérifiant l'absence de tout secret (`GEMINI_API_KEY`, `DATABASE_URL`, credentials Drive) dans `dist/`.
3. **Synchronisation Capacitor** : `npx cap sync android` copiant `dist/` vers `android/app/src/main/assets/public`.
4. **Compilation Gradle** (depuis `android/` via le wrapper `./gradlew` versionné) :
   - Versions SDK verrouillées (`minSdkVersion` compatible Android System WebView moderne, `compileSdkVersion` / `targetSdkVersion` conformes aux exigences Android en vigueur).
   - `usesCleartextTraffic="false"` sur les variantes `release`.
   - Build testable : `./gradlew assembleDebug` → `app-debug.apk`.
   - Build signé reproductible : `./gradlew assembleRelease` avec `keystore.properties` et `.jks` hors Git (variables d'environnement CI ou secrets locaux ignorés par `.gitignore`).

---

## 5. Conséquences & Risques

### Conséquences Positives
- **Fiabilité comptable totale** : zéro risque de désynchronisation ou de conflit entre règles rétroactives, transferts internes EUR/USD et notes personnalisées.
- **Consultation hors-ligne instantanée** : démarrage en mode avion sans réseau avec graphiques Recharts, grand livre multi-comptes, notes et règles disponibles immédiatement.
- **Coût d'ingénierie maîtrisé** : pas de moteur CRDT, pas de file outbox, pas de réconciliation de versions en base.

### Compromis Acceptés
- **Pas d'édition en mode avion** : l'utilisateur ne peut pas enregistrer une note ou créer une règle tant qu'il n'a pas de connexion réseau. L'interface affiche un état explicite pour éviter toute frustration ou perte silencieuse.

### Risques Identifiés & Mitigations
| Risque | Impact | Mitigation |
| --- | --- | --- |
| **Faux positif réseau Android** (Wi-Fi connecté sans accès Internet) | L'utilisateur clique sur Enregistrer et échoue | Sur erreur réseau (`fetch` timeout/network error), l'UI affiche un message clair non destructif sans fermer le tiroir de note pour permettre de réessayer dès le retour Internet. |
| **Saturation mémoire WebView lors du premier bootstrap (`since=0`)** | Lenteur ou crash si des milliers de transactions arrivent d'un coup | Pagination serveur obligatoire (`limit=500`, `has_more`) par transactions SQLite par lots de 500 lignes. |
| **Vol ou perte du smartphone contenant le réplica local** | Accès en lecture aux transactions cachées | Verrouillage biométrique/PIN OS Android, `allowBackup="false"`, token stocké dans Android Keystore, et possibilité de révoquer la session depuis Desktop (`POST /api/auth/logout` avec `revoke_all: true`). |
| **Dérive de build APK entre machines** | Échecs Gradle ou différences de WebView | Utilisation exclusive du Gradle Wrapper (`./gradlew`), `package-lock.json` figé et versions SDK explicites dans le dépôt `android/`. |
