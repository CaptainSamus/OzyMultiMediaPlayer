# Board polish and performance — design

Date: 2026-10-07. Agreed with Mark in the fable hub session. Two plans implement it in parallel:
`docs/superpowers/plans/2026-10-07-board-interaction.md` (opus 1) and
`docs/superpowers/plans/2026-10-07-performance.md` (opus 2).

Baseline: main at `aab619e` (v0.2.0.11). Session format is version 5; this work bumps it to 6.

## What Mark asked for, in his words (condensed)

- An **optimization section** so a heavy scene (twenty 1080p videos) can be dropped to a lower
  playback resolution, per video or for the whole scene, like Premiere's 1/2 and 1/4.
- A **real-time load viewer** showing what the open scene costs, with a clear split between
  what Ozy is doing and a blanket "everything else" figure for the rest of the system.
- **Selecting one video** should be a click, not a lasso.
- **Clicking the picture should play it**, reliably. An "EZ play" mode where a click anywhere on
  the video plays it.
- **Copies should not eat memory**: pasting must not wreck a scene.
- **Tidy only what is selected**, not the whole scene; a "tidy group" action.
- **Snapping while scaling**: a tile should snap to a neighbour's height/width and edges while
  being resized, not only while being moved.
- **Scale a group** as one object when the group is sticky.
- **Rearrange inside a sticky group** by dragging one member over another so the two swap
  slots, staying neat; Ctrl-drag (pull one member free) stays as it is.

## Decisions

### Selection (plan A, Task 1)
- Plain click on an ungrouped tile, or a member of a non-sticky group, selects just that tile.
- Plain click on a sticky-group member selects the whole group (unchanged).
- Clicking a tile that is already in the selection keeps the selection (so a drag moves all).
- Shift-click toggles, Ctrl-click selects exactly that one (both unchanged).

### Click to play, and EZ play (plan A, Task 2)
- The post-drag click guard is fixed: `suppressClick` is consumed by the next click (or cleared
  by the next pointerdown) rather than being cleared by a `setTimeout(0)` that fires first.
- **EZ play** is a global setting (`settings.ezPlay`, default off) with a toolbar button beside
  Hover play. When on, a click anywhere on a tile that is not a control (button, input, select,
  seek bar, markers, volume zone, bookmark panel, error panel, resize handle) toggles play on
  that tile. For YouTube/Twitch tiles in Player mode, the existing `.pan-shield` over the iframe
  takes the click and toggles play through the tile's playback controller, so the embed's own
  controls are unreachable while EZ play is on (the tile's own buttons still work).
- Shift-click never plays.

### Tidy the selection (plan A, Task 3)
- Tidy ▾ entries act on the selection when one exists, else on every board tile. Labels gain
  "(selection)" while a selection exists.
- Selection tidy keeps the rest of the board untouched: tiles are flow-wrapped inside the
  selection's current bounding-box width. **Fit** gives every selected tile the same height
  (the mean of their current heights) and wraps at the bounding-box width, growing downward if
  needed. **Grid** keeps sizes and packs edge to edge from the bounding box's top-left. Neither
  re-fits the view when acting on a selection.
- The group bar gains a **Tidy** button that selects the group and runs Fit on it.

### Resize snapping (plan A, Task 4)
- While corner-resizing a tile (board, aspect-locked tiles), the moving edges snap to other
  tiles' edges (with and without the link gap) and the size snaps to another tile's height or
  width. Same 8 screen-pixel threshold and guide lines as move snapping. Alt disables it.
- Text tiles (free aspect) do not snap on resize.

### Group scaling (plan A, Task 5)
- Corner-resizing a member of a sticky group, without Ctrl, scales every member about the
  group's bounding box, anchored at the corner opposite the handle. Ctrl-resize scales only the
  one tile (mirrors Ctrl-drag).
- The factor is clamped so no member goes below `BOARD_MIN_H` or above `BOARD_MAX_H`.
- Resize snapping applies to the dragged tile; the factor derives from its snapped height.
- Undo is one resize entry.

### Swap rearrange inside a sticky group (plan A, Task 6)
- **Alt-drag** on a member of a sticky group is a swap drag: the tile lifts (follows the
  pointer, on top, with a `.swapping` outline) and the member under the pointer highlights as
  the target and previews moving into the dragged tile's slot. Release over a member swaps
  their rectangles (position **and** size, so the layout is identical afterwards). Release
  anywhere else snaps the tile back.
- Every existing gesture is unchanged: plain drag moves the sticky group, Ctrl-drag pulls one
  member free, Shift-click toggles selection, Alt-drag on empty board or on any other tile
  still pans, middle-mouse always pans. The one loss is that a pan can no longer be started by
  Alt-dragging on top of a sticky member (Mark chose this on 2026-10-07 as the least
  disruptive option).
- Undo is one move entry covering the two tiles.

### Offscreen pause (plan B, Task 1)
- Default on (`settings.pauseOffscreen`). A playing tile whose element is entirely outside
  the board/gallery viewport (plus a margin of half a viewport) is paused without
  broadcasting to its group and marked `autoPaused`. When it comes back into view it resumes;
  a synced member is first re-seeked to the group time so it stays in sync.
- Checked after view changes (pan, zoom, layout, drag end, scroll) and on a 500 ms interval.
- Skipped while Hover play is on, in compare view, or fullscreen.

### Playback resolution tiers (plan B, Task 2)
- Tiers: `full`, `half`, `quarter`. A tier is an H.264 proxy scaled by 1/2 or 1/4 (even
  dimensions), `-preset faster -crf 23`, cached next to today's playable copies with the tier
  in the file name. `full` means today's behaviour (original, or the playable copy if one
  exists).
- Scene control: **Optimize ▾** menu in the toolbar with Playback quality Full / ½ / ¼. Saved in
  the session as `layout.quality`.
- Per-tile override in the tile's ⚙ settings popover: Scene default / Full / ½ / ¼. Saved per
  file tile as `quality` (`'scene'` when following the scene). Copy/paste carries it.
- Tiers are built on demand, one ffmpeg at a time through the existing proxy queue. A tile
  keeps playing its current source until the tier is ready, shows a small progress badge, then
  swaps source preserving time, paused state and rate.
- Only local file tiles get tiers in this pass. Web tiles keep their own `webQuality`;
  sequence and image tiles are untouched.

### Cache controls (plan B, Task 3)
- Settings: `cacheDir` (null = userData default) and `cacheCapMB` (default 20480). The proxy
  folder honours `cacheDir`.
- After every finished proxy job the cache is trimmed oldest-access-first until under the cap;
  files that cannot be deleted (in use) are skipped.
- The Optimize menu shows the cache total and cap, with Change folder…, and the existing clear.
  Changing the folder does not move existing files.

### Load viewer (plan B, Task 4)
- A panel toggled from the Optimize menu, refreshed once a second.
- Top: **Ozy** (CPU %, memory MB, GPU-process memory MB) and **Everything else** (system CPU %
  minus Ozy, system memory used minus Ozy), plus headroom (free memory). Source: Electron's
  `app.getAppMetrics()` and Node's `os` module. No per-program detail is read or stored.
- GPU is Ozy-only (GPU process memory) and labelled as such; no system GPU counters.
- Per-tile rows: name, source resolution, tier, playing/paused/auto-paused, dropped frames
  (`getVideoPlaybackQuality`), and an estimated decode memory from resolution.

### Paste and session open start paused (plan B, Task 5)
- Opening a session never autoplays: every tile is built paused, ready to play, whatever
  play state the file saved (Mark, 2026-10-07: a file saved while playing resumed on open).
  The saved `paused` field is still written, so nothing else changes.
- Pasted tiles always start paused. With offscreen pause and tiers, a paused copy costs close
  to nothing. There is no shared-decoder instancing in Chromium; a playing copy costs what the
  original does, and the spec says so in the UI copy.

## Out of scope
- Frame-rate reduction as a tier. Mark asked (2026-10-07) whether 60 fps clips could play at
  24. Halving (60 to 30) is clean, but 60 to 24 is not an even ratio and judders, and most
  footage is 24 fps, so the gain is small. Deferred. DASH/MSE stream mode (Task 35 remains deferred). Tiers for
  web/sequence tiles. System GPU counters.

## Global constraints
- Vanilla JS, no new runtime dependencies. Pure logic in `lib/*.js` with `node --test`
  tests; `app.js` only wires it. Every lib module exports via `module.exports` and
  `window.X`.
- Session version becomes 6; older files must still open (session.test.js fixtures).
- Cutting behaviour: comment out in place, never delete.
- Test the app with a separate `--user-data-dir`; never Mark's instance. Close what you open.
- Each plan works on its own branch from `main`: `feat/board-interaction` and
  `feat/performance`. Commit per task. No version bump, tag, release or PR; sonnet merges both
  and opens one PR when Mark says so.
- `app.js` contains a NUL byte near offset 175927; use `grep -a` / `sed` to search it.
