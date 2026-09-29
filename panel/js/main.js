'use strict';

const cs = new CSInterface();
const hostApp = cs.getHostEnvironment().appName; // 'PPRO' | 'AEFT'
const extPath = cs.getSystemPath(SystemPath.EXTENSION);
cs.evalScript('$.evalFile(' + JSON.stringify(extPath + '/jsx/' + (hostApp === 'PPRO' ? 'ppro' : 'aeft') + '.jsx') + ')');

(function () {
  const elements = {
    pickCsv: document.getElementById('pickCsv'),
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
  const allControls = [elements.pickCsv, elements.stream, elements.offsetBtn, elements.linkTarget,
    elements.refreshBtn, elements.addUntagged, elements.addMarkerBtn, elements.syncBtn, elements.executeBtn];
  const offsetControls = [elements.offsetInput, elements.offsetMinusSec, elements.offsetPlusSec,
    elements.offsetMinusFrame, elements.offsetPlusFrame, elements.offsetReset];
  let csvFilePath = '';
  let groups = [];
  let activeInfo = null;
  let activeEntry = null;
  let activeKey = '';
  let userOffsetSec = 0;
  let busy = false;
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

  thumbnailVideo.muted = true;
  thumbnailVideo.preload = 'auto';

  // ponytail: no eviction; add LRU cleanup if the cache grows too large
  // ponytail: Replacing a source video during this session can leave stale thumbnails because mtimes are memoized.

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
    busy = value;
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
      if (activeKey !== previousActiveKey) userOffsetSec = 0;
    }
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
      const parsed = TSLib.parseCsv(readText(path));
      groups = TSLib.groupByStream(parsed.records);
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
      const loadMessage = basename(path) + ': ' + groups.length + ' 件の配信を読み込みました' +
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

  function pickCsv() {
    const result = window.cep.fs.showOpenDialogEx(false, false, '同期 CSV を選択', '', ['csv']);
    if (!result || result.err !== 0 || !result.data || !result.data[0]) return;
    loadCsvPath(result.data[0], true).then(refreshMarkers);
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
      hostName: hostApp === 'PPRO' ? 'premiere' : 'ae'
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
      hostName: hostApp === 'PPRO' ? 'premiere' : 'ae'
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
      const counts = changeCounts(state.plan);
      const successMessage = state.plan.preview.length === 0 ? '変更はありません' :
        '同期しました（アプリ ' + Number(applyResult.applied || 0) + ' / CSV ' + counts.csv +
        (failed.length ? ' / 失敗 ' + failed.length + ' 件' : '') +
        (nudged.length ? ' / 位置調整 ' + nudged.length + ' 件' : '') + '）' + relistWarning;
      setStatus(successMessage, 'ok');
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

  async function syncNow() {
    // Drop any earlier preview so a failed recompute never leaves a stale drawer executable.
    invalidatePreview();
    setBusy(true);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = await computePreview();
        const plan = state.plan;
        const reasons = TSLib.syncConfirmReasons({
          plan: state.plan,
          entry: state.entry,
          parsedWarnings: state.parsedWarnings,
          repaired: state.repaired
        });
        if (reasons.length > 0) {
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
        by: hostApp === 'PPRO' ? 'premiere' : 'ae',
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

  function bindEvents() {
    elements.pickCsv.addEventListener('click', pickCsv);
    elements.refreshBtn.addEventListener('click', async function () {
      await refreshTarget(true);
      await refreshMarkers();
    });
    elements.linkTarget.addEventListener('click', linkTarget);
    elements.addMarkerBtn.addEventListener('click', addMarker);
    elements.syncBtn.addEventListener('click', syncNow);
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
