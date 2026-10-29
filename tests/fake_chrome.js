'use strict';

// background.js を Node で動かすための偽 chrome / fetch（依存ゼロ）
// Fake chrome / fetch for running background.js under Node (no dependencies).

// chrome.storage.*.get と同じ引数（null / 文字列 / 配列 / 既定値オブジェクト）を受ける
// Accepts the same key forms as chrome.storage.*.get (null / string / array / defaults object).
function pick(area, keys) {
  if (keys === null || keys === undefined) return structuredClone(area);
  const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
  const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const result = {};
  names.forEach((name) => {
    if (Object.prototype.hasOwnProperty.call(area, name)) result[name] = structuredClone(area[name]);
    else if (Object.prototype.hasOwnProperty.call(defaults, name)) result[name] = defaults[name];
  });
  return result;
}

function storageArea(area) {
  return {
    get: async (keys) => pick(area, keys),
    // set は既存の値にマージする / set merges into the existing values
    set: async (items) => { Object.assign(area, structuredClone(items)); },
    remove: async (keys) => { [].concat(keys).forEach((name) => { delete area[name]; }); }
  };
}

// 偽 chrome を作る。storage / session は直接中身を見られる素の object
// Builds a fake chrome. storage / session are plain objects tests can inspect directly.
function createFakeChrome(initialStorage, initialSession) {
  const storage = structuredClone(initialStorage || {});
  const session = structuredClone(initialSession || {});
  const calls = {
    messageHandler: null,
    commandHandler: null,
    alarmHandler: null,
    alarms: [],
    permissions: new Set(),
    tabMessages: []
  };
  const chrome = {
    storage: { local: storageArea(storage), session: storageArea(session) },
    runtime: {
      onMessage: { addListener: (fn) => { calls.messageHandler = fn; } },
      getURL: (path) => path
    },
    commands: { onCommand: { addListener: (fn) => { calls.commandHandler = fn; } } },
    tabs: {
      query: async () => [],
      sendMessage: async (tabId, message) => { calls.tabMessages.push([tabId, message]); }
    },
    identity: {
      getRedirectURL: () => 'https://fakeextensionid.chromiumapp.org/',
      // テストが上書きしない限り失敗する / Fails unless a test overrides it
      launchWebAuthFlow: async () => { throw new Error('launchWebAuthFlow is not mocked'); }
    },
    alarms: {
      create: (name, info) => { calls.alarms.push([name, info]); },
      get: async (name) => {
        const found = calls.alarms.filter((entry) => entry[0] === name).pop();
        return found ? Object.assign({ name: name }, found[1]) : undefined;
      },
      onAlarm: { addListener: (fn) => { calls.alarmHandler = fn; } }
    },
    // 拒否を試すテストは fc.chrome.permissions.request を上書きする / Override fc.chrome.permissions.request to simulate a denial
    permissions: {
      contains: async (query) => (query.origins || []).every((origin) => calls.permissions.has(origin)),
      request: async (query) => {
        (query.origins || []).forEach((origin) => calls.permissions.add(origin));
        return true;
      }
    }
  };
  return { chrome: chrome, calls: calls, storage: storage, session: session };
}

// background.js を毎回新しく評価して module.exports を返す
// Evaluates background.js fresh on every call and returns its module.exports.
function loadBackground(fakeChrome, fetchImpl) {
  const backgroundPath = require.resolve('../extension/background.js');
  delete require.cache[backgroundPath];
  globalThis.chrome = fakeChrome.chrome;
  globalThis.importScripts = (name) => {
    if (name === 'lib.js') globalThis.TSLib = require('../extension/lib.js');
  };
  globalThis.fetch = fetchImpl;
  return require(backgroundPath);
}

// routes: [{ match(url, init) => boolean, respond(url, init) => { status, body, headers? } }]
// headers 未指定の Date は現在時刻 / A missing Date header defaults to the current time
// 最初に一致した route が応答する。respond が throw すると通信失敗になる
// The first matching route answers; a throwing respond simulates a network failure.
function fakeFetch(routes) {
  const fetchImpl = async (url, init) => {
    fetchImpl.calls.push({ url: url, init: init });
    const route = routes.find((candidate) => candidate.match(url, init));
    if (!route) throw new Error('unmocked fetch: ' + url);
    const answer = await route.respond(url, init);
    const status = answer.status;
    const body = answer.body;
    // ヘッダ名は大文字小文字を区別しない / Header names are case-insensitive
    const headers = {};
    Object.keys(answer.headers || {}).forEach((key) => { headers[key.toLowerCase()] = answer.headers[key]; });
    return {
      ok: status >= 200 && status < 300,
      status: status,
      headers: {
        get: (key) => {
          const name = key.toLowerCase();
          if (headers[name] !== undefined) return headers[name];
          return name === 'date' ? new Date().toUTCString() : null;
        }
      },
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

module.exports = { createFakeChrome, loadBackground, fakeFetch };
