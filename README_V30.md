# HosBac Quiz — V30

## Pipeline images PDF → Cloudinary → Neon `document_images` → Quiz

### Schéma Neon
```sql
CREATE TABLE document_images (
  id BIGSERIAL PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER DEFAULT 0,
  image_url TEXT NOT NULL,
  public_id TEXT,
  page INTEGER,
  width INTEGER,
  height INTEGER,
  md5_hash TEXT,
  caption TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
Création auto au premier INSERT (`ensureDocumentImagesTable`).

### Flux import admin
1. Client extrait les pages/figures du PDF (`extractPdfImages`)
2. Upload Cloudinary optimisé (WebP q75 w800) + anti-doublon MD5
3. `admin/documents` enregistre le document + **INSERT dans `document_images`**
4. Logs explicites : `[image-pipeline]`, `[ADMIN DOCS]`

### Génération quiz (`quiz/next`)
1. Charge les `image_url` depuis Neon (`getImagesByDocumentIds`) + fallback Firestore
2. Les passe au prompt LLM (`FIGURES DISPONIBLES`)
3. Force `image_url` dans le JSON question si figure pertinente
4. Réponse API client : `{ question: { id, question, choices, difficulty, context_text, image_url } }`

### Formules
- Normalisation `frac`/`vec` sans backslash → LaTeX + MathJax (client + serveur)

### Fichiers clés
- `server/lib/image-pipeline.js`
- `server/handlers/admin/documents.js`
- `server/lib/rag.js`
- `server/handlers/quiz/next.js`
- `scripts/init-db.sql`
- `index.html`
