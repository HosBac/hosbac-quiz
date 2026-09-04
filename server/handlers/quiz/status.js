'use strict';

const { getAdmin, json } = require('../../lib/firebase');
const { getAppConfig } = require('../../lib/app-config');
const { DEFAULT_CONFIG, normalize } = require('../../lib/config');
const cors = require('../../lib/cors');

const CACHE_MS = 60000;
const cache = new Map();

function isQuotaError(error) {
  const code = Number(error?.code);
  const msg = String(error?.message || error?.details || '');
  return code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(msg);
}

function extractBearer(req) {
  const raw = String(req?.headers?.authorization || '').trim();
  if (!raw || !/^Bearer\s+\S+$/i.test(raw)) return null;
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (token.length < 20 || token.length > 10000) return null;
  return token;
}

/**
 * Normalise les champs profil HosBac (variantes de noms utilisées dans l'écosystème).
 */
function normalizeProfile(uid, raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const prenom = String(d.prenom || d.firstName || d.first_name || '').trim();
  const nom = String(d.nom || d.lastName || d.last_name || '').trim();
  const displayName = String(
    d.displayName || d.name || [prenom, nom].filter(Boolean).join(' ') || 'Élève'
  ).trim();
  const classe = String(d.classe || d.class || d.level || d.niveau || '').trim();
  const serie = String(d.serie || d.series || d.filiere || '').trim();
  const etablissement = String(d.etablissement || d.ecole || d.school || d.etab || '').trim();
  const region = String(d.region || d.regionName || '').trim();
  const quiz_xp = Number(
    d.quiz_xp != null ? d.quiz_xp :
    d.xp != null ? d.xp :
    d.quizXp != null ? d.quizXp :
    d.points != null ? d.points : 0
  ) || 0;
  const quiz_level = Number(d.quiz_level != null ? d.quiz_level : d.level != null ? d.level : 1) || 1;
  const quiz_streak = Number(d.quiz_streak != null ? d.quiz_streak : d.streak != null ? d.streak : 0) || 0;

  return {
    ...d,
    uid,
    prenom,
    nom,
    displayName,
    name: displayName,
    classe,
    class: classe,
    serie,
    etablissement,
    ecole: etablissement,
    school: etablissement,
    region,
    quiz_xp,
    xp: quiz_xp,
    quiz_level,
    quiz_streak,
    role: d.role || (d.isAdmin === true ? 'admin' : 'student'),
    isAdmin: d.isAdmin === true || d.role === 'admin',
    quiz_subscription: d.quiz_subscription || d.subscription || null
  };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { success: false, error: 'GET requis' });

  try {
    const idToken = extractBearer(req);
    if (!idToken) return json(res, 401, { success: false, error: 'Unauthorized' });

    const admin = getAdmin();
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (authError) {
      console.warn('[QUIZ STATUS AUTH]', authError?.message || authError);
      return json(res, 401, { success: false, error: 'Unauthorized' });
    }

    const uid = String(decoded.uid || '').trim();
    if (!uid) return json(res, 401, { success: false, error: 'Unauthorized' });

    const cached = cache.get(uid);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return json(res, 200, { ...cached.payload, cached: true });
    }

    const db = admin.firestore();

    // Lecture profil isolée (ne doit jamais être bloquée par la config)
    let rawProfile = {};
    let profileExists = false;
    try {
      const uSnap = await db.collection('users').doc(uid).get();
      profileExists = uSnap.exists;
      rawProfile = uSnap.exists ? (uSnap.data() || {}) : {};
    } catch (error) {
      console.error('[QUIZ STATUS] Firestore user read:', error?.message || error);
      if (isQuotaError(error)) {
        return json(res, 200, {
          success: true,
          profile: normalizeProfile(uid, {
            displayName: decoded.name || decoded.email || 'Élève',
            email: decoded.email || ''
          }),
          config: normalize(DEFAULT_CONFIG),
          quotaLimited: true,
          warning: 'Quota Firestore — profil minimal'
        });
      }
      // continue with empty raw profile
    }

    // Config isolée (Neon / Firestore config / defaults)
    let config = normalize(DEFAULT_CONFIG);
    try {
      config = await getAppConfig(() => admin);
    } catch (error) {
      console.warn('[QUIZ STATUS] getAppConfig:', error?.message || error);
      config = normalize(DEFAULT_CONFIG);
    }

    const profile = normalizeProfile(uid, {
      ...rawProfile,
      email: rawProfile.email || decoded.email || '',
      displayName: rawProfile.displayName || decoded.name || rawProfile.name
    });

    // Si le doc n'existe pas encore, créer un squelette minimal (une seule fois)
    if (!profileExists) {
      try {
        const seed = {
          uid,
          email: profile.email || '',
          displayName: profile.displayName || 'Élève',
          prenom: profile.prenom || '',
          nom: profile.nom || '',
          quiz_xp: 0,
          quiz_level: 1,
          quiz_streak: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('users').doc(uid).set(seed, { merge: true });
      } catch (error) {
        console.warn('[QUIZ STATUS] seed user doc:', error?.message || error);
      }
    }

    const payload = {
      success: true,
      profile,
      config,
      profileExists
    };
    cache.set(uid, { at: Date.now(), payload });
    if (cache.size > 500) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      oldest.forEach(([k]) => cache.delete(k));
    }
    return json(res, 200, payload);
  } catch (error) {
    console.error('[QUIZ STATUS ERROR]', error);
    if (error?.status === 401) return json(res, 401, { success: false, error: 'Unauthorized' });
    return json(res, 200, {
      success: true,
      profile: { uid: '', displayName: 'Élève', classe: '', quiz_xp: 0, quiz_level: 1 },
      config: normalize(DEFAULT_CONFIG),
      error: 'Statut du quiz temporairement indisponible.'
    });
  }
};
