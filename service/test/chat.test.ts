import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { chatKey } from '../src/chat';
import type { StreamRow } from '../src/db';
import { request, seedChannel, seedSession, seedStream } from './helpers';

// 約 2 KB のチャット JSON / About 2 KB of chat JSON
function chatJson(): string {
  const comments = Array.from({ length: 60 }, (_, i) => [i * 3, 'user' + i, 'User' + i, 'こんにちは / hello ' + i]);
  return JSON.stringify({ vod_id: '777001', length_sec: 3095, fetched_at: '2026-10-29T00:00:00.000Z', client: 'web/1.0', comments });
}

async function put(login: string, path: string, body: BodyInit | null, headers: Record<string, string> = {}): Promise<Response> {
  const cookie = await seedSession(login);
  return request(path, { method: 'PUT', headers: { cookie, 'x-requested-with': 'yts', 'content-type': 'application/json', ...headers }, body });
}

async function get(login: string, path: string): Promise<Response> {
  return request(path, { headers: { cookie: await seedSession(login) } });
}

async function chatObjects(channel: string): Promise<string[]> {
  return (await env.CHAT.list({ prefix: `chat/${channel}/` })).objects.map((o) => o.key);
}

describe('chat', () => {
  it('chatKey is chat/<channel>/<vodId>.json', () => {
    expect(chatKey('terano_naa', '123')).toBe('chat/terano_naa/123.json');
  });

  it('PUT stores the JSON in R2 and updates the stream; GET returns the same bytes', async () => {
    await seedChannel('ch_a', 'owner_ca');
    await seedStream({ stream_id: '70001', channel: 'ch_a' });
    const body = chatJson();
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2048);
    const res = await put('owner_ca', '/api/streams/70001/chat?vod_id=777001&count=60&length_sec=3095', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chat_key: 'chat/ch_a/777001.json', chat_count: 60 });
    expect(await chatObjects('ch_a')).toEqual(['chat/ch_a/777001.json']);
    const stream = await env.DB.prepare('SELECT * FROM streams WHERE stream_id = ?').bind('70001').first<StreamRow>();
    expect(stream).toMatchObject({ vod_id: '777001', chat_key: 'chat/ch_a/777001.json', chat_count: 60, chat_fetched_by: 'owner_ca' });
    expect(Number.isNaN(Date.parse(stream?.chat_fetched_at ?? ''))).toBe(false);

    const got = await get('owner_ca', '/api/streams/70001/chat');
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/json');
    expect(got.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(await got.text()).toBe(body);
  });

  it('PUT with Content-Type text/plain is 415 and writes nothing', async () => {
    await seedChannel('ch_b', 'owner_cb');
    await seedStream({ stream_id: '70002', channel: 'ch_b' });
    const res = await put('owner_cb', '/api/streams/70002/chat?vod_id=777002&count=1', chatJson(), { 'content-type': 'text/plain' });
    expect(res.status).toBe(415);
    expect(await chatObjects('ch_b')).toEqual([]);
  });

  it('PUT declaring 51 MB is 413 without sending the body', async () => {
    await seedChannel('ch_c', 'owner_cc');
    await seedStream({ stream_id: '70003', channel: 'ch_c' });
    const res = await put('owner_cc', '/api/streams/70003/chat?vod_id=777003&count=1', null, { 'content-length': String(51 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(await chatObjects('ch_c')).toEqual([]);
  });

  it('PUT without Content-Length is 411', async () => {
    await seedChannel('ch_d', 'owner_cd');
    await seedStream({ stream_id: '70004', channel: 'ch_d' });
    // ReadableStream の本文には長さが付かない / A ReadableStream body carries no length
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    const res = await put('owner_cd', '/api/streams/70004/chat?vod_id=777004&count=0', stream);
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ error: 'length_required' });
    expect(await chatObjects('ch_d')).toEqual([]);
  });

  it('PUT with Content-Length 0 is 400 empty_body and writes nothing', async () => {
    await seedChannel('ch_h', 'owner_ch');
    await seedStream({ stream_id: '70008', channel: 'ch_h' });
    const res = await put('owner_ch', '/api/streams/70008/chat?vod_id=777008&count=0', '', { 'content-length': '0' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'empty_body' });
    expect(await chatObjects('ch_h')).toEqual([]);
    const stream = await env.DB.prepare('SELECT * FROM streams WHERE stream_id = ?').bind('70008').first<StreamRow>();
    expect(stream?.chat_key).toBeNull();
  });

  it('bad vod_id, count or length_sec is 400; unknown stream is 404', async () => {
    await seedChannel('ch_e', 'owner_ce');
    await seedStream({ stream_id: '70005', channel: 'ch_e' });
    for (const query of ['vod_id=v1&count=1', 'count=1', 'vod_id=1&count=-1', 'vod_id=1&count=1.5', 'vod_id=1&count=x', 'vod_id=1&count=1&length_sec=-3']) {
      const res = await put('owner_ce', '/api/streams/70005/chat?' + query, '{}');
      expect(res.status, query).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    expect((await put('owner_ce', '/api/streams/79999/chat?vod_id=1&count=1', '{}')).status).toBe(404);
    expect(await chatObjects('ch_e')).toEqual([]);
  });

  it('non member gets 403 on PUT and GET; GET before any upload is 404 no_chat', async () => {
    await seedChannel('ch_f', 'owner_cf');
    await seedStream({ stream_id: '70006', channel: 'ch_f' });
    expect((await put('stranger_f', '/api/streams/70006/chat?vod_id=1&count=1', '{}')).status).toBe(403);
    expect((await get('stranger_f', '/api/streams/70006/chat')).status).toBe(403);
    const none = await get('owner_cf', '/api/streams/70006/chat');
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'no_chat' });
  });

  it('cookie PUT without X-Requested-With is 403 csrf; no credential is 401', async () => {
    await seedChannel('ch_g', 'owner_cg');
    await seedStream({ stream_id: '70007', channel: 'ch_g' });
    const cookie = await seedSession('owner_cg');
    const csrf = await request('/api/streams/70007/chat?vod_id=1&count=1', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(csrf.status).toBe(403);
    expect((await request('/api/streams/70007/chat')).status).toBe(401);
  });
});
