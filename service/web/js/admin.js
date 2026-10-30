'use strict';

// 管理ページ: サイト管理者はチャンネル作成、owner は自分のチャンネルの会員の追加・削除
// それ以外の人には 403 の案内だけを出す
// Admin page: the site admin creates channels, owners add and remove members of their channels.
// Everyone else sees only the 403 notice.
(function () {
  const { api, errorText, formatDate, el, setStatus, busy, requireSession, renderHeader } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };
  const ROLE_TEXT = { owner: 'owner', editor: 'editor' };
  const LOGIN_HINT = 'Twitch ログイン（英小文字・数字・_、25 文字まで）を入力してください';

  let me = null;

  function channelPath(channel) {
    return '/api/channels/' + encodeURIComponent(channel) + '/members';
  }

  // ---- 会員 / Members ----

  function memberRow(channel, member, status, reload) {
    const button = el('button', { type: 'button', class: 'btn ghost danger', text: '削除' });
    button.addEventListener('click', async function () {
      if (!confirm('「' + member.login + '」を ' + channel + ' から外しますか？')) return;
      await busy(button, async function () {
        try {
          await api(channelPath(channel) + '/' + encodeURIComponent(member.login), { method: 'DELETE' });
          setStatus(status, '削除しました', 'ok');
          await reload(true);
        } catch (e) {
          setStatus(status, errorText(e), 'error');
        }
      });
    });
    return el('tr', null, [
      el('td', { text: member.login }),
      el('td', { class: 'muted', text: ROLE_TEXT[member.role] || member.role || '—' }),
      el('td', { class: 'muted', text: member.added_by || '—' }),
      el('td', { class: 'muted num', text: formatDate(member.added_at) }),
      el('td', { class: 'actions' }, button)
    ]);
  }

  // 追加フォーム。入力欄は表の最終行に置き、form 属性で行の外の <form> に結び付ける（<tr> の中に <form> は置けない）
  // Add form. The fields sit in the table's last row and join the <form> outside it via the form attribute (a <form> cannot live inside a <tr>)
  function addForm(channel, status, reload) {
    const id = 'add-' + channel;
    const formId = id + '-form';
    const loginInput = el('input', { class: 'in', id: id + '-login', form: formId, autocomplete: 'off', maxlength: '25', placeholder: '追加する人のログイン', 'aria-label': '追加する人のログイン', 'aria-describedby': id + '-error' });
    const roleSelect = el('select', { class: 'inline', id: id + '-role', form: formId, 'aria-label': '役割' }, [
      el('option', { value: 'editor', text: ROLE_TEXT.editor }),
      el('option', { value: 'owner', text: ROLE_TEXT.owner })
    ]);
    const submit = el('button', { type: 'submit', class: 'btn', form: formId, text: '追加' });
    const fieldError = el('p', { class: 'field-error', id: id + '-error', role: 'alert' });
    const form = el('form', { id: formId, novalidate: true }, fieldError);
    const row = el('tr', null, [
      el('td', null, loginInput),
      el('td', null, roleSelect),
      el('td'),
      el('td'),
      el('td', { class: 'actions' }, submit)
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
          setStatus(status, '追加しました', 'ok');
          await reload(true);
        } catch (e) {
          setStatus(status, errorText(e), 'error');
        }
      });
    });
    return { form: form, row: row };
  }

  // 1 チャンネル分の節を作り、会員表を読み込む / Builds one channel's section and loads its member table
  function channelSection(channel) {
    const status = el('p', { class: 'status', role: 'status' });
    const add = addForm(channel.login, status, reload);
    const tbody = el('tbody', null, add.row);
    // 見出しは login。表示名が違えば薄く後ろに / The heading is the login, with a differing display name faint after it
    const showDisplay = channel.display_name && channel.display_name !== channel.login;
    const heading = showDisplay ? channel.login + ' ' + channel.display_name : channel.login;

    async function reload(keepStatus) {
      let members;
      try {
        members = (await api(channelPath(channel.login))).members || [];
      } catch (e) {
        setStatus(status, errorText(e), 'error');
        return;
      }
      if (!keepStatus) setStatus(status, '');
      // 追加フォームの行は動かさず、その前の会員の行だけ差し替える（入力中のフォーカスを保つ）
      // Replace only the member rows before the add row; the add row stays put so focus in it is kept
      while (tbody.firstChild !== add.row) tbody.firstChild.remove();
      add.row.before.apply(add.row, members.map(function (m) { return memberRow(channel.login, m, status, reload); }));
    }

    const section = el('section', { class: 'sec', 'data-channel': channel.login, 'aria-label': heading }, [
      el('div', { class: 'sec-h' }, el('h2', null, [
        channel.login,
        showDisplay ? el('span', { class: 'faint', text: ' ' + channel.display_name }) : null
      ])),
      el('div', { class: 'panel' }, el('table', { class: 'members' }, [
        el('thead', null, el('tr', null, [
          el('th', { scope: 'col', text: 'Twitch ログイン' }),
          el('th', { scope: 'col', text: '役割' }),
          el('th', { scope: 'col', text: '追加した人' }),
          el('th', { scope: 'col', text: '追加' }),
          el('th', { scope: 'col', 'aria-label': '操作' })
        ])),
        tbody
      ])),
      add.form,
      status,
      el('p', { class: 'help', text: 'editor はスタンプの追加と自分の分の削除ができます。owner は他の人のスタンプも消せます。' })
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
      container.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty', text: 'チャンネルはまだありません' })));
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
        setStatus($('create-status'), '作成しました: ' + login, 'ok');
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
