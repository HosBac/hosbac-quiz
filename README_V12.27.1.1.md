# HosBac Quiz — V12.27.1.1

Corrections ciblées (rendu LaTeX, nettoyage texte, modération).

## 1. Rendu des formules mathématiques
- `mathHtml` renforcé : protection des blocs math, conversion markdown → HTML, normalisation des délimiteurs `\( \)` / `\[ \]` pour MathJax.
- `typesetAllMath` cible les conteneurs quiz/OCR pour un rendu plus fiable.
- Les formules ne doivent plus apparaître en texte brut non interprété.

## 2. Nettoyage des astérisques / balises brutes
- Nouvelle fonction `markdownToSafeHtml` : `**gras**`, `*italique*`, titres `#` → balises HTML propres.
- Suppression des astérisques et séparateurs résiduels à l'affichage.
- Nouvelle fonction `cleanSpeechText` + intégration dans `playAudioTTS` : aucun symbole de mise en forme lu à haute voix.

## 3. Modération stricte
- **OCR (client)** : rejet si texte trop court ou mots-clés non académiques ; message officiel de non-conformité.
- **OCR (IA)** : le prompt impose un JSON `rejected:true` pour tout contenu hors cours collège/lycée (nudité, violence, hors-sujet).
- **Mode oral** : prompt système renforcé — refus ferme de toute discussion non scolaire avec la phrase imposée.
- API `ai/analyze` propage le code `CONTENT_REJECTED` (HTTP 422).

## Fichiers modifiés
- `index.html`
- `server/handlers/ai/analyze.js`

Aucune autre fonctionnalité n'a été altérée.
