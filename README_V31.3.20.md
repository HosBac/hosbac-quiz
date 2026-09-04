# HosBac Quiz V31.3.20

## Rendu mathématique
- MathJax 3 CHTML avec configuration inline `$...$` et `\(...\)`.
- Rendu dynamique avec `MathJax.typesetPromise()` après injection des questions, choix et explications.
- Conteneurs inline stables dans les cartes flex.
- Blocs mathématiques centrés et défilables horizontalement sur petit écran.
- Aucun affichage volontaire de LaTeX brut en cas de rendu asynchrone.
- Classes dédiées `quiz-question-text`, `option-text` et `explanation-text`.
