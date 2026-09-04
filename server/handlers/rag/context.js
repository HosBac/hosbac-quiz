'use strict';

const { getAdmin, json, requireAdmin } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const rag = require('../../lib/rag');

function chunks(text, size = 7000) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    await requireAdmin(req);
    const db = getAdmin().firestore();

    if (req.method !== 'POST') {
      return json(res, 405, { success: false, error: 'Utilisez POST' });
    }

    const b = req.body || {};
    const snap = await db.collection('quiz_documents').doc(String(b.docId || '')).get();
    if (!snap.exists) {
      return json(res, 404, { success: false, error: 'Document introuvable' });
    }

    const doc = snap.data();
    if (doc.active === false) {
      return json(res, 403, { success: false, error: 'Document inactif' });
    }

    let clean = cleanText(b.text);
    if (!clean) {
      if (!doc.url) {
        return json(res, 400, { success: false, error: 'URL Cloudinary absente' });
      }
      const r = await fetch(doc.url);
      if (!r.ok) {
        return json(res, 502, { success: false, error: 'PDF Cloudinary inaccessible' });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const data = await pdfParse(buf);
      clean = cleanText(data.text);
    }

    if (!clean) {
      return json(res, 422, {
        success: false,
        code: 'OCR_REQUIRED',
        error: 'Aucun texte extractible. Utilisez l’OCR automatique pour ce PDF numérisé.'
      });
    }

    // Firestore (compatibilité)
    const old = await db.collection('quiz_rag_chunks').where('docId', '==', snap.id).get();
    if (!old.empty) {
      const del = db.batch();
      old.docs.forEach((x) => del.delete(x.ref));
      await del.commit();
    }

    const detectedFromText = Array.from(
      new Set((clean.match(/\bSA[1-8]\b/gi) || []).map((x) => x.toUpperCase()))
    );
    if (detectedFromText.length) {
      const merged = Array.from(
        new Set([...(Array.isArray(doc.chapitres) ? doc.chapitres : []), ...detectedFromText])
      );
      await snap.ref.set(
        { chapitres: merged, sa: merged, chapitre: doc.chapitre || merged.join(' · ') },
        { merge: true }
      );
      doc.chapitres = merged;
    }

    const cs = chunks(clean);
    const batch = db.batch();
    for (let i = 0; i < cs.length; i++) {
      const id = crypto.createHash('sha1').update(`${snap.id}:${i}:${cs[i]}`).digest('hex');
      batch.set(
        db.collection('quiz_rag_chunks').doc(id),
        {
          docId: snap.id,
          classe: doc.classe,
          serie: doc.serie,
          matiere: doc.matiere,
          chapitre: doc.chapitre,
          chapitres: Array.isArray(doc.chapitres) ? doc.chapitres : [],
          sa_title: doc.sa_title || doc.title || '',
          sequences: Array.isArray(doc.sequences) ? doc.sequences : [],
          index: i,
          text: cs[i],
          createdAt: getAdmin().firestore.Timestamp.now()
        },
        { merge: true }
      );
    }
    await batch.commit();

    await snap.ref.set(
      {
        chunkCount: cs.length,
        textLength: clean.length,
        indexedAt: getAdmin().firestore.Timestamp.now(),
        ocrIndexed: Boolean(b.text)
      },
      { merge: true }
    );

    // Neon vectoriel
    let neonChunks = 0;
    try {
      const saCode = (Array.isArray(doc.chapitres) && doc.chapitres[0])
        || (Array.isArray(doc.sa) && doc.sa[0])
        || (String(doc.sa_title || doc.chapitre || '').match(/SA\s*[1-8]/i) || [])[0]
        || '';
      const result = await rag.indexDocument({
        docId: snap.id,
        text: clean,
        classe: doc.classe,
        serie: doc.serie,
        matiere: doc.matiere,
        saTitle: doc.sa_title || doc.title || '',
        sequences: Array.isArray(doc.sequences) ? doc.sequences : [],
        title: doc.title || doc.name || 'Document',
        sa: String(saCode || '').replace(/\s+/g, '').toUpperCase()
      });
      neonChunks = result?.chunkCount || 0;
    } catch (e) {
      console.warn('[RAG CONTEXT] Neon index skip:', e.message);
    }

    return json(res, 200, {
      success: true,
      docId: snap.id,
      chunkCount: cs.length,
      neonChunks,
      textLength: clean.length,
      ocrIndexed: Boolean(b.text)
    });
  } catch (e) {
    console.error('[RAG CONTEXT]', e);
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
