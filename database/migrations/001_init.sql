CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username TEXT UNIQUE NOT NULL CHECK (char_length(username) BETWEEN 3 AND 32),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'offline',
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  privacy JSONB NOT NULL DEFAULT '{"profile":"contacts","lastSeen":"contacts","calls":"contacts"}',
  settings JSONB NOT NULL DEFAULT '{"theme":"liquid","notifications":true,"sound":true,"language":"ru"}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  call_policy_version TEXT NOT NULL,
  developer_policy_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS user_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_address INET,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contacts (
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias TEXT,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, contact_id),
  CHECK (owner_id <> contact_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type TEXT NOT NULL CHECK (type IN ('private','group','channel')),
  title TEXT,
  description TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','subscriber')),
  muted_until TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  reply_to UUID REFERENCES messages(id) ON DELETE SET NULL,
  thread_root UUID REFERENCES messages(id) ON DELETE SET NULL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_body_search_idx ON messages USING GIN (to_tsvector('simple', body));

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY(message_id, user_id)
);
CREATE TABLE IF NOT EXISTS saved_messages (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, message_id)
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','audio','document','voice','avatar')),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  initiator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('voice','video','screen')),
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','active','ended','missed','rejected')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS call_participants (
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','joined','left','rejected')),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  PRIMARY KEY(call_id, user_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','message','chat')),
  target_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS extension_marketplace (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  manifest JSONB NOT NULL,
  trust TEXT NOT NULL DEFAULT 'community' CHECK (trust IN ('official','verified','community')),
  category TEXT NOT NULL DEFAULT 'Plugins',
  publisher TEXT NOT NULL DEFAULT 'Community',
  rating NUMERIC(3,2) NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  package_url TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_extensions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL REFERENCES extension_marketplace(id) ON DELETE CASCADE,
  manifest JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, extension_id)
);
CREATE TABLE IF NOT EXISTS extension_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK (action IN ('install','enable','disable','remove','update','rollback','safe-mode')),
  snapshot JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS extension_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  extension_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

INSERT INTO extension_marketplace(id, manifest, trust, category, publisher, rating, downloads, package_url, signature, status) VALUES
('core-tools', '{"id":"core-tools","name":"Core Tools","version":"1.0.0","author":"Liquid Messenger Team","trust":"official","category":"Productivity","description":"Command palette and quick actions for chats, files and calls.","permissions":["ui","commands","events","notifications","voice","microphone","camera","screenshare","call-events"],"entry":"index.js"}', 'official', 'Productivity', 'Liquid Messenger Team', 5.00, 0, '/plugins/core-tools/', 'official-local', 'active'),
('theme-pack', '{"id":"theme-pack","name":"Theme Pack","version":"1.0.0","author":"Liquid Messenger Team","trust":"official","category":"Themes","description":"Official neon and minimal theme examples for extension developers.","permissions":["ui","theme","storage"],"entry":"index.js"}', 'official', 'Themes', 'Liquid Messenger Team', 5.00, 0, '/plugins/theme-pack/', 'official-local', 'active'),
('safe-mode-controller', '{"id":"safe-mode-controller","name":"Safe Mode Controller","version":"1.0.0","author":"Liquid Messenger Team","trust":"official","category":"Security","description":"Recovery controls for disabling extensions without deleting user data.","permissions":["ui","events","storage","notifications"],"entry":"index.js"}', 'official', 'Security', 'Liquid Messenger Team', 5.00, 0, '/plugins/safe-mode-controller/', 'official-local', 'active')
ON CONFLICT(id) DO UPDATE SET manifest=EXCLUDED.manifest, trust=EXCLUDED.trust, category=EXCLUDED.category, publisher=EXCLUDED.publisher, package_url=EXCLUDED.package_url, signature=EXCLUDED.signature, status=EXCLUDED.status, updated_at=now();

-- Performance indexes for 500+ concurrent users and fast search/realtime fanout.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_username_trgm_idx ON users USING GIN (lower(username) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_display_name_trgm_idx ON profiles USING GIN (lower(display_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS chat_members_user_updated_idx ON chat_members(user_id, chat_id);
CREATE INDEX IF NOT EXISTS chat_members_chat_user_idx ON chat_members(chat_id, user_id);
CREATE INDEX IF NOT EXISTS contacts_owner_blocked_idx ON contacts(owner_id, blocked, contact_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_valid_idx ON refresh_tokens(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS legal_acceptances_user_accepted_idx ON legal_acceptances(user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS message_receipts_user_read_idx ON message_receipts(user_id, read_at);
CREATE INDEX IF NOT EXISTS attachments_uploader_created_idx ON attachments(uploader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_status_created_idx ON reports(status, created_at DESC);

CREATE INDEX IF NOT EXISTS extension_marketplace_status_idx ON extension_marketplace(status, trust, category);
CREATE INDEX IF NOT EXISTS user_extensions_user_enabled_idx ON user_extensions(user_id, enabled);
CREATE INDEX IF NOT EXISTS extension_history_user_created_idx ON extension_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS extension_reports_status_created_idx ON extension_reports(status, created_at DESC);
