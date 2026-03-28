-- ============================================================
-- Schema: Plataforma de Pesquisas Online
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Usuários administrativos ────────────────────────────────
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,           -- bcrypt hash
  name        VARCHAR(255) NOT NULL,
  role        VARCHAR(50) DEFAULT 'admin',     -- admin | superadmin
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Pesquisas ───────────────────────────────────────────────
CREATE TABLE surveys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_by      UUID REFERENCES users(id),
  title           VARCHAR(500) NOT NULL,
  description     TEXT,
  status          VARCHAR(50) DEFAULT 'draft',  -- draft | active | closed
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  -- Configurações de coleta
  allow_anonymous BOOLEAN DEFAULT TRUE,
  require_login   BOOLEAN DEFAULT FALSE,
  randomize_questions BOOLEAN DEFAULT FALSE,
  -- Anti-fraude
  max_responses_per_ip INTEGER DEFAULT 1,
  fingerprint_check    BOOLEAN DEFAULT TRUE,
  -- Metadados
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Perguntas ───────────────────────────────────────────────
CREATE TABLE questions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id     UUID REFERENCES surveys(id) ON DELETE CASCADE,
  order_index   INTEGER NOT NULL,
  type          VARCHAR(50) NOT NULL,
  -- tipos: single_choice | multiple_choice | scale | open_text
  --        rating | date | matrix | geo
  text          TEXT NOT NULL,
  description   TEXT,
  required      BOOLEAN DEFAULT TRUE,
  options       JSONB,   -- para single/multiple choice e matrix
  settings      JSONB,   -- ex: {"min": 1, "max": 10, "labels": [...]}
  -- Para lógica condicional
  show_if       JSONB,   -- ex: {"question_id": "...", "value": "sim"}
  -- Grupo demográfico que esta pergunta representa
  demographic_key VARCHAR(100),  -- ex: "gender" | "age_group" | "region"
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Cotas por pesquisa ──────────────────────────────────────
CREATE TABLE quotas (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id   UUID REFERENCES surveys(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,         -- ex: "Mulheres 18-24"
  filters     JSONB NOT NULL,               -- critérios da cota
  target      INTEGER NOT NULL,             -- número alvo de respostas
  current     INTEGER DEFAULT 0,            -- preenchido automaticamente
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Parâmetros populacionais (para raking) ──────────────────
CREATE TABLE population_targets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id   UUID REFERENCES surveys(id) ON DELETE CASCADE,
  dimension   VARCHAR(100) NOT NULL,        -- ex: "gender" | "age_group"
  category    VARCHAR(100) NOT NULL,        -- ex: "female" | "25-34"
  proportion  DECIMAL(10, 6) NOT NULL,      -- 0.0 a 1.0
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (survey_id, dimension, category)
);

-- ─── Sessões de resposta ─────────────────────────────────────
CREATE TABLE response_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id       UUID REFERENCES surveys(id) ON DELETE CASCADE,
  respondent_id   UUID,                     -- opcional (se autenticado)
  ip_hash         VARCHAR(64),              -- SHA-256 do IP (privacidade)
  fingerprint     VARCHAR(64),              -- fingerprint do navegador
  -- Dados geográficos opcionais
  latitude        DECIMAL(9, 6),
  longitude       DECIMAL(9, 6),
  country         VARCHAR(10),
  region          VARCHAR(100),
  -- Status
  status          VARCHAR(50) DEFAULT 'started', -- started | completed | abandoned
  completion_rate DECIMAL(5, 2) DEFAULT 0,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  -- Anti-fraude
  is_bot          BOOLEAN DEFAULT FALSE,
  fraud_score     DECIMAL(5, 2) DEFAULT 0,
  -- Peso estatístico (calculado pelo raking)
  weight          DECIMAL(10, 6) DEFAULT 1.0
);

-- ─── Respostas individuais ───────────────────────────────────
CREATE TABLE answers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id  UUID REFERENCES response_sessions(id) ON DELETE CASCADE,
  question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
  survey_id   UUID REFERENCES surveys(id) ON DELETE CASCADE,
  -- Valor da resposta (flexível para todos os tipos)
  value       JSONB NOT NULL,
  -- ex: {"choice": "female"} | {"choices": ["a","b"]} | {"text": "..."} | {"score": 7}
  answered_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Resultados de ponderação (raking IPF) ───────────────────
CREATE TABLE weighting_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  survey_id       UUID REFERENCES surveys(id) ON DELETE CASCADE,
  status          VARCHAR(50) DEFAULT 'pending',  -- pending | running | done | failed
  -- Parâmetros do algoritmo
  max_iterations  INTEGER DEFAULT 100,
  convergence_tol DECIMAL(10, 8) DEFAULT 0.001,
  weight_trim_max DECIMAL(10, 4) DEFAULT 5.0,    -- peso máximo por respondente
  -- Resultados
  iterations_used INTEGER,
  converged       BOOLEAN,
  final_error     DECIMAL(15, 10),
  summary         JSONB,    -- distribuição dos pesos
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- ─── Índices ─────────────────────────────────────────────────
CREATE INDEX idx_questions_survey      ON questions(survey_id, order_index);
CREATE INDEX idx_answers_session       ON answers(session_id);
CREATE INDEX idx_answers_survey        ON answers(survey_id);
CREATE INDEX idx_sessions_survey       ON response_sessions(survey_id);
CREATE INDEX idx_sessions_ip           ON response_sessions(ip_hash);
CREATE INDEX idx_pop_targets_survey    ON population_targets(survey_id);

-- ─── Seed: usuário admin padrão ──────────────────────────────
-- Senha: admin123 (bcrypt hash)
INSERT INTO users (email, password, name, role) VALUES (
  'admin@pesquisas.com',
  '$2b$10$mLK.rjgRGCi4i.xjqCcGh.5nJXJqPCgAKTGsz8Ke7KwvtxEJ2rKJi',
  'Administrador',
  'superadmin'
) ON CONFLICT DO NOTHING;
