# Multi Video Player

A fully local desktop app that plays many videos at once (20+ if your GPU can
decode them), with a hover-to-reveal control bar on every video and savable
sessions that remember each video's position.

## One-time setup

1. Install Node.js (LTS) from https://nodejs.org — this is the only download
   besides the Electron runtime itself.
2. In this folder run:

```
npm install
```

That downloads Electron once into `node_modules/`. After that the app never
touches the network: it loads no remote content, and every http/https/ws
request is cancelled at the network layer in `main.js`.

## Run

```
npm start
```

or double-click `start.bat`.

To open a saved session straight away, drag a `.mvp` file onto
`open-session.bat`, or run `npm start -- "C:\path\to\session.mvp"`.

## Using it

- **+ Add videos** (or drag files onto the window) adds tiles. Nothing
  autoplays; hit **Play all** or press **Space**.
- **Hover a tile** to get its own controls: scrub bar, play/pause, −5 s /
  +5 s (Shift for 30 s), time, bookmarks, mute, and speed. Move the mouse
  to the **right side** of the picture and a big white volume bar appears:
  click or drag anywhere on it to set the level (mouse wheel works too).
  Click the picture to play/pause it, double-click for fullscreen.
  On the board the controls stay the same size on screen at any zoom.
- **Bookmarks.** `🔖+` (or `B` while hovering) drops a bookmark at the
  current time. They show as yellow pins above the scrub bar: click a pin to
  jump there, right-click to delete. The `🔖 n` button opens a list where
  you can name, jump to, or delete each one. `[` and `]` jump to the
  previous / next bookmark. Bookmarks are saved in the session file.
- **Per-video keys** (with the mouse over a video): `←`/`→` seek 5 s,
  `↑`/`↓` volume, `K` play/pause, `M` mute, `B` bookmark, `[` `]` bookmarks.
- **Two layouts.** Tiles always use each video's real aspect ratio.
  - **Gallery** (attached): videos flow in rows and share one size. Drag any
    tile's corner, move the zoom slider, or `Ctrl`+wheel and they all resize.
    **Fit all** (`F`) picks the largest size with no scrolling.
  - **Board** (detached): an infinite canvas, Miro-style. Drag a video by its
    title bar or picture to move it; pull a corner to resize just that one
    (double-click a corner to reset its size). Middle-mouse or `Alt`-drag
    pans, the wheel scrolls, `Ctrl`+wheel zooms at the cursor, and the
    **✋ Pan** tool (`H`) makes plain left-drag pan too. **Fit all** frames
    every video; **Tidy** lines them up in rows keeping their sizes. Dropping
    files onto the board puts them under the cursor. Switching Gallery →
    Board starts from the exact gallery layout.
  - **Lasso.** Left-drag on empty board to draw a rectangle; everything it
    touches is selected. `Shift`-click adds or removes one video, `Ctrl+A`
    selects all, `Esc` clears. Drag any selected video and the whole group
    moves together.
  - **🔗 Linked** (`L`, on by default). While it's on, moving or resizing a
    video pushes its neighbours just far enough out of the way that nothing
    overlaps, and they slide back if you shrink again mid-drag. Turn it off
    and videos can overlap freely. Hold `Alt` while dragging to bypass it.
  - **Snapping.** While moving, edges snap to other videos' edges and to a
    neat gap beside them; a pink guide line shows the match. `Alt` disables.
  - Positions, sizes, the board's pan/zoom, and the gallery size are all
    saved in the session file.
- **Master volume** (toolbar slider) scales every video's own volume at
  once. New videos start at a quiet 10% so twenty of them don't blast you;
  raise a single video with its own slider or everything with the master.
- **Save / Save as** writes a `.mvp` session file (plain JSON). It stores,
  for every video: file path, current time, volume, mute state, speed, and
  whether it was playing. **Open session** (or dropping a `.mvp` on the
  window) rebuilds the grid and seeks every video back to where it was.

Shortcuts: `Ctrl+A` add videos, `Ctrl+O` open session, `Ctrl+S` save,
`Ctrl+Shift+S` save as, `Space` play/pause everything.

## Formats

Chromium's built-in decoders handle H.264 MP4, WebM (VP8/VP9/AV1), and Ogg.
HEVC, ProRes, and most `.mkv`/`.avi` payloads need to be transcoded to
H.264 MP4 first (e.g. with FFmpeg or DaVinci Resolve).
