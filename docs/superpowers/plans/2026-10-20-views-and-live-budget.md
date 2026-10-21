# Views and Live-Video Budget Implementation Plan (plan E)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Up to two extra Ozy windows that are cameras on the same board (own pan/zoom, mirrored playback, no editing), made safe by a per-window live-video budget that turns small or surplus videos into stills so no zoom or window arrangement can exceed a fixed number of decoders.

**Architecture:** Stable tile ids. A `lib/lod.js` rule picks which tiles are live in a window; `app.js` releases or restores `<video>` sources accordingly with a canvas still. A message bus in `main.js` relays `bus` messages between Ozy windows. The main window is the layout authority and sends snapshots (`collectSession()` plus ids); views apply snapshots by diff through `lib/snapshot.js`. Playback ops and a once-a-second clock are mirrored. Views load the same `index.html` with `?view=N` and gate editing behind `window.OZY_VIEW`.

**Tech Stack:** Vanilla JS, Electron 33 (`BrowserWindow`, `ipcMain`, `webContents.send`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-20-views-and-live-budget-design.md`. Read it first; the plan argues from it.

## Global Constraints

- Branch `feat/views-and-live-budget` from `feat/board-polish-and-performance` (`8dbe966`). One commit per task. No tag/release/PR; push and report to the hub.
- Pure logic in `lib/*.js` with tests; `app.js` wires. `grep -an` for `app.js`; preserve line endings; comment out rather than delete.
- Opus 2 is on `feat/recent-sessions` at the same time, editing `openSession`/`saveSession`/`saveSessionAs`, the Open button, the empty-board hint, and `lib/settings.js` (its key on its own line). Stay out of those spots; define `window.OZY_VIEW` early in `app.js` (Task 4) because plan F reads it.
- Manual checks: isolated profile, own CDP port, close everything. Two-window checks need two CDP targets: `/json/list` on the one `--remote-debugging-port` lists every window; pick by `url` (`?view=1`).
- Performance contract from the spec: one decoder per window where a tile is live; never more than `settings.liveCap` live local videos per window.
- Session version stays 6. New fields: per-tile `id`, `layout.views`.

## Review Focus

1. Releasing a video's source must keep its frame on screen (canvas still) and restore at the board time, playing if it was playing (Task 2 manual check; `Lod` tests cover the choice, the restore path is wired code).
2. A view must never apply a snapshot that is older than one it already applied (snapshots carry a sequence number; Task 3 test `stale snapshot ignored`).
3. A playback message must not bounce: window A plays, sends to B, B applies and must not send it back to A (Task 5: `applyingRemote` guard; manual check with two windows shows one message per action in the log).
4. Closing a view while a snapshot is in flight must not throw in main (`webContents.isDestroyed()` guard, Task 4).
5. A view opened on an empty board, then tiles added in main, must show them (Task 4 manual check), and a view must open the hint not a blank page when the main window has no session.

---

### Task 1: Stable tile ids

**Files:**
- Modify: `app.js` tile constructors (`addVideo`, `addWebTile`, `addImageTile`, `addTextTile`, `addSequenceTile`: grep -an `suppressClick: false` finds the object literals, and `guard: ClickGuard.create()` from plan A), `collectSession` (every branch gets `id: t.id`), `lib/session.js` (`Session.tileId(v)`), `lib/session.test.js`

**Interfaces:**
- Produces: `tile.id` (string, `crypto.randomUUID()`), restored from a record's `id` when present and not already in use by another tile in this window, else fresh. `Session.tileId(v)` → the record's id if it is a non-empty string ≤ 64 chars, else `null`.
- Produces: `tileById(id)` in `app.js`.

- [ ] **Step 1: Test**

```js
test('tileId: a string id is kept, anything else is null', () => {
  assert.equal(Session.tileId({ id: 'abc' }), 'abc');
  assert.equal(Session.tileId({ id: 7 }), null);
  assert.equal(Session.tileId({}), null);
  assert.equal(Session.tileId({ id: 'x'.repeat(65) }), null);
});
```

- [ ] **Step 2: Fail** → `node --test lib/session.test.js`.

- [ ] **Step 3: Implement** `Session.tileId`. In `app.js` add near the helpers:

```js
const tileIds = new Set();
function newTileId(wanted) {
  const id = wanted && !tileIds.has(wanted) ? wanted : crypto.randomUUID();
  tileIds.add(id);
  return id;
}
function tileById(id) { return tiles.find((t) => t.id === id) || null; }
```

In each constructor, `id: newTileId(Session.tileId(state))` (text tiles take `record`). In `removeTile`, `tileIds.delete(tile.id)`. In `clearAll`, `tileIds.clear()`. In `collectSession`, add `id: t.id` to every branch. Paste: `pasteClipboard` must give copies fresh ids: strip `id` from the records it pastes (`const { id, ...rest } = v`) so copies are new tiles.

- [ ] **Step 4: Pass** → `npm test`.

- [ ] **Step 5: Commit** `feat: stable tile ids, saved in the session`.

---

### Task 2: Live-video budget (stills)

**Files:**
- Create: `lib/lod.js`, `lib/lod.test.js`
- Modify: `lib/settings.js` (`liveCap`), `lib/settings.test.js`, `app.js` (`addVideo`: `tile.release()` / `tile.restore()`; a `applyLiveBudget()` next to `applyOffscreen`; Optimize menu control), `index.html` (`#tile-template` canvas still, Optimize control), `style.css`

**Interfaces:**
- Produces: `Lod.choose(items, view, { minPx, cap })` where `items` is `[{ id, rect, playing, budgeted }]` in screen px and `view` is `{ x, y, w, h }` → `Set` of ids that should be live. Rules: not budgeted → always live (web tiles) but counts against `cap`; not intersecting the view → not live; `rect.h < minPx` → not live; then by distance of rect centre to view centre, nearest first, until `cap`.
- Produces: `settings.liveCap` (4 to 64, default 12). `tile.live` (bool, default true), `tile.release()`, `tile.restore()`, `tile.shadow = { time, rate, playing, at }` (the extrapolated clock while released).

- [ ] **Step 1: Tests**

```js
// lib/lod.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Lod = require('./lod');
const view = { x: 0, y: 0, w: 1000, h: 600 };
const it = (id, x, y, h = 200, extra = {}) => ({ id, rect: { x, y, w: h * 16 / 9, h }, playing: true, budgeted: true, ...extra });

test('off-screen and tiny tiles are stills', () => {
  const live = Lod.choose([it(1, 2000, 0), it(2, 0, 0, 40), it(3, 100, 100)], view, { minPx: 96, cap: 12 });
  assert.deepEqual([...live], [3]);
});
test('the cap keeps the ones nearest the centre', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(it(i, i * 160, 200, 150));  // a row across the view; centre x=500
  const live = Lod.choose(items, view, { minPx: 96, cap: 3 });
  assert.equal(live.size, 3);
  assert.ok(live.has(2) && live.has(3));
});
test('unbudgeted tiles are always live but use up the cap', () => {
  const live = Lod.choose([it('web', 0, 0, 200, { budgeted: false }), it(1, 300, 0), it(2, 600, 0)], view, { minPx: 96, cap: 2 });
  assert.ok(live.has('web'));
  assert.equal(live.size, 2);
});
test('paused tiles still count: a paused visible tile is live (it is cheap, but a swap costs a seek)', () => {
  const live = Lod.choose([it(1, 0, 0, 200, { playing: false })], view, { minPx: 96, cap: 12 });
  assert.ok(live.has(1));
});
```

Settings test: `liveCap` default 12, clamped 4..64.

- [ ] **Step 2: Fail.**

- [ ] **Step 3: Implement**

```js
// lib/lod.js
// Which videos a window should actually decode. Everything else is a still of its last frame.
// Off-screen or tiny tiles never decode; among the rest the ones nearest the middle of the view
// win until the cap. Web embeds cannot be stilled, so they are always live but count.
{
  const Lod = {
    choose(items, view, { minPx = 96, cap = 12 } = {}) {
      const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
      const live = new Set();
      let used = 0;
      const vis = (r) => r.x < view.x + view.w && r.x + r.w > view.x && r.y < view.y + view.h && r.y + r.h > view.y;
      for (const i of items) if (!i.budgeted) { live.add(i.id); used++; }
      const cands = items.filter((i) => i.budgeted && vis(i.rect) && i.rect.h >= minPx)
        .map((i) => ({ i, d: Math.hypot(i.rect.x + i.rect.w / 2 - cx, i.rect.y + i.rect.h / 2 - cy) }))
        .sort((a, b) => a.d - b.d);
      for (const c of cands) { if (used >= cap) break; live.add(c.i.id); used++; }
      return live;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Lod;
  else window.Lod = Lod;
}
```

`index.html` `#tile-template`: after `<video ...>` add `<canvas class="still" hidden></canvas>`. `style.css`: `.tile canvas.still { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; } .tile.still video { visibility: hidden; } .tile.still.playing-still::after { content: '▶'; position: absolute; left: 8px; bottom: 8px; color: #fff; opacity: 0.6; font-size: 14px; }`.

`addVideo`, after the quality helpers:

```js
  // Live budget: a still is the last frame copied to a canvas; the <video> drops its source so the
  // decoder is freed. The board's idea of time keeps advancing in `shadow` so restore lands right.
  const still = el.querySelector('canvas.still');
  tile.live = true;
  tile.shadow = null;
  tile.release = () => {
    if (!tile.live) return;
    try {
      if (video.videoWidth) { still.width = video.videoWidth; still.height = video.videoHeight; still.getContext('2d').drawImage(video, 0, 0); }
    } catch {}
    tile.shadow = { time: video.currentTime || 0, rate: video.playbackRate || 1, playing: !video.paused, at: performance.now() };
    tile.releasedSrc = video.currentSrc || video.src;
    video.removeAttribute('src'); video.load();
    still.hidden = false; el.classList.add('still'); el.classList.toggle('playing-still', tile.shadow.playing);
    tile.live = false;
  };
  tile.shadowTime = () => (tile.shadow ? tile.shadow.time + (tile.shadow.playing ? (performance.now() - tile.shadow.at) / 1000 * tile.shadow.rate : 0) : video.currentTime);
  tile.restore = () => {
    if (tile.live) return;
    const s = tile.shadow; tile.shadow = null;
    const at = Math.min(tile.shadowTime(), tile.info && tile.info.duration ? tile.info.duration : Infinity);
    const once = () => {
      video.removeEventListener('loadedmetadata', once);
      if (at > 0) video.currentTime = isFinite(video.duration) ? Math.min(at, video.duration) : at;
      video.playbackRate = s.rate;
      if (s.playing) video.play().catch(() => {});
      still.hidden = true; el.classList.remove('still', 'playing-still');
    };
    video.addEventListener('loadedmetadata', once);
    tile.setSource(tile.releasedSrc);
    tile.live = true;
  };
```

Note `tile.shadowTime` must read the shadow before `restore` clears it; order the lines so `at` is computed first (as written). `tile.pb` is what the rest of the app reads for time/paused; make `videoPlayback` consult the shadow when released: in `videoPlayback(video)` the tile is not known, so instead give `addVideo` a wrapper: after `pb: videoPlayback(video)` is built, override `tile.pb` with an object whose getters check `tile.live` (time → `tile.shadowTime()`, paused → `!tile.shadow.playing`, `play()`/`pause()` → update `tile.shadow.playing` and `at`/`time` when released, else forward). Keep it in `app.js` next to `videoPlayback` as `budgetedPlayback(tile, inner)`.

`applyLiveBudget()` next to `applyOffscreen`, called from the same hooks and the 500 ms interval, before `applyOffscreen`:

```js
function applyLiveBudget() {
  if (!isBoard() && !document.body.classList.contains('mode-gallery')) return;
  const r = gridRect();
  const view = { x: r.left, y: r.top, w: r.width, h: r.height };
  const items = tiles.filter((t) => t.el.isConnected && (isBoard() ? !!t.board : !t.freeAspect)).map((t) => {
    const b = t.el.getBoundingClientRect();
    return { id: t.id, rect: { x: b.left, y: b.top, w: b.width, h: b.height }, playing: !!(t.pb && !t.pb.paused), budgeted: !!t.release };
  });
  const live = Lod.choose(items, view, { minPx: LIVE_MIN_PX, cap: settings.liveCap });
  for (const t of tiles) { if (!t.release) continue; if (live.has(t.id)) { if (!t.live) t.restore(); } else if (t.live) t.release(); }
}
```

`const LIVE_MIN_PX = 96;`. Offscreen pause: in `applyOffscreen`, skip tiles that have `t.release` (local videos are now handled by the budget); keep it for web and sequence tiles. Compare view and fullscreen: force-restore the tiles they show (`hoverPlayBusy()` sites). Optimize ▾: `<label class="menu-check">Live videos per window <input type="number" id="opt-livecap" min="4" max="64" style="width:5em"></label>` wired to `settings.liveCap` + `applyLiveBudget()`.

`collectSession` for a released tile must write `currentTime: t.pb.time` and `paused: t.pb.paused` through the wrapper, so saving a board with stills saves the right times. The load strip's `tileState` gains `'still'` when `!t.live`.

- [ ] **Step 4: Pass** → `npm test`.

- [ ] **Step 5: Manual check** (isolated profile, CDP): 20 clips playing, cap 12: twelve are live (count `tiles.filter(t=>t.live)`), the rest show their frame and a ▶ badge; zoom out until tiles are under 96 px: all become stills, `document.querySelectorAll('video[src]').length` drops to 0, the load strip's Ozy memory falls; zoom back in: tiles restore within a second at the right times (compare `pb.time` before and after; a playing tile's time advanced while still). Save with stills, reopen: times correct. Close.

- [ ] **Step 6: Commit** `feat: live-video budget turns small or surplus videos into stills`.

---

### Task 3: Snapshot diff rules

**Files:**
- Create: `lib/snapshot.js`, `lib/snapshot.test.js`

**Interfaces:**
- Produces: `Snapshot.diff(current, incoming)` where `current` is `[{ id, board, groupId }]` (what the view has) and `incoming` is the snapshot `{ seq, videos: [records with id and board], groups: [{ id, members: [ids], sticky, sync, ... }] }` → `{ add: [records], remove: [ids], move: [{ id, board }], regroup: [{ id (group), members, opts }] | null }`.
- Produces: `Snapshot.accept(lastSeq, seq)` → `true` when `seq > lastSeq`.

- [ ] **Step 1: Tests**

```js
test('diff: adds, removes, moves', () => {
  const d = Snapshot.diff(
    [{ id: 'a', board: { x: 0, y: 0, w: 1, h: 1 } }, { id: 'b', board: { x: 0, y: 0, w: 1, h: 1 } }],
    { seq: 2, videos: [{ id: 'a', board: { x: 5, y: 0, w: 1, h: 1 } }, { id: 'c', board: { x: 0, y: 0, w: 2, h: 2 } }], groups: [] });
  assert.deepEqual(d.add.map((r) => r.id), ['c']);
  assert.deepEqual(d.remove, ['b']);
  assert.deepEqual(d.move, [{ id: 'a', board: { x: 5, y: 0, w: 1, h: 1 } }]);
});
test('diff: unchanged rects are not moves', () => { /* same rect -> move [] */ });
test('diff: groups come through as member id lists', () => { /* groups: [{id:1, members:[0,1]}] with videos a,b -> regroup [{id:1, members:['a','b']}] */ });
test('stale snapshot ignored', () => { assert.equal(Snapshot.accept(5, 4), false); assert.equal(Snapshot.accept(5, 6), true); });
```

Write the two sketched tests out in full.

- [ ] **Step 2: Fail.** **Step 3: Implement** (pure, straightforward; group `members` in `collectSession` are indices into `videos`, so map them to ids). **Step 4: Pass.** **Step 5: Commit** `feat: snapshot diff rules for view windows`.

---

### Task 4: View windows and the bus

**Files:**
- Modify: `main.js` (view windows, `bus` relay, `open-view`, `close-view`, window bookkeeping), `preload.js` (`bus`, `onBus`, `openView`, `viewNumber`), `index.html` (Window ▾ menu), `app.js` (`window.OZY_VIEW`, view gating, snapshot send/apply)

**Interfaces:**
- Produces in `main.js`: `views = new Map()` (n → BrowserWindow), `ipcMain.handle('open-view', (e, n, bounds))`, `ipcMain.on('bus', (e, msg))` → `for every Ozy window w != sender: w.webContents.send('bus', msg)` with `isDestroyed()` guards; `snapshot-request` goes to `win` only. Views load `index.html?view=N`. `win.on('closed')` closes views.
- Produces in `preload.js`: `bus: (msg) => ipcRenderer.send('bus', msg)`, `onBus: (cb) => ipcRenderer.on('bus', (_e, m) => cb(m))`, `openView: (n, bounds) => ipcRenderer.invoke('open-view', n, bounds)`, `viewNumber: () => Number(new URLSearchParams(location.search).get('view') || 0)`.
- Produces in `app.js`: `window.OZY_VIEW` (0 main, 1 or 2 view) set at the very top; `document.body.classList.add('view')` when > 0; `sendSnapshot()` (debounced 100 ms; `seq` increments) called from `finishRects`, `recordAdd`, `recordRemove`, `createGroup`/`dissolveGroup`/`removeFromGroup`, `setGroupSync`, the sticky toggle, `applySession` end, `clearAll`, and tier/quality changes; `applySnapshot(msg)` in views.

- [ ] **Step 1: main + preload** as above. Views: `new BrowserWindow({ ...same webPreferences, width: 1100, height: 700, title: 'Ozy view N' })`, `loadURL(http://127.0.0.1:${uiPort}/index.html?view=${n})`. Cap: refuse `n` not in {1, 2} or already open (focus it instead). `second-instance`/`open-file` keep targeting `win`.

- [ ] **Step 2: Gating in app.js.** At the top: `window.OZY_VIEW = window.api.viewNumber(); const IS_VIEW = window.OZY_VIEW > 0;`. In a view: hide with CSS `body.view .main-only { display: none }` and add `main-only` to: Add videos, Open/Save/Save as, Clear board, Group/Ungroup, Tidy menu, Linked, A/B, text toolbar, tile ✕ and ⚙ buttons, group bar edit controls (name, swatch, sticky, sync, loop, ungroup; keep play/mute/volume/rate), the `.handle`s. In code, early-return when `IS_VIEW` in: `attachTileDrag` (no drags at all; keep click-to-play through `tileClick`), `startResize`, `startSwapDrag`, every tidy function, `createGroup`, `removeTile` (unless called by `applySnapshot`), `pasteClipboard`, `copySelection` is fine, keyboard handlers for those actions, drop handlers (`drop` on the grid), `openSession`/`saveSession`. The lasso stays (selection is allowed). Undo/redo in a view: disabled (`undoStack` operations return).

- [ ] **Step 3: Snapshots.** Main: `function sendSnapshot() { clearTimeout(snapTimer); snapTimer = setTimeout(() => { const s = collectSession(); window.api.bus({ type: 'snapshot', seq: ++snapSeq, videos: s.videos, groups: s.groups, layout: { mode: layout.mode, quality: layout.quality } }); }, 100); }`. Also answer `snapshot-request` by sending immediately. View: on load send `{ type: 'snapshot-request' }`; on `snapshot`: if `!Snapshot.accept(lastSeq, msg.seq)` return; `lastSeq = msg.seq`; compute `Snapshot.diff(...)`; apply: remove → `removeTile(t, { record: false, fromSnapshot: true })`; add → `buildFromRecord(Session.openRecord(rec))` (built paused; then the clock catches it up); move → set `t.board` and `layoutTile`; regroup → dissolve all groups and recreate from the snapshot (`createGroup(members, opts)` with `fromSnapshot: true` so it does not echo); mode → `setMode` if different. After applying: `layoutTiles(); markOnBoard(); renderTimeline(); applyLiveBudget();`. A view never calls `sendSnapshot`.

- [ ] **Step 4: Window menu.** `index.html`: `<div class="menu main-only" id="window-menu"><button id="btn-window">Window ▾</button><div class="menu-list" hidden><button id="win-view-1">New view 1</button><button id="win-view-2">New view 2</button></div></div>`; `app.js` wires to `window.api.openView(n)`. Title bar of a view: `Ozy view N – <session name>` (reuse `updateChrome`).

- [ ] **Step 5: Manual check** (two windows over one CDP port): open a board with eight clips in main; Window ▾ → New view 1: the view shows the same eight at the same places; move a tile in main: the view follows within 200 ms; add and remove tiles: the view follows; group two: the view shows the swatch; in the view, drag does nothing, ✕ and ⚙ are absent, Tidy absent; close the view: main unaffected; open a view on an empty board, add clips in main: the view shows them. Close everything.

- [ ] **Step 6: Commit** `feat: view windows, a camera on the same board, with layout mirrored from the main window`.

---

### Task 5: Playback mirroring and the clock

**Files:**
- Modify: `app.js` (`budgetedPlayback`/`videoPlayback`/`ytPlayback` call sites: `tile.togglePlay`, `seekTo`, scrub commit, `stepFrame`, rate select, group bar play/pause, `playTile`/`pauseTile`, timeline scrub; a `remote` guard), `lib/snapshot.js` (`Snapshot.clockFix(local, remote, tol)` → seconds to seek or `null`), `lib/snapshot.test.js`

**Interfaces:**
- Produces: `emitPlayback(tile, op, value)` → `window.api.bus({ type: 'playback', id: tile.id, op: 'play'|'pause'|'seek'|'scrub'|'rate', value, time })` unless `applyingRemote`. `applyPlayback(msg)`: find tile by id; set `applyingRemote = true`; apply through `tile.pb` (seek → `pb.time = value`; play → `pb.time = value` if given then `pb.play()`; etc.); `finally applyingRemote = false`.
- Produces: main window `setInterval(1000)` → `{ type: 'clock', times: { [id]: pb.time } }` for playing local tiles; a view applies `Snapshot.clockFix(pb.time, t, 0.25)` by seeking when non-null and the tile is live and not scrubbing.
- Views do not run the drift/loop engine: wrap the 10 Hz `setInterval` body (grep -an `Runs 10x a second`) in `if (IS_VIEW) return;`. Group actions in a view: `broadcast` still expands to members locally (so the view feels immediate) and each member op is emitted; the main window applies them per member, which is consistent because the engine in main only corrects drift.

- [ ] **Step 1: Test** `clockFix`: `assert.equal(Snapshot.clockFix(10.0, 10.1, 0.25), null); assert.equal(Snapshot.clockFix(10.0, 10.6, 0.25), 10.6);`.

- [ ] **Step 2: Fail. Step 3: Implement.** Instrument every user-initiated playback path (list above; grep -an `togglePlay\|seekTo(\|stepFrame\|\.rate = \|playTile\|pauseTile\|pbScrub`) with `emitPlayback`. Keep the hover-play and EZ-play paths covered because they call `togglePlay`/`pb.play`. Do not emit from the drift engine or from `applyOffscreen`/`applyLiveBudget` (those are per-window). `applyPlayback` on a released (still) tile updates its `shadow` through the wrapper so it restores right.

- [ ] **Step 4: Pass. Step 5: Manual check** (two windows): play in main → view plays within 100 ms, times within 0.25 s after 10 s; pause in the view → main pauses; scrub in the view → main follows; step a frame in main → view matches; group play from the view's group bar → both members in both windows; zoom the view out so its tiles are stills → main unaffected, view's badge shows ▶ on the playing stills; zoom back in → view resumes at the right time. Log one bus message per action (no bounce). Close everything.

- [ ] **Step 6: Commit** `feat: playback mirrored across windows with a once-a-second clock`.

---

### Task 6: Views in the session file

**Files:**
- Modify: `app.js` (`collectSession` layout.views; `applySession` reopens views; view sends `view-state` on pan/zoom end and before unload), `main.js` (`open-view` takes bounds; `view-state` bookkeeping lives in the main window's renderer, not main), `lib/session.js` (`Session.views(raw)` validation), `lib/session.test.js`

**Interfaces:**
- Produces: `layout.views: [{ n, bounds: { x, y, w, h }, panX, panY, zoom }]`; `Session.views(raw)` → validated array (≤ 2, numbers finite, zoom clamped) or `[]`.

- [ ] **Step 1: Test** `Session.views` (junk → [], three entries → two, zoom clamped).
- [ ] **Step 2–4:** implement; view windows send `{ type: 'view-state', n, bounds: await window.api.viewBounds(), panX, panY, zoom }` (add `viewBounds` to preload via `ipcMain.handle('view-bounds')` returning `BrowserWindow.fromWebContents(e.sender).getBounds()`); the main window keeps the latest per `n` in `viewStates` and writes them in `collectSession`. On `applySession`, after tiles load, for each saved view call `window.api.openView(n, bounds)` and, once that view sends `snapshot-request`, include `{ panX, panY, zoom }` in the snapshot reply as `viewHint[n]`; the view applies it once.
- [ ] **Step 5: Manual check**: open a view, move it to a second position/size, zoom it, save; reopen the session: the view comes back where it was with its zoom. Close.
- [ ] **Step 6: Commit** `feat: views are remembered in the session file`.

---

### Task 7: Hand-off

- [ ] `npm test` green; push; worktree removed if used. Reply to the hub (`scott fable windows 1 (work here)`) with commits, changes from the plan and why, the two-window checks you ran, and what you could not verify (a second physical monitor, macOS).
