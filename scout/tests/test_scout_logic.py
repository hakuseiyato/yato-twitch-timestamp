# scout.py の純粋な判定（--replace の除外・チャット遅れ・配信前ピーク）のテスト。I/O は使わない
# Tests for scout.py's pure rules (--replace blocking, chat lag, pre-stream peaks); no I/O
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import scout  # noqa: E402
import signals  # noqa: E402


def _stamp(sid: str, offset: float, by: str, memo: str, deleted: bool = False) -> dict:
    return {'id': sid, 'offset_sec': offset, 'by': by, 'memo': memo, 'deleted': deleted}


# (a) 自分の生きた候補 / own alive candidate、(b) 他人の生きた候補 / someone else's alive candidate、
# (c) 自分の削除済み候補 / own deleted candidate、(d) 人のスタンプ / human stamp
STAMPS = [
    _stamp('a', 600, 'yato', '候補: 笑い'),
    _stamp('b', 700, 'other', '候補: 声の急変'),
    _stamp('c', 800, 'yato', '候補: 発言', deleted=True),
    _stamp('d', 900, 'yato', 'ここ好き'),
]


class ReplaceRulingTest(unittest.TestCase):
    def test_own_alive_candidates_only(self):
        self.assertEqual([s['id'] for s in scout.own_alive_candidates(STAMPS, 'yato')], ['a'])

    def test_own_alive_candidates_case_insensitive(self):
        # サーバーは小文字で比べる / The server compares lowercased logins
        self.assertEqual([s['id'] for s in scout.own_alive_candidates(STAMPS, 'Yato')], ['a'])

    def test_blocking_excludes_only_replaced(self):
        replaced_ids = {s['id'] for s in scout.own_alive_candidates(STAMPS, 'yato')}
        kept = scout.stamps_for_blocking(STAMPS, replaced_ids)
        self.assertEqual([s['id'] for s in kept], ['b', 'c', 'd'])
        blocked, existing_alive = signals.stamps_to_blocked(kept, 0.0)
        self.assertEqual(sorted(blocked), [700.0, 800.0, 900.0])
        self.assertEqual(existing_alive, 1)  # (b) だけ / only (b)

    def test_blocking_without_replace_keeps_all(self):
        self.assertEqual(len(scout.stamps_for_blocking(STAMPS, set())), 4)


class ChatRowsTest(unittest.TestCase):
    def test_chat_lag_subtracted(self):
        chat = {'comments': [[65, 'u', 'U', 'www']]}
        self.assertEqual(scout.chat_rows(chat, 5.0), [(60.0, 'www')])

    def test_malformed_rows_skipped(self):
        chat = {'comments': [[65, 'u', 'U', 'ok'], ['x', 'u', 'U', 'bad'], [1, 'u'], 'junk', None]}
        self.assertEqual(scout.chat_rows(chat, 0.0), [(65.0, 'ok')])
        self.assertEqual(scout.chat_rows(None), [])


class PeaksInStreamTest(unittest.TestCase):
    def test_drops_peaks_before_stream_start(self):
        # vod_offset_sec が負なら配信開始前（配信時刻 < 0）のピークは送れない
        # With a negative vod_offset_sec, peaks before the stream start (stream time < 0) cannot be posted
        peaks = [(10.0, 3.0), (30.0, 2.5), (31.0, 2.1)]
        self.assertEqual(scout.peaks_in_stream(peaks, -30.0), [(30.0, 2.5), (31.0, 2.1)])
        self.assertEqual(scout.peaks_in_stream(peaks, 0.0), peaks)


if __name__ == '__main__':
    unittest.main()
