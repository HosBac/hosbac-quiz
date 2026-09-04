'use strict';

const crypto = require('crypto');
const rag = require('../../lib/rag');
const { normalizeQuestionMath } = require('../../lib/math-format');
const { listActiveModels, generateWithFallback } = require('../../lib/ai-fallback');
const { extractRagQuestions, buildRagQuestionsFromText } = require('../../lib/rag-question-source');

const PVP_QUESTION_COUNT = 8;
const REQUEST_TIMEOUT_MS = 9000;

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function stripMarkdownJson(raw) {
  return String(raw ?? '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function parseJson(raw) {
  const cleaned = stripMarkdownJson(raw);
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {}
  }
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try { return JSON.parse(cleaned.slice(objStart, objEnd + 1)); } catch (_) {}
  }
  return null;
}

function shuffleQuestionOptions(question) {
  const original = Array.isArray(question.choices) ? question.choices : [];
  const indexed = original.map((choice, index) => ({ choice, index }));
  for (let i = indexed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }
  question.choices = indexed.map(x => x.choice);
  question.correctAnswer = indexed.findIndex(x => x.index === Number(question.correctAnswer));
  question.correctChoice = question.choices[question.correctAnswer] || '';
  if (question.option_explanations && typeof question.option_explanations === 'object') {
    const old = question.option_explanations;
    question.option_explanations = Object.fromEntries(
      indexed.map(({ index }, newIndex) => [String(newIndex), old[String(index)] || ''])
    );
  }
  return question;
}

function normalizeQuestion(q, subject) {
  if (!q || typeof q !== 'object') return null;
  let choices = q.choices || q.options;
  if (choices && !Array.isArray(choices) && typeof choices === 'object') {
    choices = ['A', 'B', 'C', 'D'].map(L => choices[L] ?? choices[L.toLowerCase()] ?? '');
  }
  if (!Array.isArray(choices) || choices.length !== 4) return null;

  const optionObjects = choices.map(c => c && typeof c === 'object'
    ? {
        text: clean(c.text || c.texte || c.label),
        is_correct: c.is_correct === true || c.est_correcte === true || c.isCorrect === true,
        feedback: clean(c.feedback || c.explanation || '')
      }
    : { text: clean(c), is_correct: false, feedback: '' });

  let correct = q.correctAnswer ?? q.correct_answer ?? q.correct_letter;
  if (typeof correct === 'string' && /^[A-D]$/i.test(correct)) correct = correct.toUpperCase().charCodeAt(0) - 65;
  const flagged = optionObjects.findIndex(o => o.is_correct);
  if (flagged >= 0) correct = flagged;
  correct = Number(correct);
  if (!Number.isInteger(correct) || correct < 0 || correct > 3) return null;
  if (optionObjects.some(o => !o.text)) return null;

  const question = normalizeQuestionMath({
    id: crypto.randomUUID(),
    theme: clean(q.theme || q.topic || q.chapter || ''),
    question: clean(q.question || q.text),
    choices: optionObjects.map(o => o.text),
    correctAnswer: correct,
    correctChoice: optionObjects[correct].text,
    explanation: clean(q.explanation || ''),
    option_explanations: Object.fromEntries(optionObjects.map((o, i) => [String(i), o.feedback])),
    hint: clean(q.hint || ''),
    difficulty: Number(q.difficulty) || 2,
    subject: subject || ''
  }, subject);

  if (!question.question) return null;
  return shuffleQuestionOptions(question);
}

function toPublicQuestion(q) {
  return {
    id: q.id,
    theme: q.theme || '',
    question: q.question,
    choices: q.choices,
    difficulty: q.difficulty || 2,
    subject: q.subject || ''
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseProviderResponse(response, extractText) {
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    let message = body.slice(0, 500);
    try { message = JSON.parse(body)?.error?.message || JSON.parse(body)?.error || message; } catch (_) {}
    throw new Error(`HTTP ${response.status}: ${String(message).slice(0, 500)}`);
  }
  let data = {};
  try { data = JSON.parse(body); } catch (_) { throw new Error('Réponse IA JSON invalide'); }
  return extractText(data);
}

async function callGemini(prompt) {
  const apiKey = String(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1 || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY manquante');
  const model = String(process.env.PVP_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const r = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.45, maxOutputTokens: 8192, responseMimeType: 'application/json' }
      })
    }
  );
  return parseProviderResponse(r, d => d?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '');
}

async function callGroq(prompt) {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw new Error('GROQ_API_KEY manquante');
  const model = String(process.env.PVP_GROQ_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
  const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: "Retourne uniquement le JSON demandé. Respecte exactement le nombre de questions et d’options." },
        { role: 'user', content: prompt }
      ],
      temperature: 0.35,
      max_tokens: 7000,
      response_format: { type: 'json_object' }
    })
  });
  return parseProviderResponse(r, d => d?.choices?.[0]?.message?.content || '');
}

async function callMistral(prompt) {
  const apiKey = String(process.env.MISTRAL_API_KEY || '').trim();
  if (!apiKey) throw new Error('MISTRAL_API_KEY manquante');
  const model = String(process.env.PVP_MISTRAL_MODEL || process.env.MISTRAL_MODEL || 'mistral-small-latest').trim();
  const r = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: "Retourne uniquement le JSON demandé. Respecte exactement le nombre de questions et d’options." },
        { role: 'user', content: prompt }
      ],
      temperature: 0.35,
      max_tokens: 7000,
      response_format: { type: 'json_object' }
    })
  });
  return parseProviderResponse(r, d => d?.choices?.[0]?.message?.content || '');
}

async function callOpenRouter(prompt) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY manquante');
  const model = String(process.env.PVP_OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini').trim();
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'HosBac Quiz PvP' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: "Retourne uniquement le JSON demandé. Respecte exactement le nombre de questions et d’options." },
        { role: 'user', content: prompt }
      ],
      temperature: 0.35,
      max_tokens: 7000,
      response_format: { type: 'json_object' }
    })
  });
  return parseProviderResponse(r, d => d?.choices?.[0]?.message?.content || '');
}

async function callHuggingFace(prompt) {
  const apiKey = String(process.env.HF_API_KEY || '').trim();
  if (!apiKey) throw new Error('HF_API_KEY manquante');
  const model = String(process.env.PVP_HF_MODEL || process.env.HF_MODEL || 'Qwen/Qwen2.5-7B-Instruct').trim();
  const r = await fetchWithTimeout('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: "Retourne uniquement le JSON demandé. Respecte exactement le nombre de questions et d’options." },
        { role: 'user', content: prompt }
      ],
      temperature: 0.35,
      max_tokens: 7000
    })
  });
  return parseProviderResponse(r, d => d?.choices?.[0]?.message?.content || '');
}

async function generatePvpQuestions({ classe, matiere, sa, count = PVP_QUESTION_COUNT }) {
  const questionCount = Math.max(1, Math.min(30, Number(count) || PVP_QUESTION_COUNT));
  let hits = [];
  let context = '';
  try {
    hits = await rag.searchRAGContext(
      [matiere, classe, sa, 'cours'].filter(Boolean).join(' '),
      { classe, matiere, sa, strictProfile: true },
      Math.min(20, Math.max(questionCount * 2, 8))
    );
    context = rag.buildContextString(hits, 12000);
  } catch (e) {
    console.warn('[PVP QUESTION BANK] RAG retrieval:', e.message);
  }

  // RAG-first réel : si les documents contiennent déjà des QCM/corrigés
  // structurés, aucune requête LLM n'est effectuée.
  let ragQuestions = extractRagQuestions(hits).filter(q => !q.subject || normalizeSubject(q.subject) === normalizeSubject(matiere));
  if (ragQuestions.length < questionCount && hits.length) ragQuestions = ragQuestions.concat(buildRagQuestionsFromText(hits, questionCount - ragQuestions.length));
  if (ragQuestions.length >= questionCount) {
    const questions = ragQuestions.slice(0, questionCount).map(q => normalizeQuestion(q, matiere)).filter(Boolean);
    if (questions.length === questionCount) {
      return { questions, questionsPublic: questions.map(toPublicQuestion), provider: 'rag' };
    }
  }

  // Mode 100 % RAG lorsque tous les modèles sont OFF.
  const activeModels = await listActiveModels();
  if (!activeModels.length) {
    throw Object.assign(new Error('Les documents pour cette classe et matière ne sont pas encore disponibles dans le RAG. Veuillez revenir plus tard.'), {
      status: 503,
      code: 'RAG_DOCUMENTS_UNAVAILABLE'
    });
  }

  const sourceRule = context
    ? 'Le CONTEXTE RAG est disponible : utilise exclusivement ses informations pour construire les questions.'
    : 'Le CONTEXTE RAG est indisponible : utilise exclusivement le programme scolaire correspondant à la classe et à la matière.';

  const prompt = `Tu es le générateur QCM de HosBac Quiz. Génère exactement ${questionCount} questions QCM distinctes pour un duel PvP.
Classe: ${classe}
Matière: ${matiere}
SA/chapitre: ${sa || 'programme'}

${sourceRule}
CONTEXTE RAG:
---
${context || 'Aucun contexte RAG disponible.'}
---

Contraintes pédagogiques:
- exactement ${questionCount} questions;
- exactement 4 options par question;
- une seule bonne réponse;
- une explication pédagogique;
- aucune répétition;
- la question doit rester strictement dans la classe et la matière demandées;
- pour les mathématiques/PCT, conserve les formules LaTeX existantes sans les réécrire en dehors des règles déjà appliquées par HosBac;
- pour les matières littérales, texte clair sans balises mathématiques;
- ne mets jamais de balises Markdown autour du JSON.

Retourne UNIQUEMENT un objet JSON de la forme:
{"questions":[{"theme":"...","question":"...","options":[{"text":"...","is_correct":true,"feedback":"..."},{"text":"...","is_correct":false,"feedback":"..."},{"text":"...","is_correct":false,"feedback":"..."},{"text":"...","is_correct":false,"feedback":"..."}],"explanation":"...","hint":"...","difficulty":2}]}`;

  const errors = [];
  try {
    const fb = await generateWithFallback(prompt, {
      jsonMode: true,
      temperature: 0.35,
      maxTokens: Math.min(7000, Math.max(1800, questionCount * 700)),
      level: classe,
      subject: matiere
    });
    const parsed = parseJson(fb.text);
    const arr = Array.isArray(parsed) ? parsed : parsed?.questions;
    if (!Array.isArray(arr)) throw new Error('Réponse QCM invalide');
    const questions = [];
    for (const item of arr) {
      const q = normalizeQuestion(item, matiere);
      if (q) questions.push(q);
      if (questions.length === questionCount) break;
    }
    if (questions.length !== questionCount) throw new Error(`Génération insuffisante: ${questions.length}/${questionCount}`);
    return { questions, questionsPublic: questions.map(toPublicQuestion), provider: fb.provider, model: fb.model };
  } catch (e) {
    errors.push(e.message || String(e));
    console.warn('[PVP QUESTION BANK] configured fallback failed:', e.message);
  }
  throw Object.assign(new Error(`Aucun fournisseur IA n’a pu préparer ${questionCount} questions. ${errors.join(' | ')}`), { status: 503 });
}

function normalizeSubject(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

module.exports = {
  PVP_QUESTION_COUNT,
  generatePvpQuestions,
  toPublicQuestion,
  stripMarkdownJson
};
