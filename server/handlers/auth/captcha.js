'use strict';

const cors = require('../../lib/cors');

const GOOGLE_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

function allowedHostnames() {
  return String(process.env.CAPTCHA_ALLOWED_HOSTNAMES || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function jsonSafe(res, status, payload) {
  try {
    return res.status(status).json(payload);
  } catch (e) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(payload));
  }
}

module.exports = async function captchaHandler(req, res) {
  if (cors(req, res)) return;

  // Public config endpoint used by the V3 browser integration.
  if (req.method === 'GET') {
    const siteKey = String(process.env.CAPTCHA_SITE_KEY || '').trim();
    if (!siteKey) {
      return jsonSafe(res, 503, {
        success: false,
        code: 'CAPTCHA_NOT_CONFIGURED',
        siteKeyMissing: true,
        error: 'CAPTCHA_SITE_KEY non configurée sur Vercel.'
      });
    }
    return jsonSafe(res, 200, {
      success: true,
      version: 3,
      siteKey
    });
  }

  if (req.method !== 'POST') {
    return jsonSafe(res, 405, {
      success: false,
      code: 'METHOD_NOT_ALLOWED',
      error: 'POST requis'
    });
  }

  try {
    const secret = String(process.env.CAPTCHA_SECRET || '').trim();
    if (!secret) {
      console.error('[CAPTCHA] CAPTCHA_SECRET missing');
      return jsonSafe(res, 503, {
        success: false,
        code: 'CAPTCHA_SECRET_MISSING',
        error: 'CAPTCHA_SECRET non configurée sur Vercel.'
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = String(body.token || '').trim();
    const action = String(body.action || 'quiz_access').trim();

    if (!token) {
      return jsonSafe(res, 400, {
        success: false,
        code: 'CAPTCHA_TOKEN_MISSING',
        error: 'Token CAPTCHA manquant.'
      });
    }

    if (action !== 'quiz_access') {
      return jsonSafe(res, 400, {
        success: false,
        code: 'CAPTCHA_INVALID_ACTION',
        error: 'Action reCAPTCHA invalide.'
      });
    }

    // Authentication is required only for POST verification.
    const { requireAuth } = require('../../lib/firebase');
    const decoded = await requireAuth(req);
    if (!decoded?.uid) {
      return jsonSafe(res, 401, {
        success: false,
        code: 'AUTH_REQUIRED',
        error: 'Authentification requise.'
      });
    }

    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);

    const googleResponse = await fetch(GOOGLE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    const raw = await googleResponse.text();
    let google = null;
    try {
      google = raw ? JSON.parse(raw) : null;
    } catch {
      console.error('[CAPTCHA] Google returned non-JSON:', raw.slice(0, 500));
      return jsonSafe(res, 502, {
        success: false,
        code: 'CAPTCHA_GOOGLE_BAD_RESPONSE',
        error: 'Réponse invalide du service reCAPTCHA Google.'
      });
    }

    if (!googleResponse.ok || !google) {
      console.error('[CAPTCHA] Google HTTP error:', googleResponse.status, google);
      return jsonSafe(res, 502, {
        success: false,
        code: 'CAPTCHA_GOOGLE_HTTP_ERROR',
        error: 'Le service reCAPTCHA Google a refusé la requête.'
      });
    }

    if (google.success !== true) {
      return jsonSafe(res, 403, {
        success: false,
        code: 'CAPTCHA_REJECTED',
        error: 'La vérification reCAPTCHA a été refusée.',
        reasons: google['error-codes'] || []
      });
    }

    const hostname = String(google.hostname || '').trim().toLowerCase();
    const allowed = allowedHostnames();
    if (allowed.length && hostname && !allowed.includes(hostname)) {
      console.warn('[CAPTCHA] Hostname refused:', hostname, allowed);
      return jsonSafe(res, 403, {
        success: false,
        code: 'CAPTCHA_HOSTNAME_NOT_ALLOWED',
        error: 'Le domaine utilisé n’est pas autorisé pour cette clé reCAPTCHA.'
      });
    }

    if (google.action && google.action !== action) {
      return jsonSafe(res, 403, {
        success: false,
        code: 'CAPTCHA_ACTION_MISMATCH',
        error: 'L’action reCAPTCHA ne correspond pas à la demande.'
      });
    }

    const score = Number(google.score);
    const configured = Number(process.env.CAPTCHA_MIN_SCORE);
    const minimum = Number.isFinite(configured) && configured >= 0 && configured <= 1 ? configured : 0.5;

    if (!Number.isFinite(score) || score < minimum) {
      return jsonSafe(res, 403, {
        success: false,
        code: 'CAPTCHA_LOW_SCORE',
        error: 'La vérification anti-robot n’a pas obtenu un score suffisant.',
        score,
        minimumScore: minimum
      });
    }

    console.log('[CAPTCHA] verified', {
      uid: decoded.uid,
      hostname: hostname || null,
      action: google.action || action,
      score
    });

    return jsonSafe(res, 200, {
      success: true,
      verified: true,
      uid: decoded.uid,
      hostname: hostname || null,
      action: google.action || action,
      score
    });
  } catch (error) {
    console.error('[CAPTCHA] Server error:', {
      message: error?.message,
      code: error?.code,
      stack: error?.stack
    });

    return jsonSafe(res, error?.status || 500, {
      success: false,
      code: error?.status === 401 ? 'AUTH_REQUIRED' : 'CAPTCHA_SERVER_ERROR',
      error: error?.message || 'Erreur interne pendant la vérification reCAPTCHA.'
    });
  }
};
