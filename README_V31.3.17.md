# HosBac Quiz — V31.3.17

## Correctif affichage des formules
- Correction du rendu MathJax : le nœud `<mjx-container>` retourné comme racine par `tex2svgPromise()` est désormais accepté correctement.
- Suppression du faux fallback systématique qui affichait les fractions sous forme `(1)/(2)`.
- Normalisation mathématique unifiée entre quiz/next, quiz/batch et OCR/IA.
- Réparation des notations courantes issues de l’OCR/IA : `frac{a}{b}`, `sqrt(x)`, `ln(x)`, fractions ASCII, puissances et indices.
- Conservation du LaTeX standard `$...$` / `$$...$$` pour Mathématiques et PCT afin que MathJax affiche de vraies formules.
- Unification du traitement des formules nues issues de l’OCR/IA : ensembles, équations, fractions, racines, puissances, indices, vecteurs et notations scientifiques courantes.
- Conversion des fractions ASCII vers `\frac{...}{...}` avant MathJax, y compris les formes imbriquées comme `(-b+\sqrt{...})/(2a)`.
- En cas d’échec MathJax ou de chargement tardif, le site affiche un fallback lisible (√, fractions, exposants et symboles scientifiques) au lieu de montrer du LaTeX brut.
- Suppression d’un ancien normalisateur local inutilisé dans `quiz/next.js` et du correcteur redondant de `quiz/batch.js`.
