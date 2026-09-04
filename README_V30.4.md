# HosBac Quiz — V30.4

## 1. Streaming SSE sur `/api/ai/analyze`
- Réponse progressive (`text/event-stream`) : tokens dès les premières ms
- Client `apiAnalyzeStream()` pour mode oral et OCR
- Évite le **Vercel Runtime Timeout 60s**
- Fallback JSON non-stream conservé

## 2. Payload optimisé
- Troncature entrée : oral 8k, OCR 18k caractères
- `max_tokens` réduit (oral 1200 / OCR 1800)
- Prompt plus compact

## 3. Nettoyage HTML global
- Prompt système : Markdown uniquement, interdiction HTML
- `htmlTagsToMarkdown` renforcé (`<strong>` → `**`, etc.)
- `mathHtml` applique le nettoyage avant rendu
- TTS : strip des balises avant lecture

### Événements SSE
- `start` → `token` (répété) → `done` | `error`
