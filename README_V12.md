# HosBac Quiz V12

Base : V11. Cette version ajoute **Neon PostgreSQL (pgvector)** pour le RAG et les résultats, sans toucher à l’authentification Firebase, au PVP, à l’OCR ni au mode oral.

## Nouveautés

- **Neon** : tables `document_sections` (embeddings 768 dims Gemini), `documents`, `quiz_results`
- **RAG vectoriel** : recherche cosine prioritaire, fallback Firestore
- **Embeddings** : Gemini `text-embedding-004`
- **Admin** : import multi-PDF (jusqu’à 6), titre SA, séquences dynamiques
- **Gemini** déjà en tête de la chaîne de génération QCM (inchangé)
- Auth handoff / captcha / sessions : **inchangés**

## Variables d’environnement Vercel (déjà prévues)

- `DATABASE_URL` (Neon)
- `GEMINI_API_KEY` (+ optionnel `GEMINI_API_KEY_2`)
- Firebase, Cloudinary, Groq, etc. (existantes)

## Déploiement

1. Dézipper
2. `npm install` (ajoute `pg`)
3. Déployer sur Vercel (ou `vercel --prod`)
4. Vérifier que le script SQL Neon a bien été exécuté

## Notes

- Les 2 anciens documents Firestore peuvent être supprimés depuis l’admin puis réimportés proprement (1 SA = 1 PDF).
- Si Neon est indisponible, le quiz continue avec le RAG Firestore (fallback silencieux).
