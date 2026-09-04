'use strict';

/**
 * Retry + détection surcharge (429 / 503 / high demand)
 */

function isHighDemandError(status, bodyText, errMsg) {
  const s = Number(status) || 0;
  if (s === 429 || s === 503 || s === 500) return true;
  const t = String(bodyText || errMsg || '').toLowerCase();
  return (
    t.includes('high demand') ||
    t.includes('resource exhausted') ||
    t.includes('quota') ||
    t.includes('rate limit') ||
    t.includes('too many requests') ||
    t.includes('unavailable') ||
    t.includes('overloaded') ||
    t.includes('try again later') ||
    t.includes('quota exceeded') ||
    t.includes('limit 20') ||
    t.includes('resource_exhausted') ||
    t.includes('tokens per minute') ||
    t.includes('tpm') ||
    t.includes('request too large') ||
    t.includes('context length') ||
    t.includes('maximum context') ||
    t.includes('prompt is too long') ||
    t.includes('token limit')
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exécute fn jusqu'à maxAttempts fois avec backoff exponentiel.
 * fn doit throw ou retourner { ok:false, status, body } pour retry.
 */
async function withRetry(fn, { maxAttempts = 2, baseDelayMs = 1000, label = 'AI' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return result;
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      const status = e?.status || e?.httpStatus;
      const retryable = isHighDemandError(status, msg, msg);
      console.warn(`[${label}] tentative ${attempt}/${maxAttempts} échouée:`, msg.slice(0, 200));
      if (e?.noRetry || !retryable || attempt >= maxAttempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  throw lastErr || new Error(label + ' indisponible');
}

/** Liste de modèles Gemini de secours */
function geminiModelCascade() {
  const primary = String(process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
  const secondary = String(process.env.GEMINI_MODEL_FALLBACK || process.env.GEMINI_MODEL_2 || 'gemini-2.5-flash').trim();
  const tertiary = 'gemini-2.0-flash';
  const list = [primary, secondary, tertiary, 'gemini-flash-latest'];
  return [...new Set(list.filter(Boolean))];
}

module.exports = {
  isHighDemandError,
  sleep,
  withRetry,
  geminiModelCascade
};
