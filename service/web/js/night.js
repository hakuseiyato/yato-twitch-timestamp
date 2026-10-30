'use strict';

// 配信ページの「夜の処理」の状態行（純粋関数）。ブラウザでは window.YTSNight、Node では require で読む
// Night-run status line of the stream page (pure functions). window.YTSNight in the browser, require() in Node.
// 常駐が書く night_status: '処理中: <段>' / '完了（候補 N・チャット動画 N・字幕 N）' / '失敗: <段> — <理由>'
// night_status written by the daemon: '処理中: <stage>' / '完了（…）' / '失敗: <stage> — <reason>'
const YTSNight = (function () {
  // 要求から常駐の応答が無いまま、この時間で「動いていない」とみなす / No daemon reply this long after a request counts as "not running"
  const STALE_MS = 5 * 60 * 1000;

  function pad2(n) { return String(n).padStart(2, '0'); }

  // ISO → 'YYYY-MM-DD HH:MM'（見る人の現地時刻。api.js の formatDate と同じ形。api.js は読まない）
  // ISO -> 'YYYY-MM-DD HH:MM' (viewer's local time; same shape as formatDate in api.js, which is not loaded here)
  function formatDoneAt(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // 要求が済んでいない（done より新しい、または done が無い）/ The request is still open (newer than done, or no done)
  function requestOpen(stream) {
    const requested = Date.parse(stream.night_requested_at);
    if (!Number.isFinite(requested)) return false;
    const done = Date.parse(stream.night_done_at);
    return !Number.isFinite(done) || requested > done;
  }

  function processing(stream) {
    return String(stream.night_status || '').indexOf('処理中') === 0;
  }

  // 要求が開いている・または処理中なら running（polling とボタンの無効化に使う）
  // Running when a request is open or a run is in progress (drives polling and disabling the button)
  function isRunning(stream) {
    return requestOpen(stream) || processing(stream);
  }

  // 状態行の文言と種類 / Text and kind of the status line
  function nightStatusText(stream, nowMs) {
    const status = String(stream.night_status || '');
    if (requestOpen(stream)) {
      if (processing(stream)) return { text: status, kind: 'running', running: true };
      if (nowMs - Date.parse(stream.night_requested_at) < STALE_MS) return { text: '要求済み', kind: 'requested', running: true };
      return { text: 'PC 側の常駐が動いていないようです', kind: 'stale', running: true };
    }
    if (processing(stream)) return { text: status, kind: 'running', running: true };
    const done = Date.parse(stream.night_done_at);
    if (Number.isFinite(done)) {
      return {
        text: status + '（' + formatDoneAt(done) + '）',
        kind: status.indexOf('失敗') === 0 ? 'failed' : 'done',
        running: false
      };
    }
    return { text: '', kind: 'idle', running: false };
  }

  return {
    nightStatusText: nightStatusText,
    isRunning: isRunning
  };
}());

if (typeof module !== 'undefined') module.exports = YTSNight;
