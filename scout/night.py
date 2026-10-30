"""Peakaboo 夜の処理: 配信の VOD を保存し、チャット・候補・チャット動画・字幕・取り込み計画まで作る。
Peakaboo night runner: save the VOD, then chat, candidates, chat videos, captions and the import plan.

段は night_lib.STEP_ORDER の順に進み、済んだ段は state.json に 'done' で残るので再実行で飛ばす。
Steps run in night_lib.STEP_ORDER; finished steps are kept as 'done' in state.json and skipped on a re-run.

単発 / One-shot: `python -I scout/night.py --vod <id> [--force] [--footage-root <dir>] [--config <night.config.json>]`
戻りコード / Exit codes: 0 = 全段済み / all steps done、1 = 失敗で止まった / stopped on a failure、2 = 起動時のエラー / startup error
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I でも隣のモジュールを読む / sibling modules under -I
import api  # noqa: E402
import gql  # noqa: E402
import night_lib  # noqa: E402
import scout  # noqa: E402
import td  # noqa: E402

log = logging.getLogger('night')
log.addHandler(logging.NullHandler())  # ハンドラ未設定でも stderr に漏らさない / stay quiet until main attaches handlers

HERE = Path(__file__).resolve().parent
NIGHT_DIR = Path(os.path.expandvars(r'%LOCALAPPDATA%\peakaboo\night'))
LIVE_HISTORY_MAX = 20
MAX_FAILURES = 3
_REASON_MAX = 200
_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
_REQUIRED_KEYS = ('channel', 'footage_root', 'twitch_downloader', 'pre_sec', 'post_sec', 'chat_render',
                  'caption_line_chars', 'poll_minutes')


def load_night_config(path: Path | str) -> dict:
    """night.config.json を読み、パスの環境変数（%LOCALAPPDATA% など）を展開する。
    Read night.config.json and expand env vars in its paths.

    Raises
    ------
    ValueError
        必須キーが欠けている / A required key is missing.
    """
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    missing = [k for k in _REQUIRED_KEYS if k not in cfg]
    if missing:
        raise ValueError(f'night.config.json に {", ".join(missing)} がありません / missing keys')
    for key in ('footage_root', 'twitch_downloader'):
        cfg[key] = os.path.expandvars(cfg[key])
    return cfg


def _write_atomic(path: Path, text: str) -> None:
    """一時名に書いてから置き換える（途中で止まっても半端なファイルを残さない）。
    Write to a temp name, then replace, so an interrupted write never leaves a partial file."""
    tmp = path.with_name(path.name + '.tmp')
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    os.replace(tmp, path)


class State:
    """state.json（job ごとの段の進み具合と、見張りが見た配信の履歴）。
    state.json: per-VOD job progress and the history of lives the watcher saw."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path is not None else NIGHT_DIR / 'state.json'
        self.data: dict = {}

    def load(self) -> State:
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding='utf-8'))
        self.data.setdefault('last_live', None)
        self.data.setdefault('live_history', [])
        self.data.setdefault('jobs', {})
        return self

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _write_atomic(self.path, json.dumps(self.data, ensure_ascii=False, indent=2))

    @property
    def jobs(self) -> dict:
        return self.data['jobs']

    @property
    def live_history(self) -> list[dict]:
        return self.data['live_history']

    def job(self, vod_id: str) -> dict:
        """VOD の job（無ければ作る）/ The VOD's job, created when missing."""
        return self.jobs.setdefault(str(vod_id), {'steps': {}, 'error': None, 'started_at': scout.now_iso()})

    def record_live(self, stream: dict, seen_at: str | None = None) -> None:
        """配信中を見たことを記録する。last_live は最後に見た時刻、履歴は配信ごとに最初に見た時刻（VOD 開始に近い）。
        Record a live sighting: last_live keeps the latest time, history keeps each stream's first sighting
        (closest to the VOD start), newest 20 streams."""
        seen = seen_at or scout.now_iso()
        entry = {'stream_id': str(stream['id']), 'title': stream.get('title') or '', 'seen_at': seen}
        self.data['last_live'] = entry
        if not any(e['stream_id'] == entry['stream_id'] for e in self.live_history):
            self.live_history.append(dict(entry))
            del self.live_history[:-LIVE_HISTORY_MAX]


def state_path_for(footage_root: Path | str, config_root: Path | str) -> Path:
    """素材の保存先ごとの state.json。設定どおりなら共有の state.json、別の場所（試験）なら state_<sha1 先頭 8 桁>.json。
    The state file per footage root: the shared state.json for the configured root, else state_<sha1[:8]>.json,
    so production and test runs never share a job."""
    resolved = Path(footage_root).resolve()
    if resolved == Path(config_root).resolve():
        return NIGHT_DIR / 'state.json'
    return NIGHT_DIR / f'state_{hashlib.sha1(str(resolved).encode("utf-8")).hexdigest()[:8]}.json'


def reset_job(state: State, vod_id: str, day_dir: Path) -> dict:
    """--force: job を作り直す。素材名は同じ日フォルダにあるときだけ引き継ぐ（前回の VOD を人の録画と取り違えない）。
    --force: recreate the job, keeping the footage name only when it lives in the same day folder
    (so the earlier download is not mistaken for a human recording)."""
    old = state.jobs.pop(str(vod_id), None) or {}
    job = state.job(str(vod_id))
    if old.get('footage') and Path(old['footage']).parent.resolve() == Path(day_dir).resolve():
        job['footage'] = old['footage']
        job['footage_existing'] = old.get('footage_existing', False)
    return job


@dataclass
class JobContext:
    """1 本の VOD を処理するのに要るもの / Everything one VOD job needs.

    status は段の切り替わりの状態文字列を受ける（単発ではログ、常駐ではサーバーへ）。
    status receives the status string at each step (logged in one-shot mode, sent to the server by the daemon).
    """
    client: api.Client
    cfg: dict
    night_cfg: dict
    state: State
    vod: dict
    stream_row: dict | None
    footage_root: Path
    notify: Callable[[str], None]
    status: Callable[[str], None]
    scout_config_path: Path = HERE / 'scout.config.json'


def _date_tag(ctx: JobContext) -> str:
    return night_lib.date_tag_jst(ctx.vod['createdAt'])


def _day_dir(ctx: JobContext) -> Path:
    return Path(ctx.footage_root) / f'_{_date_tag(ctx)}'


def _cache_dir(ctx: JobContext) -> Path:
    return Path(ctx.cfg['cache_dir']) / str(ctx.vod['id'])


def _remove_parts(final: Path) -> None:
    """前回の途中ファイル（<名前>.part…）を消す / Delete leftovers (<name>.part…) of an earlier attempt."""
    prefix = final.stem + '.part'
    if not final.parent.exists():
        return
    for p in final.parent.iterdir():
        if p.is_file() and p.name.startswith(prefix):
            log.info('途中ファイルを削除: %s', p.name)
            p.unlink()


def _run_logged(cmd: list[str]) -> None:
    """外部コマンドを動かし、出力を 1 行ずつ night.log に流す / Run a command, streaming its output into the log.

    Raises
    ------
    subprocess.CalledProcessError
        終了コードが 0 でない / Non-zero exit code.
    """
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace',
                          creationflags=_NO_WINDOW) as proc:
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.strip():
                log.info('  %s', line.rstrip())
    if proc.returncode:
        raise subprocess.CalledProcessError(proc.returncode, cmd)


def step_vod(ctx: JobContext, job: dict) -> None:
    """VOD を yt-dlp で Footage\\_YYMMDD\\ に保存する。名前は最初の 1 回だけ決める。
    Save the VOD with yt-dlp into Footage\\_YYMMDD\\; the name is chosen once."""
    day = _day_dir(ctx)
    day.mkdir(parents=True, exist_ok=True)
    if not job.get('footage'):
        vod_id = str(ctx.vod['id'])
        taken = {Path(j['footage']).stem for vid, j in ctx.state.jobs.items() if vid != vod_id and j.get('footage')}
        on_disk = {p.stem for p in day.iterdir() if p.is_file() and p.suffix.lower() == '.mp4'}
        name, existing = night_lib.choose_footage_name(_date_tag(ctx), night_lib.sanitize_title(ctx.vod['title']),
                                                       taken, on_disk)
        job['footage'] = str(day / f'{name}.mp4')
        job['footage_existing'] = existing
    final = Path(job['footage'])
    if final.exists():
        log.info('VOD は保存済み: %s', final.name)
    else:
        _remove_parts(final)
        part = final.with_name(final.stem + '.part.mp4')
        # 出力テンプレートの % を文字として扱う / keep a literal % out of yt-dlp's output template
        _run_logged(['yt-dlp', '-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4',
                     '--newline', '--progress-delta', '30', '--encoding', 'utf-8',
                     '-o', str(part).replace('%', '%%'), f'https://www.twitch.tv/videos/{ctx.vod["id"]}'])
        os.replace(part, final)
        log.info('VOD を保存: %s（%.2f GB）', final.name, final.stat().st_size / 1e9)
    job['steps']['vod'] = 'done'


def _resolve_row(ctx: JobContext, job: dict) -> dict:
    """VOD の配信行を決める: 記録済み → 渡された行 → vod_id 一致 → 見張りの履歴 → vod-<id> で登録。
    Pick the VOD's stream row: stored id → given row → same vod_id → watcher history → register vod-<id>."""
    if job.get('stream_id'):
        return ctx.client.get(f'/api/streams/{scout.seg(job["stream_id"])}')['stream']
    if ctx.stream_row:
        return ctx.stream_row
    vod = ctx.vod
    rows = ctx.client.get(f'/api/channels/{scout.seg(ctx.cfg["channel"])}/streams')['streams']
    row = next((r for r in rows if str(r.get('vod_id') or '') == str(vod['id'])), None)
    row = row or night_lib.match_stream_row(rows, ctx.state.live_history, vod['createdAt'])
    if row:
        return row
    log.info('配信行が無いため vod-%s で登録', vod['id'])
    return ctx.client.post('/api/streams', {'stream_id': f'vod-{vod["id"]}', 'channel': ctx.cfg['channel'],
                                            'started_at': vod['createdAt'], 'title': vod['title'],
                                            'vod_id': str(vod['id'])})['stream']


def step_chat(ctx: JobContext, job: dict) -> None:
    """配信行を決め、チャット JSON を取り（描画に使う）、未取込ならサーバーへ送り、vod_offset_sec を合わせる。
    Resolve the stream row, download the chat JSON (needed for rendering), upload it when missing, set vod_offset_sec."""
    row = _resolve_row(ctx, job)
    sid = str(row['stream_id'])
    job['stream_id'] = sid
    vod_id = str(ctx.vod['id'])
    cache = _cache_dir(ctx)
    cache.mkdir(parents=True, exist_ok=True)
    chat_json = cache / 'chat.json'
    if not chat_json.exists():
        exe = Path(ctx.night_cfg['twitch_downloader'])
        td.ensure_installed(exe)
        part = cache / 'chat.part.json'
        part.unlink(missing_ok=True)
        td.chatdownload(exe, vod_id, part)
        os.replace(part, chat_json)
    if row.get('chat_count'):
        log.info('チャットは取込済み（%s 件）のため送らない', row['chat_count'])
    else:
        rows = td.simplify_chat(json.loads(chat_json.read_text(encoding='utf-8')))
        length = int(ctx.vod['lengthSeconds'])
        query = urllib.parse.urlencode({'vod_id': vod_id, 'count': len(rows), 'length_sec': length})
        ctx.client.put_raw(f'/api/streams/{scout.seg(sid)}/chat?{query}',
                           td.chat_json_for_server(vod_id, length, rows), 'application/json')
        log.info('チャットを送信: %d 件', len(rows))
    computed = night_lib.vod_offset(ctx.vod['createdAt'], row['started_at'])
    current = float(row.get('vod_offset_sec') or 0)
    # 後の段は毎回スタンプと一緒に行を読み直すので、ここで書いた値がそのまま使われる
    # Later steps re-read the row along with the stamps, so the value written here is what they use
    if night_lib.should_apply_offset(current, computed):
        ctx.client.patch(f'/api/streams/{scout.seg(sid)}', {'vod_offset_sec': computed})
        log.info('vod_offset_sec を %+.1f 秒に設定', computed)
    elif current == 0 and abs(computed) > 120:
        job['offset_note'] = f'配信開始と VOD の差が {computed:+.0f} 秒あるため vod_offset_sec を自動設定していません'
        log.warning('%s', job['offset_note'])
    job['steps']['chat'] = 'done'


def step_scout(ctx: JobContext, job: dict) -> None:
    """Scout を確認なしで走らせ、候補をサーバーへ送る。保存した VOD を音声源にする。
    Run Scout without confirmation and post candidates, using the saved VOD as the audio source."""
    args = argparse.Namespace(config=str(ctx.scout_config_path), server=None, top=None, cpu=False,
                              stream=job['stream_id'], replace=False, dry_run=False, yes=True, source=job['footage'])
    if scout.run(args) == 1:
        job['no_candidates'] = True
        log.info('Scout の新しい候補なし')
    job['steps']['scout'] = 'done'


def _targets(ctx: JobContext, job: dict) -> list[tuple[dict, float]]:
    """生きている全スタンプ（人・候補とも）と VOD 時刻。VOD の外に出るものは除く。
    Every alive stamp (human and candidate) with its VOD time, dropping those outside the VOD."""
    body = ctx.client.get(f'/api/streams/{scout.seg(job["stream_id"])}/stamps')
    offset = float((body.get('stream') or {}).get('vod_offset_sec') or 0)
    length = float(ctx.vod['lengthSeconds'])
    alive = sorted((s for s in body.get('records') or [] if not s.get('deleted')), key=lambda s: float(s['offset_sec']))
    targets = []
    for stamp in alive:
        t_vod = float(stamp['offset_sec']) - offset
        if 0 <= t_vod <= length:
            targets.append((stamp, t_vod))
    return targets


def _chat_path(ctx: JobContext, stamp_id: str) -> Path:
    return _day_dir(ctx) / 'chat' / f'{_date_tag(ctx)}_chat_{stamp_id}.mov'


def _caption_path(ctx: JobContext, stamp_id: str) -> Path:
    return _day_dir(ctx) / 'captions' / f'{_date_tag(ctx)}_caption_{stamp_id}.srt'


def step_render(ctx: JobContext, job: dict) -> None:
    """スタンプごとに透過チャット動画を書き出す。同名があれば飛ばす。
    Render a transparent chat video per stamp; an existing file is skipped."""
    targets = _targets(ctx, job)
    if targets:
        exe = Path(ctx.night_cfg['twitch_downloader'])
        td.ensure_installed(exe)
        chat_json = _cache_dir(ctx) / 'chat.json'
        pre, post = float(ctx.night_cfg['pre_sec']), float(ctx.night_cfg['post_sec'])
        length = float(ctx.vod['lengthSeconds'])
        for i, (stamp, t_vod) in enumerate(targets, 1):
            ctx.status(night_lib.status_text_running('render', i, len(targets)))
            final = _chat_path(ctx, stamp['id'])
            if final.exists():
                continue
            final.parent.mkdir(parents=True, exist_ok=True)
            _remove_parts(final)
            part = final.with_name(final.stem + '.part.mov')
            begin, end = td.render_window(t_vod, pre, post, length)
            td.chatrender(exe, chat_json, begin, end, part, ctx.night_cfg['chat_render'])
            os.replace(part, final)
    log.info('チャット動画: %d 件', len(targets))
    job['steps']['render'] = 'done'


def step_captions(ctx: JobContext, job: dict) -> None:
    """スタンプごとに文字起こしから SRT を書く。重なる発話が無ければ書かない。
    Write an SRT per stamp from the transcript; nothing is written when no speech overlaps."""
    targets = _targets(ctx, job)
    if targets:
        segments = json.loads((_cache_dir(ctx) / 'transcript.json').read_text(encoding='utf-8'))
        pre, post = float(ctx.night_cfg['pre_sec']), float(ctx.night_cfg['post_sec'])
        written = 0
        for stamp, t_vod in targets:
            final = _caption_path(ctx, stamp['id'])
            if final.exists():
                continue
            text = night_lib.srt_for_window(segments, t_vod, pre, post, int(ctx.night_cfg['caption_line_chars']))
            if not text:
                continue
            final.parent.mkdir(parents=True, exist_ok=True)
            _write_atomic(final, text)
            written += 1
        log.info('字幕: %d 件を書き出し', written)
    job['steps']['captions'] = 'done'


def step_plan(ctx: JobContext, job: dict) -> None:
    """peakaboo_<vodId>.json と peakaboo.json（同じ内容）を書き、完了を通知する。
    Write peakaboo_<vodId>.json and peakaboo.json (same content) and notify completion."""
    candidates = []
    for stamp, _t in _targets(ctx, job):
        chat, caption = _chat_path(ctx, stamp['id']), _caption_path(ctx, stamp['id'])
        candidates.append({'id': stamp['id'], 'offset_sec': stamp['offset_sec'], 'memo': stamp.get('memo') or '',
                           'chat': str(chat) if chat.exists() else None,
                           'caption': str(caption) if caption.exists() else None})
    plan = night_lib.build_plan(
        date_tag=_date_tag(ctx), stream_id=job['stream_id'], vod_id=str(ctx.vod['id']), title=ctx.vod['title'],
        footage=job['footage'], footage_existing=bool(job.get('footage_existing')),
        pre_sec=ctx.night_cfg['pre_sec'], post_sec=ctx.night_cfg['post_sec'], candidates=candidates,
        steps=dict(job['steps']), finished_at=scout.now_iso())
    if job.get('offset_note'):
        plan['offset_note'] = job['offset_note']  # 設計 §7.5-2: 人が見るため計画にも残す / kept for a human to see
    text = json.dumps(plan, ensure_ascii=False, indent=2)
    day = _day_dir(ctx)
    day.mkdir(parents=True, exist_ok=True)
    _write_atomic(day / f'peakaboo_{ctx.vod["id"]}.json', text)
    _write_atomic(day / 'peakaboo.json', text)
    job['steps']['plan'] = 'done'
    done = night_lib.status_text_done(len(candidates), sum(1 for c in candidates if c['chat']),
                                      sum(1 for c in candidates if c['caption']))
    ctx.status(done)
    notes = [n for n in ('新しい候補なし' if job.get('no_candidates') else '', job.get('offset_note') or '') if n]
    ctx.notify(' '.join([f'Peakaboo: {done}', *notes]))


def _reason(e: BaseException) -> str:
    """例外を短い理由にする（トークンは api 側で例外に載らない）/ Short reason text for an exception."""
    # 通知・Web に出すので日本語だけ: 「日本語 / English」の文言は前半を採る
    # Shown in toasts and on the web, so Japanese only: take the half before ' / ' of our bilingual messages
    if isinstance(e, subprocess.CalledProcessError):
        cmd = e.cmd[0] if isinstance(e.cmd, (list, tuple)) else str(e.cmd)
        text = f'{Path(str(cmd)).name} が終了コード {e.returncode} で失敗'
    elif isinstance(e, api.ApiError):
        text = f'サーバー HTTP {e.status} {e.error}'
    elif isinstance(e, scout.ScoutExit):
        text = str(e).split(' / ')[0]
    else:
        message = str(e).split(' / ')[0]
        text = f'エラー: {type(e).__name__}' + (f': {message}' if message else '')
    return text[:_REASON_MAX]


def run_job(ctx: JobContext) -> dict:
    """済んでいない段を順に実行する。失敗はその段で止め、同じ段が 3 回続けて失敗したら job を止めて通知する。
    Run the unfinished steps in order. A failure stops at that step; three failures in a row on the same step
    stop the job and notify.

    Returns
    -------
    dict
        state 内の job（そのまま更新される）/ The job inside the state (updated in place).
    """
    job = ctx.state.job(str(ctx.vod['id']))
    if job.get('stopped'):
        log.info('job %s は停止中のため飛ばす', ctx.vod['id'])
        return job
    while (step := night_lib.next_step(job)) is not None:
        label = night_lib.STEP_LABELS[step]
        ctx.status(night_lib.status_text_running(step))
        log.info('段 %s 開始', label)
        t0 = time.perf_counter()
        try:
            globals()[f'step_{step}'](ctx, job)  # 実行時に引く（テストの差し替えが効く）/ looked up at call time
        except Exception as e:  # 段の失敗はすべて記録して止まる / every step failure is recorded, then we stop
            reason = _reason(e)
            prev = job.get('error') or {}
            count = prev.get('count', 0) + 1 if prev.get('step') == step else 1
            job['error'] = {'step': step, 'reason': reason, 'count': count}
            log.error('段 %s 失敗（%d 回目）%.1f 秒: %s', label, count, time.perf_counter() - t0, reason, exc_info=True)
            failed = night_lib.status_text_failed(step, reason)
            ctx.status(failed)
            if count >= MAX_FAILURES:
                job['stopped'] = True
                ctx.notify(f'Peakaboo: {failed}')
            ctx.state.save()
            return job
        job['error'] = None
        log.info('段 %s 完了 %.1f 秒', label, time.perf_counter() - t0)
        ctx.state.save()
    return job


# WinRT トーストを Windows PowerShell 5.1 で出す（pwsh 7 は WinRT 型を読めない）。本文は Base64 で渡し文字化けを避ける
# Show a WinRT toast via Windows PowerShell 5.1 (pwsh 7 cannot load WinRT types); the text goes in as Base64
_TOAST_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__TEXT__'))
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text></binding></visual></toast>')
$xml.GetElementsByTagName('text').Item(0).AppendChild($xml.CreateTextNode($text)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
"""


def notify(text: str) -> None:
    """Windows のトースト通知を出す。失敗はログに書くだけ（通知で job を止めない）。
    Show a Windows toast; a failure is only logged (notifications never stop a job)."""
    script = _TOAST_SCRIPT.replace('__TEXT__', base64.b64encode(text.encode('utf-8')).decode('ascii'))
    encoded = base64.b64encode(script.encode('utf-16-le')).decode('ascii')
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                                capture_output=True, timeout=30, creationflags=_NO_WINDOW)
        if result.returncode:
            log.warning('通知に失敗（終了コード %d）: %s', result.returncode,
                        result.stderr.decode('utf-8', 'replace').strip()[:300])
        else:
            log.info('通知: %s', text)
    except (OSError, subprocess.SubprocessError) as e:
        log.warning('通知に失敗: %s', e)


def setup_logging() -> None:
    """画面と night.log（scout.attach_log_file と同じ書式）へ、night と scout のログを出す。
    Send night and scout logs to the console and night.log (same format as scout.attach_log_file)."""
    NIGHT_DIR.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(NIGHT_DIR / 'night.log', mode='a', encoding='utf-8')
    fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(scout._MessageOnly())  # トレースバックはファイルにだけ / tracebacks go to the file only
    for logger in (log, scout.log):
        logger.setLevel(logging.INFO)
        logger.addHandler(fh)
        logger.addHandler(sh)


def find_vod(login: str, vod_id: str) -> dict:
    """GQL の最新 VOD（3 本）から id で探す / Find the VOD by id among the newest three from GQL.

    Raises
    ------
    ValueError
        見つからない、または録画中 / Not found, or still recording.
    """
    for video in gql.snapshot(login)['videos']:
        if str(video['id']) == str(vod_id):
            if video.get('status') != 'RECORDED':
                raise ValueError(f'VOD {vod_id} はまだ録画中です（{video.get("status")}）')
            return video
    raise ValueError(f'VOD {vod_id} が {login} の最新 3 本に見つかりません')


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog='night', description='Peakaboo 夜の処理（単発）/ night runner (one-shot)')
    p.add_argument('--vod', required=True, help='VOD id')
    p.add_argument('--force', action='store_true', help='job を作り直して全段を実行 / recreate the job and run every step')
    p.add_argument('--footage-root', help='素材の保存先（設定を上書き）/ footage root (overrides the config)')
    p.add_argument('--config', default=str(HERE / 'night.config.json'), help='night.config.json')
    args = p.parse_args(argv)
    if not args.vod.isdigit():
        p.error('--vod は数字 / --vod must be numeric')
    return args


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # python -I は PYTHONIOENCODING を見ない / -I ignores it
    args = parse_args(argv)
    setup_logging()
    try:
        night_cfg = load_night_config(args.config)
        config_root = night_cfg['footage_root']
        if args.footage_root:
            night_cfg['footage_root'] = args.footage_root
        cfg_path = Path(args.config).resolve().parent / 'scout.config.json'
        cfg = scout.load_config(cfg_path)
        client = api.Client(cfg['server'], scout.read_token(Path(cfg['token_path'])))
        state = State(state_path_for(night_cfg['footage_root'], config_root)).load()
        vod = find_vod(night_cfg['channel'], args.vod)
    except (scout.ScoutExit, api.ApiError, ValueError, OSError) as e:
        log.error('起動できません: %s', _reason(e))
        return 2
    log.info('夜の処理を開始: VOD %s「%s」素材 %s 状態 %s', vod['id'], vod['title'], night_cfg['footage_root'], state.path)
    ctx = JobContext(client=client, cfg=cfg, night_cfg=night_cfg, state=state, vod=vod, stream_row=None,
                     footage_root=Path(night_cfg['footage_root']), notify=notify,
                     status=lambda text: log.info('状態: %s', text), scout_config_path=cfg_path)
    if args.force:
        reset_job(state, args.vod, _day_dir(ctx))
        state.save()
    job = run_job(ctx)
    return 0 if night_lib.next_step(job) is None else 1


if __name__ == '__main__':
    sys.exit(main())
