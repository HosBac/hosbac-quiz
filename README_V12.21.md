# HosBac Quiz V12.21

Correctif : suppression du seed automatique des modèles IA + gestion 100 % manuelle + toggle ON/OFF.

## Changements

1. **Plus aucun seeding automatique**
   - `ensureAiModelsTable()` crée uniquement la table (CREATE IF NOT EXISTS).
   - `seedMissingDefaults()` est un no-op.
   - Le handler admin n’appelle plus de seed à chaque requête.
   - Les INSERT d’exemples dans `scripts/ai_models_config.sql` sont commentés.

2. **Bouton « Vider toute la liste »**
   - DELETE `/api/admin/ai-models` avec `{ clearAll: true }` → `DELETE FROM ai_models_config`.
   - L’admin repart d’une table vide et n’ajoute que les modèles voulus.

3. **Formulaire d’ajout manuel (4 champs)**
   - Provider (select), Nom du modèle, Variable env Vercel, Priorité.
   - Aucune clé API stockée ou affichée côté frontend.

4. **Toggle ON / OFF**
   - Appel `PUT /api/admin/ai-models` avec `{ id, is_active }`.
   - Mise à jour immédiate de l’UI locale (sans rechargement complet).
   - Le moteur de génération (`listActiveModels`) n’utilise que les lignes `is_active = true`.

5. **Suppression unitaire**
   - DELETE avec `{ id }` retire la ligne en base et du DOM.

## Fichiers modifiés uniquement

- `server/lib/ai-fallback.js`
- `server/handlers/admin/ai-models.js`
- `index.html` (section Admin modèles IA)
- `scripts/ai_models_config.sql` (exemples commentés)

Auth, quiz, PVP, OCR, styles et le reste de l’architecture : **inchangés**.

## Note opérationnelle

Après déploiement, ouvrir Admin → Modèles IA → **Vider toute la liste**, puis ajouter uniquement les modèles / variables d’env réellement configurés sur Vercel.
