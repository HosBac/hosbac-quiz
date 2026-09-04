# HosBac Quiz — V12.27.1.2

## Warnings Node / PostgreSQL
- `server/lib/db.js` : `sslmode=verify-full` injecté dans `DATABASE_URL` (préparation pg v9).
- SSL : `rejectUnauthorized` activable via `PG_SSL_REJECT_UNAUTHORIZED=true` (défaut false pour compat Neon).
- `api/index.js` : parsing de route via **WHATWG `new URL()`** (plus de `url.parse`).

## Pipeline images PDF → Cloudinary → RAG
### Backend
- `server/lib/image-pipeline.js` :
  - Upload Cloudinary avec transformation **f_webp,q_75,w_800,c_limit**
  - Anti-doublon **MD5** (`rag_image_hashes` Firestore) → réutilise l’URL existante
  - Ignore les images &lt; 100×100 px
- `admin/documents` :
  - Action `process-images` : traite un lot d’images extraites
  - Import unitaire / multi-SA : enregistre `image_url` / `image_urls` automatiquement

### Frontend admin
- `extractPdfImages` (pdf.js) : rend les pages, filtre le contenu vide, compresse WebP max 800px
- Import SA par PDF : extraction + upload optimisé avant enregistrement RAG
- Mode multi-SA : champ PDF optionnel pour schémas associés automatiquement

L’administrateur n’a plus à coller manuellement les liens d’images.
