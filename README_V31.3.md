# HosBac Quiz — V31.3

## Contexte sans spoiler
- Prompt : `context_text` = mise en situation uniquement, jamais la formule/solution
- Question de cours pure → `context_text: ""`
- `sanitizeContextText()` filtre les contextes qui révèlent la réponse

## Diversification RAG
- `sampleHits` : tirage aléatoire parmi les **top 20** résultats (plus seulement les 2 premiers)
- Pool élargi (min 20)

## Anti-répétition
- Historique session + sessions antérieures (jusqu'à 40 empreintes)
- Similarité par empreinte / tokens
- Jusqu'à 3 tentatives de génération si trop proche

## Frontend
- Bloc « Contexte de l'exercice » affiché seulement si `context_text` non vide
