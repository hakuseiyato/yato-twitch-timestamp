# Yato Twitch Timestamp

Yato Twitch Timestamp is a dependency-free Chrome extension for recording useful moments during a Twitch live stream. Broadcasters and editors can create native Twitch stream markers. Moderators without editor permission automatically fall back to local records. Every timestamp is stored locally regardless of whether the native marker succeeds.

Records can be exported as a shared CSV sync file for the included Premiere Pro and After Effects panel. Editors can also merge CSV files received from moderators through the extension popup.

## Setup

1. Register an application at [Twitch Developer Console](https://dev.twitch.tv/console).
2. Set its category to **Other** and its client type to **Public**.
3. Add this OAuth Redirect URL:

   ```text
   https://nkebinaanllmgbkpehnlcaomjcofdnng.chromiumapp.org/
   ```

   The popup also shows the exact redirect URL. Register it in the Twitch developer console before logging in.

4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `extension/` directory.
5. Open the extension popup, paste the Twitch Client ID, and click "保存".
6. Click "ログイン" and authorize the `channel:manage:broadcast` scope.

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

The popup groups non-deleted records by stream and shows whether each one is "ネイティブ" or "ローカル". A whole stream or an individual record can be deleted locally from this view. CSV export also includes tombstones so deletions continue to propagate through a shared sync file.

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

## Limitations

- Timestamping is available only while the channel is live.
- Native Twitch markers require the token owner to be the broadcaster or an editor with the required scope.
- Native markers require VOD storage to be enabled and are unavailable on reruns.
- Timestamp accuracy is approximately within a few seconds and depends on playback and network latency.
- Twitch implicit-grant access tokens expire. Click "ログイン" again when the extension reports that the login has expired.
- Records are held in `chrome.storage.local`; export important sessions before clearing extension data or removing the extension.
- The CSV and sidecar must remain writable during panel synchronization.

## Testing

The pure library has no dependencies. Run:

```sh
node tests/test_lib.js
```

The tests cover Twitch URL parsing, offset and timecode calculations, clock-skew correction, CSV round trips, ID-based record merging, grouping, and the three-way sync planner. Tests do not modify the sample by default. To regenerate `samples/sample.csv` through `TSLib.toCsv`, run:

```sh
node tests/test_lib.js --write-sample
```

## Project layout

- `extension/` — Manifest V3 extension, popup, content UI, service worker, and pure shared library.
- `panel/` — CEP panel for Premiere Pro and After Effects, including host-specific ExtendScript adapters and the development installer.
- `tools/gen_key.js` — ephemeral RSA public-key and extension-ID generator.
- `tests/test_lib.js` — dependency-free Node assertion tests, including sync planner coverage.
- `samples/sample.csv` — example sync-file data including a multiline Japanese memo.
