# Twitch GQL の配信状況の取得と解釈のテスト（urlopen を差し替える）
# Tests for fetching and parsing the Twitch GQL stream snapshot (urlopen is patched)
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api  # noqa: E402
import gql  # noqa: E402

NODE = {'id': '2600000001', 'title': '雑談', 'lengthSeconds': 3600,
        'createdAt': '2026-10-30T10:00:00Z', 'status': 'RECORDED'}
LIVE = {'id': '320000000001', 'title': '雑談', 'createdAt': '2026-10-30T10:00:00Z'}


def _response(stream, nodes) -> dict:
    return {'data': {'user': {'stream': stream, 'videos': {'edges': [{'node': n} for n in nodes]}}}}


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ParseSnapshotTest(unittest.TestCase):
    def test_offline_with_videos(self):
        second = {**NODE, 'id': '2600000000', 'status': 'RECORDED'}
        self.assertEqual(gql.parse_snapshot(_response(None, [NODE, second])),
                         {'stream': None, 'videos': [NODE, second]})

    def test_live(self):
        recording = {**NODE, 'status': 'RECORDING'}
        self.assertEqual(gql.parse_snapshot(_response(LIVE, [recording])),
                         {'stream': LIVE, 'videos': [recording]})

    def test_no_videos(self):
        resp = {'data': {'user': {'stream': None, 'videos': None}}}
        self.assertEqual(gql.parse_snapshot(resp), {'stream': None, 'videos': []})

    def test_unknown_login_raises(self):
        with self.assertRaises(ValueError):
            gql.parse_snapshot({'data': {'user': None}})

    def test_missing_data_raises(self):
        with self.assertRaises(ValueError):
            gql.parse_snapshot({'errors': [{'message': 'boom'}]})


class SnapshotTest(unittest.TestCase):
    def test_request_shape(self):
        body = json.dumps(_response(None, [NODE])).encode('utf-8')
        with mock.patch('urllib.request.urlopen', return_value=_Resp(body)) as urlopen:
            self.assertEqual(gql.snapshot('terano_naa'), {'stream': None, 'videos': [NODE]})
        req = urlopen.call_args[0][0]
        self.assertEqual(req.full_url, 'https://gql.twitch.tv/gql')
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.get_header('Client-id'), 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp')
        self.assertEqual(req.get_header('User-agent'), api.USER_AGENT)
        self.assertEqual(req.get_header('Content-type'), 'application/json')
        self.assertIsNone(req.get_header('Authorization'))
        sent = json.loads(req.data.decode('utf-8'))
        self.assertEqual(sent['variables'], {'login': 'terano_naa'})
        self.assertIn('user(login: $login)', sent['query'])
        self.assertIn('videos(first: 3, sort: TIME)', sent['query'])
        self.assertEqual(urlopen.call_args[1]['timeout'], 20)

    def test_network_error(self):
        with mock.patch('urllib.request.urlopen', side_effect=urllib.error.URLError('down')):
            with self.assertRaises(api.ApiError) as cm:
                gql.snapshot('terano_naa')
        self.assertEqual(cm.exception.status, 0)
        self.assertTrue(cm.exception.error.startswith('network: '))


if __name__ == '__main__':
    unittest.main()
