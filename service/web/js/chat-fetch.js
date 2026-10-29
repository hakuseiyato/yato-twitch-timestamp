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

  // コメント 1 ページ（応答の配列の先頭）→ {comments, nodes, cursor, hasNextPage}。VOD が無ければ例外
  // comments: null や errors（IntegrityCheckFailed など）は最終ページとみなさず例外にする（黙って打ち切らない）
  // One comments page (first element of the response array) -> {comments, nodes, cursor, hasNextPage}; throws when the VOD is missing.
  // comments: null or errors (IntegrityCheckFailed and the like) throw instead of reading as the last page (no silent truncation).
  function parseCommentsPage(page) {
    const entry = Array.isArray(page) ? page[0] : page;
    const video = entry && entry.data ? entry.data.video : null;
    if (!video) throw new Error('VOD が見つかりません / VOD not found');
    const errors = entry.errors;
    if (!video.comments || (Array.isArray(errors) && errors.length)) {
      const first = Array.isArray(errors) && errors[0] ? String(errors[0].message || '') : '';
      throw new Error('チャット取得が拒否されました / Chat fetch rejected: ' + (first || 'comments: null'));
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

  // VOD のチャットを contentOffsetSeconds で先頭から逐次取得する（cursor は Twitch の integrity 検査で拒否されるため使わない）
  // 1 ページは offset の前後の窓なので、ページ間の重複は id で除く。次の offset は前ページ最後のコメントの秒（戻らない）
  // 新しい id が 0 件のとき: hasNextPage が偽か、次の秒が lengthSeconds を超えるなら終わり。そうでなければ 1 秒進める
  // ページ数の上限（lengthSeconds が分かれば ceil(length/10)+50、不明なら 5000）に達したら例外（黙って打ち切らない）
  // options: { lengthSeconds?, signal? }。signal が中止されると AbortError。onProgress(累計件数) をページごとに呼ぶ
  // Fetches a VOD's chat sequentially by contentOffsetSeconds (no cursor: Twitch rejects it with an integrity check).
  // A page is a window around the offset, so overlaps between pages are removed by id. The next offset is the last comment's second (never backwards).
  // With zero new ids: stop when hasNextPage is false or the next second would pass lengthSeconds; otherwise advance one second.
  // Hitting the page cap (ceil(length/10)+50 when lengthSeconds is known, else 5000) throws (no silent truncation).
  // options: { lengthSeconds?, signal? }. An aborted signal gives an AbortError. onProgress(total count) runs after each page.
  async function fetchVodChat(vodId, onProgress, options) {
    const opts = options || {};
    const signal = opts.signal;
    const length = Number(opts.lengthSeconds) > 0 ? Number(opts.lengthSeconds) : null;
    const maxPages = length !== null ? Math.ceil(length / 10) + 50 : 5000;
    const seenIds = new Set();
    const all = [];
    let offset = 0;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      if (signal && signal.aborted) throw new DOMException('中止しました / Aborted', 'AbortError');
      const page = await postGql([{
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables: { videoID: String(vodId), contentOffsetSeconds: offset },
        extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } }
      }], signal);
      const parsed = parseCommentsPage(page);
      const fresh = mergeComments(seenIds, parsed.nodes);
      for (const row of fresh) all.push(row);
      if (onProgress) onProgress(all.length);
      const lastNode = parsed.nodes[parsed.nodes.length - 1];
      let next = Math.max(offset, lastNode ? Number(lastNode.contentOffsetSeconds) || 0 : offset);
      if (fresh.length === 0) {
        if (!parsed.hasNextPage || (length !== null && offset + 1 > length)) return sortByOffset(all);
        next = offset + 1;
      }
      // 終端より後ろを要求すると Twitch は comments: null を返す / Asking past the end makes Twitch return comments: null
      if (length !== null && next > length) return sortByOffset(all);
      offset = next;
    }
    throw new Error('チャット取得がページ数の上限に達しました / Chat fetch hit the page limit (' + maxPages + ')');
  }

  // 窓の重なりで順序が前後しうるので offset の昇順に揃える（安定ソート）/ Windows may interleave, so sort by offset (stable)
  function sortByOffset(rows) {
    return rows.sort(function (a, b) { return a[0] - b[0]; });
  }

  return {
    normalizeComment: normalizeComment,
    parseCommentsPage: parseCommentsPage,
    parseVodId: parseVodId,
    parseHelixDuration: parseHelixDuration,
    pickVod: pickVod,
    buildChatJson: buildChatJson,
    mergeComments: mergeComments,
    listVods: listVods,
    fetchVodChat: fetchVodChat
  };
}());

if (typeof module !== 'undefined') module.exports = YTSChat;
