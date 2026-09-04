# HosBac Quiz — V30.1

## Critical fix: extraction d'images PDF côté serveur

### Problème
`document_images` restait vide car seul le texte était traité à l'import ; aucune extraction d'images embarquées du PDF n'était exécutée côté serveur.

### Solution
1. **`server/lib/pdf-extract-images.js`** (nouveau)
   - Utilise `pdfjs-dist` (legacy) pour lire les XObject images embarquées page par page
   - Convertit en PNG base64 (sans canvas natif — compatible Vercel)
   - Filtre les images &lt; 100×100 px
   - Support URL HTTP/Cloudinary ou buffer base64

2. **`server/handlers/admin/documents.js`**
   - Si le client n'envoie pas d'images : extraction automatique depuis l'URL PDF
   - Puis `processExtractedImages` → Cloudinary → **INSERT Neon `document_images`**
   - Logs : `Successfully inserted image into Neon: …` / erreurs explicites `console.error`

3. **`package.json`**
   - Dépendance `pdfjs-dist@^3.11.174`

### Déploiement
```bash
npm install
# Vérifier CLOUDINARY_* et DATABASE_URL sur Vercel
# Ré-importer les PDF (les anciens imports restent sans images)
```
