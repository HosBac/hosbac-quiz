'use strict';

const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const { getAppConfig } = require('../../lib/app-config');
const cors = require('../../lib/cors');
const crypto = require('crypto');
const { PVP_QUESTION_COUNT } = require('./question-bank');

const ACTIVE_STATUSES = new Set(['PREPARING', 'WAITING_GUEST', 'IN_PROGRESS', 'waiting', 'ready', 'started']);

function nowMs() { return Date.now(); }
function ts(admin) { return admin.firestore.Timestamp.now(); }
function uidInMatch(m, uid) { return m.player1 === uid || m.player2 === uid; }
function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v._seconds === 'number') return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  return Number(v) || 0;
}

async function readUser(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? snap.data() : {};
}

function normalizeProfileValue(value) {
  return String(value || '').trim().toLowerCase();
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(String(status || ''));
}

function isExpiredMatch(match) {
  const expiresAt = Number(match?.expiresAt || 0);
  if (expiresAt > 0) return expiresAt <= nowMs();
  // Legacy rooms created before the PvP expiry field existed must not be able
  // to lock a user forever. Waiting/preparing rooms are short-lived; an
  // in-progress room without a timer is treated as stale only after 2 hours.
  const createdAt = toMillis(match?.createdAt);
  if (!createdAt) return false;
  const age = nowMs() - createdAt;
  const status = String(match?.status || '').toUpperCase();
  const maxAge = ['PREPARING','WAITING_GUEST','WAITING','READY'].includes(status) ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000;
  return age >= maxAge;
}

async function countDailyPvpParticipation(db, uid) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const [hostSnap, guestSnap] = await Promise.all([
    db.collection('quiz_matches').where('player1', '==', uid).limit(200).get(),
    db.collection('quiz_matches').where('player2', '==', uid).limit(200).get()
  ]);
  const ids = new Set();
  for (const snap of [hostSnap, guestSnap]) {
    for (const doc of snap.docs) {
      const m = doc.data() || {};
      if (toMillis(m.createdAt) >= startMs) ids.add(doc.id);
    }
  }
  return ids.size;
}

async function refundWager(db, match, admin) {
  const wager = Number(match?.wager_xp || 0);
  const count = Math.max(1, Number(match?.questionsLimit || 8));
  const stake = Number(match?.wager_total_xp || (wager * count));
  if (!match || stake <= 0 || match.wagerSettled) return;
  const batch = db.batch();
  for (const uid of [match.player1, match.player2].filter(Boolean)) {
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    const u = snap.exists ? snap.data() : {};
    const xp = Number(u.quiz_xp || 0) + stake;
    batch.set(ref, {
      quiz_xp: xp,
      totalXp: Number(u.totalXp || 0) + stake,
      inspe_points: Number(u.inspe_points || 0) + stake,
      quiz_level: Math.floor(xp / 100) + 1
    }, { merge: true });
  }
  batch.set(db.collection('quiz_matches').doc(match.id), { wagerSettled: true, wagerSettlement: 'refunded' }, { merge: true });
  await batch.commit();
}

async function cancelMatchInternal(db, matchId, reason = 'cancelled', actorUid = null) {
  const admin = getAdmin();
  const ref = db.collection('quiz_matches').doc(matchId);
  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { changed:false };
    const m = snap.data() || {};
    if (['finished','COMPLETED','CANCELLED','cancelled'].includes(m.status)) return { changed:false,status:m.status };

    const wager = Number(m.wager_xp || 0);
    const questionCount = Math.max(1, Number(m.questionsLimit || 8));
    const stake = Number(m.wager_total_xp || (wager * questionCount));
    const playerIds = [m.player1,m.player2].filter(Boolean);
    const userSnaps = new Map();
    for (const uid of playerIds) userSnaps.set(uid, await tx.get(db.collection('users').doc(uid)));

    tx.update(ref, { status:'CANCELLED', cancelReason:reason, cancelledBy:actorUid || null, cancelledAt:ts(admin) });
    const hostReserved = stake > 0 && (m.hostWagerReserved === true || m.hostWagerReserved == null);
    const guestReserved = stake > 0 && !!m.player2 && (m.guestWagerReserved === true || m.guestWagerReserved == null);
    if (stake > 0 && !m.wagerSettled && (hostReserved || guestReserved)) tx.update(ref, { wagerSettled:true, wagerSettlement:'refunded' });

    for (const uid of playerIds) {
      const us = userSnaps.get(uid);
      const u = us?.exists ? us.data() : {};
      const isHost = uid === m.player1;
      const shouldRefund = isHost ? hostReserved : guestReserved;
      if (shouldRefund && !m.wagerSettled) {
        const xp = Number(u.quiz_xp || 0) + stake;
        tx.set(db.collection('users').doc(uid), { quiz_xp:xp, totalXp:Number(u.totalXp||0)+stake, inspe_points:Number(u.inspe_points||0)+stake, quiz_level:Math.floor(xp/100)+1, pvpStatus:'idle', pvpMatchId:null }, { merge:true });
      } else {
        tx.set(db.collection('users').doc(uid), { pvpStatus:'idle', pvpMatchId:null }, { merge:true });
      }
    }
    return { changed:true,status:'CANCELLED',match:{...m,id:matchId,status:'CANCELLED'} };
  });
  const users = [result.match?.player1,result.match?.player2].filter(Boolean);
  if (users.length) {
    const batch=db.batch();
    for (const uid of users) batch.set(db.collection('users_online').doc(uid), { status:'idle',matchId:null,updatedAt:ts(admin) }, { merge:true });
    await batch.commit();
  }
  return result;
}


async function findActiveForUser(db, uid) {
  const [hostSnap, guestSnap] = await Promise.all([
    db.collection('quiz_matches').where('player1', '==', uid).limit(50).get(),
    db.collection('quiz_matches').where('player2', '==', uid).limit(50).get()
  ]);
  const all = [...hostSnap.docs, ...guestSnap.docs].map(d => ({ id: d.id, ...d.data() }))
    .filter(m => isActiveStatus(m.status));
  const live = all.filter(m => !isExpiredMatch(m));
  if (live.length) return live.sort((a,b) => toMillis(b.createdAt) - toMillis(a.createdAt))[0];

  // Expired PREPARING/WAITING rooms are not active. Mark them cancelled and
  // let the normal cancellation/refund path restore any reserved wager.
  for (const stale of all.filter(isExpiredMatch)) {
    try { await cancelMatchInternal(db, stale.id, 'expired'); } catch (e) { console.warn('[PVP ACTIVE CLEANUP]', e.message); }
  }
  return null;
}

async function setPresenceForPlayers(db, users, matchId, admin) {
  const batch = db.batch();
  for (const uid of users.filter(Boolean)) {
    batch.set(db.collection('users_online').doc(uid), { uid, status: 'in_game', matchId, updatedAt: ts(admin) }, { merge: true });
    batch.set(db.collection('users').doc(uid), { pvpStatus: 'in_game', pvpMatchId: matchId }, { merge: true });
  }
  await batch.commit();
}

async function joinSpecific(req, uid, matchId) {
  const admin = getAdmin();
  const db = admin.firestore();
  const ref = db.collection('quiz_matches').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('Salon introuvable'), { status: 404 });
  const m = snap.data();
  if (m.player1 === uid) return buildJoinResponse(m, matchId, 'host');
  if (m.player2 && m.player2 !== uid) throw Object.assign(new Error('Ce duel est déjà complet.'), { status: 409 });
  if (!['WAITING_GUEST', 'waiting'].includes(m.status)) {
    if (m.status === 'PREPARING') throw Object.assign(new Error('Le duel prépare encore ses questions. Réessaie dans quelques secondes.'), { status: 409 });
    throw Object.assign(new Error('Ce duel n’est plus disponible.'), { status: 409 });
  }
  if (Number(m.expiresAt || 0) && Number(m.expiresAt) <= nowMs()) throw Object.assign(new Error('Ce salon a expiré.'), { status: 410 });

  const guest = await readUser(db, uid);
  const guestClass = normalizeProfileValue(guest.classe || guest.class);
  const guestSerie = normalizeProfileValue(guest.serie);
  if (guestClass !== normalizeProfileValue(m.classe) || guestSerie !== normalizeProfileValue(m.serie || m.series)) {
    throw Object.assign(new Error('Ce duel est réservé aux élèves de la même classe et de la même série.'), { status: 403 });
  }

  const active = await findActiveForUser(db, uid);
  if (active && active.id !== matchId) throw Object.assign(new Error('Tu as déjà un duel actif. Termine ou quitte-le avant de rejoindre ce duel.'), { status: 409 });

  const cfg = await getAppConfig(admin);
  const dailyLimit = Math.max(1, Number(cfg.pvpDailyLimit || 3));
  const usedToday = await countDailyPvpParticipation(db, uid);
  if (usedToday >= dailyLimit) throw Object.assign(new Error(`Limite PvP quotidienne atteinte (${dailyLimit} duel(s)).`), { status: 429 });

  const questionsLimit = Math.max(1, Number(m.questionsLimit || cfg.pvpQuestions || PVP_QUESTION_COUNT));
  if (!Array.isArray(m.questions) || m.questions.length !== questionsLimit) throw Object.assign(new Error('Les questions du duel ne sont pas encore prêtes.'), { status: 409 });

  const wager = Number(m.wager_xp || 0);
  const stake = Number(m.wager_total_xp || (wager * questionsLimit));
  const guestRef = db.collection('users').doc(uid);
  const result = await db.runTransaction(async tx => {
    const userSnap = await tx.get(guestRef);
    const u = userSnap.exists ? userSnap.data() : {};
    const xp = Number(u.quiz_xp ?? u.inspe_points ?? 0);
    if (xp < stake) return { ok: false, xp, required: stake };
    if (stake > 0) {
      tx.set(guestRef, {
        quiz_xp: xp - stake,
        totalXp: Math.max(0, Number(u.totalXp || 0) - stake),
        inspe_points: Math.max(0, Number(u.inspe_points || 0) - stake),
        quiz_level: Math.floor(Math.max(0, xp - stake) / 100) + 1
      }, { merge: true });
    }
    tx.update(ref, {
      player2: uid,
      status: 'IN_PROGRESS',
      joinedAt: ts(admin),
      questionStartTime: ts(admin),
      host_answered: false,
      guest_answered: false,
      currentQuestionIndex: 0,
      questionIndex: 0,
      guestWagerReserved: stake > 0,
      wager_total_xp: stake
    });
    return { ok: true };
  });
  if (!result.ok) throw Object.assign(new Error(`XP insuffisants pour rejoindre ce duel. Il faut ${Number(result.required || stake)} XP pour cette mise.`), { status: 402, code:'XP_INSUFFICIENT_PVP' });
  await setPresenceForPlayers(db, [m.player1, uid], matchId, admin);
  return buildJoinResponse({ ...m, player2: uid, status: 'IN_PROGRESS' }, matchId, 'guest');
}

function buildJoinResponse(m, matchId, role) {
  const count = Math.max(1, Number(m.questionsLimit || m.questions?.length || PVP_QUESTION_COUNT));
  return {
    success: true,
    matchId,
    status: m.status,
    role,
    player1: m.player1,
    player2: m.player2,
    matiere: m.matiere || '',
    sa: m.sa || '',
    classe: m.classe || '',
    serie: m.serie || m.series || '',
    wager_xp: Number(m.wager_xp || 0),
    wager_total_xp: Number(m.wager_total_xp || (Number(m.wager_xp || 0) * count)),
    questionsReady: Array.isArray(m.questions) && m.questions.length === count,
    questions: role === 'guest' && Array.isArray(m.questionsPublic) ? m.questionsPublic : undefined,
    questionsCount: count,
    currentQuestionIndex: Number(m.currentQuestionIndex ?? m.questionIndex ?? 0),
    questionStartTime: m.questionStartTime || null
  };
}

async function createMatch(req, uid) {
  const admin = getAdmin();
  const db = admin.firestore();
  const b = req.body || {};
  const classe = String(b.classe || '').trim();
  const serie = String(b.serie || b.series || '').trim();
  const matiere = String(b.matiere || '').trim();
  const sa = String(b.sa || b.chapitre || '').trim();
  if (!classe) throw Object.assign(new Error('Classe manquante'), { status: 400 });
  if (!matiere) throw Object.assign(new Error('Matière manquante'), { status: 400 });

  const cfg = await getAppConfig(admin);
  const configuredEntryXP = Math.max(0, Number(cfg.pvpEntryXP ?? 0));
  const rawWager = b.wager_xp;
  const wager = rawWager === undefined || rawWager === null || String(rawWager).trim() === ''
    ? configuredEntryXP
    : Number(rawWager);
  if (!Number.isInteger(wager) || wager < 0 || wager > 100000) {
    throw Object.assign(new Error('La mise XP doit être un nombre entier compris entre 0 et 100000 XP.'), { status: 400 });
  }
  const questionsLimit = Math.max(1, Math.min(30, Number(cfg.pvpQuestions || PVP_QUESTION_COUNT)));
  const stake = wager * questionsLimit;
  const dailyLimit = Math.max(1, Number(cfg.pvpDailyLimit || 3));
  const availableUser = await readUser(db, uid);
  const profileClass = normalizeProfileValue(availableUser.classe || availableUser.class);
  const profileSerie = normalizeProfileValue(availableUser.serie);
  if (profileClass && profileClass !== normalizeProfileValue(classe)) throw Object.assign(new Error('La classe du duel doit correspondre à ton profil.'), { status: 400 });
  if (profileSerie !== normalizeProfileValue(serie)) throw Object.assign(new Error('La série du duel doit correspondre à ton profil.'), { status: 400 });

  const active = await findActiveForUser(db, uid);
  if (active) throw Object.assign(new Error('Tu as déjà un duel PvP en cours. Termine-le ou quitte-le avant d’en lancer un autre.'), { status: 409 });

  const usedToday = await countDailyPvpParticipation(db, uid);
  if (usedToday >= dailyLimit) throw Object.assign(new Error(`Limite PvP quotidienne atteinte (${dailyLimit} duel(s)).`), { status: 429 });

  const availableXp = Number(availableUser.quiz_xp ?? availableUser.inspe_points ?? 0);
  if (availableXp < stake) throw Object.assign(new Error(`XP insuffisant. Il faut ${stake} XP pour lancer ce duel (${wager} XP × ${questionsLimit} questions).`), { status: 402 });

  const ref = db.collection('quiz_matches').doc(crypto.randomUUID());
  const createdAt = ts(admin);
  const expiresAt = nowMs() + Number(cfg.pvpMinutes || 10) * 60 * 1000;

  await db.runTransaction(async tx => {
    const userRef = db.collection('users').doc(uid);
    const uSnap = await tx.get(userRef);
    const u = uSnap.exists ? uSnap.data() : {};
    const xp = Number(u.quiz_xp ?? u.inspe_points ?? 0);
    if (xp < stake) throw Object.assign(new Error(`XP insuffisant. Il faut ${stake} XP pour lancer ce duel (${wager} XP × ${questionsLimit} questions).`), { status: 402 });
    // The full per-question stake is reserved atomically with room creation, preventing two
    // rapid clicks from spending the same XP balance twice.
    if (stake > 0) {
      tx.set(userRef, {
        quiz_xp: xp - stake,
        totalXp: Math.max(0, Number(u.totalXp || 0) - stake),
        inspe_points: Math.max(0, Number(u.inspe_points || 0) - stake),
        quiz_level: Math.floor(Math.max(0, xp - stake) / 100) + 1,
        pvpStatus:'waiting',
        pvpMatchId:ref.id
      }, { merge: true });
    } else {
      tx.set(userRef, { pvpStatus:'waiting', pvpMatchId:ref.id }, { merge:true });
    }
    tx.set(db.collection('users_online').doc(uid), { uid, status:'waiting', matchId:ref.id, classe, serie, updatedAt:ts(admin) }, { merge:true });
    tx.create(ref, {
      player1: uid,
      player2: null,
      status: 'PREPARING',
      generationStatus: 'IDLE',
      generationAttempts: 0,
      lastGenerationError: null,
      nextGenerationAt: 0,
      series: serie,
      serie,
      classe,
      matiere,
      sa,
      createdAt,
      expiresAt,
      questions: [],
      questionsPublic: [],
      questionsLimit,
      currentQuestionIndex: 0,
      questionIndex: 0,
      questionStartTime: null,
      host_score: 0,
      guest_score: 0,
      scores: { [uid]: 0 },
      host_answered: false,
      guest_answered: false,
      host_last_emote: null,
      guest_last_emote: null,
      last_emote_at: null,
      answers_history: [],
      wager_xp: wager,
      wager_total_xp: stake,
      wagerSettled: stake === 0,
      hostWagerReserved: stake > 0,
      generatedBy: null,
      generatedAt: null,
      version: '31.3.27'
    });
  });

  // Best-effort background kick. The polling status endpoint remains the reliable trigger.
  try {
    const gen = require('./generate-questions');
    if (typeof gen.generateMatchQuestions === 'function') {
      Promise.resolve().then(() => gen.generateMatchQuestions(ref.id, uid)).catch(e => console.warn('[PVP CREATE] background generation:', e.message));
    }
  } catch (e) {
    console.warn('[PVP CREATE] background trigger unavailable:', e.message);
  }

  return {
    success: true,
    matchId: ref.id,
    status: 'PREPARING',
    role: 'host',
    expiresAt,
    matiere,
    sa,
    classe,
    serie,
    wager_xp: wager,
    wager_total_xp: stake,
    questionsReady: false,
    questionsCount: questionsLimit,
    inviteUrl: `/quiz?pvp_room=${encodeURIComponent(ref.id)}`
  };
}

async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });
  try {
    const d = await requireAuth(req);
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();
    if (action === 'join' || body.matchId) return json(res, 200, await joinSpecific(req, d.uid, String(body.matchId).trim()));
    return json(res, 200, await createMatch(req, d.uid));
  } catch (e) {
    console.error('[PVP MATCH]', e);
    return json(res, e.status || 500, { success: false, error: e.message || 'Erreur PvP' });
  }
}

handler.joinSpecific = joinSpecific;
handler.createMatch = createMatch;
handler.findActiveForUser = findActiveForUser;
handler.cancelMatchInternal = cancelMatchInternal;
module.exports = handler;
