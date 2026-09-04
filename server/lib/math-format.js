"use strict";

/** HosBac — normalisation mathématique unique serveur. */
function isMathSubject(subject) {
  const s = String(subject || "").trim().toUpperCase();
  return ["MATHS", "MATHÉMATIQUES", "MATHEMATIQUES", "PCT", "PHYSIQUE-CHIMIE", "PHYSIQUE CHIMIE", "PHYSIQUE-CHIMIE (PCT)"].includes(s);
}

function isLiteralSubject(subject) {
  const s = String(subject || "").trim().toUpperCase();
  return ["SVT", "ANGLAIS", "FRANCAIS", "FRANÇAIS", "HISTOIRE-GEO", "HISTOIRE-GÉOGRAPHIE", "PHILOSOPHIE"].includes(s);
}

function unescapeMathText(value) {
  let s = String(value ?? "");
  for (let i = 0; i < 3; i++) s = s.replace(/\\\\(?=[A-Za-z\[\]\(\)\{\}])/g, "\\");
  // Do NOT turn \text, \times, \theta, \tan or \right into control characters.
  return s.replace(/\\n(?![A-Za-z])/g, "\n").replace(/\\t(?![A-Za-z])/g, "\t").replace(/\\r(?![A-Za-z])/g, "\r");
}

function convertBalancedFractions(s) {
  let out = String(s || ""), changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== "/" || out[i - 1] !== ")" || out[i + 1] !== "(") continue;
      let depth = 0, leftStart = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (out[j] === ")") depth++;
        else if (out[j] === "(") { depth--; if (depth === 0) { leftStart = j; break; } }
      }
      if (leftStart < 0) continue;
      depth = 0; let rightEnd = -1;
      for (let j = i + 1; j < out.length; j++) {
        if (out[j] === "(") depth++;
        else if (out[j] === ")") { depth--; if (depth === 0) { rightEnd = j; break; } }
      }
      if (rightEnd < 0) continue;
      const a = out.slice(leftStart + 1, i - 1).trim(), b = out.slice(i + 2, rightEnd).trim();
      if (!a || !b) continue;
      out = out.slice(0, leftStart) + `\\frac{${a}}{${b}}` + out.slice(rightEnd + 1);
      changed = true; break;
    }
  }
  return out;
}

function canonicalizeMathBody(body) {
  let s = unescapeMathText(body).trim();
  if (!s) return s;

  // Repair old corrupted responses such as TAB+"ext" / TAB+"imes".
  s = s.replace(/\t(ext|imes|heta|an)\b/g, (_, cmd) => cmd === "imes" ? "\\times" : cmd === "heta" ? "\\theta" : cmd === "an" ? "\\tan" : "\\text")
    .replace(/(^|[^\\A-Za-z])(ext|imes|heta|frac|sqrt|lim|ln|log|sin|cos|tan|times|div|cdot|leq|geq|neq|pm|alpha|beta|gamma|delta|theta|pi|infty|in|mid|to|rightarrow|leftarrow)(?=\s*(?:\{|\(|\[|_|\^|[A-Za-z0-9]))/gi, (_, pre, cmd) => pre + "\\" + cmd);
  s = s.replace(/[−–—]/g, "-").replace(/×/g, "\\times ").replace(/÷/g, "\\div ")
    .replace(/≤/g, "\\leq ").replace(/≥/g, "\\geq ").replace(/≠/g, "\\neq ")
    .replace(/±/g, "\\pm ").replace(/∞/g, "\\infty ");

  const bare = "frac|dfrac|tfrac|sqrt|vec|overrightarrow|overleftarrow|hat|bar|tilde|mathbf|mathrm|mathbb|sum|prod|int|lim|sin|cos|tan|log|ln|alpha|beta|gamma|delta|theta|pi|infty|leq|geq|neq|pm|times|div|cdot|partial|nabla|in|mid|to|rightarrow|leftarrow|forall|exists|subset|subseteq|cup|cap|perp|parallel|approx|sim|equiv";
  s = s.replace(new RegExp(`(^|[^\\\\A-Za-z])(${bare})(?=\\s*(?:\\{|\\(|\\[|_|\\^|[A-Za-z0-9]))`, "gi"), (_, pre, cmd) => pre + "\\\\" + cmd);

  s = s.replace(/(?:\\)?(sqrt|ln|log|sin|cos|tan)\s*\(\s*([^()]*)\s*\)/gi, (_, fn, x) => `\\${fn}{${x.trim()}}`)
    .replace(/([A-Za-z0-9])\s*\^\s*\(([^()]*)\)/g, (_, base, exp) => `${base}^{${exp.trim()}}`)
    .replace(/(?:\\)?(?:frac|dfrac|tfrac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gi, (_, a, b) => `\\frac{${a.trim()}}{${b.trim()}}`);

  s = s.replace(/\\left\s*/g, "").replace(/\\right\s*/g, "")
    .replace(/\\,/g, " ").replace(/\\;/g, " ").replace(/\\:/g, " ").replace(/\\!/g, "")
    .replace(/\\quad\b/g, " ").replace(/\\qquad\b/g, " ")
    .replace(/\\begin\{(?:array|aligned|cases|matrix|pmatrix|bmatrix)\}/g, "")
    .replace(/\\end\{(?:array|aligned|cases|matrix|pmatrix|bmatrix)\}/g, "")
    .replace(/\\\\/g, "\\");

  s = convertBalancedFractions(s)
    .replace(/((?:[A-Za-z][A-Za-z0-9']*)\s*\([^()]*\))\s*\/\s*((?:[A-Za-z][A-Za-z0-9']*)\s*\([^()]*\))/g, (_, a, b) => `\\frac{${a.trim()}}{${b.trim()}}`)
    .replace(/\b([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)\b/g, (_, a, b) => `\\frac{${a}}{${b}}`)
    .replace(/\b([A-Za-z0-9])\s*\^\s*(?:\{([^{}]+)\}|([A-Za-z0-9]+))/g, (_, a, b, c) => `${a}^{${b ?? c}}`)
    .replace(/\b([A-Za-z0-9])\s*_\s*(?:\{([^{}]+)\}|([A-Za-z0-9]+))/g, (_, a, b, c) => `${a}_{${b ?? c}}`);

  return s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\s{2,}/g, " ").trim();
}

function isFormulaLike(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 260) return false;
  const hasMath = /[=^_+*/<>≤≥≠±]|\\(?:frac|sqrt|ln|log|sin|cos|tan|alpha|beta|gamma|theta|pi|infty|leq|geq|neq|times|div|cdot|vec|int|sum|partial|nabla|in|mid|to|lim)\b/.test(t);
  if (!hasMath) return false;
  const words = (t.match(/[A-Za-zÀ-ÿ]{2,}/g) || []).filter(w => !["lim","sin","cos","tan","log","ln","frac","sqrt","infty"].includes(w.toLowerCase())).length;
  return words <= 10;
}

function stripLiteralMath(text) {
  return String(text || "").replace(/\\\[([\s\S]*?)\\\]/g, "$1").replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1").replace(/\$([^$\n]+)\$/g, "$1").replace(/\s{2,}/g, " ").trim();
}

function repairLegacyMathEscapes(value) {
  let s = String(value ?? "");
  s = s.replace(/\t(ext|imes|heta|an)\b/g, (_, cmd) => cmd === "imes" ? "\\times" : cmd === "heta" ? "\\theta" : cmd === "an" ? "\\tan" : "\\text");
  s = s.replace(/(^|[^\\A-Za-z])(ext|imes|frac|sqrt|lim|ln|log|sin|cos|tan|times|div|cdot|leq|geq|neq|pm|alpha|beta|gamma|delta|theta|pi|infty|in|mid|to|rightarrow|leftarrow)(?=\s*(?:\{|\(|\[|_|\^|[0-9]))/gi, (_, pre, cmd) => pre + "\\" + (cmd === "ext" ? "text" : cmd === "imes" ? "times" : cmd));
  return s;
}

function normalizeMathMarkup(value, subject) {
  const raw = repairLegacyMathEscapes(unescapeMathText(value)).trim();
  if (!raw) return raw;
  if (!isMathSubject(subject)) return isLiteralSubject(subject) ? stripLiteralMath(raw) : raw;

  const blocks = [];
  let text = raw;
  text = text.replace(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)/g,
    (m, display, inline, bracketDisplay, bracketInline) => {
      const body = display != null ? display : (inline != null ? inline : (bracketDisplay != null ? bracketDisplay : bracketInline));
      const isDisplay = display != null || bracketDisplay != null;
      blocks.push({ body: canonicalizeMathBody(body), display: isDisplay });
      return `@@HOSBAC_MATH_${blocks.length - 1}@@`;
    });

  const add = (match, display = false) => { blocks.push({ body: canonicalizeMathBody(match), display }); return `@@HOSBAC_MATH_${blocks.length - 1}@@`; };

  // OCR frequently returns one equation per line. Render each equation as a block.
  text = text.split("\n").map(line => {
    const trimmed = line.trim();
    if (!trimmed.includes('@@HOSBAC_MATH') && isFormulaLike(trimmed) && !/^[-*]\s+/.test(trimmed)) return line.slice(0, line.indexOf(trimmed)) + add(trimmed, true);
    return line;
  }).join("\n");

  text = text.replace(/\\\{[^\n]{1,320}?\\\}(?=\s|[.,;!?]|$)/g, add);
  text = text.replace(/(^|[\s:;(])((?:(?:\\[A-Za-z]+\s*)?\{[^{}]+\}|[A-Za-z][A-Za-z0-9'()]*(?:\s*[_^]\s*(?:\{[^{}]+\}|[A-Za-z0-9]+))?)\s*=\s*[A-Za-z0-9\\{}_^()+*/.'\- ±≤≥≠×÷ ]{1,180})(?=$|[.,;!?])/g,
    (full, pre, candidate) => isFormulaLike(candidate) ? pre + add(candidate.trim(), false) : full);
  text = text.replace(/(?:\\)?(?:frac|dfrac|tfrac)\s*\{[^{}]+\}\s*\{[^{}]+\}/gi, add);
  text = text.replace(/(?:\\)?(?:sqrt|ln|log|sin|cos|tan)\s*(?:\([^()]+\)|\{[^{}]+\})/gi, add);
  text = text.replace(/(?:\\)?(?:vec|overrightarrow|overleftarrow|hat|bar|tilde|mathbf|mathrm|mathbb)\s*\{[^{}]+\}/gi, add);
  text = text.replace(/(?:\\)?lim\s*[_^]\s*(?:\{[^{}]+\}|[A-Za-z0-9+\-]+)/gi, add);

  if (!text.includes("@@HOSBAC_MATH_") && isFormulaLike(text)) text = add(text, true);
  // Text macros left outside a formula are ordinary document text, not math.
  text = text.replace(/\\text\{([^{}]*)\}/g, "$1").replace(/\\mathrm\{([^{}]*)\}/g, "$1");
  return text.replace(/@@HOSBAC_MATH_(\d+)@@/g, (_, i) => { const b = blocks[Number(i)]; return b ? (b.display ? `$$${b.body}$$` : `$${b.body}$`) : ""; }).trim();
}

function normalizeQuestionMath(question, subject) {
  if (!question || typeof question !== "object") return question;
  for (const key of ["theme", "question", "explanation", "hint"]) if (question[key] != null) question[key] = normalizeMathMarkup(question[key], subject);
  if (Array.isArray(question.choices)) question.choices = question.choices.map(v => normalizeMathMarkup(v, subject));
  for (const key of ["option_explanations", "explanations"]) if (question[key] && typeof question[key] === "object") for (const k of Object.keys(question[key])) question[key][k] = normalizeMathMarkup(question[key][k], subject);
  return question;
}

module.exports = { isMathSubject, normalizeMathMarkup, normalizeQuestionMath };
