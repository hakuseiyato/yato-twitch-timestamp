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

const STAMPS_URL = PROD_ORIGIN + '/api/stamps';

// 送信テスト用の記録 / A record for upload tests
function makeRecord(id, streamId, extra) {
  return Object.assign({
    id: id, stream_id: streamId || '999', channel: 'terano_naa', started_at: '2026-10-30T10:00:00Z',
    offset_sec: 10, created_at: '2026-10-30T10:01:00Z', updated_at: '2026-10-30T10:01:00Z',
    deleted: false, clock_skew_ms: 0, by: 'mod1', memo: '', native: false
  }, extra || {});
}

// サーバー URL・ログイン・ホスト権限がそろった偽 chrome / A fake chrome with server URL, login and host permission
function syncChrome(extraStorage, options) {
  const opts = options || {};
  const fc = createFakeChrome(Object.assign({
    settings: { clientId: 'cid', lagSec: 5, serverUrl: opts.serverUrl === undefined ? PROD_ORIGIN : opts.serverUrl },
    auth: { token: 'tok', login: 'mod1', userId: '1' },
    records: []
  }, extraStorage || {}));
  if (opts.permission !== false) fc.calls.permissions.add(PROD_ORIGIN + '/*');
  return fc;
}

// Twitch 側の経路（編集者でない: マーカーは 403） / Twitch routes (non-editor: markers return 403)
function twitchRoutes() {
  return [
    { match: (u) => u.startsWith('https://id.twitch.tv/oauth2/validate'),
      respond: () => ({ status: 200, body: { client_id: 'cid', login: 'mod1', user_id: '1', scopes: ['channel:manage:broadcast'] } }) },
    { match: (u) => u === 'https://api.twitch.tv/helix/streams/markers',
      respond: () => ({ status: 403, body: { error: 'Forbidden', message: 'not an editor' } }) },
    { match: (u) => u.startsWith('https://api.twitch.tv/helix/streams?'),
      respond: () => ({ status: 200, body: { data: [{ id: '999', type: 'live', started_at: new Date(Date.now() - 600000).toISOString(), user_id: '55' }] } }) }
  ];
}

// 送った id を全部 accepted で返す / Answers with every sent id accepted
function acceptAll(u, init) {
  return { status: 200, body: { accepted: JSON.parse(init.body).records.map((r) => r.id), rejected: [] } };
}

function stampsCalls(fetchImpl) {
  return fetchImpl.calls.filter((c) => c.url === STAMPS_URL);
}

async function testStampUploadsToServer() {
  const fc = syncChrome();
  const fetchImpl = fakeFetch(twitchRoutes().concat([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]));
  const bg = loadBackground(fc, fetchImpl);
  const res = await bg.handleMessage({ type: 'stamp', url: 'https://www.twitch.tv/terano_naa', memo: 'm' });
  await bg.uploadPending();
  const calls = stampsCalls(fetchImpl);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.strictEqual(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.strictEqual(body.source, 'extension');
  assert.strictEqual(body.records.length, 1);
  assert.strictEqual(body.records[0].id, res.record.id);
  assert.deepStrictEqual(fc.storage.pending, []);
  assert.strictEqual(fc.storage.lastSync.accepted, 1);
  assert.strictEqual(fc.storage.lastSync.error, '');
  assert.ok(fc.storage.lastSync.at);
  const state = await bg.handleMessage({ type: 'getState' });
  assert.deepStrictEqual(state.pending, []);
  assert.deepStrictEqual(state.failed, []);
  assert.strictEqual(state.lastSync.accepted, 1);
}

async function testNetworkFailureKeepsPendingAndAlarmRetries() {
  const fc = syncChrome();
  let online = false;
  const fetchImpl = fakeFetch(twitchRoutes().concat([{ match: (u) => u === STAMPS_URL, respond: (u, init) => {
    if (!online) throw new Error('offline');
    return acceptAll(u, init);
  } }]));
  const bg = loadBackground(fc, fetchImpl);
  const res = await bg.handleMessage({ type: 'stamp', url: 'https://www.twitch.tv/terano_naa', memo: '' });
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.error, 'network');
  assert.deepStrictEqual(fc.storage.pending, [res.record.id]);
  assert.strictEqual(fc.storage.lastSync.error, 'network');
  // 起動時に 5 分間隔の alarm を作る / A 5-minute alarm is created on load
  assert.deepStrictEqual(fc.calls.alarms, [['yts-flush', { periodInMinutes: 5 }]]);
  online = true;
  await fc.calls.alarmHandler({ name: 'yts-flush' });
  await bg.uploadPending();
  assert.deepStrictEqual(fc.storage.pending, []);
  assert.strictEqual(fc.storage.lastSync.error, '');
}

async function testStaleIsSuccess() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL,
    respond: () => ({ status: 200, body: { accepted: [], rejected: [{ id: 'y0000001', reason: 'stale' }] } }) }]);
  const bg = loadBackground(fc, fetchImpl);
  await bg.uploadPending();
  assert.deepStrictEqual(fc.storage.pending, []);
  assert.deepStrictEqual(fc.storage.failed, []);
}

async function testUnauthorizedMarksExpiredAndLoginResends() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] });
  const fetchImpl = fakeFetch([
    { match: (u, init) => u === STAMPS_URL && init.headers.Authorization === 'Bearer tok',
      respond: () => ({ status: 401, body: { error: 'unauthorized' } }) },
    { match: (u) => u === STAMPS_URL, respond: acceptAll },
    { match: (u) => u.startsWith('https://id.twitch.tv/oauth2/validate'),
      respond: () => ({ status: 200, body: { client_id: 'cid', login: 'mod1', user_id: '1', scopes: ['channel:manage:broadcast'] } }) }
  ]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.error, 'unauthorized');
  assert.deepStrictEqual(fc.storage.pending, ['y0000001']);
  assert.strictEqual(fc.storage.auth.expired, true);
  assert.strictEqual(fc.storage.auth.token, 'tok');
  assert.strictEqual(fc.storage.lastSync.error, 'unauthorized');
  let state = await bg.handleMessage({ type: 'getState' });
  assert.strictEqual(state.auth.expired, true);

  // 再ログインで expired が消え、送り直す / Logging in again clears expired and resends
  fc.chrome.identity.launchWebAuthFlow = async (details) => {
    const nonce = new URL(details.url).searchParams.get('state');
    return 'https://fakeextensionid.chromiumapp.org/#access_token=tok2&state=' + nonce;
  };
  await bg.handleMessage({ type: 'login' });
  await bg.uploadPending();
  state = await bg.handleMessage({ type: 'getState' });
  assert.ok(!state.auth.expired);
  assert.strictEqual(state.auth.token, 'tok2');
  assert.deepStrictEqual(fc.storage.pending, []);
  const calls = stampsCalls(fetchImpl);
  assert.strictEqual(calls[calls.length - 1].init.headers.Authorization, 'Bearer tok2');
}

async function testRejectedReasonGoesToFailed() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL,
    respond: () => ({ status: 200, body: { accepted: [], rejected: [{ id: 'y0000001', reason: 'forbidden_channel' }] } }) }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.rejected, 1);
  assert.deepStrictEqual(fc.storage.pending, []);
  assert.strictEqual(fc.storage.failed.length, 1);
  assert.strictEqual(fc.storage.failed[0].id, 'y0000001');
  assert.strictEqual(fc.storage.failed[0].reason, 'forbidden_channel');
  assert.strictEqual(fc.storage.lastSync.failedCount, 1);
}

// 401 以外の 4xx は送信を止め、そのバッチと残りを pending に残す（失敗には移さない）
// A non-401 4xx stops the upload and keeps that batch and the rest pending (nothing moves to failed).
async function testClientErrorKeepsPending() {
  const fc = syncChrome({ records: [makeRecord('y0000001'), makeRecord('y0000002')], pending: ['y0000001', 'y0000002'] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL,
    respond: () => ({ status: 413, body: { error: 'too_many_records' } }) }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.error, 'too_many_records');
  assert.strictEqual(summary.rejected, 0);
  assert.deepStrictEqual(fc.storage.pending, ['y0000001', 'y0000002']);
  assert.deepStrictEqual((await bg.readState()).failed, []);
  assert.strictEqual(fc.storage.lastSync.error, 'too_many_records');
}

// JSON の無い 404 は http_404。最初のバッチで止まり、別配信のバッチは送らない
// A 404 without JSON gives http_404; it stops at the first batch, so the other stream's batch is not sent.
async function testNotFoundStopsAndKeepsPending() {
  const fc = syncChrome({ records: [makeRecord('y0000001', '999'), makeRecord('y0000002', '888')], pending: ['y0000001', 'y0000002'] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: () => ({ status: 404, body: null }) }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.error, 'http_404');
  assert.strictEqual(stampsCalls(fetchImpl).length, 1);
  assert.deepStrictEqual(fc.storage.pending, ['y0000001', 'y0000002']);
  assert.deepStrictEqual((await bg.readState()).failed, []);
  assert.strictEqual(fc.storage.lastSync.error, 'http_404');
}

// 403 {error:'csrf'} はそのコードを lastSync.error に残す / A 403 {error:'csrf'} keeps that code in lastSync.error
async function testForbiddenCsrfKeepsPending() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: () => ({ status: 403, body: { error: 'csrf' } }) }]);
  const bg = loadBackground(fc, fetchImpl);
  await bg.uploadPending();
  assert.deepStrictEqual(fc.storage.pending, ['y0000001']);
  assert.deepStrictEqual((await bg.readState()).failed, []);
  assert.strictEqual(fc.storage.lastSync.error, 'csrf');
}

// 送信中に別トークンで再ログインされたら、古いトークンの 401 で expired を立てない
// When auth is replaced by another token during the upload, the old token's 401 does not set expired.
async function testUnauthorizedWithReplacedTokenKeepsAuth() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fc.storage.auth = { token: 'tokB', login: 'mod1', userId: '1' };
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { status: 401, body: { error: 'unauthorized' } };
  } }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.error, 'unauthorized');
  assert.strictEqual(stampsCalls(fetchImpl)[0].init.headers.Authorization, 'Bearer tok');
  assert.deepStrictEqual(fc.storage.auth, { token: 'tokB', login: 'mod1', userId: '1' });
  assert.deepStrictEqual(fc.storage.pending, ['y0000001']);
}

// 失敗一覧を消す / Clearing the failure list
async function testClearFailed() {
  const fc = syncChrome({
    records: [makeRecord('y0000001')], pending: ['y0000001'],
    failed: [{ id: 'y0000002', reason: 'forbidden_channel', at: '2026-10-30T09:00:00Z' }]
  });
  const bg = loadBackground(fc, fakeFetch([]));
  await bg.handleMessage({ type: 'clearFailed' });
  assert.deepStrictEqual(fc.storage.failed, []);
  assert.deepStrictEqual(fc.storage.pending, ['y0000001']);
}

async function testServerErrorKeepsPending() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL,
    respond: () => ({ status: 503, body: { error: 'twitch_unavailable' } }) }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.error, '503');
  assert.deepStrictEqual(fc.storage.pending, ['y0000001']);
  assert.deepStrictEqual((await bg.readState()).failed, []);
}

async function testLargeQueueIsSplitInto500() {
  const records = [];
  for (let i = 0; i < 1200; i += 1) records.push(makeRecord('y' + i.toString(16).padStart(7, '0'), '999', { offset_sec: i }));
  const fc = syncChrome({ records: records, pending: records.map((r) => r.id) });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.deepStrictEqual(stampsCalls(fetchImpl).map((c) => JSON.parse(c.init.body).records.length), [500, 500, 200]);
  assert.strictEqual(summary.accepted, 1200);
  assert.deepStrictEqual(fc.storage.pending, []);
}

async function testNoServerUrlSendsNothing() {
  const fc = syncChrome({ records: [makeRecord('y0000001')] }, { serverUrl: '' });
  const fetchImpl = fakeFetch(twitchRoutes());
  const bg = loadBackground(fc, fetchImpl);
  const res = await bg.handleMessage({ type: 'stamp', url: 'https://www.twitch.tv/terano_naa', memo: '' });
  await bg.uploadPending();
  await bg.handleMessage({ type: 'syncNow' });
  assert.strictEqual(stampsCalls(fetchImpl).length, 0);
  assert.deepStrictEqual(fc.storage.pending.slice().sort(), ['y0000001', res.record.id].sort());
}

async function testSyncNowSendsEveryRecord() {
  const tomb = makeRecord('y0000002', '999', { deleted: true, updated_at: '2026-10-30T10:02:00Z' });
  const fc = syncChrome({ records: [makeRecord('y0000001'), tomb], pending: [] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.handleMessage({ type: 'syncNow' });
  assert.strictEqual(summary.accepted, 2);
  const calls = stampsCalls(fetchImpl);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].init.body).records.map((r) => [r.id, r.deleted]), [['y0000001', false], ['y0000002', true]]);
  assert.deepStrictEqual(fc.storage.pending, []);
}

async function testNoPermissionSendsNothing() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] }, { permission: false });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  const summary = await bg.uploadPending();
  assert.strictEqual(summary.error, 'permission_required');
  assert.strictEqual(fetchImpl.calls.length, 0);
  assert.strictEqual(fc.storage.lastSync.error, 'permission_required');
  assert.deepStrictEqual(fc.storage.pending, ['y0000001']);
}

async function testImportRecordsEnqueues() {
  const fc = syncChrome();
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  const res = await bg.handleMessage({ type: 'importRecords', records: [makeRecord('y0000001'), makeRecord('y0000002', '999', { offset_sec: 20 })] });
  assert.strictEqual(res.added, 2);
  assert.deepStrictEqual(fc.storage.pending.slice().sort(), ['y0000001', 'y0000002']);
  await bg.uploadPending();
  assert.deepStrictEqual(JSON.parse(stampsCalls(fetchImpl)[0].init.body).records.map((r) => r.id).sort(), ['y0000001', 'y0000002']);
  assert.deepStrictEqual(fc.storage.pending, []);
}

async function testAcceptedClearsOldFailure() {
  const fc = syncChrome({
    records: [makeRecord('y0000001'), makeRecord('y0000002')],
    pending: ['y0000001'],
    failed: [{ id: 'y0000001', reason: 'invalid_record', at: '2026-10-30T09:00:00Z' }, { id: 'y0000002', reason: 'forbidden_channel', at: '2026-10-30T09:00:00Z' }]
  });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  await bg.uploadPending();
  assert.deepStrictEqual(fc.storage.failed.map((f) => f.id), ['y0000002']);
  assert.strictEqual(fc.storage.lastSync.failedCount, 1);
}

async function testReadStateDefaultsClientIdWhenEmpty() {
  const fc = createFakeChrome({ settings: { clientId: '', lagSec: 5 } });
  const bg = loadBackground(fc, fakeFetch([]));
  const state = await bg.readState();
  assert.strictEqual(state.settings.clientId, DEFAULT_CLIENT_ID);
  assert.deepStrictEqual(state.pending, []);
  assert.deepStrictEqual(state.failed, []);
  assert.strictEqual(state.lastSync, null);
}

async function testUpdateMemoUploads() {
  const fc = syncChrome({ records: [makeRecord('y0000001')] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  await bg.handleMessage({ type: 'updateMemo', id: 'y0000001', memo: 'later' });
  await bg.uploadPending();
  const calls = stampsCalls(fetchImpl);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(JSON.parse(calls[0].init.body).records[0].memo, 'later');
  assert.deepStrictEqual(fc.storage.pending, []);
}

// 送信中にメモを直したら、その id は送り直す / An id edited while its upload is in flight is sent again
async function testEditDuringUploadIsResent() {
  const fc = syncChrome({ records: [makeRecord('y0000001')], pending: ['y0000001'] });
  let bg;
  let first = true;
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: async (u, init) => {
    if (first) {
      first = false;
      await bg.handleMessage({ type: 'updateMemo', id: 'y0000001', memo: 'edited' });
    }
    return acceptAll(u, init);
  } }]);
  bg = loadBackground(fc, fetchImpl);
  await bg.uploadPending();
  await bg.uploadPending();
  const calls = stampsCalls(fetchImpl);
  assert.deepStrictEqual(calls.map((c) => JSON.parse(c.init.body).records[0].memo), ['', 'edited']);
  assert.deepStrictEqual(fc.storage.pending, []);
}

async function testDeleteRecordSendsTombstone() {
  const fc = syncChrome({ records: [makeRecord('y0000001'), makeRecord('y0000002', '999', { offset_sec: 20 })] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  // popup は一覧の記録をそのまま送る / The popup sends the listed record as is
  const res = await bg.handleMessage({ type: 'deleteRecord', record: makeRecord('y0000001') });
  assert.strictEqual(res.tombstoned, true);
  await bg.uploadPending();
  assert.strictEqual(fc.storage.records.length, 2);
  const tomb = fc.storage.records.find((r) => r.id === 'y0000001');
  assert.strictEqual(tomb.deleted, true);
  assert.notStrictEqual(tomb.updated_at, '2026-10-30T10:01:00Z');
  assert.strictEqual(fc.storage.records.find((r) => r.id === 'y0000002').deleted, false);
  const calls = stampsCalls(fetchImpl);
  assert.strictEqual(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body).records;
  assert.deepStrictEqual(sent.map((r) => [r.id, r.deleted]), [['y0000001', true]]);
  assert.deepStrictEqual(fc.storage.pending, []);
}

async function testForbiddenTombstoneGoesToFailed() {
  const fc = syncChrome({ records: [makeRecord('y0000001', '999', { by: 'other' })] });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL,
    respond: () => ({ status: 200, body: { accepted: [], rejected: [{ id: 'y0000001', reason: 'forbidden_tombstone' }] } }) }]);
  const bg = loadBackground(fc, fetchImpl);
  await bg.handleMessage({ type: 'deleteRecord', record: makeRecord('y0000001', '999', { by: 'other' }) });
  await bg.uploadPending();
  assert.deepStrictEqual(fc.storage.pending, []);
  assert.deepStrictEqual(fc.storage.failed.map((f) => [f.id, f.reason]), [['y0000001', 'forbidden_tombstone']]);
  // 手元では墓標のまま / It stays a tombstone locally
  assert.strictEqual(fc.storage.records[0].deleted, true);
}

async function testDeleteStreamIsLocalOnly() {
  const fc = syncChrome({
    records: [makeRecord('y0000001', '999'), makeRecord('y0000002', '999', { offset_sec: 20 }), makeRecord('y0000003', '888')],
    pending: ['y0000001', 'y0000003'],
    failed: [{ id: 'y0000002', reason: 'forbidden_channel', at: '2026-10-30T09:00:00Z' }, { id: 'y0000003', reason: 'invalid_record', at: '2026-10-30T09:00:00Z' }]
  }, { permission: false });
  const fetchImpl = fakeFetch([{ match: (u) => u === STAMPS_URL, respond: acceptAll }]);
  const bg = loadBackground(fc, fetchImpl);
  await bg.handleMessage({ type: 'deleteStream', stream_id: '999' });
  await bg.uploadPending();
  assert.deepStrictEqual(fc.storage.records.map((r) => r.id), ['y0000003']);
  assert.deepStrictEqual(fc.storage.pending, ['y0000003']);
  assert.deepStrictEqual(fc.storage.failed.map((f) => f.id), ['y0000003']);
  // 権限を足して送っても、消した配信の記録は送らない / Even with permission, the deleted stream's records are not sent
  fc.calls.permissions.add(PROD_ORIGIN + '/*');
  await bg.uploadPending();
  assert.deepStrictEqual(stampsCalls(fetchImpl).map((c) => JSON.parse(c.init.body).records.map((r) => r.id)), [['y0000003']]);
}

(async () => {
  await testStampWithoutEditorFallsBackToLocal();
  await testUnmockedFetchIsReported();
  await testSaveSettingsServerUrl();
  await testSaveSettingsEmptyClientIdUsesDefault();
  await testStampUploadsToServer();
  await testNetworkFailureKeepsPendingAndAlarmRetries();
  await testStaleIsSuccess();
  await testUnauthorizedMarksExpiredAndLoginResends();
  await testRejectedReasonGoesToFailed();
  await testClientErrorKeepsPending();
  await testNotFoundStopsAndKeepsPending();
  await testForbiddenCsrfKeepsPending();
  await testUnauthorizedWithReplacedTokenKeepsAuth();
  await testClearFailed();
  await testServerErrorKeepsPending();
  await testLargeQueueIsSplitInto500();
  await testNoServerUrlSendsNothing();
  await testSyncNowSendsEveryRecord();
  await testNoPermissionSendsNothing();
  await testImportRecordsEnqueues();
  await testAcceptedClearsOldFailure();
  await testReadStateDefaultsClientIdWhenEmpty();
  await testUpdateMemoUploads();
  await testEditDuringUploadIsResent();
  await testDeleteRecordSendsTombstone();
  await testForbiddenTombstoneGoesToFailed();
  await testDeleteStreamIsLocalOnly();
  console.log('all tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
