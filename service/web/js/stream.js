'use strict';

// 配信ページ /s/<stream_id>: コメント密度グラフ・コメント / スタンプ一覧・ここに印・チャット取り込み
// Stream page /s/<stream_id>: comment density graph, comment / stamp lists, mark here and chat import.
(function () {
  const { api, errorText, formatDate, el, setStatus, busy, requireSession, renderHeader } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };
  const BIN_KEY = 'yts_bin_sec';
  const BIN_CHOICES = [15, 30, 60, 120];
  const OFFSET_LIMIT_SEC = 3600;
  const SETTING_LABELS = { vod_offset_sec: 'VOD のずれ', chat_lag_sec: '反応の遅れ' };
  // この幅以上はコメントとスタンプを横並び（app.css の .lists / .tabs と同じ値）
  // At this width and up, comments and stamps sit side by side (same value as .lists / .tabs in app.css)
  const wideQuery = window.matchMedia('(min-width: 1100px)');

  const match = /^\/s\/([^/]+)(?:\/comments)?\/?$/.exec(location.pathname);
  const streamId = match ? decodeURIComponent(match[1]) : '';
  const base = '/api/streams/' + encodeURIComponent(streamId);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('yts-' + streamId) : null;

  let me = null;
  let stream = null;
  let chat = null;           // R2 のチャット JSON（未取込は null）/ Chat JSON from R2 (null when not imported)
  let comments = [];         // offset 昇順 / Sorted by offset
  let times = new Float64Array(0);
  let commentItems = [];
  let timeNodes = [];
  let stamps = [];           // 墓標を除いた offset 昇順 / Without tombstones, sorted by offset
  let stampItems = [];
  let binSec = 30;
  let selectedBin = null;
  let highlighted = { comments: [0, 0], stamps: [0, 0] };
  let graph = null;
  let vodCandidates = [];
  let importAbort = null;
  const deleting = new Set(); // 削除を送っている最中のスタンプ id / Ids of stamps whose deletion is in flight

  // ---- 共通 / Shared ----

  function showError(text) { $('page-error').textContent = text || ''; }

  // 例外 → 1 行の文言。Twitch 側の Error は日本語の message を持つ / Thrown value -> one line. Twitch-side Errors carry a Japanese message
  function messageOf(e) {
    if (e instanceof TypeError) return 'Twitch に接続できません (' + e.message + ')';
    if (e instanceof Error) return e.message;
    return errorText(e);
  }

  function isAbort(e) { return e && e.name === 'AbortError'; }

  function tc(sec) { return TSLib.formatTimecode(Math.floor(sec)); }

  function readBinSec() {
    try {
      const saved = Number(localStorage.getItem(BIN_KEY));
      if (BIN_CHOICES.includes(saved)) return saved;
    } catch (e) { /* storage blocked */ }
    return 30;
  }

  function post(message) {
    if (channel) channel.postMessage(message);
  }

  // ---- 見出し / Heading ----

  // 配信の長さ: チャットの length_sec。チャットが無ければ null（最後のスタンプは長さではないので使わない）
  // Stream length: the chat's length_sec; null without chat (the last stamp is not the length, so it is not used)
  function streamLengthSec() {
    return chat && Number(chat.length_sec) > 0 ? Number(chat.length_sec) : null;
  }

  // パンくず・h1・メタ行（開始と長さ / VOD / チャットの状態 / スタンプ数と候補数）
  // Breadcrumb, h1 and the meta line (start and length / VOD / chat state / stamp and candidate counts)
  function renderHead() {
    const title = stream.title || '（タイトルなし）';
    $('stream-title').textContent = title;
    document.title = title + ' — Peakaboo';
    // formatDate は 'YYYY-MM-DD HH:MM'（不明は '—'）/ formatDate gives 'YYYY-MM-DD HH:MM' ('—' when unknown)
    const started = formatDate(stream.started_at).split(' ');
    const sep = function () { return el('span', { class: 'faint', 'aria-hidden': 'true', text: '›' }); };
    $('stream-crumb').replaceChildren(
      el('a', { href: '/', text: '配信' }), sep(),
      el('span', { text: stream.channel || '' }), sep(),
      el('span', { text: started[0] })
    );
    const length = streamLengthSec();
    $('stream-meta').replaceChildren('開始 ', el('b', { class: 'num', text: started[1] || started[0] }));
    if (length !== null) $('stream-meta').append(' · 長さ ', el('b', { class: 'num', text: TSLib.formatTimecode(length) }));
    $('vod-meta').hidden = !stream.vod_id;
    if (stream.vod_id) {
      $('vod-link').href = 'https://www.twitch.tv/videos/' + encodeURIComponent(stream.vod_id);
      $('vod-link').textContent = String(stream.vod_id);
    }
    const state = $('chat-state-text');
    const button = $('import-button');
    if (chat) {
      state.replaceChildren(
        el('span', { class: 'ok', text: '取り込み済み' }), ' · ',
        el('b', { class: 'num', text: comments.length.toLocaleString() + ' 件' })
      );
      button.textContent = '再取り込み';
      // 取り込んだ日時と人（薄く）/ When and by whom it was imported (faint)
      $('chat-fetched').textContent = '（' + formatDate(stream.chat_fetched_at) + (stream.chat_fetched_by ? ' · ' + stream.chat_fetched_by : '') + '）';
    } else {
      state.replaceChildren(el('span', { class: 'warn', text: '未取り込み' }));
      button.textContent = '取り込む';
      $('chat-fetched').textContent = '';
    }
    const candidates = stamps.filter(function (s) { return TSLib.isCandidate(s.memo); }).length;
    $('stamp-meta').replaceChildren('スタンプ ', el('b', { class: 'num', text: stamps.length.toLocaleString() }));
    if (candidates > 0) $('stamp-meta').append(' ', el('span', { class: 'faint', text: '候補 ' + candidates.toLocaleString() }));
  }

  // ---- コメント一覧（1 度だけ組み、強調とスクロールでは組み直さない）/ Comment list (built once; highlight and scroll never rebuild it) ----

  function setChat(data) {
    chat = data;
    const rows = data && Array.isArray(data.comments) ? data.comments.filter(Array.isArray) : [];
    // 安定ソートで offset 昇順に / Stable sort by offset
    comments = rows.slice().sort(function (a, b) { return (Number(a[0]) || 0) - (Number(b[0]) || 0); });
    times = YTSBins.shiftTimes(comments, stream.vod_offset_sec, stream.chat_lag_sec);
    const fragment = document.createDocumentFragment();
    commentItems = new Array(comments.length);
    timeNodes = new Array(comments.length);
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const time = el('span', { class: 't', text: tc(times[i]) });
      const item = el('li', null, [
        time,
        el('span', { class: 'u', title: String(c[1] || ''), text: String(c[2] || c[1] || '') }),
        el('span', { text: String(c[3] || '') })
      ]);
      timeNodes[i] = time;
      commentItems[i] = item;
      fragment.append(item);
    }
    $('comment-list').replaceChildren(fragment);
    highlighted.comments = [0, 0];
    $('comment-count').textContent = comments.length.toLocaleString();
    const empty = $('comment-empty');
    empty.hidden = comments.length > 0;
    empty.textContent = chat ? 'コメントはありません' : '未取り込み。上の「取り込む」で取り込めます';
  }

  // 時刻補正が変わったら時刻の文字だけ書き換える（順序は一定のずらしでは変わらない）
  // When the time correction changes, only the time text is rewritten (a constant shift keeps the order)
  function retime() {
    times = YTSBins.shiftTimes(comments, stream.vod_offset_sec, stream.chat_lag_sec);
    for (let i = 0; i < timeNodes.length; i++) timeNodes[i].textContent = tc(times[i]);
  }

  // ---- スタンプ一覧（件数が少ないので追加時は組み直す）/ Stamp list (small, rebuilt on add) ----

  // stamps と stampItems は常に offset 順（stampRange の範囲とグラフが前提にする）。「候補を先に」は並べる順だけ変える
  // stamps and stampItems always stay in offset order (stampRange and the graph rely on it); "Candidates first" only changes the display order
  function renderStamps() {
    stamps.sort(function (a, b) { return a.offset_sec - b.offset_sec || (a.id < b.id ? -1 : 1); });
    stampItems = stamps.map(function (s) {
      const candidate = TSLib.isCandidate(s.memo);
      let body;
      if (candidate) {
        // 候補: チップ + 理由（' | ' の前）+ 発言（' | ' の後ろ、薄く）/ Candidate: chip + reason (before ' | ') + utterance (after ' | ', faint)
        const text = s.memo.replace(TSLib.CANDIDATE_PATTERN, '');
        const cut = text.indexOf(' | ');
        const reason = cut < 0 ? text : text.slice(0, cut);
        const said = cut < 0 ? '' : text.slice(cut + 3);
        body = el('span', { class: 'body' }, [
          el('span', { class: 'chip', text: '候補' }),
          reason,
          said ? ' ' : null,
          said ? el('span', { class: 'by', text: said }) : null
        ]);
      } else {
        // 人: メモ（無ければ「メモなし」）+ 付けた人（薄く）/ Person: memo ("メモなし" when empty) + who marked it (faint)
        body = el('span', { class: 'body' }, [
          s.memo ? s.memo : el('span', { class: 'faint', text: 'メモなし' }),
          ' ',
          el('span', { class: 'by', text: s.by })
        ]);
      }
      // 消せる人（本人・owner・site_admin）にだけ × を出す / The × only for those who may delete (author, owner, site admin)
      if (TSLib.canDeleteStamp(me, stream.channel, s)) {
        const remove = el('button', { type: 'button', class: 'x', 'aria-label': '削除: ' + tc(s.offset_sec), title: 'このスタンプを削除', text: '×' });
        // 送信中の行は組み直しても押せないまま / Rows whose deletion is in flight stay disabled across rebuilds
        if (deleting.has(s.id)) setBusy(remove, true);
        remove.addEventListener('click', function (event) {
          // 行のクリック（将来のシーク）に伝えない / Keep the click from reaching the row (future seek)
          event.stopPropagation();
          if (!confirm('このスタンプを削除しますか？\n' + tc(s.offset_sec) + ' ' + (s.memo || ''))) return;
          deleteStamp(s, remove);
        });
        body.append(remove);
      }
      return el('li', { class: candidate ? 'cand candidate' : 'human' }, [
        el('span', { class: 't', text: tc(s.offset_sec) }),
        body
      ]);
    });
    let shown = stampItems;
    if ($('stamp-candidates-first').checked) {
      shown = stamps.map(function (s, i) { return i; })
        .sort(function (i, j) { return TSLib.candidateFirst(stamps[i], stamps[j]); })
        .map(function (i) { return stampItems[i]; });
    }
    $('stamp-list').replaceChildren.apply($('stamp-list'), shown);
    highlighted.stamps = [0, 0];
    $('stamp-count').textContent = stamps.length.toLocaleString();
    $('stamp-empty').hidden = stamps.length > 0;
    // メタ行のスタンプ数・候補数・長さも追従させる / Keeps the meta line's stamp and candidate counts and length in step
    renderHead();
  }

  // 墓標（deleted: true・新しい updated_at）を送り、受理されたら一覧とグラフから外す
  // Sends a tombstone (deleted: true with a newer updated_at); once accepted, drops the stamp from the list and graph
  async function deleteStamp(s, button) {
    showError('');
    // updated_at は今と「元の updated_at + 1 ms」の遅い方。時計が進んだ端末が書いた行でも stale で弾かれない
    // updated_at is the later of now and the stored updated_at + 1 ms, so a row written by a faster clock is not rejected as stale
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(s.updated_at) + 1 || 0)).toISOString();
    const tomb = TSLib.tombstoneRecord(s, updatedAt);
    deleting.add(s.id);
    setBusy(button, true);
    try {
      const result = await api('/api/stamps', { method: 'POST', body: { records: [tomb], source: 'web' } });
      if ((result.accepted || []).includes(s.id)) {
        // 見えている並び（「候補を先に」を含む）で前後の行を控えてから外す / Note the neighbours in display order (incl. "candidates first") before removing
        const order = Array.from($('stamp-list').children).map(function (li) { return stamps[stampItems.indexOf(li)]; });
        const at = order.indexOf(s);
        const neighbours = order.slice(at + 1).concat(order.slice(0, Math.max(at, 0)).reverse());
        deleting.delete(s.id);
        stamps = stamps.filter(function (x) { return x !== s; });
        renderStamps();
        redraw();
        setStatus($('page-status'), 'スタンプを削除しました', 'ok');
        // ボタンが消えてフォーカスが body に落ちたときだけ移す / Move focus only when it fell to <body> with the removed button
        if (!document.activeElement || document.activeElement === document.body) focusNearestX(neighbours);
        return;
      }
      const reason = ((result.rejected || [])[0] || {}).reason || 'unknown';
      // サーバーは本人・owner・サイト管理者以外の墓標を forbidden_tombstone、会員でなければ forbidden_channel、
      // 手元より新しい版があれば stale、元の行の時刻が先に進みすぎて墓標の時刻が範囲外なら invalid_time で返す。
      // それ以外は errorText に任せる
      // The server answers forbidden_tombstone for a tombstone by none of author, owner or site admin, forbidden_channel for a non-member,
      // stale when a newer version exists, and invalid_time when the stored row's time runs so far ahead that the tombstone's is out of range.
      // Anything else goes through errorText
      const DELETE_TEXT = {
        stale: 'ほかの場所で更新されています。再読み込みしてください',
        invalid_time: 'ほかの場所で更新されています。再読み込みしてください',
        forbidden_tombstone: '削除できるのは本人・チャンネルの owner・サイト管理者だけです',
        forbidden_channel: 'このチャンネルの会員ではありません'
      };
      showError(DELETE_TEXT[reason] || '削除できませんでした: ' + errorText({ error: reason }));
    } catch (e) {
      showError('削除できませんでした: ' + messageOf(e));
    }
    // 失敗: 送信中から外し、今の × を戻す（待つ間に組み直されていれば新しいボタン）
    // Failure: leave the in-flight set and restore the current × (a new button if the list was rebuilt meanwhile)
    deleting.delete(s.id);
    const row = stampItems[stamps.indexOf(s)];
    const current = row ? row.querySelector('button.x') : null;
    if (current) setBusy(current, false);
  }

  function setBusy(button, on) {
    button.disabled = on;
    if (on) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  // 削除の後のフォーカス: 次の行の ×（無ければ前の行）、どれも無ければタブ「スタンプ」か一覧
  // Focus after a delete: the next row's × (else the previous one); if none, the "スタンプ" tab or the list itself
  function focusNearestX(neighbours) {
    for (const n of neighbours) {
      const row = stampItems[stamps.indexOf(n)];
      const x = row ? row.querySelector('button.x') : null;
      if (x && !x.disabled) { x.focus(); return; }
    }
    const tab = $('tab-stamps');
    if (tab.offsetParent !== null) { tab.focus(); return; }
    const panel = $('panel-stamps');
    panel.tabIndex = -1;
    panel.focus();
  }

  // ---- グラフ / Graph ----

  function lengthSec() {
    let length = 1;
    if (chat) length = Math.max(length, (Number(chat.length_sec) || 0) + (Number(stream.vod_offset_sec) || 0));
    if (times.length) length = Math.max(length, times[times.length - 1] + 1);
    for (const s of stamps) length = Math.max(length, s.offset_sec + 1);
    return length;
  }

  function redraw() {
    // graph.js は Node でも読むので TSLib を見ない。候補の印はここで付ける / graph.js is also loaded in Node and never reads TSLib, so candidates are marked here
    const marked = stamps.map(function (s) { return Object.assign({}, s, { candidate: TSLib.isCandidate(s.memo) }); });
    graph.setData({ counts: YTSBins.binCounts(times, binSec, lengthSec()), binSec: binSec, stamps: marked });
    if (selectedBin !== null) {
      graph.select(selectedBin);
      selectedBin = graph.state().selected;
      applySelection(false);
    }
  }

  // [lo, hi) の範囲に class を付け替える / Moves a class onto the [lo, hi) range
  function moveClass(items, prev, next, name) {
    for (let i = prev[0]; i < prev[1] && i < items.length; i++) items[i].classList.remove(name);
    for (let i = next[0]; i < next[1]; i++) items[i].classList.add(name);
  }

  function stampRange(start, end) {
    let lo = 0;
    while (lo < stamps.length && stamps[lo].offset_sec < start) lo++;
    let hi = lo;
    while (hi < stamps.length && stamps[hi].offset_sec < end) hi++;
    return [lo, hi];
  }

  // 見えている一覧（横並びなら両方）を、選択範囲の先頭（無ければ直後の行）までスクロール
  // Scrolls the visible list(s) (both when side by side) to the first row of the selection (or the next row when the bin is empty)
  function scrollToSelection() {
    if (selectedBin === null) return;
    scrollPanel($('panel-comments'), commentItems, highlighted.comments);
    scrollPanel($('panel-stamps'), stampItems, highlighted.stamps);
  }

  function scrollPanel(panel, items, range) {
    if (panel.hidden) return;
    const target = items[Math.min(range[0], items.length - 1)];
    if (target) panel.scrollTop = target.offsetTop;
  }

  function applySelection(scroll) {
    const start = selectedBin * binSec;
    const end = start + binSec;
    const commentRange = [YTSBins.firstAtOrAfter(times, start), YTSBins.firstAtOrAfter(times, end)];
    moveClass(commentItems, highlighted.comments, commentRange, 'in-bin');
    highlighted.comments = commentRange;
    const range = stampRange(start, end);
    moveClass(stampItems, highlighted.stamps, range, 'in-bin');
    highlighted.stamps = range;
    $('selection-label').replaceChildren('選択 ', el('b', { class: 'num', text: tc(start) + ' – ' + tc(end) }),
      ' · コメント ' + (commentRange[1] - commentRange[0]).toLocaleString() + ' 件');
    $('mark-button').disabled = false;
    if (scroll) scrollToSelection();
  }

  function onBinSelected(bin) {
    selectedBin = bin;
    applySelection(true);
    post({ type: 'seek', sec: bin * binSec });
  }

  function changeBinWidth() {
    const next = Number($('bin-select').value);
    if (!BIN_CHOICES.includes(next)) return;
    // 選択の開始秒を保つ / Keep the selection's start second
    if (selectedBin !== null) selectedBin = Math.floor((selectedBin * binSec) / next);
    binSec = next;
    try { localStorage.setItem(BIN_KEY, String(next)); } catch (e) { /* storage blocked */ }
    redraw();
    if (selectedBin !== null) scrollToSelection();
  }

  // ---- タブ / Tabs ----

  function showTab(name) {
    for (const key of ['comments', 'stamps']) {
      const on = key === name;
      $('tab-' + key).setAttribute('aria-selected', String(on));
      $('tab-' + key).tabIndex = on ? 0 : -1;
      $('panel-' + key).hidden = !on;
    }
    scrollToSelection();
  }

  // 広い幅では両パネルの hidden を外し（タブは CSS で隠れる）、狭い幅では選んでいるタブの 1 枚に戻す。
  // タブが隠れている間はパネルを tabpanel にしない（読み上げに見えないタブを指させない）
  // Wide: clears hidden on both panels (the tabs are hidden by CSS); narrow: back to the selected tab's single panel.
  // While the tabs are hidden the panels are not tabpanels (screen readers are not pointed at invisible tabs)
  function syncLayout() {
    const wide = wideQuery.matches;
    for (const key of ['comments', 'stamps']) {
      const panel = $('panel-' + key);
      if (wide) {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-labelledby');
      } else {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', 'tab-' + key);
      }
    }
    if (wide) {
      $('panel-comments').hidden = false;
      $('panel-stamps').hidden = false;
      scrollToSelection();
    } else {
      showTab($('tab-stamps').getAttribute('aria-selected') === 'true' ? 'stamps' : 'comments');
    }
  }

  function tabKeys(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = $('panel-comments').hidden ? 'comments' : 'stamps';
    showTab(next);
    $('tab-' + next).focus();
  }

  // ---- 設定（時刻補正）/ Settings (time correction) ----

  function fillSettings() {
    $('vod-offset').value = String(stream.vod_offset_sec);
    $('chat-lag').value = String(stream.chat_lag_sec);
  }

  async function saveSetting(input, key) {
    const status = $('settings-status');
    const value = Number(input.value);
    if (input.value.trim() === '' || !Number.isFinite(value) || Math.abs(value) > OFFSET_LIMIT_SEC) {
      input.classList.add('invalid');
      input.value = String(stream[key]);
      setStatus(status, '−3600〜3600 の秒数を入れてください (bad_request)', 'error');
      return;
    }
    input.classList.remove('invalid');
    if (value === Number(stream[key])) return;
    try {
      const body = {};
      body[key] = value;
      stream = (await api(base, { method: 'PATCH', body: body })).stream;
      setStatus(status, '保存しました: ' + SETTING_LABELS[key] + ' = ' + stream[key] + ' s', 'ok');
      post({ type: 'settings' });
      retime();
      redraw();
    } catch (e) {
      input.value = String(stream[key]);
      setStatus(status, '保存できませんでした: ' + errorText(e) + '（現在 ' + stream[key] + ' s）', 'error');
    }
  }

  // ---- ここに印 / Mark here ----

  async function markHere() {
    if (selectedBin === null) return;
    showError('');
    const sec = selectedBin * binSec;
    const now = new Date().toISOString();
    const record = {
      id: TSLib.newId(),
      timecode: TSLib.formatTimecode(sec),
      offset_sec: sec,
      by: me.login,
      memo: '',
      native: false,
      channel: stream.channel,
      stream_id: stream.stream_id,
      started_at: stream.started_at,
      created_at: now,
      updated_at: now,
      deleted: false,
      clock_skew_ms: 0
    };
    await busy($('mark-button'), async function () {
      try {
        const result = await api('/api/stamps', { method: 'POST', body: { records: [record], source: 'web' } });
        if ((result.accepted || []).includes(record.id)) {
          stamps.push(record);
          renderStamps();
          redraw();
          setStatus($('page-status'), '印を付けました: ' + record.timecode, 'ok');
        } else {
          const reason = ((result.rejected || [])[0] || {}).reason || 'unknown';
          showError('印を付けられませんでした (' + reason + ')');
        }
      } catch (e) {
        showError('印を付けられませんでした: ' + errorText(e));
      }
    });
  }

  // ---- チャット取り込み / Chat import ----

  // 未取込（404 no_chat）は null。応答は max-age=3600 で URL は取り込み直しでも同じなので、
  // chat_fetched_at を ?v= に付けて古いキャッシュを避ける（サーバーは ?v= を見ない）
  // null when not imported (404 no_chat). The response is max-age=3600 and the URL stays the same on re-import,
  // so chat_fetched_at goes into ?v= to skip a stale cache (the server ignores ?v=)
  async function loadChat() {
    try {
      return await api(base + '/chat?v=' + encodeURIComponent(stream.chat_fetched_at || ''));
    } catch (e) {
      if (e && e.status === 404 && e.error === 'no_chat') return null;
      throw e;
    }
  }

  function setImporting(on) {
    $('import-button').disabled = on;
    $('vod-confirm').disabled = on;
    $('import-progress').hidden = !on;
  }

  function progress(text) { $('import-progress-text').textContent = text; }

  function closePicker() {
    $('vod-picker').hidden = true;
    $('import-button').disabled = false;
    $('vod-url').classList.remove('invalid');
  }

  async function openPicker() {
    const select = $('vod-select');
    $('vod-picker').hidden = false;
    $('import-button').disabled = true;
    select.disabled = true;
    select.replaceChildren(el('option', { value: '', text: '候補を読み込み中…' }));
    try {
      vodCandidates = await YTSChat.listVods(stream.channel);
    } catch (e) {
      vodCandidates = [];
      showError(messageOf(e));
    }
    // 既定: 今の vod_id が候補にあればそれ、候補に無ければ URL 欄へ、未設定なら配信開始に近い VOD
    // Default: the current vod_id when it is a candidate, otherwise into the URL field; when unset, the VOD nearest the stream start
    const current = stream.vod_id ? String(stream.vod_id) : '';
    const currentKnown = vodCandidates.some(function (v) { return String(v.id) === current; });
    const picked = current ? (currentKnown ? { id: current } : null) : YTSChat.pickVod(vodCandidates, stream.started_at);
    $('vod-url').value = current && !currentKnown ? current : '';
    select.replaceChildren(
      el('option', { value: '', text: vodCandidates.length ? '選んでください' : '候補がありません' }),
      ...vodCandidates.map(function (v) {
        return el('option', {
          value: String(v.id),
          text: formatDate(v.createdAt) + ' · ' + TSLib.formatTimecode(Number(v.lengthSeconds) || 0) + ' · ' + (v.title || '')
        });
      })
    );
    select.value = picked ? String(picked.id) : '';
    select.disabled = vodCandidates.length === 0;
    (vodCandidates.length ? select : $('vod-url')).focus();
  }

  async function confirmPicker(event) {
    event.preventDefault();
    showError('');
    const urlInput = $('vod-url');
    urlInput.classList.remove('invalid');
    let vodId;
    if (urlInput.value.trim()) {
      vodId = YTSChat.parseVodId(urlInput.value);
      if (!vodId) {
        urlInput.classList.add('invalid');
        urlInput.focus();
        showError('VOD の URL（twitch.tv/videos/…）か数字の ID を入れてください');
        return;
      }
    } else {
      vodId = $('vod-select').value;
      if (!vodId) {
        showError('VOD を選ぶか URL を入れてください');
        return;
      }
    }
    // 候補に無い VOD（貼り付けた URL）は長さを最後のコメントから決める / A VOD outside the candidates (pasted URL) takes its length from the last comment
    const known = vodCandidates.find(function (v) { return String(v.id) === vodId; }) || null;
    // vod_id は先に PATCH しない。PUT …/chat が成功したときにサーバーが保存する（中止・失敗では今の vod_id のまま）
    // vod_id is not PATCHed first: PUT …/chat saves it on success (cancel or failure leaves the current vod_id as is)
    closePicker();
    await runImport(vodId, known);
  }

  // vod: 候補の VOD、または null（長さは最後のコメントから）/ vod: a candidate VOD, or null (length from the last comment)
  async function runImport(vodId, vod) {
    const controller = new AbortController();
    importAbort = controller;
    setImporting(true);
    setStatus($('page-status'), '');
    try {
      if (vod && !(Number(vod.lengthSeconds) > 0)) {
        throw new Error('VOD の長さが 0 秒です（処理中か削除済み）');
      }
      progress('0 件');
      const rows = await YTSChat.fetchVodChat(vodId, function (n) {
        progress(n.toLocaleString() + ' 件');
      }, { signal: controller.signal });
      const length = vod
        ? Number(vod.lengthSeconds)
        : Math.ceil(rows.reduce(function (m, r) { return Math.max(m, Number(r[0]) || 0); }, 0));
      progress('保存中…（' + rows.length.toLocaleString() + ' 件）');
      const query = new URLSearchParams({ vod_id: vodId, count: String(rows.length), length_sec: String(length) });
      await api(base + '/chat?' + query.toString(), { method: 'PUT', rawBody: YTSChat.buildChatJson(vodId, length, rows) });
      stream = (await api(base)).stream;
      setChat(await loadChat());
      fillSettings();
      renderHead();
      redraw();
      setStatus($('page-status'), '取り込みました: ' + rows.length.toLocaleString() + ' 件', 'ok');
    } catch (e) {
      if (isAbort(e)) setStatus($('page-status'), '取り込みを中止しました');
      else showError('取り込めませんでした: ' + messageOf(e));
    } finally {
      importAbort = null;
      setImporting(false);
    }
  }

  // 取り込みも取り込み直しも、必ず VOD の選択から（違う VOD に直せるように）
  // Import and re-import both start from the VOD picker (so a wrong VOD can be corrected)
  async function startImport() {
    showError('');
    if (importAbort) return;
    await openPicker();
  }

  function popOut() {
    const win = window.open('/s/' + encodeURIComponent(streamId) + '/comments', 'yts-comments-' + streamId);
    if (!win) showError('別ウィンドウを開けませんでした（ポップアップのブロック）');
  }

  // ---- 起動 / Boot ----

  async function boot() {
    if (!streamId) throw { status: 404, error: 'not_found' };
    me = await requireSession();
    renderHeader(me, null);
    stream = (await api(base)).stream;
    const [stampData, chatData] = await Promise.all([api(base + '/stamps'), loadChat()]);
    stamps = (stampData.records || []).filter(function (r) { return !r.deleted; });
    binSec = readBinSec();
    $('bin-select').value = String(binSec);

    $('boot-status').hidden = true;
    $('stream-view').hidden = false;
    graph = YTSGraph.createGraph($('graph'));
    graph.onSelect(onBinSelected);
    setChat(chatData);
    renderStamps();
    fillSettings();
    renderHead();
    redraw();

    $('bin-select').addEventListener('change', changeBinWidth);
    $('vod-offset').addEventListener('change', function () { saveSetting($('vod-offset'), 'vod_offset_sec'); });
    $('chat-lag').addEventListener('change', function () { saveSetting($('chat-lag'), 'chat_lag_sec'); });
    $('tab-comments').addEventListener('click', function () { showTab('comments'); });
    $('tab-stamps').addEventListener('click', function () { showTab('stamps'); });
    $('tab-comments').addEventListener('keydown', tabKeys);
    $('tab-stamps').addEventListener('keydown', tabKeys);
    // 組み直すと in-bin が消えるので選択を当て直す / Rebuilding drops in-bin, so the selection is re-applied
    $('stamp-candidates-first').addEventListener('change', function () {
      renderStamps();
      if (selectedBin !== null) applySelection(false);
    });
    $('mark-button').addEventListener('click', markHere);
    $('import-button').addEventListener('click', startImport);
    $('vod-picker').addEventListener('submit', confirmPicker);
    $('vod-cancel').addEventListener('click', function () { showError(''); closePicker(); });
    $('import-cancel').addEventListener('click', function () { if (importAbort) importAbort.abort(); });
    $('popout-button').addEventListener('click', popOut);
    syncLayout();
    wideQuery.addEventListener('change', syncLayout);
  }

  // 起動の失敗は画面に出す（例外を外に漏らさない）/ Boot failures go on screen (nothing escapes as an unhandled rejection)
  boot().catch(function (e) {
    const status = $('boot-status');
    status.hidden = false;
    setStatus(status, errorText(e), 'error');
  });
}());
