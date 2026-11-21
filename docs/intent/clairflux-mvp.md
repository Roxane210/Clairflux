# Énoncé d'Intention Validé — ClairFlux MVP

- **Date de validation** : 2026-11-21
- **Statut** : Confirmé par le Product Owner (Phase 0.B — `interview-me`)

## 1. Résultat attendu
Disposer d'un analyseur intelligent de relevés bancaires PDF (**BoursoBank** et **Revolut**) offrant une vue financière consolidée sur Desktop (`1440×900`) et sur application Android APK (`390×844` via Capacitor), avec :
- Prise en charge de **plusieurs comptes par banque** (ex. plusieurs comptes courants, cartes différées ou livrets chez BoursoBank ; poches **EUR**, **USD** et coffres chez Revolut), chacun détecté automatiquement et **renommable librement**,
- Consolidation multi-devises : opérations en **USD** affichées dans leur devise d'origine (`$`) et converties en **EUR (`€`)** dans les totaux et graphiques globaux au **taux de change de la date d'opération**, avec un mode filtre **« Vue USD seul »** affichant tout en `$`,
- Colonnes obligatoires **Banque** et **Type de compte** (avec nom/devise du compte),
- **Notes personnalisées** sur les opérations,
- Onglet dédié aux **règles de catégorisation**,
- Deux graphiques Recharts structurants : **Solde cumulé 6M** et **Dépenses M-1 / Moyenne 3M**.

## 2. Utilisateur & Contexte technique
- **Usage personnel unique** : accès privé simple sur ordinateur et smartphone Android, sans module d'inscription publique ni isolation multi-clients.
- **Socle cible** : Docker Compose multi-services, base PostgreSQL Serverless **Neon** + **Drizzle ORM**, client Web conforme **Modern Web Guidance (Baseline)** + Android System WebView (Capacitor).

## 3. Déclenchement & Périmètre Google Drive
- **Exclusivité stricte** sur 2 dossiers Google Drive :
  - **BoursoBank** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
  - **Revolut** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
- **Déclenchement strictement à la demande** via le bouton « Synchroniser maintenant » (**aucun** scan automatique ou polling en arrière-plan).
- **Conservation définitive** de l'historique et des notes même si un PDF est archivé ou supprimé ultérieurement sur Drive.

## 4. Critères de réussite & Intégrité comptable
- **Zéro doublon** en cas de chevauchement de relevés PDF ou de relance après erreur, y compris entre plusieurs comptes d'une même banque ou entre devises EUR et USD.
- **Virements internes & changes EUR ↔ USD** : mouvements entre vos comptes (BoursoBank ↔ Revolut, inter-comptes BoursoBank, vers épargne, et **conversions internes Revolut EUR ↔ USD**) automatiquement repérés comme `Transfert interne` et **exclus des totaux de dépenses** dans les graphiques (avec correction manuelle possible à tout moment), tout en conservant les soldes exacts par devise.
- **Règles de catégorisation** appliquées automatiquement aux futurs relevés **et** recalculées sur l'historique existant, **sans jamais écraser** les corrections manuelles déjà faites par l'utilisateur.

## 5. Contraintes fermes (Android Offline-First & Gouvernance)
- **Android Offline-First en consultation complète** : sans connexion, l'utilisateur consulte tous ses graphiques, opérations, notes et règles depuis le cache local synchronisé en delta.
- **Écriture en ligne uniquement** : l'ajout ou la modification de notes et de règles nécessite une connexion réseau (zéro file de conflits hors-ligne).
- **Gouvernance pré-code** : aucun code applicatif n'est écrit avant validation visuelle Mock-First (`prototype`) et validation des 4 documents normatifs (`TECHNICAL_STANDARDS.md`, `ADR/`, `DATA_MODEL_DRIZZLE_SPEC.md`, `API_DELTA_SYNC_CONTRACT.md`).

## 6. Hors périmètre (Ce qu'on ne fait PAS)
- Pas de gestion multi-utilisateurs, rôles ou partage de foyer.
- Pas de scan automatique en tâche de fond sur Google Drive.
- Pas d'édition/création de notes ou règles hors-ligne sur Android.
- Pas d'import depuis d'autres dossiers Drive ou d'autres banques hors des 2 IDs autorisés.
