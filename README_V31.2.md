# HosBac Quiz — V31.2

## Fix modale édition documents RAG
- Pré-remplissage : cache liste + GET `admin/documents?id=`
- Contenu chargé depuis `content`/`text` ou chunks `quiz_rag_chunks`
- PATCH/PUT : `id` via query, body ou URL (`resolveDocId`)
- Enregistrement : title, description, content + ré-indexation RAG
- UI : fermeture modale + `loadDocs()` sans reload page
