"""TwitchDownloaderCLI のラッパー: チャット取得 → サーバー用の行に簡約 → 透過チャット動画の書き出し。
TwitchDownloaderCLI wrappers: download chat -> simplify into server rows -> render a transparent chat video.

導入 / Install
    `D:\\Tools\\TwitchDownloader\\TwitchDownloaderCLI.exe`
    `--version` → `TwitchDownloaderCLI 1.56.5+f8335cabef7436c362b13703359d440a26065bc4`
    （GitHub lay295/TwitchDownloader 1.56.5、TwitchDownloaderCLI-1.56.5-Windows-x64.zip、
    sha256 8b1b0695…13a0 は release の digest と一致 / matches the release digest）

`chatdownload --help` の要点 / Relevant flags
    -u/--id <VOD id>、-o/--output <.json|.html|.txt>、-E/--embed-images（絵文字・バッジを JSON に埋め込む /
    embed emotes and badges for offline rendering）、--collision Overwrite|Exit|Rename|Prompt（既定 Prompt）

`chatrender --help` の要点 / Relevant flags
    -i/--input、-o/--output、-b/--beginning・-e/--ending（#ms・#s・##:##:##）、-w/--chat-width（既定 350）、
    -h/--chat-height（既定 600）、--font-size（既定 12）、--background-color（'#RRGGBB' / '#AARRGGBB'、既定 #111111）、
    --generate-mask、--offline（JSON の埋め込み画像だけで描く / render only from embedded images）、
    --output-args（既定 `-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p "{save_path}"`）、--collision

render_cfg（設計 §4.9 の chat_render）→ CLI 引数 / render_cfg (design §4.9 chat_render) -> CLI flags
    width → -w、height → -h、font_size → --font-size、background → --background-color

透過の試験（VOD 2914625472、600〜610 秒）/ Transparency trials (VOD 2914625472, 600-610 s)
    x `.mov` + `--background-color #00000000` → h264 / yuv420p（既定の --output-args のままで alpha 無し / no alpha）
    x 上に `--generate-mask` を足す → `<name>.mov` と `<name>_mask.mov` の 2 本、どちらも h264 / yuv420p
      / plus --generate-mask -> two h264 yuv420p files (<name>.mov and <name>_mask.mov), still no alpha
    o `--output-args=-c:v qtrle -pix_fmt argb "{save_path}"` → qtrle / argb、10 秒で約 7.8 MB（採用 / chosen）
      参考 / for reference: prores_ks 4444 → yuva444p12le だが 10 秒 131 MB、png → rgba で 41 MB
    `--output-args` の値は `-c:v` で始まるため、`--output-args <値>` と分けると CLI が引数と誤読して失敗する。
    `=` で 1 つにつなぐ。
    The value starts with `-c:v`, so the CLI misreads a separate argument as a flag; join it with `=`.

`--collision Exit` は同名ファイルがあると書かずに終了コード 1 で終わる（夜の処理は上書きしない規則のため）。
`--collision Exit` leaves an existing file untouched and exits with code 1 (the night run never overwrites).
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

# 透過を保つ QuickTime Animation。上の試験を参照 / QuickTime Animation keeps alpha; see the trials above
ALPHA_OUTPUT_ARGS = '-c:v qtrle -pix_fmt argb "{save_path}"'


def ensure_installed(exe: Path) -> None:
    """TwitchDownloaderCLI の有無を確かめる。
    Check that TwitchDownloaderCLI exists.

    Parameters
    ----------
    exe : Path
        TwitchDownloaderCLI.exe のパス / Path to TwitchDownloaderCLI.exe.

    Raises
    ------
    RuntimeError
        ファイルが無い / The file does not exist.
    """
    if not Path(exe).is_file():
        raise RuntimeError(f'TwitchDownloaderCLI が見つかりません: {exe} / TwitchDownloaderCLI not found')


def chatdownload(exe: Path, vod_id: str, out_json: Path) -> None:
    """VOD のチャットを絵文字・バッジ込みの JSON に取得する（chatrender を --offline で回すため）。
    Download a VOD's chat as JSON with emotes and badges embedded (so chatrender can run --offline).

    Parameters
    ----------
    exe : Path
        TwitchDownloaderCLI.exe のパス / Path to TwitchDownloaderCLI.exe.
    vod_id : str
        数字だけの VOD id / Numeric VOD id.
    out_json : Path
        書き出す .json（既にあれば CLI は書かずに失敗する）/ Output .json (the CLI fails without writing if it exists).

    Raises
    ------
    ValueError
        vod_id が数字でない / vod_id is not numeric.
    subprocess.CalledProcessError
        CLI が失敗した / The CLI failed.
    """
    if not str(vod_id).isdigit():
        raise ValueError(f'VOD id が不正です / Invalid VOD id: {vod_id!r}')
    subprocess.run([str(exe), 'chatdownload', '-u', str(vod_id), '-o', str(out_json), '-E',
                    '--collision', 'Exit'], check=True)


def simplify_chat(td_json: dict) -> list[list]:
    """TwitchDownloader の comments[] をサーバー用の `[offset_sec, login, display, text]` に変換する。
    Convert TwitchDownloader's comments[] into server rows `[offset_sec, login, display, text]`.

    Parameters
    ----------
    td_json : dict
        chatdownload が書いた JSON / JSON written by chatdownload.

    Returns
    -------
    list[list]
        commenter が無ければ login・display は ''、負の offset は 0、本文の無いコメントは落とす。offset は丸めない。
        Blank login/display without a commenter, negative offsets become 0, body-less comments are dropped,
        offsets are not rounded.
    """
    rows: list[list] = []
    for comment in td_json.get('comments') or []:
        body = (comment.get('message') or {}).get('body')
        if not body:
            continue
        commenter = comment.get('commenter') or {}
        rows.append([max(0, comment['content_offset_seconds']), commenter.get('name') or '',
                     commenter.get('display_name') or '', body])
    return rows


def chat_json_for_server(vod_id: str, length_sec: int, rows: list[list]) -> bytes:
    """サーバーに置くチャット JSON（service/web/js/chat-fetch.js の buildChatJson と同じキー）。
    Chat JSON for the server (same keys as buildChatJson in service/web/js/chat-fetch.js).

    Parameters
    ----------
    vod_id : str
        VOD id。
    length_sec : int
        VOD の長さ（秒）/ VOD length in seconds.
    rows : list[list]
        simplify_chat の戻り値 / Rows from simplify_chat.

    Returns
    -------
    bytes
        UTF-8 の JSON / UTF-8 encoded JSON.
    """
    # JS の toISOString と同じ形（ミリ秒・Z）/ Same shape as JS toISOString (milliseconds, Z)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    data = {'vod_id': str(vod_id), 'length_sec': length_sec, 'fetched_at': fetched_at,
            'client': 'night/1.0', 'comments': rows}
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def render_window(t_vod: float, pre: float, post: float, length_sec: float) -> tuple[float, float]:
    """スタンプ時刻の前後で、VOD の範囲に収めた書き出し区間を返す。
    Render window around a stamp, clamped to the VOD.

    Returns
    -------
    tuple[float, float]
        `(max(0, t - pre), min(length, t + post))`
    """
    return max(0, t_vod - pre), min(length_sec, t_vod + post)


def chatrender(exe: Path, chat_json: Path, begin: float, end: float, out_mov: Path, render_cfg: dict) -> None:
    """chatdownload の JSON から、指定区間の透過チャット動画（qtrle / argb の .mov）を書き出す。
    Render a transparent chat video (qtrle / argb .mov) for the given range from chatdownload's JSON.

    Parameters
    ----------
    exe : Path
        TwitchDownloaderCLI.exe のパス / Path to TwitchDownloaderCLI.exe.
    chat_json : Path
        -E 付きで取った JSON（--offline で描くため）/ JSON downloaded with -E (rendered --offline).
    begin, end : float
        VOD 上の秒。ミリ秒に丸めて渡す / Seconds on the VOD, passed as whole milliseconds.
    out_mov : Path
        書き出す .mov（既にあれば CLI は書かずに失敗する）/ Output .mov (the CLI fails without writing if it exists).
    render_cfg : dict
        `width`・`height`・`font_size`・`background`（設計 §4.9 の chat_render）/ design §4.9 chat_render.

    Raises
    ------
    subprocess.CalledProcessError
        CLI が失敗した / The CLI failed.
    """
    subprocess.run([str(exe), 'chatrender', '-i', str(chat_json), '-o', str(out_mov),
                    '-b', f'{round(begin * 1000)}ms', '-e', f'{round(end * 1000)}ms',
                    '-w', str(render_cfg['width']), '-h', str(render_cfg['height']),
                    '--font-size', str(render_cfg['font_size']),
                    '--background-color', str(render_cfg['background']),
                    '--offline', f'--output-args={ALPHA_OUTPUT_ARGS}', '--collision', 'Exit'], check=True)
