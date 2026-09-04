'use strict';

const { getAdmin, json, requireAdmin } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const rag = require('../../lib/rag');
const { processExtractedImages, uploadOptimizedImage, saveImageUrlsToNeon, insertDocumentImage } = require('../../lib/image-pipeline');
const { extractImagesFromPdfUrl, extractImagesFromPdfBuffer } = require('../../lib/pdf-extract-images');

function resolveDocId(req) {
  const q = (req.query && (req.query.id || req.query.docId || req.query.documentId)) || '';
  if (q) return String(q).trim();
  const b = req.body || {};
  if (b.id || b.docId || b.documentId) return String(b.id || b.docId || b.documentId).trim();
  // Fallback: parse query string from URL (Vercel rewrite)
  try {
    const u = new URL(String(req.url || '/'), 'http://localhost');
    const id = u.searchParams.get('id') || u.searchParams.get('docId');
    if (id) return String(id).trim();
  } catch (_) {}
  return '';
}

module.exports = async (req, res) => {

  if (cors(req, res)) return;
  try {
    await requireAdmin(req);
    const db = getAdmin().firestore();
    console.log('[ADMIN DOCS] ENTER', req.method, 'action=', (req.body && req.body.action) || '(none)', 'hasImages=', !!(req.body && req.body.images && req.body.images.length), 'hasUrl=', !!(req.body && req.body.url), 'docId=', (req.body && (req.body.documentId || req.body.docId)) || (req.query && req.query.id) || '');

    if (req.method === 'GET') {
      const id = resolveDocId(req);
      if (id) {
        const snap = await db.collection('quiz_documents').doc(id).get();
        if (!snap.exists) return json(res, 404, { success: false, error: 'Document introuvable' });
        let data = { id: snap.id, ...snap.data() };
        if (!data.content && !data.text) {
          try {
            const chunks = await db.collection('quiz_rag_chunks').where('docId', '==', id).limit(30).get();
            const sorted = chunks.docs
              .map((x) => ({ index: Number(x.data().index) || 0, text: x.data().text || '' }))
              .sort((a, b) => a.index - b.index);
            const parts = sorted.map((x) => x.text).filter(Boolean);
            if (parts.length) data.content = parts.join('\n\n');
          } catch (e) {
            console.warn('[ADMIN DOCS] chunks load', e.message);
          }
        }
        // Toujours exposer content pour le frontend
        if (!data.content && data.text) data.content = data.text;
        return json(res, 200, { success: true, document: data });
      }
      const s = await db.collection('quiz_documents').orderBy('createdAt', 'desc').limit(100).get();
      return json(res, 200, {
        success: true,
        documents: s.docs.map((x) => ({ id: x.id, ...x.data() }))
      });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const isImageAction = b.action === 'process-images' || b.processImages === true || b.action === 'extract-pdf-images';
      if (!isImageAction && (!b.classe || !b.matiere)) {
        return json(res, 400, { success: false, error: 'classe et matiere sont obligatoires' });
      }

      /**
       * Action dédiée : upload optimisé d'images extraites d'un PDF (anti-doublon MD5,
       * WebP q75 w800, ignore < 100x100). Remplit automatiquement image_url côté admin.
       */
      if (b.action === 'process-images' || b.processImages === true) {
        const images = Array.isArray(b.images) ? b.images : [];
        if (!images.length) {
          return json(res, 400, { success: false, error: 'Aucune image à traiter' });
        }
        const documentId = String(b.documentId || b.docId || '').trim();
        console.log('[ADMIN DOCS] process-images count=', images.length, 'docId=', documentId || '(pending)');
        const processed = await processExtractedImages(images, { documentId });
        return json(res, 200, {
          success: true,
          images: processed,
          count: processed.length,
          deduped: processed.filter((x) => x.deduped).length,
          documentId: documentId || null
        });
      }

      // Extraction serveur forcée depuis URL PDF → Cloudinary → Neon
      if (b.action === 'extract-pdf-images') {
        const documentId = String(b.documentId || b.docId || '').trim();
        const pdfUrl = String(b.url || '').trim();
        console.log('[ADMIN DOCS] extract-pdf-images docId=', documentId, 'url=', pdfUrl.slice(0, 100));
        if (!pdfUrl) {
          return json(res, 400, { success: false, error: 'URL PDF manquante' });
        }
        try {
          const extracted = await extractImagesFromPdfUrl(pdfUrl);
          console.log('[ADMIN DOCS] extract-pdf-images found', extracted.length);
          if (!extracted.length) {
            return json(res, 200, { success: true, images: [], count: 0, message: 'Aucune image embarquée détectée dans le PDF' });
          }
          const processed = await processExtractedImages(extracted, { documentId });
          console.log('[ADMIN DOCS] extract-pdf-images uploaded', processed.length);
          // Aussi sauvegarder les URLs si documentId
          if (documentId && processed.length) {
            try {
              await saveImageUrlsToNeon(documentId, processed.map((x) => x.url).filter(Boolean));
            } catch (e) {
              console.warn('[ADMIN DOCS] saveImageUrlsToNeon', e.message);
            }
            try {
              const db = getAdmin().firestore();
              await db.collection('quiz_documents').doc(documentId).set({
                image_urls: processed.map((x) => x.url).filter(Boolean),
                image_url: processed[0] && processed[0].url || ''
              }, { merge: true });
            } catch (e) {
              console.warn('[ADMIN DOCS] firestore image_urls', e.message);
            }
          }
          return json(res, 200, {
            success: true,
            images: processed,
            count: processed.length
          });
        } catch (e) {
          console.error('[ADMIN DOCS] extract-pdf-images FAILED', e.message, e.stack);
          return json(res, 500, { success: false, error: e.message || 'Extraction PDF échouée' });
        }
      }


      /**
       * Mode Document Complet Multi-SA :
       * body.multiSa === true + body.text = document entier.
       * Découpe automatique par titres SA1…SA8 et indexe chaque SA.
       */
      if (b.multiSa === true || b.mode === 'multi') {
        const fullText = String(b.text || '').trim();
        if (!fullText) {
          return json(res, 400, { success: false, error: 'Texte du document complet requis pour le mode multi-SA' });
        }
        const globalTitle = String(b.title || b.name || 'Document complet').trim();
        const globalDesc = String(b.description || b.globalDescription || '').trim();
        const classe = String(b.classe);
        const serie = String(b.serie || '');
        const matiere = String(b.matiere);

        // Découpage par en-têtes SA (SA 1, SA1 :, Situation d'apprentissage 2, etc.)
        const saRegex = /(?:^|\n)\s*(?:SA\s*([1-8])|Situation\s+d['']apprentissage\s*([1-8])|Chapitre\s*([1-8])|Unit[eé]\s*([1-8])|Le[cç]on\s*([1-8]))\s*[:.\-–—)]?\s*([^\n]*)/gi;
        const matches = [];
        let m;
        while ((m = saRegex.exec(fullText)) !== null) {
          const num = m[1] || m[2] || m[3] || m[4] || m[5];
          const titlePart = (m[6] || '').trim();
          if (!num) continue;
          matches.push({
            index: m.index,
            sa: 'SA' + num,
            title: titlePart ? `SA${num} : ${titlePart}` : `SA${num}`,
            headerLen: m[0].length
          });
        }

        if (!matches.length) {
          // Fallback : découpage par blocs ~1000 car. si aucun marqueur SA/Chapitre/Unité
          const chunkSize = 1000;
          if (fullText.length > chunkSize) {
            let offset = 0, n = 1;
            while (offset < fullText.length && n <= 8) {
              matches.push({ index: offset, sa: 'SA' + n, title: (globalTitle || 'Document') + ' — partie ' + n, headerLen: 0 });
              offset += chunkSize;
              n++;
            }
          } else {
            matches.push({ index: 0, sa: 'SA1', title: globalTitle || 'SA1', headerLen: 0 });
          }
        }

        // Traiter les images du PDF une seule fois (compression + anti-doublon)
        let globalImages = [];
        if (Array.isArray(b.images) && b.images.length) {
          try {
            console.log('[ADMIN DOCS] multi client images', b.images.length);
            globalImages = await processExtractedImages(b.images);
          } catch (e) {
            console.error('[ADMIN DOCS] multi images FAILED', e.message, e.stack);
          }
        } else if (Array.isArray(b.image_urls) && b.image_urls.length) {
          globalImages = b.image_urls.filter(Boolean).map((url) => ({ url: String(url) }));
        }
        if (!globalImages.length && b.url) {
          try {
            console.log('[ADMIN DOCS] multi extract from PDF url');
            const extracted = await extractImagesFromPdfUrl(String(b.url));
            if (extracted.length) {
              globalImages = await processExtractedImages(extracted);
              console.log('[ADMIN DOCS] multi Successfully extracted images:', globalImages.length);
            }
          } catch (e) {
            console.error('[ADMIN DOCS] multi PDF extract FAILED', e.message, e.stack);
          }
        }

        const created = [];
        let totalChunks = 0;

        for (let i = 0; i < matches.length; i++) {
          const start = matches[i].index + (matches[i].headerLen || 0);
          const end = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
          const sectionText = fullText.slice(start, end).trim();
          if (!sectionText || sectionText.length < 20) continue;

          const ref = db.collection('quiz_documents').doc(); // MULTI-DOC: toujours un nouvel ID — plusieurs docs par SA autorisés
          const saCode = matches[i].sa;
          const saTitle = matches[i].title;
          const docData = {
            url: '',
            publicId: '',
            name: saTitle,
            title: saTitle,
            sa_title: saTitle,
            sequences: [],
            classe,
            serie,
            matiere,
            chapitre: saCode,
            chapitres: [saCode],
            sa: [saCode],
            description: globalDesc,
            parentTitle: globalTitle,
            multiImport: true,
            // Associer les images du document (toutes les SA partagent le pool ; 1ère SA reçoit image_url principale)
            image_urls: globalImages.map((x) => x.url).filter(Boolean),
            image_url: i === 0 && globalImages[0] ? globalImages[0].url : '',
            images: i === 0 ? globalImages : [],
            active: true,
            createdAt: getAdmin().firestore.Timestamp.now()
          };
          await ref.set(docData);

          // Neon document_images pour cette SA
          if (globalImages.length) {
            try {
              await saveImageUrlsToNeon(ref.id, globalImages.map((x) => x.url).filter(Boolean));
            } catch (e) {
              console.warn('[ADMIN DOCS] multi Neon images', e.message);
            }
          }

          try {
            const result = await rag.indexDocument({
              docId: ref.id,
              text: sectionText,
              classe,
              serie,
              matiere,
              saTitle,
              sequences: [],
              title: saTitle,
              sa: saCode
            });
            totalChunks += result?.chunkCount || 0;

            const crypto = require('crypto');
            const clean = sectionText.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
            const size = 7000;
            const batch = db.batch();
            for (let j = 0; j < clean.length; j += size) {
              const part = clean.slice(j, j + size);
              const id = crypto.createHash('sha1').update(ref.id + ':' + j + ':' + part).digest('hex');
              batch.set(db.collection('quiz_rag_chunks').doc(id), {
                docId: ref.id,
                classe,
                serie,
                matiere,
                chapitre: saCode,
                chapitres: [saCode],
                sa_title: saTitle,
                sequences: [],
                index: Math.floor(j / size),
                text: part,
                createdAt: getAdmin().firestore.Timestamp.now()
              }, { merge: true });
            }
            await batch.commit();
            await ref.set({
              chunkCount: Math.ceil(clean.length / size) || 1,
              textLength: clean.length,
              indexedAt: getAdmin().firestore.Timestamp.now(),
              sourceType: 'text-multi'
            }, { merge: true });
          } catch (e) {
            console.warn('[ADMIN DOCS] multi SA index skip', saCode, e.message);
          }

          created.push({ id: ref.id, sa: saCode, title: saTitle });
        }

        return json(res, 201, {
          success: true,
          multiSa: true,
          count: created.length,
          neonChunks: totalChunks,
          documents: created,
          message: created.length + ' SA importée(s) depuis le document complet'
        });
      }

      const hasUrl = Boolean(String(b.url || '').trim());
      const hasText = Boolean(String(b.text || '').trim());
      if (!hasUrl && !hasText) {
        return json(res, 400, { success: false, error: 'Fournis un PDF (url) ou un texte, pas les deux vides' });
      }

      const ref = db.collection('quiz_documents').doc();
      const title = String(b.title || b.name || b.sa_title || 'Document').trim();
      const saTitle = String(b.sa_title || b.saTitle || title).trim();
      const sequences = Array.isArray(b.sequences)
        ? b.sequences.map((x) => String(x).trim()).filter(Boolean)
        : String(b.sequences || '')
            .split(/\n|,|;/)
            .map((x) => x.trim())
            .filter(Boolean);

      const rawChapitre = String(b.chapitre || '');
      const detectedSAs =
        Array.isArray(b.chapitres) && b.chapitres.length
          ? b.chapitres.map(String).filter((x) => /^SA[1-8]$/i.test(x))
          : Array.from(new Set((rawChapitre.match(/SA[1-8]/gi) || []).map((x) => x.toUpperCase())));

      if (saTitle && /^SA[1-8]/i.test(saTitle) && !detectedSAs.length) {
        const m = saTitle.match(/SA[1-8]/i);
        if (m) detectedSAs.push(m[0].toUpperCase());
      }

      const chapitre = rawChapitre || saTitle || detectedSAs.join(' · ');

      // Images : client (base64) OU extraction serveur depuis PDF (URL / buffer)
      let imageUrls = Array.isArray(b.image_urls) ? b.image_urls.map(String).filter(Boolean) : [];
      let imageMeta = [];
      if (Array.isArray(b.images) && b.images.length) {
        try {
          console.log('[ADMIN DOCS] processing client-provided images', b.images.length);
          imageMeta = await processExtractedImages(b.images, { documentId: ref.id });
          imageUrls = imageMeta.map((x) => x.url).filter(Boolean);
          console.log('[ADMIN DOCS] client images uploaded', imageUrls.length);
        } catch (e) {
          console.error('[ADMIN DOCS] client images FAILED', e.message, e.stack);
        }
      }
      // Extraction serveur si aucune image fournie mais PDF disponible
      if (!imageUrls.length) {
        try {
          let extracted = [];
          if (b.pdfBase64) {
            console.log('[ADMIN DOCS] extracting images from pdfBase64');
            const raw = String(b.pdfBase64).replace(/^data:application\/pdf;base64,/, '');
            extracted = await extractImagesFromPdfBuffer(Buffer.from(raw, 'base64'));
          } else if (hasUrl && /\.pdf($|\?)|cloudinary|\/raw\/upload/i.test(String(b.url))) {
            console.log('[ADMIN DOCS] extracting images from PDF url');
            extracted = await extractImagesFromPdfUrl(String(b.url));
          }
          if (extracted.length) {
            console.log('[ADMIN DOCS] PDF embedded images found', extracted.length);
            imageMeta = await processExtractedImages(extracted, { documentId: ref.id });
            imageUrls = imageMeta.map((x) => x.url).filter(Boolean);
            console.log('[ADMIN DOCS] Successfully inserted images into Neon:', imageUrls.length, imageUrls.slice(0, 3));
          } else {
            console.warn('[ADMIN DOCS] No embedded images found in PDF');
          }
        } catch (e) {
          console.error('[ADMIN DOCS] PDF image extraction FAILED', e.message, e.stack);
        }
      }

      const docData = {
        url: String(b.url || ''),
        publicId: String(b.publicId || ''),
        name: String(b.name || title),
        title,
        sa_title: saTitle,
        sequences,
        classe: String(b.classe),
        serie: String(b.serie || ''),
        matiere: String(b.matiere),
        chapitre,
        chapitres: detectedSAs,
        sa: detectedSAs,
        image_urls: imageUrls,
        image_url: imageUrls[0] || String(b.image_url || ''),
        images: imageMeta,
        active: b.active !== false,
        createdAt: getAdmin().firestore.Timestamp.now()
      };

      await ref.set(docData);

      // Persister image_urls dans Neon document_images (si pas déjà fait via processExtractedImages)
      if (imageUrls.length) {
        try {
          const saved = await saveImageUrlsToNeon(ref.id, imageUrls);
          console.log('[ADMIN DOCS] Neon document_images saved=', saved, 'for', ref.id);
        } catch (e) {
          console.warn('[ADMIN DOCS] Neon images', e.message);
        }
      }

      let neonChunks = 0;
      try {
        if (hasText) {
          const result = await rag.indexDocument({
            docId: ref.id,
            text: String(b.text),
            classe: docData.classe,
            serie: docData.serie,
            matiere: docData.matiere,
            saTitle,
            sequences,
            title,
            sa: detectedSAs[0] || ''
          });
          neonChunks = result?.chunkCount || 0;
          // Aussi chunks Firestore pour compat
          const crypto = require('crypto');
          const clean = String(b.text).replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
          const size = 7000;
          const batch = db.batch();
          for (let i = 0; i < clean.length; i += size) {
            const part = clean.slice(i, i + size);
            const id = crypto.createHash('sha1').update(ref.id + ':' + i + ':' + part).digest('hex');
            batch.set(db.collection('quiz_rag_chunks').doc(id), {
              docId: ref.id,
              classe: docData.classe,
              serie: docData.serie,
              matiere: docData.matiere,
              chapitre: docData.chapitre,
              chapitres: docData.chapitres,
              sa_title: saTitle,
              sequences,
              index: Math.floor(i / size),
              text: part,
              createdAt: getAdmin().firestore.Timestamp.now()
            }, { merge: true });
          }
          await batch.commit();
          await ref.set({ chunkCount: Math.ceil(clean.length / size) || 1, textLength: clean.length, indexedAt: getAdmin().firestore.Timestamp.now(), sourceType: 'text' }, { merge: true });
        } else {
          await rag.indexDocument({
            docId: ref.id,
            text: '',
            classe: docData.classe,
            serie: docData.serie,
            matiere: docData.matiere,
            saTitle,
            sequences,
            title,
            sa: detectedSAs[0] || ''
          });
        }
      } catch (e) {
        console.warn('[ADMIN DOCS] Neon index skip:', e.message);
      }

      return json(res, 201, {
        success: true,
        neonChunks,
        document: { id: ref.id, ...(await ref.get()).data() }
      });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const id = resolveDocId(req);
      if (!id) return json(res, 400, { success: false, error: 'ID manquant' });
      const allowed = [
        'name', 'title', 'sa_title', 'sequences', 'classe', 'serie', 'matiere',
        'chapitre', 'chapitres', 'sa', 'url', 'publicId', 'active',
        'description', 'content', 'text', 'image_url', 'image_urls'
      ];
      const b = req.body || {};
      const patch = {};
      for (const k of allowed) if (k in b) patch[k] = b[k];
      // Alias contenu éditable
      if (b.content != null) { patch.content = String(b.content); patch.text = String(b.content); }
      if (b.text != null && b.content == null) { patch.content = String(b.text); patch.text = String(b.text); }
      if (b.description != null) patch.description = String(b.description);
      if (b.title != null) { patch.title = String(b.title); patch.name = String(b.title); patch.sa_title = String(b.title); }
      if (Object.keys(patch).length) {
        patch.updatedAt = getAdmin().firestore.Timestamp.now();
        await db.collection('quiz_documents').doc(id).set(patch, { merge: true });
      }

      // Ré-indexation RAG si le texte a été modifié
      const newText = b.content != null ? String(b.content) : (b.text != null ? String(b.text) : '');
      let reindexed = false;
      if (newText.trim().length > 20) {
        try {
          const snap = await db.collection('quiz_documents').doc(id).get();
          const data = snap.exists ? snap.data() : {};
          // Supprimer anciens chunks Firestore
          const oldChunks = await db.collection('quiz_rag_chunks').where('docId', '==', id).get();
          const batch = db.batch();
          oldChunks.docs.forEach((x) => batch.delete(x.ref));
          await batch.commit();
          try { await rag.deleteDocument(id); } catch (_) {}
          await rag.indexDocument({
            docId: id,
            text: newText,
            classe: data.classe || '',
            serie: data.serie || '',
            matiere: data.matiere || '',
            saTitle: data.sa_title || data.title || '',
            sequences: data.sequences || [],
            title: data.title || data.name || '',
            sa: (data.sa && data.sa[0]) || (data.chapitres && data.chapitres[0]) || ''
          });
          const crypto = require('crypto');
          const clean = newText.replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
          const size = 7000;
          const batch2 = db.batch();
          for (let i = 0; i < clean.length; i += size) {
            const part = clean.slice(i, i + size);
            const cid = crypto.createHash('sha1').update(id + ':' + i + ':' + part).digest('hex');
            batch2.set(db.collection('quiz_rag_chunks').doc(cid), {
              docId: id,
              classe: data.classe || '',
              serie: data.serie || '',
              matiere: data.matiere || '',
              chapitre: data.chapitre || '',
              chapitres: data.chapitres || [],
              sa_title: data.sa_title || '',
              sequences: data.sequences || [],
              index: Math.floor(i / size),
              text: part,
              createdAt: getAdmin().firestore.Timestamp.now()
            }, { merge: true });
          }
          await batch2.commit();
          await db.collection('quiz_documents').doc(id).set({
            textLength: clean.length,
            chunkCount: Math.ceil(clean.length / size) || 1,
            indexedAt: getAdmin().firestore.Timestamp.now()
          }, { merge: true });
          reindexed = true;
        } catch (e) {
          console.warn('[ADMIN DOCS] reindex', e.message);
        }
      }

      const updated = await db.collection('quiz_documents').doc(id).get();
      return json(res, 200, {
        success: true,
        reindexed,
        document: updated.exists ? { id: updated.id, ...updated.data() } : { id }
      });
    }

    if (req.method === 'DELETE') {
      const id = resolveDocId(req);
      if (!id) return json(res, 400, { success: false, error: 'ID manquant' });
      const ref = db.collection('quiz_documents').doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { success: false, error: 'Document introuvable' });

      const chunks = await db.collection('quiz_rag_chunks').where('docId', '==', id).get();
      const batch = db.batch();
      chunks.docs.forEach((x) => batch.delete(x.ref));
      batch.delete(ref);
      await batch.commit();

      try {
        await rag.deleteDocument(id);
      } catch (e) {
        console.warn('[ADMIN DOCS] Neon delete skip:', e.message);
      }

      return json(res, 200, { success: true, deletedChunks: chunks.size });
    }

    return json(res, 405, { success: false, error: 'Méthode non autorisée' });
  } catch (e) {
    console.error(e);
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
