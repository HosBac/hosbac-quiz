const { withRetry, isHighDemandError, geminiModelCascade, sleep } = require("../../lib/ai-retry");
const { generateWithFallback, listActiveModels } = require("../../lib/ai-fallback");
const { extractRagQuestions, buildRagQuestionsFromText } = require("../../lib/rag-question-source");
const { getCachedQuestion, putCachedQuestions } = require("../../lib/question-cache");
const { getAdmin, json, requireAuth } = require("../../lib/firebase");
const { normalize } = require("../../lib/config");
const { getAppConfig } = require("../../lib/app-config");
const cors = require("../../lib/cors");
const crypto = require("crypto");
const rag = require("../../lib/rag");
const { normalizeQuestionMath: normalizeQuestionMathServer } = require("../../lib/math-format");
const { getImagesByDocumentIds } = require("../../lib/image-pipeline");

/**
 * ============================================================
 * OUTILS
 * ============================================================
 */

function cleanText(value) {
  return String(value || "").trim();
}


function clampDifficulty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, Math.round(n)));
}

/**
 * Extrait une question depuis plusieurs formats JSON possibles.
 *
 * Format principal attendu :
 * [
 *   {
 *     "id": "...",
 *     "question": "...",
 *     "choices": ["A", "B", "C", "D"],
 *     "correctAnswer": 0,
 *     "explanation": "...",
 *     "hint": "...",
 *     "difficulty": 1
 *   }
 * ]
 *
 * On accepte également :
 * {
 *   "question": {...}
 * }
 */
function questionFingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function isTooSimilarToHistory(questionText, historyList) {
  const fp = questionFingerprint(questionText);
  if (!fp || fp.length < 12) return false;
  const tokens = new Set(fp.split(' ').filter((w) => w.length > 3));
  for (const prev of historyList || []) {
    const pf = questionFingerprint(prev);
    if (!pf) continue;
    if (fp === pf) return true;
    if (fp.includes(pf.slice(0, 40)) || pf.includes(fp.slice(0, 40))) return true;
    const prevTokens = pf.split(' ').filter((w) => w.length > 3);
    if (!prevTokens.length || !tokens.size) continue;
    let overlap = 0;
    for (const t of prevTokens) if (tokens.has(t)) overlap++;
    if (overlap / Math.max(prevTokens.length, 1) >= 0.72) return true;
  }
  return false;
}

function extractQuestion(text) {

  const raw = cleanText(text);

  if (!raw) return null;

  let parsed = null;

  /*
   * Certains modèles entourent leur JSON avec ```json ... ```
   */
  const cleanJsonString = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const cleaned = cleanJsonString;

  /*
   * Première tentative : JSON complet.
   */
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    /*
     * Deuxième tentative :
     * récupérer le premier objet JSON ou tableau JSON.
     */
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);

    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
      } catch {
        parsed = null;
      }
    }

    if (!parsed) {
      const objectMatch = cleaned.match(/\{[\s\S]*\}/);

      if (objectMatch) {
        try {
          parsed = JSON.parse(objectMatch[0]);
        } catch {
          parsed = null;
        }
      }
    }
  }

  if (!parsed) return null;

  /*
   * Normalisation des différents formats.
   */
  let candidate = null;

  if (Array.isArray(parsed)) {
    candidate = parsed[0];
  } else if (parsed.question && typeof parsed.question === "object") {
    candidate = parsed.question;
  } else {
    candidate = parsed;
  }

  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  // Résolution de la bonne réponse : lettre, index, puis texte exact de l'option.
  const letterMap = { A: 0, B: 1, C: 2, D: 3 };

  // Format préféré : options[{id,texte,est_correcte,feedback}]
  let choices = [];
  let fromOptionsFeedback = null;
  let fromOptionsCorrect = null;
  if (Array.isArray(candidate.options) && candidate.options.length >= 2) {
    const opts = candidate.options.slice(0, 4);
    choices = opts.map((o) => cleanText((o && (o.texte || o.text || o.label || o.choice)) || ''));
    fromOptionsFeedback = {};
    opts.forEach((o, i) => {
      if (!o || typeof o !== 'object') return;
      const letter = String(o.id || String.fromCharCode(65 + i)).toUpperCase().replace(/[^A-D]/g, '').slice(0, 1) || String.fromCharCode(65 + i);
      const idx = letterMap[letter] != null ? letterMap[letter] : i;
      const fb = cleanText(o.feedback || o.explanation || '');
      if (fb) {
        fromOptionsFeedback[String(idx)] = fb;
        fromOptionsFeedback[letter] = fb;
      }
      if (o.est_correcte === true || o.isCorrect === true || o.correct === true) {
        fromOptionsCorrect = idx;
      }
    });
  } else if (Array.isArray(candidate.choices)) {
    choices = candidate.choices.slice(0, 4).map((choice) => {
      if (choice && typeof choice === 'object') {
        return cleanText(choice.texte || choice.text || choice.label || choice.feedback || '');
      }
      return cleanText(choice);
    });
  } else {
    choices = [];
  }
  const declaredCorrectChoice = cleanText(
    candidate.correctChoice || candidate.correct_choice || candidate.answerText || candidate.correct_answer_text
  );
  let correctAnswer = Number(candidate.correctAnswer);
  if (fromOptionsCorrect != null && Number.isInteger(fromOptionsCorrect)) {
    correctAnswer = fromOptionsCorrect;
  }

  // correct_answer / correctAnswer peut être "A"/"B"/"C"/"D"
  const rawCorrect = candidate.correct_answer != null ? candidate.correct_answer : candidate.correctAnswer;
  if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) {
    const letter = cleanText(rawCorrect).toUpperCase();
    if (Object.prototype.hasOwnProperty.call(letterMap, letter)) {
      correctAnswer = letterMap[letter];
    }
  }

  // Si le modèle fournit le TEXTE de la bonne option, c'est la source de vérité.
  if (declaredCorrectChoice && choices.length === 4) {
    let exact = choices.findIndex(c => cleanText(c) === declaredCorrectChoice);
    if (exact < 0) {
      exact = choices.findIndex(c => cleanText(c).toLowerCase() === declaredCorrectChoice.toLowerCase());
    }
    if (exact >= 0) correctAnswer = exact;
  }

  if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) {
    return null;
  }

  // Toujours aligner correctChoice sur choices[index] pour éviter D="Conventions" + explication "1883".
  const alignedChoice = choices[correctAnswer] || '';

  let explanation = cleanText(candidate.explanation) || '';
  // Si l'explication cite une autre lettre que la bonne, on la reformate de façon neutre.
  const letterOfCorrect = String.fromCharCode(65 + correctAnswer);
  if (explanation) {
    const cited = explanation.match(/\bBonne r[eé]ponse\s*:\s*([A-D])\b/i);
    if (cited && cited[1].toUpperCase() !== letterOfCorrect) {
      explanation = `Bonne réponse : ${letterOfCorrect}. ${alignedChoice}. ` + explanation.replace(/\bBonne r[eé]ponse\s*:\s*[A-D]\b[.\s]*/i, '');
    }
  }
  if (!explanation) {
    explanation = `Bonne réponse : ${letterOfCorrect}. ${alignedChoice}`;
  }

  // Explications par option (erreurs classiques élèves)
  // Accepter options[].feedback, explanations {A,B,C,D} OU option_explanations {0,1,2,3}
  let optionExplanations = candidate.option_explanations || candidate.optionExplanations || null;
  const letterExpl = candidate.explanations || candidate.explanationByOption || null;
  if (fromOptionsFeedback && typeof fromOptionsFeedback === 'object') {
    optionExplanations = Object.assign({}, optionExplanations || {}, fromOptionsFeedback);
  }
  if ((!optionExplanations || typeof optionExplanations !== 'object') && letterExpl && typeof letterExpl === 'object') {
    optionExplanations = {};
    const map = { A: '0', B: '1', C: '2', D: '3', a: '0', b: '1', c: '2', d: '3' };
    for (const [lk, idx] of Object.entries(map)) {
      if (letterExpl[lk] != null) optionExplanations[idx] = letterExpl[lk];
    }
  }
  const generic = /bonne r[eé]ponse est\s*[a-d]|option (est )?incorrecte|cette option est incorrecte|c'?est faux car|la bonne est\s*[a-d]|tout simplement faux/i;
  if (optionExplanations && typeof optionExplanations === 'object') {
    const cleaned = {};
    for (const k of ['0', '1', '2', '3']) {
      let t = optionExplanations[k] != null ? optionExplanations[k] : optionExplanations[Number(k)];
      // Also try letter keys
      if (t == null && letterExpl) {
        const letter = String.fromCharCode(65 + Number(k));
        t = letterExpl[letter] || letterExpl[letter.toLowerCase()];
      }
      t = cleanText(t);
      if (!t || generic.test(t) || t.length < 40 || /raisonnement associ|ne m[eè]ne pas au r[eé]sultat|n'est pas celle attendue/i.test(t)) {
        const choiceTxt = Array.isArray(choices) ? cleanText(choices[Number(k)]) : '';
        const isRight = Number(k) === correctAnswer;
        t = isRight
          ? (`Justification : cette proposition est correcte car elle respecte la règle ou le calcul attendu` + (choiceTxt ? ` (« ${choiceTxt.slice(0, 110)} »).` : '.'))
          : (`Cette proposition (« ${(choiceTxt || '…').slice(0, 110)} ») n'est pas celle attendue. Voici l'écart par rapport au raisonnement correct du cours.`);
      }
      cleaned[k] = t;
    }
    optionExplanations = cleaned;
  } else {
    optionExplanations = {};
    for (let k = 0; k < 4; k++) {
      const choiceTxt = Array.isArray(choices) ? cleanText(choices[k]) : '';
      const isRight = k === correctAnswer;
      optionExplanations[String(k)] = isRight
        ? (`Justification : cette option suit la méthode ou la définition du cours` + (choiceTxt ? ` (« ${choiceTxt.slice(0, 110)} »).` : '.'))
        : (`Cette proposition (« ${(choiceTxt || '…').slice(0, 110)} ») ne correspond pas à la réponse attendue d'après le cours.`);
    }
  }

  const question = {
    id: crypto.randomUUID(), // jamais réutiliser un id modèle (évite correction figée)
    theme: cleanText(candidate.theme || candidate.topic || candidate.chapter || ''),
    question: cleanText(candidate.question),
    choices,
    correctAnswer,
    correctChoice: alignedChoice,
    explanation,
    option_explanations: optionExplanations,
    explanations: (function(){
      if (!optionExplanations) return null;
      const o = {};
      for (let i = 0; i < 4; i++) o[String.fromCharCode(65 + i)] = optionExplanations[String(i)] || '';
      return o;
    })(),
    hint: cleanText(candidate.hint),
    difficulty: clampDifficulty(candidate.difficulty),
    image_url: cleanText(candidate.image_url || candidate.imageUrl || candidate.image || ''),
  };

  if (!question.question) return null;
  if (question.choices.length !== 4) return null;
  if (question.choices.some((choice) => !choice)) return null;

  const uniqueChoices = new Set(question.choices.map(choice => choice.trim().toLocaleLowerCase()));
  if (uniqueChoices.size !== 4) return null;

  if (
    !Number.isInteger(question.correctAnswer) ||
    question.correctAnswer < 0 ||
    question.correctAnswer > 3
  ) {
    return null;
  }

  // Dernière garantie : correctChoice === choices[correctAnswer]
  if (cleanText(question.correctChoice) !== cleanText(question.choices[question.correctAnswer])) {
    question.correctChoice = question.choices[question.correctAnswer];
  }

  const normalized = question;
  normalized.correctChoice = normalized.choices[normalized.correctAnswer] || '';
  if (!normalized.explanation) return null;
  return normalized;
}

/**
 * ============================================================
 * MISTRAL — fournisseur principal
 * ============================================================
 */
async function askMistral(prompt, providers) {
  const apiKey = cleanText(process.env.MISTRAL_API_KEY);
  if (!apiKey) { providers.push("Mistral: MISTRAL_API_KEY manquante"); return null; }
  const model = cleanText(process.env.MISTRAL_MODEL) || "mistral-small-2603";
  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({
        model,
        messages:[
          {role:"system",content:"Tu es le moteur de génération de QCM de HosBac. Génère UNE seule question pédagogique adaptée à la classe, à la série et à la matière. Retourne uniquement un objet JSON valide avec question, choices, correctAnswer, explanation, hint et difficulty. choices contient exactement 4 propositions; correctAnswer est 0,1,2 ou 3; correctChoice doit recopier exactement la proposition correcte telle qu’elle apparaît dans choices; difficulty est 1 à 4. Formules mathématiques STRICTEMENT réservées aux matières Mathématiques et Physique-Chimie (PCT). Utilise uniquement $...$ pour le LaTeX en ligne et $$...$$ pour les blocs; jamais \( ... \) ni \[ ... \]. Pour SVT, Anglais, Français, Histoire-Géo, Philosophie et toute autre matière littérale: aucun LaTeX ni balise mathématique, texte brut clair uniquement. Ne dis jamais qu'un document est absent et ne parle jamais à l'élève."},
          {role:"user",content:prompt}
        ],
        temperature:0.2,
        max_tokens:900,
        response_format:{type:"json_object"}
      })
    });
    if(!response.ok){const t=await response.text().catch(()=>"");providers.push(`Mistral: HTTP ${response.status}${t?` - ${t.slice(0,500)}`:""}`);return null;}
    const data=await response.json();
    const question=extractQuestion(data?.choices?.[0]?.message?.content||"");
    if(question)return question;
    providers.push("Mistral: réponse JSON invalide ou question invalide");
    return null;
  }catch(e){providers.push(`Mistral: ${e?.message||"Erreur inconnue"}`);return null;}
}

/**
 * ============================================================
 * GROQ
 * ============================================================
 */

async function askGroq(prompt, providers) {
  const apiKey = cleanText(process.env.GROQ_API_KEY);

  if (!apiKey) {
    providers.push("Groq: GROQ_API_KEY manquante");
    return null;
  }

  const model =
    cleanText(process.env.GROQ_MODEL) ||
    "openai/gpt-oss-120b";

  /*
   * Une seule question = petite sortie.
   * Cela réduit fortement le risque de dépasser le TPM.
   */
  const requestBody = {
    model,

    messages: [
      {
        role: "system",
        content:
          "Tu es le moteur de génération de QCM de HosBac. " +
          "Tu dois produire UNE seule question pédagogique adaptée " +
          "au profil scolaire fourni. " +
          "Tu ne dois jamais répondre comme un assistant conversationnel. " +
          "Tu ne dois jamais dire que tu ne peux pas répondre. " +
          "Tu dois retourner uniquement un objet JSON. " +
          "L'objet doit contenir : question, choices, correctAnswer, explanation, hint, difficulty. " +
          "choices doit contenir exactement 4 propositions. " +
          "correctAnswer doit être un entier de 0 à 3 et correctChoice doit être la copie exacte de choices[correctAnswer]. " +
          "difficulty doit être un entier de 1 à 4. Formules mathématiques STRICTEMENT réservées à Mathématiques/PCT : $...$ en ligne, $$...$$ en bloc, jamais \( ... \) ni \[ ... \]. Pour les matières littérales, aucun LaTeX.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],

    temperature: 0.2,

    /*
     * Une question ne nécessite pas 2200 tokens.
     */
    max_tokens: 900,

    /*
     * Le modèle doit produire du JSON.
     */
    response_format: {
      type: "json_object",
    },
  };

  /*
   * Deux tentatives maximum :
   * - tentative normale
   * - retry court uniquement pour un 429
   */
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },

          body: JSON.stringify(requestBody),
        }
      );

      if (response.status === 429 && attempt === 0) {
        /*
         * On attend 6 secondes maximum.
         * Cela permet de laisser retomber le TPM.
         */
        await new Promise((resolve) =>
          setTimeout(resolve, 6000)
        );

        continue;
      }

      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => "");

        providers.push(
          `Groq: HTTP ${response.status}${
            errorText
              ? ` - ${errorText.slice(0, 500)}`
              : ""
          }`
        );

        return null;
      }

      const data = await response.json();

      const content =
        data?.choices?.[0]?.message?.content || "";

      const question = extractQuestion(content);

      if (question) {
        return question;
      }

      providers.push(
        "Groq: réponse JSON invalide ou question invalide"
      );

      return null;
    } catch (error) {
      providers.push(
        `Groq: ${error?.message || "Erreur inconnue"}`
      );

      return null;
    }
  }

  providers.push(
    "Groq: limite de requêtes atteinte après nouvelle tentative"
  );

  return null;
}

/**
 * ============================================================
 * HUGGING FACE
 * ============================================================
 *
 * On utilise l'API Chat Completions compatible.
 *
 * IMPORTANT :
 * HF_MODEL doit être un modèle Instruct/Chat.
 *
 * Valeur par défaut :
 * Qwen/Qwen2.5-7B-Instruct
 */

async function askHuggingFace(prompt, providers) {
  const apiKey = cleanText(process.env.HF_API_KEY);

  if (!apiKey) {
    providers.push("HF: HF_API_KEY manquante");
    return null;
  }

  const model =
    cleanText(process.env.HF_MODEL) ||
    "Qwen/Qwen2.5-7B-Instruct";

  try {
    const response = await fetch(
      "https://router.huggingface.co/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },

        body: JSON.stringify({
          model,

          messages: [
            {
              role: "system",
              content:
                "Tu es le moteur pédagogique de HosBac. " +
                "Génère UNE seule question QCM. " +
                "Retourne uniquement un objet JSON valide. " +
                "Ne parle pas à l'utilisateur. " +
                "Ne dis jamais qu'aucun document n'est disponible. " +
                "Adapte la question à la classe, la série et la matière. Formules mathématiques uniquement pour Mathématiques/PCT avec $...$ en ligne ou $$...$$ en bloc; aucune balise LaTeX pour les matières littérales.",
            },

            {
              role: "user",
              content: prompt,
            },
          ],

          temperature: 0.2,

          max_tokens: 900,

          response_format: {
            type: "json_object",
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "");

      providers.push(
        `HF: HTTP ${response.status}${
          errorText
            ? ` - ${errorText.slice(0, 500)}`
            : ""
        }`
      );

      return null;
    }

    const data = await response.json();

    const content =
      data?.choices?.[0]?.message?.content || "";

    const question = extractQuestion(content);

    if (question) {
      return question;
    }

    providers.push(
      "HF: réponse JSON invalide ou question invalide"
    );

    return null;
  } catch (error) {
    providers.push(
      `HF: ${error?.message || "Erreur inconnue"}`
    );

    return null;
  }
}

/**
 * ============================================================
 * CHOIX DU FOURNISSEUR
 * ============================================================
 */


async function askViaFallback(prompt, providers, label, session) {
  try {
    const fb = await generateWithFallback(prompt, { jsonMode: true, temperature: 0.35, maxTokens: 1200, level: session?.classe, subject: session?.matiere });
    const q = extractQuestion(fb.text);
    if (q) {
      providers.push(`${label}: OK ${fb.provider}/${fb.model}`);
      return q;
    }
    providers.push(`${label}: JSON invalide (${fb.provider}/${fb.model})`);
  } catch (e) {
    providers.push(`${label}: ${e?.message || "erreur"}`);
  }
  return null;
}

async function askGeminiKey(prompt, apiKey, providers, label) {
  if (!apiKey) return null;
  const models = geminiModelCascade();
  for (const model of models) {
    try {
      const q = await withRetry(async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                systemInstruction: {
                  parts: [{
                    text: "Tu es le moteur de génération de QCM de HosBac. Génère UNE seule question pédagogique adaptée au profil scolaire. Retourne uniquement un objet JSON valide avec question, choices, correctAnswer, explanation, hint et difficulty. choices contient exactement 4 propositions; correctAnswer est 0,1,2 ou 3; correctChoice doit recopier exactement la proposition correcte telle qu’elle apparaît dans choices; difficulty est 1 à 4. Formules mathématiques STRICTEMENT réservées à Mathématiques/PCT : $...$ en ligne et $$...$$ en bloc; jamais \\( ... \\) ni \\[ ... \\]. Pour les matières littérales, aucun LaTeX."
                  }]
                },
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: {
                  temperature: 0.35,
                  maxOutputTokens: 1200,
                  responseMimeType: "application/json"
                }
              })
            }
          );

          const bodyText = await response.text().catch(() => "");
          if (!response.ok) {
            const err = new Error(
              `${label}/${model}: HTTP ${response.status}${bodyText ? " - " + bodyText.slice(0, 400) : ""}`
            );
            err.status = response.status;
            // Une surcharge 503 doit passer immédiatement au modèle suivant.
            if (response.status === 503) err.noRetry = true;
            if (isHighDemandError(response.status, bodyText, bodyText)) throw err;
            providers.push(err.message);
            return null;
          }

          let data = {};
          try {
            data = JSON.parse(bodyText);
          } catch (_) {}

          const text =
            data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
          const question = extractQuestion(text);
          if (!question) {
            const err = new Error(`${label}/${model}: réponse JSON invalide`);
            err.status = 503;
            err.noRetry = true;
            throw err;
          }
          return question;
        } catch (error) {
          if (error?.name === 'AbortError') {
            const timeoutError = new Error(`${label}/${model}: timeout après 8s`);
            timeoutError.status = 408;
            timeoutError.noRetry = true;
            throw timeoutError;
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      }, { maxAttempts: 2, baseDelayMs: 1000, label: `${label}/${model}` });

      if (q) return q;
    } catch (e) {
      providers.push(`${label}/${model}: ${e?.message || "Erreur inconnue"}`);
    }
  }
  return null;
}

async function askOpenRouterKey(prompt, apiKey, providers, label) {
  if (!apiKey) return null;
  const model = cleanText(process.env.OPENROUTER_MODEL) || "openai/gpt-4o-mini";
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://hosbac-quiz.vercel.app",
        "X-Title": "HosBac Quiz"
      },
      body: JSON.stringify({
        model,
        messages: [
          {role:"system",content:"Tu es le moteur QCM de HosBac. Retourne uniquement un objet JSON avec question, choices, correctAnswer, explanation, hint et difficulty. Exactement 4 choix. correctAnswer=0..3. Mathématiques/PCT : LaTeX uniquement avec $...$ en ligne ou $$...$$ en bloc; jamais \( ... \) ni \[ ... \]. Matières littérales : aucun LaTeX."},
          {role:"user",content:prompt}
        ],
        temperature:0.2,
        max_tokens:900,
        response_format:{type:"json_object"}
      })
    });
    if (!response.ok) {
      const t=await response.text().catch(()=>"");
      providers.push(`${label}: HTTP ${response.status}${t?` - ${t.slice(0,400)}`:""}`);
      return null;
    }
    const data=await response.json();
    const q=extractQuestion(data?.choices?.[0]?.message?.content||"");
    if(q)return q;
    providers.push(`${label}: réponse JSON invalide ou question invalide`);
  } catch(e) {
    providers.push(`${label}: ${e?.message||"Erreur inconnue"}`);
  }
  return null;
}

async function askOpenAICompatibleKey(prompt, apiKey, providerName, baseUrl, model, providers, label) {
  if (!apiKey) return null;
  try {
    const response=await fetch(baseUrl,{
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({
        model,
        messages:[
          {role:"system",content:"Tu es le moteur QCM de HosBac. Retourne uniquement un objet JSON valide avec question, choices, correctAnswer, explanation, hint et difficulty. Exactement 4 choix. correctAnswer=0..3. Mathématiques/PCT : LaTeX uniquement avec $...$ en ligne ou $$...$$ en bloc; jamais \( ... \) ni \[ ... \]. Matières littérales : aucun LaTeX."},
          {role:"user",content:prompt}
        ],
        temperature:0.2,
        max_tokens:900,
        response_format:{type:"json_object"}
      })
    });
    if(!response.ok){
      const t=await response.text().catch(()=>"");
      providers.push(`${label}: HTTP ${response.status}${t?` - ${t.slice(0,400)}`:""}`);
      return null;
    }
    const data=await response.json();
    const q=extractQuestion(data?.choices?.[0]?.message?.content||"");
    if(q)return q;
    providers.push(`${label}: réponse JSON invalide ou question invalide`);
  }catch(e){providers.push(`${label}: ${e?.message||"Erreur inconnue"}`);}
  return null;
}

async function askCloudflareKey(prompt,apiToken,accountId,model,providers,label){
  if(!apiToken||!accountId)return null;
  try{
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${encodeURIComponent(model)}`,{
      method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${apiToken}`},
      body:JSON.stringify({messages:[
        {role:"system",content:"Tu es le moteur QCM de HosBac. Retourne uniquement un objet JSON valide avec question, choices, correctAnswer, explanation, hint et difficulty. Exactement 4 choix. correctAnswer=0..3. Mathématiques/PCT : LaTeX uniquement avec $...$ en ligne ou $$...$$ en bloc; jamais \( ... \) ni \[ ... \]. Matières littérales : aucun LaTeX."},
        {role:"user",content:prompt}
      ]})
    });
    if(!response.ok){const t=await response.text().catch(()=>"");providers.push(`${label}: HTTP ${response.status} ${t.slice(0,300)}`);return null;}
    const data=await response.json(),content=data?.result?.response||data?.result?.content||data?.result?.text||"",q=extractQuestion(content);
    if(q)return q;providers.push(`${label}: réponse invalide`);
  }catch(e){providers.push(`${label}: ${e?.message||"Erreur inconnue"}`)}
  return null;
}

function buildQuizIsolationPrompt(prompt, session) {
  const level = cleanText(session?.classe || '');
  const subject = cleanText(session?.matiere || '');
  return `CLASSE DE L'ÉLÈVE : ${level}\nMATIÈRE EXCLUSIVE : ${subject}\n\nRÈGLE D'ÉTANCHÉITÉ PÉDAGOGIQUE ABSOLUE :\nVous devez générer UNE ET UNE SEULE QUESTION conforme au programme officiel international/national de la classe de ${level} et EXCLUSIVEMENT pour la matière ${subject}.\n- IL EST STRICTEMENT INTERDIT d'aborder une autre matière (ex: pas d'Histoire si la matière est Mathématiques).\n- IL EST STRICTEMENT INTERDIT de poser une question d'un autre niveau scolaire (ex: pas de notion de Terminale ou de 3ème si l'élève est en 6ème).\n- Si vous n'avez pas de données RAG, générez une question de cours canonique basée sur le programme officiel de la classe de ${level} en ${subject}.\n\n${String(prompt || '')}`;
}

async function ask(prompt, session) {
  const isolatedPrompt = buildQuizIsolationPrompt(prompt, session);
  const providers = [];
  const pool = [
    ["Fallback Multi-IA", () => askViaFallback(isolatedPrompt, providers, "Fallback Multi-IA", session)],
    ["Gemini 1", () => askGeminiKey(isolatedPrompt, cleanText(process.env.GEMINI_API_KEY), providers, "Gemini 1")],
    ["Gemini 2", () => askGeminiKey(isolatedPrompt, cleanText(process.env.GEMINI_API_KEY_2), providers, "Gemini 2")],
    ["Groq 1", () => askOpenAICompatibleKey(isolatedPrompt, cleanText(process.env.GROQ_API_KEY), "Groq", "https://api.groq.com/openai/v1/chat/completions", cleanText(process.env.GROQ_MODEL) || "openai/gpt-oss-120b", providers, "Groq 1")],
    ["Groq 2", () => askOpenAICompatibleKey(isolatedPrompt, cleanText(process.env.GROQ_API_KEY_2), "Groq", "https://api.groq.com/openai/v1/chat/completions", cleanText(process.env.GROQ_MODEL_2 || process.env.GROQ_MODEL) || "openai/gpt-oss-120b", providers, "Groq 2")],
    ["Mistral 1", () => askOpenAICompatibleKey(isolatedPrompt, cleanText(process.env.MISTRAL_API_KEY), "Mistral", "https://api.mistral.ai/v1/chat/completions", cleanText(process.env.MISTRAL_MODEL) || "mistral-small-2603", providers, "Mistral 1")],
    ["Mistral 2", () => askOpenAICompatibleKey(isolatedPrompt, cleanText(process.env.MISTRAL_API_KEY_2), "Mistral", "https://api.mistral.ai/v1/chat/completions", cleanText(process.env.MISTRAL_MODEL_2 || process.env.MISTRAL_MODEL) || "mistral-small-2603", providers, "Mistral 2")],
    ["OpenRouter 1", () => askOpenRouterKey(isolatedPrompt, cleanText(process.env.OPENROUTER_API_KEY), providers, "OpenRouter 1")],
    ["OpenRouter 2", () => askOpenRouterKey(isolatedPrompt, cleanText(process.env.OPENROUTER_API_KEY_2), providers, "OpenRouter 2")],
    ["Cloudflare 1", () => askCloudflareKey(isolatedPrompt, cleanText(process.env.CLOUDFLARE_API_TOKEN), cleanText(process.env.CLOUDFLARE_ACCOUNT_ID), cleanText(process.env.CLOUDFLARE_AI_MODEL)||"@cf/meta/llama-3.1-8b-instruct", providers, "Cloudflare 1")],
    ["Cloudflare 2", () => askCloudflareKey(isolatedPrompt, cleanText(process.env.CLOUDFLARE_API_TOKEN_2), cleanText(process.env.CLOUDFLARE_ACCOUNT_ID_2||process.env.CLOUDFLARE_ACCOUNT_ID), cleanText(process.env.CLOUDFLARE_AI_MODEL_2||process.env.CLOUDFLARE_AI_MODEL)||"@cf/meta/llama-3.1-8b-instruct", providers, "Cloudflare 2")]
  ];

  for (const [,fn] of pool) {
    const q = await fn();
    if (q) return q;
  }

  // Legacy HF remains the final emergency fallback if configured.
  const hfQuestion = await askHuggingFace(isolatedPrompt, providers);
  if (hfQuestion) return hfQuestion;

  throw Object.assign(new Error("Aucun fournisseur IA disponible."), {providers,status:503});
}

function formatAndShuffleQuestion(rawQuestion) {
    if (!rawQuestion.options || !Array.isArray(rawQuestion.options)) return rawQuestion;
    
    // Associe chaque option à son état correct pour ne pas perdre l'information
    const shuffled = [...rawQuestion.options];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    // Réassigne proprement les nouveaux IDs de choix (A, B, C, D) après le mélange
    rawQuestion.options = shuffled.map((option, index) => ({
        ...option,
        id: String.fromCharCode(65 + index) // Génère A, B, C, D dynamiquement
    }));
    
    return rawQuestion;
}

function secureShuffleQuestion(question, previousCorrectAnswer = null) {
  question.options = question.choices.map((text, index) => ({
    text,
    is_correct: index === Number(question.correctAnswer),
    feedback: question.option_explanations?.[String(index)] || ''
  }));
  formatAndShuffleQuestion(question);
  question.choices = question.options.map((option) => option.text);
  question.correctAnswer = question.options.findIndex((option) => option.is_correct === true);
  question.correctChoice = question.choices[question.correctAnswer] || '';
  question.option_explanations = Object.fromEntries(question.options.map((option, index) => [String(index), option.feedback || '']));
  delete question.options;
  if (!question || !Array.isArray(question.choices) || question.choices.length !== 4) return question;

  // Conserve le comportement existant : deux questions successives ne doivent
  // pas avoir la bonne réponse à la même position.
  if (Number.isInteger(Number(previousCorrectAnswer)) &&
      Number(previousCorrectAnswer) >= 0 &&
      Number(previousCorrectAnswer) <= 3) {
    const currentCorrect = Number(question.correctAnswer);
    if (currentCorrect === Number(previousCorrectAnswer)) {
      const candidates = [0, 1, 2, 3].filter((i) => i !== currentCorrect);
      const j = candidates[Math.floor(Math.random() * candidates.length)];
      [question.choices[currentCorrect], question.choices[j]] =
        [question.choices[j], question.choices[currentCorrect]];
      const oldFeedback = question.option_explanations?.[String(currentCorrect)] || '';
      const swapFeedback = question.option_explanations?.[String(j)] || '';
      if (question.option_explanations) {
        question.option_explanations[String(currentCorrect)] = swapFeedback;
        question.option_explanations[String(j)] = oldFeedback;
      }
      question.correctAnswer = j;
      question.correctChoice = question.choices[j] || '';
    }
  }

  return question;
}

/**
 * ============================================================
 * HANDLER
 * ============================================================
 */

module.exports = async (req, res) => {
  if (cors(req, res)) return;

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "POST requis",
    });
  }

  try {
    const decoded = await requireAuth(req);

    const db = getAdmin().firestore();

    const body = req.body || {};

    const serverConfig = await getAppConfig(getAdmin);
    const sessionId = cleanText(body.sessionId);
    const quizId = cleanText(body.quizId);

    if (!sessionId && !quizId) {
      return json(res, 400, {
        success: false,
        error: "quizId/sessionId manquant",
      });
    }

    const effectiveQuizId = quizId || sessionId;
    const ref = db
      .collection("quiz_sessions")
      .doc(effectiveQuizId);


    const snap = await ref.get();

    if (!snap.exists) {
      return json(res, 404, {
        success: false,
        error: "Session introuvable",
      });
    }

    const session = snap.data();

    if (session.userId !== decoded.uid) {
      return json(res, 403, {
        success: false,
        error: "Accès refusé",
      });
    }

    if (session.status !== "active") {
      return json(res, 409, {
        success: false,
        error: "Session terminée",
      });
    }

    // Verrouillage du quiz : le quizId est le document de session et ses
    // métadonnées classe/matière sont la seule source de vérité.
    if (quizId && sessionId && quizId !== sessionId) {
      return json(res, 409, { success: false, code: "QUIZ_ID_MISMATCH", error: "Quiz invalide." });
    }
    if (!cleanText(session.classe) || !cleanText(session.matiere)) {
      return json(res, 409, { success: false, code: "QUIZ_PROFILE_INVALID", error: "Classe et matière du quiz invalides." });
    }

    const config = serverConfig;

    const questions = Array.isArray(
      session.questions
    )
      ? session.questions
      : [];

    const answers = Array.isArray(
      session.answers
    )
      ? session.answers
      : [];

    const answeredIds = new Set(
      answers
        .map((answer) => answer?.questionId)
        .filter(Boolean)
    );

    const index = Number(
      session.currentIndex || 0
    );

    /*
     * Nombre maximum de questions.
     */
    const sessionLimit = Math.max(1, Number(session.questionsLimit || config.questionsPerQuiz));

    if (index >= sessionLimit) {
      return json(res, 409, {
        success: false,
        code: "QUIZ_COMPLETE",
      });
    }

    /*
     * Si une question non répondue existe déjà,
     * on la renvoie.
     *
     * Cela évite de générer une nouvelle question
     * lorsque l'utilisateur recharge ou clique plusieurs fois.
     */
    const existing = questions.find(
      (question) =>
        question &&
        question.id &&
        !answeredIds.has(question.id) &&
        cleanText(question.level || question.classe) === cleanText(session.classe) &&
        cleanText(question.subject || question.matiere) === cleanText(session.matiere)
    );

    if (existing) {
      return json(res, 200, {
        success: true,

        question: {
          id: existing.id,
          theme: existing.theme || '',
          level: existing.level || existing.classe || session.classe,
          subject: existing.subject || existing.matiere || session.matiere,
          question: existing.question,
          choices: existing.choices,
          options: existing.choices.map((text, i) => ({
            id: String.fromCharCode(65 + i),
            text,
            feedback: existing.option_explanations?.[String(i)] || ''
          })),
          difficulty: existing.difficulty,
          image_url: existing.image_url || '',
        },

        index,
      });
    }

    /**
     * ========================================================
     * RAG
     * ========================================================
     *
     * Le RAG est OPTIONNEL.
     *
     * S'il existe des documents :
     *     → on les utilise.
     *
     * S'il n'y en a pas :
     *     → le quiz continue quand même.
     */

    const chunks = [];
    let ragHits = [];

    // --- Neon vector RAG (prioritaire) ---
    try {
      const neonHits = await rag.searchRAGContext(
        [
          session.matiere || "",
          session.classe || "",
          session.chapitre || "",
          "notions du cours officiel HosBac"
        ].filter(Boolean).join(" "),
        {
          classe: session.classe || "",
          serie: cleanText(session.serie || "") || undefined,
          matiere: session.matiere || "",
          sa: session.chapitre || "",
          sa_title: session.chapitre || "",
          strictProfile: true
        },
        10
      );
      ragHits = Array.isArray(neonHits) ? neonHits : [];
      if (Array.isArray(neonHits) && neonHits.length) {
        neonHits.forEach((h) => {
          if (h && h.content) chunks.push(cleanText(h.content));
        });
        console.log("[QUIZ NEXT] Neon RAG hits:", neonHits.length, "classe=", session.classe, "matiere=", session.matiere, "sa=", session.chapitre);
      } else {
        console.warn("[QUIZ NEXT] Neon RAG: 0 hit pour", session.classe, session.matiere, session.chapitre);
      }
    } catch (error) {
      console.error("[QUIZ NEXT] Neon RAG indisponible:", error?.message);
    }

    // Aucun fallback RAG cross-source : si le RAG strict ne trouve rien,
    // le générateur IA restreint au couple classe/matière prend immédiatement le relais.

    const context = chunks
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 8000);

    // RAG-first : servir directement un QCM déjà présent dans le corpus,
    // sans appeler un modèle IA et sans consommer de quota.
    let ragDirect = extractRagQuestions(ragHits);
    if (ragDirect.length < 1 && ragHits.length) ragDirect = buildRagQuestionsFromText(ragHits, 1);
    if (ragDirect.length) {
      const direct = ragDirect.find(q => !isTooSimilarToHistory(q.question, questions.map(x => x?.question).filter(Boolean)));
      if (direct) {
        const q = extractQuestion(JSON.stringify(direct));
        if (q) {
          q.id = q.id || crypto.randomUUID();
          q.level = session.classe; q.classe = session.classe;
          q.subject = session.matiere; q.matiere = session.matiere;
          q.pregenerated = true; q.ragSource = true; q.serverIssuedMs = Date.now();
          await ref.set({ questions:[...questions, q] }, { merge:true });
          return json(res, 200, { success:true, question:{ id:q.id, theme:q.theme||'', level:q.level, subject:q.subject, question:q.question, choices:q.choices, options:q.choices.map((text,i)=>({id:String.fromCharCode(65+i),text,feedback:q.option_explanations?.[String(i)]||''})), difficulty:q.difficulty, image_url:q.image_url||'' }, index });
        }
      }
    }

    // Aucun modèle actif = mode RAG exclusif. Il ne faut surtout pas tenter
    // un appel IA implicite si l'administrateur a tout désactivé.
    const activeModels = await listActiveModels();
    if (!activeModels.length) {
      return json(res, 503, { success:false, code:'RAG_DOCUMENTS_UNAVAILABLE', error:'Les documents pour cette classe et matière ne sont pas encore disponibles dans le RAG. Veuillez revenir plus tard.' });
    }

    // URLs de figures : Neon document_images (prioritaire) + Firestore fallback
    let availableFigures = [];
    try {
      const classeN = cleanText(session.classe).toLowerCase();
      const matiereN = cleanText(session.matiere).toLowerCase();
      const saHint = cleanText(session.chapitre).toUpperCase();

      // 1) Documents Firestore actifs filtrés → récupérer leurs images Neon
      const docsSnap = await db.collection("quiz_documents").where("active", "==", true).limit(50).get();
      const matchedDocIds = [];
      for (const d of docsSnap.docs) {
        const data = d.data() || {};
        const dClasse = String(data.classe || "").toLowerCase();
        const dMatiere = String(data.matiere || "").toLowerCase();
        if (dClasse !== classeN || dMatiere !== matiereN) continue;
        matchedDocIds.push(d.id);
        // Firestore image_urls fallback
        const urls = [];
        if (data.image_url) urls.push(String(data.image_url));
        if (Array.isArray(data.image_urls)) data.image_urls.forEach((u) => urls.push(String(u)));
        if (Array.isArray(data.images)) data.images.forEach((im) => { if (im && im.url) urls.push(String(im.url)); });
        for (const u of urls) {
          if (u && /^https?:\/\//i.test(u) && !availableFigures.includes(u)) availableFigures.push(u);
        }
      }

      // 2) Neon document_images pour ces document_id
      if (matchedDocIds.length) {
        try {
          const neonImgs = await getImagesByDocumentIds(matchedDocIds);
          console.log("[QUIZ NEXT] Neon document_images rows=", neonImgs.length, "docs=", matchedDocIds.length);
          for (const row of neonImgs) {
            const u = row.image_url;
            if (u && /^https?:\/\//i.test(u) && !availableFigures.includes(u)) availableFigures.push(u);
          }
        } catch (e) {
          console.warn("[QUIZ NEXT] Neon images", e.message);
        }
      }

      // 3) Aussi via hits RAG (docId dans metadata)
      try {
        if (typeof rag.attachImagesToHits === "function" && chunks.length) {
          const pseudoHits = chunks.map((content, i) => ({ content, metadata: { docId: matchedDocIds[i % Math.max(1, matchedDocIds.length)] || "" } }));
          const attached = await rag.attachImagesToHits(pseudoHits);
          for (const u of (attached.figureUrls || [])) {
            if (u && !availableFigures.includes(u)) availableFigures.push(u);
          }
        }
      } catch (e) {
        console.warn("[QUIZ NEXT] attachImages", e.message);
      }

      availableFigures = availableFigures.slice(0, 12);
      console.log("[QUIZ NEXT] availableFigures=", availableFigures.length);
    } catch (e) {
      console.warn("[QUIZ NEXT] figures lookup", e.message);
    }

    // Questions déjà posées dans CETTE session
    const sessionAsked = questions
      .map((question) => question?.question)
      .filter(Boolean);

    // Historique élève : questions répondues durant les 30 derniers jours.
    // Les IDs sont exclus en priorité; les textes restent une protection supplémentaire.
    let historyAsked = [];
    const answeredQuestionIds = new Set();
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const histSnap = await db
        .collection("quiz_sessions")
        .where("userId", "==", decoded.uid)
        .where("createdAt", ">=", cutoff)
        .limit(100)
        .get();
      for (const doc of histSnap.docs) {
        if (doc.id === effectiveQuizId) continue;
        const data = doc.data() || {};
        const qs = Array.isArray(data.questions) ? data.questions : [];
        const ans = Array.isArray(data.answers) ? data.answers : [];
        const answeredInSession = new Set(ans.map(a => String(a?.questionId || '')).filter(Boolean));
        for (const q of qs) {
          if (!q) continue;
          if (q.question && answeredInSession.has(String(q.id || ''))) historyAsked.push(String(q.question).trim());
          if (q.id && answeredInSession.has(String(q.id))) answeredQuestionIds.add(String(q.id));
        }
      }
    } catch (histErr) {
      // Fallback compatible avec les anciens index Firestore: limiter la lecture puis filtrer localement.
      try {
        const histSnap2 = await db.collection("quiz_sessions").where("userId", "==", decoded.uid).limit(100).get();
        const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const doc of histSnap2.docs) {
          if (doc.id === effectiveQuizId) continue;
          const data = doc.data() || {};
          const created = data.createdAt?.toDate ? data.createdAt.toDate().getTime() : Number(data.createdAt?._seconds || 0) * 1000;
          if (created && created < cutoffMs) continue;
          const qs = Array.isArray(data.questions) ? data.questions : [];
          const ans = Array.isArray(data.answers) ? data.answers : [];
          const answeredInSession = new Set(ans.map(a => String(a?.questionId || '')).filter(Boolean));
          for (const q of qs) {
            if (!q) continue;
            if (q.question && answeredInSession.has(String(q.id || ''))) historyAsked.push(String(q.question).trim());
            if (q.id && answeredInSession.has(String(q.id))) answeredQuestionIds.add(String(q.id));
          }
        }
      } catch (_) { console.warn("[QUIZ NEXT] historique questions indisponible"); }
    }
    historyAsked = [...new Set(historyAsked)].slice(0, 40);
    const exclusionList = [...new Set([...sessionAsked, ...historyAsked])].slice(0, 40);
    const usedQuestions = exclusionList.join(String.fromCharCode(10));
    const answeredHistoryIds = [...answeredQuestionIds].slice(0, 200);

    // Niveau de difficulté (facile | moyen | difficile) depuis session ou body
    const rawDiff = String(
      body.difficulty ||
      body.difficultyLevel ||
      session.difficultyLevel ||
      ""
    ).toLowerCase();
    let difficultyLabel = "moyen";
    if (/facile|easy|1/.test(rawDiff)) difficultyLabel = "facile";
    else if (/difficile|hard|3|4/.test(rawDiff)) difficultyLabel = "difficile";
    else if (/moyen|medium|2/.test(rawDiff)) difficultyLabel = "moyen";
    else {
      const n = clampDifficulty(session.currentDifficulty || 1);
      difficultyLabel = n <= 1 ? "facile" : n >= 3 ? "difficile" : "moyen";
    }
    const difficultyInstruction =
      difficultyLabel === "facile"
        ? "NIVEAU FACILE : questions de mémorisation directe (dates, définitions, noms propres, faits explicitement écrits dans le cours)."
        : difficultyLabel === "difficile"
          ? "NIVEAU DIFFICILE : détails précis du texte, questions par négation (\« Lequel N'EST PAS… \»), nuances théoriques, distinctions de concepts (ex. socialisme vs marxisme si le texte le permet). Interdiction des questions trop évidentes."
          : "NIVEAU MOYEN : causes/effets, comparaisons de concepts, compréhension du raisonnement du cours (pas seulement une date isolée).";

    /**
     * ========================================================
     * PROMPT
     * ========================================================
     */

    const uniquenessSeed = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;

    let sourceInstruction = "";

    if (context) {
      sourceInstruction =
        "RÈGLE ABSOLUE : Tu dois générer des questions basées EXCLUSIVEMENT sur le texte extrait fourni dans le CONTEXTE PÉDAGOGIQUE (ex: Mouvement ouvrier, dates, lois 1884, Karl Marx, etc.). Interdiction totale de poser des questions de géographie générale, culture générale, capitales, montagnes ou tout fait absent du texte. " +
        "Tu dois générer la question STRICTEMENT ET UNIQUEMENT à partir du CONTEXTE PÉDAGOGIQUE OFFICIEL ci-dessous. " +
        "Il est STRICTEMENT INTERDIT d'utiliser tes connaissances générales pour inventer une question, une date, un nom ou une réponse qui n'apparaît pas clairement dans ce texte. " +
        "Les 4 choix (A,B,C,D) et la bonne réponse doivent être directement vérifiables dans le texte fourni. " +
        "L'explication doit citer ou paraphraser uniquement ce cours. " +
        "Reste dans le niveau de la classe de l'élève (ne pose jamais une question de niveau supérieur).";
    } else {
      sourceInstruction =
        "Aucun document RAG n'est actuellement disponible pour ce profil (classe/matière/SA). " +
        "Ce n'est PAS une erreur. Génère une question pédagogique adaptée UNIQUEMENT au niveau de la classe, série et matière " +
        "à partir de connaissances scolaires générales fiables du programme. " +
        "Ne dis pas à l'élève qu'aucun document n'est disponible.";
    }

    const languageInstruction = /anglais/i.test(cleanText(session.matiere))
      ? "LANGUE : la question, les quatre choix et l'explication doivent être en anglais, car la matière est Anglais. L'explication doit porter exactement sur cette question et ces quatre choix."
      : "LANGUE : la question, les quatre choix, l'indice et l'explication doivent être en français. N'utilise pas l'anglais sauf s'il s'agit d'un élément pédagogique explicitement nécessaire.";

    const prompt = `
CLASSE DE L'ÉLÈVE : ${cleanText(session.classe)}
MATIÈRE EXCLUSIVE : ${cleanText(session.matiere)}

RÈGLE D'ÉTANCHÉITÉ PÉDAGOGIQUE ABSOLUE :
Vous devez générer UNE ET UNE SEULE QUESTION conforme au programme officiel international/national de la classe de ${cleanText(session.classe)} et EXCLUSIVEMENT pour la matière ${cleanText(session.matiere)}.
- IL EST STRICTEMENT INTERDIT d'aborder une autre matière.
- IL EST STRICTEMENT INTERDIT de poser une question d'un autre niveau scolaire.
- Si vous n'avez pas de données RAG, générez une question de cours canonique basée sur le programme officiel de la classe de ${cleanText(session.classe)} en ${cleanText(session.matiere)}.

Profil scolaire :
Classe : ${cleanText(
      session.classe
    ) || "non précisée"}

Série :
${cleanText(session.serie) || "non précisée"}

Matière :
${cleanText(session.matiere) || "non précisée"}

Chapitre / SA :
${cleanText(session.chapitre) || "non précisé"}

Niveau de difficulté demandé : ${difficultyLabel}
${difficultyInstruction}
Niveau numérique interne : ${clampDifficulty(session.currentDifficulty || 1)}

${sourceInstruction}

${languageInstruction}

CONTEXTE PÉDAGOGIQUE OFFICIEL (RAG) :
---
${
  context ||
  "Aucun contenu RAG. Utiliser uniquement le programme scolaire général du niveau demandé."
}
---

QUESTIONS DÉJÀ POSÉES (session + historique élève — NE PAS RÉUTILISER) :
${
  usedQuestions ||
  "Aucune question précédente."
}

Exclure les concepts/questions suivants (empreintes) : les reformulations, synonymes et mêmes notions ciblées sont INTERDITES.

FORMATAGE DU CONTENU :
- Les formules mathématiques sont STRICTEMENT RÉSERVÉES aux matières Mathématiques et Physique-Chimie (PCT).
- Pour Mathématiques/PCT : LaTeX obligatoire lorsqu'une formule est nécessaire, uniquement avec $...$ en ligne et $$...$$ en bloc. JAMAIS \( ... \) ni \[ ... \].
- Pour SVT, Anglais, Français, Histoire-Géo, Philosophie et toute autre matière littérale : aucun LaTeX ni balise mathématique, texte brut clair uniquement.
- CLÉ D'UNICITÉ : ${uniquenessSeed}. Varie l'angle, la situation et la formulation; ne révèle jamais cette clé.
- IDs DE QUESTIONS DÉJÀ RÉPONDUES (30 JOURS) À EXCLURE : ${answeredHistoryIds.length ? answeredHistoryIds.join(', ') : 'aucun'}.

RÈGLES :
- Génère exactement UNE question NOUVELLE (sujet/angle différent des questions déjà posées).
- La question doit correspondre à la classe, matière et série.
- Respecte le niveau de difficulté demandé.
- Génère exactement 4 options distinctes (pas d'élimination triviale).
- Une seule option doit avoir is_correct=true; les trois autres doivent avoir is_correct=false.
- EXCLUSION STRICTE : Interdiction absolue de question similaire ou identique à la liste ci-dessus (même idée, même date, même définition, même formule).
- Explore d'autres notions du CONTEXTE PÉDAGOGIQUE pour varier.
- Si la matière est Anglais, vérifie spécialement le temps verbal, le sens de la phrase et la proposition correcte avant de produire l'explication.
- hint doit être court, concret et directement utile à la résolution.
- Si un CONTENU RAG est fourni, la question DOIT être entièrement vérifiable UNIQUEMENT à partir de ce contenu (pas le programme général).
- Si aucun CONTENU RAG, la question doit être exigeante et vérifiable à partir du programme scolaire.
- Vérifie deux fois la cohérence entre question, options et feedback avant de répondre.
- Pour toute formule mathématique, utilise uniquement $...$ pour une formule en ligne ou $$...$$ pour une formule affichée. Ne renvoie jamais de LaTeX brut sans délimiteurs.
- Ne parle jamais à l'élève.
- Ne dis jamais "aucun document fourni".
- Ne dis jamais "je ne peux pas".
- Uniquement si aucun CONTENU RAG n'est fourni, réponds avec le programme scolaire général adapté au profil.
- Ne génère aucun texte en dehors du JSON.

FIGURES DISPONIBLES (URLs Cloudinary extraites des documents) :
${availableFigures.length ? availableFigures.map((u, i) => `[FIG${i + 1}] ${u}`).join("\n") : "Aucune figure fournie pour ce lot."}

RÈGLES FIGURES (OBLIGATOIRES) :
- La question doit être auto-portante : utilise « D'après la figure ci-dessus… », « D'après le graphique… », « Sur le schéma… ». INTERDIT : « selon le corrigé », « d'après le document fourni », « dans le texte ci-dessus » sans figure.

PÉDAGOGIE QCM (OBLIGATOIRE) :
- Énoncé clair, notations scientifiques officielles (LaTeX : $\vec{OM}$, unités SI, etc.).
- Les 3 distracteurs DOIVENT correspondre à des erreurs classiques d'élèves (oubli de conversion, inversion de formule, confusion de notions) — JAMAIS aléatoires.
  * Pour la bonne option : justification pédagogique précise (règle, calcul, définition).
  * Pour CHAQUE option fausse : la FAUTE DE RAISONNEMENT précise (ex. « Confusion entre médiatrice et équation du cercle », « Oubli de convertir les unités en SI »).
  * INTERDIT ABSOLU : « Cette option est incorrecte. La bonne réponse est X », « c'est faux car la bonne est B », toute tautologie.
  * Chaque entrée = 1 à 3 phrases autonomes et pédagogiques.


FORMAT JSON OBLIGATOIRE (préféré — feedback chirurgical par option) :

{
  "theme": "Thème précis du cours",
  "question": "Texte de la question (LaTeX autorisé pour les maths)",
  "options": [
    {
      "text": "Proposition A",
      "is_correct": false,
      "feedback": "Explication chirurgicale de l'erreur précise (calcul, notion ou inattention)."
    },
    {
      "text": "Proposition B",
      "is_correct": true,
      "feedback": "Pourquoi cette option est correcte (règle / calcul / définition)."
    },
    {
      "text": "Proposition C",
      "is_correct": false,
      "feedback": "Erreur spécifique si l'élève choisit C."
    },
    {
      "text": "Proposition D",
      "is_correct": false,
      "feedback": "Erreur spécifique si l'élève choisit D."
    }
  ],
  "hint": "Indice subtil pour aider l'élève sans lui donner la réponse."
}

POUR CHAQUE OPTION FAUSSE, LE CHAMP "feedback" DOIT OBLIGATOIREMENT CONTENIR UNE PHRASE D'EXPLICATION PÉDAGOGIQUE COMPLÈTE ET SPÉCIFIQUE AU SUJET (minimum 15 mots). IL EST FORMELLEMENT INTERDIT DE RENVOYER DES PHRASES TAUTOLOGIQUES COMME "Cette option est incorrecte", "Le raisonnement ne mène pas au résultat", OU "La bonne réponse est X".

INTERDICTION STRICTE de feedbacks génériques ou répétitifs (« cette proposition n'est pas celle attendue », « la bonne réponse est B »). Pour chaque mauvaise option, analyse l'erreur logique ou d'inattention d'un élève qui la choisirait, et explique précisément pourquoi CE calcul / CE raisonnement est faux. Adapte le vocabulaire à la matière (maths, histoire-géo, SVT, etc.).
`;

    /**
     * ========================================================
     * GENERATION (cache mémoire → IA fallback)
     * ========================================================
     */

    const cacheKey = [
      session.classe || "",
      session.serie || "",
      session.matiere || "",
      session.chapitre || "",
      String(clampDifficulty(session.currentDifficulty || session.difficultyLevel || 1)),
      // Variante légère pour ne pas servir toujours le même item
      String((questions.length || 0) % 3)
    ];
    let question = getCachedQuestion(cacheKey);
    if (question && isTooSimilarToHistory(question.question, exclusionList)) {
      console.log("[QUIZ NEXT] cache HIT but too similar — skip");
      question = null;
    }
    if (question) {
      console.log("[QUIZ NEXT] cache HIT", cacheKey.slice(0, 4).join("|"));
    } else {
      // Jusqu'à 2 tentatives pour éviter les questions déjà vues
      for (let attempt = 0; attempt < 2; attempt++) {
        const attemptPrompt =
          attempt === 0
            ? prompt
            : prompt +
              "\n\nTENTATIVE " +
              (attempt + 1) +
              " : la question précédente était trop proche de l'historique. Change complètement de notion, de date ou d'angle pédagogique.";
        question = await ask(attemptPrompt, session);
        if (!question) continue;
        if (isTooSimilarToHistory(question.question, exclusionList)) {
          console.log("[QUIZ NEXT] generated too similar, retry", attempt + 1);
          question = null;
          continue;
        }
        break;
      }
      if (question) {
        try {
          const toStore = { ...question };
          delete toStore.id;
          putCachedQuestions(cacheKey, [toStore]);
        } catch (_) {}
      }
    }

    if (!question) {
      return json(res, 503, {
        success: false,
        error:
          "Impossible de générer une question.",
      });
    }

    /*
     * Timestamp serveur.
     */
    const previousQuestion = questions.length ? questions[questions.length - 1] : null;
    // Métadonnées de sécurité imposées par la session, jamais par le modèle.
    question.level = cleanText(session.classe);
    question.subject = cleanText(session.matiere);
    question.classe = cleanText(session.classe);
    question.matiere = cleanText(session.matiere);
    normalizeQuestionMathServer(question, question.subject);
    secureShuffleQuestion(question, previousQuestion?.correctAnswer);
    // Liaison automatique figure si l'IA a omis image_url mais qu'une figure est disponible
    if ((!question.image_url || !String(question.image_url).trim()) && availableFigures.length) {
      const qText = String(question.question || "");
      const needsFig = /figure|graphique|sch[eé]ma|courbe|diagramme|ci-dessus|ci dessus|barycentre|vecteur|solide|triangle|cercle|rep[eè]re|fonction|parabole|histogramme|tableau/i.test(qText);
      // Si figure disponible et question visuelle / unique figure → attacher
      if (needsFig || availableFigures.length >= 1) {
        question.image_url = availableFigures[(questions.length || 0) % availableFigures.length];
      }
    }
    // Valider que image_url fait partie des figures autorisées (anti-invention)
    if (question.image_url && availableFigures.length && !availableFigures.includes(String(question.image_url))) {
      const match = availableFigures.find((u) => String(question.image_url).includes(u) || u.includes(String(question.image_url)));
      question.image_url = match || ( /figure|graphique|sch[eé]ma|courbe/i.test(String(question.question||"")) ? availableFigures[0] : "" );
    }
    // ID unique obligatoire : si deux questions partagent le même id, answer.js
    // retrouve toujours la première et affiche la même correction.
    question.id = crypto.randomUUID();
    question.serverIssuedMs = Date.now();
    // Garantir cohérence post-shuffle
    if (Array.isArray(question.choices) && question.choices.length === 4) {
      const ci = Number(question.correctAnswer);
      if (Number.isInteger(ci) && ci >= 0 && ci <= 3) {
        question.correctChoice = question.choices[ci];
      }
    }

    /**
     * ========================================================
     * SAUVEGARDE FIRESTORE
     * ========================================================
     */

    await ref.update({
      questions:
        getAdmin().firestore.FieldValue.arrayUnion(
          question
        ),

      questionsCount:
        getAdmin().firestore.FieldValue.increment(
          1
        ),
    });

    /**
     * ========================================================
     * REPONSE CLIENT
     * ========================================================
     *
     * IMPORTANT :
     * On ne renvoie PAS correctAnswer.
     *
     * L'élève ne doit évidemment pas recevoir
     * la bonne réponse avant de répondre.
     */

    return json(res, 200, {
      success: true,

      question: {
        id: question.id,
        theme: question.theme || '',
        level: question.level,
        subject: question.subject,
        question: question.question,
        choices: question.choices,
        options: question.choices.map((text, i) => ({
          id: String.fromCharCode(65 + i),
          text,
          feedback: question.option_explanations?.[String(i)] || ''
        })),
        difficulty: question.difficulty,
        image_url: question.image_url || '',
        explanation: question.explanation || '',
        option_explanations: question.option_explanations || null,
        explanations: question.explanations || null,
        hint: question.hint || '',
      },

      index,
    });
  } catch (error) {
    console.error("[QUIZ NEXT]", error);
    const status = error?.status || 503;
    const msg = String(error?.message || "");
    const overloaded =
      status === 429 ||
      status === 503 ||
      /quota|rate limit|surcharg|indisponible|tous les modèles|aucun modèle/i.test(msg);
    return json(res, overloaded ? 503 : status, {
      success: false,
      error: overloaded
        ? "Les services IA sont momentanément surchargés. Veuillez réessayer dans une minute."
        : msg || "Erreur lors de la génération de la question.",
      code: overloaded ? "AI_OVERLOADED" : "NEXT_ERROR",
      ...(error?.providers ? { providers: error.providers } : {}),
      ...(error?.details ? { details: error.details } : {})
    });
  }
};
