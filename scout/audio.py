"""Scout の音声処理: yt-dlp で VOD 音声を取得 → ffmpeg で 16 kHz WAV → faster-whisper で文字起こし。
Scout audio stage: fetch VOD audio with yt-dlp -> 16 kHz WAV with ffmpeg -> transcribe with faster-whisper.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import subprocess
import wave
from pathlib import Path

import numpy as np

log = logging.getLogger('scout')

# yt-dlp の途中ファイル（audio.mp4.part 等）を完成品と取り違えないため、拡張子が 1 つのものだけ採る
# Only names with a single extension count, so yt-dlp leftovers such as audio.mp4.part are never reused
def _finished_audio(cache_dir: Path) -> Path | None:
    found = sorted(p for p in cache_dir.glob('audio.*') if p.name.count('.') == 1)
    return found[0] if found else None


def _run(tool: str, args: list[str]) -> None:
    """外部ツールを実行。見つからなければ日英のメッセージで RuntimeError。
    Run an external tool; RuntimeError with a bilingual message when it is missing."""
    try:
        subprocess.run([tool, *args], check=True)
    except FileNotFoundError:
        raise RuntimeError(f'{tool} が見つかりません / {tool} not found') from None


def fetch_audio(vod_id: str, cache_dir: Path) -> Path:
    """Twitch VOD の音声だけを取得（既にあれば再利用）。
    Download only the audio of a Twitch VOD (reused when already cached).

    Parameters
    ----------
    vod_id : str
        数字だけの VOD id / Numeric VOD id.
    cache_dir : Path
        `<cache_dir>/<vod_id>/` / The per-VOD cache folder.

    Returns
    -------
    Path
        `audio.<ext>`（拡張子は yt-dlp 次第）/ `audio.<ext>` (extension decided by yt-dlp).

    Raises
    ------
    ValueError
        vod_id が数字でない / vod_id is not numeric.
    RuntimeError
        yt-dlp が無い、または出力が見つからない / yt-dlp is missing or produced no file.
    subprocess.CalledProcessError
        yt-dlp が失敗した / yt-dlp failed.
    """
    if not str(vod_id).isdigit():
        raise ValueError(f'VOD id が不正です / Invalid VOD id: {vod_id!r}')
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = _finished_audio(cache_dir)
    if cached:
        return cached
    _run('yt-dlp', ['-f', 'Audio_Only', '-o', str(cache_dir / 'audio.%(ext)s'),
                    f'https://www.twitch.tv/videos/{vod_id}'])
    out = _finished_audio(cache_dir)
    if out is None:
        raise RuntimeError(f'yt-dlp の出力が見つかりません / yt-dlp produced no file in {cache_dir}')
    return out


def to_wav16k(src: Path, dst: Path) -> Path:
    """モノラル 16 kHz の WAV に変換。途中で止まった WAV を再利用しないよう一時名に書いてから置き換える。
    Convert to mono 16 kHz WAV, writing to a temp name first so a half-written WAV is never reused."""
    tmp = dst.with_name(dst.stem + '.tmp.wav')
    _run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', str(src),
                    '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', str(tmp)])
    os.replace(tmp, dst)
    return dst


def load_wav(path: Path) -> tuple[np.ndarray, int]:
    """16 bit WAV を float32（-1..1）で読む / Read a 16-bit WAV as float32 in -1..1.

    Raises
    ------
    ValueError
        16 bit モノラルでない / Not 16-bit mono.
    """
    with wave.open(str(path), 'rb') as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError(f'16 bit モノラルの WAV ではありません / Not a 16-bit mono WAV: {path}')
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0, sr


def _add_cuda_dll_path() -> None:
    """pip の nvidia-cublas-cu12 等の DLL フォルダを PATH の先頭に足す。
    ctranslate2 は cublas64_12.dll を PATH から探し、os.add_dll_directory では見つけない（2026-10-30 実測）。
    Prepend the DLL folders of pip's nvidia-cublas-cu12 etc. to PATH.
    ctranslate2 looks up cublas64_12.dll on PATH and ignores os.add_dll_directory (measured 2026-10-30)."""
    spec = importlib.util.find_spec('nvidia')
    if spec is None or not spec.submodule_search_locations:
        return
    dirs = [str(p) for root in spec.submodule_search_locations for p in Path(root).glob('*/bin') if p.is_dir()]
    path = os.environ.get('PATH', '')
    missing = [d for d in dirs if d not in path.split(os.pathsep)]
    if missing:
        os.environ['PATH'] = os.pathsep.join([*missing, path])


def _transcribe_with(samples: np.ndarray, cfg: dict, device: str, compute_type: str) -> list[dict]:
    from faster_whisper import WhisperModel  # 重いので使うときだけ読む / heavy, imported on use

    if device != 'cpu':
        _add_cuda_dll_path()

    model = WhisperModel(cfg['model'], device=device, compute_type=compute_type)
    # 同梱の PyAV が古くファイルパスを渡すと失敗するため、numpy 配列を渡す
    # The bundled PyAV is old and fails on file paths, so a numpy array is passed
    segments, _info = model.transcribe(samples, language=cfg.get('language'), vad_filter=True,
                                       beam_size=int(cfg.get('beam_size', 5)))
    out: list[dict] = []
    next_report = 600.0
    for seg in segments:  # 生成器なので CUDA の失敗はここで出ることがある / lazy: CUDA errors may surface here
        out.append({'start': float(seg.start), 'end': float(seg.end), 'text': seg.text})
        if seg.end >= next_report:
            log.info('  whisper %d:%02d:00 まで / up to %d:%02d:00 (%d segments)',
                     int(seg.end // 3600), int(seg.end % 3600 // 60),
                     int(seg.end // 3600), int(seg.end % 3600 // 60), len(out))
            next_report += 600.0
    return out


def transcribe(samples: np.ndarray, cfg: dict) -> list[dict]:
    """faster-whisper で文字起こし。CUDA が使えなければ CPU（int8）で再試行する。
    Transcribe with faster-whisper; retry on CPU (int8) when CUDA fails.

    Parameters
    ----------
    samples : np.ndarray
        16 kHz モノラルの float32 / 16 kHz mono float32.
    cfg : dict
        設定の `whisper`（model / device / compute_type / language / beam_size）/ The config's `whisper` block.

    Returns
    -------
    list[dict]
        `[{start, end, text}]`（VOD 秒）/ `[{start, end, text}]` in VOD seconds.
    """
    device, compute_type = cfg.get('device', 'cuda'), cfg.get('compute_type', 'float16')
    try:
        return _transcribe_with(samples, cfg, device, compute_type)
    except (RuntimeError, ValueError, OSError) as e:
        if device == 'cpu':
            raise
        log.warning('CUDA で失敗したので CPU（int8）で再試行します / CUDA failed, retrying on CPU (int8): %s', e)
        return _transcribe_with(samples, cfg, 'cpu', 'int8')
