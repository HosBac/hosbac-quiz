'use strict';
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const { getAppConfig } = require('../../lib/app-config');
const cors = require('../../lib/cors');

const QUESTION_SECONDS = 30;
function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value._seconds === 'number') return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  return Number(value) || 0;
}
function playerKey(m, uid) { return m.player1 === uid ? 'host' : 'guest'; }

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });
  try {
    const d = await requireAuth(req);
    const db = getAdmin().firestore();
    const cfg = await getAppConfig(getAdmin());
    const b = req.body || {};
    const matchId = String(b.matchId || '').trim();
    const questionIndex = Number(b.questionIndex);
    let answer = Number(b.answer);
    if (!matchId) return json(res, 400, { success: false, error: 'matchId manquant' });
    if (!Number.isInteger(questionIndex) || questionIndex < 0) return json(res, 400, { success: false, error: 'questionIndex invalide' });
    if (!Number.isInteger(answer) || answer < -1 || answer > 3) return json(res, 400, { success: false, error: 'Réponse invalide' });

    const defaultXp = Math.max(0, Number(cfg.default_xp_per_correct_answer ?? cfg.baseXP ?? 1));
    const ref = db.collection('quiz_matches').doc(matchId);
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw Object.assign(new Error('Match introuvable'), { status: 404 });
      const m = snap.data();
      if (!['IN_PROGRESS','started'].includes(m.status)) throw Object.assign(new Error('Le duel n’est pas en cours.'), { status: 409 });
      if (!m.player2 || ![m.player1, m.player2].includes(d.uid)) throw Object.assign(new Error('Accès refusé'), { status: 403 });
      const current = Number(m.currentQuestionIndex ?? m.questionIndex ?? 0);
      if (questionIndex !== current) return { stale: true, currentQuestionIndex: current, scores: m.scores || {} };
      const key = playerKey(m, d.uid);
      const answeredField = key === 'host' ? 'host_answered' : 'guest_answered';
      if (m[answeredField] === true) return { duplicate: true, currentQuestionIndex: current, scores: m.scores || {}, bothAnswered: !!m.host_answered && !!m.guest_answered };

      const xpPerCorrect = Number(m.wager_xp || 0) === 0 ? defaultXp : Math.max(0, Number(cfg.pvpXPPerQuestion || 1));
      const q = Array.isArray(m.questions) ? m.questions[current] : null;
      if (!q) throw Object.assign(new Error('Question PvP introuvable.'), { status: 500 });
      const startMs = toMillis(m.questionStartTime);
      const elapsedRaw = startMs ? Math.max(0, (Date.now() - startMs) / 1000) : 0;
      const timedOut = answer < 0 || elapsedRaw >= QUESTION_SECONDS;
      if (timedOut) answer = -1;
      const elapsedSeconds = Math.min(QUESTION_SECONDS, Math.floor(elapsedRaw));
      const isCorrect = answer >= 0 && answer === Number(q.correctAnswer);
      const points = isCorrect ? xpPerCorrect : 0;
      const scores = { ...(m.scores || {}) };
      scores[d.uid] = Number(scores[d.uid] || 0) + points;
      const history = Array.isArray(m.answers_history) ? [...m.answers_history] : [];
      history.push({ questionIndex: current, player: key, uid: d.uid, answer: answer >= 0 ? answer : null, correct: isCorrect, points, elapsedSeconds, timedOut, answeredAt: Date.now() });

      const patch = { scores, answers_history: history, [answeredField]: true };
      if (points > 0) {
        const userRef = db.collection('users').doc(d.uid);
        const userSnap = await tx.get(userRef);
        const u = userSnap.exists ? userSnap.data() : {};
        const xp = Number(u.quiz_xp || 0) + points;
        tx.set(userRef, { quiz_xp: xp, totalXp: Number(u.totalXp || 0) + points, inspe_points: Number(u.inspe_points || 0) + points, quiz_level: Math.floor(xp / 100) + 1 }, { merge: true });
      }
      tx.update(ref, patch);
      const bothAnswered = (key === 'host' ? true : m.host_answered === true) && (key === 'guest' ? true : m.guest_answered === true);
      return { stale:false, duplicate:false, awarded:points>0, isCorrect, points, elapsedSeconds, timedOut, scores, status:m.status, currentQuestionIndex:current, advanced:false, opponentAnswered:key==='host'?!!m.guest_answered:!!m.host_answered, bothAnswered, canAdvance:m.player1===d.uid && bothAnswered };
    });
    return json(res, 200, { success:true, ...result });
  } catch(e) {
    return json(res, e.status || 500, { success:false, error:e.message || 'Réponse impossible' });
  }
};
