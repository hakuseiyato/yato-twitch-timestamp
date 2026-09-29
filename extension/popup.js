'use strict';

(function () {
  const elements = {
    authStatus: document.getElementById('auth-status'),
    authButton: document.getElementById('auth-button'),
    clientId: document.getElementById('client-id'),
    lagSec: document.getElementById('lag-sec'),
    saveSettings: document.getElementById('save-settings'),
    redirectUrl: document.getElementById('redirect-url'),
    csvImport: document.getElementById('csv-import'),
    status: document.getElementById('status'),
    streams: document.getElementById('streams')
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
        actionButton(row, '削除', async function () {
          await send({ type: 'deleteRecord', record: record });
          await loadState();
          setStatus('記録を削除しました', false);
        }, true);
      });
    });
  }

  function renderState() {
    elements.clientId.value = currentState.settings.clientId || '';
    elements.lagSec.value = currentState.settings.lagSec;
    elements.redirectUrl.textContent = currentState.redirectUrl || chrome.identity.getRedirectURL();
    const loggedIn = Boolean(currentState.auth && currentState.auth.token);
    elements.authStatus.textContent = loggedIn ? currentState.auth.login + ' でログイン中' : '未ログイン';
    elements.authButton.textContent = loggedIn ? 'ログアウト' : 'ログイン';
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
          lagSec: elements.lagSec.value
        }
      });
      await loadState();
      setStatus(result.reloginRequired ? 'Client ID が変更されたため、再ログインしてください' : '設定を保存しました', false);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.authButton.addEventListener('click', async function () {
    elements.authButton.disabled = true;
    try {
      if (currentState.auth && currentState.auth.token) {
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
