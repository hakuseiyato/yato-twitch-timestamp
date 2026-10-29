import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { request, seedChannel, seedMember, seedSession } from './helpers';

// テストでは BOOTSTRAP_LOGIN = 'yato'（vitest.config.ts）/ In tests BOOTSTRAP_LOGIN = 'yato' (vitest.config.ts)
const SITE_ADMIN = 'yato';

// cookie で認証した JSON 要求（変更系は X-Requested-With: yts 付き）
// A cookie-authenticated JSON request (mutating ones carry X-Requested-With: yts)
async function call(login: string, method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = await seedSession(login);
  const headers: Record<string, string> = { cookie };
  if (method !== 'GET') headers['x-requested-with'] = 'yts';
  if (body !== undefined) headers['content-type'] = 'application/json';
  return request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('channels and members', () => {
  it('site admin can create a channel and becomes its owner', async () => {
    const res = await call(SITE_ADMIN, 'POST', '/api/channels', { login: 'Chan_A', display_name: 'Chan A' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { login: string; display_name: string; created_by: string } };
    expect(body.channel).toMatchObject({ login: 'chan_a', display_name: 'Chan A', created_by: SITE_ADMIN });
    const member = await env.DB.prepare('SELECT role FROM members WHERE channel = ? AND login = ?').bind('chan_a', SITE_ADMIN).first<{ role: string }>();
    expect(member?.role).toBe('owner');

    // 同じチャンネルの 2 回目は 409 / Creating the same channel again is 409
    const again = await call(SITE_ADMIN, 'POST', '/api/channels', { login: 'chan_a' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'exists' });
  });

  it('channel login bad-name is 400', async () => {
    const res = await call(SITE_ADMIN, 'POST', '/api/channels', { login: 'bad-name', display_name: 'x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });

  it('non site admin cannot create a channel (403)', async () => {
    await seedChannel('chan_b', 'owner_b');
    const res = await call('owner_b', 'POST', '/api/channels', { login: 'chan_b2' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('owner can add an editor; editor cannot add members (403)', async () => {
    await seedChannel('chan_c', 'owner_c');
    const add = await call('owner_c', 'POST', '/api/channels/chan_c/members', { login: 'Editor_C', role: 'editor' });
    expect(add.status).toBe(200);
    expect(((await add.json()) as { member: { login: string; role: string } }).member).toMatchObject({ login: 'editor_c', role: 'editor' });

    const list = await call('owner_c', 'GET', '/api/channels/chan_c/members');
    expect(list.status).toBe(200);
    const members = ((await list.json()) as { members: { login: string; role: string; added_by: string | null }[] }).members;
    expect(members.map((m) => [m.login, m.role])).toEqual([
      ['editor_c', 'editor'],
      ['owner_c', 'owner'],
    ]);
    expect(members[0].added_by).toBe('owner_c');

    const byEditor = await call('editor_c', 'POST', '/api/channels/chan_c/members', { login: 'someone', role: 'editor' });
    expect(byEditor.status).toBe(403);
    expect(await byEditor.json()).toEqual({ error: 'forbidden' });
  });

  it('adding an existing member updates the role; bad role or login is 400', async () => {
    await seedChannel('chan_d', 'owner_d');
    await seedMember('chan_d', 'ed_d', 'editor');
    const promote = await call('owner_d', 'POST', '/api/channels/chan_d/members', { login: 'ed_d', role: 'owner' });
    expect(promote.status).toBe(200);
    const row = await env.DB.prepare('SELECT role FROM members WHERE channel = ? AND login = ?').bind('chan_d', 'ed_d').first<{ role: string }>();
    expect(row?.role).toBe('owner');

    expect((await call('owner_d', 'POST', '/api/channels/chan_d/members', { login: 'x_d', role: 'viewer' })).status).toBe(400);
    expect((await call('owner_d', 'POST', '/api/channels/chan_d/members', { login: 'bad-name', role: 'editor' })).status).toBe(400);
  });

  it('editor gets 403 on the member list', async () => {
    await seedChannel('chan_e', 'owner_e');
    await seedMember('chan_e', 'ed_e', 'editor');
    const res = await call('ed_e', 'GET', '/api/channels/chan_e/members');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('non member gets 403 on the member list, also for an unknown channel', async () => {
    await seedChannel('chan_f', 'owner_f');
    expect((await call('stranger', 'GET', '/api/channels/chan_f/members')).status).toBe(403);
    expect((await call('stranger', 'GET', '/api/channels/no_such_chan/members')).status).toBe(403);
    // site admin でも存在しないチャンネルは 403 / Even the site admin gets 403 for an unknown channel
    expect((await call(SITE_ADMIN, 'GET', '/api/channels/no_such_chan/members')).status).toBe(403);
  });

  it('the last owner cannot be removed or demoted (400 last_owner)', async () => {
    await seedChannel('chan_g', 'owner_g');
    await seedMember('chan_g', 'ed_g', 'editor');
    const del = await call('owner_g', 'DELETE', '/api/channels/chan_g/members/owner_g');
    expect(del.status).toBe(400);
    expect(await del.json()).toEqual({ error: 'last_owner' });
    const demote = await call('owner_g', 'POST', '/api/channels/chan_g/members', { login: 'owner_g', role: 'editor' });
    expect(demote.status).toBe(400);
    expect(await demote.json()).toEqual({ error: 'last_owner' });

    // editor は消せる、居ない人は 404 / An editor can be removed; a missing member is 404
    const ok = await call('owner_g', 'DELETE', '/api/channels/chan_g/members/ed_g');
    expect(ok.status).toBe(200);
    const missing = await call('owner_g', 'DELETE', '/api/channels/chan_g/members/ed_g');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('an owner can be removed while another owner remains', async () => {
    await seedChannel('chan_h', 'owner_h');
    await seedMember('chan_h', 'owner_h2', 'owner');
    const res = await call('owner_h', 'DELETE', '/api/channels/chan_h/members/owner_h');
    expect(res.status).toBe(200);
    const left = await env.DB.prepare('SELECT login FROM members WHERE channel = ?').bind('chan_h').all<{ login: string }>();
    expect(left.results.map((r) => r.login)).toEqual(['owner_h2']);
  });

  it('GET /api/channels lists own channels; site admin sees all', async () => {
    await seedChannel('chan_i', 'owner_i');
    await seedChannel('chan_j', 'owner_j');
    await seedMember('chan_j', 'owner_i', 'editor');
    const mine = await call('owner_i', 'GET', '/api/channels');
    expect(mine.status).toBe(200);
    const channels = ((await mine.json()) as { channels: { login: string; role: string }[] }).channels;
    expect(channels.map((c) => [c.login, c.role])).toEqual([
      ['chan_i', 'owner'],
      ['chan_j', 'editor'],
    ]);

    const nobody = await call('nobody_i', 'GET', '/api/channels');
    expect(((await nobody.json()) as { channels: unknown[] }).channels).toEqual([]);

    const admin = await call(SITE_ADMIN, 'GET', '/api/channels');
    const all = ((await admin.json()) as { channels: { login: string; role: string }[] }).channels;
    expect(all.map((c) => c.login)).toEqual(expect.arrayContaining(['chan_i', 'chan_j']));
    expect(all.every((c) => c.role === 'owner')).toBe(true);
  });

  it('member routes require auth (401) and CSRF header for cookies (403 csrf)', async () => {
    expect((await request('/api/channels')).status).toBe(401);
    await seedChannel('chan_k', 'owner_k');
    const cookie = await seedSession('owner_k');
    const res = await request('/api/channels/chan_k/members', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'x_k', role: 'editor' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'csrf' });
  });
});
