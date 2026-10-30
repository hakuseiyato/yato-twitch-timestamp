'use strict';

// コメント密度グラフ（canvas）。棒 = ビンごとのコメント数、縦線 = スタンプ、選択ビンは --accent
// ブラウザでは素の識別子 YTSGraph（classic script の const）、Node では require で読む（labelStep のテスト用）
// Comment density graph (canvas). Bars = comments per bin, vertical lines = stamps, the selected bin in --accent.
// A bare YTSGraph identifier in the browser (classic-script const), require() in Node (to test labelStep).
const YTSGraph = (function () {
  // 目盛りの候補（秒）/ Candidate label intervals (seconds)
  const NICE_STEPS_SEC = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600];
  const LABEL_MIN_PX = 72;
  const AXIS_H = 20;
  const TOP_PAD = 16;

  // 目盛りの間隔（ビン数）。binSec の倍数のきりの良い秒で、間隔が LABEL_MIN_PX 以上になる最小のもの
  // Label step in bins: the smallest round number of seconds (a multiple of binSec) whose spacing is at least LABEL_MIN_PX.
  function labelStep(binSec, pxPerBin) {
    for (const sec of NICE_STEPS_SEC) {
      if (sec % binSec !== 0) continue;
      if ((sec / binSec) * pxPerBin >= LABEL_MIN_PX) return sec / binSec;
    }
    return Math.ceil(LABEL_MIN_PX / pxPerBin);
  }

  function cssVar(node, name) {
    return getComputedStyle(node).getPropertyValue(name).trim();
  }

  // canvas の親は position: relative の箱（ツールチップをそこに置く）
  // The canvas parent is a position: relative box (the tooltip lives there).
  function createGraph(canvas) {
    const wrap = canvas.parentElement;
    const ctx = canvas.getContext('2d');
    const tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.hidden = true;
    // 読み上げは canvas の aria-valuetext が担う / Screen readers use the canvas aria-valuetext instead
    tooltip.setAttribute('aria-hidden', 'true');
    wrap.append(tooltip);

    let counts = new Uint32Array(1);
    let binSec = 30;
    let stamps = [];
    let selected = null;
    let hovered = null;
    let selectHandler = null;
    let cssWidth = 0;
    let cssHeight = 0;

    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'slider');
    canvas.setAttribute('aria-valuemin', '0');

    function pxPerBin() {
      return cssWidth / counts.length;
    }

    function rangeText(bin) {
      return TSLib.formatTimecode(bin * binSec) + ' – ' + TSLib.formatTimecode((bin + 1) * binSec);
    }

    function binText(bin) {
      const n = counts[bin] || 0;
      return rangeText(bin) + ' / ' + n.toLocaleString() + ' 件 / ' + n.toLocaleString() + ' comments';
    }

    // キーボード操作の読み上げ用 / For screen readers while using the keyboard
    function updateAria() {
      canvas.setAttribute('aria-valuemax', String(counts.length - 1));
      if (selected === null) {
        canvas.removeAttribute('aria-valuenow');
        canvas.setAttribute('aria-valuetext', '未選択 / Nothing selected');
      } else {
        canvas.setAttribute('aria-valuenow', String(selected));
        canvas.setAttribute('aria-valuetext', binText(selected));
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cssWidth = Math.max(1, rect.width);
      cssHeight = Math.max(1, rect.height);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function draw() {
      if (!cssWidth) return;
      const colors = {
        bar: cssVar(canvas, '--graph-bar') || '#5a6b7d',
        hover: cssVar(canvas, '--graph-bar-hover') || '#7d8fa3',
        accent: cssVar(canvas, '--accent'),
        stamp: cssVar(canvas, '--warning'),
        candidate: cssVar(canvas, '--candidate') || '#c792ea',
        axis: cssVar(canvas, '--border'),
        label: cssVar(canvas, '--secondary'),
        font: cssVar(canvas, '--font-body')
      };
      ctx.clearRect(0, 0, cssWidth, cssHeight);
      const plotH = cssHeight - AXIS_H - TOP_PAD;
      const baseY = TOP_PAD + plotH;
      const step = pxPerBin();
      let max = 0;
      for (const n of counts) if (n > max) max = n;

      // 棒（1px 未満でも隙間なしで描く）/ Bars (drawn without gaps even when under 1px)
      const gap = step >= 4 ? 1 : 0;
      for (let i = 0; i < counts.length; i++) {
        if (!counts[i] && i !== selected) continue;
        const h = max ? Math.max(1, (counts[i] / max) * plotH) : 0;
        ctx.fillStyle = i === selected ? colors.accent : i === hovered ? colors.hover : colors.bar;
        // 選択ビンは件数 0 でも全高の帯で示す / The selected bin shows as a full-height band even at zero comments
        if (i === selected) {
          ctx.globalAlpha = 0.25;
          ctx.fillRect(i * step, TOP_PAD, Math.max(1, step - gap), plotH);
          ctx.globalAlpha = 1;
        }
        if (h) ctx.fillRect(i * step, baseY - h, Math.max(1, step - gap), h);
      }

      // スタンプの縦線。候補（呼び出し側が s.candidate を付ける）は --candidate
      // Stamp lines. Candidates (the caller sets s.candidate) use --candidate
      for (const s of stamps) {
        ctx.fillStyle = s.candidate ? colors.candidate : colors.stamp;
        const x = (Number(s.offset_sec) / binSec) * step;
        if (x >= 0 && x <= cssWidth) ctx.fillRect(Math.min(x, cssWidth - 2), 0, 2, baseY);
      }

      // 横軸と目盛り / Axis and labels
      ctx.fillStyle = colors.axis;
      ctx.fillRect(0, baseY, cssWidth, 1);
      ctx.fillStyle = colors.label;
      ctx.font = '11px ' + (colors.font || 'sans-serif');
      ctx.textBaseline = 'top';
      const every = labelStep(binSec, step);
      for (let i = 0; i < counts.length; i += every) {
        const x = i * step;
        ctx.fillRect(x, baseY, 1, 4);
        ctx.textAlign = i === 0 ? 'left' : 'center';
        if (x + 30 < cssWidth) ctx.fillText(TSLib.formatTimecode(i * binSec), x, baseY + 6);
      }
      // 最大件数 / Maximum count
      ctx.textAlign = 'left';
      ctx.fillText('max ' + max.toLocaleString(), 4, 2);
    }

    // 画面の x 座標 → ビン番号（範囲外は null）/ Client x -> bin index (null outside)
    function binAtX(clientX) {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      if (x < 0 || x >= rect.width) return null;
      return Math.min(counts.length - 1, Math.floor(x / (rect.width / counts.length)));
    }

    function showTooltip(bin, clientX) {
      tooltip.textContent = binText(bin);
      tooltip.hidden = false;
      const wrapRect = wrap.getBoundingClientRect();
      const left = clientX - wrapRect.left + 12;
      const maxLeft = wrap.clientWidth - tooltip.offsetWidth - 4;
      tooltip.style.left = Math.max(4, Math.min(left, maxLeft)) + 'px';
    }

    function select(bin) {
      selected = bin === null || bin === undefined ? null : Math.max(0, Math.min(counts.length - 1, bin));
      updateAria();
      draw();
    }

    function choose(bin) {
      select(bin);
      if (selectHandler && selected !== null) selectHandler(selected);
    }

    canvas.addEventListener('pointermove', function (event) {
      const bin = binAtX(event.clientX);
      if (bin !== hovered) {
        hovered = bin;
        draw();
      }
      if (bin === null) tooltip.hidden = true;
      else showTooltip(bin, event.clientX);
    });
    canvas.addEventListener('pointerleave', function () {
      hovered = null;
      tooltip.hidden = true;
      draw();
    });
    // 押した瞬間に反応する / Responds on pointer-down
    canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      const bin = binAtX(event.clientX);
      if (bin !== null) choose(bin);
    });
    canvas.addEventListener('keydown', function (event) {
      const last = counts.length - 1;
      let next = null;
      if (event.key === 'ArrowLeft') next = selected === null ? last : selected - 1;
      else if (event.key === 'ArrowRight') next = selected === null ? 0 : selected + 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = last;
      if (next === null) return;
      event.preventDefault();
      choose(Math.max(0, Math.min(last, next)));
    });

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(wrap);
    // 拡大率（devicePixelRatio）の変化も拾う / Also catches devicePixelRatio changes
    window.addEventListener('resize', resize);
    resize();
    updateAria();

    return {
      setData: function (d) {
        counts = d.counts && d.counts.length ? d.counts : new Uint32Array(1);
        binSec = d.binSec;
        stamps = d.stamps || [];
        if (selected !== null && selected >= counts.length) selected = counts.length - 1;
        hovered = null;
        updateAria();
        draw();
      },
      select: select,
      onSelect: function (cb) { selectHandler = cb; },
      binAtX: binAtX,
      // 検証・デバッグ用 / For tests and debugging
      state: function () {
        return { binCount: counts.length, binSec: binSec, selected: selected, stampCount: stamps.length, max: Math.max.apply(null, Array.from(counts)) };
      }
    };
  }

  return {
    labelStep: labelStep,
    createGraph: createGraph
  };
}());

if (typeof module !== 'undefined') module.exports = YTSGraph;
