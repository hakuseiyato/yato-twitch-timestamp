'use strict';

// パネルの同期元「サーバー」の通信（設定の保存・/api の呼び出し・スタンプの pull / push）
// The panel's "server" sync source: saving settings, calling /api, and pulling / pushing stamps.
// fetch と localStorage は globalThis から取る。テストは configure で差し替える
// fetch and localStorage come from globalThis; tests replace them through configure.
const YTSServer = (function () {
  const lib = typeof TSLib !== 'undefined' ? TSLib : require('./lib.js');
  const SETTINGS_KEY = 'yts.server';
  const MAX_PER_REQUEST = 500;
  const overrides = { fetch: null, storage: null };

  function configure(options) {
    const opts = options || {};
    if (opts.fetch) overrides.fetch = opts.fetch;
    if (opts.storage) overrides.storage = opts.storage;
  }

  function storage() {
    return overrides.storage || globalThis.localStorage;
  }

  function fetchImpl(url, init) {
    return overrides.fetch ? overrides.fetch(url, init) : globalThis.fetch(url, init);
  }

  // status / error / detail を持つ Error を作る / Builds an Error carrying status / error / detail
  function apiError(status, error, detail, message) {
    const result = new Error(message);
    result.status = status;
    result.error = error;
    result.detail = detail;
    return result;
  }

  function loadSettings() {
    try {
      const value = JSON.parse(storage().getItem(SETTINGS_KEY) || '{}');
      return {
        serverUrl: typeof value.serverUrl === 'string' ? value.serverUrl : '',
        token: typeof value.token === 'string' ? value.token : ''
      };
    } catch (error) {
      return { serverUrl: '', token: '' };
    }
  }

  // URL は origin（https://host[:port]）にそろえて保存する / Saves the URL normalized to its origin (https://host[:port])
  function saveSettings(settings) {
    const input = settings || {};
    let url;
    try {
      url = new URL(String(input.serverUrl || '').trim());
    } catch (error) {
      throw new Error('サーバー URL が正しくありません / Invalid server URL');
    }
    if (url.protocol !== 'https:') throw new Error('サーバー URL は https:// で始めてください / The server URL must start with https://');
    const token = String(input.token || '').trim();
    if (!token) throw new Error('トークンを入力してください / Enter a token');
    const saved = { serverUrl: url.origin, token: token };
    storage().setItem(SETTINGS_KEY, JSON.stringify(saved));
    return saved;
  }

  function messageForStatus(status) {
    if (status === 401) return 'トークンが無効です。Web の /me で発行し直してください / Token invalid. Issue a new one on /me';
    if (status === 403) return 'このチャンネルの会員ではありません / Not a member of this channel';
    if (status === 404) return 'サーバーに見つかりません (404) / Not found on the server (404)';
    if (lib.isRetryableUpload(status)) return 'サーバーが一時的に応答しません (' + status + ') / Server temporarily unavailable (' + status + ')';
    return 'サーバーがエラーを返しました (' + status + ') / Server returned an error (' + status + ')';
  }

  // Bearer トークン付きで JSON をやり取りする。非 2xx は {status, error, detail, message} の Error を throw
  // Exchanges JSON with the Bearer token; non-2xx throws an Error with {status, error, detail, message}.
  async function api(path, options) {
    const opts = options || {};
    const settings = loadSettings();
    if (!settings.serverUrl || !settings.token) {
      throw apiError(0, 'not_configured', '', 'サーバー URL とトークンを設定してください / Set the server URL and token');
    }
    const headers = { Authorization: 'Bearer ' + settings.token };
    const init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let response;
    try {
      response = await fetchImpl(settings.serverUrl + path, init);
    } catch (error) {
      throw apiError(0, 'network', error && error.message ? error.message : String(error), 'サーバーに接続できません / Cannot reach the server');
    }
    let data = null;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = null;
    }
    if (!response.ok) {
      const body = data && typeof data === 'object' ? data : {};
      throw apiError(response.status, body.error || 'http_' + response.status, body.detail || '', messageForStatus(response.status));
    }
    return data;
  }

  function me() {
    return api('/api/me');
  }

  async function listStreams(channel) {
    const data = await api('/api/channels/' + encodeURIComponent(channel) + '/streams');
    if (!data || !Array.isArray(data.streams)) throw apiError(200, 'http_200', '', 'サーバーの応答が不正です / Unexpected server response');
    return data.streams;
  }

  // 墓標込みの全件 / All records including tombstones
  async function pullStamps(streamId) {
    const data = await api('/api/streams/' + encodeURIComponent(streamId) + '/stamps');
    if (!data || !Array.isArray(data.records)) throw apiError(200, 'http_200', '', 'サーバーの応答が不正です / Unexpected server response');
    return data.records;
  }

  // 500 件ずつ送り、結果をまとめる。失敗したら残りは送らず、そこまでの結果を partial に付けて throw
  // (retryable はネットワーク失敗 / 408 / 429 / 5xx / 形の不正な 200)
  // Sends 500 records per request and aggregates the results. On failure the rest is not sent and the error is thrown
  // with the results so far in partial (retryable for network failure / 408 / 429 / 5xx / a malformed 200).
  async function pushStamps(records) {
    const list = records || [];
    const batches = lib.planUpload(list, list.map(function (record) { return record.id; }), MAX_PER_REQUEST);
    const total = { accepted: [], rejected: [] };
    for (let i = 0; i < batches.length; i += 1) {
      let response;
      try {
        response = await api('/api/stamps', { method: 'POST', body: { records: batches[i].records, source: 'panel' } });
        if (!response || !Array.isArray(response.accepted) || !Array.isArray(response.rejected)) {
          throw apiError(200, 'http_200', '', 'サーバーの応答が不正です / Unexpected server response');
        }
      } catch (error) {
        // 未設定は status 0 でも再送で直らない / Missing settings are not fixed by a retry despite status 0
        error.retryable = error.error === 'http_200' || (error.error !== 'not_configured' && lib.isRetryableUpload(error.status));
        error.partial = total;
        throw error;
      }
      total.accepted = total.accepted.concat(response.accepted);
      total.rejected = total.rejected.concat(response.rejected);
    }
    return total;
  }

  return {
    configure: configure,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    api: api,
    me: me,
    listStreams: listStreams,
    pullStamps: pullStamps,
    pushStamps: pushStamps
  };
}());

if (typeof window !== 'undefined') window.YTSServer = YTSServer;
if (typeof module !== 'undefined') module.exports = YTSServer;
