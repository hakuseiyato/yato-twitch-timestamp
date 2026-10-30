# night.py（夜の処理の段・状態・通知）のテスト。ネットワークと外部コマンドは差し替える
# Tests for night.py (night-run steps, state, notify); network and external commands are mocked
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# `python -m unittest scout.tests.…` は scout/ を名前空間パッケージとして先に読む。night には scout.py を読ませ、
# 読んだ後でパッケージを戻す（unittest がパッケージから tests をたどるため）
# The dotted invocation imports the scout/ directory as a namespace package first; night gets scout.py, then the
# package is put back because unittest walks scout.tests from it
_scout_pkg = sys.modules.pop('scout') if not hasattr(sys.modules.get('scout'), 'run') and 'scout' in sys.modules else None
import night  # noqa: E402
if _scout_pkg is not None:
    sys.modules['scout'] = _scout_pkg
import night_lib  # noqa: E402

VOD = {'id': '2914625472', 'title': 'VALORANTやる', 'lengthSeconds': 5911,
       'createdAt': '2026-10-30T06:03:22Z', 'status': 'RECORDED'}
ROW = {'stream_id': '316644129905', 'channel': 'terano_naa', 'started_at': '2026-10-30T06:03:17.000Z',
       'title': 'VALORANTやる', 'vod_id': '2914625472', 'vod_offset_sec': 0, 'chat_count': 120}
NIGHT_CFG = {'channel': 'terano_naa', 'footage_root': '', 'twitch_downloader': r'D:\Tools\TD\TwitchDownloaderCLI.exe',
             'pre_sec': 15, 'post_sec': 45,
             'chat_render': {'width': 400, 'height': 1080, 'font_size': 24, 'background': '#00000000'},
             'caption_line_chars': 20, 'poll_minutes': 10}


class FakeClient:
    """GET は道筋の辞書から返し、書き込みは MagicMock で記録する / GET answers from a route dict; writes are recorded."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.post = mock.MagicMock(return_value={'stream': {}})
        self.patch = mock.MagicMock(return_value={'stream': {}})
        self.put_raw = mock.MagicMock(return_value={'chat_count': 0})

    def get(self, path):
        return self.routes[path]


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.cache = self.tmp / 'cache'
        self.footage = self.tmp / 'Footage'
        self.state = night.State(self.tmp / 'night' / 'state.json').load()
        self.notify = mock.MagicMock()
        self.status = mock.MagicMock()

    def tearDown(self):
        self._tmp.cleanup()

    def ctx(self, client=None, row=None):
        return night.JobContext(client=client, cfg={'channel': 'terano_naa', 'cache_dir': str(self.cache)},
                                night_cfg=dict(NIGHT_CFG), state=self.state, vod=dict(VOD), stream_row=row,
                                footage_root=self.footage, notify=self.notify, status=self.status)


class StateTest(Base):
    def test_save_load_round_trip(self):
        job = self.state.job('2914625472')
        job['steps']['vod'] = 'done'
        self.state.record_live({'id': '316644129905', 'title': 'VALORANTやる'}, seen_at='2026-10-30T06:10:00Z')
        self.state.save()
        again = night.State(self.state.path).load()
        self.assertEqual(again.jobs['2914625472']['steps'], {'vod': 'done'})
        self.assertEqual(again.data['last_live']['stream_id'], '316644129905')
        self.assertEqual(again.live_history[0]['seen_at'], '2026-10-30T06:10:00Z')
        # 一時ファイルは残らない / no temp file is left behind
        self.assertEqual(sorted(p.name for p in self.state.path.parent.iterdir()), ['state.json'])

    def test_record_live_keeps_latest_20(self):
        for i in range(25):
            self.state.record_live({'id': str(1000 + i), 'title': ''}, seen_at=f'2026-10-30T06:{i:02d}:00Z')
        ids = [e['stream_id'] for e in self.state.live_history]
        self.assertEqual(len(ids), 20)
        self.assertEqual(ids[0], '1005')
        self.assertEqual(ids[-1], '1024')

    def test_record_live_same_stream_once_but_last_live_moves(self):
        self.state.record_live({'id': '7', 'title': 'a'}, seen_at='2026-10-30T06:00:00Z')
        self.state.record_live({'id': '7', 'title': 'a'}, seen_at='2026-10-30T06:10:00Z')
        # 履歴は最初に見た時刻（VOD 開始に近い）、last_live は最後に見た時刻
        # History keeps the first sighting (closest to the VOD start); last_live the latest
        self.assertEqual([e['seen_at'] for e in self.state.live_history], ['2026-10-30T06:00:00Z'])
        self.assertEqual(self.state.data['last_live']['seen_at'], '2026-10-30T06:10:00Z')


def _marking(name):
    """段の偽物: 呼ばれたら done を書く / Fake step that marks itself done."""
    def fake(ctx, job):
        job['steps'][name] = 'done'
    return mock.MagicMock(side_effect=fake)


class RunJobTest(Base):
    def _patch_steps(self, **overrides):
        fakes = {name: overrides.get(name) or _marking(name) for name in night_lib.STEP_ORDER}
        patches = [mock.patch.object(night, f'step_{name}', fake) for name, fake in fakes.items()]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return fakes

    def test_done_steps_are_not_called(self):
        job = self.state.job(VOD['id'])
        job['steps'].update(vod='done', chat='done')
        fakes = self._patch_steps()
        result = night.run_job(self.ctx())
        self.assertEqual(fakes['vod'].call_count, 0)
        self.assertEqual(fakes['chat'].call_count, 0)
        for name in ('scout', 'render', 'captions', 'plan'):
            self.assertEqual(fakes[name].call_count, 1, name)
        self.assertIsNone(night_lib.next_step(result))
        # 段ごとに状態を出し、状態ファイルにも全段 done が残る / status per step, and the file holds every step done
        self.assertEqual([c.args[0] for c in self.status.call_args_list][:4],
                         ['処理中: 候補', '処理中: チャット動画', '処理中: 字幕', '処理中: 計画'])
        saved = night.State(self.state.path).load().jobs[VOD['id']]
        self.assertTrue(all(saved['steps'][s] == 'done' for s in night_lib.STEP_ORDER))

    def test_three_failures_on_same_step_stop_the_job(self):
        job = self.state.job(VOD['id'])
        job['steps'].update(vod='done', chat='done')
        failing = mock.MagicMock(side_effect=RuntimeError('GPU が見つかりません'))
        fakes = self._patch_steps(scout=failing)
        for attempt in (1, 2):
            result = night.run_job(self.ctx())
            self.assertEqual(result['error'], {'step': 'scout', 'reason': 'エラー: RuntimeError: GPU が見つかりません',
                                               'count': attempt})
            self.assertFalse(result.get('stopped'))
            self.notify.assert_not_called()
        result = night.run_job(self.ctx())
        self.assertTrue(result['stopped'])
        self.assertEqual(result['error']['count'], 3)
        self.notify.assert_called_once()
        text = self.notify.call_args.args[0]
        self.assertTrue(text.startswith('Peakaboo: 失敗: 候補 — '), text)
        # 止まった job はもう段を呼ばない / a stopped job runs no more steps
        night.run_job(self.ctx())
        self.assertEqual(failing.call_count, 3)
        self.assertEqual(fakes['render'].call_count, 0)
        self.assertTrue(night.State(self.state.path).load().jobs[VOD['id']]['stopped'])

    def test_count_resets_when_failing_step_changes(self):
        job = self.state.job(VOD['id'])
        job['steps'].update(vod='done')
        job['error'] = {'step': 'vod', 'reason': 'x', 'count': 2}
        self._patch_steps(chat=mock.MagicMock(side_effect=RuntimeError('boom')))
        result = night.run_job(self.ctx())
        self.assertEqual(result['error']['step'], 'chat')
        self.assertEqual(result['error']['count'], 1)


class StepChatTest(Base):
    def setUp(self):
        super().setUp()
        self.chat_dir = self.cache / VOD['id']
        self.td_json = {'comments': [{'content_offset_seconds': 1.5, 'commenter': {'name': 'a', 'display_name': 'A'},
                                      'message': {'body': 'こんばんは'}}]}

    def _client(self, row):
        return FakeClient({'/api/channels/terano_naa/streams': {'streams': [row]},
                           f'/api/streams/{row["stream_id"]}': {'stream': row}})

    def _fake_download(self, exe, vod_id, out_json):
        Path(out_json).write_text(json.dumps(self.td_json), encoding='utf-8')

    def test_imported_chat_is_not_uploaded_but_offset_is_set(self):
        client = self._client(dict(ROW))
        job = self.state.job(VOD['id'])
        with mock.patch.object(night.td, 'ensure_installed'), \
                mock.patch.object(night.td, 'chatdownload', side_effect=self._fake_download) as dl:
            night.step_chat(self.ctx(client), job)
        client.put_raw.assert_not_called()
        client.patch.assert_called_once_with('/api/streams/316644129905', {'vod_offset_sec': 5.0})
        # 描画用の JSON は取り、途中名は残らない / the JSON is still fetched for rendering, no partial name left
        dl.assert_called_once()
        self.assertEqual(dl.call_args.args[2].name, 'chat.part.json')
        self.assertTrue((self.chat_dir / 'chat.json').exists())
        self.assertFalse((self.chat_dir / 'chat.part.json').exists())
        self.assertEqual(job['stream_id'], '316644129905')
        self.assertEqual(job['steps']['chat'], 'done')

    def test_missing_chat_is_uploaded(self):
        row = dict(ROW, chat_count=None, vod_offset_sec=5)
        client = self._client(row)
        job = self.state.job(VOD['id'])
        with mock.patch.object(night.td, 'ensure_installed'), \
                mock.patch.object(night.td, 'chatdownload', side_effect=self._fake_download):
            night.step_chat(self.ctx(client), job)
        client.put_raw.assert_called_once()
        path, body, ctype = client.put_raw.call_args.args
        self.assertEqual(path, '/api/streams/316644129905/chat?vod_id=2914625472&count=1&length_sec=5911')
        self.assertEqual(ctype, 'application/json')
        self.assertEqual(json.loads(body)['comments'], [[1.5, 'a', 'A', 'こんばんは']])
        # 人が設定した offset は触らない / a human-set offset is left alone
        client.patch.assert_not_called()

    def test_large_offset_is_noted_not_patched(self):
        client = self._client(dict(ROW, started_at='2026-10-30T05:00:00Z'))
        job = self.state.job(VOD['id'])
        with mock.patch.object(night.td, 'ensure_installed'), \
                mock.patch.object(night.td, 'chatdownload', side_effect=self._fake_download):
            night.step_chat(self.ctx(client), job)
        client.patch.assert_not_called()
        self.assertIn('3802', job['offset_note'])

    def test_unknown_vod_registers_a_vod_stream(self):
        created = dict(ROW, stream_id='vod-2914625472', started_at=VOD['createdAt'], chat_count=None)
        client = FakeClient({'/api/channels/terano_naa/streams': {'streams': []},
                             '/api/streams/vod-2914625472': {'stream': created}})
        client.post.return_value = {'stream': created}
        job = self.state.job(VOD['id'])
        with mock.patch.object(night.td, 'ensure_installed'), \
                mock.patch.object(night.td, 'chatdownload', side_effect=self._fake_download):
            night.step_chat(self.ctx(client), job)
        client.post.assert_called_once_with('/api/streams', {
            'stream_id': 'vod-2914625472', 'channel': 'terano_naa', 'started_at': VOD['createdAt'],
            'title': VOD['title'], 'vod_id': VOD['id']})
        self.assertEqual(job['stream_id'], 'vod-2914625472')


    def test_offset_note_only_when_unset(self):
        # 人が設定済み（5 秒）なら差が大きくても書かない / no note when a person already set the offset
        client = self._client(dict(ROW, started_at='2026-10-30T05:00:00Z', vod_offset_sec=5))
        job = self.state.job(VOD['id'])
        with mock.patch.object(night.td, 'ensure_installed'),                 mock.patch.object(night.td, 'chatdownload', side_effect=self._fake_download):
            night.step_chat(self.ctx(client), job)
        self.assertNotIn('offset_note', job)

    def test_cached_chat_needs_no_cli(self):
        self.chat_dir.mkdir(parents=True)
        (self.chat_dir / 'chat.json').write_text(json.dumps(self.td_json), encoding='utf-8')
        client = self._client(dict(ROW))
        job = self.state.job(VOD['id'])
        with mock.patch.object(night.td, 'ensure_installed', side_effect=RuntimeError('missing')) as ensure,                 mock.patch.object(night.td, 'chatdownload') as dl:
            night.step_chat(self.ctx(client), job)
        ensure.assert_not_called()
        dl.assert_not_called()
        self.assertEqual(job['steps']['chat'], 'done')


class StatePathTest(unittest.TestCase):
    def test_config_root_uses_shared_state(self):
        self.assertEqual(night.state_path_for(r'D:\Work_HDD\Footage', r'D:\Work_HDD\Footage'),
                         night.NIGHT_DIR / 'state.json')

    def test_other_root_gets_its_own_state(self):
        root = r'C:\Work\Yato\Claude\_scratch\night_test\寺乃なあ\Footage'
        digest = hashlib.sha1(str(Path(root).resolve()).encode('utf-8')).hexdigest()[:8]
        self.assertEqual(night.state_path_for(root, r'D:\Work_HDD\Footage'), night.NIGHT_DIR / f'state_{digest}.json')


class ResetJobTest(Base):
    def test_footage_kept_in_same_day_folder(self):
        day = self.footage / '_261030'
        old = self.state.job(VOD['id'])
        old.update(footage=str(day / '261030_x.mp4'), footage_existing=False, stream_id='1')
        old['steps']['vod'] = 'done'
        job = night.reset_job(self.state, VOD['id'], day)
        self.assertEqual(job['footage'], str(day / '261030_x.mp4'))
        self.assertFalse(job['footage_existing'])
        self.assertEqual(job['steps'], {})
        self.assertNotIn('stream_id', job)

    def test_footage_dropped_for_another_folder(self):
        old = self.state.job(VOD['id'])
        old.update(footage=str(self.tmp / 'other' / '_261030' / '261030_x.mp4'), footage_existing=True)
        job = night.reset_job(self.state, VOD['id'], self.footage / '_261030')
        self.assertNotIn('footage', job)
        self.assertNotIn('footage_existing', job)


class ReasonTest(unittest.TestCase):
    def test_bilingual_message_keeps_japanese_half(self):
        e = night.scout.ScoutExit(2, 'ERR: 配信が見つかりません / Stream not found: 1')
        self.assertEqual(night._reason(e), 'ERR: 配信が見つかりません')

    def test_plain_exception_is_japanese_labelled(self):
        e = RuntimeError(r'TwitchDownloaderCLI が見つかりません: D:\x.exe / TwitchDownloaderCLI not found')
        self.assertEqual(night._reason(e), r'エラー: RuntimeError: TwitchDownloaderCLI が見つかりません: D:\x.exe')


class StepCaptionsTest(Base):
    def test_writes_bom_srt_per_alive_stamp(self):
        cache = self.cache / VOD['id']
        cache.mkdir(parents=True)
        segments = [{'start': 600.0, 'end': 603.0, 'text': 'えっ待って'}]
        (cache / 'transcript.json').write_text(json.dumps(segments, ensure_ascii=False), encoding='utf-8')
        row = dict(ROW, vod_offset_sec=5)
        records = [
            {'id': 'y0000001', 'offset_sec': 610.0, 'by': 'yato', 'memo': '候補: 笑い', 'deleted': False},
            {'id': 'y0000002', 'offset_sec': 612.0, 'by': 'yato', 'memo': '候補: 発言', 'deleted': True},
            {'id': 'y0000003', 'offset_sec': 3000.0, 'by': 'yato', 'memo': 'ここ好き', 'deleted': False},
        ]
        client = FakeClient({'/api/streams/316644129905': {'stream': row},
                             '/api/streams/316644129905/stamps': {'stream': row, 'records': records}})
        job = self.state.job(VOD['id'])
        job.update(stream_id='316644129905', date_tag='261030')
        night.step_captions(self.ctx(client), job)
        cap_dir = self.footage / '_261030' / 'captions'
        srt = cap_dir / '261030_caption_y0000001.srt'
        data = srt.read_bytes()
        self.assertTrue(data.startswith(b'\xef\xbb\xbf'))
        # t_vod = 610 − 5 = 605、窓の 0 秒は 590 → 600 秒の発話は 10 秒 / origin 590, so the 600 s speech is at 10 s
        self.assertIn('00:00:10,000 --> 00:00:13,000\r\nえっ待って'.encode('utf-8'), data)
        # 墓標は書かず、重なりの無いスタンプも書かない / no file for the tombstone nor for a stamp with no overlap
        self.assertEqual(sorted(p.name for p in cap_dir.iterdir()), ['261030_caption_y0000001.srt'])
        self.assertEqual(job['steps']['captions'], 'done')


class StepPlanTest(Base):
    def test_plan_files_and_notify(self):
        row = dict(ROW, vod_offset_sec=5)
        records = [{'id': 'y0000001', 'offset_sec': 610.0, 'by': 'yato', 'memo': '候補: 笑い', 'deleted': False},
                   {'id': 'y0000003', 'offset_sec': 3000.0, 'by': 'yato', 'memo': 'ここ好き', 'deleted': False}]
        client = FakeClient({'/api/streams/316644129905/stamps': {'stream': row, 'records': records}})
        day = self.footage / '_261030'
        (day / 'chat').mkdir(parents=True)
        (day / 'chat' / '261030_chat_y0000001.mov').write_bytes(b'mov')
        job = self.state.job(VOD['id'])
        job.update(stream_id='316644129905', footage=str(day / '261030_x.mp4'), footage_existing=False)
        job['steps'].update({s: 'done' for s in ('vod', 'chat', 'scout', 'render', 'captions')})
        night.step_plan(self.ctx(client), job)
        text = (day / 'peakaboo.json').read_text(encoding='utf-8')
        self.assertEqual(text, (day / 'peakaboo_2914625472.json').read_text(encoding='utf-8'))
        plan = json.loads(text)
        self.assertEqual(plan['stream_id'], '316644129905')
        self.assertEqual([c['id'] for c in plan['candidates']], ['y0000001', 'y0000003'])
        self.assertEqual(plan['candidates'][0]['chat'], str(day / 'chat' / '261030_chat_y0000001.mov'))
        self.assertIsNone(plan['candidates'][0]['caption'])
        self.assertIsNone(plan['candidates'][1]['chat'])
        self.assertNotIn('plan', plan['steps'])
        self.assertEqual(job['steps']['plan'], 'done')
        self.notify.assert_called_once_with('Peakaboo: 完了（候補 2・チャット動画 1・字幕 0）')


class StepVodTest(Base):
    def test_name_is_chosen_once_and_part_is_replaced(self):
        day = self.footage / '_261030'
        day.mkdir(parents=True)
        (day / '261030_VALORANTやる.mp4').write_bytes(b'human')       # 人の録画 / a human recording
        (day / '261030_VALORANTやる_vod.part.mp4').write_bytes(b'x')  # 前回の残骸 / leftover from a crash

        def fake_run(cmd):
            out = Path(cmd[cmd.index('-o') + 1])
            self.assertFalse(out.exists())  # 残骸は消してから / leftover removed first
            out.write_bytes(b'vod')

        job = self.state.job(VOD['id'])
        with mock.patch.object(night, '_run_logged', side_effect=fake_run) as run:
            night.step_vod(self.ctx(), job)
        final = day / '261030_VALORANTやる_vod.mp4'
        self.assertEqual(job['footage'], str(final))
        self.assertTrue(job['footage_existing'])
        self.assertEqual(final.read_bytes(), b'vod')
        self.assertFalse((day / '261030_VALORANTやる_vod.part.mp4').exists())
        # 再実行は保存済みの名前と既存ファイルを使い、yt-dlp を呼ばない / a re-run reuses the stored name and file
        job['steps'].pop('vod')
        with mock.patch.object(night, '_run_logged') as run:
            night.step_vod(self.ctx(), job)
        run.assert_not_called()
        self.assertEqual(job['footage'], str(final))


class NotifyTest(unittest.TestCase):
    def test_failure_only_logs(self):
        with mock.patch.object(night.subprocess, 'run', side_effect=OSError('no powershell')), \
                self.assertLogs('night', level='WARNING'):
            night.notify('Peakaboo: 完了')


if __name__ == '__main__':
    unittest.main()
