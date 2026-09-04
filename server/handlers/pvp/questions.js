'use strict';
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'GET requis' });
  try {
    const d = await requireAuth(req);
    const id = String(req.query?.matchId || '').trim();
    if (!id) return json(res, 400, { success: false, error: 'matchId manquant' });
    const db = getAdmin().firestore();
    const snap = await db.collection('quiz_matches').doc(id).get();
    if (!snap.exists) return json(res, 404, { success: false, error: 'Match introuvable' });
    const m = snap.data();
    if (m.player1 !== d.uid && m.player2 !== d.uid) return json(res, 403, { success: false, error: 'Accès refusé' });
    const count = Math.max(1, Number(m.questionsLimit || m.questions?.length || 8));
    if (!Array.isArray(m.questionsPublic) || m.questionsPublic.length !== count) return json(res, 409, { success: false, error: 'Questions non prêtes' });
    return json(res, 200, {
      success: true,
      questionsCount: count,
      questions: m.questionsPublic.map(q => ({ id:q.id, theme:q.theme||'', question:q.question, choices:q.choices, difficulty:q.difficulty||2, subject:q.subject||m.matiere||'' }))
    });
  } catch (e) {
    return json(res, e.status || 500, { success: false, error: e.message || 'Questions indisponibles' });
  }
};
