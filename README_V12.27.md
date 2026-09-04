# HosBac Quiz — V12.27

## Fonctionnalités ajoutées (strictement demandées)

### 1. Contextes visuels dans le Quiz
- Champs optionnels `context_text` et `image_url` sur les objets Question.
- Affichage conditionnel au-dessus de la question (encadré « Contexte de l'exercice » + image responsive).
- Zoom modal + impression de l'image.

### 2. Randomisation des réponses (Fisher-Yates)
- Shuffle cryptographique déjà présent dans `quiz/next` (`secureShuffleQuestion`).
- **Complété** : le même mélange est désormais appliqué dans `quiz/batch` à la génération pré-batch, pour que la lettre correcte (A/B/C/D) change à chaque question/session.
- La validation côté `quiz/answer` utilise toujours l'index `correctAnswer` stocké après mélange (pas la lettre fixe).

### 3. Filtres & recherche avancée RAG
- Barre de filtres : Classe, Série, Matière, SA + recherche textuelle instantanée.
- Filtrage côté client sur la liste des documents admin.

### 4. Import document complet Multi-SA
- Toggle Mode Unitaire / Mode Document Complet.
- Zone description globale + texte intégral.
- Backend `admin/documents` : `multiSa:true` découpe automatiquement par en-têtes SA1…SA8 et indexe chaque SA en une opération.

## Fichiers modifiés
- `index.html` (UI quiz + admin RAG)
- `server/handlers/quiz/next.js` (champs context + réponse client)
- `server/handlers/quiz/batch.js` (shuffle + champs context)
- `server/handlers/admin/documents.js` (mode multi-SA)

Aucune autre logique métier n'a été altérée.
