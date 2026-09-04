# HosBac Quiz — V12.27.8

## Quiz : images / figures / courbes
- Affichage `image_url` au-dessus de la question (zoom + imprimer) — déjà en place, confirmé.
- Génération (`quiz/next`) :
  - Récupère les URLs de figures des documents RAG (`image_url` / `image_urls`).
  - Prompt : questions auto-portantes (« D'après la figure ci-dessus… »), champ JSON `image_url` obligatoire si figure.
  - Repli automatique : si l'IA omet `image_url` mais le texte évoque une figure, liaison à une URL disponible.
- `quiz/batch` : mêmes consignes JSON (`image_url`, `context_text`).

## OCR : rendu Markdown + formules
- Prompt OCR : **interdiction HTML**, Markdown uniquement, maths en `$...$` / `$$...$$`.
- Frontend : `htmlTagsToMarkdown` convertit `<strong>`/`<em>` résiduels → markdown puis HTML sûr + MathJax.
- Copie : `stripHtmlForExport` retire balises et marqueurs pour un texte propre.

Fichiers touchés : `index.html`, `server/handlers/quiz/next.js`, `batch.js`, `server/handlers/ai/analyze.js`.
