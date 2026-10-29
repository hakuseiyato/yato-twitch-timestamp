'use strict';

// マイページ: サインイン中の login と、パネル用トークンの発行・一覧・失効
// My page: the signed-in login, and issuing, listing and revoking panel tokens.
(function () {
  const { api, errorText, formatDate, el, setStatus, busy, requireSession, renderHeader } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };

  // 認証経路の表示名 / Display names of the auth routes
  const VIA_TEXT = { session: 'Web', token: 'パネル用トークン / panel token', twitch: 'Twitch トークン / Twitch token' };

  async function revoke(token, button) {
    const name = token.label ? token.label + ' (' + token.prefix + ')' : token.prefix;
    if (!confirm('トークン「' + name + '」を失効させますか？ このトークンを使うパネルは同期できなくなります。\nRevoke token "' + name + '"? Panels using it will stop syncing.')) return;
    await busy(button, async function () {
      try {
        await api('/api/tokens/' + encodeURIComponent(token.prefix), { method: 'DELETE' });
        setStatus($('tokens-status'), '失効させました / Revoked', 'ok');
        await loadTokens(true);
      } catch (e) {
        setStatus($('tokens-status'), errorText(e), 'error');
      }
    });
  }

  function tokenRow(token) {
    const button = el('button', { type: 'button', class: 'danger', text: '失効 / Revoke' });
    button.addEventListener('click', function () { revoke(token, button); });
    return el('tr', null, [
      el('td', { class: 'mono', text: token.prefix }),
      el('td', { class: token.label ? null : 'muted', text: token.label || '—' }),
      el('td', { class: 'num', text: formatDate(token.created_at) }),
      el('td', { class: 'num', text: token.last_used_at ? formatDate(token.last_used_at) : '未使用 / Never' }),
      el('td', { class: 'actions' }, button)
    ]);
  }

  // keepStatus が真なら直前の結果表示を残す / Keeps the previous result message when keepStatus is true
  async function loadTokens(keepStatus) {
    const list = $('token-list');
    const status = $('tokens-status');
    let tokens;
    try {
      // GET /api/tokens は配列をそのまま返す / GET /api/tokens returns a bare array
      tokens = await api('/api/tokens');
    } catch (e) {
      setStatus(status, errorText(e), 'error');
      return;
    }
    if (!keepStatus) setStatus(status, '');
    if (!tokens || tokens.length === 0) {
      list.replaceChildren(el('p', { class: 'empty', text: '発行済みのトークンはありません / No tokens issued' }));
      return;
    }
    list.replaceChildren(el('table', null, [
      el('thead', null, el('tr', null, [
        el('th', { scope: 'col', text: 'ID' }),
        el('th', { scope: 'col', text: 'ラベル / Label' }),
        el('th', { scope: 'col', text: '発行日時 / Created' }),
        el('th', { scope: 'col', text: '最終使用 / Last used' }),
        el('th', { scope: 'col' }, el('span', { class: 'muted', text: '操作 / Actions' }))
      ])),
      el('tbody', null, tokens.map(tokenRow))
    ]));
  }

  async function issue(event) {
    event.preventDefault();
    const labelText = $('token-label').value.trim();
    await busy($('issue-button'), async function () {
      try {
        const result = await api('/api/tokens', { method: 'POST', body: { label: labelText || null } });
        $('token-value').value = result.token;
        $('token-reveal').hidden = false;
        setStatus($('copy-status'), '');
        $('token-label').value = '';
        $('token-value').focus();
        $('token-value').select();
        setStatus($('tokens-status'), '発行しました / Issued', 'ok');
        await loadTokens(true);
      } catch (e) {
        setStatus($('tokens-status'), errorText(e), 'error');
      }
    });
  }

  async function copyToken() {
    const input = $('token-value');
    try {
      await navigator.clipboard.writeText(input.value);
      setStatus($('copy-status'), 'コピーしました / Copied', 'ok');
    } catch (e) {
      input.focus();
      input.select();
      setStatus($('copy-status'), 'コピーできませんでした。選択中の文字を手でコピーしてください / Copy failed; copy the selected text by hand', 'error');
    }
  }

  async function boot() {
    let me;
    try {
      me = await requireSession();
    } catch (e) {
      setStatus($('boot-status'), errorText(e), 'error');
      return;
    }
    $('boot-status').hidden = true;
    renderHeader(me, '/me');
    $('me-login').textContent = me.login;
    $('me-via').textContent = '(' + (VIA_TEXT[me.via] || me.via) + ')';
    $('account-view').hidden = false;
    $('tokens-view').hidden = false;
    $('issue-form').addEventListener('submit', issue);
    $('copy-button').addEventListener('click', copyToken);
    await loadTokens();
  }

  boot();
}());
