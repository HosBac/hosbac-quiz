'use strict';

/**
 * Embeddings Gemini text-embedding-004 (768 dims).
 * Utilise l'API v1beta et retourne null en cas d'echec afin de
 * permettre au RAG de basculer vers la recherche textuelle SQL.
 */

async function embedText(text) {
  const apiKey = String(
    process.env.GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY_1 ||
    process.env.GEMINI_API_KEY_2 ||
    ''
  ).trim();
  if (!apiKey) {
    console.warn('[EMBED] GEMINI_API_KEY manquante — RAG vectoriel désactivé');
    return null;
  }

  const input = String(text || '').trim().slice(0, 8000);
  if (!input) return null;

  const model = String(process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004').trim();

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: input }] }
      })
    });

    if (!response.ok) {
      const t = await response.text().catch(() => '');
      console.warn('[EMBED] HTTP', response.status, t.slice(0, 300));
      console.warn('[WARN] RAG Embedding indisponible, bascule sur la recherche textuelle SQL basique');
      return null;
    }

    const data = await response.json();
    const values = data?.embedding?.values || data?.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length < 100) {
      console.warn('[EMBED] Vecteur invalide');
      return null;
    }

    return values;
  } catch (e) {
    console.warn('[EMBED]', e?.message || 'Erreur inconnue');
    console.warn('[WARN] RAG Embedding indisponible, bascule sur la recherche textuelle SQL basique');
    return null;
  }
}

function toPgVector(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return '[' + arr.map((n) => (Number.isFinite(n) ? n : 0)).join(',') + ']';
}

module.exports = {
  embedText,
  toPgVector
};
