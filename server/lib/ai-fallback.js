'use strict';

/**
 * Moteur de fallback multi-IA administrable (Neon ai_models_config).
 * Rotation automatique en cas de quota / 429 / timeout.
 */

const { query, isAvailable } = require('./db');
const { isHighDemandError, withRetry, sleep } = require('./ai-retry');

const DEFAULT_MODELS = [
  // Gemini multi-clés
  { provider: 'gemini', model_name: 'gemini-3.6-flash', env_key_name: 'GEMINI_API_KEY', priority_order: 1 },
  { provider: 'gemini', model_name: 'gemini-3.6-flash', env_key_name: 'GEMINI_API_KEY_1', priority_order: 2 },
  { provider: 'gemini', model_name: 'gemini-2.5-flash', env_key_name: 'GEMINI_API_KEY_2', priority_order: 3 },
  { provider: 'gemini', model_name: 'gemini-2.0-flash', env_key_name: 'GEMINI_API_KEY', priority_order: 4 },
  { provider: 'gemini', model_name: 'gemini-2.5-flash', env_key_name: 'GEMINI_API_KEY_2', priority_order: 5 },
  // OpenRouter multi-clés
  { provider: 'openrouter', model_name: 'openai/gpt-4o-mini', env_key_name: 'OPENROUTER_API_KEY', priority_order: 10 },
  { provider: 'openrouter', model_name: 'openai/gpt-4o-mini', env_key_name: 'OPENROUTER_API_KEY_1', priority_order: 11 },
  { provider: 'openrouter', model_name: 'google/gemini-2.0-flash-001', env_key_name: 'OPENROUTER_API_KEY_2', priority_order: 12 },
  // Mistral multi-clés
  { provider: 'mistral', model_name: 'mistral-small-latest', env_key_name: 'MISTRAL_API_KEY', priority_order: 20 },
  { provider: 'mistral', model_name: 'mistral-small-latest', env_key_name: 'MISTRAL_API_KEY_1', priority_order: 21 },
  { provider: 'mistral', model_name: 'mistral-small-latest', env_key_name: 'MISTRAL_API_KEY_2', priority_order: 22 },
  { provider: 'mistral', model_name: 'mistral-small-latest', env_key_name: 'MISTRAL_API_KEY_3', priority_order: 23 },
  // Grok / xAI multi-clés
  { provider: 'grok', model_name: 'grok-2-latest', env_key_name: 'XAI_API_KEY', priority_order: 30 },
  { provider: 'grok', model_name: 'grok-2-latest', env_key_name: 'GROK_API_KEY', priority_order: 31 },
  { provider: 'grok', model_name: 'grok-2-latest', env_key_name: 'GROK_API_KEY_1', priority_order: 32 },
  { provider: 'grok', model_name: 'grok-2-latest', env_key_name: 'GROK_API_KEY_2', priority_order: 33 },
  // Cloudflare multi-clés
  { provider: 'cloudflare', model_name: '@cf/meta/llama-3.1-8b-instruct', env_key_name: 'CLOUDFLARE_API_TOKEN', priority_order: 40 },
  { provider: 'cloudflare', model_name: '@cf/meta/llama-3.1-8b-instruct', env_key_name: 'CLOUDFLARE_API_TOKEN_2', priority_order: 41 },
  { provider: 'cloudflare', model_name: '@cf/meta/llama-3.1-8b-instruct', env_key_name: 'CLOUDFLARE_API_KEY_1', priority_order: 42 },
  { provider: 'cloudflare', model_name: '@cf/meta/llama-3.1-8b-instruct', env_key_name: 'CLOUDFLARE_API_KEY_2', priority_order: 43 }
]

async function ensureAiModelsTable() {
  if (!(await isAvailable())) return false;
  await query(`
    CREATE TABLE IF NOT EXISTS ai_models_config (
      id SERIAL PRIMARY KEY,
      provider VARCHAR(50) NOT NULL,
      model_name VARCHAR(100) NOT NULL,
      env_key_name VARCHAR(100) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      priority_order INT DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // No automatic seeding — admin adds models manually from the dashboard.
  return true;
}


async function seedMissingDefaults() {
  // Disabled: models are managed exclusively via Admin dashboard (no auto-seed).
  return;
}

async function listActiveModels() {
  try {
    if (await ensureAiModelsTable()) {
      const res = await query(
        `SELECT id, provider, model_name, env_key_name, is_active, priority_order
         FROM ai_models_config
         WHERE is_active = true
         ORDER BY priority_order ASC, id ASC`
      );
      // Uniquement les modèles explicitement activés dans l'Admin (pas de hardcode).
      const rows = res?.rows || [];
      return rows.map((r) => ({
        ...r,
        model_name: cleanModelId(r.model_name),
        provider: resolveProvider(r.provider, r.model_name)
      }));
    }
  } catch (e) {
    console.warn('[AI FALLBACK] listActive from Neon:', e.message);
  }
  // Table vide ou DB KO : aucune cascade hardcodée (évite appels Gemini involontaires).
  return [];
}

async function listAllModels() {
  await ensureAiModelsTable();
  const res = await query(
    `SELECT id, provider, model_name, env_key_name, is_active, priority_order, created_at
     FROM ai_models_config ORDER BY priority_order ASC, id ASC`
  );
  return res?.rows || [];
}

function getApiKey(envKeyName) {
  const name = String(envKeyName || '').trim();
  if (!name) return '';
  let v = String(process.env[name] || '').trim();
  if (v) return v;
  // Alias courants (Vercel peut n\'avoir que GEMINI_API_KEY sans _1)
  const aliases = {
    GEMINI_API_KEY_1: ['GEMINI_API_KEY'],
    GEMINI_API_KEY_2: ['GEMINI_API_KEY_2', 'GEMINI_API_KEY'],
    OPENROUTER_API_KEY_1: ['OPENROUTER_API_KEY'],
    OPENROUTER_API_KEY_2: ['OPENROUTER_API_KEY_2', 'OPENROUTER_API_KEY'],
    MISTRAL_API_KEY_1: ['MISTRAL_API_KEY'],
    MISTRAL_API_KEY_2: ['MISTRAL_API_KEY_2', 'MISTRAL_API_KEY'],
    MISTRAL_API_KEY_3: ['MISTRAL_API_KEY_3', 'MISTRAL_API_KEY'],
    GROQ_API_KEY_1: ['GROQ_API_KEY'],
    GROQ_API_KEY_2: ['GROQ_API_KEY_2', 'GROQ_API_KEY'],
    GROK_API_KEY: ['XAI_API_KEY', 'GROK_API_KEY'],
    GROK_API_KEY_1: ['GROK_API_KEY_1', 'XAI_API_KEY', 'GROK_API_KEY'],
    GROK_API_KEY_2: ['GROK_API_KEY_2', 'XAI_API_KEY'],
    CLOUDFLARE_API_KEY_1: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'],
    CLOUDFLARE_API_KEY_2: ['CLOUDFLARE_API_TOKEN_2', 'CLOUDFLARE_API_TOKEN']
  };
  for (const a of aliases[name] || []) {
    v = String(process.env[a] || '').trim();
    if (v) return v;
  }
  return '';
}

async function callGemini(apiKey, model, prompt, { jsonMode = true, temperature = 0.4, maxTokens = 8192 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {})
      }
    })
  });
  const bodyText = await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error(bodyText.slice(0, 400) || `Gemini HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  let data = {};
  try {
    data = JSON.parse(bodyText);
  } catch (_) {}
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

async function callOpenRouter(apiKey, model, prompt, { temperature = 0.4, maxTokens = 8192 } = {}) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'HosBac Quiz'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' }
    })
  });
  const bodyText = await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error(bodyText.slice(0, 400) || `OpenRouter HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  let data = {};
  try {
    data = JSON.parse(bodyText);
  } catch (_) {}
  return data?.choices?.[0]?.message?.content || '';
}

async function callMistral(apiKey, model, prompt, { temperature = 0.4, maxTokens = 8192 } = {}) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' }
    })
  });
  const bodyText = await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error(bodyText.slice(0, 400) || `Mistral HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  let data = {};
  try {
    data = JSON.parse(bodyText);
  } catch (_) {}
  return data?.choices?.[0]?.message?.content || '';
}

async function callGrok(apiKey, model, prompt, { temperature = 0.4, maxTokens = 8192 } = {}) {
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens
    })
  });
  const bodyText = await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error(bodyText.slice(0, 400) || `Grok HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  let data = {};
  try {
    data = JSON.parse(bodyText);
  } catch (_) {}
  return data?.choices?.[0]?.message?.content || '';
}

async function callCloudflare(apiKey, model, prompt) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID_2;
  if (!account) throw Object.assign(new Error('CLOUDFLARE_ACCOUNT_ID manquant'), { status: 503 });
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${encodeURIComponent(model)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Retourne uniquement du JSON valide.' },
          { role: 'user', content: prompt }
        ]
      })
    }
  );
  const bodyText = await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error(bodyText.slice(0, 400) || `Cloudflare HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  let data = {};
  try {
    data = JSON.parse(bodyText);
  } catch (_) {}
  return data?.result?.response || data?.result?.content || data?.result?.text || '';
}

/**
 * Nettoie l'ID modèle (supprime préfixes erronés type gemini/qwen/.../GROQ_API_KEY).
 */
function cleanModelId(raw) {
  let m = String(raw || '').trim();
  if (!m) return m;
  // Concaténation accidentelle .../GROQ_API_KEY
  const envTail = m.match(/\/(GEMINI_API_KEY[_0-9]*|GROQ_API_KEY[_0-9]*|OPENROUTER_API_KEY[_0-9]*|MISTRAL_API_KEY[_0-9]*|XAI_API_KEY|GROK_API_KEY[_0-9]*|CLOUDFLARE_[A-Z0-9_]+)$/i);
  if (envTail) m = m.slice(0, envTail.index);
  // gemini/qwen/... ou google/qwen/... → qwen/...
  m = m.replace(/^(?:gemini|google)\/(qwen|llama|mixtral|gpt-oss|openai)/i, '$1');
  // Préfixe groq/ redondant
  m = m.replace(/^groq\//i, '');
  // openrouter/qwen → qwen only if going to groq later; keep for openrouter
  return m.trim();
}

/**
 * Déduit le vrai provider à partir du provider admin + de l'ID modèle.
 * Empêche d'envoyer un modèle Groq à l'API Gemini.
 */
function resolveProvider(providerRaw, modelName) {
  const p = String(providerRaw || '').toLowerCase().trim();
  const m = String(modelName || '').toLowerCase();
  // Indices forts sur l'ID modèle
  if (
    m.startsWith('qwen/') ||
    m.startsWith('llama-') ||
    m.startsWith('llama/') ||
    m.startsWith('mixtral') ||
    m.startsWith('gpt-oss') ||
    m.startsWith('groq/') ||
    m.includes('whisper') ||
    /qwen3|llama-3|mixtral|gpt-oss/i.test(m)
  ) {
    // OpenRouter vs Groq : si provider admin = openrouter, respecter
    if (p === 'openrouter') return 'openrouter';
    return 'groq';
  }
  if (m.startsWith('gemini-') || m.startsWith('models/gemini')) return 'gemini';
  if (m.startsWith('grok-') || m.startsWith('xai/')) return 'grok';
  if (m.startsWith('@cf/') || m.includes('cloudflare')) return 'cloudflare';
  if (m.startsWith('mistral-') || m.startsWith('open-mistral') || m.startsWith('codestral')) {
    if (p === 'openrouter') return 'openrouter';
    return 'mistral';
  }
  if (m.includes('/') && (m.startsWith('openai/') || m.startsWith('google/') || m.startsWith('meta/') || m.startsWith('anthropic/'))) {
    if (p === 'groq') return 'groq';
    return p === 'openrouter' || !p ? 'openrouter' : p;
  }
  // Provider admin explicite
  if (['gemini', 'google'].includes(p)) return 'gemini';
  if (['groq'].includes(p)) return 'groq';
  if (['openrouter'].includes(p)) return 'openrouter';
  if (['mistral'].includes(p)) return 'mistral';
  if (['grok', 'xai'].includes(p)) return 'grok';
  if (['cloudflare'].includes(p)) return 'cloudflare';
  return p || 'unknown';
}

async function callGroq(apiKey, model, prompt, { temperature = 0.4, maxTokens = 2000, jsonMode = true } = {}) {
  const modelId = cleanModelId(model);
  // Plafond strict pour TPM bas (ex. Qwen 8k TPM)
  const safeMax = Math.min(Number(maxTokens) || 2000, 2500);
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: safeMax,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    })
  });
  const bodyText = await r.text().catch(() => '');
  if (!r.ok) {
    const err = new Error(bodyText.slice(0, 400) || `Groq HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  let data;
  try { data = JSON.parse(bodyText); } catch {
    throw Object.assign(new Error('Réponse Groq non JSON'), { status: 502 });
  }
  const content = data?.choices?.[0]?.message?.content || '';
  if (!content) throw Object.assign(new Error('Réponse Groq vide'), { status: 503 });
  return content;
}

async function callProvider(modelRow, prompt, opts = {}) {
  const key = getApiKey(modelRow.env_key_name);
  if (!key) {
    const err = new Error(`Clé absente: ${modelRow.env_key_name}`);
    err.status = 503;
    throw err;
  }
  const model = cleanModelId(modelRow.model_name);
  const provider = resolveProvider(modelRow.provider, model);
  // Garde-fou: refuser clé Groq sur endpoint Gemini et inversement
  const envName = String(modelRow.env_key_name || '').toUpperCase();
  if (provider === 'gemini' && /GROQ|OPENROUTER|MISTRAL|XAI|GROK|CLOUDFLARE/.test(envName) && !/GEMINI/.test(envName)) {
    const err = new Error(`Incohérence provider/clé: modèle Gemini avec ${envName}`);
    err.status = 400;
    throw err;
  }
  if (provider === 'groq' && /GEMINI|XAI|GROK_API|CLOUDFLARE/.test(envName) && !/GROQ/.test(envName)) {
    // Si env dit GROQ ok; sinon tenter quand même si clé présente (admin a pu mal nommer)
    console.warn('[AI FALLBACK] provider=groq mais env_key=', envName);
  }
  console.log('[AI FALLBACK] route', provider, model, modelRow.env_key_name);
  switch (provider) {
    case 'gemini':
      return callGemini(key, model.replace(/^models\//, ''), prompt, opts);
    case 'groq':
      return callGroq(key, model, prompt, opts);
    case 'openrouter':
      return callOpenRouter(key, model, prompt, opts);
    case 'mistral':
      return callMistral(key, model, prompt, opts);
    case 'grok':
    case 'xai':
      return callGrok(key, model, prompt, opts);
    case 'cloudflare':
      return callCloudflare(key, model, prompt);
    default:
      throw Object.assign(new Error('Provider inconnu: ' + provider + ' (model=' + model + ')'), { status: 400 });
  }
}

/**
 * Génère du texte JSON en parcourant les modèles actifs (priorité ASC).
 * Retourne { text, provider, model }
 */
function buildPedagogicalIsolationPrompt(prompt, opts = {}) {
  const level = String(opts.level || opts.classe || '').trim();
  const subject = String(opts.subject || opts.matiere || '').trim();
  if (!level || !subject) return String(prompt || '');
  return `CLASSE DE L'ÉLÈVE : ${level}\nMATIÈRE EXCLUSIVE : ${subject}\n\nRÈGLE D'ÉTANCHÉITÉ PÉDAGOGIQUE ABSOLUE :\nVous devez générer UNE ET UNE SEULE QUESTION conforme au programme officiel international/national de la classe de ${level} et EXCLUSIVEMENT pour la matière ${subject}.\n- IL EST STRICTEMENT INTERDIT d'aborder une autre matière (ex: pas d'Histoire si la matière est Mathématiques).\n- IL EST STRICTEMENT INTERDIT de poser une question d'un autre niveau scolaire (ex: pas de notion de Terminale ou de 3ème si l'élève est en 6ème).\n- Si vous n'avez pas de données RAG, générez une question de cours canonique basée sur le programme officiel de la classe de ${level} en ${subject}.\n\nRÈGLES DE FORMATAGE MATHÉMATIQUE ABSOLUES : les formules mathématiques sont STRICTEMENT RÉSERVÉES aux matières Mathématiques et Physique-Chimie (PCT). Utilisez uniquement $...$ pour le LaTeX en ligne et $$...$$ pour les blocs. N'utilisez JAMAIS \( ... \) ni \[ ... \]. Pour SVT, Anglais, Français, Histoire-Géo, Philosophie et toute autre matière littérale, INTERDICTION TOTALE de LaTeX ou de balises mathématiques : texte brut clair uniquement.\n\n${String(prompt || '')}`;
}

async function generateTextWithFallback(prompt, opts = {}) {
  const models = await listActiveModels();
  if (!models.length) {
    const err = new Error('Les documents pour cette classe et matière ne sont pas encore disponibles dans le RAG. Veuillez revenir plus tard.');
    err.status = 503;
    err.code = 'AI_MODELS_ALL_OFF';
    throw err;
  }
  const errors = [];
  const seen = new Set();
  for (const m of models) {
    const key = `${m.provider}|${m.model_name}|${m.env_key_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!getApiKey(m.env_key_name)) {
      errors.push(`${m.provider}/${m.model_name}: clé ${m.env_key_name} absente`);
      continue;
    }
    try {
      const text = await callProvider(m, String(prompt || ''), { ...opts, jsonMode: opts.jsonMode === true });
      if (!String(text || '').trim()) throw Object.assign(new Error('Réponse IA vide'), { status: 503 });
      return { text, provider: m.provider, model: m.model_name, modelId: m.id, envKey: m.env_key_name };
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`${m.provider}/${m.model_name}@${m.env_key_name}: ${msg.slice(0, 200)}`);
      console.warn('[AI TEXT FALLBACK] fail', m.provider, m.model_name, msg.slice(0, 180));
      await sleep(isHighDemandError(e?.status || e?.httpStatus, msg, msg) || e?.status === 429 ? 50 : 100);
    }
  }
  const err = new Error('Aucun fournisseur IA disponible après la cascade configurée.');
  err.status = 503;
  err.code = 'AI_PROVIDER_UNAVAILABLE';
  err.details = errors;
  throw err;
}

async function generateWithFallback(prompt, opts = {}) {
  const isolatedPrompt = buildPedagogicalIsolationPrompt(prompt, opts);
  const models = await listActiveModels();
  if (!models.length) {
    const err = new Error(
      "Aucun modèle IA actif configuré dans l'Admin. Ajoutez des modèles (provider + variable env) et activez-les."
    );
    err.status = 503;
    throw err;
  }
  const errors = [];
  // Déduplique (provider+model+env) tout en respectant priority_order
  const seen = new Set();
  const ordered = [];
  for (const m of models) {
    const k = `${m.provider}|${m.model_name}|${m.env_key_name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ordered.push(m);
  }
  for (const m of ordered) {
    if (!getApiKey(m.env_key_name)) {
      errors.push(`${m.provider}/${m.model_name}: clé ${m.env_key_name} absente`);
      continue;
    }
    try {
      // TPM / 429 : une seule tentative puis bascule immédiate vers le modèle suivant
      const text = await withRetry(
        async () => {
          const out = await callProvider(m, isolatedPrompt, opts);
          if (!out || !String(out).trim()) {
            const err = new Error('Réponse vide');
            err.status = 503;
            throw err;
          }
          return out;
        },
        { maxAttempts: 1, baseDelayMs: 200, label: `${m.provider}/${m.model_name}/${m.env_key_name}` }
      );
      console.log('[AI FALLBACK] OK', m.provider, m.model_name, m.env_key_name);
      return { text, provider: m.provider, model: m.model_name, modelId: m.id, envKey: m.env_key_name };
    } catch (e) {
      const msg = e?.message || String(e);
      const status = e?.status || e?.httpStatus;
      console.warn('[AI FALLBACK] fail', m.provider, m.model_name, m.env_key_name, msg.slice(0, 160));
      errors.push(`${m.provider}/${m.model_name}@${m.env_key_name}: ${msg.slice(0, 200)}`);
      // Bascule immédiate — pas de blocage utilisateur
      await sleep(isHighDemandError(status, msg, msg) || status === 429 ? 80 : 150);
    }
  }
  const err = new Error(
    'Tous les modèles IA sont indisponibles ou en quota. Réessaie dans un instant.'
  );
  err.status = 503;
  err.details = errors;
  throw err;
}

module.exports = {
  ensureAiModelsTable,
  seedMissingDefaults,
  listActiveModels,
  listAllModels,
  generateWithFallback,
  generateTextWithFallback,
  buildPedagogicalIsolationPrompt,
  callProvider,
  resolveProvider,
  cleanModelId,
  DEFAULT_MODELS,
  getApiKey
};
