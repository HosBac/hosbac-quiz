# HosBac Quiz — V12.27.9

## 1. Prompt OCR anti-hallucination
- Interdiction HTML ; Markdown pur uniquement.
- **JAMAIS de LaTeX** sur Français, Histoire-Géo, Anglais, Philosophie, culture générale.
- Maths (`$...$` / `$$...$$`) réservées à Mathématiques, Physique-Chimie, PCT, SVT.

## 2. Rendu OCR frontend
- `htmlTagsToMarkdown` + `markdownToSafeHtml` + MathJax : gras/italique et formules rendus, pas de balises brutes.

## 3. Admin RAG — Modifier / Supprimer
- Bouton **Modifier** sur chaque document.
- Modale : titre SA, description, contenu texte/Markdown.
- API `PATCH admin/documents?id=` étendue (`description`, `content`/`text`) avec **ré-indexation RAG** automatique si le contenu change.

## 4. Quiz — images
- Affichage `image_url` au-dessus de la question (inchangé / confirmé).
