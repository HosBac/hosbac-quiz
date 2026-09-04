'use strict';
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const cors = require('../../lib/cors');
module.exports=async(req,res)=>{
  if(cors(req,res))return;
  if(req.method!=='POST')return json(res,405,{success:false,error:'POST requis'});
  try{
    const d=await requireAuth(req),id=String((req.body||{}).matchId||'').trim();
    if(!id)return json(res,400,{success:false,error:'matchId manquant'});
    const db=getAdmin().firestore(),ref=db.collection('quiz_matches').doc(id),snap=await ref.get();
    if(!snap.exists)return json(res,404,{success:false,error:'Match introuvable'});
    const m=snap.data();
    if(m.player1!==d.uid&&m.player2!==d.uid)return json(res,403,{success:false,error:'Accès refusé'});
    if(!m.player2)return json(res,409,{success:false,error:'En attente du second joueur'});
    if(!Array.isArray(m.questions)||m.questions.length!==Number(m.questionsLimit||8))return json(res,409,{success:false,error:'Questions non prêtes'});
    if(['WAITING_GUEST','waiting'].includes(m.status)) await ref.set({status:'IN_PROGRESS',questionStartTime:getAdmin().firestore.Timestamp.now(),currentQuestionIndex:0,questionIndex:0,host_answered:false,guest_answered:false},{merge:true});
    return json(res,200,{success:true,matchId:id,status:'IN_PROGRESS',currentQuestionIndex:Number(m.currentQuestionIndex||0),questionsReady:true,questionsCount:Number(m.questionsLimit||8)});
  }catch(e){return json(res,e.status||500,{success:false,error:e.message||'Démarrage impossible'});}
};
