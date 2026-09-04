"use strict";
module.exports = async function safeQuizStatus(req, res) {
  try {
    const handler = require("../../server/handlers/quiz/status");
    return await Promise.resolve(handler(req, res));
  } catch (error) {
    console.error(`[API ERROR - ${req.url}]`, error);
    const status = [401,403,405].includes(Number(error?.status)) ? Number(error.status) : 200;
    return res.status(status).json(status === 200
      ? {success:false,xp:0,status:'idle',error:'Statut du quiz temporairement indisponible.'}
      : {success:false,error:error?.message || 'Non autorisé'});
  }
};
