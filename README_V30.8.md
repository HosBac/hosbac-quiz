# HosBac Quiz — V30.8

## Feedback chirurgical par option
- Format JSON préféré : `options[{id, texte, est_correcte, feedback}]`
- Prompt : interdiction des feedbacks génériques
- `extractQuestion` / `normalizeQuestions` mappent `options[].feedback` → `explanations` + `option_explanations`
- UI : clic option → affiche le `feedback` IA spécifique

## OCR
- Nettoyage renforcé des balises vides (`<strong></strong>`, `<em></em>`)
- Suppression des bruits `• <strong>…` avant affichage
