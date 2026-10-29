'use strict';

// background.js を偽 chrome の上で動かし、打刻の実フローを確かめる
// Run background.js on a fake chrome and check the real stamp flow.
const assert = require('assert');
const { createFakeChrome, loadBackground, fakeFetch } = require('./fake_chrome.js');

async function testStampWithoutEditorFallsBackToLocal() {
  const fc = createFakeChrome({
    settings: { clientId: 'cid', lagSec: 5 },
    auth: { token: 'tok', login: 'mod1', userId: '1' },
    records: []
  });
  // 編集者でないトークン: マーカー作成は 403 / Non-editor token: marker creation returns 403
  const fetchImpl = fakeFetch([
    { match: (u) => u.startsWith('https://id.twitch.tv/oauth2/validate'),
      respond: () => ({ status: 200, body: { client_id: 'cid', login: 'mod1', user_id: '1', scopes: ['channel:manage:broadcast'] } }) },
    { match: (u) => u === 'https://api.twitch.tv/helix/streams/markers',
      respond: () => ({ status: 403, body: { error: 'Forbidden', message: 'not an editor' } }) },
    { match: (u) => u.startsWith('https://api.twitch.tv/helix/streams?'),
      respond: () => ({ status: 200, body: { data: [{ id: '999', type: 'live', started_at: '2026-10-30T10:00:00Z', user_id: '55' }] } }) }
  ]);
  const bg = loadBackground(fc, fetchImpl);
  assert.strictEqual(typeof fc.calls.messageHandler, 'function');

  // content.js が送る形 / The shape content.js sends
  const res = await bg.handleMessage({
    type: 'stamp',
    url: 'https://www.twitch.tv/terano_naa',
    memo: 'm',
    pressedAt: Date.parse('2026-10-30T10:10:05Z')
  });
  assert.strictEqual(res.native, false);
  assert.strictEqual(res.warning, '');

  const state = await bg.readState();
  assert.strictEqual(state.records.length, 1);
  const record = state.records[0];
  assert.strictEqual(record.stream_id, '999');
  assert.strictEqual(record.by, 'mod1');
  assert.strictEqual(record.channel, 'terano_naa');
  assert.strictEqual(record.memo, 'm');
  assert.strictEqual(record.native, false);
  // 605 秒 - 遅延 5 秒。Date ヘッダが秒単位なので時計ずれで 1 秒ぶれる
  // 605 s minus 5 s lag; the second-resolution Date header can shift it by 1 s.
  assert.ok(record.offset_sec === 600 || record.offset_sec === 599, 'offset_sec=' + record.offset_sec);
  assert.deepStrictEqual(fc.storage.records, state.records);

  // validate → streams → markers の順に呼ぶ（stream に user_id があるので users は呼ばない）
  // Calls validate → streams → markers (users is skipped because the stream has user_id).
  assert.deepStrictEqual(fetchImpl.calls.map((c) => c.url), [
    'https://id.twitch.tv/oauth2/validate',
    'https://api.twitch.tv/helix/streams?user_login=terano_naa',
    'https://api.twitch.tv/helix/streams/markers'
  ]);
  assert.strictEqual(fetchImpl.calls[2].init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[2].init.body), { user_id: '55', description: '[mod1] m' });
  // 配信情報はセッション側にも控える / The stream is also remembered in session storage
  assert.strictEqual(fc.session.lastStreams.terano_naa.id, '999');
}

async function testUnmockedFetchIsReported() {
  const fetchImpl = fakeFetch([]);
  await assert.rejects(fetchImpl('https://example.com/x'), /unmocked fetch: https:\/\/example.com\/x/);
  assert.strictEqual(fetchImpl.calls.length, 1);
}

(async () => {
  await testStampWithoutEditorFallsBackToLocal();
  await testUnmockedFetchIsReported();
  console.log('all tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
