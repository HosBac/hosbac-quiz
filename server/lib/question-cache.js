'use strict';

/**
 * Cache mémoire questions / explications (TTL + taille max).
 * Réduit les appels IA pour les mêmes contextes (classe/matière/chapitre).
 * Compatible serverless : utile intra-instance ; pas de dépendance Redis.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = Number(process.env.QUESTION_CACHE_TTL_MS || 15 * 60 * 1000); // 15 min
const MAX_KEYS = Number(process.env.QUESTION_CACHE_MAX_KEYS || 400);
const MAX_PER_KEY = Number(process.env.QUESTION_CACHE_MAX_PER_KEY || 24);

/** @type {Map<string, { at: number, items: any[] }>} */
const store = new Map();

function hashKey(parts) {
  const raw = (Array.isArray(parts) ? parts : [parts])
    .map((p) => String(p ?? '').trim().toLowerCase())
    .join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function touch(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > DEFAULT_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

function evictIfNeeded() {
  if (store.size <= MAX_KEYS) return;
  // FIFO approx: drop oldest by `at`
  const ranked = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
  const toDrop = ranked.slice(0, Math.max(1, store.size - MAX_KEYS));
  for (const [k] of toDrop) store.delete(k);
}

/**
 * Récupère une question en cache (retirée du pool pour limiter les doublons).
 */
function getCachedQuestion(keyParts) {
  const key = hashKey(keyParts);
  const entry = touch(key);
  if (!entry || !entry.items.length) return null;
  const item = entry.items.shift();
  entry.at = Date.now();
  if (!entry.items.length) store.delete(key);
  return item ? { ...item, _cached: true } : null;
}

/**
 * Ajoute une ou plusieurs questions au cache.
 */
function putCachedQuestions(keyParts, questions) {
  const list = (Array.isArray(questions) ? questions : [questions]).filter(Boolean);
  if (!list.length) return;
  const key = hashKey(keyParts);
  const entry = touch(key) || { at: Date.now(), items: [] };
  for (const q of list) {
    if (entry.items.length >= MAX_PER_KEY) break;
    entry.items.push(q);
  }
  entry.at = Date.now();
  store.set(key, entry);
  evictIfNeeded();
}

function cacheStats() {
  let items = 0;
  for (const e of store.values()) items += e.items.length;
  return { keys: store.size, items, ttlMs: DEFAULT_TTL_MS, maxKeys: MAX_KEYS };
}

function clearCache() {
  store.clear();
}

module.exports = {
  hashKey,
  getCachedQuestion,
  putCachedQuestions,
  cacheStats,
  clearCache
};
