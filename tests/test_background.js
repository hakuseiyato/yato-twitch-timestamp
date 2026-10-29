'use strict';

// background.js を偽 chrome の上で動かし、打刻の実フローを確かめる
// Run background.js on a fake chrome and check the real stamp flow.
const assert = require('assert');
const { createFakeChrome, loadBackground, fakeFetch } = require('./fake_chrome.js');

async function testStampWithoutEditorFallsBackToLocal() {
  // 時計を固定し、Twitch の時計を 3 秒進んでいることにする
  // Freeze the clock and make Twitch's clock 3 s ahead.
  const pressedAt = Date.parse('2026-10-30T10:10:05Z');
  const serverDate = new Date(pressedAt + 3000).toUTCString();
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
      respond: () => ({ status: 200, headers: { Date: serverDate }, body: { data: [{ id: '999', type: 'live', started_at: '2026-10-30T10:00:00Z', user_id: '55' }] } }) }
  ]);
  const bg = loadBackground(fc, fetchImpl);
  assert.strictEqual(typeof fc.calls.messageHandler, 'function');

  // content.js が送る形 / The shape content.js sends
  const realNow = Date.now;
  Date.now = () => pressedAt;
  let res;
  try {
    res = await bg.handleMessage({ type: 'stamp', url: 'https://www.twitch.tv/terano_naa', memo: 'm', pressedAt: pressedAt });
  } finally {
    Date.now = realNow;
  }
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
  // 605 秒 + 時計ずれ 3 秒 - 遅延 5 秒 / 605 s + 3 s clock skew - 5 s lag
  assert.strictEqual(record.clock_skew_ms, 3000);
  assert.strictEqual(record.offset_sec, 603);
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

const DEFAULT_CLIENT_ID = '105fdov1w7trd0swseu50l5qy2sckg';
const PROD_ORIGIN = 'https://yato-twitch-timestamp.hakuseiyato.workers.dev';

async function testSaveSettingsServerUrl() {
  const fc = createFakeChrome({ settings: { clientId: 'cid', lagSec: 5 }, auth: { token: 'tok', login: 'mod1', userId: '1' }, records: [] });
  const bg = loadBackground(fc, fakeFetch([]));
  // 既定値 / Defaults
  let state = await bg.handleMessage({ type: 'getState' });
  assert.strictEqual(state.settings.serverUrl, '');
  assert.strictEqual(state.serverPermission, false);

  // https 以外・パス付きは拒否 / Non-https and URLs with a path are rejected
  const urlError = { message: 'サーバー URL は https://ホスト名 の形で入力してください / Server URL must be https://host' };
  for (const bad of ['http://x', 'https://h/path', 'not a url', 'https://h/?q=1', 'https://h/#x']) {
    await assert.rejects(bg.handleMessage({ type: 'saveSettings', settings: { clientId: 'cid', lagSec: 5, serverUrl: bad } }), urlError, bad);
  }
  assert.strictEqual(fc.storage.settings.serverUrl, undefined);

  // 末尾の / を落として origin で保存 / Stored as the origin without the trailing slash
  const saved = await bg.handleMessage({ type: 'saveSettings', settings: { clientId: 'cid', lagSec: 5, serverUrl: '  ' + PROD_ORIGIN + '/  ' } });
  assert.strictEqual(saved.settings.serverUrl, PROD_ORIGIN);
  assert.strictEqual(fc.storage.settings.serverUrl, PROD_ORIGIN);
  assert.strictEqual(saved.reloginRequired, false);
  state = await bg.handleMessage({ type: 'getState' });
  assert.strictEqual(state.settings.serverUrl, PROD_ORIGIN);

  // 権限は偽 chrome.permissions の中身に従う / The permission follows the fake chrome.permissions contents
  assert.strictEqual(state.serverPermission, false);
  assert.strictEqual(await bg.hasHostPermission(PROD_ORIGIN), false);
  fc.calls.permissions.add(PROD_ORIGIN + '/*');
  state = await bg.handleMessage({ type: 'getState' });
  assert.strictEqual(state.serverPermission, true);
  assert.strictEqual(await bg.hasHostPermission(PROD_ORIGIN), true);
  assert.strictEqual(await bg.hasHostPermission(''), false);

  // 空欄は未設定に戻す / An empty value clears the setting
  const cleared = await bg.handleMessage({ type: 'saveSettings', settings: { clientId: 'cid', lagSec: 5, serverUrl: '' } });
  assert.strictEqual(cleared.settings.serverUrl, '');
  state = await bg.handleMessage({ type: 'getState' });
  assert.strictEqual(state.serverPermission, false);
}

async function testSaveSettingsEmptyClientIdUsesDefault() {
  const fc = createFakeChrome({});
  const bg = loadBackground(fc, fakeFetch([]));
  let state = await bg.handleMessage({ type: 'getState' });
  assert.strictEqual(state.settings.clientId, DEFAULT_CLIENT_ID);
  const saved = await bg.handleMessage({ type: 'saveSettings', settings: { clientId: '  ', lagSec: 3 } });
  assert.strictEqual(saved.settings.clientId, DEFAULT_CLIENT_ID);
  assert.strictEqual(fc.storage.settings.clientId, DEFAULT_CLIENT_ID);
  assert.strictEqual(fc.storage.settings.lagSec, 3);
  assert.strictEqual(fc.storage.settings.serverUrl, '');
}

(async () => {
  await testStampWithoutEditorFallsBackToLocal();
  await testUnmockedFetchIsReported();
  await testSaveSettingsServerUrl();
  await testSaveSettingsEmptyClientIdUsesDefault();
  console.log('all tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
