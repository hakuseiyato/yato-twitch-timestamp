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

  // フル尺 Sequence の名前。夜の処理が書いた sequence_name（素材名から作る）を優先し、無い古い計画は YYMMDD_<タイトル>
  // （素材名と同じ規則: ファイル名に使えない文字と制御文字を除き、前後空白を落として 30 文字）
  // The full-length sequence name: the sequence_name written overnight (from the footage name) wins; older plans without it
  // get YYMMDD_<title> (same rule as the footage name: forbidden and control chars stripped, trimmed, cut to 30).
  function sequenceName(plan) {
    if (plan.sequence_name) return String(plan.sequence_name);
    const cleaned = String(plan.title || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').trim();
    return plan.date_tag + '_' + Array.from(cleaned).slice(0, 30).join('').trim();
  }

  // 作り直した Short の id を plan.placed から外す（消された Short の記録で配置を飛ばさない）。plan を返す
  // Drops the ids of recreated Shorts from plan.placed (a deleted Short's record must not skip placement). Returns plan.
  function clearPlaced(plan, ids) {
    if (plan && plan.placed) (ids || []).forEach(function (id) { delete plan.placed[String(id)]; });
    return plan;
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
    clearPlaced: clearPlaced,
    summary: summary
  };
}());

if (typeof window !== 'undefined') window.YTSImport = YTSImport;
if (typeof module !== 'undefined') module.exports = YTSImport;
