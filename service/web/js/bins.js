'use strict';

// コメント数のビン分け（純粋関数）。ブラウザでは window.YTSBins、Node では require で読む
// Binning of comment counts (pure functions). window.YTSBins in the browser, require() in Node.
const YTSBins = (function () {
  // 秒 → ビン番号 / Seconds to bin index
  function binIndex(sec, binSec) {
    return Math.floor(sec / binSec);
  }

  // offset（秒）の配列をビンごとに数える。長さは ceil(lengthSec / binSec)（最低 1）
  // 負・非数・最後のビンより後ろの offset は捨てる
  // Counts offsets (seconds) per bin. Length is ceil(lengthSec / binSec), at least 1.
  // Negative, non-numeric and past-the-last-bin offsets are dropped.
  function binCounts(offsets, binSec, lengthSec) {
    const counts = new Uint32Array(Math.max(1, Math.ceil(lengthSec / binSec)));
    for (const sec of offsets) {
      if (!(sec >= 0)) continue;
      const bin = binIndex(sec, binSec);
      if (bin < counts.length) counts[bin]++;
    }
    return counts;
  }

  // 上位 n ビンの index。件数の多い順・同点は若い index を優先して n 個選び、index の昇順で返す
  // Indices of the top-n bins: picked by count desc, ties to the lower index, returned in ascending index order.
  function peakBins(counts, n) {
    const order = Array.from(counts.keys()).sort((a, b) => counts[b] - counts[a] || a - b);
    return order.slice(0, Math.max(0, n)).sort((a, b) => a - b);
  }

  return {
    binIndex: binIndex,
    binCounts: binCounts,
    peakBins: peakBins
  };
}());

if (typeof module !== 'undefined') module.exports = YTSBins;
