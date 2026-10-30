'use strict';

// VOD のチャットリプレイ取得と整形。前半は純粋関数（テスト対象）、後半は fetch を使う薄い通信関数
// ブラウザでは window.YTSChat、Node では require で読む
// Fetching and shaping a VOD's chat replay. Pure functions first (tested), thin fetch-based network functions after.
// window.YTSChat in the browser, require() in Node.
const YTSChat = (function () {
  const GQL_URL = 'https://gql.twitch.tv/gql';
  // GraphQL 用の Client-ID。TwitchDownloader の ChatDownloader.cs と同じ値（2026-10-29 確認）
  // Web 版の kimne78… は cursor 指定の 2 ページ目以降が IntegrityCheckFailed になるため使わない
  // Client-ID for GraphQL: the same value as TwitchDownloader's ChatDownloader.cs (checked 2026-10-29).
  // The web client's kimne78… is not used: cursor pages from page 2 onward fail with IntegrityCheckFailed.
  const GQL_CLIENT_ID = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp';
  // 1 回の取得のページ数の上限（無限ループ防止）/ Page cap for one fetch (guards against an endless loop)
  const MAX_PAGES = 20000;
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

  // コメント 1 ページ（応答の配列の先頭）→ {comments, nodes, cursor, hasNextPage}。VOD が無ければ例外
  // comments: null や errors（IntegrityCheckFailed など）は最終ページとみなさず例外にする（黙って打ち切らない）
  // One comments page (first element of the response array) -> {comments, nodes, cursor, hasNextPage}; throws when the VOD is missing.
  // comments: null or errors (IntegrityCheckFailed and the like) throw instead of reading as the last page (no silent truncation).
  function parseCommentsPage(page) {
    const entry = Array.isArray(page) ? page[0] : page;
    const video = entry && entry.data ? entry.data.video : null;
    if (!video) throw new Error('VOD が見つかりません');
    const errors = entry.errors;
    if (!video.comments || (Array.isArray(errors) && errors.length)) {
      const first = Array.isArray(errors) && errors[0] ? String(errors[0].message || '') : '';
      throw new Error('チャット取得が拒否されました: ' + (first || 'comments: null'));
    }
    const block = video.comments;
    const edges = block.edges || [];
    const comments = [];
    const nodes = [];
    for (const edge of edges) {
      const node = edge && edge.node;
      const row = normalizeComment(node);
      if (!row) continue;
      comments.push(row);
      nodes.push(node);
    }
    return {
      comments: comments,
      nodes: nodes,
      cursor: edges.length ? edges[edges.length - 1].cursor : null,
      hasNextPage: Boolean(block.pageInfo && block.pageInfo.hasNextPage)
    };
  }

  // ページの node のうち未見の id だけを整形して返し、seenIds に足す。id が無い node は offset・login・本文で見分ける
  // Normalizes only the nodes whose id is unseen and adds them to seenIds. Nodes without an id are keyed by offset, login and text.
  function mergeComments(seenIds, pageNodes) {
    const fresh = [];
    for (const node of pageNodes || []) {
      const row = normalizeComment(node);
      if (!row) continue;
      const key = node.id ? String(node.id) : row[0] + '|' + row[1] + '|' + row[3];
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      fresh.push(row);
    }
    return fresh;
  }

  // parseCommentsPage の結果 → 次に送る cursor。最終ページは null。hasNextPage が真なのに cursor が無い（edges が空）なら例外
  // parseCommentsPage result -> the cursor to send next. null on the last page. Throws when hasNextPage is true but there is no cursor (empty edges).
  function nextCursor(parsed) {
    if (!parsed.hasNextPage) return null;
    if (!parsed.cursor) throw new Error('次ページの位置がありません');
    return parsed.cursor;
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
        throw new Error('Twitch GraphQL の応答が ' + res.status + ' です');
      }
      await wait(RETRY_WAIT_MS);
    }
  }

  // チャンネルの最新アーカイブ VOD 20 本 / The channel's latest 20 archive VODs
  async function listVods(login) {
    const name = String(login || '').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error('チャンネル名が不正です');
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

  // VOD のチャットを TwitchDownloader と同じ形で逐次取得する: 1 ページ目は contentOffsetSeconds: 0、
  // 以降は前ページ最後の edge の cursor を hasNextPage が偽になるまで。重複は id で除く（念のため）
  // 拒否（comments: null / errors）は parseCommentsPage が例外にする。MAX_PAGES に達したら例外（黙って打ち切らない）
  // options: { signal? }。signal が中止されると AbortError。onProgress(累計件数) をページごとに呼ぶ
  // Fetches a VOD's chat the way TwitchDownloader does: page 1 with contentOffsetSeconds: 0,
  // then the last edge's cursor until hasNextPage is false. Duplicates are dropped by id (just in case).
  // Rejections (comments: null / errors) throw in parseCommentsPage. Reaching MAX_PAGES throws (no silent truncation).
  // options: { signal? }. An aborted signal gives an AbortError. onProgress(total count) runs after each page.
  async function fetchVodChat(vodId, onProgress, options) {
    const signal = options && options.signal;
    const seenIds = new Set();
    const all = [];
    let variables = { videoID: String(vodId), contentOffsetSeconds: 0 };
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      if (signal && signal.aborted) throw new DOMException('中止しました', 'AbortError');
      const page = await postGql([{
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables: variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } }
      }], signal);
      const parsed = parseCommentsPage(page);
      for (const row of mergeComments(seenIds, parsed.nodes)) all.push(row);
      if (onProgress) onProgress(all.length);
      const cursor = nextCursor(parsed);
      if (cursor === null) return all;
      variables = { videoID: String(vodId), cursor: cursor };
    }
    throw new Error('チャット取得がページ数の上限（' + MAX_PAGES + '）に達しました');
  }

  return {
    normalizeComment: normalizeComment,
    parseCommentsPage: parseCommentsPage,
    parseVodId: parseVodId,
    parseHelixDuration: parseHelixDuration,
    pickVod: pickVod,
    buildChatJson: buildChatJson,
    mergeComments: mergeComments,
    nextCursor: nextCursor,
    listVods: listVods,
    fetchVodChat: fetchVodChat
  };
}());

if (typeof module !== 'undefined') module.exports = YTSChat;
