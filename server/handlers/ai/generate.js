const { withRetry, isHighDemandError, geminiModelCascade, sleep } = require('../../lib/ai-retry');
const { requireAuth, json } = require("../../lib/firebase");
const cors = require("../../lib/cors");
const { normalizeQuestionMath } = require("../../lib/math-format");
const { generateWithFallback } = require("../../lib/ai-fallback");

/**
 * HosBac Quiz - AI Generator
 *
 * Fournisseur principal :
 *   Groq
 *
 * Fallback :
 *   Hugging Face Inference Providers
 *
 * Variables Vercel :
 *   GROQ_API_KEY
 *   GROQ_MODEL
 *   HF_API_KEY
 *   HF_MODEL
 *
 * Modèle Groq recommandé :
 *   openai/gpt-oss-120b
 *
 * Modèle HF :
 *   configurable avec HF_MODEL
 */

const STRICT_QUESTION_SYSTEM =
  "RÈGLE DE CONFORMITÉ ACADÉMIQUE ABSOLUE : si la demande concerne des paris sportifs, jeux d'argent, factures, contenu vulgaire ou non-académique, renvoie uniquement {\"status\":\"rejected\",\"error\":\"Document non conforme.\"}. " +
  "Tu es l'intelligence artificielle pédagogique de HosBac Quiz. Retourne uniquement un JSON conforme au schéma demandé. " +
  "Chaque question doit contenir exactement les champs theme, question, options et hint. " +
  "Chaque option doit contenir exactement les champs text, is_correct et feedback. " +
  "Les options doivent être distinctes, une seule doit avoir is_correct=true et les trois autres is_correct=false. " +
  "Le champ feedback doit expliquer précisément le raisonnement, y compris l'erreur pédagogique propre à chaque distracteur. " +
  "RÈGLES DE FORMATAGE MATHÉMATIQUE ABSOLUES : les formules mathématiques sont STRICTEMENT RÉSERVÉES aux matières Mathématiques et Physique-Chimie (PCT). Utilise uniquement $...$ pour le LaTeX en ligne et $$...$$ pour les blocs. N’utilise JAMAIS \( ... \) ni \[ ... \]. Pour SVT, Anglais, Français, Histoire-Géo, Philosophie et toute autre matière littérale, INTERDICTION TOTALE de LaTeX ou de balises mathématiques : texte brut clair uniquement. " +
  "Le champ hint doit être subtil et ne jamais donner la réponse. " +
  "N'invente aucune information absente du contexte fourni. " +
  "Ne génère aucun champ context, contexte ou context_text.";

function extractJson(text) {
  if (!text) return null;

  let t = String(text).trim();

  // Retire les éventuels blocs Markdown.
  t = t
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Première tentative : réponse JSON directe.
  try {
    const direct = JSON.parse(t);
    if (Array.isArray(direct)) {
      return normalizeQuestions(direct);
    }

    // Certains modèles peuvent retourner :
    // {"questions":[...]}
    if (direct && Array.isArray(direct.questions)) {
      return normalizeQuestions(direct.questions);
    }
  } catch (_) {
    // On continue avec l'extraction.
  }

  // Recherche d'un tableau JSON dans une réponse plus longue.
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(t.slice(start, end + 1));

    if (!Array.isArray(parsed)) {
      return null;
    }

    return normalizeQuestions(parsed);
  } catch (_) {
    return null;
  }
}


function normalizeMathMarkup(value) {
  return normalizeQuestionMath({ question: String(value || "") }).question;
}

function shuffleQuestionOptions(question) {
  if (!question || !Array.isArray(question.choices) || question.choices.length < 2) {
    if (!question || !Array.isArray(question.options) || question.options.length < 2) return question;
  }

  // Format options[{id, texte, est_correcte, feedback}]
  if (Array.isArray(question.options) && question.options.length >= 2) {
    const shuffled = [...question.options];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    question.options = shuffled.map((option, index) => ({
      ...option,
      id: String.fromCharCode(65 + index)
    }));
    return question;
  }

  // Format HosBac interne: choices[] + correctAnswer (index).
  if (!Array.isArray(question.choices) || question.choices.length < 2) return question;
  const originalCorrect = Number(question.correctAnswer);
  const indexed = question.choices.map((choice, index) => ({ choice, index }));

  for (let i = indexed.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }

  question.choices = indexed.map(({ choice }) => choice);
  question.correctAnswer = indexed.findIndex(({ index }) => index === originalCorrect);
  question.correctChoice = question.choices[question.correctAnswer] || '';

  if (question.option_explanations && typeof question.option_explanations === 'object') {
    const old = question.option_explanations;
    const remapped = {};
    indexed.forEach(({ index }, newIndex) => {
      if (old[String(index)] != null) remapped[String(newIndex)] = old[String(index)];
    });
    question.option_explanations = remapped;
  }
  if (question.explanations && typeof question.explanations === 'object') {
    const old = question.explanations;
    const remapped = {};
    indexed.forEach(({ index }, newIndex) => {
      const oldLetter = String.fromCharCode(65 + index);
      const newLetter = String.fromCharCode(65 + newIndex);
      if (old[oldLetter] != null) remapped[newLetter] = old[oldLetter];
    });
    question.explanations = remapped;
  }

  return question;
}

function normalizeQuestions(items) {
  if (!Array.isArray(items)) return null;

  const questions = items
    .map((q, i) => {
      if (!q || typeof q !== "object") return null;

      const letterMap = { A: 0, B: 1, C: 2, D: 3 };
      let choices = [];
      let correctAnswer = Number(q.correctAnswer);
      const optionExplanations = {};
      const explanations = {};

      if (Array.isArray(q.options) && q.options.length >= 2) {
        const opts = q.options.slice(0, 4);
        choices = opts.map((o) => String((o && (o.texte || o.text || o.label)) || ""));
        opts.forEach((o, idx) => {
          if (!o || typeof o !== "object") return;
          const letter = String(o.id || String.fromCharCode(65 + idx))
            .toUpperCase()
            .replace(/[^A-D]/g, "")
            .slice(0, 1) || String.fromCharCode(65 + idx);
          const i2 = letterMap[letter] != null ? letterMap[letter] : idx;
          const fb = String(o.feedback || o.explanation || "").trim();
          if (fb) {
            optionExplanations[String(i2)] = fb;
            explanations[letter] = fb;
          }
          if (o.est_correcte === true || o.isCorrect === true || o.correct === true) {
            correctAnswer = i2;
          }
        });
      } else if (Array.isArray(q.choices)) {
        choices = q.choices.slice(0, 4).map((ch) => {
          if (ch && typeof ch === "object") return String(ch.texte || ch.text || ch.label || "");
          return String(ch);
        });
      }

      if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) {
        const letter = String(q.correct_answer || q.correctAnswer || "")
          .trim()
          .toUpperCase();
        if (letterMap[letter] != null) correctAnswer = letterMap[letter];
        else correctAnswer = 0;
      }

      // Merge explanations objects if provided
      const letterExpl = q.explanations || {};
      for (const L of ["A", "B", "C", "D"]) {
        if (letterExpl[L] && !explanations[L]) {
          explanations[L] = String(letterExpl[L]);
          optionExplanations[String(letterMap[L])] = String(letterExpl[L]);
        }
      }
      const ox = q.option_explanations || {};
      for (let i = 0; i < 4; i++) {
        if (ox[String(i)] && !optionExplanations[String(i)]) {
          optionExplanations[String(i)] = String(ox[String(i)]);
          explanations[String.fromCharCode(65 + i)] = String(ox[String(i)]);
        }
      }

      return {
        id:
          q.id ||
          `q_${Date.now()}_${i}_${Math.random()
            .toString(36)
            .slice(2, 8)}`,

        theme: normalizeMathMarkup(q.theme || q.topic || q.chapter || ""),

        question: normalizeMathMarkup(q.question),

        choices: choices.map(normalizeMathMarkup),

        options: choices.map((choice, index) => ({
          text: normalizeMathMarkup(choice),
          is_correct: index === (Number.isInteger(correctAnswer) ? correctAnswer : 0),
          feedback: normalizeMathMarkup(optionExplanations[String(index)] || "")
        })),

        correctAnswer:
          Number.isInteger(correctAnswer) &&
          correctAnswer >= 0 &&
          correctAnswer < 4
            ? correctAnswer
            : 0,

        explanation: normalizeMathMarkup(q.explanation || explanations[String.fromCharCode(65 + (Number.isInteger(correctAnswer) ? correctAnswer : 0))] || ""),

        option_explanations: optionExplanations,
        explanations: explanations,

        hint: normalizeMathMarkup(q.hint),

        difficulty: Math.max(
          1,
          Math.min(4, Number(q.difficulty) || 1)
        )
      };
    })
    .filter(
      q =>
        q &&
        q.question &&
        q.choices.length === 4
    );

  if (!questions.length) return null;
  return questions.map((question) => shuffleQuestionOptions(question));
}

/**
 * Génération avec Mistral.
 */
async function mistral(prompt) {
  const apiKey=process.env.MISTRAL_API_KEY;
  if(!apiKey)throw new Error("MISTRAL_API_KEY manquante");
  const model=process.env.MISTRAL_MODEL||"mistral-small-latest";
  const response=await fetch("https://api.mistral.ai/v1/chat/completions",{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`},
    body:JSON.stringify({model,messages:[
      {role:"system",content:STRICT_QUESTION_SYSTEM},
      {role:"user",content:prompt}
    ],temperature:0.2,max_tokens:3000,response_format:{type:"json_object"}})
  });
  const rawText=await response.text();
  if(!response.ok)throw new Error(`Mistral HTTP ${response.status}: ${rawText.slice(0,500)}`);
  let data;try{data=JSON.parse(rawText)}catch{throw new Error("Réponse Mistral invalide")}
  const questions=extractJson(data?.choices?.[0]?.message?.content);
  if(!questions)throw new Error("Mistral a répondu, mais le JSON des questions est invalide");
  return questions;
}

/**
 * Génération avec Groq.
 */
async function groq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("GROQ_API_KEY manquante");
  }

  const model =
    process.env.GROQ_MODEL ||
    "openai/gpt-oss-120b";

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },

      body: JSON.stringify({
        model,

        messages: [
          {
            role: "system",
            content:
              STRICT_QUESTION_SYSTEM
          },

          {
            role: "user",
            content: prompt
          }
        ],

        temperature: 0.2,

        max_tokens: 3000,

        response_format: {
          type: "json_object"
        }
      })
    }
  );

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Groq HTTP ${response.status}: ${rawText.slice(0, 500)}`
    );
  }

  let data;

  try {
    data = JSON.parse(rawText);
  } catch (_) {
    throw new Error("Réponse Groq invalide");
  }

  const content =
    data?.choices?.[0]?.message?.content;

  const questions = extractJson(content);

  if (!questions) {
    throw new Error(
      "Groq a répondu, mais le JSON des questions est invalide"
    );
  }

  return questions;
}

/**
 * Génération via Hugging Face Inference Providers.
 *
 * HF utilise une API compatible chat-completions.
 */
async function huggingFace(prompt) {
  const apiKey = process.env.HF_API_KEY;

  if (!apiKey) {
    throw new Error("HF_API_KEY manquante");
  }

  const model =
    process.env.HF_MODEL ||
    "Qwen/Qwen2.5-7B-Instruct";

  const response = await fetch(
    "https://router.huggingface.co/v1/chat/completions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },

      body: JSON.stringify({
        model,

        messages: [
          {
            role: "system",
            content: STRICT_QUESTION_SYSTEM
          },

          {
            role: "user",
            content: prompt
          }
        ],

        temperature: 0.2,

        max_tokens: 3000
      })
    }
  );

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Hugging Face HTTP ${response.status}: ${rawText.slice(0, 500)}`
    );
  }

  let data;

  try {
    data = JSON.parse(rawText);
  } catch (_) {
    throw new Error(
      "Réponse Hugging Face invalide"
    );
  }

  const content =
    data?.choices?.[0]?.message?.content;

  const questions = extractJson(content);

  if (!questions) {
    throw new Error(
      "Hugging Face a répondu, mais le JSON des questions est invalide"
    );
  }

  return questions;
}



async function cloudflareGenerate(prompt,token,account,model,label,errors){
  if(!token||!account)return null;
  try{
    const sysCf=STRICT_QUESTION_SYSTEM;
    const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${encodeURIComponent(model)}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({messages:[{role:'system',content:sysCf},{role:'user',content:prompt}]})});
    if(!r.ok){errors.push({provider:label,error:`HTTP ${r.status}`});return null;}
    const d=await r.json();const raw=d?.result?.response||d?.result?.content||d?.result?.text||'';return extractJson(raw);
  }catch(e){errors.push({provider:label,error:e.message});return null;}
}
async function geminiGenerate(prompt, apiKey, label, errors) {
  if(!apiKey)return null;
  const models = geminiModelCascade();
  for (const model of models) {
    try {
      const result = await withRetry(async (attempt) => {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: STRICT_QUESTION_SYSTEM + "\n\n" + prompt }] }], generationConfig: { temperature: .2, maxOutputTokens: 1500, responseMimeType: "application/json" } })
        });
        const bodyText = await r.text().catch(() => "");
        if (!r.ok) {
          const err = new Error(`HTTP ${r.status} ${bodyText.slice(0, 300)}`);
          err.status = r.status;
          if (isHighDemandError(r.status, bodyText, bodyText)) throw err;
          errors.push({ provider: label + "/" + model, error: err.message });
          return null;
        }
        let d = {};
        try { d = JSON.parse(bodyText); } catch (_) {}
        const q = extractJson(d?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "");
        if (!q) throw Object.assign(new Error("JSON invalide"), { status: 503 });
        return q;
      }, { maxAttempts: 3, baseDelayMs: 1000, label: label + "/" + model });
      if (result) return result;
    } catch (e) {
      errors.push({ provider: label + "/" + model, error: e.message });
    }
  }
  return null;
}
async function openRouterGenerate(prompt, apiKey, label, errors) {
  if(!apiKey)return null;
  try{
    const model=process.env.OPENROUTER_MODEL||"openai/gpt-4o-mini";
    const r=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`,"X-Title":"HosBac Quiz"},body:JSON.stringify({model,messages:[{role:"system",content:STRICT_QUESTION_SYSTEM},{role:"user",content:prompt}],temperature:.2,max_tokens:1500,response_format:{type:"json_object"}})});
    if(!r.ok){errors.push({provider:label,error:`HTTP ${r.status}`});return null;}
    const d=await r.json(); return extractJson(d?.choices?.[0]?.message?.content||"");
  }catch(e){errors.push({provider:label,error:e.message});return null;}
}

function finalizeGeneratedQuestions(questions) {
  if (!Array.isArray(questions)) return questions;
  return questions.map((question) => normalizeQuestionMath(question, question?.subject || question?.matiere || ""));
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "Méthode non autorisée"
    });
  }

  try {
    await requireAuth(req);

    const body = req.body || {};

    const prompt = String(body.prompt || "").trim();

    if (!prompt) {
      return json(res, 400, {
        success: false,
        error: "Prompt manquant"
      });
    }

    if (prompt.length > 24000) {
      return json(res, 413, {
        success: false,
        error:
          "Contexte trop volumineux. Utilisez le RAG par fragments."
      });
    }

    const errors = [];
    try {
      const fb = await generateWithFallback(prompt, {
        jsonMode: true,
        temperature: 0.35,
        maxTokens: 3000,
        level: body.classe || body.level || '',
        subject: body.matiere || body.subject || ''
      });
      const questions = extractJson(fb.text);
      if (questions) {
        return json(res, 200, {
          success:true,
          provider:fb.provider,
          model:fb.model,
          questions:finalizeGeneratedQuestions(questions)
        });
      }
      errors.push({provider:fb.provider,error:'Réponse JSON de questions invalide'});
    } catch (e) {
      errors.push({provider:'configured-cascade',error:e.message || String(e)});
    }

    /*
     * Aucun fournisseur n'a fonctionné.
     * On retourne les vraies erreurs afin de pouvoir
     * diagnostiquer le problème dans Vercel.
     */
    return json(res, 503, {
      success: false,
      code: "AI_PROVIDER_UNAVAILABLE",
      error: "Aucun fournisseur IA disponible.",
      providers: errors
    });
  } catch (error) {
    console.error("[AI/GENERATE]", error);

    return json(res, error.status || 500, {
      success: false,
      error: error.message || "Erreur serveur"
    });
  }
};
