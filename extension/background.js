'use strict';

importScripts('lib.js');

const DEFAULT_SETTINGS = { clientId: '', lagSec: 5 };
const streamCache = new Map();
let storageChain = Promise.resolve();

function serializedStorage(operation) {
  const next = storageChain.then(operation, operation);
  storageChain = next.catch(function () {});
  return next;
}

async function readState() {
  const stored = await chrome.storage.local.get(['settings', 'auth', 'records']);
  return {
    settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings || {}),
    auth: Object.assign({ token: '', login: '', userId: '' }, stored.auth || {}),
    records: Array.isArray(stored.records) ? stored.records : []
  };
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
  await serializedStorage(function () { return chrome.storage.local.set({ auth: auth }); });
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
  });
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
      return state;
    }
    case 'saveSettings': {
      const state = await readState();
      const nextSettings = {
        clientId: String(message.settings.clientId || '').trim(),
        lagSec: Number(message.settings.lagSec)
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
        return { added: merged.length - state.records.length };
      });
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
        return { record: record };
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
