# Architecture

## Project overview

Yato Twitch Timestamp is a Manifest V3 Chrome extension for recording useful moments during Twitch live streams. Broadcasters and editors can create native Twitch markers, while moderators without permission fall back to local records through the same action. Every record is stored locally and can be exported as a CSV sync file shared with one CEP panel that supports both Premiere Pro and After Effects.

`service/` adds a cloud side: one Cloudflare Worker that stores streams, stamps, and members in D1, stores each VOD's chat replay in R2, and serves web pages with a comment-density graph per stream. The extension sends its stamps to the Worker when a server URL is set; the panel does not call the service yet.

## Technology stack

- JavaScript for Chrome Extension Manifest V3, the Adobe CEP panel, and Node.js tests and tools
- HTML and CSS
- Adobe ExtendScript ES3 host adapters
- Twitch Helix API and Twitch OAuth implicit grant
- `chrome.identity`, `chrome.storage.local`, `chrome.storage.session`, and `chrome.commands`
- CEP `CSInterface` and Node-enabled panel APIs for host bridging and atomic file updates
- `service/`: TypeScript on Cloudflare Workers (Free plan), with Workers Static Assets for the pages
- `service/`: Cloudflare D1 (SQLite) for channels, members, streams, stamps, sessions, panel tokens, and the Twitch token-validation cache
- `service/`: Cloudflare R2 for chat replay JSON
- `service/`: `wrangler` for local development, migrations, and deployment
- `service/`: `vitest` with `@cloudflare/vitest-plugin` for Worker tests in workerd, and `tsc` for type checking
- `service/web/`: plain HTML, CSS, and JavaScript with `<canvas>` for the graph; Twitch GraphQL (unofficial) for chat replay and Helix `GET /videos` for VOD registration

The extension and the panel have no external libraries, package manager, or build step. `service/` uses npm for development dependencies only (`wrangler`, `typescript`, `vitest`, `@cloudflare/vitest-plugin`, `@cloudflare/workers-types`); its runtime dependencies are empty.

## Dependencies

- Chrome or another Chromium-based browser
- A Twitch Developer Application Client ID
- Node.js only for tests and public-key generation
- Adobe Premiere Pro 22+ when synchronizing Premiere sequences
- Adobe After Effects 22+ when synchronizing compositions
- Node.js 20+, npm, and a Cloudflare account when developing or deploying `service/`

## Project structure

- `extension/manifest.json`: extension permissions, service worker, content script, popup, and keyboard shortcuts
- `extension/lib.js`: pure functions for URL validation, timing, record normalization, CSV conversion, ID-based merging, grouping, and sync planning
- `extension/background.js`: OAuth, Twitch API access, local and session storage, record creation, the server upload queue, and message handling
- `extension/content.js` / `extension/content.css`: recording panel and toast messages on Twitch pages
- `extension/popup.js` / `extension/popup.html` / `extension/popup.css`: settings (including the server URL and host permission), authentication, server sync status and failure list, listing, deletion, CSV import, and CSV export UI
- `panel/CSXS/manifest.xml`: CEP extension identity and Premiere Pro / After Effects 22+ host requirements
- `panel/.debug`: local CEP debugging ports for Premiere Pro and After Effects
- `panel/install.ps1`: junction-based development installer, PlayerDebugMode setup, and optional shared-library copy
- `panel/html/index.html`: shared compact Japanese synchronization UI
- `panel/css/styles.css`: Adobe-style dark panel theme and operation status colors
- `panel/js/main.js`: host detection, CSV and sidecar I/O, stream and link state, one-click synchronization and confirmation-drawer orchestration, marker-list editing, thumbnail memory/disk caching, payload construction, and the `evalScript` bridge
- `panel/js/libs/CSInterface.js`: Adobe CEP bridge library, stored verbatim
- `panel/jsx/ppro.jsx`: Premiere Pro sequence, marker, and target adapter
- `panel/jsx/aeft.jsx`: After Effects composition, marker, and target adapter
- `tools/gen_key.js`: Manifest public-key, fixed extension-ID, and redirect-URL generator
- `tests/test_lib.js`: dependency-free unit tests for `extension/lib.js`, including the sync planner
- `samples/sample.csv`: sample sharing and synchronization format
- `service/wrangler.jsonc`: Worker name, Static Assets (`web/`, Worker runs first), D1 binding `DB` (`yts`), R2 binding `CHAT` (`yts-chat`), and `vars.TWITCH_CLIENT_ID`
- `service/migrations/0001_init.sql`: D1 schema (seven tables; stamps keyed by `(stream_id, id)`)
- `service/src/index.ts`: Worker entry; sends `/api/` and `/auth/` to the router and everything else to Static Assets, mapping `/s/<id>` and `/s/<id>/comments` to `s.html` and `comments.html`
- `service/src/router.ts` / `service/src/http.ts`: method-and-path router, and JSON response and request-body helpers
- `service/src/auth.ts`: session cookie, `ytt_` panel tokens, Twitch token validation with a one-hour cache, and the auth and token routes
- `service/src/access.ts`: site admin (`BOOTSTRAP_LOGIN`) and per-channel `owner` / `editor` checks
- `service/src/members.ts`: channel creation and member management routes
- `service/src/streams.ts`: stream registration, listing, reading, and settings updates
- `service/src/stamps.ts`: stamp upsert (later `updated_at` wins, tombstones only by the author or an owner) and stamp listing
- `service/src/chat.ts`: streams the uploaded chat JSON into R2 without parsing it and serves it back
- `service/web/`: pages `index.html` (stream list), `auth/callback.html`, `s.html` (stream page), `comments.html` (detached comment list), `me.html`, `admin.html`, and `css/app.css`
- `service/web/js/`: `api.js` (API calls and sign-in), `chat-fetch.js` (Twitch GraphQL chat fetch and shaping), `bins.js` (binning and time shift), `graph.js` (canvas graph), page scripts, and `lib.js` (copy of `panel/js/lib.js` made by `npm run build:web`)
- `service/test/`: Worker tests run by `npm test`; `fixtures/gql_comments_page.json` is a synthetic chat page in the shape of a real Twitch GraphQL response
- `tests/test_service_web.js`: dependency-free Node tests for the pure logic in `service/web/js`

The former standalone After Effects CSV importer is removed. Both Adobe hosts now use the same panel, sync file, and synchronization model.

## Record and CSV model

Each record has a stable `id`. New IDs consist of `y` followed by seven hexadecimal digits; the nonnumeric prefix prevents Excel from converting them to numbers. Existing eight-character hexadecimal IDs remain valid. Legacy records or CSV rows without a valid ID receive a deterministic, `y`-prefixed FNV-1a ID derived from their record key. An older eight-character hexadecimal ID that Excel shortened to one through seven hexadecimal digits by removing leading zeroes is repaired by zero-padding. Within one file, the first occurrence of a duplicate ID keeps it and later occurrences receive new IDs.

CSV files use UTF-8 with a BOM, RFC 4180 quoting, and CRLF line endings. Columns are:

`id,timecode,offset_sec,by,memo,native,channel,stream_id,started_at,created_at,updated_at,deleted,clock_skew_ms`

Records merge by `id`; the later `updated_at` wins. When an edited `timecode` in `h:mm:ss`, `hh:mm:ss`, or `mm:ss` form differs from `offset_sec`, the panel treats the timecode as authoritative and converts it to integer seconds. Any ID or timecode repair marks the file for rewrite on the next sync. Panel parsing treats an unreadable `offset_sec` as a blocking error and reports its CSV line number; popup import instead skips such rows and reports their count. A `stream_id` that resembles an Excel conversion, including scientific notation or a value containing `.`, produces a warning. Extra columns are discarded whenever the panel serializes the CSV.

Tombstones remain in storage and CSV sync files so deletion can propagate. `groupByStream` exposes `records` for non-deleted UI rows and counts, and `allRecords` for complete CSV export.

## Extension data flow

The content script or keyboard shortcut sends a recording request to the service worker. The service worker validates the token, retrieves the live stream for the target channel, and attempts to create a Twitch marker. It stores the same record format in `chrome.storage.local` regardless of the native marker result. HTTP 401 and 403 responses are treated as the normal moderator fallback. The last stream information and Twitch clock-skew estimate are cached in `chrome.storage.session` for temporary API failures.

Storage read-modify-write operations are serialized through a Promise chain so rapid recordings do not overwrite one another. The popup groups non-deleted stored records by stream. CSV export uses the corresponding complete group, including tombstones. Deleting an individual record in the popup writes a tombstone; deleting a whole stream is a local hard delete that is never sent to the server.

### Extension to Worker

When `settings.serverUrl` is set, the extension also uploads records to the Worker:

1. Every change to a record (stamp, memo edit, CSV import, individual deletion) adds its `id` to `pending` in `chrome.storage.local` inside the same serialized storage step that saves the record, then starts an upload without waiting for it.
2. `uploadPending` runs uploads one at a time on its own Promise chain, so saving records never waits on the network and the same id is not sent twice concurrently. It sends nothing without a server URL, without a token (`login_required`), or without the optional host permission for `<serverUrl>/*` (`permission_required`); the popup requests that permission because it needs a user gesture.
3. `planUpload` groups pending records by `stream_id` into batches of at most 500, and each batch is sent as `POST <serverUrl>/api/stamps` with `{records, source: 'extension'}` and `Authorization: Bearer <Twitch token>`.
4. On 200, `accepted` ids and `rejected` ids with reason `stale` leave `pending` and any old failure entry and are added to `synced`. Other rejections move to `failed` as `{id, reason, at}`; retrying cannot fix them. A record edited while its batch was in flight stays pending and is sent again.
5. A network error (`network`), 408, 429, or 5xx (the server's `error` code or `http_<status>`) stops the run and keeps the rest pending. 401 also stops it and sets `auth.expired`, but only if the token used for the request is still the stored one (a login during the request is not marked expired). Any other 4xx (404, 403, 413, ...) stops the run, keeps that batch and the rest pending, and records the server's `error` code or `http_<status>`; per-record failures come only from `rejected` on 200.
6. Each run that sent something, or stopped before sending, writes `lastSync` (`at`, `accepted`, `failedCount`, `error`). An idle run with nothing pending keeps the previous `lastSync`.

`synced` holds the ids the current server has taken. Saving a different `serverUrl` empties `synced` and `failed`, puts every record id (tombstones included) in `pending`, and starts an upload. A `chrome.alarms` alarm (`yts-flush`, every five minutes) retries the queue, and a successful login starts an upload. "サーバーと同期" queues every local record, tombstones included, before uploading. The popup reads `pending`, `failed`, `synced`, `lastSync`, `serverPermission`, and `auth.expired` through `getState`, shows the per-record state (`failed` > `pending` > `sent` > `unsent`) with `recordSyncState`, maps reason codes to text with `reasonText`, and clears the failure list with `clearFailed`.

## Panel and host API

The panel detects its Adobe host, loads the matching JSX file with `$.evalFile`, and communicates through `CSInterface.evalScript`. Both host adapters expose:

- `ytsPing`: verifies that the host adapter is loaded
- `ytsTargetInfo`: identifies the active or linked sequence/composition
- `ytsListMarkers`: returns the app-side marker state
- `ytsMarkerDetails`: returns details used by the always-visible marker list after verifying the required `targetId`
- `ytsSeek`: moves the playhead to a marker time after verifying the required `targetId`
- `ytsEditMarker`: immediately edits a marker after verifying the required `targetId`
- `ytsDeleteMarker`: immediately deletes a marker after verifying the required `targetId`
- `ytsAddMarker`: immediately adds a marker at the playhead after verifying the required `targetId`
- `ytsApply`: applies the selected synchronization operations

Both hosts link the currently active target: the active sequence in Premiere Pro and the active composition in After Effects. The panel never creates a sequence. If neither is available, it reports "シーケンス（コンポ）を開いてください". An already linked target is presented as "再紐付け"; accepting "紐付けし直すと同期の履歴が消えます。続けますか？" clears the previous synchronization base. App time is calculated as CSV `offset_sec` plus the target offset. Changing a linked target's offset shifts its synchronized markers on the next run.

Marker-list APIs require `targetId` and reject the operation with "対象が切り替わりました。↻ で更新してください" if the active target has changed. Name editing supports Enter to confirm, Shift+Enter for a line break, Esc to cancel, and IME-safe confirmation. Premiere comments are split and rebuilt with the same logic as `TSLib.splitPremiereComment` and `buildPremiereComment`, preserving the trailing `by: X [yts:id]`. Deletion requires a second press between 300 milliseconds and three seconds after the first. Addition uses the playhead and advances one frame when another marker already occupies the time. These edits reach the host immediately and are propagated to CSV by the next synchronization.

The marker list thumbnails are rendered by seeking a source video in the panel's `<video>` element. Lookup proceeds through memory, the `USER_DATA/YatoTwitchTimestamp/thumbs` disk cache, and video decoding. Disk keys use FNV-1a, writes use temporary-file replacement, and failed thumbnails are suppressed for the remainder of the current panel session.

`ytsApply` returns `{ applied, failed, nudged }`. Update and delete operations locate a marker using its ID together with the time observed when the differences were calculated, with half-frame tolerance. Tag operations locate an untagged marker using its list index together with its calculated-state time.

Premiere marker comments contain `by: <by> [yts:<id>]`; the tag is the stable marker identity. Updates replace only the tag and preserve duration, color, and all other comment text. Creation adds `by:`. After Effects stores the ID in the marker parameter `yts_id`, with a comment tag fallback, and preserves duration, label, chapter, URL, frame target, cue point name and type, and existing parameters during updates. Because After Effects cannot store two markers at the same time, a colliding create or update advances one frame at a time until it finds an open time. The adjusted time is propagated back to the CSV and reported as "位置調整: N 件". Native records use green markers, while local records receive deterministic per-recorder colors.

Markers with unreadable host times are omitted from synchronization, reported as "時刻を読めないマーカーがあります", and never interpreted as app-side deletions. A tagged marker whose ID belongs to another stream, as can happen when a sequence is duplicated from another stream, or whose ID duplicates another marker is assigned a new tag rather than being allowed to rewrite the existing row.

## Sidecar state

Each sync file has a sibling `<CSV name>.yts-sync.json` sidecar. State is keyed by `host|projectPath|targetId` and stores:

- the selected stream
- the target offset
- the last successful synchronization time
- a base snapshot of each marker used for three-way comparison, with entries shaped as `{ t, memo, autoName }`

`autoName` identifies a marker whose generated timecode is used as its name because the memo was empty. This prevents moving the marker from turning the old generated timecode into a memo. Creating the same target entry again is a re-link operation that clears its synchronization history; the next sync therefore treats differences as CSV-authoritative.

The sidecar must stay next to the CSV. CSV and sidecar writes use a temporary file followed by replacement, and the CSV is written as UTF-8 with a BOM. Atomic replacement retains `<file>.bak` until replacement succeeds; if replacement fails, the original remains recoverable in `.bak`. After execution, the base is reconstructed from the markers actually present in the app. Failed operations are excluded so they are retried on the next sync, and records proposed for untagged markers are not written when the corresponding tag operation fails.

## Synchronization algorithm

For every marker `id`, `TSLib.syncPlan` performs a three-way comparison between the current CSV record, the current app marker, and the sidecar base snapshot.

- If only the CSV changed, the CSV operation is applied to the app.
- If only the app changed, the app value is written to the CSV.
- If neither side changed, no operation is needed.
- If both sides changed to equivalent values, the state is accepted without a conflict.
- If both sides changed differently, the confirmation drawer reports "競合" and defaults to the app; the user may select the CSV for that row.
- For a linked target with no base snapshot, differences default to the CSV side.
- A missing CSV row or `deleted=true` is a deletion request for the app marker.
- A marker removed in the app produces a `deleted=true` CSV tombstone so other targets can remove it.
- Untagged markers created by hand can be added to the CSV as new records and tagged with an ID when "タグのないマーカーも CSV に追加" is enabled. It is enabled by default.
- Marker time comparisons use a half-frame tolerance to avoid false moves caused by host time quantization.

If no CSV rows exist for the linked stream, synchronization stops with "この配信の行が CSV に見つかりません（stream_id が Excel で変換された可能性があります）". If parsing finds unreadable offsets, synchronization stops with a line-number report such as "読めない行があります: 5, 9 行目（offset_sec / timecode を確認してください）".

Move, memo edit, addition, and deletion are supported in both directions. Clicking "同期" calculates a plan and passes it to `TSLib.syncConfirmReasons`. The confirmation drawer opens only for a calculation error, `needsConfirm` mass deletion, a conflict, a first synchronization without `lastSyncAt`, a tag operation, at least ten additions to the app, or a CSV parsing, calculation, or ID-repair warning. Otherwise the plan executes immediately. The drawer contains the difference list, conflict selections, mass-deletion confirmation, "未タグのマーカーも CSV に追加", and "この内容で同期". The calculated state records the CSV content, active target identity, and complete marker listing. Execution performs these safety checks:

- It reloads the CSV before applying and uses `mergeFresh` to merge concurrent non-conflicting changes by ID. If the confirmed CSV has changed incompatibly, execution aborts with "確認後に CSV が更新されました。同期を押し直してください". Content is compared directly because file modification times can have only one-second resolution.
- It confirms the linked target again and aborts with "紐付け先が変わりました。同期を押し直してください" if it changed.
- It lists markers again and uses `sameMarkers` to compare them with the calculated state. Any difference, including a marker deleted after calculation, aborts with "確認後にマーカーが変更されました。同期を押し直してください".
- It reloads the CSV immediately before the atomic write. A collision at this point reports "確認後に CSV が更新されました。同期を押し直してください（アプリ側の変更は適用済みです）".
- During immediate one-click synchronization, an interruption before app changes causes one automatic recalculation and retry. If the second attempt also stops, the confirmation drawer opens. When execution from the drawer is interrupted, the plan is recalculated and the drawer is refreshed.
- When a plan would delete at least three markers or rows and at least half of the previously synchronized markers, "この内容で同期" remains disabled until the red "大量削除を確認しました" checkbox is selected. This guards cases such as replacing the shared CSV with a fresh extension export that omits rows added in an Adobe app.

After host application, `applyNudges` updates records with any After Effects collision adjustments, `finalizeRecords` filters or finalizes CSV changes based on operation results, and `baseFromMarkers` rebuilds the sidecar base from a fresh marker listing. Together with `mergeFresh` and `sameMarkers`, these helpers are implemented in `extension/lib.js` and shared by the panel. The result preserves concurrent edits, retries failed operations on later syncs, and never commits a proposed row for an untagged marker whose tag operation failed.

## Service data flow

The browser signs in through the Twitch implicit grant, returns to `/auth/callback`, and posts the token to `POST /api/auth/session`; the Worker validates it with Twitch and issues its own 30-day session cookie without storing the Twitch token. For "チャットを取り込む", the stream page fetches the VOD's chat replay page by page directly from Twitch GraphQL, shapes it into `[offset_sec, login, display_name, text]` rows, and sends the whole JSON once with `PUT /api/streams/<id>/chat`. The Worker streams the body into R2 at `chat/<channel>/<vod_id>.json` and updates the stream row in D1. The page then reads the JSON back with `GET /api/streams/<id>/chat` and bins it in the browser; comment times are shifted by `vod_offset_sec - chat_lag_sec`. Stamps, including "ここに印" from the stream page, go to D1 through `POST /api/stamps` with the same columns as the CSV sync file; the later `updated_at` wins and deletions are `deleted=1` tombstones. The Worker never parses chat JSON, which keeps each request within the Free plan's CPU limit.

## Running the project

1. The Manifest `key` is already configured for extension ID `nkebinaanllmgbkpehnlcaomjcofdnng`.
2. Register `https://nkebinaanllmgbkpehnlcaomjcofdnng.chromiumapp.org/` as the redirect URL in Twitch Developer Console.
3. Load `extension/` as an unpacked extension from `chrome://extensions`.
4. Log in from the popup (the Client ID is prefilled). To send stamps to the service, also save the server URL and grant the host permission.
5. Install the Adobe panel with `powershell -ExecutionPolicy Bypass -File panel\install.ps1`, restart the target app, and open **Window > Extensions > Yato Twitch Timestamp**.

The installer copies `extension/lib.js` to `panel/js/lib.js` on every run (the panel loads the copy); the test suite checks that the copy is current.

Run tests with `node tests/test_lib.js`, `node tests/test_background.js`, `node tests/test_popup_markup.js`, and `node tests/test_service_web.js`.

For `service/` setup, local development, tests, and deployment, see `service/README.md`.
