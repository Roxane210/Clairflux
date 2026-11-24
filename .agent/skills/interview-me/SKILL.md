---
name: interview-me
description: Extrait l'intention réelle du Product Owner ClairFlux avant tout plan, spec ou code. Pose une question à la fois avec une hypothèse argumentée et des options pré-calculées, en français clair orienté usage, jusqu'à atteindre >= 95 % de confiance sur la synchronisation Drive, la déduplication BoursoBank/Revolut et l'APK hors-ligne.
---

# Interview Me — Cadrage Produit ClairFlux

## Objectif

Empêcher toute supposition silencieuse avant d'écrire une spécification ou du code. Ce skill s'adresse à un **Product Owner non-développeur** : chaque question est rédigée en **français clair, orienté usage et résultat concret**, sans jargon technique inutile.

## Périmètre d'ambiguïtés critiques ClairFlux à lever

Avant de valider un périmètre, vérifier systématiquement les zones d'ombre sur :
1. **Synchronisation Google Drive exclusive** :
   - Dossier **BoursoBank** : `1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h`
   - Dossier **Revolut** : `1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus`
   - Questions types : fréquence de scan, gestion des sous-dossiers éventuels vs racine stricte, comportement si un PDF est déplacé/supprimé/renommé sur Drive, déclenchement manuel vs planifié.
2. **Déduplication BoursoBank / Revolut** :
   - Relevés PDF qui se chevauchent (ex. relevé mensuel + relevé intermédiaire ou ré-export Revolut CSV/PDF).
   - Virements internes entre comptes BoursoBank et Revolut (doivent-ils être exclus des graphiques de dépenses ou marqués comme « Transfert interne » ?).
   - Règle d'unicité lorsqu'une opération change légèrement de libellé entre opération « en attente » et « comptabilisée ».
3. **Application Android APK Offline-First (Capacitor)** :
   - Que doit pouvoir faire l'utilisateur sans réseau (consulter les 6 derniers mois, ajouter/modifier des notes rapides, modifier une catégorie) ?
   - En cas de modification simultanée sur Desktop et Android hors-ligne (ex. note personnalisée ou règle de catégorisation), quelle règle tranche (dernière modification gagnante, fusion, ou choix utilisateur) ?
   - Politique de verrouillage biométrique / PIN ou accès direct sur le téléphone personnel.
4. **Règles de catégorisation, notes & tableaux** :
   - Priorité entre règle automatique, catégorisation IA Gemini et correction manuelle de l'utilisateur.
   - Périmètre d'application d'une nouvelle règle (futur uniquement ou recalcul rétroactif sur l'historique).

## Protocole strict (Une question à la fois)

### Étape 1 : Poser l'hypothèse initiale + niveau de confiance
Au premier tour, formuler en une phrase ce que l'on comprend du besoin et donner un score de confiance honnête (`0–100%`). Si `< 70%`, préciser en une ligne ce qui manque.

```text
HYPOTHÈSE : [Ce que vous voulez obtenir concrètement en 1 phrase]
CONFIANCE : ~XX% — manque : [zone d'ambiguïté principale]
```

### Étape 2 : Une seule question ciblée avec hypothèse et options pré-calculées
Ne **jamais** envoyer une liste de questions d'un coup. Poser **strictement 1 question** par tour avec :
- La question orientée usage concret,
- L'hypothèse par défaut (`MON HYPOTHÈSE : ...`) expliquant pourquoi ce choix semble logique,
- 2 à 3 options pré-calculées concrètes (impact fonctionnel clair pour chacune) afin que le PO puisse réagir vite ou corriger.

Format :
```text
QUESTION : <1 question claire sans jargon>
MON HYPOTHÈSE : <proposition par défaut + raison métier>
OPTIONS PRÉ-CALCULÉES :
A) <Option concrète 1 — effet visible>
B) <Option concrète 2 — effet visible>
C) Autre (précisez votre besoin)
```

### Étape 3 : Détecter les réponses de convention (« faire comme d'habitude »)
Si l'utilisateur répond par une formule vague (« comme les autres applis », « quelque chose de standard/robuste »), sonder avec :
> *« Si vous deviez l'utiliser demain matin sur votre téléphone dans le métro, qu'est-ce qui vous ferait gagner le plus de temps ou vous agacerait le moins ? »*

### Étape 4 : Reformulation complète & Portes de validation (>= 95 % de confiance)
Condition d'arrêt : pouvoir prédire la réponse de l'utilisateur aux 3 prochaines questions.
Présenter alors la synthèse en 6 lignes maximum :
- **Résultat attendu** : ...
- **Pour qui / Contexte** : ...
- **Déclencheur** : ...
- **Critère de réussite** : ...
- **Contrainte ferme** : ...
- **Hors périmètre (ce qu'on ne fait PAS)** : ...

Demander un **« Oui » explicite** (« Oui / Non / À affiner ? »). Ne **jamais** accepter « comme vous voulez » ou « ça a l'air bien » sans re-cadrer par un choix binaire clair.

### Étape 5 : Arrêt immédiat après confirmation
Dès que l'utilisateur confirme explicitement par « Oui » :
1. Livrer l'Énoncé d'Intention validé.
2. Proposer la suite logique (`idea-refine` pour explorer les cas limites ou `swarm-egm-engineering` pour rédiger les normes et spécifications).
3. **Arrêter le tour immédiatement** sans lancer de génération de code.
