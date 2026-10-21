# Extra views, live-video budget, recent sessions — design

Date: 2026-10-20. Agreed with Scott in the fable hub session. Plans:
`docs/superpowers/plans/2026-10-20-views-and-live-budget.md` (opus 1) and
`docs/superpowers/plans/2026-10-20-recent-sessions.md` (opus 2).

Baseline: `feat/board-polish-and-performance` at `8dbe966` (v0.2.0.13 pre-release, PR #1 open).

## What Scott asked for

- A **recent sessions** list so reopening a saved board is one click.
- **Extra windows on the same board**, like Unreal, Blender or Premiere panels: "two sets of four
  shots, all variants of the same shot; instead of fitting eight on one monitor, zoom in closer
  and have four on each of two monitors. That copy window is another camera on the same board."
  In the extra window he wants to pan, zoom, and press play on what he sees. Limit: two extra
  views. He worries that zooming out too far in a view would suddenly double the load or crash.

## Decisions

### Live-video budget (level of detail), every window
- A tile drawn smaller than `LIVE_MIN_PX = 96` screen pixels tall is a **still**: its `<video>`
  releases its source (`removeAttribute('src'); load()`) after the current frame is copied to a
  canvas overlay that stays visible. Zoom back in and it reloads at the time the board says it
  is at, playing if it was playing.
- Each window holds at most `settings.liveCap` live local videos (default 12, range 4 to 64,
  Optimize ▾). When more are visible and large enough, the ones nearest the view centre win;
  the rest are stills. Web tiles (iframes) are not budgeted (they cannot be snapshotted) but
  are counted against the cap.
- Stills are a view-side state only: nothing about a tile being a still is saved or sent to
  other windows. Play state and time are board truth and keep advancing for a still (its clock
  is extrapolated from the last known time and rate while "playing").
- This replaces the offscreen-pause mechanism's role for local videos: offscreen tiles are
  stills (released decoders) rather than paused elements. Offscreen pause stays for web and
  sequence tiles as it is. A still that is "playing" shows a small ▶ badge so the user knows
  motion is just not drawn at this size.

### Extra views
- **Window ▾ → New view** (max 2 open) opens a second BrowserWindow loading the same
  `index.html` with `?view=1|2`. It is **another camera on the same board**: own pan and
  zoom (and own gallery scroll if in gallery mode), same tiles, same groups, same playback.
- A view can: pan, zoom, fit, select, play/pause/scrub/step tiles and groups, use the timeline,
  toggle mute/volume, switch Player/Local on web tiles, use hover play and EZ play. A view
  cannot: move, resize, tidy, group/ungroup, add, remove, paste, edit text, open or save
  sessions, change tile settings or quality, clear the board. Those controls are hidden in a
  view; the keyboard shortcuts for them do nothing; drags on tiles are ignored.
- The **main window is the authority** for layout and the group engine. Views receive a
  **snapshot** (the `collectSession()` output plus stable tile ids) whenever layout, tiles or
  groups change, and apply it by diff (update rects, add, remove, regroup). Views do not run
  the drift/loop engine; they follow playback messages and a once-a-second clock.
- **Playback mirroring**: any window that plays, pauses, seeks, scrubs, steps, or changes the
  rate of a tile sends `{ type: 'playback', id, op, value }` on the bus; every other window
  applies it to its own element for that id. Group actions are sent per member by the window
  that originated them (the main window's `broadcast` already expands groups; a view asks
  the main window to perform group actions by sending the leader's op, and the main window
  rebroadcasts the members' ops). The main window sends `{ type: 'clock', times: { id: t } }`
  once a second for playing tiles; a view re-seeks any tile more than 0.25 s off.
- The bus is `ipcRenderer.send('bus', msg)` → main process → `webContents.send('bus', msg)` to
  every other Ozy window. Main does no interpretation except: a `snapshot-request` from a new
  view is forwarded to the main window only.
- Closing a view closes nothing else. Closing the main window closes its views. A view opened
  while the board is empty shows the empty-board hint.
- Session file: `layout.views = [{ bounds: {x,y,w,h}, panX, panY, zoom }]`, written by the main
  window from what each view last reported (`{ type: 'view-state', n, ... }`, sent on every
  pan/zoom end and on close); on open, views listed there are reopened at those bounds.
- Performance contract: a video costs one decoder per window where it is live. The budget
  above bounds every window to `liveCap` decoders, so no zoom or window arrangement can
  exceed `liveCap × (1 + open views)`. The load strip's per-video table shows "still" as a
  state; the strip's Ozy figures already cover every Ozy process, so views are included.

### Recent sessions
- `settings.recentSessions`: up to 10 `{ path, openedAt }`, most recent first; updated on
  open and on save/save-as; de-duplicated case-insensitively on Windows.
- UI: the **Open session** button becomes a split button: click opens the dialog as today;
  the ▾ beside it lists the recent files by name with the folder in a tooltip, greyed when
  missing on disk (checked when the menu opens), each with a ✕ to forget, and "Clear list".
  The empty-board hint also lists the three most recent as links.
- Views never show it (they cannot open sessions).

## Out of scope
- Editing the layout from a view. Dragging tiles between windows. More than two views.
- Sharing one decoded frame between windows (not possible in Chromium).
- Stills for web tiles (iframes).

## Global constraints
- As before: vanilla JS, pure logic in `lib/*.js` with `node --test`, comment out instead of
  delete, isolated profile for manual checks, `grep -an` for `app.js`, one commit per task,
  no tag/release from the coder.
- Session version stays 6 (new fields are additive and ignored by older builds).
