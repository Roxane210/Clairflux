# Mode d'emploi ClairFlux (`v1.1.0-build.2`)

Bienvenue dans **ClairFlux**, votre application personnelle de suivi de comptes **BoursoBank** et **Revolut** (en **EUR** et en **USD**), utilisable sur ordinateur (navigateur Web) et sur smartphone Android (application APK), même **sans connexion Internet**.

---

## Sommaire

1. [Se connecter sur ordinateur et smartphone Android (Pixel 8 Portrait & Paysage)](#1-se-connecter-sur-ordinateur-et-smartphone-android)
2. [Consulter la Synthèse et les 2 graphiques](#2-consulter-la-synthèse-et-les-2-graphiques)
3. [Gérer vos Catégories et Sous-catégories (`Transactions > Catégories`)](#3-gérer-vos-catégories-et-sous-catégories)
4. [Règles automatiques, notes rapides hors-ligne (Outbox) et Export CSV](#4-règles-automatiques-notes-rapides-hors-ligne-et-export-csv)
5. [Catégorisation hybride IA Gemini, Boîte de révision & Suggestions de règles](#5-catégorisation-hybride-ia-gemini-boîte-de-révision--suggestions-de-règles)
6. [Synchroniser Google Drive manuellement et installer l'APK Android](#6-synchroniser-google-drive-manuellement-et-installer-lapk-android)

---

## 1. Se connecter sur ordinateur et smartphone Android

### Connexion (Web Desktop & APK Android)
1. Ouvrez l'adresse Web de votre instance ClairFlux sur votre ordinateur, ou lancez l'application **ClairFlux** sur votre smartphone Android.
2. Saisissez votre **secret personnel d'accès** puis appuyez sur **Déverrouiller ClairFlux**.
   - Vous pouvez cliquer sur **Afficher / Masquer** pour vérifier votre saisie.
   - Par sécurité, après 5 erreurs consécutives, une pause temporaire s'applique automatiquement.
3. Une fois connecté, ClairFlux charge vos derniers comptes, opérations et catégories depuis le serveur.
4. **Si vous ouvrez l'application Android sans réseau** (avion, métro, zone blanche) : utilisez le bouton permettant de **continuer hors-ligne** dès que vos données ont déjà été synchronisées une première fois sur le téléphone.

### Ergonomie optimisée sur Google Pixel 8 (Portrait & Paysage)
ClairFlux s'adapte automatiquement à la tenue de votre **Google Pixel 8** (Android 15 Edge-to-Edge) :
- **En mode Portrait (`412×915`)** :
  - Les onglets principaux restent accessibles en bas de l'écran pour une navigation à une main, sans jamais recouvrir la barre de gestes Android.
  - Les fenêtres d'édition (notes, catégories, règles) s'ouvrent depuis le bas (*tiroir bas*) et l'affichage s'ajuste automatiquement quand le clavier apparaît pour ne jamais masquer vos champs.
- **En mode Paysage (`915×412`, rotation à gauche `90°` ou à droite `270°`)** :
  - **Aucun rechargement de page** lors de la rotation : vous gardez exactement votre écran et vos filtres en cours.
  - La barre du bas disparaît pour laisser toute la hauteur utile aux chiffres et graphiques, et laisse place à une **barre latérale compacte à gauche**.
  - Les marges s'ajustent des deux côtés pour que ni le poinçon caméra ni les gestes système ne masquent les boutons ou les montants à droite.
  - Les tiroirs d'édition s'ouvrent proprement en **panneau latéral à droite**.

---

## 2. Consulter la Synthèse et les 2 graphiques

L'onglet **Synthèse** regroupe en un coup d'œil la situation de vos comptes.

### Choisir votre périmètre avec le bandeau de filtres commun
En haut de **Synthèse** (et de **Transactions**), le bandeau de filtres vous permet d'ajuster instantanément tous les chiffres :
- **Banque** : *Tous les comptes*, *BoursoBank* ou *Revolut*.
- **Devise** :
  - **EUR consolidé** : additionne vos comptes EUR et USD en convertissant chaque opération USD au taux de change historique du jour de l'opération.
  - **USD seul** : isole uniquement vos montants en dollars américains sans conversion.
- **Période** : *1 semaine*, *1 mois* (par défaut), *3 mois*, *6 mois*, *1 an*, *Tout* ou *Personnalisé* (dates **Du** et **Au**).
  - *Astuce* : sur les périodes courtes (`<= 45 jours`), les graphiques passent automatiquement à un affichage **jour par jour** ; au-delà, ils affichent une vue **mois par mois**.

### Lire les 4 indicateurs clés
- **Solde consolidé** : solde total actuel des comptes correspondant au périmètre sélectionné.
- **Revenus** : total des entrées d'argent sur la période choisie.
- **Dépenses hors transferts** : vos vraies dépenses du quotidien, en excluant automatiquement vos virements entre vos propres comptes.
- **Transferts internes exclus** : montant des virements internes (par exemple entre BoursoBank et Revolut, ou conversions EUR ↔ USD) mis de côté pour ne jamais fausser vos dépenses.

### Lire les 2 graphiques et les alertes budgets
1. **Graphique 1 — Solde bancaire cumulé** : montre l'évolution de votre trésorerie sur la période (en courbe continue, jour par jour ou mois par mois). Survolez ou touchez un point pour voir le montant exact.
2. **Graphique 2 — Dépenses (hors transferts internes)** : affiche vos dépenses et propose **3 modes de comparaison** en un clic :
   - **Sans comparaison** : uniquement vos dépenses de la période.
   - **Période précédente (M-1)** : compare avec le mois précédent.
   - **Moyenne 3 mois** : compare avec votre rythme moyen des 3 derniers mois, avec l'écart en pourcentage affiché en bas de carte.
3. **Alertes budgets mensuels** : suit vos plafonds mensuels avec le **rythme d'avancement du mois** et trois niveaux visuels + textuels clairs :
   - **Maîtrisé (`< 80 %`)**,
   - **Vigilance (`>= 80 %`)**,
   - **Dépassement (`>= 100 %`)**.

---

## 3. Gérer vos Catégories et Sous-catégories

Depuis l'onglet **Transactions**, ouvrez le sous-onglet **Catégories** pour organiser votre classement financier sur mesure.

### Fonctionnement à 2 niveaux & Pack français de départ
- ClairFlux utilise une structure simple et lisible à **2 niveaux maximum** :
  - **Niveau 1 — Catégorie** (ex. *Alimentation*, *Logement*, *Transports*),
  - **Niveau 2 — Sous-catégorie** (ex. *Courses & Supermarché*, *Restaurants & Cafés*).
- Dès le départ, un **pack français complet** est déjà prêt (*Revenus*, *Logement*, *Abonnements & Télécoms*, *Banque & Assurances*, *Alimentation*, *Transports*, *Vie quotidienne & Achats*, *Loisirs & Culture*, *Voyages & Vacances*, *Impôts & Taxes*, *Entretien & Imprévus*, *Transferts & Hors budget*, plus *Non catégorisé*).
- Ce pack n'est **pas figé** : vous pouvez le renommer, le compléter, le fusionner ou l'alléger librement (sauf les catégories techniques protégées *Non catégorisé* et *Transfert interne*).

### Actions disponibles dans `Transactions > Catégories`
> **Important** : la création, modification, fusion et suppression de catégories nécessitent une **connexion Internet active**. Hors-ligne, vous pouvez consulter toute votre arborescence sans pouvoir la modifier.

1. **Déplier / replier une catégorie** : touchez ou cliquez sur une catégorie principale pour afficher ses sous-catégories et le nombre d'opérations associées.
2. **Créer une catégorie ou une sous-catégorie** :
   - Cliquez sur **+ Nouvelle catégorie** (ou sur le bouton d'ajout d'une sous-catégorie sous un parent).
   - Indiquez le **nom**, choisissez si c'est une **catégorie principale** (avec son groupe budgétaire : *Revenus*, *Charges fixes*, *Dépenses variables*, *Non-mensuelles*, *Épargne* ou *Transferts*) ou une **sous-catégorie** rattachée à une catégorie existante, puis validez.
3. **Modifier / Renommer** :
   - Cliquez sur **Modifier** à côté d'une catégorie ou sous-catégorie pour changer son nom, son groupe budgétaire (pour une catégorie racine) ou l'archiver si vous ne souhaitez plus la voir dans les sélecteurs.
   - Le renommage met automatiquement à jour le libellé affiché sur vos opérations et règles existantes.
4. **Fusionner deux catégories** :
   - Utile si vous avez deux postes proches (ex. regrouper *Cafés* dans *Restaurants & Cafés*).
   - Cliquez sur **Fusionner**, sélectionnez la **catégorie cible**, puis confirmez : toutes les opérations et règles de l'ancienne catégorie sont automatiquement transférées vers la cible, sans aucune perte.
5. **Supprimer avec réaffectation obligatoire** :
   - Cliquez sur **Supprimer**.
   - Si la catégorie contient encore des opérations ou des règles, ClairFlux vous demande obligatoirement de choisir une **catégorie de réaffectation** : aucune opération ne reste orpheline.
   - *Note* : si une catégorie principale possède encore des sous-catégories actives, supprimez ou fusionnez d'abord ses sous-catégories.

---

## 4. Règles automatiques, notes rapides hors-ligne et Export CSV

### Consulter, annoter et classer une opération (`Transactions > Opérations`)
1. Utilisez la barre de recherche (par libellé bancaire, catégorie, compte ou texte de note) et le bouton **Avec notes** pour retrouver immédiatement une dépense.
2. Touchez ou cliquez sur une ligne d'opération pour ouvrir son **tiroir de détail** :
   - **Catégorie / Sous-catégorie** : sélectionnez la catégorie souhaitée dans le menu groupé à 2 niveaux. Dès que vous changez manuellement la catégorie, elle est verrouillée comme choix manuel pour ne jamais être écrasée.
   - **Transfert interne** : activez ou désactivez cette case si une opération est un virement entre vos propres comptes.
   - **Note rapide** : ajoutez un commentaire personnel (ex. *« Remboursement restaurant avec Thomas »*), enregistrez ou supprimez la note.
   - **Créer une règle depuis ce libellé** : ouvre directement la création de règle pré-remplie avec le libellé du commerçant.

### Travailler sans réseau : le mode Hors-ligne et l'Outbox
Sur smartphone Android (ou si votre connexion coupe momentanément) :
- **Tout reste lisible** : vos graphiques, indicateurs, opérations, notes existantes, règles et catégories restent consultables à 100 %.
- **Notes rapides & recatégorisations locales actives** : vous pouvez continuer à ajouter/modifier des **notes rapides** et ajuster la catégorie d'une opération.
- **File d'attente sécurisée (*Outbox*)** : un bandeau vous indique en haut de l'écran (et par un badge sur l'onglet **Synchro Drive**) combien de modifications attendent d'être envoyées.
- Dès que Internet revient, ClairFlux envoie automatiquement vos modifications sans jamais créer de doublon (vous pouvez aussi appuyer sur **Synchroniser l'outbox maintenant**).

### Créer et gérer vos règles automatiques (`Transactions > Règles de catégorisation`)
1. Ouvrez le sous-onglet **Règles de catégorisation**.
2. Créez une règle en choisissant :
   - un **nom de règle** et un **texte à détecter** dans le libellé bancaire (ex. `BIOCOOP`, `SNCF`, `FREE MOBILE`),
   - le type de correspondance (contient, commence par, correspondance exacte, expression régulière),
   - éventuellement une **banque** ou un **type de compte** précis,
   - la **catégorie / sous-catégorie cible** (dans le sélecteur à 2 niveaux) ou le marquage en **Transfert interne**.
3. Ajustez l'ordre de priorité avec **Monter** / **Descendre** et activez ou mettez en pause chaque règle.
4. Utilisez le bouton de **réapplication des règles** pour classer les opérations non verrouillées.
   - *Garantie de sécurité* : ClairFlux **n'écrase jamais** les opérations que vous avez classées manuellement ni vos transferts internes appariés.

### Exporter vos opérations en CSV
- Dans `Transactions > Opérations`, filtrez éventuellement par période, banque, devise, recherche ou **Avec notes**, puis cliquez sur **Exporter CSV**.
- Le fichier téléchargé contient exactement les opérations affichées, au format compatible Excel / LibreOffice (séparateur `;`, accents UTF-8 préservés, protection contre les formules).

---

## 5. Catégorisation hybride IA Gemini, Boîte de révision & Suggestions de règles

ClairFlux combine vos règles gratuites et l'intelligence artificielle **Gemini** pour classer rapidement votre historique sans jamais perdre le contrôle.

### Garantie de sécurité : vos choix ne sont jamais écrasés
ClairFlux applique un ordre de priorité strict et inviolable :
**`Manuel > Virement interne > Règle utilisateur > IA Gemini`**

Concrètement :
- Toute opération que vous avez **classée manuellement** (ou déjà validée) reste verrouillée à jamais.
- Tous vos **virements internes** (BoursoBank ↔ Revolut, conversions EUR ↔ USD) restent exclus des dépenses.
- Toutes les opérations déjà couvertes par l'une de **vos règles** sont classées gratuitement sans solliciter l'IA.
- L'IA ne traite **que** les opérations restantes non classées, et uniquement quand vous le demandez.

### Lancer le rattrapage IA des opérations sans règle depuis `Synchro`
> **En ligne uniquement** : le lancement et l'annulation du rattrapage IA nécessitent une connexion Internet active (les boutons sont verrouillés hors-ligne).

1. Ouvrez l'onglet **Synchro Drive** (ou **Synchro**).
2. Dans l'encart dédié au **rattrapage IA des opérations sans règle**, cliquez sur le bouton de lancement manuel.
3. ClairFlux analyse les opérations restantes par lots de 50 avec une **barre de progression en direct** indiquant combien d'opérations ont été classées automatiquement et combien attendent votre avis.
4. À tout moment, vous pouvez cliquer sur **Annuler** : le lot en cours se termine proprement et tout le travail déjà validé reste sauvegardé (vous pourrez reprendre plus tard sans recommencer de zéro).

### Lire et traiter la Boîte de révision IA (`Transactions > À réviser (IA)`)
- **Confiance élevée (`>= 85 %`)** : l'IA classe directement l'opération dans votre grand livre (vous pouvez toujours la modifier ensuite).
- **Confiance modérée (`< 85 %`)** : par prudence, l'opération apparaît dans **`Transactions > À réviser (IA)`** avec la suggestion de l'IA, son score de confiance et une brève justification.

Sur chaque opération à réviser, vous disposez de 4 gestes simples :
1. **Valider en 1 clic** : confirme la proposition de l'IA et la verrouille comme choix validé.
2. **Corriger sur 2 niveaux** : choisissez directement la bonne **Catégorie** et **Sous-catégorie** dans le menu à 2 niveaux.
3. **Ignorer** : écarte la proposition sans classer l'opération pour l'instant.
4. **Valider + Créer une règle permanente** : confirme la catégorie **et** enregistre immédiatement une règle automatique pour ce commerçant (vous pouvez aussi traiter plusieurs lignes d'un coup si besoin).

### Accepter les Suggestions de règles gratuites
Lorsque vous classez ou recevez au moins **3 opérations similaires** d'un même commerçant sans règle existante, ClairFlux vous propose automatiquement une **Suggestion de règle gratuite** en haut de l'écran de révision :
- Cliquez sur **Accepter** en 1 clic pour transformer ce commerçant en règle permanente (et classer automatiquement l'historique non verrouillé) : **les mois suivants, ce commerçant sera classé instantanément et gratuitement sans jamais appeler l'IA**.
- Cliquez sur **Ignorer** si vous ne souhaitez pas créer de règle pour ce libellé.

---

## 6. Synchroniser Google Drive manuellement et installer l'APK Android

### Règle d'or Google Drive : 100 % manuel et limité à 2 dossiers
Par conception, ClairFlux ne lance **jamais** de synchronisation automatique en arrière-plan et n'accède **qu'à vos deux dossiers dédiés** :
- **BoursoBank** (`1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`)
- **Revolut** (`1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`)

### Importer vos nouveaux relevés PDF
1. Déposez vos relevés bancaires PDF dans le dossier **BoursoBank** ou **Revolut** sur votre Google Drive.
2. Dans ClairFlux (avec une connexion Internet active — la synchro Drive est verrouillée hors-ligne), cliquez sur **Synchroniser** dans le bandeau du haut ou depuis l'onglet **Synchro Drive**.
3. ClairFlux détecte uniquement les nouveaux fichiers (ou ceux qui avaient échoué), extrait les opérations (EUR et USD avec taux historique), ignore les doublons déjà importés et range les PDF réussis dans le sous-dossier **`Archives`** de chaque banque sur Drive.
4. Dans l'onglet **Synchro Drive**, vous voyez l'état exact de chaque fichier (*Importé · Archivé sur Drive*, inchangé ou erreur détaillée à corriger).

### Télécharger, vérifier et installer l'application Android (APK)
1. Sur votre ordinateur ou directement depuis le navigateur de votre Pixel 8 connecté à ClairFlux, ouvrez l'onglet **Synchro Drive** → carte **Application Android (APK)**.
2. Vérifiez que le statut indique que l'APK est disponible et notez sa version (`v1.1.0-build.2`) ainsi que son **empreinte SHA-256**.
3. Cliquez sur le bouton de téléchargement pour récupérer `clairflux-release.apk`.
4. *(Recommandé)* Vérifiez que l'empreinte SHA-256 du fichier téléchargé correspond exactement à celle affichée dans ClairFlux.
5. Sur votre **Pixel 8** :
   - Ouvrez le fichier `clairflux-release.apk` depuis l'application **Files / Fichiers** d'Android.
   - Autorisez ponctuellement l'installation depuis cette source si Android le demande, puis validez la mise à jour ou l'installation.
6. Lancez **ClairFlux** une première fois avec Internet activé et déverrouillez avec votre secret personnel : vos comptes, catégories et opérations sont alors enregistrés localement et utilisables partout, même hors-ligne.
