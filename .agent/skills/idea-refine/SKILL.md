---
name: idea-refine
description: Applique une pensée divergente puis convergente en français clair pour affiner les flux critiques de ClairFlux (reprise sur erreur des lots PDF Gemini, synchronisation delta mobile Offline-First, ergonomie d'ajout de notes rapides et règles de catégorisation).
---

# Idea Refine — Raffinement des Flux Critiques ClairFlux

## Quand l'utiliser

Utiliser ce skill une fois l'intention globale clarifiée (`interview-me`), lorsqu'un flux critique présente plusieurs façons d'être conçu et doit être stress-testé avant de figer l'architecture (`swarm-egm-engineering`).

Domaines prioritaires sur ClairFlux :
1. **Reprise sur erreur des lots PDF Gemini** : que faire si 1 relevé sur 12 échoue (quota Gemini, PDF scanné illisible, coupure réseau, JSON malformé) sans re-payer ni dupliquer les 11 autres ?
2. **Synchronisation delta mobile (Android Capacitor Offline-First ↔ API / Neon)** : comment synchroniser uniquement ce qui a changé depuis le dernier passage, gérer les coupures en cours de transfert et résorber la file d'actions hors-ligne ?
3. **Ergonomie d'ajout de notes rapides & catégorisation** : comment annoter une dépense en < 3 secondes à une main sur mobile ou éditer rapidement une règle de catégorisation sans perdre le fil de lecture ?

## Processus en 3 Phases

### Phase 1 : Comprendre & Ouvrir (Pensée Divergente)
1. **Reformuler en défi produit** (« Comment pourrions-nous... ») centré sur l'utilisateur final.
2. **Poser 3 questions maximum** d'affinement si un angle critique manque (tolérance à la latence, niveau d'automatisation souhaité, gestion manuelle des exceptions).
3. **Générer 5 à 7 variantes concrètes** en appliquant ces angles :
   - **Inversion** : Et si on faisait exactement l'inverse ? (ex. : afficher d'abord les données locales périmées avec pastille d'état plutôt que bloquer sur un écran de chargement).
   - **Simplification ×10** : Quelle est la version la plus simple qui élimine 80 % de la complexité ?
   - **Pire scénario (Stress-test panne)** : Que se passe-t-il si le réseau coupe au milieu de la page 4 d'un PDF ou pendant l'envoi d'une note hors-ligne ?
   - **Ergonomie une main (Fintech Tier-1)** : Comment l'utilisateur fait-il le geste avec le pouce seul ?
   - **Idempotence absolue** : Comment garantir que relancer 3 fois la même opération donne exactement le même résultat comptable ?

### Phase 2 : Évaluer & Converger
1. **Regrouper en 2 à 3 directions distinctes** (avec tableau comparatif simple : *Expérience utilisateur*, *Fiabilité / Risques*, *Complexité de mise en œuvre*).
2. **Stress-tester sans complaisance** : exposer ce qui peut casser chaque option :
   - Risques de doublons comptables ou de perte de notes.
   - Coût d'appels Gemini inutiles en cas de boucle de retry.
   - Dérive entre cache local Android et base Neon PostgreSQL.
3. **Lister les hypothèses cachées** à valider explicitement avec le Product Owner.

### Phase 3 : Trancher & Formaliser (One-Pager)
Après validation par le PO, produire un document synthétique (proposé pour `docs/ideas/<flux>.md` après accord) contenant :
- **Problème ciblé**
- **Direction retenue et pourquoi** (en français clair, orienté résultat)
- **Mécanisme de résilience / reprise sur erreur**
- **Périmètre MVP**
- **Liste « Ce qu'on ne fait PAS » (Not Doing)** — obligatoire pour éviter la dérive fonctionnelle.
- **Questions ouvertes restantes** avant passage aux contrats techniques (`swarm-egm-engineering`).
