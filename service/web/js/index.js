'use strict';

// トップページ: 未サインインならサインインボタン、サインイン後はチャンネルの配信一覧と VOD 登録
// Top page: a sign-in button when signed out; once signed in, the channel's stream list and VOD registration.
(function () {
  const { api, errorText, formatDate, el, setStatus, busy, signInUrl, twitchToken, renderHeader } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };
  const HELIX_VIDEOS = 'https://api.twitch.tv/helix/videos?id=';
  const REAUTH_TEXT = 'もう一度サインインしてください';

  let config = null;

  // /api/config は 1 度だけ読む / /api/config is read once
  async function loadConfig() {
    if (!config) config = await api('/api/config');
    return config;
  }

  function startSignIn(statusNode) {
    try {
      location.href = signInUrl(config.twitch_client_id);
    } catch (e) {
      setStatus(statusNode, 'ブラウザの保存領域が使えません', 'error');
    }
  }

  // ---- 未サインイン / Signed out ----

  async function showSignIn() {
    $('signin-view').hidden = false;
    const status = $('signin-status');
    try {
      await loadConfig();
    } catch (e) {
      setStatus(status, errorText(e), 'error');
      return;
    }
    if (!config.twitch_client_id) {
      setStatus(status, 'サーバーの設定が済んでいません', 'error');
      return;
    }
    const button = $('signin-button');
    button.hidden = false;
    button.addEventListener('click', function () { startSignIn(status); });
  }

  // ---- 配信一覧 / Stream list ----

  function chatCell(stream) {
    if (stream.chat_key) {
      const count = Number(stream.chat_count) || 0;
      return el('td', { class: 'chat ok', text: '取り込み済み · ' + count.toLocaleString() + ' 件' });
    }
    return el('td', { class: 'chat muted', text: '未取り込み' });
  }

  // 1 配信 = 1 行。行全体のクリックはタイトルのリンクを CSS で広げて受ける（app.css の .streams .t a::after）
  // One stream per row. A click anywhere on the row lands on the title link, stretched by CSS (.streams .t a::after in app.css).
  function streamRow(stream, highlightId) {
    const title = stream.title || '';
    return el('tr', {
      class: stream.stream_id === highlightId ? 'is-new' : null,
      'data-stream-id': stream.stream_id
    }, [
      el('td', { text: formatDate(stream.started_at) }),
      el('td', { class: 't' }, el('a', {
        class: title ? null : 'untitled',
        href: '/s/' + encodeURIComponent(stream.stream_id),
        text: title || '（タイトルなし）'
      })),
      chatCell(stream),
      el('td', { class: 'num', text: String(Number(stream.stamp_count) || 0) })
    ]);
  }

  async function loadStreams(highlightId) {
    const channel = $('channel-select').value;
    const list = $('stream-list');
    const status = $('streams-status');
    if (!channel) return;
    setStatus(status, '読み込み中…');
    let data;
    try {
      data = await api('/api/channels/' + encodeURIComponent(channel) + '/streams');
    } catch (e) {
      setStatus(status, errorText(e), 'error');
      return;
    }
    setStatus(status, '');
    const streams = data.streams || [];
    $('streams-count').textContent = streams.length + ' 件';
    if (streams.length === 0) {
      list.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty', text: 'まだ配信がありません。「＋ VOD から登録」で追加できます。' })));
      return;
    }
    list.replaceChildren(el('div', { class: 'panel' }, el('table', null, [
      el('thead', null, el('tr', null, [
        el('th', { scope: 'col', text: '日付' }),
        el('th', { scope: 'col', text: 'タイトル' }),
        el('th', { scope: 'col', text: 'チャット' }),
        el('th', { scope: 'col', class: 'num', text: 'スタンプ' })
      ])),
      el('tbody', null, streams.map(function (s) { return streamRow(s, highlightId); }))
    ])));
    if (highlightId) {
      const row = list.querySelector('.is-new');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---- VOD から登録 / Register from VOD ----

  function setVodFormOpen(open) {
    $('vod-form').hidden = !open;
    $('vod-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('vod-input').focus();
  }

  function vodError(text, needSignIn) {
    $('vod-error').textContent = text || '';
    $('vod-input').classList.remove('invalid');
    $('vod-resignin').hidden = !needSignIn;
  }

  // Helix で VOD を引く。token が無い・401 は null（サインインし直し）/ Looks up the VOD on Helix; null when there is no token or on 401 (sign in again)
  async function fetchHelixVideo(vodId) {
    const token = twitchToken();
    if (!token) return null;
    const res = await fetch(HELIX_VIDEOS + encodeURIComponent(vodId), {
      headers: { Authorization: 'Bearer ' + token, 'Client-Id': config.twitch_client_id }
    });
    if (res.status === 401) return null;
    if (!res.ok) throw { status: res.status, error: 'twitch_api' };
    const body = await res.json();
    const video = body && body.data && body.data[0];
    if (!video) throw { status: 404, error: 'vod_not_found' };
    return video;
  }

  async function registerVod(event) {
    event.preventDefault();
    vodError('');
    const vodId = YTSChat.parseVodId($('vod-input').value);
    if (!vodId) {
      vodError('VOD の URL（twitch.tv/videos/…）か数字の ID を入力してください');
      $('vod-input').classList.add('invalid');
      $('vod-input').focus();
      return;
    }
    await busy($('vod-submit'), async function () {
      try {
        await loadConfig();
        if (!config.twitch_client_id) {
          vodError('サーバーの設定が済んでいません');
          return;
        }
        let video;
        try {
          video = await fetchHelixVideo(vodId);
        } catch (e) {
          if (e && e.error === 'vod_not_found') vodError('VOD が見つかりません');
          else if (e && e.error === 'twitch_api') vodError('Twitch API のエラー (' + e.status + ')');
          else vodError('Twitch に接続できません');
          return;
        }
        if (!video) {
          vodError(REAUTH_TEXT, true);
          return;
        }
        const result = await api('/api/streams', {
          method: 'POST',
          body: {
            // 配信の録画でない VOD（アップロード等）は stream_id が null / VODs that are not stream recordings have a null stream_id
            stream_id: video.stream_id || ('vod-' + vodId),
            channel: video.user_login,
            started_at: video.created_at,
            title: video.title,
            vod_id: vodId
          }
        });
        const stream = result.stream;
        const select = $('channel-select');
        if (Array.from(select.options).some(function (o) { return o.value === stream.channel; })) select.value = stream.channel;
        $('vod-input').value = '';
        setVodFormOpen(false);
        await loadStreams(stream.stream_id);
        setStatus($('streams-status'), '登録しました', 'ok');
      } catch (e) {
        vodError(errorText(e));
      }
    });
  }

  // ---- サインイン後 / Signed in ----

  async function showStreams(me) {
    renderHeader(me, '/');
    $('streams-view').hidden = false;
    const select = $('channel-select');
    let channels = [];
    try {
      channels = (await api('/api/channels')).channels || [];
    } catch (e) {
      setStatus($('streams-status'), errorText(e), 'error');
      return;
    }
    if (channels.length === 0) {
      select.disabled = true;
      $('vod-toggle').disabled = true;
      $('stream-list').replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty', text: '参加しているチャンネルがありません。チャンネルの owner に追加を頼んでください。' })));
      return;
    }
    select.replaceChildren.apply(select, channels.map(function (c) {
      return el('option', { value: c.login, text: c.display_name ? c.display_name + ' (' + c.login + ')' : c.login });
    }));
    select.addEventListener('change', function () { loadStreams(); });
    $('vod-toggle').addEventListener('click', function () { setVodFormOpen($('vod-form').hidden); });
    $('vod-cancel').addEventListener('click', function () { vodError(''); setVodFormOpen(false); });
    $('vod-form').addEventListener('submit', registerVod);
    $('vod-resignin').addEventListener('click', function () { startSignIn($('streams-status')); });
    await loadStreams();
  }

  async function boot() {
    let me = null;
    try {
      me = await api('/api/me');
    } catch (e) {
      if (!e || e.status !== 401) {
        setStatus($('boot-status'), errorText(e), 'error');
        return;
      }
    }
    $('boot-status').hidden = true;
    if (me) await showStreams(me);
    else await showSignIn();
  }

  boot();
}());
