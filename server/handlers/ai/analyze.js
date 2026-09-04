'use strict';

/**
 * HosBac — AI Analyze (OCR / oral / correction)
 * - Streaming SSE (évite timeout Vercel 60s)
 * - Payload tronqué
 * - Markdown uniquement (pas de HTML brut)
 */

const { requireAuth, json } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const { normalizeMathMarkup } = require('../../lib/math-format');
const { generateTextWithFallback } = require('../../lib/ai-fallback');

const MAX_INPUT = {
  oral: 8000,
  ocr: 30000,
  default: 12000
};
const MAX_TOKENS = {
  oral: 1200,
  ocr: 6000,
  default: 1500
};

function clean(v) {
  return String(v ?? '').trim();
}


function isMathSubject(subject) {
  const s=clean(subject).toUpperCase();
  return ['MATHS','MATHÉMATIQUES','MATHEMATIQUES','PCT','PHYSIQUE-CHIMIE','PHYSIQUE CHIMIE','PHYSIQUE-CHIMIE (PCT)'].includes(s);
}
function stripMathForLiteralSubject(text) {
  return clean(text)
    .replace(/\\\[([\s\S]*?)\\\]/g,'$1')
    .replace(/\\\(([\s\S]*?)\\\)/g,'$1')
    .replace(/\$\$([\s\S]*?)\$\$/g,'$1')
    .replace(/\$([^$\n]+)\$/g,'$1')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g,'($1)/($2)')
    .replace(/\\sqrt\{([^{}]+)\}/g,'racine de ($1)')
    .replace(/\\(?:text|mathrm)\{([^{}]*)\}/g,'$1')
    .replace(/\\[A-Za-z]+/g,'')
    .replace(/[{}]/g,'')
    .replace(/\s{2,}/g,' ').trim();
}

/**
 * Sécurité KaTeX/MathJax : le modèle peut encore produire des macros avancées
 * malgré le prompt. On neutralise uniquement les constructions connues pour
 * casser le rendu et on conserve le contenu lisible.
 */
function sanitizeMathResponse(text, isMathSubject = true) {
  if (!text) return "";
  let s = String(text);

  if (!isMathSubject) {
    return s
      .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
      .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
      .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
      .replace(/\$([^$\n]+)\$/g, "$1")
      .replace(/\$/g, "");
  }

  // \underbrace{contenu}_{annotation} -> (contenu : annotation)
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\\underbrace\{([^{}]*)\}_\{([^{}]*)\}/g, "($1 : $2)")
      .replace(/\\overbrace\{([^{}]*)\}\^\{([^{}]*)\}/g, "($1 : $2)")
      .replace(/\\underbrace\{([^{}]*)\}/g, "($1)")
      .replace(/\\overbrace\{([^{}]*)\}/g, "($1)");
  }

  // Espacements TeX non nécessaires au rendu.
  s = s
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\:/g, " ")
    .replace(/\\!/g, "")
    .replace(/\\quad\b/g, " ")
    .replace(/\\qquad\b/g, " ");

  // \text{...}/\mathrm{...} : conserver le contenu lisible plutôt que la macro.
  s = s
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\\mathrm\{([^{}]*)\}/g, "$1");

  // Les tableaux/arrays ne doivent jamais atteindre le moteur mathématique.
  s = s
    .replace(/\\begin\{(?:array|aligned|cases|matrix|pmatrix|bmatrix)\}/g, "")
    .replace(/\\end\{(?:array|aligned|cases|matrix|pmatrix|bmatrix)\}/g, "")
    .replace(/\\\\/g, "\\");

  // Commandes de décoration fréquentes mais inutiles pour le résultat pédagogique.
  s = s.replace(/\\(?:left|right)\b/g, "");

  return s.trim();
}

function truncateInput(text, mode) {
  const limit = MAX_INPUT[mode] || MAX_INPUT.default;
  const s = clean(text);
  if (s.length <= limit) return s;
  // Garder début + fin (énoncé + fin d'exercice souvent utiles)
  const head = Math.floor(limit * 0.7);
  const tail = limit - head - 40;
  return s.slice(0, head) + '\n\n[…texte tronqué pour performance…]\n\n' + s.slice(-tail);
}

function parsePayload(text) {
  let t = clean(text)
    .replace(/^```(?:json|markdown|text)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch (_) {}
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (_) {}
  }
  return { analysis: t };
}

function normalizeMathText(text, subject) {
  return normalizeMathMarkup(text, subject);
}

const SYSTEM_BASE =
  'Tu es l\'I.A. d\'assistance scolaire de HosBac. Ton rôle est d\'analyser des documents et épreuves académiques de collège/lycée et de fournir une aide pédagogique complète. ' +
  'FORMAT OBLIGATOIRE : Markdown pur (**gras**, *italique*, listes avec -). AUCUNE balise HTML. ' +
  'Pour une demande OCR, lis l\'image transcrite dans son orientation correcte, reconstruis l\'énoncé de manière claire et complète et ne résume jamais les exercices. ' +
  'Résous CHAQUE problème et CHAQUE question présente, une par une, avec les étapes de calcul et les explications pédagogiques. ' +
  'STRUCTURE OCR OBLIGATOIRE : 1. Énoncé Reconstruit ; 2. Corrigé Détaillé ; 3. Astuces et Pièges à éviter. ' +
  'Épreuves béninoises autorisées sans exception de forme : BEPC, BAC, CEP, devoirs de classe, DEC-MESTFP, Communication Écrite, Expression Écrite, Lecture, Histoire-Géo, SVT, PCT, Mathématiques, Philosophie, Français et autres disciplines scolaires. ' +
  'RÈGLES MATHÉMATIQUES : Mathématiques et PCT/Physique-Chimie uniquement : LaTeX simple standard avec $...$ en ligne et $$...$$ en bloc, fractions avec \\frac{a}{b}. Chaque équation ou calcul important doit être placé seul sur sa ligne en $$...$$ afin de garantir un alignement propre. Ne mets jamais une commande LaTeX seule hors délimiteurs. Les unités et explications restent hors formule, par exemple : $$C_A(t)=5500+2000t$$ (en francs). ' +
  'N\'UTILISE JAMAIS \\underbrace, \\overbrace, \\, \\;, \\quad, \\qquad, \\text{...} complexe, \\begin{array}, macros personnalisées ou autres constructions avancées. ' +
  'Pour Français, Communication Écrite, Expression Écrite, Littérature, Histoire-Géo, Philosophie, SVT, Anglais et toute matière autre que Mathématiques/PCT : AUCUNE formule mathématique, aucun signe $, aucune balise LaTeX ; texte Markdown uniquement. ' +
  'Si le contenu est hors collège/lycée ou manifestement non académique, respecte la politique de conformité du message utilisateur. ' +
  'En mode oral : français littéraire uniquement, sans LaTeX ni formules mathématiques. ' +
  'INTERDICTION TOTALE de balises HTML (<strong>, <em>, <br>, <p>, <div>, <span>, etc.).';


/** Filtre heuristique local (paris, factures) avant d'appeler l'IA */
function isClearlyNonAcademic(text) {
  const s = String(text || '').toLowerCase();
  if (!s || s.length < 8) return false;
  const banned = [
    /1xbet/, /betwinner/, /betclic/, /parionssport/, /pmu\b/, /bookmaker/,
    /\b(mise|cotes?)\b.*\b(match|buts?)\b/, /\bpari(s)?\s+sportif/,
    /\bcoupon\b.*\b(pari|bet)\b/, /\bfacture\b.*\b(ttc|ht)\b/,
    /\bnum[eé]ro\s+de\s+transaction\b/, /\brib\b.*\biban\b/
  ];
  return banned.some((re) => re.test(s));
}

function buildPrompt(b, text) {
  const mode = clean(b.mode || 'ocr').toLowerCase();
  const classe = clean(b.classe);
  const serie = clean(b.serie);
  const matiere = clean(b.matiere);
  const independent = b.independent === true || mode === 'oral';

  if (mode === 'oral' || independent) {
    return (
      `RÈGLE DE CONFORMITÉ ACADÉMIQUE ABSOLUE :\n` +
      `Vérifie si le texte dicté est STRICTEMENT scolaire/académique (cours, épreuves, méthodologie).\n` +
      `SI paris sportifs, jeux d'argent, factures, sujets personnels, création web, ou hors collège/lycée :\n` +
      `renvoie UNIQUEMENT le JSON : {"status":"rejected","error_message":"Document non conforme. HosBac est une plateforme exclusivement académique. Seuls les exercices, épreuves et cours scolaires sont autorisés."}\n` +
      `Sinon, si hors-sujet scolaire sans être un document illicite, réponds exactement :\n` +
      `« Je suis une assistance académique HosBac. Je ne peux répondre qu'aux questions liées à vos cours et épreuves scolaires. »\n\n` +
      `Tu es un coach d'oral scolaire HosBac (collège/lycée).\n` +
      `Réponds à toute discipline scolaire (français, histoire-géo, philo, langues, méthodo, etc.).\n` +
      `FORMAT : français littéraire fluide. Markdown pur (**gras**, *italique*). AUCUNE balise HTML.\n` +
      `INTERDICTION LaTeX / formules mathématiques en mode oral.\n` +
      (classe ? `Classe (contexte) : ${classe}.\n` : '') +
      `\nTEXTE DICTÉ PAR L'ÉLÈVE :\n${text}\n\n` +
      `Structure (si conforme) :\n` +
      `1) Évaluation (Bon / À améliorer / Incomplet)\n` +
      `2) Analyse pédagogique claire\n` +
      `3) Conseil pour l'oral\n`
    );
  }

  const common =
    `RÈGLE DE CONFORMITÉ ACADÉMIQUE ABSOLUE :\n` +
    `Avant toute analyse, vérifie que le document est STRICTEMENT académique (exercice, épreuve, cours collège/lycée).\n` +
    `SI paris sportifs, tickets 1xBet/Betwinner, jeux d'argent, factures, contenu personnel ou non scolaire :\n` +
    `renvoie UNIQUEMENT : {"status":"rejected","error_message":"Document non conforme. HosBac est une plateforme exclusivement académique. Seuls les exercices, épreuves et cours scolaires sont autorisés."}\n\n` +
    `Profil élève : classe=${classe || '?'} série=${serie || '-'} matière=${matiere || '?'}.\n` +
    `ACCEPTATION ACADÉMIQUE : accepte sans exception de forme toutes les épreuves et cours scolaires béninois (BEPC, BAC, CEP, devoirs de classe), notamment les en-têtes DEC-MESTFP, Communication Écrite, Expression Écrite, Lecture, Histoire-Géo, SVT, PCT, Mathématiques, Philosophie et Français. Ces mentions sont des indicateurs académiques et ne doivent jamais être rejetées.\n` +    `Si le texte contient un de ces marqueurs académiques, considère-le comme un document scolaire probable et ne le rejette pas pour son intitulé, sa matière, sa langue ou son format ; rejette uniquement s'il contient réellement un contenu interdit/non académique.\n` +
    `FORMAT DE SORTIE — RÈGLE ABSOLUE :\n` +
    `- Markdown pur uniquement (**gras**, *italique*). AUCUNE balise HTML.\n` +
    `- FORMULES : pour Mathématiques et PCT/Physique-Chimie uniquement, LaTeX propre ($...$ ou $$...$$) autorisé. Pour Français, Littérature, Communication Écrite, Expression Écrite, Histoire-Géo, Philosophie, Anglais et toute autre matière non mathématique : AUCUNE formule mathématique ni balise LaTeX ; texte Markdown uniquement.\n` +`- Interdiction HTML (<strong>, <em>). Markdown pur uniquement.\n` +
    `- Pour l'OCR, sois exhaustif : ne résume pas et ne coupe aucune question.\n\n` +
    `TEXTE ÉLÈVE :\n${text}`;

  return (
    common +
    `\n\nMISSION OCR / CORRECTION EXHAUSTIVE :\n` +
    `- Lis et retranscris l'intégralité du sujet dans son orientation correcte. Ne résume jamais et ne supprime aucune question.\n` +
    `- Résous CHAQUE problème et CHAQUE question présente sur le document, une par une, dans l'ordre, avec les étapes de raisonnement/calcul utiles et une réponse finale clairement identifiable.\n` +
    `- Pour plusieurs exercices ou sous-questions (Problème 1, 2, 3, a, b, c...), traite chaque partie sans exception.\n` +
    `- Markdown UNIQUEMENT (**gras**, *italique*, listes). AUCUNE balise HTML.\n` +
    `- INTERDICTION ABSOLUE de renvoyer du JSON, des accolades de code, ou des blocs \`\`\`json / \`\`\`.\n` +
    `- Réponds UNIQUEMENT en texte Markdown structuré ainsi :\n` +
    `## 1. Énoncé Reconstruit\n` +
    `[transcription propre et complète de l'épreuve]\n\n` +
    `## 2. Corrigé Détaillé\n` +
    `[résolution exhaustive, question par question, avec étapes et réponses finales]\n\n` +
    `## 3. Astuces et Pièges à éviter\n` +
    `[conseils méthodologiques ciblés sur l'épreuve]\n`
  );
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function startSse(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

/** Stream OpenAI-compatible (Groq, Mistral, OpenRouter, Gemini OpenAI endpoint) */
async function streamOpenAICompatible(url, key, model, prompt, maxTokens, onToken) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_BASE },
        { role: 'user', content: prompt }
      ],
      temperature: 0.15,
      max_tokens: maxTokens,
      stream: true
    })
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${errText.slice(0, 280)}`);
  }
  if (!r.body) throw new Error('Pas de corps stream');

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta =
          j?.choices?.[0]?.delta?.content ||
          j?.choices?.[0]?.message?.content ||
          '';
        if (delta) {
          full += delta;
          if (onToken) onToken(delta, full);
        }
      } catch (_) {}
    }
  }
  return full;
}

/** Non-stream fallback */
async function openAICompatible(url, key, model, prompt, maxTokens) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_BASE },
        { role: 'user', content: prompt }
      ],
      temperature: 0.15,
      max_tokens: maxTokens
    })
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 300)}`);
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error('Réponse JSON invalide');
  }
  const content = d?.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('Réponse IA vide');
  return content;
}

async function cloudflare(token, account, model, prompt) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${encodeURIComponent(model)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_BASE },
          { role: 'user', content: prompt }
        ]
      })
    }
  );
  const raw = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 300)}`);
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error('Réponse Cloudflare invalide');
  }
  const c = d?.result?.response || d?.result?.content || d?.result?.text || '';
  if (!c) throw new Error('Réponse IA vide');
  return c;
}

function providerList() {
  return [
    ['Groq 1', 'https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, process.env.GROQ_MODEL || 'openai/gpt-oss-120b', true],
    ['Groq 2', 'https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY_2, process.env.GROQ_MODEL_2 || process.env.GROQ_MODEL || 'openai/gpt-oss-120b', true],
    ['Mistral', 'https://api.mistral.ai/v1/chat/completions', process.env.MISTRAL_API_KEY, process.env.MISTRAL_MODEL || 'mistral-small-latest', true],
    ['OpenRouter 1', 'https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini', true],
    ['OpenRouter 2', 'https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY_2, process.env.OPENROUTER_MODEL_2 || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini', true],
    ['Gemini OpenAI', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || 'gemini-2.0-flash', true],
    ['Gemini OpenAI 2', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', process.env.GEMINI_API_KEY_2, process.env.GEMINI_MODEL_2 || process.env.GEMINI_MODEL || 'gemini-2.0-flash', true]
  ];
}

function stripCodeFences(s) {
  return clean(s)
    .replace(/^```(?:json|markdown|text|md)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function splitMarkdownSections(content) {
  const raw = stripCodeFences(content);
  // Compatible avec les anciennes réponses et la nouvelle structure numérotée.
  const docMatch = raw.match(/##\s*(?:1\.\s*)?É?noncé\s+Reconstruit\s*([\s\S]*?)(?=##\s*(?:2\.\s*)?(?:Corrigé\s+Détaillé|Analyse\s+pédagogique)|$)/i)
    || raw.match(/##\s*(?:1\.\s*)?Document\s+reconstruit\s*([\s\S]*?)(?=##\s*(?:2\.\s*)?(?:Corrigé\s+Détaillé|Analyse\s+pédagogique)|$)/i);
  const anaMatch = raw.match(/##\s*(?:2\.\s*)?(?:Corrigé\s+Détaillé|Analyse\s+pédagogique)\s*([\s\S]*?)$/i);
  if (docMatch || anaMatch) {
    return {
      formattedDocument: clean(docMatch ? docMatch[1] : ''),
      analysis: clean(anaMatch ? anaMatch[1] : raw)
    };
  }
  return null;
}

function finalizeFromContent(content, subject) {
  let raw = stripCodeFences(content);
  // If model still returns JSON, parse silently — never expose raw JSON to client UI
  const parsed = parsePayload(raw);
  let formattedDocument = '';
  let analysis = '';
  let rejected = false;
  let error;

  if (parsed && (parsed.formattedDocument || parsed.formattedText || parsed.analysis || parsed.text)) {
    formattedDocument = normalizeMathText(parsed.formattedDocument || parsed.formattedText || '', subject);
    analysis = normalizeMathText(parsed.analysis || parsed.text || '', subject);
    rejected = parsed.rejected === true || parsed.status === 'rejected' || parsed.status === 'REJECTED';
    error = parsed.error || parsed.error_message || parsed.errorMessage;
  } else {
    const sections = splitMarkdownSections(raw);
    if (sections) {
      formattedDocument = normalizeMathText(sections.formattedDocument || '', subject);
      analysis = normalizeMathText(sections.analysis || '', subject);
    } else {
      analysis = normalizeMathText(raw, subject);
    }
  }

  // Rejection payload {status:rejected,error_message}
  if (parsed && (parsed.status === 'rejected' || parsed.status === 'REJECTED')) {
    return {
      analysis: '',
      formattedDocument: undefined,
      rejected: true,
      error: parsed.error_message || parsed.error || 'Document non conforme. HosBac est une plateforme exclusivement académique.'
    };
  }
  // Safety: if analysis still looks like raw JSON, unwrap
  if (/^\s*\{\s*"(?:formattedDocument|analysis)/.test(analysis)) {
    try {
      const again = parsePayload(analysis);
      formattedDocument = normalizeMathText(again.formattedDocument || again.formattedText || formattedDocument, subject);
      analysis = normalizeMathText(again.analysis || again.text || '', subject);
    } catch (_) {}
  }

  // Dernière barrière avant le client : aucune macro math toxique ne doit sortir de cette route.
  const mathSubject = isMathSubject(subject);
  formattedDocument = sanitizeMathResponse(formattedDocument, mathSubject);
  analysis = sanitizeMathResponse(analysis, mathSubject);

  return {
    analysis,
    formattedDocument: formattedDocument || undefined,
    rejected,
    error
  };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });

  try {
    const decoded = await requireAuth(req);
    const b = req.body || {};
    const mode = clean(b.mode || 'ocr').toLowerCase();
    const text = truncateInput(b.text, mode);
    if (!text) return json(res, 400, { success: false, error: 'Texte à analyser manquant' });

    const wantStream =
      b.stream === true ||
      b.stream === 'true' ||
      String(req.headers.accept || '').includes('text/event-stream');

    if (isClearlyNonAcademic(text)) {
      const rej = {
        success: false,
        rejected: true,
        status: 'rejected',
        code: 'CONTENT_REJECTED',
        error: 'Document non conforme. HosBac est une plateforme exclusivement académique. Seuls les exercices, épreuves et cours scolaires sont autorisés.'
      };
      if (wantStream) {
        startSse(res);
        sseWrite(res, { type: 'error', ...rej });
        res.end();
        return;
      }
      return json(res, 400, rej);
    }
    const prompt = buildPrompt(b, text);
    const maxTokens = MAX_TOKENS[mode] || MAX_TOKENS.default;
    const errors = [];

    console.log('[AI ANALYZE]', {
      uid: decoded.uid,
      mode,
      stream: wantStream,
      inputLen: text.length,
      maxTokens
    });

    // Cascade administrée côté serveur : ordre/priorité et ON/OFF viennent
    // exclusivement de ai_models_config. Aucun provider hardcodé ne contourne
    // le panneau Admin. En mode stream, on pseudo-stream la réponse gagnante
    // après génération complète afin de pouvoir basculer proprement en cas de
    // 429/500/timeout sans laisser un écran partiellement rendu.
    try {
      const fb = await generateTextWithFallback(
        `${SYSTEM_BASE}\n\n${prompt}`,
        {
          jsonMode: false,
          temperature: 0.15,
          maxTokens,
          level: b.classe,
          subject: b.matiere
        }
      );
      const fin = finalizeFromContent(fb.text, clean(b.matiere));
      if (fin.rejected) {
        const rej = { success:false, rejected:true, status:'rejected', code:'CONTENT_REJECTED', error:fin.error || 'Document non conforme.' };
        if (wantStream) {
          startSse(res);
          sseWrite(res, { type:'error', ...rej });
          res.end();
          return;
        }
        return json(res, 400, rej);
      }
      if (!fin.analysis) throw Object.assign(new Error('Analyse IA vide'), { status:503 });

      if (wantStream) {
        startSse(res);
        sseWrite(res, { type:'start', mode, inputLen:text.length, provider:fb.provider, model:fb.model });
        const step = 48;
        const content = fin.analysis;
        for (let i=0; i<content.length; i+=step) sseWrite(res, { type:'token', text:content.slice(i,i+step), provider:fb.provider });
        sseWrite(res, { type:'done', success:true, provider:fb.provider, model:fb.model, analysis:fin.analysis, formattedDocument:fin.formattedDocument });
        res.end();
        return;
      }
      return json(res, 200, { success:true, provider:fb.provider, model:fb.model, analysis:fin.analysis, formattedDocument:fin.formattedDocument });
    } catch (e) {
      errors.push(e.message || String(e));
      console.error('[AI ANALYZE] configured cascade failed', errors);
      if (wantStream) {
        startSse(res);
        sseWrite(res, { type:'error', success:false, code:e.code || 'AI_PROVIDER_UNAVAILABLE', error:e.code === 'AI_MODELS_ALL_OFF' ? 'Les modèles IA sont désactivés et aucun contenu RAG exploitable n’est disponible pour cette fonctionnalité.' : 'Aucun fournisseur IA disponible.', providers:errors });
        res.end();
        return;
      }
      return json(res, e.status || 503, { success:false, code:e.code || 'AI_PROVIDER_UNAVAILABLE', error:e.code === 'AI_MODELS_ALL_OFF' ? 'Les modèles IA sont désactivés et cette fonctionnalité nécessite un modèle IA.' : 'Aucun fournisseur IA disponible.', providers:errors });
    }
  } catch (e) {
    console.error('[AI ANALYZE]', e);
    if (!res.headersSent) {
      return json(res, e.status || 500, { success: false, error: e.message });
    }
    try {
      sseWrite(res, { type: 'error', error: e.message });
      res.end();
    } catch (_) {}
  }
};
