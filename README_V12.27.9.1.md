# HosBac Quiz — V12.27.9.1

## Correctifs affichés (screenshot formules brutes + images)

### Formules mathématiques
- Client `normalizeQuizMath` : convertit `frac{...}`, `vec{...}` **sans backslash** en `\frac`, `\vec`, puis enveloppe en `\(...\)`.
- Serveur `normalizeMathMarkup` (quiz/next) + `fixBareLatex` (batch) : même correction à la source.
- Typeset MathJax renforcé (double passage court après rendu des choix).

### Images / figures en tête de question
- Liaison automatique élargie : si des `image_url` existent sur les documents RAG de la matière/classe, elles sont attachées aux questions (barycentre, vecteur, schéma, graphique, etc.).
- L'affichage `image_url` au-dessus du texte de question reste actif.

**Important** : les figures n'apparaissent que si les documents importés en admin ont des `image_url` / `image_urls` (import PDF avec extraction d'images).
