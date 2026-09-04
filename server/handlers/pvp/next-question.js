'use strict';
const { getAdmin, json, requireAuth } = require('../../lib/firebase');
const { getAppConfig } = require('../../lib/app-config');
const cors = require('../../lib/cors');
const QUESTION_SECONDS = 30;
function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value._seconds === 'number') return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
  if (typeof value.seconds === 'number') return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  return Number(value) || 0;
}
async function settleWager(tx, db, m, scores) {
  const wager = Number(m.wager_xp || 0);
  const stake = Number(m.wager_total_xp || (wager * Math.max(1, Number(m.questionsLimit || 8))));
  if (stake <= 0 || m.wagerSettled) return { settlement:'none', winner:null };
  const a = Number(scores[m.player1] || 0), b = Number(scores[m.player2] || 0);
  const winner = a === b ? null : (a > b ? m.player1 : m.player2);
  const playerIds=[m.player1,m.player2].filter(Boolean);
  const snaps=await Promise.all(playerIds.map(uid=>tx.get(db.collection('users').doc(uid))));
  for(let i=0;i<playerIds.length;i++){
    const uid=playerIds[i], ref=db.collection('users').doc(uid), snap=snaps[i], u=snap.exists?snap.data():{};
    const delta = winner ? (uid === winner ? stake * 2 : 0) : stake;
    if (!delta) continue;
    const xp = Number(u.quiz_xp || 0) + delta;
    tx.set(ref, { quiz_xp:xp, totalXp:Number(u.totalXp||0)+delta, inspe_points:Number(u.inspe_points||0)+delta, quiz_level:Math.floor(xp/100)+1 }, { merge:true });
  }
  return { settlement:winner ? 'winner' : 'draw', winner };
}

module.exports = async (req,res)=>{
  if(cors(req,res))return;
  if(req.method!=='POST')return json(res,405,{success:false,error:'POST requis'});
  try{
    const d=await requireAuth(req);
    const db=getAdmin().firestore();
    const id=String((req.body||{}).matchId||'').trim();
    if(!id)return json(res,400,{success:false,error:'matchId manquant'});
    const cfg=await getAppConfig(getAdmin());
    const ref=db.collection('quiz_matches').doc(id);
    const result=await db.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists)throw Object.assign(new Error('Match introuvable'),{status:404});
      const m=snap.data();
      if(m.player1!==d.uid)return {forbidden:true};
      if(!m.player2)throw Object.assign(new Error('En attente du second joueur.'),{status:409});
      if(!['IN_PROGRESS','started'].includes(m.status))throw Object.assign(new Error('Le duel n’est pas en cours.'),{status:409});
      const idx=Number(m.currentQuestionIndex??m.questionIndex??0);
      const count=Math.max(1,Number(m.questionsLimit||cfg.pvpQuestions||8));
      const elapsed=toMillis(m.questionStartTime)?(Date.now()-toMillis(m.questionStartTime))/1000:0;
      const history=Array.isArray(m.answers_history)?[...m.answers_history]:[];
      let hostAnswered=!!m.host_answered, guestAnswered=!!m.guest_answered;
      const addTimeout=(uid,player)=>{
        if(!uid)return;
        const already=history.some(h=>Number(h.questionIndex)===idx&&h.uid===uid);
        if(!already)history.push({questionIndex:idx,player,uid,answer:null,correct:false,points:0,elapsedSeconds:QUESTION_SECONDS,timedOut:true,answeredAt:Date.now()});
      };
      if(elapsed>=QUESTION_SECONDS){
        if(!hostAnswered){addTimeout(m.player1,'host');hostAnswered=true;}
        if(!guestAnswered){addTimeout(m.player2,'guest');guestAnswered=true;}
      }
      if(!hostAnswered || !guestAnswered) throw Object.assign(new Error('Les deux joueurs doivent avoir répondu ou le temps doit être écoulé.'),{status:409});
      const scores=m.scores||{};
      if(idx+1>=count){
        // Toutes les lectures Firestore sont faites avant les écritures de la transaction.
        const hostSnap=await tx.get(db.collection('users').doc(m.player1));
        const guestSnap= m.player2 ? await tx.get(db.collection('users').doc(m.player2)) : null;
        const hostUser=hostSnap.exists?hostSnap.data():{};
        const guestUser=guestSnap?.exists?guestSnap.data():{};
        const settlement=await settleWager(tx,db,{...m,answers_history:history},scores);
        const historyRef=db.collection('match_history').doc(ref.id);
        tx.set(historyRef,{
          matchId:ref.id,
          host:{uid:m.player1,name:hostUser.displayName||`${hostUser.prenom||''} ${hostUser.nom||''}`.trim()||'Élève'},
          guest:{uid:m.player2||null,name:guestUser.displayName||`${guestUser.prenom||''} ${guestUser.nom||''}`.trim()||'Élève'},
          scores,
          winner:settlement.winner||'draw',
          timestamp:getAdmin().firestore.Timestamp.now(),
          questions:Array.isArray(m.questions)?m.questions:[],
          answers_history:history,
          wager_xp:Number(m.wager_xp||0),
          wager_total_xp:stake
        },{merge:false});
        tx.update(ref,{answers_history:history,status:'COMPLETED',completedAt:getAdmin().firestore.Timestamp.now(),host_answered:hostAnswered,guest_answered:guestAnswered,wagerSettled:true,wagerSettlement:settlement.settlement,...(settlement.winner?{wagerWinner:settlement.winner}:{})});
        for(const uid of [m.player1,m.player2].filter(Boolean)){
          tx.set(db.collection('users').doc(uid),{pvpStatus:'idle',pvpMatchId:null},{merge:true});
          tx.set(db.collection('users_online').doc(uid),{status:'idle',matchId:null,updatedAt:getAdmin().firestore.Timestamp.now()},{merge:true});
        }
        return {completed:true,status:'COMPLETED',currentQuestionIndex:idx,winner:settlement.winner||'draw',scores};
      }
      const next=idx+1;
      const qStart=getAdmin().firestore.Timestamp.now();
      tx.update(ref,{answers_history:history,currentQuestionIndex:next,questionIndex:next,questionStartTime:qStart,host_answered:false,guest_answered:false});
      return {completed:false,status:'IN_PROGRESS',currentQuestionIndex:next,questionStartTime:qStart,scores};
    });
    if(result.forbidden)return json(res,403,{success:false,error:'Seul l’hôte peut passer à la question suivante.'});
    return json(res,200,{success:true,...result});
  }catch(e){return json(res,e.status||500,{success:false,error:e.message||'Transition PvP impossible'});}
};
