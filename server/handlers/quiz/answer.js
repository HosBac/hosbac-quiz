const {
  getAdmin,
  json,
  requireAuth,
} = require("../../lib/firebase");

const {
  normalize,
} = require("../../lib/config");

const cors =
  require("../../lib/cors");

const { normalizeQuestionMath } = require("../../lib/math-format");

const crypto =
  require("crypto");

function normalizeAnswer(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3) return value;
  const raw = String(value ?? "").trim().toUpperCase();
  if (/^[0-3]$/.test(raw)) return Number(raw);
  if (/^[ABCD]$/.test(raw)) return raw.charCodeAt(0) - 65;
  return null;
}

function normalizeCorrectAnswer(value) {
  const n = normalizeAnswer(value);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
}

module.exports = async (
  req,
  res
) => {
  if (cors(req, res)) return;

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "Méthode non autorisée",
    });
  }

  try {
    const decoded =
      await requireAuth(req);

    const db =
      getAdmin().firestore();

    const body =
      req.body || {};

    const sessionId =
      String(
        body.sessionId || ""
      ).trim();

    const questionId =
      String(
        body.questionId || ""
      ).trim();

    if (!sessionId) {
      return json(res, 400, {
        success: false,
        error:
          "sessionId manquant",
      });
    }

    if (!questionId) {
      return json(res, 400, {
        success: false,
        error:
          "questionId manquant",
      });
    }

    const ref =
      db
        .collection(
          "quiz_sessions"
        )
        .doc(sessionId);

    /**
     * Transaction atomique.
     *
     * Cela empêche deux clics simultanés
     * de valider deux fois la même question.
     */
    const result =
      await db.runTransaction(
        async (transaction) => {
          const snap =
            await transaction.get(
              ref
            );

          if (!snap.exists) {
            throw Object.assign(
              new Error(
                "Session introuvable"
              ),
              { status: 404 }
            );
          }

          const session =
            snap.data();

          if (
            session.userId !==
            decoded.uid
          ) {
            throw Object.assign(
              new Error(
                "Accès refusé"
              ),
              { status: 403 }
            );
          }

          if (
            session.status !==
            "active"
          ) {
            throw Object.assign(
              new Error(
                "Session terminée"
              ),
              { status: 409 }
            );
          }

          const questions =
            Array.isArray(
              session.questions
            )
              ? session.questions
              : [];

          const answers =
            Array.isArray(
              session.answers
            )
              ? session.answers
              : [];

          const question =
            questions.find(
              (q) =>
                q &&
                String(q.id) ===
                  questionId
            );

          if (question) normalizeQuestionMath(question, question.subject || question.matiere || "");

          if (!question) {
            throw Object.assign(
              new Error(
                "Question introuvable"
              ),
              { status: 404 }
            );
          }

          /**
           * IMPORTANT :
           *
           * Si le navigateur renvoie deux fois
           * la même réponse, on ne renvoie plus
           * "Question déjà répondue".
           *
           * On retourne simplement le résultat
           * déjà enregistré.
           */
          const previousAnswer =
            answers.find(
              (answer) =>
                answer &&
                String(
                  answer.questionId
                ) === questionId
            );

          if (previousAnswer) {
            return {
              alreadyAnswered:
                true,

              isCorrect:
                Boolean(
                  previousAnswer.isCorrect
                ),

              xpEarned:
                Number(
                  previousAnswer.xp || 0
                ),

              streak:
                Number(
                  session.correctStreak ||
                    0
                ),

              nextDifficulty:
                Number(
                  session.currentDifficulty ||
                    1
                ),

              elapsedSeconds:
                Number(
                  previousAnswer.elapsedSeconds ||
                    0
                ),

              explanation:
                question.explanation ||
                "",
              correctAnswer: normalizeCorrectAnswer(question.correctAnswer),
              correctLetter: (() => { const ci = normalizeCorrectAnswer(question.correctAnswer); return Number.isInteger(ci) ? String.fromCharCode(65 + ci) : ""; })(),
              correctChoice: Array.isArray(question.choices) ? question.choices[normalizeCorrectAnswer(question.correctAnswer)] || "" : "",
              selectedAnswer: normalizeAnswer(previousAnswer.answer),
              selectedLetter: (() => { const si = normalizeAnswer(previousAnswer.answer); return Number.isInteger(si) ? String.fromCharCode(65 + si) : ""; })(),
              selectedChoice: Array.isArray(question.choices) ? question.choices[normalizeAnswer(previousAnswer.answer)] || "" : "",
              questionId: question.id,
            };
          }

          const now = Date.now();
          // Aucun chronomètre pour le quiz : le temps ne bloque jamais la réponse.
          const elapsed = Math.max(0, Math.floor((now-Number(question.serverIssuedMs||session.serverStartMs||now))/1000));

          const selectedIndex = normalizeAnswer(body.answer);
          let correctIndex = normalizeCorrectAnswer(question.correctAnswer);

          // Source de vérité : le texte exact de la bonne proposition stockée,
          // pour éviter tout décalage après mélange A/B/C/D.
          if (Array.isArray(question.choices) && question.choices.length === 4) {
            const want = String(question.correctChoice || "").trim();
            if (want) {
              const byExact = question.choices.findIndex(c => String(c).trim() === want);
              if (byExact >= 0) correctIndex = byExact;
              else {
                const byLoose = question.choices.findIndex(c => String(c).trim().toLowerCase() === want.toLowerCase());
                if (byLoose >= 0) correctIndex = byLoose;
              }
            }
          }

          const timedOut = body.timedOut === true || body.timeout === true || String(body.answer) === '-1';
          if (selectedIndex === null && !timedOut) {
            throw Object.assign(new Error("Réponse invalide. Choisis uniquement A, B, C ou D."), {status:400, code:"INVALID_ANSWER"});
          }
          if (correctIndex === null || !Array.isArray(question.choices) || question.choices.length !== 4) {
            throw Object.assign(new Error("Question invalide côté serveur. La question a été rejetée pour éviter une correction incohérente."), {status:500, code:"INVALID_QUESTION"});
          }

          // Comparaison STRICTE par index (lettre A=0..D=3). Temps écoulé = incorrect.
          const isCorrect = !timedOut && selectedIndex === correctIndex;
          const correctLetter = String.fromCharCode(65 + correctIndex);
          const selectedLetter = selectedIndex === null ? "" : String.fromCharCode(65 + selectedIndex);


          const config =
            normalize(
              (await db.collection("quiz_config").doc("global").get()).data() || {}
            );

          const previousStreak =
            Number(
              session.correctStreak ||
                0
            );

          const newStreak =
            isCorrect
              ? previousStreak + 1
              : 0;

          let xp = 0;

          if (isCorrect) {
            xp = Number(config.baseXP) || 0;
            if (elapsed <= config.speedThresholdSeconds && newStreak >= config.streakRequired) xp *= config.speedMultiplier;
            const hintsUsed = Array.isArray(session.hintsUsed) ? session.hintsUsed : [];
            if (hintsUsed.includes(questionId)) {
              xp = Math.max(0, Math.round(xp * 0.70 * 100) / 100);
            }
          }

          const currentDifficulty =
            Number(
              session.currentDifficulty ||
                1
            );

          let nextDifficulty =
            currentDifficulty;

          if (
            isCorrect &&
            newStreak >= 3
          ) {
            nextDifficulty =
              Math.min(
                4,
                currentDifficulty +
                  1
              );
          } else if (
            !isCorrect &&
            previousStreak === 0
          ) {
            nextDifficulty =
              Math.max(
                1,
                currentDifficulty -
                  1
              );
          }

          const answerId =
            crypto.randomUUID();

          const userRef = getAdmin().firestore().collection("users").doc(decoded.uid);
          const userSnap = await transaction.get(userRef);
          const userData = userSnap.exists ? userSnap.data() : {};
          const oldQuizXp = Number(userData.quiz_xp || 0);
          const newQuizXp = oldQuizXp + xp;
          const oldTotalXp = Number(userData.totalXp || 0);
          const oldInspe = Number(userData.inspe_points || 0);

          const entry = {
            answerId,

            questionId:
              question.id,

            answer: selectedIndex,

            isCorrect,

            elapsedSeconds:
              elapsed,

            xp,

            createdAt:
              getAdmin()
                .firestore
                .Timestamp
                .now(),
          };

          transaction.update(
            ref,
            {
              answers:
                getAdmin()
                  .firestore
                  .FieldValue
                  .arrayUnion(
                    entry
                  ),

              correctStreak:
                newStreak,

              currentDifficulty:
                nextDifficulty,

              xpEarned:
                getAdmin()
                  .firestore
                  .FieldValue
                  .increment(
                    xp
                  ),

              // L'index serveur est dérivé du nombre de réponses réellement enregistrées.
              // Il ne peut donc pas rester bloqué ni avancer deux fois sur un double clic.
              currentIndex: answers.length + 1,
            }
          );

          if (xp > 0) {
            transaction.set(userRef, {
              quiz_xp: newQuizXp,
              totalXp: oldTotalXp + xp,
              inspe_points: oldInspe + xp,
              quiz_level: Math.floor(newQuizXp / 100) + 1,
              quiz_last_xp_earned: xp,
              quiz_xp_updated_at: getAdmin().firestore.Timestamp.now()
            }, {merge:true});
          }

          return {
            alreadyAnswered:
              false,

            isCorrect,

            xpEarned:
              xp,

            streak:
              newStreak,

            nextDifficulty,

            elapsedSeconds:
              elapsed,

            explanation:
              question.explanation ||
              "",
            option_explanations: question.option_explanations || null,
            explanations: question.explanations || null,
            timedOut: false,
            correctAnswer: correctIndex,
            correctLetter,
            correctChoice: Array.isArray(question.choices) ? question.choices[correctIndex] || "" : "",
            selectedAnswer: selectedIndex,
            selectedLetter,
            selectedChoice: (selectedIndex !== null && Array.isArray(question.choices)) ? question.choices[selectedIndex] || "" : "",
            questionId: question.id,
            explanation: question.explanation || "",
            option_explanations: question.option_explanations || null,
            explanations: question.explanations || null,
            timedOut: timedOut,
            quizXpTotal: newQuizXp
          };
        }
      );

    /**
     * Même réponse HTTP 200 dans les deux cas :
     *
     * - première validation ;
     * - deuxième requête identique.
     *
     * Le frontend ne sera donc plus bloqué
     * par "Question déjà répondue".
     */
    return json(res, 200, {
      success: true,

      alreadyAnswered:
        result.alreadyAnswered,

      isCorrect:
        result.isCorrect,

      xpEarned:
        result.xpEarned,

      streak:
        result.streak,

      nextDifficulty:
        result.nextDifficulty,

      elapsedSeconds:
        result.elapsedSeconds,

      explanation:
        result.explanation,
      correctAnswer: result.correctAnswer,
      correctLetter: result.correctLetter,
      correctChoice: result.correctChoice,
      selectedAnswer: result.selectedAnswer,
      selectedLetter: result.selectedLetter,
      selectedChoice: result.selectedChoice,
      questionId: result.questionId,
      quizXpTotal: result.quizXpTotal
    });
  } catch (error) {
    console.error(
      "[QUIZ ANSWER]",
      error
    );

    return json(
      res,
      error.status || 500,
      {
        success: false,

        ...(error.code
          ? {
              code:
                error.code,
            }
          : {}),

        error:
          error.message ||
          "Erreur lors de la validation de la réponse.",
      }
    );
  }
};
