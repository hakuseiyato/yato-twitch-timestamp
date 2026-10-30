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
        # リダイレクト先へ持ち越さない / Not copied onto redirects
        self.assertIn('Authorization', req.unredirected_hdrs)

    def test_default_user_agent(self):
        client = api.Client('https://x', 'ytt_x')
        with mock.patch('urllib.request.urlopen', return_value=_Resp(b'{}')) as urlopen:
            client.get('/api/me')
        ua = urlopen.call_args[0][0].get_header('User-agent')
        self.assertTrue(ua.startswith('Mozilla/5.0'))
        self.assertIn('Peakaboo-Scout', ua)

    def test_no_chat_returns_none(self):
        with mock.patch('urllib.request.urlopen', side_effect=_http_error(404, {'error': 'no_chat'})):
            self.assertIsNone(self.client.get('/api/streams/s1/chat'))

    def test_other_error_raises(self):
        with mock.patch('urllib.request.urlopen', side_effect=_http_error(403, {'error': 'forbidden'})):
            with self.assertRaises(api.ApiError) as cm:
                self.client.get('/api/streams/s1')
        self.assertEqual(cm.exception.status, 403)
        self.assertEqual(cm.exception.error, 'forbidden')

    def test_put_sends_json(self):
        with mock.patch('urllib.request.urlopen', return_value=_Resp(b'{"ok":true}')) as urlopen:
            self.assertEqual(self.client.put('/api/streams/s1', {'title': 'あ'}), {'ok': True})
        req = urlopen.call_args[0][0]
        self.assertEqual(req.get_method(), 'PUT')
        self.assertEqual(req.full_url, 'https://x/api/streams/s1')
        self.assertEqual(req.get_header('Content-type'), 'application/json')
        self.assertEqual(req.get_header('Authorization'), 'Bearer ytt_x')
        self.assertEqual(json.loads(req.data.decode('utf-8')), {'title': 'あ'})

    def test_patch_sends_json(self):
        with mock.patch('urllib.request.urlopen', return_value=_Resp(b'{"ok":true}')) as urlopen:
            self.assertEqual(self.client.patch('/api/night/r1', {'state': 'done'}), {'ok': True})
        req = urlopen.call_args[0][0]
        self.assertEqual(req.get_method(), 'PATCH')
        self.assertEqual(req.get_header('Content-type'), 'application/json')
        self.assertEqual(json.loads(req.data.decode('utf-8')), {'state': 'done'})

    def test_patch_rejects_non_dict(self):
        with mock.patch('urllib.request.urlopen', return_value=_Resp(b'[1]')):
            with self.assertRaises(api.ApiError) as cm:
                self.client.patch('/api/x', {})
        self.assertEqual(cm.exception.error, 'unexpected_response')

    def test_put_raw_sends_bytes_as_is(self):
        raw = json.dumps({'comments': [[1, 'u', 'U', '草']]}, ensure_ascii=False).encode('utf-8')
        with mock.patch('urllib.request.urlopen', return_value=_Resp(b'{"ok":true}')) as urlopen:
            self.assertEqual(self.client.put_raw('/api/streams/s1/chat', raw, 'application/json'), {'ok': True})
        req = urlopen.call_args[0][0]
        self.assertEqual(req.get_method(), 'PUT')
        self.assertIs(req.data, raw)
        self.assertEqual(req.get_header('Content-type'), 'application/json')
        self.assertEqual(req.get_header('Authorization'), 'Bearer ytt_x')
        self.assertIn('Authorization', req.unredirected_hdrs)
        self.assertTrue(req.get_header('User-agent').startswith('Mozilla/5.0'))


if __name__ == '__main__':
    unittest.main()
