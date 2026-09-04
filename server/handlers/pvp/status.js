'use strict';

const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const { getAppConfig } = require('../../lib/app-config');
const cors = require('../../lib/cors');
const generation = require('./generate-questions');

const QUESTION_SECONDS = 30;

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value._seconds === 'number') return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function cancelIfCriticalDisconnect(db, ref, m, admin) {
  if (!['IN_PROGRESS','started'].includes(m.status) || !m.player1 || !m.player2) return false;
  const pres = await Promise.all([m.player1,m.player2].map(uid => db.collection('users_online').doc(uid).get()));
  const stale = pres.some((snap,i) => {
    if (!snap.exists) return true;
    const p=snap.data()||{};
    if (String(p.matchId||'')!==String(ref.id)) return true;
    const at=toMillis(p.updatedAt);
    return !at || Date.now()-at > 20000;
  });
  if (!stale) return false;
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(!snap.exists)return;
    const x=snap.data()||{};
    if(!['IN_PROGRESS','started'].includes(x.status))return;
    const playerIds=[x.player1,x.player2].filter(Boolean);
    const userSnaps=await Promise.all(playerIds.map(uid=>tx.get(db.collection('users').doc(uid))));
    tx.update(ref,{status:'CANCELLED',cancelReason:'critical_disconnect',cancelledAt:admin.firestore.Timestamp.now()});
    const wager=Number(x.wager_xp||0);
    const stake=Number(x.wager_total_xp||(wager*Math.max(1,Number(x.questionsLimit||8))));
    if(stake>0&&!x.wagerSettled){
      for(let i=0;i<playerIds.length;i++){
        const uid=playerIds[i],ur=db.collection('users').doc(uid),us=userSnaps[i],u=us.exists?us.data():{},xp=Number(u.quiz_xp||0)+stake;
        tx.set(ur,{quiz_xp:xp,totalXp:Number(u.totalXp||0)+stake,inspe_points:Number(u.inspe_points||0)+stake,quiz_level:Math.floor(xp/100)+1,pvpStatus:'idle',pvpMatchId:null},{merge:true});
      }
      tx.update(ref,{wagerSettled:true,wagerSettlement:'refunded'});
    } else {
      for(const uid of [x.player1,x.player2].filter(Boolean)) tx.set(db.collection('users').doc(uid),{pvpStatus:'idle',pvpMatchId:null},{merge:true});
    }
  });
  return true;
}

async function finalizeExpired(db, ref, m) {
  if (!['IN_PROGRESS', 'started'].includes(m.status)) return m;
  const start = toMillis(m.questionStartTime);
  if (!start || Date.now() - start < QUESTION_SECONDS * 1000) return m;

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return m;
    const x = snap.data();
    if (!['IN_PROGRESS', 'started'].includes(x.status)) return x;
    const idx = Number(x.currentQuestionIndex ?? x.questionIndex ?? 0);
    const history = Array.isArray(x.answers_history) ? [...x.answers_history] : [];
    const has = uid => history.some(h => Number(h.questionIndex) === idx && h.uid === uid);
    for (const [key, uid, field] of [['host', x.player1, 'host_answered'], ['guest', x.player2, 'guest_answered']]) {
      if (uid && !has(uid) && x[field] !== true) {
        history.push({ questionIndex: idx, player: key, uid, answer: null, correct: false, points: 0, elapsedSeconds: QUESTION_SECONDS, timedOut: true, answeredAt: Date.now() });
      }
    }
    tx.update(ref, { answers_history: history, host_answered: true, guest_answered: true });
    return { ...x, answers_history: history, host_answered: true, guest_answered: true };
  });
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'GET requis' });
  try {
    const d = await requireAuth(req);
    const id = String(req.query?.matchId || '').trim();
    if (!id) return json(res, 400, { success: false, error: 'matchId manquant' });
    const admin = getAdmin();
    const db = admin.firestore();
    const ref = db.collection('quiz_matches').doc(id);
    let snap = await ref.get();
    if (!snap.exists) return json(res, 404, { success: false, error: 'Match introuvable' });
    let m = snap.data();
    if (m.player1 !== d.uid && m.player2 !== d.uid) return json(res, 403, { success: false, error: 'Accès refusé' });

    await cancelIfCriticalDisconnect(db, ref, m, admin);
    snap = await ref.get();
    if (snap.exists) m = snap.data();

    const cfg = await getAppConfig(admin);
    const questionCount = Math.max(1, Number(m.questionsLimit || cfg.pvpQuestions || 8));

    if (m.status === 'PREPARING' && m.player1 === d.uid) {
      try {
        if (Number(m.nextGenerationAt || 0) <= Date.now()) {
          await generation.generateMatchQuestions(id, d.uid);
          snap = await ref.get();
          if (snap.exists) m = snap.data();
        }
      } catch (e) {
        // The room remains visible while the generation retry backoff is active.
        console.warn('[PVP STATUS] generation:', e.message);
        snap = await ref.get();
        if (snap.exists) m = snap.data();
      }
    }

    m.id = id;
    if ((m.status === 'WAITING_GUEST' || m.status === 'waiting') && Number(m.expiresAt || 0) && Number(m.expiresAt) <= Date.now()) {
      const wager = Number(m.wager_xp || 0);
      const stake = Number(m.wager_total_xp || (wager * Math.max(1, Number(m.questionsLimit || questionCount))));
      await db.runTransaction(async tx => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) return;
        const x = fresh.data();
        if (!['WAITING_GUEST','waiting'].includes(x.status) || Number(x.expiresAt || 0) > Date.now()) return;
        const hostSnap = (stake > 0 && x.player1 && !x.wagerSettled) ? await tx.get(db.collection('users').doc(x.player1)) : null;
        tx.update(ref, { status: 'CANCELLED', cancelReason: 'expired', cancelledAt: admin.firestore.Timestamp.now() });
        if (stake > 0 && x.player1 && !x.wagerSettled) {
          const u = hostSnap?.exists ? hostSnap.data() : {};
          const xp = Number(u.quiz_xp || 0) + stake;
          tx.set(db.collection('users').doc(x.player1), { quiz_xp: xp, totalXp: Number(u.totalXp || 0) + stake, inspe_points: Number(u.inspe_points || 0) + stake, quiz_level: Math.floor(xp / 100) + 1 }, { merge: true });
          tx.update(ref, { wagerSettled: true, wagerSettlement: 'refunded' });
        }
        tx.set(db.collection('users').doc(x.player1), { pvpStatus: 'idle', pvpMatchId: null }, { merge: true });
        tx.set(db.collection('users_online').doc(x.player1), { status: 'idle', matchId: null, updatedAt: admin.firestore.Timestamp.now() }, { merge: true });
      });
      snap = await ref.get();
      if (snap.exists) m = { ...snap.data(), id };
    }

    if (m.status === 'waiting' && m.player2) {
      await ref.set({ status: 'IN_PROGRESS', questionStartTime: admin.firestore.Timestamp.now(), currentQuestionIndex: 0, questionIndex: 0, host_answered: false, guest_answered: false }, { merge: true });
      snap = await ref.get();
      if (snap.exists) m = { ...snap.data(), id };
    }

    m = await finalizeExpired(db, ref, m);
    const idx = Number(m.currentQuestionIndex ?? m.questionIndex ?? 0);
    const startMs = toMillis(m.questionStartTime);
    const elapsed = m.status === 'IN_PROGRESS' ? Math.max(0, Math.min(QUESTION_SECONDS, Math.floor((Date.now() - startMs) / 1000))) : 0;
    const remaining = Math.max(0, QUESTION_SECONDS - elapsed);
    const isHost = m.player1 === d.uid;
    const yourAnswered = isHost ? !!m.host_answered : !!m.guest_answered;
    const opponentAnswered = isHost ? !!m.guest_answered : !!m.host_answered;
    const questionsReady = Array.isArray(m.questionsPublic) && m.questionsPublic.length === questionCount;
    const canAdvance = isHost && ['IN_PROGRESS','started'].includes(m.status) && !!m.host_answered && !!m.guest_answered;

    const light = {
      success: true,
      matchId: id,
      status: m.status,
      generationStatus: m.generationStatus || null,
      generationAttempts: Number(m.generationAttempts || 0),
      lastGenerationError: m.lastGenerationError || null,
      player1: m.player1,
      player2: m.player2,
      scores: m.scores || {},
      currentQuestionIndex: idx,
      questionStartTime: m.questionStartTime || null,
      serverNow: Date.now(),
      timeRemaining: remaining,
      host_answered: !!m.host_answered,
      guest_answered: !!m.guest_answered,
      yourAnswered,
      opponentAnswered,
      canAdvance,
      lastEmote: isHost ? (m.guest_last_emote || null) : (m.host_last_emote || null),
      lastEmoteAt: m.last_emote_at || 0,
      wager_xp: Number(m.wager_xp || 0),
      wager_total_xp: Number(m.wager_total_xp || (Number(m.wager_xp || 0) * questionCount)),
      questionsLimit: questionCount,
      isHost,
      matiere: m.matiere || '',
      sa: m.sa || '',
      classe: m.classe || '',
      serie: m.serie || m.series || '',
      expiresAt: m.expiresAt || null,
      cancelReason: m.cancelReason || null,
      cancelledBy: m.cancelledBy || null,
      questionsReady
    };

    if (m.status === 'PREPARING' || m.status === 'WAITING_GUEST' || m.status === 'waiting') return json(res, 200, light);
    if (m.status === 'CANCELLED' || m.status === 'cancelled') return json(res, 200, light);
    if (m.status === 'COMPLETED' || m.status === 'finished') {
      const users = await Promise.all([m.player1, m.player2].filter(Boolean).map(async uid => {
        const us = await db.collection('users').doc(uid).get(); const u = us.exists ? us.data() : {};
        return { uid, name: u.displayName || `${u.prenom || ''} ${u.nom || ''}`.trim() || 'Élève', classe: u.classe || '', etablissement: u.etablissement || u.school || '' };
      }));
      const scores = m.scores || {};
      const a = Number(scores[m.player1] || 0), b = Number(scores[m.player2] || 0);
      const winner = a === b ? 'draw' : (a > b ? m.player1 : m.player2);
      return json(res, 200, { ...light, status: 'COMPLETED', winner, users, answers_history: Array.isArray(m.answers_history) ? m.answers_history : [], reviewQuestions: Array.isArray(m.questions) ? m.questions.map(q => ({ id:q.id, theme:q.theme||'', question:q.question, choices:q.choices, correctAnswer:q.correctAnswer, explanation:q.explanation||'', option_explanations:q.option_explanations||{} })) : [] });
    }

    return json(res, 200, { ...light, currentQuestion: Array.isArray(m.questionsPublic) ? m.questionsPublic[idx] || null : null });
  } catch (e) {
    return json(res, e.status || 500, { success: false, error: e.message || 'Statut PvP indisponible' });
  }
};
