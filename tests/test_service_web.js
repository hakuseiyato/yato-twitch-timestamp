'use strict';

// Web ページ側の純粋ロジック（service/web/js）のテスト。`node tests/test_service_web.js` で実行
// Tests for the web page's pure logic (service/web/js). Run with `node tests/test_service_web.js`.
const assert = require('assert');
const Bins = require('../service/web/js/bins.js');
const Chat = require('../service/web/js/chat-fetch.js');
const Api = require('../service/web/js/api.js');
const Graph = require('../service/web/js/graph.js');
const page = require('../service/test/fixtures/gql_comments_page.json');

// ビン分け / Binning
assert.deepStrictEqual(Array.from(Bins.binCounts([0, 29, 30, 31, 95], 30, 100)), [2, 2, 0, 1]);
assert.deepStrictEqual(Array.from(Bins.binCounts([-1, 100, 120, NaN, 50], 30, 100)), [0, 1, 0, 1]);
assert.strictEqual(Bins.binCounts([], 30, 0).length, 1);
assert.deepStrictEqual(Bins.peakBins(Uint32Array.from([1, 5, 5, 2]), 2), [1, 2]);
assert.deepStrictEqual(Bins.peakBins(Uint32Array.from([3, 1, 9, 3]), 2), [0, 2]);
assert.strictEqual(Bins.binIndex(59.9, 30), 1);

// コメント整形 / Comment normalisation
const nodes = page[0].data.video.comments.edges.map(e => e.node);
const c = Chat.normalizeComment(nodes[1]);
assert.strictEqual(c[0], 66); assert.strictEqual(c[1], 'frozencoola'); assert.strictEqual(c[2], 'FROZENCOOLA'); assert.ok(c[3].length > 0);
assert.strictEqual(c.length, 4);
assert.strictEqual(Chat.normalizeComment({ ...nodes[0], commenter: null })[1], '');
assert.strictEqual(Chat.normalizeComment({ ...nodes[0], commenter: null })[2], '');
assert.strictEqual(Chat.normalizeComment(nodes[0])[3], 'Sery_Bot は seryboArrive です');
assert.strictEqual(Chat.normalizeComment({ ...nodes[0], message: undefined }), null);
const parsed = Chat.parseCommentsPage(page);
assert.strictEqual(parsed.comments.length, 3);
assert.strictEqual(parsed.hasNextPage, true);
assert.strictEqual(parsed.cursor, page[0].data.video.comments.edges[2].cursor);
assert.throws(() => Chat.parseCommentsPage([{ data: { video: null } }]), /VOD not found/);

// VOD ID / VOD id
assert.strictEqual(Chat.parseVodId('https://www.twitch.tv/videos/2913861877?t=1h2m'), '2913861877');
assert.strictEqual(Chat.parseVodId('twitch.tv/videos/123?t=1h'), '123');
assert.strictEqual(Chat.parseVodId('https://m.twitch.tv/videos/456#x'), '456');
assert.strictEqual(Chat.parseVodId(' 789 '), '789');
assert.strictEqual(Chat.parseVodId('abc'), null);
assert.strictEqual(Chat.parseVodId('https://www.twitch.tv/somebody'), null);

// Helix の duration / Helix duration
assert.strictEqual(Chat.parseHelixDuration('1h3m21s'), 3801);
assert.strictEqual(Chat.parseHelixDuration('3m21s'), 201);
assert.strictEqual(Chat.parseHelixDuration('45s'), 45);
assert.strictEqual(Chat.parseHelixDuration('2h'), 7200);
assert.ok(Number.isNaN(Chat.parseHelixDuration('')));
assert.ok(Number.isNaN(Chat.parseHelixDuration('1x')));

// VOD の選択 / VOD selection
assert.strictEqual(Chat.pickVod([{id:'a', createdAt:'2026-10-29T11:49:03Z'}, {id:'b', createdAt:'2026-10-28T11:00:00Z'}], '2026-10-29T11:48:00Z').id, 'a');
assert.strictEqual(Chat.pickVod([{id:'b', createdAt:'2026-10-28T11:00:00Z'}], '2026-10-29T11:48:00Z'), null);
assert.strictEqual(Chat.pickVod([{id:'x', createdAt:'garbage'}, {id:'a', createdAt:'2026-10-29T12:10:00Z'}], '2026-10-29T11:48:00Z').id, 'a');
assert.strictEqual(Chat.pickVod([{id:'x', createdAt:'garbage'}], '2026-10-29T11:48:00Z'), null);

// チャット JSON / Chat JSON
const j = JSON.parse(Chat.buildChatJson('1', 100, [[1,'a','A','x']]));
assert.deepStrictEqual(j.comments, [[1,'a','A','x']]); assert.strictEqual(j.vod_id, '1');
assert.strictEqual(j.length_sec, 100); assert.strictEqual(j.client, 'web/1.0');
assert.ok(!Number.isNaN(Date.parse(j.fetched_at)));

// 一覧の日時（ローカル時刻）/ List dates (local time)
assert.strictEqual(Api.formatDate(new Date(2026, 9, 29, 9, 5).toISOString()), '2026-10-29 09:05');
assert.strictEqual(Api.formatDate(''), '—');
assert.strictEqual(Api.formatDate(null), '—');

// コメント時刻の補正と探索 / Comment time shift and lookup
assert.deepStrictEqual(Array.from(Bins.shiftTimes([[10, 'a', 'A', 'x'], [2, 'b', 'B', 'y'], ['bad', 'c', 'C', 'z']], 1, 5)), [6, 0, 0]);
assert.deepStrictEqual(Array.from(Bins.shiftTimes([[10.5, 'a', 'A', 'x']], 0, 0)), [10.5]);
assert.strictEqual(Bins.firstAtOrAfter(Float64Array.from([0, 5, 5, 9]), 5), 1);
assert.strictEqual(Bins.firstAtOrAfter(Float64Array.from([0, 5, 5, 9]), 6), 3);
assert.strictEqual(Bins.firstAtOrAfter(Float64Array.from([0, 5, 5, 9]), 10), 4);
assert.strictEqual(Bins.firstAtOrAfter(Float64Array.from([]), 0), 0);

// グラフの目盛り間隔（ビン数）/ Graph label step (in bins)
assert.strictEqual(Graph.labelStep(30, 4), 20);
assert.strictEqual(Graph.labelStep(60, 10), 10);
assert.strictEqual(Graph.labelStep(120, 100), 1);
assert.strictEqual(Graph.labelStep(15, 0.01), 7200);

// 取得の拒否は最終ページ扱いにしない / A rejected fetch is never treated as the last page
assert.throws(() => Chat.parseCommentsPage([{ errors: [{ message: 'failed integrity check', extensions: { code: 'IntegrityCheckFailed' } }], data: { video: { id: '1', comments: null } } }]),
  /チャット取得が拒否されました \/ Chat fetch rejected: .*failed integrity check/);
assert.throws(() => Chat.parseCommentsPage([{ data: { video: { id: '1', comments: null } } }]), /Chat fetch rejected/);
assert.throws(() => Chat.parseCommentsPage([{ errors: [{ message: 'IntegrityCheckFailed' }], data: { video: { comments: { edges: [], pageInfo: {} } } } }]),
  /Chat fetch rejected: IntegrityCheckFailed/);
assert.throws(() => Chat.parseCommentsPage([{ errors: [{ message: 'x' }], data: { video: null } }]), /VOD not found/);

// ページ間の重複除去 / De-duplication across pages
const seenIds = new Set();
assert.strictEqual(Chat.mergeComments(seenIds, nodes).length, 3);
const page2 = [nodes[1], nodes[2], { ...nodes[2], id: 'new-id', contentOffsetSeconds: 999 }];
const fresh = Chat.mergeComments(seenIds, page2);
assert.deepStrictEqual(fresh.map(r => r[0]), [999]);
assert.strictEqual(Chat.mergeComments(seenIds, page2).length, 0);

// 次の cursor の判定: hasNextPage 偽 → null、真で cursor が無い（edges 空）→ 例外（空回りしない）
// Next-cursor decision: hasNextPage false -> null; true without a cursor (empty edges) -> throws (never spins)
assert.strictEqual(Chat.nextCursor(parsed), page[0].data.video.comments.edges[2].cursor);
assert.strictEqual(Chat.nextCursor({ hasNextPage: false, cursor: 'x' }), null);
const emptyNext = Chat.parseCommentsPage([{ data: { video: { comments: { edges: [], pageInfo: { hasNextPage: true } } } } }]);
assert.throws(() => Chat.nextCursor(emptyNext), /Next page cursor missing/);

// fetchVodChat: 1 ページ目は offset 0、以降は cursor・Client-ID は TwitchDownloader の値・重複なし
// fetchVodChat: page 1 by offset 0, then cursors; Client-ID is TwitchDownloader's; no duplicates
function fakeNode(id, sec) {
  return { id: id, contentOffsetSeconds: sec, commenter: { login: 'u', displayName: 'U' }, message: { fragments: [{ text: id }] } };
}
const fakePages = [
  [fakeNode('a', 1), fakeNode('b', 2)],
  [fakeNode('b', 2), fakeNode('c', 3)],
  [fakeNode('d', 4)]
];

(async function () {
  const sent = [];
  global.fetch = async function (url, init) {
    const v = JSON.parse(init.body)[0].variables;
    sent.push({ v: v, clientId: init.headers['Client-ID'] });
    const index = v.cursor === undefined ? 0 : Number(v.cursor.slice(1)) + 1;
    return { ok: true, status: 200, json: async () => [{ data: { video: { comments: {
      edges: fakePages[index].map(n => ({ cursor: 'p' + index, node: n })),
      pageInfo: { hasNextPage: index < fakePages.length - 1 } } } } }] };
  };
  const rows = await Chat.fetchVodChat('9', null, {});
  assert.deepStrictEqual(rows.map(r => r[3]), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(sent.map(s => s.v), [
    { videoID: '9', contentOffsetSeconds: 0 }, { videoID: '9', cursor: 'p0' }, { videoID: '9', cursor: 'p1' }
  ]);
  assert.ok(sent.every(s => s.clientId === 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp'));
  // 拒否は例外になる（黙って打ち切らない）/ A rejection throws (no silent truncation)
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [{ errors: [{ message: 'failed integrity check' }], data: { video: { comments: null } } }] });
  await assert.rejects(Chat.fetchVodChat('1', null, {}), /Chat fetch rejected/);
  // hasNextPage が真なのに edges が空 → 例外 / hasNextPage true with empty edges -> throws
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [{ data: { video: { comments: { edges: [], pageInfo: { hasNextPage: true } } } } }] });
  await assert.rejects(Chat.fetchVodChat('1', null, {}), /Next page cursor missing/);
  console.log('all tests passed');
}()).catch(function (e) { console.error(e); process.exit(1); });
