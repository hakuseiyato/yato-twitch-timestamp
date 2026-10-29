'use strict';

importScripts('lib.js');

// serverUrl が空ならサーバーへは送らない / An empty serverUrl means nothing is sent to the server
const DEFAULT_SETTINGS = { clientId: '105fdov1w7trd0swseu50l5qy2sckg', lagSec: 5, serverUrl: '' };
const SERVER_URL_ERROR = 'サーバー URL は https://ホスト名 の形で入力してください / Server URL must be https://host';
const streamCache = new Map();
let storageChain = Promise.resolve();

function serializedStorage(operation) {
  const next = storageChain.then(operation, operation);
  storageChain = next.catch(function () {});
  return next;
}

// 入力されたサーバー URL を https の origin（末尾 / なし）にする。空は ''
// Normalizes the server URL to an https origin (no trailing slash); empty gives ''.
function normalizeServerUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error(SERVER_URL_ERROR);
  }
  if (url.protocol !== 'https:' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(SERVER_URL_ERROR);
  }
  return url.origin;
}

// サーバーへのホスト権限があるか（権限の要求はユーザー操作が要るので popup が行う）
// Whether the host permission for the server is granted (popup requests it, since that needs a user gesture).
async function hasHostPermission(serverUrl) {
  if (!serverUrl) return false;
  return chrome.permissions.contains({ origins: [serverUrl + '/*'] });
}

async function readState() {
  const stored = await chrome.storage.local.get(['settings', 'auth', 'records', 'pending', 'failed', 'lastSync']);
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
  // 空欄の Client ID は既定値 / An empty Client ID falls back to the default
  if (!settings.clientId) settings.clientId = DEFAULT_SETTINGS.clientId;
  return {
    settings: settings,
    auth: Object.assign({ token: '', login: '', userId: '', expired: false }, stored.auth || {}),
    records: Array.isArray(stored.records) ? stored.records : [],
    // 送信待ちの id・送れなかった記録・最後の送信結果 / Ids waiting to upload, failed uploads, last upload result
    pending: Array.isArray(stored.pending) ? stored.pending : [],
    failed: Array.isArray(stored.failed) ? stored.failed : [],
    lastSync: stored.lastSync || null
  };
}

// pending に ids を足す（serializedStorage の中から呼ぶ） / Adds ids to pending (call inside serializedStorage)
async function addPending(ids) {
  const stored = await chrome.storage.local.get('pending');
  const pending = Array.isArray(stored.pending) ? stored.pending : [];
  const seen = new Set(pending);
  const next = pending.concat(ids.filter(function (id) {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }));
  await chrome.storage.local.set({ pending: next });
  return next;
}

function enqueue(ids) {
  return serializedStorage(function () { return addPending(ids); });
}

// 送信を裏で始める（待たない。uploadPending は例外を投げない）
// Starts an upload in the background (not awaited; uploadPending never throws).
function kickUpload() {
  uploadPending().catch(function () {});
}

async function readJson(response) {
  try {
    return (await response.json()) || {};
  } catch (error) {
    return {};
  }
}

// ponytail: 送信は 1 本ずつ直列に流す（同じ id の二重送信を避ける）。storageChain とは別の鎖なので記録の保存は送信を待たない
// ponytail: Uploads run one at a time (avoids sending the same id twice). It is a separate chain from storageChain, so saving records never waits on the network.
let uploadChain = Promise.resolve();

// 送信待ちを全部サーバーへ送る。例外は投げず、結果の要約を返す
// Sends every pending record to the server. Never throws; returns a summary.
function uploadPending() {
  const next = uploadChain.then(runUpload, runUpload).catch(function () {
    return { accepted: 0, rejected: 0, error: 'internal' };
  });
  uploadChain = next;
  return next;
}

async function runUpload() {
  const summary = { accepted: 0, rejected: 0, error: '' };
  const state = await readState();
  const serverUrl = state.settings.serverUrl;
  if (!serverUrl) return summary;
  if (!state.auth.token) {
    summary.error = 'login_required';
  } else if (!(await hasHostPermission(serverUrl))) {
    // 権限が無いと fetch は CORS で落ちるので送らない / Without the permission fetch would fail on CORS, so do not send
    summary.error = 'permission_required';
  } else {
    // id の無い古い記録も mergeRecords で id をそろえてから組む / mergeRecords gives old records their ids before planning
    const batches = TSLib.planUpload(TSLib.mergeRecords(state.records), state.pending, 500);
    // 送るものが無ければ前回の結果を残す（5 分ごとの空振りで上書きしない）
    // Nothing to send: keep the previous result (an idle 5-minute run does not overwrite it).
    if (!batches.length) return summary;
    for (const batch of batches) {
      const stop = await uploadBatch(serverUrl, state.auth.token, batch, summary);
      if (stop) break;
    }
  }
  await serializedStorage(async function () {
    const stored = await chrome.storage.local.get('failed');
    const failedCount = Array.isArray(stored.failed) ? stored.failed.length : 0;
    await chrome.storage.local.set({
      lastSync: { at: new Date().toISOString(), accepted: summary.accepted, failedCount: failedCount, error: summary.error }
    });
  });
  return summary;
}

// 1 バッチを送り、キューに反映する。以降のバッチを止めるなら true
// Sends one batch and applies the result to the queue. Returns true to stop the remaining batches.
async function uploadBatch(serverUrl, token, batch, summary) {
  const ids = batch.records.map(function (record) { return record.id; });
  let response;
  try {
    response = await fetch(serverUrl + '/api/stamps', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch.records.map(TSLib.toUploadRecord), source: 'extension' })
    });
  } catch (error) {
    summary.error = 'network';
    return true;
  }
  const body = await readJson(response);

  if (response.ok) {
    const accepted = Array.isArray(body.accepted) ? body.accepted : [];
    const rejected = Array.isArray(body.rejected) ? body.rejected : [];
    // accepted と stale は成功。以前の失敗記録から外す / accepted and stale are successes; drop their old failures
    const succeeded = new Set(accepted.concat(rejected.filter(function (item) { return item.reason === 'stale'; }).map(function (item) { return item.id; })));
    summary.accepted += accepted.length;
    summary.rejected += rejected.filter(function (item) { return item.reason !== 'stale'; }).length;
    const sentAt = new Map(batch.records.map(function (record) { return [record.id, record.updated_at]; }));
    await serializedStorage(async function () {
      const current = await readState();
      const result = TSLib.applyUploadResult(current.pending, current.failed, ids, body);
      // 送信中に直された記録は送り直す / Records edited while in flight are sent again
      const edited = TSLib.mergeRecords(current.records).filter(function (record) {
        return sentAt.has(record.id) && record.updated_at !== sentAt.get(record.id) && current.pending.indexOf(record.id) >= 0;
      }).map(function (record) { return record.id; });
      const pending = result.pendingIds.concat(edited.filter(function (id) { return result.pendingIds.indexOf(id) < 0; }));
      const failed = result.failed.filter(function (entry) { return !succeeded.has(entry.id); });
      await chrome.storage.local.set({ pending: pending, failed: failed });
    });
    return false;
  }

  if (response.status === 401) {
    // トークン切れ。トークンは消さず、popup が再ログインを促す / Token expired: keep it; the popup asks to log in again
    summary.error = 'unauthorized';
    await serializedStorage(async function () {
      const stored = await chrome.storage.local.get('auth');
      if (stored.auth) await chrome.storage.local.set({ auth: Object.assign({}, stored.auth, { expired: true }) });
    });
    return true;
  }

  if (TSLib.isRetryableUpload(response.status)) {
    summary.error = String(response.status);
    return true;
  }

  // 送り直しても直らない 4xx: このバッチを失敗に移す / A 4xx that a retry cannot fix: move this batch to failed
  const reason = typeof body.error === 'string' && body.error ? body.error : String(response.status);
  summary.error = reason;
  summary.rejected += ids.length;
  await serializedStorage(async function () {
    const current = await readState();
    const at = new Date().toISOString();
    const moved = new Set(ids);
    const failed = current.failed.filter(function (entry) { return !moved.has(entry.id); })
      .concat(ids.map(function (id) { return { id: id, reason: reason, at: at }; }));
    await chrome.storage.local.set({
      pending: current.pending.filter(function (id) { return !moved.has(id); }),
      failed: failed
    });
  });
  return false;
}

async function readLastStream(login) {
  const stored = await chrome.storage.session.get('lastStreams');
  const streams = stored.lastStreams || {};
  return streams[login] || null;
}

async function saveLastStream(login, stream) {
  const saved = {
    id: stream.id,
    started_at: stream.started_at,
    user_id: stream.user_id || '',
    clockSkewMs: Number(stream.clockSkewMs) || 0,
    savedAt: Date.now()
  };
  await serializedStorage(async function () {
    const stored = await chrome.storage.session.get('lastStreams');
    const lastStreams = Object.assign({}, stored.lastStreams || {});
    lastStreams[login] = saved;
    await chrome.storage.session.set({ lastStreams: lastStreams });
  });
  return saved;
}

async function apiJson(url, options) {
  let response;
  try {
    response = await fetch(url, options || {});
  } catch (error) {
    throw new Error('Twitch API に接続できませんでした');
  }
  let body = {};
  try {
    body = await response.json();
  } catch (error) {
    body = {};
  }
  return { response: response, body: body };
}

async function validateToken(token) {
  return apiJson('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: 'OAuth ' + token }
  });
}

function helixHeaders(clientId, token, includeJson) {
  const headers = {
    Authorization: 'Bearer ' + token,
    'Client-Id': clientId
  };
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}

async function handleLogin() {
  const state = await readState();
  if (!state.settings.clientId) throw new Error('Client ID を設定してください');
  const nonce = crypto.randomUUID ? crypto.randomUUID() : crypto.getRandomValues(new Uint32Array(4)).join('-');
  const redirectUrl = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: state.settings.clientId,
    redirect_uri: redirectUrl,
    scope: 'channel:manage:broadcast',
    state: nonce
  });
  let resultUrl;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({
      url: 'https://id.twitch.tv/oauth2/authorize?' + params.toString(),
      interactive: true
    });
  } catch (error) {
    throw new Error('ログインがキャンセルされたか、認証に失敗しました');
  }
  if (!resultUrl) throw new Error('ログインがキャンセルされました');
  const returned = new URL(resultUrl);
  const hash = new URLSearchParams(returned.hash.slice(1));
  if (returned.searchParams.get('error') || hash.get('error')) throw new Error('ログインが拒否されました');
  if (hash.get('state') !== nonce) throw new Error('ログイン状態の確認に失敗しました');
  const token = hash.get('access_token');
  if (!token) throw new Error('アクセストークンを取得できませんでした');
  const validation = await validateToken(token);
  if (!validation.response.ok || !validation.body.login || !validation.body.user_id) {
    throw new Error('ログイン情報を確認できませんでした');
  }
  if (!Array.isArray(validation.body.scopes) || validation.body.scopes.indexOf('channel:manage:broadcast') < 0) {
    throw new Error('必要な権限（channel:manage:broadcast）が付与されていません');
  }
  if (validation.body.client_id !== state.settings.clientId) {
    throw new Error('トークンの Client ID が設定と一致しません');
  }
  const auth = { token: token, login: validation.body.login, userId: validation.body.user_id };
  // 新しい auth には expired が無いので、期限切れの印も消える / The new auth has no expired flag, so it is cleared
  await serializedStorage(function () { return chrome.storage.local.set({ auth: auth }); });
  kickUpload();
  return { auth: auth };
}

async function getLiveStream(login, clientId, token, t0, lagSec) {
  const cached = streamCache.get(login);
  if (cached && Date.now() - cached.cachedAt < 15000) {
    const startedMs = Date.parse(cached.stream.started_at);
    const rawOffset = (t0 + (Number(cached.stream.clockSkewMs) || 0) - startedMs) / 1000 - lagSec;
    if (Number.isFinite(rawOffset) && rawOffset >= 0) return cached.stream;
  }
  const requestStartMs = Date.now();
  const result = await apiJson('https://api.twitch.tv/helix/streams?user_login=' + encodeURIComponent(login), {
    headers: helixHeaders(clientId, token, false)
  });
  const responseEndMs = Date.now();
  if (!result.response.ok) {
    throw new Error('配信情報を取得できませんでした' + (result.body.message ? ': ' + result.body.message : ''));
  }
  const stream = result.body.data && result.body.data[0] ? result.body.data[0] : null;
  if (!stream || stream.type !== 'live') return null;
  stream.clockSkewMs = TSLib.computeClockSkewMs(result.response.headers.get('Date'), requestStartMs, responseEndMs);
  streamCache.set(login, { stream: stream, cachedAt: Date.now() });
  await saveLastStream(login, stream);
  return stream;
}

async function getBroadcasterId(login, stream, clientId, token) {
  if (stream.user_id) return stream.user_id;
  const result = await apiJson('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login), {
    headers: helixHeaders(clientId, token, false)
  });
  if (!result.response.ok || !result.body.data || !result.body.data[0]) {
    throw new Error('チャンネル情報を取得できませんでした');
  }
  return result.body.data[0].id;
}

async function saveRecord(stream, channel, by, memo, offsetSec, native, warning) {
  const now = new Date().toISOString();
  const record = {
    id: TSLib.newId(),
    stream_id: stream.id,
    channel: channel,
    started_at: stream.started_at,
    offset_sec: offsetSec,
    created_at: now,
    updated_at: now,
    deleted: false,
    clock_skew_ms: Number(stream.clockSkewMs) || 0,
    by: by || 'unknown',
    memo: memo,
    native: native
  };
  await serializedStorage(async function () {
    const current = await readState();
    await chrome.storage.local.set({ records: TSLib.mergeRecords(current.records, [record]) });
    await addPending([record.id]);
  });
  kickUpload();
  return { record: record, native: native, warning: warning || '' };
}

async function saveFromCache(channel, by, memo, t0, lagSec, warning, noCacheError) {
  const cached = await readLastStream(channel);
  if (!cached) throw new Error(noCacheError);
  const offsetSec = TSLib.localOffsetSec(t0, cached.clockSkewMs, cached.started_at, lagSec);
  return saveRecord(cached, channel, by || 'unknown', memo, offsetSec, false, warning);
}

async function handleStamp(message) {
  const t0 = Number.isFinite(message.pressedAt) ? message.pressedAt : Date.now();
  const state = await readState();
  const channel = TSLib.channelFromUrl(message.url);
  if (!channel) throw new Error('チャンネルページで押してください');
  const memo = String(message.memo || '').trim();
  const lagSec = Number(state.settings.lagSec) || 0;
  const storedLogin = state.auth.login || '';
  let by = storedLogin || 'unknown';
  // Logged out (e.g. token expired on a previous press): keep stamping from the cached stream.
  if (!state.settings.clientId || !state.auth.token) {
    return saveFromCache(channel, by, memo, t0, lagSec,
      'ログインしていないため、前回の配信情報でローカル保存しました。再ログインしてください',
      'ポップアップでログインしてください');
  }

  let validation;
  try {
    validation = await validateToken(state.auth.token);
  } catch (error) {
    return saveFromCache(channel, by, memo, t0, lagSec,
      'Twitch API に接続できないため、前回取得した配信情報でローカル保存しました',
      'ログイン情報を確認できませんでした');
  }
  if (validation.response.status === 401) {
    await serializedStorage(function () { return chrome.storage.local.set({ auth: { token: '', login: '', userId: '' } }); });
    return saveFromCache(channel, storedLogin || 'unknown', memo, t0, lagSec,
      'ログインの有効期限が切れました。前回の配信情報でローカル保存しました。再ログインしてください',
      'ログインの有効期限が切れました');
  }
  if (!validation.response.ok || !validation.body.login) {
    return saveFromCache(channel, by, memo, t0, lagSec,
      'Twitch API に接続できないため、前回取得した配信情報でローカル保存しました',
      'ログイン情報を確認できませんでした');
  }
  by = validation.body.login;

  let stream;
  try {
    stream = await getLiveStream(channel, state.settings.clientId, state.auth.token, t0, lagSec);
  } catch (error) {
    return saveFromCache(channel, by, memo, t0, lagSec,
      'Twitch API に接続できないため、前回取得した配信情報でローカル保存しました',
      error.message || '配信情報を取得できませんでした');
  }
  if (!stream) throw new Error('配信中ではありません');

  let offsetSec = TSLib.localOffsetSec(t0, stream.clockSkewMs, stream.started_at, lagSec);
  const description = ('[' + by + '] ' + memo).slice(0, 140);
  let native = false;
  let warning = '';
  let broadcasterId;
  try {
    broadcasterId = await getBroadcasterId(channel, stream, state.settings.clientId, state.auth.token);
  } catch (error) {
    return saveFromCache(channel, by, memo, t0, lagSec,
      'Twitch API に接続できないため、前回取得した配信情報でローカル保存しました',
      error.message || 'チャンネル情報を取得できませんでした');
  }

  try {
    const tPostSentMs = Date.now();
    const marker = await apiJson('https://api.twitch.tv/helix/streams/markers', {
      method: 'POST',
      headers: helixHeaders(state.settings.clientId, state.auth.token, true),
      body: JSON.stringify({ user_id: broadcasterId, description: description })
    });
    if (marker.response.ok && marker.body.data && marker.body.data[0]) {
      native = true;
      offsetSec = TSLib.nativeOffsetSec(marker.body.data[0].position_seconds, tPostSentMs, t0, lagSec, offsetSec);
    } else if (marker.response.status !== 401 && marker.response.status !== 403) {
      warning = 'Twitch マーカーを作成できなかったため、ローカルに保存しました';
      if (marker.body.message) warning += ': ' + marker.body.message;
    }
  } catch (error) {
    warning = 'Twitch マーカーを作成できなかったため、ローカルに保存しました';
  }

  return saveRecord(stream, channel, by, memo, offsetSec, native, warning);
}

async function handleMessage(message) {
  switch (message.type) {
    case 'login':
      return handleLogin();
    case 'logout':
      await serializedStorage(function () { return chrome.storage.local.set({ auth: { token: '', login: '', userId: '' } }); });
      return {};
    case 'stamp':
      return handleStamp(message);
    case 'getState': {
      const state = await readState();
      state.redirectUrl = chrome.identity.getRedirectURL();
      state.serverPermission = await hasHostPermission(state.settings.serverUrl);
      return state;
    }
    case 'saveSettings': {
      const state = await readState();
      const nextSettings = {
        // 空欄は既定の Client ID / An empty Client ID falls back to the default
        clientId: String(message.settings.clientId || '').trim() || DEFAULT_SETTINGS.clientId,
        lagSec: Number(message.settings.lagSec),
        serverUrl: normalizeServerUrl(message.settings.serverUrl)
      };
      if (!Number.isFinite(nextSettings.lagSec) || nextSettings.lagSec < 0) throw new Error('遅延（秒）には 0 以上の数値を入力してください');
      const reloginRequired = nextSettings.clientId !== state.settings.clientId;
      await serializedStorage(function () {
        const changes = { settings: nextSettings };
        if (reloginRequired) changes.auth = { token: '', login: '', userId: '' };
        return chrome.storage.local.set(changes);
      });
      return { settings: nextSettings, reloginRequired: reloginRequired };
    }
    case 'importRecords': {
      return serializedStorage(async function () {
        const state = await readState();
        const incoming = Array.isArray(message.records) ? message.records : [];
        const merged = TSLib.mergeRecords(state.records, incoming);
        await chrome.storage.local.set({ records: merged });
        // 取り込んだ記録もサーバーへ送る / Imported records are uploaded too
        await addPending(TSLib.mergeRecords(incoming).map(function (record) { return record.id; }));
        return { added: merged.length - state.records.length };
      }).then(function (result) {
        kickUpload();
        return result;
      });
    }
    case 'syncNow': {
      // 手元の全記録（墓標を含む）を送り直す / Resend every local record, tombstones included
      const state = await readState();
      await enqueue(TSLib.mergeRecords(state.records).map(function (record) { return record.id; }));
      return uploadPending();
    }
    case 'updateMemo':
      // Memo typed after stamping. Native Twitch markers cannot be edited via the API, so this only updates the local record.
      return serializedStorage(async function () {
        const state = await readState();
        const record = state.records.find(function (item) { return item.id === message.id; });
        if (!record) throw new Error('記録が見つかりません');
        record.memo = String(message.memo || '').trim().slice(0, 500);
        record.updated_at = new Date().toISOString();
        await chrome.storage.local.set({ records: state.records });
        await addPending([record.id]);
        return { record: record };
      }).then(function (result) {
        kickUpload();
        return result;
      });
    case 'deleteStream':
      return serializedStorage(async function () {
        const state = await readState();
        const records = state.records.filter(function (record) { return record.stream_id !== message.stream_id; });
        await chrome.storage.local.set({ records: records });
        return {};
      });
    case 'deleteRecord':
      return serializedStorage(async function () {
        const state = await readState();
        const target = TSLib.recordKey(message.record);
        let removed = false;
        const records = state.records.filter(function (record) {
          if (!removed && TSLib.recordKey(record) === target) {
            removed = true;
            return false;
          }
          return true;
        });
        await chrome.storage.local.set({ records: records });
        return {};
      });
    default:
      throw new Error('不明な操作です');
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  handleMessage(message).then(function (result) {
    sendResponse(Object.assign({ ok: true }, result));
  }).catch(function (error) {
    sendResponse({ ok: false, error: error && error.message ? error.message : '処理に失敗しました' });
  });
  return true;
});

// 5 分ごとに送り直す。既にあれば作り直さない（作り直すと周期が延びる）
// Retries every 5 minutes. An existing alarm is kept, since re-creating it would push the period back.
chrome.alarms.get('yts-flush').then(function (existing) {
  if (!existing) chrome.alarms.create('yts-flush', { periodInMinutes: 5 });
}).catch(function () {});
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'yts-flush') return uploadPending();
  return undefined;
});

chrome.commands.onCommand.addListener(async function (command) {
  const t0 = Date.now();
  if (command !== 'stamp') return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || tab.id === undefined) return;
  let result;
  try {
    result = Object.assign({ ok: true }, await handleStamp({ url: tab.url || '', memo: '', pressedAt: t0 }));
  } catch (error) {
    result = { ok: false, error: error && error.message ? error.message : '処理に失敗しました' };
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toast', result: result });
  } catch (error) {
    // The active tab may not have the content script.
  }
});

// Node のテストから読むための公開（拡張では module が無いので何もしない）
// Exposed for Node tests; a no-op in the extension where module is undefined.
if (typeof module !== 'undefined') module.exports = { handleMessage: handleMessage, readState: readState, hasHostPermission: hasHostPermission, uploadPending: uploadPending, enqueue: enqueue };
