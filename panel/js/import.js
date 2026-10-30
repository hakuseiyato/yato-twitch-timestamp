'use strict';

// 「配信を取り込む」の純粋関数（夜の処理が書いた peakaboo.json を読む側）。DOM・CEP・ExtendScript には触れない
// Pure helpers of "配信を取り込む" (the reader of the peakaboo.json written overnight). No DOM, CEP or ExtendScript.
const YTSImport = (function () {
  // Footage 直下の _YYMMDD フォルダだけを新しい順に / Only the _YYMMDD folders under Footage, newest first
  function planFolders(entries) {
    return (entries || []).filter(function (name) { return /^_\d{6}$/.test(String(name)); }).sort().reverse();
  }

  // peakaboo_<vodId>.json があれば peakaboo.json は出さない（同じ内容の重複） / peakaboo.json is dropped when a peakaboo_<vodId>.json exists (same content)
  function planFiles(entries) {
    const names = (entries || []).map(String);
    const perVod = names.filter(function (name) { return /^peakaboo_[^\\/]+\.json$/.test(name); }).sort();
    if (perVod.length) return perVod;
    return names.indexOf('peakaboo.json') >= 0 ? ['peakaboo.json'] : [];
  }

  // plan.shorts の名前がまだプロジェクトにある id は済み、それ以外は作る / Ids whose plan.shorts name is still in the project are done; the rest are created
  function pendingCandidates(plan, existingSequenceNames) {
    const shorts = (plan && plan.shorts) || {};
    const existing = new Set((existingSequenceNames || []).map(String));
    const toCreate = [];
    const done = {};
    ((plan && plan.candidates) || []).forEach(function (candidate) {
      const id = String(candidate.id);
      const name = Object.prototype.hasOwnProperty.call(shorts, id) ? String(shorts[id]) : '';
      if (name && existing.has(name)) done[id] = name;
      else toCreate.push(id);
    });
    return { toCreate: toCreate, done: done };
  }

  // フル尺 Sequence の名前 YYMMDD_<タイトル> / The full-length sequence name YYMMDD_<title>
  function sequenceName(plan) {
    return plan.date_tag + '_' + plan.title;
  }

  // 状態欄の最後の 1 行 / The final status line
  function summary(result) {
    const skipped = (result && result.skipped) || [];
    return 'Short ' + result.shorts + ' 本、チャット動画 ' + result.chats + ' 本、字幕 ' + result.captions + ' 本' +
      (skipped.length ? '（' + skipped.join('、') + '）' : '');
  }

  return {
    planFolders: planFolders,
    planFiles: planFiles,
    pendingCandidates: pendingCandidates,
    sequenceName: sequenceName,
    summary: summary
  };
}());

if (typeof window !== 'undefined') window.YTSImport = YTSImport;
if (typeof module !== 'undefined') module.exports = YTSImport;
