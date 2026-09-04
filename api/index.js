"use strict";

// Routeur Vercel avec imports STATIQUES pour forcer le bundling NFT
// de tous les handlers (évite MODULE_NOT_FOUND au runtime).

const sessionHandler = require('../server/handlers/auth/session');
const handoffHandler = require('../server/handlers/auth/handoff');
const captchaHandler = require('../server/handlers/auth/captcha');
const verifyHandler = require('../server/handlers/auth/verify');

const quizStartHandler = require('../server/handlers/quiz/start');
const quizStatusHandler = require('../server/handlers/quiz/status');
const quizAnswerHandler = require('../server/handlers/quiz/answer');
const quizHintHandler = require('../server/handlers/quiz/hint');
const quizFinishHandler = require('../server/handlers/quiz/finish');
const quizHistoryHandler = require('../server/handlers/quiz/history');
const quizRankingHandler = require('../server/handlers/quiz/ranking');
const quizBatchHandler = require('../server/handlers/quiz/batch');
const quizNextHandler = require('../server/handlers/quiz/next');

const aiGenerateHandler = require('../server/handlers/ai/generate');
const aiQuotaHandler = require('../server/handlers/ai/quota');
const aiAnalyzeHandler = require('../server/handlers/ai/analyze');

const ragContextHandler = require('../server/handlers/rag/context');
const ocrAnalyzeHandler = require('../server/handlers/ocr/analyze');

const pvpGenerateQuestionsHandler = require('../server/handlers/pvp/generate-questions');
const pvpNextQuestionHandler = require('../server/handlers/pvp/next-question');
const pvpPresenceHandler = require('../server/handlers/pvp/presence');
const pvpInvitationsHandler = require('../server/handlers/pvp/invitations');
const pvpMatchHandler = require('../server/handlers/pvp/match');
const pvpJoinHandler = require('../server/handlers/pvp/join');
const pvpQuestionsHandler = require('../server/handlers/pvp/questions');
const pvpCancelHandler = require('../server/handlers/pvp/cancel');
const pvpEmoteHandler = require('../server/handlers/pvp/emote');
const pvpStartDuelHandler = require('../server/handlers/pvp/start-duel');
const pvpScoreHandler = require('../server/handlers/pvp/score');
const pvpStatusHandler = require('../server/handlers/pvp/status');

const adminStatsHandler = require('../server/handlers/admin/stats');
const adminSubscriptionHandler = require('../server/handlers/admin/subscription');
const adminCloudinarySignHandler = require('../server/handlers/admin/cloudinary-sign');
const adminDocumentsHandler = require('../server/handlers/admin/documents');
const adminConfigHandler = require('../server/handlers/admin/config');
const adminAiModelsHandler = require('../server/handlers/admin/ai-models');
const adminRagTestHandler = require('../server/handlers/admin/rag-test');

const routeHandlers = {
  'auth/session': sessionHandler,
  'auth/handoff': handoffHandler,
  'auth/captcha': captchaHandler,
  'auth/verify': verifyHandler,
  'quiz/start': quizStartHandler,
  'quiz/status': quizStatusHandler,
  'quiz/answer': quizAnswerHandler,
  'quiz/hint': quizHintHandler,
  'quiz/finish': quizFinishHandler,
  'quiz/history': quizHistoryHandler,
  'quiz/ranking': quizRankingHandler,
  'quiz/batch': quizBatchHandler,
  'quiz/next': quizNextHandler,
  'ai/generate': aiGenerateHandler,
  'ai/quota': aiQuotaHandler,
  'ai/analyze': aiAnalyzeHandler,
  'rag/context': ragContextHandler,
  'ocr/analyze': ocrAnalyzeHandler,
  'pvp/generate-questions': pvpGenerateQuestionsHandler,
  'pvp/next-question': pvpNextQuestionHandler,
  'pvp/presence': pvpPresenceHandler,
  'pvp/invitations': pvpInvitationsHandler,
  'pvp/match': pvpMatchHandler,
  'pvp/join': pvpJoinHandler,
  'pvp/questions': pvpQuestionsHandler,
  'pvp/cancel': pvpCancelHandler,
  'pvp/emote': pvpEmoteHandler,
  'pvp/start-duel': pvpStartDuelHandler,
  'pvp/score': pvpScoreHandler,
  'pvp/status': pvpStatusHandler,
  'admin/stats': adminStatsHandler,
  'admin/subscription': adminSubscriptionHandler,
  'admin/cloudinary-sign': adminCloudinarySignHandler,
  'admin/documents': adminDocumentsHandler,
  'admin/config': adminConfigHandler,
  'admin/ai-models': adminAiModelsHandler,
  'admin/rag-test': adminRagTestHandler
};

function getRoute(req) {
  const queryPath = req.query && req.query.path;
  if (typeof queryPath === 'string' && queryPath.trim()) {
    return queryPath.replace(/^\/+|\/+$/g, '');
  }
  let pathname = '';
  try {
    const u = new URL(String(req.url || '/'), 'http://localhost');
    pathname = u.pathname || '';
  } catch (_) {
    pathname = String(req.url || '').split('?')[0];
  }
  return pathname.replace(/^\/+/, '').replace(/^api\/?/, '').replace(/^\/+|\/+$/g, '');
}

function publicError(error) {
  const status = Number(error?.status || 0);
  if ([400, 401, 403, 404, 405, 409, 410, 412, 415, 422, 429, 402].includes(status)) {
    return { status, payload: { success: false, error: error?.message || 'Requête invalide' } };
  }
  return {
    status: 200,
    payload: {
      success: false,
      error: 'Service temporairement indisponible.',
      code: 'API_TEMPORARILY_UNAVAILABLE'
    }
  };
}

module.exports = async function handler(req, res) {
  const path = getRoute(req);
  try {
    if (!path || path === 'index.js') {
      return res.status(200).json({
        success: true,
        name: 'HosBac Quiz API',
        version: '31.4.4-pro+',
        status: 'ok'
      });
    }

    const routeHandler = routeHandlers[path];
    if (!routeHandler) {
      return res.status(404).json({ success: false, error: 'Route API inconnue', route: path });
    }

    if (typeof routeHandler !== 'function') {
      console.error(`[API] Handler invalide pour ${path}`);
      return res.status(200).json({
        success: false,
        error: 'Service temporairement indisponible.',
        code: 'ROUTE_LOAD_FAILED'
      });
    }

    console.log('[API] hit', path, req.method);
    const result = await Promise.resolve(routeHandler(req, res));
    return result;
  } catch (error) {
    console.error(`[API ERROR - ${req.url}]`, error);
    const out = publicError(error);
    return res.status(out.status).json(out.payload);
  }
};
