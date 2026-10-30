'use strict';

// panel/js/server.js（パネルの同期元「サーバー」の通信）を偽 fetch / 偽 localStorage で検査する
// Tests panel/js/server.js (the panel's "server" sync source) with a fake fetch and a fake localStorage.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const YTSServer = require('../panel/js/server.js');

// localStorage と同じ getItem / setItem / removeItem を持つ偽物 / Fake with localStorage's getItem / setItem / removeItem
function createFakeStorage(initial) {
  const items = Object.assign({}, initial || {});
  return {
    items: items,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null),
    setItem: (key, value) => { items[key] = String(value); },
    removeItem: (key) => { delete items[key]; }
  };
}

// 呼ばれた要求を記録し、handler の返す {status, body} を Response 風に返す偽 fetch
// Fake fetch that records requests and answers with the {status, body} returned by handler, shaped like a Response.
function createFakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const answer = await handler(call, calls.length);
    const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => text,
      json: async () => JSON.parse(text)
    };
  };
  fetch.calls = calls;
  return fetch;
}

function makeRecords(count) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    records.push({
      id: 'y' + i.toString(16).padStart(7, '0'), timecode: '00:00:00', offset_sec: i, by: 'u', memo: '', native: false,
      channel: 'c', stream_id: 's', started_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z', deleted: false, clock_skew_ms: 0
    });
  }
  return records;
}

const tokenSettings = JSON.stringify({ serverUrl: 'https://h.example', token: 'ytt_abc' });

(async function main() {
  // saveSettings: URL は origin に正規化、https 以外は拒否、loadSettings で読み戻せる
  // saveSettings normalizes the URL to its origin, rejects non-https, and loadSettings reads it back.
  {
    const storage = createFakeStorage();
    YTSServer.configure({ fetch: createFakeFetch(() => ({ status: 200, body: {} })), storage: storage });
    assert.deepStrictEqual(YTSServer.loadSettings(), { serverUrl: '', token: '' });
    YTSServer.saveSettings({ serverUrl: ' https://A.example.dev/me?x=1 ', token: ' ytt_abc ' });
    assert.deepStrictEqual(JSON.parse(storage.items['yts.server']), { serverUrl: 'https://a.example.dev', token: 'ytt_abc' });
    assert.deepStrictEqual(YTSServer.loadSettings(), { serverUrl: 'https://a.example.dev', token: 'ytt_abc' });
    assert.throws(() => YTSServer.saveSettings({ serverUrl: 'http://a.example.dev', token: 'ytt_abc' }), /https/);
    assert.throws(() => YTSServer.saveSettings({ serverUrl: 'not a url', token: 'ytt_abc' }), /URL/);
    assert.throws(() => YTSServer.saveSettings({ serverUrl: 'https://a.example.dev', token: '  ' }), /トークン/);
    // 失敗した保存は前の設定を残す / A failed save keeps the previous settings
    assert.deepStrictEqual(YTSServer.loadSettings(), { serverUrl: 'https://a.example.dev', token: 'ytt_abc' });
    // 壊れた保存値は空の設定として読む / A corrupt stored value reads as empty settings
    YTSServer.configure({ storage: createFakeStorage({ 'yts.server': '{bad' }) });
    assert.deepStrictEqual(YTSServer.loadSettings(), { serverUrl: '', token: '' });
  }

  // api: Bearer と JSON を付けて serverUrl + path に送る / api sends to serverUrl + path with Bearer and JSON
  {
    const fetch = createFakeFetch(() => ({ status: 200, body: { login: 'me', via: 'token', channels: [{ login: 'c', role: 'member' }], site_admin: false } }));
    YTSServer.configure({ fetch: fetch, storage: createFakeStorage({ 'yts.server': tokenSettings }) });
    const me = await YTSServer.me();
    assert.strictEqual(me.login, 'me');
    assert.strictEqual(fetch.calls[0].url, 'https://h.example/api/me');
    assert.strictEqual(fetch.calls[0].method, 'GET');
    assert.strictEqual(fetch.calls[0].headers.Authorization, 'Bearer ytt_abc');
    await YTSServer.api('/api/x', { method: 'POST', body: { a: 1 } });
    assert.strictEqual(fetch.calls[1].method, 'POST');
    assert.strictEqual(fetch.calls[1].headers['Content-Type'], 'application/json');
    assert.deepStrictEqual(fetch.calls[1].body, { a: 1 });
  }

  // 設定が無ければ送らずに throw / Without settings, api throws without sending
  {
    const fetch = createFakeFetch(() => ({ status: 200, body: {} }));
    YTSServer.configure({ fetch: fetch, storage: createFakeStorage() });
    await assert.rejects(YTSServer.me(), /トークン/);
    assert.strictEqual(fetch.calls.length, 0);
  }

  // 401 / 403 / ネットワーク失敗の文言と status・error / Messages, status and error for 401 / 403 / network failure
  {
    const storage = createFakeStorage({ 'yts.server': tokenSettings });
    YTSServer.configure({ fetch: createFakeFetch(() => ({ status: 401, body: { error: 'unauthorized' } })), storage: storage });
    await assert.rejects(YTSServer.me(), (error) => {
      assert.strictEqual(error.status, 401); assert.strictEqual(error.error, 'unauthorized');
      assert.strictEqual(error.message, 'トークンが無効です。Web の /me で発行し直してください');
      return true;
    });
    YTSServer.configure({ fetch: createFakeFetch(() => ({ status: 403, body: { error: 'forbidden', detail: 'not_member' } })) });
    await assert.rejects(YTSServer.listStreams('c'), (error) => {
      assert.strictEqual(error.status, 403); assert.strictEqual(error.detail, 'not_member');
      assert.strictEqual(error.message, 'このチャンネルの会員ではありません');
      return true;
    });
    YTSServer.configure({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(YTSServer.me(), (error) => {
      assert.strictEqual(error.status, 0); assert.strictEqual(error.error, 'network');
      assert.strictEqual(error.message, 'サーバーに接続できません');
      return true;
    });
    // 本文が JSON でない 500 も status 付きで throw / A 500 with a non-JSON body still throws with its status
    YTSServer.configure({ fetch: async () => ({ ok: false, status: 500, text: async () => 'oops' }) });
    await assert.rejects(YTSServer.me(), (error) => { assert.strictEqual(error.status, 500); assert.strictEqual(error.error, 'http_500'); return true; });
  }

  // listStreams / pullStamps の URL と戻り値 / URLs and results of listStreams / pullStamps
  {
    const fetch = createFakeFetch((call) => (/\/streams$/.test(call.url)
      ? { status: 200, body: { streams: [{ stream_id: 'vod-1', title: 't', started_at: '2026-01-01T00:00:00.000Z', stamp_count: 2 }] } }
      : { status: 200, body: { stream: { stream_id: 'vod 1' }, records: makeRecords(2) } }));
    YTSServer.configure({ fetch: fetch, storage: createFakeStorage({ 'yts.server': tokenSettings }) });
    const streams = await YTSServer.listStreams('terano_naa');
    assert.strictEqual(fetch.calls[0].url, 'https://h.example/api/channels/terano_naa/streams');
    assert.strictEqual(streams[0].stream_id, 'vod-1');
    const records = await YTSServer.pullStamps('vod 1');
    assert.strictEqual(fetch.calls[1].url, 'https://h.example/api/streams/vod%201/stamps');
    assert.strictEqual(records.length, 2); assert.strictEqual(records[1].id, 'y0000001');
  }

  // pushStamps: 1,200 件を 500 / 500 / 200 の 3 回で送り、source は panel、結果をまとめる
  // pushStamps sends 1,200 records in 3 requests (500 / 500 / 200) with source panel and aggregates the results.
  {
    const fetch = createFakeFetch((call) => ({
      status: 200,
      body: { accepted: call.body.records.slice(1).map((r) => r.id), rejected: [{ id: call.body.records[0].id, reason: 'stale' }] }
    }));
    YTSServer.configure({ fetch: fetch, storage: createFakeStorage({ 'yts.server': tokenSettings }) });
    const result = await YTSServer.pushStamps(makeRecords(1200));
    assert.deepStrictEqual(fetch.calls.map((c) => c.body.records.length), [500, 500, 200]);
    assert.ok(fetch.calls.every((c) => c.url === 'https://h.example/api/stamps' && c.method === 'POST' && c.body.source === 'panel'));
    assert.strictEqual(result.accepted.length, 1197); assert.strictEqual(result.rejected.length, 3);
    // 0 件なら送らない / Nothing is sent for zero records
    assert.deepStrictEqual(await YTSServer.pushStamps([]), { accepted: [], rejected: [] });
    assert.strictEqual(fetch.calls.length, 3);
  }

  // 2 回目が 503 なら retryable 付きで throw し、3 回目を送らない。1 回目の結果は partial に残る
  // A 503 on the 2nd request throws with retryable and does not send the 3rd; the 1st result stays in partial.
  {
    const fetch = createFakeFetch((call, n) => (n === 2
      ? { status: 503, body: { error: 'unavailable' } }
      : { status: 200, body: { accepted: call.body.records.map((r) => r.id), rejected: [] } }));
    YTSServer.configure({ fetch: fetch, storage: createFakeStorage({ 'yts.server': tokenSettings }) });
    await assert.rejects(YTSServer.pushStamps(makeRecords(1200)), (error) => {
      assert.strictEqual(error.retryable, true); assert.strictEqual(error.status, 503);
      assert.strictEqual(error.partial.accepted.length, 500);
      return true;
    });
    assert.strictEqual(fetch.calls.length, 2);
  }

  // ネットワーク失敗も retryable、401 は retryable でない / A network failure is retryable; 401 is not
  {
    YTSServer.configure({ fetch: async () => { throw new TypeError('Failed to fetch'); }, storage: createFakeStorage({ 'yts.server': tokenSettings }) });
    await assert.rejects(YTSServer.pushStamps(makeRecords(1)), (error) => { assert.strictEqual(error.retryable, true); return true; });
    YTSServer.configure({ fetch: createFakeFetch(() => ({ status: 401, body: { error: 'unauthorized' } })) });
    await assert.rejects(YTSServer.pushStamps(makeRecords(1)), (error) => { assert.strictEqual(error.retryable, false); assert.strictEqual(error.status, 401); return true; });
    // accepted / rejected が配列でない 200 は再送扱い / A 200 without accepted / rejected arrays is retryable
    YTSServer.configure({ fetch: createFakeFetch(() => ({ status: 200, body: { ok: true } })) });
    await assert.rejects(YTSServer.pushStamps(makeRecords(1)), (error) => { assert.strictEqual(error.retryable, true); assert.strictEqual(error.error, 'http_200'); return true; });
    // 設定が無いのは再送で直らない / Missing settings are not retryable
    YTSServer.configure({ storage: createFakeStorage() });
    await assert.rejects(YTSServer.pushStamps(makeRecords(1)), (error) => { assert.strictEqual(error.retryable, false); assert.strictEqual(error.error, 'not_configured'); return true; });
  }

  // me(候補) は候補の URL / トークンで送り、保存はしない（接続の確認後にだけ保存するため）
  // me(candidate) sends with the candidate URL / token without saving (settings are saved only after the check passes).
  {
    const storage = createFakeStorage({ 'yts.server': tokenSettings });
    const fetch = createFakeFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
    YTSServer.configure({ fetch: fetch, storage: storage });
    const candidate = YTSServer.normalizeSettings({ serverUrl: ' https://New.example/x ', token: ' ytt_new ' });
    assert.deepStrictEqual(candidate, { serverUrl: 'https://new.example', token: 'ytt_new' });
    assert.throws(() => YTSServer.normalizeSettings({ serverUrl: 'http://x', token: 't' }), /https/);
    await assert.rejects(YTSServer.me(candidate), (error) => { assert.strictEqual(error.status, 401); return true; });
    assert.strictEqual(fetch.calls[0].url, 'https://new.example/api/me');
    assert.strictEqual(fetch.calls[0].headers.Authorization, 'Bearer ytt_new');
    // 失敗しても保存済みの設定は変わらない / The saved settings stay unchanged after the failure
    assert.strictEqual(storage.items['yts.server'], tokenSettings);
  }

  // push の結果の振り分け: accepted と stale は成功、他は失敗一覧、forbidden_tombstone は次の pull で戻す
  // Sorting a push result: accepted and stale succeed, the rest are failures, forbidden_tombstone ids are restored by the next pull.
  {
    const TSLib = require('../panel/js/lib.js');
    const sorted = TSLib.applyPanelPushResult({
      accepted: ['y00000a1', 'y00000a2'],
      rejected: [
        { id: 'y00000b1', reason: 'stale' },
        { id: 'y00000c1', reason: 'forbidden_tombstone' },
        { id: 'y00000d1', reason: 'invalid_time' }
      ]
    });
    assert.deepStrictEqual(sorted.okIds, ['y00000a1', 'y00000a2', 'y00000b1']);
    assert.deepStrictEqual(sorted.failed, [{ id: 'y00000c1', reason: 'forbidden_tombstone' }, { id: 'y00000d1', reason: 'invalid_time' }]);
    assert.deepStrictEqual(sorted.forcePull, ['y00000c1']);
    // 空・欠けた応答（throw 時の partial が無い等）でも落ちない / Empty or missing results (e.g. no partial on a throw) do not crash
    assert.deepStrictEqual(TSLib.applyPanelPushResult(null), { okIds: [], failed: [], forcePull: [] });
    assert.deepStrictEqual(TSLib.applyPanelPushResult({ accepted: [], rejected: [] }), { okIds: [], failed: [], forcePull: [] });
  }

  // CEP で lib.js が読めず require も無いときも、server.js の読み込み自体は失敗しない（main.js の案内を出せるように）
  // In CEP with lib.js missing and no require, loading server.js itself must not throw (so main.js can show its notice).
  {
    const source = fs.readFileSync(path.resolve(__dirname, '../panel/js/server.js'), 'utf8');
    const context = vm.createContext({ window: {} });
    assert.doesNotThrow(() => vm.runInContext(source, context));
    assert.strictEqual(vm.runInContext('typeof YTSServer', context), 'object');
    assert.ok(context.window.YTSServer, 'window.YTSServer must be set');
    // lib が要る関数は呼んだときに日本語の Error / Functions needing lib throw a Japanese Error when called
    context.window.YTSServer.configure({ storage: createFakeStorage({ 'yts.server': tokenSettings }), fetch: createFakeFetch(() => ({ status: 200, body: {} })) });
    await assert.rejects(context.window.YTSServer.pushStamps(makeRecords(1)), /lib\.js を読み込めませんでした。panel\\install\.ps1 を再実行してください$/);
  }

  console.log('all tests passed');
}()).catch((error) => {
  console.error(error);
  process.exit(1);
});
