# HosBac Quiz V12.20

Correctif ciblé : Dashboard Admin — Modèles IA & configuration dynamique.

## Correctifs

1. **Bug `DEFAULT_MODELS is not defined`**
   - Cause : le handler GET `/api/admin/ai-models` renvoyait `defaults: DEFAULT_MODELS` sans importer la constante.
   - Fix : réponse GET limitée à `{ success, models }` (liste depuis Neon, triée `priority_order ASC`).

2. **Formulaire d’ajout (4 champs stricts)**
   - Provider (select) : gemini | openrouter | mistral | grok | cloudflare
   - Nom du modèle (texte libre)
   - Variable env Vercel (texte libre, ex. `GEMINI_API_KEY_1`) — aucune clé API en clair
   - Priorité (nombre, vide par défaut → 1 si non renseigné). Plus de pré-remplissage à 50.

3. **Liste dynamique sous le formulaire**
   - Cartes : provider, model_name, env_key_name, priority_order
   - Toggle ON/OFF (`is_active`) via PATCH
   - Bouton Supprimer via DELETE

## Inchangé

- Auth Firebase, quiz, PVP, OCR, styles, schéma Neon existant, moteur `ai-fallback.js` (seed + rotation 429).
- Architecture et routes inchangées hors ce correctif.

## Fichiers touchés uniquement

- `server/handlers/admin/ai-models.js`
- `index.html` (section `#adminAiModels` + handlers JS associés)
