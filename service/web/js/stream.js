'use strict';

// 配信ページ /s/<stream_id>: コメント密度グラフ・コメント / スタンプ一覧・ここに印・チャット取り込み
// Stream page /s/<stream_id>: comment density graph, comment / stamp lists, mark here and chat import.
(function () {
  const { api, errorText, formatDate, el, setStatus, busy, requireSession, renderHeader } = YTSApi;
  const $ = function (id) { return document.getElementById(id); };
  const BIN_KEY = 'yts_bin_sec';
  const BIN_CHOICES = [15, 30, 60, 120];
  const OFFSET_LIMIT_SEC = 3600;
  const SETTING_LABELS = { vod_offset_sec: 'VOD のずれ / VOD offset', chat_lag_sec: '反応の遅れ / Chat lag' };

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

  // ---- 共通 / Shared ----

  function showError(text) { $('page-error').textContent = text || ''; }

  // 例外 → 1 行の文言。Twitch 側の Error は日英の message を持つ / Thrown value -> one line. Twitch-side Errors carry a bilingual message
  function messageOf(e) {
    if (e instanceof TypeError) return 'Twitch に接続できません / Could not reach Twitch (' + e.message + ')';
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

  function renderHead() {
    const title = stream.title || '（タイトルなし） / (untitled)';
    $('stream-title').textContent = title;
    document.title = title + ' — Peakaboo';
    const meta = [stream.channel, formatDate(stream.started_at)];
    $('stream-meta').replaceChildren(meta.join(' · '));
    if (stream.vod_id) {
      $('stream-meta').append(' · ', el('a', {
        href: 'https://www.twitch.tv/videos/' + encodeURIComponent(stream.vod_id),
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'VOD ' + stream.vod_id
      }));
    }
    const state = $('chat-state-text');
    const button = $('import-button');
    if (chat) {
      const count = comments.length.toLocaleString();
      state.className = 'chat-done';
      state.textContent = '取込済み / Imported: ' + count + ' 件 / comments（' + formatDate(stream.chat_fetched_at) +
        (stream.chat_fetched_by ? ', ' + stream.chat_fetched_by : '') + '）';
      button.textContent = 'チャットを取り込み直す / Re-import chat';
      button.className = 'secondary';
    } else {
      state.className = 'chat-none';
      state.textContent = '未取込 / Not imported yet';
      button.textContent = 'チャットを取り込む / Import chat';
      button.className = 'primary';
    }
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
      const time = el('span', { class: 'row-time', text: tc(times[i]) });
      const item = el('li', null, [
        time,
        el('span', { class: 'row-name', title: String(c[1] || ''), text: String(c[2] || c[1] || '') }),
        el('span', { class: 'row-text', text: String(c[3] || '') })
      ]);
      timeNodes[i] = time;
      commentItems[i] = item;
      fragment.append(item);
    }
    $('comment-list').replaceChildren(fragment);
    highlighted.comments = [0, 0];
    $('comment-count').textContent = '(' + comments.length.toLocaleString() + ')';
    const empty = $('comment-empty');
    empty.hidden = comments.length > 0;
    empty.textContent = chat
      ? 'コメントはありません / No comments'
      : '未取込 / Not imported yet — 「チャットを取り込む / Import chat」で取り込めます / Use "Import chat" above';
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
      let text;
      if (candidate) {
        // 候補はバッジ + 印を外した本文 / Candidates: badge + memo without the prefix
        text = el('span', { class: 'row-text' }, [
          el('span', { class: 'badge-candidate', title: '候補 / Candidate', 'aria-label': '候補 / Candidate', text: '候補' }),
          s.memo.replace(TSLib.CANDIDATE_PATTERN, '')
        ]);
      } else {
        text = s.memo ? el('span', { class: 'row-text', text: s.memo }) : el('span', { class: 'row-text muted', text: '（メモなし / no memo）' });
      }
      return el('li', { class: candidate ? 'candidate' : null }, [
        el('span', { class: 'row-time', text: tc(s.offset_sec) }),
        el('span', { class: 'row-name', text: s.by }),
        text
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
    $('stamp-count').textContent = '(' + stamps.length.toLocaleString() + ')';
    $('stamp-empty').hidden = stamps.length > 0;
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

  // 見えている一覧を、選択範囲の先頭（無ければ直後の行）までスクロール
  // Scrolls the visible list to the first row of the selection (or the next row when the bin is empty)
  function scrollToSelection() {
    if (selectedBin === null) return;
    const showingStamps = !$('panel-stamps').hidden;
    const panel = showingStamps ? $('panel-stamps') : $('panel-comments');
    const items = showingStamps ? stampItems : commentItems;
    const range = showingStamps ? highlighted.stamps : highlighted.comments;
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
    $('selection-label').textContent = '選択 / Selected: ' + tc(start) + ' – ' + tc(end) +
      '（' + (commentRange[1] - commentRange[0]).toLocaleString() + ' 件 / comments）';
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
      setStatus(status, '−3600〜3600 の秒数を入れてください / Enter seconds between −3600 and 3600 (bad_request)', 'error');
      return;
    }
    input.classList.remove('invalid');
    if (value === Number(stream[key])) return;
    try {
      const body = {};
      body[key] = value;
      stream = (await api(base, { method: 'PATCH', body: body })).stream;
      setStatus(status, '保存しました / Saved: ' + SETTING_LABELS[key] + ' = ' + stream[key] + ' s', 'ok');
      post({ type: 'settings' });
      retime();
      redraw();
    } catch (e) {
      input.value = String(stream[key]);
      setStatus(status, '保存できませんでした / Not saved: ' + errorText(e) + '（現在 / now ' + stream[key] + ' s）', 'error');
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
          setStatus($('page-status'), '印を付けました / Marked ' + record.timecode, 'ok');
        } else {
          const reason = ((result.rejected || [])[0] || {}).reason || 'unknown';
          showError('印を付けられませんでした / Could not mark (' + reason + ')');
        }
      } catch (e) {
        showError('印を付けられませんでした / Could not mark: ' + errorText(e));
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
    select.replaceChildren(el('option', { value: '', text: '候補を読み込み中… / Loading candidates…' }));
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
      el('option', { value: '', text: vodCandidates.length ? '選んでください / Choose one' : '候補がありません / No candidates' }),
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
        showError('VOD の URL（twitch.tv/videos/…）か数字の ID を入れてください / Enter a VOD URL (twitch.tv/videos/…) or numeric ID');
        return;
      }
    } else {
      vodId = $('vod-select').value;
      if (!vodId) {
        showError('VOD を選ぶか URL を入れてください / Choose a VOD or enter a URL');
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
        throw new Error('VOD の長さが 0 秒です（処理中か削除済み）/ The VOD length is 0 s (still processing or deleted)');
      }
      progress('0 件 / 0 comments');
      const rows = await YTSChat.fetchVodChat(vodId, function (n) {
        progress(n.toLocaleString() + ' 件 / ' + n.toLocaleString() + ' comments');
      }, { signal: controller.signal });
      const length = vod
        ? Number(vod.lengthSeconds)
        : Math.ceil(rows.reduce(function (m, r) { return Math.max(m, Number(r[0]) || 0); }, 0));
      progress('保存中… / Saving… (' + rows.length.toLocaleString() + ' 件 / comments)');
      const query = new URLSearchParams({ vod_id: vodId, count: String(rows.length), length_sec: String(length) });
      await api(base + '/chat?' + query.toString(), { method: 'PUT', rawBody: YTSChat.buildChatJson(vodId, length, rows) });
      stream = (await api(base)).stream;
      setChat(await loadChat());
      fillSettings();
      renderHead();
      redraw();
      setStatus($('page-status'), '取り込みました / Imported: ' + rows.length.toLocaleString() + ' 件 / comments', 'ok');
    } catch (e) {
      if (isAbort(e)) setStatus($('page-status'), '取り込みを中止しました / Import cancelled');
      else showError('取り込めませんでした / Import failed: ' + messageOf(e));
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
    if (!win) showError('別ウィンドウを開けませんでした（ポップアップのブロック）/ Could not open the window (pop-up blocked)');
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
  }

  // 起動の失敗は画面に出す（例外を外に漏らさない）/ Boot failures go on screen (nothing escapes as an unhandled rejection)
  boot().catch(function (e) {
    const status = $('boot-status');
    status.hidden = false;
    setStatus(status, errorText(e), 'error');
  });
}());
