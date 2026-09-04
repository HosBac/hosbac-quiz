const {getAdmin,json,requireAuth}=require('../../lib/firebase');
const {normalize}=require('../../lib/config');
const cors=require('../../lib/cors');
module.exports=async(req,res)=>{
  if(cors(req,res))return;
  if(req.method!=='POST')return json(res,405,{success:false,error:'POST requis'});
  try{
    const d=await requireAuth(req),db=getAdmin().firestore(),b=req.body||{};
    const sessionId=String(b.sessionId||'').trim(),questionId=String(b.questionId||'').trim();
    if(!sessionId||!questionId)return json(res,400,{success:false,error:'sessionId et questionId sont obligatoires'});
    const ref=db.collection('quiz_sessions').doc(sessionId);
    const result=await db.runTransaction(async tx=>{
      const snap=await tx.get(ref); if(!snap.exists)throw Object.assign(new Error('Session introuvable'),{status:404});
      const s=snap.data(); if(s.userId!==d.uid)throw Object.assign(new Error('Accès refusé'),{status:403});
      if(s.status!=='active')throw Object.assign(new Error('Session terminée'),{status:409});
      const questions=Array.isArray(s.questions)?s.questions:[]; const q=questions.find(x=>String(x?.id)===questionId);
      if(!q)throw Object.assign(new Error('Question introuvable'),{status:404});
      const used=Array.isArray(s.hintsUsed)?s.hintsUsed:[];
      if(used.includes(questionId))return {alreadyUsed:true};
      const patch={hintsUsed:[...used,questionId]};
      tx.update(ref,patch);
      return {alreadyUsed:false};

    });
    return json(res,200,{success:true,...result,penaltyRate:0.30});
  }catch(e){return json(res,e.status||500,{success:false,code:e.code,error:e.message});}
};
