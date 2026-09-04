'use strict';

/**
 * HosBac Quiz V12 — Moteur RAG Neon (pgvector)
 * Ingestion + retrieval strict par métadonnées (classe, matière, SA).
 */

const { query } = require('./db');
const { embedText, toPgVector } = require('./embeddings');

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Canonical metadata (import + search MUST use the same values).
 * Classe : 6e|5e|4e|3e|2nd|1ere|terminale
 * Matière : histoire-geo|mathematiques|svt|pct|anglais
 */
function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeClasse(c) {
  let s = stripAccents(String(c || '').trim().toLowerCase())
    .replace(/\s+/g, '')
    .replace(/eme$/i, 'e')
    .replace(/ème$/i, 'e');
  if (!s) return '';
  s = s.replace(/[^a-z0-9]/g, ''); // 1-ere, 1_ere → 1ere
  const map = {
    '6e': '6e', '6': '6e',
    '5e': '5e', '5': '5e',
    '4e': '4e', '4': '4e',
    '3e': '3e', '3': '3e',
    '2nd': '2nd', '2nde': '2nd', 'seconde': '2nd',
    '1ere': '1ere', '1re': '1ere', 'premiere': '1ere',
    'terminale': 'terminale', 'tle': 'terminale', 'term': 'terminale'
  };
  return map[s] || s;
}

function normalizeMatiere(m) {
  let s = stripAccents(String(m || '').trim().toLowerCase())
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  if (!s) return '';
  if (s.includes('hist') || s.includes('geo') || s === 'hg' || s.includes('histoire')) {
    return 'histoire-geo';
  }
  if (s.includes('math')) return 'mathematiques';
  if (s.includes('svt') || s.includes('vie') || s.includes('terre')) return 'svt';
  if (s.includes('pct') || s.includes('phys') || s.includes('chim')) return 'pct';
  if (s.includes('angl') || s.includes('english')) return 'anglais';
  return s;
}


/**
 * Normalisation centrale — OBLIGATOIRE à l'insertion ET à la recherche.
 * - minuscules, sans accents, espaces/tirets normalisés
 * - classes : 1ère/1ere/Premiere → 1ere
 * - matières : Histoire Géographie / HG → histoire-geo
 */
function normalizeMetadata(meta = {}) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const classe = normalizeClasse(m.classe || m.class || m.niveau || '');
  const matiere = normalizeMatiere(m.matiere || m.subject || m.discipline || '');
  let serie = stripAccents(String(m.serie || '').trim().toLowerCase()).replace(/\s+/g, '');
  if (serie) serie = serie.replace(/^serie/, '');
  let sa = String(m.sa || m.sa_title || m.chapitre || '').trim().toUpperCase();
  const saMatch = sa.match(/(?:SA|CHAPITRE|UNITE|UNITÉ|LECON|LEÇON)\s*([1-8])/i) || sa.match(/\b([1-8])\b/);
  if (/^SA[1-8]$/i.test(sa)) {
    /* keep */
  } else if (saMatch) {
    sa = 'SA' + saMatch[1];
  } else {
    sa = sa.replace(/\s+/g, ' ').slice(0, 80);
  }
  return {
    classe,
    matiere,
    serie: serie || '',
    sa: sa || '',
    sa_title: String(m.sa_title || m.title || m.chapitre || '').trim(),
    title: String(m.title || m.name || m.sa_title || '').trim()
  };
}


/** Toutes les formes possibles stockées historiquement pour une classe */
function classeVariants(c) {
  const n = normalizeClasse(c);
  if (!n) return [];
  const variants = new Set([n, String(c || '').trim()]);
  if (/^[3-6]e$/.test(n)) {
    const digit = n.charAt(0);
    variants.add(digit + 'ème');
    variants.add(digit + 'eme');
    variants.add(digit + 'e');
    variants.add(digit);
    variants.add(digit + 'Éme');
  }
  if (n === '2nd') { variants.add('2nde'); variants.add('Seconde'); variants.add('2nd'); variants.add('2nde'); }
  if (n === '1ere') { variants.add('1ère'); variants.add('1re'); variants.add('Première'); variants.add('1ere'); }
  if (n === 'terminale') { variants.add('Terminale'); variants.add('TLE'); variants.add('Term'); }
  return [...variants].filter(Boolean);
}

function matiereVariants(m) {
  const n = normalizeMatiere(m);
  if (!n) return [];
  const variants = new Set([n]);
  if (n === 'histoire-geo') {
    ['Histoire-Géographie','Histoire-Geographie','Histoire Géographie','histoire-géographie',
     'HISTOIRE-GÉOGRAPHIE','Histoire Géo','HG','histoire geo'].forEach(x => variants.add(x));
  }
  if (n === 'mathematiques') {
    ['Mathématiques','Mathematiques','MATHS','Maths','maths'].forEach(x => variants.add(x));
  }
  if (n === 'svt') ['SVT','Svt'].forEach(x => variants.add(x));
  if (n === 'pct') ['PCT','Pct','Physique-Chimie'].forEach(x => variants.add(x));
  if (n === 'anglais') ['Anglais','ANGLAIS','English'].forEach(x => variants.add(x));
  return [...variants];
}

/**
 * Découpage intelligent :
 * 1) Par sections ## SA n / SA1 / **SA1** si présentes
 * 2) Sinon blocs 800–1200 car. avec overlap 150
 */
function splitBySA(text) {
  const clean = String(text || '').replace(/\r/g, '\n');
  // SA classiques + Chapitre / Unité / Leçon / Situation d'apprentissage
  const re = /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\*\*)?(?:SA\s*([1-8])|Situation\s+d['']apprentissage\s*([1-8])|Chapitre\s*([1-8])|Unit[eé]\s*([1-8])|Le[cç]on\s*([1-8]))(?:\s*[:.\-–—)]|\s*\*\*|\s+|$)/gim;
  const marks = [];
  let m;
  while ((m = re.exec(clean)) !== null) {
    const num = m[1] || m[2] || m[3] || m[4] || m[5];
    if (num) marks.push({ sa: 'SA' + num, index: m.index, full: m[0] });
  }
  if (marks.length >= 1) {
    const sections = [];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index;
      const end = i + 1 < marks.length ? marks[i + 1].index : clean.length;
      const body = clean.slice(start, end).trim();
      if (body.length > 40) sections.push({ sa: marks[i].sa, text: body });
    }
    if (sections.length) return sections;
  }
  // Fallback : découpage par blocs ~1000 caractères (paragraphes)
  const t = clean.trim();
  if (!t || t.length < 40) return null;
  const chunks = [];
  let buf = '';
  let saIdx = 1;
  const paras = t.split(/\n{2,}/);
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > 1000 && buf.length > 80) {
      chunks.push({ sa: 'SA' + Math.min(saIdx, 8), text: buf.trim() });
      saIdx++;
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf.trim().length > 40) chunks.push({ sa: 'SA' + Math.min(saIdx, 8), text: buf.trim() });
  return chunks.length ? chunks : null;
}


function chunkBySize(text, size = 1000, overlap = 150) {
  const clean = cleanText(text);
  if (!clean) return [];
  const out = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    // coupe sur une frontière de phrase si possible
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const lastDot = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
      if (lastDot > size * 0.5) end = i + lastDot + 1;
    }
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out.filter(Boolean);
}

/**
 * Retourne des chunks { text, sa? } pour indexation.
 */
function buildChunks(text, defaultSa) {
  const bySa = splitBySA(text);
  if (bySa && bySa.length) {
    const out = [];
    for (const sec of bySa) {
      const parts = chunkBySize(sec.text, 1000, 150);
      for (const p of parts) out.push({ text: p, sa: sec.sa });
    }
    return out;
  }
  return chunkBySize(text, 1000, 150).map((t) => ({
    text: t,
    sa: defaultSa || null
  }));
}

async function indexDocument({
  docId,
  text,
  classe,
  serie,
  matiere,
  saTitle,
  sequences,
  title,
  sa // code SA explicite SA1..SA8
}) {
  const classeN = normalizeClasse(classe);
  const matiereN = normalizeMatiere(matiere);
  const defaultSa = sa || (saTitle && String(saTitle).match(/SA\s*[1-8]/i)
    ? String(saTitle).match(/SA\s*[1-8]/i)[0].replace(/\s+/g, '').toUpperCase()
    : null);

  const parts = buildChunks(text, defaultSa);

  if (!parts.length) {
    await query(
      `INSERT INTO documents (id, title, classe, serie, matiere, sa_title, sequences, chunk_count, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT chunk_count FROM documents WHERE id=$1), 0), true, NOW())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         classe = EXCLUDED.classe,
         serie = EXCLUDED.serie,
         matiere = EXCLUDED.matiere,
         sa_title = EXCLUDED.sa_title,
         sequences = EXCLUDED.sequences,
         updated_at = NOW()`,
      [
        String(docId),
        title || saTitle || 'Document',
        classeN || null,
        serie || null,
        matiereN || null,
        saTitle || null,
        Array.isArray(sequences) ? sequences : []
      ]
    );
    return { chunkCount: 0, metadataOnly: true };
  }

  await query(`DELETE FROM document_sections WHERE metadata->>'docId' = $1`, [String(docId)]);

  let inserted = 0;
  for (let i = 0; i < parts.length; i++) {
    const content = parts[i].text;
    const chunkSa = parts[i].sa || defaultSa || '';
    const embedding = await embedText(content);
    const metadata = {
      docId: String(docId),
      classe: classeN || '',
      serie: serie || '',
      matiere: matiereN || '',
      sa: chunkSa,
      sa_title: saTitle || title || '',
      sequences: Array.isArray(sequences) ? sequences : [],
      title: title || '',
      index: i
    };

    if (embedding) {
      const vec = toPgVector(embedding);
      const res = await query(
        `INSERT INTO document_sections (content, metadata, embedding)
         VALUES ($1, $2::jsonb, $3::vector)`,
        [content, JSON.stringify(metadata), vec]
      );
      if (res) inserted++;
    } else {
      const res = await query(
        `INSERT INTO document_sections (content, metadata)
         VALUES ($1, $2::jsonb)`,
        [content, JSON.stringify(metadata)]
      );
      if (res) inserted++;
    }
  }

  await query(
    `INSERT INTO documents (id, title, classe, serie, matiere, sa_title, sequences, chunk_count, active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       classe = EXCLUDED.classe,
       serie = EXCLUDED.serie,
       matiere = EXCLUDED.matiere,
       sa_title = EXCLUDED.sa_title,
       sequences = EXCLUDED.sequences,
       chunk_count = EXCLUDED.chunk_count,
       updated_at = NOW()`,
    [
      String(docId),
      title || saTitle || 'Document',
      classeN || null,
      serie || null,
      matiereN || null,
      saTitle || null,
      Array.isArray(sequences) ? sequences : [],
      inserted
    ]
  );

  return { chunkCount: inserted };
}

/**
 * Recherche STRICTE par métadonnées + similarité vectorielle optionnelle.
 * Priorité : filtre classe + matière + SA, puis ranking cosine si embedding dispo.
 */
async function searchRAGContext(promptText, filters = {}, limit = 10) {
  try {
    const limitN = Math.max(1, Math.min(20, Number(limit) || 10));
    const classe = normalizeClasse(filters.classe || '');
    const matiere = normalizeMatiere(filters.matiere || '');
    const strictProfile = filters.strictProfile === true;
    let sa = String(filters.sa || filters.sa_title || filters.chapitre || '').trim().toUpperCase();
    const saMatch = sa.match(/SA\s*([1-8])/i);
    if (saMatch) sa = 'SA' + saMatch[1];
    else if (!/^SA[1-8]$/i.test(sa)) sa = '';

    // Un quiz doit toujours être borné par le couple classe + matière.
    // Les métadonnées sont normalisées à l'insertion : égalité stricte, jamais ILIKE.
    if (strictProfile && (!classe || !matiere)) {
      console.warn('[RAG] strictProfile refusé: classe/matière manquante', { classe, matiere });
      return [];
    }

    const conditions = [];
    const params = [];
    let idx = 1;

    if (strictProfile) {
      conditions.push(`metadata->>'classe' = $${idx}`);
      params.push(classe);
      idx++;
      conditions.push(`metadata->>'matiere' = $${idx}`);
      params.push(matiere);
      idx++;
    } else {
      if (classe) {
        conditions.push(`metadata->>'classe' = $${idx}`);
        params.push(classe);
        idx++;
      }
      if (matiere) {
        conditions.push(`metadata->>'matiere' = $${idx}`);
        params.push(matiere);
        idx++;
      }
    }

    if (sa) {
      conditions.push(`(
        UPPER(REPLACE(COALESCE(metadata->>'sa',''), ' ', '')) = $${idx}
        OR metadata->>'sa_title' ILIKE $${idx + 1}
        OR metadata->>'title' ILIKE $${idx + 1}
        OR content ILIKE $${idx + 1}
      )`);
      params.push(sa.replace(/\s+/g, ''), '%' + sa + '%');
      idx += 2;
    }

    if (!conditions.length) {
      return strictProfile ? [] : searchVectorOnly(promptText, limitN);
    }

    const where = conditions.join(' AND ');

    const sqlFilter = `
      SELECT content, metadata, embedding
      FROM document_sections
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    const filtered = await query(sqlFilter, params);
    if (!filtered?.rows?.length) {
      console.warn('[RAG] 0 hits with filters', { classe, matiere, sa, strictProfile });
      // En mode quiz strict, ZÉRO fallback hors couple classe/matière.
      return [];
    }

    const poolSize = Math.max(limitN * 4, 20);
    const embedding = await embedText(promptText || matiere + ' ' + classe + ' ' + sa);
    let pool = [];
    if (embedding) {
      const vec = toPgVector(embedding);
      const sqlRank = `
        SELECT content, metadata,
               1 - (embedding <=> $1::vector) AS score
        FROM document_sections
        WHERE ${where} AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $${idx}
      `;
      const ranked = await query(sqlRank, [vec, ...params, poolSize]);
      if (ranked?.rows?.length) {
        pool = ranked.rows.map((r) => ({
          content: r.content,
          metadata: r.metadata || {},
          score: Number(r.score) || 0
        }));
      }
    }
    if (!pool.length) {
      pool = filtered.rows.map((r) => ({
        content: r.content,
        metadata: r.metadata || {},
        score: 0
      }));
    }
    return sampleHits(pool, limitN);
  } catch (e) {
    console.warn('[RAG] retrieval failed:', e?.message);
    // Le fallback textuel reste strict lorsqu'il est demandé depuis un quiz.
    try {
      return await searchTextFallback(promptText, filters, limit);
    } catch (e2) {
      console.warn('[RAG] text fallback failed:', e2?.message);
      return [];
    }
  }
}

/** Recherche textuelle simple (sans vector) — ne bloque jamais le quiz */
async function searchTextFallback(promptText, filters = {}, limit = 10) {
  const limitN = Math.max(1, Math.min(20, Number(limit) || 10));
  const classe = normalizeClasse(filters.classe || '');
  const matiere = normalizeMatiere(filters.matiere || '');
  const strictProfile = filters.strictProfile === true;
  if (strictProfile && (!classe || !matiere)) return [];

  let sa = String(filters.sa || filters.sa_title || filters.chapitre || '').trim().toUpperCase();
  const saMatch = sa.match(/SA\s*([1-8])/i);
  if (saMatch) sa = 'SA' + saMatch[1];
  else if (!/^SA[1-8]$/i.test(sa)) sa = '';

  const conditions = [];
  const params = [];
  let idx = 1;
  if (classe) {
    conditions.push(`metadata->>'classe' = $${idx}`);
    params.push(classe);
    idx++;
  }
  if (matiere) {
    conditions.push(`metadata->>'matiere' = $${idx}`);
    params.push(matiere);
    idx++;
  }
  if (strictProfile && (!classe || !matiere)) return [];
  if (!conditions.length) return [];
  if (sa) {
    conditions.push(`(metadata->>'sa' ILIKE $${idx} OR metadata->>'sa_title' ILIKE $${idx} OR content ILIKE $${idx})`);
    params.push('%' + sa + '%');
    idx++;
  }
  // En mode strict, le contenu recherché ne peut jamais élargir les métadonnées.
  const q = String(promptText || '').trim().slice(0, 80);
  if (q && !strictProfile) {
    conditions.push(`content ILIKE $${idx}`);
    params.push('%' + q.replace(/[%_]/g, '') + '%');
    idx++;
  }
  params.push(limitN);
  const res = await query(
    `SELECT content, metadata FROM document_sections WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${idx}`,
    params
  );
  if (!res?.rows) return [];
  return res.rows.map((r) => ({ content: r.content, metadata: r.metadata || {}, score: 0.5 }));
}

/** Mélange + tirage de k éléments (variation des chunks RAG) */
function sampleHits(pool, k) {
  if (!Array.isArray(pool) || !pool.length) return [];
  const want = Math.max(1, Math.min(Number(k) || 5, pool.length));
  // Top-K élargi (15–20) puis tirage aléatoire pour varier les thèmes
  const sorted = pool.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const topN = Math.min(Math.max(20, want * 3), sorted.length);
  const candidates = sorted.slice(0, topN);
  // Fisher-Yates sur les candidats
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const chosen = [];
  const ids = new Set();
  for (const h of candidates) {
    if (chosen.length >= want) break;
    const key = String(h.content || '').slice(0, 120);
    if (ids.has(key)) continue;
    chosen.push(h);
    ids.add(key);
  }
  // Compléter si besoin depuis le reste du pool
  if (chosen.length < want) {
    const rest = pool.slice().sort(() => Math.random() - 0.5);
    for (const h of rest) {
      if (chosen.length >= want) break;
      const key = String(h.content || '').slice(0, 120);
      if (ids.has(key)) continue;
      chosen.push(h);
      ids.add(key);
    }
  }
  return chosen.slice(0, want);
}

async function searchVectorOnly(promptText, limitN) {
  let embedding = null;
  try {
    embedding = await embedText(promptText);
  } catch (e) {
    console.warn('[WARN] RAG Embedding indisponible, bascule sur la recherche textuelle SQL basique:', e && e.message);
    return [];
  }
  if (!embedding) return [];
  const vec = toPgVector(embedding);
  const res = await query(
    `SELECT content, metadata, 1 - (embedding <=> $1::vector) AS score
     FROM document_sections
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vec, limitN]
  );
  if (!res || !res.rows) return [];
  const mapped = res.rows.map((r) => ({
    content: r.content,
    metadata: r.metadata || {},
    score: Number(r.score) || 0
  }));
  return sampleHits(mapped, limitN);
}

/**
 * Construit le contexte texte pour le prompt (concat chunks).
 */
function buildContextString(hits, maxChars = 12000) {
  if (!Array.isArray(hits) || !hits.length) return '';
  let out = '';
  for (const h of hits) {
    const block = String(h.content || '').trim();
    if (!block) continue;
    if (out.length + block.length + 4 > maxChars) break;
    out += (out ? '\n\n---\n\n' : '') + block;
  }
  return out;
}

async function deleteDocument(docId) {
  await query(`DELETE FROM document_sections WHERE metadata->>'docId' = $1`, [String(docId)]);
  await query(`DELETE FROM document_images WHERE document_id = $1`, [String(docId)]);
  await query(`DELETE FROM documents WHERE id = $1`, [String(docId)]);
  return true;
}

async function saveQuizResult({ userId, score, total, subject, classe, serie, sessionId }) {
  await query(
    `INSERT INTO quiz_results (user_id, score, total, subject, classe, serie, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      String(userId || ''),
      Number(score) || 0,
      Number(total) || 0,
      subject || null,
      classe || null,
      serie || null,
      sessionId || null
    ]
  );
}

/**
 * Ingestion directe (script migration / admin texte) sans doc Firestore.
 */
async function ingestRawText({
  text,
  classe,
  matiere,
  sa,
  saTitle,
  serie,
  docId
}) {
  const id = docId || ('raw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  return indexDocument({
    docId: id,
    text,
    classe,
    matiere,
    sa,
    saTitle: saTitle || sa || '',
    serie: serie || '',
    title: saTitle || sa || 'Cours',
    sequences: []
  });
}

module.exports = {
  normalizeMetadata,
  normalizeClasse,
  normalizeMatiere,
  indexDocument,
  searchRAGContext,
  buildContextString,
  deleteDocument,
  saveQuizResult,
  ingestRawText,
  buildChunks,
  splitBySA,
  chunkBySize: chunkBySize,
  cleanText,
  normalizeClasse,
  normalizeMatiere,
  classeVariants,
  matiereVariants,
  stripAccents,
  sampleHits
};
