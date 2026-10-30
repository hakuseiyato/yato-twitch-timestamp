"""Peakaboo Scout: Twitch VOD の音声とチャットから見どころ候補を選び、候補スタンプとして送る。
Peakaboo Scout: pick highlight candidates from a Twitch VOD's audio and chat and post them as candidate stamps.

送るのはスタンプ 13 列だけ。文字起こし・音声はローカルのキャッシュに残し、サーバーへは送らない。
Only the 13 stamp columns are sent; the transcript and audio stay in the local cache.

戻りコード / Exit codes: 0 = 送信または dry-run 完了 / sent or dry-run done、1 = 候補なし・未送信 / no candidates or not sent、2 = エラー / error
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import secrets
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I でも隣のモジュールを読む / sibling modules under -I
import api  # noqa: E402
import audio  # noqa: E402
import signals  # noqa: E402

log = logging.getLogger('scout')
JST = timezone(timedelta(hours=9))
STREAM_LIST_LIMIT = 15


class ScoutExit(Exception):
    """メッセージを出して指定の戻りコードで終える / Stop with a message and the given exit code."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def now_iso() -> str:
    """サーバーの nowIso と同じ形（ミリ秒・Z）/ Same shape as the server's nowIso (milliseconds, Z)."""
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def hms(sec: float) -> str:
    s = max(0, int(sec))
    return f'{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}'


def new_id() -> str:
    """'y' + 小文字 16 進 7 桁（28 bit）/ 'y' + 7 lowercase hex digits (28 bits)."""
    return 'y%07x' % secrets.randbits(28)


def load_config(path: Path) -> dict:
    """設定を読み、パスの環境変数（%APPDATA% など）を展開する / Read the config and expand env vars in paths."""
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    for key in ('token_path', 'cache_dir'):
        cfg[key] = os.path.expandvars(cfg[key])
    return cfg


def read_token(path: Path) -> str:
    """トークンを読む。無ければ貼り付けてもらい保存する。トークンは表示もログもしない。
    Read the token, or ask for it and save it. The token is never printed or logged."""
    if path.exists():
        token = path.read_text(encoding='utf-8').strip()
        if token.startswith('ytt_'):
            return token
        raise ScoutExit(2, f'ERR: トークンファイルの形式が違います / The token file is malformed: {path}')
    token = input('Peakaboo の /me で発行した ytt_ トークンを貼り付けてください / Paste the ytt_ token issued on /me: ').strip()
    if not token.startswith('ytt_'):
        raise ScoutExit(2, 'ERR: ytt_ で始まるトークンではありません / The token must start with ytt_')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding='utf-8')
    log.info('トークンを保存しました / Token saved: %s', path)
    return token


def check_member(me: dict, channel: str) -> str:
    """トークンの持ち主の login。チャンネルに入れなければ止める。サイト管理者はサーバー側で全チャンネルに入れる。
    The token owner's login; stop unless they can access the channel. The server lets the site admin into every channel."""
    login = me.get('login') or ''
    channels = {c.get('login') for c in me.get('channels') or []}
    if channel not in channels and not me.get('site_admin'):
        raise ScoutExit(2, f'ERR: {login} は {channel} のメンバーではありません / {login} is not a member of {channel}')
    return login


def _jst(started_at: str | None) -> str:
    if not started_at:
        return '—'
    return datetime.fromisoformat(started_at.replace('Z', '+00:00')).astimezone(JST).strftime('%Y-%m-%d %H:%M')


def choose_stream(client: api.Client, channel: str) -> str:
    """最新 15 件を表にして選んでもらう。Enter で既定、番号で選択、それ以外は 1 回だけ聞き直す。
    Show the newest 15 streams and ask. Enter picks the default, a number picks that row, anything else re-asks once."""
    body = client.get(f'/api/channels/{channel}/streams') or {}
    streams = sorted(body.get('streams') or [], key=lambda s: s.get('started_at') or '', reverse=True)
    if not streams:
        raise ScoutExit(1, f'配信がありません / No streams for {channel}')
    shown = streams[:STREAM_LIST_LIMIT]
    default = signals.pick_default_stream(streams)
    log.info('%3s  %-16s  %-30s  %s', '#', '開始 (JST)', 'タイトル / Title', 'VOD')
    for i, s in enumerate(shown, 1):
        mark = '  [既定 / default]' if default is s else ''
        log.info('%3d  %-16s  %-30s  %s%s', i, _jst(s.get('started_at')), (s.get('title') or '')[:30],
                 s.get('vod_id') or '—', mark)
    if default is not None and all(default is not s for s in shown):
        log.info('既定 / default: %s %s', default['stream_id'], _jst(default.get('started_at')))
    for _attempt in range(2):
        answer = input('番号を入力（Enter で既定）/ Number (Enter for default): ').strip()
        if answer == '' and default is not None:
            return default['stream_id']
        if answer.isdigit() and 1 <= int(answer) <= len(shown):
            return shown[int(answer) - 1]['stream_id']
        log.info('番号が正しくありません / Invalid number: %r', answer)
    raise ScoutExit(1, '配信を選べませんでした / No stream selected')


def attach_log_file(path: Path) -> None:
    """scout.log へ追記するハンドラを足す / Add a handler that appends to scout.log."""
    fh = logging.FileHandler(path, mode='a', encoding='utf-8')
    fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    log.addHandler(fh)


class Stage:
    """段の名前と所要秒をログに出す / Log a stage's name and elapsed seconds."""

    def __init__(self, name: str):
        self.name = name
        self.t0 = 0.0

    def __enter__(self) -> Stage:
        log.info('stage %s ...', self.name)
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        status = 'ok' if exc_type is None else 'failed'
        log.info('stage %s %s %.1fs', self.name, status, time.perf_counter() - self.t0)
        return False


def prepare_audio(vod_id: str, cache: Path, whisper_cfg: dict) -> tuple[np.ndarray, int, list[dict]]:
    """音声 → 16 kHz WAV → 文字起こし（それぞれキャッシュがあれば再利用）。
    Audio -> 16 kHz WAV -> transcript, each reused from the cache when present."""
    with Stage('yt-dlp (audio.fetch_audio)'):
        src = audio.fetch_audio(vod_id, cache)
    wav = cache / 'audio16k.wav'
    with Stage('ffmpeg (audio.to_wav16k)'):
        if not wav.exists():
            audio.to_wav16k(src, wav)
    samples, sr = audio.load_wav(wav)
    log.info('音声 / audio: %s, %.0f 秒 / sec, %d Hz', wav.name, len(samples) / sr, sr)
    transcript = cache / 'transcript.json'
    with Stage('whisper (audio.transcribe)'):
        if transcript.exists():
            segments = json.loads(transcript.read_text(encoding='utf-8'))
            log.info('文字起こしを再利用 / transcript reused')
        else:
            segments = audio.transcribe(samples, whisper_cfg)
            # 途中で止まった JSON を再利用しないよう一時名から置き換える / temp name first, so a partial file is never reused
            tmp = transcript.with_name('transcript.tmp.json')
            tmp.write_text(json.dumps(segments, ensure_ascii=False), encoding='utf-8')
            os.replace(tmp, transcript)
    log.info('セグメント / segments: %d', len(segments))
    return samples, sr, segments


def chat_rows(chat: dict | None) -> list[tuple[float, str]]:
    """`comments: [[vod_sec, login, display, text], …]` から (秒, 本文)。壊れた行は飛ばす。
    (seconds, text) from the comments rows; malformed rows are skipped."""
    rows = []
    for c in (chat or {}).get('comments') or []:
        if isinstance(c, list) and len(c) >= 4 and isinstance(c[0], (int, float)):
            rows.append((float(c[0]), str(c[3])))
    return rows


def build_signals(cfg: dict, db: np.ndarray, segments: list[dict],
                  comments: list[tuple[float, str]]) -> dict[str, np.ndarray]:
    """使える信号だけの dict（チャットが無ければ音声の 3 つ）/ Only the available signals (3 audio ones without chat)."""
    n_bins = len(db)
    sigs = {
        'voice': signals.voice_spike(db, min_db=float(cfg['voice_min_db'])),
        'laugh': signals.laughter(db, segments, n_bins, laugh_words=tuple(cfg['laugh_words'])),
        'keyword': signals.keywords(segments, n_bins, cfg['keyword_words']),
    }
    if comments:
        sigs['chat'] = signals.chat_density([t for t, _ in comments], n_bins)
        sigs['chat_text'] = signals.chat_text_ratio(comments, n_bins, words=tuple(cfg['chat_words']))
    return sigs


def replace_own_candidates(client: api.Client, stamps: list[dict], by: str, dry_run: bool) -> int:
    """自分の生きている候補を墓標にして先に送る。dry-run は件数だけ。墓標にした（する）件数を返す。
    Tombstone the user's own alive candidates first; dry-run only counts. Returns how many were (would be) tombstoned."""
    # 候補の判定は signals と同じ規則を使う / same candidate rule as signals
    mine = [s for s in stamps if s.get('by') == by and not s.get('deleted')
            and signals._is_candidate(s.get('memo', ''))]
    if dry_run:
        log.info('--replace: %d 件を削除予定（dry-run のため送信しません）/ %d would be tombstoned (dry-run, not sent)',
                 len(mine), len(mine))
        return len(mine)
    if not mine:
        log.info('--replace: 自分の候補はありません / no own candidates')
        return 0
    ts = now_iso()
    tombs = [{**s, 'deleted': True, 'updated_at': ts} for s in mine]
    result = client.post('/api/stamps', {'records': tombs, 'source': 'scout'})
    accepted, rejected = result.get('accepted') or [], result.get('rejected') or []
    log.info('--replace: 削除 %d 件、拒否 %d 件 / tombstoned %d, rejected %d',
             len(accepted), len(rejected), len(accepted), len(rejected))
    for r in rejected:
        log.info('  拒否 / rejected %s: %s', r.get('id'), r.get('reason'))
    return len(mine)


def run(args: argparse.Namespace) -> int:
    cfg = load_config(Path(args.config))
    server = args.server or cfg['server']
    cap_total = args.top if args.top is not None else int(cfg['cap_total'])
    whisper_cfg = dict(cfg['whisper'])
    if args.cpu:
        whisper_cfg.update(device='cpu', compute_type='int8')

    client = api.Client(server, read_token(Path(cfg['token_path'])))
    try:
        me = client.get('/api/me')
    except api.ApiError as e:
        if e.status == 401:
            raise ScoutExit(2, 'ERR: トークンが無効です。/me で発行し直してください / The token is invalid. Issue a new one on /me') from None
        raise
    by = check_member(me if isinstance(me, dict) else {}, cfg['channel'])

    stream_id = args.stream or choose_stream(client, cfg['channel'])
    body = client.get(f'/api/streams/{stream_id}')
    stream = body.get('stream') if isinstance(body, dict) else None
    if not stream:
        raise ScoutExit(2, f'ERR: 配信が見つかりません / Stream not found: {stream_id}')
    vod_id = stream.get('vod_id')
    if not vod_id:
        raise ScoutExit(2, f'ERR: Web で VOD から登録してください（/s/{stream_id}）/ Register the VOD on the web first (/s/{stream_id})')
    vod_offset = float(stream.get('vod_offset_sec') or 0.0)

    cache = Path(cfg['cache_dir']) / str(vod_id)
    cache.mkdir(parents=True, exist_ok=True)
    attach_log_file(cache / 'scout.log')
    log.info('scout start %s stream=%s vod=%s', now_iso(), stream_id, vod_id)
    log.info('配信 / stream: %s %s  vod_offset_sec=%.1f', _jst(stream.get('started_at')), stream.get('title') or '', vod_offset)

    samples, sr, segments = prepare_audio(str(vod_id), cache, whisper_cfg)

    with Stage('fetch (api stamps + chat)'):
        stamps_body = client.get(f'/api/streams/{stream_id}/stamps')
        stamps = (stamps_body.get('records') if isinstance(stamps_body, dict) else stamps_body) or []
        chat = client.get(f'/api/streams/{stream_id}/chat')
        comments = chat_rows(chat if isinstance(chat, dict) else None)
    log.info('既存スタンプ / existing stamps: %d（墓標込み / incl. tombstones）、チャット / chat: %d', len(stamps), len(comments))

    blocked, existing_alive = signals.stamps_to_blocked(stamps, vod_offset)
    if args.replace:
        existing_alive = max(0, existing_alive - replace_own_candidates(client, stamps, by, args.dry_run))

    with Stage('score (signals)'):
        db = signals.rms_db(samples, sr)
        sigs = build_signals(cfg, db, segments, comments)
        weights = cfg['weights']
        score, contrib = signals.composite(sigs, weights)
        thr = signals.threshold(float(cfg['threshold']), weights, set(sigs))
        found = signals.peaks(score, thr, float(cfg['merge_sec']))
        kept = signals.exclude(found, blocked, float(cfg['exclude_radius_sec']))
        picked = sorted(signals.select_candidates(kept, cap_total, existing_alive))
    log.info('信号 / signals: %s  しきい値 / threshold %.2f  ピーク / peaks %d -> 除外後 / after exclusion %d'
             ' -> 候補 / candidates %d（上限 / cap %d - 既存 / existing %d）',
             ','.join(sigs), thr, len(found), len(kept), len(picked), cap_total, existing_alive)

    if not picked:
        log.info('候補なし / No candidates')
        return 1

    if not comments:
        log.info('チャット信号なし / no chat signals')
    ts = now_iso()
    records = []
    log.info('%3s  %-8s  %-8s  %5s  %s  |  %s', '#', '配信時刻', 'VOD時刻', '点', '理由', '発言')
    for i, (t_vod, sc) in enumerate(picked, 1):
        b = min(max(int(t_vod / signals.BIN_SEC), 0), len(db) - 1)
        why = signals.reason({k: float(v[b]) for k, v in contrib.items()}, cfg['names'], weights)
        said = signals.utterance(segments, t_vod)
        records.append(signals.to_record(t_vod, vod_offset, stream, by, signals.memo(why, said), ts, new_id()))
        log.info('%3d  %s  %s  %5.2f  %s  |  %s', i, hms(t_vod + vod_offset), hms(t_vod), sc, why, said)

    if args.dry_run:
        log.info('dry-run のため送信しません / dry-run: nothing sent')
        return 0
    answer = input('送信しますか？ / Send? y/N: ').strip().lower()
    if answer != 'y':
        log.info('送信しませんでした / Not sent')
        return 1
    result = client.post('/api/stamps', {'records': records, 'source': 'scout'})
    accepted, rejected = result.get('accepted') or [], result.get('rejected') or []
    log.info('受理 / accepted: %d、拒否 / rejected: %d', len(accepted), len(rejected))
    for r in rejected:
        log.info('  拒否 / rejected %s: %s', r.get('id'), r.get('reason'))
    if not accepted:
        raise ScoutExit(2, 'ERR: 1 件も受理されませんでした / Nothing was accepted')
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog='scout',
        description='Peakaboo Scout: VOD から見どころ候補を選んで送る / pick highlight candidates from a VOD and post them')
    p.add_argument('--stream', help='配信 id（省略で一覧から選ぶ）/ stream id (omit to pick from a list)')
    p.add_argument('--server', help='サーバー URL（設定を上書き）/ server URL (overrides the config)')
    p.add_argument('--dry-run', action='store_true', help='送信せず表だけ出す / show the table without sending')
    p.add_argument('--top', type=int, help='候補の上限（cap_total を上書き）/ candidate cap (overrides cap_total)')
    p.add_argument('--replace', action='store_true', help='自分の既存候補を消して選び直す / tombstone own candidates first')
    p.add_argument('--cpu', action='store_true', help='Whisper を CPU で動かす / run Whisper on CPU')
    p.add_argument('--config', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scout.config.json'),
                   help='設定ファイル / config file')
    args = p.parse_args(argv)
    if args.top is not None and args.top < 0:
        p.error('--top は 0 以上 / --top must be >= 0')
    return args


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')  # cp932 に無い文字で落ちない / survive chars outside cp932
    args = parse_args(argv)
    log.setLevel(logging.INFO)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(logging.Formatter('%(message)s'))
    log.addHandler(sh)
    try:
        return run(args)
    except ScoutExit as e:
        log.info('%s', e)
        return e.code
    except api.ApiError as e:
        log.error('ERR: サーバーエラー / Server error: HTTP %d %s', e.status, e.error)
        return 2
    except subprocess.CalledProcessError as e:
        log.error('ERR: %s が失敗しました / %s failed (exit %s)', e.cmd[0], e.cmd[0], e.returncode)
        return 2
    except (RuntimeError, ValueError, OSError) as e:
        log.error('ERR: %s', e)
        return 2


if __name__ == '__main__':
    sys.exit(main())
