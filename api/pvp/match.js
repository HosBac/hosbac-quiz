"use strict";
module.exports = async function safePvpMatch(req, res) {
  try {
    const handler = require("../../server/handlers/pvp/match");
    return await Promise.resolve(handler(req, res));
  } catch (error) {
    console.error(`[API ERROR - ${req.url}]`, error);
    const status = [400,401,402,403,404,405,409,410,429].includes(Number(error?.status)) ? Number(error.status) : 200;
    return res.status(status).json({success:false,error:error?.message || 'Erreur PvP'});
  }
};
