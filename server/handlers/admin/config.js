'use strict';

const { getAdmin, json, requireAdmin } = require('../../lib/firebase');
const { normalize } = require('../../lib/config');
const cors = require('../../lib/cors');
const { query, isAvailable } = require('../../lib/db');
const { invalidateAppConfigCache } = require('../../lib/app-config');

const SETTINGS_KEY = 'global';

async function ensureSettingsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadFromNeon() {
  if (!(await isAvailable())) return null;
  try {
    await ensureSettingsTable();
    const res = await query(`SELECT data, updated_at FROM app_settings WHERE key = $1`, [SETTINGS_KEY]);
    if (res?.rows?.[0]?.data) {
      return {
        data: res.rows[0].data,
        updatedAt: res.rows[0].updated_at
      };
    }
  } catch (e) {
    console.warn('[ADMIN CONFIG] Neon read:', e.message);
  }
  return null;
}

async function saveToNeon(config) {
  if (!(await isAvailable())) return false;
  try {
    await ensureSettingsTable();
    const payload={
      ...config,
      dailyAiRequests:Number(config.dailyAiRequests),
      daily_requests_limit:Number(config.dailyAiRequests),
      daily_ai_limit:Number(config.dailyAiRequests)
    };
    await query(
      `INSERT INTO app_settings (key, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [SETTINGS_KEY, JSON.stringify(payload)]
    );
    return true;
  } catch (e) {
    console.warn('[ADMIN CONFIG] Neon write:', e.message);
    return false;
  }
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    await requireAdmin(req);
    const db = getAdmin().firestore();
    const ref = db.collection('quiz_config').doc('global');

    if (req.method === 'GET') {
      // Priorité Neon, puis Firestore
      const neon = await loadFromNeon();
      if (neon?.data && typeof neon.data === 'object') {
        const config = normalize(neon.data);
        return json(res, 200, {
          success: true,
          config,
          serverSaved: true,
          source: 'neon',
          updatedAt: neon.updatedAt || null
        });
      }
      const s = await ref.get();
      const raw = s.exists ? s.data() : {};
      const config = normalize(raw);
      const updatedAt = raw.updatedAt || null;
      return json(res, 200, {
        success: true,
        config,
        serverSaved: s.exists,
        source: s.exists ? 'firestore' : 'default',
        updatedAt
      });
    }

    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      const current = await ref.get();
      const incoming = req.body && typeof req.body === 'object' ? req.body : {};
      // Ne pas écraser avec des undefined
      const cleaned = {};
      for (const [k, v] of Object.entries(incoming)) {
        if (v !== undefined && v !== null && k !== 'updatedAt') cleaned[k] = v;
      }
      // Alias champs formulaires / SQL
      if (cleaned.daily_ai_limit != null && cleaned.dailyAiRequests == null) cleaned.dailyAiRequests = Number(cleaned.daily_ai_limit);
      if (cleaned.dailyAiLimit != null && cleaned.dailyAiRequests == null) cleaned.dailyAiRequests = Number(cleaned.dailyAiLimit);
      if (cleaned.ai_tool_cost != null && cleaned.aiToolCostXP == null) cleaned.aiToolCostXP = Number(cleaned.ai_tool_cost);
      if (cleaned.base_xp != null && cleaned.baseXP == null) cleaned.baseXP = Number(cleaned.base_xp);
      if (cleaned.default_xp_per_correct_answer != null && cleaned.baseXP == null) cleaned.baseXP = Number(cleaned.default_xp_per_correct_answer);
      if (cleaned.questions_per_quiz != null && cleaned.questionsPerQuiz == null) cleaned.questionsPerQuiz = Number(cleaned.questions_per_quiz);
      if (cleaned.daily_quiz_limit != null && cleaned.dailyQuizLimit == null) cleaned.dailyQuizLimit = Number(cleaned.daily_quiz_limit);
      if (cleaned.pvp_entry_xp != null && cleaned.pvpEntryXP == null) cleaned.pvpEntryXP = Number(cleaned.pvp_entry_xp);
      if (cleaned.pvp_questions != null && cleaned.pvpQuestions == null) cleaned.pvpQuestions = Number(cleaned.pvp_questions);
      if (cleaned.pvp_daily_limit != null && cleaned.pvpDailyLimit == null) cleaned.pvpDailyLimit = Number(cleaned.pvp_daily_limit);
      if (cleaned.pvp_xp_per_question != null && cleaned.pvpXPPerQuestion == null) cleaned.pvpXPPerQuestion = Number(cleaned.pvp_xp_per_question);
      if (cleaned.pvpEntryXP != null) cleaned.pvpEntryXP = Math.max(0, Math.min(100000, Number(cleaned.pvpEntryXP) || 0));
      if (cleaned.pvpQuestions != null) cleaned.pvpQuestions = Math.max(1, Math.min(30, Number(cleaned.pvpQuestions) || 8));
      if (cleaned.pvpDailyLimit != null) cleaned.pvpDailyLimit = Math.max(1, Math.min(100, Number(cleaned.pvpDailyLimit) || 3));
      if (cleaned.pvpXPPerQuestion != null) cleaned.pvpXPPerQuestion = Math.max(0, Math.min(1000, Number(cleaned.pvpXPPerQuestion) || 1));
      const base = current.exists ? current.data() : {};
      const c = normalize({ ...base, ...cleaned });
      const updatedAt = getAdmin().firestore.Timestamp.now();
      await ref.set({ ...c, updatedAt }, { merge: false }); // replace full config doc

      const neonOk = await saveToNeon(c);
      const verified = await ref.get();
      const verifiedConfig = normalize(verified.exists ? verified.data() : c);

      // Relecture Neon pour confirmer
      const neonAfter = await loadFromNeon();
      const finalConfig = neonAfter?.data
        ? normalize(neonAfter.data)
        : verifiedConfig;

      invalidateAppConfigCache();
      return json(res, 200, {
        success: true,
        config: finalConfig,
        dailyAiRequests: finalConfig.dailyAiRequests,
        serverSaved: true,
        neonSaved: neonOk,
        source: neonOk ? 'neon+firestore' : 'firestore',
        updatedAt: verified.exists ? verified.data()?.updatedAt || updatedAt : updatedAt
      });
    }

    return json(res, 405, { success: false, error: 'Méthode non autorisée' });
  } catch (e) {
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
