# HosBac Quiz — V30.5

## 1. Explications pédagogiques des fausses options
- Prompt QCM : interdiction des tautologies (« faux car la bonne est B »)
- Chaque `option_explanations[i]` doit décrire la **faute de raisonnement**
- Filtrage serveur + fallback client non générique
- UI : « Pourquoi l'option X est fausse : … »

## 2. Mode oral indépendant du quiz
- Ne transmet plus la matière du quiz (`matiere: ''`, `independent: true`)
- Prompt dédié : toutes disciplines scolaires acceptées
- Interdiction LaTeX / formules maths en mode oral
- Rendu `renderOralHtml` (littéraire, sans MathJax)

## 3. Nettoyage HTML mode oral
- Prompt : Markdown uniquement
- `htmlTagsToMarkdown` + `renderOralHtml` côté UI
