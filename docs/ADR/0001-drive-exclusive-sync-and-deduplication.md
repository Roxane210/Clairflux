# ADR 0001 — Exclusivité Google Drive, Conservation Historique & Déduplication Multi-Comptes / Devises

- **Statut** : Accepté
- **Date** : 2026-11-21
- **Décideurs** : Product Owner & Équipe Architecture ClairFlux
- **Documents liés** :
  - [clairflux-mvp.md](file:///d:/Applications/Clairflux/docs/intent/clairflux-mvp.md)
  - [critical-flows.md](file:///d:/Applications/Clairflux/docs/ideas/critical-flows.md)
  - [DATA_MODEL_DRIZZLE_SPEC.md](file:///d:/Applications/Clairflux/docs/DATA_MODEL_DRIZZLE_SPEC.md)

---

## 1. Contexte

ClairFlux centralise les relevés bancaires PDF **BoursoBank** et **Revolut** déposés par l'utilisateur dans Google Drive afin d'offrir une consolidation multi-comptes (plusieurs comptes courants, cartes différées et livrets chez BoursoBank ; poches `EUR`, `USD` et coffres chez Revolut) sur Desktop et Android.

Deux risques majeurs doivent être neutralisés par conception :
1. **Risque d'accès ou d'import hors périmètre** : un Google Drive personnel contient de nombreux documents privés. L'application ne doit lire **que** les deux dossiers dédiés aux relevés, uniquement sur action explicite de l'utilisateur, et ne jamais perdre l'historique comptable ou les notes si un PDF est déplacé ou supprimé sur Drive.
2. **Risque de doublons et de double comptabilisation des dépenses** :
   - Deux relevés successifs ou partiels peuvent chevaucher les mêmes journées.
   - Deux achats identiques le même jour sur le même compte doivent pourtant être conservés tous les deux.
   - Les virements internes (BoursoBank ↔ Revolut, inter-comptes BoursoBank, vers épargne) et les conversions internes Revolut `EUR ↔ USD` ne doivent jamais gonfler les totaux de dépenses.

---

## 2. Contraintes

- **Exclusivité stricte des 2 dossiers Google Drive** :
  - BoursoBank : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
  - Revolut : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
- **Déclenchement 100 % manuel** : bouton *« Synchroniser maintenant »* uniquement (aucun cron, webhook ou polling en arrière-plan).
- **Conservation historique définitive** : aucune opération ni note personnalisée n'est supprimée en base si le PDF source disparaît de Google Drive.
- **Zéro doublon** en cas de relance après erreur, ré-import d'un relevé chevauchant ou détection multi-comptes/multi-devises.
- **Prise en charge native multi-comptes & multi-devises** (`EUR` et `USD`).

---

## 3. Options Considérées

### Axe A — Contrôle du périmètre Drive & Cycle de vie des fichiers

1. **Option A1 — Filtrage uniquement dans le worker applicatif, suppression en base si absent sur Drive**
   - *Avantages* : implémentation simple.
   - *Inconvénients* : un bug applicatif pourrait insérer un fichier d'un autre dossier ; la suppression/archivage d'un PDF sur Drive détruirait les notes et l'historique financier. **Rejetée.**
2. **Option A2 — Triple verrouillage des 2 dossiers (Configuration + Worker + Contrainte `CHECK` PostgreSQL) & Soft-flag `is_missing_on_drive`** *(Retenue)*
   - *Avantages* : garantie structurelle au niveau base de données qu'aucun autre `drive_folder_id` ni banque incohérente ne peut être enregistré ; conservation définitive de l'historique et des notes.
   - *Inconvénients* : nécessite un maintien explicite des deux IDs en configuration et migration SQL si un troisième dossier était ajouté un jour.

### Axe B — Stratégie de Déduplication Transactionnelle

1. **Option B1 — Clé unique `(account_id, booking_date, amount_cents, raw_label)` sans index d'occurrence**
   - *Inconvénients* : supprime à tort le 2e paiement légitime si deux achats identiques ont lieu le même jour (ex. deux tickets de transport ou deux cafés au même montant). **Rejetée.**
2. **Option B2 — Déduplication par `drive_file_id` uniquement**
   - *Inconvénients* : incapable de détecter les chevauchements entre deux PDF distincts (ex. relevé mensuel vs export glissant Revolut). **Rejetée.**
3. **Option B3 — Double filtre : cache fichier `(drive_file_id, md5_checksum)` + empreinte transactionnelle `dedup_hash` incluant `account_id`, `currency`, `booking_date`, `amount_cents`, `normalized_label` et `statement_occurrence_index`** *(Retenue)*
   - *Avantages* : évite les appels Gemini inutiles sur fichiers inchangés, préserve les vrais doublons légitimes du même jour, et bloque les chevauchements multi-PDF sur `ON CONFLICT (dedup_hash) DO NOTHING`.

### Axe C — Détection des Transferts Internes & Changes `EUR ↔ USD`

1. **Option C1 — Catégorisation purement lexicale par règles de mots-clés**
   - *Inconvénients* : fragile face aux libellés variés de virements instantanés ou de conversions Revolut, et risque de masquer une dépense vers un tiers ayant le mot « virement » dans son libellé. **Rejetée.**
2. **Option C2 — Moteur d'appariement 1-to-1 par paire comptable (`transfer_group_id`) + tolérance spread FX sur `EUR ↔ USD` + override manuel protégé** *(Retenue)*
   - *Avantages* : preuve mathématique (somme nulle sur même devise dans une fenêtre de `±3 jours`, ou paire Revolut de devises opposées `±1 jour` avec cohérence de contre-valeur EUR dans une tolérance de spread), tout en permettant à l'utilisateur de corriger manuellement sans écrasement ultérieur.

---

## 4. Décision Retenue

1. **Verrouillage Drive & Déclenchement Manuel** :
   - Le service `sync-worker` n'interroge Drive que sur appel explicite déclenché par `POST /api/sync/drive` (`trigger_mode = 'manual'`). Aucun scheduler ni cron n'est déployé.
   - Les requêtes Drive ciblent exclusivement les deux IDs `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` (`boursobank`) et `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` (`revolut`), doublés d'une contrainte `CHECK` PostgreSQL sur `drive_files` vérifiant à la fois l'ID du dossier et la cohérence `drive_folder_id ↔ bank`.
   - Lorsqu'un PDF déjà commité n'est plus présent dans le dossier Drive, `drive_files.is_missing_on_drive` passe à `true` ; aucune transaction ni note n'est supprimée.

2. **Déduplication à 2 Niveaux** :
   - **Niveau Fichier** : `UNIQUE(drive_file_id, md5_checksum)` dans `drive_files`. Tout fichier déjà commité avec le même `md5_checksum` est ignoré sans appel Gemini.
   - **Niveau Opération** : `dedup_hash = SHA256(account_id | currency | booking_date | amount_cents | normalized_label | statement_occurrence_index)` avec contrainte `UNIQUE(dedup_hash)` sur `transactions` et insertion idempotente `ON CONFLICT (dedup_hash) DO NOTHING`.
   - Chaque compte détecté par Gemini est identifié par `UNIQUE(bank, external_ref_masked, currency)` dans `accounts`, isolant proprement les poches `EUR`/`USD` et les différents comptes d'une même banque.

3. **Appariement Transferts Internes & Changes `EUR ↔ USD`** :
   - Les paires inter-comptes de même devise (`a.amount_cents = -b.amount_cents`, `±3 jours`) et les paires de change Revolut `EUR ↔ USD` (`±1 jour`, signes opposés, motif de change, écart en `amount_eur_cents` `<= max(200, 3%)`) reçoivent un `transfer_group_id` commun et `is_internal_transfer = true`.
   - Ces opérations restent visibles dans le grand livre et conservent l'exactitude des soldes par compte/devise, mais sont exclues des totaux et graphiques de dépenses.
   - L'utilisateur peut forcer ou annuler ce statut (`is_manual_transfer_override = true`), verrouillant la décision face aux passes automatiques futures.

---

## 5. Conséquences & Risques

### Conséquences Positives
- **Conformité périmètre garantie par la base** : impossible techniquement d'ingérer un fichier hors des 2 dossiers Drive autorisés.
- **Zéro perte de données** : le ménage sur Google Drive n'impacte ni l'historique ni les notes personnelles.
- **Coût Gemini maîtrisé** : les fichiers inchangés (`md5_checksum` identique et commité) ne déclenchent aucun appel LLM.
- **Fiabilité des dépenses** : les mouvements de trésorerie entre BoursoBank et Revolut ou entre poches EUR/USD ne faussent plus le comparatif `M-1 / Moyenne 3M`.

### Risques & Mitigations

| Risque identifié | Probabilité | Impact | Mitigation retenue |
| :--- | :--- | :--- | :--- |
| Changement de formatage mineur du libellé par une banque entre un export mensuel et un export glissant | Moyenne | Moyen (risque de doublon si `normalized_label` diffère) | Normalisation stricte (NFKD, minuscules, espaces compressés) dans le prompt Gemini + règles de nettoyage déterministes par banque avant calcul du `dedup_hash`. |
| Virement interne dont seule une jambe est importée (ex. relevé BoursoBank déposé avant celui de Revolut) | Élevée | Faible (temporairement compté comme dépense) | L'appariement s'exécute à chaque nouvel import de relevé et lie rétroactivement les paires dès l'arrivée de la seconde jambe ; possibilité de marquage manuel immédiat. |
| Évolution d'un des IDs de dossier Google Drive (renommage/recréation du dossier par l'utilisateur) | Faible | Élevé (synchro bloquée par la contrainte `CHECK`) | Les IDs Drive ne changent pas lors d'un simple renommage de dossier ; en cas de recréation volontaire, une migration SQL Drizzle dédiée mettra à jour la contrainte `CHECK`. |
| Spread/frais week-end Revolut légèrement supérieur à 3 % sur très petits montants de change (`< 10 €`) | Faible | Faible | Seuil plancher de `200` centimes (`2,00 €`) couvrant les micro-conversions, complété par l'override manuel en 1 geste dans le tiroir d'opération. |
