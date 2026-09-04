-- HosBac Quiz : table modèles IA multi-clés
CREATE TABLE IF NOT EXISTS ai_models_config (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL,
    model_name VARCHAR(100) NOT NULL,
    env_key_name VARCHAR(100) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    priority_order INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Optionnel : vider et recharger (décommente si besoin)
-- TRUNCATE ai_models_config RESTART IDENTITY;

-- Exemples optionnels (désactivés : plus de seed auto — ajoutez les modèles depuis le Dashboard Admin)
-- INSERT INTO ai_models_config (provider, model_name, env_key_name, is_active, priority_order) VALUES
-- ('gemini','gemini-3.6-flash','GEMINI_API_KEY',true,1),
-- ('gemini','gemini-3.6-flash','GEMINI_API_KEY_1',true,2),
-- ('gemini','gemini-2.5-flash','GEMINI_API_KEY_2',true,3),
-- ('openrouter','openai/gpt-4o-mini','OPENROUTER_API_KEY',true,10),
-- ('openrouter','openai/gpt-4o-mini','OPENROUTER_API_KEY_1',true,11),
-- ('openrouter','google/gemini-2.0-flash-001','OPENROUTER_API_KEY_2',true,12),
-- ('mistral','mistral-small-latest','MISTRAL_API_KEY',true,20),
-- ('mistral','mistral-small-latest','MISTRAL_API_KEY_1',true,21),
-- ('mistral','mistral-small-latest','MISTRAL_API_KEY_2',true,22),
-- ('mistral','mistral-small-latest','MISTRAL_API_KEY_3',true,23),
-- ('grok','grok-2-latest','XAI_API_KEY',true,30),
-- ('grok','grok-2-latest','GROK_API_KEY_1',true,32),
-- ('cloudflare','@cf/meta/llama-3.1-8b-instruct','CLOUDFLARE_API_TOKEN',true,40),
-- ('cloudflare','@cf/meta/llama-3.1-8b-instruct','CLOUDFLARE_API_TOKEN_2',true,41)
-- ON CONFLICT DO NOTHING;
