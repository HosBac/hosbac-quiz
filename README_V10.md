# HosBac Quiz V10

Version V10 basée sur V9.5, avec corrections ciblées et conservation des fonctionnalités existantes.

## Corrections principales
- inscription/profil HosBac : classe 6ème → Terminale, série uniquement 2nd/1ère/Terminale, séries A/B/C/D/AB/CD, établissement et région ;
- FAQ et À propos configurables depuis l’administration HosBac ;
- configuration Quiz validée après sauvegarde côté serveur et valeurs visibles ;
- RAG : titre, classe, série, SA1 à SA8, chapitre et indexation PDF ; détection automatique de SA dans le texte ;
- mode oral : pipeline IA avec Gemini x2, Groq x2, Mistral x2, OpenRouter x2 et Cloudflare x2 ;
- OCR : reconstruction du document et rendu mathématique avant affichage/export ;
- indice : marque la question côté serveur et réduit de 30 % le XP de cette question, sans ajouter un texte technique ;
- correction QCM : bonne réponse A/B/C/D explicitement identifiée ;
- PvP : coût d’utilisation configurable (3 XP par défaut) et 1 XP par bonne réponse en duel ;
- sons de correction renforcés ;
- quota IA quotidien piloté par la configuration active ;
- aucune modification volontaire des fonctionnalités non concernées.
