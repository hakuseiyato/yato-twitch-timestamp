'use strict';

// マイページ: サインイン中の login と、パネル用トークンの発行・一覧・失効
// My page: the signed-in login, and issuing, listing and revoking panel tokens.
(function () {
  const { api, errorText, formatDate, el, setStatus, busy, requireSession, renderHeader } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };

  // 認証経路の表示名 / Display names of the auth routes
  const VIA_TEXT = { session: 'Web', token: 'パネル用トークン', twitch: 'Twitch トークン' };

  async function revoke(token, button) {
    const name = token.label ? token.label + ' (' + token.prefix + ')' : token.prefix;
    if (!confirm('トークン「' + name + '」を失効させますか？ このトークンを使うパネルは同期できなくなります。')) return;
    await busy(button, async function () {
      try {
        await api('/api/tokens/' + encodeURIComponent(token.prefix), { method: 'DELETE' });
        setStatus($('tokens-status'), '失効させました', 'ok');
        await loadTokens(true);
      } catch (e) {
        setStatus($('tokens-status'), errorText(e), 'error');
      }
    });
  }

  // 1 行: ラベル（ID を薄く後ろに）/ 発行 / 最終使用 / 失効
  // One row: label (ID faint after it) / created / last used / revoke
  function tokenRow(token) {
    const button = el('button', { type: 'button', class: 'btn ghost danger', text: '失効' });
    button.addEventListener('click', function () { revoke(token, button); });
    return el('tr', null, [
      el('td', null, [
        el('span', { class: token.label ? null : 'muted', text: token.label || '—' }),
        ' ',
        el('span', { class: 'faint mono', text: token.prefix })
      ]),
      el('td', { class: 'muted num', text: formatDate(token.created_at) }),
      el('td', { class: 'muted num', text: token.last_used_at ? formatDate(token.last_used_at) : '未使用' }),
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
      list.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty', text: '発行済みのトークンはありません' })));
      return;
    }
    list.replaceChildren(el('div', { class: 'panel' }, el('table', null, [
      el('thead', null, el('tr', null, [
        el('th', { scope: 'col', text: 'ラベル' }),
        el('th', { scope: 'col', text: '発行' }),
        el('th', { scope: 'col', text: '最終使用' }),
        el('th', { scope: 'col', 'aria-label': '操作' })
      ])),
      el('tbody', null, tokens.map(tokenRow))
    ])));
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
        setStatus($('tokens-status'), '発行しました', 'ok');
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
      setStatus($('copy-status'), 'コピーしました', 'ok');
    } catch (e) {
      input.focus();
      input.select();
      setStatus($('copy-status'), 'コピーできませんでした。選択中の文字を手でコピーしてください', 'error');
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
    $('me-via').textContent = '（' + (VIA_TEXT[me.via] || me.via) + '）';
    $('account-view').hidden = false;
    $('tokens-view').hidden = false;
    $('issue-form').addEventListener('submit', issue);
    $('copy-button').addEventListener('click', copyToken);
    await loadTokens();
  }

  boot();
}());
