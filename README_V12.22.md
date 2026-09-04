# HosBac Quiz V12.22

Rendu mathématiques (MathJax), OCR nettoyé, Mode Oral pédagogique.

## 1. Mathématiques
- MathJax : packages `noerrors` + `noundefined` (équivalent throwOnError:false — plus d’erreurs brutes à l’écran).
- `repairLatex()` : équilibre `\left`/`\right`, convertit `(a)/(b)` et `a/b` en `\frac`, `sqrt(x)` → `\sqrt`, exposants.
- Pipeline appliqué côté frontend (`mathHtml` / `normalizeQuizMath`) et serveur (`normalizeMathText`).

## 2. OCR « Corriger un exercice en photo »
- Prompt : suppression des en-têtes admin (adresses, BP, téléphones, emails, ministères).
- Sortie : **sujet nettoyé** + **correction pédagogique détaillée** uniquement.

## 3. Mode Oral
- Structure fixe : 🎯 Évaluation · 💡 Analyse pédagogique · 🗣️ Conseil épreuve orale.
- Politesse seule (« bonjour ») → invitation à dicter le raisonnement.

## Fichiers touchés
- `index.html` (MathJax + repairLatex + typeset)
- `server/handlers/ai/analyze.js` (prompts OCR/oral + normalizeMathText)

Auth, quiz, admin modèles, architecture : inchangés.
