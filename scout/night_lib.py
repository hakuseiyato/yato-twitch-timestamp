"""夜の処理（night runner）の純粋な規則: 着手条件・素材名・オフセット・SRT・計画・状態文字列。
Pure rules for the night runner: start condition, footage name, offset, SRT, plan and status texts.

I/O・ネットワーク・ffmpeg は扱わない（常駐側が呼ぶ）。時刻の ISO 文字列はすべて UTC（末尾 Z）。
No I/O, network or ffmpeg here; the daemon calls these. Every ISO time string is UTC (trailing Z).

状態文字列は Web（service/web/js/night.js）との契約 / Status strings are a contract with the web page:
  '処理中: <段>' / '完了（候補 N・チャット動画 N・字幕 N）' / '失敗: <段> — <理由>'
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    JST = ZoneInfo('Asia/Tokyo')
except Exception:  # tzdata が無い環境 / no tz database available
    JST = timezone(timedelta(hours=9))

STEP_ORDER = ('vod', 'chat', 'scout', 'render', 'captions', 'plan')
STEP_LABELS = {'vod': 'VOD 保存', 'chat': 'チャット', 'scout': '候補', 'render': 'チャット動画',
               'captions': '字幕', 'plan': '計画'}

_FORBIDDEN_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')  # Windows の禁止文字と制御文字 / Windows-forbidden and control chars
_LIVE_RECENT = timedelta(hours=24)   # 直近に配信を見たとみなす範囲 / how recent the last seen live must be
_VOD_SLACK = timedelta(hours=6)      # 配信開始は seen_at より前 / the stream starts before seen_at
_MATCH_WINDOW = timedelta(minutes=60)
_MAX_AUTO_OFFSET = 120.0


def _parse_iso(iso: str) -> datetime:
    """'2026-10-30T06:03:22Z' を aware datetime にする / Parse an ISO UTC string into an aware datetime."""
    return datetime.fromisoformat(iso.replace('Z', '+00:00'))


def sanitize_title(title: str, limit: int = 30) -> str:
    """ファイル名に使えない文字と制御文字を除き、前後空白を落として limit 文字で切る。空なら 'stream'。
    Drop filename-forbidden and control characters, strip, cut to `limit` chars; 'stream' when empty."""
    cleaned = _FORBIDDEN_RE.sub('', title).strip()[:limit].strip()
    return cleaned or 'stream'


def date_tag_jst(iso: str) -> str:
    """UTC の ISO 時刻を JST の YYMMDD にする / UTC ISO time to the JST date tag YYMMDD."""
    return _parse_iso(iso).astimezone(JST).strftime('%y%m%d')


def choose_footage_name(date_tag: str, title: str, taken: set[str], on_disk: set[str]) -> tuple[str, bool]:
    """素材の basename（拡張子なし）と、既存ファイルを使うかを返す。
    Return the footage basename (no extension) and whether an existing file is used.

    他 job が使った名前は _2, _3… で避け、その名前がフォルダに既にあれば（人が置いたもの）_vod を付けて True。
    Names taken by other jobs get _2, _3…; if that name is already on disk (put there by a person), add _vod and return True.
    """
    base = f'{date_tag}_{title}'
    name = base
    n = 2
    while name in taken:
        name = f'{base}_{n}'
        n += 1
    if name in on_disk:
        return f'{name}_vod', True
    return name, False


def should_start(state: dict, snapshot: dict, now: datetime) -> str | None:
    """着手する vod_id を返す。配信終了後で録画が確定し、まだ job が無い最新の VOD だけ。
    Return the vod_id to start: the newest recorded VOD after the live has ended that has no job yet.

    条件 / Conditions: last_live.seen_at が now の 24 時間以内、snapshot['stream'] が None、
    status == 'RECORDED' かつ createdAt >= seen_at − 6 時間。
    last_live.seen_at within 24 h of now, no live stream, status RECORDED and createdAt >= seen_at − 6 h.
    """
    last_live = state.get('last_live')
    if not last_live or snapshot.get('stream') is not None:
        return None
    seen_at = _parse_iso(last_live['seen_at'])
    if seen_at < now - _LIVE_RECENT:
        return None
    jobs = state.get('jobs') or {}
    earliest = seen_at - _VOD_SLACK
    recorded = [v for v in snapshot.get('videos') or []
                if v.get('status') == 'RECORDED' and _parse_iso(v['createdAt']) >= earliest]
    recorded.sort(key=lambda v: _parse_iso(v['createdAt']), reverse=True)
    for video in recorded:
        if video['id'] not in jobs:
            return video['id']
    return None


def vod_offset(vod_created_at: str, started_at: str) -> float:
    """VOD 開始 − 配信開始（秒）/ VOD start minus stream start, in seconds."""
    return (_parse_iso(vod_created_at) - _parse_iso(started_at)).total_seconds()


def should_apply_offset(current: float, computed: float) -> bool:
    """人が設定していない（0）ときだけ、|offset| <= 120 秒なら自動設定する。
    Auto-set only when unset (0) and |offset| <= 120 s."""
    return current == 0 and abs(computed) <= _MAX_AUTO_OFFSET


def match_stream_row(rows: list[dict], live_history: list[dict], vod_created_at: str) -> dict | None:
    """VOD に対応する配信行を返す。createdAt の前後 60 分以内に見た live の stream_id と同じ行、近い順。
    Return the stream row for the VOD: same stream_id as a live seen within ±60 min of createdAt, closest first.

    監視は VOD 開始の数分後に live を見ることがあるので後ろ側も許す。
    The watcher may see the live a few minutes after the VOD starts, so the window extends after it too.
    """
    created = _parse_iso(vod_created_at)
    by_id = {row.get('stream_id'): row for row in rows}
    near = []
    for entry in live_history:
        gap = abs(_parse_iso(entry['seen_at']) - created)
        if gap <= _MATCH_WINDOW:
            near.append((gap, entry['stream_id']))
    for _gap, stream_id in sorted(near, key=lambda item: item[0]):
        if stream_id in by_id:
            return by_id[stream_id]
    return None


def _srt_time(sec: float) -> str:
    """秒を SRT の HH:MM:SS,mmm にする / Seconds to SRT HH:MM:SS,mmm."""
    ms = int(round(sec * 1000))
    h, rest = divmod(ms, 3_600_000)
    m, rest = divmod(rest, 60_000)
    s, ms = divmod(rest, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def srt_for_window(segments: list[dict], t_vod: float, pre: float, post: float, line_chars: int = 20) -> str:
    """[t−pre, t+post] に重なる文字起こしを max(0, t−pre) 基準の SRT（先頭 BOM・CRLF）にする。重なりが無ければ ''。
    Build an SRT (BOM, CRLF) of segments overlapping [t−pre, t+post], shifted to max(0, t−pre); '' when none overlap.

    Short とチャット動画は VOD 時刻 max(0, t−pre) から始まるので、字幕もそこを 0 秒にする。
    The Short and the chat render start at VOD time max(0, t−pre), so captions use that as 0 s.
    窓より前から続く発話の開始は 0 に詰め、終わりは窓で切らない。本文は line_chars 文字ごとに折り返す。
    Speech starting before the window is clamped to 0; ends are not cut to the window. Text wraps every line_chars characters.
    """
    origin = max(0.0, t_vod - pre)
    stop = t_vod + post
    cues = []
    for seg in segments:
        if not (seg['end'] > origin and seg['start'] < stop):
            continue
        start = max(0.0, seg['start'] - origin)
        end = seg['end'] - origin
        text = seg['text'].strip()
        lines = [text[i:i + line_chars] for i in range(0, len(text), line_chars)] or ['']
        cues.append('\r\n'.join([str(len(cues) + 1), f'{_srt_time(start)} --> {_srt_time(end)}', *lines]) + '\r\n\r\n')
    if not cues:
        return ''
    return '﻿' + ''.join(cues)


def build_plan(*, date_tag: str, stream_id: str, vod_id: str, title: str, footage: str, footage_existing: bool,
               pre_sec: float, post_sec: float, candidates: list[dict], steps: dict, finished_at: str) -> dict:
    """パネルが読む計画ファイルの中身（version 1）/ The plan file content the panel reads (version 1)."""
    return {
        'version': 1,
        'date_tag': date_tag,
        'stream_id': stream_id,
        'vod_id': vod_id,
        'title': title,
        'footage': footage,
        'footage_existing': footage_existing,
        'pre_sec': pre_sec,
        'post_sec': post_sec,
        'candidates': candidates,
        'steps': steps,
        'finished_at': finished_at,
    }


def next_step(job: dict) -> str | None:
    """STEP_ORDER のうち 'done' でない最初の段。全部済みなら None。
    The first step in STEP_ORDER not marked 'done'; None when all are done."""
    steps = job.get('steps') or {}
    for step in STEP_ORDER:
        if steps.get(step) != 'done':
            return step
    return None


def pending_requests(rows: list[dict]) -> list[dict]:
    """「今夜やる」要求が開いていて、まだ処理中でない配信行。
    Stream rows with an open run-tonight request that are not already running.

    要求が完了より新しい（完了が無いも含む）ものを開いているとみなす。ISO UTC なので文字列比較でよい。
    A request is open when newer than the last done (or never done); ISO UTC strings compare correctly as text.
    """
    pending = []
    for row in rows:
        requested = row.get('night_requested_at')
        done = row.get('night_done_at')
        if not requested or (done and requested <= done):
            continue
        if str(row.get('night_status') or '').startswith('処理中'):
            continue
        pending.append(row)
    return pending


def status_text_running(step: str, i: int | None = None, n: int | None = None) -> str:
    """'処理中: <段>'、件数があれば ' i/n' を付ける / '処理中: <stage>', plus ' i/n' when counts are given."""
    text = f'処理中: {STEP_LABELS[step]}'
    if i is not None and n is not None:
        text += f' {i}/{n}'
    return text


def status_text_done(candidates: int, chats: int, captions: int) -> str:
    """完了の状態文字列 / Status string for a finished run."""
    return f'完了（候補 {candidates}・チャット動画 {chats}・字幕 {captions}）'


def status_text_failed(step: str, reason: str) -> str:
    """失敗の状態文字列 / Status string for a failed step."""
    return f'失敗: {STEP_LABELS[step]} — {reason}'
