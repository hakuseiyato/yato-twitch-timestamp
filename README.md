# Yato Twitch Timestamp

Yato Twitch Timestamp is a dependency-free Chrome extension for recording useful moments during a Twitch live stream. Broadcasters and editors can create native Twitch stream markers. Moderators without editor permission automatically fall back to local records. Every timestamp is stored locally regardless of whether the native marker succeeds.

Records can be exported as a shared CSV sync file for the included Premiere Pro and After Effects panel. Editors can also merge CSV files received from moderators through the extension popup.

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
2. Enter the server origin in "サーバー URL / Server URL", for example `https://yato-twitch-timestamp.hakuseiyato.workers.dev`, and click "保存". Only `https://host` is accepted (no path, query, or fragment).
3. Click "このサーバーへの送信を許可 / Allow sending to this server" and accept Chrome's prompt. The extension declares the server only as an optional host permission, so Chrome blocks requests to it until you grant it for that origin. Once granted, the popup syncs immediately.
4. Make sure you are logged in. The Worker checks the Twitch token and accepts stamps only for channels where your Twitch login is a member (`/admin`).

Behavior:

- Stamping, editing a memo, importing a CSV, and deleting an individual record each queue the affected record and upload it right away with `POST /api/stamps`. A deleted record is sent as a tombstone (`deleted: true`); the server accepts tombstones only for your own records.
- "配信ごとの削除" (the stream-level "削除" button) is local only. It removes the stream's records from this browser and from the upload queue and sends nothing, so the stream stays on the server.
- Records that could not be sent (offline, server error, expired login) stay in the queue. The extension retries the queue every five minutes and after the next login. "サーバーと同期 / Sync with server" queues every local record, tombstones included, and sends them now.
- The popup shows "未送信 n 件 / pending n", "最終同期 HH:mm（成功 n）/ last sync" with the number of accepted records, and, per record, "送信済 / sent", "未送信 / pending", or "失敗 / failed" next to "ネイティブ" / "ローカル".
- A record the server reports as `stale` is already stored there in the same or a newer version. It counts as sent and is not retried.

Reading failures:

- Records the server rejects one by one appear in the collapsible "失敗 n 件 / failed n" list with the last four characters of the id, the timecode, and the reason. They are not retried automatically; "失敗一覧を消す / Clear failures" empties the list, and "サーバーと同期" sends them again after you fix the cause.
  - "他の人の記録は消せません / cannot delete others' records" (`forbidden_tombstone`): only the author (or a channel owner on the web) can delete a record on the server. It stays deleted locally.
  - "このチャンネルの会員ではありません / not a member of this channel" (`forbidden_channel`): ask a channel owner to add your Twitch login in `/admin`.
  - "記録の形式が不正です / invalid record" (`invalid_*`), "時刻が不正です / invalid time" (`invalid_time`), "配信情報がありません / stream missing" (`missing_stream`): the record itself is broken, typically from an edited CSV.
- Errors that stop the whole upload are shown under the last sync line, and the records stay pending:
  - "サーバーに届きませんでした (http_404) / server unreachable (http_404)" or another `http_<status>`: usually a wrong server URL.
  - "通信できませんでした / network error": offline or the server is down; the five-minute retry sends them later.
  - "サーバーへの送信が許可されていません / sending not allowed yet": grant the host permission (step 3).
  - "ログインが必要です / login required": log in again (see below).
- Twitch login tokens from the implicit grant expire after about four hours. When the server answers 401, or when the extension finds the token expired while stamping, the popup shows "トークンが切れました。再ログインしてください / Token expired. Log in again". Click "ログイン"; the queued records are sent after the login. Stamps keep being saved locally in the meantime.

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

3. Restart Premiere Pro or After Effects, then open **Window > Extensions > Yato Twitch Timestamp**.
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

Native Twitch markers are green. Other marker colors are assigned per recorder (`by`) and cycle in order of first appearance.

The panel uses a copy of `extension/lib.js` at `panel/js/lib.js` (CEP resolves relative paths from the junction, so it cannot reach files outside the panel). `panel\install.ps1` refreshes the copy; re-run it after editing `extension/lib.js`. `node tests/test_lib.js` fails when the copy is stale.

## Cloud service (`service/`)

`service/` is a single Cloudflare Worker deployed to the owner's personal Cloudflare account on the Free plan. The Worker serves the JSON API under `/api/` and the static pages in `service/web/`. D1 stores channels, members, streams, stamps, sessions, and panel tokens; R2 stores one chat JSON file per VOD. Users sign in with Twitch through the same Twitch application (redirect `https://<worker-host>/auth/callback`), and only members of a channel can see its streams. `/` lists the streams of the user's channels and registers a stream from a VOD URL ("VOD から登録"). `/s/<stream_id>` is the stream page: a comment-density graph (15, 30, 60, or 120 second bins, with stamp positions drawn as vertical lines), "コメント" and "スタンプ" tabs, "別ウィンドウ" to detach the comment list to `/s/<stream_id>/comments` (it follows the graph through `BroadcastChannel`), and "ここに印" to add a stamp, recorded as the signed-in user, at the start of the selected bin. "チャットを取り込む" makes the browser fetch the VOD's chat replay directly from Twitch GraphQL and upload it to the Worker once; the Worker stores the body in R2 without parsing it, and importing again overwrites it. Comment times are shifted by the stream's "VOD のずれ" and "反応の遅れ" (default five seconds) settings. `/me` issues panel tokens and `/admin` creates channels and manages members.

The Chrome extension sends stamps to the service when a server URL is set (see [Server sync](#サーバーと同期--server-sync)). The Adobe panel does not talk to the service yet; synchronizing it with the service is planned as a follow-up, and the CSV sync file workflow above is unchanged.

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

`node tests/test_background.js` runs `extension/background.js` on a fake `chrome` and `fetch` (stamping, the upload queue, retries, and server responses), and `node tests/test_popup_markup.js` checks that the popup markup and script stay in step.

The library tests cover Twitch URL parsing, offset and timecode calculations, clock-skew correction, CSV round trips, ID-based record merging, grouping, and the three-way sync planner. Tests do not modify the sample by default. To regenerate `samples/sample.csv` through `TSLib.toCsv`, run:

```sh
node tests/test_lib.js --write-sample
```

## Project layout

- `extension/` — Manifest V3 extension, popup, content UI, service worker, and pure shared library.
- `panel/` — CEP panel for Premiere Pro and After Effects, including host-specific ExtendScript adapters and the development installer.
- `tools/gen_key.js` — ephemeral RSA public-key and extension-ID generator.
- `tests/test_lib.js` — dependency-free Node assertion tests, including sync planner coverage.
- `tests/test_background.js` / `tests/fake_chrome.js` — service worker tests on a fake `chrome` and `fetch`; `tests/test_popup_markup.js` — popup element checks.
- `service/` — Cloudflare Worker (D1 + R2 + static pages) for the cloud service; see `service/README.md`.
- `tests/test_service_web.js` — dependency-free Node tests for the service's page logic (bins, chat shaping, VOD selection).
- `samples/sample.csv` — example sync-file data including a multiline Japanese memo.
