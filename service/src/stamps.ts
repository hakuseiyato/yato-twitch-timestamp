// スタンプの upsert（updated_at が新しい方が勝つ・墓標の権限）と一覧
// Upserting stamps (newer updated_at wins, tombstone permissions) and listing them
import TSLib from '../../panel/js/lib.js';
import { memberRole, requireMember, type Role } from './access';
import { requireAuth, requireCsrf, type Principal } from './auth';
import { nowIso, type StampRow, type StreamRow } from './db';
import { error, json, readJson } from './http';
import type { Router } from './router';
import { ensureStream, loadStream, STREAM_ID_PATTERN } from './streams';

export type StampSource = 'extension' | 'web' | 'panel';

// 同期 CSV と同じ 13 列 / The same 13 columns as the sync CSV
export interface StampRecord {
  id: string;
  timecode: string;
  offset_sec: number;
  by: string;
  memo: string;
  native: boolean;
  channel: string;
  stream_id: string;
  started_at: string;
  created_at: string;
  updated_at: string;
  deleted: boolean;
  clock_skew_ms: number;
}

type Rejected = { id: string | null; reason: string };
type Incoming = Omit<StampRecord, 'timecode'>;
// 判定に要る既存行の列 / Columns of an existing row needed for the checks
type Existing = Pick<StampRow, 'by' | 'updated_at'>;

const SOURCES: readonly StampSource[] = ['extension', 'web', 'panel'];
// 1 要求の上限（D1 の呼び出し回数と CPU 10 ms を守る）/ Per-request cap (keeps D1 calls and the 10 ms CPU budget in bounds)
export const MAX_RECORDS = 500;
// D1 の 1 文あたりの bind 上限は 100（stream_id の 1 個を引いた分）/ D1 allows 100 bound parameters per statement (minus one for stream_id)
const ID_CHUNK = 99;
// 受け付ける日時の範囲: 2000 年以降、サーバー時刻 + 5 分まで（未来の updated_at で行が固まるのを防ぐ）
// Accepted time range: from 2000 up to server time + 5 minutes (a future updated_at would freeze the row)
const TIME_MIN_MS = Date.parse('2000-01-01T00:00:00Z');
const TIME_SKEW_MS = 5 * 60 * 1000;

// 主キー (stream_id, id) を 1 つの文字列にする（stream_id に / は入らない）/ Joins the (stream_id, id) primary key into one string (stream_id never contains /)
function stampKey(streamId: string, id: string): string {
  return streamId + '/' + id;
}

// D1 の行（0/1 の整数）を 13 列の形（boolean・number）にする。channel / started_at は配信行から
// Turns a D1 row (0/1 integers) into the 13-column shape (booleans, numbers). channel / started_at come from the stream row
export function rowToRecord(row: StampRow, stream: Pick<StreamRow, 'channel' | 'started_at'>): StampRecord {
  return {
    id: row.id,
    timecode: TSLib.formatTimecode(Math.floor(row.offset_sec)),
    offset_sec: row.offset_sec,
    by: row.by,
    memo: row.memo ?? '',
    native: row.native === 1,
    channel: stream.channel,
    stream_id: row.stream_id,
    started_at: stream.started_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted: row.deleted === 1,
    clock_skew_ms: row.clock_skew_ms ?? 0,
  };
}

// true / 'true' / 1 / '1' を真、false / 'false' / 0 / '0' / 空を偽。それ以外は null
// true / 'true' / 1 / '1' are true; false / 'false' / 0 / '0' / empty are false. Anything else is null
function toBool(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === undefined || value === null || value === '') return false;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
}

// 日時を ISO に揃える。空なら fallback、読めなければ null（比較と since の文字列比較を揃えるため）
// Normalizes a date to ISO. Empty gives the fallback, unreadable gives null (so comparisons and the `since` string compare agree)
function toIso(value: unknown, fallback: string | null): string | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// 受信した 1 行を検査して整える / Validates and normalizes one received record
function parseRecord(raw: unknown): Incoming | Rejected {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { id: null, reason: 'invalid_record' };
  const r = raw as Record<string, unknown>;
  const rawId = typeof r.id === 'string' ? r.id : typeof r.id === 'number' ? String(r.id) : null;
  const reject = (reason: string): Rejected => ({ id: rawId, reason });

  // Excel で先頭のゼロが落ちた ID は repairId で戻す / IDs that lost leading zeros in Excel are restored by repairId
  const id = TSLib.repairId(rawId);
  if (!id) return reject('invalid_id');
  const offsetText = typeof r.offset_sec === 'string' ? r.offset_sec.trim() : r.offset_sec;
  const offset = typeof offsetText === 'number' || (typeof offsetText === 'string' && offsetText !== '') ? Number(offsetText) : NaN;
  if (!Number.isFinite(offset) || offset < 0) return reject('invalid_offset');
  if (typeof r.stream_id !== 'string' || r.stream_id === '') return reject('missing_stream');
  if (typeof r.by !== 'string' || r.by.trim() === '') return reject('invalid_by');

  const memo = r.memo === undefined || r.memo === null ? '' : r.memo;
  const native = toBool(r.native);
  const deleted = toBool(r.deleted);
  const skew = r.clock_skew_ms === undefined || r.clock_skew_ms === null || r.clock_skew_ms === '' ? 0 : Number(r.clock_skew_ms);
  const startedAt = toIso(r.started_at, null);
  const createdAt = toIso(r.created_at, nowIso());
  // updated_at が無ければ created_at（TSLib.normalizeRecord と同じ補完）
  // A missing updated_at falls back to created_at (the same fill as TSLib.normalizeRecord)
  const updatedAt = createdAt === null ? null : toIso(r.updated_at, createdAt);
  if (
    !STREAM_ID_PATTERN.test(r.stream_id) ||
    typeof memo !== 'string' ||
    native === null ||
    deleted === null ||
    !Number.isFinite(skew) ||
    startedAt === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return reject('invalid_record');
  }
  const latest = Date.now() + TIME_SKEW_MS;
  if ([createdAt, updatedAt].some((iso) => Date.parse(iso) < TIME_MIN_MS || Date.parse(iso) > latest)) return reject('invalid_time');
  return {
    id,
    offset_sec: TSLib.round3(offset),
    by: r.by,
    memo,
    native,
    // 会員でないチャンネルと同じ扱い（形の悪い名前の会員はいない）/ Treated like a non-member channel (nobody is a member of a malformed name)
    channel: TSLib.validLogin(r.channel) ?? '',
    stream_id: r.stream_id,
    started_at: startedAt,
    created_at: createdAt,
    updated_at: updatedAt,
    deleted,
    clock_skew_ms: Math.round(skew),
  };
}

// 既存行を 1 往復で引く（配信ごとに id を束ねる）/ Loads the existing rows in one round trip (ids grouped per stream)
async function loadExisting(env: Env, records: Incoming[]): Promise<Map<string, Existing>> {
  const found = new Map<string, Existing>();
  const idsByStream = new Map<string, Set<string>>();
  for (const r of records) idsByStream.set(r.stream_id, (idsByStream.get(r.stream_id) ?? new Set()).add(r.id));
  const statements: D1PreparedStatement[] = [];
  for (const [streamId, idSet] of idsByStream) {
    const ids = [...idSet];
    for (let at = 0; at < ids.length; at += ID_CHUNK) {
      const chunk = ids.slice(at, at + ID_CHUNK);
      statements.push(
        env.DB.prepare(`SELECT stream_id, id, by, updated_at FROM stamps WHERE stream_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`).bind(
          streamId,
          ...chunk,
        ),
      );
    }
  }
  if (statements.length === 0) return found;
  for (const result of await env.DB.batch<Existing & { stream_id: string; id: string }>(statements)) {
    for (const row of result.results) found.set(stampKey(row.stream_id, row.id), { by: row.by, updated_at: row.updated_at });
  }
  return found;
}

// by と created_at は作成時のまま（書き換えてから墓標にする抜け道を塞ぐ）。WHERE は同時送信で古い行が勝たないための保険
// `by` and created_at stay as created (closing the rewrite-then-tombstone loophole). The WHERE guards against an older row winning a race
const UPSERT_SQL =
  'INSERT INTO stamps (id, stream_id, offset_sec, by, memo, native, created_at, updated_at, deleted, clock_skew_ms, source) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(stream_id, id) DO UPDATE SET offset_sec = excluded.offset_sec, memo = excluded.memo, native = excluded.native, ' +
  'updated_at = excluded.updated_at, deleted = excluded.deleted, clock_skew_ms = excluded.clock_skew_ms, source = excluded.source ' +
  'WHERE excluded.updated_at > stamps.updated_at';

// 1 行ずつ判定し、受理分を 1 回の batch で書く / Judges each record and writes the accepted ones in a single batch
export async function upsertStamps(
  env: Env,
  p: Principal,
  records: unknown[],
  source: StampSource,
): Promise<{ accepted: string[]; rejected: Rejected[] }> {
  const parsed = records.map(parseRecord);
  const valid = parsed.filter((r): r is Incoming => !('reason' in r));
  // 会員の確認はチャンネルごと、配信行の用意は配信ごとに 1 回だけ（先にまとめて済ませる）
  // Membership once per channel and the stream row once per stream (all done up front)
  const channels = [...new Set(valid.map((r) => r.channel).filter((c) => c !== ''))];
  const roles = new Map<string, Role | null>(
    await Promise.all(channels.map(async (c) => [c, await memberRole(env, c, p.login)] as const)),
  );
  // 配信ごとに、会員であるチャンネルを名乗る最初の行で作る / Each stream is created from its first record naming a member channel
  const streamSeeds = new Map<string, Incoming>();
  for (const r of valid) if (roles.get(r.channel) && !streamSeeds.has(r.stream_id)) streamSeeds.set(r.stream_id, r);
  // stream_id → 実在する行の channel / stream_id → channel of the row that exists
  const streamChannels = new Map<string, string>(
    await Promise.all(
      [...streamSeeds.values()].map(
        async (r) => [r.stream_id, (await ensureStream(env, { stream_id: r.stream_id, channel: r.channel, started_at: r.started_at })).channel] as const,
      ),
    ),
  );
  const existing = await loadExisting(
    env,
    valid.filter((r) => streamChannels.get(r.stream_id) === r.channel),
  );
  const rejected: Rejected[] = [];
  const accepted: { id: string; statement: D1PreparedStatement }[] = [];

  for (const record of parsed) {
    if ('reason' in record) {
      rejected.push(record);
      continue;
    }
    const reject = (reason: string) => rejected.push({ id: record.id, reason });
    const role = roles.get(record.channel);
    // 会員でないチャンネルの配信行は作らず、配信の有無も明かさない。既存の配信行はその行のチャンネルで判定する
    // No stream row for a non-member channel, and its existence is not revealed. An existing stream row is judged by its own channel
    if (!role || streamChannels.get(record.stream_id) !== record.channel) {
      reject('forbidden_channel');
      continue;
    }
    const key = stampKey(record.stream_id, record.id);
    const prev = existing.get(key);
    // 墓標は作者本人か owner だけ。新規の墓標は自分の by に限る。by の大文字小文字は問わない（login は小文字）
    // Tombstones only by the author or an owner. A brand-new tombstone only for one's own `by`. Case-insensitive (logins are lowercase)
    const author = prev ? prev.by : record.by;
    if (record.deleted && author.toLowerCase() !== p.login && (!prev || role !== 'owner')) {
      reject('forbidden_tombstone');
      continue;
    }
    if (prev && Date.parse(record.updated_at) <= Date.parse(prev.updated_at)) {
      reject('stale');
      continue;
    }
    existing.set(key, { by: author, updated_at: record.updated_at });
    accepted.push({
      id: record.id,
      statement: env.DB.prepare(UPSERT_SQL).bind(
        record.id,
        record.stream_id,
        record.offset_sec,
        record.by,
        record.memo,
        record.native ? 1 : 0,
        record.created_at,
        record.updated_at,
        record.deleted ? 1 : 0,
        record.clock_skew_ms,
        source,
      ),
    });
  }

  const ids: string[] = [];
  if (accepted.length > 0) {
    const results = await env.DB.batch(accepted.map((a) => a.statement));
    // 判定と書き込みの間に新しい行が入っていれば WHERE で書かれない → stale
    // If a newer row arrived between the check and the write, the WHERE skips it → stale
    results.forEach((result, i) => {
      if (result.meta.changes > 0) ids.push(accepted[i].id);
      else rejected.push({ id: accepted[i].id, reason: 'stale' });
    });
  }
  return { accepted: ids, rejected };
}

// 認証の種類から決める既定の source / Default source by the kind of credential
function defaultSource(p: Principal): StampSource {
  if (p.via === 'token') return 'panel';
  if (p.via === 'twitch') return 'extension';
  return 'web';
}

export function registerStampRoutes(router: Router): void {
  // 本文 {records: StampRecord[], source?}。受理 0 件でも 200 / Body {records: StampRecord[], source?}. 200 even when nothing is accepted
  router.add('POST', '/api/stamps', async (ctx) => {
    const principal = await requireAuth(ctx);
    requireCsrf(ctx, principal);
    const body = await readJson<unknown>(ctx.request);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return error(400, 'bad_request');
    const { records, source } = body as { records?: unknown; source?: unknown };
    if (!Array.isArray(records)) return error(400, 'bad_request');
    if (records.length > MAX_RECORDS) return error(413, 'too_many_records', `max ${MAX_RECORDS}`);
    if (source !== undefined && !SOURCES.includes(source as StampSource)) return error(400, 'bad_request');
    return json(200, await upsertStamps(ctx.env, principal, records, (source as StampSource | undefined) ?? defaultSource(principal)));
  });

  // 墓標込みの全件（offset_sec 昇順）。?since= で updated_at が新しい分だけ
  // All records including tombstones (offset_sec ascending). ?since= limits to newer updated_at
  router.add('GET', '/api/streams/:id/stamps', async (ctx) => {
    const principal = await requireAuth(ctx);
    const stream = await loadStream(ctx.env, ctx.params.id);
    await requireMember(ctx, principal, stream.channel);
    const sinceParam = ctx.url.searchParams.get('since');
    const since = sinceParam ? toIso(sinceParam, null) : null;
    if (sinceParam && since === null) return error(400, 'bad_request');
    const { results } = await ctx.env.DB.prepare(
      'SELECT * FROM stamps WHERE stream_id = ?1 AND (?2 IS NULL OR updated_at > ?2) ORDER BY offset_sec ASC, id ASC',
    )
      .bind(stream.stream_id, since)
      .all<StampRow>();
    return json(200, { stream, records: results.map((row) => rowToRecord(row, stream)) });
  });
}
