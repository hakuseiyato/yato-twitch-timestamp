import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { nowIso, type StreamRow } from '../src/db';
import { ensureStream } from '../src/streams';
import { request, seedChannel, seedMember, seedSession, seedStream, seedToken } from './helpers';

type StreamWithCount = StreamRow & { stamp_count: number };

// cookie で認証した JSON 要求（変更系は X-Requested-With: yts 付き）
// A cookie-authenticated JSON request (mutating ones carry X-Requested-With: yts)
async function call(login: string, method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = await seedSession(login);
  const headers: Record<string, string> = { cookie };
  if (method !== 'GET') headers['x-requested-with'] = 'yts';
  if (body !== undefined) headers['content-type'] = 'application/json';
  return request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function insertStamp(id: string, streamId: string, deleted: number): Promise<void> {
  const now = nowIso();
  await env.DB.prepare('INSERT INTO stamps (id, stream_id, offset_sec, by, memo, native, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, streamId, 10, 'someone', '', 1, now, now, deleted)
    .run();
}

describe('streams', () => {
  it('registered stream appears in the list with stamp_count 0', async () => {
    await seedChannel('st_a', 'owner_sa');
    const res = await call('owner_sa', 'POST', '/api/streams', {
      stream_id: '1001',
      channel: 'st_a',
      started_at: '2026-10-01T10:00:00Z',
      title: 'first',
      vod_id: '5001',
    });
    expect(res.status).toBe(200);
    const { stream } = (await res.json()) as { stream: StreamRow };
    expect(stream).toMatchObject({
      stream_id: '1001',
      channel: 'st_a',
      started_at: '2026-10-01T10:00:00.000Z',
      title: 'first',
      vod_id: '5001',
      vod_offset_sec: 0,
      chat_lag_sec: 5,
    });

    const list = await call('owner_sa', 'GET', '/api/channels/st_a/streams');
    expect(list.status).toBe(200);
    const { streams } = (await list.json()) as { streams: StreamWithCount[] };
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ stream_id: '1001', stamp_count: 0 });
  });

  it('second registration updates vod_id only (empty title keeps the old one)', async () => {
    await seedChannel('st_b', 'owner_sb');
    await call('owner_sb', 'POST', '/api/streams', { stream_id: 'vod-2002', channel: 'st_b', started_at: '2026-10-02T10:00:00Z', title: 'keep me' });
    const res = await call('owner_sb', 'POST', '/api/streams', {
      stream_id: 'vod-2002',
      channel: 'st_b',
      started_at: '2026-10-09T00:00:00Z',
      title: '',
      vod_id: '6002',
    });
    expect(res.status).toBe(200);
    const { stream } = (await res.json()) as { stream: StreamRow };
    expect(stream).toMatchObject({ stream_id: 'vod-2002', title: 'keep me', vod_id: '6002', started_at: '2026-10-02T10:00:00.000Z' });
  });

  it('non member gets 403 on register, list, get and patch', async () => {
    await seedChannel('st_c', 'owner_sc');
    await seedStream({ stream_id: '3003', channel: 'st_c' });
    const post = await call('stranger_c', 'POST', '/api/streams', { stream_id: '3004', channel: 'st_c', started_at: '2026-10-03T10:00:00Z' });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: 'forbidden' });
    expect((await call('stranger_c', 'GET', '/api/channels/st_c/streams')).status).toBe(403);
    expect((await call('stranger_c', 'GET', '/api/streams/3003')).status).toBe(403);
    expect((await call('stranger_c', 'PATCH', '/api/streams/3003', { title: 'x' })).status).toBe(403);
  });

  it('re-registering a stream of another channel checks membership of that channel', async () => {
    await seedChannel('st_d', 'owner_sd');
    await seedChannel('st_d2', 'owner_sd2');
    await seedStream({ stream_id: '4004', channel: 'st_d2', title: 'theirs' });
    const res = await call('owner_sd', 'POST', '/api/streams', { stream_id: '4004', channel: 'st_d', started_at: '2026-10-04T10:00:00Z', title: 'mine' });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare('SELECT title FROM streams WHERE stream_id = ?').bind('4004').first<{ title: string }>();
    expect(row?.title).toBe('theirs');
  });

  it('bad stream_id, channel, started_at or vod_id is 400', async () => {
    await seedChannel('st_e', 'owner_se');
    const base = { stream_id: '5005', channel: 'st_e', started_at: '2026-10-05T10:00:00Z' };
    for (const patch of [{ stream_id: 'abc' }, { channel: 'bad-name' }, { started_at: 'not a date' }, { vod_id: 'v123' }, { title: 5 }]) {
      const res = await call('owner_se', 'POST', '/api/streams', { ...base, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
  });

  it('list is started_at DESC and stamp_count skips tombstones', async () => {
    await seedChannel('st_f', 'owner_sf');
    await seedMember('st_f', 'ed_sf', 'editor');
    await seedStream({ stream_id: '6001', channel: 'st_f', started_at: '2026-10-01T00:00:00.000Z' });
    await seedStream({ stream_id: '6002', channel: 'st_f', started_at: '2026-10-03T00:00:00.000Z' });
    await seedStream({ stream_id: '6003', channel: 'st_f', started_at: '2026-10-02T00:00:00.000Z' });
    await insertStamp('y6000001', '6002', 0);
    await insertStamp('y6000002', '6002', 0);
    await insertStamp('y6000003', '6002', 1);
    const res = await call('ed_sf', 'GET', '/api/channels/st_f/streams');
    const { streams } = (await res.json()) as { streams: StreamWithCount[] };
    expect(streams.map((s) => [s.stream_id, s.stamp_count])).toEqual([
      ['6002', 2],
      ['6003', 0],
      ['6001', 0],
    ]);
  });

  it('GET /api/streams/:id returns the stream; unknown id is 404', async () => {
    await seedChannel('st_g', 'owner_sg');
    await seedStream({ stream_id: '7007', channel: 'st_g', title: 'g' });
    const res = await call('owner_sg', 'GET', '/api/streams/7007');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stream: StreamRow }).stream).toMatchObject({ stream_id: '7007', title: 'g' });
    const missing = await call('owner_sg', 'GET', '/api/streams/7999');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('PATCH saves chat_lag_sec 12 and rejects 99999 with 400', async () => {
    await seedChannel('st_h', 'owner_sh');
    await seedStream({ stream_id: '8008', channel: 'st_h', vod_id: '9008' });
    const ok = await call('owner_sh', 'PATCH', '/api/streams/8008', { chat_lag_sec: 12, vod_offset_sec: -1.5, title: 'renamed', vod_id: null, unknown: 1 });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { stream: StreamRow }).stream).toMatchObject({ chat_lag_sec: 12, vod_offset_sec: -1.5, title: 'renamed', vod_id: null });

    const bad = await call('owner_sh', 'PATCH', '/api/streams/8008', { chat_lag_sec: 99999 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_request' });
    for (const body of [{ vod_offset_sec: '3' }, { vod_id: 'abc' }, { title: 1 }]) {
      expect((await call('owner_sh', 'PATCH', '/api/streams/8008', body)).status, JSON.stringify(body)).toBe(400);
    }
    const row = await env.DB.prepare('SELECT chat_lag_sec FROM streams WHERE stream_id = ?').bind('8008').first<{ chat_lag_sec: number }>();
    expect(row?.chat_lag_sec).toBe(12);
  });

  it('Bearer ytt_ works and cookie POST without X-Requested-With is 403 csrf', async () => {
    await seedChannel('st_i', 'owner_si');
    const token = await seedToken('owner_si');
    const res = await request('/api/streams', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ stream_id: '9009', channel: 'st_i', started_at: '2026-10-09T10:00:00Z' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stream: StreamRow }).stream.title).toBe('');

    const cookie = await seedSession('owner_si');
    const csrf = await request('/api/streams/9009', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toEqual({ error: 'csrf' });
  });

  it('ensureStream inserts once, never overwrites and returns the channel of the existing row', async () => {
    const first = await ensureStream(env, { stream_id: '9100', channel: 'st_j', started_at: '2026-10-10T00:00:00Z', title: 'one' });
    expect(first).toEqual({ channel: 'st_j', created: true });
    const second = await ensureStream(env, { stream_id: '9100', channel: 'other', started_at: '2026-10-11T00:00:00.000Z', title: 'two' });
    expect(second).toEqual({ channel: 'st_j', created: false });
    const row = await env.DB.prepare('SELECT * FROM streams WHERE stream_id = ?').bind('9100').first<StreamRow>();
    expect(row).toMatchObject({ channel: 'st_j', started_at: '2026-10-10T00:00:00.000Z', title: 'one', chat_lag_sec: 5 });
  });

  it('PATCH accepts the night request/done/status fields', async () => {
    await seedChannel('st_n', 'owner_sn');
    await seedStream({ stream_id: '7001', channel: 'st_n', started_at: '2026-10-30T06:00:00Z' });
    const res = await call('owner_sn', 'PATCH', '/api/streams/7001', {
      night_requested_at: '2026-10-30T13:00:00Z', night_status: '処理中: VOD 保存', night_done_at: null,
    });
    expect(res.status).toBe(200);
    const { stream } = (await res.json()) as { stream: StreamRow };
    expect(stream).toMatchObject({ night_requested_at: '2026-10-30T13:00:00Z', night_status: '処理中: VOD 保存', night_done_at: null });
    const list = await call('owner_sn', 'GET', '/api/channels/st_n/streams');
    expect(((await list.json()) as { streams: StreamRow[] }).streams[0].night_status).toBe('処理中: VOD 保存');
  });

  it('PATCH rejects malformed night fields', async () => {
    await seedChannel('st_m', 'owner_sm');
    await seedStream({ stream_id: '7002', channel: 'st_m', started_at: '2026-10-30T06:00:00Z' });
    for (const body of [{ night_requested_at: 'yesterday' }, { night_status: 'x'.repeat(201) }, { night_done_at: 12 }]) {
      expect((await call('owner_sm', 'PATCH', '/api/streams/7002', body)).status).toBe(400);
    }
  });
});
