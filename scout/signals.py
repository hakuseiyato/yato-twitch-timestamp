"""Scout の純粋ロジック: 0.5 秒ビンの信号を合成して見どころ候補を選ぶ。
Pure scoring logic for Scout: combine 0.5-s bin signals and pick highlight candidates.

I/O・ネットワーク・ffmpeg・whisper は扱わない（Task 6 の scout 本体が呼ぶ）。
No I/O, network, ffmpeg or whisper here; the Scout runner calls these functions.

時刻の約束 / Time conventions:
  音声・文字起こし・チャットは VOD 時刻。サーバーのスタンプ offset_sec は配信時刻 = VOD 時刻 + vod_offset_sec。
  Audio, transcript and chat are VOD time. Server stamp offset_sec is stream time = VOD time + vod_offset_sec.
"""
from __future__ import annotations

import math
import re

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

BIN_SEC = 0.5
CHAT_BIN_SEC = 30.0
_BINS_PER_CHAT = int(CHAT_BIN_SEC / BIN_SEC)
_CANDIDATE_RE = re.compile(r'^\s*候補[:：]')
_RECORD_KEYS = ('id', 'timecode', 'offset_sec', 'by', 'memo', 'native', 'channel', 'stream_id',
                'started_at', 'created_at', 'updated_at', 'deleted', 'clock_skew_ms')

Peak = tuple[float, float]  # (vod_time_sec, score)

# 合成前の正規化表。疎な 0/1 信号を z 化すると 1 区間で z≈95 になりしきい値が効かないため、各信号を [0, 1] に揃える。
# Normalisation table: z-scoring sparse 0/1 signals gives z≈95 for one segment, so every signal is mapped to [0, 1].
ZSCORED = ('chat',)  # 密な連続信号: clip(z, 0, 3) / 3 / dense continuous signal
SCALED = ('voice',)  # voice_spike の diff/min_db: clip(v, 0, 3) / 3 / already diff/min_db
# 他（laugh / keyword / chat_text）は 0..1 にクリップ / others are clipped to 0..1


def rms_db(samples: np.ndarray, sr: int, bin_sec: float = BIN_SEC) -> np.ndarray:
    """各ビンの RMS を dB で返す（端数サンプルは切り捨て）。
    RMS per bin in dB; trailing samples that do not fill a bin are dropped."""
    n = int(sr * bin_sec)
    k = len(samples) // n
    x = np.asarray(samples[:k * n], dtype=np.float64).reshape(k, n)
    return 20.0 * np.log10(np.sqrt(np.mean(x * x, axis=1)) + 1e-9)


def zscore(x: np.ndarray) -> np.ndarray:
    """標準化。一定値の列は NaN でなく全 0。
    Standardise; a constant series yields all zeros instead of NaN."""
    x = np.asarray(x, dtype=np.float64)
    sd = x.std()
    return np.zeros_like(x) if sd == 0 else (x - x.mean()) / sd


def _rise(db: np.ndarray, window_bins: int) -> np.ndarray:
    """直前 window_bins の中央値からの上昇量。直前が足りないビンは 0。
    Rise above the median of the previous window_bins; bins without enough history are 0."""
    db = np.asarray(db, dtype=np.float64)
    out = np.zeros_like(db)
    if len(db) > window_bins:
        med = np.median(sliding_window_view(db, window_bins)[:-1], axis=1)
        out[window_bins:] = db[window_bins:] - med
    return out


def voice_spike(db: np.ndarray, window_bins: int = 20, min_db: float = 8.0) -> np.ndarray:
    """声の急変: 上昇量が min_db 以上なら diff / min_db、未満は 0。
    Voice spike: diff / min_db when the rise is at least min_db, else 0."""
    diff = _rise(db, window_bins)
    return np.where(diff >= min_db, diff / min_db, 0.0)


def _segment_bins(seg: dict, n_bins: int) -> slice:
    """セグメント [start, end) が重なるビンの範囲。
    Bin range overlapped by a segment [start, end)."""
    if seg['end'] <= 0:
        return slice(0, 0)
    lo = max(0, int(seg['start'] / BIN_SEC))
    hi = max(lo + 1, int(math.ceil(seg['end'] / BIN_SEC)))
    return slice(lo, min(hi, n_bins))


def laughter(db: np.ndarray, segments: list[dict], n_bins: int,
             laugh_words: tuple[str, ...] = ('笑', 'ハハ', 'www', 'ｗ'), peak_db: float = 6.0) -> np.ndarray:
    """笑い: 笑いの語を含むセグメントの区間、または 2 秒（4 ビン）内に短いピークが 3 回以上ある区間を 1。
    Laughter: 1 over segments containing a laugh word, or where 3+ short peaks fall within 2 s (4 bins)."""
    out = np.zeros(n_bins)
    for seg in segments:
        if any(w in seg['text'] for w in laugh_words):
            out[_segment_bins(seg, n_bins)] = 1.0
    peak = (_rise(db, 20) >= peak_db)[:n_bins]
    for j in range(max(0, len(peak) - 3)):
        win = peak[j:j + 4]
        if win.sum() >= 3:
            out[j:j + 4][win] = 1.0
    return out


def keywords(segments: list[dict], n_bins: int, words: list[str] | tuple[str, ...]) -> np.ndarray:
    """発言: セグメント内の一致語数が 1 なら 0.8、2 以上なら 1.0 を区間のビンに。
    Keyword: 0.8 for one matched word in a segment, 1.0 for two or more, over its bins."""
    out = np.zeros(n_bins)
    for seg in segments:
        hits = sum(w in seg['text'] for w in words)
        if hits:
            s = _segment_bins(seg, n_bins)
            out[s] = np.maximum(out[s], 1.0 if hits >= 2 else 0.8)
    return out


def _expand(per_chat_bin: np.ndarray, n_bins: int) -> np.ndarray:
    """30 秒ビンの値を 0.5 秒ビンに 60 倍展開し n_bins に合わせる。
    Repeat each 30-s bin value 60x into 0.5-s bins, fitted to n_bins."""
    out = np.zeros(n_bins)
    rep = np.repeat(per_chat_bin, _BINS_PER_CHAT)[:n_bins]
    out[:len(rep)] = rep
    return out


def _chat_index(t: float, n_chat: int) -> int | None:
    i = int(t // CHAT_BIN_SEC)
    return i if 0 <= i < n_chat else None


def chat_density(comment_times: list[float], n_bins: int) -> np.ndarray:
    """チャット急増: 30 秒ビンごとのコメント数。
    Chat density: comment count per 30-s bin."""
    n_chat = -(-n_bins // _BINS_PER_CHAT)
    counts = np.zeros(n_chat)
    for t in comment_times:
        i = _chat_index(t, n_chat)
        if i is not None:
            counts[i] += 1
    return _expand(counts, n_bins)


def chat_text_ratio(comments: list[tuple[float, str]], n_bins: int,
                    words: list[str] | tuple[str, ...] = ('草', 'w', 'ｗ', '笑', 'かわいい')) -> np.ndarray:
    """チャットの反応: 30 秒ビン内で語を含むコメントの比率（0 件のビンは 0）。
    Chat reaction: share of comments containing a word per 30-s bin (0 when the bin is empty)."""
    n_chat = -(-n_bins // _BINS_PER_CHAT)
    total, hit = np.zeros(n_chat), np.zeros(n_chat)
    for t, text in comments:
        i = _chat_index(t, n_chat)
        if i is not None:
            total[i] += 1
            hit[i] += any(w in text for w in words)
    ratio = np.divide(hit, total, out=np.zeros(n_chat), where=total > 0)
    return _expand(ratio, n_bins)


def _normalise(key: str, v: np.ndarray) -> np.ndarray:
    """信号を正規化表に従って [0, 1] に揃える。
    Map a signal to [0, 1] following the normalisation table."""
    if key in ZSCORED:
        return np.clip(zscore(v), 0.0, 3.0) / 3.0
    if key in SCALED:
        return np.clip(np.asarray(v, dtype=np.float64), 0.0, 3.0) / 3.0
    return np.clip(np.asarray(v, dtype=np.float64), 0.0, 1.0)


def composite(signals: dict[str, np.ndarray],
              weights: dict[str, float]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """合成点と、信号ごとの重み付き正規化値（理由づけ用）。渡された信号だけを足す。
    Composite score and per-signal weighted normalised values (for reasons); only the given signals are summed."""
    contrib = {k: weights[k] * _normalise(k, v) for k, v in signals.items()}
    n = len(next(iter(signals.values()))) if signals else 0
    return sum(contrib.values(), np.zeros(n)), contrib


def threshold(base: float, weights: dict[str, float], available: set[str]) -> float:
    """使える信号の重みの割合でしきい値を縮める。
    Scale the threshold by the share of weight carried by the available signals."""
    return base * sum(w for k, w in weights.items() if k in available) / sum(weights.values())


def peaks(score: np.ndarray, thr: float, merge_sec: float = 20.0) -> list[Peak]:
    """しきい値以上のビンを merge_sec 以内で統合し、各塊の最大ビンの中央時刻と点を返す。
    Merge above-threshold bins within merge_sec; return the centre time and score of each run's max bin."""
    score = np.asarray(score, dtype=np.float64)
    idx = np.flatnonzero(score >= thr)
    if len(idx) == 0:
        return []
    gap = int(merge_sec / BIN_SEC)
    runs = np.split(idx, np.flatnonzero(np.diff(idx) > gap) + 1)
    result = []
    for run in runs:
        best = int(run[np.argmax(score[run])])
        result.append(((best + 0.5) * BIN_SEC, float(score[best])))
    return result


def exclude(peaks: list[Peak], blocked_vod_times: list[float], radius_sec: float = 30.0) -> list[Peak]:
    """既存スタンプの半径内（境界を含む）のピークを除く。
    Drop peaks within radius_sec of a blocked time, boundary inclusive."""
    return [p for p in peaks if all(abs(p[0] - b) > radius_sec for b in blocked_vod_times)]


def _is_candidate(memo_text: str) -> bool:
    """memo が `候補:` / `候補：` で始まるか（先頭空白可）。
    Whether the memo starts with the candidate prefix (either colon, leading whitespace allowed)."""
    return bool(_CANDIDATE_RE.match(memo_text or ''))


def stamps_to_blocked(stamps: list[dict], vod_offset_sec: float) -> tuple[list[float], int]:
    """除外する VOD 時刻（生きている人のスタンプ + 削除を問わない候補）と、生きている候補の数。
    Blocked VOD times (alive human stamps + candidates regardless of deletion) and the alive candidate count."""
    blocked: list[float] = []
    alive = 0
    for s in stamps:
        cand, deleted = _is_candidate(s.get('memo', '')), bool(s.get('deleted'))
        if cand or not deleted:
            blocked.append(float(s['offset_sec']) - vod_offset_sec)
        alive += cand and not deleted
    return blocked, alive


def reason(contrib: dict[str, float], names: dict[str, str], weights: dict[str, float]) -> str:
    """寄与が自分の重みの半分以上の信号名を高い順に `・` で結ぶ。無ければ最大の 1 つ。
    Join labels of signals contributing >= 0.5 x their weight, highest first, with `・`; else the single highest."""
    ranked = sorted(contrib.items(), key=lambda kv: kv[1], reverse=True)
    strong = [k for k, v in ranked if v >= 0.5 * weights[k]] or [ranked[0][0]]
    return '・'.join(names.get(k, k) for k in strong)


def utterance(segments: list[dict], t: float, before: float = 2.0, after: float = 3.0, limit: int = 60) -> str:
    """[t-before, t+after] に重なるセグメントの text を空白で結合し limit 文字で切る。
    Join texts of segments overlapping [t-before, t+after] with spaces, cut to limit chars."""
    texts = [s['text'].strip() for s in segments if s['end'] >= t - before and s['start'] <= t + after]
    return ' '.join(x for x in texts if x)[:limit]


def memo(reason_text: str, utter: str) -> str:
    """候補スタンプの memo 文字列。
    Memo text for a candidate stamp."""
    return '候補: ' + reason_text + (' | ' + utter if utter else '')


def to_record(t_vod: float, vod_offset_sec: float, stream: dict, by: str, memo_text: str,
              now_iso: str, new_id: str) -> dict:
    """サーバーへ送る 13 列のスタンプ行（offset_sec は配信時刻）。
    13-column stamp row for the server; offset_sec is stream time."""
    values = (new_id, '', round(t_vod + vod_offset_sec, 3), by, memo_text, False, stream['channel'],
              stream['stream_id'], stream['started_at'], now_iso, now_iso, False, 0)
    return dict(zip(_RECORD_KEYS, values))


def select_candidates(peaks: list[Peak], cap_total: int = 10, existing_alive: int = 0) -> list[Peak]:
    """点の高い順に cap_total - existing_alive 件（0 以下なら空）。
    Highest-scoring peaks up to cap_total - existing_alive (empty when that is <= 0)."""
    room = max(0, cap_total - existing_alive)
    return sorted(peaks, key=lambda p: p[1], reverse=True)[:room]


def pick_default_stream(streams: list[dict]) -> dict | None:
    """vod_id がある配信のうち started_at が最新のもの。無ければ None。
    Latest stream (by started_at) that has a vod_id, or None."""
    with_vod = [s for s in streams if s.get('vod_id')]
    return max(with_vod, key=lambda s: s.get('started_at') or '', default=None)
