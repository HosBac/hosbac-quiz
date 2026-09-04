# HosBac Quiz — V30.9

## RAG
- `normalizeMetadata()` central (insertion + recherche)
- Fallback souple si 0 hits : sans SA → sans classe → sans filtres
- Parser SA élargi (Chapitre / Unité / Leçon) + découpe ~1000 car.

## Quiz feedback
- Prompt : feedback min. 15 mots, interdiction tautologies
- UI : plus de phrase fixe « raisonnement… ne mène pas »
- Fallback dynamique basé sur le texte de l'option

## OCR
- Nettoyage renforcé balises vides et bruits de scan
