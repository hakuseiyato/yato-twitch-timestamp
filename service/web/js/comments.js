'use strict';

// 切り離したコメント一覧 /s/<stream_id>/comments。親ページの seek / settings を BroadcastChannel で受ける
// 親が閉じても単独で動く（検索と一覧は自前で読み込む）
// Detached comment list /s/<stream_id>/comments. Follows the parent's seek / settings via BroadcastChannel.
// Works on its own when the parent is closed (it loads the list and runs the search itself).
(function () {
  const { api, errorText, formatDate, el, setStatus, requireSession } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };
  const FLASH_MS = 3000;
  const SEARCH_DELAY_MS = 120;

  const match = /^\/s\/([^/]+)\/comments\/?$/.exec(location.pathname);
  const streamId = match ? decodeURIComponent(match[1]) : '';
  const base = '/api/streams/' + encodeURIComponent(streamId);

  let stream = null;
  let comments = [];
  let times = new Float64Array(0);
  let items = [];
  let timeNodes = [];
  let haystacks = [];
  let flashed = [];
  let flashTimer = 0;
  let searchTimer = 0;

  function tc(sec) { return TSLib.formatTimecode(Math.floor(sec)); }

  // 未取込（404 no_chat）は null。?v= は取り込み直し後の古いキャッシュ避け（stream.js と同じ）
  // null when not imported (404 no_chat). ?v= skips a stale cache after re-import (same as stream.js)
  async function loadChat() {
    try {
      return await api(base + '/chat?v=' + encodeURIComponent(stream.chat_fetched_at || ''));
    } catch (e) {
      if (e && e.status === 404 && e.error === 'no_chat') return null;
      throw e;
    }
  }

  function render(chat) {
    const rows = chat && Array.isArray(chat.comments) ? chat.comments.filter(Array.isArray) : [];
    comments = rows.slice().sort(function (a, b) { return (Number(a[0]) || 0) - (Number(b[0]) || 0); });
    times = YTSBins.shiftTimes(comments, stream.vod_offset_sec, stream.chat_lag_sec);
    const fragment = document.createDocumentFragment();
    items = new Array(comments.length);
    timeNodes = new Array(comments.length);
    haystacks = new Array(comments.length);
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const display = String(c[2] || c[1] || '');
      const text = String(c[3] || '');
      const time = el('span', { class: 't', text: tc(times[i]) });
      items[i] = el('li', null, [
        time,
        el('span', { class: 'u', title: String(c[1] || ''), text: display }),
        el('span', { text: text })
      ]);
      timeNodes[i] = time;
      haystacks[i] = (display + '\n' + text).toLowerCase();
      fragment.append(items[i]);
    }
    $('comment-list').replaceChildren(fragment);
    if (!chat) $('comment-list').append(el('li', { class: 'empty', text: '未取り込み' }));
    else if (!comments.length) $('comment-list').append(el('li', { class: 'empty', text: 'コメントはありません' }));
    applySearch();
  }

  // 部分一致（大文字小文字を区別しない）で行を hidden にする / Hides rows by case-insensitive substring match
  function applySearch() {
    const needle = $('search').value.trim().toLowerCase();
    let shown = 0;
    for (let i = 0; i < items.length; i++) {
      const hit = !needle || haystacks[i].includes(needle);
      items[i].hidden = !hit;
      if (hit) shown++;
    }
    $('filter-count').textContent = needle
      ? shown.toLocaleString() + ' / ' + items.length.toLocaleString() + ' 件'
      : items.length.toLocaleString() + ' 件';
  }

  function clearFlash() {
    for (const item of flashed) item.classList.remove('flash');
    flashed = [];
  }

  // sec 以上の最初の（表示中の）コメントへスクロールし、同じ秒の行を 3 秒強調
  // Scrolls to the first (visible) comment at or after sec and highlights rows of that second for 3 s
  function seek(sec) {
    if (!Number.isFinite(sec)) return;
    let i = YTSBins.firstAtOrAfter(times, sec);
    while (i < items.length && items[i].hidden) i++;
    clearFlash();
    clearTimeout(flashTimer);
    if (i >= items.length) return;
    const second = Math.floor(times[i]);
    for (let j = i; j < items.length && Math.floor(times[j]) === second; j++) {
      if (items[j].hidden) continue;
      items[j].classList.add('flash');
      flashed.push(items[j]);
    }
    $('comment-scroll').scrollTop = items[i].offsetTop;
    flashTimer = setTimeout(clearFlash, FLASH_MS);
  }

  // 親が時刻補正を保存したら読み直して時刻だけ書き換える / Re-reads the stream after the parent saves a time correction and rewrites only the times
  async function reloadSettings() {
    try {
      stream = (await api(base)).stream;
      times = YTSBins.shiftTimes(comments, stream.vod_offset_sec, stream.chat_lag_sec);
      for (let i = 0; i < timeNodes.length; i++) timeNodes[i].textContent = tc(times[i]);
      $('page-error').textContent = '';
    } catch (e) {
      $('page-error').textContent = '設定を読み直せませんでした: ' + errorText(e);
    }
  }

  function listen() {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('yts-' + streamId);
    channel.addEventListener('message', function (event) {
      const data = event.data || {};
      if (data.type === 'seek') seek(Number(data.sec));
      else if (data.type === 'settings') reloadSettings();
    });
  }

  async function boot() {
    if (!streamId) throw { status: 404, error: 'not_found' };
    // 読み込みに失敗しても親ページへは戻れるように先に張る / Set first so the way back works even if loading fails
    $('back-link').href = '/s/' + encodeURIComponent(streamId);
    await requireSession();
    stream = (await api(base)).stream;
    const title = stream.title || '（タイトルなし）';
    // パンくず: タイトル · 日付（formatDate の日付部分）/ Breadcrumb: title · date (the date part of formatDate)
    $('popout-title').textContent = title + ' · ' + formatDate(stream.started_at).split(' ')[0];
    document.title = 'コメント — ' + title;
    render(await loadChat());
    $('boot-status').hidden = true;
    $('search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applySearch, SEARCH_DELAY_MS);
    });
    listen();
  }

  // 起動の失敗は画面に出す（例外を外に漏らさない）/ Boot failures go on screen (nothing escapes as an unhandled rejection)
  boot().catch(function (e) {
    setStatus($('boot-status'), errorText(e), 'error');
  });
}());
