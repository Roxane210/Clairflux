# Affinage des Flux Critiques — ClairFlux (`idea-refine`)

- **Date** : 2026-11-21
- **Statut** : Convergé et validé par le Product Owner

## Problème ciblé
Garantir sur **ClairFlux** une ingestion PDF Gemini résiliente sur les 2 dossiers Google Drive exclusifs, une consultation mobile Android instantanée hors-ligne, et une prise de note + création de règle fluide à une main sans risque de doublon ni perte de données.

---

## 1. Flux A — Reprise sur erreur des lots PDF Gemini & Multi-Comptes / Devises
- **Direction retenue** : **Reprise granulaire par fichier PDF avec checkpoint SQL individuel**, découpage par compte/devise et figement du taux de change historique.
- **Fonctionnement** :
  - Au clic sur *« Synchroniser maintenant »* (déclenchement manuel exclusif), le worker liste les PDF des 2 dossiers autorisés (`1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h` BoursoBank et `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus` Revolut).
  - L'analyseur Gemini découpe chaque PDF en blocs par **compte distinct** (`account_ref_masked`, `account_type`, `currency: 'EUR' | 'USD'`, soldes d'ouverture/clôture) afin de créer automatiquement les comptes BoursoBank (plusieurs comptes possibles) et Revolut (EUR, USD, coffres), chacun renommable par l'utilisateur.
  - Chaque opération en USD reçoit côté serveur un `fx_rate_to_eur` de sa date d'opération (taux du relevé Revolut si présent, sinon taux historique mis en cache dans `fx_rates`) et fige `amount_eur_cents` pour stabiliser les comparatifs `M-1 / Moyenne 3M` et garantir la lecture 100 % hors-ligne sur Android.
  - Les paires de change interne Revolut `EUR ↔ USD` (même banque, date `±1 jour`, motif de change) sont liées et marquées `Transfert interne` (exclues des dépenses).
  - Chaque PDF est identifié par `drive_file_id` + `md5_checksum`. Tout fichier déjà commité avec le même checksum est ignoré sans appel Gemini.
  - Un PDF en échec passe au statut `'failed'` avec motif explicite et bouton dédié *« Réessayer ce fichier »* sans re-traiter les fichiers réussis.

## 2. Flux B — Synchronisation Delta Mobile (Android Offline-First)
- **Direction retenue** : **Réplica delta local complet + agrégats pré-calculés en lecture seule hors-ligne**.
- **Fonctionnement** :
  - En ligne, l'APK Android tire uniquement les changements depuis son dernier curseur (`since_revision`) : comptes, transactions, notes, règles, agrégats 6M / M-1 / 3M et statut de synchro Drive.
  - Aucun PDF brut n'est stocké sur le téléphone (seules les données structurées légères).
  - Hors-ligne, 100 % des écrans (graphiques Recharts, liste des opérations avec Banque & Type de compte, notes, onglet Règles) restent consultables instantanément.
  - Les boutons de création/édition (ajout de note, création/édition de règle, bouton « Synchroniser maintenant ») affichent un état désactivé clair : *« Connexion requise pour modifier »*.

## 3. Flux C — Ergonomie Note Rapide & Règle en 1 Geste
- **Direction retenue** : **Tiroir tactile natif (`<dialog>`) 1-tap avec Note prête à taper + raccourci « Créer une règle »**.
- **Fonctionnement** :
  - Sur mobile (`390×844`), toucher une opération (hitbox `>= 44×44px`) ouvre un tiroir bas natif (`<dialog>`).
  - Sur Desktop (`1440×900`), le même composant s'ouvre en panneau latéral droit sans masquer le contexte du grand livre.
  - Le champ **Note personnalisée** est directement accessible ; la catégorie est ajustable en 1 geste ; le bouton *« Créer une règle depuis ce libellé »* bascule vers l'onglet Règles pré-rempli et recalcule l'historique sans écraser les corrections manuelles.

## Ce qu'on ne fait PAS (Not Doing)
- Pas de lot tout-ou-rien bloquant les PDF valides si 1 fichier échoue.
- Pas de reprise intra-PDF page par page (les totaux de contrôle s'évaluent par relevé complet).
- Pas de téléchargement des PDF bancaires bruts dans l'APK Android.
- Pas de file de mutations hors-ligne ni de moteur de résolution de conflits multi-appareils.
- Pas d'édition directe en ligne dans les cellules du tableau mobile.
