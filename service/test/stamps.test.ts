import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { nowIso, type StampRow, type StreamRow } from '../src/db';
import type { StampRecord } from '../src/stamps';
import { request, seedSession, seedStream, seedToken } from './helpers';

const CHANNEL = 'terano_naa';
const STARTED_AT = '2026-10-20T10:00:00Z';

type UpsertResult = { accepted: string[]; rejected: { id: string | null; reason: string }[] };

// terano_naa（owner yato、editor mod1）を何度呼んでも 1 つだけ作る
// Creates terano_naa (owner yato, editor mod1) once, however many times it is called
async function seedTerano(): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO channels (login, display_name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(CHANNEL, CHANNEL, 'yato', now),
    env.DB.prepare('INSERT OR IGNORE INTO members (channel, login, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').bind(CHANNEL, 'yato', 'owner', 'yato', now),
    env.DB.prepare('INSERT OR IGNORE INTO members (channel, login, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').bind(CHANNEL, 'mod1', 'editor', 'yato', now),
  ]);
}

// 13 列の正しい行。over で上書きする / A valid 13-column record, overridden by `over`
function rec(streamId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'y0000001',
    timecode: '',
    offset_sec: 10,
    by: 'mod1',
    memo: '',
    native: true,
    channel: CHANNEL,
    stream_id: streamId,
    started_at: STARTED_AT,
    created_at: '2026-10-20T10:05:00.000Z',
    updated_at: '2026-10-20T10:05:00.000Z',
    deleted: false,
    clock_skew_ms: 0,
    ...over,
  };
}

// cookie で認証した JSON 要求（変更系は X-Requested-With: yts 付き）
// A cookie-authenticated JSON request (mutating ones carry X-Requested-With: yts)
async function call(login: string, method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = await seedSession(login);
  const headers: Record<string, string> = { cookie };
  if (method !== 'GET') headers['x-requested-with'] = 'yts';
  if (body !== undefined) headers['content-type'] = 'application/json';
  return request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function post(login: string, records: unknown[], extra: Record<string, unknown> = {}): Promise<UpsertResult> {
  const res = await call(login, 'POST', '/api/stamps', { records, ...extra });
  expect(res.status).toBe(200);
  return (await res.json()) as UpsertResult;
}

async function stampRow(id: string): Promise<StampRow | null> {
  return env.DB.prepare('SELECT * FROM stamps WHERE id = ?').bind(id).first<StampRow>();
}

describe('POST /api/stamps', () => {
  it('two rows are accepted and the stream row is created from the records', async () => {
    await seedTerano();
    const result = await post('mod1', [rec('60001', { id: 'y6000101' }), rec('60001', { id: 'y6000102', offset_sec: 20.12345, memo: 'hi' })]);
    expect(result).toEqual({ accepted: ['y6000101', 'y6000102'], rejected: [] });
    const stream = await env.DB.prepare('SELECT * FROM streams WHERE stream_id = ?').bind('60001').first<StreamRow>();
    expect(stream).toMatchObject({ channel: CHANNEL, started_at: '2026-10-20T10:00:00.000Z' });
    expect(await stampRow('y6000102')).toMatchObject({ stream_id: '60001', offset_sec: 20.123, by: 'mod1', memo: 'hi', native: 1, deleted: 0, source: 'web' });
  });

  it('older or equal updated_at is stale; newer updated_at wins', async () => {
    await seedTerano();
    await post('mod1', [rec('60002', { id: 'y6000201', memo: 'first', updated_at: '2026-10-20T11:00:00.000Z' })]);
    const older = await post('mod1', [rec('60002', { id: 'y6000201', memo: 'older', updated_at: '2026-10-20T10:59:00.000Z' })]);
    expect(older).toEqual({ accepted: [], rejected: [{ id: 'y6000201', reason: 'stale' }] });
    const equal = await post('mod1', [rec('60002', { id: 'y6000201', memo: 'equal', updated_at: '2026-10-20T11:00:00Z' })]);
    expect(equal).toEqual({ accepted: [], rejected: [{ id: 'y6000201', reason: 'stale' }] });
    expect((await stampRow('y6000201'))?.memo).toBe('first');
    const newer = await post('mod1', [rec('60002', { id: 'y6000201', memo: 'newer', updated_at: '2026-10-20T11:01:00.000Z' })]);
    expect(newer).toEqual({ accepted: ['y6000201'], rejected: [] });
    expect(await stampRow('y6000201')).toMatchObject({ memo: 'newer', updated_at: '2026-10-20T11:01:00.000Z' });
  });

  it('repairs ids that lost leading zeros and rejects broken rows one by one', async () => {
    await seedTerano();
    const result = await post('mod1', [
      rec('60003', { id: '12ab' }),
      rec('60003', { id: 'zzz' }),
      rec('60003', { id: 'y6000302', offset_sec: 'x' }),
      rec('60003', { id: 'y6000303', offset_sec: -1 }),
      rec('60003', { id: 'y6000304', offset_sec: '12.3456' }),
      rec('60003', { id: 'y6000305', stream_id: '' }),
      rec('60003', { id: 'y6000306', by: '' }),
      'not an object',
      rec('60003', { id: 'y6000307' }),
    ]);
    expect(result.accepted).toEqual(['000012ab', 'y6000304', 'y6000307']);
    expect(result.rejected).toEqual([
      { id: 'zzz', reason: 'invalid_id' },
      { id: 'y6000302', reason: 'invalid_offset' },
      { id: 'y6000303', reason: 'invalid_offset' },
      { id: 'y6000305', reason: 'missing_stream' },
      { id: 'y6000306', reason: 'invalid_by' },
      { id: null, reason: 'invalid_record' },
    ]);
    expect(await stampRow('000012ab')).toMatchObject({ stream_id: '60003' });
    expect((await stampRow('y6000304'))?.offset_sec).toBe(12.346);
  });

  it('tombstones need the author or an owner', async () => {
    await seedTerano();
    await post('yato', [rec('60004', { id: 'y6000401', by: 'yato' })]);
    await post('mod1', [rec('60004', { id: 'y6000402', by: 'mod1' }), rec('60004', { id: 'y6000403', by: 'mod1' })]);
    const later = '2026-10-20T12:00:00.000Z';

    const byEditor = await post('mod1', [rec('60004', { id: 'y6000401', by: 'yato', deleted: true, updated_at: later })]);
    expect(byEditor.rejected).toEqual([{ id: 'y6000401', reason: 'forbidden_tombstone' }]);
    const byOwner = await post('yato', [rec('60004', { id: 'y6000402', by: 'mod1', deleted: true, updated_at: later })]);
    expect(byOwner.accepted).toEqual(['y6000402']);
    const ownRow = await post('mod1', [rec('60004', { id: 'y6000403', by: 'mod1', deleted: 'true', updated_at: later })]);
    expect(ownRow.accepted).toEqual(['y6000403']);
    expect((await stampRow('y6000401'))?.deleted).toBe(0);
    expect((await stampRow('y6000402'))?.deleted).toBe(1);
    expect((await stampRow('y6000403'))?.deleted).toBe(1);

    // 新規の墓標は自分の by だけ / A brand-new tombstone is allowed only for one's own `by`
    const newForeign = await post('mod1', [rec('60004', { id: 'y6000404', by: 'yato', deleted: true })]);
    expect(newForeign.rejected).toEqual([{ id: 'y6000404', reason: 'forbidden_tombstone' }]);
    expect(await stampRow('y6000404')).toBeNull();

    // by は作成時のまま。書き換えてから墓標にする抜け道は無い
    // `by` stays as created, so rewriting it before tombstoning is no way around the rule
    await post('mod1', [rec('60004', { id: 'y6000401', by: 'mod1', memo: 'edited', updated_at: later })]);
    expect(await stampRow('y6000401')).toMatchObject({ by: 'yato', memo: 'edited' });
    const bypass = await post('mod1', [rec('60004', { id: 'y6000401', by: 'mod1', deleted: true, updated_at: '2026-10-20T13:00:00.000Z' })]);
    expect(bypass.rejected).toEqual([{ id: 'y6000401', reason: 'forbidden_tombstone' }]);

    // by の大文字小文字は問わない（保存は送られたまま）/ `by` is compared case-insensitively (stored as sent)
    await post('mod1', [rec('60004', { id: 'y6000405', by: 'Mod1' })]);
    expect((await stampRow('y6000405'))?.by).toBe('Mod1');
    const mixedCase = await post('mod1', [rec('60004', { id: 'y6000405', by: 'Mod1', deleted: true, updated_at: later })]);
    expect(mixedCase.accepted).toEqual(['y6000405']);
  });

  it('rows of a non-member channel, or of a stream that belongs to another channel, are forbidden_channel', async () => {
    await seedTerano();
    await env.DB.prepare('INSERT OR IGNORE INTO channels (login, display_name, created_by, created_at) VALUES (?, ?, ?, ?)').bind('other_ch', 'other_ch', 'someone', nowIso()).run();
    await seedStream({ stream_id: '60005', channel: 'other_ch', title: 'theirs' });
    const result = await post('mod1', [
      rec('60006', { id: 'y6000501', channel: 'other_ch' }),
      rec('60007', { id: 'y6000502', channel: 'no_such_channel' }),
      rec('60005', { id: 'y6000503' }),
    ]);
    expect(result).toEqual({
      accepted: [],
      rejected: [
        { id: 'y6000501', reason: 'forbidden_channel' },
        { id: 'y6000502', reason: 'forbidden_channel' },
        { id: 'y6000503', reason: 'forbidden_channel' },
      ],
    });
    expect(await stampRow('y6000503')).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM streams WHERE stream_id IN (?, ?)').bind('60006', '60007').first()).toBeNull();
    expect((await env.DB.prepare('SELECT channel FROM streams WHERE stream_id = ?').bind('60005').first<{ channel: string }>())?.channel).toBe('other_ch');
  });

  it('the same id on two streams is accepted for both and listed under each', async () => {
    await seedTerano();
    await post('mod1', [rec('60008', { id: 'y6000801', memo: 'eight' })]);
    const other = await post('mod1', [rec('60009', { id: 'y6000801', memo: 'nine', updated_at: '2026-10-21T00:00:00.000Z' })]);
    expect(other).toEqual({ accepted: ['y6000801'], rejected: [] });
    for (const [streamId, memo] of [['60008', 'eight'], ['60009', 'nine']]) {
      const res = await call('mod1', 'GET', `/api/streams/${streamId}/stamps`);
      const { records } = (await res.json()) as { records: StampRecord[] };
      expect(records.map((r) => [r.id, r.stream_id, r.memo])).toEqual([['y6000801', streamId, memo]]);
    }
  });

  it('more than 500 records is 413 before any write; 3 records on one new stream are all accepted', async () => {
    await seedTerano();
    const many = Array.from({ length: 501 }, (_, i) => rec('60012', { id: 'y60120' + i.toString(16).padStart(2, '0').slice(-2) }));
    const res = await call('mod1', 'POST', '/api/stamps', { records: many });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_many_records', detail: 'max 500' });
    expect(await env.DB.prepare('SELECT 1 FROM streams WHERE stream_id = ?').bind('60012').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM stamps WHERE stream_id = ?').bind('60012').first()).toBeNull();

    const three = await post('mod1', [rec('60013', { id: 'y6001301' }), rec('60013', { id: 'y6001302' }), rec('60013', { id: 'y6001303' })]);
    expect(three).toEqual({ accepted: ['y6001301', 'y6001302', 'y6001303'], rejected: [] });
    expect((await env.DB.prepare('SELECT channel FROM streams WHERE stream_id = ?').bind('60013').first<{ channel: string }>())?.channel).toBe(CHANNEL);
  });

  it('created_at / updated_at far in the future or before 2000 is invalid_time', async () => {
    await seedTerano();
    const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
    const result = await post('mod1', [
      rec('60014', { id: 'y6001401', updated_at: ahead(24 * 3600 * 1000) }),
      rec('60014', { id: 'y6001402', created_at: ahead(24 * 3600 * 1000), updated_at: '' }),
      rec('60014', { id: 'y6001403', updated_at: '1999-12-31T23:59:59.000Z' }),
      rec('60014', { id: 'y6001404', updated_at: ahead(60 * 1000) }),
    ]);
    expect(result).toEqual({
      accepted: ['y6001404'],
      rejected: [
        { id: 'y6001401', reason: 'invalid_time' },
        { id: 'y6001402', reason: 'invalid_time' },
        { id: 'y6001403', reason: 'invalid_time' },
      ],
    });
  });

  it('the same id twice in one request keeps the newer one', async () => {
    await seedTerano();
    const result = await post('mod1', [
      rec('60010', { id: 'y6001001', memo: 'a', updated_at: '2026-10-20T10:05:00.000Z' }),
      rec('60010', { id: 'y6001001', memo: 'b', updated_at: '2026-10-20T10:06:00.000Z' }),
      rec('60010', { id: 'y6001001', memo: 'c', updated_at: '2026-10-20T10:04:00.000Z' }),
    ]);
    expect(result).toEqual({ accepted: ['y6001001', 'y6001001'], rejected: [{ id: 'y6001001', reason: 'stale' }] });
    expect((await stampRow('y6001001'))?.memo).toBe('b');
  });

  it('source follows the body or the kind of credential; a bad body or source is 400', async () => {
    await seedTerano();
    const token = await seedToken('mod1');
    const viaToken = await request('/api/stamps', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ records: [rec('60011', { id: 'y6001101' })] }),
    });
    expect(viaToken.status).toBe(200);
    expect((await stampRow('y6001101'))?.source).toBe('panel');
    await post('mod1', [rec('60011', { id: 'y6001102' })], { source: 'extension' });
    expect((await stampRow('y6001102'))?.source).toBe('extension');

    for (const body of [{ records: 'x' }, { nope: [] }, [], { records: [], source: 'evil' }]) {
      const res = await call('mod1', 'POST', '/api/stamps', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    const empty = await post('mod1', []);
    expect(empty).toEqual({ accepted: [], rejected: [] });
  });

  it('cookie POST without X-Requested-With is 403 csrf; no credential is 401', async () => {
    const cookie = await seedSession('mod1');
    const csrf = await request('/api/stamps', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ records: [] }) });
    expect(csrf.status).toBe(403);
    const anon = await request('/api/stamps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: [] }) });
    expect(anon.status).toBe(401);
  });
});

describe('GET /api/streams/:id/stamps', () => {
  it('returns 13-column records with tombstones, ordered by offset_sec, filtered by since', async () => {
    await seedTerano();
    await post('mod1', [
      rec('60020', { id: 'y6002001', offset_sec: 30, updated_at: '2026-10-20T10:01:00.000Z' }),
      rec('60020', { id: 'y6002002', offset_sec: 3725.9, native: false, clock_skew_ms: -120, updated_at: '2026-10-20T10:03:00.000Z' }),
      rec('60020', { id: 'y6002003', offset_sec: 5, deleted: true, updated_at: '2026-10-20T10:02:00.000Z' }),
    ]);
    const res = await call('yato', 'GET', '/api/streams/60020/stamps');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stream: StreamRow; records: StampRecord[] };
    expect(body.stream).toMatchObject({ stream_id: '60020', channel: CHANNEL });
    expect(body.records.map((r) => r.id)).toEqual(['y6002003', 'y6002001', 'y6002002']);
    expect(body.records[2]).toEqual({
      id: 'y6002002',
      timecode: '01:02:05',
      offset_sec: 3725.9,
      by: 'mod1',
      memo: '',
      native: false,
      channel: CHANNEL,
      stream_id: '60020',
      started_at: '2026-10-20T10:00:00.000Z',
      created_at: '2026-10-20T10:05:00.000Z',
      updated_at: '2026-10-20T10:03:00.000Z',
      deleted: false,
      clock_skew_ms: -120,
    });
    expect(body.records[0].deleted).toBe(true);

    const since = await call('mod1', 'GET', '/api/streams/60020/stamps?since=' + encodeURIComponent('2026-10-20T10:01:30Z'));
    const filtered = (await since.json()) as { records: StampRecord[] };
    expect(filtered.records.map((r) => r.id)).toEqual(['y6002003', 'y6002002']);
  });

  it('unknown stream is 404, non member is 403, bad since is 400', async () => {
    await seedTerano();
    await post('mod1', [rec('60021', { id: 'y6002101' })]);
    const missing = await call('mod1', 'GET', '/api/streams/69999/stamps');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    expect((await call('stranger', 'GET', '/api/streams/60021/stamps')).status).toBe(403);
    const bad = await call('mod1', 'GET', '/api/streams/60021/stamps?since=yesterday');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_request' });
  });
});
