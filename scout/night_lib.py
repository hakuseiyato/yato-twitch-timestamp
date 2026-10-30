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
from pathlib import PureWindowsPath

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
    """'2026-10-30T06:03:22Z' を aware datetime にする。時差の無い時刻は UTC とみなす。
    Parse an ISO string into an aware datetime; a naive timestamp is taken as UTC."""
    parsed = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


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

    番号が先: 名前かその _vod 形が他 job に使われていれば _2, _3… と上げる。決まった名前がフォルダに既にあれば
    （人が置いたもの）_vod を付けて True。これで _vod 形も他 job と重ならない。
    Counter first: raise _2, _3… while the name or its _vod form is taken by another job. If the chosen name is
    already on disk (put there by a person), add _vod and return True, so the _vod form never collides either.
    """
    base = f'{date_tag}_{title}'
    name = base
    n = 2
    while name in taken or f'{name}_vod' in taken:
        name = f'{base}_{n}'
        n += 1
    if name in on_disk:
        return f'{name}_vod', True
    return name, False


def should_start(state: dict, snapshot: dict, now: datetime) -> str | None:
    """着手する vod_id を返す。配信終了後で録画が確定し、まだ job が無い最新の VOD だけ。
    Return the vod_id to start: the newest recorded VOD after the live has ended that has no job yet.

    条件 / Conditions: last_live.seen_at が now の 24 時間以内、snapshot['stream'] が None、
    status == 'RECORDED' かつ createdAt >= その配信を最初に見た時刻 − 6 時間（履歴に無ければ seen_at − 6 時間）。
    last_live.seen_at within 24 h of now, no live stream, status RECORDED and createdAt >= the stream's first
    sighting − 6 h (seen_at − 6 h when the history lacks it).

    最後に見た時刻を基準にすると 6 時間を超える配信の VOD が範囲から外れるので、最初に見た時刻を使う。
    Measured from the first sighting, since from the last one a stream longer than 6 h would fall outside the range.
    """
    last_live = state.get('last_live')
    if not last_live or snapshot.get('stream') is not None:
        return None
    seen_at = _parse_iso(last_live['seen_at'])
    if seen_at < now - _LIVE_RECENT:
        return None
    jobs = state.get('jobs') or {}
    first = next((e['seen_at'] for e in state.get('live_history') or [] if e.get('stream_id') == last_live['stream_id']),
                 None)
    earliest = (_parse_iso(first) if first else seen_at) - _VOD_SLACK
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


def nearest_stream_row(rows: list[dict], vod_created_at: str, window_sec: float = 3600,
                       vod_id: str | None = None) -> dict | None:
    """started_at が VOD の createdAt に最も近く window_sec 以内の配信行。vod_id の無い行（vod_id を渡せば同じ行も）だけ。
    The stream row whose started_at is closest to the VOD's createdAt within window_sec; only rows without a vod_id
    (or with the given vod_id).

    見張りが live を見損ねた（履歴に無い）ときに vod-<id> の行を別に作らないための最後の照合。時刻の壊れた行は飛ばす。
    The last match before registering a separate vod-<id> row when the watcher missed the live; rows with a broken
    time are skipped.
    """
    created = _parse_iso(vod_created_at)
    best: tuple[timedelta, dict] | None = None
    for row in rows:
        row_vod = str(row.get('vod_id') or '')
        if row_vod and row_vod != str(vod_id or ''):
            continue
        try:
            gap = abs(_parse_iso(str(row.get('started_at') or '')) - created)
        except ValueError:
            continue
        if gap <= timedelta(seconds=window_sec) and (best is None or gap < best[0]):
            best = (gap, row)
    return best[1] if best else None


def sequence_name(footage: str) -> str:
    """フル尺 Sequence の名前: 素材の basename（拡張子なし）から末尾の _vod を落としたもの。
    The full-length sequence name: the footage basename without extension, minus a trailing _vod.

    素材名は job ごとに _2, _3… で重ならないので、同じ日に 2 本あっても Sequence 名がぶつからない。
    Footage names never collide across jobs (_2, _3…), so two streams on one day get distinct sequence names.
    """
    stem = PureWindowsPath(footage).stem
    return stem[:-len('_vod')] if stem.endswith('_vod') else stem


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
    窓より前から続く発話の開始は 0 に詰め、終わりは窓で切らない。本文は line_chars 文字ごとに折り返す（0 以下なら折り返さない）。
    空白だけの発話は飛ばす。
    Speech starting before the window is clamped to 0; ends are not cut to the window. Text wraps every line_chars
    characters (no wrapping when line_chars <= 0). Whitespace-only segments are skipped.
    """
    origin = max(0.0, t_vod - pre)
    stop = t_vod + post
    cues = []
    for seg in segments:
        if not (seg['end'] > origin and seg['start'] < stop):
            continue
        text = seg['text'].strip()
        if not text:
            continue
        start = max(0.0, seg['start'] - origin)
        end = seg['end'] - origin
        width = line_chars if line_chars > 0 else len(text)
        lines = [text[i:i + width] for i in range(0, len(text), width)]
        cues.append('\r\n'.join([str(len(cues) + 1), f'{_srt_time(start)} --> {_srt_time(end)}', *lines]) + '\r\n\r\n')
    if not cues:
        return ''
    return '\ufeff' + ''.join(cues)


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
        'sequence_name': sequence_name(footage),
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


def pending_requests(rows: list[dict], adopt_running: bool = False) -> list[dict]:
    """「今夜やる」要求が開いていて、まだ処理中でない配信行。
    Stream rows with an open run-tonight request that are not already running.

    要求が完了より新しい（完了が無いも含む）ものを開いているとみなす。ミリ秒の有無が混ざるので時刻で比べる。
    A request is open when newer than the last done (or never done); compared as datetimes since milliseconds may differ.
    adopt_running=True（常駐の毎周）は、処理中のまま完了時刻の無い行も拾う（常駐は 1 本ずつ処理するので、周の時点で
    そうなっている行は、落ちた常駐か届かなかった PATCH の名残）。
    adopt_running=True (every daemon tick) also takes rows left running with no done time (the daemon runs one job at a
    time, so at tick time such a row is left over from a dead daemon or a lost PATCH).
    """
    pending = []
    for row in rows:
        if adopt_running and str(row.get('night_status') or '').startswith('処理中') and not row.get('night_done_at'):
            pending.append(row)
            continue
        requested = row.get('night_requested_at')
        done = row.get('night_done_at')
        if not requested:
            continue
        try:
            requested_at = _parse_iso(requested)  # 完了が無くても読む / parsed even without a done time
            closed = bool(done) and requested_at <= _parse_iso(done)
        except ValueError:  # 壊れた 1 行で周ごと落とさない / one broken row must not fail the whole tick
            continue
        if closed:
            continue
        if str(row.get('night_status') or '').startswith('処理中'):
            continue
        pending.append(row)
    return pending


def vod_near(videos: list[dict], started_at: str) -> dict | None:
    """配信開始に createdAt が最も近く、60 分以内の VOD。無ければ None。
    The VOD whose createdAt is closest to the stream start and within 60 min; None when there is none."""
    start = _parse_iso(started_at)
    near = [(abs(_parse_iso(v['createdAt']) - start), v) for v in videos]
    near = [item for item in near if item[0] <= _MATCH_WINDOW]
    return min(near, key=lambda item: item[0])[1] if near else None


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
