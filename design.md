<!-- Hallmark · genre: modern-minimal · design-system: design.md · designed-as-app -->

# Peakaboo Web 設計システム

> `service/web/` の全ページはこの文書を読んでから作る。CSS の実体は `service/web/css/app.css`、色の基準は `tests/test_web_tokens.js`。
> 元の設計書: `yato-atlas/yato-twitch-timestamp/specs/2026-10-30-web-redesign-design.md` §4（見た目の正は試作 v2）。

## Genre

**modern-minimal** — Notion のような「静かな道具」。箱で囲まず、罫線・余白・字の強弱で整理する。面（`.panel` `.listbox`）にまとめるのは表と一覧だけ。装飾のための色・影・角丸は足さない。

## Macrostructure（ページの型）

| 型 | クラス | 幅 | 使うページ |
|---|---|---|---|
| 文書型 | `main.doc` | 最大 680px | サインイン、配信一覧、マイページ、管理 |
| 文書型（狭） | `main.doc.pop` | 最大 560px | 別ウィンドウのコメント（ヘッダー無し） |
| 作業台型 | `main.wide` | 最大 1320px | 配信 |

本文の余白は `32px 28px 56px`（640px 以下は 16px）。

## Theme（トークン）

暗い地が既定、`@media (prefers-color-scheme: light)` で明るい地。手動の切り替えは付けない。
値はコントラスト基準が正で、下表は基準に合わせて動かした最終値（太字が試作 v2 から動かした値）。

| トークン | 暗い地 | 明るい地 | 用途 |
|---|---|---|---|
| `--paper` | `#161618` | `#ffffff` | 地 |
| `--paper-2` | `#1c1c1f` | `#f8f8f7` | 面・入力 |
| `--paper-3` | `#222226` | `#f1f1ef` | ボタン・表のヘッダー・hover |
| `--paper-4` | `#2a2a2f` | `#e8e8e5` | ボタンの hover |
| `--ink` | `#ececea` | `#2b2a27` | 本文 |
| `--ink-2` | `#a2a2a0` | **`#5c5b57`** | 補助の文字 |
| `--ink-3` | **`#8b8b88`** | **`#6d6c68`** | 件数・`.by`・プレースホルダー・軸 |
| `--rule` / `--rule-2` | `#2c2c31` / `#232327` | `#e6e6e3` / `#efefed` | 罫線 / 行の区切り |
| `--accent` | `#79b8f7` | **`#1b6cc7`** | リンク・選択 |
| `--accent-fill` | **`#2675c8`** | **`#1b6cc7`** | `.btn.pri` の塗り（白字 4.5:1） |
| `--on-accent` | `#ffffff` | `#ffffff` | 塗りの上の文字 |
| `--accent-soft` / `--sel` | `#2675c822` / `#2675c826` | `#1b6cc714` / `#1b6cc714` | 薄い青地・選択範囲 |
| `--ok` | `#7ccf86` | **`#297b40`** | 成功 |
| `--warn` | `#e6b65a` | **`#8e6511`** | 人のスタンプ（琥珀） |
| `--err` | `#ef7a7a` | `#c43c3c` | 失敗・削除 |
| `--cand` / `--cand-soft` | `#c99af0` / `#c99af01f` | `#7c3fb0` / `#7c3fb014` | 候補（紫） |
| `--bar-top` | `#6f8fb8` | **`#678bb9`** | グラフの棒 |
| `--bar-bot` | `#3b4d66` | `#c6d3e3` | 棒のグラデーションの下端（基準の対象外） |
| `--bar-hover` | `#8fb0d8` | **`#4a6c9a`** | 棒の hover |
| `--focus` | `#79b8f7` | **`#1b6cc7`** | focus ring |
| `--shadow` | `0 1px 0 #0006, 0 8px 24px -16px #000c` | `0 1px 0 #0000000a, 0 8px 24px -18px #00000040` | 面の影 |

コントラストの下限（`tests/test_web_tokens.js` が両方の地で計算する）:

- 文字（`--ink` `--ink-2` `--ink-3` `--accent` `--ok` `--warn` `--err` `--cand`）は `--paper` `--paper-2` `--paper-3` の 3 面すべてで 4.5:1 以上
- 線・棒（`--bar-top` `--cand` `--warn` `--accent-fill`）は 3 面で 3:1 以上
- `--on-accent` on `--accent-fill` は 4.5:1 以上、`--focus` on `--paper` は 3:1 以上
- 新しい色を足すときは先にテストへ足す。テストが落ちる値は使わない

## Typography

- 本文: `--font-body` = `Inter, "Noto Sans JP", system-ui, "Segoe UI", sans-serif`、15px / 行高 1.6、`font-feature-settings: "cv11", "ss01", "tnum"`
- 等幅: `--font-mono` = `"JetBrains Mono", ui-monospace, Consolas, monospace`（時刻・ID・トークン）、13px
- h1 28px / 600 / 字間 -0.02em。節の見出し `.sec-h` 13px / 600。表のヘッダー 12px / 500。補助文 13–13.5px
- 字体は Google Fonts（Inter 400/500/600/700、Noto Sans JP 400/500/700、JetBrains Mono 400/500、`display=swap`）を各 HTML の `<head>` で読む。読み込み前・遮断時はシステム字体で表示され、崩れないこと

## Spacing と形

- 余白は 4px 刻みを目標にする。現状は試作 v2 の値が正で、38 か所が 4px 刻みから外れる。一括で丸めるのは別作業
- 角丸: 面 8px（`--radius-lg`）、ボタン・入力 6px（`--radius`）、チップ 999px
- 操作の高さ `--control-h`: 36px、`@media (pointer: coarse)` で 44px

## Motion

- 遷移させてよいのは `transform` / `opacity` / 色（文字・背景・枠）だけ、120ms 以下（`--ease`）。幅・高さ・位置は遷移させない
- `prefers-reduced-motion: reduce` で遷移 0

## 部品（`app.css` のクラス）

| 部品 | クラス | 要点 |
|---|---|---|
| ヘッダー | `.hdr` `.mark` `.nav` `.who` `.av` | 52px。マーク 22px + 製品名、現在地は下線 2px、右にアバター 24px + ログイン名 + サインアウト（文字ボタン） |
| パンくず・導入 | `.crumb` `.lead` | 13px / `--ink-2` |
| 節 | `.sec` `.sec-h`（`.cnt` `.r`）`.help` | 見出しの下に罫線、右端 `.r` に補助操作 |
| 面 | `.panel` `.listbox` `.gwrap` | 1px 枠 + `--shadow` + 8px、地 `--paper-2` |
| ボタン | `.btn` `.btn.pri` `.btn.ghost` `.btn.danger` | `.pri` だけ塗り |
| 入力 | `.in` | `--paper-2`、1px 枠、内側に 1px の影 |
| 候補 | `.chip` | 枠と文字が `--cand`、地 `--cand-soft`、11px / 600。色だけに頼らず「候補」と書く |
| 注記 | `.note` | 左 3px の青線。1 回だけ見せるトークンなど |
| インライン値 | `.inline` | 破線の下線。クリックで入力に変わる |
| 一覧 | `ul.rows`（`li.in-bin` `li.flash` `li.cand` `li.human` `.t` `.u` `.by` `.x`）、`ul.rows.st` | 時刻（等幅）/ 名前 / 本文。候補は左 3px 紫、人は左 3px 琥珀。選択範囲は `--sel` の地、別ウィンドウの点滅は地 + 左 3px 青 |
| スタンプの削除 | `ul.rows .x` | 行の右端の × は本物の `<button>`（枠・地なしの文字だけ、`--ink-3`、hover で `--err`）。書いた本人・チャンネルの owner・サイト管理者にだけ出し、確認してから消す。タッチでは当たり判定だけ 44px |
| 配信一覧 | `.streams`（`tr.is-new` `.t a.untitled` `td.num`） | 表。行のどこを押してもタイトルのリンクへ（index.js の tbody への click 委譲）。登録直後の行は `--sel` の地 + 左 3px 青 |
| 会員表 | `.members` | 管理ページの表。5 列 + 追加フォームを 680px に収めるため左右の余白を 10px に詰め、login は折り返さない（収まらなければ面の中で横スクロール） |
| 配信ページ | `.meta` `.gwrap` `.graph` `.selrow` `.lists` `.tabs` | `.lists` は 1100px 以上で 3:2 の横並び（`.tabs` は隠れ、両パネルが見える。パネルは `role="tabpanel"` を外す）、未満は 1 列 + タブ（選んでいないパネルの列は見出しごと畳む）。切り替えは stream.js の `syncLayout()` |
| アイコン | `svg.i` | 線画 1 系統、線幅 1.75、14px。絵文字は使わない |

JS が付けるクラス名（`in-bin` `flash` `is-new` `cand` `candidate` `human` `invalid` `untitled` `on`、状態行の `ok` / `error`、タブの `aria-selected`）は契約なので名前を変えない。`candidate` は互換のために stream.js が `cand` と並べて付けている（今は app.css も JS も読まない）。

## CTA voice

- `.btn.pri` は 1 ページに 1 つ: 「Twitch でサインイン」「ここに印」「発行」「この VOD で取り込む」（配信ページのメタ行の「取り込む」は文字だけのボタン `.link-btn`）
- それ以外は既定の `.btn`、目立たせない操作は `.btn.ghost`、削除・失効は `.btn.danger`

## 文言の規則

- 利用者に見せる文言は日本語だけ（Peakaboo の例外。コードコメントは日英併記のまま）
- 1 行で言い切る。敬体でなくてよく、体言止めも可（「未取り込み」「取り込み済み」）
- 変えないもの: `候補:` 接頭辞、CSV の列名、API のエラーコード

## What pages must share

- マーク（`/favicon.svg` と同じ図形）とヘッダー（別ウィンドウのコメントとサインインは除く）
- `app.css` のトークンと部品。ページ固有の色・影・角丸を足さない
- 字体の `<link>`（6 つの HTML すべて）
- focus ring は `--focus` 2px（`:focus-visible`）

## 改訂履歴

- 2026-10-30 初版（設計書 §4 から転記。コントラスト基準に合わせて `--ink-2`（明）`--ink-3` `--accent`（明）`--accent-fill` `--ok`（明）`--warn`（明）`--bar-top`（明）`--bar-hover`（明）`--focus`（明）を調整）
- 2026-10-30 仕上げ: 旧クラス（`.card` `.row-list` `.stream-row` `.stream-grid` `.site-nav` ほか）と旧トークンのエイリアスを削除。部品表に `.streams` `.members` スタンプの削除を足し、`.lists` / `.tabs` の切り替えを明記。`.btn.danger` の hover は枠を赤くしない
- 2026-10-30 最終レビュー: CTA の表を「この VOD で取り込む」に直し、`candidate` が互換用であることを明記
