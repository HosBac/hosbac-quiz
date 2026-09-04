'use strict';

const { json, requireAdmin } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const rag = require('../../lib/rag');
const { query, isAvailable } = require('../../lib/db');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    await requireAdmin(req);
    if (req.method !== 'POST' && req.method !== 'GET') {
      return json(res, 405, { success: false, error: 'GET ou POST' });
    }

    const body = req.body || {};
    const neonOk = await isAvailable();

    let sectionCount = 0;
    let docCount = 0;
    let storedMeta = [];
    if (neonOk) {
      const a = await query('SELECT COUNT(*)::int AS n FROM document_sections');
      const b = await query('SELECT COUNT(*)::int AS n FROM documents');
      sectionCount = a?.rows?.[0]?.n || 0;
      docCount = b?.rows?.[0]?.n || 0;
      const meta = await query(`
        SELECT DISTINCT metadata->>'classe' AS classe, metadata->>'matiere' AS matiere, metadata->>'sa' AS sa
        FROM document_sections
        LIMIT 30
      `);
      storedMeta = meta?.rows || [];
    }

    const filters = {
      classe: body.classe || '',
      serie: body.serie || '',
      matiere: body.matiere || '',
      sa: body.sa || body.sa_title || ''
    };
    const prompt = String(body.prompt || body.q || 'contenu pédagogique du document').trim();

    let hits = [];
    if (neonOk) {
      hits = await rag.searchRAGContext(prompt, filters, 5);
    }

    return json(res, 200, {
      success: true,
      neonAvailable: neonOk,
      tables: {
        document_sections: sectionCount,
        documents: docCount
      },
      filters,
      prompt,
      hitsCount: hits.length,
      hits: hits.map((h) => ({
        score: h.score,
        preview: String(h.content || '').slice(0, 280),
        metadata: h.metadata || {}
      })),
      filtersNormalized: {
        classe: require('../../lib/rag').normalizeClasse(body.classe || ''),
        matiere: require('../../lib/rag').normalizeMatiere(body.matiere || '')
      },
      storedMeta,
      diagnosis:
        !neonOk
          ? 'Neon inaccessible (DATABASE_URL ou réseau). Vérifie la variable Vercel.'
          : sectionCount === 0
            ? 'Tables Neon vides : aucun chunk indexé. Réimporte un document (PDF ou texte) et attends la fin de l’indexation.'
            : hits.length === 0
              ? 'Des chunks existent mais aucun ne correspond aux filtres. Voir storedMeta (valeurs en base) vs filtersNormalized (recherche). Réimporte les docs pour normaliser, ou aligne classe/matière.'
              : 'RAG opérationnel : des extraits ont été trouvés pour cette requête.'
    });
  } catch (e) {
    console.error('[RAG TEST]', e);
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
