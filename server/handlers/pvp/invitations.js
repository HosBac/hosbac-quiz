'use strict';

const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');

// Cache court pour éviter de saturer le quota Firestore avec le polling frontend.
const CACHE_MS = 45000;
const cache = new Map();

function isQuotaError(error) {
  const code = Number(error?.code);
  const msg = String(error?.message || error?.details || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

module.exports = async function invitationsHandler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') {
    return json(res, 405, { success: false, error: 'GET requis' });
  }

  try {
    const d = await requireAuth(req);
    const uid = String(d.uid || '');

    const cached = cache.get(uid);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return json(res, 200, { ...cached.payload, cached: true });
    }

    const db = getAdmin().firestore();

    let online = {};
    try {
      const onlineSnap = await db.collection('users_online').doc(uid).get();
      online = onlineSnap.exists ? onlineSnap.data() : {};
    } catch (error) {
      if (isQuotaError(error)) {
        return json(res, 200, { success: true, invitations: [], quotaLimited: true });
      }
      throw error;
    }

    if (String(online.status || 'idle') === 'in_game') {
      const payload = { success: true, invitations: [] };
      cache.set(uid, { at: Date.now(), payload });
      return json(res, 200, payload);
    }

    let u = {};
    try {
      const uSnap = await db.collection('users').doc(uid).get();
      u = uSnap.exists ? uSnap.data() : {};
    } catch (error) {
      if (isQuotaError(error)) {
        return json(res, 200, { success: true, invitations: [], quotaLimited: true });
      }
      throw error;
    }

    const classe = String(u.classe || u.class || '').trim().toLowerCase();
    const serie = String(u.serie || '').trim().toLowerCase();
    if (!classe) {
      const payload = { success: true, invitations: [] };
      cache.set(uid, { at: Date.now(), payload });
      return json(res, 200, payload);
    }

    let snap;
    try {
      snap = await db.collection('quiz_matches').where('status', '==', 'WAITING_GUEST').limit(20).get();
    } catch (error) {
      if (isQuotaError(error)) {
        return json(res, 200, { success: true, invitations: [], quotaLimited: true });
      }
      throw error;
    }

    const now = Date.now();
    const invitations = [];

    for (const doc of snap.docs) {
      if (invitations.length >= 5) break;
      const m = doc.data();
      if (m.player1 === uid || m.player2 || Number(m.expiresAt || 0) <= now) continue;

      const matchClass = String(m.classe || m.class || '').trim().toLowerCase();
      const matchSerie = String(m.serie || m.series || '').trim().toLowerCase();
      if (matchClass !== classe || matchSerie !== serie) continue;

      const readyCount = Math.max(1, Number(m.questionsLimit || 8));
      if (!Array.isArray(m.questionsPublic) || m.questionsPublic.length !== readyCount) continue;

      let hostName = 'Élève';
      let etablissement = '';
      let hostOnline = true;
      try {
        const [p, hostOnlineSnap] = await Promise.all([
          db.collection('users').doc(m.player1).get(),
          db.collection('users_online').doc(m.player1).get()
        ]);
        const x = p.exists ? p.data() : {};
        hostName = x.displayName || `${x.prenom || ''} ${x.nom || ''}`.trim() || 'Élève';
        etablissement = x.etablissement || x.school || '';
        const hostPresence = hostOnlineSnap.exists ? hostOnlineSnap.data() : {};
        if (!['waiting', 'in_game'].includes(String(hostPresence.status || '').toLowerCase())) continue;
        hostOnline = hostPresence.status !== 'offline';
      } catch (error) {
        if (isQuotaError(error)) break;
        continue;
      }

      invitations.push({
        matchId: doc.id,
        playerId: m.player1,
        name: hostName,
        etablissement,
        classe: m.classe || classe,
        serie: matchSerie,
        matiere: m.matiere || '',
        wager_xp: Number(m.wager_xp || 0),
        expiresAt: m.expiresAt,
        hostOnline
      });
    }

    const payload = { success: true, invitations };
    cache.set(uid, { at: Date.now(), payload });
    if (cache.size > 300) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 80);
      oldest.forEach(([k]) => cache.delete(k));
    }
    return json(res, 200, payload);
  } catch (e) {
    if (isQuotaError(e)) {
      return json(res, 200, { success: true, invitations: [], quotaLimited: true });
    }
    return json(res, e.status || 500, {
      success: false,
      error: e.message || 'Invitations indisponibles'
    });
  }
};
