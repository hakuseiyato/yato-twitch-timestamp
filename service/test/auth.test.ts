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

function postSession(token: string): Promise<Response> {
  return request('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    const res = await postSession('tok-session');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('yts_=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(((await res.json()) as { login: string }).login).toBe('yato');

    // 発行された cookie で /api/me が通る / The issued cookie authenticates /api/me
    const me = await request('/api/me', { headers: { cookie: cookie.split(';')[0] } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ login: 'yato', via: 'session', channels: [], site_admin: false });
  });

  it('session with foreign client_id is 401 client_mismatch', async () => {
    mockValidate(200, validBody({ client_id: 'someone-else' }));
    const res = await postSession('tok-foreign');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'client_mismatch' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('validate 503 yields 503 twitch_unavailable and no token_cache row', async () => {
    mockValidate(503);
    const res = await postSession('tok-503');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'twitch_unavailable' });
    const row = await env.DB.prepare('SELECT hash FROM token_cache WHERE hash = ?').bind(await sha256Hex('tok-503')).first();
    expect(row).toBeNull();
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
    const headers = { authorization: 'Bearer tok-cached' };
    const first = await request('/api/me', { headers });
    const second = await request('/api/me', { headers });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { via: string }).via).toBe('twitch');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Bearer twitch token of another app is 401', async () => {
    mockValidate(200, validBody({ client_id: 'someone-else' }));
    const res = await request('/api/me', { headers: { authorization: 'Bearer tok-other-app' } });
    expect(res.status).toBe(401);
  });

  it('ytt_ token works and revoked one is 401', async () => {
    const token = await seedToken('yato');
    const headers = { authorization: 'Bearer ' + token };
    const me = await request('/api/me', { headers });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { via: string }).via).toBe('token');

    const prefix = (await sha256Hex(token)).slice(0, 8);
    const revoke = await request('/api/tokens/' + prefix, { method: 'DELETE', headers });
    expect(revoke.status).toBe(200);
    const after = await request('/api/me', { headers });
    expect(after.status).toBe(401);
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
