'use strict';

const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');

const CACHE_MS = 30000;
const cache = new Map();

function isQuotaError(error) {
  const code = Number(error?.code);
  const msg = String(error?.message || error?.details || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

function nameOf(u) {
  return String(u.displayName || `${u.prenom || ''} ${u.nom || ''}`.trim() || 'Élève').trim();
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'GET requis' });

  try {
    const d = await requireAuth(req);
    const scope = String(req.query?.scope || 'regional');
    const cacheKey = `${d.uid}:${scope}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return json(res, 200, { ...cached.payload, cached: true });
    }

    const db = getAdmin().firestore();
    let me;
    try {
      me = await db.collection('users').doc(d.uid).get();
    } catch (error) {
      if (isQuotaError(error)) {
        return json(res, 200, { success: true, scope, total: 0, ranking: [], quotaLimited: true });
      }
      throw error;
    }

    if (!me.exists) {
      return json(res, 200, { success: true, scope, total: 0, ranking: [] });
    }

    const p = me.data() || {};
    let field = scope === 'school' ? 'ecole' : 'region';
    let value = String(p[field] || p.etablissement || p.school || '').trim();
    if (scope === 'school' && !value) {
      field = 'etablissement';
      value = String(p.etablissement || p.school || p.ecole || '').trim();
    }
    if (!value) {
      const payload = {
        success: true,
        scope,
        region: scope === 'regional' ? 'Région non définie' : undefined,
        school: scope === 'school' ? 'Établissement non défini' : undefined,
        total: 0,
        ranking: []
      };
      cache.set(cacheKey, { at: Date.now(), payload });
      return json(res, 200, payload);
    }

    let snap;
    try {
      // limit bas pour protéger le quota Firestore
      snap = await db.collection('users').where(field, '==', value).limit(100).get();
    } catch (error) {
      if (isQuotaError(error)) {
        return json(res, 200, { success: true, scope, total: 0, ranking: [], quotaLimited: true });
      }
      throw error;
    }

    const ranking = snap.docs
      .map((x) => {
        const data = x.data() || {};
        return {
          id: x.id,
          name: nameOf(data),
          classe: String(data.classe || data.class || ''),
          quiz_xp: Number(data.quiz_xp != null ? data.quiz_xp : data.xp || 0) || 0
        };
      })
      .sort((a, b) => b.quiz_xp - a.quiz_xp || a.name.localeCompare(b.name, 'fr'))
      .slice(0, 20);

    const payload = {
      success: true,
      scope,
      total: snap.size,
      [field]: value,
      ranking
    };
    cache.set(cacheKey, { at: Date.now(), payload });
    if (cache.size > 200) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
      oldest.forEach(([k]) => cache.delete(k));
    }
    return json(res, 200, payload);
  } catch (e) {
    console.error('[RANKING]', e);
    if (isQuotaError(e)) {
      return json(res, 200, { success: true, scope: String(req.query?.scope || 'regional'), total: 0, ranking: [], quotaLimited: true });
    }
    return json(res, e.status || 500, { success: false, error: e.message || 'Classement indisponible' });
  }
};
