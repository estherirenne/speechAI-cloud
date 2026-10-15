#!/bin/sh
# Dijalankan otomatis oleh image postgres HANYA saat volume masih kosong (pertama kali).
set -e

psql -v ON_ERROR_STOP=1 -v app_pw="$APP_DB_PASSWORD" \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===== Skema =====
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text UNIQUE NOT NULL CHECK (username ~ '^[a-zA-Z0-9_]{3,30}$'),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chats (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'New chat' CHECK (char_length(title) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id         bigserial PRIMARY KEY,
  chat_id    uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chats_user_updated ON chats (user_id, updated_at DESC);
CREATE INDEX idx_messages_chat ON messages (chat_id, id);

-- ===== Role aplikasi (bukan superuser, tidak bisa melewati RLS) =====
CREATE ROLE speechai_app LOGIN PASSWORD :'app_pw';
GRANT SELECT, INSERT ON users TO speechai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chats, messages TO speechai_app;
GRANT USAGE, SELECT ON SEQUENCE messages_id_seq TO speechai_app;

-- ===== Row Level Security: tiap user hanya melihat datanya sendiri =====
ALTER TABLE chats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats    FORCE  ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE  ROW LEVEL SECURITY;

CREATE POLICY chats_owner ON chats FOR ALL TO speechai_app
  USING      (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Pesan hanya boleh ditulis ke chat milik sendiri (subquery ke chats ikut kena RLS)
CREATE POLICY messages_owner ON messages FOR ALL TO speechai_app
  USING      (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
              AND EXISTS (SELECT 1 FROM chats c WHERE c.id = chat_id));

-- ===== Data contoh (hanya untuk demo) =====
INSERT INTO users (username, password_hash) VALUES
  ('alice', crypt('alice123', gen_salt('bf'))),
  ('bob',   crypt('bob123',   gen_salt('bf')));

WITH c AS (
  INSERT INTO chats (user_id, title)
  SELECT id, 'Hello from ' || username FROM users
  RETURNING id, user_id
)
INSERT INTO messages (chat_id, user_id, role, content)
SELECT id, user_id, 'assistant', 'Hi! Let''s practice English together. How was your day?' FROM c;

EOSQL
