'use strict';
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const { query, isAvailable } = require('../../lib/db');

function serializeDateValue(value) {
  try {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    if (typeof value === 'object') {
      const seconds = Number(value.seconds ?? value._seconds ?? value.epochSeconds);
      const nanos = Number(value.nanoseconds ?? value._nanoseconds ?? 0);
      if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0)).toISOString();
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch (_) {
    return null;
  }
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (!['GET','DELETE'].includes(req.method)) return json(res, 405, { success: false, error: 'GET ou DELETE requis' });
  try {
    const d = await requireAuth(req);

    if (req.method === 'DELETE') {
      const body = req.body || {};
      const sessionId = String(body.sessionId || '').trim();
      const clearAll = body.clearAll === true;
      if (!sessionId && !clearAll) return json(res, 400, { success: false, error: 'sessionId ou clearAll requis' });

      // Firestore: delete only sessions owned by the authenticated user.
      const db = getAdmin().firestore();
      if (sessionId && !sessionId.startsWith('neon:')) {
        const ref = db.collection('quiz_sessions').doc(sessionId);
        const snap = await ref.get();
        if (snap.exists && String(snap.data()?.userId || '') === String(d.uid)) await ref.delete();
      } else if (!sessionId) {
        // Explicit global clear: process finished sessions in safe batches until empty.
        while (true) {
          const snap = await db.collection('quiz_sessions').where('userId', '==', d.uid).where('status', '==', 'finished').limit(450).get().catch(() => null);
          if (!snap || snap.empty) break;
          const batch = db.batch();
          snap.docs.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
          if (snap.size < 450) break;
        }
      }

      // Neon: remove only rows belonging to the authenticated user.
      if (await isAvailable()) {
        try {
          if (sessionId && sessionId.startsWith('neon:')) {
            const rowId = Number(sessionId.slice(5));
            if (Number.isInteger(rowId) && rowId > 0) await query(`DELETE FROM quiz_results WHERE user_id = $1 AND id = $2`, [d.uid, rowId]);
          } else if (sessionId) {
            await query(`DELETE FROM quiz_results WHERE user_id = $1 AND session_id = $2`, [d.uid, sessionId]);
          } else {
            await query(`DELETE FROM quiz_results WHERE user_id = $1`, [d.uid]);
          }
        } catch (e) {
          console.warn('[HISTORY] delete neon', e.message);
        }
      }
      return json(res, 200, { success: true, deleted: true, all: clearAll });
    }

    const history = [];

    // Neon quiz_results
    if (await isAvailable()) {
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS quiz_results (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT,
            score INT,
            total INT,
            subject TEXT,
            classe TEXT,
            serie TEXT,
            session_id TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        const r = await query(
          `SELECT id, score, total, subject, classe, serie, session_id, created_at
           FROM quiz_results WHERE user_id = $1
           ORDER BY created_at DESC LIMIT 10`,
          [d.uid]
        );
        for (const row of r?.rows || []) {
          history.push({
            sessionId: row.session_id || ('neon:' + String(row.id)),
            score: row.score,
            total: row.total,
            matiere: row.subject,
            classe: row.classe,
            date: serializeDateValue(row.created_at),
            createdAt: serializeDateValue(row.created_at),
            source: 'neon'
          });
        }
      } catch (e) {
        console.warn('[HISTORY] neon', e.message);
      }
    }

    // Firestore sessions finished
    const db = getAdmin().firestore();
    const snap = await db
      .collection('quiz_sessions')
      .where('userId', '==', d.uid)
      .where('status', '==', 'finished')
      .limit(10)
      .get()
      .catch(() => null);
    if (snap) {
      for (const doc of snap.docs) {
        const s = doc.data();
        history.push({
          score: s.finalScore,
          total: s.questionsLimit,
          correct: (s.answers || []).filter((a) => a?.isCorrect).length,
          xpEarned: s.xpEarned,
          matiere: s.matiere,
          classe: s.classe,
          date: serializeDateValue(s.timestamp || s.endTime || s.createdAt),
          createdAt: serializeDateValue(s.createdAt || s.timestamp || s.endTime),
          timestamp: Number(s.timestamp || 0) || null,
          source: 'firestore',
          sessionId: doc.id
        });
      }
    }

    history.sort((a, b) => {
      const ta = new Date(a.date || a.createdAt || a.timestamp || 0).getTime();
      const tb = new Date(b.date || b.createdAt || b.timestamp || 0).getTime();
      return tb - ta;
    });

    return json(res, 200, { success: true, history: history.slice(0, 10) });
  } catch (e) {
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
