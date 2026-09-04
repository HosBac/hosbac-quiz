'use strict';

const { json, requireAdmin } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const { listAllModels, ensureAiModelsTable } = require('../../lib/ai-fallback');
const { query, isAvailable } = require('../../lib/db');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    await requireAdmin(req);
    if (!(await isAvailable())) {
      return json(res, 503, {
        success: false,
        error: 'Neon DATABASE_URL indisponible. Impossible de gérer les modèles.'
      });
    }
    await ensureAiModelsTable();

    if (req.method === 'GET') {
      const models = await listAllModels();
      return json(res, 200, { success: true, models });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const provider = String(b.provider || '').trim().toLowerCase();
      const model_name = String(b.model_name || b.modelName || '').trim();
      const env_key_name = String(b.env_key_name || b.envKeyName || '').trim();
      const priority_order = Number(b.priority_order ?? b.priorityOrder ?? 1);
      const is_active = b.is_active !== false && b.isActive !== false;
      if (!provider || !model_name || !env_key_name) {
        return json(res, 400, { success: false, error: 'provider, model_name et env_key_name requis' });
      }
      const r = await query(
        `INSERT INTO ai_models_config (provider, model_name, env_key_name, is_active, priority_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [provider, model_name, env_key_name, is_active, priority_order]
      );
      return json(res, 201, { success: true, model: r.rows[0] });
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const b = req.body || {};
      const id = Number(b.id);
      if (!id) return json(res, 400, { success: false, error: 'id requis' });
      // toggle only
      if (typeof b.is_active === 'boolean' || typeof b.isActive === 'boolean') {
        const active = typeof b.is_active === 'boolean' ? b.is_active : b.isActive;
        const r = await query(
          `UPDATE ai_models_config SET is_active = $1 WHERE id = $2 RETURNING *`,
          [active, id]
        );
        return json(res, 200, { success: true, model: r.rows[0] });
      }
      const fields = [];
      const params = [];
      let i = 1;
      for (const [key, col] of [
        ['provider', 'provider'],
        ['model_name', 'model_name'],
        ['modelName', 'model_name'],
        ['env_key_name', 'env_key_name'],
        ['envKeyName', 'env_key_name'],
        ['priority_order', 'priority_order'],
        ['priorityOrder', 'priority_order']
      ]) {
        if (b[key] !== undefined && b[key] !== null) {
          fields.push(`${col} = $${i++}`);
          params.push(b[key]);
        }
      }
      if (!fields.length) return json(res, 400, { success: false, error: 'Rien à mettre à jour' });
      params.push(id);
      const r = await query(
        `UPDATE ai_models_config SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        params
      );
      return json(res, 200, { success: true, model: r.rows[0] });
    }

    if (req.method === 'DELETE') {
      const b = req.body || {};
      const clearAll = b.clearAll === true || b.clear === true || String(req.query?.clear || '') === '1';
      if (clearAll) {
        await query(`DELETE FROM ai_models_config`);
        return json(res, 200, { success: true, cleared: true });
      }
      const id = Number(b.id || req.query?.id);
      if (!id) return json(res, 400, { success: false, error: 'id requis (ou clearAll:true pour vider la table)' });
      await query(`DELETE FROM ai_models_config WHERE id = $1`, [id]);
      return json(res, 200, { success: true, deleted: id });
    }

    return json(res, 405, { success: false, error: 'Méthode non autorisée' });
  } catch (e) {
    console.error('[ADMIN AI MODELS]', e);
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
