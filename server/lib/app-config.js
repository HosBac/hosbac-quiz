'use strict';

/**
 * Lecture centralisée de la config quiz :
 * 1) Neon app_settings
 * 2) Firestore quiz_config/global
 * 3) DEFAULT_CONFIG
 */

const { normalize, DEFAULT_CONFIG } = require('./config');
const { query, isAvailable } = require('./db');

const SETTINGS_KEY = 'global';
let cache = { at: 0, config: null };
const CACHE_MS = 60000;

async function loadFromNeon() {
  if (!(await isAvailable())) return null;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const res = await query(`SELECT data, updated_at FROM app_settings WHERE key = $1`, [SETTINGS_KEY]);
    if (res?.rows?.[0]?.data && typeof res.rows[0].data === 'object') {
      return { data: res.rows[0].data, updatedAt: res.rows[0].updated_at, source: 'neon' };
    }
  } catch (e) {
    console.warn('[APP CONFIG] Neon:', e.message);
  }
  return null;
}

async function getAppConfig(getAdmin) {
  const now = Date.now();
  if (cache.config && now - cache.at < CACHE_MS) return cache.config;

  const neon = await loadFromNeon();
  if (neon?.data) {
    const config = normalize(neon.data);
    cache = { at: now, config: { ...config, _source: 'neon', _updatedAt: neon.updatedAt } };
    return cache.config;
  }

  try {
    if (typeof getAdmin === 'function') {
      const snap = await getAdmin().firestore().collection('quiz_config').doc('global').get();
      if (snap.exists) {
        const config = normalize(snap.data() || {});
        cache = { at: now, config: { ...config, _source: 'firestore' } };
        return cache.config;
      }
    }
  } catch (e) {
    console.warn('[APP CONFIG] Firestore:', e.message);
  }

  const config = normalize({});
  cache = { at: now, config: { ...config, _source: 'default' } };
  return cache.config;
}

function invalidateAppConfigCache() {
  cache = { at: 0, config: null };
}

module.exports = {
  getAppConfig,
  loadFromNeon,
  invalidateAppConfigCache,
  SETTINGS_KEY,
  DEFAULT_CONFIG
};
