'use strict';

const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const { getAppConfig } = require('../../lib/app-config');
const { generatePvpQuestions, PVP_QUESTION_COUNT } = require('./question-bank');
const cors = require('../../lib/cors');

async function refundAndCancel(db, matchId, m, admin, reason) {
  const ref = db.collection('quiz_matches').doc(matchId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const x = snap.data();
    if (['CANCELLED', 'COMPLETED', 'finished', 'cancelled'].includes(x.status)) return;
    const wager = Number(x.wager_xp || 0);
    const stake = Number(x.wager_total_xp || (wager * Math.max(1, Number(x.questionsLimit || 8))));
    const ur = (stake > 0 && !x.wagerSettled && x.player1) ? db.collection('users').doc(x.player1) : null;
    const us = ur ? await tx.get(ur) : null;
    tx.update(ref, { status: 'CANCELLED', cancelReason: reason, cancelledAt: admin.firestore.Timestamp.now(), generationStatus: 'FAILED' });
    if (stake > 0 && !x.wagerSettled && x.player1) {
      const u = us.exists ? us.data() : {};
      const xp = Number(u.quiz_xp || 0) + stake;
      tx.set(ur, { quiz_xp: xp, totalXp: Number(u.totalXp || 0) + stake, inspe_points: Number(u.inspe_points || 0) + stake, quiz_level: Math.floor(xp / 100) + 1 }, { merge: true });
      tx.update(ref, { wagerSettled: true, wagerSettlement: 'refunded' });
    }
    const userIds = [x.player1, x.player2].filter(Boolean);
    for (const uid of userIds) {
      tx.set(db.collection('users').doc(uid), { pvpStatus: 'idle', pvpMatchId: null }, { merge: true });
      tx.set(db.collection('users_online').doc(uid), { status: 'idle', matchId: null, updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
    }
  });
}

async function generateMatchQuestions(matchId, callerUid) {
  const admin = getAdmin();
  const db = admin.firestore();
  const ref = db.collection('quiz_matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('Match introuvable'), { status: 404 });
  let m = snap.data();
  if (callerUid && m.player1 !== callerUid) throw Object.assign(new Error('Seul l’hôte peut préparer les questions.'), { status: 403 });

  const cfg = await getAppConfig(admin);
  const count = Math.max(1, Math.min(30, Number(m.questionsLimit || cfg.pvpQuestions || PVP_QUESTION_COUNT)));
  if (Array.isArray(m.questions) && m.questions.length === count) return { already: true, count, status: m.status };
  if (!['PREPARING', 'WAITING_GUEST'].includes(m.status)) return { already: false, count, status: m.status };

  const now = Date.now();
  if (Number(m.nextGenerationAt || 0) > now) return { retryAt: Number(m.nextGenerationAt), count, status: m.status };

  const locked = await db.runTransaction(async tx => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) return false;
    const x = fresh.data();
    if (!['PREPARING', 'WAITING_GUEST'].includes(x.status)) return false;
    if (Array.isArray(x.questions) && x.questions.length === count) return false;
    if (x.generationStatus === 'RUNNING') return false;
    tx.update(ref, { generationStatus: 'RUNNING', generationAttempts: Number(x.generationAttempts || 0) + 1 });
    return true;
  });
  if (!locked) return { inProgress: true, count };

  try {
    const bank = await generatePvpQuestions({
      classe: m.classe,
      matiere: m.matiere,
      sa: m.sa,
      count
    });
    await ref.set({
      questions: bank.questions,
      questionsPublic: bank.questionsPublic,
      questionsLimit: count,
      status: 'WAITING_GUEST',
      generationStatus: 'DONE',
      generatedBy: callerUid || m.player1,
      generatedAt: admin.firestore.Timestamp.now(),
      lastGenerationError: null,
      nextGenerationAt: 0
    }, { merge: true });
    return { success: true, ready: true, count, provider: bank.provider || null, status: 'WAITING_GUEST' };
  } catch (e) {
    const attempts = Number(m.generationAttempts || 1);
    const retryAt = Date.now() + Math.min(30000, 5000 * Math.max(1, attempts));
    if (attempts >= 3) {
      await refundAndCancel(db, matchId, m, admin, 'question_generation_failed');
      return { success: false, failed: true, status: 'CANCELLED', error: e.message };
    }
    await ref.set({
      generationStatus: 'IDLE',
      lastGenerationError: String(e.message || 'Erreur de génération').slice(0, 1000),
      nextGenerationAt: retryAt
    }, { merge: true });
    throw Object.assign(new Error(String(e.message || 'Génération des questions impossible')), { status: e.status || 503, retryAt });
  }
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });
  try {
    const d = await requireAuth(req);
    const id = String((req.body || {}).matchId || '').trim();
    if (!id) return json(res, 400, { success: false, error: 'matchId manquant' });
    const result = await generateMatchQuestions(id, d.uid);
    return json(res, 200, { success: true, ...result });
  } catch (e) {
    return json(res, e.status || 503, { success: false, error: e.message || 'Questions indisponibles', retryAt: e.retryAt || null });
  }
};

module.exports.generateMatchQuestions = generateMatchQuestions;
