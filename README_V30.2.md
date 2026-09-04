# HosBac Quiz — V30.2

## Correctifs critiques

### Images PDF → Neon `document_images`
1. **Ordre d’upload corrigé** : création document d’abord, puis `process-images` **avec `documentId`** (lots de 2).
2. **Fallback serveur** : action `extract-pdf-images` si le client n’extrait rien.
3. **Logs Vercel** : `[API] hit`, `[ADMIN DOCS] ENTER`, `[UPLOAD]…`, `Successfully inserted image into Neon`.
4. **`vercel.json`** : `maxDuration: 60`, `memory: 1024` sur `api/index.js`.

### Multi-documents par SA
- Chaque import crée un **nouvel ID** Firestore — aucune unicité SA/matière/classe.
- Le RAG interroge **tous** les chunks correspondants (filtre classe + matière + SA).

### Structure QCM pédagogique
- Distracteurs = erreurs classiques d’élèves.
- `option_explanations` {0,1,2,3} renvoyés et affichés après réponse.
- `explanation` étape par étape de la bonne réponse.

### Déploiement
```bash
npm install   # pdfjs-dist requis
# Vérifier CLOUDINARY_* + DATABASE_URL
# Ré-importer les PDF après déploiement
```
