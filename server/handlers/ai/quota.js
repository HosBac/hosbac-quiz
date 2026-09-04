'use strict';

const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const { getAppConfig } = require('../../lib/app-config');

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Outils IA :
 * - Admin avec solde XP > cost → déduction, accès OK
 * - Admin sans solde → accès gratuit
 * - Élève → déduction obligatoire ou rejet
 * Config lue via Neon (prioritaire) puis Firestore
 */
module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST requis' });
  try {
    const d = await requireAuth(req);
    const db = getAdmin().firestore();
    const userRef = db.collection('users').doc(d.uid);
    const cfg = await getAppConfig(getAdmin);
    const body = req.body || {};
    const cost = Math.max(0, Number(body.cost ?? cfg.aiToolCostXP ?? 3));
    const feature = String(body.feature || 'IA').trim() || 'IA';
    const consume = Boolean(body.consume);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const u = snap.exists ? snap.data() : {};
      const isAdmin = u.role === 'admin' || u.isAdmin === true;
      const xp = Number(u.inspe_points ?? u.quiz_xp ?? 0);
      const today = dayKey();
      const usedDate = u.ai_usage_date === today ? today : null;
      const used = usedDate ? Number(u.ai_usage_count || 0) : 0;
      const limit = Math.max(1, Number(cfg.dailyAiRequests || 10));

      // Limite quotidienne : admin aussi comptabilisé s'il consomme, mais pas de blocage admin
      if (!isAdmin && used >= limit) {
        return {
          allowed: false,
          code: 'AI_DAILY_LIMIT',
          used,
          limit,
          cost,
          feature,
          error: `Limite quotidienne atteinte (${limit} utilisations IA / jour).`
        };
      }

      if (isAdmin) {
        // Admin : toujours autorisé. Déduction seulement s'il a assez de points.
        if (consume && cost > 0 && xp >= cost) {
          const remaining = Math.max(0, xp - cost);
          tx.set(
            userRef,
            {
              inspe_points: remaining,
              quiz_xp: Math.max(0, Number(u.quiz_xp || 0) - cost),
              totalXp: Math.max(0, Number(u.totalXp || 0) - cost),
              ai_usage_date: today,
              ai_usage_count: used + 1,
              ai_tool_last_cost: cost,
              ai_tool_last_feature: feature
            },
            { merge: true }
          );
          return {
            allowed: true,
            isAdmin: true,
            used: used + 1,
            limit,
            cost,
            feature,
            remainingXp: remaining,
            consumed: true,
            deducted: true
          };
        }
        if (consume) {
          tx.set(
            userRef,
            {
              ai_usage_date: today,
              ai_usage_count: used + 1,
              ai_tool_last_cost: 0,
              ai_tool_last_feature: feature
            },
            { merge: true }
          );
        }
        return {
          allowed: true,
          isAdmin: true,
          used: consume ? used + 1 : used,
          limit,
          cost: xp >= cost ? cost : 0,
          feature,
          remainingXp: xp,
          consumed: consume,
          deducted: false,
          freeAdminAccess: xp < cost
        };
      }

      // Élève
      if (cost > 0 && xp < cost) {
        return {
          allowed: false,
          code: 'XP_INSUFFICIENT',
          xp,
          cost,
          feature,
          error: `Solde de points XP insuffisant. Il faut ${cost} XP (solde : ${xp}).`
        };
      }

      if (consume) {
        const remaining = Math.max(0, xp - cost);
        tx.set(
          userRef,
          {
            ai_usage_date: today,
            ai_usage_count: used + 1,
            inspe_points: remaining,
            quiz_xp: Math.max(0, Number(u.quiz_xp || 0) - cost),
            totalXp: Math.max(0, Number(u.totalXp || 0) - cost),
            ai_tool_last_cost: cost,
            ai_tool_last_feature: feature
          },
          { merge: true }
        );
        return {
          allowed: true,
          isAdmin: false,
          used: used + 1,
          limit,
          cost,
          feature,
          remainingXp: remaining,
          consumed: true,
          deducted: true
        };
      }

      return { allowed: true, isAdmin: false, used, limit, cost, feature, xp };
    });

    if (result.allowed === false) {
      return json(res, 402, { success: false, ...result });
    }
    return json(res, 200, { success: true, ...result, configSource: cfg._source || null, dailyAiRequests: cfg.dailyAiRequests });
  } catch (e) {
    console.error('[AI QUOTA]', e);
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
