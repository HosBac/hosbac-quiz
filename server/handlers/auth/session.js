'use strict';

/**
 * Session unique par compte :
 * POST { sessionId } → enregistre activeSessionId
 * GET → renvoie activeSessionId courant
 * Cache court + soft-fail quota pour éviter de saturer Firestore.
 */
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const crypto = require('crypto');

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
    const uid = String(d.uid || '');
    const db = getAdmin().firestore();
    const ref = db.collection('users').doc(uid);

    if (req.method === 'GET') {
      const cached = cache.get(uid);
      if (cached && Date.now() - cached.at < CACHE_MS) {
        return json(res, 200, { ...cached.payload, cached: true });
      }
      try {
        const snap = await ref.get();
        const u = snap.exists ? snap.data() : {};
        const payload = { success: true, activeSessionId: u.activeSessionId || null };
        cache.set(uid, { at: Date.now(), payload });
        return json(res, 200, payload);
      } catch (error) {
        if (isQuotaError(error)) {
          return json(res, 200, { success: true, activeSessionId: null, quotaLimited: true });
        }
        throw error;
      }
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const sessionId = String(body.sessionId || crypto.randomUUID()).trim();
      try {
        await ref.set(
          {
            activeSessionId: sessionId,
            activeSessionAt: getAdmin().firestore.Timestamp.now()
          },
          { merge: true }
        );
      } catch (error) {
        if (isQuotaError(error)) {
          return json(res, 200, { success: true, activeSessionId: sessionId, quotaLimited: true });
        }
        throw error;
      }
      cache.set(uid, { at: Date.now(), payload: { success: true, activeSessionId: sessionId } });
      return json(res, 200, { success: true, activeSessionId: sessionId });
    }

    return json(res, 405, { success: false, error: 'GET ou POST' });
  } catch (e) {
    console.error(`[API ERROR - ${req.url}]`, e);
    if (isQuotaError(e)) {
      return json(res, 200, { success: true, activeSessionId: null, quotaLimited: true });
    }
    const status = [400, 401, 403, 405, 409].includes(Number(e?.status)) ? Number(e.status) : 200;
    return json(res, status, {
      success: false,
      error: e.message || 'Session temporairement indisponible',
      ...(status === 200 ? { activeSessionId: null } : {})
    });
  }
};
