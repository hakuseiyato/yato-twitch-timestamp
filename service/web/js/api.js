'use strict';

// Web ページ共通: Worker の API 呼び出し、サインイン URL、見出しバー、DOM 組み立て
// ブラウザでは素の識別子 YTSApi（classic script の const）、Node では require で読む
// Shared by the web pages: Worker API calls, the sign-in URL, the header bar and DOM building.
// A bare YTSApi identifier in the browser (classic-script const), require() in Node.
const YTSApi = (function () {
  const STATE_KEY = 'yts_state';
  const TWITCH_TOKEN_KEY = 'yts_twitch_token';
  const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';

  // エラーコード → 日英の文言 / Error code -> bilingual message
  const ERROR_TEXT = {
    network: '通信できませんでした / Network error',
    unauthorized: 'サインインが必要です / Sign-in required',
    forbidden: '権限がありません / Not allowed',
    csrf: '要求が拒否されました / Request rejected',
    session_required: 'Web からのサインインが必要です / Web sign-in required',
    bad_request: '入力が正しくありません / Invalid input',
    not_found: '見つかりません / Not found',
    exists: '既に存在します / Already exists',
    last_owner: '最後の owner は外せません / The last owner cannot be removed',
    client_mismatch: '別アプリのトークンです / Token belongs to another app',
    twitch_unavailable: 'Twitch に接続できません。少し待って再試行してください / Twitch is unavailable, try again shortly',
    invalid_label: 'ラベルが長すぎます / Label is too long',
    payload_too_large: 'データが大きすぎます / Payload too large',
    internal: 'サーバーエラー / Server error'
  };

  // Worker の API を呼ぶ。非 2xx と通信失敗は {status, error, detail} を throw
  // Calls the Worker API. Non-2xx and network failures throw {status, error, detail}.
  async function api(path, options) {
    const opts = options || {};
    const headers = { 'X-Requested-With': 'yts' };
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw { status: 0, error: 'network', detail: String((e && e.message) || e) };
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!res.ok) {
      throw { status: res.status, error: (data && data.error) || 'http_' + res.status, detail: data && data.detail };
    }
    return data;
  }

  // 例外 → 画面に出す文言（コードも添える）/ Thrown value -> on-screen message (with the code)
  function errorText(err) {
    const code = (err && err.error) || 'unknown';
    const base = ERROR_TEXT[code] || 'エラーが発生しました / Something went wrong';
    return base + ' (' + code + (err && err.status ? ' ' + err.status : '') + ')';
  }

  // サインイン必須のページ用。401 なら / へ移り、resolve しない
  // For pages that need a session. On 401 moves to / and never resolves.
  async function requireSession() {
    try {
      return await api('/api/me');
    } catch (e) {
      if (e && e.status === 401) {
        location.replace('/');
        return new Promise(function () {});
      }
      throw e;
    }
  }

  function randomState() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // implicit grant の URL。state は sessionStorage に置き、callback で照合する
  // The implicit-grant URL. state is kept in sessionStorage and checked on the callback.
  function signInUrl(clientId) {
    const state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    const params = new URLSearchParams({
      response_type: 'token',
      client_id: clientId,
      redirect_uri: location.origin + '/auth/callback',
      scope: '',
      state: state
    });
    return AUTHORIZE_URL + '?' + params.toString();
  }

  // Helix 用の Twitch トークン（タブを閉じると消える）/ Twitch token for Helix (gone when the tab closes)
  function twitchToken() {
    try { return sessionStorage.getItem(TWITCH_TOKEN_KEY); } catch (e) { return null; }
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // ISO → ローカル時刻の 'YYYY-MM-DD HH:mm'。空・不正は '—'
  // ISO -> local 'YYYY-MM-DD HH:mm'. Empty or invalid gives '—'.
  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // 要素を作る。文字列は textContent で入れる（innerHTML は使わない）
  // Builds an element. Strings go in via textContent (never innerHTML).
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // 状態行に文言を出す。kind は 'ok' / 'error' / '' / Shows a message on a status line; kind is 'ok' / 'error' / ''
  function setStatus(node, text, kind) {
    node.textContent = text || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  // 要求中はボタンを無効にする / Disables the button while a request runs
  async function busy(button, task) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      return await task();
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function signOut() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // 失敗しても手元の状態は消してトップへ / Even on failure, clear local state and go to the top
    }
    try { sessionStorage.removeItem(TWITCH_TOKEN_KEY); } catch (e) { /* storage blocked */ }
    location.replace('/');
  }

  // 見出しバー（#site-header）を描く。管理リンクは site admin か owner のときだけ
  // Renders the header bar (#site-header). The admin link appears only for the site admin or an owner.
  function renderHeader(me, current) {
    const header = document.getElementById('site-header');
    const canAdmin = me.site_admin || (me.channels || []).some(function (c) { return c.role === 'owner'; });
    const link = function (href, text) {
      return el('a', { href: href, text: text, 'aria-current': current === href ? 'page' : null });
    };
    header.replaceChildren(
      el('a', { class: 'brand', href: '/', text: 'Yato Twitch Timestamp' }),
      el('nav', { class: 'site-nav', 'aria-label': 'メニュー / Menu' }, [
        link('/', '配信一覧 / Streams'),
        link('/me', 'マイページ / My page'),
        canAdmin ? link('/admin', '管理 / Admin') : null,
        el('span', { class: 'who', text: me.login }),
        el('button', { type: 'button', class: 'secondary', text: 'サインアウト / Sign out', onclick: signOut })
      ])
    );
    header.hidden = false;
  }

  return {
    api: api,
    errorText: errorText,
    requireSession: requireSession,
    signInUrl: signInUrl,
    twitchToken: twitchToken,
    formatDate: formatDate,
    el: el,
    setStatus: setStatus,
    busy: busy,
    signOut: signOut,
    renderHeader: renderHeader
  };
}());

if (typeof module !== 'undefined') module.exports = YTSApi;
