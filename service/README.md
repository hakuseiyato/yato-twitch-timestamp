# service — Yato Twitch Timestamp のクラウド側

Cloudflare Worker 1 本で、JSON API（`/api/`・`/auth/`）と `web/` の静的ページ（Workers Static Assets）を出す。
D1 に配信・スタンプ・会員などを置き、R2 に VOD ごとのチャット JSON を置く。Cloudflare Workers の Free プランで動かす前提。

ブラウザの Web ページに加え、Chrome 拡張（`POST /api/stamps` でスタンプを送る）と Premiere Pro / After Effects パネル（同期元「サーバー」。鏡 CSV に写して同期の前に pull、後に push）がこのサービスと通信する。

## 必要なもの

- Node.js 20 以上と npm
- Cloudflare アカウント（Workers・D1・R2 を Free プランで使う）
- Twitch Developer Console のアプリ 1 つ
  - client type は **Confidential**（implicit grant は Confidential 型でしか使えない。Public 型は Device Code Grant のみ）。client secret は発行されるが、どこでも使わない
  - OAuth Redirect URL に `https://<worker-host>/auth/callback` を追加する（`<worker-host>` は deploy 後に出る `yato-twitch-timestamp.<subdomain>.workers.dev`）
  - ローカルで試すときは `http://localhost:8787/auth/callback` も追加する（ページは `location.origin + '/auth/callback'` に戻す）

## 初回セットアップ

`service/` で実行する。

```sh
npm install
npx wrangler login
npx wrangler d1 create yts
```

`d1 create` が出した `database_id` を `wrangler.jsonc` の `d1_databases[0].database_id` に書く（今は `00000000-0000-0000-0000-000000000000` の仮値）。

```sh
npx wrangler r2 bucket create yts-chat
```

`wrangler.jsonc` の `vars.TWITCH_CLIENT_ID` に Twitch アプリの Client ID を書く。implicit grant の Client ID は認可 URL に載る公開値なので、secret ではなく `vars` に置いている（設計書 §5 は secret と書くが、コードは `vars`）。

最初のサイト管理者にする Twitch login を secret に入れる（対話で値を聞かれる）。値は Twitch の login を小文字で入れる（比較は完全一致。Twitch の login は常に小文字）。

```sh
npx wrangler secret put BOOTSTRAP_LOGIN
```

D1 にスキーマを流して deploy する。

```sh
npm run migrate:remote
npm run deploy
```

deploy 後、`https://<worker-host>/api/health` が `{"ok":true}` を返すことを確かめる。

## ローカル開発

```sh
npm run migrate:local
npm run dev
```

- `npm run dev` は `wrangler dev --persist-to .wrangler/state`。ローカルの D1 / R2 は `.wrangler/state` に残る（`.gitignore` 済み）
- ローカルでの secret と Client ID は `service/.dev.vars`（`.gitignore` 済み）に書く。例:

  ```text
  BOOTSTRAP_LOGIN=<自分の Twitch login>
  TWITCH_CLIENT_ID=<Client ID>
  ```

- ローカルの DB を作り直すときは `.wrangler/state` を消してから migrate し直す。
  `migrations/0001_init.sql` は本番 deploy 前に直接書き換えている。wrangler は適用済みの migration をファイル名で記録するので、古い版を適用済みのローカル DB には書き換えが反映されない。
  本番に初めて deploy した後は `migrations/0001_init.sql` を二度と書き換えず、変更は `migrations/0002_<name>.sql` のように新しいファイルで足す（wrangler は migration をファイル名ごとに 1 回だけ適用する）。

  ```sh
  rm -rf .wrangler/state
  npm run migrate:local
  ```

- `wrangler.jsonc` の binding を変えたら `npm run types` で `worker-configuration.d.ts` を作り直す

## テスト

`service/` で実行する。

| コマンド | 中身 |
|---|---|
| `npm test` | `vitest run`。Worker の経路を workerd 上で通す（D1 / R2 は Miniflare のローカル実装。テストでは `BOOTSTRAP_LOGIN` = `yato`） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:web` | `node ../tests/test_service_web.js`。`web/js` の純粋ロジック（ビン分け・チャット整形・VOD 選択など） |
| `node ../tests/test_lib.js` | 共有ライブラリのテスト。`panel/js/lib.js` と `web/js/lib.js` の複製が古いと失敗する |
| `npm run build:web` | `../panel/js/lib.js` を `web/js/lib.js` に複製する |

`lib.js` の複製の流れは `extension/lib.js` → `panel/js/lib.js`（`panel/install.ps1`）→ `service/web/js/lib.js`（`npm run build:web`）。
Worker 側（`src/`）は `../../panel/js/lib.js` を直接 import する。`extension/lib.js` を直したら両方の複製を作り直す。

## 運用

### サイト管理者と会員

- `BOOTSTRAP_LOGIN` と一致する login でサインインした人がサイト管理者になる。D1 には書かず、要求ごとに secret と比べる（secret を変えれば移る）
- サイト管理者は `/admin` でチャンネル（例: `terano_naa`）を作る。作った人は owner として会員に入る。サイト管理者は既存の全チャンネルで owner 扱い
- owner は `/admin` で会員を追加・削除し、役割（`owner` / `editor`）を変える。最後の owner は消せず、editor にも下げられない
- 会員でない人はサインインできても配信は見えない（一覧は空、API は 403）

設計書 §5 は「`BOOTSTRAP_LOGIN` の初回サインインで最初の owner を作る」と書くが、コードは上のとおり常時サイト管理者として扱い、チャンネルは `/admin` で作る。

### パネル用トークン

`/me` で `ytt_` トークンを発行・失効する。平文は発行時に 1 度だけ表示され、D1 には SHA-256 だけが残る。
発行と失効は Web ページ（session cookie）からだけできる。パネルの「サーバー」に URL とこのトークンを入れて使う（`Authorization: Bearer ytt_…`）。401 が返ったら失効しているので発行し直す。

### Free 枠の見方

Cloudflare ダッシュボードで次を見る（数値は設計書 §3、2026-10-29 時点の Free プラン）。

| 項目 | Free の上限 | 主に増える操作 |
|---|---|---|
| Workers のリクエスト数 | 100,000 / 日 | ページ表示・API 呼び出し（静的ページも Worker を先に通る） |
| D1 の書き込み行数 | 100,000 行 / 日 | スタンプの保存、サインイン（session）、Twitch トークン検証のキャッシュ |
| R2 Class A（書き込み系）操作 | 1,000,000 / 月 | 「チャットを取り込む」（1 回で PUT 1 回） |

チャット本体は D1 に入れないので、取り込みで D1 の書き込み行数はほとんど増えない（`streams` の 1 行の更新だけ）。

### Twitch のチャット取得が失敗したとき

チャットは、ブラウザが Twitch GraphQL（非公式）から直接取る。Client-ID `kd1unb4b3q4t58fwlpcbzcbnm76a8fp` と persisted query `VideoCommentsByOffsetOrCursor` の hash は `web/js/chat-fetch.js` の `GQL_CLIENT_ID` と `COMMENTS_HASH` にある（どちらも TwitchDownloader の `ChatDownloader.cs` と同じ値）。

- 配信ページに「取り込めませんでした / Import failed: チャット取得が拒否されました / Chat fetch rejected: …」が出て、その後ろが `IntegrityCheckFailed` や persisted query 関連のエラーなら、Twitch 側の変更を疑う
- TwitchDownloader の `ChatDownloader.cs` の最新の Client-ID と hash を確かめ、`web/js/chat-fetch.js` の 2 つの値を直し、`npm run test:web` を通してから `npm run deploy`
- Web 版の Client-ID `kimne78kx3ncx6brgo4mv6wki5h1ko` は、cursor 送りの 2 ページ目以降が `IntegrityCheckFailed` になるので使わない（2026-10-29 実測）
- 取得は最後のページまで取り終えてから 1 回だけ PUT する。途中で失敗しても、R2 にある前回の取り込みは上書きされない

### ログと D1 の確認

```sh
npx wrangler tail
npx wrangler d1 execute yts --remote --command "SELECT channel, login, role FROM members"
```

## API 一覧

### CORS（パネル用）

CEP パネルは `file://` 起点（`Origin: null`）で Node も無効なので、`fetch` で Worker を叩くには CORS の許可が要る。
`/api/*` の `OPTIONS` には 204（`Access-Control-Allow-Origin: *`、`Authorization, Content-Type, X-Requested-With`、全メソッド、`Max-Age: 86400`）を返し、
実際の要求には **`Authorization` ヘッダがあるときだけ** `Access-Control-Allow-Origin: *`（と `Vary: Origin`）を付ける（`src/cors.ts`）。
cookie で認証した要求には付けない。`*` は credentials と併用できないので、他サイトのページが利用者の cookie で API を読むことはできず、
Bearer は攻撃側のページが持っていない値なので、CSRF の守り（cookie の変更系に `X-Requested-With: yts` 必須）は変わらない。
許可するオリジンを絞るなら `*` をやめ、cookie 経由にも付けないこと（`null` オリジンは誰でも名乗れるので許可しても意味がない）。


経路の登録は `src/index.ts` と `src/auth.ts`・`src/members.ts`・`src/streams.ts`・`src/stamps.ts`・`src/chat.ts`。
認証は session cookie（`yts_`）→ `Authorization: Bearer ytt_…` → `Authorization: Bearer <Twitch トークン>` の順に見る。Twitch トークンは `TWITCH_CLIENT_ID` のアプリのものだけ通す。
cookie で認証した変更系（POST / PUT / PATCH / DELETE）は `X-Requested-With: yts` が必須。未認証は 401、会員でないチャンネルは 403。

| メソッド | パス | 誰が | 用途 |
|---|---|---|---|
| GET | `/api/health` | 誰でも | 死活確認 `{"ok":true}` |
| GET | `/api/config` | 誰でも | `twitch_client_id`（サインイン URL を組む） |
| POST | `/api/auth/session` | 誰でも（`X-Requested-With: yts` 必須） | Twitch トークンを検証して session cookie（30 日）を発行 |
| POST | `/api/auth/logout` | 認証済み | session を消す |
| GET | `/api/me` | 認証済み | login、所属チャンネルと役割、`site_admin` |
| POST | `/api/tokens` | session のみ | `ytt_` トークンを発行 |
| GET | `/api/tokens` | 認証済み | 自分の有効なトークン一覧（hash の先頭 8 桁で表示） |
| DELETE | `/api/tokens/:prefix` | session のみ | hash の先頭 8 桁で自分のトークンを失効 |
| GET | `/api/channels` | 認証済み | 自分が会員のチャンネル（サイト管理者は全チャンネル） |
| POST | `/api/channels` | サイト管理者 | チャンネルを作成（作成者が owner） |
| GET | `/api/channels/:login/members` | owner | 会員一覧 |
| POST | `/api/channels/:login/members` | owner | 会員の追加・役割の変更 |
| DELETE | `/api/channels/:login/members/:member` | owner | 会員の削除（最後の owner は不可） |
| GET | `/api/channels/:login/streams` | 会員 | 配信一覧（新しい順、墓標を除くスタンプ数付き） |
| POST | `/api/streams` | 会員 | VOD から配信を登録。既存なら `vod_id` と空でない `title` だけ更新 |
| GET | `/api/streams/:id` | 会員 | 配信 1 件 |
| PATCH | `/api/streams/:id` | 会員 | `vod_id` / `vod_offset_sec` / `chat_lag_sec` / `title` を更新 |
| POST | `/api/stamps` | 認証済み（行ごとに会員を確認） | スタンプの upsert（1 要求 500 件まで）。`updated_at` が新しい方が勝つ。墓標は作者本人か owner だけ |
| GET | `/api/streams/:id/stamps` | 会員 | 墓標込みの全件（`offset_sec` 昇順）。`?since=` で差分 |
| PUT | `/api/streams/:id/chat` | 会員 | チャット JSON を R2 へ（`?vod_id=&count=&length_sec=`、50 MB まで、本文はパースしない） |
| GET | `/api/streams/:id/chat` | 会員 | R2 のチャット JSON を返す（`Cache-Control: private, max-age=3600`） |

ページ: `/`（配信一覧）、`/auth/callback`（サインインの戻り先）、`/me`、`/admin`、`/s/<stream_id>`（配信ページ）、`/s/<stream_id>/comments`（切り離したコメント一覧）。

設計書 §9 の `/api/admin/members` はコードでは `/api/channels/:login/members`、`DELETE /api/tokens/<hash>` は hash の先頭 8 桁で指定する形になっている。

## データの置き場所

### R2（バケット `yts-chat`、binding `CHAT`）

- キー: `chat/<channel>/<vod_id>.json`。同じ VOD を取り込み直すと上書き
- 形: `{"vod_id":"…","length_sec":…,"fetched_at":"…","client":"web/1.0","comments":[[offset_sec, login, display_name, text], …]}`（エモート・色・バッジは持たない）

### D1（データベース `yts`、binding `DB`、スキーマは `migrations/0001_init.sql`）

| 表 | 主キー | 中身 |
|---|---|---|
| `channels` | `login` | 配信チャンネル |
| `members` | `(channel, login)` | 会員と役割（`owner` / `editor`） |
| `streams` | `stream_id` | 配信。`vod_id`、`vod_offset_sec`（既定 0）、`chat_lag_sec`（既定 5）、チャットの R2 キーと件数 |
| `stamps` | `(stream_id, id)` | スタンプ。同期 CSV の列に `source`（`extension` / `web` / `panel`）を足したもの。削除は `deleted=1` の墓標 |
| `api_tokens` | `hash` | `ytt_` トークンの SHA-256 |
| `sessions` | `id` | session cookie（30 日） |
| `token_cache` | `hash` | Twitch トークン検証結果のキャッシュ（トークンの SHA-256 をキーに 1 時間）。トークン自体は保存しない |

`stamps` の `id` は `y` + 7 桁 hex（28 bit の乱数）で配信をまたいで重なりうるので、主キーは `(stream_id, id)` の複合にしている。
API が返すスタンプは CSV と同じ 13 列で、`channel` / `started_at` は `streams` から、`timecode` は `offset_sec` から組み立てる。
