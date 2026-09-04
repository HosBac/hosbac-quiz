# HosBac Quiz — V31.3.19 Pro

## Correctif critique du rendu mathématique

- Restauration de `isMathSubjectClient`, utilisée par le pipeline mathématique du frontend.
- Correction de l’erreur runtime `isMathSubjectClient is not defined` qui empêchait le rendu du quiz.
- Détection des variantes accentuées et des libellés PCT/Physique-Chimie.
- Le rendu MathJax reste centralisé via `mathHtml()` et `typesetAllMath()`.
- Aucun changement fonctionnel hors du pipeline d’affichage mathématique.
