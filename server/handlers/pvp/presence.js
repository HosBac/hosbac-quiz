'use strict';

const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const pvpMatch = require('./match');

// Cache GET presence pour limiter les lectures Firestore (polling frontend).
const CACHE_MS = 30000;
const cache = new Map();

function isQuotaError(error) {
  const code = Number(error?.code);
  const msg = String(error?.message || error?.details || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const d = await requireAuth(req);
    const admin = getAdmin();
    const db = admin.firestore();
    const uid = String(d.uid || '');

    if (req.method === 'GET') {
      const cached = cache.get(uid);
      if (cached && Date.now() - cached.at < CACHE_MS) {
        return json(res, 200, { ...cached.payload, cached: true });
      }

      let u = {};
      try {
        const snap = await db.collection('users').doc(uid).get();
        u = snap.exists ? snap.data() : {};
      } catch (error) {
        if (isQuotaError(error)) {
          return json(res, 200, { success: true, status: 'idle', matchId: null, inProgress: false, active: false, quotaLimited: true });
        }
        throw error;
      }

      const storedStatus = String(u.pvpStatus || 'idle').toLowerCase();
      const storedMatchId = u.pvpMatchId ? String(u.pvpMatchId) : null;

      let activeMatch = null;
      try {
        activeMatch = await pvpMatch.findActiveForUser(db, uid);
      } catch (error) {
        if (isQuotaError(error)) {
          return json(res, 200, {
            success: true,
            status: storedStatus === 'in_game' ? 'in_game' : (storedStatus === 'waiting' ? 'waiting' : 'idle'),
            matchId: storedMatchId,
            inProgress: storedStatus === 'in_game',
            active: storedStatus === 'in_game' || storedStatus === 'waiting',
            quotaLimited: true
          });
        }
        throw error;
      }

      if (activeMatch) {
        const id = activeMatch.id;
        const matchStatus = String(activeMatch.status || '').toUpperCase();
        const inProgress = matchStatus === 'IN_PROGRESS' || matchStatus === 'STARTED';
        const nextStatus = inProgress ? 'in_game' : 'waiting';
        // Réparer le cache présence seulement si nécessaire (évite écritures à chaque poll)
        if (storedMatchId !== id || storedStatus !== nextStatus) {
          try {
            await db.collection('users').doc(uid).set({ pvpStatus: nextStatus, pvpMatchId: id }, { merge: true });
          } catch (error) {
            if (!isQuotaError(error)) throw error;
          }
        }
        const payload = { success: true, status: nextStatus, matchId: id, inProgress, active: true };
        cache.set(uid, { at: Date.now(), payload });
        return json(res, 200, payload);
      }

      // Pas de match actif : nettoyer seulement si vraiment stale
      if (storedStatus !== 'idle' || storedMatchId) {
        try {
          await db.collection('users').doc(uid).set({ pvpStatus: 'idle', pvpMatchId: null }, { merge: true });
          await db.collection('users_online').doc(uid).set({
            status: 'idle',
            matchId: null,
            updatedAt: admin.firestore.Timestamp.now()
          }, { merge: true });
        } catch (error) {
          if (!isQuotaError(error)) throw error;
        }
      }

      const payload = { success: true, status: 'idle', matchId: null, inProgress: false, active: false, staleCleared: true };
      cache.set(uid, { at: Date.now(), payload });
      if (cache.size > 400) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
        oldest.forEach(([k]) => cache.delete(k));
      }
      return json(res, 200, payload);
    }

    if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });

    const body = req.body || {};
    let status = String(body.status || 'idle').toLowerCase();
    if (status !== 'idle' && status !== 'in_game') status = 'idle';
    const matchId = body.matchId ? String(body.matchId) : null;
    const now = admin.firestore.Timestamp.now();
    await db.collection('users_online').doc(uid).set({
      uid,
      status,
      matchId: status === 'in_game' ? matchId : null,
      classe: String(body.classe || ''),
      serie: String(body.serie || ''),
      updatedAt: now
    }, { merge: true });
    await db.collection('users').doc(uid).set({
      pvpStatus: status,
      pvpMatchId: status === 'idle' ? null : matchId
    }, { merge: true });
    cache.delete(uid);
    return json(res, 200, { success: true, status, matchId: status === 'idle' ? null : matchId });
  } catch (e) {
    console.error(`[API ERROR - ${req.url}]`, e);
    if (isQuotaError(e)) {
      return json(res, 200, { success: true, status: 'idle', matchId: null, inProgress: false, active: false, quotaLimited: true });
    }
    const status = [400, 401, 403, 405, 409, 429].includes(Number(e?.status)) ? Number(e.status) : 200;
    return json(res, status, {
      success: false,
      error: e.message || 'Présence PvP temporairement indisponible',
      ...(status === 200 ? { status: 'idle', active: false, matchId: null } : {})
    });
  }
};
