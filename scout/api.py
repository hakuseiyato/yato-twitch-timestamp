"""Peakaboo サーバーの最小 API クライアント（stdlib urllib のみ）。
Minimal Peakaboo server API client (stdlib urllib only).

トークンは Authorization ヘッダーにだけ載せ、例外・ログには出さない。
The token goes only into the Authorization header and never into exceptions or logs.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Peakaboo-Scout/0.1'
_TIMEOUT_SEC = 60


class ApiError(Exception):
    """サーバーが 4xx/5xx を返した / The server answered 4xx/5xx.

    Parameters
    ----------
    status : int
        HTTP ステータス（通信失敗は 0）/ HTTP status (0 for a transport failure).
    error : str
        本文の `error` コード / The `error` code from the body.
    """

    def __init__(self, status: int, error: str):
        super().__init__(f'HTTP {status}: {error}')
        self.status = status
        self.error = error


class Client:
    """Bearer トークン付きの JSON クライアント / JSON client with a bearer token.

    Parameters
    ----------
    base_url : str
        例 / e.g. `https://yato-twitch-timestamp.hakuseiyato.workers.dev`
    token : str
        `ytt_` で始まるパネル用トークン / Panel token starting with `ytt_`.
    user_agent : str
        workers.dev は `python-urllib` の UA を 1010 で弾くためブラウザ風にする。
        workers.dev rejects the `python-urllib` UA with error 1010, so a browser-like one is sent.
    """

    def __init__(self, base_url: str, token: str, user_agent: str = USER_AGENT):
        self.base_url = base_url.rstrip('/')
        self._token = token
        self.user_agent = user_agent

    def _request(self, method: str, path: str, body: dict | None = None) -> dict | list | None:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header('User-Agent', self.user_agent)
        # 別ホストへのリダイレクトにトークンを持ち越さない / Do not carry the token onto a cross-host redirect
        req.add_unredirected_header('Authorization', 'Bearer ' + self._token)
        req.add_header('Accept', 'application/json')
        if data is not None:
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT_SEC) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            code = _error_code(e)
            # チャット未取込は信号が 1 つ欠けるだけなので None / Missing chat only drops one signal, so None
            if e.code == 404 and code == 'no_chat':
                return None
            raise ApiError(e.code, code) from None
        except urllib.error.URLError as e:
            raise ApiError(0, f'network: {e.reason}') from None

    def get(self, path: str) -> dict | list | None:
        """GET して JSON を返す。404 `no_chat` は None / GET and return JSON; 404 `no_chat` gives None."""
        return self._request('GET', path)

    def post(self, path: str, body: dict) -> dict:
        """JSON を POST して応答を返す / POST JSON and return the response."""
        result = self._request('POST', path, body)
        if not isinstance(result, dict):
            raise ApiError(200, 'unexpected_response')
        return result


def _error_code(e: urllib.error.HTTPError) -> str:
    """エラー本文の `error`。JSON でなければ HTTP の理由句 / The body's `error`, else the HTTP reason phrase."""
    try:
        body = json.loads(e.read().decode('utf-8'))
        if isinstance(body, dict) and isinstance(body.get('error'), str):
            return body['error']
    except (ValueError, OSError):
        pass  # JSON でない本文（Cloudflare の HTML など）は理由句で代用 / non-JSON body (e.g. Cloudflare HTML) falls back to the reason
    return str(e.reason)
