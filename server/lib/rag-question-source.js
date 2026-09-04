'use strict';

/**
 * Extracteur local de QCM déjà présents dans les documents RAG.
 * Aucun appel réseau/IA : quand un document contient des questions/corrigés
 * structurés, celles-ci peuvent être utilisées directement sans quota LLM.
 */
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function stripFence(s) { return String(s ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim(); }

function parseJsonCandidates(text) {
  const raw = stripFence(text);
  const out = [];
  for (const candidate of [raw, raw.match(/\[[\s\S]*\]/)?.[0], raw.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const j = JSON.parse(candidate);
      if (Array.isArray(j)) out.push(...j);
      else if (Array.isArray(j.questions)) out.push(...j.questions);
      else if (j.question) out.push(j);
    } catch (_) {}
  }
  return out;
}

function parseMarkdownQcm(text) {
  const raw = String(text ?? '').replace(/\r/g, '\n');
  const results = [];
  const qRe = /(?:^|\n)\s*(?:question\s*)?(\d{1,3})?[.)\-:]?\s*([^\n]{8,500})\n\s*A[.)]\s*([^\n]+)\n\s*B[.)]\s*([^\n]+)\n\s*C[.)]\s*([^\n]+)\n\s*D[.)]\s*([^\n]+)([\s\S]*?)(?=\n\s*(?:question\s*)?\d{1,3}[.)\-:]|\n\s*(?:question\s*)?[A-ZÀ-ÿ][^\n]{0,80}\n\s*A[.)]|$)/gi;
  let m;
  while ((m = qRe.exec(raw)) !== null) {
    const tail = m[7] || '';
    const ans = tail.match(/(?:bonne\s+réponse|réponse(?:\s+correcte)?|answer|correct)\s*[:\-]?\s*([ABCD])/i);
    if (!ans) continue;
    results.push({ question: clean(m[2]), choices: [clean(m[3]), clean(m[4]), clean(m[5]), clean(m[6])], correctAnswer: ans[1].toUpperCase().charCodeAt(0) - 65 });
  }
  return results;
}

function normalizeRawQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  let choices = q.choices || q.options;
  if (choices && !Array.isArray(choices) && typeof choices === 'object') choices = ['A','B','C','D'].map(k => choices[k] ?? choices[k.toLowerCase()] ?? '');
  if (!Array.isArray(choices) || choices.length !== 4) return null;
  choices = choices.map(c => typeof c === 'object' ? clean(c.text || c.texte || c.label) : clean(c));
  if (choices.some(c => !c)) return null;
  let correct = q.correctAnswer ?? q.correct_answer ?? q.correct_letter ?? q.answer;
  if (typeof correct === 'string' && /^[ABCD]$/i.test(correct.trim())) correct = correct.trim().toUpperCase().charCodeAt(0) - 65;
  if (typeof correct === 'string' && /^\d+$/.test(correct.trim())) correct = Number(correct);
  correct = Number(correct);
  if (!Number.isInteger(correct) || correct < 0 || correct > 3) return null;
  const question = clean(q.question || q.text || q.enonce);
  if (!question) return null;
  return {
    id: q.id || null,
    theme: clean(q.theme || q.topic || q.chapter || ''),
    question,
    choices,
    correctAnswer: correct,
    explanation: clean(q.explanation || q.correction || ''),
    hint: clean(q.hint || ''),
    difficulty: Number(q.difficulty) || 2,
    subject: clean(q.subject || q.matiere || ''),
    option_explanations: q.option_explanations || {}
  };
}

function extractRagQuestions(hits = []) {
  const result = [];
  const seen = new Set();
  for (const hit of hits || []) {
    const content = String(hit?.content || '');
    const candidates = [...parseJsonCandidates(content), ...parseMarkdownQcm(content)];
    for (const raw of candidates) {
      const q = normalizeRawQuestion(raw);
      if (!q) continue;
      const key = q.question.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(q);
    }
  }
  return result;
}


const STOPWORDS = new Set(('avec pour dans cette cette une des les est sont qui que par sur sous aux leur leurs leurs mais donc comme plus moins selon entre sans être avoir cours notion notions exercice question quelle quel quelles quels peut peut-on cette ces cet aussi très nous vous ils elles une un au aux du de la le la et ou en se ce son sa ses').split(/\s+/));
function buildRagQuestionsFromText(hits = [], count = 8) {
  const sentences = [];
  for (const hit of hits || []) {
    const meta = hit?.metadata || {};
    const text = String(hit?.content || '').replace(/\r/g,'\n');
    const parts = text.split(/(?<=[.!?])\s+|\n+/).map(clean).filter(x => x.length >= 35 && x.length <= 360);
    for (const sentence of parts) sentences.push({ sentence, theme:clean(meta.sa_title || meta.title || meta.sa || '') });
  }
  const out=[]; const used=new Set();
  for (let i=0;i<sentences.length && out.length<count;i++) {
    const target=sentences[i];
    const words=[...new Set((target.sentence.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z]{6,}/g)||[]))]
      .filter(w=>!STOPWORDS.has(w));
    let key=words.sort((a,b)=>a.length-b.length).find(w=>sentences.filter(x=>x.sentence.toLowerCase().includes(w)).length===1);
    if(!key) continue;
    const distractors=[];
    for(const cand of sentences){
      if(cand===target || cand.sentence.toLowerCase().includes(key) || used.has(cand.sentence.toLowerCase())) continue;
      if(!distractors.some(x=>x.sentence===cand.sentence)) distractors.push(cand);
      if(distractors.length===3) break;
    }
    if(distractors.length<3) continue;
    const choices=[target.sentence,...distractors.map(x=>x.sentence)];
    out.push({theme:target.theme||'Cours',question:`Selon le cours, quelle affirmation décrit correctement la notion « ${key} » ?`,choices,correctAnswer:0,explanation:`Cette proposition reprend explicitement l'information présente dans le document RAG.`,hint:'Relis le passage du cours consacré à cette notion.',difficulty:2,subject:clean(target.subject||'')});
    used.add(target.sentence.toLowerCase());
  }
  return out;
}

module.exports = { extractRagQuestions, normalizeRawQuestion, buildRagQuestionsFromText };
