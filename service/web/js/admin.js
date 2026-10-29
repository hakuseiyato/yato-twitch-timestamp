'use strict';

// 管理ページ: サイト管理者はチャンネル作成、owner は自分のチャンネルの会員の追加・削除
// それ以外の人には 403 の案内だけを出す
// Admin page: the site admin creates channels, owners add and remove members of their channels.
// Everyone else sees only the 403 notice.
(function () {
  const { api, errorText, formatDate, el, setStatus, busy, requireSession, renderHeader } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };
  const ROLE_TEXT = { owner: 'owner（管理） / owner', editor: 'editor（編集） / editor' };
  const LOGIN_HINT = 'Twitch の login（英小文字・数字・_、25 文字まで）を入力してください / Enter a Twitch login (lowercase letters, digits, _; up to 25)';

  let me = null;

  function channelPath(channel) {
    return '/api/channels/' + encodeURIComponent(channel) + '/members';
  }

  // ---- 会員 / Members ----

  function memberRow(channel, member, status, reload) {
    const button = el('button', { type: 'button', class: 'danger', text: '削除 / Remove' });
    button.addEventListener('click', async function () {
      if (!confirm('「' + member.login + '」を ' + channel + ' から外しますか？\nRemove "' + member.login + '" from ' + channel + '?')) return;
      await busy(button, async function () {
        try {
          await api(channelPath(channel) + '/' + encodeURIComponent(member.login), { method: 'DELETE' });
          setStatus(status, '削除しました / Removed', 'ok');
          await reload(true);
        } catch (e) {
          setStatus(status, errorText(e), 'error');
        }
      });
    });
    return el('tr', null, [
      el('td', { text: member.login }),
      el('td', { text: ROLE_TEXT[member.role] || member.role || '—' }),
      el('td', { class: member.added_by ? null : 'muted', text: member.added_by || '—' }),
      el('td', { class: 'num', text: formatDate(member.added_at) }),
      el('td', { class: 'actions' }, button)
    ]);
  }

  function addForm(channel, status, reload) {
    const id = 'add-' + channel;
    const loginInput = el('input', { id: id + '-login', autocomplete: 'off', maxlength: '25', 'aria-describedby': id + '-error' });
    const roleSelect = el('select', { id: id + '-role' }, [
      el('option', { value: 'editor', text: ROLE_TEXT.editor }),
      el('option', { value: 'owner', text: ROLE_TEXT.owner })
    ]);
    const submit = el('button', { type: 'submit', class: 'primary', text: '追加 / Add' });
    const fieldError = el('p', { class: 'field-error', id: id + '-error', role: 'alert' });
    const form = el('form', { novalidate: true }, [
      el('div', { class: 'form-row' }, [
        el('div', { class: 'field' }, [el('label', { for: loginInput.id, text: '追加する login / Login to add' }), loginInput]),
        el('div', { class: 'field narrow' }, [el('label', { for: roleSelect.id, text: '役割 / Role' }), roleSelect]),
        submit
      ]),
      fieldError
    ]);
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const login = TSLib.validLogin(loginInput.value.trim());
      fieldError.textContent = login ? '' : LOGIN_HINT;
      loginInput.classList.toggle('invalid', !login);
      if (!login) {
        loginInput.focus();
        return;
      }
      await busy(submit, async function () {
        try {
          await api(channelPath(channel), { method: 'POST', body: { login: login, role: roleSelect.value } });
          loginInput.value = '';
          setStatus(status, '追加しました / Added', 'ok');
          await reload(true);
        } catch (e) {
          setStatus(status, errorText(e), 'error');
        }
      });
    });
    return form;
  }

  // 1 チャンネル分の枠を作り、会員表を読み込む / Builds one channel's section and loads its member table
  function channelSection(channel) {
    const status = el('p', { class: 'status', role: 'status' });
    const tableWrap = el('div', { class: 'table-wrap' });
    const heading = channel.display_name ? channel.display_name + ' (' + channel.login + ')' : channel.login;

    async function reload(keepStatus) {
      let members;
      try {
        members = (await api(channelPath(channel.login))).members || [];
      } catch (e) {
        setStatus(status, errorText(e), 'error');
        return;
      }
      if (!keepStatus) setStatus(status, '');
      tableWrap.replaceChildren(el('table', null, [
        el('thead', null, el('tr', null, [
          el('th', { scope: 'col', text: 'login' }),
          el('th', { scope: 'col', text: '役割 / Role' }),
          el('th', { scope: 'col', text: '追加した人 / Added by' }),
          el('th', { scope: 'col', text: '追加日時 / Added at' }),
          el('th', { scope: 'col' }, el('span', { class: 'muted', text: '操作 / Actions' }))
        ])),
        el('tbody', null, members.map(function (m) { return memberRow(channel.login, m, status, reload); }))
      ]));
    }

    const section = el('section', { class: 'card', 'data-channel': channel.login, 'aria-label': heading }, [
      el('div', { class: 'card-head' }, el('h2', { text: heading })),
      tableWrap,
      addForm(channel.login, status, reload),
      status
    ]);
    reload();
    return section;
  }

  // owner のチャンネルを読み直して枠を作り直す / Reloads the owned channels and rebuilds their sections
  async function loadChannels() {
    const container = $('channel-sections');
    let channels;
    try {
      channels = ((await api('/api/channels')).channels || []).filter(function (c) { return c.role === 'owner'; });
    } catch (e) {
      container.replaceChildren(el('p', { class: 'status error', text: errorText(e) }));
      return [];
    }
    if (channels.length === 0 && me.site_admin) {
      container.replaceChildren(el('p', { class: 'empty', text: 'チャンネルはまだありません / No channels yet' }));
    } else {
      container.replaceChildren.apply(container, channels.map(channelSection));
    }
    return channels;
  }

  // ---- チャンネル作成 / Create channel ----

  async function createChannel(event) {
    event.preventDefault();
    const loginInput = $('create-login');
    const login = TSLib.validLogin(loginInput.value.trim());
    $('create-error').textContent = login ? '' : LOGIN_HINT;
    loginInput.classList.toggle('invalid', !login);
    if (!login) {
      loginInput.focus();
      return;
    }
    const displayName = $('create-display').value.trim();
    await busy($('create-button'), async function () {
      try {
        await api('/api/channels', { method: 'POST', body: { login: login, display_name: displayName || null } });
        loginInput.value = '';
        $('create-display').value = '';
        setStatus($('create-status'), '作成しました / Created: ' + login, 'ok');
        await loadChannels();
      } catch (e) {
        setStatus($('create-status'), errorText(e), 'error');
      }
    });
  }

  async function boot() {
    try {
      me = await requireSession();
    } catch (e) {
      setStatus($('boot-status'), errorText(e), 'error');
      return;
    }
    $('boot-status').hidden = true;
    renderHeader(me, '/admin');
    const owns = (me.channels || []).some(function (c) { return c.role === 'owner'; });
    if (!me.site_admin && !owns) {
      $('forbidden-view').hidden = false;
      return;
    }
    $('admin-heading').hidden = false;
    if (me.site_admin) {
      $('create-view').hidden = false;
      $('create-form').addEventListener('submit', createChannel);
    }
    await loadChannels();
  }

  boot();
}());
