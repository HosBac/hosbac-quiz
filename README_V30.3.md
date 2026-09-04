# HosBac Quiz — V30.3

## 1. Import multi-fichiers (Admin)
- `<input type="file" multiple>` sur chaque carte SA
- Traitement **séquentiel** fichier par fichier (évite timeout 408)
- Barre de progression : « Traitement du fichier 2/7 en cours… »

## 2. Mode oral — plus de balises HTML brutes
- Prompt oral : Markdown uniquement, interdiction `<strong>`, `<br>`, etc.
- Affichage via `mathHtml()` (conversion HTML/Markdown + MathJax)

## 3. Quiz interactif — explications sur toutes les options
- Après réponse : justification de la bonne réponse
- Options fausses cliquables → « Pourquoi l'option X est fausse : … »
- Utilise `option_explanations` du moteur QCM

## 4. Chronomètre 30 secondes
- Compte à rebours visible dès l'affichage de la question
- Réponse anticipée → stop chrono + correction
- Temps écoulé → révélation auto + explications cliquables
- Reset à 30 s sur « Question suivante »
- API `quiz/answer` accepte `timedOut: true` / `answer: -1`
