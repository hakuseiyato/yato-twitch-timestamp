'use strict';

// popup.html にサーバー同期の要素があり、popup.js がそれを使っているかを確かめる（実際の表示は Chrome で確認）
// Checks that popup.html has the server sync elements and popup.js uses them (the real rendering is checked in Chrome).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.resolve(__dirname, '../extension/popup.html'), 'utf8');
const script = fs.readFileSync(path.resolve(__dirname, '../extension/popup.js'), 'utf8');

const ids = ['sync-section', 'sync-now', 'pending-count', 'last-sync', 'sync-error', 'failed-details', 'failed-summary', 'failed-list', 'clear-failed', 'relogin'];
for (const id of ids) {
  assert.ok(new RegExp('id="' + id + '"').test(html), 'popup.html is missing #' + id);
  assert.ok(script.indexOf("getElementById('" + id + "')") >= 0, 'popup.js does not use #' + id);
}
assert.ok(html.indexOf('サーバーと同期 / Sync with server') >= 0);
assert.ok(html.indexOf('失敗一覧を消す / Clear failures') >= 0);
assert.ok(html.indexOf('トークンが切れました。再ログインしてください / Token expired. Log in again') >= 0);
// 失敗一覧は折りたたみ / The failure list is collapsible
assert.ok(/<details id="failed-details"/.test(html));

// 新しいメッセージを background に送る / Sends the new messages to the background
for (const type of ['syncNow', 'clearFailed']) assert.ok(script.indexOf("type: '" + type + "'") >= 0, 'popup.js does not send ' + type);
for (const name of ['TSLib.reasonText', 'TSLib.recordSyncState']) assert.ok(script.indexOf(name) >= 0, 'popup.js does not use ' + name);
// 4 つの送信状態すべてに印がある / Every one of the four sync states has a mark
for (const mark of ["sent: '送信済 / sent'", "pending: '未送信 / pending'", "failed: '失敗 / failed'", "unsent: '未送信 / unsent'"]) {
  assert.ok(script.indexOf(mark) >= 0, 'popup.js is missing the mark ' + mark);
}
assert.ok(script.indexOf('currentState.synced') >= 0, 'popup.js does not pass synced to recordSyncState');
// データを HTML として流し込まない / Never inject data as HTML
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(script), 'popup.js must not use innerHTML');

console.log('all tests passed');
