-- 初期スキーマ（設計書 §6 の 7 表）
-- Initial schema (the 7 tables of design doc section 6)

CREATE TABLE channels (
  login TEXT PRIMARY KEY,
  display_name TEXT,
  created_by TEXT,
  created_at TEXT
);

CREATE TABLE members (
  channel TEXT,
  login TEXT,
  role TEXT,
  added_by TEXT,
  added_at TEXT,
  PRIMARY KEY (channel, login)
);

CREATE TABLE streams (
  stream_id TEXT PRIMARY KEY,
  channel TEXT,
  started_at TEXT,
  title TEXT,
  vod_id TEXT,
  -- VOD 開始が配信開始より遅れた分の補正。人が直す
  -- Correction for the VOD starting later than the stream. Edited by hand
  vod_offset_sec REAL DEFAULT 0,
  -- 視聴者の反応の遅れ。コメント時刻からこの分を引いて配信時刻に揃える。人が直す
  -- Viewer reaction lag, subtracted from comment times to align with the stream. Edited by hand
  chat_lag_sec REAL DEFAULT 5,
  chat_key TEXT,
  chat_count INTEGER,
  chat_fetched_at TEXT,
  chat_fetched_by TEXT,
  created_at TEXT
);

CREATE TABLE stamps (
  -- 'y' + 7 hex。拡張・パネルと同じ採番。乱数 28 bit なので配信をまたいで重なりうる → 主キーは (stream_id, id)
  -- 'y' + 7 hex, same scheme as the extension and panel. Only 28 random bits, so ids may repeat across streams → key is (stream_id, id)
  id TEXT,
  stream_id TEXT,
  offset_sec REAL,
  by TEXT,
  memo TEXT,
  native INTEGER,
  created_at TEXT,
  updated_at TEXT,
  deleted INTEGER DEFAULT 0,
  clock_skew_ms INTEGER,
  -- 'extension' / 'web' / 'panel'
  source TEXT,
  PRIMARY KEY (stream_id, id)
);

CREATE TABLE api_tokens (
  hash TEXT PRIMARY KEY,
  login TEXT,
  label TEXT,
  created_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  login TEXT,
  user_id TEXT,
  created_at TEXT,
  expires_at TEXT
);

CREATE TABLE token_cache (
  hash TEXT PRIMARY KEY,
  login TEXT,
  user_id TEXT,
  client_id TEXT,
  validated_at TEXT
);

CREATE INDEX stamps_stream_updated ON stamps (stream_id, updated_at);
CREATE INDEX streams_channel_started ON streams (channel, started_at);
CREATE INDEX sessions_expires ON sessions (expires_at);
CREATE INDEX members_login ON members (login);
