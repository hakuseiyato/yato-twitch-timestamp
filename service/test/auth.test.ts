import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/auth';
import { request, seedSession, seedToken } from './helpers';

const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

// Twitch の validate を固定応答にする（Worker はテストと同じ isolate で動くので global fetch の差し替えが効く）
// Stubs Twitch validate (the Worker shares the test isolate, so replacing global fetch reaches it)
function mockValidate(status: number, body: unknown = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== VALIDATE_URL) throw new Error('unexpected fetch / 想定外の fetch: ' + url);
    return Response.json(body, { status });
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { client_id: env.TWITCH_CLIENT_ID, login: 'yato', user_id: '1', scopes: [], expires_in: 3600, ...overrides };
}

function postSession(token: string, headers: Record<string, string> = { 'x-requested-with': 'yts' }): Promise<Response> {
  return request('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ token }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth', () => {
  it('GET /api/me without auth is 401', async () => {
    const res = await request('/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('POST /api/auth/session creates a session cookie', async () => {
    mockValidate(200, validBody());
    const res = await postSession('toksession01');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('yts_=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(((await res.json()) as { login: string }).login).toBe('yato');

    // 発行された cookie で /api/me が通る / The issued cookie authenticates /api/me
    const me = await request('/api/me', { headers: { cookie: cookie.split(';')[0] } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ login: 'yato', via: 'session', channels: [], site_admin: true });
  });

  it('session with foreign client_id is 401 client_mismatch', async () => {
    mockValidate(200, validBody({ client_id: 'someone-else' }));
    const res = await postSession('tokforeign01');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'client_mismatch' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('validate 503 yields 503 twitch_unavailable and no token_cache row', async () => {
    mockValidate(503);
    const res = await postSession('tok503unavailable');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'twitch_unavailable' });
    const row = await env.DB.prepare('SELECT hash FROM token_cache WHERE hash = ?').bind(await sha256Hex('tok503unavailable')).first();
    expect(row).toBeNull();
  });

  it('session POST without X-Requested-With is 403 csrf', async () => {
    const spy = mockValidate(200, validBody());
    const res = await postSession('toknoheader01', {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'csrf' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('session POST with a malformed or ytt_ token is 400 before any fetch', async () => {
    const spy = mockValidate(200, validBody());
    for (const token of ['ytt_' + 'a'.repeat(32), 'short', 'has-dash-123', 'a'.repeat(201)]) {
      const res = await postSession(token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('validate 429 is 503 twitch_unavailable and no token_cache row', async () => {
    mockValidate(429);
    const res = await request('/api/me', { headers: { authorization: 'Bearer tokratelimited01' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'twitch_unavailable' });
    const row = await env.DB.prepare('SELECT hash FROM token_cache WHERE hash = ?').bind(await sha256Hex('tokratelimited01')).first();
    expect(row).toBeNull();
  });

  it('validate fetch failure is 503 twitch_unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const res = await request('/api/me', { headers: { authorization: 'Bearer toktimeout0001' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'twitch_unavailable' });
  });

  it('expired session is 401 and clears cookie', async () => {
    const cookie = await seedSession('yato');
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind('2000-01-01T00:00:00.000Z', cookie.slice('yts_='.length))
      .run();
    const res = await request('/api/me', { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('Bearer twitch token is cached for an hour', async () => {
    const spy = mockValidate(200, validBody());
    const headers = { authorization: 'Bearer tokcached01' };
    const first = await request('/api/me', { headers });
    const second = await request('/api/me', { headers });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { via: string }).via).toBe('twitch');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Bearer twitch token of another app is 401', async () => {
    mockValidate(200, validBody({ client_id: 'someone-else' }));
    const res = await request('/api/me', { headers: { authorization: 'Bearer tokotherapp01' } });
    expect(res.status).toBe(401);
  });

  it('ytt_ token works and revoked one is 401', async () => {
    const token = await seedToken('yato');
    const headers = { authorization: 'Bearer ' + token };
    const me = await request('/api/me', { headers });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { via: string }).via).toBe('token');

    // 失効は Web ページ（session）から / Revocation goes through the web page (session)
    const cookie = await seedSession('yato');
    const prefix = (await sha256Hex(token)).slice(0, 8);
    const revoke = await request('/api/tokens/' + prefix, { method: 'DELETE', headers: { cookie, 'x-requested-with': 'yts' } });
    expect(revoke.status).toBe(200);
    const after = await request('/api/me', { headers });
    expect(after.status).toBe(401);
  });

  it('ytt_ Bearer cannot issue or revoke tokens (403 session_required)', async () => {
    const token = await seedToken('yato');
    const headers = { authorization: 'Bearer ' + token };
    const issue = await request('/api/tokens', { method: 'POST', headers, body: JSON.stringify({ label: 'x' }) });
    expect(issue.status).toBe(403);
    expect(await issue.json()).toEqual({ error: 'session_required' });
    const prefix = (await sha256Hex(token)).slice(0, 8);
    const revoke = await request('/api/tokens/' + prefix, { method: 'DELETE', headers });
    expect(revoke.status).toBe(403);
    expect(await revoke.json()).toEqual({ error: 'session_required' });
  });

  it('ytt_ last_used_at is written at most once an hour', async () => {
    const token = await seedToken('yato');
    const hash = await sha256Hex(token);
    const headers = { authorization: 'Bearer ' + token };
    const lastUsed = async () =>
      (await env.DB.prepare('SELECT last_used_at FROM api_tokens WHERE hash = ?').bind(hash).first<{ last_used_at: string | null }>())?.last_used_at;
    const setLastUsed = (value: string) => env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE hash = ?').bind(value, hash).run();

    // null なら書く / Written when null
    expect((await request('/api/me', { headers })).status).toBe(200);
    expect(await lastUsed()).not.toBeNull();

    // 1 時間以内なら書かない / Not written within the hour
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    await setLastUsed(recent);
    expect((await request('/api/me', { headers })).status).toBe(200);
    expect(await lastUsed()).toBe(recent);

    // 1 時間より古ければ書く / Written when older than an hour
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await setLastUsed(old);
    expect((await request('/api/me', { headers })).status).toBe(200);
    expect(await lastUsed()).not.toBe(old);
  });

  it('cookie POST without X-Requested-With is 403 csrf', async () => {
    const cookie = await seedSession('yato');
    const init = { method: 'POST', body: JSON.stringify({ label: 'panel' }) };
    const res = await request('/api/tokens', { ...init, headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'csrf' });

    // ヘッダ付きなら発行でき、一覧に出る / With the header it is issued and listed
    const ok = await request('/api/tokens', { ...init, headers: { cookie, 'x-requested-with': 'yts' } });
    expect(ok.status).toBe(200);
    const issued = (await ok.json()) as { token: string; label: string };
    expect(issued.token).toMatch(/^ytt_[0-9a-f]{32}$/);
    expect(issued.label).toBe('panel');
    const list = (await (await request('/api/tokens', { headers: { cookie } })).json()) as { prefix: string; label: string }[];
    expect(list).toContainEqual(expect.objectContaining({ prefix: (await sha256Hex(issued.token)).slice(0, 8), label: 'panel' }));
  });

  it('GET /api/config returns twitch_client_id', async () => {
    const res = await request('/api/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ twitch_client_id: env.TWITCH_CLIENT_ID });
  });
});
