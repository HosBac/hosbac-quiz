# HosBac Quiz — V31.1

## Sécurité académique
- `ocr/analyze.js` : filtre local paris/factures → HTTP 400
- `ai/generate.js` : règle de conformité en tête des prompts système
- `ai/analyze.js` : rejet → HTTP 400 + bandeau UI rouge

## OCR formatage
- Markdown pur, pas de HTML
- LaTeX réservé Maths / Physique-Chimie

## Rendu maths
- `ensureMathDelimiters` : `\(`/`\)` → `$`, `\[`/`\]` → `$$`
- MathJax sur quiz, OCR, oral

## Admin RAG
- Modifier titre, description, contenu (PATCH)
- Supprimer (DELETE)
- GET `?id=` pour charger le contenu à l'édition
