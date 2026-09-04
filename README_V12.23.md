# HosBac Quiz V12.23 — Robustesse & charge (300–500 users)

## 1. Fallback multi-clés IA
- `generateWithFallback` lit les modèles actifs (Neon `ai_models_config`, `priority_order ASC`).
- En cas d’échec / 429 / quota : bascule immédiate vers le modèle/clé suivant (délai minimal).
- Déduplication provider+model+env ; log de la clé utilisée.

## 2. Cache questions (mémoire + TTL)
- Nouveau module `server/lib/question-cache.js` (TTL 15 min, max ~400 clés, 24 items/clé).
- `quiz/next` : HIT cache avant appel IA ; MISS → génération + mise en cache.
- `quiz/batch` : alimente le cache après génération batch.
- Clé : classe | série | matière | chapitre | difficulté.

## 3. Pool PostgreSQL Neon
- Détection URL `-pooler` / pgbouncer.
- `max` configurable (`PG_POOL_MAX`, défaut 15 pooler / 8 direct, plafonné à 20).
- `idleTimeout`, `connectionTimeout`, `statement_timeout` (15 s).
- `allowExitOnIdle: true`.

## 4. PvP — nettoyage écouteurs / polls
- `stopAllPvpPolling()` centralise clearInterval (match + invitations).
- `pagehide` / `beforeunload` / `visibilitychange` → arrêt des polls + presence `idle`.

## Fichiers touchés
- `server/lib/db.js`
- `server/lib/ai-fallback.js`
- `server/lib/question-cache.js` (nouveau)
- `server/handlers/quiz/next.js`
- `server/handlers/quiz/batch.js`
- `index.html` (cleanup PvP)

Auth, parcours élève, admin modèles : inchangés.
