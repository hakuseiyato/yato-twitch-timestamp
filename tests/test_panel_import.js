'use strict';

// panel/js/import.js（「配信を取り込む」の純粋関数）と index.html の要素を検査する
// Tests panel/js/import.js (pure helpers of "配信を取り込む") and the matching elements in index.html.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Imp = require('../panel/js/import.js');

assert.deepStrictEqual(Imp.planFolders(['_261029', 'misc', '_261030', '_261028', 'notes.txt']), ['_261030', '_261029', '_261028']);
assert.deepStrictEqual(Imp.planFiles(['peakaboo.json', 'peakaboo_2914625472.json', '261030_x.mp4']), ['peakaboo_2914625472.json']);
assert.deepStrictEqual(Imp.planFiles(['peakaboo.json']), ['peakaboo.json']);
const plan = { date_tag: '261030', title: 'VALORANT', candidates: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], shorts: { a: '261030_Short_01_x', b: '261030_Short_02_y' } };
assert.deepStrictEqual(Imp.pendingCandidates(plan, ['261030_Short_01_x']), { toCreate: ['b', 'c'], done: { a: '261030_Short_01_x' } });
assert.deepStrictEqual(Imp.pendingCandidates({ candidates: [{ id: 'z' }] }, []), { toCreate: ['z'], done: {} });
assert.strictEqual(Imp.sequenceName(plan), '261030_VALORANT');
assert.strictEqual(Imp.summary({ shorts: 3, chats: 2, captions: 0, skipped: ['字幕は bin から各 Short へドラッグ'] }), 'Short 3 本、チャット動画 2 本、字幕 0 本（字幕は bin から各 Short へドラッグ）');

// 飛ばした理由が無ければ括弧を付けない。複数は「、」区切り / No parentheses without reasons; several are joined with 、
assert.strictEqual(Imp.summary({ shorts: 0, chats: 0, captions: 0, skipped: [] }), 'Short 0 本、チャット動画 0 本、字幕 0 本');
assert.strictEqual(Imp.summary({ shorts: 1, chats: 0, captions: 1, skipped: ['チャット動画なし 1', '字幕なし 2'] }), 'Short 1 本、チャット動画 0 本、字幕 1 本（チャット動画なし 1、字幕なし 2）');
// 複数の peakaboo_*.json は全部出す（名前順）/ Several peakaboo_*.json are all listed (by name)
assert.deepStrictEqual(Imp.planFiles(['peakaboo_2.json', 'peakaboo.json', 'peakaboo_1.json', 'peakaboo_1.json.bak']), ['peakaboo_1.json', 'peakaboo_2.json']);

// index.html に 5 つの id があり、import.js が main.js の前に読まれる / index.html has the 5 ids and loads import.js before main.js
const html = fs.readFileSync(path.resolve(__dirname, '../panel/html/index.html'), 'utf8');
for (const id of ['importStreamBtn', 'importPopover', 'importPlan', 'importRun', 'importClose']) {
  assert.ok(html.indexOf('id="' + id + '"') >= 0, 'index.html is missing #' + id);
}
const importScript = html.indexOf('<script src="../js/import.js"></script>');
assert.ok(importScript >= 0 && importScript < html.indexOf('<script src="../js/main.js"></script>'), 'import.js must load before main.js');
assert.ok(html.indexOf('title="配信を取り込む（夜の処理の結果を Premiere に）"') >= 0);

console.log('test_panel_import: ok');
