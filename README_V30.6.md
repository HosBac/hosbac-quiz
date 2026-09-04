# HosBac Quiz — V30.6

## 1. OCR — plus de JSON / HTML brut
- Prompt OCR : Markdown structuré (`## Document reconstruit` / `## Analyse pédagogique`), **interdiction** de blocs ```json
- `finalizeFromContent` parse JSON en silence ou découpe les sections Markdown
- Frontend `extractOcrFields` : n'affiche que `formattedDocument` et `analysis`
- Pendant le stream : pas d'affichage du JSON en construction

## 2. Quiz — explications pédagogiques par option
- Prompt : objet `explanations` {A,B,C,D} (+ `option_explanations` {0..3})
- Interdiction des tautologies (« Cette option est incorrecte. La bonne réponse est C. »)
- UI : clic sur une option → texte spécifique de l'erreur de raisonnement
