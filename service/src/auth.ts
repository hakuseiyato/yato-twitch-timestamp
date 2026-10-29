// 認証: session cookie（yts_）/ Bearer ytt_ / Bearer Twitch トークンと、その経路
// Authentication: session cookie (yts_) / Bearer ytt_ / Bearer Twitch token, and their routes
import { nowIso, type ApiTokenRow, type SessionRow, type TokenCacheRow } from './db';
import { error, json, readJson } from './http';
import type { HandlerContext, Router } from './router';

export type Principal = { login: string; userId: string | null; via: 'session' | 'twitch' | 'token' };

// Twitch の validate が 5xx / 通信失敗。index.ts で 503 twitch_unavailable になる
// Twitch validate returned 5xx or the request failed. index.ts turns it into 503 twitch_unavailable
export class TwitchUnavailable extends Error {}

const SESSION_COOKIE = 'yts_';
const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;
const TOKEN_CACHE_TTL_MS = 3600 * 1000;
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';
const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteLength: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at >= 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function readBearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return match ? match[1] : null;
}

// Twitch トークンを検証する。結果は SHA-256 をキーに 1 時間キャッシュ（トークン自体は保存しない）
// 4xx は null、5xx と通信失敗は TwitchUnavailable を throw（その場合キャッシュは書かない）
// Validates a Twitch token, cached for an hour keyed by its SHA-256 (the token itself is never stored)
// 4xx gives null; 5xx and network failures throw TwitchUnavailable (and never write the cache)
export async function validateTwitchToken(
  token: string,
  env: Env,
): Promise<{ login: string; userId: string; clientId: string } | null> {
  const hash = await sha256Hex(token);
  const cached = await env.DB.prepare('SELECT * FROM token_cache WHERE hash = ?').bind(hash).first<TokenCacheRow>();
  if (cached && Date.now() - Date.parse(cached.validated_at) < TOKEN_CACHE_TTL_MS) {
    return { login: cached.login, userId: cached.user_id, clientId: cached.client_id };
  }
  let res: Response;
  try {
    res = await fetch(VALIDATE_URL, { headers: { Authorization: 'OAuth ' + token } });
  } catch (cause) {
    throw new TwitchUnavailable('validate の通信に失敗 / validate request failed', { cause });
  }
  if (res.status >= 500) throw new TwitchUnavailable(`validate ${res.status}`);
  if (res.status !== 200) {
    await env.DB.prepare('DELETE FROM token_cache WHERE hash = ?').bind(hash).run();
    return null;
  }
  const body = (await res.json()) as { login?: unknown; user_id?: unknown; client_id?: unknown };
  if (typeof body.login !== 'string' || typeof body.user_id !== 'string' || typeof body.client_id !== 'string') {
    throw new TwitchUnavailable('validate の応答が想定外 / validate returned an unexpected body');
  }
  await env.DB.prepare('INSERT OR REPLACE INTO token_cache (hash, login, user_id, client_id, validated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, body.login, body.user_id, body.client_id, nowIso())
    .run();
  return { login: body.login, userId: body.user_id, clientId: body.client_id };
}

// 期限内の session を引く。期限切れの行は消す / Looks up a live session. Expired rows are deleted
async function sessionPrincipal(id: string, env: Env): Promise<Principal | null> {
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<SessionRow>();
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return { login: row.login, userId: row.user_id, via: 'session' };
}

async function apiTokenPrincipal(token: string, env: Env): Promise<Principal | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT * FROM api_tokens WHERE hash = ? AND revoked_at IS NULL').bind(hash).first<ApiTokenRow>();
  if (!row) return null;
  await env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE hash = ?').bind(nowIso(), hash).run();
  return { login: row.login, userId: null, via: 'token' };
}

// cookie yts_ → Bearer ytt_… → Bearer <Twitch> の順に認証する。他アプリの Twitch トークンは通さない
// Authenticates by cookie yts_, then Bearer ytt_…, then Bearer <Twitch>. Twitch tokens of other apps are rejected
export async function resolvePrincipal(request: Request, env: Env): Promise<Principal | null> {
  const sessionId = readCookie(request, SESSION_COOKIE);
  if (sessionId) {
    const principal = await sessionPrincipal(sessionId, env);
    if (principal) return principal;
  }
  const bearer = readBearer(request);
  if (!bearer) return null;
  if (bearer.startsWith('ytt_')) return apiTokenPrincipal(bearer, env);
  const validated = await validateTwitchToken(bearer, env);
  if (!validated || validated.clientId !== env.TWITCH_CLIENT_ID) return null;
  return { login: validated.login, userId: validated.userId, via: 'twitch' };
}

// 認証必須。無ければ 401 を throw し、無効な cookie が付いていれば消す
// Requires authentication. Throws 401, clearing the cookie when an invalid one was sent
export async function requireAuth(ctx: HandlerContext): Promise<Principal> {
  const principal = await resolvePrincipal(ctx.request, ctx.env);
  if (principal) return principal;
  const res = error(401, 'unauthorized');
  if (readCookie(ctx.request, SESSION_COOKIE) !== null) res.headers.append('Set-Cookie', CLEAR_SESSION_COOKIE);
  throw res;
}

// cookie で認証した変更系の要求は X-Requested-With: yts が必須（Bearer は対象外）
// Cookie-authenticated mutating requests must carry X-Requested-With: yts (Bearer is exempt)
export function requireCsrf(ctx: HandlerContext, principal: Principal): void {
  if (principal.via !== 'session') return;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.request.method)) return;
  if (ctx.request.headers.get('x-requested-with') !== 'yts') throw error(403, 'csrf');
}

// Web ページ（session）からだけ許す操作。漏れた ytt_ で新しいトークンを作らせない
// Operations allowed only from the web page (session), so a leaked ytt_ cannot mint more tokens
function requireSession(principal: Principal): void {
  if (principal.via !== 'session') throw error(403, 'session_required');
}

export function registerAuthRoutes(router: Router): void {
  // 認証不要。Web ページが implicit grant の URL を組むのに使う / No auth. The web page builds the implicit grant URL with it
  router.add('GET', '/api/config', async ({ env }) => json(200, { twitch_client_id: env.TWITCH_CLIENT_ID }));

  // Twitch トークンを検証して session cookie を発行（session がまだ無いので CSRF 対象外）
  // Validates a Twitch token and issues the session cookie (exempt from CSRF: no session yet)
  router.add('POST', '/api/auth/session', async ({ request, env }) => {
    const body = await readJson<{ token?: unknown } | null>(request, 4096);
    if (typeof body?.token !== 'string' || body.token === '') return error(400, 'token_required');
    const validated = await validateTwitchToken(body.token, env);
    if (!validated) return error(401, 'unauthorized');
    if (validated.clientId !== env.TWITCH_CLIENT_ID) return error(401, 'client_mismatch');
    const id = randomHex(32);
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_MAX_AGE_SEC * 1000);
    await env.DB.prepare('INSERT INTO sessions (id, login, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, validated.login, validated.userId, now.toISOString(), expires.toISOString())
      .run();
    const res = json(200, { login: validated.login });
    res.headers.append('Set-Cookie', `${SESSION_COOKIE}=${id}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE_SEC}`);
    return res;
  });

  router.add('POST', '/api/auth/logout', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    const sessionId = readCookie(ctx.request, SESSION_COOKIE);
    if (principal.via === 'session' && sessionId) {
      await ctx.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    }
    const res = json(200, { ok: true });
    res.headers.append('Set-Cookie', CLEAR_SESSION_COOKIE);
    return res;
  });

  router.add('GET', '/api/me', async (ctx) => {
    const principal = await requireAuth(ctx);
    const { results } = await ctx.env.DB.prepare('SELECT channel, role FROM members WHERE login = ? ORDER BY channel')
      .bind(principal.login)
      .all<{ channel: string; role: string }>();
    return json(200, {
      login: principal.login,
      via: principal.via,
      channels: results.map((row) => ({ login: row.channel, role: row.role })),
      // ponytail: Task 4 で isSiteAdmin に置き換える / Replaced by isSiteAdmin in Task 4
      site_admin: !!ctx.env.BOOTSTRAP_LOGIN && ctx.env.BOOTSTRAP_LOGIN === principal.login,
    });
  });

  // パネル用 ytt_ トークンを発行。平文は応答で 1 度だけ返し、D1 には hash だけ置く
  // Issues a ytt_ token for the panel. The plain text is returned once; D1 keeps only the hash
  router.add('POST', '/api/tokens', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireSession(principal);
    requireCsrf(ctx, principal);
    const body = await readJson<{ label?: unknown } | null>(ctx.request, 4096);
    const label = body?.label ?? null;
    if (label !== null && (typeof label !== 'string' || label.length > 100)) return error(400, 'invalid_label');
    const token = 'ytt_' + randomHex(16);
    await ctx.env.DB.prepare('INSERT INTO api_tokens (hash, login, label, created_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), principal.login, label, nowIso())
      .run();
    return json(200, { token, label });
  });

  router.add('GET', '/api/tokens', async (ctx) => {
    const principal = await requireAuth(ctx);
    const { results } = await ctx.env.DB.prepare(
      'SELECT * FROM api_tokens WHERE login = ? AND revoked_at IS NULL ORDER BY created_at DESC',
    )
      .bind(principal.login)
      .all<ApiTokenRow>();
    return json(
      200,
      results.map((row) => ({ prefix: row.hash.slice(0, 8), label: row.label, created_at: row.created_at, last_used_at: row.last_used_at })),
    );
  });

  // hash の先頭 8 桁で自分のトークンを失効させる / Revokes one of the caller's tokens by the first 8 hex of its hash
  router.add('DELETE', '/api/tokens/:prefix', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireSession(principal);
    requireCsrf(ctx, principal);
    const prefix = ctx.params.prefix;
    // hex に限り LIKE の % と _ を入れさせない / Hex only, so LIKE wildcards cannot get in
    if (!/^[0-9a-f]{8}$/.test(prefix)) return error(400, 'invalid_prefix');
    const result = await ctx.env.DB.prepare(
      "UPDATE api_tokens SET revoked_at = ? WHERE login = ? AND hash LIKE ? || '%' AND revoked_at IS NULL",
    )
      .bind(nowIso(), principal.login, prefix)
      .run();
    if (result.meta.changes === 0) return error(404, 'not_found');
    return json(200, { ok: true });
  });
}
