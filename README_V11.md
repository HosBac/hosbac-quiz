# HosBac Quiz V11

Base: HosBac-Quiz-V10.1. Cette version corrige uniquement la logique du quiz et la persistance de configuration, sans modifier l’intégration HosBac principale.

## Corrections principales
- Évaluation serveur normalisée pour A/B/C/D ou 0/1/2/3.
- Bonne réponse toujours calculée à partir de la question stockée côté serveur.
- Réponse sélectionnée et bonne réponse renvoyées explicitement pour éviter les incohérences visuelles.
- XP créditée immédiatement après une bonne réponse.
- `currentIndex` déterministe basé sur le nombre de réponses enregistrées.
- Limite et nombre de questions d’une session figés au démarrage; aucune session partielle n’est créée lorsque le quota quotidien restant est insuffisant.
- Quiz par matière, selon la configuration serveur.
- Aucun minuteur dans l’interface.
- Mélange cryptographique des quatre choix; la position correcte ne reste pas volontairement sur A et ne se répète pas deux fois de suite.
- `correctChoice` recalculée après mélange.
- Validation stricte des QCM: exactement quatre choix, choix uniques, réponse correcte valide, explication obligatoire.
- Affichage mathématique renforcé et conservation des délimiteurs MathJax.
- Configuration admin relue après sauvegarde directement depuis Firestore; confirmation serveur et date de sauvegarde visibles.
- Jours disponibles et quotas rechargés depuis le serveur après actualisation.
- Volume des notifications sonores augmenté.

## Vérification
Les fichiers JavaScript serveur doivent passer `node --check`. Le frontend est servi comme fichier HTML statique par Vercel.
