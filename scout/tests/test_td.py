# td.py（TwitchDownloaderCLI のラッパー）のテスト。CLI は subprocess.run を差し替えて argv だけ検査する
# Tests for td.py (TwitchDownloaderCLI wrappers); the CLI is mocked and only its argv is checked
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import td  # noqa: E402

FIXTURE = Path(__file__).parent / 'fixtures' / 'td_chat_sample.json'
EXE = Path(r'D:\Tools\TwitchDownloader\TwitchDownloaderCLI.exe')
RENDER_CFG = {'width': 400, 'height': 1080, 'font_size': 24, 'background': '#00000000'}


def _load_fixture() -> dict:
    with open(FIXTURE, encoding='utf-8') as f:
        return json.load(f)


def _value_after(argv: list, flag: str) -> str:
    return argv[argv.index(flag) + 1]


class SimplifyChatTest(unittest.TestCase):
    def setUp(self):
        self.rows = td.simplify_chat(_load_fixture())

    def test_three_rows_body_less_dropped(self):
        # 本文の無い viewer_c の行は落ちる / viewer_c has no body and is dropped
        self.assertEqual(len(self.rows), 3)
        self.assertNotIn('viewer_c', [r[1] for r in self.rows])

    def test_plain_row_keeps_fractional_offset(self):
        self.assertEqual(self.rows[0], [12.5, 'viewer_a', '視聴者A', 'こんばんは'])

    def test_null_commenter_is_blank(self):
        self.assertEqual(self.rows[1], [30, '', '', '名前のない人のコメント'])

    def test_negative_offset_is_zero(self):
        self.assertEqual(self.rows[2], [0, 'viewer_b', 'viewer_b', '始まる前の一言'])


class ChatJsonForServerTest(unittest.TestCase):
    def test_keys_and_values(self):
        rows = [[12.5, 'viewer_a', '視聴者A', 'こんばんは']]
        raw = td.chat_json_for_server('2914625472', 5911, rows)
        self.assertIsInstance(raw, bytes)
        data = json.loads(raw)
        self.assertEqual(set(data), {'vod_id', 'length_sec', 'fetched_at', 'client', 'comments'})
        self.assertEqual(data['vod_id'], '2914625472')
        self.assertEqual(data['length_sec'], 5911)
        self.assertEqual(data['client'], 'night/1.0')
        self.assertEqual(data['comments'], rows)
        # ISO 8601 で読めること / fetched_at parses as ISO 8601
        datetime.fromisoformat(data['fetched_at'].replace('Z', '+00:00'))


class RenderWindowTest(unittest.TestCase):
    def test_clamped_at_start(self):
        self.assertEqual(td.render_window(10, 15, 45, 5911), (0, 55))

    def test_clamped_at_end(self):
        self.assertEqual(td.render_window(5900, 15, 45, 5911), (5885, 5911))


class EnsureInstalledTest(unittest.TestCase):
    def test_missing(self):
        missing = Path(tempfile.gettempdir()) / 'no_such_dir_td' / 'TwitchDownloaderCLI.exe'
        with self.assertRaises(RuntimeError) as cm:
            td.ensure_installed(missing)
        self.assertIn('TwitchDownloaderCLI が見つかりません', str(cm.exception))
        self.assertIn('TwitchDownloaderCLI not found', str(cm.exception))
        self.assertIn(str(missing), str(cm.exception))

    def test_present(self):
        with tempfile.TemporaryDirectory() as d:
            exe = Path(d) / 'TwitchDownloaderCLI.exe'
            exe.write_bytes(b'')
            td.ensure_installed(exe)


class ChatDownloadTest(unittest.TestCase):
    def test_argv(self):
        out = Path(r'C:\tmp\chat.json')
        with mock.patch('td.subprocess.run') as run:
            td.chatdownload(EXE, '2914625472', out)
        run.assert_called_once()
        argv = run.call_args.args[0]
        self.assertEqual(argv[:2], [str(EXE), 'chatdownload'])
        self.assertEqual(_value_after(argv, '-u'), '2914625472')
        self.assertEqual(_value_after(argv, '-o'), str(out))
        self.assertIn('-E', argv)
        self.assertEqual(_value_after(argv, '--collision'), 'Exit')
        self.assertTrue(run.call_args.kwargs.get('check'))

    def test_non_numeric_vod_id(self):
        with mock.patch('td.subprocess.run') as run:
            with self.assertRaises(ValueError):
                td.chatdownload(EXE, '123 --x', Path(r'C:\tmp\chat.json'))
        run.assert_not_called()

    def test_failure_propagates(self):
        err = subprocess.CalledProcessError(1, ['x'])
        with mock.patch('td.subprocess.run', side_effect=err):
            with self.assertRaises(subprocess.CalledProcessError):
                td.chatdownload(EXE, '2914625472', Path(r'C:\tmp\chat.json'))


class ChatRenderTest(unittest.TestCase):
    def _argv(self, begin, end):
        with mock.patch('td.subprocess.run') as run:
            td.chatrender(EXE, Path(r'C:\tmp\chat.json'), begin, end, Path(r'C:\tmp\s01.mov'), RENDER_CFG)
        run.assert_called_once()
        self.assertTrue(run.call_args.kwargs.get('check'))
        return run.call_args.args[0]

    def test_argv(self):
        argv = self._argv(600, 610)
        self.assertEqual(argv[:2], [str(EXE), 'chatrender'])
        self.assertEqual(_value_after(argv, '-i'), r'C:\tmp\chat.json')
        self.assertEqual(_value_after(argv, '-o'), r'C:\tmp\s01.mov')
        self.assertEqual(_value_after(argv, '-b'), '600000ms')
        self.assertEqual(_value_after(argv, '-e'), '610000ms')
        self.assertEqual(_value_after(argv, '-w'), '400')
        self.assertEqual(_value_after(argv, '-h'), '1080')
        self.assertEqual(_value_after(argv, '--font-size'), '24')
        self.assertEqual(_value_after(argv, '--background-color'), '#00000000')
        self.assertIn('--offline', argv)
        self.assertEqual(_value_after(argv, '--collision'), 'Exit')
        # 透過は QuickTime Animation（argb）/ Transparency comes from QuickTime Animation (argb)
        self.assertIn('--output-args=-c:v qtrle -pix_fmt argb "{save_path}"', argv)

    def test_fractional_seconds_to_ms(self):
        argv = self._argv(585.5, 645.25)
        self.assertEqual(_value_after(argv, '-b'), '585500ms')
        self.assertEqual(_value_after(argv, '-e'), '645250ms')


if __name__ == '__main__':
    unittest.main()
