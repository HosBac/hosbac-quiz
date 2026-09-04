'use strict';

/**
 * Génère N questions en UNE requête Gemini et les stocke sur la session.
 * Le client appelle ensuite quiz/next qui sert les questions pré-générées (instantané).
 */

const crypto = require('crypto');
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const rag = require('../../lib/rag');
const { generateWithFallback, listActiveModels } = require('../../lib/ai-fallback');
const { extractRagQuestions, buildRagQuestionsFromText } = require('../../lib/rag-question-source');
const { putCachedQuestions } = require('../../lib/question-cache');
const { normalizeQuestionMath } = require('../../lib/math-format');

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripBadLatex(s) {
  return String(s || '')
    .replace(/\\hline/gi, '')
    .replace(/\\cline\{[^}]*\}/gi, '')
    .replace(/\\begin\{tabular\}[\s\S]*?\\end\{tabular\}/gi, (m) => m.replace(/\\hline/gi, ' '));
}



/**
 * Fisher-Yates cryptographique : mélange les choix pour que la bonne réponse
 * ne soit jamais figée sur la même lettre (A/B/C/D) d'une question à l'autre.
 */
function secureShuffleChoices(question) {
  if (!question || !Array.isArray(question.choices) || question.choices.length !== 4) return question;
  const originalCorrect = Number(question.correctAnswer);
  if (!Number.isInteger(originalCorrect) || originalCorrect < 0 || originalCorrect > 3) return question;
  const indexed = question.choices.map((choice, index) => ({ choice, index }));
  for (let i = indexed.length - 1; i > 0; i--) {
    const rnd = crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;
    const j = Math.floor(rnd * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }
  question.choices = indexed.map((x) => x.choice);
  question.correctAnswer = indexed.findIndex((x) => x.index === originalCorrect);
  question.correctChoice = question.choices[question.correctAnswer] || '';
  return question;
}

function parseQuestions(raw, limit, session) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = String(raw).match(/\[[\s\S]*\]/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const arr = Array.isArray(parsed) ? parsed : parsed?.questions || [];
  const out = [];
  for (const q of arr) {
    if (!q || out.length >= limit) break;
    let choices = q.choices || q.options;
    if (choices && !Array.isArray(choices) && typeof choices === 'object') {
      choices = ['A', 'B', 'C', 'D'].map((L) => choices[L] || choices[L.toLowerCase()] || '');
    }
    if (!Array.isArray(choices) || choices.length < 4) continue;
    choices = choices.slice(0, 4).map((c) => clean(stripBadLatex(c)));
    let correct = q.correctAnswer;
    if (typeof correct === 'string' && /^[A-D]$/i.test(correct)) {
      correct = correct.toUpperCase().charCodeAt(0) - 65;
    }
    if (q.correct_letter && /^[A-D]$/i.test(q.correct_letter)) {
      correct = q.correct_letter.toUpperCase().charCodeAt(0) - 65;
    }
    correct = Number(correct);
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) continue;
    const questionText = clean(stripBadLatex(q.question || q.text));
    if (!questionText) continue;
    const qObj = {
      id: crypto.randomUUID(),
      theme: clean(q.theme || q.topic || q.chapter || ''),
      question: questionText,
      level: String(session?.classe || ''),
      subject: String(session?.matiere || ''),
      classe: String(session?.classe || ''),
      matiere: String(session?.matiere || ''),
      choices,
      correctAnswer: correct,
      correctChoice: choices[correct],
      explanation: clean(stripBadLatex(q.explanation || '')),
      hint: clean(stripBadLatex(q.hint || '')),
      difficulty: Number(q.difficulty) || 2,
      serverIssuedMs: Date.now(),
      pregenerated: true,
      image_url: clean(q.image_url || q.imageUrl || q.image || ''),
    };
    normalizeQuestionMath(qObj, qObj.subject);
    qObj.correctChoice = qObj.choices[qObj.correctAnswer] || '';
    // Mélange aléatoire des choix dès la génération batch (évite lettre fixe)
    secureShuffleChoices(qObj);
    out.push(qObj);
  }
  return out;
}

async function callGeminiBatch(prompt) {
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);
  if (!keys.length) throw Object.assign(new Error('GEMINI_API_KEY manquante'), { status: 503 });
  const models = geminiModelCascade();
  let lastErr;
  for (const key of keys) {
    for (const model of models) {
      try {
        return await withRetry(async () => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.45,
                maxOutputTokens: 8192,
                responseMimeType: 'application/json'
              }
            })
          });
          const bodyText = await r.text().catch(() => '');
          if (!r.ok) {
            const err = new Error(bodyText.slice(0, 300) || 'HTTP ' + r.status);
            err.status = r.status;
            if (isHighDemandError(r.status, bodyText, bodyText)) throw err;
            throw err;
          }
          let data = {};
          try {
            data = JSON.parse(bodyText);
          } catch (_) {}
          const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
          if (!text) {
            const err = new Error('Réponse vide');
            err.status = 503;
            throw err;
          }
          return text;
        }, { maxAttempts: 3, baseDelayMs: 800, label: 'BATCH/' + model });
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('Génération batch indisponible');
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });
  try {
    const d = await requireAuth(req);
    const db = getAdmin().firestore();
    const body = req.body || {};
    const sessionId = String(body.sessionId || '').trim();
    const quizId = String(body.quizId || '').trim();
    if (!sessionId && !quizId) return json(res, 400, { success: false, error: 'quizId/sessionId manquant' });

    const effectiveQuizId = quizId || sessionId;
    if (quizId && sessionId && quizId !== sessionId) return json(res, 409, { success:false, code:'QUIZ_ID_MISMATCH', error:'Quiz invalide.' });
    const ref = db.collection('quiz_sessions').doc(effectiveQuizId);
    const snap = await ref.get();
    if (!snap.exists) return json(res, 404, { success: false, error: 'Session introuvable' });
    const session = snap.data();
    if (session.userId !== d.uid) return json(res, 403, { success: false, error: 'Accès refusé' });
    if (session.status !== 'active') {
      return json(res, 409, { success: false, error: 'Session inactive' });
    }

    const existing = Array.isArray(session.questions) ? session.questions : [];
    const limit = Math.max(1, Math.min(100, Number(session.questionsLimit || body.count || 1)));
    if (existing.length >= limit) {
      return json(res, 200, {
        success: true,
        already: true,
        count: existing.length,
        publicQuestions: existing.map((q) => ({
          id: q.id,
          level: q.level || q.classe || session.classe,
          subject: q.subject || q.matiere || session.matiere,
          theme: q.theme || '',
          question: q.question,
          choices: q.choices,
          difficulty: q.difficulty
        }))
      });
    }

    const classe = session.classe || '';
    const matiere = session.matiere || '';
    const chapitre = session.chapitre || '';

    // Historique des questions déjà répondues sur les 30 derniers jours.
    // Les IDs sont conservés pour exclusion technique; les textes servent de garde anti-répétition.
    const answeredHistoryIds = new Set();
    const answeredHistoryTexts = [];
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const hist = await db.collection('quiz_sessions')
        .where('userId', '==', d.uid)
        .where('createdAt', '>=', cutoff)
        .limit(100)
        .get();
      for (const doc of hist.docs) {
        if (doc.id === effectiveQuizId) continue;
        const data = doc.data() || {};
        const answers = Array.isArray(data.answers) ? data.answers : [];
        const answeredIds = new Set(answers.map(a => String(a?.questionId || '')).filter(Boolean));
        const qs = Array.isArray(data.questions) ? data.questions : [];
        for (const q of qs) {
          if (!q || !answeredIds.has(String(q.id || ''))) continue;
          if (q.id) answeredHistoryIds.add(String(q.id));
          if (q.question) answeredHistoryTexts.push(String(q.question).trim());
        }
      }
    } catch (_) {
      // Les anciens projets peuvent ne pas disposer de l'index composite; le batch reste fonctionnel.
    }
    const historyExclusion = [...new Set(answeredHistoryTexts)].slice(0, 40);
    const historyIdExclusion = [...answeredHistoryIds].slice(0, 200);
    // Contexte RAG plafonné (reste largement sous ~6k tokens avec le prompt)
    const RAG_MAX_CHARS = 2500;
    let context = '';
    let ragHits = [];
    try {
      const hits = await rag.searchRAGContext(
        [matiere, classe, chapitre, 'cours'].filter(Boolean).join(' '),
        { classe, matiere, sa: chapitre, strictProfile: true },
        4
      );
      ragHits = Array.isArray(hits) ? hits : [];
      context = String(rag.buildContextString(ragHits, RAG_MAX_CHARS) || '').slice(0, RAG_MAX_CHARS);
    } catch (e) {
      console.warn('[QUIZ BATCH] RAG', e.message);
    }

    const need = limit - existing.length;

    // RAG-first sans IA : les QCM déjà présents dans les documents sont servis
    // directement, sans appeler de fournisseur ni consommer de quota.
    let ragDirect = extractRagQuestions(ragHits);
    if (ragDirect.length < need && ragHits.length) ragDirect = ragDirect.concat(buildRagQuestionsFromText(ragHits, need - ragDirect.length));
    if (ragDirect.length) {
      const direct = parseQuestions(JSON.stringify({ questions: ragDirect }), need, session);
      if (direct.length >= need) {
        const all = existing.concat(direct.slice(0, need));
        await ref.set({ questions: all, questionsCount: all.length, batchGenerated: true, batchSource: 'rag', batchAt: getAdmin().firestore.Timestamp.now() }, { merge: true });
        return json(res, 200, { success: true, questions: direct.slice(0, need), questionsCount: all.length, source: 'rag' });
      }
    }

    // Tous les modèles OFF : aucun appel IA ne doit être tenté.
    const activeModels = await listActiveModels();
    if (!activeModels.length) {
      return json(res, 503, { success:false, code:'RAG_DOCUMENTS_UNAVAILABLE', error:'Les documents pour cette classe et matière ne sont pas encore disponibles dans le RAG. Veuillez revenir plus tard.' });
    }
    // Petits lots pour respecter les TPM bas (ex. Groq 8k TPM)
    const CHUNK = Math.min(4, Math.max(2, need));
    const questions = [];
    let remaining = need;
    let chunkIndex = 0;
    while (remaining > 0 && questions.length < need) {
      const n = Math.min(CHUNK, remaining);
      const uniquenessSeed = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      const prompt = [
        `CLÉ D'UNICITÉ : ${uniquenessSeed}. Cette clé sert à varier l'angle et la formulation; elle ne doit jamais apparaître dans la question.`,
        `QUESTIONS DÉJÀ RÉPONDUES (30 JOURS) À EXCLURE : ${historyExclusion.length ? historyExclusion.join(' | ') : 'aucune'}. IDs historiques à ne jamais réutiliser : ${historyIdExclusion.length ? historyIdExclusion.join(', ') : 'aucun'}.`,
        `CLASSE DE L'ÉLÈVE : ${classe}. MATIÈRE EXCLUSIVE : ${matiere}. RÈGLE D'ÉTANCHÉITÉ PÉDAGOGIQUE ABSOLUE : génère EXACTEMENT ${n} questions conformes au programme officiel de la classe ${classe} et EXCLUSIVEMENT en ${matiere}. Interdiction absolue de toute autre matière ou tout autre niveau. Si le RAG est vide, utilise uniquement le programme officiel de ${classe} en ${matiere}. Chaque question DOIT inclure option_explanations {0,1,2,3} avec la faute de raisonnement précise pour chaque distracteur (jamais « faux car la bonne est X »). Génère EXACTEMENT ${n} questions JSON en français.`,
        `Classe:${classe||'-'} Matière:${matiere||'-'} SA:${chapitre||'programme'}`,
        `Règles: 4 choix; correctAnswer 0-3; court; pas de tableaux LaTeX; formules uniquement pour Mathématiques/PCT avec $...$ en ligne et $$...$$ en bloc; jamais \\( \\) ni \\[ \\]. Pour SVT/Anglais/Français/Histoire-Géo/Philosophie et autres matières littérales: texte brut sans LaTeX.`,
        `Questions auto-portantes: « D\'après la figure ci-dessus… » / « D\'après le graphique… ». Interdit: « selon le corrigé ». Si figure: remplir image_url.`,
        `Si CONTEXTE: s'y limiter. Varier les notions.`,
        `CONTEXTE (extrait):\n${context || 'Programme scolaire du niveau.'}`,
        `JSON uniquement: [{"theme":"Thème précis","question":"...","choices":["A","B","C","D"],"correctAnswer":0,"explanation":"...","hint":"...","difficulty":2,"image_url":""}]`
      ].join('\n');

      const fb = await generateWithFallback(prompt, {
        jsonMode: true,
        temperature: 0.4,
        maxTokens: 2000,
        level: classe,
        subject: matiere
      });
      const parsed = parseQuestions(fb.text, n, session);
      if (!parsed.length) {
        chunkIndex++;
        if (chunkIndex > 3) break;
        remaining = need - questions.length;
        continue;
      }
      for (const q of parsed) {
        if (questions.length >= need) break;
        questions.push(q);
      }
      remaining = need - questions.length;
      chunkIndex++;
      // Sécurité: max 3 appels IA par batch
      if (chunkIndex >= 3) break;
    }

    if (questions.length < Math.min(2, need)) {
      return json(res, 503, {
        success: false,
        error: 'Génération insuffisante (' + questions.length + '). Réessaie.',
        code: 'BATCH_INSUFFICIENT'
      });
    }
    // Cache pour économie de quotas
    try {
      putCachedQuestions(
        [classe, session.serie || '', matiere, chapitre || '', 'batch'],
        questions.map((q) => {
          const c = { ...q };
          delete c.id;
          return c;
        })
      );
    } catch (_) {}

    // Stockage atomique
    const all = existing.concat(questions);
    await ref.set(
      {
        questions: all,
        questionsCount: all.length,
        batchGenerated: true,
        batchAt: getAdmin().firestore.Timestamp.now()
      },
      { merge: true }
    );

    return json(res, 200, {
      success: true,
      count: all.length,
      publicQuestions: all.map((q) => ({
        id: q.id,
        level: q.level || q.classe || session.classe,
        subject: q.subject || q.matiere || session.matiere,
        theme: q.theme || '',
        question: q.question,
        choices: q.choices,
        difficulty: q.difficulty
      }))
    });
  } catch (e) {
    console.error('[QUIZ BATCH]', e);
    const status = e.status || 503;
    const msg = String(e.message || '');
    const overloaded =
      status === 429 ||
      status === 503 ||
      /quota|rate limit|surcharg|indisponible|fallback|tous les modèles/i.test(msg);
    return json(res, overloaded ? 503 : status, {
      success: false,
      error: overloaded
        ? 'Les services IA sont momentanément surchargés. Veuillez réessayer dans une minute.'
        : msg || 'Erreur lors de la génération des questions.',
      code: overloaded ? 'AI_OVERLOADED' : 'BATCH_ERROR'
    });
  }
};
