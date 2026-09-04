# HosBac Quiz — V31.3.18 Pro

## Correctif définitif du moteur de formules
- Correction du décodage des séquences `\t`, `\r` et `\n` afin de ne plus transformer `\text`, `\times`, `\theta`, `\tan` ou `\right` en caractères de contrôle.
- Normalisation mathématique serveur/client alignée sur un même principe.
- Détection des formules autonomes ligne par ligne pour les étapes OCR et les corrigés.
- Fractions, racines, logarithmes, limites, puissances, indices, vecteurs, ensembles et notations PCT normalisés avant MathJax.
- Formules de bloc centrées et isolées proprement ; formules inline conservées dans la phrase.
- Le streaming OCR n'envoie plus des formules partielles à MathJax pendant que l'IA est encore en train de générer sa réponse. Le rendu mathématique final est effectué une fois la réponse complète reçue.
- Les anciennes sorties déjà corrompues (`ext`, `imes`, TAB+`ext`, etc.) sont récupérées lorsque cela est possible.
- Aucun placeholder interne ne peut être envoyé à l'affichage.
- Fallback lisible maintenu uniquement en cas d'indisponibilité réelle de MathJax.
