// 配信の登録・一覧・取得・更新 / Registering, listing, reading and updating streams
import TSLib from '../../panel/js/lib.js';
import { requireMember } from './access';
import { requireAuth, requireCsrf } from './auth';
import { nowIso, type StreamRow } from './db';
import { error, json, readJson } from './http';
import type { Router } from './router';

// Twitch の stream_id、または VOD から作った仮の ID / A Twitch stream_id, or a provisional ID made from a VOD
const STREAM_ID_PATTERN = /^(?:[0-9]{1,30}|vod-[0-9]{1,30})$/;
const VOD_ID_PATTERN = /^[0-9]{1,30}$/;
const TITLE_MAX = 500;
// vod_offset_sec / chat_lag_sec の許容範囲（秒）/ Allowed range of vod_offset_sec / chat_lag_sec (seconds)
const OFFSET_LIMIT_SEC = 3600;

// 無ければ INSERT、あれば何もしない（Task 6 のスタンプ受信でも使う）
// Inserts when missing, does nothing when present (also used when stamps arrive in Task 6)
export async function ensureStream(
  env: Env,
  stream: { stream_id: string; channel: string; started_at: string; title?: string },
): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO streams (stream_id, channel, started_at, title, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(stream.stream_id, stream.channel, stream.started_at, stream.title ?? '', nowIso())
    .run();
}

function isTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TITLE_MAX;
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= OFFSET_LIMIT_SEC;
}

// 配信行を引く。無ければ 404 を throw（会員の確認は呼び出し側）/ Loads a stream row. Throws 404 when missing (callers check membership)
async function loadStream(env: Env, id: string): Promise<StreamRow> {
  const row = await env.DB.prepare('SELECT * FROM streams WHERE stream_id = ?').bind(id).first<StreamRow>();
  if (!row) throw error(404, 'not_found');
  return row;
}

export function registerStreamRoutes(router: Router): void {
  // VOD から配信を登録。既にあれば vod_id（指定時）と title（空でないとき）だけ更新する
  // Registers a stream from a VOD. When it exists, only vod_id (when given) and title (when non-empty) are updated
  router.add('POST', '/api/streams', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    const body = await readJson<Record<string, unknown> | null>(ctx.request, 4096);
    const streamId = body?.stream_id;
    const channel = TSLib.validLogin(body?.channel);
    const startedAt = body?.started_at;
    const title = body?.title ?? '';
    const vodId = body?.vod_id ?? null;
    if (
      typeof streamId !== 'string' ||
      !STREAM_ID_PATTERN.test(streamId) ||
      !channel ||
      typeof startedAt !== 'string' ||
      Number.isNaN(Date.parse(startedAt)) ||
      !isTitle(title) ||
      (vodId !== null && (typeof vodId !== 'string' || !VOD_ID_PATTERN.test(vodId)))
    ) {
      return error(400, 'bad_request');
    }
    // 既存の行は、その行のチャンネルの会員かで判定する（本文の channel で他人の配信を書き換えさせない）
    // An existing row is checked against its own channel (so the body's channel cannot reach another channel's stream)
    const existing = await ctx.env.DB.prepare('SELECT channel FROM streams WHERE stream_id = ?').bind(streamId).first<{ channel: string }>();
    const checkedChannel = existing?.channel ?? channel;
    await requireMember(ctx, principal, checkedChannel);
    if (!existing) {
      await ensureStream(ctx.env, { stream_id: streamId, channel, started_at: new Date(startedAt).toISOString(), title });
    }
    // channel も条件に入れ、確認と書き込みの間に別チャンネルの行が入っても触らない
    // channel is in the condition too, so a row of another channel inserted in between is left alone
    const stream = await ctx.env.DB.prepare(
      "UPDATE streams SET vod_id = COALESCE(?3, vod_id), title = CASE WHEN ?4 <> '' THEN ?4 ELSE title END " +
        'WHERE stream_id = ?1 AND channel = ?2 RETURNING *',
    )
      .bind(streamId, checkedChannel, vodId, title)
      .first<StreamRow>();
    if (!stream) return error(403, 'forbidden');
    return json(200, { stream });
  });

  // 配信一覧（新しい順）。stamp_count は墓標を除いた件数 / Stream list (newest first). stamp_count excludes tombstones
  router.add('GET', '/api/channels/:login/streams', async (ctx) => {
    const principal = await requireAuth(ctx);
    await requireMember(ctx, principal, ctx.params.login);
    const { results } = await ctx.env.DB.prepare(
      'SELECT s.*, (SELECT COUNT(*) FROM stamps t WHERE t.stream_id = s.stream_id AND t.deleted = 0) AS stamp_count ' +
        'FROM streams s WHERE s.channel = ? ORDER BY s.started_at DESC',
    )
      .bind(ctx.params.login)
      .all<StreamRow & { stamp_count: number }>();
    return json(200, { streams: results });
  });

  router.add('GET', '/api/streams/:id', async (ctx) => {
    const principal = await requireAuth(ctx);
    const stream = await loadStream(ctx.env, ctx.params.id);
    await requireMember(ctx, principal, stream.channel);
    return json(200, { stream });
  });

  // vod_id（null で消す）/ vod_offset_sec / chat_lag_sec / title を更新。知らないキーは無視
  // Updates vod_id (null clears it) / vod_offset_sec / chat_lag_sec / title. Unknown keys are ignored
  router.add('PATCH', '/api/streams/:id', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    const current = await loadStream(ctx.env, ctx.params.id);
    await requireMember(ctx, principal, current.channel);
    const body = await readJson<Record<string, unknown> | null>(ctx.request, 4096);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return error(400, 'bad_request');
    const sets: string[] = [];
    const values: unknown[] = [];
    if ('vod_id' in body) {
      const vodId = body.vod_id;
      if (vodId !== null && (typeof vodId !== 'string' || !VOD_ID_PATTERN.test(vodId))) return error(400, 'bad_request');
      sets.push('vod_id = ?');
      values.push(vodId);
    }
    for (const key of ['vod_offset_sec', 'chat_lag_sec'] as const) {
      if (!(key in body)) continue;
      if (!isOffset(body[key])) return error(400, 'bad_request');
      sets.push(`${key} = ?`);
      values.push(body[key]);
    }
    if ('title' in body) {
      if (!isTitle(body.title)) return error(400, 'bad_request');
      sets.push('title = ?');
      values.push(body.title);
    }
    if (sets.length === 0) return json(200, { stream: current });
    const stream = await ctx.env.DB.prepare(`UPDATE streams SET ${sets.join(', ')} WHERE stream_id = ? RETURNING *`)
      .bind(...values, current.stream_id)
      .first<StreamRow>();
    return json(200, { stream });
  });
}
