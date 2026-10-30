'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TSLib = require('../extension/lib.js');

assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/x'), 'x');
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/x/'), 'x');
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/x/videos'), null);
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/x/clip/abc'), null);
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/x/about'), null);
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/moderator/x'), 'x');
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/moderator/x/activity'), 'x');
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/popout/x/chat'), 'x');
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/popout/x'), null);
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/popout/moderator/x'), 'x');
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/directory'), null);
assert.strictEqual(TSLib.channelFromUrl('https://example.com/x'), null);
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/bad-name'), null);
assert.strictEqual(TSLib.channelFromUrl('https://www.twitch.tv/Upper_Case'), 'upper_case');

assert.strictEqual(TSLib.computeOffsetSec(Date.parse('2026-01-01T00:01:05Z'), '2026-01-01T00:00:00Z', 5), 60);
assert.strictEqual(TSLib.computeOffsetSec(Date.parse('2026-01-01T00:00:02Z'), '2026-01-01T00:00:00Z', 5), 0);
assert.strictEqual(TSLib.computeClockSkewMs('Thu, 01 Jan 1970 00:00:10 GMT', 8000, 10000), 1000);
assert.strictEqual(TSLib.computeClockSkewMs('', 8000, 10000), 0);
assert.strictEqual(TSLib.computeClockSkewMs('invalid', 8000, 10000), 0);
assert.strictEqual(TSLib.localOffsetSec(Date.parse('2026-01-01T00:01:00Z'), 5000, '2026-01-01T00:00:00Z', 5), 60);
assert.strictEqual(TSLib.nativeOffsetSec(100, 12000, 10000, 5, 42), 93);
assert.strictEqual(TSLib.nativeOffsetSec(NaN, 12000, 10000, 5, 42), 42);

assert.strictEqual(TSLib.formatTimecode(0), '00:00:00');
assert.strictEqual(TSLib.formatTimecode(59), '00:00:59');
assert.strictEqual(TSLib.formatTimecode(3600), '01:00:00');
assert.strictEqual(TSLib.formatTimecode(3661), '01:01:01');
assert.strictEqual(TSLib.formatTimecode(360000), '100:00:00');

assert.strictEqual(TSLib.formatTimecodeFrames(0, 30), '00:00:00:00');
assert.strictEqual(TSLib.formatTimecodeFrames(1.5, 30), '00:00:01:15');
assert.strictEqual(TSLib.formatTimecodeFrames(1.2, 30), '00:00:01:06');
assert.strictEqual(TSLib.formatTimecodeFrames(3661.5, 24), '01:01:01:12');
assert.strictEqual(TSLib.formatTimecodeFrames(-2.5, 30), '-00:00:02:15');
assert.strictEqual(TSLib.formatTimecodeFrames(0.5, 120), '00:00:00:060');
assert.strictEqual(TSLib.formatTimecodeFrames(360000, 30), '100:00:00:00');
assert.strictEqual(TSLib.formatTimecodeFrames(1.5, 0), '00:00:01:00');
assert.strictEqual(TSLib.parseTimecodeFrames('00:00:01:15', 30), 1.5);
assert.strictEqual(TSLib.parseTimecodeFrames('-00:00:02:15', 30), -2.5);
assert.strictEqual(TSLib.parseTimecodeFrames(' 01:01:01:12 ', 24), 3661.5);
assert.strictEqual(Object.is(TSLib.parseTimecodeFrames('-00:00:00:00', 30), 0), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames('00:60:00:00', 30)), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames('00:00:60:00', 30)), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames('00:00:00:30', 30)), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames('abc', 30)), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames('', 30)), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames('1:2:3', 30)), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames('00:00:01:15', 0)), true);
assert.strictEqual(Number.isNaN(TSLib.parseTimecodeFrames(5, 30)), true);
for (let frame = 0; frame <= 100; frame += 1) {
  const seconds = frame / 30;
  const roundTrip = TSLib.parseTimecodeFrames(TSLib.formatTimecodeFrames(seconds, 30), 30);
  assert.ok(Math.abs(roundTrip - seconds) < 1e-9);
}

assert.strictEqual(TSLib.fnv1aHex(''), '811c9dc5');
assert.strictEqual(TSLib.fnv1aHex('a'), 'e40c292c');
assert.strictEqual(TSLib.fnv1aHex('foobar'), 'bf9cf968');
assert.strictEqual(TSLib.fnv1aHex('C:/v/a.mp4|123|45').length, 8);
assert.match(TSLib.fnv1aHex('C:/v/a.mp4|123|45'), /^[0-9a-f]{8}$/);

assert.deepStrictEqual(TSLib.splitPremiereComment('by: alice [yts:aaaaaaaa]'),
  { user: '', by: 'alice', hasBy: true, id: 'aaaaaaaa' });
assert.deepStrictEqual(TSLib.splitPremiereComment('hello by: alice [yts:aaaaaaaa]'),
  { user: 'hello', by: 'alice', hasBy: true, id: 'aaaaaaaa' });
assert.deepStrictEqual(TSLib.splitPremiereComment('note by: x inside by: alice [yts:aaaaaaaa]'),
  { user: 'note by: x inside', by: 'alice', hasBy: true, id: 'aaaaaaaa' });
assert.deepStrictEqual(TSLib.splitPremiereComment('see [yts:bbbbbbbb] ok by: alice [yts:aaaaaaaa]'),
  { user: 'see ok', by: 'alice', hasBy: true, id: 'aaaaaaaa' });
assert.deepStrictEqual(TSLib.splitPremiereComment('line1\nline2 by: bob [yts:y1234567]'),
  { user: 'line1\nline2', by: 'bob', hasBy: true, id: 'y1234567' });
assert.deepStrictEqual(TSLib.splitPremiereComment('free text'),
  { user: 'free text', by: '', hasBy: false, id: null });
assert.deepStrictEqual(TSLib.splitPremiereComment('by: carol'),
  { user: '', by: 'carol', hasBy: true, id: null });
assert.deepStrictEqual(TSLib.splitPremiereComment('abcby: x [yts:aaaaaaaa]'),
  { user: 'abcby: x', by: '', hasBy: false, id: 'aaaaaaaa' });
assert.deepStrictEqual(TSLib.splitPremiereComment(''),
  { user: '', by: '', hasBy: false, id: null });
assert.deepStrictEqual(TSLib.splitPremiereComment(null),
  { user: '', by: '', hasBy: false, id: null });

assert.strictEqual(TSLib.buildPremiereComment('hello', 'alice', true, 'aaaaaaaa'),
  'hello by: alice [yts:aaaaaaaa]');
assert.strictEqual(TSLib.buildPremiereComment('', 'alice', true, 'aaaaaaaa'),
  'by: alice [yts:aaaaaaaa]');
assert.strictEqual(TSLib.buildPremiereComment('x [yts:bbbbbbbb]', '', false, 'aaaaaaaa'),
  'x [yts:aaaaaaaa]');
assert.strictEqual(TSLib.buildPremiereComment('', '', false, null), '');
['hello', 'line1\nline2', 'note by: x inside', ''].forEach(function (user) {
  assert.deepStrictEqual(
    TSLib.splitPremiereComment(TSLib.buildPremiereComment(user, 'alice', true, 'aaaaaaaa')),
    { user: user, by: 'alice', hasBy: true, id: 'aaaaaaaa' }
  );
});

const baseConfirmInput = {
  plan: { preview: [], appOps: [], warnings: [] },
  entry: { lastSyncAt: 'x' },
  parsedWarnings: [],
  repaired: 0
};
assert.deepStrictEqual(TSLib.syncConfirmReasons(baseConfirmInput), []);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  entry: { lastSyncAt: '' }
})), ['初回の同期']);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  plan: { preview: [], appOps: [{ op: 'tag' }], warnings: [] }
})), ['ID の付与']);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  plan: { preview: Array(9).fill({ kind: 'add-app' }), appOps: [], warnings: [] }
})), []);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  plan: { preview: Array(10).fill({ kind: 'add-app' }), appOps: [], warnings: [] }
})), ['アプリへの追加が多い']);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  plan: { preview: [], appOps: [], warnings: ['w'] }
})), ['警告あり']);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  parsedWarnings: ['w']
})), ['警告あり']);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  repaired: 1
})), ['警告あり']);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  plan: { needsConfirm: true, preview: [{ kind: 'conflict' }], appOps: [], warnings: [] }
})), ['大量削除', '競合']);
assert.deepStrictEqual(TSLib.syncConfirmReasons(Object.assign({}, baseConfirmInput, {
  plan: { error: 'E', needsConfirm: true, preview: [{ kind: 'conflict' }], appOps: [], warnings: [] }
})), ['E', '大量削除', '競合']);

const sampleRecords = [
  {
    stream_id: 'stream123', channel: 'alpha', started_at: '2026-01-02T03:04:05Z',
    offset_sec: 12, created_at: '2026-01-02T03:04:17Z', clock_skew_ms: 0,
    by: 'editor', memo: 'Opening', native: true
  },
  {
    stream_id: 'stream123', channel: 'alpha', started_at: '2026-01-02T03:04:05Z',
    offset_sec: 90, created_at: '2026-01-02T03:05:35Z', clock_skew_ms: 120,
    by: 'moderator', memo: '見どころ, "すごい"\n二行目', native: false
  },
  {
    stream_id: 'stream123', channel: 'alpha', started_at: '2026-01-02T03:04:05Z',
    offset_sec: 3661, created_at: '2026-01-02T04:05:06Z', clock_skew_ms: -80,
    by: 'editor', memo: 'Boss fight', native: true
  }
];

const csv = TSLib.toCsv(sampleRecords);
assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
assert.ok(csv.indexOf('\r\n') >= 0);
assert.ok(csv.indexOf('id,timecode,offset_sec,by,memo,native,channel,stream_id,started_at,created_at,updated_at,deleted,clock_skew_ms\r\n') === 1);
const parsedResult = TSLib.parseCsv(csv);
assert.strictEqual(parsedResult.skipped, 0);
assert.deepStrictEqual(parsedResult.skippedRows, []);
assert.strictEqual(parsedResult.repaired, 0);
assert.deepStrictEqual(parsedResult.warnings, []);
assert.strictEqual(parsedResult.records.length, 3);
assert.strictEqual(parsedResult.records[1].memo, '見どころ, "すごい"\n二行目');
assert.strictEqual(parsedResult.records[1].native, false);
assert.strictEqual(parsedResult.records[1].clock_skew_ms, 120);
assert.strictEqual(parsedResult.records[2].offset_sec, 3661);
assert.strictEqual(parsedResult.records[2].created_at, sampleRecords[2].created_at);
assert.strictEqual(parsedResult.records[2].updated_at, sampleRecords[2].created_at);
assert.strictEqual(parsedResult.records[2].deleted, false);
assert.throws(function () { TSLib.parseCsv('by,memo,stream_id\na,b,c\n'); }, /必須ヘッダー/);

const skippedResult = TSLib.parseCsv(
  'offset_sec,by,memo,stream_id\r\n' +
  '12,a,ok,s\r\n' +
  ',b,empty,s\r\n' +
  'nope,c,invalid,s\r\n'
);
assert.strictEqual(skippedResult.records.length, 1);
assert.strictEqual(skippedResult.skipped, 2);
assert.deepStrictEqual(skippedResult.skippedRows, [3, 4]);

const injectionRecords = [
  Object.assign({}, sampleRecords[0], { created_at: 'i1', by: '@x', memo: '=SUM(A1)' }),
  Object.assign({}, sampleRecords[0], { created_at: 'i2', by: 'safe', memo: '-5' })
];
const injectionCsv = TSLib.toCsv(injectionRecords);
assert.ok(injectionCsv.indexOf("'=SUM(A1)") >= 0);
assert.ok(injectionCsv.indexOf("'@x") >= 0);
assert.ok(injectionCsv.indexOf("'-5") >= 0);
const injectionParsed = TSLib.parseCsv(injectionCsv).records;
assert.strictEqual(injectionParsed[0].memo, '=SUM(A1)');
assert.strictEqual(injectionParsed[0].by, '@x');
assert.strictEqual(injectionParsed[1].memo, '-5');

const legacyId = TSLib.legacyId(sampleRecords[0]);
assert.strictEqual(TSLib.legacyId(Object.assign({}, sampleRecords[0])), legacyId);
assert.match(legacyId, /^y[0-9a-f]{7}$/);
assert.match(TSLib.newId(), /^y[0-9a-f]{7}$/);
assert.strictEqual(TSLib.isValidId('12ab34ef'), true);
assert.strictEqual(TSLib.isValidId('y2ab34ef'), true);
assert.strictEqual(TSLib.isValidId('12AB34EF'), false);
assert.strictEqual(TSLib.isValidId('z2ab34ef'), false);
const firstRoundTrip = TSLib.parseCsv(TSLib.toCsv(sampleRecords)).records;
const secondRoundTrip = TSLib.parseCsv(TSLib.toCsv(firstRoundTrip)).records;
assert.deepStrictEqual(firstRoundTrip.map(function (record) { return record.id; }),
  secondRoundTrip.map(function (record) { return record.id; }));
const legacyCsv = 'offset_sec,by,memo,stream_id,channel,started_at,created_at,native,clock_skew_ms\r\n' +
  '12,editor,Opening,stream123,alpha,2026-01-02T03:04:05Z,2026-01-02T03:04:17Z,true,0\r\n';
assert.strictEqual(TSLib.parseCsv(legacyCsv).records[0].id, TSLib.normalizeRecord(sampleRecords[0]).id);

const fractional = Object.assign({}, sampleRecords[0], { id: '12345678', offset_sec: 12.3456 });
assert.strictEqual(TSLib.parseCsv(TSLib.toCsv([fractional])).records[0].offset_sec, 12.346);
const floorCsv = TSLib.toCsv([Object.assign({}, fractional, { offset_sec: 59.9 })]);
assert.ok(floorCsv.indexOf('12345678,00:00:59,59.9,') >= 0);

const duplicate = Object.assign({}, sampleRecords[0]);
assert.strictEqual(TSLib.mergeRecords(sampleRecords, [duplicate]).length, 3);
const secondPress = Object.assign({}, sampleRecords[0], { created_at: '2026-01-02T03:04:17.500Z' });
assert.strictEqual(TSLib.mergeRecords(sampleRecords, [secondPress]).length, 4);
const oldVersion = Object.assign({}, sampleRecords[0], { id: 'aaaaaaaa', updated_at: '2026-01-01T00:00:00Z', memo: 'old' });
const newVersion = Object.assign({}, oldVersion, { updated_at: '2026-01-02T00:00:00Z', memo: 'new' });
assert.strictEqual(TSLib.mergeRecords([oldVersion], [newVersion])[0].memo, 'new');
assert.strictEqual(TSLib.mergeRecords([newVersion], [oldVersion])[0].memo, 'new');
const tieVersion = Object.assign({}, newVersion, { memo: 'tie' });
assert.strictEqual(TSLib.mergeRecords([newVersion], [tieVersion])[0].memo, 'new');
const tombstone = Object.assign({}, newVersion, { updated_at: '2026-01-03T00:00:00Z', deleted: true });
assert.strictEqual(TSLib.mergeRecords([newVersion], [tombstone])[0].deleted, true);

// 墓標化・送信バッチ・応答の反映（サーバー送信キュー）
// Tombstoning, upload batches and applying the response (server upload queue)
const tombSource = { id: 'y0000001', memo: 'a', deleted: false, updated_at: '2026-01-01T00:00:00.000Z' };
const t = TSLib.tombstoneRecord(tombSource, '2026-02-01T00:00:00.000Z');
assert.strictEqual(t.deleted, true); assert.strictEqual(t.updated_at, '2026-02-01T00:00:00.000Z'); assert.strictEqual(t.memo, 'a');
assert.strictEqual(tombSource.deleted, false);
const recs = [{ id: 'a', stream_id: 's1' }, { id: 'b', stream_id: 's1' }, { id: 'c', stream_id: 's2' }];
const uploadPlan = TSLib.planUpload(recs, ['a', 'c', 'zzz'], 500);
assert.deepStrictEqual(uploadPlan.map(p => [p.stream_id, p.records.map(r => r.id)]), [['s1', ['a']], ['s2', ['c']]]);
assert.strictEqual(TSLib.planUpload([{ id: 'a', stream_id: 's1' }, { id: 'b', stream_id: 's1' }], ['a', 'b'], 1).length, 2);
// 既定は 500 件ごと / The default batch size is 500
const manyRecs = Array.from({ length: 1001 }, (_, i) => ({ id: 'r' + i, stream_id: 's1' }));
assert.deepStrictEqual(TSLib.planUpload(manyRecs, manyRecs.map(r => r.id)).map(p => p.records.length), [500, 500, 1]);
const r = TSLib.applyUploadResult(['a', 'b', 'c', 'd'], [], ['a', 'b', 'c'], { accepted: ['a'], rejected: [{ id: 'b', reason: 'stale' }, { id: 'c', reason: 'forbidden_tombstone' }] });
assert.deepStrictEqual(r.pendingIds, ['d']); assert.strictEqual(r.failed.length, 1); assert.strictEqual(r.failed[0].reason, 'forbidden_tombstone');
// 応答に出ない id は残し、同じ id の失敗は上書き / IDs missing from the response stay; a repeated failure overwrites
const prevFailed = [{ id: 'c', reason: 'invalid_id', at: 'old' }];
const r2 = TSLib.applyUploadResult(['a', 'c', 'e'], prevFailed, ['a', 'c', 'e'], { accepted: ['a'], rejected: [{ id: 'c', reason: 'missing_stream' }] });
assert.deepStrictEqual(r2.pendingIds, ['e']); assert.strictEqual(r2.failed.length, 1); assert.strictEqual(r2.failed[0].reason, 'missing_stream');
assert.notStrictEqual(r2.failed[0].at, 'old'); assert.strictEqual(prevFailed[0].reason, 'invalid_id');
assert.strictEqual(TSLib.isRetryableUpload(0), true); assert.strictEqual(TSLib.isRetryableUpload(503), true); assert.strictEqual(TSLib.isRetryableUpload(401), false); assert.strictEqual(TSLib.isRetryableUpload(413), false);
assert.strictEqual(TSLib.isRetryableUpload(408), true); assert.strictEqual(TSLib.isRetryableUpload(429), true); assert.strictEqual(TSLib.isRetryableUpload(403), false);
// 失敗理由の表示文言と記録ごとの送信状態（popup 用） / Failure reason text and per-record sync state (for the popup)
assert.strictEqual(TSLib.reasonText('forbidden_tombstone'), "他の人の記録は消せません / cannot delete others' records");
assert.strictEqual(TSLib.reasonText('forbidden_channel'), 'このチャンネルの会員ではありません / not a member of this channel');
for (const code of ['invalid_id', 'invalid_offset', 'invalid_by', 'invalid_record']) {
  assert.strictEqual(TSLib.reasonText(code), '記録の形式が不正です / invalid record', code);
}
assert.strictEqual(TSLib.reasonText('invalid_time'), '時刻が不正です / invalid time');
assert.strictEqual(TSLib.reasonText('missing_stream'), '配信情報がありません / stream missing');
assert.strictEqual(TSLib.reasonText('permission_required'), 'サーバーへの送信が許可されていません / sending not allowed yet');
assert.strictEqual(TSLib.reasonText('unauthorized'), 'ログインが必要です / login required');
assert.strictEqual(TSLib.reasonText('login_required'), 'ログインが必要です / login required');
assert.strictEqual(TSLib.reasonText('network'), '通信できませんでした / network error');
// 一時的な不調（5xx / 408 / 429）と、それ以外の 4xx / Temporary trouble (5xx / 408 / 429) and other 4xx
for (const code of ['http_500', 'http_502', 'http_503', 'http_599', 'http_408', 'http_429']) {
  assert.strictEqual(TSLib.reasonText(code), 'サーバーが一時的に応答しません / server temporarily unavailable', code);
}
for (const code of ['http_400', 'http_403', 'http_404', 'http_405', 'http_413']) {
  assert.strictEqual(TSLib.reasonText(code), 'サーバーが要求を拒否しました (' + code + ') / server rejected the request (' + code + ')', code);
}
assert.strictEqual(TSLib.reasonText('http_200'), 'サーバーの応答が不正です / unexpected server response');
assert.strictEqual(TSLib.reasonText('http_302'), 'サーバーに届きませんでした (http_302) / server unreachable (http_302)');
assert.strictEqual(TSLib.reasonText('internal'), '拡張の内部エラー / extension internal error');
assert.strictEqual(TSLib.reasonText('csrf'), 'csrf');
assert.strictEqual(TSLib.reasonText('http_x'), 'http_x');
assert.strictEqual(TSLib.reasonText(''), '');
assert.strictEqual(TSLib.reasonText(undefined), '');
// 失敗 > 送信待ち > 送信済（synced にある） > 一度も送っていない / failed > pending > sent (in synced) > never sent
const syncFailed = [{ id: 'f1', reason: 'forbidden_channel', at: 'x' }, { id: 'both', reason: 'invalid_record', at: 'x' }];
const syncPending = ['p1', 'both', 'ps'];
const syncDone = ['s1', 'ps', 'f1'];
assert.strictEqual(TSLib.recordSyncState('p1', syncPending, syncFailed, syncDone), 'pending');
assert.strictEqual(TSLib.recordSyncState('f1', syncPending, syncFailed, syncDone), 'failed');
assert.strictEqual(TSLib.recordSyncState('both', syncPending, syncFailed, syncDone), 'failed');
assert.strictEqual(TSLib.recordSyncState('ps', syncPending, syncFailed, syncDone), 'pending');
assert.strictEqual(TSLib.recordSyncState('s1', syncPending, syncFailed, syncDone), 'sent');
assert.strictEqual(TSLib.recordSyncState('u1', syncPending, syncFailed, syncDone), 'unsent');
assert.strictEqual(TSLib.recordSyncState('u1', undefined, undefined, undefined), 'unsent');
const u = TSLib.toUploadRecord({ id: 'y1', offset_sec: 61.2345, native: 'true', deleted: 0, created_at: '2026-01-01T00:00:00.000Z', by: 'x', memo: '', stream_id: 's', channel: 'c', started_at: '2026-01-01T00:00:00.000Z' });
assert.strictEqual(u.timecode, '00:01:01'); assert.strictEqual(u.offset_sec, 61.235); assert.strictEqual(u.native, true); assert.strictEqual(u.deleted, false); assert.strictEqual(u.updated_at, u.created_at); assert.strictEqual(u.clock_skew_ms, 0);
assert.deepStrictEqual(Object.keys(u), ['id', 'timecode', 'offset_sec', 'by', 'memo', 'native', 'channel', 'stream_id', 'started_at', 'created_at', 'updated_at', 'deleted', 'clock_skew_ms']);

const otherStream = {
  stream_id: 'newer', channel: 'beta', started_at: '2026-02-01T00:00:00Z',
  offset_sec: 4, created_at: '', clock_skew_ms: 0, by: 'editor', memo: '', native: false
};
const unknownStream = {
  stream_id: 'unknown', channel: 'gamma', started_at: '',
  offset_sec: 1, created_at: '', clock_skew_ms: 0, by: 'editor', memo: '', native: false
};
const groupTombstone = Object.assign({}, sampleRecords[0], { id: 'bbbbbbbb', deleted: true });
const tombstoneOnly = Object.assign({}, groupTombstone, {
  id: 'cccccccc', stream_id: 'deleted-only', started_at: '2025-01-01T00:00:00Z'
});
const groups = TSLib.groupByStream(sampleRecords.concat([groupTombstone, tombstoneOnly, unknownStream, otherStream]));
assert.strictEqual(groups[0].stream_id, 'newer');
assert.strictEqual(groups[1].records[0].offset_sec, 12);
assert.strictEqual(groups[1].records.length, 3);
assert.strictEqual(groups[1].allRecords.length, 4);
assert.strictEqual(groups[2].stream_id, 'deleted-only');
assert.strictEqual(groups[2].records.length, 0);
assert.strictEqual(groups[2].allRecords.length, 1);
assert.strictEqual(groups[3].stream_id, 'unknown');
assert.strictEqual(TSLib.fileStamp(''), 'unknown');
assert.strictEqual(TSLib.fileStamp('not-a-date'), 'unknown');

const NOW = '2026-03-01T00:00:00Z';
function record(id, offset, memo, extra) {
  return Object.assign({
    id: id, stream_id: 's1', channel: 'alpha', started_at: '2026-01-01T00:00:00Z',
    offset_sec: offset, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    clock_skew_ms: 0, by: 'editor', memo: memo || '', native: false, deleted: false
  }, extra || {});
}

function plan(overrides) {
  return TSLib.syncPlan(Object.assign({
    records: [], streamId: 's1', target: null, userOffset: 0,
    appMarkers: [], fps: 30, now: NOW, choices: {}, addUntagged: false,
    hostName: 'premiere'
  }, overrides || {}));
}

const firstSyncRecords = [record('00000001', 10, 'one'), record('00000002', 20, 'two')];
let result = plan({ records: firstSyncRecords });
assert.deepStrictEqual(result.appOps.map(function (op) { return op.op; }), ['create', 'create']);
assert.deepStrictEqual(result.base['00000001'], { t: 10, memo: 'one', autoName: false });
assert.strictEqual(result.preview[0].kind, 'add-app');

result = plan({
  records: [record('00000003', 10, 'base')],
  target: { userOffset: 0, base: { '00000003': { t: 10, memo: 'base' } } },
  appMarkers: [{ index: 0, id: '00000003', t: 11, memo: 'base' }]
});
assert.strictEqual(result.records[0].offset_sec, 11);
assert.strictEqual(result.records[0].updated_at, NOW);
assert.strictEqual(result.preview[0].kind, 'move');
assert.strictEqual(result.preview[0].source, 'app');

result = plan({
  records: [record('00000004', 12, 'csv')],
  target: { userOffset: 0, base: { '00000004': { t: 10, memo: 'base' } } },
  appMarkers: [{ index: 0, id: '00000004', t: 10, memo: 'base' }]
});
assert.strictEqual(result.appOps[0].op, 'update');
assert.strictEqual(result.appOps[0].t, 12);
assert.strictEqual(result.appOps[0].index, 0);
assert.strictEqual(result.appOps[0].appT, 10);
assert.strictEqual(result.preview[0].source, 'csv');

result = plan({
  records: [record('00000014', 12, 'same')],
  target: { userOffset: 0, base: { '00000014': { t: 10, memo: 'base' } } },
  appMarkers: [{ index: 0, id: '00000014', t: 12, memo: 'same' }]
});
assert.strictEqual(result.conflicts.length, 0);
assert.strictEqual(result.csvChanged, false);
assert.strictEqual(result.appOps.length, 0);

const conflictInput = {
  records: [record('00000005', 12, 'csv')],
  target: { userOffset: 0, base: { '00000005': { t: 10, memo: 'base' } } },
  appMarkers: [{ index: 0, id: '00000005', t: 14, memo: 'app' }]
};
result = plan(conflictInput);
assert.deepStrictEqual(result.conflicts, ['00000005']);
assert.strictEqual(result.preview[0].kind, 'conflict');
assert.strictEqual(result.preview[0].source, 'app');
assert.strictEqual(result.records[0].offset_sec, 14);
result = plan(Object.assign({}, conflictInput, { choices: { '00000005': 'csv' } }));
assert.strictEqual(result.preview[0].source, 'csv');
assert.strictEqual(result.appOps[0].op, 'update');
assert.strictEqual(result.appOps[0].t, 12);

const noHistoryInput = {
  records: [record('00000006', 10, 'csv')],
  appMarkers: [{ index: 0, id: '00000006', t: 20, memo: 'app' }]
};
result = plan(noHistoryInput);
assert.strictEqual(result.preview[0].kind, 'conflict');
assert.strictEqual(result.preview[0].source, 'csv');
assert.strictEqual(result.appOps[0].op, 'update');
result = plan(Object.assign({}, noHistoryInput, { choices: { '00000006': 'app' } }));
assert.strictEqual(result.preview[0].source, 'app');
assert.strictEqual(result.records[0].offset_sec, 20);
result = plan({
  records: [record('00000015', 10, 'equal')],
  appMarkers: [{ index: 0, id: '00000015', t: 10, memo: 'equal' }]
});
assert.strictEqual(result.conflicts.length, 0);
assert.strictEqual(result.appOps.length, 0);
assert.deepStrictEqual(result.base['00000015'], { t: 10, memo: 'equal', autoName: false });

const frame = 1 / 30;
const toleranceInput = {
  records: [record('00000007', 10, '')],
  target: { userOffset: 0, base: { '00000007': { t: 10, memo: '' } } }
};
result = plan(Object.assign({}, toleranceInput, {
  appMarkers: [{ index: 0, id: '00000007', t: 10 + frame * 0.4, memo: '' }]
}));
assert.strictEqual(result.csvChanged, false);
assert.strictEqual(result.preview.length, 0);
result = plan(Object.assign({}, toleranceInput, {
  appMarkers: [{ index: 0, id: '00000007', t: 10 + frame * 0.6, memo: '' }]
}));
assert.strictEqual(result.csvChanged, true);
assert.strictEqual(result.preview[0].kind, 'move');

result = plan({
  records: [record('00000008', 10, 'gone')],
  target: { userOffset: 0, base: { '00000008': { t: 10, memo: 'gone' } } }
});
assert.strictEqual(result.records[0].deleted, true);
assert.strictEqual(result.records[0].updated_at, NOW);
assert.strictEqual(result.preview[0].kind, 'delete-csv');
result = plan({
  records: [record('00000009', 10, 'gone', { deleted: true })],
  appMarkers: [{ index: 2, id: '00000009', t: 10, memo: 'gone' }]
});
assert.strictEqual(result.appOps[0].op, 'delete');
assert.strictEqual(result.appOps[0].index, 2);
assert.strictEqual(result.appOps[0].appT, 10);
assert.strictEqual(result.preview[0].kind, 'delete-app');

result = plan({
  target: { userOffset: 0, base: { '0000000a': { t: 10, memo: 'removed' } } },
  appMarkers: [{ index: 0, id: '0000000a', t: 10, memo: 'removed' }]
});
assert.ok(result.error);
assert.deepStrictEqual(result.appOps, []);
result = plan({
  records: [record('000000ff', 1, '')],
  appMarkers: [{ index: 0, id: '0000000b', t: 13.25, memo: 'found' }],
  userOffset: 1.25, hostName: 'ae'
});
const unknownTagged = result.records.find(function (item) { return item.id === '0000000b'; });
assert.strictEqual(unknownTagged.offset_sec, 12);
assert.strictEqual(unknownTagged.by, 'ae');
assert.strictEqual(unknownTagged.channel, 'alpha');
assert.strictEqual(result.appOps.length, 1);
assert.strictEqual(result.appOps[0].op, 'create');
assert.strictEqual(result.preview.some(function (row) { return row.kind === 'add-csv'; }), true);

result = plan({
  records: [record('0000000c', 5, '')], userOffset: 2, addUntagged: true, hostName: 'ae',
  appMarkers: [{ index: 7, id: null, t: 14.3456, memo: 'new' }]
});
const added = result.records.find(function (item) { return item.id !== '0000000c'; });
assert.match(added.id, /^y[0-9a-f]{7}$/);
assert.notStrictEqual(added.id, '0000000c');
assert.strictEqual(added.offset_sec, 12.346);
assert.strictEqual(added.by, 'ae');
assert.strictEqual(added.channel, 'alpha');
assert.strictEqual(added.started_at, '2026-01-01T00:00:00Z');
assert.strictEqual(result.appOps[0].op, 'tag');
assert.strictEqual(result.appOps[0].index, 7);
// streamTemplate: CSV にその配信の行が無いとき（スタンプ 0 件のサーバー配信）、新しい記録の channel / started_at を補う
// streamTemplate: fills channel / started_at of new records when the CSV has no rows of the stream (a server stream with zero stamps).
const template = { channel: 'beta', started_at: '2026-02-01T00:00:00Z' };
result = plan({ appMarkers: [{ index: 0, id: 'y000000d', t: 4, memo: 'first' }], hostName: 'yato', streamTemplate: template });
assert.strictEqual(result.records.length, 1);
assert.strictEqual(result.records[0].channel, 'beta');
assert.strictEqual(result.records[0].started_at, '2026-02-01T00:00:00Z');
assert.strictEqual(result.records[0].by, 'yato');
result = plan({ appMarkers: [{ index: 0, id: null, t: 4, memo: '' }], addUntagged: true, streamTemplate: template });
assert.strictEqual(result.records[0].channel, 'beta');
// CSV に行があればそちらが優先 / Rows in the CSV win over the template
result = plan({ records: [record('0000000c', 5, '')], appMarkers: [{ index: 0, id: 'y000000d', t: 4, memo: '' }], streamTemplate: template });
assert.strictEqual(result.records.find(function (item) { return item.id === 'y000000d'; }).channel, 'alpha');
result = plan({ appMarkers: [{ index: 0, id: null, t: 10, memo: '' }], addUntagged: false });
assert.strictEqual(result.records.length, 0);
assert.strictEqual(result.appOps.length, 0);
assert.deepStrictEqual(result.base, {});

result = plan({
  records: [record('0000000d', 59.9, '')],
  target: { userOffset: 0, base: { '0000000d': { t: 59.9, memo: '' } } },
  appMarkers: [{ index: 0, id: '0000000d', t: 59.9, memo: '00:00:59' }]
});
assert.strictEqual(result.csvChanged, false);
assert.strictEqual(result.appOps.length, 0);
assert.deepStrictEqual(result.base['0000000d'], { t: 59.9, memo: '', autoName: true });

const passThrough = record('0000000e', 4, 'other', { stream_id: 'other' });
result = plan({ records: [record('0000000f', 2, ''), passThrough] });
const passed = result.records.find(function (item) { return item.id === '0000000e'; });
assert.strictEqual(passed.stream_id, 'other');
assert.strictEqual(passed.memo, 'other');

result = plan({
  records: [
    record('00000010', 2, 'csv'),
    record('00000011', 3, 'dead', { deleted: true }),
    record('00000012', 4, 'create')
  ],
  target: { userOffset: 0, base: {
    '00000010': { t: 1, memo: 'old' },
    '00000011': { t: 3, memo: 'dead' }
  } },
  appMarkers: [
    { index: 0, id: '00000010', t: 1, memo: 'old' },
    { index: 1, id: '00000011', t: 3, memo: 'dead' },
    { index: 2, id: null, t: 5, memo: 'tagged' },
    { index: 3, id: '00000010', t: 99, memo: 'duplicate' }
  ],
  addUntagged: true
});
// The duplicate-id marker (index 3) is re-tagged as untagged (M11), so two tag ops come first.
assert.deepStrictEqual(result.appOps.map(function (op) { return op.op; }), ['tag', 'tag', 'update', 'delete', 'create']);
assert.strictEqual(result.appOps[2].t, 2);

// Regression probes P1-P12 and hardening helpers.
{
  const records = [record('aaaaaaaa', 10, 'x', { stream_id: 'A' }), record('bbbbbbbb', 50, 'y', { stream_id: 'B' })];
  const cross = plan({
    records: records, streamId: 'B', userOffset: 5,
    appMarkers: [{ index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' }]
  });
  const original = cross.records.find(function (item) { return item.id === 'aaaaaaaa'; });
  assert.strictEqual(original.stream_id, 'A');
  assert.strictEqual(original.offset_sec, 10);
  assert.strictEqual(original.memo, 'x');
  assert.strictEqual(cross.appOps.some(function (op) { return op.id === 'aaaaaaaa'; }), false);
  assert.strictEqual(cross.base.aaaaaaaa, undefined);

  const crossAdded = plan({
    records: records, streamId: 'B', userOffset: 5, addUntagged: true,
    appMarkers: [{ index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' }]
  });
  const tags = crossAdded.appOps.filter(function (op) { return op.op === 'tag'; });
  assert.strictEqual(tags.length, 1);
  assert.match(tags[0].id, /^y[0-9a-f]{7}$/);
  assert.notStrictEqual(tags[0].id, 'aaaaaaaa');
  assert.strictEqual(tags[0].index, 0);
  assert.strictEqual(tags[0].appT, 10);
  assert.ok(crossAdded.records.some(function (item) { return item.id === tags[0].id && item.stream_id === 'B'; }));

  const originalStream = plan({
    records: cross.records, streamId: 'A',
    target: { base: { aaaaaaaa: { t: 10, memo: 'x' } }, userOffset: 0 },
    appMarkers: [{ index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' }]
  });
  assert.deepStrictEqual(originalStream.appOps, []);
  assert.deepStrictEqual(originalStream.preview, []);
}

{
  const source = TSLib.toCsv([record('aaaaaaaa', 10, 'x'), record('bbbbbbbb', 20, 'y')])
    .replace(',20,', ',1:23,');
  const parsed = TSLib.parseCsv(source);
  assert.strictEqual(parsed.skipped, 1);
  assert.deepStrictEqual(parsed.skippedRows, [3]);
}

{
  const parsed = TSLib.parseCsv(TSLib.toCsv([
    record('aaaaaaaa', 10, 'x'), record('aaaaaaaa', 99, 'new one')
  ]));
  assert.strictEqual(parsed.records.length, 2);
  assert.strictEqual(parsed.records[0].id, 'aaaaaaaa');
  assert.match(parsed.records[1].id, /^y[0-9a-f]{7}$/);
  assert.notStrictEqual(parsed.records[1].id, 'aaaaaaaa');
  assert.strictEqual(parsed.repaired, 1);
}

{
  const source = TSLib.toCsv([
    record('aaaaaaaa', 10, 'x', { stream_id: '316012345678' }),
    record('bbbbbbbb', 20, 'y', { stream_id: '316012345678' })
  ]).split('316012345678').join('3.16012E+11');
  const parsed = TSLib.parseCsv(source);
  assert.ok(parsed.warnings.length >= 1);
  const guarded = plan({
    records: parsed.records, streamId: '316012345678',
    target: { base: { aaaaaaaa: { t: 10, memo: 'x' }, bbbbbbbb: { t: 20, memo: 'y' } } },
    appMarkers: [
      { index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' },
      { index: 1, id: 'bbbbbbbb', t: 20, memo: 'y' }
    ]
  });
  assert.strictEqual(guarded.error,
    'この配信の行が CSV に見つかりません（stream_id が Excel で変換された可能性があります）');
  assert.deepStrictEqual(guarded.appOps, []);
  assert.deepStrictEqual(guarded.preview, []);
  assert.strictEqual(guarded.csvChanged, false);
  assert.strictEqual(guarded.needsConfirm, false);
  assert.strictEqual(guarded.deleteCount, 0);
}

{
  const parsed = TSLib.parseCsv(TSLib.toCsv([record('01234567', 10, 'x')]).replace('01234567', '1234567'));
  assert.strictEqual(parsed.records[0].id, '01234567');
  assert.strictEqual(parsed.repaired, 1);
  const moved = plan({
    records: parsed.records,
    target: { base: { '01234567': { t: 10, memo: 'x' } } },
    appMarkers: [{ index: 0, id: '01234567', t: 15, memo: 'moved in app' }]
  });
  assert.strictEqual(moved.appOps.some(function (op) { return op.op === 'delete' || op.op === 'create'; }), false);
  assert.strictEqual(moved.records[0].offset_sec, 15);
  assert.strictEqual(moved.records[0].memo, 'moved in app');
}

{
  const records = [record('aaaaaaaa', 10, 'x'), record('bbbbbbbb', 10, 'y')];
  const created = plan({ records: records });
  const actualBase = TSLib.baseFromMarkers({
    appMarkers: [{ index: 1, id: 'bbbbbbbb', t: 10, memo: 'y' }],
    records: created.records, streamId: 's1', userOffset: 0, previousBase: created.base
  });
  assert.strictEqual(actualBase.aaaaaaaa, undefined);
  const next = plan({
    records: created.records, target: { base: actualBase, userOffset: 0 },
    appMarkers: [{ index: 1, id: 'bbbbbbbb', t: 10, memo: 'y' }]
  });
  assert.ok(next.appOps.some(function (op) { return op.op === 'create' && op.id === 'aaaaaaaa'; }));
  assert.strictEqual(next.preview.some(function (row) { return row.kind === 'delete-csv'; }), false);
}

{
  const markers = [
    { index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' },
    { index: 1, id: null, t: 30, memo: 'u' }
  ];
  const tagged = plan({
    records: [record('aaaaaaaa', 10, 'x')],
    target: { base: { aaaaaaaa: { t: 10, memo: 'x' } } },
    appMarkers: markers, addUntagged: true
  });
  const tagId = tagged.appOps.find(function (op) { return op.op === 'tag'; }).id;
  const finalized = TSLib.finalizeRecords(tagged, [tagId]);
  assert.strictEqual(finalized.some(function (item) { return item.id === tagId; }), false);
  const actualBase = TSLib.baseFromMarkers({
    appMarkers: markers, records: finalized, streamId: 's1', userOffset: 0,
    previousBase: tagged.base
  });
  const retry = plan({
    records: finalized, target: { base: actualBase }, appMarkers: markers, addUntagged: true
  });
  assert.strictEqual(retry.appOps.filter(function (op) { return op.op === 'tag'; }).length, 1);
  assert.strictEqual(retry.appOps.filter(function (op) { return op.op === 'create'; }).length, 0);
}

{
  const idless = TSLib.toCsv([record('aaaaaaaa', 10, 'x')]).replace('aaaaaaaa', '');
  const parsed = TSLib.parseCsv(idless);
  assert.strictEqual(parsed.repaired, 1);
  const stableId = parsed.records[0].id;
  const persisted = TSLib.toCsv(parsed.records).replace(',x,', ',x edited,');
  const reparsed = TSLib.parseCsv(persisted);
  assert.strictEqual(reparsed.records[0].id, stableId);
  const initial = plan({ records: parsed.records });
  const concurrent = plan({
    records: reparsed.records, target: { base: initial.base },
    appMarkers: [{ index: 0, id: stableId, t: 42, memo: 'moved in app' }]
  });
  assert.ok(concurrent.conflicts.indexOf(stableId) >= 0 || concurrent.preview.some(function (row) {
    return row.kind === 'move' || row.kind === 'memo';
  }));
  assert.strictEqual(concurrent.appOps.some(function (op) { return op.op === 'delete' || op.op === 'create'; }), false);
}

{
  const first = plan({
    records: [record('aaaaaaaa', 60, '')],
    target: { base: { aaaaaaaa: { t: 60, memo: '' } } },
    appMarkers: [{ index: 0, id: 'aaaaaaaa', t: 70, memo: '00:01:00' }]
  });
  const second = plan({
    records: first.records, target: { base: first.base },
    appMarkers: [{ index: 0, id: 'aaaaaaaa', t: 70, memo: '00:01:00' }], now: 'later'
  });
  assert.strictEqual(second.records[0].memo, '');
  assert.deepStrictEqual(second.preview, []);
}

{
  const duplicateMarker = plan({
    records: [record('aaaaaaaa', 10, 'x')],
    target: { base: { aaaaaaaa: { t: 10, memo: 'x' } } }, addUntagged: true,
    appMarkers: [
      { index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' },
      { index: 1, id: 'aaaaaaaa', t: 80, memo: 'copy' }
    ]
  });
  const tags = duplicateMarker.appOps.filter(function (op) { return op.op === 'tag'; });
  assert.strictEqual(tags.length, 1);
  assert.strictEqual(tags[0].index, 1);
  assert.match(tags[0].id, /^y[0-9a-f]{7}$/);
  assert.strictEqual(duplicateMarker.records.length, 2);
  assert.strictEqual(duplicateMarker.records.find(function (item) { return item.id === 'aaaaaaaa'; }).offset_sec, 10);
  assert.strictEqual(duplicateMarker.appOps.some(function (op) { return op.op === 'delete'; }), false);
}

{
  const changedTimecode = TSLib.toCsv([record('aaaaaaaa', 60, 'x')]).replace('00:01:00', '00:01:30');
  const parsed = TSLib.parseCsv(changedTimecode);
  assert.strictEqual(parsed.records[0].offset_sec, 90);
  assert.strictEqual(parsed.repaired, 1);
}

{
  const original = plan({
    records: [record('aaaaaaaa', 10, 'x'), record('dddddddd', 90, 'deleted in app earlier')],
    target: { base: { aaaaaaaa: { t: 10, memo: 'x' }, cccccccc: { t: 70, memo: 'added in premiere' } } },
    appMarkers: [
      { index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' },
      { index: 1, id: 'cccccccc', t: 70, memo: 'added in premiere' }
    ]
  });
  assert.ok(original.appOps.some(function (op) { return op.op === 'delete' && op.id === 'cccccccc'; }));
  assert.ok(original.appOps.some(function (op) { return op.op === 'create' && op.id === 'dddddddd'; }));
  assert.strictEqual(original.deleteCount, 1);
  assert.strictEqual(original.needsConfirm, false);

  const ids = ['bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'];
  const largeBase = { aaaaaaaa: { t: 10, memo: 'x' } };
  const markers = [{ index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' }];
  ids.forEach(function (id, index) {
    largeBase[id] = { t: 20 + index, memo: id };
    markers.push({ index: index + 1, id: id, t: 20 + index, memo: id });
  });
  const guarded = plan({ records: [record('aaaaaaaa', 10, 'x')], target: { base: largeBase }, appMarkers: markers });
  assert.strictEqual(guarded.preview.filter(function (row) { return row.kind === 'delete-app'; }).length, 4);
  assert.strictEqual(guarded.deleteCount, 4);
  assert.strictEqual(guarded.needsConfirm, true);
}

{
  const previous = { t: 10, memo: 'x' };
  const unreadable = plan({
    records: [record('aaaaaaaa', 10, 'x')], target: { base: { aaaaaaaa: previous } },
    appMarkers: [{ index: 0, id: 'aaaaaaaa', t: null, memo: 'x' }]
  });
  assert.deepStrictEqual(unreadable.appOps, []);
  assert.deepStrictEqual(unreadable.preview, []);
  assert.strictEqual(unreadable.records[0].offset_sec, 10);
  assert.deepStrictEqual(unreadable.base.aaaaaaaa, previous);
  assert.ok(unreadable.warnings.length > 0);
}

{
  const a = [{ index: 0, id: null, t: 10, memo: 'x' }];
  assert.strictEqual(TSLib.sameMarkers(a, [{ index: 0, id: '', t: 10.01, memo: 'x' }], 30), true);
  assert.strictEqual(TSLib.sameMarkers(a, [{ index: 0, id: undefined, t: 10.02, memo: 'x' }], 30), false);
  assert.strictEqual(TSLib.sameMarkers(a, [], 30), false);
  assert.strictEqual(TSLib.sameMarkers(a, [{ index: 0, id: 'aaaaaaaa', t: 10, memo: 'x' }], 30), false);
  assert.strictEqual(TSLib.markerTolerance(0), 1 / 60);
}

{
  const snapshot = [
    record('aaaaaaaa', 1, 'old'), record('bbbbbbbb', 2, 'old'),
    record('cccccccc', 3, 'old'), record('eeeeeeee', 5, 'old')
  ];
  const planned = [
    record('aaaaaaaa', 1, 'planned'), record('bbbbbbbb', 2, 'old'),
    record('cccccccc', 3, 'old'), record('eeeeeeee', 5, 'planned')
  ];
  const fresh = [
    record('aaaaaaaa', 1, 'old'), record('bbbbbbbb', 2, 'fresh'),
    record('dddddddd', 4, 'new fresh'), record('eeeeeeee', 5, 'fresh')
  ];
  const merged = TSLib.mergeFresh({ snapshot: snapshot, planned: planned, fresh: fresh });
  const byId = new Map(merged.records.map(function (item) { return [item.id, item]; }));
  assert.strictEqual(byId.get('aaaaaaaa').memo, 'planned');
  assert.strictEqual(byId.get('bbbbbbbb').memo, 'fresh');
  assert.strictEqual(byId.has('cccccccc'), false);
  assert.strictEqual(byId.get('dddddddd').memo, 'new fresh');
  assert.strictEqual(byId.get('eeeeeeee').memo, 'planned');
  assert.deepStrictEqual(merged.conflicts, ['eeeeeeee']);
}

{
  const nudged = TSLib.applyNudges(
    [record('aaaaaaaa', 10, 'x'), record('bbbbbbbb', 20, 'y')],
    [{ id: 'aaaaaaaa', to: 13.4567 }], 1.25, 'nudged-now'
  );
  assert.strictEqual(nudged[0].offset_sec, 12.207);
  assert.strictEqual(nudged[0].updated_at, 'nudged-now');
  assert.strictEqual(nudged[1].offset_sec, 20);
  assert.strictEqual(TSLib.recordSignature(record('aaaaaaaa', 10, 'x')),
    TSLib.recordSignature(Object.assign({}, record('aaaaaaaa', 10, 'x'))));
}

{
  const multiline = 'id,timecode,offset_sec,by,memo,native,channel,stream_id,started_at,created_at,updated_at,deleted,clock_skew_ms\r\n' +
    'aaaaaaaa,00:00:10,10,a,"first\r\nsecond",false,ch,s,,,,false,0\r\n' +
    'bbbbbbbb,00:00:20,20,b,ok,false,ch,s,,,,false,0\r\n' +
    'cccccccc,00:00:30,nope,c,false,ch,s,,,,false,0\r\n';
  const parsed = TSLib.parseCsv(multiline);
  assert.strictEqual(parsed.records.length, 2);
  assert.deepStrictEqual(parsed.skippedRows, [5]);
}

if (process.argv.includes('--write-sample')) {
  fs.writeFileSync(path.resolve(__dirname, '../samples/sample.csv'), csv, 'utf8');
}
// Old DualPlayer exports (Timecode, Seconds, Note, Has Screenshot, Thumbnail) are detected and converted.
{
  const dpCsv = 'Timecode,Seconds,Note,Has Screenshot,Thumbnail (Base64)\n' +
    '01:24:48:06,5088.219,"ゲイバーの話",No,""\n' +
    '01:38:15:14,5895.489,"狙った, ""相手""\n二行目",Yes,"data:image/jpeg;base64,/9j/4AAQ=="\n' +
    'xx,abc,"bad",No,""\n';
  const dpTsv = 'Timecode\tSeconds\tNote\tHas Screenshot\tThumbnail (Base64)\n01:24:48:06\t5088.219\t"ゲイバーの話"\tNo\t""\n';
  assert.deepStrictEqual(TSLib.detectCsvFormat(dpCsv), { format: 'dualplayer', delimiter: ',' });
  assert.deepStrictEqual(TSLib.detectCsvFormat(dpTsv), { format: 'dualplayer', delimiter: '\t' });
  assert.strictEqual(TSLib.detectCsvFormat(TSLib.toCsv([])).format, 'sync');
  assert.strictEqual(TSLib.detectCsvFormat('\uFEFFName,Description,In,Out\n').format, 'unknown');
  const streamId = TSLib.dualPlayerStreamId('D:\\Footage\\_261007');
  assert.strictEqual(streamId, TSLib.dualPlayerStreamId('d:/footage/_261007'));           // path form / case independent
  const opts = { streamId: streamId, channel: '_261007', updatedAt: '2026-10-08T00:00:00.000Z' };
  const first = TSLib.convertDualPlayer(dpCsv, opts);
  assert.strictEqual(first.records.length, 2);
  assert.deepStrictEqual(first.skippedRows, [5]); // physical line: the quoted memo above spans two lines
  assert.strictEqual(first.records[0].offset_sec, 5088.219);
  assert.strictEqual(first.records[1].memo, '狙った, "相手"\n二行目');
  assert.ok(first.records.every(r => r.by === 'dualplayer' && r.stream_id === streamId && r.channel === '_261007' && TSLib.isValidId(r.id)));
  assert.ok(!/base64/.test(TSLib.toCsv(first.records)));                                   // thumbnails are not carried over
  // TSV gives the same ids for the same stamp.
  assert.strictEqual(TSLib.convertDualPlayer(dpTsv, opts).records[0].id, first.records[0].id);
  // Re-export with an edited note (newer file) merges as an update, not a duplicate.
  const edited = TSLib.convertDualPlayer(dpCsv.replace('ゲイバーの話', 'ゲイバーの話（修正）'), Object.assign({}, opts, { updatedAt: '2026-10-09T00:00:00.000Z' }));
  const merged = TSLib.mergeIntoSync(first.records, [edited.records]);
  assert.deepStrictEqual([merged.added, merged.updated, merged.records.length], [0, 1, 2]);
  assert.strictEqual(merged.records[0].memo, 'ゲイバーの話（修正）');
  // Existing sync-format parsing is unaffected by the delimiter parameter.
  assert.strictEqual(TSLib.parseCsv(TSLib.toCsv(first.records)).records.length, 2);
}

// Review of 57e0395 — import safety.
{
  const streamId = TSLib.dualPlayerStreamId('D:/Footage/_261007');
  const dp = (rows) => 'Timecode,Seconds,Note,Has Screenshot,Thumbnail (Base64)\n' +
    rows.map(r => '00:00:00:00,' + r[0] + ',"' + r[1] + '",No,""').join('\n') + '\n';
  const t1 = '2026-10-08T00:00:00.000Z', t2 = '2026-10-09T00:00:00.000Z', t3 = '2026-10-10T00:00:00.000Z';
  const conv = (text, at) => TSLib.convertDualPlayer(text, { streamId: streamId, channel: '_261007', updatedAt: at });

  // H1: a re-export never reverts edits made in the app (move / rename / delete) after the first import.
  const first = conv(dp([[10, 'a'], [20, 'b'], [30, 'c']]), t1).records;
  const id = (sec) => first.find(r => r.offset_sec === sec).id;
  const afterSync = first.map(r => {
    if (r.offset_sec === 10) return Object.assign({}, r, { offset_sec: 12, updated_at: t2 });            // moved in the app
    if (r.offset_sec === 20) return Object.assign({}, r, { memo: 'b renamed', updated_at: t2 });         // renamed in the app
    if (r.offset_sec === 30) return Object.assign({}, r, { deleted: true, updated_at: t2 });             // deleted in the app
    return r;
  });
  const reexport = conv(dp([[10, 'a'], [20, 'b'], [30, 'c'], [40, 'd']]), t3).records;
  const m = TSLib.mergeIntoSync(afterSync, [reexport]);
  const byId = new Map(m.records.map(r => [r.id, r]));
  assert.deepStrictEqual([m.added, m.updated, m.keptEdited], [1, 0, 3]);
  assert.strictEqual(byId.get(id(10)).offset_sec, 12);
  assert.strictEqual(byId.get(id(20)).memo, 'b renamed');
  assert.strictEqual(byId.get(id(30)).deleted, true);                                               // tombstone not revived
  // ...but an untouched imported row still takes a note edited in DualPlayer.
  const m2 = TSLib.mergeIntoSync(first, [conv(dp([[10, 'a2'], [20, 'b'], [30, 'c']]), t3).records]);
  assert.deepStrictEqual([m2.added, m2.updated, m2.keptEdited], [0, 1, 0]);

  // M1: two stamps at the same millisecond keep both notes, with stable ids.
  const same = conv(dp([[5, 'first'], [5, 'second']]), t1).records;
  assert.strictEqual(same.length, 2);
  assert.deepStrictEqual(same.map(r => r.memo).sort(), ['first', 'second']);
  assert.deepStrictEqual(conv(dp([[5, 'first'], [5, 'second']]), t1).records.map(r => r.id), same.map(r => r.id));

  // M4: the same id under another stream is re-keyed (stably), never overwriting the other stream's row.
  const mine = [Object.assign({}, first[0], { stream_id: 'local-aaaa0000', channel: 'seq' })];
  const theirs = [Object.assign({}, first[0], { memo: 'other stream', updated_at: t3 })];
  const r1 = TSLib.mergeIntoSync(mine, [theirs]);
  assert.strictEqual(r1.rekeyed, 1);
  assert.strictEqual(r1.records.length, 2);
  assert.strictEqual(r1.records.find(r => r.id === first[0].id).stream_id, 'local-aaaa0000');
  const r2 = TSLib.mergeIntoSync(r1.records, [theirs]);                                               // merging again adds nothing
  assert.deepStrictEqual([r2.added, r2.records.length], [0, 2]);

  // Moderator rows (per-row times) still follow later-wins, but never revive a tombstone.
  const mod = Object.assign({}, first[1], { by: 'mod', created_at: t1, updated_at: t1 });
  const modEdited = Object.assign({}, mod, { memo: 'mod fix', updated_at: t3 });
  assert.strictEqual(TSLib.mergeIntoSync([mod], [[modEdited]]).records[0].memo, 'mod fix');
  const tomb = Object.assign({}, mod, { deleted: true, updated_at: t2 });
  assert.strictEqual(TSLib.mergeIntoSync([tomb], [[modEdited]]).records[0].deleted, true);

  // Re-review: the result does not depend on the order of the selected files; a re-key is counted once.
  const base = Object.assign({}, mod, { deleted: false });
  const tombIn = Object.assign({}, base, { deleted: true, updated_at: t2 });
  const liveIn = Object.assign({}, base, { memo: 'newer', updated_at: t3 });
  const orderA = TSLib.mergeIntoSync([base], [[tombIn], [liveIn]]).records[0];
  const orderB = TSLib.mergeIntoSync([base], [[liveIn], [tombIn]]).records[0];
  assert.deepStrictEqual([orderA.memo, orderA.deleted], ['newer', false]);
  assert.deepStrictEqual([orderB.memo, orderB.deleted], ['newer', false]);
  const otherStream = Object.assign({}, base, { stream_id: 'other-stream' });
  const k1 = TSLib.mergeIntoSync([base], [[otherStream]]);
  const k2 = TSLib.mergeIntoSync(k1.records, [[otherStream]]);
  assert.deepStrictEqual([k1.rekeyed, k2.rekeyed, k2.added], [1, 0, 0]);
  assert.ok(!JSON.stringify(k1.records).includes('rekeyed'));

  // L1: a sync CSV with a blank or comma-only first line is still detected as sync.
  assert.strictEqual(TSLib.detectCsvFormat('"",""\r\n' + TSLib.toCsv(first).replace(/^﻿/, '')).format, 'sync');
  const syncText = TSLib.toCsv(first).replace(/^\uFEFF/, '');
  assert.strictEqual(TSLib.detectCsvFormat('\r\n' + syncText).format, 'sync');
  assert.strictEqual(TSLib.detectCsvFormat(',,,,\r\n' + syncText).format, 'sync');

  // L3: names are cut by characters, so an emoji is never split.
  const emojiName = TSLib.frameFileName(1, 30, 'x'.repeat(59) + '😀');
  assert.ok(emojiName.endsWith('x😀.png'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiName));

  // afterImport: additions alone run without asking; any other change stops at the drawer.
  const plan = (kinds) => ({ preview: kinds.map(k => ({ kind: k })), appOps: [] });
  const entry = { lastSyncAt: t2 };
  assert.deepStrictEqual(TSLib.syncConfirmReasons({ plan: plan(['add-app', 'add-csv']), entry: entry, afterImport: true }), []);
  assert.deepStrictEqual(TSLib.syncConfirmReasons({ plan: plan(['add-app', 'memo']), entry: entry, afterImport: true }), ['取り込み後の変更']);
  assert.deepStrictEqual(TSLib.syncConfirmReasons({ plan: plan(['memo']), entry: entry }), []);          // normal syncs unchanged
}

// recordsFromMarkers: creating a new sync CSV from the active sequence's markers.
{
  const streamId = TSLib.localStreamId('D:\\proj\\a.prproj', 'seq-1');
  assert.strictEqual(streamId, TSLib.localStreamId('D:\\proj\\a.prproj', 'seq-1'));      // stable
  assert.notStrictEqual(streamId, TSLib.localStreamId('D:\\proj\\a.prproj', 'seq-2'));   // per sequence
  assert.ok(/^local-[0-9a-f]{8}$/.test(streamId));
  const markers = [
    { index: 0, id: null, t: 20, memo: 'Opening', by: 'editor' },          // untagged → new id + tag op
    { index: 1, id: 'yaaaaaa1', t: 90, memo: '見どころ\n二行目', by: '' },   // tagged → keeps id
    { index: 2, id: 'yaaaaaa1', t: 95, memo: 'copy', by: '' },              // duplicate tag → new id + tag op
    { index: 3, id: null, t: 100, memo: '00:01:40', by: '' },               // timecode name → empty memo
    { index: 4, id: null, t: NaN, memo: 'bad', by: '' }                      // unreadable time → skipped
  ];
  const out = TSLib.recordsFromMarkers({ appMarkers: markers, streamId: streamId, channel: 'seqA', by: 'premiere', now: '2026-10-10T00:00:00.000Z' });
  assert.strictEqual(out.records.length, 4);
  assert.strictEqual(out.tagOps.length, 3);
  assert.deepStrictEqual(out.tagOps.map(op => op.index), [0, 2, 3]);
  const at = t => out.records.find(r => r.offset_sec === t);
  assert.strictEqual(at(90).id, 'yaaaaaa1');
  assert.notStrictEqual(at(95).id, 'yaaaaaa1');
  assert.ok(TSLib.isValidId(at(20).id) && at(20).id === out.tagOps[0].id);
  assert.strictEqual(at(20).by, 'editor');
  assert.strictEqual(at(90).by, 'premiere');
  assert.strictEqual(at(100).memo, '');
  assert.strictEqual(at(90).memo, '見どころ\n二行目');
  assert.ok(out.records.every(r => r.stream_id === streamId && r.channel === 'seqA' && r.started_at === '' && r.native === false && !r.deleted));
  // CSV round trip: no unreadable rows, no id repairs, same content.
  const parsed = TSLib.parseCsv(TSLib.toCsv(out.records));
  assert.strictEqual(parsed.skippedRows.length, 0);
  assert.strictEqual(parsed.repaired, 0);
  assert.deepStrictEqual(parsed.records.map(r => [r.id, r.offset_sec, r.memo, r.by]), out.records.map(r => [r.id, r.offset_sec, r.memo, r.by]));
  // The new file loads as one stream group.
  assert.strictEqual(TSLib.groupByStream(parsed.records).length, 1);
}

// frameFileName: exported marker frame names are Windows-safe and stable.
assert.strictEqual(TSLib.frameFileName(20, 30, 'Opening'), '00-00-20-00_Opening.png');
assert.strictEqual(TSLib.frameFileName(3661, 30, 'a/b:c*d?"e<f>g|h'), '01-01-01-00_a_b_c_d__e_f_g_h.png');
assert.strictEqual(TSLib.frameFileName(100, 30, ''), '00-01-40-00.png');
assert.strictEqual(TSLib.frameFileName(90, 30, '見どころ\n二行目'), '00-01-30-00_見どころ_二行目.png');
assert.strictEqual(TSLib.frameFileName(1.5, 59.94, 'x'), '00-00-01-29_x.png');
assert.strictEqual(TSLib.frameFileName(0, 30, '  trailing...  '), '00-00-00-00_trailing.png');
assert.strictEqual(TSLib.frameFileName(5, 30, 'x'.repeat(80)), '00-00-05-00_' + 'x'.repeat(60) + '.png');

// mergeIntoSync: merging moderators' CSVs into the sync file.
{
  const row = (id, offset, updatedAt, extra) => Object.assign({
    id: id, offset_sec: offset, by: 'mod', memo: '', native: false, channel: 'alpha', stream_id: 's1',
    started_at: '2026-01-02T03:04:05Z', created_at: '2026-01-02T03:05:00Z', updated_at: updatedAt, deleted: false, clock_skew_ms: 0
  }, extra || {});
  const sync = [row('yaaaaaa1', 10, '2026-01-02T03:05:00Z'), row('yaaaaaa2', 20, '2026-01-02T03:06:00Z', { memo: 'keep' })];
  const modA = [
    row('ybbbbbb1', 30, '2026-01-02T03:07:00Z'),                                 // new
    row('yaaaaaa1', 11, '2026-01-02T04:00:00Z', { memo: 'newer' }),              // newer update wins
    row('yaaaaaa2', 99, '2026-01-01T00:00:00Z', { memo: 'older' })               // older update ignored
  ];
  const modB = [
    row('ycccccc1', 40, '2026-01-02T03:08:00Z', { stream_id: 's2', channel: 'beta' }), // other stream kept
    row('ybbbbbb1', 30, '2026-01-02T05:00:00Z', { deleted: true })                       // tombstone carried
  ];
  const result = TSLib.mergeIntoSync(sync, [modA, modB]);
  const byId = new Map(result.records.map(r => [r.id, r]));
  assert.strictEqual(result.records.length, 4);
  assert.strictEqual(result.added, 2);       // ybbbbbb1, ycccccc1
  assert.strictEqual(result.updated, 1);     // yaaaaaa1
  assert.strictEqual(result.unchanged, 1);   // yaaaaaa2
  assert.strictEqual(byId.get('yaaaaaa1').memo, 'newer');
  assert.strictEqual(byId.get('yaaaaaa1').offset_sec, 11);
  assert.strictEqual(byId.get('yaaaaaa2').memo, 'keep');
  assert.strictEqual(byId.get('ybbbbbb1').deleted, true);
  assert.strictEqual(byId.get('ycccccc1').stream_id, 's2');
  // Merging the same files again changes nothing.
  const again = TSLib.mergeIntoSync(result.records, [modA, modB]);
  assert.deepStrictEqual([again.added, again.updated, again.unchanged], [0, 0, 4]);
  // Round trip through CSV keeps the merge idempotent (what the panel actually writes and re-reads).
  const reparsed = TSLib.parseCsv(TSLib.toCsv(result.records)).records;
  const third = TSLib.mergeIntoSync(reparsed, [modA, modB]);
  assert.deepStrictEqual([third.added, third.updated], [0, 0]);
  // Nothing incoming.
  assert.deepStrictEqual(TSLib.mergeIntoSync(sync, []).added, 0);
}

// Floating widget position: round trip, and clamping when the window shrinks.
{
  const fr = TSLib.posToFractions(800, 500, 100, 40, 1000, 600);
  assert.deepStrictEqual(fr, { right: 0.1, bottom: 0.1 });
  assert.deepStrictEqual(TSLib.fractionsToPos(fr, 100, 40, 1000, 600), { left: 800, top: 500 });
  // Same fractions in a smaller window keep the corner-relative gap proportionally.
  assert.deepStrictEqual(TSLib.fractionsToPos(fr, 100, 40, 500, 300), { left: 350, top: 230 });
  // Off-screen / oversized values are clamped inside the viewport (4px margin).
  assert.deepStrictEqual(TSLib.fractionsToPos({ right: 5, bottom: -1 }, 100, 40, 1000, 600), { left: 4, top: 556 });
  assert.deepStrictEqual(TSLib.fractionsToPos(null, 100, 40, 1000, 600), { left: 896, top: 556 });
  // A widget wider than the viewport sticks to the left margin.
  assert.deepStrictEqual(TSLib.fractionsToPos({ right: 0, bottom: 0 }, 1200, 40, 1000, 600).left, 4);
}

// サーバー鏡 CSV のパス・push 対象・サーバー取り込み・meta の形
// Server mirror CSV path, records to push, merging server records, and the meta shape.
{
  assert.strictEqual(TSLib.serverMirrorPath('C:/u/data', 'https://a.b.workers.dev', 'vod-12'), 'C:/u/data/server/a.b.workers.dev/vod-12_sync.csv');
  assert.strictEqual(TSLib.serverMirrorPath('/d', 'https://h', 'x/../y'), '/d/server/h/x_.._y_sync.csv');
  // 末尾の区切りは 1 つにまとめ、host:port の : は _ に / A trailing separator is dropped; the : of host:port becomes _
  assert.strictEqual(TSLib.serverMirrorPath('/d/', 'https://h:8443/x', 'a b'), '/d/server/h_8443/a_b_sync.csv');
  // ドットだけの host はフォルダ移動になるので拒否 / A dots-only host would climb folders, so it is rejected
  ['https://.', 'https://..', 'https://...'].forEach((url) => {
    assert.throws(() => TSLib.serverMirrorPath('/d', url, 's'), /ホスト名が不正です \/ invalid server host/);
  });
  const p = TSLib.recordsToPush([{ id: 'a', updated_at: '2026-01-02T00:00:00.000Z', offset_sec: 1, created_at: '2026-01-01T00:00:00.000Z', by: 'u', memo: '', stream_id: 's', channel: 'c', started_at: '2026-01-01T00:00:00.000Z' }, { id: 'b', updated_at: '2026-01-01T00:00:00.000Z', offset_sec: 2, created_at: '2026-01-01T00:00:00.000Z', by: 'u', memo: '', stream_id: 's', channel: 'c', started_at: '2026-01-01T00:00:00.000Z' }], '2026-01-01T12:00:00.000Z');
  assert.deepStrictEqual(p.map(r => r.id), ['a']); assert.strictEqual(p[0].timecode, '00:00:01');
  assert.strictEqual(TSLib.recordsToPush([{ id: 'c', created_at: '2026-01-01T00:00:00.000Z', offset_sec: 0, by: 'u', memo: '', stream_id: 's', channel: 'c', started_at: '2026-01-01T00:00:00.000Z' }], '').length, 1);
  // mergeRecords は不正な id を legacyId に置き換えるので、サーバーと同じく正しい id を使う
  // mergeRecords replaces invalid ids with legacyId, so use valid ids as the server does.
  const m = TSLib.mergeServerRecords([{ id: 'y00000aa', memo: 'old', updated_at: '2026-01-01T00:00:00.000Z' }], [{ id: 'y00000aa', memo: 'new', updated_at: '2026-01-02T00:00:00.000Z' }, { id: 'y00000ff', memo: '', updated_at: '2026-01-02T00:00:00.000Z' }]);
  assert.strictEqual(m.records.find(r => r.id === 'y00000aa').memo, 'new'); assert.strictEqual(m.changed, 2);
  // 同じ内容をもう一度取り込んでも変化なし / Merging the same records again changes nothing
  assert.strictEqual(TSLib.mergeServerRecords(m.records, m.records).changed, 0);
  // ローカルの方が新しければローカルが残り、変化なし / A newer local record stays and counts as no change
  const keep = TSLib.mergeServerRecords([{ id: 'y00000aa', memo: 'mine', updated_at: '2026-01-03T00:00:00.000Z' }], [{ id: 'y00000aa', memo: 'new', updated_at: '2026-01-02T00:00:00.000Z' }]);
  assert.strictEqual(keep.records[0].memo, 'mine'); assert.strictEqual(keep.changed, 0);
  assert.strictEqual(TSLib.isServerMeta({ serverUrl: 'https://h', stream_id: 's', channel: 'c' }), true); assert.strictEqual(TSLib.isServerMeta({}), false);

  // forceIds: 直前の push で forbidden_tombstone になった id は、ローカルの墓標が新しくてもサーバーの生存記録で上書き
  // forceIds: ids rejected as forbidden_tombstone by the last push take the server's live record even over a newer local tombstone.
  const tomb = [{ id: 'y00000aa', memo: 'x', offset_sec: 5, deleted: true, updated_at: '2026-01-05T00:00:00.000Z' }];
  const live = [{ id: 'y00000aa', memo: 'theirs', offset_sec: 5, deleted: false, updated_at: '2026-01-02T00:00:00.000Z' }];
  const noForce = TSLib.mergeServerRecords(tomb, live);
  assert.strictEqual(noForce.records[0].deleted, true); assert.strictEqual(noForce.changed, 0);
  const forced = TSLib.mergeServerRecords(tomb, live, { forceIds: ['y00000aa'] });
  assert.strictEqual(forced.records.length, 1);
  assert.strictEqual(forced.records[0].deleted, false); assert.strictEqual(forced.records[0].memo, 'theirs');
  assert.strictEqual(forced.records[0].updated_at, '2026-01-02T00:00:00.000Z'); assert.strictEqual(forced.changed, 1);
  // サーバーも墓標なら戻すものは無い / Nothing to restore when the server also has a tombstone
  const bothDead = TSLib.mergeServerRecords(tomb, [Object.assign({}, live[0], { deleted: true })], { forceIds: ['y00000aa'] });
  assert.strictEqual(bothDead.records[0].deleted, true); assert.strictEqual(bothDead.changed, 0);
  // ローカルが生存（墓標でない）なら通常の updated_at 勝ち / A live local record follows the usual newer-wins rule
  const localLive = TSLib.mergeServerRecords([Object.assign({}, tomb[0], { deleted: false, memo: 'mine' })], live, { forceIds: ['y00000aa'] });
  assert.strictEqual(localLive.records[0].memo, 'mine'); assert.strictEqual(localLive.changed, 0);
  // forceIds に無い id には効かない / Ids not in forceIds are unaffected
  assert.strictEqual(TSLib.mergeServerRecords(tomb, live, { forceIds: ['y00000ff'] }).records[0].deleted, true);

  // nextPushAt: 応答が揃えば push 開始時刻へ進め、throw（retryable でもそうでなくても）なら前の値のまま
  // nextPushAt: advances to the push start time on a full response; keeps the previous value when the push threw (retryable or not).
  const started = '2026-01-10T00:00:00.000Z';
  const previous = '2026-01-01T00:00:00.000Z';
  assert.strictEqual(TSLib.nextPushAt({ accepted: ['a'], rejected: [] }, started, previous), started);
  // 記録ごとの拒否（stale・forbidden_*）は再送しないので進める / Per-record rejections are not resent, so it advances
  assert.strictEqual(TSLib.nextPushAt({ accepted: [], rejected: [{ id: 'b', reason: 'forbidden_tombstone' }, { id: 'c', reason: 'stale' }] }, started, previous), started);
  const retry = Object.assign(new Error('503'), { retryable: true, partial: { accepted: ['a'], rejected: [] } });
  assert.strictEqual(TSLib.nextPushAt(retry, started, previous), previous);
  const denied = Object.assign(new Error('401'), { retryable: false, status: 401, partial: { accepted: [], rejected: [] } });
  assert.strictEqual(TSLib.nextPushAt(denied, started, previous), previous);
  assert.strictEqual(TSLib.nextPushAt(null, started, ''), '');
}

// ExtendScript's $.evalFile decodes BOM-less files with the system code page (cp932) and fails on UTF-8 Japanese.
for (const jsx of ['ppro.jsx', 'aeft.jsx']) {
  const head = fs.readFileSync(path.resolve(__dirname, '../panel/jsx/' + jsx)).subarray(0, 3);
  assert.deepStrictEqual([...head], [0xef, 0xbb, 0xbf], jsx + ' must start with a UTF-8 BOM');
}

// The CEP panel ships a copy of lib.js (made by panel/install.ps1); fail if it is stale.
const panelLib = path.resolve(__dirname, '../panel/js/lib.js');
if (fs.existsSync(panelLib)) {
  assert.strictEqual(fs.readFileSync(panelLib, 'utf8'), fs.readFileSync(path.resolve(__dirname, '../extension/lib.js'), 'utf8'),
    'panel/js/lib.js is stale: re-run panel/install.ps1');
}

// Web ページも lib.js の複製を配る（service で `npm run build:web`）。古ければ失敗させる
// The web pages ship a copy of lib.js (made by `npm run build:web` in service/); fail if it is stale.
assert.ok(fs.readFileSync(path.resolve(__dirname, '../service/web/js/lib.js')).equals(fs.readFileSync(panelLib)),
  'service/web/js/lib.js is stale: re-run `npm run build:web` in service/');
console.log('all tests passed');
