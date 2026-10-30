# night_lib.py の純粋な規則（着手条件・素材名・SRT・計画・状態文字列）のテスト。I/O は使わない
# Tests for night_lib.py's pure rules (start condition, footage name, SRT, plan, status texts); no I/O
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import night_lib  # noqa: E402


class TitleTest(unittest.TestCase):
    def test_sanitize(self):
        self.assertEqual(night_lib.sanitize_title(' VALORANT: ランク上げ? '), 'VALORANT ランク上げ')
        self.assertEqual(night_lib.sanitize_title('???'), 'stream')
        self.assertEqual(night_lib.sanitize_title('あ' * 40), 'あ' * 30)
        self.assertEqual(night_lib.sanitize_title('a\x00b\tc'), 'abc')
    def test_date_tag(self):
        self.assertEqual(night_lib.date_tag_jst('2026-10-30T06:03:22Z'), '261030')
        self.assertEqual(night_lib.date_tag_jst('2026-10-30T16:30:00Z'), '261031')

class FootageNameTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(night_lib.choose_footage_name('261030', 'VALORANT', set(), set()), ('261030_VALORANT', False))
    def test_existing_on_disk(self):
        self.assertEqual(night_lib.choose_footage_name('261030', 'VALORANT', set(), {'261030_VALORANT'}), ('261030_VALORANT_vod', True))
    def test_second_vod_same_title(self):
        self.assertEqual(night_lib.choose_footage_name('261030', 'VALORANT', {'261030_VALORANT'}, {'261030_VALORANT'}), ('261030_VALORANT_2', False))
    def test_vod_name_taken_by_other_job(self):
        self.assertEqual(night_lib.choose_footage_name('261030', 'X', {'261030_X_vod'}, {'261030_X', '261030_X_vod'}), ('261030_X_2', False))

class StartTest(unittest.TestCase):
    NOW = datetime(2026, 10, 30, 8, 0, tzinfo=timezone.utc)
    STATE = {'last_live': {'stream_id': '316644129905', 'title': 'VALORANT', 'seen_at': '2026-10-30T06:10:00Z'}, 'jobs': {}}
    VOD = {'id': '2914625472', 'title': 'VALORANT', 'lengthSeconds': 5911, 'createdAt': '2026-10-30T06:03:22Z', 'status': 'RECORDED'}
    def test_starts_when_offline_and_recorded(self):
        self.assertEqual(night_lib.should_start(self.STATE, {'stream': None, 'videos': [self.VOD]}, self.NOW), '2914625472')
    def test_waits_while_live(self):
        self.assertIsNone(night_lib.should_start(self.STATE, {'stream': {'id': '1'}, 'videos': [self.VOD]}, self.NOW))
    def test_waits_while_recording(self):
        self.assertIsNone(night_lib.should_start(self.STATE, {'stream': None, 'videos': [dict(self.VOD, status='RECORDING')]}, self.NOW))
    def test_ignores_old_vod(self):
        old = dict(self.VOD, createdAt='2026-10-29T06:00:00Z')
        self.assertIsNone(night_lib.should_start(self.STATE, {'stream': None, 'videos': [old]}, self.NOW))
    def test_skips_existing_job(self):
        state = dict(self.STATE, jobs={'2914625472': {'steps': {}}})
        self.assertIsNone(night_lib.should_start(state, {'stream': None, 'videos': [self.VOD]}, self.NOW))
    def test_no_live_seen_in_24h(self):
        state = dict(self.STATE, last_live=dict(self.STATE['last_live'], seen_at='2026-10-28T06:10:00Z'))
        self.assertIsNone(night_lib.should_start(state, {'stream': None, 'videos': [self.VOD]}, self.NOW))
    def test_naive_created_at_is_utc(self):
        naive = dict(self.VOD, createdAt='2026-10-30T06:03:22')
        self.assertEqual(night_lib.should_start(self.STATE, {'stream': None, 'videos': [naive]}, self.NOW), '2914625472')

class OffsetTest(unittest.TestCase):
    def test_offset(self):
        self.assertAlmostEqual(night_lib.vod_offset('2026-10-30T06:03:22Z', '2026-10-30T06:03:17Z'), 5.0)
        self.assertTrue(night_lib.should_apply_offset(0, 5.0))
        self.assertFalse(night_lib.should_apply_offset(3.0, 5.0))
        self.assertFalse(night_lib.should_apply_offset(0, 121.0))
    def test_match_stream_row(self):
        rows = [{'stream_id': '316644129905'}, {'stream_id': 'vod-1'}]
        hist = [{'stream_id': '316644129905', 'seen_at': '2026-10-30T06:10:00Z'}]
        self.assertEqual(night_lib.match_stream_row(rows, hist, '2026-10-30T06:03:22Z')['stream_id'], '316644129905')
        self.assertIsNone(night_lib.match_stream_row(rows, [], '2026-10-30T06:03:22Z'))

class SrtTest(unittest.TestCase):
    SEG = [{'start': 100.0, 'end': 102.0, 'text': 'こんにちは'}, {'start': 110.0, 'end': 113.5, 'text': 'あ' * 25}, {'start': 200.0, 'end': 201.0, 'text': '範囲外'}]
    def test_window_and_shift(self):
        srt = night_lib.srt_for_window(self.SEG, 105.0, 15, 45, 20)
        self.assertTrue(srt.startswith('\ufeff1\r\n00:00:10,000 --> 00:00:12,000\r\nこんにちは\r\n'))
        self.assertIn('2\r\n00:00:20,000 --> 00:00:23,500\r\n' + 'あ' * 20 + '\r\n' + 'あ' * 5 + '\r\n', srt)
        self.assertNotIn('範囲外', srt)
    def test_window_starting_before_vod_zero_is_not_shifted(self):
        srt = night_lib.srt_for_window([{'start': 3.0, 'end': 20.0, 'text': 'x'}], 10.0, 15, 45)
        self.assertIn('00:00:03,000 --> 00:00:20,000', srt)
    def test_empty(self):
        self.assertEqual(night_lib.srt_for_window(self.SEG, 1000.0, 15, 45), '')
    def test_whitespace_only_text_gives_no_cue(self):
        self.assertEqual(night_lib.srt_for_window([{'start': 100.0, 'end': 101.0, 'text': '  '}], 105.0, 15, 45), '')
    def test_non_positive_line_chars_means_no_wrap(self):
        srt = night_lib.srt_for_window([{'start': 100.0, 'end': 101.0, 'text': 'あ' * 25}], 105.0, 15, 45, 0)
        self.assertIn('\r\n' + 'あ' * 25 + '\r\n', srt)

class StepsTest(unittest.TestCase):
    def test_next_step(self):
        self.assertEqual(night_lib.next_step({'steps': {'vod': 'done', 'chat': 'done'}}), 'scout')
        self.assertIsNone(night_lib.next_step({'steps': {k: 'done' for k in night_lib.STEP_ORDER}}))
    def test_pending_requests(self):
        rows = [{'stream_id': 'a', 'night_requested_at': '2026-10-30T13:00:00Z'},
                {'stream_id': 'b', 'night_requested_at': '2026-10-30T12:00:00Z', 'night_done_at': '2026-10-30T12:30:00Z'},
                {'stream_id': 'c', 'night_requested_at': '2026-10-30T13:00:00Z', 'night_done_at': '2026-10-30T12:30:00Z'},
                {'stream_id': 'd', 'night_requested_at': '2026-10-30T13:00:00Z', 'night_status': '処理中: 候補'},
                {'stream_id': 'e'}]
        self.assertEqual([r['stream_id'] for r in night_lib.pending_requests(rows)], ['a', 'c'])
    def test_pending_adopts_abandoned_running_rows(self):
        # 常駐が処理中に落ちた行（完了時刻なし）は起動直後だけ拾い直す / rows left running by a dead daemon
        rows = [{'stream_id': 'd', 'night_requested_at': '2026-10-30T13:00:00Z', 'night_status': '処理中: 候補'},
                {'stream_id': 'f', 'night_requested_at': '2026-10-30T12:00:00Z', 'night_done_at': '2026-10-30T12:30:00Z',
                 'night_status': '処理中: 字幕'},
                {'stream_id': 'g', 'night_status': '処理中: 開始'}]
        self.assertEqual([r['stream_id'] for r in night_lib.pending_requests(rows, adopt_running=True)], ['d', 'g'])
        self.assertEqual(night_lib.pending_requests(rows), [])
    def test_pending_compares_times_not_text(self):
        rows = [{'stream_id': 'm', 'night_requested_at': '2026-10-30T13:00:00.500Z', 'night_done_at': '2026-10-30T13:00:00Z'}]
        self.assertEqual([r['stream_id'] for r in night_lib.pending_requests(rows)], ['m'])
    def test_status_texts(self):
        self.assertEqual(night_lib.status_text_running('render', 3, 10), '処理中: チャット動画 3/10')
        self.assertEqual(night_lib.status_text_running('vod'), '処理中: VOD 保存')
        self.assertEqual(night_lib.status_text_done(10, 10, 9), '完了（候補 10・チャット動画 10・字幕 9）')
        self.assertEqual(night_lib.status_text_failed('chat', 'exit 1'), '失敗: チャット — exit 1')
    def test_build_plan_shape(self):
        plan = night_lib.build_plan(date_tag='261030', stream_id='1', vod_id='2', title='t', footage='D:\\x.mp4', footage_existing=False,
                                    pre_sec=15, post_sec=45, candidates=[], steps={}, finished_at='2026-10-30T13:20:00Z')
        self.assertEqual(plan['version'], 1)
        self.assertEqual(sorted(plan), sorted(['version', 'date_tag', 'stream_id', 'vod_id', 'title', 'footage', 'footage_existing',
                                                'pre_sec', 'post_sec', 'candidates', 'steps', 'finished_at']))


if __name__ == '__main__':
    unittest.main()
