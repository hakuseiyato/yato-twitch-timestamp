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
// 夜の処理が書いた sequence_name を優先する / The sequence_name written overnight wins
assert.strictEqual(Imp.sequenceName({ date_tag: '261030', title: 'X', sequence_name: '261030_X_2' }), '261030_X_2');
// 古い計画はタイトルから: 禁止文字と制御文字を除き、前後空白を落として 30 文字 / Old plans fall back to the title: forbidden and control chars stripped, trimmed, cut to 30
assert.strictEqual(Imp.sequenceName({ date_tag: '261030', title: ' VALORANT: ランク\\上げ?\t ' }), '261030_VALORANT ランク上げ');
assert.strictEqual(Imp.sequenceName({ date_tag: '261030', title: 'あ'.repeat(40) }), '261030_' + 'あ'.repeat(30));
assert.strictEqual(Imp.sequenceName({ date_tag: '261030', title: 'a/b*c"d<e>f|g\u0000h', sequence_name: '' }), '261030_abcdefgh');

// 作り直した Short は置いた記録を消す（チャット動画と字幕をもう一度置く）/ A recreated Short loses its placed record, so chat and captions are placed again
const placedPlan = { placed: { a: { chat: true }, b: { caption: true }, c: { chat: true } } };
assert.strictEqual(Imp.clearPlaced(placedPlan, ['a', 'c', 'zz']), placedPlan);
assert.deepStrictEqual(placedPlan.placed, { b: { caption: true } });
const noPlaced = { candidates: [] };
assert.deepStrictEqual(Imp.clearPlaced(noPlaced, ['a']), { candidates: [] });
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

// 取り込みは同時に 1 つだけ: importStream が importRunning を見て立て、setBusy がそれを OR する（main.js は node で動かせないので文字列で固定）
// Only one import at a time: importStream checks and sets importRunning, setBusy ORs it in (main.js cannot run in node, so pinned by source text).
const mainSource = fs.readFileSync(path.resolve(__dirname, '../panel/js/main.js'), 'utf8');
function functionBody(name) {
  const match = new RegExp('\\n  (?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n').exec(mainSource);
  assert.ok(match, 'main.js has no function ' + name);
  return match[0];
}
assert.ok(functionBody('importStream').indexOf('importRunning') >= 0, 'importStream must use importRunning');
assert.ok(functionBody('setBusy').indexOf('importRunning') >= 0, 'setBusy must OR in importRunning');
// Short を作るたびに計画を書き戻す（ループの中で writePlan）/ The plan is written back after every created Short (writePlan inside the loop)
const createBody = functionBody('createPlanShorts');
const loopStart = createBody.indexOf('for (let i = 0; i < pending.toCreate.length');
assert.ok(loopStart >= 0 && createBody.indexOf('writePlan(planPath, plan)', loopStart) > loopStart, 'writePlan must run inside the Short loop');
// 作った Short の placed を書き戻しの前に消す / placed of a created Short is cleared before the write-back
const clearAt = createBody.indexOf('YTSImport.clearPlaced(plan, [created.id])', loopStart);
assert.ok(clearAt > loopStart && clearAt < createBody.indexOf('writePlan(planPath, plan)', loopStart), 'createPlanShorts must clear placed before writePlan');
// 計画のある日付フォルダは全部並べる（最初の 1 つで止めない）/ Every day folder with a plan is listed (no break after the first)
assert.ok(functionBody('listImportPlans').indexOf('break') < 0, 'listImportPlans must list every day folder');

console.log('test_panel_import: ok');
