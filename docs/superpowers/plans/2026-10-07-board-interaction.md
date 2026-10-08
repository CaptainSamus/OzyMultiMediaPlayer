# Board Interaction Implementation Plan (plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make board selection, click-to-play, tidy, resize snapping, group scaling and in-group rearranging behave the way Mark described, without touching the performance work running in parallel.

**Architecture:** Every rule lives in a small pure module under `lib/` with `node --test` coverage (the repo's pattern: `lib/arrange.js`, `lib/hoverplay.js`, `lib/clipboard.js`); `app.js` only wires pointer events to those modules. New modules: `lib/select.js`, `lib/clickguard.js`, `lib/snap.js`, `lib/swap.js`; extensions to `lib/arrange.js` and `lib/settings.js`.

**Tech Stack:** Vanilla JS, Electron 33, `node --test` (`npm test`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-board-polish-and-performance-design.md`

## Global Constraints

- Branch `feat/board-interaction` from `main` (`aab619e`). One commit per task. No version bump, tag, release or PR.
- Pure logic in `lib/*.js`, exported with `if (typeof module !== 'undefined' && module.exports) module.exports = X; else window.X = X;`, tests in `lib/<name>.test.js`, run with `npm test`.
- Every new lib file must be added to `index.html` as `<script src="lib/<name>.js"></script>` before `app.js` (see the block near `index.html:403`).
- `app.js` has a NUL byte near offset 175927: search it with `grep -an` and `sed -n`, never plain `grep`/ripgrep. Line numbers below are for `main` at `aab619e`; re-locate with `grep -an` before editing.
- Cut behaviour by commenting out in place, never deleting.
- Manual checks run the app with a separate profile: `./node_modules/.bin/electron . --user-data-dir=<scratchpad>/ozy-userdata --remote-debugging-port=9333`, never Mark's running instance. Close every window you open. The CDP recipe is in memory note `ozy-manual-checks-via-cdp` (fetch `/json/list`, `Runtime.evaluate`, keep each evaluate short).
- Plan B (`feat/performance`) edits `app.js` too, in `addVideo` (source loading), `pasteClipboard`, `applySession`, the App/Optimize menus, `collectSession`'s `layout` and file-tile branches, and `lib/settings.js`. Stay out of those regions except where a task below names them, so sonnet's merge stays clean. Where both plans edit `lib/settings.js` defaults, add your key on its own line.

## Review Focus

1. A plain click on a selected tile inside a multi-selection must not collapse the selection (Task 1 test `keeps a multi-selection on a plain click`).
2. A click that follows a drag must not toggle play, and the next clean click must (Task 2 test `the guard is consumed by one click`).
3. Resize snapping must never pick a candidate from the tile being resized or from a tile that is also being scaled with it (Task 4 test `ignores excluded tiles`).
4. Group scaling must stop at the member that would hit the size limits, not the dragged tile only (Task 5 test `clampFactor respects the smallest and largest member`).
5. A swap drag released over empty space, over a non-member, or cancelled (lost capture) must put the tile back exactly where it started, and an Alt-drag that is not a swap must still pan (Task 6 test `no target means no change`, `isSwapDrag`, and the manual check).

---

### Task 1: A plain click selects one tile

**Files:**
- Create: `lib/select.js`, `lib/select.test.js`
- Modify: `app.js:1476-1493` (`attachTileDrag` pointerdown), `index.html` script list
- Modify: `index.html:150` (Sticky tooltip wording)

**Interfaces:**
- Produces: `Select.onPointerDown({ inSelection, grouped, sticky, mod, shift })` → `'toggle' | 'only' | 'group' | 'keep'`.

- [ ] **Step 1: Write the failing test**

```js
// lib/select.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Select = require('./select');

test('shift toggles, whatever else is true', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: true, mod: false, shift: true }), 'toggle');
  assert.equal(Select.onPointerDown({ inSelection: true, grouped: false, sticky: false, mod: true, shift: true }), 'toggle');
});
test('ctrl/cmd picks just this tile, even inside a sticky group', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: true, mod: true, shift: false }), 'only');
});
test('a plain click on an ungrouped tile selects just it (the thing that was missing)', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: false, sticky: false, mod: false, shift: false }), 'only');
});
test('a plain click on a non-sticky group member selects just it', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: false, mod: false, shift: false }), 'only');
});
test('a plain click on a sticky member selects the whole group', () => {
  assert.equal(Select.onPointerDown({ inSelection: false, grouped: true, sticky: true, mod: false, shift: false }), 'group');
});
test('keeps a multi-selection on a plain click', () => {
  assert.equal(Select.onPointerDown({ inSelection: true, grouped: false, sticky: false, mod: false, shift: false }), 'keep');
  assert.equal(Select.onPointerDown({ inSelection: true, grouped: true, sticky: true, mod: false, shift: false }), 'keep');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/select.test.js`
Expected: FAIL, `Cannot find module './select'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/select.js
// What a pointerdown on a board tile does to the selection. Pure, so the one rule Mark asked for
// (a plain click picks one tile) sits next to the ones that already existed and can't drift.
{
  const Select = {
    // inSelection: the tile is already selected; grouped/sticky: its group, if any; mod: Ctrl/Cmd
    onPointerDown({ inSelection, grouped, sticky, mod, shift }) {
      if (shift) return 'toggle';
      if (mod) return 'only';
      if (inSelection) return 'keep';          // a drag will move everything selected
      if (grouped && sticky) return 'group';   // the group's bar should show
      return 'only';
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Select;
  else window.Select = Select;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/select.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it in `attachTileDrag`**

Add `<script src="lib/select.js"></script>` to `index.html` next to the other lib scripts (before `app.js`).

In `app.js` `attachTileDrag`, replace the block from `if (e.shiftKey) {` down to `else if (tile.group && !selection.has(tile)) selectGroupOf(tile);` with:

```js
    const action = Select.onPointerDown({
      inSelection: selection.has(tile), grouped: !!tile.group, sticky: !!(tile.group && tile.group.sticky),
      mod: modKey(e), shift: e.shiftKey,
    });
    if (action === 'toggle') {
      // shift-click toggles membership without starting a drag
      setSelected(tile, !selection.has(tile));
      selectionStatus();
      tile.suppressClick = true;
      setTimeout(() => { tile.suppressClick = false; }, 0);
      return;
    }
    // Ctrl: just this tile, even inside a sticky group. A plain click picks one tile, or a sticky
    // member's whole group (so its settings bar shows); a click inside the selection keeps it.
    const single = modKey(e);
    if (action === 'only') selectOnly(tile);
    else if (action === 'group') selectGroupOf(tile);
```

(`single` is still used further down in `onMove`; keep it.) Task 2 changes the `suppressClick` lines again; leave them as they are for now.

- [ ] **Step 6: Manual check**

Start the app with the isolated profile, add three local videos to the board, group two of them with Sticky on. Plain click the ungrouped one: it gets the selected outline alone. Plain click a sticky member: both members select and the group bar shows. Lasso all three, then plain click one of them: all three stay selected. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/select.js lib/select.test.js app.js index.html
git commit -m "feat: a plain click selects one board tile"
```

---

### Task 2: Click-to-play is reliable, plus EZ play

**Files:**
- Create: `lib/clickguard.js`, `lib/clickguard.test.js`
- Modify: `app.js` — `attachTileDrag` (`suppressClick` sites), the `video` click handler at `~2011`, the `el` click handlers at `~2017` and `~2637`, web tile `.pan-shield` wiring near `~2640`, the hover-play toolbar wiring at `~4380`
- Modify: `lib/settings.js` (`ezPlay` default + merge), `index.html:42` (toolbar button), `style.css` (`.pan-shield` rule near line 711)

**Interfaces:**
- Produces: `ClickGuard.create()` → `{ afterDrag(), pointerDown(), shouldAct() }`. `shouldAct()` returns `false` exactly once after `afterDrag()`, then `true`; `pointerDown()` clears the guard.
- Produces: `settings.ezPlay` (boolean), `setEzPlay(on)` in `app.js`, body class `ez-play`.
- Produces: `ClickGuard.isControl(selectorMatch)` — see Step 3.

- [ ] **Step 1: Write the failing test**

```js
// lib/clickguard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ClickGuard = require('./clickguard');

test('a clean click acts', () => {
  const g = ClickGuard.create();
  assert.equal(g.shouldAct(), true);
});
test('the guard is consumed by one click', () => {
  const g = ClickGuard.create();
  g.afterDrag();
  assert.equal(g.shouldAct(), false); // the click that ends a drag
  assert.equal(g.shouldAct(), true);  // the next real click
});
test('a new press clears a stale guard', () => {
  const g = ClickGuard.create();
  g.afterDrag();
  g.pointerDown();                     // the click after the drag never came (release over an embed)
  assert.equal(g.shouldAct(), true);
});
test('ezTarget: controls never count as the picture', () => {
  const hit = (sel) => ['button', '.seek', '.vol-zone'].includes(sel);
  assert.equal(ClickGuard.ezTarget(hit), false);
  assert.equal(ClickGuard.ezTarget(() => false), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/clickguard.test.js`
Expected: FAIL, `Cannot find module './clickguard'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/clickguard.js
// "Did that click end a drag, or is it a real click?" The old flag was cleared by a setTimeout(0)
// that fired before the click arrived, so a drag's release could toggle play. This one is consumed
// by the click itself, and a fresh press clears it in case that click never came.
{
  const CONTROLS = ['button', 'input', 'select', '.seek', '.markers', '.vol-zone', '.bm-panel', '.error', '.handle', '.text-body'];
  const ClickGuard = {
    create() {
      let armed = false;
      return {
        afterDrag() { armed = true; },
        pointerDown() { armed = false; },
        shouldAct() { if (armed) { armed = false; return false; } return true; },
      };
    },
    // EZ play: a click counts as "on the picture" unless it landed on a control. `closest` is
    // (selector) => boolean, usually (s) => !!e.target.closest(s).
    ezTarget(closest) { return !CONTROLS.some((s) => closest(s)); },
    CONTROLS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ClickGuard;
  else window.ClickGuard = ClickGuard;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/clickguard.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Replace `suppressClick` with the guard**

Add `<script src="lib/clickguard.js"></script>` to `index.html`.

In `addVideo` (`app.js:~1830`) the tile object has `suppressClick: false`; add `guard: ClickGuard.create()` beside it. Do the same in `addWebTile` (`~2249`), `addImageTile` (`~2682`), `addSequenceTile` (`~3061`) and `addTextTile` (`~2743`) wherever the tile object is built (grep -an `suppressClick` to find them all; every tile that has `suppressClick` gets `guard`).

In `attachTileDrag`:
- At the top of the pointerdown handler, right after the early returns, add `tile.guard.pointerDown();`.
- In the shift branch, replace `tile.suppressClick = true; setTimeout(() => { tile.suppressClick = false; }, 0);` with `tile.guard.afterDrag();` (a shift-click must not play either).
- In `onUp`, replace the same two lines inside `if (moving) {` with `tile.guard.afterDrag();`.

Local video click handler (`~2011`):

```js
  video.addEventListener('click', (e) => {
    if (e.shiftKey) return;              // selects (board: attachTileDrag; gallery: the el click below), never plays
    if (!tile.guard.shouldAct()) return; // this click ended a drag
    tile.togglePlay();
  });
```

Apply the same two-line change to the web stream `<video>` click (`~2523`) and the sequence canvas click (`~3343`), which currently test `tile.suppressClick`. Leave the `suppressClick` property on the tile objects (commented `// kept for older code paths`) so nothing else breaks; grep -an to confirm no remaining reader.

- [ ] **Step 6: EZ play setting and button**

`lib/settings.js`: in `defaults()` add `ezPlay: false`; in `merge()` add `ezPlay: s.ezPlay === true,` on its own line under `hoverPlay`. Add to `lib/settings.test.js`:

```js
test('ezPlay defaults off and only true turns it on', () => {
  assert.equal(S.merge({}).ezPlay, false);
  assert.equal(S.merge({ ezPlay: 'yes' }).ezPlay, false);
  assert.equal(S.merge({ ezPlay: true }).ezPlay, true);
});
```

`index.html:42`, after the Hover play button:

```html
    <button id="ez-play" title="EZ play: click anywhere on a video to play or pause it (the controls still work). For YouTube tiles the click lands on Ozy, so the embed's own controls are off while this is on.">EZ play</button>
```

`app.js`, after `hoverPlayBtn.addEventListener(...)` (`~4393`):

```js
// ---------- EZ play ----------
// A click anywhere on a tile that is not a control plays or pauses it. The picture already does
// this; EZ play extends it to the overlay bars and, for embeds, to a shield over the iframe.
const ezPlayBtn = document.getElementById('ez-play');
const ezPlayOn = () => !!(settings && settings.ezPlay);
function setEzPlay(on) {
  settings.ezPlay = !!on;
  saveSettings();
  ezPlayBtn.classList.toggle('toggled', settings.ezPlay);
  document.body.classList.toggle('ez-play', settings.ezPlay);
  setStatus(settings.ezPlay ? 'EZ play on: click anywhere on a video to play or pause it' : 'EZ play off');
}
ezPlayBtn.addEventListener('click', () => setEzPlay(!ezPlayOn()));
// a click on a tile's chrome (not a control, not the picture, which handles itself)
function ezClick(tile, e) {
  if (!ezPlayOn() || e.shiftKey || !tile.pb) return;
  if (e.target === tile.mediaEl) return; // the picture's own click handler already toggled
  if (!ClickGuard.ezTarget((s) => !!e.target.closest(s))) return;
  if (!tile.guard.shouldAct()) return;
  if (tile.togglePlay) tile.togglePlay(); else { if (tile.pb.paused) tile.pb.play(); else tile.pb.pause(); }
}
```

Where settings are first applied after load (grep -an `hoverPlayBtn.classList.toggle` or the settings-load block near `~4022-4040` that sets `wheelZoomEl.checked`), add `ezPlayBtn.classList.toggle('toggled', settings.ezPlay); document.body.classList.toggle('ez-play', settings.ezPlay);`.

In `addVideo`'s `el` click handler (`~2017`) and the web tile's (`~2637`), add `ezClick(tile, e);` as the first line (before the gallery shift-select return). Add the same `el.addEventListener('click', (e) => ezClick(tile, e));` in `addSequenceTile` and `addImageTile` if they have no `el` click handler (images have no `pb`, so `ezClick` returns early; that is fine).

Web tiles: the `.pan-shield` already covers the iframe. `style.css` after the `.pan-shield` rules (`~712`):

```css
/* EZ play: the shield takes the click so Ozy, not the embed, plays or pauses */
body.ez-play .tile.web .pan-shield { pointer-events: auto; cursor: pointer; }
```

In `addWebTile`, the shield is in the web template (`index.html:360`) and is not queried by `app.js` yet. After the template is cloned add:

```js
  const shield = el.querySelector('.pan-shield');
  if (shield) shield.addEventListener('click', (e) => { if (!board.hand) ezClick(tile, e); });
```

(`ezClick` skips when the target is the media element; the shield is not, so it toggles.)

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Manual check**

Isolated profile. Add a local video to the board. Drag it 100 px and release: it does not start playing. Click its picture: it plays. Click again: it pauses. Turn EZ play on: click the empty part of the top bar: it toggles play; click the seek bar: it scrubs, no toggle. Add a YouTube tile in Player mode: with EZ play on, click the picture: it plays/pauses; with EZ play off, the embed's own controls work again. Close the app.

- [ ] **Step 9: Commit**

```bash
git add lib/clickguard.js lib/clickguard.test.js lib/settings.js lib/settings.test.js app.js index.html style.css
git commit -m "feat: reliable click-to-play and an EZ play mode"
```

---

### Task 3: Tidy acts on the selection; Tidy group

**Files:**
- Modify: `lib/arrange.js` (add `flowAtHeight`), `lib/arrange.test.js`
- Modify: `app.js:3943-3965` (Tidy menu functions), `app.js:~3979-3980` (menu wiring), group bar wiring near `app.js:~575-585`
- Modify: `index.html:69-70` (menu labels), `index.html:150-161` (group bar button)

**Interfaces:**
- Produces: `Arrange.flowAtHeight(items /*[{aspect}]*/, height, W, gap)` → rects; never null, a tile wider than W sits on its own row.
- Produces: `tidyTargets()` in `app.js` → `{ list, scoped }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/arrange.test.js`:

```js
test('flowAtHeight: one height, wraps at W, never refuses', () => {
  const r = A.flowAtHeight([{ aspect: 2 }, { aspect: 2 }, { aspect: 2 }], 100, 450, 10);
  assert.deepEqual(r[0], { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(r[1], { x: 210, y: 0, w: 200, h: 100 });
  assert.deepEqual(r[2], { x: 0, y: 110, w: 200, h: 100 });   // third wraps: 420 + 10 + 200 > 450
});
test('flowAtHeight: a tile wider than the box gets its own row instead of null', () => {
  const r = A.flowAtHeight([{ aspect: 1 }, { aspect: 4 }, { aspect: 1 }], 100, 250, 0);
  assert.equal(r.length, 3);
  assert.equal(r[1].y, 100);
  assert.equal(r[2].y, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/arrange.test.js`
Expected: FAIL, `A.flowAtHeight is not a function`.

- [ ] **Step 3: Implement**

Add to `Arrange` in `lib/arrange.js`:

```js
  // Tidy the selection: every tile this one height, wrapped at the selection's own width. Unlike
  // flow() it never refuses - a tile wider than W just takes a row to itself - because here the
  // box is the tiles' own bounding box, not a view they have to fit.
  flowAtHeight(items, height, W, gap) {
    const rects = []; let x = 0, y = 0;
    for (const it of items) {
      const w = height * it.aspect;
      if (x > 0 && x + gap + w > W + 0.01) { x = 0; y += height + gap; }
      if (x > 0) x += gap;
      rects.push({ x, y, w, h: height });
      x += w;
    }
    return rects;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/arrange.test.js`
Expected: PASS.

- [ ] **Step 5: Tidy functions act on the selection**

Replace `tidyFitToView` and `tidyGrid` in `app.js` (`~3946-3965`) with:

```js
// the tiles a Tidy entry works on: the selection when there is one, else the whole board
function tidyTargets() {
  const all = boardTilesInOrder();
  const sel = all.filter((t) => selection.has(t));
  return sel.length ? { list: sel, scoped: true } : { list: all, scoped: false };
}
// Fit: every tile the same height. Whole board: the largest that flow-wraps inside the view.
// Selection: the mean of their current heights, wrapped at the selection's own width, so the
// rest of the board is untouched (undo = resize).
function tidyFitToView() {
  // text tiles size themselves from their text, so they sit this one out and keep their own box
  const { list: targets, scoped } = tidyTargets();
  const list = targets.filter((t) => !t.freeAspect); if (!list.length) return;
  const entry = recordResize(list);
  if (scoped) {
    const bb = boardBounds(list);
    const height = list.reduce((s, t) => s + t.board.h, 0) / list.length;
    const rects = Arrange.flowAtHeight(list.map((t) => ({ aspect: t.aspect })), height, bb.w, GAP);
    list.forEach((t, i) => { t.board = { x: bb.minX + rects[i].x, y: bb.minY + rects[i].y, w: rects[i].w, h: rects[i].h }; layoutTile(t); });
    finishRects(entry); setStatus(`Tidied ${list.length} selected videos`);
    return;
  }
  const r = gridRect(); const W = (r.width - 2 * GAP) / board.zoom, H = (r.height - 2 * GAP) / board.zoom;
  const origin = toCanvas(r.left + GAP, r.top + GAP);
  const { rects } = Arrange.fitToView(list.map((t) => ({ aspect: t.aspect })), W, H, GAP);
  list.forEach((t, i) => { t.board = { x: origin.x + rects[i].x, y: origin.y + rects[i].y, w: rects[i].w, h: rects[i].h }; layoutTile(t); });
  finishRects(entry); setStatus('Arranged to fit the view');
}
// Grid: sizes kept, ceil(sqrt(n)) columns edge to edge from the block's top-left. Whole board:
// then frame it. Selection: leave the view alone (undo = move).
function tidyGrid() {
  const { list, scoped } = tidyTargets(); if (!list.length) return;
  const entry = recordMove(list);
  const bb = boardBounds(list);
  const rects = Arrange.grid(list.map((t) => ({ w: t.board.w, h: t.board.h })), 0);
  list.forEach((t, i) => { t.board.x = bb.minX + rects[i].x; t.board.y = bb.minY + rects[i].y; layoutTile(t); });
  finishRects(entry);
  if (scoped) setStatus(`Packed ${list.length} selected videos into a grid`);
  else { fitBoard(); setStatus('Packed into a grid'); }
}
// Group bar: Tidy = select the group and Fit it
function tidyGroup(g) {
  if (!g) return;
  selectGroupOf([...g.members][0]);
  tidyFitToView();
}
```

Check `boardBounds` (`app.js:277`) returns `{ minX, minY, w, h }`; it is used that way in `tidyGrid` already (`bb.minX`), and `attachTileDrag` reads `bb0.w`/`bb0.h`.

Menu labels: in the Tidy menu click handler (`~3977`) update the two `<small>` hints when the menu opens:

```js
document.getElementById('btn-tidy-menu').addEventListener('click', (e) => {
  e.stopPropagation(); tidyList.hidden = !tidyList.hidden;
  const scoped = selection.size > 0;
  document.querySelector('#tidy-fit small').textContent = scoped ? 'selection: same height, wrapped in place' : 'same size, fills the view';
  document.querySelector('#tidy-grid small').textContent = scoped ? 'selection: keep sizes, no gaps' : 'keep sizes, no gaps';
});
```

(Replace the existing one-line handler.)

Group bar: `index.html` after the `gb-sticky` button add
`<button class="gb-tidy board-only" title="Tidy this group: every member the same height, wrapped where the group sits (Ctrl+Z undoes)">Tidy</button>`
and in `app.js` next to the other `gbQ(...)` listeners: `gbQ('.gb-tidy').addEventListener('click', () => tidyGroup(active));`.

- [ ] **Step 6: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: five videos on the board, lasso three, Tidy ▾ → Fit: the three line up at one height inside their old footprint, the other two do not move. Ctrl+Z restores. Group two of them with different sizes, press Tidy on the group bar: they match heights. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/arrange.js lib/arrange.test.js app.js index.html
git commit -m "feat: Tidy acts on the selection; Tidy group on the group bar"
```

---

### Task 4: Snapping while resizing

**Files:**
- Create: `lib/snap.js`, `lib/snap.test.js`
- Modify: `app.js:1392-1470` (`startResize` onMove), `index.html` script list

**Interfaces:**
- Produces: `Snap.resize({ start, corner, h, aspect, others, th, gap })` → `{ h, guideX: number|null, guideY: number|null }`. `start` is the tile's rect at pointerdown `{x,y,w,h}`, `corner` is `'tl'|'tr'|'bl'|'br'`, `h` the proposed height, `others` an array of rects not being resized, `th` the threshold in board units, `gap` the link gap.
- Produces: `Snap.rectFor(start, corner, h, aspect)` → the rect the tile would occupy at height `h`, anchored on the opposite corner.

- [ ] **Step 1: Write the failing test**

```js
// lib/snap.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Snap = require('./snap');

const start = { x: 0, y: 0, w: 160, h: 90 }; // 16:9
const A = 16 / 9;

test('rectFor anchors the opposite corner', () => {
  assert.deepEqual(Snap.rectFor(start, 'br', 180, A), { x: 0, y: 0, w: 320, h: 180 });
  assert.deepEqual(Snap.rectFor(start, 'tl', 180, A), { x: -160, y: -90, w: 320, h: 180 });
});
test('snaps the height to a neighbour with the same height', () => {
  const r = Snap.resize({ start, corner: 'br', h: 176, aspect: A, others: [{ x: 500, y: 0, w: 320, h: 180 }], th: 8, gap: 8 });
  assert.equal(r.h, 180);
});
test('snaps the width to a neighbour with the same width', () => {
  const r = Snap.resize({ start, corner: 'br', h: 100, aspect: A, others: [{ x: 500, y: 0, w: 192, h: 400 }], th: 8, gap: 8 });
  assert.equal(Math.round(r.h * A), 192); // width 192 -> height 108
});
test('snaps the moving edge to a neighbour edge, with the gap', () => {
  // growing right toward a tile whose left edge is at x=400: our right edge snaps to 392 (gap 8)
  const r = Snap.resize({ start, corner: 'br', h: 218, aspect: A, others: [{ x: 400, y: 300, w: 100, h: 100 }], th: 8, gap: 8 });
  assert.equal(Math.round(r.h * A), 392);
  assert.equal(r.guideX, 400);
});
test('outside the threshold nothing snaps', () => {
  const r = Snap.resize({ start, corner: 'br', h: 150, aspect: A, others: [{ x: 500, y: 0, w: 320, h: 180 }], th: 8, gap: 8 });
  assert.equal(r.h, 150);
  assert.equal(r.guideX, null); assert.equal(r.guideY, null);
});
test('ignores excluded tiles', () => {
  // the caller passes only the rects that may be snapped to; an empty list means no snap at all
  const r = Snap.resize({ start, corner: 'br', h: 176, aspect: A, others: [], th: 8, gap: 8 });
  assert.equal(r.h, 176);
});
test('the smallest correction wins', () => {
  const r = Snap.resize({ start, corner: 'br', h: 176, aspect: A, others: [{ x: 500, y: 0, w: 10, h: 180 }, { x: 600, y: 0, w: 10, h: 177 }], th: 8, gap: 8 });
  assert.equal(r.h, 177);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/snap.test.js`
Expected: FAIL, `Cannot find module './snap'`.

- [ ] **Step 3: Implement**

```js
// lib/snap.js
// Snapping while a tile is corner-resized. Moving a tile already snaps its edges (snapRect in
// app.js); this is the size side of it: the height snaps to a neighbour's height, the width to a
// neighbour's width, and the two moving edges to neighbours' edges (with and without the link
// gap). Everything is expressed as a candidate height so the aspect ratio is never broken, and the
// smallest correction wins.
{
  const Snap = {
    rectFor(start, corner, h, aspect) {
      const w = h * aspect;
      return {
        x: corner.includes('l') ? start.x + start.w - w : start.x,
        y: corner.includes('t') ? start.y + start.h - h : start.y,
        w, h,
      };
    },
    resize({ start, corner, h, aspect, others, th, gap }) {
      const left = corner.includes('l'), top = corner.includes('t');
      // the x of the anchored vertical edge and the y of the anchored horizontal edge
      const ax = left ? start.x + start.w : start.x;
      const ay = top ? start.y + start.h : start.y;
      let best = null; // { h, d, guideX, guideY }
      const consider = (cand, guideX, guideY) => {
        if (!(cand > 0)) return;
        const d = Math.abs(cand - h);
        if (d <= th && (!best || d < best.d)) best = { h: cand, d, guideX, guideY };
      };
      for (const o of others || []) {
        consider(o.h, null, null);                 // same height
        consider(o.w / aspect, null, null);        // same width
        // moving vertical edge (right when growing right, left when growing left) meets o's edges
        for (const ex of [o.x, o.x + o.w, o.x - gap, o.x + o.w + gap]) {
          const w = left ? ax - ex : ex - ax;
          consider(w / aspect, ex < o.x ? o.x : (ex > o.x + o.w ? o.x + o.w : ex), null);
        }
        // moving horizontal edge meets o's edges
        for (const ey of [o.y, o.y + o.h, o.y - gap, o.y + o.h + gap]) {
          const hh = top ? ay - ey : ey - ay;
          consider(hh, null, ey < o.y ? o.y : (ey > o.y + o.h ? o.y + o.h : ey));
        }
      }
      return best ? { h: best.h, guideX: best.guideX, guideY: best.guideY } : { h, guideX: null, guideY: null };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Snap;
  else window.Snap = Snap;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/snap.test.js`
Expected: PASS, 7 tests. (If `snaps the moving edge` fails on the width check, confirm the candidate `w = ex - ax` with `ex = 392` gives `h = 392 / A = 220.5`, within 8 of 218.)

- [ ] **Step 5: Wire into `startResize`**

Add `<script src="lib/snap.js"></script>` to `index.html`.

In `startResize` `onMove`, in the aspect-locked branch, after `let h = ...` and before `if (onBoard) {`, nothing changes; inside `if (onBoard) {` replace the first line `h = clamp(h, BOARD_MIN_H, BOARD_MAX_H);` with:

```js
      if (!ev.altKey) {
        const others = tiles.filter((t) => t.board && !fixed.has(t)).map((t) => t.board);
        const s = Snap.resize({ start, corner, h, aspect: tile.aspect, others, th: SNAP_PX / board.zoom, gap: LINK_GAP });
        h = s.h;
        hideGuides();
        if (s.guideX !== null) showGuideV(s.guideX);
        if (s.guideY !== null) showGuideH(s.guideY);
      } else hideGuides();
      h = clamp(h, BOARD_MIN_H, BOARD_MAX_H);
```

In `onUp` add `hideGuides();` after `document.body.style.cursor = '';`.

- [ ] **Step 6: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: two videos side by side, one smaller. Drag the small one's bottom-right handle toward the big one's height: a horizontal guide appears and the height locks at the neighbour's. Grow it rightward toward another tile: it stops one gap short with a vertical guide. Hold Alt: no snapping. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/snap.js lib/snap.test.js app.js index.html
git commit -m "feat: snap height, width and edges while resizing"
```

---

### Task 5: Scale a sticky group as one object

**Files:**
- Modify: `lib/arrange.js` (add `scaleAbout`, `clampFactor`), `lib/arrange.test.js`
- Modify: `app.js:1392-1470` (`startResize`)

**Interfaces:**
- Consumes: `Snap.resize` from Task 4.
- Produces: `Arrange.scaleAbout(rects, bbox, factor, corner)` → rects scaled by `factor` about the bbox corner opposite `corner` (so dragging `'br'` keeps the bbox's top-left fixed). `bbox` is `{ minX, minY, w, h }`.
- Produces: `Arrange.clampFactor(rects, factor, minH, maxH)` → the factor limited so every rect's height stays within `[minH, maxH]`.

- [ ] **Step 1: Write the failing test**

Append to `lib/arrange.test.js`:

```js
test('scaleAbout keeps the opposite corner of the bounding box fixed', () => {
  const rects = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 110, y: 0, w: 100, h: 50 }];
  const bb = { minX: 0, minY: 0, w: 210, h: 50 };
  const r = A.scaleAbout(rects, bb, 2, 'br');            // dragging bottom-right: top-left stays
  assert.deepEqual(r[0], { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(r[1], { x: 220, y: 0, w: 200, h: 100 });
  const l = A.scaleAbout(rects, bb, 2, 'tl');            // dragging top-left: bottom-right stays
  assert.deepEqual(l[1], { x: 210 - 200, y: 50 - 100, w: 200, h: 100 });
});
test('clampFactor respects the smallest and largest member', () => {
  const rects = [{ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 400 }];
  assert.equal(A.clampFactor(rects, 0.5, 40, 4000), 0.8);   // 50 * f >= 40
  assert.equal(A.clampFactor(rects, 20, 40, 4000), 10);     // 400 * f <= 4000
  assert.equal(A.clampFactor(rects, 2, 40, 4000), 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/arrange.test.js`
Expected: FAIL, `A.scaleAbout is not a function`.

- [ ] **Step 3: Implement**

Add to `Arrange`:

```js
  // Group scaling: every rect scaled by `factor` about the bounding-box corner opposite the handle
  // being dragged, so the far corner of the group stays put like a single tile's would.
  scaleAbout(rects, bbox, factor, corner) {
    const ox = corner.includes('l') ? bbox.minX + bbox.w : bbox.minX;
    const oy = corner.includes('t') ? bbox.minY + bbox.h : bbox.minY;
    return rects.map((r) => ({ x: ox + (r.x - ox) * factor, y: oy + (r.y - oy) * factor, w: r.w * factor, h: r.h * factor }));
  },
  // the factor limited so the smallest member stays >= minH and the largest <= maxH
  clampFactor(rects, factor, minH, maxH) {
    if (!rects.length) return factor;
    const lo = Math.min(...rects.map((r) => r.h)), hi = Math.max(...rects.map((r) => r.h));
    return Math.min(maxH / hi, Math.max(minH / lo, factor));
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/arrange.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into `startResize`**

In `startResize`, after `const onBoard = isBoard();` add:

```js
  // A sticky group's member scales the whole group about its bounding box (Ctrl: just this tile,
  // mirroring Ctrl-drag). Text members scale their box too and re-wrap.
  const groupScale = onBoard && !modKey(e) && tile.group && tile.group.sticky
    ? [...tile.group.members].filter((m) => m.board) : null;
  const members = groupScale && groupScale.length > 1 ? groupScale : null;
  const groupBB = members ? boardBounds(members) : null;
  const memberStart = members ? new Map(members.map((m) => [m, { ...m.board }])) : null;
```

Change `const fixed = new Set([tile]);` to `const fixed = new Set(members || [tile]);` and add `members`' classes: after `tile.el.classList.add('resizing');` add `if (members) for (const m of members) m.el.classList.add('resizing');` (and remove them in `onUp` alongside the tile's).

In `onMove`, inside `if (onBoard) {` after the Task 4 snap block and the clamp, replace the block from `const w = h * tile.aspect;` through `if (board.linked && !ev.altKey) resolveOverlaps(fixed);` with:

```js
      if (members) {
        const factor = Arrange.clampFactor([...memberStart.values()], h / start.h, BOARD_MIN_H, BOARD_MAX_H);
        const rects = Arrange.scaleAbout(members.map((m) => memberStart.get(m)), groupBB, factor, corner);
        members.forEach((m, i) => { m.board = { ...rects[i] }; layoutTile(m); if (m.freeAspect) renderTextTile(m); });
      } else {
        const w = h * tile.aspect;
        const b = tile.board;
        if (corner.includes('l')) b.x = start.x + (start.w - w);
        if (corner.includes('t')) b.y = start.y + (start.h - h);
        b.w = w; b.h = h;
        layoutTile(tile);
      }
      if (board.linked && !ev.altKey) resolveOverlaps(fixed);
```

`boardBounds(list)` takes tiles and reads `t.board`; `members` are tiles, so `boardBounds(members)` is right. The dragged tile's `start.h` is the single-tile start; `memberStart` holds every member's.

Update the Sticky tooltip in `index.html:150` to: `Sticky: dragging one member moves the whole group and a corner scales the whole group (Ctrl-drag or Ctrl-resize: just that one). Alt-drag a member over another member to swap their places.` (the last sentence is Task 6's).

- [ ] **Step 6: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: group three videos (Sticky on). Drag one member's bottom-right handle: all three grow together, the group's top-left corner stays put. Ctrl+drag a handle: only that tile changes. Ctrl+Z undoes the group scale in one step. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/arrange.js lib/arrange.test.js app.js index.html
git commit -m "feat: corner-resize scales a sticky group as one object"
```

---

### Task 6: Swap rearrange inside a sticky group

**Files:**
- Create: `lib/swap.js`, `lib/swap.test.js`
- Modify: `app.js:1476-1562` (`attachTileDrag`), `style.css` (`.swapping`, `.swap-target`), `index.html` script list

**Interfaces:**
- Consumes: `Select.onPointerDown` (Task 1), `ClickGuard` (Task 2).
- Produces: `Swap.targetAt(point, slots, selfId)` → the id of the slot containing `point`, excluding `selfId`, or `null`. `slots` is `[{ id, rect }]`.
- Produces: `Swap.apply(slots, a, b)` → a new slots array with the rects of `a` and `b` exchanged.
- Produces: `Swap.isSwapDrag({ sticky, alt, mod, shift, memberCount })` → boolean: Alt-drag on a sticky member with at least two members on the board.

- [ ] **Step 1: Write the failing test**

```js
// lib/swap.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Swap = require('./swap');

const slots = [
  { id: 1, rect: { x: 0, y: 0, w: 100, h: 100 } },
  { id: 2, rect: { x: 110, y: 0, w: 100, h: 100 } },
  { id: 3, rect: { x: 0, y: 110, w: 200, h: 50 } },
];
test('targetAt finds the slot under the point, never the dragged tile', () => {
  assert.equal(Swap.targetAt({ x: 150, y: 50 }, slots, 1), 2);
  assert.equal(Swap.targetAt({ x: 50, y: 50 }, slots, 1), null);   // that is our own slot
  assert.equal(Swap.targetAt({ x: 50, y: 130 }, slots, 1), 3);
});
test('no target means no change', () => {
  assert.equal(Swap.targetAt({ x: 500, y: 500 }, slots, 1), null);
  assert.deepEqual(Swap.apply(slots, 1, null), slots);
});
test('apply exchanges rects, position and size, and leaves the rest alone', () => {
  const out = Swap.apply(slots, 1, 3);
  assert.deepEqual(out.find((s) => s.id === 1).rect, { x: 0, y: 110, w: 200, h: 50 });
  assert.deepEqual(out.find((s) => s.id === 3).rect, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(out.find((s) => s.id === 2).rect, slots[1].rect);
  assert.deepEqual(slots[0].rect, { x: 0, y: 0, w: 100, h: 100 }); // input untouched
});
test('isSwapDrag: Alt-drag on a sticky member, with at least two members', () => {
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: false, shift: false, memberCount: 2 }), true);
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: false, mod: false, shift: false, memberCount: 2 }), false); // plain drag moves the group as before
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: true, shift: false, memberCount: 2 }), false);   // Ctrl pulls one free
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: false, shift: true, memberCount: 2 }), false);   // Shift toggles selection
  assert.equal(Swap.isSwapDrag({ sticky: false, alt: true, mod: false, shift: false, memberCount: 2 }), false); // not sticky: Alt-drag pans
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: false, shift: false, memberCount: 1 }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/swap.test.js`
Expected: FAIL, `Cannot find module './swap'`.

- [ ] **Step 3: Implement**

```js
// lib/swap.js
// Rearranging inside a sticky group without un-tidying it: Alt-drag a member over another member
// and the two exchange slots (position and size). Plain drag still moves the group, Ctrl-drag
// still pulls one member free. Alt-drag anywhere else still pans the view (so does middle-mouse).
{
  const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const Swap = {
    isSwapDrag({ sticky, alt, mod, shift, memberCount }) {
      return !!sticky && !!alt && !mod && !shift && memberCount >= 2;
    },
    targetAt(point, slots, selfId) {
      const hit = slots.find((s) => s.id !== selfId && inside(point, s.rect));
      return hit ? hit.id : null;
    },
    apply(slots, a, b) {
      if (a === null || b === null || a === undefined || b === undefined || a === b) return slots;
      const ra = slots.find((s) => s.id === a), rb = slots.find((s) => s.id === b);
      if (!ra || !rb) return slots;
      return slots.map((s) => (s.id === a ? { id: a, rect: { ...rb.rect } } : s.id === b ? { id: b, rect: { ...ra.rect } } : s));
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Swap;
  else window.Swap = Swap;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/swap.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the swap drag**

Add `<script src="lib/swap.js"></script>` to `index.html`.

`style.css`, next to `.tile.dragging`:

```css
body.mode-board .tile.swapping { outline: 2px dashed var(--accent); opacity: 0.85; }
body.mode-board .tile.swap-target { outline: 2px solid var(--accent); }
```

`attachTileDrag`'s pointerdown handler returns at its first line when `e.altKey` is set (so the grid's handler pans). The swap check has to run before that. Replace the first line

```js
    if (!isBoard() || e.button !== 0 || !tile.board || e.altKey) return;
```

with

```js
    if (!isBoard() || e.button !== 0 || !tile.board) return;
    const members = tile.group ? [...tile.group.members].filter((m) => m.board) : [];
    if (Swap.isSwapDrag({ sticky: !!(tile.group && tile.group.sticky), alt: e.altKey, mod: modKey(e), shift: e.shiftKey, memberCount: members.length })) {
      e.stopPropagation(); // the grid's pointerdown would otherwise start an Alt-pan too
      return startSwapDrag(tile, members, e);
    }
    if (e.altKey) return; // Alt-drag anywhere else pans (grid handler)
```

The grid's own `pointerdown` listener (`app.js:~1643`) is on an ancestor in the bubble phase, so `stopPropagation` is what keeps the pan from starting. Keep the `e.target.closest('.handle, input, button, select')` early return after this block as it is.

Add the new function after `attachTileDrag`:

```js
// ---------- board: swap two members of a sticky group ----------
// The dragged tile follows the pointer; the member under the pointer is the target and previews
// moving into the dragged tile's slot. Release on a target: the two exchange rects. Anywhere
// else, or a lost capture: everything goes back. One undo entry.
function startSwapDrag(tile, members, e) {
  const el = tile.el;
  try { el.setPointerCapture(e.pointerId); } catch {}
  const startC = { x: e.clientX, y: e.clientY };
  const slots = members.map((m) => ({ id: m, rect: { ...m.board } }));
  const startRect = { ...tile.board };
  let moving = false, target = null, undoEntry = null;
  const restore = (m) => { const s = slots.find((x) => x.id === m); m.board = { ...s.rect }; layoutTile(m); };
  const setTarget = (m) => {
    if (target === m) return;
    if (target) { target.el.classList.remove('swap-target'); restore(target); }
    target = m;
    if (target) { target.el.classList.add('swap-target'); target.board = { ...startRect }; layoutTile(target); }
  };
  const onMove = (ev) => {
    const dx = ev.clientX - startC.x, dy = ev.clientY - startC.y;
    if (!moving) {
      if (Math.hypot(dx, dy) < 4) return;
      moving = true;
      undoEntry = recordMove(members, 'swap');
      bringToFront(tile);
      el.classList.add('swapping');
      document.body.classList.add('tile-dragging');
    }
    tile.board.x = startRect.x + dx / board.zoom; tile.board.y = startRect.y + dy / board.zoom;
    layoutTile(tile);
    const p = toCanvas(ev.clientX, ev.clientY);
    setTarget(Swap.targetAt(p, slots, tile));
  };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    activeInteractions.delete(onUp);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('lostpointercapture', onUp);
    if (!moving) return;
    const final = Swap.apply(slots, tile, target);
    if (target) target.el.classList.remove('swap-target');
    for (const s of final) { s.id.board = { ...s.rect }; layoutTile(s.id); }
    el.classList.remove('swapping');
    document.body.classList.remove('tile-dragging');
    finishRects(undoEntry); // drops the entry when nothing changed (no target)
    tile.guard.afterDrag();
    if (target) { setStatus('Swapped'); logUi('info', 'swap', { group: tile.group && tile.group.id }); }
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  activeInteractions.add(onUp);
}
```

Notes for the implementer: `slots[].id` holds the tile object itself (ids only need to be comparable with `===`, and `Swap.apply` returns `{ id, rect }` with the same objects). `finishRects` (`app.js:1008`) keeps only tiles whose rect changed, so a no-target release records nothing. `recordMove` signature is `(list, label)` (`app.js:1006`). `resetBoardInteraction` (`app.js:431`) calls every entry in `activeInteractions`, so a lost release restores through `onUp` with `target` as it was; if that leaves a preview applied, `Swap.apply` with a non-null target commits it, which is the same result the user saw. If you prefer a lost capture to always revert, set `target = null` in a `pointercancel` handler before `onUp`.

- [ ] **Step 6: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: group four videos of different sizes (Sticky on), Tidy group so they are neat. Alt-drag one member over another: the target highlights and jumps into the dragged tile's slot; release: they have swapped, sizes included, and the layout is as neat as before. Alt-drag a member and release over empty board: it snaps back. Plain drag: the whole group moves as before. Alt-drag starting on empty board, or on an ungrouped tile: the view pans as before. Ctrl-drag: one member comes free. Ctrl+Z undoes a swap in one step. Hover play off throughout. Close the app.

Drive this over CDP if clicking by hand is not possible: dispatch pointerdown with `altKey: true` on the tile's `video`, a pointermove past 4 px, a pointermove to the centre of the other tile, then pointerup, each as its own short evaluate, and read `tiles[i].board` between them.

- [ ] **Step 7: Commit**

```bash
git add lib/swap.js lib/swap.test.js app.js style.css index.html
git commit -m "feat: drag a sticky-group member over another to swap their slots"
```

---

### Task 7: Hand-off

- [ ] Run `npm test` once more on the branch; all green.
- [ ] Push `feat/board-interaction` to origin (no PR).
- [ ] Reply to the hub window (`scott fable windows 1 (work here)`) with: commit list, anything you changed from the plan and why, and what you could not verify. Do not merge; sonnet merges both branches when Mark says so.
