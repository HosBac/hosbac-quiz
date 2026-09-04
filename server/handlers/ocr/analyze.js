'use strict';

/**
 * HosBac — OCR analyze / modération académique
 * Le OCR principal est côté navigateur (Tesseract).
 * Cette route :
 *  - valide l'auth
 *  - applique un filtre de conformité académique sur le texte fourni
 *  - renvoie HTTP 400 si rejeté
 */

const { requireAuth, json } = require('../../lib/firebase');
const cors = require('../../lib/cors');


const BENIN_ACADEMIC_MARKERS = [
  /dec[- ]?mestfp/i, /communication\s+ecrite/i, /communication\s+écrite/i,
  /expression\s+ecrite/i, /expression\s+écrite/i, /lecture/i, /histoire[- ]?g[eé]o/i,
  /sciences?\s+de\s+la\s+vie/i, /svt/i, /pct/i, /physique[- ]?chimie/i,
  /math[ée]matiques?/i, /philosophie/i, /fran[cç]ais/i, /bepc/i, /bac(?:calaur[eé]at)?/i,
  /cep/i, /devoir\s+de\s+classe/i, /[eé]preuve/i, /session\s+(?:normale|de\s+remplacement)/i,
  /minist[eè]re\s+des?\s+enseignements?/i, /enseignement\s+secondaire/i
];
function looksLikeBeninAcademicExam(text){
  const s=String(text||'');
  return BENIN_ACADEMIC_MARKERS.some(re=>re.test(s));
}

const REJECT_MSG =
  'Document non conforme. HosBac est une plateforme exclusivement dédiée aux épreuves et cours scolaires/académiques.';

function isClearlyNonAcademic(text) {
  const s = String(text || '').toLowerCase();
  if (!s || s.length < 6) return false;
  const banned = [
    /1xbet/,
    /betwinner/,
    /betclic/,
    /parionssport/,
    /\bpmu\b/,
    /bookmaker/,
    /\bpari(s)?\s+sportif/,
    /\bcoupon\b.*\b(pari|bet)\b/,
    /\b(mise|cotes?)\b.*\b(match|buts?|score)\b/,
    /\bfacture\b.*\b(ttc|ht|tva)\b/,
    /\bnum[eé]ro\s+de\s+transaction\b/,
    /\brib\b.*\biban\b/,
    /\bcasino\b/,
    /\bjackpot\b/
  ];
  return banned.some((re) => re.test(s));
}

const SYSTEM_OCR_RULES =
  'RÈGLE DE CONFORMITÉ ACADÉMIQUE ABSOLUE :\n' +
  'ACCEPTATION : toutes les épreuves/cours académiques béninois sont autorisés, y compris BEPC, BAC, CEP, devoirs de classe, DEC-MESTFP, Communication Écrite, Expression Écrite, Lecture, Histoire-Géo, SVT, PCT, Mathématiques, Philosophie et Français. La présence de ces termes ne doit JAMAIS provoquer un rejet.\n' +
  'Avant toute analyse, examinez le contenu. Si le document concerne des PARIS SPORTIFS ' +
  '(coupons 1xBet, Betwinner, cotes, mises), des jeux d\'argent, des factures, du contenu vulgaire ' +
  'ou des sujets NON-ACADÉMIQUES : renvoyez STRICTEMENT ' +
  '{"status":"rejected","error":"' +
  REJECT_MSG +
  '"}\n' +
  'FORMATAGE :\n' +
  '- Interdiction des balises HTML (<strong>, <em>, <br>, <p>).\n' +
  '- Markdown pur uniquement (**gras**, *italique*, listes -).\n' +
  '- LaTeX (\\frac, \\sqrt, \\to, \\lim, \\mathbb) UNIQUEMENT pour Mathématiques et Physique-Chimie. Toute équation ou étape de calcul doit être isolée sur sa propre ligne avec $$...$$ ; aucune commande LaTeX ne doit apparaître seule dans le texte. Les unités et commentaires restent hors formule. ' +
  'JAMAIS de LaTeX pour Français, Histoire-Géo, Philosophie ou SVT non quantitatif.\n';

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') {
    return json(res, 405, { success: false, error: 'Méthode non autorisée' });
  }

  try {
    await requireAuth(req);
    const b = req.body || {};
    const text = String(b.text || b.content || b.ocrText || '').trim();
    const knownAcademic = looksLikeBeninAcademicExam(text);

    // Filtre local immédiat
    if (text && isClearlyNonAcademic(text)) {
      return json(res, 400, {
        success: false,
        status: 'rejected',
        rejected: true,
        code: 'CONTENT_REJECTED',
        error: REJECT_MSG
      });
    }

    // Pas d'image serveur : OCR navigateur
    if (b.imageBase64 && !text) {
      return json(res, 200, {
        success: true,
        provider: 'tesseract-client',
        text: '',
        message:
          'OCR disponible côté navigateur. Utilisez le module OCR de HosBac Quiz. ' +
          'Après extraction, le texte sera soumis à la conformité académique.',
        systemRules: SYSTEM_OCR_RULES
      });
    }

    if (text) {
      return json(res, 200, {
        success: true,
        status: 'ok',
        academicDetected: knownAcademic,
        text,
        moderated: true,
        message: 'Texte conforme au filtre local. Poursuivre avec ai/analyze pour l\'analyse pédagogique.'
      });
    }

    return json(res, 200, {
      success: true,
      provider: 'tesseract-client',
      text: '',
      message: 'OCR disponible côté navigateur. Utilisez le module OCR de HosBac Quiz.',
      systemRules: SYSTEM_OCR_RULES
    });
  } catch (e) {
    return json(res, e.status || 500, { success: false, error: e.message });
  }
};
