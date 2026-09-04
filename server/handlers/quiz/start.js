const {getAppConfig}=require("../../lib/app-config");
const crypto = require("crypto");
const { getAdmin, json, requireAuth } = require("../../lib/firebase");
const { normalize } = require("../../lib/config");
const cors = require("../../lib/cors");

const TIME_ZONE = process.env.QUIZ_TIMEZONE || "Africa/Porto-Novo";
function localParts(){const p={};for(const x of new Intl.DateTimeFormat("en-CA",{timeZone:TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date()))if(x.type!=="literal")p[x.type]=x.value;return p;}
function todayKey(){const p=localParts();return `${p.year}-${p.month}-${p.day}`;}
function localDay(){const w=new Intl.DateTimeFormat("en-US",{timeZone:TIME_ZONE,weekday:"short"}).format(new Date());return ({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6})[w];}
function currentHour(){return Number(localParts().hour||0);}
function isAdmin(u){return u?.role==="admin"||u?.isAdmin===true;}

module.exports=async(req,res)=>{
 if(cors(req,res))return;
 if(req.method!=="POST")return json(res,405,{success:false,error:"Méthode non autorisée"});
 try{
  const decoded=await requireAuth(req),db=getAdmin().firestore(),body=req.body||{},config=await getAppConfig(getAdmin),dayKey=todayKey();
  const userSnap=await db.collection("users").doc(decoded.uid).get();
  const userData=userSnap.exists?userSnap.data():{};
  const admin=isAdmin(userData);
  if(!admin && !config.enabledDays.includes(localDay())) return json(res,403,{success:false,code:"QUIZ_DAY_CLOSED",error:"Les quiz sont disponibles selon le calendrier configuré par l’administrateur."});
  if(!admin){const h=currentHour();const inWindow=config.quizStartHour<=config.quizEndHour?h>=config.quizStartHour&&h<=config.quizEndHour:h>=config.quizStartHour||h<=config.quizEndHour;if(!inWindow)return json(res,403,{success:false,code:"QUIZ_HOUR_CLOSED",error:`Les quiz sont ouverts de ${String(config.quizStartHour).padStart(2,"0")}h à ${String(config.quizEndHour).padStart(2,"0")}h.`});}
  const profileClasse=String(userData.classe||userData.class||"").trim();
  const classe=String(body.classe||profileClasse||"").trim();
  const serie=String(body.serie||userData.serie||"").trim();
  const matiere=String(body.matiere||userData.matiere||userData.subject||"").trim();
  if(profileClasse && classe !== profileClasse) return json(res,403,{success:false,code:"PROFILE_CLASS_MISMATCH",error:"La classe du quiz ne correspond pas à celle du profil."});
  const chapitre=String(body.chapitre||"").trim();
  const deviceId=String(body.deviceId||"").trim()||crypto.randomUUID();
  const allowedClasses=["6ème","5ème","4ème","3ème","2nd","1ère","Terminale"];
  const allowedSeries=["A","B","C","D","AB","CD","A+B","C+D"];
  if(!classe)return json(res,400,{success:false,code:"PROFILE_CLASS_REQUIRED",error:"Classe obligatoire. Complète ton profil HosBac avant de commencer."});
  if(!allowedClasses.includes(classe))return json(res,400,{success:false,code:"INVALID_CLASS",error:"Classe invalide."});
  if(["2nd","1ère","Terminale"].includes(classe)&&!serie)return json(res,400,{success:false,code:"PROFILE_SERIES_REQUIRED",error:"Série obligatoire pour cette classe."});
  if(!["2nd","1ère","Terminale"].includes(classe)&&serie)return json(res,400,{success:false,code:"SERIES_NOT_ALLOWED",error:"La série n'est disponible qu'à partir de la seconde."});
  if(serie&&!allowedSeries.includes(serie))return json(res,400,{success:false,code:"INVALID_SERIES",error:"Série invalide."});
  if(!matiere)return json(res,400,{success:false,error:"Matière manquante"});

  // Un seul appareil/session actif. Le nouveau téléphone invalide immédiatement l'ancien.
  const active=await db.collection("quiz_sessions").where("userId","==",decoded.uid).where("status","==","active").limit(20).get();
  const batch=db.batch();
  active.docs.forEach(doc=>batch.update(doc.ref,{status:"cancelled",cancelReason:"new_device_or_new_session",cancelledAt:getAdmin().firestore.Timestamp.now()}));
  if(!active.empty)await batch.commit();

  // Le quota journalier s'applique UNIQUEMENT aux quiz solo.
  // Les duels PvP (quizType=pvp_duel) ne consomment pas la limite quotidienne.
  const quizType=String(body.quizType||body.type||"solo").toLowerCase();
  const isPvp=quizType==="pvp_duel"||quizType==="pvp"||body.pvp===true||Boolean(body.matchId);
  let used=0;
  if(!admin && !isPvp){
   const daySnap=await db.collection("quiz_sessions")
     .where("userId","==",decoded.uid)
     .where("dayKey","==",dayKey)
     .get();
   used=daySnap.docs.reduce((sum,doc)=>{
     const d=doc.data()||{};
     if(String(d.matiere||"")!==matiere) return sum;
     return sum + (Array.isArray(d.answers)?d.answers.length:0);
   },0);
   const sessionSize=Number(config.questionsPerQuiz);
   const dailyLimit=Number(config.dailyQuizLimit);
   const remaining=Math.max(0,dailyLimit-used);
   if(remaining < sessionSize){
     return json(res,429,{success:false,code:"DAILY_LIMIT",used,remaining,limit:dailyLimit,matiere,required:sessionSize,error:remaining>0?`Il reste ${remaining} question(s) pour ${matiere}. Un quiz complet nécessite ${sessionSize} question(s).`:`Limite de ${dailyLimit} questions atteinte aujourd'hui pour ${matiere}.`});
   }
  }

  const startAt=Date.now(),sessionId=crypto.randomUUID();
  const questionsLimit=Number(config.questionsPerQuiz);
  await db.collection("quiz_sessions").doc(sessionId).set({userId:decoded.uid,dayKey,status:"active",deviceId,createdAt:getAdmin().firestore.Timestamp.now(),serverStartMs:startAt,quizId:sessionId,classe,level:classe,serie,matiere,subject:matiere,chapitre,questions:[],answers:[],currentIndex:0,correctStreak:0,currentDifficulty:1,difficultyLevel:String(body.difficulty||body.difficultyLevel||"moyen").toLowerCase(),xpEarned:0,questionsCount:0,questionsLimit,isAdminSession:admin,quizType:isPvp?"pvp_duel":"solo",matchId:body.matchId||null});
  return json(res,200,{success:true,resumed:false,sessionId,quizId:sessionId,config:{...config,questionsPerQuiz:questionsLimit},remaining:admin?null:Math.max(0,config.dailyQuizLimit-used-questionsLimit),admin,profile:{classe,serie,matiere,quiz_xp:Number(userData.quiz_xp||0)}});
 }catch(e){console.error("[QUIZ START]",e);return json(res,e.status||500,{success:false,error:e.message||"Impossible de démarrer le quiz."});}
};
