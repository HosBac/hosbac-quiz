'use strict';
const { getAdmin, json, requireAuth, requireAdmin } = require('../../lib/firebase');
const cors = require('../../lib/cors');

const ACTIVE_STATUSES = ['PREPARING','WAITING_GUEST','IN_PROGRESS','waiting','ready','started'];

async function findMatchesForUser(db, uid) {
  const [hostSnap, guestSnap] = await Promise.all([
    db.collection('quiz_matches').where('player1','==',uid).limit(100).get(),
    db.collection('quiz_matches').where('player2','==',uid).limit(100).get()
  ]);
  const map = new Map();
  for (const doc of [...hostSnap.docs,...guestSnap.docs]) {
    if (ACTIVE_STATUSES.includes(String(doc.data()?.status || ''))) map.set(doc.id, doc.id);
  }
  return [...map.keys()];
}

async function findAllActiveMatches(db) {
  const snap = await db.collection('quiz_matches').where('status','in',ACTIVE_STATUSES).get();
  return snap.docs.map(d => d.id);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success:false, error:'POST requis' });
  try {
    const body = req.body || {};
    const wantAll = body.all === true || String(body.all || '').toLowerCase() === 'true';
    const admin = wantAll ? await requireAdmin(req) : { decoded: await requireAuth(req) };
    const uid = admin.decoded.uid;
    const sdk = getAdmin();
    const db = sdk.firestore();
    const isSiteAdmin = !!admin.user;
    const matchId = String(body.matchId || '').trim();

    let ids;
    if (matchId) {
      const snap = await db.collection('quiz_matches').doc(matchId).get();
      if (!snap.exists) return json(res, 404, { success:false, error:'Match introuvable' });
      const m = snap.data() || {};
      if (!isSiteAdmin && m.player1 !== uid && m.player2 !== uid) {
        return json(res, 403, { success:false, error:'Accès refusé' });
      }
      ids = [matchId];
    } else if (wantAll && isSiteAdmin) {
      ids = await findAllActiveMatches(db);
    } else {
      ids = await findMatchesForUser(db, uid);
    }

    const cancelled = [];
    const failed = [];
    for (const id of ids) {
      try {
        const result = await require('./match').cancelMatchInternal(db, id, wantAll && isSiteAdmin ? 'admin_reset' : 'player_cancelled', uid);
        if (result?.changed || result?.status === 'CANCELLED') cancelled.push(id);
      } catch (e) {
        // A room that disappeared or was already completed is not a blocker.
        failed.push({ id, error:e.message || 'Annulation impossible' });
      }
    }

    // Always clear the caller's cache; this is what releases a ghost lock even
    // when the original match was deleted outside the normal PvP flow.
    await db.collection('users').doc(uid).set({ pvpStatus:'idle', pvpMatchId:null }, { merge:true });
    await db.collection('users_online').doc(uid).set({ status:'idle', matchId:null, updatedAt:sdk.firestore.Timestamp.now() }, { merge:true });

    return json(res, 200, { success:true, status:'CANCELLED', cancelledCount:cancelled.length, cancelledIds:cancelled, failedCount:failed.length });
  } catch (e) {
    return json(res, e.status || 500, { success:false, error:e.message || 'Annulation impossible' });
  }
};
