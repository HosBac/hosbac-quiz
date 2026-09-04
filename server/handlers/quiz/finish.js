const {getAdmin,json,requireAuth}=require("../../lib/firebase");
const cors=require("../../lib/cors");
const rag=require("../../lib/rag");
module.exports=async(req,res)=>{
 if(cors(req,res))return;
 if(req.method!=="POST")return json(res,405,{success:false,error:"Méthode non autorisée"});
 try{
  const d=await requireAuth(req),db=getAdmin().firestore(),b=req.body||{};
  const ref=db.collection("quiz_sessions").doc(String(b.sessionId||"")),snap=await ref.get();
  if(!snap.exists)return json(res,404,{success:false,error:"Session introuvable"});
  const s=snap.data();
  if(s.userId!==d.uid)return json(res,403,{success:false,error:"Accès refusé"});
  const answers=Array.isArray(s.answers)?s.answers:[];
  const total=Math.max(1,Number(s.questionsLimit||s.questionsCount||s.questions?.length||answers.length||1));
  const correct=answers.filter(a=>a&&a.isCorrect).length;
  const xpEarned=answers.reduce((sum,a)=>sum+Math.max(0,Number(a?.xp||0)),0);
  const unanswered=Math.max(0,total-answers.length);
  const score=Math.round(correct/total*100);
  const perfect=answers.length>=total&&correct===total;
  if(s.status==="finished")return json(res,200,{success:true,alreadyFinished:true,xpEarned:Number(s.xpEarned||xpEarned),score:Number(s.finalScore||score),total,correct});
  const finishedAt = Date.now();
  await ref.update({status:"finished",endTime:getAdmin().firestore.Timestamp.now(),timestamp:finishedAt,createdAt:finishedAt,finalScore:score,xpEarned,unanswered,penaltyXP:0,perfect});

  // Neon quiz_results (best-effort, silencieux)
  try{
    await rag.saveQuizResult({
      userId:d.uid,
      score:correct,
      total,
      subject:s.matiere||"",
      classe:s.classe||"",
      serie:s.serie||"",
      sessionId:String(b.sessionId||"")
    });
  }catch(e){console.warn("[QUIZ FINISH] Neon result skip:",e.message);}

  return json(res,200,{success:true,score,total,correct,xpEarned,penaltyXP:0,perfect,unanswered});
 }catch(e){console.error("[QUIZ FINISH]",e);return json(res,e.status||500,{success:false,error:e.message});}
};
