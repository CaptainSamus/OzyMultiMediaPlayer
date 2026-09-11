# Ozy Multi Media Player — v1 design

Date: 2026-09-10. Status: approved by Mark in chat.

## Goal

Refine the existing local Electron multi-video player into a shippable
Windows desktop app for browsing and comparing local videos and renders,
with YouTube and Twitch tiles on the same board. Website, sharing, and
accounts are v2 and are out of scope here.

## What already exists (keep as is)

- Vanilla JS renderer (`app.js`, `index.html`, `style.css`), no build step.
- Gallery layout (rows, shared size) and Board layout (infinite canvas,
  lasso, linked no-overlap, snapping).
- Per-tile hover controls, bookmarks, master volume, per-video shortcuts.
- `.mvp` JSON sessions (format `multi-video-player-session`, version 3).
- Main process (`main.js`) streams files over the `localvideo://` scheme
  with range support and hard-blocks every http/https/ws request.
- Renderer touches disk only through `window.api` (`preload.js`). This
  boundary is what lets a future website reuse the UI with a browser
  bridge; every new disk or network feature goes through it too.

## Offline requirement

The app must work fully offline. Every local feature (file tiles, layouts,
bookmarks, sessions, ffmpeg proxies, frame step, sync, A/B) runs with no
network access at all. Only web tiles need a connection. Their only offline
handling: a YouTube tile that doesn't report ready within 10 s shows a
"Could not load" panel with a Retry button over the video's cached
thumbnail (fetched once when the tile was added, stored with the other
thumbnails), so it still looks like the video it is. Twitch tiles show
a generic icon. Nothing else in the app is affected.

- The app never phones home, checks for updates, or loads any remote
  asset for its own UI. All scripts, styles, fonts, and icons ship in the
  package. The installer must not require a connection to run.
- ffmpeg, ffprobe, and yt-dlp ship inside the installer, never downloaded
  on first run. yt-dlp's self-update runs only when the user clicks it.

## Out of scope for v1

EXR or image sequences (single still images are in, see feature 8),
website hosting, board sharing, accounts, home server or network library,
mood board export. macOS support is v1.1, right after the Windows v1.0
release (plan Task 16): unsigned Mac builds, a dmg installer and a
self-contained zip portable per chip (all dependencies inside the app
bundle, about 200 MB), matching the Windows installer + portable pair; Cmd
modifiers, open-file, and a GitHub Actions workflow that builds Windows
and Mac artifacts for one release. Downloads are per OS; the code and
version are shared.

## Later: auto-update, then installers (v2, Mark 2026-09-10)

Long term the app auto-updates so nobody reinstalls by hand, and only
then do installers (Windows NSIS as primary, Mac .dmg) replace the
portable / zip downloads. Order matters:
1. Apple Developer account, code signing and notarization for the Mac
   build; Windows Authenticode signing is optional but avoids SmartScreen
   warnings. Mac auto-update cannot work on an unsigned app.
2. `electron-updater` pulling from GitHub Releases (`publish` switches
   from `null` to the github provider; the app checks on launch and
   offers "Restart to update"). This is the one place the app phones
   home, so the README must say so and a setting must let it be turned
   off.
3. Installers and portables continue to ship side by side; the
   auto-updater serves the installed builds.

## Features

### 1. Installer and packaging

- Add `electron-builder`. Targets: NSIS installer and portable exe, x64,
  offered as equals (installer adds Start menu, `.mvp` association,
  uninstaller; portable is a single exe with no install).
- Product name "Ozy Multi Media Player", app id `com.ozy.multimediaplayer`.
  App icon: Mark's film-reel / disc artwork, supplied as `build/icon.png`
  (square, 512 px or larger). electron-builder derives the `.ico` from
  it; the window and taskbar use the same image.
- Associate `.mvp` so double-click and "open with" launch the app with the
  session (existing `sessionFileFromArgv` already handles the argv path;
  also handle `second-instance` so a second launch opens in the running
  window).
- `npm run dist` builds; `start.bat` and `npm start` keep working for dev.
- ffmpeg, ffprobe (feature 2) and yt-dlp (feature 7) binaries ship as
  `extraResources` and are resolved from `process.resourcesPath` when
  packaged, from `node_modules` / a `bin/` folder in dev. No
  auto-update artifacts (`publish: null`).

### 2. ffmpeg: probe and "Make playable"

- Bundle `ffmpeg-static` and `ffprobe-static` (or equivalent) binaries.
- **Probe on add.** `window.api.probe(path)` runs ffprobe once per file
  and returns `{ codec, width, height, fps, duration, playable, proxy }`.
  `playable` is decided by a codec allowlist Chromium on Windows handles:
  h264, hevc (hardware, Electron 33+), vp8, vp9, av1, and audio-only
  formats already in the MIME table. Everything else (prores, dnxhd,
  mpeg4, msmpeg4, wmv, etc.) is `false`. Probe results cache in memory
  per session and are stored on the tile (`tile.info`).
- **Make playable.** When `playable` is false, or the `<video>` element
  raises a decode error, the tile's error panel shows a
  **Make playable** button instead of only text. Clicking calls
  `window.api.makeProxy(path)`. Main runs
  `ffmpeg -i in -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -c:a aac -movflags +faststart out.mp4`,
  parses `time=` from stderr for progress, and sends `proxy-progress`
  events. Output lives in
  `app.getPath('userData')/proxies/<sha1(original path + size + mtime)>.mp4`.
  On success the tile swaps its `src` to the proxy and keeps `tile.path`
  as the original. On reopen, `probe` also reports `proxy` if a matching
  cache file exists, so the session loads straight into the proxy.
- Progress shows as a bar in the tile's error panel. Cancel button kills
  the ffmpeg child. Only one transcode runs at a time; others queue.
- A toolbar **Cache** menu item shows cache size and clears it.

### 3. Frame step and timecode

- Frame stepping uses `fps` from the probe; if the probe failed, assume
  24 and mark the readout with `~`.
- Keys while hovering a tile: `,` back one frame, `.` forward one frame.
  Buttons `|<` and `>|` next to the existing −5s/+5s. Stepping pauses the
  video first.
- Step math: `currentTime = (round(currentTime * fps) ± 1 + 0.5) / fps`
  (land on the frame's midpoint so Chromium shows the intended frame).
- The time label cycles on click between `m:ss / m:ss`, `frame / frames`,
  and `HH:MM:SS:FF`. The chosen mode is a per-session preference stored in
  `layout.timeDisplay`.

### 4. Groups, group settings bar, unified timeline, marker colours

**Groups.** Select two or more tiles (lasso or Shift-click on the board;
in the gallery, Shift-click tiles) and press **Group** (`Ctrl+G`).
A group has a name (auto "Group 1", editable), a colour from a palette
of 8, and settings. A tile is in at most one group; grouping selected
tiles that are already in other groups pulls them out of those. Members
show the group colour as a swatch on the title bar. **Ungroup**
(`Ctrl+Shift+G`) dissolves it. Clicking a member selects the whole group
(Ctrl-click selects only that tile; Alt is already pan). Groups exist in both layouts; the
spatial behaviour below only applies on the board.

**Group settings bar.** Appears above the unified timeline whenever a
group is selected. Controls, each applying only to that group:
- **Play / Pause** the group, **Mute** (all members; a member's own mute
  is remembered and restored on unmute), group **Volume** (scales members
  like the master does), **Speed**.
- **Sync** on/off. When on, the group has a shared **group time** `g`
  and each member a `start` (where it sits on the group timeline),
  captured when Sync is switched on so that nothing jumps:
  `start = max(all currentTimes) − member.currentTime`. A member's time
  is `g − start`, clamped to `[0, duration]`; members whose start hasn't
  been reached wait at frame 0. Play, pause, seek (scrub, arrows,
  bookmarks, frame step) and speed on any member apply to all. Drift
  check every 500 ms re-seeks any follower more than 80 ms off. When off, members play independently but still share
  mute, volume, speed, and loop settings.
- **Sticky** on/off (board only). When on, dragging any member moves the
  whole group and lasso treats the group as one; Ctrl-drag moves one
  member. When off, members move independently.
- **Loop** mode:
  - *Off*: each member stops at its end; pressing Play on a group whose
    members have all ended restarts group time from 0.
  - *Shortest*: when group time reaches the earliest `start + duration`,
    every member restarts (group time back to 0).
  - *Longest*: when group time reaches the latest `start + duration`,
    every member restarts. Members that end earlier hold on their last
    frame (paused) until then.
  - *Range*: loops between the In and Out handles on the unified timeline
    (below). Handles default to the group's full extent.
  Loop modes only make sense with Sync on; switching Loop to anything but
  Off turns Sync on, and the bar says so.

**Unified timeline.** A strip docked at the bottom of the window,
shown when a group is selected (or a single tile is selected: then it
shows that tile alone). Two heights, toggled by a grip or `T`:
- *Collapsed*: one bar spanning the group's extent (0 to the latest
  `start + duration`), a shared playhead, the In/Out loop handles, and
  every member's markers drawn on the bar in their colours. Scrubbing the
  bar seeks the group.
- *Expanded*: one lane per member, stacked, each showing the member's
  name, a block covering its extent (from its `start`, length its
  duration) with start and end timecode labels, and its own markers.
  The playhead, scrub, and In/Out handles span all lanes. Clicking a
  marker jumps there; right-click a marker to delete or recolour.
Timeline time display follows `layout.timeDisplay` (feature 3).

**Marker colours.** Bookmarks gain a `color` from the same palette of 8
(default yellow). The bookmark list panel shows a swatch per bookmark;
clicking it cycles the colour. Markers above the tile's scrub bar and on
the unified timeline use that colour.

**Session format** bumps to version 4:
`groups: [{ id, name, color, members: [videoIndex], sync, sticky, loop,
range: { in, out } | null, volume, muted, rate }]`,
`videos[i].sync = { start }` or null, `bookmarks[].color`.
Version 3 files still load (no groups, default colours).

### 5. A/B compare

- With exactly two tiles selected, toolbar **A/B** (key `C`) opens a
  full-window compare view. Both `<video>` elements move into the view
  (they keep playing, no reload) and are wrapped in a temporary group
  with Sync on and the offsets they have at that moment; their real
  group membership is restored on close.
- Modes: **Wipe** (B on top of A, `clip-path: inset(0 0 0 X%)`, drag the
  line, default 50 %) and **Flip** (only one visible; `Tab` toggles).
  Bottom bar: one shared scrub bar, play/pause, frame step, mode buttons,
  time label in the session's display mode, labels "A: name" and
  "B: name".
- Both videos are letterboxed to the same box; if aspects differ, the
  smaller is centred.
- `Esc` or the close button returns the elements to their tiles, drops
  the temporary group, and re-runs layout.

### 5b. Undo (Ctrl+Z)

- `Ctrl+Z` reverts the last of these actions: removing a tile (✕ or
  session clear is excluded), moving tiles on the board (a group or
  lasso drag is one entry), resizing a tile on the board, and resizing
  the gallery (row height). `Ctrl+Shift+Z` redoes.
- History holds at most 10 entries; the oldest drops off. Entries store
  only what they need: for a move or resize, the previous board rects (or
  row height) of the affected tiles; for a removal, the tile's full
  session record (path or url, time, volume, mute, rate, bookmarks,
  board rect, group id and start) so it comes back exactly as it was,
  re-joining its group if that group still exists.
- Opening a session or clearing all resets history. A status message
  names what was undone ("Undo: move 3 videos").

### 6. Web tiles (YouTube, Twitch)

- The existing **+ Add videos** button becomes a small pulldown with two
  choices: **Local files…** (opens the Windows file picker, exactly what
  the button does today) and **YouTube / Twitch URL…** (drops down a URL
  bar with an Add button; Enter adds, Esc closes). `Ctrl+A` still opens
  the local picker directly. Dropping files on the window is unchanged.
- The URL bar accepts, and `lib/weburl.js` parses:
  - YouTube video: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed/`
  - YouTube Shorts: `youtube.com/shorts/<id>` (plays as a normal video
    tile; aspect defaults to 9:16)
  - YouTube playlist: any URL with `list=`, or `youtube.com/playlist?list=`.
    A playlist does **not** become a tile. It is added to the Sources
    sidebar (feature 7), which opens with the playlist expanded so the
    user drags in the videos they want or clicks Add all.
  - Twitch clip: `clips.twitch.tv/<slug>`, `twitch.tv/<channel>/clip/<slug>`
  - Twitch live stream: `twitch.tv/<channel>` (channel embed; shows
    "offline" from Twitch itself if the channel isn't live)
  Anything else is rejected with a status message and the bar stays open.
- A web tile is a `.tile` whose media is an `<iframe>` instead of
  `<video>`. Tiles gain `type: 'file' | 'youtube' | 'twitch'` and
  `kind: 'video' | 'short' | 'clip' | 'stream'`.
  YouTube uses the iframe player with `enablejsapi=1` and the postMessage
  API for play, pause, seek, volume, mute, and rate. Twitch clips and
  streams use the Twitch embed iframe; it exposes no reliable playback
  API from a non-web origin, so Twitch tiles get the title bar, remove,
  move, resize, and nothing else. Streams have no duration, so the seek
  bar is hidden on them.
- Web tiles participate in layout, lasso, linking, snapping, sessions
  (`videos[i].url`, `type`), Play all / Pause all, and master volume
  (YouTube only). They can join groups for Sticky, mute, and volume
  (YouTube only), but not Sync, Loop, the timeline, or A/B in v1.
- **Page origin (spike result, 2026-09-10).** Both YouTube (error 153)
  and Twitch refuse to embed from `file://` or a custom scheme. So main
  serves the UI from a loopback http server: bound to `127.0.0.1`,
  random port, serving only files under the app directory (normalised
  path, nothing outside it, no directory listing), closed on quit. The
  window loads `http://127.0.0.1:<port>/index.html`; `localvideo://`
  keeps streaming local files. Twitch embeds use `parent=127.0.0.1`.
  This works offline. Findings: `docs/superpowers/specs/2026-09-10-twitch-spike.md`.
- Network: the hard block in `main.js` becomes an allowlist (host or any
  subdomain): `youtube.com`, `youtube-nocookie.com`, `ytimg.com`,
  `googlevideo.com`, `google.com`, `gstatic.com`, `googleapis.com`,
  `ggpht.com`, `twitch.tv`, `jtvnw.net`, `ttvnw.net`, `twitchcdn.net`,
  `live-video.net`, plus the exact host `d1ndex63qxojbr.cloudfront.net`
  (Twitch's clip video CDN; exact host rather than all of cloudfront.net,
  update it if Twitch moves). Everything else stays blocked, including ad and
  tracking hosts the embeds try (`amazon-adsystem.com`,
  `iabtechnologylab.com`, `cdndex.io`), which has no visible effect on
  playback. CSP gains `frame-src` for `player.twitch.tv`,
  `clips.twitch.tv`, `www.youtube.com`, `www.youtube-nocookie.com`.
  README's "never touches the network" claim is updated to "only when
  you add a web tile".

### 7. Sources sidebar (folders and playlists)

- A collapsible panel on the left of the grid (toggle button in the
  toolbar and key `\``; width drag-resizable, 220–480 px, remembered).
  Two tabs: **Local** (folders) and **YouTube / Twitch** (playlists);
  the active tab is remembered. An **Add selected** button in the panel
  head adds every highlighted row (across sources and tabs), confirming
  above 30. Each source is a row with
  a name, item count, and a menu (Refresh, Add all, Pin/Unpin, Remove).
  Clicking a source expands it into a scrollable list of items:
  thumbnail, name, duration. Sources and the panel state live in a global
  settings file `app.getPath('userData')/settings.json`, not in the
  session, so favourites show in every session.
- **Right-click on a row.** Local tab: right-click a file row opens a
  small menu with "Show in Explorer" (selects the file in a new Explorer
  window). YouTube / Twitch tab: right-click a playlist row copies the
  video's URL to the clipboard and the status bar says "Copied". The
  same two actions exist on tiles' title bars for file and web tiles.
- **Folders.** Added by the **Add folder…** button (Windows folder picker)
  or automatically as the "Recent" entry whenever the user adds local
  files: the parent folder of the last pick becomes the single Recent
  row (replacing the previous one). **Pin** turns Recent into a
  favourite that stays. Listing is non-recursive: files with a video or
  audio extension from the MIME table, sorted by name. Refresh re-reads
  the folder; there is no file watcher in v1. A folder that no longer
  exists shows greyed with "Missing".
- **Thumbnails.** For local files, main generates one JPEG per file with
  ffmpeg (`-ss 10% of duration` via ffprobe, `-frames:v 1 -vf
  scale=320:-2`) into `userData/thumbs/<same hash as proxies>.jpg`,
  lazily: the renderer asks for a thumbnail only when a row scrolls into
  view (IntersectionObserver), main runs at most two ffmpeg jobs at a
  time, and existing files are served straight from disk. Audio files
  and failures show a generic icon. The Cache button's count and clear
  include the thumbnail folder.
- **Playlists.** Added by pasting a playlist URL into the URL bar
  (feature 6) or via **Add playlist…** in the sidebar. Main runs the
  bundled **yt-dlp** (`yt-dlp --flat-playlist -J <url>`), which returns
  title, id, duration, and thumbnail URL for every entry with no API key
  and no size cap. The list is cached in settings.json and refreshed on
  demand. Thumbnails are YouTube's own `i.ytimg.com` images, loaded by
  the renderer through the network allowlist.
- **yt-dlp lifecycle.** The binary ships in the installer. If it exits
  non-zero with an "unsupported"/"unable to extract" style error, the
  sidebar shows "yt-dlp needs updating" with a button that runs
  `yt-dlp -U` (self-update, network) and a note pointing at the bin
  folder for a manual replacement. If yt-dlp is missing, the Playlists
  section shows one line saying so; everything else works.
- **Getting items onto the board.** Drag one row (or a multi-selection
  made with click, Shift-click, Ctrl-click) from the list and drop on
  the grid: file rows become file tiles, playlist rows become YouTube
  tiles, placed under the cursor on the board or appended in the
  gallery. Double-click a row adds it. **Add all** adds every item in
  the source; above 30 items it asks "Add N videos?" first. Rows already
  on the board show a small dot.
- The pulldown's **YouTube / Twitch URL…** flow is unchanged for single
  videos, Shorts, clips, and streams.

### 8. Image tiles and "Add all + images"

- Still images (`.jpg .jpeg .png .gif .webp .bmp`) can be tiles. An
  image tile shows the picture (`<img>`, `object-fit: contain`) with the
  title bar, remove, move, resize, lasso, Linked and snapping, sessions
  (`type: 'image'`), undo, and group membership for Sticky only. No
  playback controls, no bookmarks, no sync, no timeline, no A/B.
  Aspect comes from the image's natural size.
- Images arrive from the sidebar or from dropping image files on the
  window, and from the Local files… picker (its filter gains an
  "Images" entry). GIFs animate as the browser animates them; nothing
  more.
- Sidebar folder rows list images alongside video and audio, with a
  small "IMG" tag on the row and a thumbnail made by ffmpeg like the
  others. Each folder row has two buttons: **Add all** (video and audio
  only, as before) and **Add all + images** (everything). Both confirm
  above 30 items. Dragging or double-clicking an image row makes an
  image tile.

## Session format v4

```
{ format, version: 4, savedAt, layout: {..., timeDisplay, timelineExpanded}, masterVolume,
  videos: [{ type, kind, path | url, title, currentTime, volume, muted, playbackRate,
             paused, aspect, board, bookmarks: [{ t, label, color }], sync: { start } | null }],
  groups: [{ id, name, color, members: [videoIndex], sync, sticky, loop, range, volume, muted, rate }] }
```

Loading v3 sets `type: 'file'`, `sync: null`, `groups: []`,
`bookmarks[].color: 'yellow'`, `timeDisplay: 'clock'`.

## Error handling

- yt-dlp failure or missing: see feature 7. Playlist listing errors
  never block adding single videos by URL.
- ffprobe or ffmpeg missing: features 2 and 3 degrade (no probe, fps
  assumed 24 with `~`, Make playable button hidden) and a one-time
  status message says the binaries were not found.
- Transcode failure: error text from ffmpeg's last stderr lines in the
  tile panel, button returns to Make playable.
- Web tile fails to load (YouTube): 10 s without the player's `onReady`
  shows "Could not load" + Retry over the cached thumbnail
  (`userData/thumbs/yt-<id>.jpg`, fetched via Electron `net` when the
  tile is first added). Twitch: the embed's own error.

## Testing

No test framework exists and the renderer is DOM-bound. Per feature:

- Unit-testable pure functions (frame step math, group offset and loop
  math, timeline extent math, URL parsing, proxy hash, codec allowlist) go in small modules under `lib/`
  and get tests with Node's built-in `node:test`, run by `npm test`.
- Everything else is verified by running the app (`npm start`) against
  a fixed sample set: one h264 mp4, one hevc mp4, one ProRes mov, one
  mkv, one YouTube video, one playlist, one Twitch clip. The plan lists
  the manual checks per task.
- Offline check, run once per feature and again on the packaged build:
  disable the network adapter, launch the app, and confirm every local
  feature works.

## Build order

1. Installer and packaging
2. ffmpeg probe and Make playable
3. Frame step and timecode
4. Groups and settings bar, then unified timeline and marker colours
5. A/B compare
5b. Undo
6. Web tiles (after the Twitch spike)
7. Sources sidebar: folders and thumbnails, then playlists via yt-dlp
8. Image tiles and Add all + images

Each step is a separate task for the opus window; the sonnet window
commits after each and builds the installer at the end.
