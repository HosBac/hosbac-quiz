'use strict';

const { json, requireAdmin } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const crypto = require('crypto');

function sha256Signature(params, apiSecret) {
  const serialized = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  const signature = crypto
    .createHash('sha256')
    .update(serialized + apiSecret, 'utf8')
    .digest('hex');

  return { serialized, signature };
}

/**
 * Accepte plusieurs noms de variables (Vercel / historiques).
 * Supporte aussi CLOUDINARY_URL = cloudinary://API_KEY:API_SECRET@CLOUD_NAME
 */
function resolveCloudinaryConfig() {
  let cloudName = String(
    process.env.CLOUDINARY_CLOUD_NAME ||
      process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ||
      process.env.CLOUDINARY_NAME ||
      process.env.CLOUD_NAME ||
      ''
  ).trim();

  let apiKey = String(
    process.env.CLOUDINARY_API_KEY ||
      process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY ||
      process.env.CLOUDINARY_KEY ||
      ''
  ).trim();

  let apiSecret = String(
    process.env.CLOUDINARY_API_SECRET ||
      process.env.CLOUDINARY_SECRET ||
      process.env.CLOUDINARY_API_SECRET_KEY ||
      ''
  ).trim();

  const url = String(process.env.CLOUDINARY_URL || '').trim();
  if (url && (!cloudName || !apiKey || !apiSecret)) {
    // cloudinary://api_key:api_secret@cloud_name
    try {
      const u = new URL(url);
      if (!apiKey) apiKey = decodeURIComponent(u.username || '');
      if (!apiSecret) apiSecret = decodeURIComponent(u.password || '');
      if (!cloudName) cloudName = (u.hostname || '').trim();
    } catch (_) {
      /* ignore */
    }
  }

  return { cloudName, apiKey, apiSecret };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') {
    return json(res, 405, { success: false, error: 'POST requis' });
  }

  try {
    await requireAdmin(req);

    const { cloudName, apiKey, apiSecret } = resolveCloudinaryConfig();

    if (!cloudName || !apiKey || !apiSecret) {
      const missing = [];
      if (!cloudName) missing.push('CLOUDINARY_CLOUD_NAME (ou NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ou CLOUDINARY_URL)');
      if (!apiKey) missing.push('CLOUDINARY_API_KEY');
      if (!apiSecret) missing.push('CLOUDINARY_API_SECRET');

      console.error('[CLOUDINARY SIGN] Variables manquantes:', missing);

      return json(res, 500, {
        success: false,
        code: 'CLOUDINARY_ENV_MISSING',
        error:
          'Configuration Cloudinary incomplète sur Vercel. Variables manquantes : ' +
          missing.join(', '),
        missing
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'hosbac_quiz_docs';
    const publicId = `quiz_${crypto.randomUUID()}`;

    const paramsToSign = {
      folder,
      public_id: publicId,
      timestamp
    };

    const { serialized, signature } = sha256Signature(paramsToSign, apiSecret);

    console.log('[CLOUDINARY SIGN]', {
      cloudName,
      apiKeyPrefix: apiKey.slice(0, 6),
      timestamp,
      folder,
      publicId,
      signatureAlgorithm: 'sha256',
      stringToSign: serialized
    });

    return json(res, 200, {
      success: true,
      cloudName,
      apiKey,
      timestamp,
      folder,
      publicId,
      signature,
      signatureAlgorithm: 'sha256',
      resourceType: 'raw',
      uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/raw/upload`
    });
  } catch (e) {
    console.error('[CLOUDINARY SIGN]', e);
    return json(res, e.status || 500, {
      success: false,
      error: e.message || "Impossible de signer l'upload Cloudinary."
    });
  }
};
