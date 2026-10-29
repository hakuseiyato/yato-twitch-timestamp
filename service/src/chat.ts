// チャット JSON の保存（R2 へストリームで流す・Worker はパースしない）と配信
// Storing chat JSON (streamed to R2; the Worker never parses it) and serving it back
import { requireMember } from './access';
import { requireAuth, requireCsrf } from './auth';
import { nowIso } from './db';
import { error, json } from './http';
import type { Router } from './router';
import { loadStream, VOD_ID_PATTERN } from './streams';

// 50 MB（3 時間の配信で約 3 MB の見込み）/ 50 MB (a 3-hour stream is expected to be about 3 MB)
const CHAT_MAX_BYTES = 52_428_800;
const NON_NEGATIVE_INT = /^[0-9]{1,15}$/;

export function chatKey(channel: string, vodId: string): string {
  return `chat/${channel}/${vodId}.json`;
}

// 省略は null、あれば 0 以上の整数。不正なら undefined / Absent gives null, otherwise a non-negative integer. Invalid gives undefined
function optionalCount(value: string | null): number | null | undefined {
  if (value === null) return null;
  return NON_NEGATIVE_INT.test(value) ? Number(value) : undefined;
}

export function registerChatRoutes(router: Router): void {
  // ?vod_id=&count=&length_sec=。本文は読まずにそのまま R2 へ / The body goes to R2 as-is, unread
  router.add('PUT', '/api/streams/:id/chat', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    const stream = await loadStream(ctx.env, ctx.params.id);
    await requireMember(ctx, principal, stream.channel);

    const params = ctx.url.searchParams;
    const vodId = params.get('vod_id');
    if (vodId === null || !VOD_ID_PATTERN.test(vodId)) return error(400, 'bad_request');
    if (!(ctx.request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return error(415, 'unsupported_media_type');
    }
    const length = ctx.request.headers.get('content-length');
    if (length === null) return error(411, 'length_required');
    if (!NON_NEGATIVE_INT.test(length)) return error(400, 'bad_request');
    if (Number(length) > CHAT_MAX_BYTES) return error(413, 'payload_too_large');
    const count = optionalCount(params.get('count'));
    // length_sec は検査だけ（保存する列は無い）/ length_sec is validated only (there is no column for it)
    const lengthSec = optionalCount(params.get('length_sec'));
    if (count === undefined || lengthSec === undefined) return error(400, 'bad_request');

    const key = chatKey(stream.channel, vodId);
    await ctx.env.CHAT.put(key, ctx.request.body, { httpMetadata: { contentType: 'application/json' } });
    await ctx.env.DB.prepare(
      'UPDATE streams SET vod_id = ?, chat_key = ?, chat_count = ?, chat_fetched_at = ?, chat_fetched_by = ? WHERE stream_id = ?',
    )
      .bind(vodId, key, count, nowIso(), principal.login, stream.stream_id)
      .run();
    return json(200, { chat_key: key, chat_count: count });
  });

  // R2 の本文をそのまま返す。未取込なら 404 no_chat / Returns the R2 body as-is. 404 no_chat when not uploaded yet
  router.add('GET', '/api/streams/:id/chat', async (ctx) => {
    const principal = await requireAuth(ctx);
    const stream = await loadStream(ctx.env, ctx.params.id);
    await requireMember(ctx, principal, stream.channel);
    if (!stream.chat_key) return error(404, 'no_chat');
    const object = await ctx.env.CHAT.get(stream.chat_key);
    if (!object) return error(404, 'no_chat');
    return new Response(object.body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=3600' },
    });
  });
}
