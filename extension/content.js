'use strict';

(function () {
  const DEFAULT_GAP = 18;       // px from the right/bottom edges when no position is stored
  const DRAG_THRESHOLD = 4;     // px of movement before a pointerdown on the handle becomes a drag
  const POS_KEY = 'buttonPos';

  let lastUrl = '';
  let toastTimer = null;
  let storedFractions = null;   // { right, bottom } or null for the default corner
  let pendingId = '';           // record id the open memo input belongs to
  let committing = null;        // in-flight commit, so blur + click do not save twice

  const panel = document.createElement('div');
  panel.id = 'yts-panel';
  const handle = document.createElement('div');
  handle.id = 'yts-handle';
  handle.textContent = '⋮⋮';
  handle.title = 'ドラッグで移動（ダブルクリックで右下に戻す）';
  handle.setAttribute('aria-label', 'ドラッグで移動（ダブルクリックで右下に戻す）');
  const input = document.createElement('input');
  input.id = 'yts-memo';
  input.type = 'text';
  input.placeholder = 'メモ（Enter で保存 / Esc で閉じる）';
  input.maxLength = 500;
  input.hidden = true;
  const button = document.createElement('button');
  button.id = 'yts-stamp';
  button.type = 'button';
  button.textContent = '⏱ 記録';
  const toast = document.createElement('div');
  toast.id = 'yts-toast';
  toast.setAttribute('role', 'status');
  panel.appendChild(handle);
  panel.appendChild(input);
  panel.appendChild(button);
  panel.appendChild(toast);
  (document.body || document.documentElement).appendChild(panel);

  function contextAvailable() {
    return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  }

  function showToast(message, isError) {
    toast.textContent = message;
    toast.className = isError ? 'yts-error yts-visible' : 'yts-visible';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.className = ''; }, 5000);
  }

  function showContextLost() {
    showToast('拡張機能が更新されました。ページを再読み込みしてください', true);
  }

  async function send(message) {
    if (!contextAvailable()) {
      showContextLost();
      return null;
    }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (!contextAvailable() || (error && /Extension context invalidated/i.test(error.message || ''))) showContextLost();
      else showToast('処理に失敗しました', true);
      return null;
    }
  }

  // ---- position -------------------------------------------------------------

  // The widget is anchored with right/bottom so it grows up/left (e.g. when the memo input opens).
  function applyPosition() {
    const rect = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const fractions = storedFractions || { right: DEFAULT_GAP / vw, bottom: DEFAULT_GAP / vh };
    const pos = TSLib.fractionsToPos(fractions, rect.width, rect.height, vw, vh);
    panel.style.right = Math.round(vw - pos.left - rect.width) + 'px';
    panel.style.bottom = Math.round(vh - pos.top - rect.height) + 'px';
  }

  function savePosition() {
    if (!contextAvailable()) return;
    const value = {};
    value[POS_KEY] = storedFractions;
    chrome.storage.local.set(value).catch(function () {});
  }

  let drag = null;
  handle.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    const rect = panel.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moving: false };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', function (event) {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moving && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moving = true;
    panel.classList.add('yts-dragging');
    const rect = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    storedFractions = TSLib.posToFractions(drag.left + dx, drag.top + dy, rect.width, rect.height, vw, vh);
    applyPosition();
  });
  function endDrag(event) {
    if (!drag) return;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    const moved = drag.moving;
    drag = null;
    panel.classList.remove('yts-dragging');
    if (moved) savePosition();
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', function () {
    storedFractions = null;
    applyPosition();
    if (contextAvailable()) chrome.storage.local.remove(POS_KEY).catch(function () {});
  });
  window.addEventListener('resize', applyPosition);

  // ---- memo -----------------------------------------------------------------

  function openMemo(recordId) {
    pendingId = recordId;
    input.value = '';
    input.hidden = false;
    applyPosition();
    input.focus();
  }

  function closeMemo() {
    pendingId = '';
    input.value = '';
    input.hidden = true;
    applyPosition();
  }

  // Saves the typed memo (if any) to the pending record and closes the input. Safe to call twice.
  function commitMemo() {
    if (committing) return committing;
    const id = pendingId;
    const memo = input.value.trim();
    closeMemo();
    if (!id || !memo) return Promise.resolve();
    committing = send({ type: 'updateMemo', id: id, memo: memo }).then(function (result) {
      if (!result) return;
      if (result.ok) showToast('メモを保存しました', false);
      else showToast(result.error || 'メモを保存できませんでした', true);
    }).finally(function () { committing = null; });
    return committing;
  }

  ['keydown', 'keyup', 'keypress'].forEach(function (eventName) {
    input.addEventListener(eventName, function (event) {
      event.stopPropagation(); // keep Twitch's keyboard shortcuts from firing while typing
      if (eventName !== 'keydown' || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitMemo();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeMemo();
      }
    });
  });
  input.addEventListener('blur', function () {
    if (input.hidden) return;
    if (input.value.trim()) commitMemo();
    else closeMemo();
  });

  // ---- stamp ----------------------------------------------------------------

  function showResult(result) {
    if (!result || !result.ok) {
      showToast(result && result.error ? result.error : '処理に失敗しました', true);
      return false;
    }
    const prefix = result.native ? 'マーカーを打ちました ' : '保存しました ';
    const suffix = result.native ? '' : '（ローカル）';
    let message = prefix + TSLib.formatTimecode(result.record.offset_sec) + suffix;
    if (result.warning) message += '\n' + result.warning;
    showToast(message, false);
    return true;
  }

  // The time is taken at the press; the memo is typed afterwards and attached with updateMemo.
  async function stamp(pressedAt) {
    await commitMemo();
    button.disabled = true;
    try {
      const result = await send({ type: 'stamp', url: location.href, memo: '', pressedAt: pressedAt });
      if (result && showResult(result) && result.record && result.record.id) openMemo(result.record.id);
    } finally {
      button.disabled = false;
    }
  }

  // pointerdown on the button would blur the memo input first; prevent that so stamp() commits it in order.
  button.addEventListener('pointerdown', function (event) { event.preventDefault(); });
  button.addEventListener('click', function () {
    stamp(Date.now());
  });

  // Hotkey path: background already stamped; attach the memo input to that record.
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== 'toast') return;
    commitMemo().then(function () {
      const result = message.result;
      if (showResult(result) && result.record && result.record.id) openMemo(result.record.id);
    });
  });

  // ---- visibility / init ----------------------------------------------------

  function updateVisibility() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const visible = !!TSLib.channelFromUrl(lastUrl);
    panel.style.display = visible ? 'flex' : 'none';
    if (!visible && pendingId) commitMemo();
    if (visible) applyPosition();
  }

  if (contextAvailable()) {
    chrome.storage.local.get(POS_KEY).then(function (stored) {
      const value = stored && stored[POS_KEY];
      if (value && Number.isFinite(value.right) && Number.isFinite(value.bottom)) storedFractions = value;
      applyPosition();
    }).catch(function () {});
  }
  updateVisibility();
  setInterval(updateVisibility, 1000);
}());
