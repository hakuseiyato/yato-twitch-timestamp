'use strict';

(function () {
  const elements = {
    authStatus: document.getElementById('auth-status'),
    authButton: document.getElementById('auth-button'),
    clientId: document.getElementById('client-id'),
    lagSec: document.getElementById('lag-sec'),
    serverUrl: document.getElementById('server-url'),
    grantHost: document.getElementById('grant-host'),
    saveSettings: document.getElementById('save-settings'),
    redirectUrl: document.getElementById('redirect-url'),
    csvImport: document.getElementById('csv-import'),
    status: document.getElementById('status'),
    streams: document.getElementById('streams'),
    relogin: document.getElementById('relogin'),
    syncSection: document.getElementById('sync-section'),
    syncNow: document.getElementById('sync-now'),
    pendingCount: document.getElementById('pending-count'),
    lastSync: document.getElementById('last-sync'),
    syncError: document.getElementById('sync-error'),
    failedDetails: document.getElementById('failed-details'),
    failedSummary: document.getElementById('failed-summary'),
    failedList: document.getElementById('failed-list'),
    clearFailed: document.getElementById('clear-failed')
  };
  // 送信状態の印 / Sync state marks
  const SYNC_MARKS = {
    sent: '送信済 / sent',
    pending: '未送信 / pending',
    failed: '失敗 / failed',
    unsent: '未送信 / unsent'
  };
  let currentState = null;

  function setStatus(message, isError) {
    elements.status.textContent = message || '';
    elements.status.className = isError ? 'error' : '';
  }

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : '処理に失敗しました');
    return response;
  }

  function append(parent, tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
  }

  function download(content, type, filename) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function decodeCsvFile(file) {
    const buffer = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (error) {
      return new TextDecoder('shift_jis').decode(buffer);
    }
  }

  function actionButton(parent, label, handler, destructive) {
    const button = append(parent, 'button', label, destructive ? 'danger' : 'secondary');
    button.type = 'button';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(handler()).catch(function (error) { setStatus(error.message, true); });
    });
    return button;
  }

  function renderStreams() {
    elements.streams.replaceChildren();
    const groups = TSLib.groupByStream(currentState.records);
    if (!groups.length) {
      append(elements.streams, 'p', 'まだタイムスタンプがありません', 'empty');
      return;
    }

    groups.forEach(function (group) {
      const details = append(elements.streams, 'details', undefined, 'stream');
      const summary = append(details, 'summary');
      const title = append(summary, 'span', group.channel || '不明なチャンネル', 'stream-title');
      const started = group.started_at ? new Date(group.started_at).toLocaleString() : '開始時刻不明';
      append(title, 'small', started + ' · ' + group.records.length + '件');
      const actions = append(summary, 'span', undefined, 'actions');
      actionButton(actions, 'CSV', function () {
        download(TSLib.toCsv(group.allRecords), 'text/csv;charset=utf-8', group.channel + '_' + TSLib.fileStamp(group.started_at) + '.csv');
      });
      actionButton(actions, '削除', async function () {
        if (!confirm('この配信のタイムスタンプをすべて削除しますか？')) return;
        await send({ type: 'deleteStream', stream_id: group.stream_id });
        await loadState();
        setStatus('配信の記録を削除しました', false);
      }, true);

      const list = append(details, 'div', undefined, 'record-list');
      group.records.forEach(function (record) {
        const row = append(list, 'div', undefined, 'record');
        append(row, 'span', TSLib.formatTimecode(record.offset_sec), 'timecode');
        const body = append(row, 'span', undefined, 'record-body');
        append(body, 'span', record.memo || '（メモなし）', 'memo');
        append(body, 'small', record.by || '不明');
        append(row, 'span', record.native ? 'ネイティブ' : 'ローカル', record.native ? 'badge native' : 'badge local');
        // サーバー URL があるときだけ送信状態を出す / Show the sync state only when a server URL is set
        if (currentState.settings.serverUrl) {
          const syncState = TSLib.recordSyncState(record.id, currentState.pending, currentState.failed, currentState.synced);
          append(row, 'span', SYNC_MARKS[syncState], 'badge ' + syncState);
        }
        actionButton(row, '削除', async function () {
          await send({ type: 'deleteRecord', record: record });
          await loadState();
          setStatus('記録を削除しました', false);
        }, true);
      });
    });
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function renderSync() {
    const serverUrl = currentState.settings.serverUrl;
    elements.syncSection.hidden = !serverUrl;
    if (!serverUrl) return;
    const pending = currentState.pending || [];
    const failed = currentState.failed || [];
    elements.pendingCount.textContent = '未送信 ' + pending.length + ' 件 / pending ' + pending.length;
    const lastSync = currentState.lastSync;
    const at = lastSync && lastSync.at ? new Date(lastSync.at) : null;
    if (at && Number.isFinite(at.getTime())) {
      const time = pad2(at.getHours()) + ':' + pad2(at.getMinutes());
      elements.lastSync.textContent = '最終同期 ' + time + '（成功 ' + lastSync.accepted + '）/ last sync ' + time + ' (accepted ' + lastSync.accepted + ')';
    } else {
      elements.lastSync.textContent = '最終同期 なし / last sync: never';
    }
    const error = lastSync && lastSync.error ? TSLib.reasonText(lastSync.error) : '';
    elements.syncError.textContent = error;
    elements.syncError.hidden = !error;

    // 失敗一覧: id の下 4 桁・タイムコード・理由 / Failure list: last 4 chars of the id, timecode, reason
    elements.failedDetails.hidden = !failed.length;
    elements.failedSummary.textContent = '失敗 ' + failed.length + ' 件 / failed ' + failed.length;
    elements.failedList.replaceChildren();
    const byId = new Map(TSLib.mergeRecords(currentState.records).map(function (record) { return [record.id, record]; }));
    failed.forEach(function (entry) {
      const record = byId.get(entry.id);
      const row = append(elements.failedList, 'div', undefined, 'failed-row');
      append(row, 'span', String(entry.id || '').slice(-4), 'mono');
      append(row, 'span', record ? TSLib.formatTimecode(Math.floor(record.offset_sec)) : '--:--:--', 'timecode');
      append(row, 'span', TSLib.reasonText(entry.reason), 'reason');
    });
  }

  function renderState() {
    elements.clientId.value = currentState.settings.clientId || '';
    elements.lagSec.value = currentState.settings.lagSec;
    elements.serverUrl.value = currentState.settings.serverUrl || '';
    // 権限が無いときだけ許可ボタンを出す / Show the grant button only while the permission is missing
    elements.grantHost.hidden = !currentState.settings.serverUrl || Boolean(currentState.serverPermission);
    elements.redirectUrl.textContent = currentState.redirectUrl || chrome.identity.getRedirectURL();
    const loggedIn = Boolean(currentState.auth && currentState.auth.token);
    const expired = loggedIn && Boolean(currentState.auth.expired);
    elements.authStatus.textContent = loggedIn ? currentState.auth.login + ' でログイン中' : '未ログイン';
    // 期限切れならボタンは再ログイン / With an expired token the button logs in again
    elements.authButton.textContent = loggedIn && !expired ? 'ログアウト' : 'ログイン';
    // 期限切れ、またはサーバーへ送る記録があるのに未ログインなら再ログインを促す
    // Ask to log in again when the token expired, or when records wait for the server while logged out.
    elements.relogin.hidden = !(expired || (!loggedIn && currentState.settings.serverUrl && (currentState.pending || []).length > 0));
    renderSync();
    renderStreams();
  }

  async function loadState() {
    currentState = await send({ type: 'getState' });
    renderState();
  }

  elements.saveSettings.addEventListener('click', async function () {
    try {
      const result = await send({
        type: 'saveSettings',
        settings: {
          clientId: elements.clientId.value,
          lagSec: elements.lagSec.value,
          serverUrl: elements.serverUrl.value
        }
      });
      await loadState();
      setStatus(result.reloginRequired ? 'Client ID が変更されたため、再ログインしてください' : '設定を保存しました', false);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // 手元の記録をサーバーへ送り、表示を更新する / Sends the local records to the server and refreshes the view
  async function syncNow() {
    elements.syncNow.disabled = true;
    try {
      const result = await send({ type: 'syncNow' });
      await loadState();
      if (result.error) setStatus(TSLib.reasonText(result.error), true);
      else setStatus('同期しました（成功 ' + result.accepted + '）/ Synced (accepted ' + result.accepted + ')', false);
    } finally {
      elements.syncNow.disabled = false;
    }
  }

  elements.syncNow.addEventListener('click', function () {
    syncNow().catch(function (error) { setStatus(error.message, true); });
  });

  elements.clearFailed.addEventListener('click', async function () {
    try {
      await send({ type: 'clearFailed' });
      await loadState();
      setStatus('失敗一覧を消しました / Cleared the failures', false);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // permissions.request はユーザー操作の中でしか呼べないので popup から直接呼ぶ
  // permissions.request needs a user gesture, so the popup calls it directly.
  elements.grantHost.addEventListener('click', async function () {
    const serverUrl = currentState && currentState.settings.serverUrl;
    if (!serverUrl) return;
    try {
      const granted = await chrome.permissions.request({ origins: [serverUrl + '/*'] });
      await loadState();
      if (!granted) {
        setStatus('サーバーへの送信は許可されませんでした / Sending to the server was not allowed', true);
        return;
      }
      setStatus('サーバーへの送信を許可しました / Sending to the server is allowed', false);
      // 許可されたらすぐ送る / Send right away once allowed
      await syncNow();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.authButton.addEventListener('click', async function () {
    elements.authButton.disabled = true;
    try {
      if (currentState.auth && currentState.auth.token && !currentState.auth.expired) {
        await send({ type: 'logout' });
        setStatus('ログアウトしました', false);
      } else {
        await send({ type: 'login' });
        setStatus('ログインしました', false);
      }
      await loadState();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      elements.authButton.disabled = false;
    }
  });

  elements.csvImport.addEventListener('change', async function () {
    const files = Array.from(elements.csvImport.files || []);
    const messages = [];
    for (const file of files) {
      try {
        const parsed = TSLib.parseCsv(await decodeCsvFile(file));
        const result = await send({ type: 'importRecords', records: parsed.records });
        messages.push(file.name + ': ' + result.added + '件を追加しました（' + parsed.skipped + ' 行をスキップ）');
      } catch (error) {
        messages.push(file.name + ': エラー: ' + error.message);
      }
    }
    elements.csvImport.value = '';
    await loadState();
    setStatus(messages.join('\n'), messages.some(function (message) { return message.indexOf('エラー:') >= 0; }));
  });

  loadState().catch(function (error) { setStatus(error.message, true); });
}());
