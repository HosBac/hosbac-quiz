-- ============================================================
-- HosBac Quiz V12 - Schéma Neon (pgvector)
-- À exécuter une seule fois dans le SQL Editor de Neon
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS document_sections (
  id              BIGSERIAL PRIMARY KEY,
  content         TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  embedding       vector(768),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_sections_embedding
  ON document_sections
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_document_sections_metadata
  ON document_sections
  USING GIN (metadata);

CREATE TABLE IF NOT EXISTS quiz_results (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  score           INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  subject         TEXT,
  classe          TEXT,
  serie           TEXT,
  session_id      TEXT,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_results_user
  ON quiz_results (user_id);

CREATE INDEX IF NOT EXISTS idx_quiz_results_completed
  ON quiz_results (completed_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  classe          TEXT,
  serie           TEXT,
  matiere         TEXT,
  sa_title        TEXT,
  sequences       TEXT[] DEFAULT '{}',
  cloudinary_url  TEXT,
  public_id       TEXT,
  chunk_count     INTEGER DEFAULT 0,
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_classe_matiere
  ON documents (classe, matiere);


-- Modèles IA (fallback multi-provider)
CREATE TABLE IF NOT EXISTS ai_models_config (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  model_name VARCHAR(100) NOT NULL,
  env_key_name VARCHAR(100) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  priority_order INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Images extraites des PDF (Cloudinary URLs liées aux documents RAG)
CREATE TABLE IF NOT EXISTS document_images (
  id              BIGSERIAL PRIMARY KEY,
  document_id     TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL DEFAULT 0,
  image_url       TEXT NOT NULL,
  public_id       TEXT,
  page            INTEGER,
  width           INTEGER,
  height          INTEGER,
  md5_hash        TEXT,
  caption         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_images_document_id
  ON document_images (document_id);

CREATE INDEX IF NOT EXISTS idx_document_images_hash
  ON document_images (md5_hash);
