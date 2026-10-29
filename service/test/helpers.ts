// テストの共通処理 / Shared test helpers
import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { nowIso, type StreamRow } from '../src/db';

// 未適用の migration だけを D1 に流す（何度呼んでもよい）
// Applies only the migrations not yet applied (safe to call repeatedly)
export async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

// Worker の fetch を相対パスで呼ぶ / Calls the Worker's fetch with a relative path
export function request(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request('https://example.com' + path, init));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

// チャンネルと owner の会員行を作る / Creates a channel and its owner's member row
export async function seedChannel(login: string, ownerLogin: string): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO channels (login, display_name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(login, login, ownerLogin, now),
    env.DB.prepare('INSERT INTO members (channel, login, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').bind(login, ownerLogin, 'owner', ownerLogin, now),
  ]);
}

export async function seedMember(channel: string, login: string, role: string): Promise<void> {
  await env.DB.prepare('INSERT INTO members (channel, login, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)')
    .bind(channel, login, role, null, nowIso())
    .run();
}

// 30 日有効の session を作り、cookie 文字列 `yts_=<id>` を返す
// Creates a session valid for 30 days and returns the cookie string `yts_=<id>`
export async function seedSession(login: string): Promise<string> {
  const id = randomHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  await env.DB.prepare('INSERT INTO sessions (id, login, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, login, null, now.toISOString(), expires.toISOString())
    .run();
  return `yts_=${id}`;
}

// 足りない列を既定値で埋めて配信行を作る / Creates a stream row, filling missing columns with defaults
export async function seedStream(partial: Partial<StreamRow>): Promise<StreamRow> {
  const now = nowIso();
  const row: StreamRow = {
    stream_id: 's' + randomHex(4),
    channel: 'yato',
    started_at: now,
    title: null,
    vod_id: null,
    vod_offset_sec: 0,
    chat_lag_sec: 5,
    chat_key: null,
    chat_count: null,
    chat_fetched_at: null,
    chat_fetched_by: null,
    created_at: now,
    ...partial,
  };
  const columns = Object.keys(row) as (keyof StreamRow)[];
  await env.DB.prepare(`INSERT INTO streams (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .bind(...columns.map((column) => row[column]))
    .run();
  return row;
}

// ytt_ トークンを作り、hash だけ保存して平文を返す / Creates a ytt_ token, stores only its hash and returns the plain text
export async function seedToken(login: string): Promise<string> {
  const token = 'ytt_' + randomHex(16);
  await env.DB.prepare('INSERT INTO api_tokens (hash, login, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), login, 'test', nowIso())
    .run();
  return token;
}
