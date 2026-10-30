'use strict';

const cs = new CSInterface();
const hostApp = cs.getHostEnvironment().appName; // 'PPRO' | 'AEFT'
const extPath = cs.getSystemPath(SystemPath.EXTENSION);
cs.evalScript('$.evalFile(' + JSON.stringify(extPath + '/jsx/' + (hostApp === 'PPRO' ? 'ppro' : 'aeft') + '.jsx') + ')');

(function () {
  const elements = {
    newCsv: document.getElementById('newCsv'),
    pickCsv: document.getElementById('pickCsv'),
    mergeCsv: document.getElementById('mergeCsv'),
    serverBtn: document.getElementById('serverBtn'),
    serverPopover: document.getElementById('serverPopover'),
    serverUrl: document.getElementById('serverUrl'),
    serverToken: document.getElementById('serverToken'),
    serverConnect: document.getElementById('serverConnect'),
    serverClose: document.getElementById('serverClose'),
    serverPicker: document.getElementById('serverPicker'),
    serverChannel: document.getElementById('serverChannel'),
    serverStream: document.getElementById('serverStream'),
    serverOpen: document.getElementById('serverOpen'),
    exportFramesBtn: document.getElementById('exportFramesBtn'),
    shortsBtn: document.getElementById('shortsBtn'),
    shortsPopover: document.getElementById('shortsPopover'),
    shortsPre: document.getElementById('shortsPre'),
    shortsPost: document.getElementById('shortsPost'),
    shortsIncludeHuman: document.getElementById('shortsIncludeHuman'),
    shortsCreate: document.getElementById('shortsCreate'),
    shortsClose: document.getElementById('shortsClose'),
    importStreamBtn: document.getElementById('importStreamBtn'),
    importPopover: document.getElementById('importPopover'),
    importRoot: document.getElementById('importRoot'),
    importPlan: document.getElementById('importPlan'),
    importRun: document.getElementById('importRun'),
    importClose: document.getElementById('importClose'),
    stream: document.getElementById('stream'),
    offsetBtn: document.getElementById('offsetBtn'),
    offsetLabel: document.getElementById('offsetLabel'),
    offsetPopover: document.getElementById('offsetPopover'),
    offsetInput: document.getElementById('offsetInput'),
    offsetSeconds: document.getElementById('offsetSeconds'),
    offsetError: document.getElementById('offsetError'),
    offsetMinusSec: document.getElementById('offsetMinusSec'),
    offsetPlusSec: document.getElementById('offsetPlusSec'),
    offsetMinusFrame: document.getElementById('offsetMinusFrame'),
    offsetPlusFrame: document.getElementById('offsetPlusFrame'),
    offsetReset: document.getElementById('offsetReset'),
    linkTarget: document.getElementById('linkTarget'),
    refreshBtn: document.getElementById('refreshBtn'),
    addUntagged: document.getElementById('addUntagged'),
    addMarkerBtn: document.getElementById('addMarkerBtn'),
    syncBtn: document.getElementById('syncBtn'),
    executeBtn: document.getElementById('executeBtn'),
    previewDrawer: document.getElementById('previewDrawer'),
    closePreview: document.getElementById('closePreview'),
    warnings: document.getElementById('warnings'),
    confirmDeleteRow: document.getElementById('confirmDeleteRow'),
    confirmDelete: document.getElementById('confirmDelete'),
    previewList: document.getElementById('previewList'),
    log: document.getElementById('log'),
    linkState: document.getElementById('linkState'),
    status: document.getElementById('status'),
    logHistory: document.getElementById('logHistory'),
    markerList: document.getElementById('markerList')
  };
  const storageKey = 'yts.csvPath.' + hostApp;
  const allControls = [elements.newCsv, elements.pickCsv, elements.mergeCsv, elements.serverBtn, elements.exportFramesBtn, elements.shortsBtn, elements.shortsCreate, elements.importStreamBtn, elements.importRun, elements.stream, elements.offsetBtn, elements.linkTarget,
    elements.refreshBtn, elements.addUntagged, elements.addMarkerBtn, elements.syncBtn, elements.executeBtn];
  const offsetControls = [elements.offsetInput, elements.offsetMinusSec, elements.offsetPlusSec,
    elements.offsetMinusFrame, elements.offsetPlusFrame, elements.offsetReset];
  let csvFilePath = '';
  let groups = [];
  let activeInfo = null;
  let activeEntry = null;
  let activeKey = '';
  let userOffsetSec = 0;
  let offsetCsvPath = '';
  let busy = false;
  // 「配信を取り込む」の実行中。途中の setBusy(false)（openServerStream など）でボタンが戻らないよう setBusy が OR する
  // An import is in flight; setBusy ORs it in so nested setBusy(false) calls (openServerStream etc.) do not re-enable buttons mid-import.
  let importRunning = false;
  let previewState = null;
  let choices = {};
  let libraryReady = typeof TSLib !== 'undefined';
  let markerRequestToken = 0;
  let lastSeekKey = '';
  let csvById = new Map();
  let focusTimer = null;
  const statusHistory = [];
  const thumbCache = new Map();
  const thumbFailed = new Set();
  const thumbnailVideo = document.createElement('video');
  // Separate decoder for full-resolution frame export so it never disturbs the thumbnail queue.
  const frameVideo = document.createElement('video');
  frameVideo.muted = true;
  frameVideo.preload = 'auto';
  const frameCanvas = document.createElement('canvas');
  let frameVideoPath = '';
  let lastMarkerDetails = null;
  const thumbnailCanvas = document.createElement('canvas');
  let currentVideoPath = '';
  let thumbnailQueue = [];
  let thumbnailProcessing = false;
  let thumbGeneration = 0;
  let activeCaptureAbort = null;
  let markerObserver = null;
  let markerEditBusy = false;
  let thumbDiskCacheReady = null;
  let thumbDiskCacheDir = '';
  const sourceMtimeCache = new Map();
  // 同期元「サーバー」の状態 / State of the "server" sync source
  // window のプロパティとして読む（server.js が失敗しても TDZ の ReferenceError にならない）
  // Read as a window property (no TDZ ReferenceError even if server.js failed).
  const serverReady = !!window.YTSServer;
  let serverBusy = false;
  let serverLogin = '';
  let serverStreams = [];
  let serverMirrorCache = { path: null, value: false };
  // 直前の pull でサーバーにあった id → updated_at（同じものは push しない） / id → updated_at the server had at the last pull (not pushed back)
  let serverPulled = { path: '', byId: new Map() };
  // pull の結果を同期の完了メッセージに添える / The pull result, added to the sync's completion message
  let serverSyncNote = '';
  const ZERO_STAMPS_MESSAGE = 'サーバーの配信を開きました（スタンプ 0 件）';

  thumbnailVideo.muted = true;
  thumbnailVideo.preload = 'auto';

  // ponytail: no eviction; add LRU cleanup if the cache grows too large
  // ponytail: Replacing a source video during this session can leave stale thumbnails because mtimes are memoized.

  // AE にはシーケンスが無いので Shorts ボタンを出さない / After Effects has no sequences, so the Shorts button is hidden.
  elements.shortsBtn.hidden = hostApp !== 'PPRO';
  // 「配信を取り込む」も Premiere だけ / "配信を取り込む" is Premiere-only too.
  elements.importStreamBtn.hidden = hostApp !== 'PPRO';

  elements.linkTarget.title = hostApp === 'PPRO'
    ? 'アクティブなシーケンスに紐付け'
    : 'アクティブなコンポに紐付け';

  function messageOf(error) {
    return error && error.message ? error.message : String(error);
  }

  function setStatus(message, className) {
    elements.status.textContent = message || '';
    elements.status.className = 'status' + (className ? ' ' + className : '');
    elements.status.title = message || '';
    if (!message) return;
    const now = new Date();
    statusHistory.push({
      time: [now.getHours(), now.getMinutes(), now.getSeconds()].map(function (value) {
        return ('0' + value).slice(-2);
      }).join(':'),
      message: String(message),
      className: className || ''
    });
    if (statusHistory.length > 20) statusHistory.shift();
    renderLogHistory();
  }

  function renderLogHistory() {
    clearChildren(elements.logHistory);
    statusHistory.slice().reverse().forEach(function (entry) {
      const row = document.createElement('div');
      row.className = 'log-history-row' + (entry.className ? ' ' + entry.className : '');
      row.textContent = entry.time + ' ' + entry.message;
      row.title = row.textContent;
      elements.logHistory.appendChild(row);
    });
  }

  function basename(path) {
    const parts = String(path || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  function updateCsvButton() {
    const text = csvFilePath || '同期 CSV を選択';
    elements.pickCsv.title = text;
    elements.pickCsv.setAttribute('aria-label', text);
  }

  function updateLinkState(failed) {
    let text;
    if (failed) {
      text = '紐付け先を取得できませんでした';
    } else if (!activeInfo || !activeInfo.hasTarget) {
      text = missingTargetText();
    } else if (activeEntry) {
      const group = groups.find(function (item) { return item.stream_id === activeEntry.stream_id; });
      const streamName = group ? group.channel || group.stream_id : activeEntry.stream_id;
      text = activeInfo.name + ' ⇔ ' + basename(csvFilePath) + '（配信 ' + streamName + '）';
    } else {
      text = '未紐付け: ' + activeInfo.name;
    }
    // サーバーの鏡 CSV を開いているときは目印を付ける / Mark when a server mirror CSV is open
    if (!failed && isServerMirror(csvFilePath)) text = 'サーバー · ' + text;
    elements.linkState.textContent = text;
    elements.linkState.title = text;
  }

  function offsetFps() {
    // Use 30 fps when no target is available so the popover remains usable before linking.
    return activeInfo && Number(activeInfo.fps) > 0 ? Number(activeInfo.fps) : 30;
  }

  function formatSeconds(value) {
    return String(Math.round(value * 1000) / 1000);
  }

  function updateOffsetDisplay() {
    const text = TSLib.formatTimecodeFrames(userOffsetSec, offsetFps());
    elements.offsetInput.value = text;
    elements.offsetSeconds.textContent = '= ' + formatSeconds(userOffsetSec) + ' 秒';
    elements.offsetLabel.textContent = userOffsetSec !== 0 ? text : '';
    elements.offsetLabel.hidden = userOffsetSec === 0;
    elements.offsetBtn.title = userOffsetSec !== 0 ? 'オフセット（' + formatSeconds(userOffsetSec) + ' 秒）' : 'オフセット';
  }

  function setOffset(value) {
    const next = Number(value);
    const changed = next !== userOffsetSec;
    userOffsetSec = next;
    elements.offsetInput.classList.remove('invalid');
    elements.offsetError.textContent = '';
    updateOffsetDisplay();
    // Blur commits the input even when nothing was edited; only a real change may discard the preview.
    if (changed) invalidatePreview();
  }

  function commitOffsetInput() {
    const parsed = TSLib.parseTimecodeFrames(elements.offsetInput.value, offsetFps());
    if (!Number.isFinite(parsed)) {
      elements.offsetInput.classList.add('invalid');
      elements.offsetError.textContent = 'hh:mm:ss:ff 形式で入力してください';
      return false;
    }
    setOffset(parsed);
    return true;
  }

  function closeOffsetPopover() {
    elements.offsetPopover.hidden = true;
    elements.offsetBtn.setAttribute('aria-expanded', 'false');
  }

  // 「候補から Sequence を作る」の前後秒数はパネルを閉じても覚えておく / The Shorts before/after seconds survive panel restarts.
  const shortsStorageKeys = { pre: 'yts.shorts.pre', post: 'yts.shorts.post' };

  function closeShortsPopover() {
    elements.shortsPopover.hidden = true;
    elements.shortsBtn.setAttribute('aria-expanded', 'false');
  }

  async function createShorts() {
    const pre = Number(elements.shortsPre.value), post = Number(elements.shortsPost.value);
    if (!(pre >= 0) || !(post > 0)) { setStatus('前後の秒数を確認してください', 'error'); return; }
    try {
      localStorage.setItem(shortsStorageKeys.pre, String(pre));
      localStorage.setItem(shortsStorageKeys.post, String(post));
    } catch (error) {}
    setBusy(true);
    try {
      // 日付 YYMMDD は配信の開始日（JST）。無ければ ExtendScript 側が Sequence 名の先頭 6 桁を使う
      // The YYMMDD date is the stream's start day (JST); without it the ExtendScript side uses the sequence name's leading 6 digits.
      const group = selectedGroup();
      const params = { preSec: pre, postSec: post, includeHuman: elements.shortsIncludeHuman.checked, dateTag: dateTagOf(group && group.started_at), parentBin: 'Sequence' };
      // その日の bin に既に Short があれば、二重に作る前に確認する / Confirm before adding to a day bin that already holds Shorts
      const probe = await callHost('ytsCreateShorts(' + hostLiteral(Object.assign({ dryRun: true }, params)) + ')', true);
      if (probe.existing > 0 && !window.confirm(probe.bin + ' には既に ' + probe.existing + ' 本あります。さらに ' + probe.targets + ' 本作りますか？')) {
        setStatus('作成を中止しました', '');
        return;
      }
      const out = await callHost('ytsCreateShorts(' + hostLiteral(params) + ')', true);
      // skipped = 範囲が取れない、または Sequence を作れなかったマーカー / skipped = markers with no usable range or whose sequence could not be created
      if (!out.created.length) {
        setStatus('候補マーカーがありません' + (out.skipped ? '（' + out.skipped + ' 件はスキップ）' : ''), '');
      } else {
        setStatus(out.created.length + ' 件の Sequence を作成しました（' + (out.bin || 'Peakaboo_Shorts') + '）' + (out.skipped ? '、' + out.skipped + ' 件はスキップ' : ''), 'ok');
      }
      closeShortsPopover();
    } catch (error) { setStatus(messageOf(error), 'error'); } finally { setBusy(false); }
  }

  // ISO の開始時刻を JST の YYMMDD にする（読めなければ ''）/ ISO start time -> YYMMDD in JST ('' when unreadable)
  function dateTagOf(startedAt) {
    const date = new Date(startedAt || '');
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const pick = function (type) { const part = parts.find(function (q) { return q.type === type; }); return part ? part.value : ''; };
    const tag = pick('year') + pick('month') + pick('day');
    return /^\d{6}$/.test(tag) ? tag : '';
  }

  function hostLiteral(value) {
    return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  function callHost(expr, parseJson) {
    return new Promise(function (resolve, reject) {
      cs.evalScript(expr, function (result) {
        if (typeof result !== 'string' || !result || result === 'EvalScript error.') {
          reject(new Error('ExtendScript の実行に失敗しました（EvalScript error.）'));
          return;
        }
        if (result.indexOf('ERR|') === 0) {
          reject(new Error(result.slice(4)));
          return;
        }
        if (result.indexOf('OK|') !== 0) {
          reject(new Error('ExtendScript の実行に失敗しました（EvalScript error.）'));
          return;
        }
        const payload = result.slice(3);
        if (!parseJson) {
          resolve(payload);
          return;
        }
        try {
          resolve(JSON.parse(payload));
        } catch (error) {
          reject(new Error('ホストから受信したデータを解析できませんでした'));
        }
      });
    });
  }

  function decodeFileData(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      return new TextDecoder('shift_jis').decode(bytes);
    }
  }

  function encodeFileData(text) {
    const bytes = new TextEncoder().encode(text);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length))));
    }
    return btoa(chunks.join(''));
  }

  function readText(path) {
    const result = window.cep.fs.readFile(path, window.cep.encoding.Base64);
    if (!result || result.err !== 0) {
      throw new Error('ファイルを読み込めませんでした（エラー ' + (result ? result.err : '不明') + '）');
    }
    return decodeFileData(result.data);
  }

  function pathExists(path) {
    const result = window.cep.fs.stat(path);
    return !!result && result.err === 0;
  }

  function mtimeToken(path) {
    const result = window.cep.fs.stat(path);
    if (!result || result.err !== 0 || !result.data) {
      throw new Error('ファイル情報を取得できませんでした（エラー ' + (result ? result.err : '不明') + '）');
    }
    return String(result.data.mtime);
  }

  function atomicWrite(path, text) {
    const temporaryPath = path + '.tmp';
    const backupPath = path + '.bak';
    const originalExists = pathExists(path);
    if (originalExists) {
      const original = window.cep.fs.readFile(path, window.cep.encoding.Base64);
      if (!original || original.err !== 0) {
        throw new Error('バックアップ用にファイルを読み込めませんでした（エラー ' + (original ? original.err : '不明') + '）');
      }
      const backup = window.cep.fs.writeFile(backupPath, original.data, window.cep.encoding.Base64);
      if (!backup || backup.err !== 0) {
        throw new Error('バックアップを作成できませんでした（エラー ' + (backup ? backup.err : '不明') + '）');
      }
    }
    const write = window.cep.fs.writeFile(temporaryPath, encodeFileData(text), window.cep.encoding.Base64);
    if (!write || write.err !== 0) {
      throw new Error('ファイルを書き込めませんでした（エラー ' + (write ? write.err : '不明') + '）');
    }
    let rename = window.cep.fs.rename(temporaryPath, path);
    if ((!rename || rename.err !== 0) && originalExists && pathExists(path)) {
      window.cep.fs.deleteFile(path);
      rename = window.cep.fs.rename(temporaryPath, path);
    }
    if (!rename || rename.err !== 0) {
      throw new Error('ファイルを置き換えられませんでした。元のファイルは ' + backupPath + ' に保持されています（エラー ' +
        (rename ? rename.err : '不明') + '）');
    }
    if (originalExists) {
      try { window.cep.fs.deleteFile(backupPath); } catch (backupDeleteError) {}
    }
  }

  function getSidecarPath(path) {
    return path.replace(/\.csv$/i, '') + '.yts-sync.json';
  }

  function emptySidecar() {
    return { version: 1, targets: {} };
  }

  function readSidecar(path) {
    if (!pathExists(path)) return emptySidecar();
    let value;
    try {
      value = JSON.parse(readText(path));
    } catch (error) {
      throw new Error('同期情報ファイルが壊れています。内容を確認してください: ' + path);
    }
    if (!value || typeof value !== 'object' || !value.targets || typeof value.targets !== 'object') {
      throw new Error('同期情報ファイルが壊れています。内容を確認してください: ' + path);
    }
    return value;
  }

  function targetKey(info) {
    return hostApp + '|' + String(info.projectPath || '') + '|' + String(info.targetId || '');
  }

  function selectedGroup() {
    const streamId = elements.stream.value;
    for (let i = 0; i < groups.length; i += 1) {
      if (groups[i].stream_id === streamId) return groups[i];
    }
    return null;
  }

  function displayStartedAt(startedAt) {
    if (!startedAt) return '開始時刻不明';
    const date = new Date(startedAt);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '開始時刻不明';
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function populateStreams(preferredStreamId) {
    clearChildren(elements.stream);
    if (!groups.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = csvFilePath ? '有効な配信がありません' : 'CSV を選択してください';
      elements.stream.appendChild(option);
      return;
    }
    if (groups.length > 1) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '配信を選択してください';
      elements.stream.appendChild(placeholder);
    }
    groups.forEach(function (group) {
      const option = document.createElement('option');
      option.value = group.stream_id;
      option.textContent = (group.channel || '不明なチャンネル') + ' / ' +
        displayStartedAt(group.started_at) + ' / ' + group.records.length + ' 件';
      elements.stream.appendChild(option);
    });
    if (preferredStreamId && groups.some(function (group) { return group.stream_id === preferredStreamId; })) {
      elements.stream.value = preferredStreamId;
    } else if (groups.length === 1) {
      elements.stream.value = groups[0].stream_id;
    }
  }

  function invalidatePreview() {
    previewState = null;
    choices = {};
    elements.previewDrawer.hidden = true;
    elements.warnings.textContent = '';
    elements.confirmDelete.checked = false;
    elements.confirmDeleteRow.hidden = true;
    clearChildren(elements.previewList);
    updateControls();
  }

  function updateControls() {
    if (!libraryReady) {
      allControls.forEach(function (control) { control.disabled = true; });
      offsetControls.forEach(function (control) { control.disabled = true; });
      return;
    }
    const group = selectedGroup();
    const linked = !!activeEntry;
    elements.pickCsv.disabled = busy;
    elements.newCsv.disabled = busy; // the active target is re-read when clicked
    // 鏡 CSV への統合はサーバーへ届かないので無効にする（古い CSV は拡張の「CSV を取り込む」で送る）
    // Merging into a mirror never reaches the server, so it is disabled (old CSVs go through the extension's import).
    const mirrorOpen = isServerMirror(csvFilePath);
    elements.mergeCsv.disabled = busy || !csvFilePath || mirrorOpen;
    elements.mergeCsv.title = mirrorOpen
      ? 'サーバーの配信では統合できません。古い CSV は Chrome 拡張の「CSV を取り込む」でサーバーへ送ってください'
      : 'ほかの CSV を同期ファイルに統合（複数選択可）';
    elements.serverBtn.disabled = busy || !serverReady;
    updateServerControls();
    elements.exportFramesBtn.disabled = busy || !lastMarkerDetails || !lastMarkerDetails.markers.length;
    elements.exportFramesBtn.title = '全マーカーを画像で書き出す（保存先を選択）';
    elements.shortsBtn.disabled = busy || hostApp !== 'PPRO' || !activeInfo || !activeInfo.hasTarget;
    elements.shortsCreate.disabled = busy;
    elements.importStreamBtn.disabled = busy || hostApp !== 'PPRO' || !serverReady || !window.YTSImport;
    elements.importRun.disabled = busy || !elements.importPlan.value;
    elements.refreshBtn.disabled = busy;
    elements.stream.disabled = busy || !groups.length || linked;
    elements.stream.hidden = !(groups.length >= 2 && !activeEntry);
    elements.offsetBtn.disabled = busy;
    offsetControls.forEach(function (control) { control.disabled = busy; });
    elements.addUntagged.disabled = busy;
    elements.confirmDelete.disabled = busy;
    elements.linkTarget.disabled = busy || !csvFilePath || !group || !activeInfo || !activeInfo.hasTarget;
    elements.linkTarget.textContent = activeEntry ? '再紐付け' : '紐付け';
    elements.addMarkerBtn.disabled = busy || markerEditBusy || !activeInfo || !activeInfo.hasTarget;
    elements.syncBtn.disabled = busy || !csvFilePath || !group || !activeEntry;
    const deleteConfirmationMissing = !!(previewState && previewState.plan && previewState.plan.needsConfirm &&
      !elements.confirmDelete.checked);
    elements.executeBtn.disabled = busy || !previewState || !!(previewState && previewState.plan && previewState.plan.error) ||
      deleteConfirmationMissing;
    const conflictSelects = elements.previewList.querySelectorAll('.conflict-select');
    for (let i = 0; i < conflictSelects.length; i += 1) conflictSelects[i].disabled = busy;
    updateCsvButton();
  }

  function setBusy(value) {
    busy = value || importRunning;
    updateControls();
  }

  function missingTargetText() {
    return hostApp === 'PPRO' ? 'アクティブなシーケンスがありません' : 'アクティブなコンポジションがありません';
  }

  function targetNoun() {
    return hostApp === 'PPRO' ? 'シーケンス' : 'コンポジション';
  }

  function updateTargetDisplay(sidecar) {
    const previousActiveKey = activeKey;
    activeEntry = null;
    activeKey = '';
    if (!activeInfo || !activeInfo.hasTarget) {
      populateStreams(elements.stream.value);
      updateLinkState(false);
      updateOffsetDisplay();
      updateControls();
      return;
    }
    activeKey = targetKey(activeInfo);
    activeEntry = sidecar && sidecar.targets ? sidecar.targets[activeKey] || null : null;
    if (activeEntry) {
      populateStreams(activeEntry.stream_id);
      userOffsetSec = Number(activeEntry.userOffset) || 0;
    } else {
      populateStreams(elements.stream.value);
      // An unlinked target starts at offset 0 when the target or the CSV changed, so a previous CSV's
      // offset is never carried into an automatic link.
      if (activeKey !== previousActiveKey || csvFilePath !== offsetCsvPath) userOffsetSec = 0;
    }
    offsetCsvPath = csvFilePath;
    updateLinkState(false);
    updateOffsetDisplay();
    updateControls();
  }

  async function refreshTarget(showSuccess) {
    invalidatePreview();
    setBusy(true);
    try {
      activeInfo = await callHost('ytsTargetInfo()', true);
      const sidecar = csvFilePath ? readSidecar(getSidecarPath(csvFilePath)) : emptySidecar();
      updateTargetDisplay(sidecar);
      if (showSuccess) setStatus('紐付け先を更新しました', 'ok');
    } catch (error) {
      activeInfo = null;
      activeEntry = null;
      activeKey = '';
      updateLinkState(true);
      setStatus(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function loadCsvPath(path, remember) {
    invalidatePreview();
    setBusy(true);
    try {
      const text = readText(path);
      if (TSLib.detectCsvFormat(text).format !== 'sync') throw notSyncFormatError(path);
      const parsed = TSLib.parseCsv(text);
      groups = TSLib.groupByStream(parsed.records);
      // スタンプ 0 件のサーバー配信は meta から配信を 1 つ作る（紐付けて「＋追加」で最初の印を付けられる）
      // A server stream with zero stamps gets one stream from its meta (so it can be linked and the first marker added).
      const emptyGroup = !groups.length && isServerMirror(path) ? emptyMirrorGroup(path) : null;
      if (emptyGroup) groups = [emptyGroup];
      csvById = new Map();
      parsed.records.forEach(function (record) {
        if (record.id) csvById.set(record.id, record);
      });
      csvFilePath = path;
      updateCsvButton();
      populateStreams('');
      if (remember) {
        try { localStorage.setItem(storageKey, path); } catch (storageError) {}
      }
      activeInfo = await callHost('ytsTargetInfo()', true);
      updateTargetDisplay(readSidecar(getSidecarPath(path)));
      const skipped = Array.isArray(parsed.skipped) ? parsed.skipped.length : Number(parsed.skipped) || 0;
      if (!groups.length) throw new Error('有効なタイムスタンプがありません');
      const loadMessage = emptyGroup ? ZERO_STAMPS_MESSAGE : basename(path) + ': ' + groups.length + ' 件の配信を読み込みました' +
        (skipped ? '（スキップ ' + skipped + ' 行）' : '');
      setStatus(loadMessage, 'ok');
    } catch (error) {
      activeEntry = null;
      activeKey = '';
      if (!csvFilePath || csvFilePath !== path) {
        groups = [];
        csvById = new Map();
        csvFilePath = '';
        updateCsvButton();
        populateStreams('');
      }
      updateLinkState(false);
      setStatus(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function notSyncFormatError(path) {
    return new Error(basename(path) + ' は同期ファイルの形式ではありません（offset_sec の列がありません）。シーケンスのマーカーから作るには「新規」を使ってください');
  }

  function fileMtimeIso(path) {
    try {
      const result = window.cep.fs.stat(path);
      const time = result && result.err === 0 && result.data ? new Date(result.data.mtime).getTime() : NaN;
      return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
    } catch (error) {
      return new Date().toISOString();
    }
  }

  // "（追加 a 件・更新 u 件・編集済みのため取り込まなかった k 件・…）" for a mergeIntoSync result.
  function importCounts(merged) {
    const parts = ['追加 ' + merged.added + ' 件', '更新 ' + merged.updated + ' 件'];
    if (merged.keptEdited) parts.push('編集済みのため取り込まなかった ' + merged.keptEdited + ' 件');
    if (merged.rekeyed) parts.push('別の配信と重なった ID を振り直した ' + merged.rekeyed + ' 件');
    return '（' + parts.join('・') + '）';
  }

  // Reads a CSV in any supported format. Old DualPlayer exports are converted to sync rows
  // (stream = the folder the CSV sits in, updated_at = the file's modification time).
  function readAnyCsv(path) {
    const text = readText(path);
    const detected = TSLib.detectCsvFormat(text);
    if (detected.format === 'sync') return { format: 'sync', parsed: TSLib.parseCsv(text) };
    if (detected.format === 'dualplayer') {
      const folder = dirname(path);
      return {
        format: 'dualplayer',
        parsed: TSLib.convertDualPlayer(text, {
          delimiter: detected.delimiter,
          streamId: TSLib.dualPlayerStreamId(folder),
          channel: basename(folder),
          updatedAt: fileMtimeIso(path)
        })
      };
    }
    throw notSyncFormatError(path);
  }

  // DualPlayer CSV picked as the sync file: convert to "<name>_sync.csv" next to it (merging if it already exists).
  async function adoptDualPlayerCsv(path, converted) {
    const target = path.replace(/(\.[^.\\/]*)?$/, '_sync.csv');
    if (converted.skippedRows.length) {
      throw new Error(basename(path) + ': 読めない行 ' + converted.skippedRows.join(', ') + ' 行目があるため変換しませんでした');
    }
    let message;
    if (pathExists(target)) {
      const existing = TSLib.parseCsv(readText(target));
      if (existing.skippedRows && existing.skippedRows.length) {
        throw new Error(basename(target) + ' に読めない行があります: ' + existing.skippedRows.join(', ') + ' 行目');
      }
      const merged = TSLib.mergeIntoSync(existing.records, [converted.records]);
      if (merged.added || merged.updated) atomicWrite(target, TSLib.toCsv(merged.records));
      message = basename(target) + ' に取り込みました' + importCounts(merged);
    } else {
      atomicWrite(target, TSLib.toCsv(converted.records));
      message = basename(target) + ' を作成しました（' + converted.records.length + ' 件）';
    }
    await loadCsvPath(target, true);
    refreshMarkers();
    return { path: target, message: 'DualPlayer の CSV を変換しました: ' + message };
  }

  // Right after the user loads a CSV: link the open sequence/comp if it is not linked yet (never re-links,
  // so sync history is kept), then go straight to sync. The first sync still stops at the confirm drawer.
  // Returns false when it did nothing (no target, several streams, ...), so the caller can show its own message.
  // options（省略可）: userOffset = 新しく紐付けるときのオフセット秒、skipConfirm = syncNow へそのまま渡す
  // options (optional): userOffset = offset seconds used when newly linking, skipConfirm = passed through to syncNow.
  async function autoLinkAndSync(prefix, options) {
    const opts = options || {};
    if (!csvFilePath || groups.length !== 1 || !selectedGroup()) return false;
    try {
      let info;
      try { info = await callHost('ytsTargetInfo()', true); } catch (error) { return false; }
      if (!info || !info.hasTarget) return false;
      const sidecarPath = getSidecarPath(csvFilePath);
      let autoLinked = false;
      if (!readSidecar(sidecarPath).targets[targetKey(info)]) {
        // linkTarget は userOffsetSec を紐付けに書く。オフセット欄と同じ setOffset で入れる / linkTarget stores userOffsetSec; set through setOffset like the offset controls
        if (Number.isFinite(opts.userOffset)) setOffset(opts.userOffset);
        await linkTarget();
        if (!readSidecar(sidecarPath).targets[targetKey(info)]) return true; // linking failed; its error is already shown
        autoLinked = true;
      }
      await syncNow(true, opts);
      const notes = [];
      if (prefix) notes.push(prefix);
      notes.push(elements.status.textContent);
      if (autoLinked) {
        const offsetNote = userOffsetSec ? '（オフセット ' + userOffsetSec + ' 秒）' : '';
        notes.push(info.name + ' に自動で紐付けました' + offsetNote +
          (elements.previewDrawer.hidden ? '' : '。別のシーケンスに紐付ける場合は、そのシーケンスを開いて再紐付けしてください'));
      }
      setStatus(notes.join(' / '), elements.status.classList.contains('error') ? 'error' : 'ok');
      return true;
    } catch (error) {
      setStatus((prefix ? prefix + ' / ' : '') + messageOf(error), 'error');
      return true;
    }
  }

  async function pickCsv() {
    const result = window.cep.fs.showOpenDialogEx(false, false, '同期 CSV を選択', '', ['csv']);
    if (!result || result.err !== 0 || !result.data || !result.data[0]) return;
    const path = result.data[0];
    let read;
    try {
      read = readAnyCsv(path);
    } catch (error) {
      setStatus(messageOf(error), 'error');
      return;
    }
    // The original DualPlayer file is never modified, so it is converted without asking.
    let loadedPath = path;
    let prefix = '';
    if (read.format === 'dualplayer') {
      try {
        const adopted = await adoptDualPlayerCsv(path, read.parsed);
        loadedPath = adopted.path;
        prefix = adopted.message;
      } catch (error) {
        setStatus(messageOf(error), 'error');
        return;
      }
    } else {
      await loadCsvPath(path, true);
      refreshMarkers();
    }
    // loadCsvPath keeps the previous file when loading fails; only continue with the file just picked.
    if (!samePath(csvFilePath, loadedPath)) return;
    if (!(await autoLinkAndSync(prefix)) && prefix) setStatus(prefix, 'ok');
  }

  // ---- create a new sync CSV from the active sequence/comp -------------------

  // Writes a CSV from the current markers, tags untagged markers, and links the target as already synced,
  // so the next "同期" only handles real differences.
  async function createCsvFromTarget() {
    if (busy) return;
    setBusy(true);
    try {
      const info = await callHost('ytsTargetInfo()', true);
      if (!info || !info.hasTarget) throw new Error('シーケンス（コンポ）を開いてください');
      const details = await callHost('ytsMarkerDetails()', true);
      const markers = Array.isArray(details.markers) ? details.markers : [];
      if (!markers.length) throw new Error('マーカーを 1 つ以上打ってから作成してください（＋追加でも打てます）');

      const defaultName = String(info.name || 'markers').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') + '.csv';
      const dialog = window.cep.fs.showSaveDialogEx('同期 CSV を新規作成', csvFilePath ? dirname(csvFilePath) : '', ['csv'], defaultName);
      if (!dialog || dialog.err !== 0 || !dialog.data) return;
      let path = String(dialog.data);
      if (!/\.csv$/i.test(path)) path += '.csv';
      if (pathExists(path)) throw new Error('同じ名前のファイルがあります。別の名前にしてください');

      const streamId = TSLib.localStreamId(info.projectPath, info.targetId);
      const now = new Date().toISOString();
      // Memos come from ytsListMarkers (exactly what sync compares later); details only add the recorder.
      const listed = await callHost('ytsListMarkers()', true);
      const byIndex = new Map(markers.map(function (m) { return [m.index, m.by]; }));
      const built = TSLib.recordsFromMarkers({
        appMarkers: listed.map(function (m) { return { index: m.index, id: m.id, t: m.t, memo: m.memo, by: byIndex.get(m.index) || '' }; }),
        streamId: streamId,
        channel: info.name || '',
        by: hostApp === 'PPRO' ? 'premiere' : 'ae',
        now: now,
        fps: info.fps
      });
      let failedIds = [];
      if (built.tagOps.length) {
        const applied = await callHost('ytsApply(' + hostLiteral(built.tagOps) + ')', true);
        failedIds = Array.isArray(applied.failed) ? applied.failed : [];
      }
      const failed = new Set(failedIds);
      const records = built.records.filter(function (record) { return !failed.has(record.id); });
      if (!records.length) throw new Error('マーカーに ID を付けられませんでした');
      atomicWrite(path, TSLib.toCsv(records));

      // Base = what actually landed in the app, read back after tagging (same as after a sync).
      const relisted = await callHost('ytsListMarkers()', true);
      const sidecar = emptySidecar();
      sidecar.targets[targetKey(info)] = {
        host: hostApp,
        projectPath: info.projectPath || '',
        targetId: String(info.targetId || ''),
        name: info.name || '',
        stream_id: streamId,
        userOffset: 0,
        lastSyncAt: now,
        base: TSLib.baseFromMarkers({ records: records, streamId: streamId, appMarkers: relisted, userOffset: 0 })
      };
      atomicWrite(getSidecarPath(path), JSON.stringify(sidecar, null, 2));

      setBusy(false);
      userOffsetSec = 0;
      await loadCsvPath(path, true);
      refreshMarkers();
      setStatus(basename(path) + ' を作成しました（マーカー ' + records.length + ' 件）。このシーケンスと紐付けました' +
        (failed.size ? '（ID を付けられなかった ' + failed.size + ' 件は除外）' : ''), failed.size ? '' : 'ok');
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      if (busy) setBusy(false);
    }
  }

  // ---- export marker frames as PNG (source frame, full resolution) ---------

  // Decodes the source video at full resolution and returns a PNG data URL.
  // ponytail: browser seeking can land ±1 frame off; add an ffmpeg path if frame-exact output is needed.
  function captureFullFrame(media, fps) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const listeners = [];
      const timer = setTimeout(function () { finish(new Error('動画の読み込みがタイムアウトしました')); }, 20000);
      function finish(error, dataUrl) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.forEach(function (item) { frameVideo.removeEventListener(item[0], item[1]); });
        if (error) { frameVideoPath = ''; reject(error); } else resolve(dataUrl);
      }
      function once(eventName, next) {
        const onEvent = function () { next(); };
        const onError = function () { finish(new Error('動画を読み込めませんでした')); };
        frameVideo.addEventListener(eventName, onEvent, { once: true });
        frameVideo.addEventListener('error', onError, { once: true });
        listeners.push([eventName, onEvent], ['error', onError]);
      }
      function draw() {
        try {
          if (!frameVideo.videoWidth) throw new Error('動画サイズを取得できませんでした');
          frameCanvas.width = frameVideo.videoWidth;
          frameCanvas.height = frameVideo.videoHeight;
          frameCanvas.getContext('2d').drawImage(frameVideo, 0, 0);
          finish(null, frameCanvas.toDataURL('image/png'));
        } catch (error) { finish(error); }
      }
      function seek() {
        // Land inside the frame rather than on its boundary, where the previous frame can be shown.
        const nudge = Math.min(0.25 / (fps > 0 ? fps : 30), 0.004);
        const duration = Number.isFinite(frameVideo.duration) ? frameVideo.duration : Infinity;
        once('seeked', draw);
        frameVideo.currentTime = Math.max(0, Math.min(media.t + nudge, duration - 0.05));
      }
      const url = 'file:///' + encodeURI(String(media.path).replace(/\\/g, '/').replace(/^\/+/, ''))
        .replace(/#/g, '%23').replace(/\?/g, '%3F');
      if (frameVideoPath !== media.path) {
        frameVideoPath = media.path;
        once('loadedmetadata', seek);
        frameVideo.src = url;
        frameVideo.load();
      } else {
        seek();
      }
    });
  }

  // ---- where frames go ----------------------------------------------------
  const framesDirKey = 'yts.framesDir.' + hostApp;

  function rememberedFramesDir() {
    try { return localStorage.getItem(framesDirKey) || ''; } catch (error) { return ''; }
  }

  function ensureFolder(folder) {
    if (!pathExists(folder)) {
      const made = window.cep.fs.makedir(folder);
      if (!made || made.err !== 0) throw new Error('保存先フォルダを作成できませんでした（エラー ' + (made ? made.err : '不明') + '）');
    }
    return folder;
  }

  // The folder chosen last time, or frames/ next to the sync file.
  function framesFolder() {
    const folder = rememberedFramesDir() || (csvFilePath ? dirname(csvFilePath) + '/frames' : '');
    if (!folder) throw new Error('保存先が決まっていません。全マーカーの書き出しボタンで保存先を選んでください');
    return ensureFolder(folder);
  }

  // Waits until the file exists and its length is stable (the Premiere export is asynchronous).
  // cep.fs.stat has no size field, so the length is measured by reading the file once it exists.
  async function waitForFile(path, timeoutMs) {
    let lastLength = -1;
    for (let waited = 0; waited <= timeoutMs; waited += 500) {
      const stat = window.cep.fs.stat(path);
      let length = -1;
      if (stat && stat.err === 0) {
        const read = window.cep.fs.readFile(path, window.cep.encoding.Base64);
        length = read && read.err === 0 && read.data ? read.data.length : -1;
      }
      if (length > 0 && length === lastLength) return true;
      lastLength = length;
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
    }
    return false;
  }

  // Rendered frame of the sequence/comp (all layers), written by the host.
  async function writeCompositeFrame(marker, folder, fileName) {
    const targetId = activeInfo && activeInfo.targetId ? String(activeInfo.targetId) : '';
    const result = await callHost('ytsExportFrame(' + hostLiteral({
      t: marker.t, dir: folder, name: fileName.replace(/\.png$/i, ''), targetId: targetId
    }) + ')', true);
    if (!(await waitForFile(result.path, 30000))) throw new Error('書き出したファイルが見つかりません（タイムアウト）');
  }

  // Source video frame decoded in the panel (fallback when the rendered export fails).
  async function writeSourceFrame(marker, fps, folder, fileName) {
    const dataUrl = await captureFullFrame(marker.media, fps);
    const written = window.cep.fs.writeFile(folder + '/' + fileName, dataUrl.slice(dataUrl.indexOf(',') + 1), window.cep.encoding.Base64);
    if (!written || written.err !== 0) throw new Error('画像を保存できませんでした（エラー ' + (written ? written.err : '不明') + '）');
  }

  // Returns true when it had to fall back to the source frame.
  async function writeFrame(marker, fps, folder, fileName) {
    try {
      await writeCompositeFrame(marker, folder, fileName);
      return false;
    } catch (compositeError) {
      if (/対象が切り替わりました/.test(messageOf(compositeError)) || !marker.media) throw compositeError;
      await writeSourceFrame(marker, fps, folder, fileName);
      return true;
    }
  }

  // Shows the exported file in Explorer (in front, selected); a failure here never fails the export itself.
  async function revealFile(filePath) {
    try {
      await callHost('ytsRevealFile(' + hostLiteral(filePath) + ')', false);
      return true;
    } catch (error) {
      return false;
    }
  }

  async function exportOneFrame(marker, fps) {
    if (busy) return;
    setBusy(true);
    try {
      const folder = framesFolder();
      const fileName = TSLib.frameFileName(marker.t, fps, marker.name);
      const fellBack = await writeFrame(marker, fps, folder, fileName);
      const opened = await revealFile(folder + '/' + fileName);
      setStatus(folder + '/' + fileName + ' を書き出しました' +
        (fellBack ? '（合成の書き出しに失敗したため、素材のフレームで書き出しました）' : '') +
        (opened ? '' : '（フォルダは開けませんでした）'), fellBack ? '' : 'ok');
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function exportAllFrames() {
    if (busy || !lastMarkerDetails || !lastMarkerDetails.markers.length) return;
    // Choose the destination (starts at the last folder, else frames/ next to the sync file) and remember it.
    const initial = rememberedFramesDir() || (csvFilePath ? dirname(csvFilePath) + '/frames' : '');
    if (initial && csvFilePath && initial === dirname(csvFilePath) + '/frames') {
      try { ensureFolder(initial); } catch (error) {}
    }
    const picked = window.cep.fs.showOpenDialogEx(false, true, '画像の保存先を選択', initial, []);
    if (!picked || picked.err !== 0 || !picked.data || !picked.data[0]) return;
    const folder = String(picked.data[0]);
    try { localStorage.setItem(framesDirKey, folder); } catch (error) {}

    const fps = lastMarkerDetails.fps;
    const markers = lastMarkerDetails.markers.slice();
    setBusy(true);
    let written = 0;
    let fellBackCount = 0;
    let lastWritten = '';
    const failures = [];
    try {
      ensureFolder(folder);
      const used = new Set();
      for (let i = 0; i < markers.length; i += 1) {
        const marker = markers[i];
        setStatus('画像を書き出し中 ' + (i + 1) + '/' + markers.length, '');
        // Same name twice in one batch gets _2, _3; across batches the same name is overwritten.
        let fileName = TSLib.frameFileName(marker.t, fps, marker.name);
        for (let n = 2; used.has(fileName.toLowerCase()); n += 1) {
          fileName = TSLib.frameFileName(marker.t, fps, marker.name).replace(/\.png$/, '_' + n + '.png');
        }
        used.add(fileName.toLowerCase());
        try {
          if (await writeFrame(marker, fps, folder, fileName)) fellBackCount += 1;
          written += 1;
          lastWritten = folder + '/' + fileName;
        } catch (error) {
          failures.push(TSLib.formatTimecodeFrames(marker.t, fps) + ': ' + messageOf(error));
        }
      }
      const opened = lastWritten ? await revealFile(lastWritten) : true;
      const summary = written + ' 枚を ' + folder + ' に書き出しました（失敗 ' + failures.length + ' 件' +
        (fellBackCount ? '・素材のフレームで代用 ' + fellBackCount + ' 件' : '') + '）' +
        (opened ? '' : '（フォルダは開けませんでした）');
      setStatus([summary].concat(failures).join(' / '), failures.length ? 'error' : (fellBackCount ? '' : 'ok'));
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---- merge other CSVs (e.g. moderators' exports) into the sync file -------

  function dirname(path) {
    const value = String(path || '');
    const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    return index >= 0 ? value.slice(0, index) : '';
  }

  function samePath(a, b) {
    const normalize = function (value) { return String(value || '').replace(/\\/g, '/').toLowerCase(); };
    return normalize(a) === normalize(b);
  }

  function stampForFileName() {
    const pad = function (value) { return String(value).padStart(2, '0'); };
    const d = new Date();
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  // Moves a merged source into <sync dir>/merged/, adding a timestamp when the name is taken.
  function moveToMergedFolder(path) {
    const folder = dirname(csvFilePath) + '/merged';
    if (!pathExists(folder)) {
      const made = window.cep.fs.makedir(folder);
      if (!made || made.err !== 0) return false;
    }
    const name = basename(path);
    let target = folder + '/' + name;
    if (pathExists(target)) target = folder + '/' + name.replace(/(\.csv)?$/i, '_' + stampForFileName() + '$1');
    const moved = window.cep.fs.rename(path, target);
    return !!moved && moved.err === 0;
  }

  function pickMergeCsv() {
    if (busy || !csvFilePath) return;
    const result = window.cep.fs.showOpenDialogEx(true, false, '統合する CSV を選択（複数選択可）', dirname(csvFilePath), ['csv']);
    if (!result || result.err !== 0 || !result.data || !result.data.length) return;
    mergeCsvFiles(result.data);
  }

  async function mergeCsvFiles(paths) {
    const messages = [];
    const sources = paths.filter(function (path) { return !samePath(path, csvFilePath); });
    if (sources.length < paths.length) messages.push('同期ファイル自身は除外しました');
    const accepted = [];
    sources.forEach(function (path) {
      try {
        const parsed = readAnyCsv(path).parsed;
        if (parsed.skippedRows && parsed.skippedRows.length) {
          messages.push(basename(path) + ': 読めない行 ' + parsed.skippedRows.join(', ') + ' 行目のため統合しませんでした');
          return;
        }
        if (parsed.warnings && parsed.warnings.length) {
          messages.push(basename(path) + ': ' + parsed.warnings.join('、') + '（統合しませんでした）');
          return;
        }
        // A CSV with its own sidecar is another target's sync file: merge it, but leave it where it is.
        accepted.push({ path: path, records: parsed.records, keepInPlace: pathExists(getSidecarPath(path)) });
      } catch (error) {
        messages.push(basename(path) + ': ' + messageOf(error) + '（統合しませんでした）');
      }
    });
    if (!accepted.length) {
      setStatus(messages.concat('統合できる CSV がありませんでした').join(' / '), 'error');
      return;
    }

    setBusy(true);
    let merged;
    try {
      // Re-read the sync file right before writing so edits made since it was loaded are kept.
      const current = TSLib.parseCsv(readText(csvFilePath));
      if (current.skippedRows && current.skippedRows.length) {
        throw new Error('同期ファイルに読めない行があります: ' + current.skippedRows.join(', ') + ' 行目');
      }
      merged = TSLib.mergeIntoSync(current.records, accepted.map(function (item) { return item.records; }));
      if (merged.added || merged.updated) atomicWrite(csvFilePath, TSLib.toCsv(merged.records));
    } catch (error) {
      setBusy(false);
      setStatus(messages.concat(messageOf(error)).join(' / '), 'error');
      return;
    }

    // Move sources only after the sync file was written (or nothing needed writing).
    accepted.forEach(function (item) {
      if (item.keepInPlace) messages.push(basename(item.path) + ' はほかで同期ファイルとして使われているため移動しませんでした');
    });
    const notMoved = accepted.filter(function (item) { return !item.keepInPlace && !moveToMergedFolder(item.path); });
    notMoved.forEach(function (item) { messages.push('統合済みですが移動できませんでした: ' + basename(item.path)); });
    setBusy(false);

    invalidatePreview();
    await loadCsvPath(csvFilePath, false);
    refreshMarkers();
    const summary = merged.added || merged.updated
      ? accepted.length + ' ファイルを統合しました' + importCounts(merged)
      : accepted.length + ' ファイルを確認しました。新しいタイムスタンプはありませんでした' +
        (merged.keptEdited ? importCounts(merged) : '');
    const moved = accepted.filter(function (item) { return !item.keepInPlace; }).length - notMoved.length;
    const mergeMessage = [summary + (moved ? '。merged へ移動しました' : '')].concat(messages).join(' / ');
    setStatus(mergeMessage, notMoved.length || messages.some(function (m) { return /統合しませんでした/.test(m); }) ? '' : 'ok');
    // Already linked: go on to sync (merging never links a target by itself).
    if (activeEntry && (merged.added || merged.updated)) await autoLinkAndSync(mergeMessage);
  }

  function numericOffset() {
    const value = userOffsetSec;
    if (!Number.isFinite(value)) throw new Error('オフセットには数値を入力してください');
    return value;
  }

  async function linkTarget() {
    const group = selectedGroup();
    if (!group || !csvFilePath) return;
    setBusy(true);
    invalidatePreview();
    try {
      const info = await callHost('ytsTargetInfo()', true);
      if (!info.hasTarget) throw new Error('シーケンス（コンポ）を開いてください');
      const sidecarPath = getSidecarPath(csvFilePath);
      const sidecar = readSidecar(sidecarPath);
      const key = targetKey(info);
      if (sidecar.targets[key] && !window.confirm('紐付けし直すと同期の履歴が消えます。続けますか？')) {
        setStatus('紐付けを中止しました', '');
        return;
      }
      const userOffset = numericOffset();
      sidecar.targets[key] = {
        host: hostApp,
        projectPath: info.projectPath || '',
        targetId: String(info.targetId || ''),
        name: info.name || '',
        stream_id: group.stream_id,
        userOffset: userOffset,
        lastSyncAt: '',
        base: {}
      };
      atomicWrite(sidecarPath, JSON.stringify(sidecar, null, 2));
      activeInfo = info;
      updateTargetDisplay(sidecar);
      setStatus((info.projectPath ? '紐付けました' : '紐付けました。未保存のプロジェクトは再識別できない場合があります'), info.projectPath ? 'ok' : '');
      await refreshMarkers();
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function showMarkerEmpty(message) {
    lastMarkerDetails = null;
    updateControls();
    thumbGeneration += 1;
    thumbnailQueue = [];
    if (activeCaptureAbort) activeCaptureAbort();
    if (markerObserver) markerObserver.disconnect();
    clearChildren(elements.markerList);
    const empty = document.createElement('div');
    empty.className = 'marker-empty';
    empty.textContent = message;
    elements.markerList.appendChild(empty);
  }

  function ensureThumbDiskCache() {
    if (thumbDiskCacheReady !== null) return thumbDiskCacheReady;
    thumbDiskCacheDir = String(cs.getSystemPath(SystemPath.USER_DATA) || '').replace(/\\/g, '/') +
      '/YatoTwitchTimestamp/thumbs';
    const parts = thumbDiskCacheDir.split('/');
    let current = '';
    try {
      parts.forEach(function (part, index) {
        if (!part) {
          if (index === 0) current = '/';
          return;
        }
        current = current && current !== '/' ? current + '/' + part : current + part;
        const result = window.cep.fs.makedir(current);
        if (result && result.err === 0) return;
      });
      const stat = window.cep.fs.stat(thumbDiskCacheDir);
      thumbDiskCacheReady = !!stat && stat.err === 0;
    } catch (error) {
      thumbDiskCacheReady = false;
    }
    return thumbDiskCacheReady;
  }

  function sourceMtime(path) {
    if (sourceMtimeCache.has(path)) return sourceMtimeCache.get(path);
    const stat = window.cep.fs.stat(path);
    const value = stat && stat.err === 0 && stat.data ? String(stat.data.mtime || '') : '';
    sourceMtimeCache.set(path, value);
    return value;
  }

  function thumbDiskPath(media) {
    if (!ensureThumbDiskCache()) return '';
    const key = TSLib.fnv1aHex(media.path + '|' + sourceMtime(media.path) + '|' + Math.round(media.t * 10));
    return thumbDiskCacheDir + '/' + key + '.jpg';
  }

  function readDiskThumbnail(media) {
    const path = thumbDiskPath(media);
    if (!path) return '';
    try {
      const result = window.cep.fs.readFile(path, window.cep.encoding.Base64);
      return result && result.err === 0 ? 'data:image/jpeg;base64,' + result.data : '';
    } catch (error) {
      return '';
    }
  }

  function writeDiskThumbnail(media, dataUrl) {
    const path = thumbDiskPath(media);
    const temporaryPath = path + '.tmp';
    const marker = 'base64,';
    const index = String(dataUrl || '').indexOf(marker);
    if (!path || index < 0) return;
    try {
      const write = window.cep.fs.writeFile(temporaryPath, dataUrl.slice(index + marker.length), window.cep.encoding.Base64);
      if (!write || write.err !== 0) {
        window.cep.fs.deleteFile(temporaryPath);
        return;
      }
      let rename = window.cep.fs.rename(temporaryPath, path);
      if (!rename || rename.err !== 0) {
        window.cep.fs.deleteFile(path);
        rename = window.cep.fs.rename(temporaryPath, path);
      }
      if (!rename || rename.err !== 0) window.cep.fs.deleteFile(temporaryPath);
    } catch (error) {}
  }

  function applyThumbnail(row, dataUrl, media, key, fromCache) {
    if (!row.isConnected) return;
    const thumb = row.querySelector('.thumb');
    const img = row.querySelector('.thumb img');
    const empty = row.querySelector('.thumb-empty');
    thumb.classList.remove('loading');
    img.onerror = null;
    if (dataUrl) {
      img.onerror = function () {
        img.onerror = null;
        if (!fromCache || !row.isConnected) {
          if (!fromCache && key) thumbFailed.add(key);
          applyThumbnail(row, null, media, key, false);
          return;
        }
        thumbCache.delete(key);
        const diskPath = thumbDiskPath(media);
        if (diskPath) {
          try { window.cep.fs.deleteFile(diskPath); } catch (deleteError) {}
        }
        if (!row._ytsThumbRetried) {
          row._ytsThumbRetried = true;
          thumb.classList.add('loading');
          thumbnailQueue.push({ row: row, media: media, key: key, generation: thumbGeneration });
          processThumbnailQueue();
        } else {
          applyThumbnail(row, null, media, key, false);
        }
      };
      img.src = dataUrl;
      img.hidden = false;
      empty.hidden = true;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      empty.hidden = false;
    }
  }

  function captureThumbnail(media) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const cleanups = [];
      const timer = setTimeout(function () { finish(new Error('サムネイルの読み込みがタイムアウトしました')); }, 20000);

      activeCaptureAbort = function () {
        const error = new Error('cancelled');
        error.cancelled = true;
        finish(error);
      };

      function cleanup() {
        clearTimeout(timer);
        while (cleanups.length) cleanups.pop()();
      }

      function finish(error, dataUrl) {
        if (settled) return;
        settled = true;
        cleanup();
        activeCaptureAbort = null;
        if (error) {
          currentVideoPath = '';
          reject(error);
        } else {
          resolve(dataUrl);
        }
      }

      function waitFor(eventName, next) {
        function onReady() {
          remove();
          next();
        }
        function onError() {
          remove();
          finish(new Error('動画を読み込めませんでした'));
        }
        function remove() {
          thumbnailVideo.removeEventListener(eventName, onReady);
          thumbnailVideo.removeEventListener('error', onError);
        }
        thumbnailVideo.addEventListener(eventName, onReady);
        thumbnailVideo.addEventListener('error', onError);
        cleanups.push(remove);
      }

      function draw() {
        try {
          if (!thumbnailVideo.videoWidth) throw new Error('動画サイズを取得できませんでした');
          thumbnailCanvas.width = 320;
          thumbnailCanvas.height = Math.round(320 * thumbnailVideo.videoHeight / thumbnailVideo.videoWidth);
          const context = thumbnailCanvas.getContext('2d');
          context.drawImage(thumbnailVideo, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
          finish(null, thumbnailCanvas.toDataURL('image/jpeg', 0.7));
        } catch (error) {
          finish(error);
        }
      }

      function seek() {
        const duration = thumbnailVideo.duration || media.t;
        const target = Math.max(0, Math.min(media.t, duration - 0.05));
        if (Math.abs(thumbnailVideo.currentTime - target) < 0.001 && thumbnailVideo.readyState >= 2) {
          draw();
          return;
        }
        waitFor('seeked', draw);
        try {
          thumbnailVideo.currentTime = target;
        } catch (error) {
          finish(error);
        }
      }

      const normalizedPath = String(media.path).replace(/\\/g, '/').replace(/^\/+/, '');
      // encodeURI leaves # and ? untouched, so encode them explicitly for file URLs.
      const url = 'file:///' + encodeURI(normalizedPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
      if (currentVideoPath !== media.path) {
        currentVideoPath = media.path;
        waitFor('loadedmetadata', seek);
        thumbnailVideo.src = url;
        thumbnailVideo.load();
      } else {
        seek();
      }
    });
  }

  function processThumbnailQueue() {
    if (thumbnailProcessing || !thumbnailQueue.length) return;
    const task = thumbnailQueue.shift();
    if (!task.row.isConnected || task.generation !== thumbGeneration) {
      processThumbnailQueue();
      return;
    }
    thumbnailProcessing = true;
    captureThumbnail(task.media).then(function (dataUrl) {
      thumbCache.set(task.key, dataUrl);
      writeDiskThumbnail(task.media, dataUrl);
      if (task.generation === thumbGeneration) {
        applyThumbnail(task.row, dataUrl, task.media, task.key, false);
      }
    }).catch(function (error) {
      if (!error || !error.cancelled) thumbFailed.add(task.key);
      if (task.generation === thumbGeneration) {
        applyThumbnail(task.row, null, task.media, task.key, false);
      }
    }).then(function () {
      thumbnailProcessing = false;
      processThumbnailQueue();
    });
  }

  function queueThumbnail(row, media) {
    if (!media) {
      applyThumbnail(row, null, null, '', false);
      return;
    }
    const key = media.path + '|' + Math.round(media.t * 10);
    if (thumbFailed.has(key)) {
      applyThumbnail(row, null, media, key, false);
      return;
    }
    if (thumbCache.has(key)) {
      applyThumbnail(row, thumbCache.get(key), media, key, true);
      return;
    }
    const diskData = readDiskThumbnail(media);
    if (diskData) {
      thumbCache.set(key, diskData);
      applyThumbnail(row, diskData, media, key, true);
      return;
    }
    row.querySelector('.thumb').classList.add('loading');
    thumbnailQueue.push({ row: row, media: media, key: key, generation: thumbGeneration });
    processThumbnailQueue();
  }

  function editMarkerInline(button, marker, field, renderedTargetId) {
    if (busy || markerEditBusy || !button.parentNode) return;
    const originalValue = String(marker[field] || '');
    const input = document.createElement('textarea');
    const rect = button.getBoundingClientRect();
    const minimumHeight = Math.max(1, Math.round(rect.height));
    let finished = false;
    input.className = 'inline-input';
    input.rows = 1;
    input.value = originalValue;
    input.style.width = Math.max(120, Math.round(rect.width)) + 'px';
    input.style.minHeight = minimumHeight + 'px';
    button.parentNode.replaceChild(input, button);

    function resizeInput() {
      input.style.height = 'auto';
      input.style.height = Math.max(minimumHeight, input.scrollHeight) + 'px';
    }

    resizeInput();
    input.focus();
    input.select();

    function restore() {
      if (input.parentNode) input.parentNode.replaceChild(button, input);
    }

    function finish(cancelled) {
      if (finished) return;
      finished = true;
      const value = input.value;
      if (cancelled || value === originalValue) {
        restore();
        return;
      }
      if (previewState || !elements.previewDrawer.hidden) invalidatePreview();
      markerEditBusy = true;
      updateControls();
      const payload = {
        index: marker.index,
        t: marker.t,
        id: marker.id,
        targetId: renderedTargetId,
        origName: String(marker.name || '')
      };
      payload[field] = value;
      callHost('ytsEditMarker(' + hostLiteral(payload) + ')', true).catch(function (error) {
        setStatus(messageOf(error), 'error');
      }).then(function () {
        return refreshMarkers();
      }).then(function () {
        markerEditBusy = false;
        updateControls();
      });
    }

    input.addEventListener('blur', function () { finish(false); });
    input.addEventListener('input', resizeInput);
    ['keydown', 'keyup', 'keypress'].forEach(function (eventName) {
      input.addEventListener(eventName, function (event) {
        event.stopPropagation();
        if (eventName !== 'keydown') return;
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          finish(false);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(true);
        }
      });
    });
  }

  function deleteMarker(button, marker, renderedTargetId) {
    if (busy || markerEditBusy) return;
    if (!button.classList.contains('confirm')) {
      button._ytsConfirmAt = Date.now();
      button.classList.add('confirm');
      button.textContent = '削除?';
      button.setAttribute('aria-label', 'もう一度押すと削除');
      button.title = 'もう一度押すと削除';
      button._ytsConfirmTimer = setTimeout(function () {
        if (!button.isConnected) return;
        button.classList.remove('confirm');
        button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8h5.8l.6-8M6.5 6.5v4M9.5 6.5v4"></path></svg>';
        button.setAttribute('aria-label', '削除');
        button.title = '削除';
      }, 3000);
      return;
    }
    if (Date.now() - button._ytsConfirmAt < 300) return;
    clearTimeout(button._ytsConfirmTimer);
    if (previewState || !elements.previewDrawer.hidden) invalidatePreview();
    markerEditBusy = true;
    updateControls();
    callHost('ytsDeleteMarker(' + hostLiteral({
      index: marker.index,
      t: marker.t,
      id: marker.id,
      targetId: renderedTargetId,
      origName: String(marker.name || '')
    }) + ')', true)
      .catch(function (error) { setStatus(messageOf(error), 'error'); })
      .then(function () { return refreshMarkers(); })
      .then(function () {
        markerEditBusy = false;
        updateControls();
      });
  }

  function renderMarkers(details) {
    const previousScrollTop = elements.markerList.scrollTop;
    const renderedTargetId = activeInfo && activeInfo.targetId ? String(activeInfo.targetId) : '';
    thumbGeneration += 1;
    thumbnailQueue = [];
    if (activeCaptureAbort) activeCaptureAbort();
    if (markerObserver) markerObserver.disconnect();
    clearChildren(elements.markerList);
    const markers = Array.isArray(details.markers) ? details.markers : [];
    if (!markers.length) {
      showMarkerEmpty('マーカーがありません');
      return;
    }
    lastMarkerDetails = { fps: details.fps, markers: markers };
    updateControls();
    markerObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        markerObserver.unobserve(entry.target);
        queueThumbnail(entry.target, entry.target._ytsMedia);
      });
    }, { root: elements.markerList, rootMargin: '100px' });

    markers.forEach(function (marker) {
      const row = document.createElement('div');
      const thumb = document.createElement('div');
      const img = document.createElement('img');
      const thumbEmpty = document.createElement('span');
      const thumbLoading = document.createElement('span');
      const body = document.createElement('div');
      const line1 = document.createElement('div');
      const tc = document.createElement('button');
      const name = document.createElement('button');
      const line2 = document.createElement('div');
      const comment = document.createElement('button');
      const markerBy = document.createElement('span');
      const deleteButton = document.createElement('button');
      const frameButton = document.createElement('button');
      const timecode = TSLib.formatTimecodeFrames(marker.t, details.fps);
      const record = marker.id ? csvById.get(marker.id) : null;
      const by = marker.by || (record ? record.by : '') || '';
      const seekKey = marker.index + '|' + marker.t;

      row.className = 'marker-row' + (seekKey === lastSeekKey ? ' active' : '');
      row._ytsMedia = marker.media || null;
      thumb.className = 'thumb';
      img.alt = '';
      img.hidden = true;
      thumbEmpty.className = 'thumb-empty';
      thumbEmpty.textContent = 'プレビューなし';
      thumbEmpty.hidden = true;
      thumbLoading.className = 'thumb-loading';
      thumbLoading.textContent = '読み込み中';
      body.className = 'marker-body';
      line1.className = 'marker-line1';
      tc.type = 'button';
      tc.className = 'tc';
      tc.textContent = timecode;
      tc.setAttribute('aria-label', timecode + ' へ移動');
      name.type = 'button';
      name.className = 'inline-edit marker-name' + (marker.name ? '' : ' empty');
      name.textContent = marker.name || '（名前なし）';
      name.title = marker.name || '（名前なし）';
      line2.className = 'marker-line2';
      comment.type = 'button';
      comment.className = 'inline-edit marker-comment' + (marker.comment ? '' : ' placeholder');
      comment.textContent = marker.comment || 'コメントを追加';
      comment.title = marker.comment || 'コメントを追加';
      markerBy.className = 'marker-by';
      markerBy.textContent = by ? '/ ' + by : '';
      deleteButton.type = 'button';
      deleteButton.className = 'icon-button marker-delete';
      deleteButton.setAttribute('aria-label', '削除');
      deleteButton.title = '削除';
      deleteButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8h5.8l.6-8M6.5 6.5v4M9.5 6.5v4"></path></svg>';
      frameButton.type = 'button';
      frameButton.className = 'icon-button marker-frame';
      frameButton.setAttribute('aria-label', '画像を書き出す');
      frameButton.title = '画像を書き出す（前回選んだ保存先へ）';
      frameButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"></rect><circle cx="6" cy="6.5" r="1.2"></circle><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 2.5"></path></svg>';
      frameButton.addEventListener('click', function () { exportOneFrame(marker, details.fps); });
      tc.addEventListener('click', function () {
        lastSeekKey = seekKey;
        const rows = elements.markerList.querySelectorAll('.marker-row');
        for (let i = 0; i < rows.length; i += 1) rows[i].classList.remove('active');
        row.classList.add('active');
        callHost('ytsSeek(' + hostLiteral(marker.t) + ')', false).catch(function (error) {
          setStatus(messageOf(error), 'error');
        });
      });
      name.addEventListener('click', function () { editMarkerInline(name, marker, 'name', renderedTargetId); });
      if (hostApp === 'PPRO') {
        comment.addEventListener('click', function () { editMarkerInline(comment, marker, 'comment', renderedTargetId); });
      }
      deleteButton.addEventListener('click', function () { deleteMarker(deleteButton, marker, renderedTargetId); });
      thumb.appendChild(img);
      thumb.appendChild(thumbEmpty);
      thumb.appendChild(thumbLoading);
      line1.appendChild(tc);
      line1.appendChild(name);
      body.appendChild(line1);
      if (hostApp === 'PPRO') line2.appendChild(comment);
      if (by) line2.appendChild(markerBy);
      if (hostApp === 'PPRO' || by) body.appendChild(line2);
      row.appendChild(thumb);
      row.appendChild(body);
      row.appendChild(frameButton);
      row.appendChild(deleteButton);
      elements.markerList.appendChild(row);
      if (!marker.media) applyThumbnail(row, null, null, '', false);
      else {
        const cacheKey = marker.media.path + '|' + Math.round(marker.media.t * 10);
        if (thumbFailed.has(cacheKey)) applyThumbnail(row, null, marker.media, cacheKey, false);
        else if (thumbCache.has(cacheKey)) applyThumbnail(row, thumbCache.get(cacheKey), marker.media, cacheKey, true);
        else {
          thumb.classList.add('loading');
          markerObserver.observe(row);
        }
      }
    });
    elements.markerList.scrollTop = previousScrollTop;
  }

  async function refreshMarkers() {
    const token = ++markerRequestToken;
    if (!activeInfo || !activeInfo.hasTarget) {
      showMarkerEmpty('シーケンス（コンポ）を開いてください');
      return;
    }
    try {
      const details = await callHost('ytsMarkerDetails()', true);
      if (token !== markerRequestToken) return;
      renderMarkers(details);
    } catch (error) {
      if (token !== markerRequestToken) return;
      setStatus(messageOf(error), 'error');
      showMarkerEmpty('マーカーを取得できませんでした');
    }
  }

  function changeCounts(plan) {
    let appCount = 0;
    let csvCount = 0;
    let conflictCount = 0;
    plan.preview.forEach(function (row) {
      if (row.kind === 'conflict') conflictCount += 1;
      if (row.kind === 'add-app' || row.kind === 'delete-app' ||
          ((row.kind === 'move' || row.kind === 'memo' || row.kind === 'conflict') && row.source === 'csv')) appCount += 1;
      if (row.kind === 'add-csv' || row.kind === 'delete-csv' ||
          ((row.kind === 'move' || row.kind === 'memo' || row.kind === 'conflict') && row.source === 'app')) csvCount += 1;
    });
    return { app: appCount, csv: csvCount, conflicts: conflictCount };
  }

  function timeText(row) {
    const format = function (value) {
      return value && Number.isFinite(Number(value.t)) ? TSLib.formatTimecode(Math.floor(Number(value.t))) : '—';
    };
    if (row.kind === 'move' || row.kind === 'conflict') return format(row.from) + ' → ' + format(row.to);
    return format(row.to || row.from);
  }

  function memoText(row) {
    const memo = function (value) {
      return value && value.memo ? String(value.memo) : '（メモなし）';
    };
    if (row.from && row.to && String(row.from.memo || '') !== String(row.to.memo || '')) {
      return memo(row.from) + ' → ' + memo(row.to);
    }
    return memo(row.to || row.from);
  }

  function rerunPlan() {
    const state = previewState;
    state.plan = TSLib.syncPlan({
      records: state.parsedRecords,
      streamId: state.entry.stream_id,
      target: state.entry.lastSyncAt ? state.entry : null,
      userOffset: state.userOffset,
      appMarkers: state.appMarkers,
      fps: state.fps,
      now: state.now,
      choices: choices,
      addUntagged: state.addUntagged,
      hostName: newRecordBy(state.path),
      streamTemplate: newRecordStream(state.path)
    });
    renderPreview();
  }

  function renderPreview() {
    clearChildren(elements.previewList);
    elements.warnings.textContent = '';
    elements.confirmDelete.checked = false;
    elements.confirmDeleteRow.hidden = true;
    if (!previewState) return;
    const plan = previewState.plan;
    const warningLines = [];
    (previewState.parsedWarnings || []).forEach(function (warning) { warningLines.push(String(warning)); });
    (plan.warnings || []).forEach(function (warning) { warningLines.push(String(warning)); });
    elements.warnings.textContent = warningLines.join('\n');
    if (plan.needsConfirm) {
      elements.confirmDeleteRow.hidden = false;
      elements.confirmDeleteRow.querySelector('span').textContent =
        '大量削除を確認しました（削除 ' + Number(plan.deleteCount || 0) + ' 件）';
    }
    if (plan.error) {
      setStatus(String(plan.error), 'error');
      updateControls();
      return;
    }
    const labels = {
      'add-app': 'アプリに追加', 'add-csv': 'CSV に追加', move: '移動', memo: 'メモ変更',
      'delete-app': 'アプリから削除', 'delete-csv': 'CSV から削除', conflict: '競合'
    };
    const counts = changeCounts(plan);
    const summary = document.createElement('div');
    summary.className = 'preview-summary';
    summary.textContent = 'アプリ: ' + counts.app + ' 件 / CSV: ' + counts.csv + ' 件 / 競合: ' + counts.conflicts + ' 件';
    elements.previewList.appendChild(summary);
    if (!plan.preview.length) {
      const empty = document.createElement('div');
      empty.className = 'preview-empty';
      empty.textContent = '変更はありません';
      elements.previewList.appendChild(empty);
    }
    plan.preview.forEach(function (row) {
      const item = document.createElement('div');
      const kind = document.createElement('div');
      const time = document.createElement('div');
      const memo = document.createElement('div');
      const typeClass = row.kind === 'conflict' ? ' conflict' :
        (row.kind.indexOf('add-') === 0 ? ' add' : (row.kind.indexOf('delete-') === 0 ? ' delete' : ''));
      item.className = 'preview-row' + typeClass;
      kind.className = 'preview-kind';
      kind.textContent = labels[row.kind] || row.kind;
      time.className = 'preview-time';
      time.textContent = timeText(row);
      memo.className = 'preview-memo';
      memo.textContent = memoText(row);
      item.appendChild(kind);
      item.appendChild(time);
      item.appendChild(memo);
      if (row.kind === 'conflict') {
        const select = document.createElement('select');
        select.className = 'conflict-select';
        [['app', 'アプリ優先'], ['csv', 'CSV優先']].forEach(function (pair) {
          const option = document.createElement('option');
          option.value = pair[0];
          option.textContent = pair[1];
          select.appendChild(option);
        });
        select.value = choices[row.id] || row.source;
        select.addEventListener('change', function () {
          choices[row.id] = select.value;
          rerunPlan();
        });
        item.appendChild(select);
      }
      elements.previewList.appendChild(item);
    });
    updateControls();
  }

  function openDrawer() {
    elements.previewDrawer.hidden = false;
    renderPreview();
  }

  async function computePreview() {
    const group = selectedGroup();
    if (!csvFilePath || !group) throw new Error('CSV と配信を選択してください');
    const info = await callHost('ytsTargetInfo()', true);
    if (!info.hasTarget) throw new Error(missingTargetText());
    const key = targetKey(info);
    const sidecar = readSidecar(getSidecarPath(csvFilePath));
    const entry = sidecar.targets[key];
    if (!entry) throw new Error('アクティブな' + targetNoun() + 'が紐付けられていません。先に紐付けてください');
    const mtime = mtimeToken(csvFilePath);
    const csvText = readText(csvFilePath);
    const parsed = TSLib.parseCsv(csvText);
    if (Number(parsed.skipped) > 0) {
      throw new Error('読めない行があります: ' + parsed.skippedRows.join(', ') + ' 行目（offset_sec / timecode を確認してください）');
    }
    const appMarkers = await callHost('ytsListMarkers()', true);
    const userOffset = numericOffset();
    const now = new Date().toISOString();
    choices = {};
    previewState = {
      path: csvFilePath,
      mtime: mtime,
      info: info,
      key: key,
      entry: entry,
      parsedRecords: parsed.records,
      csvText: csvText,
      snapshotRecords: parsed.records,
      repaired: Number(parsed.repaired) || 0,
      parsedWarnings: parsed.warnings || [],
      appMarkers: appMarkers,
      fps: Number(info.fps) || 0,
      userOffset: userOffset,
      now: now,
      addUntagged: elements.addUntagged.checked,
      plan: null
    };
    previewState.plan = TSLib.syncPlan({
      records: previewState.parsedRecords,
      streamId: previewState.entry.stream_id,
      target: previewState.entry.lastSyncAt ? previewState.entry : null,
      userOffset: previewState.userOffset,
      appMarkers: previewState.appMarkers,
      fps: previewState.fps,
      now: previewState.now,
      choices: choices,
      addUntagged: previewState.addUntagged,
      hostName: newRecordBy(previewState.path),
      streamTemplate: newRecordStream(previewState.path)
    });
    return previewState;
  }

  async function runExecute() {
    if (!previewState) return;
    const state = previewState;
      let csvTextChangedSincePreview = false;
      let currentCsvText = readText(state.path);
      const currentMtime = mtimeToken(state.path);
      if (currentCsvText !== state.csvText || currentMtime !== state.mtime) {
        csvTextChangedSincePreview = currentCsvText !== state.csvText;
        const freshParsed = TSLib.parseCsv(currentCsvText);
        if (Number(freshParsed.skipped) > 0) {
          throw new Error('読めない行があります: ' + freshParsed.skippedRows.join(', ') + ' 行目（offset_sec / timecode を確認してください）');
        }
        const freshMerge = TSLib.mergeFresh({
          snapshot: state.snapshotRecords,
          planned: state.plan.records,
          fresh: freshParsed.records
        });
        if (freshMerge.conflicts.length) {
          const error = new Error('確認後に CSV が更新されました。同期を押し直してください');
          error.stale = true;
          throw error;
        }
      }
      const info = await callHost('ytsTargetInfo()', true);
      if (!info.hasTarget || targetKey(info) !== state.key) {
        const error = new Error('紐付け先が変わりました。同期を押し直してください');
        error.stale = true;
        throw error;
      }
      const currentMarkers = await callHost('ytsListMarkers()', true);
      if (!TSLib.sameMarkers(state.appMarkers, currentMarkers, state.fps)) {
        const error = new Error('確認後にマーカーが変更されました。同期を押し直してください');
        error.stale = true;
        throw error;
      }
      let applyResult = { applied: 0, failed: [], nudged: [] };
      if (state.plan.appOps.length) {
        applyResult = await callHost('ytsApply(' + hostLiteral(state.plan.appOps) + ')', true);
      }
      const failed = Array.isArray(applyResult.failed) ? applyResult.failed : [];
      const nudged = Array.isArray(applyResult.nudged) ? applyResult.nudged : [];
      let records = TSLib.finalizeRecords(state.plan, failed);
      records = TSLib.applyNudges(records, nudged, state.userOffset, state.now);

      currentCsvText = readText(state.path);
      if (currentCsvText !== state.csvText) {
        csvTextChangedSincePreview = true;
        const latestParsed = TSLib.parseCsv(currentCsvText);
        if (Number(latestParsed.skipped) > 0) {
          throw new Error('読めない行があります: ' + latestParsed.skippedRows.join(', ') + ' 行目（offset_sec / timecode を確認してください）');
        }
        const latestMerge = TSLib.mergeFresh({
          snapshot: state.snapshotRecords,
          planned: records,
          fresh: latestParsed.records
        });
        if (latestMerge.conflicts.length) {
          throw new Error('確認後に CSV が更新されました。同期を押し直してください（アプリ側の変更は適用済みです）');
        }
        records = latestMerge.records;
      }
      if (state.plan.csvChanged || state.repaired > 0 || failed.length || nudged.length || csvTextChangedSincePreview) {
        atomicWrite(state.path, TSLib.toCsv(records));
      }
      let nextBase;
      let relistWarning = '';
      try {
        const relisted = await callHost('ytsListMarkers()', true);
        nextBase = TSLib.baseFromMarkers({
          appMarkers: relisted,
          records: records,
          streamId: state.entry.stream_id,
          userOffset: state.userOffset,
          excludeIds: failed,
          previousBase: state.entry.base || {}
        });
      } catch (relistError) {
        nextBase = {};
        Object.keys(state.plan.base || {}).forEach(function (id) { nextBase[id] = state.plan.base[id]; });
        failed.forEach(function (id) { delete nextBase[id]; });
        relistWarning = '（マーカー再取得に失敗したため予定値で保存）';
      }

      const sidecarPath = getSidecarPath(state.path);
      const sidecar = readSidecar(sidecarPath);
      const current = sidecar.targets[state.key] || state.entry;
      sidecar.targets[state.key] = {
        host: hostApp,
        projectPath: info.projectPath || '',
        targetId: String(info.targetId || ''),
        name: info.name || '',
        stream_id: current.stream_id,
        userOffset: state.userOffset,
        lastSyncAt: state.now,
        base: nextBase
      };
      atomicWrite(sidecarPath, JSON.stringify(sidecar, null, 2));
      csvById = new Map();
      records.forEach(function (record) {
        if (record.id) csvById.set(record.id, record);
      });
      // サーバーの鏡なら、書き戻した CSV の変更をサーバーへ送る（失敗しても同期自体は済んでいる）
      // For a server mirror, send the written-back CSV's changes to the server (a failure does not undo the sync).
      const pushed = isServerMirror(state.path) ? await pushFromMirror(state.path) : { note: '', failed: false };
      const counts = changeCounts(state.plan);
      const successMessage = state.plan.preview.length === 0 ? '変更はありません' :
        '同期しました（アプリ ' + Number(applyResult.applied || 0) + ' / CSV ' + counts.csv +
        (failed.length ? ' / 失敗 ' + failed.length + ' 件' : '') +
        (nudged.length ? ' / 位置調整 ' + nudged.length + ' 件' : '') + '）' + relistWarning;
      const serverNotes = [serverSyncNote, pushed.note].filter(Boolean);
      serverSyncNote = '';
      setStatus([successMessage].concat(serverNotes).join(' / '), pushed.failed ? 'error' : 'ok');
      previewState = null;
      choices = {};
      elements.warnings.textContent = '';
      elements.confirmDelete.checked = false;
      elements.confirmDeleteRow.hidden = true;
      clearChildren(elements.previewList);
      elements.previewDrawer.hidden = true;
      activeInfo = info;
      updateTargetDisplay(sidecar);
      await refreshMarkers();
  }

  // afterImport: called right after a CSV pick / conversion / merge; then anything but additions asks first.
  // options.skipConfirm: 理由が「初回の同期」「アプリへの追加が多い」だけなら引き出しを出さずに同期する（取り込みで作ったばかりの Sequence 用）
  // options.skipConfirm: sync without the drawer when the only reasons are 初回の同期 / アプリへの追加が多い (for a sequence the import just created).
  const SKIPPABLE_CONFIRM_REASONS = ['初回の同期', 'アプリへの追加が多い'];
  async function syncNow(afterImport, options) {
    const skipConfirm = !!(options && options.skipConfirm);
    // Drop any earlier preview so a failed recompute never leaves a stale drawer executable.
    invalidatePreview();
    setBusy(true);
    try {
      // サーバーの鏡は先にサーバーの変更を取り込む。取り込めなければ同期しない（手元だけで同期すると衝突の判断が狂う）
      // A server mirror first takes in the server's changes; without them the sync stops (a local-only sync would misjudge conflicts).
      serverSyncNote = '';
      if (isServerMirror(csvFilePath) && !(await pullIntoMirror(csvFilePath))) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = await computePreview();
        const plan = state.plan;
        const reasons = TSLib.syncConfirmReasons({
          plan: state.plan,
          entry: state.entry,
          parsedWarnings: state.parsedWarnings,
          repaired: state.repaired,
          afterImport: afterImport === true
        });
        const confirmSkipped = skipConfirm && !plan.error &&
          reasons.every(function (reason) { return SKIPPABLE_CONFIRM_REASONS.indexOf(reason) >= 0; });
        if (reasons.length > 0 && !confirmSkipped) {
          openDrawer();
          setStatus(plan.error ? String(plan.error) : '同期内容を確認してください（' + reasons.join('、') + '）',
            plan.error ? 'error' : 'ok');
          return;
        }
        try {
          await runExecute();
          return;
        } catch (error) {
          if (!error.stale) throw error;
          if (attempt === 0) continue;
          try {
            await computePreview();
            openDrawer();
            setStatus(messageOf(error), 'error');
          } catch (recomputeError) {
            setStatus(messageOf(recomputeError), 'error');
          }
          return;
        }
      }
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function executeFromDrawer() {
    if (!previewState) return;
    setBusy(true);
    try {
      await runExecute();
    } catch (error) {
      if (error.stale) {
        try {
          await computePreview();
          openDrawer();
          setStatus('確認後に内容が変わったため、確認内容を更新しました。確認してから同期してください', 'error');
        } catch (recomputeError) {
          invalidatePreview();
          setStatus(messageOf(recomputeError), 'error');
        }
      } else {
        setStatus(messageOf(error), 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function addMarker() {
    if (busy || markerEditBusy || !activeInfo || !activeInfo.hasTarget) return;
    if (previewState || !elements.previewDrawer.hidden) invalidatePreview();
    markerEditBusy = true;
    updateControls();
    try {
      await callHost('ytsAddMarker(' + hostLiteral({
        id: TSLib.newId(),
        by: newRecordBy(csvFilePath),
        targetId: String(activeInfo.targetId || '')
      }) + ')', true);
      setStatus('マーカーを追加しました', 'ok');
      await refreshMarkers();
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      markerEditBusy = false;
      updateControls();
    }
  }

  // ---- 同期元「サーバー」: 設定・配信ピッカー・鏡 CSV --------------------------
  // ---- "server" sync source: settings, stream picker, mirror CSV ---------------

  // 鏡 CSV の置き場の根（USER_DATA/yato-twitch-timestamp） / Root folder of mirror CSVs (USER_DATA/yato-twitch-timestamp)
  function serverBaseDir() {
    return String(cs.getSystemPath(SystemPath.USER_DATA) || '').replace(/\\/g, '/') + '/yato-twitch-timestamp';
  }

  // フォルダを 1 段ずつ作る（ensureThumbDiskCache と同じ手順） / Creates a folder level by level (same steps as ensureThumbDiskCache)
  function makeDirs(dir) {
    const parts = String(dir || '').replace(/\\/g, '/').split('/');
    let current = '';
    parts.forEach(function (part, index) {
      if (!part) {
        if (index === 0) current = '/';
        return;
      }
      current = current && current !== '/' ? current + '/' + part : current + part;
      window.cep.fs.makedir(current);
    });
    if (!pathExists(dir)) throw new Error('鏡 CSV のフォルダを作れませんでした: ' + dir);
  }

  // 鏡 CSV の横の <stream_id>.server.json / The <stream_id>.server.json next to a mirror CSV
  function serverMetaPath(csvPath) {
    return String(csvPath || '').replace(/_sync\.csv$/i, '').replace(/\.csv$/i, '') + '.server.json';
  }

  // meta が読めて形が正しければ返す。無い・壊れていれば null / Returns the meta when readable and well-formed; null otherwise
  function readServerMeta(csvPath) {
    const metaPath = serverMetaPath(csvPath);
    if (!csvPath || !pathExists(metaPath)) return null;
    try {
      const meta = JSON.parse(readText(metaPath));
      return TSLib.isServerMeta(meta) ? meta : null;
    } catch (error) {
      return null;
    }
  }

  function writeServerMeta(csvPath, meta) {
    atomicWrite(serverMetaPath(csvPath), JSON.stringify(meta, null, 2) + '\n');
    serverMirrorCache = { path: null, value: false };
  }

  // 開いている CSV がサーバーの鏡か（パスごとに 1 度だけ確かめる） / Whether a CSV is a server mirror (checked once per path)
  function isServerMirror(csvPath) {
    if (!csvPath) return false;
    if (serverMirrorCache.path !== csvPath) serverMirrorCache = { path: csvPath, value: !!readServerMeta(csvPath) };
    return serverMirrorCache.value;
  }

  // 新しく作る記録の by。サーバーの鏡なら接続した人の login、それ以外はアプリ名
  // The `by` of newly created records: the connected login for a server mirror, the app name otherwise.
  function newRecordBy(csvPath) {
    const meta = isServerMirror(csvPath) ? readServerMeta(csvPath) : null;
    return (meta && meta.me) || (hostApp === 'PPRO' ? 'premiere' : 'ae');
  }

  // 新しく作る記録の channel / started_at の補い。鏡なら meta の値（CSV にこの配信の行が無いときだけ syncPlan が使う）
  // Fallback channel / started_at for new records: the meta's for a mirror (syncPlan uses it only when the CSV has no rows of the stream).
  function newRecordStream(csvPath) {
    const meta = isServerMirror(csvPath) ? readServerMeta(csvPath) : null;
    return meta ? { channel: meta.channel, started_at: meta.started_at || '' } : null;
  }

  // 記録が 0 件の鏡でも配信を選べるよう、meta から groupByStream と同じ形の空のグループを作る
  // Builds an empty group shaped like groupByStream's from the meta, so a mirror with zero records can still be selected.
  function emptyMirrorGroup(csvPath) {
    const meta = readServerMeta(csvPath);
    return meta ? { stream_id: meta.stream_id, channel: meta.channel, started_at: meta.started_at || '', records: [], allRecords: [] } : null;
  }

  // 鏡 CSV と今のサーバー設定が同じサーバーか（別のサーバーへ同じ stream_id を送らない）
  // Whether the mirror CSV and the current server settings point at the same server (never send a stream_id to another server).
  function assertMirrorServer(meta) {
    const settings = YTSServer.loadSettings();
    if (settings.serverUrl && settings.serverUrl !== meta.serverUrl) {
      throw new Error('この鏡 CSV は別のサーバー（' + meta.serverUrl + '）のものです。「サーバー」で接続し直してください');
    }
  }

  // 同期の前にサーバーの記録を鏡 CSV へ取り込む。失敗したら状態欄に出して false（同期を中止する）
  // Before a sync, merges the server's records into the mirror CSV. On failure shows it and returns false (the sync stops).
  async function pullIntoMirror(csvPath) {
    try {
      const meta = readServerMeta(csvPath);
      if (!meta) throw new Error('鏡 CSV の情報（.server.json）を読めません');
      assertMirrorServer(meta);
      const serverRecords = await YTSServer.pullStamps(meta.stream_id);
      const parsed = TSLib.parseCsv(readText(csvPath));
      if (Number(parsed.skipped) > 0) {
        throw new Error('読めない行があります: ' + parsed.skippedRows.join(', ') + ' 行目（offset_sec / timecode を確認してください）');
      }
      // 直前の push で forbidden_tombstone だった id は、サーバーの生存記録で戻す / Ids rejected as forbidden_tombstone come back from the server
      const forceIds = Array.isArray(meta.forcePull) ? meta.forcePull : [];
      const merged = TSLib.mergeServerRecords(parsed.records, serverRecords, { forceIds: forceIds });
      if (merged.changed > 0) atomicWrite(csvPath, TSLib.toCsv(merged.records));
      serverPulled = {
        path: csvPath,
        byId: new Map(serverRecords.map(function (record) {
          const normalized = TSLib.normalizeRecord(record);
          return [normalized.id, normalized.updated_at];
        }))
      };
      const nextMeta = Object.assign({}, meta, { lastPullAt: new Date().toISOString() });
      delete nextMeta.forcePull;
      writeServerMeta(csvPath, nextMeta);
      if (merged.changed > 0) {
        serverSyncNote = 'サーバーから ' + merged.changed + ' 件取り込み';
        setStatus(serverSyncNote, 'ok');
      }
      return true;
    } catch (error) {
      setStatus('サーバーから取り込めないため同期を中止しました: ' + messageOf(error), 'error');
      return false;
    }
  }

  // 同期の後に、前回の push より後に変わった記録をサーバーへ送る。返り値 {note, failed} は完了メッセージに添える
  // lastPushAt は push の開始時刻（送信中の編集を次回に回す）。throw したら進めない（次回まとめて送り直す）
  // After a sync, sends records changed since the last push. The returned {note, failed} goes into the completion message.
  // lastPushAt becomes the push start time (edits made during the push go next time); it stays put after a throw (all resent next time).
  async function pushFromMirror(csvPath) {
    const startedAt = new Date().toISOString();
    let meta = readServerMeta(csvPath);
    if (!meta) return { note: '', failed: false };
    let result = null;
    let pushError = null;
    try {
      assertMirrorServer(meta);
      // 直前の pull でサーバーにあったものと同じ記録は送らない（他人の墓標を送り返して拒否されないように）
      // Records identical to what the last pull returned are not sent back (so others' tombstones are not bounced as rejections).
      const pulled = serverPulled.path === csvPath ? serverPulled.byId : new Map();
      const toPush = TSLib.recordsToPush(TSLib.parseCsv(readText(csvPath)).records, meta.lastPushAt)
        .filter(function (record) { return pulled.get(record.id) !== record.updated_at; });
      if (!toPush.length) return { note: '', failed: false };
      result = await YTSServer.pushStamps(toPush);
    } catch (error) {
      pushError = error;
      result = error && error.partial ? error.partial : null;
    }
    const sorted = TSLib.applyPanelPushResult(result);
    meta = readServerMeta(csvPath) || meta;
    const nextMeta = Object.assign({}, meta, { lastPushAt: TSLib.nextPushAt(pushError || result, startedAt, meta.lastPushAt) });
    const forcePull = Array.from(new Set((Array.isArray(meta.forcePull) ? meta.forcePull : []).concat(sorted.forcePull)));
    if (forcePull.length) nextMeta.forcePull = forcePull;
    try {
      writeServerMeta(csvPath, nextMeta);
    } catch (error) {
      pushError = pushError || error;
    }
    const notes = [];
    if (sorted.okIds.length) notes.push('サーバーへ ' + sorted.okIds.length + ' 件送信');
    if (sorted.failed.length) {
      const reasons = Array.from(new Set(sorted.failed.map(function (item) { return TSLib.reasonText(item.reason); })));
      notes.push('送れなかった ' + sorted.failed.length + ' 件: ' + reasons.join('、'));
    }
    if (pushError) notes.push('サーバーへの送信は次回に再試行: ' + messageOf(pushError));
    return { note: notes.join(' / '), failed: !!pushError || sorted.failed.length > 0 };
  }

  function selectedServerStream() {
    const streamId = elements.serverStream.value;
    return serverStreams.find(function (stream) { return stream.stream_id === streamId; }) || null;
  }

  function updateServerControls() {
    const locked = serverBusy || busy || !serverReady;
    elements.serverConnect.disabled = locked;
    elements.serverChannel.disabled = locked || !elements.serverChannel.options.length;
    elements.serverStream.disabled = locked || !serverStreams.length;
    elements.serverOpen.disabled = locked || !selectedServerStream();
  }

  function setServerBusy(value) {
    serverBusy = value;
    updateServerControls();
  }

  function closeServerPopover() {
    elements.serverPopover.hidden = true;
    elements.serverBtn.setAttribute('aria-expanded', 'false');
  }

  // 配信の行: YYYY-MM-DD HH:mm · タイトル · スタンプ n / A stream row: YYYY-MM-DD HH:mm · title · stamps n
  function serverStreamLabel(stream) {
    const date = new Date(stream.started_at);
    const pad = function (value) { return String(value).padStart(2, '0'); };
    const when = Number.isFinite(date.getTime())
      ? date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
      : '開始時刻不明';
    return when + ' · ' + (stream.title || stream.stream_id) + ' · スタンプ ' + (Number(stream.stamp_count) || 0);
  }

  async function loadServerStreams() {
    const channel = elements.serverChannel.value;
    serverStreams = [];
    clearChildren(elements.serverStream);
    updateServerControls();
    if (!channel) return;
    setServerBusy(true);
    try {
      serverStreams = await YTSServer.listStreams(channel);
      serverStreams.forEach(function (stream) {
        const option = document.createElement('option');
        option.value = stream.stream_id;
        option.textContent = serverStreamLabel(stream);
        option.title = option.textContent;
        elements.serverStream.appendChild(option);
      });
      if (!serverStreams.length) setStatus(channel + ': サーバーに配信がありません', '');
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      setServerBusy(false);
    }
  }

  // 入力を /api/me で確かめ、通ったときだけ保存して会員のチャンネルを並べる（失敗しても前の設定と入力欄は残す）
  // Checks the input with /api/me, saves it only on success, and lists member channels (a failure keeps the old settings and the inputs).
  async function connectServer() {
    let candidate;
    try {
      candidate = YTSServer.normalizeSettings({ serverUrl: elements.serverUrl.value, token: elements.serverToken.value });
    } catch (error) {
      setStatus(messageOf(error), 'error');
      return;
    }
    elements.serverPicker.hidden = true;
    serverStreams = [];
    clearChildren(elements.serverChannel);
    clearChildren(elements.serverStream);
    setServerBusy(true);
    let me;
    try {
      me = await YTSServer.me(candidate);
      YTSServer.saveSettings(candidate);
    } catch (error) {
      setStatus(messageOf(error), 'error');
      return;
    } finally {
      setServerBusy(false);
    }
    elements.serverUrl.value = candidate.serverUrl;
    serverLogin = String((me && me.login) || '');
    const channels = me && Array.isArray(me.channels) ? me.channels : [];
    channels.forEach(function (channel) {
      const option = document.createElement('option');
      option.value = channel.login;
      option.textContent = channel.login + (channel.role ? '（' + channel.role + '）' : '');
      elements.serverChannel.appendChild(option);
    });
    elements.serverPicker.hidden = false;
    updateServerControls();
    if (!channels.length) {
      setStatus(serverLogin + ': 会員のチャンネルがありません', 'error');
      return;
    }
    setStatus(serverLogin + ' としてサーバーに接続しました', 'ok');
    await loadServerStreams();
  }

  // サーバーの記録を鏡 CSV に取り込み、meta を書いて、その CSV を開く
  // Merges the server records into the mirror CSV, writes the meta, and opens that CSV.
  // options（省略可）は autoLinkAndSync へ渡す（取り込みの userOffset / skipConfirm） / options (optional) go to autoLinkAndSync (the import's userOffset / skipConfirm)
  async function openServerStream(stream, options) {
    const settings = YTSServer.loadSettings();
    let mirrorPath = '';
    let merged = null;
    setBusy(true);
    try {
      mirrorPath = TSLib.serverMirrorPath(serverBaseDir(), settings.serverUrl, stream.stream_id);
      makeDirs(dirname(mirrorPath));
      const serverRecords = await YTSServer.pullStamps(stream.stream_id);
      const exists = pathExists(mirrorPath);
      const localRecords = exists ? TSLib.parseCsv(readText(mirrorPath)).records : [];
      // 開き直しでも、直前の push で forbidden_tombstone だった id はサーバーの生存記録で戻す（pullIntoMirror と同じ）。
      // 取り込めたら forcePull は消す（新しい meta に書かない）。記録が 0 件でも見出しだけの CSV と meta を書く
      // On re-open too, ids rejected as forbidden_tombstone come back from the server (as in pullIntoMirror); after a
      // successful pull forcePull is dropped (not written to the new meta). With zero records a header-only CSV and the meta are still written.
      const previous = readServerMeta(mirrorPath);
      const forceIds = previous && Array.isArray(previous.forcePull) ? previous.forcePull : [];
      merged = TSLib.mergeServerRecords(localRecords, serverRecords, { forceIds: forceIds });
      if (merged.changed || !exists) atomicWrite(mirrorPath, TSLib.toCsv(merged.records));
      writeServerMeta(mirrorPath, {
        serverUrl: settings.serverUrl,
        stream_id: stream.stream_id,
        channel: stream.channel || elements.serverChannel.value,
        started_at: stream.started_at || '',
        title: stream.title || '',
        lastPullAt: new Date().toISOString(),
        lastPushAt: previous && previous.lastPushAt ? previous.lastPushAt : '',
        me: serverLogin
      });
    } catch (error) {
      setStatus(messageOf(error), 'error');
      return;
    } finally {
      setBusy(false);
    }
    closeServerPopover();
    await loadCsvPath(mirrorPath, true);
    let opened = '';
    if (csvFilePath === mirrorPath && groups.length) {
      opened = merged.records.length ? 'サーバー: ' + serverStreamLabel(stream) + '（取り込み ' + merged.changed + ' 件）' : ZERO_STAMPS_MESSAGE;
      setStatus(opened, 'ok');
    }
    await refreshMarkers();
    // 「CSV」で開いたときと同じく、未紐付けなら紐付けてそのまま同期する（初回は確認の引き出しで止まる）
    // As with opening via "CSV": link if not linked yet and sync right away (the first sync stops at the confirm drawer).
    if (!samePath(csvFilePath, mirrorPath)) return;
    if (!(await autoLinkAndSync(opened, options)) && opened) setStatus(opened, 'ok');
  }

  function openServerPopover() {
    const settings = YTSServer.loadSettings();
    elements.serverPopover.hidden = false;
    elements.serverBtn.setAttribute('aria-expanded', 'true');
    if (!elements.serverUrl.value) elements.serverUrl.value = settings.serverUrl;
    if (!elements.serverToken.value) elements.serverToken.value = settings.token;
    updateServerControls();
    // 設定済みならそのまま配信ピッカーへ。未設定なら入力欄へ
    // With saved settings, go straight to the stream picker; otherwise focus the inputs.
    if (settings.serverUrl && settings.token) {
      if (elements.serverPicker.hidden && !serverBusy) connectServer();
    } else {
      (settings.serverUrl ? elements.serverToken : elements.serverUrl).focus();
    }
  }

  // ---- 配信を取り込む: 夜の処理の peakaboo.json → 素材・同期・Short・チャット動画・字幕 ----------
  // ---- 配信を取り込む: the night run's peakaboo.json → footage, sync, Shorts, chat videos, captions --

  const FOOTAGE_ROOT_KEY = 'yts.footageRoot';
  const DEFAULT_FOOTAGE_ROOT = 'D:\\Work_HDD\\寺乃なあ\\Footage';

  function footageRoot() {
    let value = '';
    try { value = localStorage.getItem(FOOTAGE_ROOT_KEY) || ''; } catch (storageError) {}
    return (value || DEFAULT_FOOTAGE_ROOT).replace(/[\\/]+$/, '');
  }

  function saveFootageRoot() {
    const value = elements.importRoot.value.trim();
    try {
      if (value) localStorage.setItem(FOOTAGE_ROOT_KEY, value);
      else localStorage.removeItem(FOOTAGE_ROOT_KEY);
    } catch (storageError) {}
    listImportPlans();
  }

  // フォルダの中の名前（読めなければ空） / Names inside a folder (empty when unreadable)
  function listDir(dir) {
    const result = window.cep.fs.readdir(dir);
    return result && result.err === 0 && Array.isArray(result.data) ? result.data : [];
  }

  // 取り込み計画がある _YYMMDD を全部、新しい順に並べる（先頭 = いちばん新しいものが選ばれる）
  // Lists every _YYMMDD folder that has a plan, newest first (the first, newest one is selected).
  function listImportPlans() {
    const root = footageRoot();
    elements.importRoot.value = root;
    clearChildren(elements.importPlan);
    const folders = YTSImport.planFolders(listDir(root));
    for (let i = 0; i < folders.length; i += 1) {
      const files = YTSImport.planFiles(listDir(root + '\\' + folders[i]));
      files.forEach(function (name) {
        const option = document.createElement('option');
        option.value = root + '\\' + folders[i] + '\\' + name;
        option.textContent = folders[i] + ' / ' + name;
        option.title = option.value;
        elements.importPlan.appendChild(option);
      });
    }
    if (!elements.importPlan.options.length) setStatus('peakaboo.json が見つかりません（Footage の場所: ' + root + '）', 'error');
    updateControls();
  }

  function openImportPopover() {
    elements.importPopover.hidden = false;
    elements.importStreamBtn.setAttribute('aria-expanded', 'true');
    listImportPlans();
  }

  function closeImportPopover() {
    elements.importPopover.hidden = true;
    elements.importStreamBtn.setAttribute('aria-expanded', 'false');
  }

  // 飛ばした理由。count は「理由 N」に、note は同じ文を 1 行にまとめる
  // Skip reasons: count() becomes "reason N"; note() collapses identical texts into one line.
  function createSkipList() {
    const counts = new Map();
    const notes = new Map();
    return {
      count: function (label) { counts.set(label, (counts.get(label) || 0) + 1); },
      note: function (text) { notes.set(text, (notes.get(text) || 0) + 1); },
      list: function () {
        const out = [];
        counts.forEach(function (n, label) { out.push(label + ' ' + n); });
        notes.forEach(function (n, text) { out.push(n > 1 ? text + '（' + n + ' 件）' : text); });
        return out;
      }
    };
  }

  // 計画を書き戻す（他のキーはそのまま） / Writes the plan back (other keys untouched)
  function writePlan(planPath, plan) {
    atomicWrite(planPath, JSON.stringify(plan, null, 2) + '\n');
  }

  // (1) 素材を読み込み、フル尺 Sequence を作って（既にあれば使って）開く / (1) Import the footage and create (or reuse) and open the full-length sequence
  async function importPlanFootage(plan) {
    setBusy(true);
    setStatus('素材を読み込み中', '');
    return callHost('ytsImportStream(' + hostLiteral({ footage: plan.footage, dateTag: plan.date_tag, sequenceName: YTSImport.sequenceName(plan) }) + ')', true);
  }

  // plan に channel は無いので、ピッカーのチャンネル → 会員のチャンネルの順に配信行を探す
  // The plan has no channel, so the stream row is looked up in the picker's channel, then in every member channel.
  async function findServerStream(streamId) {
    const channels = elements.serverChannel.value ? [elements.serverChannel.value] : [];
    const me = await YTSServer.me();
    serverLogin = String((me && me.login) || serverLogin);
    (me && Array.isArray(me.channels) ? me.channels : []).forEach(function (channel) {
      if (channels.indexOf(channel.login) < 0) channels.push(channel.login);
    });
    for (let i = 0; i < channels.length; i += 1) {
      const rows = await YTSServer.listStreams(channels[i]);
      const row = rows.find(function (item) { return item.stream_id === streamId; });
      if (row) return Object.assign({ channel: channels[i] }, row);
    }
    return null;
  }

  // (2)(3) サーバーの配信を開いて紐付け・同期する。Short 作成へ進めるときだけ true
  // (2)(3) Open the server stream, link and sync. True only when Short creation may go on.
  async function syncPlanStream(plan, imported) {
    setBusy(true);
    setStatus('同期中', '');
    const streamId = String(plan.stream_id || '');
    const row = await findServerStream(streamId);
    if (!row) {
      setStatus('サーバーに配信 ' + streamId + ' がありません', 'error');
      return false;
    }
    // 配信時刻 = VOD 時刻 + vod_offset_sec。素材は VOD なのでマーカーは −vod_offset_sec ずらす
    // Stream time = VOD time + vod_offset_sec; the footage is the VOD, so markers shift by −vod_offset_sec.
    await openServerStream(row, { skipConfirm: !imported.existing, userOffset: -(Number(row.vod_offset_sec) || 0) });
    if (elements.status.classList.contains('error')) return false;
    if (!activeEntry || activeEntry.stream_id !== row.stream_id) {
      setStatus('フル尺 Sequence をサーバーの配信に紐付けできませんでした', 'error');
      return false;
    }
    if (!elements.previewDrawer.hidden) {
      setStatus(elements.status.textContent + ' / 確認して同期したあと、もう一度「取り込む」を押してください', '');
      return false;
    }
    return true;
  }

  // (4) 済んでいない候補の Short を 1 本ずつ作り、そのたびに plan.shorts を書き戻す。配置の対象 [{id, sequenceId}] を返す
  // (4) Creates the missing Shorts one by one, writing plan.shorts back after each. Returns the placement targets [{id, sequenceId}].
  async function createPlanShorts(plan, planPath, result, skips) {
    setBusy(true);
    const base = { dateTag: plan.date_tag, parentBin: 'Sequence', preSec: Number(plan.pre_sec), postSec: Number(plan.post_sec), includeHuman: true };
    const probe = await callHost('ytsCreateShorts(' + hostLiteral(Object.assign({ dryRun: true, onlyIds: [] }, base)) + ')', true);
    const idByName = new Map();
    probe.sequenceNames.forEach(function (name, index) { idByName.set(name, (probe.sequenceIds || [])[index]); });
    const pending = YTSImport.pendingCandidates(plan, probe.sequenceNames);
    const shorts = Object.keys(pending.done).map(function (id) { return { id: id, sequenceId: idByName.get(pending.done[id]) }; });
    plan.shorts = plan.shorts || {};
    for (let i = 0; i < pending.toCreate.length; i += 1) {
      setStatus('Short を作成中 (' + (i + 1) + '/' + pending.toCreate.length + ')', '');
      let out;
      try {
        out = await callHost('ytsCreateShorts(' + hostLiteral(Object.assign({ onlyIds: [pending.toCreate[i]] }, base)) + ')', true);
      } catch (error) {
        skips.note(messageOf(error));
        continue;
      }
      if (!out.created.length) skips.count(out.skipped ? '範囲が取れない候補' : 'マーカーが無い候補');
      out.created.forEach(function (created) {
        plan.shorts[created.id] = created.name;
        shorts.push({ id: created.id, sequenceId: created.sequenceId });
        result.shorts += 1;
      });
      // 1 本ごとに書き戻す（途中で止まっても再実行で二重に作らない）。書けなければ取り込みごと止める
      // Written back after every Short (a stop midway never duplicates on rerun); a failed write stops the whole import.
      if (out.created.length) writePlan(planPath, plan);
    }
    return shorts;
  }

  // (5) 各 Short にチャット動画と字幕を置き、置けた（既にあった）ものを plan.placed に記録する
  // (5) Places the chat video and captions on each Short and records placed (or already present) ones in plan.placed.
  async function placePlanMedia(plan, planPath, shorts, result, skips) {
    const kinds = [
      { key: 'chat', label: 'チャット動画を配置中', missing: 'チャット動画なし', host: 'ytsPlaceChat', param: 'movPath', counter: 'chats' },
      { key: 'caption', label: '字幕を配置中', missing: '字幕なし', host: 'ytsPlaceCaption', param: 'srtPath', counter: 'captions' }
    ];
    const candidateById = new Map((plan.candidates || []).map(function (candidate) { return [String(candidate.id), candidate]; }));
    plan.placed = plan.placed || {};
    let changed = false;
    for (let k = 0; k < kinds.length; k += 1) {
      const kind = kinds[k];
      setBusy(true);
      setStatus(kind.label, '');
      for (let i = 0; i < shorts.length; i += 1) {
        const id = shorts[i].id;
        if (plan.placed[id] && plan.placed[id][kind.key] === true) continue;
        const candidate = candidateById.get(id);
        const file = candidate ? candidate[kind.key] : null;
        if (!file || !pathExists(file)) { skips.count(kind.missing); continue; }
        try {
          const params = { sequenceId: shorts[i].sequenceId, dateTag: plan.date_tag };
          params[kind.param] = file;
          const out = await callHost(kind.host + '(' + hostLiteral(params) + ')', true);
          if (out.placed || out.skipped === 'already') {
            plan.placed[id] = Object.assign({}, plan.placed[id]);
            plan.placed[id][kind.key] = true;
            changed = true;
          }
          if (out.placed) result[kind.counter] += 1;
          if (out.note) skips.note(out.note);
        } catch (error) {
          skips.note(messageOf(error));
        }
      }
    }
    if (changed) writePlan(planPath, plan);
  }

  // 「取り込む」: 計画を読み、(1)〜(5) を順に進め、(6) フル尺 Sequence に戻して件数を出す
  // "取り込む": reads the plan, runs (1)-(5) in order, then (6) returns to the full-length sequence and shows the counts.
  async function importStream() {
    const planPath = elements.importPlan.value;
    if (busy || importRunning || !planPath) return;
    let plan;
    try {
      plan = JSON.parse(readText(planPath));
    } catch (error) {
      setStatus('取り込み計画を読めません: ' + messageOf(error), 'error');
      return;
    }
    closeImportPopover();
    const result = { shorts: 0, chats: 0, captions: 0, skipped: [] };
    const skips = createSkipList();
    try {
      importRunning = true;
      const imported = await importPlanFootage(plan);
      if (!(await syncPlanStream(plan, imported))) return;
      const shorts = await createPlanShorts(plan, planPath, result, skips);
      await placePlanMedia(plan, planPath, shorts, result, skips);
      try {
        await callHost('app.project.openSequence(' + hostLiteral(imported.sequenceId) + ') ? "OK|" : "ERR|"', false);
      } catch (reopenError) {}
      result.skipped = skips.list();
      setStatus(YTSImport.summary(result), 'ok');
    } catch (error) {
      setStatus(messageOf(error), 'error');
    } finally {
      importRunning = false;
      setBusy(false);
    }
  }

  function bindImportEvents() {
    elements.importStreamBtn.addEventListener('click', function () {
      if (elements.importPopover.hidden) openImportPopover();
      else closeImportPopover();
    });
    elements.importRun.addEventListener('click', importStream);
    elements.importClose.addEventListener('click', closeImportPopover);
    elements.importPlan.addEventListener('change', updateControls);
    elements.importRoot.addEventListener('change', saveFootageRoot);
    // 入力中のキーを Premiere のショートカットに渡さない。Enter で確定、Escape で閉じる
    // Keep typed keys away from Premiere shortcuts; Enter commits, Escape closes.
    ['keydown', 'keyup', 'keypress'].forEach(function (eventName) {
      elements.importRoot.addEventListener(eventName, function (event) {
        event.stopPropagation();
        if (eventName !== 'keydown' || event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          elements.importRoot.blur();
        } else if (event.key === 'Escape') {
          closeImportPopover();
        }
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !elements.importPopover.hidden) closeImportPopover();
    });
    document.addEventListener('click', function (event) {
      if (!elements.importPopover.hidden && !elements.importPopover.contains(event.target) &&
          !elements.importStreamBtn.contains(event.target)) closeImportPopover();
    });
  }

  function bindServerEvents() {
    elements.serverBtn.addEventListener('click', function () {
      if (elements.serverPopover.hidden) openServerPopover();
      else closeServerPopover();
    });
    elements.serverClose.addEventListener('click', closeServerPopover);
    elements.serverConnect.addEventListener('click', connectServer);
    elements.serverChannel.addEventListener('change', loadServerStreams);
    elements.serverStream.addEventListener('change', updateServerControls);
    elements.serverOpen.addEventListener('click', function () {
      const stream = selectedServerStream();
      if (stream) openServerStream(stream);
    });
    // 入力中のキーを Premiere / AE のショートカットに渡さない。Enter で接続
    // Keep typed keys away from Premiere / AE shortcuts; Enter connects.
    [elements.serverUrl, elements.serverToken].forEach(function (input) {
      ['keydown', 'keyup', 'keypress'].forEach(function (eventName) {
        input.addEventListener(eventName, function (event) {
          event.stopPropagation();
          if (eventName === 'keydown' && (event.isComposing || event.keyCode === 229)) return;
          if (eventName === 'keydown' && event.key === 'Enter') {
            event.preventDefault();
            if (!elements.serverConnect.disabled) connectServer();
          }
        });
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !elements.serverPopover.hidden) closeServerPopover();
    });
    document.addEventListener('click', function (event) {
      if (!elements.serverPopover.hidden && !elements.serverPopover.contains(event.target) &&
          !elements.serverBtn.contains(event.target)) closeServerPopover();
    });
  }

  function bindEvents() {
    elements.newCsv.addEventListener('click', createCsvFromTarget);
    elements.pickCsv.addEventListener('click', pickCsv);
    elements.mergeCsv.addEventListener('click', pickMergeCsv);
    if (serverReady) bindServerEvents();
    if (serverReady && window.YTSImport) bindImportEvents();
    elements.exportFramesBtn.addEventListener('click', exportAllFrames);
    elements.shortsBtn.addEventListener('click', function () {
      const opening = elements.shortsPopover.hidden;
      elements.shortsPopover.hidden = !opening;
      elements.shortsBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) {
        elements.shortsPre.focus();
        elements.shortsPre.select();
      }
    });
    elements.shortsCreate.addEventListener('click', createShorts);
    elements.shortsClose.addEventListener('click', closeShortsPopover);
    // 入力中のキーを Premiere のショートカットに渡さない。Enter で作成、Escape で閉じる
    // Keep typed keys away from Premiere shortcuts; Enter creates, Escape closes.
    [elements.shortsPre, elements.shortsPost].forEach(function (input) {
      ['keydown', 'keyup', 'keypress'].forEach(function (eventName) {
        input.addEventListener(eventName, function (event) {
          event.stopPropagation();
          if (eventName !== 'keydown' || event.isComposing || event.keyCode === 229) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!elements.shortsCreate.disabled) createShorts();
          } else if (event.key === 'Escape') {
            closeShortsPopover();
          }
        });
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !elements.shortsPopover.hidden) closeShortsPopover();
    });
    document.addEventListener('click', function (event) {
      if (!elements.shortsPopover.hidden && !elements.shortsPopover.contains(event.target) &&
          !elements.shortsBtn.contains(event.target)) closeShortsPopover();
    });
    elements.refreshBtn.addEventListener('click', async function () {
      await refreshTarget(true);
      await refreshMarkers();
    });
    elements.linkTarget.addEventListener('click', linkTarget);
    elements.addMarkerBtn.addEventListener('click', addMarker);
    elements.syncBtn.addEventListener('click', function () { syncNow(false); });
    elements.executeBtn.addEventListener('click', executeFromDrawer);
    elements.closePreview.addEventListener('click', invalidatePreview);
    elements.confirmDelete.addEventListener('change', updateControls);
    elements.stream.addEventListener('change', invalidatePreview);
    elements.addUntagged.addEventListener('change', function () {
      if (!previewState) return;
      previewState.addUntagged = elements.addUntagged.checked;
      rerunPlan();
    });
    elements.offsetBtn.addEventListener('click', function () {
      const opening = elements.offsetPopover.hidden;
      elements.offsetPopover.hidden = !opening;
      elements.offsetBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) {
        updateOffsetDisplay();
        elements.offsetInput.focus();
        elements.offsetInput.select();
      }
    });
    elements.offsetInput.addEventListener('blur', commitOffsetInput);
    ['keydown', 'keyup', 'keypress'].forEach(function (eventName) {
      elements.offsetInput.addEventListener(eventName, function (event) {
        event.stopPropagation();
        if (eventName === 'keydown' && (event.isComposing || event.keyCode === 229)) return;
        if (eventName === 'keydown' && event.key === 'Enter') {
          event.preventDefault();
          commitOffsetInput();
        }
      });
    });
    elements.offsetMinusSec.addEventListener('click', function () { setOffset(userOffsetSec - 1); });
    elements.offsetPlusSec.addEventListener('click', function () { setOffset(userOffsetSec + 1); });
    elements.offsetMinusFrame.addEventListener('click', function () { setOffset(userOffsetSec - (1 / offsetFps())); });
    elements.offsetPlusFrame.addEventListener('click', function () { setOffset(userOffsetSec + (1 / offsetFps())); });
    elements.offsetReset.addEventListener('click', function () { setOffset(0); });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !elements.offsetPopover.hidden) closeOffsetPopover();
    });
    document.addEventListener('click', function (event) {
      if (!elements.offsetPopover.hidden && !elements.offsetPopover.contains(event.target) &&
          !elements.offsetBtn.contains(event.target)) closeOffsetPopover();
    });
    elements.log.addEventListener('click', function () {
      const expanded = elements.logHistory.hidden;
      elements.logHistory.hidden = !expanded;
      elements.log.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
    elements.log.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      elements.log.click();
    });
    window.addEventListener('focus', function () {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(async function () {
        if (busy || !libraryReady) return;
        try {
          const info = await callHost('ytsTargetInfo()', true);
          const hadTarget = !!(activeInfo && activeInfo.hasTarget);
          const hasTarget = !!(info && info.hasTarget);
          const changed = hadTarget !== hasTarget || (hasTarget && targetKey(info) !== targetKey(activeInfo));
          if (!changed) return;
          await refreshTarget(false);
          await refreshMarkers();
        } catch (error) {}
      }, 500);
    });
  }

  if (!libraryReady) {
    setStatus('lib.js を読み込めませんでした。panel\\install.ps1 を再実行してください', 'error');
    updateControls();
    return;
  }

  bindEvents();
  try {
    const storedPre = localStorage.getItem(shortsStorageKeys.pre);
    const storedPost = localStorage.getItem(shortsStorageKeys.post);
    if (storedPre && Number(storedPre) >= 0) elements.shortsPre.value = storedPre;
    if (storedPost && Number(storedPost) > 0) elements.shortsPost.value = storedPost;
  } catch (storageError) {}
  updateLinkState(false);
  updateOffsetDisplay();
  updateControls();
  callHost('ytsPing()').then(function (payload) {
    if (payload !== 'pong') throw new Error('ホストスクリプトから正しい応答がありませんでした');
    let storedPath = '';
    try { storedPath = localStorage.getItem(storageKey) || ''; } catch (storageError) {}
    return (storedPath ? loadCsvPath(storedPath, false) : refreshTarget(false)).then(refreshMarkers);
  }).catch(function (error) {
    setStatus(messageOf(error), 'error');
    libraryReady = false;
    updateControls();
  });
}());
