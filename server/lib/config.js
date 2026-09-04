const DEFAULT_CONFIG = {
  enabledDays: [1,2,3,4,5,6,0],
  quizStartHour: 0,
  quizEndHour: 23,
  questionsPerQuiz: 8,
  baseXP: 1,
  default_xp_per_correct_answer: 1,
  speedThresholdSeconds: 5,
  speedMultiplier: 1,
  streakRequired: 3,
  missedPenaltyXP: 0,
  dailyQuizLimit: 8,
  xpSubscriptionThreshold: 1000,
  subscriptionDays: 30,
  dailyAiRequests: 10,
  maxDailyAiRequests: 1000,
  aiToolCostXP: 3,
  pvpMinutes: 10,
  pvpXPPerQuestion: 1,
  levels: {min:1,max:4}
};
function normalize(c={}) {
  const raw={...c};
  if(raw.daily_requests_limit!=null&&raw.dailyAiRequests==null) raw.dailyAiRequests=raw.daily_requests_limit;
  if(raw.daily_ai_limit!=null&&raw.dailyAiRequests==null) raw.dailyAiRequests=raw.daily_ai_limit;
  if(raw.maxDailyRequests!=null&&raw.dailyAiRequests==null) raw.dailyAiRequests=raw.maxDailyRequests;
  const x={...DEFAULT_CONFIG,...raw};
  x.enabledDays=Array.isArray(x.enabledDays)?[...new Set(x.enabledDays.map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<=6))]:DEFAULT_CONFIG.enabledDays;
  x.quizStartHour=Math.max(0,Math.min(23,Number.isFinite(Number(x.quizStartHour))?Number(x.quizStartHour):DEFAULT_CONFIG.quizStartHour));
  x.quizEndHour=Math.max(0,Math.min(23,Number.isFinite(Number(x.quizEndHour))?Number(x.quizEndHour):DEFAULT_CONFIG.quizEndHour));
  const configuredQuestions = Number(x.questionsPerQuiz);
  x.questionsPerQuiz=Math.max(1,Math.min(100,Number.isFinite(configuredQuestions)&&configuredQuestions>0?configuredQuestions:DEFAULT_CONFIG.questionsPerQuiz));
  const configuredDailyQuizLimit = Number(x.dailyQuizLimit);
  x.dailyQuizLimit=Math.max(x.questionsPerQuiz,Number.isFinite(configuredDailyQuizLimit)&&configuredDailyQuizLimit>0?configuredDailyQuizLimit:x.questionsPerQuiz);
  if(raw.default_xp_per_correct_answer!=null && raw.baseXP==null) x.baseXP=Number(raw.default_xp_per_correct_answer);
  if(raw.baseXP!=null) x.default_xp_per_correct_answer=Number(raw.baseXP);
  x.baseXP=Math.max(1,Number(x.baseXP)||1);
  x.default_xp_per_correct_answer=Math.max(0,Number(x.default_xp_per_correct_answer)||x.baseXP);
  x.speedThresholdSeconds=Math.max(1,Number(x.speedThresholdSeconds)||5);
  x.speedMultiplier=Math.max(1,Number(x.speedMultiplier)||1);
  x.streakRequired=Math.max(1,Number(x.streakRequired)||3);
  x.missedPenaltyXP=Math.max(0,Number(x.missedPenaltyXP)||0);
  x.xpSubscriptionThreshold=Math.max(1,Number(x.xpSubscriptionThreshold)||1000);
  x.subscriptionDays=Math.max(1,Number(x.subscriptionDays)||30);
  x.maxDailyAiRequests=Math.max(1,Number(x.maxDailyAiRequests)||100000);
  const dai=Number(x.dailyAiRequests);
  // AUCUN plafond artificiel à 10
  x.dailyAiRequests=Math.max(1,Number.isFinite(dai)&&dai>0?Math.min(100000,dai):10);
  x.aiToolCostXP=Math.max(0,Math.min(1000,Number(x.aiToolCostXP)||3));
  x.pvpMinutes=Math.max(1,Math.min(60,Number(x.pvpMinutes)||10));
  x.pvpXPPerQuestion=Math.max(1,Math.min(100,Number(x.pvpXPPerQuestion)||1));
  return x;
}
module.exports={DEFAULT_CONFIG,normalize};
