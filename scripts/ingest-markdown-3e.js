#!/usr/bin/env node
'use strict';

/**
 * Migration immédiate : charge un Markdown de cours (ex. 3ème Histoire-Géo)
 * dans Neon document_sections avec embeddings Gemini.
 *
 * Usage :
 *   GEMINI_API_KEY=... DATABASE_URL=... node scripts/ingest-markdown-3e.js [chemin.md]
 *
 * Variables d'environnement obligatoires :
 *   DATABASE_URL, GEMINI_API_KEY
 *
 * Optionnelles :
 *   CLASSE=3ème  MATIERE=Histoire-Géographie
 */

const fs = require('fs');
const path = require('path');

// Charger .env.local / .env si présents (sans dépendance dotenv)
function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch (_) {}
}

loadEnvFile(path.join(process.cwd(), '.env.local'));
loadEnvFile(path.join(process.cwd(), '.env'));

const rag = require('../server/lib/rag');
const { isAvailable, query } = require('../server/lib/db');

async function main() {
  const fileArg = process.argv[2] || 'cours-hist-geo-3e-notions.md';
  const filePath = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL manquante');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY_2) {
    console.error('GEMINI_API_KEY manquante');
    process.exit(1);
  }

  const ok = await isAvailable();
  if (!ok) {
    console.error('Neon inaccessible — vérifie DATABASE_URL');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error('Fichier introuvable:', filePath);
    console.error('Crée un Markdown avec des titres du type "## SA1 — Titre" puis relance.');
    process.exit(1);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const classe = process.env.CLASSE || '3ème';
  const matiere = process.env.MATIERE || 'Histoire-Géographie';

  console.log('Fichier:', filePath);
  console.log('Classe:', classe, '| Matière:', matiere);
  console.log('Taille texte:', text.length, 'caractères');

  // Découpe par SA si possible
  const sections = rag.splitBySA(text);
  if (sections && sections.length) {
    console.log('Sections SA détectées:', sections.map((s) => s.sa).join(', '));
    let total = 0;
    for (const sec of sections) {
      const titleMatch = sec.text.match(/SA\s*[1-8]\s*[:.\-–—)]\s*([^\n]+)/i);
      const saTitle = titleMatch ? titleMatch[1].trim() : sec.sa;
      const docId = `md_${classe}_${matiere}_${sec.sa}`.replace(/[^a-zA-Z0-9_]/g, '_');
      console.log('→ Indexation', sec.sa, '…');
      const result = await rag.indexDocument({
        docId,
        text: sec.text,
        classe,
        matiere,
        sa: sec.sa,
        saTitle,
        title: `${sec.sa} — ${saTitle}`,
        serie: '',
        sequences: []
      });
      console.log('   chunks:', result.chunkCount);
      total += result.chunkCount || 0;
    }
    console.log('Total chunks insérés:', total);
  } else {
    console.log('Aucune balise SA détectée — indexation en un seul document découpé.');
    const result = await rag.ingestRawText({
      text,
      classe,
      matiere,
      sa: '',
      saTitle: path.basename(filePath),
      docId: `md_${Date.now()}`
    });
    console.log('chunks:', result.chunkCount);
  }

  const count = await query('SELECT COUNT(*)::int AS n FROM document_sections');
  console.log('Lignes document_sections maintenant:', count?.rows?.[0]?.n ?? '?');
  console.log('OK — migration terminée.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
