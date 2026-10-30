"""Twitch GQL からチャンネルの配信状況（配信中か・最新の VOD）を読む（stdlib urllib のみ、認証なし）。
Read a channel's live state and newest VODs from Twitch GQL (stdlib urllib only, no auth).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from api import USER_AGENT, ApiError

GQL_URL = 'https://gql.twitch.tv/gql'
# Twitch の Web が使う公開 Client-ID / Public Client-ID used by the Twitch web client
CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp'
_TIMEOUT_SEC = 20
# status は配信中 RECORDING、終了後 RECORDED / status is RECORDING while live, RECORDED after
QUERY = ('query($login: String!) { user(login: $login) { stream { id title createdAt } '
         'videos(first: 3, sort: TIME) { edges { node { id title lengthSeconds createdAt status } } } } }')


def parse_snapshot(response: dict) -> dict:
    """GQL の応答を `{'stream': dict | None, 'videos': [node, …]}` にする（videos は応答の順）。
    Turn a GQL response into `{'stream': dict | None, 'videos': [node, …]}` (videos in response order).

    Parameters
    ----------
    response : dict
        `gql.twitch.tv/gql` の JSON 応答 / JSON response from `gql.twitch.tv/gql`.

    Returns
    -------
    dict
        `stream` は配信中でなければ None / `stream` is None when offline.

    Raises
    ------
    ValueError
        ユーザーが無い（login 違い）か `data` が無い / The user is missing (unknown login) or `data` is absent.
    """
    data = response.get('data') if isinstance(response, dict) else None
    user = data.get('user') if isinstance(data, dict) else None
    if not isinstance(user, dict):
        raise ValueError('Twitch のユーザーが見つかりません / Twitch user not found')
    edges = (user.get('videos') or {}).get('edges') or []
    return {'stream': user.get('stream'), 'videos': [e['node'] for e in edges if isinstance(e, dict) and e.get('node')]}


def snapshot(login: str) -> dict:
    """チャンネルの配信状況を GQL で取る / Fetch the channel's live state over GQL.

    Parameters
    ----------
    login : str
        Twitch の login（例 / e.g. `terano_naa`）。

    Returns
    -------
    dict
        `parse_snapshot` と同じ形 / Same shape as `parse_snapshot`.

    Raises
    ------
    ApiError
        HTTP エラー、または通信失敗（status 0）/ HTTP error, or a transport failure (status 0).
    ValueError
        ユーザーが見つからない / The user was not found.
    """
    body = json.dumps({'query': QUERY, 'variables': {'login': login}}).encode('utf-8')
    req = urllib.request.Request(GQL_URL, data=body, method='POST')
    req.add_header('Client-ID', CLIENT_ID)
    req.add_header('User-Agent', USER_AGENT)
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SEC) as resp:
            return parse_snapshot(json.loads(resp.read().decode('utf-8')))
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, str(e.reason)) from None
    except urllib.error.URLError as e:
        raise ApiError(0, f'network: {e.reason}') from None
