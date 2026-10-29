'use strict';

// VOD のチャットリプレイ取得と整形。前半は純粋関数（テスト対象）、後半は fetch を使う薄い通信関数
// ブラウザでは window.YTSChat、Node では require で読む
// Fetching and shaping a VOD's chat replay. Pure functions first (tested), thin fetch-based network functions after.
// window.YTSChat in the browser, require() in Node.
const YTSChat = (function () {
  const GQL_URL = 'https://gql.twitch.tv/gql';
  // Twitch Web 版の Client-ID（GraphQL 専用） / Twitch web Client-ID (GraphQL only)
  const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  // TwitchDownloader の ChatDownloader.cs と同じ persisted query / Same persisted query as TwitchDownloader's ChatDownloader.cs
  const COMMENTS_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';
  const PICK_WINDOW_MS = 30 * 60 * 1000;
  const MAX_RETRIES = 3;
  const RETRY_WAIT_MS = 1000;

  // ---- 純粋関数 / Pure functions ----

  // GraphQL のコメント node → [offset_sec, login, display_name, text]。message が無ければ null
  // GraphQL comment node -> [offset_sec, login, display_name, text]; null when message is missing.
  function normalizeComment(node) {
    if (!node || !node.message) return null;
    const commenter = node.commenter;
    const text = (node.message.fragments || []).map(f => (f && f.text) || '').join('');
    return [
      Number(node.contentOffsetSeconds) || 0,
      commenter ? String(commenter.login || '') : '',
      commenter ? String(commenter.displayName || '') : '',
      text
    ];
  }

  // コメント 1 ページ（応答の配列の先頭）→ {comments, cursor, hasNextPage}。VOD が無ければ例外
  // One comments page (first element of the response array) -> {comments, cursor, hasNextPage}; throws when the VOD is missing.
  function parseCommentsPage(page) {
    const entry = Array.isArray(page) ? page[0] : page;
    const video = entry && entry.data ? entry.data.video : null;
    if (!video) throw new Error('VOD が見つかりません / VOD not found');
    const block = video.comments || { edges: [], pageInfo: {} };
    const edges = block.edges || [];
    const comments = [];
    for (const edge of edges) {
      const row = normalizeComment(edge && edge.node);
      if (row) comments.push(row);
    }
    return {
      comments: comments,
      cursor: edges.length ? edges[edges.length - 1].cursor : null,
      hasNextPage: Boolean(block.pageInfo && block.pageInfo.hasNextPage)
    };
  }

  // VOD の URL か数字だけの ID → ID 文字列。読めなければ null
  // VOD URL or bare numeric id -> id string; null when unreadable.
  function parseVodId(text) {
    const s = String(text || '').trim();
    if (/^\d+$/.test(s)) return s;
    const m = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)(?:[/?#].*)?$/i.exec(s);
    return m ? m[1] : null;
  }

  // Helix の duration（'1h3m21s' / '3m21s' / '45s' / '2h'）→ 秒。読めなければ NaN
  // Helix duration ('1h3m21s' / '3m21s' / '45s' / '2h') -> seconds; NaN when invalid.
  function parseHelixDuration(text) {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(text || ''));
    if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return NaN;
    return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  }

  // createdAt が startedAt に最も近く、差が 30 分以内の VOD。日付が読めない行は無視する
  // The VOD whose createdAt is nearest to startedAt within 30 minutes; rows with unparsable dates are ignored.
  function pickVod(vods, startedAtIso) {
    const started = Date.parse(startedAtIso);
    if (Number.isNaN(started)) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const vod of vods || []) {
      const created = Date.parse(vod && vod.createdAt);
      if (Number.isNaN(created)) continue;
      const diff = Math.abs(created - started);
      if (diff <= PICK_WINDOW_MS && diff < bestDiff) {
        best = vod;
        bestDiff = diff;
      }
    }
    return best;
  }

  // R2 に置くチャット JSON（設計書 §7 の形） / Chat JSON stored in R2 (design §7 shape)
  function buildChatJson(vodId, lengthSec, comments) {
    return JSON.stringify({
      vod_id: String(vodId),
      length_sec: lengthSec,
      fetched_at: new Date().toISOString(),
      client: 'web/1.0',
      comments: comments
    });
  }

  // ---- 通信 / Network ----

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // GraphQL へ POST。429 / 5xx は 1 秒待って 3 回まで再試行する。signal で中止できる
  // POST to GraphQL; 429 / 5xx are retried up to 3 times after a 1 s wait. Abortable via signal.
  async function postGql(body, signal) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal
      });
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        throw new Error('Twitch GraphQL の応答が ' + res.status + ' です / Twitch GraphQL returned ' + res.status);
      }
      await wait(RETRY_WAIT_MS);
    }
  }

  // チャンネルの最新アーカイブ VOD 20 本 / The channel's latest 20 archive VODs
  async function listVods(login) {
    const name = String(login || '').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('チャンネル名が不正です / Invalid channel login');
    const json = await postGql({
      query: 'query{user(login:"' + name + '"){videos(first:20 type:ARCHIVE sort:TIME){edges{node{id title lengthSeconds createdAt}}}}}'
    });
    const user = json && json.data ? json.data.user : null;
    const edges = user && user.videos ? user.videos.edges || [] : [];
    return edges.map(e => ({
      id: e.node.id,
      title: e.node.title,
      createdAt: e.node.createdAt,
      lengthSeconds: e.node.lengthSeconds
    }));
  }

  // VOD のチャットを先頭から hasNextPage が偽になるまで逐次取得する。onProgress(取得件数) をページごとに呼ぶ
  // options.signal（AbortSignal）が中止されると AbortError で止まる
  // Fetches a VOD's chat sequentially from the start until hasNextPage is false; calls onProgress(count) after each page.
  // Stops with an AbortError once options.signal (an AbortSignal) is aborted.
  async function fetchVodChat(vodId, onProgress, options) {
    const signal = options && options.signal;
    const all = [];
    let variables = { videoID: String(vodId), contentOffsetSeconds: 0 };
    for (;;) {
      if (signal && signal.aborted) throw new DOMException('中止しました / Aborted', 'AbortError');
      const page = await postGql([{
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables: variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } }
      }], signal);
      const parsed = parseCommentsPage(page);
      for (const row of parsed.comments) all.push(row);
      if (onProgress) onProgress(all.length);
      if (!parsed.hasNextPage || !parsed.cursor) return all;
      variables = { videoID: String(vodId), cursor: parsed.cursor };
    }
  }

  return {
    normalizeComment: normalizeComment,
    parseCommentsPage: parseCommentsPage,
    parseVodId: parseVodId,
    parseHelixDuration: parseHelixDuration,
    pickVod: pickVod,
    buildChatJson: buildChatJson,
    listVods: listVods,
    fetchVodChat: fetchVodChat
  };
}());

if (typeof module !== 'undefined') module.exports = YTSChat;
