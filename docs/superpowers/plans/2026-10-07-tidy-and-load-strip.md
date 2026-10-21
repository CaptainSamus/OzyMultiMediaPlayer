# Tidy Modes and Load Strip Implementation Plan (plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Tidy three size-preserving modes (Align, Compact, Rows) for hand-made layouts, turn the load viewer into a docked, resizable strip with live bars and GB-aware numbers (keeping the pop-out as an option), and fix the board clicks that died with the v0.2.0.11 pointer-capture change.

**Architecture:** Pure layout rules in `lib/arrange.js`, formatting and bar maths in `lib/loadstats.js`, both with `node --test` coverage; `app.js` wires the Tidy menu, a `#load-strip` docked above the timeline with the timeline's own drag-to-resize pattern, and the existing `tileClick` lookup for the dead handlers.

**Tech Stack:** Vanilla JS, Electron 33, `node --test`. No new dependencies.

**Spec:** Scott's brief of 2026-10-07 (recorded in this plan's task intros) on top of `docs/superpowers/specs/2026-10-07-board-polish-and-performance-design.md`.

## Global Constraints

- Branch `feat/tidy-and-load-strip` from `feat/board-polish-and-performance` (head `6651844`, PR #1). One commit per task. No version bump, tag, release; push the branch and reply to the hub. The hub decides whether it joins PR #1 or gets its own.
- Pure logic in `lib/*.js`, exported with `if (typeof module !== 'undefined' && module.exports) module.exports = X; else window.X = X;`, tests in `lib/<name>.test.js`, run with `npm test` (227 tests pass on the base branch).
- `app.js` has a NUL byte and mixed CRLF/LF line endings: search with `grep -an` / `sed -n`, preserve each region's endings. Line numbers below are for `6651844`; re-locate with `grep -an` before editing.
- Cut behaviour by commenting out in place, never deleting.
- Manual checks run the app with a separate profile (`./node_modules/.bin/electron . --user-data-dir=<scratchpad>/ozy-userdata --remote-debugging-port=93xx`), never a running instance. Close every window you open. CDP recipe: memory note `ozy-manual-checks-via-cdp`.
- Tidy modes act on `tidyTargets()` (`app.js:4220`): the selection when one exists, else every board tile. Text tiles (`t.freeAspect`) are included in Align and Compact (they only move) and excluded from Rows (they have no gallery form, same as Fit).
- Sizes never change in Align, Compact or Rows. Every test asserts `w` and `h` unchanged.

## Review Focus

1. Align must never move a tile toward an edge that is not within the threshold, so a deliberately offset tile stays put (Task 1 test `a tile far from everything does not move`).
2. Compact must never leave two tiles overlapping, whatever order they come in (Task 2 test `never overlaps, in any order`).
3. Rows must put a tile wider than the view on its own row rather than refuse or overflow (Task 3 test `a tile wider than the view gets its own row`).
4. The load strip must survive `loadStats` failing (ffmpeg-less or IPC error) by showing "unavailable" bars, not throwing in the interval (Task 4 test `bars tolerate missing data` and the manual check with the IPC stubbed to throw).
5. A double-click on the picture must go fullscreen on the board again, and a single click must not fire twice when a double-click is in progress (Task 5 manual check over CDP: dispatch click, click, dblclick and read `document.fullscreenElement` and the paused state).

---

### Task 1: Tidy → Align (edges and gaps, nothing moves far)

Scott: "a layout made by someone looks great, ten videos and one in the middle is bigger, but since it was made by hand it's not super neat or the edges don't line up. Tidying it should fix the lining up but not mess up anything else."

**Files:**
- Modify: `lib/arrange.js` (add `align`), `lib/arrange.test.js`
- Modify: `app.js` Tidy menu (`~4218-4275`), `index.html:86-90`

**Interfaces:**
- Produces: `Arrange.align(rects, th, gap, passes = 2)` → new rects, same `w`/`h`, each shifted by at most `th` per axis per pass. A left edge snaps to another tile's left edge or to its right edge plus `gap`; a right edge to another right or another left minus `gap`; likewise top/bottom. The smallest correction within `th` wins; ties prefer the gap candidates (so neighbours end up exactly one gap apart).

- [ ] **Step 1: Write the failing test**

Append to `lib/arrange.test.js`:

```js
test('align: edges a few px off become equal, sizes untouched', () => {
  const r = A.align([
    { x: 0, y: 0, w: 200, h: 100 },
    { x: 3, y: 108, w: 150, h: 100 },     // left edge 3 off, top 8 from a 100-tall tile + gap 8 = 108: already a gap
  ], 10, 8);
  assert.equal(r[1].x, 0);
  assert.equal(r[1].y, 108);
  assert.deepEqual([r[1].w, r[1].h], [150, 100]);
});
test('align: a neighbour nearly one gap away lands exactly one gap away', () => {
  const r = A.align([{ x: 0, y: 0, w: 200, h: 100 }, { x: 213, y: 2, w: 100, h: 100 }], 10, 8);
  assert.equal(r[1].x, 208);              // 200 + gap
  assert.equal(r[1].y, 0);
});
test('align: the bigger tile anchors, the smaller one moves (no chasing across passes)', () => {
  const r = A.align([{ x: 0, y: 0, w: 200, h: 100 }, { x: 213, y: 2, w: 100, h: 100 }], 10, 8, 4);
  assert.equal(r[0].x, 0);
  assert.equal(r[1].x, 208);
});
test('align: a tile far from everything does not move', () => {
  const r = A.align([{ x: 0, y: 0, w: 200, h: 100 }, { x: 500, y: 400, w: 100, h: 100 }], 10, 8);
  assert.deepEqual(r[1], { x: 500, y: 400, w: 100, h: 100 });
});
test('align: a big tile among small ones keeps its size and the small ones line up to it', () => {
  const big = { x: 300, y: 0, w: 400, h: 300 };
  const r = A.align([big, { x: 0, y: 4, w: 150, h: 100 }, { x: 0, y: 110, w: 150, h: 100 }, { x: 704, y: 0, w: 150, h: 100 }], 10, 8);
  assert.deepEqual(r[0], big);
  assert.equal(r[1].y, 0);                // top to the big one's top
  assert.equal(r[3].x, 708);              // big right + gap
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/arrange.test.js`
Expected: FAIL, `A.align is not a function`.

- [ ] **Step 3: Implement**

Add to `Arrange`:

```js
  // Align: make a hand-made layout neat without changing it. Every tile's edges look for another
  // tile's edge (or that edge one gap away) within `th` and shift to it; the smallest correction
  // wins, ties go to the gap candidate so neighbours sit exactly one gap apart. Sizes never change,
  // and a tile with nothing within reach stays where it is. Bigger tiles anchor smaller ones (the
  // big one in the middle of a hand-made layout is the reference), equal sizes anchor by order.
  // Two passes let chains settle.
  align(rects, th, gap, passes = 2) {
    let cur = rects.map((r) => ({ ...r }));
    for (let p = 0; p < passes; p++) {
      const next = cur.map((r, i) => {
        let bx = null, by = null; // { d, shift, viaGap }
        const take = (axis, shift, viaGap) => {
          const d = Math.abs(shift);
          if (d > th + 1e-9) return;
          const cur0 = axis === 'x' ? bx : by;
          if (!cur0 || d < cur0.d - 1e-9 || (Math.abs(d - cur0.d) <= 1e-9 && viaGap && !cur0.viaGap)) {
            const v = { d, shift, viaGap };
            if (axis === 'x') bx = v; else by = v;
          }
        };
        cur.forEach((o, j) => {
          if (j === i) return;
          // anchoring: a tile only moves toward a bigger tile, or an equal one earlier in the list,
          // so two neighbours never chase each other back and forth across passes
          const oa = o.w * o.h, ra = r.w * r.h;
          if (oa < ra || (oa === ra && j > i)) return;
          take('x', o.x - r.x, false);                       // left to left
          take('x', (o.x + o.w + gap) - r.x, true);          // left to right + gap
          take('x', (o.x + o.w) - (r.x + r.w), false);       // right to right
          take('x', (o.x - gap) - (r.x + r.w), true);        // right to left - gap
          take('y', o.y - r.y, false);
          take('y', (o.y + o.h + gap) - r.y, true);
          take('y', (o.y + o.h) - (r.y + r.h), false);
          take('y', (o.y - gap) - (r.y + r.h), true);
        });
        return { x: r.x + (bx ? bx.shift : 0), y: r.y + (by ? by.shift : 0), w: r.w, h: r.h };
      });
      cur = next;
    }
    return cur;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/arrange.test.js`
Expected: PASS. If the first test's `r[1].y` comes out 100 rather than 108, the "top to bottom + gap" candidate (108, d = 0) must beat "top to top" (0, d = 108); check the `take` ordering.

- [ ] **Step 5: Wire the menu entry**

`index.html` Tidy menu, add before `tidy-fit`:

```html
        <button id="tidy-align" title="Line up edges that are nearly lined up and make gaps even. Nothing changes size and nothing moves far (Ctrl+Z undoes)">Align <small>keep sizes, straighten edges</small></button>
```

`app.js` after `tidyGrid`:

```js
// Align: edges that are nearly lined up get lined up, gaps that are nearly a gap become one.
// Sizes and the arrangement are kept; a tile with nothing within reach stays put (undo = move).
const ALIGN_PX = 24; // screen px: generous, since a hand-made layout is "nearly" right
function tidyAlign() {
  const { list, scoped } = tidyTargets(); if (list.length < 2) { setStatus('Nothing to line up'); return; }
  const entry = recordMove(list);
  const rects = Arrange.align(list.map((t) => ({ ...t.board })), ALIGN_PX / board.zoom, LINK_GAP);
  list.forEach((t, i) => { t.board.x = rects[i].x; t.board.y = rects[i].y; layoutTile(t); });
  finishRects(entry);
  setStatus(scoped ? `Lined up ${list.length} selected videos` : 'Lined up the board');
}
document.getElementById('tidy-align').addEventListener('click', () => { tidyList.hidden = true; tidyAlign(); });
```

Also add the "(selection)" hint handling for the new entry in the `btn-tidy-menu` click handler (set `#tidy-align small` to `scoped ? '(selection) keep sizes, straighten edges' : 'keep sizes, straighten edges'`).

- [ ] **Step 6: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: lay out five videos by hand, roughly in a row with one bigger, edges a few px off. Tidy ▾ → Align: edges line up, gaps become even, nothing changes size, nothing jumps. Ctrl+Z restores. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/arrange.js lib/arrange.test.js app.js index.html
git commit -m "feat: Tidy → Align straightens edges and gaps without changing sizes"
```

---

### Task 2: Tidy → Compact (keep sizes, close the gaps)

Scott: "if there's one that's more all over the place but there's varying scales to all the videos, there should be ways to sort them more uniquely, preserving the scale, and potentially the position of certain videos."

**Files:**
- Modify: `lib/arrange.js` (add `compact`), `lib/arrange.test.js`
- Modify: `app.js` Tidy menu, `index.html`

**Interfaces:**
- Produces: `Arrange.compact(rects, gap, passes = 2)` → new rects, same `w`/`h`. Tiles are processed top-to-bottom then left-to-right; each slides up until it rests one `gap` below whatever already-placed tile it overlaps horizontally (or the set's top), then left the same way. Relative order is kept: a tile that started below another that it overlaps in x stays below it.

- [ ] **Step 1: Write the failing test**

Append to `lib/arrange.test.js`:

```js
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
test('compact: a scattered layout closes up to one gap, sizes untouched', () => {
  const r = A.compact([
    { x: 0, y: 0, w: 200, h: 100 },
    { x: 300, y: 40, w: 100, h: 100 },    // slides left to 208, up to 0
    { x: 10, y: 250, w: 150, h: 80 },     // slides up to 108
  ], 8);
  assert.deepEqual(r[1], { x: 208, y: 0, w: 100, h: 100 });
  assert.deepEqual(r[2], { x: 0, y: 108, w: 150, h: 80 });
});
test('compact: never overlaps, in any order', () => {
  const rects = [
    { x: 50, y: 50, w: 300, h: 200 }, { x: 100, y: 100, w: 100, h: 100 }, { x: 0, y: 0, w: 120, h: 90 },
    { x: 400, y: 20, w: 200, h: 300 }, { x: 420, y: 60, w: 50, h: 50 },
  ];
  const r = A.compact(rects, 8);
  for (let i = 0; i < r.length; i++) {
    assert.deepEqual([r[i].w, r[i].h], [rects[i].w, rects[i].h]);
    for (let j = i + 1; j < r.length; j++) assert.ok(!overlaps(r[i], r[j]), `${i} overlaps ${j}`);
  }
});
test('compact: keeps the top-left corner of the set where it was', () => {
  const r = A.compact([{ x: 100, y: 200, w: 50, h: 50 }, { x: 300, y: 400, w: 50, h: 50 }], 8);
  assert.deepEqual(r[0], { x: 100, y: 200, w: 50, h: 50 });
  assert.deepEqual(r[1], { x: 158, y: 200, w: 50, h: 50 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/arrange.test.js`
Expected: FAIL, `A.compact is not a function`.

- [ ] **Step 3: Implement**

Add to `Arrange`:

```js
  // Compact: sizes and the rough arrangement are kept; every tile slides up, then left, until it
  // rests one gap from what is already settled (or the set's own top-left), like pieces settling.
  // Tiles are settled in reading order (top, then left) so a tile keeps the neighbours it had.
  compact(rects, gap, passes = 2) {
    let cur = rects.map((r) => ({ ...r }));
    if (!cur.length) return cur;
    const minX = Math.min(...cur.map((r) => r.x)), minY = Math.min(...cur.map((r) => r.y));
    const xOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x;
    const yOverlap = (a, b) => a.y < b.y + b.h && a.y + a.h > b.y;
    for (let p = 0; p < passes; p++) {
      const order = cur.map((r, i) => i).sort((a, b) => (cur[a].y - cur[b].y) || (cur[a].x - cur[b].x));
      const placed = [];
      const next = cur.slice();
      for (const i of order) {
        const r = { ...cur[i] };
        // up: just below the lowest settled tile that shares columns with us
        let top = minY;
        for (const q of placed) if (xOverlap(r, q) && q.y + q.h + gap > top && q.y <= r.y) top = q.y + q.h + gap;
        r.y = Math.min(r.y, Math.max(minY, top)) === r.y ? Math.max(minY, top) : Math.max(minY, top);
        // left: just right of the rightmost settled tile that shares rows with us
        let left = minX;
        for (const q of placed) if (yOverlap(r, q) && q.x + q.w + gap > left && q.x <= r.x) left = q.x + q.w + gap;
        r.x = Math.max(minX, left);
        // if sliding left created an overlap with something settled, drop below it instead
        for (const q of placed) if (xOverlap(r, q) && yOverlap(r, q)) r.y = Math.max(r.y, q.y + q.h + gap);
        placed.push(r);
        next[i] = r;
      }
      cur = next;
    }
    return cur;
  },
```

(The odd-looking `r.y = ...` line reduces to `r.y = Math.max(minY, top)`; write it that way.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/arrange.test.js`
Expected: PASS. If `never overlaps` fails, print the result rects and check the "drop below" fallback runs after the left slide for every settled tile; a third pass (`passes = 3`) is acceptable if two leave a residual overlap in that fixture, but update the default and say so in the commit.

- [ ] **Step 5: Wire the menu entry**

`index.html` after `tidy-align`:

```html
        <button id="tidy-compact" title="Keep every size and the rough arrangement; slide everything up and left until it sits one gap apart (Ctrl+Z undoes)">Compact <small>keep sizes, close the gaps</small></button>
```

`app.js`:

```js
// Compact: sizes and arrangement kept; tiles settle up and left until one gap apart (undo = move).
function tidyCompact() {
  const { list, scoped } = tidyTargets(); if (!list.length) return;
  const entry = recordMove(list);
  const rects = Arrange.compact(list.map((t) => ({ ...t.board })), LINK_GAP);
  list.forEach((t, i) => { t.board.x = rects[i].x; t.board.y = rects[i].y; layoutTile(t); });
  finishRects(entry);
  if (scoped) setStatus(`Compacted ${list.length} selected videos`); else { fitBoard(); setStatus('Compacted the board'); }
}
document.getElementById('tidy-compact').addEventListener('click', () => { tidyList.hidden = true; tidyCompact(); });
```

Plus the "(selection)" hint for `#tidy-compact small`.

- [ ] **Step 6: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: scatter six videos of three different sizes with big spaces. Tidy ▾ → Compact: they close up, every size unchanged, the big one still next to the ones it was next to, no overlaps. Ctrl+Z restores. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/arrange.js lib/arrange.test.js app.js index.html
git commit -m "feat: Tidy → Compact settles tiles up and left, keeping sizes"
```

---

### Task 3: Tidy → Rows (keep sizes, sort into rows)

**Files:**
- Modify: `lib/arrange.js` (add `rows`), `lib/arrange.test.js`
- Modify: `app.js` Tidy menu, `index.html`

**Interfaces:**
- Produces: `Arrange.rows(items /*[{w,h}]*/, W, gap)` → rects: sizes kept, flow-wrapped at `W` with `gap` between tiles and rows, tops aligned per row, rows as tall as their tallest tile. A tile wider than `W` gets its own row.

- [ ] **Step 1: Write the failing test**

```js
test('rows: keep sizes, wrap at W, tops aligned, rows as tall as the tallest', () => {
  const r = A.rows([{ w: 200, h: 100 }, { w: 200, h: 150 }, { w: 200, h: 100 }], 450, 10);
  assert.deepEqual(r[0], { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(r[1], { x: 210, y: 0, w: 200, h: 150 });
  assert.deepEqual(r[2], { x: 0, y: 160, w: 200, h: 100 });   // 150 + gap
});
test('rows: a tile wider than the view gets its own row', () => {
  const r = A.rows([{ w: 100, h: 50 }, { w: 900, h: 50 }, { w: 100, h: 50 }], 500, 0);
  assert.equal(r[1].y, 50); assert.equal(r[1].x, 0);
  assert.equal(r[2].y, 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/arrange.test.js` → FAIL, `A.rows is not a function`.

- [ ] **Step 3: Implement**

```js
  // Rows: sizes kept, sorted into rows across W with even gaps; for when position doesn't matter.
  rows(items, W, gap) {
    const rects = []; let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      if (x > 0 && x + gap + it.w > W + 0.01) { x = 0; y += rowH + gap; rowH = 0; }
      if (x > 0) x += gap;
      rects.push({ x, y, w: it.w, h: it.h });
      x += it.w; rowH = Math.max(rowH, it.h);
    }
    return rects;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/arrange.test.js` → PASS.

- [ ] **Step 5: Wire the menu entry**

`index.html` after `tidy-compact`:

```html
        <button id="tidy-rows" title="Keep every size and sort into rows across the view with even gaps (Ctrl+Z undoes)">Rows <small>keep sizes, sort into rows</small></button>
```

`app.js`:

```js
// Rows: sizes kept, flowed into rows at the view's width; text tiles sit it out (undo = move).
function tidyRows() {
  const { list: targets, scoped } = tidyTargets();
  const list = targets.filter((t) => !t.freeAspect); if (!list.length) return;
  const entry = recordMove(list);
  const r = gridRect(); const W = (r.width - 2 * GAP) / board.zoom;
  const bb = boardBounds(list);
  const origin = scoped ? { x: bb.minX, y: bb.minY } : toCanvas(r.left + GAP, r.top + GAP);
  const rects = Arrange.rows(list.map((t) => ({ w: t.board.w, h: t.board.h })), W, LINK_GAP);
  list.forEach((t, i) => { t.board.x = origin.x + rects[i].x; t.board.y = origin.y + rects[i].y; layoutTile(t); });
  finishRects(entry);
  if (scoped) setStatus(`Sorted ${list.length} selected videos into rows`); else { fitBoard(); setStatus('Sorted into rows'); }
}
document.getElementById('tidy-rows').addEventListener('click', () => { tidyList.hidden = true; tidyRows(); });
```

Plus the "(selection)" hint for `#tidy-rows small`. Final menu order: Align, Compact, Rows, Grid, Fit to view.

- [ ] **Step 6: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: eight videos of mixed sizes, Tidy ▾ → Rows: rows across the view, sizes unchanged, tops aligned. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/arrange.js lib/arrange.test.js app.js index.html
git commit -m "feat: Tidy → Rows sorts tiles into rows, keeping sizes"
```

---

### Task 4: Load strip (docked, resizable, live bars) with the pop-out kept

Scott: "it should have the option to be visible just as part of the UI... adjustable size... translate large MB amounts into GB... a constantly moving bar, like memory load in video game settings... keep the view how it is right now as an option... I don't think I'll view the per-video table as much but still might."

**Files:**
- Modify: `lib/loadstats.js` (add `fmt`, `bars`), `lib/loadstats.test.js`
- Modify: `lib/settings.js` (`loadStrip`, `loadStripH`), `lib/settings.test.js`
- Modify: `index.html` (toolbar button, `#load-strip` before `#timeline`, pop-out unchanged), `style.css`, `app.js` load viewer block (`~4805-4845`)

**Interfaces:**
- Produces: `LoadStats.fmt(mb)` → `'812 MB'` below 1024, `'3.2 GB'` from 1024 up (one decimal), `'–'` for non-numbers.
- Produces: `LoadStats.bars(split, totalMemMB)` → `{ mem: [{ key: 'ozy', pct }, { key: 'other', pct }, { key: 'free', pct }], cpu: [{ key: 'ozy', pct }, { key: 'other', pct }, { key: 'idle', pct }] }`, percentages clamped to 0-100 and summing to at most 100; `null` input → all zeros.
- Produces: settings `loadStrip: false`, `loadStripH: 120` (min 56, max 400); `setLoadStrip(on)`; the strip and the pop-out share `refreshLoad()`.

- [ ] **Step 1: Write the failing test**

Append to `lib/loadstats.test.js`:

```js
test('fmt: MB under a GB, GB with one decimal above', () => {
  assert.equal(L.fmt(812), '812 MB');
  assert.equal(L.fmt(1024), '1.0 GB');
  assert.equal(L.fmt(3276), '3.2 GB');
  assert.equal(L.fmt(NaN), '–');
});
test('bars: three memory segments out of the total, three CPU segments out of 100', () => {
  const b = L.bars({ ozy: { cpu: 30, memMB: 4000, gpuMemMB: 0 }, other: { cpu: 20, memMB: 8000 }, freeMB: 4000 }, 16000);
  assert.deepEqual(b.mem.map((s) => [s.key, s.pct]), [['ozy', 25], ['other', 50], ['free', 25]]);
  assert.deepEqual(b.cpu.map((s) => [s.key, s.pct]), [['ozy', 30], ['other', 20], ['idle', 50]]);
});
test('bars tolerate missing data', () => {
  const b = L.bars(null, 0);
  assert.deepEqual(b.mem.map((s) => s.pct), [0, 0, 0]);
  assert.deepEqual(b.cpu.map((s) => s.pct), [0, 0, 0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/loadstats.test.js` → FAIL, `L.fmt is not a function`.

- [ ] **Step 3: Implement**

Add to `LoadStats`:

```js
    fmt(mb) {
      const v = Number(mb);
      if (!Number.isFinite(v)) return '–';
      return v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : Math.round(v) + ' MB';
    },
    // segments for the two live bars; percentages clamped so a bar never overflows
    bars(split, totalMemMB) {
      const zero = { mem: [{ key: 'ozy', pct: 0 }, { key: 'other', pct: 0 }, { key: 'free', pct: 0 }], cpu: [{ key: 'ozy', pct: 0 }, { key: 'other', pct: 0 }, { key: 'idle', pct: 0 }] };
      if (!split || !(Number(totalMemMB) > 0)) return zero;
      const c = (v) => Math.max(0, Math.min(100, Number(v) || 0));
      const total = Number(totalMemMB);
      const ozyM = c(split.ozy.memMB / total * 100), otherM = c(Math.min(100 - ozyM, split.other.memMB / total * 100));
      const freeM = c(Math.min(100 - ozyM - otherM, split.freeMB / total * 100));
      const ozyC = c(split.ozy.cpu), otherC = c(Math.min(100 - ozyC, split.other.cpu));
      return {
        mem: [{ key: 'ozy', pct: ozyM }, { key: 'other', pct: otherM }, { key: 'free', pct: freeM }],
        cpu: [{ key: 'ozy', pct: ozyC }, { key: 'other', pct: otherC }, { key: 'idle', pct: c(100 - ozyC - otherC) }],
      };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/loadstats.test.js` → PASS.

- [ ] **Step 5: Settings**

`lib/settings.js` `defaults()`: `loadStrip: false, loadStripH: 120`. `merge()`: `loadStrip: s.loadStrip === true,` and `loadStripH: Math.min(400, Math.max(56, Number(s.loadStripH) || d.loadStripH)),` each on its own line. Test (module is `S` at the bottom of `lib/settings.test.js`):

```js
test('load strip: off by default, height clamped', () => {
  assert.equal(S.merge({}).loadStrip, false);
  assert.equal(S.merge({}).loadStripH, 120);
  assert.equal(S.merge({ loadStripH: 10 }).loadStripH, 56);
  assert.equal(S.merge({ loadStripH: 9000 }).loadStripH, 400);
});
```

- [ ] **Step 6: Markup and style**

`index.html` toolbar, after the `#optimize-menu` div: `<button id="btn-load" title="Load strip: live bars for memory and CPU, Ozy against everything else (resize by dragging its top edge)">Load</button>`.

Before `<div id="timeline" hidden>`:

```html
  <div id="load-strip" hidden>
    <div class="ls-grip" title="Drag to resize"></div>
    <div class="ls-row"><span class="ls-label">Memory</span><div class="ls-bar ls-mem"><span data-key="ozy"></span><span data-key="other"></span><span data-key="free"></span></div><span class="ls-text ls-mem-text">…</span></div>
    <div class="ls-row"><span class="ls-label">CPU</span><div class="ls-bar ls-cpu"><span data-key="ozy"></span><span data-key="other"></span><span data-key="idle"></span></div><span class="ls-text ls-cpu-text">…</span></div>
    <div class="ls-legend"><i class="ozy"></i> Ozy <i class="other"></i> Everything else <i class="free"></i> Free <span class="spacer"></span><button class="ls-videos" title="Show each video's cost">Videos ▾</button><button class="ls-close" title="Hide (Load button shows it again)">✕</button></div>
    <div class="ls-table" hidden><table class="lp-table"><thead><tr><th>Video</th><th>Source</th><th>Tier</th><th>State</th><th>Dropped</th><th>≈ Memory</th></tr></thead><tbody></tbody></table></div>
  </div>
```

Leave `#load-panel` (the pop-out) exactly as it is; change its `.lp-close` tooltip to "Hide the pop-out (Optimize ▾ shows it again)" and its Optimize menu label to "Show load viewer (pop-out)".

`style.css`:

```css
#load-strip { flex: 0 0 auto; height: var(--ls-h, 120px); background: var(--panel); border-top: 1px solid #2a2a2e; user-select: none; display: flex; flex-direction: column; padding: 0 10px 6px; font-size: 12px; overflow: hidden; position: relative; }
#load-strip[hidden] { display: none; }
#load-strip .ls-grip { height: 6px; margin: 0 -10px 4px; cursor: ns-resize; background: linear-gradient(#2a2a2e, transparent); }
#load-strip .ls-row { display: flex; align-items: center; gap: 10px; margin: 3px 0; }
#load-strip .ls-label { width: 60px; color: var(--muted); }
#load-strip .ls-bar { flex: 1 1 auto; height: 14px; display: flex; background: #1b1b1f; border-radius: 4px; overflow: hidden; }
#load-strip .ls-bar span { display: block; height: 100%; width: 0; transition: width 0.3s ease; }
#load-strip [data-key="ozy"], #load-strip i.ozy { background: var(--accent); }
#load-strip [data-key="other"], #load-strip i.other { background: #8a8a95; }
#load-strip [data-key="free"], #load-strip [data-key="idle"], #load-strip i.free { background: #2e2e35; }
#load-strip .ls-text { width: 300px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
#load-strip .ls-legend { display: flex; align-items: center; gap: 6px; color: var(--muted); margin-top: 2px; }
#load-strip .ls-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-left: 8px; }
#load-strip .ls-legend .spacer { flex: 1 1 auto; }
#load-strip .ls-legend button { background: none; border: 1px solid #333338; color: var(--text); border-radius: 4px; padding: 1px 8px; cursor: pointer; font: inherit; }
#load-strip .ls-table { overflow: auto; flex: 1 1 auto; margin-top: 4px; }
#load-strip .ls-table[hidden] { display: none; }
```

`#timeline` is a sibling in the main column (`style.css:646`), so placing `#load-strip` right before it docks it above the timeline.

- [ ] **Step 7: Wiring**

Replace the load viewer block in `app.js` (`~4805-4845`) with one that drives both views:

```js
// ---------- load viewer: docked strip (live bars) and the pop-out table ----------
// Twice a second while either is showing: Ozy against everything else (totals from main,
// lib/loadstats.js does the arithmetic) and a row per tile. Reads nothing about other programs.
const loadPanel = document.getElementById('load-panel');
const optLoad = document.getElementById('opt-load');
const loadStrip = document.getElementById('load-strip');
const loadBtn = document.getElementById('btn-load');
let loadTimer = null;
const tileState = (t) => (!t.pb ? (t.type || 'image') : t.autoPaused ? 'auto-paused' : t.pb.paused ? 'paused' : 'playing');
const loadShowing = () => !loadPanel.hidden || !loadStrip.hidden;
function fillRows(tbody) {
  const rows = LoadStats.rows(tiles.map((t) => {
    const v = t.video;
    const q = v && typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    return { name: tileName(t), width: v ? v.videoWidth : 0, height: v ? v.videoHeight : 0, tier: t.tier, state: tileState(t), dropped: q ? q.droppedVideoFrames : undefined };
  }));
  tbody.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of [r.name, r.res, r.tier, r.state, r.dropped, r.estMB ? LoadStats.fmt(r.estMB) : '–']) { const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td); }
    tr.firstChild.title = r.name;
    tbody.appendChild(tr);
  }
}
async function refreshLoad() {
  if (!loadShowing()) return;
  let raw = null, s = null;
  try { raw = await window.api.loadStats(); s = LoadStats.split(raw); } catch {}
  const pct = (v) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) + '%';
  const otherCpu = !raw || raw.sysCpu === null ? '…' : pct(s.other.cpu);
  if (!loadPanel.hidden) {
    loadPanel.querySelector('.lp-sum').textContent = s
      ? `Ozy ${pct(s.ozy.cpu)} CPU · ${LoadStats.fmt(s.ozy.memMB)} (${LoadStats.fmt(s.ozy.gpuMemMB)} GPU) · Everything else ${otherCpu} CPU · ${LoadStats.fmt(s.other.memMB)} · ${LoadStats.fmt(s.freeMB)} free`
      : 'unavailable';
    fillRows(loadPanel.querySelector('tbody'));
  }
  if (!loadStrip.hidden) {
    const b = LoadStats.bars(s, raw ? raw.totalMemMB : 0);
    for (const seg of b.mem) loadStrip.querySelector(`.ls-mem [data-key="${seg.key}"]`).style.width = seg.pct + '%';
    for (const seg of b.cpu) loadStrip.querySelector(`.ls-cpu [data-key="${seg.key}"]`).style.width = seg.pct + '%';
    loadStrip.querySelector('.ls-mem-text').textContent = s ? `Ozy ${LoadStats.fmt(s.ozy.memMB)} · else ${LoadStats.fmt(s.other.memMB)} · free ${LoadStats.fmt(s.freeMB)} of ${LoadStats.fmt(raw.totalMemMB)}` : 'unavailable';
    loadStrip.querySelector('.ls-cpu-text').textContent = s ? `Ozy ${pct(s.ozy.cpu)} · else ${otherCpu}` : 'unavailable';
    const tbl = loadStrip.querySelector('.ls-table');
    if (!tbl.hidden) fillRows(tbl.querySelector('tbody'));
  }
}
function syncLoadTimer() {
  clearInterval(loadTimer); loadTimer = null;
  if (loadShowing()) { refreshLoad(); loadTimer = setInterval(refreshLoad, 500); }
}
function setLoadViewer(on) {            // the pop-out, from Optimize ▾
  loadPanel.hidden = !on;
  optLoad.checked = on;
  syncLoadTimer();
}
function setLoadStrip(on) {             // the docked strip, from the Load button; remembered
  settings.loadStrip = !!on;
  saveSettings();
  loadStrip.hidden = !settings.loadStrip;
  loadBtn.classList.toggle('toggled', settings.loadStrip);
  loadStrip.style.setProperty('--ls-h', settings.loadStripH + 'px');
  syncLoadTimer();
  layoutTiles(); // the board viewport changed height
}
optLoad.addEventListener('change', () => setLoadViewer(optLoad.checked));
loadPanel.querySelector('.lp-close').addEventListener('click', () => setLoadViewer(false));
loadBtn.addEventListener('click', () => setLoadStrip(!settings.loadStrip));
loadStrip.querySelector('.ls-close').addEventListener('click', () => setLoadStrip(false));
loadStrip.querySelector('.ls-videos').addEventListener('click', (e) => {
  const tbl = loadStrip.querySelector('.ls-table');
  tbl.hidden = !tbl.hidden;
  e.currentTarget.textContent = tbl.hidden ? 'Videos ▾' : 'Videos ▴';
  if (!tbl.hidden && settings.loadStripH < 200) { settings.loadStripH = 220; saveSettings(); loadStrip.style.setProperty('--ls-h', '220px'); layoutTiles(); }
  refreshLoad();
});
// drag the top edge to resize, same idea as the timeline grip (app.js ~832)
loadStrip.querySelector('.ls-grip').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const grip = e.currentTarget;
  try { grip.setPointerCapture(e.pointerId); } catch {}
  const y0 = e.clientY, h0 = settings.loadStripH;
  const onMove = (ev) => {
    settings.loadStripH = Math.round(clamp(h0 + (y0 - ev.clientY), 56, 400));
    loadStrip.style.setProperty('--ls-h', settings.loadStripH + 'px');
  };
  const onUp = () => {
    grip.removeEventListener('pointermove', onMove); grip.removeEventListener('pointerup', onUp); grip.removeEventListener('pointercancel', onUp);
    saveSettings(); layoutTiles();
  };
  grip.addEventListener('pointermove', onMove); grip.addEventListener('pointerup', onUp); grip.addEventListener('pointercancel', onUp);
});
```

Where settings are applied after load (the block that sets `wheelZoomEl.checked`, grep -an `wheelZoomEl.checked =`), add `setLoadStrip(settings.loadStrip);` but guard `saveSettings` from firing on that initial call if the block runs before settings are fully loaded (simplest: call `loadStrip.hidden = !settings.loadStrip; loadBtn.classList.toggle('toggled', settings.loadStrip); loadStrip.style.setProperty('--ls-h', settings.loadStripH + 'px'); syncLoadTimer();` there instead of `setLoadStrip`). Check whether `layoutTiles` already runs after that block; if not, call it.

`clamp` exists at `app.js:~97`.

- [ ] **Step 8: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: press Load: a strip docks above the timeline with two bars in three colours and text in MB/GB. Play six videos: the Ozy segment grows visibly. Drag the strip's top edge: it resizes between 56 and 400 px and the board re-lays out; relaunch: the strip and its height come back. Videos ▾ opens the table inside the strip. Optimize ▾ → "Show load viewer (pop-out)" still opens the old panel, both update together. Over CDP, replace `window.api.loadStats` with a function that throws: both views read "unavailable" and nothing is logged as an error. Close the app.

- [ ] **Step 9: Commit**

```bash
git add lib/loadstats.js lib/loadstats.test.js lib/settings.js lib/settings.test.js app.js index.html style.css
git commit -m "feat: docked, resizable load strip with live memory and CPU bars; pop-out kept"
```

---

### Task 5: Board clicks that died with pointer capture

Since `7402f41` (v0.2.0.11) a board tile takes pointer capture at pointerdown, so Chromium delivers `click`/`dblclick` to the tile element, not to the `<video>`, markers or time readout. Plan A fixed single-click play with `tileClick` (an `elementFromPoint` lookup). The rest is still dead on the board: double-click to fullscreen, bookmark-marker clicks, and the time readout's clock/frames/timecode cycle.

**Files:**
- Modify: `app.js`: `tileClick` (grep -an `function tileClick`), `addVideo`'s `dblclick` handler (grep -an `toggleTileFullscreen(el)`), the marker click handler (grep -an `mk.addEventListener('click'`), the time readout handler (grep -an `timeEl.addEventListener('click'`), and the matching sites in `addSequenceTile` / `addWebTile` (stream `<video>`)
- Modify: `lib/clickguard.js` if `tileClick`'s pure rule (`ClickGuard.clickPlays`) needs a `dblclick` variant; `lib/clickguard.test.js`

**Interfaces:**
- Consumes: `tileClick(tile, e)` from plan A and `ClickGuard.clickPlays`.
- Produces: `tileDblClick(tile, e)` → fullscreen when the element under the pointer is the picture; `tileClick` grows two branches: a `.markers` child → jump to that bookmark (the same code the marker's own handler runs), `.time` → cycle the time display.

- [ ] **Step 1: Write the failing test**

Read `ClickGuard.clickPlays` and its tests first. Add a test for the routing rule in the same style, for example:

```js
test('clickTarget: picture, marker, time readout or nothing', () => {
  const at = (sel) => (s) => s === sel;           // "the element under the pointer matches s"
  assert.equal(ClickGuard.clickTarget(at('video'), { ezPlay: false }), 'picture');
  assert.equal(ClickGuard.clickTarget(at('.markers .mk'), { ezPlay: false }), 'marker');
  assert.equal(ClickGuard.clickTarget(at('.time'), { ezPlay: false }), 'time');
  assert.equal(ClickGuard.clickTarget(at('button'), { ezPlay: false }), null);
  assert.equal(ClickGuard.clickTarget(at('.overlay .top'), { ezPlay: true }), 'picture'); // EZ play: chrome counts as the picture
});
```

Adapt the signature to how `clickPlays` is shaped (it takes a `closest`-style matcher per plan A's hand-back); the rule is: `'marker'` and `'time'` before `'picture'`, and controls return `null`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/clickguard.test.js` → FAIL.

- [ ] **Step 3: Implement**

Add `clickTarget` to `lib/clickguard.js` and make `clickPlays` call it (or keep `clickPlays` and add the routing beside it; do not break plan A's tests). In `app.js`, extend `tileClick` so a `'marker'` result calls the marker's jump (factor the marker handler's body into `jumpToMarker(tile, mkEl)` and have both call it, keeping the old listener in place for the gallery) and a `'time'` result runs the time-display cycle (factor it into `cycleTimeDisplay()`). Add `tileDblClick(tile, e)` next to `tileClick`: under the pointer is the picture → `toggleTileFullscreen(tile.el)` unless the compare view is open; wire `el.addEventListener('dblclick', (e) => tileDblClick(tile, e))` on the same tiles that got `tileClick`. Keep the original `video.addEventListener('dblclick', ...)` for the gallery, with a guard so the board path does not fire twice (the video never receives it on the board, so the guard is only defensive; note it in a comment).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test` → PASS.

- [ ] **Step 5: Manual check**

Isolated profile, board mode, local video with two bookmarks. Double-click the picture: fullscreen; Esc leaves. Click a marker: the video jumps to it. Click the time readout: it cycles clock → frames → timecode. Single click still plays/pauses, and a double-click does not leave the video in the opposite play state from before (if it does, debounce the single-click toggle by 250 ms when a dblclick follows; say so in the commit). Repeat in gallery mode. Close the app.

- [ ] **Step 6: Commit**

```bash
git add lib/clickguard.js lib/clickguard.test.js app.js
git commit -m "fix: double-click fullscreen, bookmark markers and the time readout work on the board again"
```

---

### Task 6: Hand-off

- [ ] `npm test` green on the branch. Push `feat/tidy-and-load-strip` (no PR).
- [ ] Reply to the hub window (`scott fable windows 1 (work here)`) with: commit list, changes from the plan and why, what you could not verify.
