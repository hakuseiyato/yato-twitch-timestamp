'use strict';

const TSLib = (function () {
  const RESERVED_CHANNELS = new Set([
    '', 'directory', 'videos', 'settings', 'subscriptions', 'inventory',
    'wallet', 'drops', 'search', 'downloads', 'jobs', 'p', 'u', 'friends',
    'following', 'turbo', 'prime', 'store', 'bits', 'messages', 'payments',
    'broadcast', 'dashboard'
  ]);

  function validLogin(value) {
    const login = String(value || '').toLowerCase();
    return !RESERVED_CHANNELS.has(login) && /^[a-z0-9_]{1,25}$/.test(login) ? login : null;
  }

  function channelFromUrl(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host !== 'www.twitch.tv' && host !== 'twitch.tv') return null;
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length === 1) return validLogin(segments[0]);
      if (segments.length === 3 && segments[0].toLowerCase() === 'popout' &&
          segments[2].toLowerCase() === 'chat') return validLogin(segments[1]);
      if (segments.length >= 2 && segments[0].toLowerCase() === 'moderator') {
        return validLogin(segments[1]);
      }
      if (segments.length >= 3 && segments[0].toLowerCase() === 'popout' &&
          segments[1].toLowerCase() === 'moderator') return validLogin(segments[2]);
      return null;
    } catch (error) {
      return null;
    }
  }

  function computeOffsetSec(nowMs, startedAtIso, lagSec) {
    return Math.max(0, Math.round((nowMs - new Date(startedAtIso).getTime()) / 1000 - Number(lagSec || 0)));
  }

  function localOffsetSec(t0, clockSkewMs, startedAtIso, lagSec) {
    return computeOffsetSec(t0 + (Number(clockSkewMs) || 0), startedAtIso, lagSec);
  }

  function nativeOffsetSec(positionSeconds, tPostSentMs, t0, lagSec, fallbackSec) {
    const result = Number(positionSeconds) - (tPostSentMs - t0) / 1000 - Number(lagSec || 0);
    return Number.isFinite(result) ? Math.max(0, Math.round(result)) : fallbackSec;
  }

  function computeClockSkewMs(dateHeader, requestStartMs, responseEndMs) {
    if (!dateHeader) return 0;
    const serverMs = Date.parse(dateHeader);
    if (!Number.isFinite(serverMs)) return 0;
    return Math.round(serverMs - (requestStartMs + responseEndMs) / 2);
  }

  function formatTimecode(sec) {
    const value = Math.max(0, Math.round(Number(sec) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  function formatTimecodeFrames(t, fps) {
    const rawValue = Number(t);
    const value = Number.isFinite(rawValue) ? rawValue : 0;
    const negative = value < 0;
    const absolute = Math.abs(value);
    const wholeSeconds = Math.floor(absolute);
    const fraction = absolute - wholeSeconds;
    const frameRate = Number(fps);
    const validFrameRate = Number.isFinite(frameRate) && frameRate > 0;
    // The epsilon prevents floating-point error from turning 1.2s at 30fps into frame 5.
    const frame = validFrameRate ?
      Math.min(Math.floor(fraction * frameRate + 1e-6), Math.ceil(frameRate) - 1) : 0;
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const seconds = wholeSeconds % 60;
    const frameWidth = validFrameRate && frameRate >= 100 ? 3 : 2;
    return (negative ? '-' : '') + String(hours).padStart(2, '0') + ':' +
      String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + ':' +
      String(frame).padStart(frameWidth, '0');
  }

  function parseTimecodeFrames(str, fps) {
    const frameRate = Number(fps);
    if (typeof str !== 'string' || !Number.isFinite(frameRate) || frameRate <= 0) return NaN;
    const match = /^(-)?(\d+):(\d{1,2}):(\d{1,2}):(\d{1,3})$/.exec(str.trim());
    if (!match) return NaN;
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    const seconds = Number(match[4]);
    const frame = Number(match[5]);
    if (minutes >= 60 || seconds >= 60 || frame >= Math.ceil(frameRate)) return NaN;
    const value = hours * 3600 + minutes * 60 + seconds + frame / frameRate;
    if (value === 0) return 0;
    return match[1] ? -value : value;
  }

  // File name key for the thumbnail disk cache.
  function fnv1aHex(str) {
    const text = String(str);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function splitPremiereComment(comments) {
    const s = String(comments == null ? '' : comments);
    const tagPattern = /\s*\[yts:([0-9a-f]{8}|y[0-9a-f]{7})\]\s*$/;
    const tagMatch = tagPattern.exec(s);
    const id = tagMatch ? tagMatch[1] : null;
    const rest = tagMatch ? s.slice(0, tagMatch.index) : s;
    const index = rest.lastIndexOf('by:');
    const tail = index >= 0 ? rest.slice(index + 3) : '';
    const hasBy = index >= 0 && (index === 0 || /\s/.test(rest.charAt(index - 1))) &&
      tail.indexOf('\n') < 0 && tail.indexOf('\r') < 0 && tail.indexOf('[') < 0;
    const by = hasBy ? tail.replace(/^\s+|\s+$/g, '') : '';
    const userRaw = hasBy ? rest.slice(0, index) : rest;
    const user = userRaw.replace(/\s*\[yts:(?:[0-9a-f]{8}|y[0-9a-f]{7})\]/g, '')
      .replace(/^\s+|\s+$/g, '');
    return { user: user, by: by, hasBy: hasBy, id: id };
  }

  function buildPremiereComment(user, by, hasBy, id) {
    const u = String(user == null ? '' : user)
      .replace(/\s*\[yts:(?:[0-9a-f]{8}|y[0-9a-f]{7})\]/g, '')
      .replace(/^\s+|\s+$/g, '');
    const parts = [];
    if (u) parts.push(u);
    if (hasBy) parts.push('by: ' + String(by == null ? '' : by));
    let s = parts.join(' ');
    if (id) s = s ? s + ' [yts:' + id + ']' : '[yts:' + id + ']';
    return s;
  }

  function syncConfirmReasons(input) {
    const source = input || {};
    const plan = source.plan || {};
    const preview = Array.isArray(plan.preview) ? plan.preview : [];
    const appOps = Array.isArray(plan.appOps) ? plan.appOps : [];
    const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
    const parsedWarnings = Array.isArray(source.parsedWarnings) ? source.parsedWarnings : [];
    const reasons = [];
    if (plan.error) reasons.push(String(plan.error));
    if (plan.needsConfirm) reasons.push('大量削除');
    if (preview.some(function (row) { return row.kind === 'conflict'; })) reasons.push('競合');
    if (!source.entry || !source.entry.lastSyncAt) reasons.push('初回の同期');
    if (appOps.some(function (op) { return op.op === 'tag'; })) reasons.push('ID の付与');
    if (preview.filter(function (row) { return row.kind === 'add-app'; }).length >= 10) {
      reasons.push('アプリへの追加が多い');
    }
    if (parsedWarnings.length > 0 || warnings.length > 0 || Number(source.repaired) > 0) {
      reasons.push('警告あり');
    }
    // Syncs right after an import (CSV pick / DualPlayer conversion / merge) run without asking only for additions.
    if (source.afterImport && preview.some(function (row) { return row.kind !== 'add-app' && row.kind !== 'add-csv'; })) {
      reasons.push('取り込み後の変更');
    }
    return reasons;
  }

  function csvField(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[\",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function protectCsvFormula(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  }

  function restoreCsvFormula(value) {
    const text = String(value || '');
    return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
  }

  function toCsv(records) {
    const headers = ['id', 'timecode', 'offset_sec', 'by', 'memo', 'native', 'channel', 'stream_id', 'started_at', 'created_at', 'updated_at', 'deleted', 'clock_skew_ms'];
    const normalized = records.map(normalizeRecord);
    const sorted = normalized.map(function (record, index) { return { record: record, index: index }; })
      .sort(function (a, b) { return Number(a.record.offset_sec) - Number(b.record.offset_sec) || a.index - b.index; })
      .map(function (item) { return item.record; });
    const lines = [headers.join(',')];
    for (const record of sorted) {
      lines.push([
        record.id, formatTimecode(Math.floor(record.offset_sec)), round3(record.offset_sec), protectCsvFormula(record.by),
        protectCsvFormula(record.memo), Boolean(record.native), record.channel, record.stream_id,
        record.started_at, record.created_at || '', record.updated_at || '', Boolean(record.deleted),
        Number(record.clock_skew_ms) || 0
      ].map(csvField).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function parseCsvRows(text, delimiter) {
    const sep = delimiter || ',';
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let line = 1;
    let rowLine = 1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          field += ch;
          if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && text[i + 1] === '\n') {
              field += '\n';
              i += 1;
            }
            line += 1;
          }
        }
      } else if (ch === '"' && field === '') {
        quoted = true;
      } else if (ch === sep) {
        row.push(field);
        field = '';
      } else if (ch === '\r' || ch === '\n') {
        row.push(field);
        rows.push({ fields: row, line: rowLine });
        row = [];
        field = '';
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        line += 1;
        rowLine = line;
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push({ fields: row, line: rowLine });
    }
    return rows;
  }

  function parseCsv(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const rows = parseCsvRows(source).filter(function (row) {
      return row.fields.some(function (field) { return field !== ''; });
    });
    if (!rows.length) throw new Error('CSV にヘッダーがありません');
    const headers = rows.shift().fields.map(function (header) { return header.trim(); });
    const required = ['offset_sec', 'by', 'memo', 'stream_id'];
    for (const name of required) {
      if (headers.indexOf(name) < 0) throw new Error('必須ヘッダーがありません: ' + name);
    }
    const records = [];
    let skipped = 0;
    const skippedRows = [];
    const warnings = [];
    const warnedStreams = new Set();
    const pending = [];
    for (const rowInfo of rows) {
      const row = rowInfo.fields;
      const value = function (name) {
        const index = headers.indexOf(name);
        return index >= 0 && row[index] !== undefined ? row[index] : '';
      };
      const streamValue = value('stream_id');
      if ((/e\+/i.test(streamValue) || streamValue.indexOf('.') >= 0) && !warnedStreams.has(streamValue)) {
        warnedStreams.add(streamValue);
        warnings.push('stream_id が数値に変換されている可能性があります: ' + streamValue);
      }
      const rawOffset = value('offset_sec');
      const offsetSec = Number(rawOffset);
      if (rawOffset.trim() === '' || !Number.isFinite(offsetSec)) {
        skipped += 1;
        skippedRows.push(rowInfo.line);
        continue;
      }
      const rawClockSkew = Number(value('clock_skew_ms'));
      const record = {
        id: '',
        stream_id: streamValue,
        channel: value('channel'),
        started_at: value('started_at'),
        offset_sec: round3(offsetSec),
        created_at: value('created_at'),
        updated_at: value('updated_at'),
        deleted: value('deleted').toLowerCase() === 'true',
        clock_skew_ms: Number.isFinite(rawClockSkew) ? rawClockSkew : 0,
        by: restoreCsvFormula(value('by')),
        memo: restoreCsvFormula(value('memo')),
        native: value('native').toLowerCase() === 'true'
      };
      let rowRepaired = false;
      if (headers.indexOf('timecode') >= 0) {
        const timecode = value('timecode').trim();
        let match = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(timecode);
        let seconds = null;
        if (match) {
          seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        } else {
          match = /^([0-5]?\d):([0-5]\d)$/.exec(timecode);
          if (match) seconds = Number(match[1]) * 60 + Number(match[2]);
        }
        if (seconds !== null && seconds !== Math.floor(offsetSec)) {
          record.offset_sec = seconds;
          rowRepaired = true;
        }
      }
      const rawId = value('id');
      const id = isValidId(String(rawId || '').trim().toLowerCase()) ?
        String(rawId).trim().toLowerCase() : repairId(rawId);
      const candidateId = id || legacyId(record);
      if (candidateId !== rawId) rowRepaired = true;
      pending.push({ record: record, id: candidateId, repaired: rowRepaired });
    }
    const reservedIds = new Set(pending.map(function (item) { return item.id; }));
    const usedIds = new Set();
    let repaired = 0;
    for (const item of pending) {
      let id = item.id;
      if (usedIds.has(id)) {
        do { id = newId(); } while (usedIds.has(id) || reservedIds.has(id));
        reservedIds.add(id);
        item.repaired = true;
      }
      usedIds.add(id);
      item.record.id = id;
      records.push(normalizeRecord(item.record));
      if (item.repaired) repaired += 1;
    }
    return { records: records, skipped: skipped, skippedRows: skippedRows, repaired: repaired, warnings: warnings };
  }

  function recordKey(record) {
    return [record.stream_id, record.offset_sec, record.by, record.memo, record.created_at].join('|');
  }

  function round3(value) {
    return Math.round(Number(value) * 1000) / 1000;
  }

  function legacyId(record) {
    const text = recordKey(record);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'y' + hash.toString(16).padStart(8, '0').slice(1);
  }

  function newId() {
    let value;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      value = crypto.getRandomValues(new Uint32Array(1))[0] & 0x0fffffff;
    } else {
      value = Math.floor(Math.random() * 0x10000000);
    }
    return 'y' + (value >>> 0).toString(16).padStart(7, '0');
  }

  function isValidId(value) {
    return /^[0-9a-f]{8}$/.test(String(value || '')) || /^y[0-9a-f]{7}$/.test(String(value || ''));
  }

  function repairId(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (isValidId(value)) return value;
    return /^[0-9a-f]{1,7}$/.test(value) ? value.padStart(8, '0') : null;
  }

  function normalizeRecord(record) {
    const copy = Object.assign({}, record);
    copy.offset_sec = round3(copy.offset_sec);
    copy.id = isValidId(copy.id) ? copy.id : legacyId(copy);
    copy.updated_at = copy.updated_at || copy.created_at || '';
    copy.deleted = copy.deleted === true;
    return copy;
  }

  function mergeRecords() {
    const byId = new Map();
    let order = 0;
    for (let i = 0; i < arguments.length; i += 1) {
      const list = arguments[i] || [];
      for (const record of list) {
        const normalized = normalizeRecord(record);
        if (!byId.has(normalized.id)) {
          byId.set(normalized.id, { record: normalized, order: order++ });
        } else {
          const current = byId.get(normalized.id);
          const currentTime = Date.parse(current.record.updated_at);
          const nextTime = Date.parse(normalized.updated_at);
          if (Number.isFinite(nextTime) && (!Number.isFinite(currentTime) || nextTime > currentTime)) {
            current.record = normalized;
          }
        }
      }
    }
    return Array.from(byId.values()).sort(function (a, b) {
      return Number(a.record.offset_sec) - Number(b.record.offset_sec) || a.order - b.order;
    }).map(function (item) { return item.record; });
  }

  // 削除を墓標（deleted: true）にしたコピーを返す。他の列は変えない
  // Returns a copy turned into a tombstone (deleted: true); other columns are unchanged.
  function tombstoneRecord(record, nowIso) {
    return Object.assign({}, record, { deleted: true, updated_at: nowIso });
  }

  // 送信待ちの id を stream_id ごと・maxPerRequest 件ごとのバッチにする（並びは records の初出順）
  // Groups pending ids into batches per stream_id of at most maxPerRequest records (in first-appearance order of records).
  function planUpload(records, pendingIds, maxPerRequest) {
    const limit = Math.max(1, Math.floor(Number(maxPerRequest)) || 500);
    const pending = new Set(pendingIds || []);
    // 同じ id が複数あれば updated_at が新しい方 / For duplicate ids, the newer updated_at wins
    const latest = new Map();
    (records || []).forEach(function (record) {
      if (!record || !pending.has(record.id)) return;
      const current = latest.get(record.id);
      if (!current || Date.parse(record.updated_at) > Date.parse(current.updated_at)) latest.set(record.id, record);
    });
    const byStream = new Map();
    latest.forEach(function (record) {
      if (!byStream.has(record.stream_id)) byStream.set(record.stream_id, []);
      byStream.get(record.stream_id).push(record);
    });
    const batches = [];
    byStream.forEach(function (list, streamId) {
      for (let i = 0; i < list.length; i += limit) batches.push({ stream_id: streamId, records: list.slice(i, i + limit) });
    });
    return batches;
  }

  // サーバーの応答を送信キューに反映する。accepted と stale は送信済み、他の rejected は失敗として記録
  // Applies the server response to the upload queue: accepted and stale are done, other rejections are recorded as failures.
  function applyUploadResult(pendingIds, failed, sent, response) {
    const res = response || {};
    const done = new Set(res.accepted || []);
    const nextFailed = (failed || []).slice();
    const at = new Date().toISOString();
    (res.rejected || []).forEach(function (item) {
      done.add(item.id);
      if (item.reason === 'stale') return;
      const entry = { id: item.id, reason: item.reason, at: at };
      const index = nextFailed.findIndex(function (old) { return old.id === item.id; });
      if (index >= 0) nextFailed[index] = entry;
      else nextFailed.push(entry);
    });
    // sent のうち応答に出ない id は残す（done に入らないので消えない）
    // Sent ids missing from the response stay (they are not in done, so they are kept).
    return {
      pendingIds: (pendingIds || []).filter(function (id) { return !done.has(id); }),
      failed: nextFailed
    };
  }

  // 送信の失敗理由コードを表示用の文言にする。知らないコードはそのまま
  // Turns an upload failure code into display text; unknown codes are shown as is.
  const REASON_TEXT = {
    forbidden_tombstone: '他の人の記録は消せません',
    forbidden_channel: 'このチャンネルの会員ではありません',
    missing_stream: '配信情報がありません',
    invalid_time: '時刻が不正です',
    permission_required: 'サーバーへの送信が許可されていません',
    unauthorized: 'ログインが必要です',
    login_required: 'ログインが必要です',
    network: '通信できませんでした',
    // 200 だが本文が accepted / rejected の形でない / A 200 whose body lacks accepted / rejected
    http_200: 'サーバーの応答が不正です',
    internal: '拡張の内部エラー'
  };

  function reasonText(code) {
    const text = code === undefined || code === null ? '' : String(code);
    if (Object.prototype.hasOwnProperty.call(REASON_TEXT, text)) return REASON_TEXT[text];
    if (/^invalid_/.test(text)) return '記録の形式が不正です';
    // 5xx / 408 / 429 は一時的、それ以外の 4xx は拒否、残りは届かない
    // 5xx / 408 / 429 are temporary, other 4xx are rejections, anything else did not arrive.
    if (/^http_(5\d\d|408|429)$/.test(text)) return 'サーバーが一時的に応答しません';
    if (/^http_4\d\d$/.test(text)) return 'サーバーが要求を拒否しました (' + text + ')';
    if (/^http_\d+$/.test(text)) return 'サーバーに届きませんでした (' + text + ')';
    return text;
  }

  // 記録の送信状態: 失敗 > 送信待ち > 送信済（今のサーバーが受け取った） > 一度も送っていない
  // A record's sync state: failed > pending > sent (the current server took it) > never sent.
  function recordSyncState(id, pendingIds, failed, syncedIds) {
    if ((failed || []).some(function (entry) { return entry && entry.id === id; })) return 'failed';
    if ((pendingIds || []).indexOf(id) >= 0) return 'pending';
    if ((syncedIds || []).indexOf(id) >= 0) return 'sent';
    return 'unsent';
  }

  // 再送で直る見込みがある応答か（0 = ネットワーク例外 / 408 / 429 / 5xx）
  // Whether a retry may succeed (0 = network failure / 408 / 429 / 5xx).
  function isRetryableUpload(status) {
    const code = Number(status);
    return code === 0 || code === 408 || code === 429 || (code >= 500 && code <= 599);
  }

  function toBoolean(value) {
    return value === true || value === 1 || String(value).trim().toLowerCase() === 'true' || String(value).trim() === '1';
  }

  // サーバーの 13 列（StampRecord）に整形する / Shapes a record into the server's 13 columns (StampRecord)
  function toUploadRecord(record) {
    const offset = round3(record.offset_sec);
    return {
      id: record.id,
      timecode: formatTimecode(Math.floor(offset)),
      offset_sec: offset,
      by: record.by,
      memo: record.memo === undefined || record.memo === null ? '' : record.memo,
      native: toBoolean(record.native),
      channel: record.channel,
      stream_id: record.stream_id,
      started_at: record.started_at,
      created_at: record.created_at,
      updated_at: record.updated_at || record.created_at,
      deleted: toBoolean(record.deleted),
      clock_skew_ms: Number(record.clock_skew_ms) || 0
    };
  }

  // サーバー配信の鏡 CSV のパス（baseDir/server/<host>/<stream_id>_sync.csv）。host と stream_id の英数・_・-・. 以外は _ に
  // （host:port の : は Windows のフォルダ名に使えない）
  // Path of a server stream's mirror CSV; characters in host and stream_id other than alphanumerics, _, - and . become _
  // (the : of host:port is not allowed in Windows folder names).
  function serverMirrorPath(baseDir, serverUrl, streamId) {
    const base = String(baseDir || '').replace(/[\\/]+$/, '');
    const host = new URL(serverUrl).host.replace(/[^A-Za-z0-9_.-]/g, '_');
    // . や .. のフォルダ名はフォルダ移動になる / Folder names like . or .. would move between folders
    if (/^\.+$/.test(host)) throw new Error('サーバー URL のホスト名が不正です');
    const safeId = String(streamId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
    return base + '/server/' + host + '/' + safeId + '_sync.csv';
  }

  // 前回 push より後に変わった記録を送信形（toUploadRecord）で返す。lastPushAt が空・不正なら全件
  // Returns records changed after the last push, shaped by toUploadRecord; all of them when lastPushAt is empty or invalid.
  function recordsToPush(records, lastPushAt) {
    const since = Date.parse(lastPushAt || '');
    return (records || []).filter(function (record) {
      if (!record) return false;
      if (!Number.isFinite(since)) return true;
      const at = Date.parse(record.updated_at || record.created_at || '');
      // 時刻が読めない記録は送る（サーバー側で invalid_time になる）/ Unreadable times are sent (the server rejects them)
      return !Number.isFinite(at) || at > since;
    }).map(toUploadRecord);
  }

  // サーバーの記録を鏡 CSV の記録に取り込む（updated_at が新しい方が勝つ）。changed は追加 + 更新の件数
  // Merges server records into the mirror's records (newer updated_at wins); changed counts additions and updates.
  // opts.forceIds: ローカルが墓標・サーバーが生存なら、墓標の方が新しくてもサーバーの記録にする（直前の push で forbidden_tombstone だった id）
  // opts.forceIds: when local is a tombstone and the server's record is live, take the server's even if the tombstone is newer
  // (ids rejected as forbidden_tombstone by the last push).
  function mergeServerRecords(localRecords, serverRecords, opts) {
    const force = new Set((opts && opts.forceIds) || []);
    let base = localRecords || [];
    if (force.size) {
      const serverLive = new Set(mergeRecords(serverRecords || []).filter(function (record) { return !record.deleted; })
        .map(function (record) { return record.id; }));
      const drop = new Set(mergeRecords(base).filter(function (record) {
        return record.deleted && force.has(record.id) && serverLive.has(record.id);
      }).map(function (record) { return record.id; }));
      base = base.filter(function (record) { return !drop.has(normalizeRecord(record).id); });
    }
    const records = mergeRecords(base, serverRecords || []);
    const localById = new Map();
    (localRecords || []).forEach(function (record) {
      const normalized = normalizeRecord(record);
      localById.set(normalized.id, normalized);
    });
    let changed = 0;
    records.forEach(function (record) {
      const local = localById.get(record.id);
      if (!local || local.updated_at !== record.updated_at) changed += 1;
    });
    return { records: records, changed: changed };
  }

  // パネルの push 結果を振り分ける。accepted と stale は成功、他の rejected は失敗、forbidden_tombstone は次の pull でサーバーの記録に戻す
  // Sorts a panel push result: accepted and stale succeed, other rejections fail, forbidden_tombstone ids are restored from the server on the next pull.
  function applyPanelPushResult(result) {
    const res = result || {};
    const applied = applyUploadResult([], [], null, res);
    const okIds = (res.accepted || []).concat((res.rejected || []).filter(function (item) { return item.reason === 'stale'; })
      .map(function (item) { return item.id; }));
    return {
      okIds: okIds,
      failed: applied.failed.map(function (item) { return { id: item.id, reason: item.reason }; }),
      forcePull: applied.failed.filter(function (item) { return item.reason === 'forbidden_tombstone'; })
        .map(function (item) { return item.id; })
    };
  }

  // 次の lastPushAt。応答が揃った（throw しなかった）ときだけ push の開始時刻へ進める（送信中の編集を取りこぼさない）。
  // throw したら retryable でもそうでなくても前の値のまま（次回まとめて送り直す。届いていた分は stale で返る）
  // The next lastPushAt: advance to the push start time only when a full response came back (edits made during the push are not skipped).
  // After a throw, retryable or not, keep the previous value (everything is resent next time; what already arrived comes back as stale).
  function nextPushAt(result, startedAtIso, previousIso) {
    const ok = !!result && Array.isArray(result.accepted) && Array.isArray(result.rejected);
    return ok ? startedAtIso : (previousIso || '');
  }

  // 鏡 CSV の横に置く <stream_id>.server.json の形か / Whether obj has the shape of a mirror's <stream_id>.server.json
  function isServerMeta(obj) {
    const nonEmpty = function (value) { return typeof value === 'string' && value !== ''; };
    return !!obj && typeof obj === 'object' && nonEmpty(obj.serverUrl) && nonEmpty(obj.stream_id) && nonEmpty(obj.channel);
  }

  function groupByStream(records) {
    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.stream_id)) {
        groups.set(record.stream_id, {
          stream_id: record.stream_id,
          channel: record.channel || '',
          started_at: record.started_at || '',
          records: [],
          allRecords: []
        });
      }
      const group = groups.get(record.stream_id);
      if (!group.channel && record.channel) group.channel = record.channel;
      if (!group.started_at && record.started_at) group.started_at = record.started_at;
      group.allRecords.push(record);
    }
    return Array.from(groups.values()).map(function (group) {
      group.allRecords = mergeRecords(group.allRecords);
      group.records = group.allRecords.filter(function (record) { return !record.deleted; });
      return group;
    }).sort(function (a, b) {
      const aTime = Date.parse(a.started_at);
      const bTime = Date.parse(b.started_at);
      const aValid = Number.isFinite(aTime);
      const bValid = Number.isFinite(bTime);
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      if (!aValid && !bValid) return 0;
      return bTime - aTime;
    });
  }

  function markerTolerance(fps) {
    return 0.5 / (typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 30);
  }

  function sameMarkers(left, right, fps) {
    const a = left || [];
    const b = right || [];
    if (a.length !== b.length) return false;
    const tolerance = markerTolerance(fps);
    const markerId = function (value) { return value === null || value === undefined || value === '' ? null : value; };
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].index !== b[i].index || markerId(a[i].id) !== markerId(b[i].id) ||
          a[i].memo !== b[i].memo) return false;
      const aFinite = typeof a[i].t === 'number' && Number.isFinite(a[i].t);
      const bFinite = typeof b[i].t === 'number' && Number.isFinite(b[i].t);
      if (aFinite !== bFinite) return false;
      if (aFinite && Math.abs(a[i].t - b[i].t) > tolerance + 1e-9) return false;
    }
    return true;
  }

  function appMemo(rawName, record, t, baseEntry, userOffset) {
    const memo = rawName === null || rawName === undefined ? '' : String(rawName);
    if (record && memo === formatTimecode(Math.floor(record.offset_sec))) return '';
    if (memo === formatTimecode(Math.floor(t - userOffset))) return '';
    if (baseEntry && baseEntry.autoName && /^\d+:\d{2}:\d{2}$/.test(memo)) return '';
    return memo;
  }

  function baseFromMarkers(input) {
    const source = input || {};
    const records = mergeRecords(source.records || []);
    const byId = new Map();
    for (const record of records) {
      if (record.stream_id === source.streamId && !record.deleted) byId.set(record.id, record);
    }
    const excluded = new Set(source.excludeIds || []);
    const previousBase = source.previousBase || {};
    const userOffset = Number.isFinite(source.userOffset) ? source.userOffset : 0;
    const seen = new Set();
    const base = {};
    for (const marker of source.appMarkers || []) {
      const id = marker.id;
      if (id === null || id === undefined || id === '' || seen.has(id) || excluded.has(id)) continue;
      seen.add(id);
      if (typeof marker.t !== 'number' || !Number.isFinite(marker.t)) {
        if (previousBase[id]) base[id] = Object.assign({}, previousBase[id]);
        continue;
      }
      const record = byId.get(id);
      if (!record) continue;
      const memo = appMemo(marker.memo, record, marker.t, previousBase[id], userOffset);
      base[id] = { t: marker.t, memo: memo, autoName: memo === '' };
    }
    return base;
  }

  function finalizeRecords(plan, failedIds) {
    const failed = new Set(failedIds || []);
    const tagIds = new Set((plan.appOps || []).filter(function (op) {
      return op.op === 'tag' && failed.has(op.id);
    }).map(function (op) { return op.id; }));
    return (plan.records || []).filter(function (record) { return !tagIds.has(record.id); });
  }

  function applyNudges(records, nudged, userOffset, now) {
    const byId = new Map((nudged || []).map(function (item) { return [item.id, item.to]; }));
    const offset = Number.isFinite(userOffset) ? userOffset : 0;
    return (records || []).map(function (record) {
      if (!byId.has(record.id)) return Object.assign({}, record);
      return Object.assign({}, record, { offset_sec: round3(byId.get(record.id) - offset), updated_at: now });
    });
  }

  function recordSignature(record) {
    if (!record) return '';
    const value = normalizeRecord(record);
    return [value.id, value.offset_sec, value.by, value.memo, value.native, value.channel,
      value.stream_id, value.started_at, value.created_at, value.updated_at, value.deleted,
      value.clock_skew_ms].join('\u0001');
  }

  // ---- foreign CSV formats ----------------------------------------------------

  function headerFields(text) {
    // First non-empty row, using the same filter as parseCsv (Excel can insert a blank or comma-only first line).
    const source = String(text || '').replace(/^﻿/, '');
    const firstRow = parseCsvRows(source).find(function (row) {
      return row.fields.some(function (field) { return field !== ''; });
    });
    const firstLine = firstRow ? source.split(/\r?\n/)[firstRow.line - 1] || '' : '';
    const delimiter = firstLine.indexOf('\t') >= 0 && firstLine.indexOf(',') < 0 ? '\t' : ',';
    const rows = parseCsvRows(firstLine, delimiter);
    return { delimiter: delimiter, headers: rows.length ? rows[0].fields.map(function (h) { return h.trim(); }) : [] };
  }

  // 'sync' (this tool's format), 'dualplayer' (DualPlayer's Timecode/Seconds/Note export, comma or tab), or 'unknown'.
  function detectCsvFormat(text) {
    const info = headerFields(text);
    if (info.headers.indexOf('offset_sec') >= 0) return { format: 'sync', delimiter: ',' };
    if (['Timecode', 'Seconds', 'Note'].every(function (h) { return info.headers.indexOf(h) >= 0; })) {
      return { format: 'dualplayer', delimiter: info.delimiter };
    }
    return { format: 'unknown', delimiter: info.delimiter };
  }

  // Converts an old DualPlayer export (Timecode, Seconds, Note, Has Screenshot, Thumbnail) into sync-file rows.
  // The id is derived from stream + time, so re-exporting the same stamps yields the same ids (memo edits merge as updates).
  function convertDualPlayer(text, options) {
    const opts = options || {};
    const delimiter = opts.delimiter || detectCsvFormat(text).delimiter;
    const rows = parseCsvRows(String(text || '').replace(/^﻿/, ''), delimiter).filter(function (row) {
      return row.fields.some(function (field) { return field !== ''; });
    });
    if (!rows.length) throw new Error('CSV にヘッダーがありません');
    const headers = rows.shift().fields.map(function (h) { return h.trim(); });
    const col = function (row, name) { const i = headers.indexOf(name); return i >= 0 && row[i] !== undefined ? row[i] : ''; };
    const stamp = opts.updatedAt || new Date().toISOString();
    const records = [];
    const skippedRows = [];
    const perMs = new Map();
    for (const rowInfo of rows) {
      const raw = col(rowInfo.fields, 'Seconds').trim();
      const seconds = Number(raw);
      if (raw === '' || !Number.isFinite(seconds) || seconds < 0) { skippedRows.push(rowInfo.line); continue; }
      const ms = Math.round(seconds * 1000);
      // Several stamps at the same millisecond (e.g. notes added while paused) get distinct, row-order-stable ids.
      const n = perMs.get(ms) || 0;
      perMs.set(ms, n + 1);
      records.push(normalizeRecord({
        id: 'y' + fnv1aHex(String(opts.streamId) + '|' + ms + (n ? '|' + n : '')).slice(1),
        offset_sec: ms / 1000,
        by: 'dualplayer',
        memo: col(rowInfo.fields, 'Note'),
        native: false,
        channel: opts.channel || '',
        stream_id: opts.streamId,
        started_at: '',
        created_at: stamp,
        updated_at: stamp,
        deleted: false,
        clock_skew_ms: 0
      }));
    }
    return { records: mergeRecords(records), skipped: skippedRows.length, skippedRows: skippedRows };
  }

  function dualPlayerStreamId(folderPath) {
    return 'dual-' + fnv1aHex(String(folderPath || '').replace(/\\/g, '/').toLowerCase());
  }

  // Stable stream id for a sync file created from an Adobe sequence/comp (no Twitch stream behind it).
  function localStreamId(projectPath, targetId) {
    return 'local-' + fnv1aHex(String(projectPath || '') + '|' + String(targetId || ''));
  }

  // Builds the rows of a brand-new sync CSV from the markers of the active sequence/comp.
  // Untagged markers (and later duplicates of an id) get a new id plus a 'tag' op for ytsApply.
  function recordsFromMarkers(input) {
    const source = input || {};
    const now = source.now || new Date().toISOString();
    const records = [];
    const tagOps = [];
    const seen = new Set();
    for (const marker of source.appMarkers || []) {
      if (typeof marker.t !== 'number' || !Number.isFinite(marker.t) || marker.t < 0) continue;
      let id = isValidId(marker.id) && !seen.has(marker.id) ? marker.id : '';
      if (!id) {
        do { id = newId(); } while (seen.has(id));
        tagOps.push({ op: 'tag', id: id, t: marker.t, appT: marker.t, index: marker.index });
      }
      seen.add(id);
      records.push(normalizeRecord({
        id: id,
        offset_sec: marker.t,
        by: marker.by || source.by || '',
        memo: appMemo(marker.memo, null, marker.t, null, 0),
        native: false,
        channel: source.channel || '',
        stream_id: source.streamId,
        started_at: '',
        created_at: now,
        updated_at: now,
        deleted: false,
        clock_skew_ms: 0
      }));
    }
    return { records: mergeRecords(records), tagOps: tagOps };
  }

  // File name for an exported marker frame: "HH-MM-SS-FF_<name>.png", safe on Windows.
  function frameFileName(t, fps, name) {
    const tc = formatTimecodeFrames(t, fps).replace(/:/g, '-');
    const safe = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
      .trim();
    // Cut by characters, not UTF-16 units, so an emoji is never split in half.
    const short = Array.from(safe).slice(0, 60).join('').replace(/[\s.]+$/, '');
    return tc + (short ? '_' + short : '') + '.png';
  }

  // Merges other CSVs (e.g. moderators' exports) into the sync file's records.
  // Same rules as mergeRecords; the counts compare the result with the original sync records.
  function mergeIntoSync(syncRecords, incomingLists) {
    // Import rules (merging other CSVs / converted DualPlayer exports into the sync file):
    // - a tombstone in the sync file is never changed or revived by an import;
    // - DualPlayer rows carry the export file's time, not a per-row edit time, so they only replace a row
    //   that is still exactly as imported (by dualplayer, never edited: updated_at === created_at);
    // - the same id under a different stream is re-keyed to a stable new id instead of overwriting;
    // - otherwise the later updated_at wins, and identical content keeps the original row.
    const result = new Map();
    const original = new Map();
    mergeRecords(syncRecords || []).forEach(function (record) {
      original.set(record.id, record);
      result.set(record.id, record);
    });
    const contentOf = function (record) {
      return recordSignature(Object.assign({}, record, { created_at: '', updated_at: '' }));
    };
    let keptEdited = 0;
    let rekeyed = 0;
    (incomingLists || []).forEach(function (list) {
      mergeRecords(list || []).forEach(function (incoming) {
        let row = incoming;
        let prior = result.get(row.id);
        if (prior && prior.stream_id !== row.stream_id) {
          let salt = 0;
          let id;
          do {
            id = 'y' + fnv1aHex(String(row.stream_id) + '|' + incoming.id + '|' + salt).slice(1);
            salt += 1;
          } while (result.has(id) && result.get(id).stream_id !== row.stream_id);
          row = Object.assign({}, row, { id: id, rekeyed: true });
          prior = result.get(id);
        }
        const take = function () {
          if (row.rekeyed) { rekeyed += 1; row = Object.assign({}, row); delete row.rekeyed; }
          result.set(row.id, row);
        };
        if (!prior) { take(); return; }
        if (contentOf(prior) === contentOf(row)) return;
        // Only a tombstone that was already in the sync file is protected; between incoming files later-wins decides,
        // so the result does not depend on the order the files were selected in.
        if (original.has(row.id) && original.get(row.id).deleted) { keptEdited += 1; return; }
        if (row.by === 'dualplayer' && !(prior.by === 'dualplayer' && prior.updated_at === prior.created_at)) {
          keptEdited += 1;
          return;
        }
        const priorTime = Date.parse(prior.updated_at);
        const rowTime = Date.parse(row.updated_at);
        if (Number.isFinite(rowTime) && (!Number.isFinite(priorTime) || rowTime > priorTime)) take();
      });
    });
    const records = mergeRecords(Array.from(result.values()));
    let added = 0;
    let updated = 0;
    records.forEach(function (record) {
      if (!original.has(record.id)) added += 1;
      else if (recordSignature(original.get(record.id)) !== recordSignature(record)) updated += 1;
    });
    return { records: records, added: added, updated: updated, unchanged: records.length - added - updated,
      keptEdited: keptEdited, rekeyed: rekeyed };
  }

  function mergeFresh(input) {
    const source = input || {};
    const snapshot = mergeRecords(source.snapshot || []);
    const planned = mergeRecords(source.planned || []);
    const fresh = mergeRecords(source.fresh || []);
    const maps = [snapshot, planned, fresh].map(function (records) {
      return new Map(records.map(function (record) { return [record.id, record]; }));
    });
    const ids = [];
    const seen = new Set();
    for (const records of [snapshot, planned, fresh]) {
      for (const record of records) {
        if (!seen.has(record.id)) {
          seen.add(record.id);
          ids.push(record.id);
        }
      }
    }
    const result = [];
    const conflicts = [];
    for (const id of ids) {
      const snapshotRecord = maps[0].get(id);
      const plannedRecord = maps[1].get(id);
      const freshRecord = maps[2].get(id);
      const snapshotSignature = recordSignature(snapshotRecord);
      const plannedSignature = recordSignature(plannedRecord);
      const freshSignature = recordSignature(freshRecord);
      const plannedChanged = plannedSignature !== snapshotSignature;
      const freshChanged = freshSignature !== snapshotSignature;
      if (plannedChanged && freshChanged && plannedSignature !== freshSignature) conflicts.push(id);
      const chosen = plannedChanged ? plannedRecord : freshRecord;
      if (chosen) result.push(chosen);
    }
    return { records: mergeRecords(result), conflicts: conflicts };
  }

  function syncPlan(input) {
    const source = input || {};
    const streamId = source.streamId;
    const target = source.target || null;
    const targetOffset = target && typeof target.userOffset === 'number' ? target.userOffset : NaN;
    const inputOffset = typeof source.userOffset === 'number' ? source.userOffset : NaN;
    const userOffset = Number.isFinite(inputOffset) ? inputOffset :
      (Number.isFinite(targetOffset) ? targetOffset : 0);
    const tolerance = markerTolerance(source.fps);
    const now = source.now || '';
    const choices = source.choices || {};
    const base = target && target.base ? target.base : {};
    const normalizedInput = (source.records || []).map(normalizeRecord);
    const allRecords = mergeRecords(normalizedInput);
    if (Object.keys(base).length > 0 && !normalizedInput.some(function (record) { return record.stream_id === streamId; })) {
      return {
        error: 'この配信の行が CSV に見つかりません（stream_id が Excel で変換された可能性があります）',
        records: allRecords, appOps: [], preview: [], conflicts: [], base: base,
        csvChanged: false, appChanged: false, needsConfirm: false, deleteCount: 0, warnings: []
      };
    }
    const streamRecords = new Map();
    const existingIds = new Set();
    const idsInOtherStreams = new Set();
    let streamTemplate = null;
    for (const record of normalizedInput) {
      existingIds.add(record.id);
      if (record.stream_id !== streamId) idsInOtherStreams.add(record.id);
    }
    for (const record of allRecords) {
      if (record.stream_id === streamId) {
        streamRecords.set(record.id, record);
        if (!streamTemplate) streamTemplate = record;
      }
    }
    // CSV にこの配信の行が無ければ呼び出し側の {channel, started_at} を使う（スタンプ 0 件のサーバー配信）
    // Without rows of this stream in the CSV, use the caller's {channel, started_at} (a server stream with zero stamps).
    if (!streamTemplate && source.streamTemplate) streamTemplate = source.streamTemplate;
    const crossStreamOnly = new Set();
    for (const id of idsInOtherStreams) {
      if (!streamRecords.has(id)) crossStreamOnly.add(id);
    }
    const sameTime = function (left, right) {
      return Math.abs(Number(left) - Number(right)) <= tolerance + 1e-9;
    };
    const markerValue = function (marker, record) {
      return { t: marker.t, memo: appMemo(marker.memo, record, marker.t, base[marker.id], userOffset) };
    };
    const recordValue = function (record) {
      return { t: Number(record.offset_sec) + userOffset, memo: record.memo || '' };
    };
    const differs = function (left, right) {
      return !sameTime(left.t, right.t) || left.memo !== right.memo;
    };
    const updateKind = function (from, to) { return sameTime(from.t, to.t) ? 'memo' : 'move'; };
    const appOperation = function (op, record, marker) {
      const operation = {
        op: op, id: record.id, t: Number(record.offset_sec) + userOffset,
        memo: record.memo || '', by: record.by, native: record.native,
        timecode: formatTimecode(Math.floor(record.offset_sec))
      };
      if (marker) {
        operation.index = marker.index;
        operation.appT = marker.t;
      }
      return operation;
    };

    const markers = source.appMarkers || [];
    const excludedIds = new Set();
    let unreadableCount = 0;
    for (const marker of markers) {
      if (typeof marker.t !== 'number' || !Number.isFinite(marker.t)) {
        unreadableCount += 1;
        if (marker.id !== null && marker.id !== undefined && marker.id !== '') excludedIds.add(marker.id);
      }
    }
    const warnings = unreadableCount > 0 ? ['時刻を読めないマーカーがあります（' + unreadableCount + ' 件）'] : [];
    const tagged = new Map();
    const untagged = [];
    for (const marker of markers) {
      if (typeof marker.t !== 'number' || !Number.isFinite(marker.t) || excludedIds.has(marker.id)) continue;
      const noId = marker.id === null || marker.id === undefined || marker.id === '';
      if (noId || crossStreamOnly.has(marker.id) || tagged.has(marker.id)) untagged.push(marker);
      else tagged.set(marker.id, marker);
    }

    const appOps = [];
    const preview = [];
    const conflicts = [];
    let csvChanged = false;
    const finalApp = new Map();
    for (const entry of tagged) finalApp.set(entry[0], markerValue(entry[1], streamRecords.get(entry[0])));
    const ids = [];
    const seenIds = new Set();
    const addId = function (id) {
      if (!seenIds.has(id) && !excludedIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
    };
    for (const id of streamRecords.keys()) addId(id);
    for (const id of tagged.keys()) addId(id);

    for (const id of ids) {
      let record = streamRecords.get(id);
      const marker = tagged.get(id);
      const history = base[id];
      const csvValue = record ? recordValue(record) : null;
      const appValue = marker ? markerValue(marker, record) : null;
      if (record && record.deleted) {
        if (marker) {
          appOps.push({ op: 'delete', id: id, t: appValue.t, appT: marker.t, memo: appValue.memo,
            by: marker.by, native: marker.native, timecode: formatTimecode(Math.floor(appValue.t - userOffset)), index: marker.index });
          preview.push({ kind: 'delete-app', id: id, from: appValue, to: null, source: 'csv' });
          finalApp.delete(id);
        }
        continue;
      }
      if (record && marker && history) {
        const csvChangedSinceBase = differs(csvValue, history);
        const appChangedSinceBase = differs(appValue, history);
        if (csvChangedSinceBase && appChangedSinceBase && differs(csvValue, appValue)) {
          const winner = choices[id] === 'csv' ? 'csv' : 'app';
          conflicts.push(id);
          preview.push({ kind: 'conflict', id: id, from: csvValue, to: appValue, source: winner });
          if (winner === 'app') {
            record = Object.assign({}, record, { offset_sec: round3(appValue.t - userOffset), memo: appValue.memo, updated_at: now });
            streamRecords.set(id, record);
            csvChanged = true;
          } else {
            appOps.push(appOperation('update', record, marker));
            finalApp.set(id, csvValue);
          }
        } else if (appChangedSinceBase && !csvChangedSinceBase) {
          record = Object.assign({}, record, { offset_sec: round3(appValue.t - userOffset), memo: appValue.memo, updated_at: now });
          streamRecords.set(id, record);
          csvChanged = true;
          preview.push({ kind: updateKind(csvValue, appValue), id: id, from: csvValue, to: appValue, source: 'app' });
        } else if (csvChangedSinceBase && !appChangedSinceBase) {
          appOps.push(appOperation('update', record, marker));
          finalApp.set(id, csvValue);
          preview.push({ kind: updateKind(appValue, csvValue), id: id, from: appValue, to: csvValue, source: 'csv' });
        }
      } else if (record && marker) {
        if (differs(csvValue, appValue)) {
          const winner = choices[id] === 'app' ? 'app' : 'csv';
          conflicts.push(id);
          preview.push({ kind: 'conflict', id: id, from: csvValue, to: appValue, source: winner });
          if (winner === 'app') {
            record = Object.assign({}, record, { offset_sec: round3(appValue.t - userOffset), memo: appValue.memo, updated_at: now });
            streamRecords.set(id, record);
            csvChanged = true;
          } else {
            appOps.push(appOperation('update', record, marker));
            finalApp.set(id, csvValue);
          }
        }
      } else if (record && history) {
        record = Object.assign({}, record, { deleted: true, updated_at: now });
        streamRecords.set(id, record);
        csvChanged = true;
        preview.push({ kind: 'delete-csv', id: id, from: csvValue, to: null, source: 'app' });
        finalApp.delete(id);
      } else if (record) {
        appOps.push(appOperation('create', record, null));
        finalApp.set(id, csvValue);
        preview.push({ kind: 'add-app', id: id, from: null, to: csvValue, source: 'csv' });
      } else if (marker && history) {
        appOps.push({ op: 'delete', id: id, t: appValue.t, appT: marker.t, memo: appValue.memo,
          by: marker.by, native: marker.native, timecode: formatTimecode(Math.floor(appValue.t - userOffset)), index: marker.index });
        finalApp.delete(id);
        preview.push({ kind: 'delete-app', id: id, from: appValue, to: null, source: 'csv' });
      } else if (marker) {
        record = normalizeRecord({ id: id, stream_id: streamId,
          channel: streamTemplate ? streamTemplate.channel || '' : '',
          started_at: streamTemplate ? streamTemplate.started_at || '' : '',
          offset_sec: round3(appValue.t - userOffset), created_at: now, updated_at: now,
          clock_skew_ms: 0, by: source.hostName || '', memo: appValue.memo, native: false, deleted: false });
        streamRecords.set(record.id, record);
        existingIds.add(record.id);
        finalApp.set(record.id, appValue);
        csvChanged = true;
        preview.push({ kind: 'add-csv', id: record.id, from: null, to: appValue, source: 'app' });
      }
    }

    if (source.addUntagged) {
      for (const marker of untagged) {
        let id = newId();
        while (existingIds.has(id)) id = newId();
        existingIds.add(id);
        const appValue = { t: marker.t, memo: appMemo(marker.memo, null, marker.t, null, userOffset) };
        const record = normalizeRecord({ id: id, stream_id: streamId,
          channel: streamTemplate ? streamTemplate.channel || '' : '',
          started_at: streamTemplate ? streamTemplate.started_at || '' : '',
          offset_sec: round3(appValue.t - userOffset), created_at: now, updated_at: now,
          clock_skew_ms: 0, by: source.hostName || '', memo: appValue.memo, native: false, deleted: false });
        streamRecords.set(id, record);
        finalApp.set(id, appValue);
        csvChanged = true;
        appOps.push({ op: 'tag', id: id, t: marker.t, appT: marker.t, memo: appValue.memo,
          by: record.by, native: false, timecode: formatTimecode(Math.floor(record.offset_sec)), index: marker.index });
        preview.push({ kind: 'add-csv', id: id, from: null, to: appValue, source: 'app' });
      }
    }

    const updatedRecords = allRecords.filter(function (record) { return record.stream_id !== streamId; })
      .concat(Array.from(streamRecords.values()));
    const mergedRecords = mergeRecords(updatedRecords);
    const newBase = {};
    for (const record of mergedRecords) {
      if (record.stream_id !== streamId || record.deleted || !finalApp.has(record.id)) continue;
      const value = finalApp.get(record.id);
      newBase[record.id] = { t: value.t, memo: value.memo, autoName: value.memo === '' };
    }
    for (const id of excludedIds) {
      if (base[id]) newBase[id] = Object.assign({}, base[id]);
    }
    const opOrder = { tag: 0, update: 1, delete: 2, create: 3 };
    appOps.sort(function (a, b) { return opOrder[a.op] - opOrder[b.op]; });
    preview.sort(function (a, b) {
      const aValue = a.to || a.from;
      const bValue = b.to || b.from;
      return Number(aValue.t) - Number(bValue.t);
    });
    const deleteCount = preview.filter(function (row) {
      return row.kind === 'delete-app' || row.kind === 'delete-csv';
    }).length;
    const baseSize = Object.keys(base).length;
    return {
      error: null, records: mergedRecords, appOps: appOps, preview: preview, conflicts: conflicts,
      base: newBase, csvChanged: csvChanged, appChanged: appOps.length > 0,
      needsConfirm: deleteCount >= 3 && deleteCount * 2 >= baseSize,
      deleteCount: deleteCount, warnings: warnings
    };
  }

  function fileStamp(startedAtIso) {
    if (!startedAtIso) return 'unknown';
    const date = new Date(startedAtIso);
    if (!Number.isFinite(date.getTime())) return 'unknown';
    const pad = function (value) { return String(value).padStart(2, '0'); };
    return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes());
  }

  // Floating widget position, stored as fractions of the gap to the right/bottom edges
  // so the widget stays near the same corner when the window is resized.
  const WIDGET_MARGIN = 4;

  function posToFractions(left, top, width, height, viewWidth, viewHeight) {
    const right = Math.max(0, viewWidth - left - width);
    const bottom = Math.max(0, viewHeight - top - height);
    return {
      right: viewWidth > 0 ? right / viewWidth : 0,
      bottom: viewHeight > 0 ? bottom / viewHeight : 0
    };
  }

  function fractionsToPos(fractions, width, height, viewWidth, viewHeight) {
    const clamp = function (value, max) { return Math.min(Math.max(value, WIDGET_MARGIN), Math.max(WIDGET_MARGIN, max)); };
    const fr = fractions || {};
    const rightFr = Number.isFinite(fr.right) ? fr.right : 0;
    const bottomFr = Number.isFinite(fr.bottom) ? fr.bottom : 0;
    return {
      left: clamp(viewWidth - width - rightFr * viewWidth, viewWidth - width - WIDGET_MARGIN),
      top: clamp(viewHeight - height - bottomFr * viewHeight, viewHeight - height - WIDGET_MARGIN)
    };
  }

  // 見どころ候補は memo の先頭だけで見分ける。書くときは半角コロンの '候補:'
  // Highlight candidates are identified only by the memo prefix; writers use the ASCII colon '候補:'.
  const CANDIDATE_PREFIX = '候補:';
  // 読むときは IME で入る全角コロン '候補：' も候補とみなす（先頭の空白は無視）
  // Readers also accept the full-width colon '候補：' typed via IME (leading whitespace ignored).
  const CANDIDATE_PATTERN = /^\s*候補[:：]\s*/;

  // memo が候補の印で始まるか / Whether the memo starts with the candidate prefix.
  function isCandidate(memo) {
    return CANDIDATE_PATTERN.test(String(memo || ''));
  }

  // Web でスタンプを消せるか: 付けた本人（大文字小文字を無視）・そのチャンネルの owner・site_admin。墓標は不可
  // Whether a stamp can be deleted from the web: its author (case-insensitive), an owner of the channel, or a site admin; never a tombstone.
  function canDeleteStamp(me, channel, stamp) {
    if (!me || !stamp || stamp.deleted === true) return false;
    if (String(stamp.by || '').toLowerCase() === String(me.login || '').toLowerCase()) return true;
    if (me.site_admin === true) return true;
    return (me.channels || []).some(function (c) { return c && c.login === channel && c.role === 'owner'; });
  }

  // sort 用: 候補を先に、同じ区分なら offset_sec 昇順、同値なら id 昇順
  // Sort comparator: candidates first, then offset_sec ascending, then id ascending.
  function candidateFirst(a, b) {
    const rank = Number(isCandidate(b.memo)) - Number(isCandidate(a.memo));
    if (rank) return rank;
    const offset = Number(a.offset_sec) - Number(b.offset_sec);
    if (offset) return offset;
    const idA = String(a.id || '');
    const idB = String(b.id || '');
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  }

  // Short 用 Sequence 名: Short_NN_本文（本文は候補の印と ' | ' 以降を除き、使えない文字を消して 20 文字まで）
  // Short sequence name: Short_NN_body (body drops the candidate prefix and everything from ' | ', strips unsafe characters, max 20 chars).
  function shortSequenceName(memo, n) {
    const body = String(memo || '')
      .replace(CANDIDATE_PATTERN, '')
      .split(' | ')[0]
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20);
    const name = 'Short_' + String(n).padStart(2, '0');
    return body ? name + '_' + body : name;
  }

  return {
    CANDIDATE_PREFIX: CANDIDATE_PREFIX,
    CANDIDATE_PATTERN: CANDIDATE_PATTERN,
    isCandidate: isCandidate,
    canDeleteStamp: canDeleteStamp,
    candidateFirst: candidateFirst,
    shortSequenceName: shortSequenceName,
    posToFractions: posToFractions,
    fractionsToPos: fractionsToPos,
    validLogin: validLogin,
    channelFromUrl: channelFromUrl,
    computeOffsetSec: computeOffsetSec,
    localOffsetSec: localOffsetSec,
    nativeOffsetSec: nativeOffsetSec,
    computeClockSkewMs: computeClockSkewMs,
    formatTimecode: formatTimecode,
    formatTimecodeFrames: formatTimecodeFrames,
    parseTimecodeFrames: parseTimecodeFrames,
    fnv1aHex: fnv1aHex,
    splitPremiereComment: splitPremiereComment,
    buildPremiereComment: buildPremiereComment,
    syncConfirmReasons: syncConfirmReasons,
    toCsv: toCsv,
    parseCsv: parseCsv,
    mergeRecords: mergeRecords,
    groupByStream: groupByStream,
    fileStamp: fileStamp,
    recordKey: recordKey,
    legacyId: legacyId,
    newId: newId,
    isValidId: isValidId,
    repairId: repairId,
    round3: round3,
    normalizeRecord: normalizeRecord,
    syncPlan: syncPlan,
    markerTolerance: markerTolerance,
    sameMarkers: sameMarkers,
    baseFromMarkers: baseFromMarkers,
    finalizeRecords: finalizeRecords,
    applyNudges: applyNudges,
    recordSignature: recordSignature,
    mergeFresh: mergeFresh,
    mergeIntoSync: mergeIntoSync,
    frameFileName: frameFileName,
    localStreamId: localStreamId,
    recordsFromMarkers: recordsFromMarkers,
    detectCsvFormat: detectCsvFormat,
    convertDualPlayer: convertDualPlayer,
    dualPlayerStreamId: dualPlayerStreamId,
    tombstoneRecord: tombstoneRecord,
    planUpload: planUpload,
    applyUploadResult: applyUploadResult,
    isRetryableUpload: isRetryableUpload,
    toUploadRecord: toUploadRecord,
    reasonText: reasonText,
    recordSyncState: recordSyncState,
    serverMirrorPath: serverMirrorPath,
    recordsToPush: recordsToPush,
    mergeServerRecords: mergeServerRecords,
    applyPanelPushResult: applyPanelPushResult,
    nextPushAt: nextPushAt,
    isServerMeta: isServerMeta
  };
}());

if (typeof module !== 'undefined') module.exports = TSLib;
