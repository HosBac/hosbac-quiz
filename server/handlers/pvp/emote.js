'use strict';
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
const ALLOWED = new Set(['🔥','🤯','👏','🎯']);
module.exports = async (req,res)=>{
  if(cors(req,res))return;
  if(req.method!=='POST')return json(res,405,{success:false,error:'POST requis'});
  try{
    const d=await requireAuth(req), id=String((req.body||{}).matchId||'').trim(), emote=String((req.body||{}).emote||'');
    if(!id)return json(res,400,{success:false,error:'matchId manquant'});
    if(!ALLOWED.has(emote))return json(res,400,{success:false,error:'Émote invalide'});
    const db=getAdmin().firestore(),ref=db.collection('quiz_matches').doc(id),snap=await ref.get();
    if(!snap.exists)return json(res,404,{success:false,error:'Match introuvable'});
    const m=snap.data(); if(m.player1!==d.uid&&m.player2!==d.uid)return json(res,403,{success:false,error:'Accès refusé'});
    const field=m.player1===d.uid?'host_last_emote':'guest_last_emote';
    await ref.set({[field]:emote,last_emote_at:Date.now()},{merge:true});
    return json(res,200,{success:true});
  }catch(e){return json(res,e.status||500,{success:false,error:e.message||'Émote impossible'});}
};
