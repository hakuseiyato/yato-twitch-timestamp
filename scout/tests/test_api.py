# Scout のサーバー API クライアントのテスト（urlopen を差し替える）
# Tests for Scout's server API client (urlopen is patched)
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import api  # noqa: E402

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Peakaboo-Scout/0.1'


def _http_error(status: int, body: dict) -> urllib.error.HTTPError:
    return urllib.error.HTTPError('https://x/api', status, 'err', {}, io.BytesIO(json.dumps(body).encode()))


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ApiClientTest(unittest.TestCase):
    def setUp(self):
        self.client = api.Client('https://x', 'ytt_x', UA)

    def test_user_agent_and_bearer(self):
        with mock.patch('urllib.request.urlopen', return_value=_Resp(b'{"login":"a"}')) as urlopen:
            self.assertEqual(self.client.get('/api/me'), {'login': 'a'})
        req = urlopen.call_args[0][0]
        self.assertTrue(req.get_header('User-agent').startswith('Mozilla/5.0'))
        self.assertEqual(req.get_header('Authorization'), 'Bearer ytt_x')

    def test_no_chat_returns_none(self):
        with mock.patch('urllib.request.urlopen', side_effect=_http_error(404, {'error': 'no_chat'})):
            self.assertIsNone(self.client.get('/api/streams/s1/chat'))

    def test_other_error_raises(self):
        with mock.patch('urllib.request.urlopen', side_effect=_http_error(403, {'error': 'forbidden'})):
            with self.assertRaises(api.ApiError) as cm:
                self.client.get('/api/streams/s1')
        self.assertEqual(cm.exception.status, 403)
        self.assertEqual(cm.exception.error, 'forbidden')


if __name__ == '__main__':
    unittest.main()
