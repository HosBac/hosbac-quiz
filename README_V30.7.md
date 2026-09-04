# HosBac Quiz — V30.7

## 1. Fix OCR ReferenceError
- `extractOcrFields` définie globalement avant tout appel
- try/catch interne + try/catch du handler OCR
- N'affiche jamais le JSON brut

## 2. Fix explications quiz (plus de fallback STEM)
- Priorité à `question.explanations[A|B|C|D]` puis `option_explanations[0..3]`
- Suppression du template « confusion de notion, inversion de formule… »
- Fallback neutre uniquement si l'IA n'a fourni aucune explication
