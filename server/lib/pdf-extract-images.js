'use strict';

/**
 * Extraction d'images embarquées depuis un PDF (Node / Vercel).
 * Utilise pdfjs-dist (legacy) — pas de canvas natif requis pour les XObject images.
 */

const MAX_PAGES = 40;
const MIN_SIDE = 100;

function toPngDataUrl(width, height, rgbaData) {
  // Construction PNG minimale via compression zlib native (pas de dépendance sharp)
  const zlib = require('zlib');
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function u32(n) {
    return Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }
  function chunk(type, data) {
    const typeB = Buffer.from(type, 'ascii');
    const len = u32(data.length);
    const crc = u32(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([len, typeB, data, crc]);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // filter none per row
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    const src = y * stride;
    rgbaData.copy(raw, y * (stride + 1) + 1, src, src + stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });
  const png = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

function normalizeImageData(img) {
  if (!img) return null;
  const width = Number(img.width) || 0;
  const height = Number(img.height) || 0;
  if (width < MIN_SIDE || height < MIN_SIDE) return null;

  // pdf.js ImageKind / data formats
  let data = img.data;
  if (!data) return null;

  // Already a typed array of RGBA
  if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    // If grayscale or RGB, expand roughly
    const expectedRGBA = width * height * 4;
    const expectedRGB = width * height * 3;
    let rgba;
    if (buf.length >= expectedRGBA) {
      rgba = buf.slice(0, expectedRGBA);
    } else if (buf.length >= expectedRGB) {
      rgba = Buffer.alloc(expectedRGBA);
      for (let i = 0, j = 0; i < expectedRGB; i += 3, j += 4) {
        rgba[j] = buf[i];
        rgba[j + 1] = buf[i + 1];
        rgba[j + 2] = buf[i + 2];
        rgba[j + 3] = 255;
      }
    } else if (buf.length >= width * height) {
      rgba = Buffer.alloc(expectedRGBA);
      for (let i = 0, j = 0; i < width * height; i++, j += 4) {
        const g = buf[i];
        rgba[j] = g;
        rgba[j + 1] = g;
        rgba[j + 2] = g;
        rgba[j + 3] = 255;
      }
    } else {
      return null;
    }
    try {
      const dataUrl = toPngDataUrl(width, height, rgba);
      return { base64: dataUrl, width, height };
    } catch (e) {
      console.warn('[pdf-extract] PNG encode failed', e.message);
      return null;
    }
  }
  return null;
}

async function loadPdfJs() {
  try {
    // pdfjs-dist v4+ / v3 legacy
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    return pdfjs;
  } catch (_) {
    try {
      return require('pdfjs-dist/build/pdf.js');
    } catch (e2) {
      try {
        return require('pdfjs-dist');
      } catch (e3) {
        console.error('[pdf-extract] pdfjs-dist unavailable', e3.message);
        return null;
      }
    }
  }
}

/**
 * @param {Buffer|Uint8Array} pdfBuffer
 * @returns {Promise<Array<{base64:string,width:number,height:number,page:number}>>}
 */
async function extractImagesFromPdfBuffer(pdfBuffer) {
  const out = [];
  const pdfjs = await loadPdfJs();
  if (!pdfjs) {
    console.error('[pdf-extract] Cannot load pdfjs-dist — add dependency pdfjs-dist');
    return out;
  }

  const data = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer);
  console.log('[pdf-extract] parsing PDF bytes=', data.byteLength);

  let doc;
  try {
    const loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true
    });
    doc = await loadingTask.promise;
  } catch (e) {
    console.error('[pdf-extract] getDocument failed', e.message);
    return out;
  }

  const numPages = Math.min(doc.numPages || 0, MAX_PAGES);
  console.log('[pdf-extract] pages=', numPages);

  const OPS = pdfjs.OPS || {};
  const paintOps = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintJpegXObject
    ].filter((x) => typeof x === 'number')
  );

  for (let p = 1; p <= numPages; p++) {
    try {
      const page = await doc.getPage(p);
      const ops = await page.getOperatorList();
      const seen = new Set();

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (!paintOps.has(fn) && fn !== 85 && fn !== 86 && fn !== 87) {
          // 85/86/87 = common paintImageXObject codes across pdfjs versions
          continue;
        }
        const args = ops.argsArray[i] || [];
        const name = args[0];
        if (!name || seen.has(name)) continue;
        seen.add(name);

        try {
          let img = null;
          if (page.objs && typeof page.objs.get === 'function') {
            img = await new Promise((resolve) => {
              try {
                const v = page.objs.get(name, (x) => resolve(x));
                // Some versions return sync
                if (v && v !== name) resolve(v);
                // timeout fallback
                setTimeout(() => resolve(null), 800);
              } catch (_) {
                resolve(null);
              }
            });
          }
          if (!img) continue;
          const normalized = normalizeImageData(img);
          if (normalized) {
            out.push({ ...normalized, page: p });
            console.log('[pdf-extract] embedded image page', p, normalized.width, 'x', normalized.height);
          }
        } catch (e) {
          console.warn('[pdf-extract] image obj page', p, e.message);
        }
      }
    } catch (e) {
      console.warn('[pdf-extract] page', p, e.message);
    }
  }

  console.log('[pdf-extract] total embedded images=', out.length);
  return out;
}

/**
 * Télécharge un PDF depuis une URL (Cloudinary / HTTP) puis extrait les images.
 */
async function extractImagesFromPdfUrl(url) {
  const u = String(url || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) {
    console.warn('[pdf-extract] invalid url');
    return [];
  }
  console.log('[pdf-extract] fetch PDF', u.slice(0, 120));
  try {
    const r = await fetch(u, { method: 'GET' });
    if (!r.ok) {
      console.error('[pdf-extract] fetch HTTP', r.status);
      return [];
    }
    const ab = await r.arrayBuffer();
    return extractImagesFromPdfBuffer(Buffer.from(ab));
  } catch (e) {
    console.error('[pdf-extract] fetch failed', e.message);
    return [];
  }
}

module.exports = {
  extractImagesFromPdfBuffer,
  extractImagesFromPdfUrl
};
