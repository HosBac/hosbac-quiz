'use strict';

/**
 * HosBac Quiz V12 — Connexion Neon PostgreSQL
 * Utilisé UNIQUEMENT pour le RAG et les résultats de quiz.
 * Auth / sessions / users restent sur Firebase.
 *
 * Fallback silencieux : si DATABASE_URL est absente ou Neon indisponible,
 * les fonctions retournent null / [] sans faire planter le serveur.
 */

const { Pool } = require('pg');

let pool = null;
let poolError = null;

function getPool() {
  if (pool) return pool;
  if (poolError) return null;

  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    poolError = new Error('DATABASE_URL manquante');
    console.warn('[DB] DATABASE_URL absente — Neon désactivé (fallback silencieux)');
    return null;
  }

  try {
    // Neon : préférer l'URL -pooler (PgBouncer) si fournie.
    // max limité pour ne pas saturer Neon sous 300–500 users concurrent.
    // sslmode=verify-full : anticipe pg v9 (plus de warning sslmode).
    let cs = connectionString;
    try {
      const u = new URL(cs);
      if (!u.searchParams.get('sslmode')) {
        u.searchParams.set('sslmode', 'verify-full');
        cs = u.toString();
      } else if (u.searchParams.get('sslmode') === 'require') {
        u.searchParams.set('sslmode', 'verify-full');
        cs = u.toString();
      }
    } catch (_) {
      if (!/[?&]sslmode=/i.test(cs)) {
        cs += (cs.includes('?') ? '&' : '?') + 'sslmode=verify-full';
      }
    }
    const isPooler = /-pooler\.|pgbouncer=true|pooling=true/i.test(cs);
    pool = new Pool({
      connectionString: cs,
      // Compat pg actuel + prepare pg v9 : vérification SSL complète
      // rejectUnauthorized false : compat CA Neon ; sslmode=verify-full est dans l'URL (pg v9)
      ssl: { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true' },
      max: Math.min(20, Math.max(3, Number(process.env.PG_POOL_MAX || (isPooler ? 15 : 8)))),
      idleTimeoutMillis: Number(process.env.PG_IDLE_MS || 20000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_MS || 8000),
      allowExitOnIdle: true,
      // Évite les requêtes zombies sous charge
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000)
    });

    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });

    return pool;
  } catch (e) {
    poolError = e;
    console.error('[DB] Impossible de créer le pool:', e.message);
    return null;
  }
}

/**
 * Exécute une requête. Retourne null en cas d'échec (jamais de throw fatal).
 */
async function query(text, params = []) {
  const p = getPool();
  if (!p) return null;
  try {
    return await p.query(text, params);
  } catch (e) {
    console.error('[DB] Query error:', e.message);
    return null;
  }
}

/**
 * Test rapide de disponibilité.
 */
async function isAvailable() {
  const res = await query('SELECT 1 AS ok');
  return !!(res && res.rows && res.rows[0]);
}

module.exports = {
  getPool,
  query,
  isAvailable
};
