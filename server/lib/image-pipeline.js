'use strict';

/**
 * HosBac — Pipeline images RAG (Cloudinary + Neon document_images)
 * - Compression via transformations Cloudinary (webp, w_800, q_75)
 * - Anti-doublon MD5 (Firestore + Neon)
 * - Ignore les images < 100x100 (côté appelant)
 * - INSERT dans document_images (Neon) après upload réussi
 */

const crypto = require('crypto');
const { getAdmin } = require('./firebase');
const { query } = require('./db');

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
    try {
      const u = new URL(url);
      if (!apiKey) apiKey = decodeURIComponent(u.username || '');
      if (!apiSecret) apiSecret = decodeURIComponent(u.password || '');
      if (!cloudName) cloudName = (u.hostname || '').trim();
    } catch (_) {}
  }
  return { cloudName, apiKey, apiSecret };
}

function md5Buffer(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function md5Base64(b64) {
  const raw = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
  return crypto.createHash('md5').update(Buffer.from(raw, 'base64')).digest('hex');
}

async function findExistingByHash(hash) {
  if (!hash) return null;
  // Neon d'abord
  try {
    const res = await query(
      `SELECT image_url FROM document_images WHERE md5_hash = $1 LIMIT 1`,
      [hash]
    );
    if (res && res.rows && res.rows[0] && res.rows[0].image_url) {
      console.log('[image-pipeline] dedup Neon hit', hash.slice(0, 8));
      return res.rows[0].image_url;
    }
  } catch (e) {
    console.warn('[image-pipeline] Neon hash lookup', e.message);
  }
  // Firestore fallback
  try {
    const db = getAdmin().firestore();
    const snap = await db.collection('rag_image_hashes').doc(hash).get();
    if (snap.exists) {
      const d = snap.data() || {};
      if (d.secure_url || d.url) return d.secure_url || d.url;
    }
  } catch (e) {
    console.warn('[image-pipeline] Firestore hash lookup', e.message);
  }
  return null;
}

async function saveHash(hash, meta) {
  try {
    const db = getAdmin().firestore();
    await db.collection('rag_image_hashes').doc(hash).set(
      { ...meta, hash, updatedAt: getAdmin().firestore.Timestamp.now() },
      { merge: true }
    );
  } catch (e) {
    console.warn('[image-pipeline] hash save', e.message);
  }
}

/**
 * Persiste une image dans Neon document_images.
 */

let _tableReady = false;
async function ensureDocumentImagesTable() {
  if (_tableReady) return true;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS document_images (
        id              BIGSERIAL PRIMARY KEY,
        document_id     TEXT NOT NULL,
        chunk_index     INTEGER NOT NULL DEFAULT 0,
        image_url       TEXT NOT NULL,
        public_id       TEXT,
        page            INTEGER,
        width           INTEGER,
        height          INTEGER,
        md5_hash        TEXT,
        caption         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_document_images_document_id ON document_images (document_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_document_images_hash ON document_images (md5_hash)`);
    _tableReady = true;
    console.log('[image-pipeline] document_images table ready');
    return true;
  } catch (e) {
    console.warn('[image-pipeline] ensure table', e.message);
    return false;
  }
}

async function insertDocumentImage({
  documentId,
  chunkIndex = 0,
  imageUrl,
  publicId = null,
  page = null,
  width = null,
  height = null,
  md5Hash = null,
  caption = null
}) {
  if (!documentId || !imageUrl) {
    console.warn('[image-pipeline] insertDocumentImage: documentId ou imageUrl manquant');
    return false;
  }
  await ensureDocumentImagesTable();
  try {
    const res = await query(
      `INSERT INTO document_images
        (document_id, chunk_index, image_url, public_id, page, width, height, md5_hash, caption)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        String(documentId),
        Number(chunkIndex) || 0,
        String(imageUrl),
        publicId ? String(publicId) : null,
        page != null ? Number(page) : null,
        width != null ? Number(width) : null,
        height != null ? Number(height) : null,
        md5Hash ? String(md5Hash) : null,
        caption ? String(caption) : null
      ]
    );
    const id = res && res.rows && res.rows[0] ? res.rows[0].id : null;
    console.log('Successfully inserted image into Neon:', imageUrl, 'id=', id, 'doc=', documentId);
    return true;
  } catch (e) {
    console.error('[image-pipeline] Neon INSERT FAILED', e.message);
    return false;
  }
}

/**
 * Upload base64 → Cloudinary (WebP q75 w800) + anti-doublon MD5.
 */
async function uploadOptimizedImage(opts = {}) {
  const { cloudName, apiKey, apiSecret } = resolveCloudinaryConfig();
  if (!cloudName || !apiKey || !apiSecret) {
    console.error('[image-pipeline] Cloudinary non configuré', {
      cloudName: !!cloudName,
      apiKey: !!apiKey,
      apiSecret: !!apiSecret
    });
    throw new Error('Cloudinary non configuré (CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET)');
  }

  const base64 = String(opts.base64 || '');
  if (!base64) throw new Error('Image base64 manquante');

  const hash = md5Base64(base64);
  const existing = await findExistingByHash(hash);
  if (existing) {
    console.log('[image-pipeline] dedup reuse', existing.slice(0, 60));
    return { url: existing, hash, deduped: true, publicId: null };
  }

  const folder = String(opts.folder || 'hosbac/rag').replace(/\/+$/, '');
  const width = Math.min(1600, Math.max(100, Number(opts.width) || 800));
  const quality = Math.min(100, Math.max(40, Number(opts.quality) || 75));
  const publicId =
    String(opts.publicId || '').trim() ||
    `${folder}/img_${hash.slice(0, 16)}`;

  const timestamp = Math.floor(Date.now() / 1000);
  const transformation = `f_webp,q_${quality},w_${width},c_limit`;

  const params = {
    timestamp: String(timestamp),
    folder,
    public_id: publicId.split('/').pop(),
    transformation
  };

  const serialized = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');

  const signature = crypto
    .createHash('sha256')
    .update(serialized + apiSecret, 'utf8')
    .digest('hex');

  const dataUri = base64.startsWith('data:')
    ? base64
    : `data:image/png;base64,${base64}`;

  const body = new URLSearchParams();
  body.set('file', dataUri);
  body.set('api_key', apiKey);
  body.set('timestamp', String(timestamp));
  body.set('signature', signature);
  body.set('folder', folder);
  body.set('public_id', params.public_id);
  body.set('transformation', transformation);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`;
  console.log('[image-pipeline] Cloudinary upload…', { folder, public_id: params.public_id, transformation });

  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('[image-pipeline] Cloudinary réponse non-JSON', raw.slice(0, 300));
    throw new Error('Réponse Cloudinary invalide: ' + raw.slice(0, 200));
  }
  if (!r.ok) {
    console.error('[image-pipeline] Cloudinary HTTP', r.status, data.error || data);
    throw new Error(data.error?.message || `Cloudinary HTTP ${r.status}`);
  }

  const secureUrl = data.secure_url || data.url;
  if (!secureUrl) throw new Error('URL Cloudinary absente');

  console.log('[image-pipeline] Cloudinary OK', secureUrl.slice(0, 80), 'bytes=', data.bytes);

  await saveHash(hash, {
    secure_url: secureUrl,
    public_id: data.public_id,
    bytes: data.bytes,
    format: data.format,
    width: data.width,
    height: data.height
  });

  return {
    url: secureUrl,
    hash,
    deduped: false,
    publicId: data.public_id,
    width: data.width,
    height: data.height,
    bytes: data.bytes
  };
}

/**
 * Traite une liste d'images extraites du PDF, upload Cloudinary, optionnellement
 * persiste dans Neon document_images si documentId fourni.
 *
 * @param {Array<{base64:string,width?:number,height?:number,page?:number,caption?:string}>} images
 * @param {{documentId?: string}} options
 */
async function processExtractedImages(images, options = {}) {
  const list = Array.isArray(images) ? images : [];
  const documentId = options.documentId ? String(options.documentId) : '';
  const out = [];
  console.log('[image-pipeline] processExtractedImages count=', list.length, 'docId=', documentId || '(none)');

  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    const w = Number(img.width) || 0;
    const h = Number(img.height) || 0;
    if (w > 0 && h > 0 && (w < 100 || h < 100)) {
      console.log('[image-pipeline] skip small', w, 'x', h);
      continue;
    }
    if (!img.base64) {
      console.log('[image-pipeline] skip empty base64 index', i);
      continue;
    }
    try {
      const up = await uploadOptimizedImage({
        base64: img.base64,
        folder: 'hosbac/rag',
        width: 800,
        quality: 75
      });
      const row = {
        url: up.url,
        hash: up.hash,
        deduped: up.deduped,
        page: img.page || null,
        caption: img.caption || '',
        width: up.width || w,
        height: up.height || h,
        publicId: up.publicId || null
      };
      if (documentId) {
        await insertDocumentImage({
          documentId,
          chunkIndex: i,
          imageUrl: row.url,
          publicId: row.publicId,
          page: row.page,
          width: row.width,
          height: row.height,
          md5Hash: row.hash,
          caption: row.caption
        });
      }
      out.push(row);
    } catch (e) {
      console.error('[image-pipeline] upload skip index', i, e.message);
    }
  }
  console.log('[image-pipeline] processExtractedImages done →', out.length, 'images');
  return out;
}

/**
 * Enregistre une liste d'URLs déjà uploadées dans document_images.
 */
async function saveImageUrlsToNeon(documentId, imageUrls = []) {
  if (!documentId || !Array.isArray(imageUrls) || !imageUrls.length) return 0;
  let n = 0;
  for (let i = 0; i < imageUrls.length; i++) {
    const url = String(imageUrls[i] || '').trim();
    if (!url) continue;
    const ok = await insertDocumentImage({
      documentId,
      chunkIndex: i,
      imageUrl: url
    });
    if (ok) n++;
  }
  return n;
}

/**
 * Récupère les images Neon pour un document_id.
 */
async function getImagesByDocumentId(documentId) {
  if (!documentId) return [];
  try {
    const res = await query(
      `SELECT id, document_id, chunk_index, image_url, public_id, page, width, height, caption
       FROM document_images
       WHERE document_id = $1
       ORDER BY chunk_index ASC, id ASC`,
      [String(documentId)]
    );
    return (res && res.rows) || [];
  } catch (e) {
    console.warn('[image-pipeline] getImagesByDocumentId', e.message);
    return [];
  }
}

/**
 * Récupère les images liées à plusieurs document_id.
 */
async function getImagesByDocumentIds(docIds = []) {
  const ids = (docIds || []).map(String).filter(Boolean);
  if (!ids.length) return [];
  try {
    const res = await query(
      `SELECT id, document_id, chunk_index, image_url, public_id, page, width, height, caption
       FROM document_images
       WHERE document_id = ANY($1::text[])
       ORDER BY document_id, chunk_index ASC`,
      [ids]
    );
    return (res && res.rows) || [];
  } catch (e) {
    console.warn('[image-pipeline] getImagesByDocumentIds', e.message);
    return [];
  }
}

module.exports = {
  resolveCloudinaryConfig,
  md5Buffer,
  md5Base64,
  findExistingByHash,
  uploadOptimizedImage,
  processExtractedImages,
  insertDocumentImage,
  saveImageUrlsToNeon,
  getImagesByDocumentId,
  getImagesByDocumentIds
};
