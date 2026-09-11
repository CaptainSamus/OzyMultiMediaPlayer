# Ozy Multi Media Player

A desktop app that plays many videos at once (20+ if your GPU can decode
them), with a hover-to-reveal control bar on every video and savable
sessions that remember each video's position. Built for comparing renders
and edits: frame stepping, synced groups, a shared timeline, and A/B wipes,
next to YouTube and Twitch tiles on the same board.

Fully local for your own files: nothing leaves your machine. The only network
use is the YouTube and Twitch tiles you add yourself, and the app keeps
working offline without them.

## Downloads

Every release on the [Releases page](https://github.com/CaptainSamus/OzyMultiMediaPlayer/releases)
has an installer and a portable version for each system. All of them are
self-contained: ffmpeg, ffprobe and yt-dlp are bundled inside, so nothing is
downloaded on first run.

| System | Installer | Portable (nothing to install) |
|---|---|---|
| Windows | `Ozy Multi Media Player Setup <version>.exe`: Start menu entry, double-click `.mvp` files to open them, uninstaller | `OzyMultiMediaPlayer-<version>-portable.exe`: a single exe, run it from anywhere |
| Mac, Apple Silicon (M1 and later) | `OzyMultiMediaPlayer-<version>-mac-arm64.dmg`: open it and drag the app to Applications | `OzyMultiMediaPlayer-<version>-mac-arm64.zip`: unzip anywhere and double-click |
| Mac, Intel | `OzyMultiMediaPlayer-<version>-mac-x64.dmg` | `OzyMultiMediaPlayer-<version>-mac-x64.zip` |

**Mac:** the app isn't signed with an Apple developer certificate yet. The
first time you open it (from the dmg or the zip), right-click the app and
choose **Open**, then **Open** again, or run
`xattr -dr com.apple.quarantine "/path/to/Ozy Multi Media Player.app"`.
After that it opens normally.

The window title shows which version you're running (e.g. `Ozy Multi Media Player 0.2.0.3`; `-dev` when run from source).

With the portable versions, open a saved session by dragging the `.mvp` onto
the window, with **Open session**, or by passing it on the command line
(`OzyMultiMediaPlayer-<version>-portable.exe "C:\path\to\session.mvp"`).
The installers also let you double-click `.mvp` files in Explorer / Finder.

## Build from source (Windows)

1. Install Node.js (LTS) from https://nodejs.org.
2. In this folder run:

```
npm install
npm start          # run it
npm test           # unit tests
npm run dist       # build the installer and portable exe into dist\
```

`npm install` downloads Electron, electron-builder and the ffmpeg/ffprobe
binaries once into `node_modules/`. `npm run dist` (or `npm run prefetch`)
downloads `yt-dlp.exe` once into `bin/` for packaging. Releases are built by
GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is pushed:
Windows and macOS, all attached to one release. You can also
double-click `start.bat`, or open a session straight away with
`npm start -- "C:\path\to\session.mvp"` / by dragging a `.mvp` onto
`open-session.bat`.

## Run from source on Mac

The Mac downloads above are the easy way. To run from source instead:

```
git clone https://github.com/CaptainSamus/OzyMultiMediaPlayer.git
cd OzyMultiMediaPlayer
npm install
npm start
```

Node.js LTS is required. Run `npm run prefetch` once to fetch the Mac
yt-dlp (for sidebar playlists) into `bin/`. On a Mac, `Cmd` takes the place
of `Ctrl` in the shortcuts and clicks below, and "Show in Explorer" is
**Reveal in Finder**.

## Network use

The app loads its own UI from a local-only server on `127.0.0.1` and cancels
every other network request in `main.js` unless it goes to YouTube or Twitch:
`youtube.com`, `youtube-nocookie.com`, `ytimg.com`, `googlevideo.com`,
`google.com`, `gstatic.com`, `googleapis.com`, `ggpht.com`, `twitch.tv`,
`jtvnw.net`, `ttvnw.net`, `twitchcdn.net`, `live-video.net`, and
`d1ndex63qxojbr.cloudfront.net` (Twitch clip files). That only happens when
you add a web tile. Listing a YouTube playlist runs the bundled **yt-dlp** as
its own process; it talks to YouTube directly (outside the app's allowlist)
and nothing else. The app never checks for updates; yt-dlp only updates
itself when you click **Update yt-dlp** in the sidebar.

## Using it

- **+ Add videos ▾** has two choices. **Local files…** (`Ctrl+A` in the
  Gallery) opens the file picker (videos, audio and images); you can also
  drag files onto the window. **YouTube / Twitch URL…** opens a URL bar that
  accepts YouTube videos (`watch?v=`, `youtu.be/`, `embed/`), Shorts (tall
  tiles), playlists (they open in the sidebar), Twitch clips and Twitch
  channels. Nothing autoplays; hit **Play all** or press **Space**.
- **Hover a tile** to get its own controls: scrub bar, play/pause, frame
  step `|◀` `▶|`, −5 s / +5 s (Shift for 30 s), time, bookmarks, mute,
  **🔁 loop** (`L`; repeats that video on its own, and is ignored while the
  tile is in a synced group, where the group's Loop setting rules), and
  speed. Move the mouse to the **right side** of the picture and a big white
  volume bar appears: click or drag anywhere on it (mouse wheel works too).
  Click the picture to play/pause it. Every tile's title bar has **✕**
  (remove) on the left and **⛶** (fullscreen) on the right; double-clicking
  a video or picture also goes fullscreen, as does `F` with one tile
  selected, and `Esc`, `F` or ⛶ again comes back.
  On the board the controls stay the same size on screen at any zoom.
- **Make playable.** Files the built-in decoders can't play show a button
  that makes an H.264 copy with the bundled ffmpeg (see Formats).
- **Frame step and time.** `,` and `.` step one frame back / forward (the
  video pauses first). Click the time label to switch between clock,
  frame count, and `HH:MM:SS:FF` timecode; the choice is saved per session.
  If a file reports the wrong frame rate, **⚙** on its control row sets
  one for frame step and timecode (playback speed is untouched).
- **Bookmarks.** `🔖+` (or `B` while hovering) drops a bookmark at the
  current time; they show as pins above the scrub bar. Click a pin to jump,
  right-click to delete, Shift-right-click to change its colour. The `🔖 n`
  list lets you name, recolour (click the dot), jump to, or delete each one.
  `[` and `]` jump to the previous / next bookmark. YouTube tiles have
  bookmarks too (their pins appear once the video has started playing,
  since YouTube only reports its length then).
- **Groups.** Select two or more tiles (lasso or Shift-click) and press
  **Group** (`Ctrl+G`); **Ungroup** is `Ctrl+Shift+G`. A group gets a name,
  a colour dot on each member, and a settings bar at the bottom: play/pause,
  mute, volume and speed for the whole group, plus
  - **⛓ Sync**: members share one timeline, so play, pause, scrub, frame
    step and speed on any member apply to all, keeping their offsets.
    YouTube members sync too, to within about ¼ s (not frame-exact).
  - **📌 Sticky** (board): dragging one member moves the whole group;
    `Ctrl`-drag moves just one.
  - **Loop**: off, when the shortest ends, when the longest ends, or a
    timeline range.
  Clicking a member selects its group; `Ctrl`-click selects just that tile.
- **Timeline.** A strip at the bottom is always there while any local or
  YouTube video is open (Twitch tiles and pictures never appear on it).
  It follows the selected group, else the selected videos ("N selected"),
  else **All videos**, and shows the shared playhead and
  every bookmark. With one video its markers keep their bookmark colours;
  with several, each video has its own colour (shown in the legend and on
  its lane). Scrub it, click a marker to jump, `I` / `O` set the loop In /
  Out at the playhead, or drag the blue handles. Drag the bar's top edge up
  to expand it to one lane per video (keep dragging to make it taller) and
  down to collapse it; `T` or the grip toggles it.
- **A/B compare.** Select exactly two videos and press `C` (or **A/B**).
  Both fill the window, synced: drag the white line to wipe between them, or
  pick **Flip** and press `Tab` to swap. `Space`, `,` `.` work as usual;
  `Esc` returns them to their tiles.
- **Undo.** `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) undo and redo removing,
  moving and resizing tiles, 10 steps back.
- **Sources sidebar** (`` ` `` or **☰ Sources**), with two tabs:
  - **Local**: **+ Folder** adds a folder; adding files from another folder
    makes a *Recent* row you can pin with **⋯**. Rows show thumbnails;
    pictures are tagged IMG. **Add all** adds a folder's videos, **+ images**
    adds everything including pictures.
  - **YouTube / Twitch**: **+ Playlist** (or pasting a playlist URL) lists
    every video with the bundled yt-dlp; the list is kept, so it shows next
    time without re-reading. If YouTube changes and yt-dlp stops working, an
    **Update yt-dlp** button appears.
  Drag rows onto the grid (they land under the cursor on the board),
  double-click a row, or Ctrl-click several (across folders and tabs) and
  press **Add selected** / `Enter`. Rows already on the board show a dot.
  Right-click a local row (or a tile's name) → **Show in Explorer**;
  right-click a YouTube / Twitch row (or web tile's name) to copy its URL.
  The sidebar is resizable and remembers its folders, playlists, width and
  tab in every session.
- **Image tiles.** jpg, png, gif, webp and bmp become picture tiles: title
  bar, move, resize, groups and sessions, no playback controls.
- **Image sequences and EXR.** A run of numbered frames
  (`shot.0001.exr`, `plate_0001.png`, … in exr, png, tif, jpg, webp or
  dpx) plays like a video in a Nuke-style frame player: it is never turned
  into a movie. The sidebar shows each run as one **SEQ** row
  (`shot.[0001-0240].exr · 240 fr`, with a thumbnail from the middle
  frame); drag it, double-click it or use Add all. Picking or dropping one
  frame asks whether to add the whole sequence; a single EXR is a
  one-frame sequence.
  - PNG, JPEG and WebP frames are shown straight from the files. EXR, TIFF
    and DPX frames are decoded by the bundled ffmpeg into a frame cache,
    around the playhead first and then the rest; the thin bar above the
    scrub bar shows which frames are ready (dim: decoded, bright: in
    memory). Playback waits on a frame that isn't ready yet, like Nuke.
  - Everything else works as for videos: frame step, timecode, bookmarks,
    loop, the timeline, groups and Sync, A/B, fullscreen, sessions, undo.
  - **⚙** sets the frame rate (24 by default; nothing is re-decoded) and,
    for EXR, **Exposure** in stops (applied in linear light) and
    **Colour**: sRGB, Rec.709 (Nuke's curve) or None (the linear values
    as they are). Changing the look re-decodes in the background while the
    tile keeps showing its frame. Log DPX shows as stored.
  - A missing frame shows the one before it with a "frame N missing"
    badge.
- **YouTube / Twitch tiles.** YouTube tiles use the app's own play, scrub,
  mute and volume controls and join Play all / Pause all and group mute /
  volume. They also get bookmarks, appear on the timeline, and join Sync and
  group loops (to about ¼ s); they have no frame step and no A/B. Twitch
  tiles use Twitch's own player and only join groups for Sticky. Drag web tiles by their title bar. To pan the board from on top
  of an embed, turn on **✋ Pan + zoom** (the embed's own controls work
  again when it's off).
- **Two layouts.** Tiles always use each item's real aspect ratio.
  - **Gallery** (attached): tiles flow in rows and share one size. Drag any
    tile's corner, move the zoom slider, or `Ctrl`+wheel and they all resize.
    **Fit all** picks the largest size with no scrolling.
  - **Board** (detached): an infinite canvas, Miro-style. Drag a tile by its
    title bar or picture to move it; pull a corner to resize just that one
    (double-click a corner to reset its size). Middle-mouse or `Alt`-drag
    pans, the wheel scrolls, `Ctrl`+wheel zooms at the cursor. The
    **✋ Pan + zoom** tool (`H`) makes plain left-drag pan and the plain
    wheel zoom at the cursor (`Shift`+wheel still scrolls sideways). **Fit all** frames
    everything. **Tidy ▾** has two arrangements: **Fit to view** makes every
    tile the same height, as big as fits in the current view, in reading
    order; **Grid** keeps each tile's size and packs them edge to edge into a
    rough square (Linked spaces them out again on the next drag). `Ctrl+Z`
    undoes either.
  - **Lasso.** Left-drag on empty board to draw a rectangle; everything it
    touches is selected. `Shift`-click adds or removes one tile (it never
    plays or pauses, and a grouped tile toggles on its own), `Ctrl+A`
    selects all, `Esc` clears. Drag any selected tile and they all move.
  - **🔗 Linked** (`Shift+L`, on by default): moving or resizing a tile pushes its
    neighbours out of the way so nothing overlaps. Hold `Alt` to bypass it.
  - **Snapping.** While moving, edges snap to other tiles' edges and to a
    neat gap beside them; a pink guide line shows the match. `Alt` disables.
- **🔇 Mute all** (toolbar) mutes every video; once every one is muted it
  reads **🔊 Unmute all**. **🔁 Loop all** turns on every video's own loop
  (it lights up), and a second click turns them all off.
- **Master volume** (toolbar slider) scales every video's own volume. New
  videos start at a quiet 10% so twenty of them don't blast you.
- **Cache** (toolbar) shows how much space playable copies, thumbnails
  and decoded sequence frames use, and clears them.
- **Save** writes a `.mvp` session file (plain JSON): every tile with its
  time, volume, mute, speed, position, bookmarks and group, plus the layout.
  It saves in place once the session has a file; **right-click Save** (or
  `Ctrl+Shift+S`) for Save as… to a new file. **Open session** (or dropping
  a `.mvp` on the window) rebuilds everything. Older session files still open.
- **Clear board** removes every tile (it asks first) and starts a new,
  unsaved session.

**Shortcuts.** Anywhere: `Ctrl+A` add videos (Gallery) / select all (Board),
`Ctrl+O` open session, `Ctrl+S` save, `Ctrl+Shift+S` save as, `Ctrl+Z` undo,
`Ctrl+Shift+Z` / `Ctrl+Y` redo, `Ctrl+G` group, `Ctrl+Shift+G` ungroup,
`Space` play/pause everything, `C` A/B compare, `T` expand / collapse the timeline,
`I` / `O` loop In / Out, `` ` `` sidebar, `F` fullscreen the selected video
(again to exit), `Esc` leave fullscreen, `Shift+F` fill the view with the
selected videos (Board; `Ctrl+Z` undoes), `Shift+L` linked, `H` pan +
zoom tool, `+` / `-` zoom, `Esc` deselect. Over a video: `←`/`→` seek 5 s
(Shift 30 s), `↑`/`↓` volume, `K` play/pause, `M` mute, `L` loop, `,` `.` frame step,
`B` bookmark, `[` `]` previous / next bookmark.

## Formats

The built-in decoders play H.264, HEVC, VP8/VP9, and AV1 video (MP4, MOV,
WebM, MKV containers) plus common audio. When you add a file the app checks
its codec with the bundled ffprobe. Anything it can't play natively (ProRes,
DNxHD, MPEG-4 Part 2, WMV, …) shows a **Make playable** button: the bundled
ffmpeg makes an H.264 copy in the background (progress bar, Cancel), and the
tile switches to it. Copies live in a cache folder and are reused next time;
the toolbar **Cache** button shows their size and clears them. Your original
file is never changed.
