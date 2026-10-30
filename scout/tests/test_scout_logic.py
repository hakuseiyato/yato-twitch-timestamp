# scout.py の純粋な判定（--replace の除外・チャット遅れ・配信前ピーク）のテスト。I/O は使わない
# Tests for scout.py's pure rules (--replace blocking, chat lag, pre-stream peaks); no I/O
import argparse
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

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


class PrepareAudioSourceTest(unittest.TestCase):
    def test_source_skips_fetch(self):
        with tempfile.TemporaryDirectory() as d:
            cache = Path(d)
            (cache / 'transcript.json').write_text('[]', encoding='utf-8')
            src = cache / 'vod.mp4'
            with mock.patch('scout.audio.fetch_audio') as fetch,                     mock.patch('scout.audio.to_wav16k') as to_wav,                     mock.patch('scout.audio.load_wav', return_value=(np.zeros(16000), 16000)):
                _samples, sr, segments = scout.prepare_audio('v1', cache, {}, source=str(src))
        fetch.assert_not_called()
        to_wav.assert_called_once_with(src, cache / 'audio16k.wav')
        self.assertEqual((sr, segments), (16000, []))

    def test_cached_wav_wins_over_source(self):
        with tempfile.TemporaryDirectory() as d:
            cache = Path(d)
            (cache / 'transcript.json').write_text('[]', encoding='utf-8')
            (cache / 'audio16k.wav').write_bytes(b'')
            with mock.patch('scout.audio.fetch_audio') as fetch,                     mock.patch('scout.audio.to_wav16k') as to_wav,                     mock.patch('scout.audio.load_wav', return_value=(np.zeros(16000), 16000)):
                scout.prepare_audio('v1', cache, {}, source=cache / 'vod.mp4')
        fetch.assert_not_called()
        to_wav.assert_not_called()


class ParseArgsTest(unittest.TestCase):
    def test_yes_and_source(self):
        args = scout.parse_args(['--yes', '--source', 'D:/x/vod.mp4'])
        self.assertTrue(args.yes)
        self.assertEqual(args.source, 'D:/x/vod.mp4')

    def test_defaults(self):
        args = scout.parse_args([])
        self.assertFalse(args.yes)
        self.assertIsNone(args.source)


class RunConfirmTest(unittest.TestCase):
    """--yes の分岐: 確認を飛ばして送る / The --yes branch: skip the prompt and send."""

    def _run(self, yes: bool, answer: str = 'n'):
        cfg_path = Path(scout.__file__).with_name('scout.config.json')
        cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
        stream = {'stream_id': 's1', 'channel': cfg['channel'], 'vod_id': 'v1', 'vod_offset_sec': 0, 'started_at': '2026-10-30T10:00:00Z',
                  'title': 't'}
        responses = {
            '/api/me': {'login': 'yato', 'channels': [{'login': cfg['channel']}]},
            '/api/streams/s1': {'stream': stream},
            '/api/streams/s1/stamps': {'records': []},
            '/api/streams/s1/chat': None,
        }
        client = mock.Mock()
        client.get.side_effect = lambda path: responses[path]
        client.post.return_value = {'accepted': ['x'], 'rejected': []}
        args = argparse.Namespace(config=str(cfg_path), server=None, top=None, cpu=False, stream='s1',
                                  replace=False, dry_run=False, yes=yes)
        with tempfile.TemporaryDirectory() as d:
            cfg['cache_dir'] = d
            with mock.patch('scout.load_config', return_value=cfg),                     mock.patch('scout.read_token', return_value='ytt_x'),                     mock.patch('scout.api.Client', return_value=client),                     mock.patch('scout.attach_log_file'),                     mock.patch('scout.prepare_audio', return_value=(np.zeros(16000 * 60), 16000, [])),                     mock.patch('scout.signals.peaks', return_value=[(30.0, 3.0)]),                     mock.patch('builtins.input', return_value=answer) as prompt:
                code = scout.run(args)
        return code, prompt, client

    def test_yes_sends_without_prompt(self):
        code, prompt, client = self._run(yes=True)
        self.assertEqual(code, 0)
        prompt.assert_not_called()
        client.post.assert_called_once()
        self.assertEqual(client.post.call_args[0][0], '/api/stamps')

    def test_without_yes_asks_and_respects_no(self):
        code, prompt, client = self._run(yes=False, answer='n')
        self.assertEqual(code, 1)
        prompt.assert_called_once()
        client.post.assert_not_called()


if __name__ == '__main__':
    unittest.main()
