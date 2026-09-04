# HosBac Quiz — V31.0

## 1. Conformité académique (OCR + Mode oral)
- Prompt système : règle de conformité en tête
- Rejet JSON `status: rejected` pour paris, factures, hors-académique
- Filtre heuristique serveur (1xBet, Betwinner, etc.)
- UI : bandeau rouge « Contenu refusé »

## 2. Formules mathématiques
- `ensureMathDelimiters` : `\(`/`\)` → `$`, `\[`/`\]` → `$$`
- MathJax typeset sur quiz, OCR, oral, popups

## 3. Mode oral
- Restriction hors-sujet : message d'assistance académique HosBac
