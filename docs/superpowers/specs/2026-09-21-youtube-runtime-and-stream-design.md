# YouTube: JS runtime for yt-dlp, and Stream mode over DASH — design

Date: 2026-09-21. Requested by Mark ("youtube is blocking using their urls in our app. investigate";
then "fix the download and figure out how to fix stream mode"). Tasks 34 and 35 in
`docs/superpowers/plans/2026-09-10-ozy-v1.md`.

## What broke (verified 2026-09-21 with the bundled yt-dlp 2026.08.19, which is the latest release)

- YouTube's video URLs carry a challenge that must be solved by running JavaScript from the
  player page. yt-dlp now delegates that to an external runtime and auto-detects only Deno. The
  app bundles none, so with the default web client yt-dlp sees storyboards only
  ("Requested format is not available"), and the `android_vr` fallback client returns a 360p URL
  that YouTube refuses with HTTP 403, both to a `<video>` element and to yt-dlp itself. Download
  mode therefore fails too. The warning yt-dlp prints about the missing runtime never reached
  `main.log` because every call passes `--no-warnings`.
- With any supported runtime, the web client lists every DASH format again and the download of
  1080p60 + m4a succeeds. QuickJS-NG 0.17.0 (`qjs-windows-x86_64.exe`, 2.1 MB) was tested end to
  end: detected as `quickjs-ng-0.17.0`, 360p download in 7 s.
- Electron 33's embedded Node is 20.18.3; yt-dlp requires Node ≥ 22, so `ELECTRON_RUN_AS_NODE`
  is not an option until Electron is upgraded.
- Stream mode as built (one combined audio+video URL played by `<video>`) cannot come back:
  the web client no longer offers any format with both audio and video (only DASH video-only,
  DASH audio-only and HLS), and the one combined format `android_vr` still lists (18, 360p) is
  bound to yt-dlp's own request and 403s from anywhere else even with the challenge solved.
- The web client's DASH URLs, once resolved with a runtime, are plain range-fetchable from the
  same IP with no special headers (`curl -r 0-1023` → 206). That is what Task 35 builds on.

## 1. Task 34 — bundle QuickJS-NG, pass it to yt-dlp, make Download the default

**Runtime binary.** `scripts/fetch-ytdlp.js` also downloads QuickJS-NG from
`https://github.com/quickjs-ng/quickjs/releases/download/<tag>/qjs-windows-x86_64.exe` →
`bin/qjs.exe` (Windows) and `qjs-darwin-arm64` / `qjs-darwin-x86_64` → `bin/darwin-<arch>/qjs`
(macOS). The tag is pinned in the script (`QJS_TAG = 'v0.17.0'`) rather than `latest`, so a
build is reproducible; bump by hand. `package.json` `extraResources`: Windows
`bin/qjs.exe → bin/qjs.exe`; mac `bin/darwin-${arch}/qjs → bin/qjs`. `binPath('qjs')` resolves
like ffmpeg (packaged: `resources/bin/qjs[.exe]`; dev: `bin/qjs.exe` or `bin/darwin-<arch>/qjs`
for the build machine's arch).

**Passing it to yt-dlp.** One helper in `lib/webstream.js`:
`WebStream.runtimeArgs(qjsPath)` → `['--js-runtimes', 'quickjs:' + qjsPath]` or `[]` when the
path is empty. Every yt-dlp invocation in `main.js` (resolve-stream, download-video, the playlist
handler, `update-ytdlp`'s post-update check if any) prepends it. `resolveArgs` and `downloadArgs`
gain a `qjs` option so the argument list is built in one place and unit-tested.

**Client order.** With a runtime, the default web client works again and offers the full ladder;
`CLIENTS` becomes `['', 'android_vr', 'ios', 'tv', 'mweb']` unchanged in content but the comment is
rewritten to say why each is there (`android_vr` remains as the fallback that needs no runtime
when the binary is missing).

**Default mode.** `WebStream.DEFAULT_MODE = 'player'` (amended 2026-09-21, Mark: Player, not
Local - nothing may download until the user asks for it). Existing sessions keep whatever mode they
saved, except Stream: `WebStream.mode('stream')` returns `'player'` and the Stream `<option>` is
hidden for YouTube tiles (commented in place, not deleted) until Task 35. Twitch clips have no
embed, so Stream remains their default and stays visible for them.

**Diagnostics.** `--no-warnings` is dropped from resolve and download; stderr is already captured
and only its last lines are shown to the user, so warnings cost nothing in the UI. `logTool` is
called on every failed yt-dlp run (it already is for resolve; add it for download and playlist),
and the start-up header line `tools` gains `qjs ok|missing` (existence check only, like the
others).

**User-visible copy.** When yt-dlp fails and `qjs` is missing (dev tree without prefetch, or a
broken install), the error shown is "YouTube needs the bundled JavaScript runtime (qjs), which
is missing" so nobody debugs yt-dlp for an hour again.

**Tests.** `lib/webstream.test.js`: `runtimeArgs('')` → `[]`; `runtimeArgs('C:\\x\\qjs.exe')` →
the two-element array; `resolveArgs(url, '', { qjs })` and `downloadArgs(..., { qjs })` contain
those two elements before `-f`; `DEFAULT_MODE === 'download'`; `mode('stream')` still allowed.
`scripts/fetch-ytdlp.js` gets no test (network); the workflow run proves it.

**Out of scope.** Electron upgrade; Deno; auto-updating qjs.

## 2. Task 35 (deferred 2026-09-21, Mark) — Stream mode as a DASH player (MediaSource Extensions)

Deferred: Player mode plus timeline sync covers the need; keep this design if Stream is wanted later.

**Purpose.** Play a YouTube video straight from YouTube's servers again, at up to 1080p, without
downloading it first, with seeking and frame stepping working as they do for local files.

**How YouTube itself plays.** Separate video-only and audio-only fragmented MP4 files, each
starting with an init segment (`ftyp` + `moov`) followed by a `sidx` index box listing every
fragment's byte size and duration, then the fragments (`moof` + `mdat`). The URLs accept HTTP
`Range` and are IP-bound, so the renderer can fetch them directly. The `<video>` element is fed
through `MediaSource` with two `SourceBuffer`s.

**Resolve (main).** `resolve-stream` runs yt-dlp `-j` with
`-f 'bestvideo[ext=mp4][vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]'`
(avc1 preferred over av01 so frame-accurate stepping stays cheap). The JSON's
`requested_formats` yields two entries; the reply becomes
`{ ok, video: { url, height, fps, vcodec, filesize }, audio: { url, acodec, filesize }, title, resolvedAt, client }`.
`WebStream.parseResolved` is rewritten for this shape and tested on a saved `-j` fixture
(`test-fixtures/ytdlp/aqz-KE-bpKQ.json`, trimmed to the fields used). Twitch clips keep the old
single-URL path: `parseResolved` returns `{ single: { url, height } }` for them and the renderer
plays `video.src = url` as today.

**CSP.** `connect-src https://*.googlevideo.com` added to `index.html` (currently `'none'`).
`media-src` already allows googlevideo and `blob:` must be added for the MediaSource object URL.

**Pure module `lib/dash.js`** (tested with fixtures cut from real YouTube DASH files, first
64 KB of a 720p avc1 video and of a 140 m4a, checked in under `test-fixtures/dash/`):
- `parseBoxes(buf)` → top-level boxes `[{ type, start, size }]`.
- `parseInit(buf)` → `{ initEnd, sidx: { timescale, earliestPresentationTime, firstOffset, segments: [{ start, end, duration }] } }` with `start`/`end` absolute byte ranges of each fragment. Throws if no `sidx` within the buffer (caller re-fetches a bigger head).
- `segmentAt(sidx, timeSec)` → index of the fragment containing that time.
- `segmentTime(sidx, i)` → `{ start, end }` in seconds.
- `plan(sidx, fromIndex, aheadSec)` → the list of fragment indices to fetch next, coalesced into
  byte ranges no larger than 10 MB (YouTube's `http_chunk_size`).
- `mime(format)` → `video/mp4; codecs="avc1.4d4020"` / `audio/mp4; codecs="mp4a.40.2"` from
  yt-dlp's `vcodec`/`acodec` strings, and `MediaSource.isTypeSupported` is checked by the caller.

**Renderer `DashPlayer` (in `app.js`, web-tile section, ~250 lines).**
`createDashPlayer(video, resolved, { onError })` returns `{ seek(t), destroy(), refresh(resolved) }`.
- Setup: `MediaSource`, `video.src = URL.createObjectURL(ms)`; on `sourceopen` add the two
  SourceBuffers in `'segments'` mode; fetch bytes `0-65535` of each track, `parseInit`, append
  the init range; set `ms.duration` from the sidx.
- Steady state: a single loop per track keeps `[currentTime, currentTime + 30 s]` buffered:
  `plan()` the next ranges, `fetch` with `Range`, `appendBuffer`, wait for `updateend`. Evict
  more than 60 s behind the playhead with `remove()`. All fetches go through one
  `AbortController` per track.
- Seek: on `seeking`, abort in-flight fetches, `abort()` the SourceBuffers, compute
  `segmentAt(t)`, resume the loop from there. The `<video>` handles the rest.
- Expiry / 403: a failed fetch (status ≥ 400 or network error) triggers one re-resolve through
  `resolve-stream` (main drops its cache entry on request: new IPC `forget-stream`), swaps the URLs
  (same format ids, so byte offsets stay valid), and retries the same range once. A second failure
  calls `onError`, which shows the existing `streamBlocked` panel with Local / Player buttons.
- Frame stepping, sync groups, bookmarks, A/B compare all talk to `tile.pb` on the `<video>`
  and need no change; the playback adapter for web tiles already wraps the `<video>`.
- `destroy()` aborts fetches, revokes the object URL, ends the stream.

**UI.** The mode button label shows the resolved height (`labelFor('stream', 1080)` → "1080p").
Stream is no longer the default (Task 34) but remains selectable; the ⚙ popover copy for Stream
becomes "Streams from YouTube, up to 1080p. Needs the connection; use Local for offline."

**Failure handling.** MSE unsupported codec → fall back to a lower avc1 format by re-resolving
with `height<=720`; then to Local. No formats → same as today.

**Tests.** `lib/dash.test.js`: box parsing on both fixtures (box list, init end offset, sidx
segment count and total duration within 0.5 s of the known length), `segmentAt` at 0, mid, end,
beyond end (clamped), `plan` coalescing under the 10 MB cap and never crossing it, `mime` for
avc1 / av01 / mp4a strings. `lib/webstream.test.js`: `parseResolved` on the yt-dlp fixture
returns both tracks; on a Twitch-shaped fixture returns `single`. The player itself is a manual
check (play, scrub, frame step, sync with a local file, leave it 5 h and confirm the re-resolve
path by forcing `forget-stream`).

**Alternative considered and rejected.** A local HTTP proxy in main that runs ffmpeg to remux
the two DASH inputs into one fragmented MP4 for the `<video>`. Simpler in the renderer but
seeking would mean restarting ffmpeg with `-ss` on every scrub, frame stepping backwards would be
slow, and it adds a persistent ffmpeg process per playing tile.

## Release

Task 34 ships as v0.2.0.10 pre-release on its own as soon as it lands, since YouTube is broken
for every user today. Task 35 follows as v0.2.0.11.
