# Peakaboo

> リポジトリ名は `yato-twitch-timestamp` のまま。製品名は **Peakaboo**（peak + peekaboo: チャットの山が顔を出す）/ The repository keeps its name; the product is **Peakaboo**.

Peakaboo is a dependency-free Chrome extension for recording useful moments during a Twitch live stream. Broadcasters and editors can create native Twitch stream markers. Moderators without editor permission automatically fall back to local records. Every timestamp is stored locally regardless of whether the native marker succeeds.

Records can be exported as a shared CSV sync file for the included Premiere Pro and After Effects panel. Editors can also merge CSV files received from moderators through the extension popup.

## 画面の文言と見た目 / UI copy and appearance

- **Japanese only.** Every label, button, status line, and error message in the web pages, the Adobe panel, and the extension is Japanese only. Everyone who uses Peakaboo reads Japanese, and the earlier "日本語 / English" pairs doubled the length of every line without serving anyone. English stays in code comments and in this README, which quotes the Japanese labels with an English gloss. Contract strings are unchanged: the `候補:` memo prefix, `by: ` and `[yts:` in marker comments, the CSV column names, and the API error codes.
- **Theme follows the OS.** The web pages are dark by default and switch to the light theme through `prefers-color-scheme`; there is no manual toggle. The design system (tokens, components, contrast floor) is documented in [`design.md`](design.md); `tests/test_web_tokens.js` checks the colour tokens against the contrast floor in both themes.
- **Fonts** (Inter, Noto Sans JP, JetBrains Mono) are loaded from Google Fonts. When they are blocked or still loading, the pages fall back to system fonts.
- **Updating.** The extension is version 0.6.0 with the Japanese-only copy; reload it from `chrome://extensions` after pulling. The Adobe panel picks up the new copy after re-running `panel\install.ps1` (see [Sync file workflow](#sync-file-workflow)).

## Setup

1. Register an application at [Twitch Developer Console](https://dev.twitch.tv/console).
2. Set its category to **Other** and its client type to **Confidential**. Twitch allows the implicit grant only for Confidential clients; a Public client is limited to the device code grant. Twitch issues a client secret for a Confidential client, but this project never uses it.
3. Add this OAuth Redirect URL:

   ```text
   https://nkebinaanllmgbkpehnlcaomjcofdnng.chromiumapp.org/
   ```

   The popup also shows the exact redirect URL. Register it in the Twitch developer console before logging in.

4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` directory.
5. Open the extension popup. The Client ID field is prefilled with the project's Twitch application (`105fdov1w7trd0swseu50l5qy2sckg`); an empty field also falls back to it. Paste your own Client ID only if you registered a separate application, then click "保存".
6. Click "ログイン" and authorize the `channel:manage:broadcast` scope.
7. Optional: to send stamps to the cloud service, see [Server sync](#サーバーと同期--server-sync).

The `key` in `extension/manifest.json` pins the unpacked extension ID to `nkebinaanllmgbkpehnlcaomjcofdnng`, so the redirect URL above stays stable across machines. It was generated once with:

```sh
node tools/gen_key.js
```

The private key was intentionally discarded and is never written to disk; unpacked loading only requires the public key. Running the generator again creates a different key and therefore changes the extension ID. Update `manifest.json` and the Twitch redirect URL if you do this.

## Usage

Open a live Twitch channel page and use the floating "⏱ 記録" button (or the hotkey). The time is recorded at the press; a memo field then opens next to the button with focus. Enter saves the memo to that record, Esc closes it without a memo (the record is kept), and leaving the field with text saves it. Pressing "⏱ 記録" again while the field is open saves the pending memo to the previous record first. The memo field isolates its keyboard events from Twitch hotkeys and ignores Enter/Esc during IME composition.

Drag the "⋮⋮" handle to move the button; the position is stored relative to the bottom-right corner and kept inside the window. Double-click the handle to return it to the bottom-right.

Native Twitch markers are created at the press, so their description is only `[<recorder>]`. Twitch has no API to edit a marker, so memos typed afterwards are stored in the local record and the exported CSV only.

The default keyboard shortcut is `Alt+Shift+M`. Change it at `chrome://extensions/shortcuts` if it conflicts with another application.

For broadcasters and editors, the extension asks Twitch to create a native stream marker and also saves the record locally. For moderators, Twitch normally returns 401 or 403 because the account lacks broadcaster/editor rights. This is an expected fallback: the extension saves the timestamp locally without showing a warning. If Twitch validation or channel APIs are temporarily unavailable, the last live stream information cached for that channel is used so the press is still saved locally. A moderator can export a CSV and send it to the editor, who selects "CSV を取り込む" in the popup. Imported records are merged by their stable `id`; legacy rows without a valid ID receive a deterministic ID.

The popup groups non-deleted records by stream and shows whether each one is "ネイティブ" or "ローカル". Deleting an individual record turns it into a tombstone (sent to the server when server sync is on); deleting a whole stream removes its records locally only. CSV export also includes tombstones so deletions continue to propagate through a shared sync file.

## サーバーと同期 / Server sync

The extension can send every stamp to the cloud service (`service/`) as well as keeping it locally. It is off until a server URL is set.

Setup:

1. Keep the Client ID as prefilled (the Worker accepts only tokens issued for its own Twitch application) and keep the Redirect URL registered as in [Setup](#setup); nothing changes there.
2. Enter the server origin in "サーバー URL" (server URL), for example `https://yato-twitch-timestamp.hakuseiyato.workers.dev`, and click "保存". Only `https://host` or `https://host:port` is accepted (no path, query, or fragment).
3. Click "このサーバーへの送信を許可" (allow sending to this server) and accept Chrome's prompt. The extension declares the server only as an optional host permission, so Chrome blocks requests to it until you grant it for that origin. Once granted, the popup syncs immediately.
4. Make sure you are logged in. The Worker checks the Twitch token and accepts stamps only for channels where your Twitch login is a member (`/admin`).

Saving a different server URL queues every local record (tombstones included) for the new server and forgets which records the previous server had received or rejected.

Behavior:

- Stamping, editing a memo, importing a CSV, and deleting an individual record each queue the affected record and upload it right away with `POST /api/stamps`. A deleted record is sent as a tombstone (`deleted: true`); the server accepts tombstones only for your own records.
- "配信ごとの削除" (the stream-level "削除" button) is local only. It removes the stream's records from this browser and from the upload queue and sends nothing, so the stream stays on the server.
- Records that could not be sent (offline, server error, expired login) stay in the queue. The extension retries the queue every five minutes and after the next login. "サーバーと同期" (sync with server) queues every local record, tombstones included, and sends them now.
- The popup shows "送信待ち n 件" (pending n), "最終同期 HH:mm（成功 n）" (last sync) with the number of accepted records, and, per record, a mark next to "ネイティブ" / "ローカル": "送信済" (sent: the current server accepted it), "送信待ち" (pending: queued), "失敗" (failed: rejected), or "未送信" (unsent: never sent to the current server, for example after "失敗一覧を消す"; "サーバーと同期" sends it).
- A record the server reports as `stale` is already stored there in the same or a newer version. It counts as sent and is not retried.

Reading failures:

- Records the server rejects one by one appear in the collapsible "失敗 n 件" (failed n) list with the last four characters of the id, the timecode, and the reason. They are not retried automatically; "失敗一覧を消す" (clear failures) empties the list, and "サーバーと同期" sends them again after you fix the cause.
  - "他の人の記録は消せません" (cannot delete others' records, `forbidden_tombstone`): only the author (or, on the web, a channel owner or a site admin) can delete a record on the server. It stays deleted locally.
  - "このチャンネルの会員ではありません" (not a member of this channel, `forbidden_channel`): ask a channel owner to add your Twitch login in `/admin`.
  - "記録の形式が不正です" (invalid record, `invalid_*`), "時刻が不正です" (invalid time, `invalid_time`), "配信情報がありません" (stream missing, `missing_stream`): the record itself is broken, typically from an edited CSV.
- Errors that stop the whole upload are shown under the last sync line, and the records stay pending:
  - "サーバーが要求を拒否しました (http_404)" (server rejected the request) or another 4xx status: usually a wrong server URL.
  - "サーバーが一時的に応答しません" (server temporarily unavailable: 5xx, 408, 429) or "通信できませんでした" (network error: offline): the five-minute retry sends them later.
  - A code the server names itself, such as `twitch_unavailable` (Twitch is down) or `csrf`, is shown as is.
  - "拡張の内部エラー" (extension internal error): an unexpected error inside the extension; reload it from `chrome://extensions`.
  - "サーバーへの送信が許可されていません" (sending not allowed yet): grant the host permission (step 3).
  - "ログインが必要です" (login required): log in again (see below).
- Twitch login tokens from the implicit grant expire after about four hours. When the server answers 401, or when the extension finds the token expired while stamping, the popup shows "トークンが切れました。再ログインしてください" (token expired; log in again). Click "ログイン"; the queued records are sent after the login. Stamps keep being saved locally in the meantime.

## Scout（候補検知） / Scout (highlight candidates)

Scout (`scout/`) is a local command-line tool that listens to a stream's VOD, picks moments that look like highlights, and posts them to the cloud service as **candidate stamps**. Candidates are ordinary stamps whose memo starts with `候補:` and whose `source` is `scout`; people then keep, edit, or delete them on the web or in Premiere Pro like any other stamp. The stream must already be registered on the service from its VOD (`/` → "VOD から登録").

Prerequisites:

- Python 3.13 with `numpy` and `faster-whisper`, plus the NVIDIA CUDA wheels faster-whisper uses (for example `nvidia-cublas-cu12`). Scout puts the `nvidia\*\bin` DLL folders of those wheels on `PATH` itself.
- `ffmpeg` and `yt-dlp` on `PATH`.
- An NVIDIA GPU is recommended. Without CUDA, Scout falls back to the CPU automatically (or use `--cpu`), which is much slower.
- A panel token (`ytt_…`) issued on `/me`, and membership of the channel (`/admin`).

First run:

1. Sign in on the service, open `/me`, and issue a token.
2. Double-click `scout\scout.bat`. When asked "Peakaboo の /me で発行した ytt_ トークンを貼り付けてください / Paste the ytt_ token issued on /me", paste it and press Enter. The input is hidden. The token is saved to `token_path` (`%APPDATA%\peakaboo\scout.token` by default) and not asked again. If the server later answers 401, issue a new token on `/me` and replace the contents of that file.

Usage:

1. Double-click `scout\scout.bat` (it runs `python -I scout.py` and keeps the window open at the end).
2. Scout lists the newest 15 streams of the configured channel (`channel` in `scout.config.json`, `terano_naa` by default). The newest stream with a VOD is marked "[既定 / default]"; press Enter to accept it or type a row number. A stream without a VOD stops with "Web で VOD から登録してください / Register the VOD on the web first".
3. Scout downloads the VOD's audio-only stream with `yt-dlp`, converts it to 16 kHz mono with `ffmpeg`, and transcribes it with faster-whisper (`large-v3-turbo`, CUDA float16; CPU int8 with `--cpu` or as the fallback). A 2.5-hour VOD took about 1 minute to download and 3 minutes to transcribe on an RTX 4070 Ti. The transcript is cached, so a second run on the same VOD skips both steps.
4. It fetches the stream's stamps and chat (if the chat was never imported it says "チャット信号なし / no chat signals" and scores from the audio alone) and shows a table: 配信時刻 / stream time, VOD時刻 / VOD time, 点 / score, 理由 / reason, 発言 / utterance.
5. "送信しますか？ / Send? y/N": `y` sends all candidates in one `POST /api/stamps` with `source: 'scout'`; anything else sends nothing.

Options (pass them after `scout.bat` from a terminal, or run `python -I scout.py …` in `scout/`):

| Option | Meaning |
|---|---|
| `--stream <id>` | Use this stream id instead of choosing from the list |
| `--server <url>` | Server URL, overriding `server` in the config |
| `--dry-run` | Show the table and send nothing |
| `--top N` | Candidate cap, overriding `cap_total` |
| `--replace` | Delete (tombstone) your own previous candidates for the stream and pick again; the tombstones go in the same POST after the `y` confirmation |
| `--cpu` | Run Whisper on the CPU |
| `--config <path>` | Another config file instead of `scout/scout.config.json` |

Exit codes: `0` sent (or `--dry-run`), `1` no candidates or not sent, `2` error. The log is appended to `<cache_dir>\<vod_id>\scout.log` (`cache_dir` is `%LOCALAPPDATA%\peakaboo\scout` by default), next to the cached audio and `transcript.json`.

How candidates are chosen:

- The VOD is split into 0.5-second bins and scored with five signals, each normalised to 0–1 and weighted: 声の急変 (sudden change in voice level), 笑い (laughter), 発言 (keywords in the transcript), チャット急増 (chat spike), and チャットの反応 (reaction words in chat). A bin becomes a peak when the weighted sum reaches `threshold` (2.0 out of a maximum of 4.3 with the default weights, so several signals have to agree). Without chat the threshold is scaled down to the share of weight the audio signals carry.
- Peaks within `merge_sec` (20 s) are merged. Anything within `exclude_radius_sec` (±30 s) of a human stamp (not deleted) or of an existing candidate is dropped; candidates that were deleted still count, so a rejected moment is not proposed again (except your own candidates replaced by `--replace`).
- A stream gets at most `cap_total` (10) candidates in total, existing candidates that are not deleted included.
- The memo is `候補: <reasons> | <what was said>`, for example `候補: 笑い・チャット急増 | …`.

Where candidates appear:

- **Web (`/s/<id>`)**: candidates are violet vertical lines on the graph (human stamps stay amber). In the stamp list they have a violet left border, a "候補" badge, and the memo without its prefix. "候補を先に" (candidates first) lists them before the other stamps. Delete a wrong candidate as usual; its author, a channel owner, or a site admin can delete it.
- **Premiere Pro panel**: candidate markers that "同期" creates are yellow. Sync colours only the markers it creates; markers already in the sequence keep their colour. Yellow is reserved for candidates, so new human markers cycle through the other colors.

Creating Short sequences (Premiere Pro only):

The button next to the frame-export button ("候補から Sequence を作る" (create Short sequences from candidates)) opens a popover with "マーカーの前（秒）" (seconds before the marker, default 15), "マーカーの後（秒）" (seconds after the marker, default 45), "人のマーカーも含める" (include human markers), and "作成" (create). For every Peakaboo marker (one with a `[yts:…]` tag) that is a candidate, or every one when the check box is on, the panel sets the active sequence's In/Out to [marker − before, marker + after], creates a subsequence, names it `YYMMDD_Short_NN_<memo without the prefix, up to 20 characters>` (YYMMDD = the stream's start day in JST, else the leading 6 digits of the sequence name; names are made unique and NN continues after Shorts already in the bin), removes the markers copied into it, and moves it to the `Sequence/_YYMMDD` bin (created when missing; `_YYMMDD` at the project root when there is no `Sequence` bin). The original In/Out points are restored afterwards, including the "unset" state, and the source sequence is made active again. If the day bin already holds Shorts, the panel asks before adding more. Verified in Premiere Pro 26.5 on 2026-10-30.

Tuning:

Edit `scout/scout.config.json`: `weights` (per signal), `threshold`, `keyword_words` (transcript keywords), `laugh_words`, `chat_words`, `exclude_radius_sec`, `merge_sec`, and `cap_total`. Because the transcript is cached, a re-run with `--dry-run` re-scores in seconds; compare the table with what you would have picked and adjust. Use `--replace` to swap your previous candidates for the new ones.

Privacy: the audio and the transcript stay on your machine in `cache_dir`. Only the candidate stamps (the 13 stamp columns: time, memo, your login, and so on) are sent to the server.

## Lag compensation

The lag setting estimates the delay between the broadcast timeline and what the viewer sees. Its default is five seconds. The extension subtracts this value from both locally calculated offsets and Twitch's native `position_seconds`, keeping native and local records on the same compensated timeline. Local timing also corrects clock skew using the Twitch response `Date` header. Set the lag value according to the viewing setup shared by the stamping team.

## Export

### CSV

Click "CSV" for a stream. CSV files use UTF-8 with a BOM, RFC 4180 quoting, and CRLF line endings. The columns are `id`, `timecode`, `offset_sec`, `by`, `memo`, `native`, `channel`, `stream_id`, `started_at`, `created_at`, `updated_at`, `deleted`, and `clock_skew_ms`. They can be shared with another editor and merged through "CSV を取り込む". Popup import first tries strict UTF-8 decoding and falls back to Shift_JIS.

New IDs are `y` followed by seven hexadecimal digits. The `y` prefix prevents Excel from converting an ID to a number. Existing eight-character hexadecimal IDs remain valid, and a legacy row without an ID receives a deterministic `y`-prefixed ID. If Excel removes leading zeroes from an older eight-character hexadecimal ID, the resulting one- to seven-character value is repaired by zero-padding. Extra columns added in Excel are not preserved when the panel rewrites the CSV.

## Sync file workflow

The `panel/` CEP extension provides the same sync workflow in Premiere Pro 22+ and After Effects 22+.

1. Export a stream CSV from the Chrome extension and put it in a shared folder accessible to every editor.
2. Install the panel:

   ```powershell
   powershell -ExecutionPolicy Bypass -File panel\install.ps1
   ```

3. Restart Premiere Pro or After Effects, then open **Window > Extensions > Peakaboo**.
4. Click "選ぶ" for the sync file, choose the stream, and enter the offset in seconds.
5. Activate the sequence or composition to synchronize, then use "紐付け" in the action row: "紐付け", "＋追加", "同期". The panel links the currently active target in both Premiere Pro and After Effects; it does not create a sequence. If no target is active, it reports "シーケンス（コンポ）を開いてください". For an already linked target, the button reads "再紐付け" and asks "紐付けし直すと同期の履歴が消えます。続けますか？" because re-linking clears its synchronization base.
6. Once a CSV is loaded and a target is linked, "同期" becomes enabled. Click it to calculate the differences and normally apply them immediately. A confirmation drawer opens only for a calculation error, mass deletion, conflict, first synchronization, tag operation, at least ten additions to the app, or a warning. The drawer provides the difference list, conflict choices, mass-deletion confirmation, "未タグのマーカーも CSV に追加", and "この内容で同期".

Changes made in the CSV, Premiere Pro, or After Effects are included in the differences calculated when "同期" is clicked and can be synchronized to the other targets. The panel compares each side with its last synchronized base. If both sides changed, the row is shown as "競合" and defaults to the app version; choose "CSV優先" for an individual row when needed. A newly linked target that has never been synchronized defaults to the CSV version.

Editing the CSV in Excel is supported, but keep the `id` column. A row without a valid ID gets a deterministic legacy ID based on its content, so changing its stream, offset, author, memo, or creation time before the first sync can change that ID. The first panel sync writes these IDs into the CSV. If duplicate IDs occur in one file, the first row keeps its ID and later rows receive new IDs. If an edited `timecode` (`h:mm:ss`, `hh:mm:ss`, or `mm:ss`) differs from `offset_sec`, the timecode wins and is converted to integer seconds. ID and timecode repairs force the panel to rewrite the CSV on the next sync. Deleting a CSV row, or setting `deleted=true`, deletes its marker on the next sync. Deleting a marker in an Adobe app writes a `deleted=true` tombstone to the CSV so other linked targets also delete it.

### Creating a sync file from Premiere Pro / After Effects

A sync file does not have to come from the Chrome extension. Open the sequence (or comp) whose markers you want to start from and click "新規". Choose where to save the CSV (default name: the sequence name); an existing file is never overwritten. The panel writes one row per marker, gives untagged markers an ID tag, links the sequence, and records the current markers as already synchronized, so the next "同期" only handles real changes. Rows get `stream_id = local-<hash of project path and sequence ID>`, `channel` = sequence name, an empty `started_at`, and `by` from the marker comment (or `premiere` / `ae`). At least one marker is required ("＋追加" can place one). Moderators' CSVs can be merged into the new file later with "統合"; their rows keep their own Twitch stream and show up as a separate stream.

### DualPlayer CSVs

Current DualPlayer builds export the sync format directly. Older builds wrote `Timecode, Seconds, Note, Has Screenshot, Thumbnail (Base64)` (comma- or tab-separated); the panel recognizes that format:

- Picking such a file with "CSV" converts it without asking (the original is never modified) into `<name>_sync.csv` next to it, merged into that file if it already exists so re-exports can be imported again. The panel then links the open sequence if it is not linked yet and syncs (see "Fewer clicks" below).
- Selecting it in "統合" converts and merges it into the current sync file.
- Conversion: `offset_sec` = `Seconds`, `memo` = `Note`, `by` = `dualplayer`, `channel` = the CSV's folder name, `stream_id` = `dual-<hash of the folder path>`, `created_at`/`updated_at` = the file's modification time. IDs are derived from the stream and the time, so the same stamp keeps its ID across re-exports and an edited note merges as an update. Thumbnails are not imported.

Any other CSV is rejected with a message naming the file; use "新規" to start a sync file from a sequence's markers.

### Import rules (merge and DualPlayer re-import)

Imports never undo work done in Premiere / After Effects:

- A row deleted in the app (a `deleted=true` tombstone) is never revived by an import.
- DualPlayer rows only carry the export file's time, so they replace a row only while it is still exactly as imported (never edited by a sync). Notes edited in DualPlayer therefore update untouched rows, but a marker moved, renamed or deleted in the app keeps the app's version. The log counts these as "編集済みのため取り込まなかった".
- Rows with real per-row times (moderators' Chrome-extension CSVs) follow "later `updated_at` wins".
- An ID that already exists under a different stream is re-keyed to a stable new ID instead of overwriting the other stream.
- The automatic sync after a CSV pick / conversion / merge runs without asking only when it adds markers or rows; any update or deletion stops at the confirm drawer ("取り込み後の変更").

DualPlayer limitations: a stamp's ID comes from its time, so moving or deleting a stamp in DualPlayer is not propagated (a moved stamp becomes a new marker; edit or delete the old one in the app). Stamps at the same millisecond are told apart by their order in the file, so deleting or reordering one of them in DualPlayer can shift which note maps to which marker. The DualPlayer stream is derived from the folder the CSV is in; moving the footage folder makes re-imports appear as a separate stream.

### Fewer clicks

After "CSV" (and after a DualPlayer conversion) the panel links the open sequence/comp automatically when it is not linked yet and the CSV has a single stream, then syncs. An already linked target is never re-linked, and the offset starts at 0 for a newly linked target. The first sync of a target still stops at the confirm drawer, so the usual flow is "CSV" → pick the file → "この内容で同期".

### サーバー / Server

Instead of a shared CSV file, the panel can use a stream stored in the cloud service (`service/`) as its sync source.

1. Sign in on the service, open `/me`, and issue a panel token (`ytt_…`). It is shown only once.
2. In the panel, click "サーバー", enter the server URL (for example `https://yato-twitch-timestamp.hakuseiyato.workers.dev`; only `https://host` or `https://host:port`) and the token, and click "接続" (connect). The settings are saved only after the server accepts them; afterwards "サーバー" connects right away.
3. Choose the channel and the stream (`YYYY-MM-DD HH:mm · title · スタンプ n`) and click "この配信を開く" (open this stream).
4. The panel copies the stream's stamps into a mirror CSV and opens it like any sync file. As with "CSV" (see "Fewer clicks"), it links the open sequence/comp if it is not linked yet and syncs; the first sync stops at the confirm drawer, so the usual flow is "この配信を開く" → "この内容で同期". After that, "紐付け" and "同期" work as for a CSV file.

The mirror CSV is `%APPDATA%\yato-twitch-timestamp\server\<host>\<stream_id>_sync.csv` (the panel's CEP `USER_DATA` folder; characters other than letters, digits, `_`, `-` and `.` in the host and the stream id become `_`, so `host:8443` becomes `host_8443`). Next to it are `<stream_id>.server.json` (server URL, stream, your login, and the last pull and push times) and the usual `<stream_id>_sync.yts-sync.json` sidecar. The panel manages these files; do not edit them.

What "同期" does with a server stream:

- **Pull first.** It fetches all of the stream's stamps (tombstones included) and merges them into the mirror CSV by `id` (the later `updated_at` wins), then calculates the differences as usual. The log shows "サーバーから n 件取り込み" (pulled n). If the server cannot be reached or refuses (401, 403, network), the sync stops with "サーバーから取り込めないため同期を中止しました: …" (sync stopped: could not pull from the server), because syncing with stale local data would misjudge conflicts.
- **Push after.** Once the sync has written the mirror CSV, the records changed since the last push are sent with `POST /api/stamps` (`source: 'panel'`, 500 per request): "サーバーへ n 件送信" (pushed n). Records exactly as the server returned them on the pull are not sent back. The last-push time is the moment the push started, so an edit made during a push is sent next time. If a request fails (network, 5xx, 401, …), the last-push time does not move: "サーバーへの送信は次回に再試行: …" (push will retry), and the next "同期" sends everything changed since the previous successful push. The markers and the mirror CSV are already synchronized at that point.
- **Per-record results.** `stale` is not a failure: the server already has the same or a newer version, so it counts as sent. Other rejections are shown as "送れなかった n 件: <reason>" (failed n) with the reasons listed under [Server sync](#サーバーと同期--server-sync). For `forbidden_tombstone` ("他の人の記録は消せません" (cannot delete others' records)), you deleted a marker recorded by someone else; only its author (or, on the web, a channel owner or a site admin) can delete it on the server. The panel remembers the id, and the next "同期" restores the server's record into the mirror CSV and puts the marker back.
- **Recorder.** Records created by the panel ("＋追加", and markers picked up by "同期") get your Twitch login from `/api/me` as `by` instead of `premiere` / `ae`.

Limits:

- 鏡 CSV を Excel 等で直接編集してもサーバーには届きません。編集は Premiere / After Effects のマーカーか Web で行ってください / Edits made directly to the mirror CSV do not reach the server; edit through the markers in Premiere Pro / After Effects or on the web.
- 古い同期 CSV をサーバーへ上げるには、Chrome 拡張の「CSV を取り込む」を使います（拡張がサーバーへ送ります）。パネルの「統合」はサーバーの配信では使えません / To upload an old sync CSV, use "CSV を取り込む" in the Chrome extension (the extension sends it to the server). The panel's "統合" is disabled while a server stream is open.
- スタンプが 0 件の配信も開けます。「＋追加」で最初の印を付けてください / A stream with no stamps can be opened too ("サーバーの配信を開きました（スタンプ 0 件）"); add the first marker with "＋追加", then "同期".

Errors:

- "トークンが無効です。Web の /me で発行し直してください" (token invalid; issue a new one on /me) (401): the token was revoked or mistyped. Issue a new one on `/me`, enter it under "サーバー", and click "接続" (connect).
- "このチャンネルの会員ではありません" (not a member of this channel) (403): ask a channel owner to add your Twitch login in `/admin`.
- "この鏡 CSV は別のサーバー（…）のものです。「サーバー」で接続し直してください" (this mirror CSV belongs to another server): the saved server URL changed after the mirror was made. Connect to that server again, or open the stream from the new server (it gets its own mirror folder).

### Exporting marker frames

The image button left of "↻" exports every marker in the list; it first asks for the destination folder (starting at the last folder used, else `frames/` next to the sync file) and remembers it per host. The image button on each row exports that marker to the remembered folder without asking (or to `frames/` next to the sync file if no folder was chosen yet).

The image is the **rendered frame of the sequence / comp**, including titles, effects and every other layer, at the sequence's frame size. Premiere Pro uses the QE `exportFramePNG`, which renders asynchronously (a few seconds per frame); the panel waits until the file is complete. After Effects uses `comp.saveFrameToPng` (not yet verified live). The playhead is not moved. After an export Explorer comes to the front with the exported file selected (for a batch, the last file); an Explorer window already showing that folder is replaced so it does not stay behind. If the rendered export fails, the panel falls back to the source video frame (decoded in the panel at the source resolution, titles not included) and says so in the log.

Files are named `HH-MM-SS-FF_<marker name>.png` (characters not allowed in Windows file names become `_`, the name part is capped at 60 characters, and an empty name leaves only the timecode). Exporting the same marker again overwrites its file; when two markers in one batch would get the same name, `_2`, `_3`, ... are appended.

### Merging other CSVs

Each moderator exports their own CSV from the extension. With the sync file loaded, click "統合" next to "CSV" and select one or more of those files (the dialog opens in the sync file's folder). They are merged into the sync file by `id` with the same rules as everywhere else: the row with the later `updated_at` wins and `deleted=true` tombstones are kept. Rows from other streams are kept too and appear in the stream selector. The sync file is re-read right before writing and written with the usual `.bak` protection; nothing is written when no row is new or newer.

After a successful merge the selected files are moved to a `merged/` folder next to the sync file (a timestamp is appended if the name is taken). A file with unreadable rows (or that cannot be parsed) is skipped and left in place, and the log lists its line numbers. Selecting the sync file itself is ignored. Merging the same file again is harmless because IDs deduplicate. If the open sequence is already linked, the panel syncs right away; otherwise markers pick up the merged rows on the next "同期". A CSV that has its own `.yts-sync.json` (another target's sync file) is merged but not moved, and a file with warnings (for example an Excel-mangled `stream_id`) is skipped.

### Marker list

The always-visible marker list shows a thumbnail, timecode, name, and comment / recorder. Click a timecode to move the playhead. Click a name to edit it; Enter confirms, Shift+Enter inserts a line break, Esc cancels, and Enter does not confirm during IME composition. Premiere Pro comments can also be edited while preserving the trailing `by: X [yts:id]` metadata. "＋追加" creates a marker at the playhead, moving it forward one frame if that time is occupied. A marker is deleted by pressing its trash button twice, with the second press at least 300 ms and no more than three seconds after the first. Edits are applied to the app immediately and reach the CSV on the next synchronization. If the active target has changed, editing is rejected with "対象が切り替わりました。↻ で更新してください".

Thumbnails are drawn by seeking the source video in the panel's `<video>` element. They are loaded from memory, then from the disk cache under `USER_DATA/YatoTwitchTimestamp/thumbs`, and finally decoded from the video. Cache files use FNV-1a keys and temporary-file replacement. A failed thumbnail is not retried while the panel remains open.

### Safety checks

- The panel blocks synchronization when `offset_sec` cannot be read and reports the affected CSV lines as "読めない行があります: 5, 9 行目（offset_sec / timecode を確認してください）". Popup import instead skips unreadable rows and reports their count.
- A `stream_id` that resembles an Excel conversion, such as scientific notation or a value containing `.`, produces a warning. If a linked stream has no CSV rows, synchronization stops with "この配信の行が CSV に見つかりません（stream_id が Excel で変換された可能性があります）".
- At execution, the panel reloads the CSV and uses `mergeFresh`, confirms the linked target again, reloads the markers and compares them with `sameMarkers`, then reloads the CSV immediately before writing. A changed CSV, target, or marker list stops with "確認後に CSV が更新されました。同期を押し直してください", "紐付け先が変わりました。同期を押し直してください", or "確認後にマーカーが変更されました。同期を押し直してください". A final CSV collision after app changes reports "確認後に CSV が更新されました。同期を押し直してください（アプリ側の変更は適用済みです）". Content is compared directly because some file systems expose modification times with only one-second resolution.
- During immediate one-click synchronization, an interruption before app changes triggers one automatic recalculation and retry. If the retry also stops, the confirmation drawer opens. An interruption after execution from the drawer recalculates the content and refreshes the drawer.
- If a sync would delete at least three markers or rows and at least half of the previously synchronized markers, the red "大量削除を確認しました" checkbox must be selected before "この内容で同期" is enabled. This commonly protects against replacing the sync file with a fresh extension export that lacks rows previously added by Adobe apps.
- Markers whose time cannot be read are skipped, reported as "時刻を読めないマーカーがあります", and never treated as deleted.

### Notes

- After applying operations, the base snapshot is rebuilt from markers actually present in the app. Failed operations are retried on the next sync, and a row for an untagged marker is not written if tagging it failed.
- A tagged marker that duplicates another ID or carries an ID belonging to another stream is re-tagged with a new ID instead of overwriting the other CSV row.
- Premiere Pro updates preserve marker duration, color, and comment text other than replacing the `[yts:id]` tag; newly created markers include `by:`. After Effects updates preserve duration, label, chapter, URL, frame target, cue point name and type, and existing parameters.
- After Effects cannot store two markers at the same time. A colliding create or update is moved forward one frame at a time, the CSV is updated to the resulting time, and the status reports "位置調整: N 件".
- A marker whose generated timecode is used as its name because its memo was empty is tracked as `autoName` in the base. Moving it therefore does not turn its old timecode into a memo.
- Atomic writes keep `<file>.bak` until replacement succeeds. If replacement fails, the original remains in `.bak`.
- Re-linking an already linked active target after accepting the warning resets its synchronization history, so the first synchronization after re-linking treats differences as CSV-authoritative.

Premiere Pro marker comments contain `by: <by> [yts:<id>]`. Do not remove the `[yts:id]` tag because it identifies the marker. After Effects stores the ID in the marker's `yts_id` parameter and uses a comment tag as a fallback. The `<CSV name>.yts-sync.json` sidecar stores link and merge state, including base entries shaped as `{ t, memo, autoName }`, and must remain next to the CSV.

Native Twitch markers are green. In Premiere Pro, Scout candidates (see [Scout](#scout候補検知--scout-highlight-candidates)) are yellow. Other marker colors are assigned per recorder (`by`) and cycle in order of first appearance.

The panel uses a copy of `extension/lib.js` at `panel/js/lib.js` (CEP resolves relative paths from the junction, so it cannot reach files outside the panel). `panel\install.ps1` refreshes the copy; re-run it after editing `extension/lib.js`. `node tests/test_lib.js` fails when the copy is stale.

## Cloud service (`service/`)

`service/` is a single Cloudflare Worker deployed to the owner's personal Cloudflare account on the Free plan. The Worker serves the JSON API under `/api/` and the static pages in `service/web/`. D1 stores channels, members, streams, stamps, sessions, and panel tokens; R2 stores one chat JSON file per VOD. Users sign in with Twitch through the same Twitch application (redirect `https://<worker-host>/auth/callback`), and only members of a channel can see its streams. `/` lists the streams of the user's channels and registers a stream from a VOD URL ("VOD から登録"). `/s/<stream_id>` is the stream page: a comment-density graph (15, 30, 60, or 120 second bins, with stamp positions drawn as vertical lines), the "コメント" and "スタンプ" lists side by side at 1100 px and wider (tabs below that), the stamp list's "×" to delete a stamp (shown only to its author, the channel's owners, and site admins; it asks for confirmation and deletes it on the server as a tombstone), "コメントを別ウィンドウで" to detach the comment list to `/s/<stream_id>/comments` (it follows the graph through `BroadcastChannel`), and "ここに印" to add a stamp, recorded as the signed-in user, at the start of the selected bin. "取り込む" (next to "チャット" in the meta line; "再取り込み" once imported) makes the browser fetch the VOD's chat replay directly from Twitch GraphQL and upload it to the Worker once; the Worker stores the body in R2 without parsing it, and importing again overwrites it. Comment times are shifted by the stream's "VOD のずれ" and "反応の遅れ" (default five seconds) settings. `/me` issues panel tokens and `/admin` creates channels and manages members.

The Chrome extension sends stamps to the service when a server URL is set (see [Server sync](#サーバーと同期--server-sync)). The Adobe panel can use a service stream as its sync source through a mirror CSV (see [サーバー / Server](#サーバー--server)); the CSV sync file workflow above is unchanged.

See [`service/README.md`](service/README.md) (Japanese) for setup, local development, tests, and operations. The test fixture `service/test/fixtures/gql_comments_page.json` is a synthetic page in the shape of a real Twitch GraphQL chat replay response; its logins, ids and messages are made up.

## Limitations

- Timestamping is available only while the channel is live.
- Native Twitch markers require the token owner to be the broadcaster or an editor with the required scope.
- Native markers require VOD storage to be enabled and are unavailable on reruns.
- Timestamp accuracy is approximately within a few seconds and depends on playback and network latency.
- Twitch implicit-grant access tokens expire (about four hours). Click "ログイン" again when the extension reports that the login has expired; server uploads wait in the queue until then.
- Records are held in `chrome.storage.local`; export important sessions before clearing extension data or removing the extension.
- The CSV and sidecar must remain writable during panel synchronization.

## Testing

The pure library has no dependencies. Run:

```sh
node tests/test_lib.js
```

`node tests/test_background.js` runs `extension/background.js` on a fake `chrome` and `fetch` (stamping, the upload queue, retries, and server responses), and `node tests/test_popup_markup.js` checks that the popup markup and script stay in step. `node tests/test_web_tokens.js` checks the web colour tokens in `service/web/css/app.css` against the contrast floor in both themes (see [`design.md`](design.md)).

The library tests cover Twitch URL parsing, offset and timecode calculations, clock-skew correction, CSV round trips, ID-based record merging, grouping, and the three-way sync planner. Tests do not modify the sample by default. To regenerate `samples/sample.csv` through `TSLib.toCsv`, run:

```sh
node tests/test_lib.js --write-sample
```

Scout's tests (signal scoring and the API client; no GPU, network, or VOD needed) run with:

```sh
python -m unittest discover -s scout/tests -v
```

## Project layout

- `extension/` — Manifest V3 extension, popup, content UI, service worker, and pure shared library.
- `panel/` — CEP panel for Premiere Pro and After Effects, including host-specific ExtendScript adapters and the development installer.
- `tools/gen_key.js` — ephemeral RSA public-key and extension-ID generator.
- `tests/test_lib.js` — dependency-free Node assertion tests, including sync planner coverage.
- `tests/test_background.js` / `tests/fake_chrome.js` — service worker tests on a fake `chrome` and `fetch`; `tests/test_popup_markup.js` — popup element checks.
- `service/` — Cloudflare Worker (D1 + R2 + static pages) for the cloud service; see `service/README.md`.
- `tests/test_service_web.js` — dependency-free Node tests for the service's page logic (bins, chat shaping, VOD selection).
- `scout/` — Scout, the local highlight-candidate tool: `scout.bat` / `scout.py` (CLI), `audio.py` (download, conversion, Whisper), `signals.py` (scoring), `api.py` (service client), `scout.config.json`, and `tests/`.
- `samples/sample.csv` — example sync-file data including a multiline Japanese memo.
