'use strict';
const { json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const match = require('./match');
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });
  try {
    const d = await requireAuth(req);
    const id = String((req.body || {}).matchId || '').trim();
    if (!id) return json(res, 400, { success: false, error: 'matchId manquant' });
    return json(res, 200, await match.joinSpecific(req, d.uid, id));
  } catch (e) {
    return json(res, e.status || 500, { success: false, error: e.message || 'Impossible de rejoindre le duel' });
  }
};
