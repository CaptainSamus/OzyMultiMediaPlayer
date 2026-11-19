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
self-contained: ffmpeg, ffprobe, yt-dlp and
[QuickJS-NG](https://github.com/quickjs-ng/quickjs) (MIT) are bundled inside, so
nothing is downloaded on first run. QuickJS-NG is a small JavaScript engine that
yt-dlp uses to solve YouTube's player challenge; without it YouTube hands out no
playable formats at all.

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
downloads `yt-dlp.exe` and `qjs.exe` (QuickJS-NG, pinned to the `QJS_TAG` in
`scripts/fetch-ytdlp.js`) once into `bin/` for packaging. Releases are built by
GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is pushed:
Windows and macOS, all attached to one release. You can also
double-click `start.bat`, or open a session straight away with
`npm start -- "C:\path\to\session.mvp"` / by dragging a `.mvp` onto
`open-session.bat`.

**If `npm run dist` fails with "Cannot create symbolic link : A required
privilege is not held by the client"** (`libcrypto.dylib` / `libssl.dylib`):
electron-builder's `winCodeSign` helper archive carries two macOS symlinks, and
Windows only lets you create symlinks with Developer Mode on (Settings ▸
Privacy & security ▸ For developers) or from an admin prompt. Either turn that
on, or unpack the archive once by hand without those two files. They are only
used when signing Mac builds on Windows, which this project never does: Mac
builds happen on GitHub's macOS runner, and nothing in the project's Mac
setup changes.

```
cd %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
node_modules-path\7zip-bin\win\x64\7za.exe x -y <the-numbered>.7z -owinCodeSign-2.6.0 -xr!libcrypto.dylib -xr!libssl.dylib
```

(`7za.exe` is in this project's `node_modules\7zip-bin\win\x64\`; the folder
name must be `winCodeSign-` plus the version in the error's download URL.) It
stays fixed on that machine until the electron-builder cache is cleared.

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
- **Front and back.** Tiles keep their layer: moving, resizing, editing text
  or jumping to a favorite never brings a tile to the front (a picture being
  cropped shows on top only while you crop). New and pasted tiles land on top.
  Right-click any tile on the board → **Bring to front** or **Send to back**
  (keys: **PgUp** / **PgDn**, on the selection or the tile under the cursor).
  With several tiles selected they move together and keep their order. The
  stacking is saved with the session.
- **The layout (2026-11-15).** The board fills the window and the controls
  float over it in panels, as in Miro (white on a light board, dark on a dark
  one; hover any icon for its name and key). **Top left:** the board's name
  (click: recent boards), open, save, save as, clear, then ☰ the app menu
  (Import from Miro, cache, mouse-wheel zoom, updates), view windows, Optimize
  and the load strip. **Left:** pan, add videos and pictures, text, sticky notes
  and shapes, line, pen, frames, then Sources and Favorites (the star shows how
  many). **Top right:** play all, pause all, loop all, hover play, EZ play, mute
  all and the master volume. **Bottom left:** gallery or board, group, ungroup,
  A/B, Tidy, Linked and the item count. **Bottom right:** the overview map, fit
  all, zoom out / in. Messages show as a note at the bottom. Selected pictures
  and videos get a small bar above them: to the front or back, lock, crop,
  duplicate, a frame around them, group, remove. Sources has a **✕** to close
  it; its rail button lights up while it is open.
- **Extra windows and their settings (2026-11-17).** ⧉ at the top left opens
  a panel: View 1 and View 2, each open or closed (with how many videos it is
  playing live), **Open view N** / **Bring to front**, and how the extra windows
  load videos: live videos per extra window (the rest show a still of their
  frame), pause videos scrolled out of view, and playback quality. Each view
  has a **View settings** button at its top left, next to its name, with how a
  view works, what it is playing right now, and its own settings (pause
  offscreen, live videos per view, the load viewer); the load strip button is
  there too. A new view points at that button for its first few openings.
- **Bookmark blocks (2026-11-16).** The bookmark button on the left rail adds a
  list of links laid out like a spreadsheet: Name, Site, Notes, Added. Paste
  links (one or a whole list) into the box at its bottom, press **Ctrl+V**
  while the block is selected, or drop a link from a browser on it; pasting or
  dropping links on empty board makes a new block. Each link's page title, site
  name and icon are looked up (in a separate, cookie-less connection; a bot
  check or error page leaves the address's own name). Click a name to open it
  in your browser. Double-click a cell to type in it (**Tab** next cell,
  **Enter** keep, **Esc** put back; emptying a name brings the page's name
  back). Click a column heading to sort, again for the other way. Right-click a
  row: copy, rename, edit the link or note, get the name again, move up/down,
  remove. Every change is undoable, the block is saved with the board, and Find
  (**Ctrl+F**) searches its names and links. An older Ozy shows the list as text.
  **Tiers (2026-11-17):** each link has a badge: click it for **S** (the best),
  **A**, **B** or none, or hover a row and press **1**, **2**, **3** (**0**
  clears). S rows are gold and bold, A rows have a blue edge, untiered rows are
  a little quieter; the header counts them, the Tier heading sorts by them, and
  right-click → **Keep top tiers at the top** keeps S and A first.
- **Scaling a bookmark block or to-do list (2026-11-17).** Drag any corner and the
  whole block scales, text and all (the corner opposite stays put; **Shift**+drag
  changes only the width). Right-click: **Smaller (half size)**, **Larger (double
  size)**, **Normal size at this zoom** (text at its usual size on screen as you
  look now: handy for one made while zoomed far out). Ctrl+Z undoes each.
- **Width and columns (2026-11-17).** A bookmark block or to-do list has a
  handle down its left and right edges: drag one to change the width while the
  text keeps its size (a bookmark block will not go narrower than its columns).
  In a bookmark block each heading but Notes has a divider on its right, as in
  Explorer: drag it to make that column wider or narrower (Notes takes what is
  left; the block widens if it has to), double-click it to fit the column to
  what is in it. Right-click: **Reset column widths**. Widths save with the
  board and scale with the block.
- **To-do lists (2026-11-17).** The checklist button on the left rail adds a
  goal with a progress bar and its tasks. Click words to type. **Enter** adds
  the next task, **Tab** makes it a sub-task of the one above (as deep as
  needed), **Shift+Tab** takes it back out (so does Enter on an empty
  sub-task), **Backspace** on an empty task removes it, **↑ ↓** move between
  tasks, **Alt+↑ ↓** reorder, **Ctrl+Enter** ticks. A task with sub-tasks is
  ticked when all of them are, and ticking it ticks them all; ▸ folds them
  away. Hover a task for + (sub-task), its colour and ✕; right-click for the
  rest (the list's own colour, fold all, clear the done tasks, untick
  everything, copy as text). Pasting several lines (or Ctrl+V with the list
  selected) makes a task of each, indents becoming sub-tasks.
- **Search (2026-11-17).** **⌕ at the top of the left rail (Ctrl+K)** searches
  Ozy's features: every button, menu item and shortcut, by name or by what it
  does (Enter or a click does it; the ones used last come first). **The teal
  picture button lower on the rail (Ctrl+Shift+F)** searches the pictures and
  videos on the board by name or folder, as thumbnails with filters; a click
  flies to one.
- **Shapes and sticky notes.** The **◇ ▾** button adds a sticky note,
  rectangle, rounded rectangle, circle, triangle, diamond, hexagon, star,
  arrow, parallelogram or a frame in the middle of the view; **N** puts a sticky
  note under the mouse and starts typing in it. Double-click a shape to type in
  it. The text bar's **Shape** list turns any text into another shape, and its
  fill colours include Miro's sticky note colours (second row). **Ctrl+D**
  duplicates the selection. A selected tile has a round handle above it: drag
  it to turn the tile (Shift: 15° steps; it settles level near 0°/90°),
  double-click it to level the tile again.
- **Frames.** **▣ Frames ▾** → New frame (or Frame around the selection). A
  frame holds what lies on it: drag it by its title and everything whose middle
  is inside goes along; a press inside it draws the lasso, as on the board, and
  double-click inside adds a note. Double-click the title to rename it. The menu
  lists the frames (click one to fly there) and **Present** shows them one by
  one (← → or Page Up/Down, Esc ends). Frames from Miro come over as frames.
- **Arrows that stay on things.** Draw a line (╱ or D) from one tile to another,
  or drop a line's round end on a picture, shape or note: that end stays on the
  middle of the side it was dropped nearest, and the line follows when the tile
  moves (Alt: drop it loose). The line bar's **Straight / Elbow / Curved** list
  says how it goes. An arrow held at both ends moves by its ends. Miro's arrows
  come over on the items they point at.
- **Pen and highlighter.** **P** (or ✎ ▾) draws freehand, **Shift+P**
  highlights; the tool stays on stroke after stroke until Esc. A stroke is a
  line: select it to change its colour or thickness. Miro's pen drawings come
  over too (when the board was copied in Miro first).
- **Find, export, overview map.** **Ctrl+F** finds text, note, shape, frame
  and picture names on the board (Enter: next, Shift+Enter: back, Esc closes).
  **▣ Frames ▾** exports the view as a PNG, every frame as one PDF (a page
  each) or every frame as its own PNG. **M** (or the Frames menu) shows a map of
  the whole board in the corner: click or drag on it to go there.
- **Locking.** Right-click a tile → **Lock** (or select it and press
  **Ctrl+Shift+L**; again unlocks). A locked tile can't be moved, resized,
  cropped, edited, restyled or removed, and Ctrl+A, the lasso and every tidy
  leave it alone. Dragging on a locked tile draws the lasso, as on empty board,
  so lock a background panel or frame and sweep up the pictures lying on it.
  A click on a locked tile selects it (a 🔒 shows) so it can be unlocked: its
  right-click menu is just **Unlock** (a locked divider also keeps Line up rows
  and Trim). Lock the dividers too (Select alike, then Ctrl+Shift+L) and a
  lasso across a row takes only the pictures. A tile the whole lasso lies
  inside is the background it was drawn on and is not taken either. Locks are
  saved with the board; a pasted copy is not locked.
- **Lines.** The **╱** button (or **D**) draws a line: drag on the board (a
  click draws a level one). Nearly level or upright snaps straight, Shift
  snaps to 15° steps, and an end also lines up with the ends of other lines
  and the edges of tiles (Alt: no snapping). Click a line to select it, drag
  it to move it, drag a round end to change it. The **line bar** over a
  selected line sets its thickness (− / + / the slider / type a number), colour,
  solid / dashed / dotted and arrowheads; **[** and **]** make the selected
  lines (or the one under the mouse) thinner and thicker, Delete removes them.
  **Select alike** (or right-click → Select lines like this one) selects every
  line of the same colour and thickness, so all the dividers of a board change
  together. Lines are guides too: a picture moved or resized near a line stops
  at it (lines win over other tiles' edges).
- **Rows between lines.** Select one divider of a stack of level lines and
  click **Line up rows** (or right-click → Line up the pictures between these
  lines). Every picture in a row gets the same height (each keeps its own
  shape: the height most of that row's pictures already have, never taller
  than the room between the lines), sits in the middle of its row, and the
  pictures one above another across the rows (columns) line up on one middle.
  Empty slots stay empty, pictures piled on each other move as one, and
  captions under or on a picture go with it. **Trim** instead keeps every
  picture where it is and cuts it where it crosses a divider (a crop:
  right-click → Reset crop gives the whole picture back). Both are one Ctrl+Z.
- **Paste pictures from anywhere.** Right-click → Copy image in Chrome (Google
  Images), Discord or any program, then Ctrl+V on the board (or right-click
  empty board → Paste): the picture lands under the cursor. When the browser
  also copied a link to the picture's file, Ozy fetches that file and keeps
  whichever is bigger, so you get the full-size original (a GIF still moves);
  a copied link to a picture pastes too. Pasted pictures are kept in
  `Ozy Imports\Pasted` (same drive as Miro imports, never C: unless that is all
  there is), and pasting the same picture again reuses its file. Tiles you
  copied in Ozy still paste as before, as long as nothing was copied since.
- **Import from Miro.** App ▾ → **Import from Miro…** brings a whole Miro
  board over: pictures (downloaded at full size, plus Miro's smaller preview
  of each, shown while a picture is small on screen), text, sticky notes,
  rectangles / rounded boxes / circles, frames, cards and YouTube embeds, each
  where it was. It needs your own Miro access token: in Miro, profile picture
  → Settings → Your apps → Create new app (in the team that has the board),
  leave "Expire user authorization token" unticked, tick only `boards:read`,
  then Install app and get OAuth token. Ozy can remember the token, encrypted
  for your Windows account. The board lands in `Ozy Imports\<board name>` on
  the drive Ozy is installed on (never C: unless that is all there is), next
  to `miro-items.json` (what Miro said, for putting a bug right). Running the
  import again only downloads what is missing (a picture used several times
  is fetched once), and a board always continues in the folder it was first
  imported into. A huge Miro board comes in scaled down, everything by the
  same amount, so it all fits (the summary says by how much). Rotation comes
  over. **Crops:** Miro's API does not say how a picture is cropped, but
  Miro's own copy does. So before importing, open the board in Miro, click
  an empty spot, press Ctrl+A then Ctrl+C: the import reads every picture's
  exact crop from that copy (and keeps them in `miro-crops.json`, so later
  imports need no copy). Already imported? Copy, then Import again: nothing
  is downloaded twice. Without a copy a cropped picture shows its middle.
  The same copy brings Miro's lines and arrows over (Miro's API leaves loose
  lines out), at their place in Miro's layers.
  Any picture can be re-cropped by hand: right-click it → **Crop…** (drag the
  picture, wheel to zoom it, drag a corner to reshape; Enter when done; undo
  puts it back). Nothing is ever cut out of the picture files themselves. Re-importing
  never overwrites a board you have saved over: the new one gets a dated name.
  Not brought over yet: arrows, pen drawings, tables, mind maps and mixed
  formatting inside one text box. Imported boards are light; right-click
  empty board space for **Light board / Dark board** on any board.
- **Favorites.** `☆` next to `✕` on a tile's title bar stars it: it gets a
  gold ring (it stays the same thickness however far you zoom out, so a
  favorite is easy to spot on a big board) and a small `★` in its corner.
  **★ Favorites** in the toolbar opens the sidebar's Favorites tab, listing
  every starred tile by name; click a name and the board flies to that tile
  and centres it (in the gallery it scrolls to it). `✕` on a row unstars it.
  Stars are saved with the session.
  - **Folders.** `+ Folder` on the Favorites tab makes a folder (anything
    selected on the board goes straight into it). Drag a name onto a folder
    to file it, or right-click a name or a tile's `★`. Each folder has a
    colour, and its videos wear that colour as their ring. Click a folder's
    header to fly to all of its videos at once; double-click its name to
    rename it, click its swatch to change its colour, `✕` removes the folder
    (its videos stay starred). Folders are saved with the session.
  - **Playing on out of view.** A favorite that is playing keeps playing when
    you look elsewhere on the board, turned down to 3 % (or the level set at
    the bottom of the Favorites tab), and is back at its own volume once it is
    in view again. Other videos still turn into stills off screen. Turn it off
    on the Favorites tab or under Optimize.
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
- **Syncing two cuts of the same footage.** When two videos are grouped, a
  small play bar sits just above them on the board (▶, the main video's
  time, `‹` `›` for the previous / next sync point, `◆ n` how many, and
  **⇆ Sync editor**). Drag it by its ⠿ grip to move it; it stays near its
  videos and moves with them. ⛓ **Sync** on the group bar opens the sync
  editor when they have never been lined up, instead of locking them
  wherever they happen to be.
  - **The sync editor** shows the two videos side by side, full window.
    While it is open they are never linked: moving one never moves the
    other. Click a video to steer it (it gets a blue outline): `←` / `→`
    one frame, `Shift` ten, `Space` play / pause it, `Tab` the other one.
    Under each: its timecode with frames and its frame number, a bar for the
    whole video (click or drag to jump), and a strip of about 8 seconds with
    a tick per frame and its sound drawn on it — drag it to scrub (right is
    later), scroll on it for one frame at a time (`Shift` ten), `Ctrl`+scroll
    to see more or less of it.
  - **⚡ Match** (`M`) lines the other video up with the main one where they
    are: by sound to get close, then by picture to land on the frame (and
    exactly, when both have a shot change there). In a capture the sound
    can sit a few frames off the picture, so the picture is what it trusts.
    It says how many frames it moved; check it and nudge it if you need to.
    If the main video was moved a long way, `G` / **⤓ Go to its sync** puts
    the other one where the sync puts it first.
  - **◆ Sync here** (`Enter`) keeps "this frame is this frame" as a sync
    point. Where the cuts differ (one has a shot the other lacks), line them
    up again after it and Sync here again: Ozy listens between the two
    points for where they part and puts the wait (or jump) there, on the
    frame where the picture cuts. Where the main video has a part the other
    lacks, the other waits, dimmed ("Not in this cut"); where the other has
    extra, it jumps over it. The other video's readout says how far it is
    from its sync ("on its sync", "+3 frames from its sync").
  - **▶ Play both** (`P`, `Shift+Space`) plays both from where they are, to
    check by eye and ear. The sync points are listed along the bottom:
    click one to go there, ✕ to remove it. `Ctrl+Z` undoes each change.
  - **Done** (`Esc`) goes back to the board. If they were lined up
    differently and that was not kept, it asks first.
  - The **main video** is the one the others follow (the longest, unless
    you pick **Make this the main video**). The bar's `⋯` also has **Clear
    all sync points**. Sync points save with the board, and come back if
    Sync is turned off and on again. An offset from an old Sync press, never
    lined up in the editor, is replaced by the first Sync here.
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
- **Text tiles / sticky notes.** Add a text tile to the board for notes and
  labels. Selecting one shows a style toolbar: font, size, colour, align,
  and bubble fill and outline.
- **Copy and paste.** `Ctrl+C` copies the selected tiles and `Ctrl+V` pastes
  them onto the board.
- **Hover play.** A play mode where videos play only while the cursor is
  over them.
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
    tile keeps showing its frame. Log DPX shows as stored. A multi-layer or
    multi-part EXR also gets a **Layer** picker (AOVs); switching layer
    decodes in the background, and switching back is instant. The sidebar
    row says how many layers a sequence has.
  - A missing frame shows the one before it with a "frame N missing"
    badge.
- **How web videos play.** YouTube tiles use YouTube's own embedded player
  by default, synced to the timeline and groups like any tile. The pulldown
  on the tile's title bar offers **Local**: yt-dlp downloads the full-quality
  file into the cache (with progress and Cancel; nothing downloads until you
  pick it) for offline, frame-accurate work. **Stream** (a direct 720p URL)
  is currently hidden for YouTube, because YouTube no longer serves a single
  audio + video file, and remains the only mode for Twitch clips. yt-dlp
  ships with a JavaScript runtime (QuickJS-NG, 2 MB, MIT) that it needs for
  YouTube's player challenge. Twitch live channels stay embed-only.
- **YouTube titles.** YouTube tiles show the video's title.
- **Scrubbing over YouTube.** Scrubbing the timeline or a tile over a
  YouTube player no longer stalls it, and Sync leaves a buffering YouTube
  tile alone.
- **Date-stamped photo folders.** Folders containing date-stamped or
  timestamped photos no longer fail to list (a sequence-detection crash).
- **Board interactions over YouTube embeds.** Board interactions recover if
  a drag, resize or file drop is released over a YouTube embed: the
  "Release to add" overlay no longer gets stuck and tiles stay movable and
  resizable without switching modes. Files dropped onto a Player tile are
  added at that spot.
- **YouTube / Twitch tiles.** YouTube tiles use the app's own play, scrub,
  mute and volume controls and join Play all / Pause all and group mute /
  volume. They also get bookmarks, appear on the timeline, and join Sync and
  group loops (to about ¼ s); they have no frame step and no A/B. Twitch
  tiles use Twitch's own player and only join groups for Sticky. Drag web tiles by their title bar. To pan the board from on top
  of an embed, turn on **✋ Pan + zoom** (the embed's own controls work
  again when it's off).
- **Two layouts.** Tiles always use each item's real aspect ratio.
  - **Gallery** (attached): tiles flow in rows, each with its own size. Drag
    a tile's corner to resize just that one. The zoom slider (or `Ctrl`+wheel,
    `+` / `-`, or the plain wheel with **Wheel zoom** ticked) scales every tile
    together, keeping the relative sizes you set. **Fit all** scales them all to fill the window with no scrolling.
    Sizes are saved in the session.
  - **Board** (detached): an infinite canvas, Miro-style. Drag a tile by its
    title bar or picture to move it; pull a corner to resize just that one
    (double-click a corner to reset its size). Middle-mouse or `Alt`-drag
    pans, the wheel scrolls, `Ctrl`+wheel zooms at the cursor. Tick
    **Wheel zoom** (next to the zoom slider) and the plain wheel zooms at the
    cursor instead, while left-drag still lassos and middle-mouse still pans.
    The **✋ Pan + zoom** tool (`H`) makes plain left-drag pan and the plain
    wheel zoom at the cursor (`Shift`+wheel still scrolls sideways). Wheel
    zooming moves in gentle steps, about 8% per notch. **Fit all** frames
    everything. **Tidy ▾** has two arrangements: **Fit to view** makes every
    tile the same height, as big as fits in the current view, in reading
    order; **Grid** keeps each tile's size and packs them edge to edge into a
    rough square (Linked spaces them out again on the next drag). `Ctrl+Z`
    undoes either.
  - **Lasso.** Left-drag on empty board to draw a rectangle; everything it
    touches is selected. `Shift`-click adds or removes one tile (it never
    plays or pauses, and a grouped tile toggles on its own), `Ctrl+A`
    selects all, `Esc` clears. Drag any selected tile and they all move.
  - **Nothing gets pushed** (the standard): what you move stops against what it
    runs into and nothing else moves. Move the mouse along and it slides along
    that edge; drag it to a clear place past it and it goes there. A corner
    resize stops growing where it touches. Things that already overlap (a
    caption on a picture) still move over each other; locked tiles, lines and
    frames never stop anything. Hold `Alt` (`Option` on a Mac) while dragging to let it overlap.
  - **🔗 Push neighbours** (`Shift+L`, the 🔗 button, or right-click the board;
    off by default, and the same for every board): moving or resizing a tile
    pushes its neighbours out of the way instead, as it did before.
  - **Opening a session** dims the board and shows a progress box until the
    pictures and videos in view have loaded ("Show the board now" skips it).
  - **Snapping.** While moving, edges snap to other tiles' edges and to a
    neat gap beside them; a pink guide line shows the match. `Alt` disables.
- **🔇 Mute all** (toolbar) mutes every video; once every one is muted it
  reads **🔊 Unmute all**. **🔁 Loop all** turns on every video's own loop
  (it lights up), and a second click turns them all off.
- **Master volume** (toolbar slider) scales every video's own volume. New
  videos start at a quiet 10% so twenty of them don't blast you.
- **App ▾** (toolbar) holds **Cache…** (how much space playable copies,
  thumbnails, downloads and decoded sequence frames use, and clears them),
  **Check for updates**, **Open logs folder**, **Copy diagnostics**, and the
  version you're running.
- **Logs.** Every run writes a log file (2 MB each, the last five kept) next
  to the cache, in `%APPDATA%\ozy-multi-media-player\logs` on Windows — the
  portable exe included. Each run starts with what you were running (version,
  installed / portable / dev, platform, whether the bundled ffmpeg, ffprobe
  and yt-dlp were found) and then records errors: crashes, failed transcodes
  with ffmpeg's own message, unreachable files and shares, session loads, and
  update checks. **App ▾ → Open logs folder** opens it; **Copy diagnostics**
  puts that start-up block, what's on the board, and the last 300 log lines on
  the clipboard, ready to paste into a message when something goes wrong.
  Logs stay on your machine — nothing is sent anywhere.
- **Updates.** The installed Windows app updates itself: a banner says a new
  version is available, **Download** shows progress, then **Restart to
  update** installs it. The portable exe and the Mac app can't self-install,
  so they show the same banner with a link to the download page instead.
  The check asks GitHub for the newest release once, about ten seconds after
  launch; **App ▾ → Check automatically on launch** turns it off, and with it
  off the app makes no network call of its own at all. **Include
  pre-releases** decides whether test builds count.
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
