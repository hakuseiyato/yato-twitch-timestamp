# night.py の常駐（tick・lock）のテスト。サーバー・GQL・run_job は偽物に差し替える
# Tests for the night daemon (tick, lock); the server, GQL and run_job are faked
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# test_night_steps.py と同じ理由で scout パッケージを一時的に外す / same namespace-package dance as test_night_steps.py
_scout_pkg = sys.modules.pop('scout') if not hasattr(sys.modules.get('scout'), 'run') and 'scout' in sys.modules else None
import night  # noqa: E402
if _scout_pkg is not None:
    sys.modules['scout'] = _scout_pkg

CHANNEL = 'terano_naa'
STREAMS_PATH = f'/api/channels/{CHANNEL}/streams'
NOW = datetime(2026, 10, 30, 14, 0, tzinfo=timezone.utc)
VOD = {'id': '2914625472', 'title': 'VALORANTやる', 'lengthSeconds': 5911,
       'createdAt': '2026-10-30T06:03:22Z', 'status': 'RECORDED'}
REQUESTED = {'stream_id': '316644129905', 'channel': CHANNEL, 'started_at': '2026-10-30T06:03:17.000Z',
             'title': 'VALORANTやる', 'vod_id': '2914625472', 'night_requested_at': '2026-10-30T13:59:00.000Z'}
NIGHT_CFG = {'channel': CHANNEL, 'footage_root': '', 'twitch_downloader': r'D:\Tools\TD\TwitchDownloaderCLI.exe',
             'pre_sec': 15, 'post_sec': 45,
             'chat_render': {'width': 400, 'height': 1080, 'font_size': 24, 'background': '#00000000'},
             'caption_line_chars': 20, 'poll_minutes': 10}
DONE_TEXT = '完了（候補 1・チャット動画 1・字幕 1）'


class FakeClient:
    """配信一覧だけ返し、PATCH を記録する / Answers the stream list and records PATCHes."""

    def __init__(self, rows):
        self.rows = rows
        self.patch = mock.MagicMock(return_value={'stream': {}})

    def get(self, path):
        assert path == STREAMS_PATH, path
        return {'streams': self.rows}


def _finishing_run_job(ctx):
    """run_job の偽物: 完了の状態を書いて job を返す / Fake run_job that reports done."""
    job = ctx.state.job(str(ctx.vod['id']))
    ctx.status(DONE_TEXT)
    return job


class TickBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.state = night.State(self.tmp / 'state.json').load()
        self.run_job = mock.MagicMock(side_effect=_finishing_run_job)
        self.snapshot = mock.MagicMock(return_value={'stream': None, 'videos': [VOD]})
        for p in (mock.patch.object(night, 'run_job', self.run_job),
                  mock.patch.object(night.gql, 'snapshot', self.snapshot)):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def loop_ctx(self, rows):
        self.client = FakeClient(rows)
        return night.LoopContext(client=self.client, cfg={'channel': CHANNEL, 'cache_dir': str(self.tmp / 'cache')},
                                 night_cfg=dict(NIGHT_CFG), state=self.state, footage_root=self.tmp / 'Footage',
                                 notify=mock.MagicMock())

    def patch_bodies(self):
        return [(c.args[0], c.args[1]) for c in self.client.patch.call_args_list]


class RequestTest(TickBase):
    def test_a_request_runs_job_once_and_reports(self):
        ran = night.tick(self.loop_ctx([dict(REQUESTED)]), NOW)
        self.assertEqual(ran, ['2914625472'])
        self.assertEqual(self.run_job.call_count, 1)
        jctx = self.run_job.call_args.args[0]
        self.assertEqual(jctx.vod['id'], '2914625472')
        self.assertEqual(jctx.stream_row['stream_id'], '316644129905')
        bodies = self.patch_bodies()
        self.assertEqual(bodies[0], ('/api/streams/316644129905', {'night_status': '処理中: 開始', 'night_done_at': None}))
        path, done = bodies[1]
        self.assertEqual(path, '/api/streams/316644129905')
        self.assertEqual(done['night_status'], DONE_TEXT)
        datetime.fromisoformat(done['night_done_at'].replace('Z', '+00:00'))  # 完了時刻が ISO / done time is ISO
        self.assertEqual(len(bodies), 2)

    def test_b_no_vod_within_60_min_fails_without_running(self):
        row = {k: v for k, v in REQUESTED.items() if k != 'vod_id'}
        row['started_at'] = '2026-10-30T04:00:00.000Z'  # VOD より 2 時間前 / two hours before the VOD
        night.tick(self.loop_ctx([row]), NOW)
        self.run_job.assert_not_called()
        bodies = self.patch_bodies()
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0][0], '/api/streams/316644129905')
        self.assertEqual(bodies[0][1]['night_status'], '失敗: 計画 — VOD が見つかりません')
        self.assertIn('night_done_at', bodies[0][1])

    def test_b2_no_vod_id_picks_vod_within_60_min(self):
        row = {k: v for k, v in REQUESTED.items() if k != 'vod_id'}
        night.tick(self.loop_ctx([row]), NOW)
        self.assertEqual(self.run_job.call_args.args[0].vod['id'], '2914625472')

    def test_status_patch_failure_does_not_stop_job(self):
        ctx = self.loop_ctx([dict(REQUESTED)])
        self.client.patch.side_effect = night.api.ApiError(0, 'network: down')
        self.assertEqual(night.tick(ctx, NOW), ['2914625472'])
        self.assertEqual(self.run_job.call_count, 1)

    def test_job_keeps_vod_and_last_terminal_status(self):
        night.tick(self.loop_ctx([dict(REQUESTED)]), NOW)
        job = self.state.jobs['2914625472']
        self.assertEqual(job['vod'], VOD)
        self.assertEqual(job['last_status'], DONE_TEXT)

    def test_g_stuck_row_of_finished_job_gets_terminal_status_again(self):
        job = self.state.job('2914625472')
        job['steps'] = {s: 'done' for s in night.night_lib.STEP_ORDER}
        job['last_status'] = DONE_TEXT
        row = dict(REQUESTED, night_status='処理中: 計画')
        self.assertEqual(night.tick(self.loop_ctx([row]), NOW), [])
        self.run_job.assert_not_called()
        bodies = self.patch_bodies()
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0][0], '/api/streams/316644129905')
        self.assertEqual(bodies[0][1]['night_status'], DONE_TEXT)
        datetime.fromisoformat(bodies[0][1]['night_done_at'].replace('Z', '+00:00'))
        # 作り直さない / the job is not reset
        self.assertEqual(len(self.state.jobs['2914625472']['steps']), len(night.night_lib.STEP_ORDER))

    def test_h_stuck_row_without_job_runs_on_every_tick(self):
        row = dict(REQUESTED, night_status='処理中: 候補')
        ctx = self.loop_ctx([row])
        self.assertEqual(night.tick(ctx, NOW), ['2914625472'])
        self.assertEqual(self.run_job.call_count, 1)
        # 2 周目も放置された行として拾う（偽の行は処理中のまま）/ adopted again on the next tick (the fake row stays running)
        self.state.jobs.clear()
        self.assertEqual(night.tick(ctx, NOW + timedelta(minutes=1)), ['2914625472'])
        self.assertEqual(self.run_job.call_count, 2)

    def test_done_job_is_reset_so_steps_run_again(self):
        job = self.state.job('2914625472')
        job['steps'] = {s: 'done' for s in night.night_lib.STEP_ORDER}
        night.tick(self.loop_ctx([dict(REQUESTED)]), NOW)
        self.assertEqual(self.state.jobs['2914625472']['steps'], {})


class WatchTest(TickBase):
    def test_c_gql_not_polled_again_within_poll_minutes(self):
        ctx = self.loop_ctx([])
        night.tick(ctx, NOW)
        self.assertEqual(self.snapshot.call_count, 1)
        night.tick(ctx, NOW.replace(minute=9))
        self.assertEqual(self.snapshot.call_count, 1)
        night.tick(ctx, NOW.replace(minute=10))
        self.assertEqual(self.snapshot.call_count, 2)

    def test_d_should_start_vod_runs_job(self):
        self.state.record_live({'id': '316644129905', 'title': 'VALORANTやる'}, seen_at='2026-10-30T07:30:00Z')
        row = {k: v for k, v in REQUESTED.items() if k != 'night_requested_at'}
        ran = night.tick(self.loop_ctx([row]), NOW)
        self.assertEqual(ran, ['2914625472'])
        self.assertEqual(self.run_job.call_count, 1)
        self.assertIn('2914625472', self.state.jobs)
        # 同じ配信行に状態を書く / the status goes to the matching stream row
        self.assertEqual(self.patch_bodies()[0],
                         ('/api/streams/316644129905', {'night_status': '処理中: 開始', 'night_done_at': None}))

    def test_live_is_recorded(self):
        self.snapshot.return_value = {'stream': {'id': '999', 'title': '配信中'}, 'videos': []}
        night.tick(self.loop_ctx([]), NOW)
        self.assertEqual(self.state.data['last_live']['stream_id'], '999')
        self.run_job.assert_not_called()


class RetryTest(TickBase):
    def _failed_job(self, vod_id, stopped=False):
        job = self.state.job(vod_id)
        job['steps'] = {'vod': 'done'}
        job['error'] = {'step': 'chat', 'reason': 'サーバー HTTP 0 network: down', 'count': 1}
        job['stream_id'] = '316644129905'
        job['vod'] = dict(VOD, id=vod_id)
        if stopped:
            job['stopped'] = True
        return job

    def test_e_failed_job_resumes_on_gql_tick_only(self):
        self._failed_job('2914625472')
        ctx = self.loop_ctx([dict(REQUESTED, night_requested_at=None)])
        self.assertEqual(night.tick(ctx, NOW), ['2914625472'])
        self.assertEqual(self.run_job.call_count, 1)
        jctx = self.run_job.call_args.args[0]
        self.assertIs(jctx.vod, VOD)  # GQL にある VOD はその辞書を使う / the snapshot's dict when listed
        self.assertEqual(jctx.stream_row['stream_id'], '316644129905')
        self.assertEqual(night.tick(ctx, NOW + timedelta(minutes=1)), [])
        self.assertEqual(self.run_job.call_count, 1)

    def test_e2_failed_job_outside_snapshot_uses_stored_vod(self):
        self._failed_job('2900000000')
        night.tick(self.loop_ctx([]), NOW)
        self.assertEqual(self.run_job.call_args.args[0].vod['id'], '2900000000')

    def test_f_stopped_job_is_never_rerun(self):
        self._failed_job('2914625472', stopped=True)
        ctx = self.loop_ctx([])
        night.tick(ctx, NOW)
        night.tick(ctx, NOW + timedelta(minutes=10))
        self.run_job.assert_not_called()


class ParseArgsTest(unittest.TestCase):
    def test_force_needs_vod(self):
        for mode in ('--daemon', '--tick'):
            with mock.patch('sys.stderr'), self.assertRaises(SystemExit):
                night.parse_args([mode, '--force'])
        self.assertTrue(night.parse_args(['--vod', '2914625472', '--force']).force)


class MissingStreamsTest(unittest.TestCase):
    def test_none_streams_go_to_log_file(self):
        saved = sys.stdout, sys.stderr
        with tempfile.TemporaryDirectory() as d:
            log_path = Path(d) / 'night.log'
            try:
                sys.stdout = sys.stderr = None
                night.route_missing_streams(log_path)
                print('進捗 / progress', file=sys.stderr)
                sys.stdout.write('出力\n')
                sys.stdout.flush()
                sys.stderr.flush()
                self.assertFalse(sys.stdout.closed)
                self.assertFalse(sys.stderr.closed)
            finally:
                for stream in {sys.stdout, sys.stderr} - set(saved):
                    if stream is not None:
                        stream.close()
                sys.stdout, sys.stderr = saved
            text = log_path.read_text(encoding='utf-8')
        self.assertIn('進捗 / progress', text)
        self.assertIn('出力', text)

    def test_existing_streams_are_kept(self):
        saved = sys.stdout, sys.stderr
        night.route_missing_streams(Path(tempfile.gettempdir()) / 'unused_night.log')
        self.assertEqual((sys.stdout, sys.stderr), saved)


class LockTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.lock = Path(self._tmp.name) / 'daemon.lock'

    def tearDown(self):
        self._tmp.cleanup()

    def test_fresh_lock_holds_own_pid_and_release_removes_it(self):
        self.assertTrue(night.acquire_lock(self.lock))
        self.assertEqual(self.lock.read_text(encoding='utf-8'), str(os.getpid()))
        night.release_lock(self.lock)
        self.assertFalse(self.lock.exists())

    def test_live_owner_blocks(self):
        # 親プロセスは lock より前から生きている / the parent process predates the lock
        self.lock.write_text(str(os.getppid()), encoding='utf-8')
        self.assertFalse(night.acquire_lock(self.lock))
        self.assertEqual(self.lock.read_text(encoding='utf-8'), str(os.getppid()))

    def test_dead_owner_is_replaced(self):
        child = subprocess.Popen([sys.executable, '-c', 'pass'])
        child.wait()
        self.lock.write_text(str(child.pid), encoding='utf-8')
        self.assertTrue(night.acquire_lock(self.lock))
        self.assertEqual(self.lock.read_text(encoding='utf-8'), str(os.getpid()))


if __name__ == '__main__':
    unittest.main()
