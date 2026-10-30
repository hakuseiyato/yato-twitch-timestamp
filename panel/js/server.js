'use strict';

// パネルの同期元「サーバー」の通信（設定の保存・/api の呼び出し・スタンプの pull / push）
// The panel's "server" sync source: saving settings, calling /api, and pulling / pushing stamps.
// fetch と localStorage は globalThis から取る。テストは configure で差し替える
// fetch and localStorage come from globalThis; tests replace them through configure.
const YTSServer = (function () {
  // CEP（require 無し）で lib.js が読めなくても、読み込み時には throw しない（main.js が案内を出せるように）
  // With lib.js missing in CEP (no require), do not throw at load time so main.js can show its notice.
  const lib = typeof TSLib !== 'undefined' ? TSLib : (typeof require === 'function' ? require('./lib.js') : null);
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

  // lib が要る関数で呼ぶ。読めていなければ日英の Error / Called by functions that need lib; throws a bilingual Error when it is missing
  function requireLib() {
    if (!lib) throw new Error('lib.js を読み込めませんでした。panel\\install.ps1 を再実行してください');
    return lib;
  }

  // 入力を検査し、URL を origin（https://host[:port]）にそろえる。保存はしない
  // Validates the input and normalizes the URL to its origin (https://host[:port]); does not save.
  function normalizeSettings(settings) {
    const input = settings || {};
    let url;
    try {
      url = new URL(String(input.serverUrl || '').trim());
    } catch (error) {
      throw new Error('サーバー URL が正しくありません');
    }
    if (url.protocol !== 'https:') throw new Error('サーバー URL は https:// で始めてください');
    const token = String(input.token || '').trim();
    if (!token) throw new Error('トークンを入力してください');
    return { serverUrl: url.origin, token: token };
  }

  // 検査・正規化してから保存する / Validates, normalizes, then saves
  function saveSettings(settings) {
    const saved = normalizeSettings(settings);
    storage().setItem(SETTINGS_KEY, JSON.stringify(saved));
    return saved;
  }

  function messageForStatus(status) {
    if (status === 401) return 'トークンが無効です。Web の /me で発行し直してください';
    if (status === 403) return 'このチャンネルの会員ではありません';
    if (status === 404) return 'サーバーに見つかりません (404)';
    if (requireLib().isRetryableUpload(status)) return 'サーバーが一時的に応答しません (' + status + ')';
    return 'サーバーがエラーを返しました (' + status + ')';
  }

  // Bearer トークン付きで JSON をやり取りする。非 2xx は {status, error, detail, message} の Error を throw
  // Exchanges JSON with the Bearer token; non-2xx throws an Error with {status, error, detail, message}.
  // opts.settings があれば保存済みの設定の代わりに使う（接続の確認用）
  // opts.settings, when given, replaces the saved settings (used to check before saving).
  async function api(path, options) {
    const opts = options || {};
    const settings = opts.settings || loadSettings();
    if (!settings.serverUrl || !settings.token) {
      throw apiError(0, 'not_configured', '', 'サーバー URL とトークンを設定してください');
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
      throw apiError(0, 'network', error && error.message ? error.message : String(error), 'サーバーに接続できません');
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

  // candidate（normalizeSettings の結果）を渡すと、保存せずにその設定で確かめる
  // With candidate (a normalizeSettings result), checks those settings without saving them.
  function me(candidate) {
    return api('/api/me', candidate ? { settings: candidate } : undefined);
  }

  async function listStreams(channel) {
    const data = await api('/api/channels/' + encodeURIComponent(channel) + '/streams');
    if (!data || !Array.isArray(data.streams)) throw apiError(200, 'http_200', '', 'サーバーの応答が不正です');
    return data.streams;
  }

  // 墓標込みの全件 / All records including tombstones
  async function pullStamps(streamId) {
    const data = await api('/api/streams/' + encodeURIComponent(streamId) + '/stamps');
    if (!data || !Array.isArray(data.records)) throw apiError(200, 'http_200', '', 'サーバーの応答が不正です');
    return data.records;
  }

  // 500 件ずつ送り、結果をまとめる。失敗したら残りは送らず、そこまでの結果を partial に付けて throw
  // (retryable はネットワーク失敗 / 408 / 429 / 5xx / 形の不正な 200)
  // Sends 500 records per request and aggregates the results. On failure the rest is not sent and the error is thrown
  // with the results so far in partial (retryable for network failure / 408 / 429 / 5xx / a malformed 200).
  async function pushStamps(records) {
    const list = records || [];
    const batches = requireLib().planUpload(list, list.map(function (record) { return record.id; }), MAX_PER_REQUEST);
    const total = { accepted: [], rejected: [] };
    for (let i = 0; i < batches.length; i += 1) {
      let response;
      try {
        response = await api('/api/stamps', { method: 'POST', body: { records: batches[i].records, source: 'panel' } });
        if (!response || !Array.isArray(response.accepted) || !Array.isArray(response.rejected)) {
          throw apiError(200, 'http_200', '', 'サーバーの応答が不正です');
        }
      } catch (error) {
        // 未設定は status 0 でも再送で直らない / Missing settings are not fixed by a retry despite status 0
        error.retryable = error.error === 'http_200' || (error.error !== 'not_configured' && requireLib().isRetryableUpload(error.status));
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
    normalizeSettings: normalizeSettings,
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
