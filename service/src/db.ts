// D1 の行型（列名は migrations の SQL と同じ snake_case）と日時の共通処理
// D1 row types (column names match the snake_case of the migration SQL) and the shared clock

export interface ChannelRow {
  login: string;
  display_name: string | null;
  created_by: string;
  created_at: string;
}

export interface MemberRow {
  channel: string;
  login: string;
  // 'owner' / 'member' など / e.g. 'owner' / 'member'
  role: string;
  added_by: string | null;
  added_at: string;
}

export interface StreamRow {
  stream_id: string;
  channel: string;
  started_at: string;
  title: string | null;
  vod_id: string | null;
  vod_offset_sec: number;
  chat_lag_sec: number;
  chat_key: string | null;
  chat_count: number | null;
  chat_fetched_at: string | null;
  chat_fetched_by: string | null;
  created_at: string;
}

export interface StampRow {
  id: string;
  stream_id: string;
  offset_sec: number;
  by: string;
  memo: string | null;
  // 0 / 1
  native: number;
  created_at: string;
  updated_at: string;
  // 0 / 1（1 は墓標）/ 0 / 1 (1 is a tombstone)
  deleted: number;
  clock_skew_ms: number | null;
  // 'extension' / 'web' / 'panel'
  source: string | null;
}

export interface ApiTokenRow {
  // 平文 ytt_ トークンの SHA-256 hex / SHA-256 hex of the plain ytt_ token
  hash: string;
  login: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface SessionRow {
  // 64 桁 hex（cookie yts_ の値）/ 64 hex digits (the value of the yts_ cookie)
  id: string;
  login: string;
  user_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface TokenCacheRow {
  // Twitch トークンの SHA-256 hex / SHA-256 hex of the Twitch token
  hash: string;
  login: string;
  user_id: string;
  client_id: string;
  validated_at: string;
}

// ISO 8601 UTC の現在時刻 / Current time as ISO 8601 UTC
export function nowIso(): string {
  return new Date().toISOString();
}
