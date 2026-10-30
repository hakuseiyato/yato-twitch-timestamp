# Scout の純粋ロジックのテスト / Tests for Scout's pure scoring logic
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import signals  # noqa: E402

NAMES = {'voice': '声の急変', 'laugh': '笑い', 'keyword': '発言', 'chat': 'チャット急増', 'chat_text': 'チャットの反応'}


class SignalsTest(unittest.TestCase):
    def test_zscore_constant_series(self):
        z = signals.zscore(np.full(10, 3.0))
        self.assertFalse(np.isnan(z).any())
        self.assertTrue((z == 0).all())

    def test_voice_spike_threshold(self):
        db = np.array([-40.0] * 20 + [-30.0])
        self.assertAlmostEqual(signals.voice_spike(db)[20], 1.25)
        db[20] = -35.0
        self.assertEqual(signals.voice_spike(db)[20], 0.0)

    def test_laughter_from_words_and_peaks(self):
        db = np.full(60, -40.0)
        out = signals.laughter(db, [{'start': 10, 'end': 11, 'text': 'あははは笑'}], 60)
        self.assertEqual(list(out[19:23]), [0, 1, 1, 0])
        db[[40, 41, 43]] = -30.0  # 4 ビン内に 3 ピーク / 3 peaks within 4 bins
        out = signals.laughter(db, [], 60)
        self.assertEqual(out[40], 1)
        self.assertEqual(out[10], 0)

    def test_keywords_scoring(self):
        words = ['やばい', '待って']
        segs = [{'start': 0, 'end': 1, 'text': 'これやばい'},
                {'start': 2, 'end': 3, 'text': 'やばい 待って'},
                {'start': 4, 'end': 5, 'text': 'ふつう'}]
        out = signals.keywords(segs, 12, words)
        self.assertAlmostEqual(out[0], 0.8)
        self.assertAlmostEqual(out[4], 1.0)
        self.assertEqual(out[8], 0.0)

    def test_chat_density_expands_to_half_second_bins(self):
        out = signals.chat_density([5.0, 10.0, 40.0], 150)
        self.assertEqual(len(out), 150)
        self.assertTrue((out[0:60] == 2).all())
        self.assertTrue((out[60:120] == 1).all())
        ratio = signals.chat_text_ratio([(1.0, '草'), (2.0, 'こんばんは'), (40.0, 'かわいい')], 150)
        self.assertTrue((ratio[0:60] == 0.5).all() and (ratio[60:120] == 1.0).all() and (ratio[120:] == 0).all())

    def test_threshold_without_chat(self):
        thr = signals.threshold(2.0, {'voice': 1, 'laugh': 1, 'kw': 0.8, 'chat': 1, 'chat_text': 0.5},
                                {'voice', 'laugh', 'kw'})
        self.assertAlmostEqual(thr, 2.0 * 2.8 / 4.3)

    def test_peaks_merge_within_20s(self):
        score = np.zeros(200)
        score[0:10] = 3.0
        score[30:36] = 3.0
        score[32] = 5.0
        p = signals.peaks(score, 2.0)
        self.assertEqual(p, [(16.25, 5.0)])
        score = np.zeros(200)
        score[0:10] = 3.0
        score[60] = 4.0
        self.assertEqual(len(signals.peaks(score, 2.0)), 2)

    def test_offset_roundtrip(self):
        stamps = [{'id': 'a', 'offset_sec': 600, 'by': 'yato', 'memo': 'ここ', 'deleted': False, 'native': True}]
        blocked, alive = signals.stamps_to_blocked(stamps, 120)
        self.assertEqual(blocked, [480.0])
        stream = {'stream_id': 's1', 'channel': 'terano_naa', 'started_at': '2026-10-30T10:00:00Z',
                  'vod_id': 'v1', 'vod_offset_sec': 120, 'title': 't'}
        rec = signals.to_record(480, 120, stream, 'scout', '候補: 笑い', '2026-10-30T12:00:00Z', 'id1')
        self.assertEqual(rec['offset_sec'], 600.0)
        self.assertEqual(list(rec), ['id', 'timecode', 'offset_sec', 'by', 'memo', 'native', 'channel',
                                     'stream_id', 'started_at', 'created_at', 'updated_at', 'deleted',
                                     'clock_skew_ms'])

    def test_exclude_radius(self):
        # ±30 秒は境界を含めて除外 / ±30 s excluded inclusive of the boundary
        kept = signals.exclude([(449.0, 1.0), (450.0, 1.0), (455.0, 1.0), (510.0, 1.0), (511.0, 1.0)], [480.0])
        self.assertEqual([t for t, _ in kept], [449.0, 511.0])

    def test_cap_counts_existing_candidates(self):
        ps = [(float(i), float(i)) for i in range(12)]
        sel = signals.select_candidates(ps, 10, 7)
        self.assertEqual([s for _, s in sel], [11.0, 10.0, 9.0])
        self.assertEqual(signals.select_candidates(ps, 10, 10), [])

    def test_stamps_to_blocked_counts_deleted_candidates(self):
        stamps = [{'offset_sec': 100, 'memo': '候補: 笑い', 'deleted': True},
                  {'offset_sec': 200, 'memo': ' 候補：発言', 'deleted': False},
                  {'offset_sec': 300, 'memo': '人のメモ', 'deleted': True},
                  {'offset_sec': 400, 'memo': '', 'deleted': False}]
        blocked, alive = signals.stamps_to_blocked(stamps, 0)
        self.assertEqual(sorted(blocked), [100.0, 200.0, 400.0])
        self.assertEqual(alive, 1)

    def test_memo_and_utterance_limit(self):
        segs = [{'start': 9.0, 'end': 12.0, 'text': 'あ' * 80}, {'start': 30.0, 'end': 31.0, 'text': '遠い'}]
        u = signals.utterance(segs, 10.0)
        self.assertEqual(u, 'あ' * 60)
        r = signals.reason({'laugh': 2.0, 'chat': 1.5, 'voice': 0.3}, NAMES)
        self.assertEqual(signals.memo(r, u), '候補: 笑い・チャット急増 | ' + 'あ' * 60)
        self.assertEqual(signals.reason({'voice': 0.4, 'chat': 0.7}, NAMES), 'チャット急増')

    def test_pick_default_stream(self):
        streams = [{'stream_id': 'a', 'started_at': '2026-10-29T10:00:00Z', 'vod_id': 'v1'},
                   {'stream_id': 'b', 'started_at': '2026-10-30T10:00:00Z', 'vod_id': None},
                   {'stream_id': 'c', 'started_at': '2026-10-28T10:00:00Z', 'vod_id': 'v0'}]
        self.assertEqual(signals.pick_default_stream(streams)['stream_id'], 'a')
        self.assertIsNone(signals.pick_default_stream([streams[1]]))


if __name__ == '__main__':
    unittest.main()
