# Pack Tidy and GPU Bar Implementation Plan (plan D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tidy mode that closes the gaps in an irregular layout the way Scott does by hand: every video keeps its place in reading order and may grow or shrink by at most a chosen percentage so neighbours meet edge to edge. Plus a Justify mode (rows filled edge to edge), a tolerance control, and a GPU bar in the load strip.

**Architecture:** `Arrange.pack` (skyline packing with bounded scaling) and `Arrange.justify` in `lib/arrange.js`, with fuzz tests that measure coverage and scale deviation. A `tidySlack` setting with a small control in the Tidy menu. `LoadStats.parseNvidiaSmi` in `lib/loadstats.js`; `main.js` runs `nvidia-smi` once per load tick when it exists and `app.js` draws a third bar.

**Tech Stack:** Vanilla JS, Electron 33, `node --test`. No new dependencies. `nvidia-smi` is used only when present on the machine.

**Spec:** Scott's brief and screenshots of 2026-10-07: `docs/superpowers/specs/images/2026-10-07-tidy-before.png` (the board as it was) and `docs/superpowers/specs/images/2026-10-07-tidy-scott-hand-sort.webp` (what he made by hand: "I am resizing, but only within a certain amount; it can't make a video double its existing size, but if each video can make small size adjustments then finding the perfect layout is much easier"). Look at both images before writing a line.

## Global Constraints

- Branch `feat/pack-tidy-and-gpu` from `feat/board-polish-and-performance` (head `51c9fdf`, PR #1, tagged v0.2.0.12). One commit per task; push; no version bump, tag or release (the hub tags).
- Pure logic in `lib/*.js` with tests, `app.js` only wires. Every new lib export via `module.exports` / `window.X`.
- `app.js` has a NUL byte and mixed line endings: `grep -an` / `sed -n`, preserve endings. Re-locate line numbers before editing.
- Cut behaviour by commenting out in place.
- Manual checks: isolated `--user-data-dir`, own CDP port, close everything. **Pack and Justify must also be checked by eye**: take a CDP screenshot (`Page.captureScreenshot`, save the PNG, open it with the Read tool) of the board before and after, with a layout rebuilt to resemble `tidy-before.png` (about 22 tiles of four or five sizes, mixed 16:9 and 4:3, one big one in the middle). Compare against `tidy-scott-hand-sort.webp`. The target is "closer to Scott's hand sort than Compact gets", judged by coverage and by looking.
- Sizes in Pack change by at most `slack` (default 0.25) in each direction per tile. Justify is unbounded per row but keeps the ratio between tiles in a row.
- Pack and Justify obey `tidyTargets()` (selection, else board); text tiles sit out (they re-wrap).

## Review Focus

1. Pack must never overlap two tiles and never scale a tile outside `[1 - slack, 1 + slack]` (Task 1 fuzz test).
2. Pack must keep reading order: a tile that was in an earlier row band must not end up below a tile from a later band by more than one row (Task 1 test `reading order kept`).
3. With `slack = 0` Pack must equal a plain skyline packing (sizes untouched), so the tolerance control at 0 % is safe (Task 1 test `slack 0 keeps sizes`).
4. Justify with one tile per row must fill the width exactly (Task 2 test).
5. The GPU bar must show "unavailable" and log nothing on a machine without `nvidia-smi`, and must never block the load tick for more than the tick interval (Task 3: `nvidia-smi` runs with a 400 ms timeout and its last good sample is reused).

---

### Task 1: Tidy → Pack (close the gaps, sizes within a tolerance)

**Files:**
- Modify: `lib/arrange.js` (add `pack`), `lib/arrange.test.js`
- Modify: `lib/settings.js` (`tidySlack`), `lib/settings.test.js`
- Modify: `app.js` Tidy menu block (grep -an `function tidyTargets`), `index.html` Tidy menu

**Interfaces:**
- Produces: `Arrange.pack(items, W, gap, slack)` where `items` is `[{ w, h }]` in reading order and `W` the width to pack into → `[{ x, y, w, h }]` relative to (0,0). Each output keeps `w/h` of its input and has `w` in `[w*(1-slack), w*(1+slack)]`.
- Produces: `Arrange.coverage(rects)` → used area ÷ bounding-box area, for tests and the status line.
- Produces: `settings.tidySlack` (0 to 0.5, default 0.25); `tidyPack()`; a `<select id="tidy-slack">` in the Tidy menu with 0 %, 10 %, 25 %, 50 %.

- [ ] **Step 1: Write the failing tests**

Append to `lib/arrange.test.js`:

```js
const noOverlap = (rs) => { for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (overlaps(rs[i], rs[j])) return false; return true; };
const rnd = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

test('pack: three equal tiles in a width that fits two and a bit stretch to fill the row', () => {
  const r = A.pack([{ w: 160, h: 90 }, { w: 160, h: 90 }, { w: 160, h: 90 }], 400, 8, 0.25);
  // two per row, the row filled edge to edge (greedy: the first grows to +25 %, the second fills
  // what is left); the third goes under whichever is shorter, one gap below it
  assert.equal(Math.round(r[0].w + 8 + r[1].w), 400);
  assert.equal(r[0].y, 0); assert.equal(r[1].y, 0);
  for (const q of r.slice(0, 2)) assert.ok(q.w >= 160 * 0.75 - 1e-6 && q.w <= 160 * 1.25 + 1e-6);
  assert.equal(Math.round(r[2].y), Math.round(Math.min(r[0].h, r[1].h) + 8));
  assert.ok(noOverlap(r));
});
test('pack: slack 0 keeps sizes', () => {
  const items = [{ w: 160, h: 90 }, { w: 120, h: 90 }, { w: 200, h: 150 }];
  const r = A.pack(items, 500, 8, 0);
  r.forEach((q, i) => { assert.equal(q.w, items[i].w); assert.equal(q.h, items[i].h); });
  assert.ok(noOverlap(r));
});
test('pack: never overlaps, never scales outside the slack, keeps aspect (fuzz)', () => {
  const R = rnd(7);
  for (let n = 0; n < 300; n++) {
    const items = Array.from({ length: 5 + Math.floor(R() * 20) }, () => { const h = 60 + R() * 240; const a = [16 / 9, 4 / 3, 1, 9 / 16][Math.floor(R() * 4)]; return { w: h * a, h }; });
    const slack = [0, 0.1, 0.25, 0.5][n % 4];
    const W = 600 + R() * 1200;
    const r = A.pack(items, W, 8, slack);
    assert.equal(r.length, items.length);
    assert.ok(noOverlap(r), `overlap in layout ${n}`);
    r.forEach((q, i) => {
      const f = q.w / items[i].w;
      assert.ok(f >= 1 - slack - 1e-6 && f <= 1 + slack + 1e-6, `scale ${f} outside slack ${slack} in layout ${n}`);
      assert.ok(Math.abs(q.w / q.h - items[i].w / items[i].h) < 1e-6, 'aspect changed');
      assert.ok(q.x >= -1e-6 && q.x + q.w <= W + 1e-6 || items[i].w * (1 - slack) > W, 'outside the width');
    });
  }
});
test('pack: reading order kept', () => {
  const items = [{ w: 300, h: 170 }, { w: 300, h: 170 }, { w: 300, h: 170 }, { w: 300, h: 170 }, { w: 150, h: 85 }, { w: 150, h: 85 }];
  const r = A.pack(items, 650, 8, 0.25);
  // the two small ones come last, so they never sit above any of the big ones
  const bigBottom = Math.max(...r.slice(0, 4).map((q) => q.y));
  assert.ok(r[4].y >= bigBottom - 1e-6 && r[5].y >= bigBottom - 1e-6);
});
test('pack: covers more of its box than compact does on a gappy layout', () => {
  const R = rnd(11);
  const items = Array.from({ length: 18 }, () => { const h = 80 + R() * 200; return { w: h * 16 / 9, h }; });
  const packed = A.pack(items, 1400, 8, 0.25);
  const compacted = A.compact(items.map((it, i) => ({ x: (i % 6) * 240, y: Math.floor(i / 6) * 300, w: it.w, h: it.h })), 8);
  assert.ok(A.coverage(packed) > A.coverage(compacted), `${A.coverage(packed)} vs ${A.coverage(compacted)}`);
  assert.ok(A.coverage(packed) > 0.8, `coverage ${A.coverage(packed)}`);
});
```

(`overlaps` exists in the test file from plan C's compact tests; if its name differs, reuse that one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/arrange.test.js` → FAIL, `A.pack is not a function`.

- [ ] **Step 3: Implement**

Add to `Arrange`:

```js
  // Pack: close the gaps the way a person does by hand. Tiles are laid in reading order on a
  // skyline (the bottom-left heuristic): each one goes to the lowest free stretch, and may grow or
  // shrink by up to `slack` so it fills that stretch exactly. Aspect is kept, so a stretch that is
  // too narrow even at minimum size is widened by merging the next stretch (raising to its
  // height). A tile that cannot fit at all starts a fresh row. Returns rects from (0,0).
  pack(items, W, gap, slack) {
    const lo = 1 - slack, hi = 1 + slack;
    let sky = [{ x: 0, w: W, y: 0 }];                       // free stretches, left to right
    const out = [];
    for (const it of items) {
      let best = null;                                        // { i, j, x, y, w, h, waste }
      for (let i = 0; i < sky.length; i++) {
        let width = 0, y = 0;
        for (let j = i; j < sky.length; j++) {
          width += sky[j].w; y = Math.max(y, sky[j].y);
          const avail = width - (sky[i].x + width < W - 1e-6 ? gap : 0); // keep a gap before the next tile, none at the right edge
          if (avail + 1e-9 < it.w * lo) continue;                          // too narrow: merge one more
          const f = Math.min(hi, Math.max(lo, avail / it.w));
          const w = it.w * f;
          if (w > avail + 1e-9) break;                                     // only when even the min is too wide
          const waste = avail - w;
          const cand = { i, j, x: sky[i].x, y, w, h: it.h * f, waste };
          if (!best || cand.y < best.y - 1e-9 || (Math.abs(cand.y - best.y) <= 1e-9 && cand.waste < best.waste)) best = cand;
          break;                                                           // the first fitting merge from i is the tightest
        }
      }
      if (!best) {                                                         // wider than the whole width even at minimum: own row
        const y = Math.max(...sky.map((s) => s.y));
        const f = Math.min(hi, Math.max(lo, W / it.w));
        best = { i: 0, j: sky.length - 1, x: 0, y, w: it.w * f, h: it.h * f, waste: 0 };
      }
      out.push({ x: best.x, y: best.y, w: best.w, h: best.h });
      // new skyline: the tile's top edge, then whatever was left of the merged stretch
      const merged = sky.slice(best.i, best.j + 1);
      const mergedW = merged.reduce((s, q) => s + q.w, 0);
      const rest = mergedW - best.w - gap;
      const repl = [{ x: best.x, w: best.w + (rest > 1e-6 ? gap : mergedW - best.w), y: best.y + best.h + gap }];
      if (rest > 1e-6) repl.push({ x: best.x + best.w + gap, w: rest, y: best.y });
      sky.splice(best.i, merged.length, ...repl);
      // merge equal-height neighbours so stretches stay few
      for (let k = 0; k < sky.length - 1;) { if (Math.abs(sky[k].y - sky[k + 1].y) <= 1e-6) { sky[k].w += sky[k + 1].w; sky.splice(k + 1, 1); } else k++; }
    }
    return out;
  },
  coverage(rects) {
    if (!rects.length) return 0;
    const bb = { x0: Math.min(...rects.map((r) => r.x)), y0: Math.min(...rects.map((r) => r.y)), x1: Math.max(...rects.map((r) => r.x + r.w)), y1: Math.max(...rects.map((r) => r.y + r.h)) };
    const used = rects.reduce((s, r) => s + r.w * r.h, 0);
    return used / ((bb.x1 - bb.x0) * (bb.y1 - bb.y0));
  },
```

Known weaknesses to tune during the manual check (the fuzz tests must stay green). First, the greedy fill gives the first tile in a row the whole stretch bonus (+25 %) and the next one only the remainder; a fairer version scales every tile in the row by the same factor to fill it, which reads better by eye. Second, a tall tile placed next to short ones leaves a step in the skyline that later tiles fill one at a time. If the eye check shows ragged right edges, add a second pass: after placing all tiles, for each row band (tiles sharing a top within half a tile height) scale the band by one factor ≤ `hi / f_max` so its right edge meets `W`, like Task 2's justify but bounded. Keep it behind the same `slack`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/arrange.test.js` → PASS. The coverage test's numbers are a floor; if Pack scores under 0.8 on that fixture, improve the heuristic (the second pass above) before moving on; do not lower the bar.

- [ ] **Step 5: Setting, menu control, wiring**

`lib/settings.js`: `tidySlack: 0.25` in `defaults()`; in `merge()` `tidySlack: Math.min(0.5, Math.max(0, Number(s.tidySlack))) || (Number(s.tidySlack) === 0 ? 0 : d.tidySlack),` (0 is a valid value; write it so 0 survives). Test:

```js
test('tidySlack: default 0.25, 0 allowed, clamped to 0.5', () => {
  assert.equal(S.merge({}).tidySlack, 0.25);
  assert.equal(S.merge({ tidySlack: 0 }).tidySlack, 0);
  assert.equal(S.merge({ tidySlack: 2 }).tidySlack, 0.5);
});
```

`index.html` Tidy menu: add `Pack` as the first entry and the control at the bottom:

```html
        <button id="tidy-pack" title="Close the gaps: every video keeps its place and may grow or shrink a little so neighbours meet edge to edge (Ctrl+Z undoes)">Pack <small>close gaps, sizes within the limit below</small></button>
        ...existing entries...
        <label class="menu-check" title="How much Pack and Justify may resize a video">Resize up to <select id="tidy-slack"><option value="0">0 %</option><option value="0.1">10 %</option><option value="0.25">25 %</option><option value="0.5">50 %</option></select></label>
```

`app.js`, next to `tidyCompact`:

```js
// Pack: close the gaps, each tile resized by at most settings.tidySlack, reading order kept.
// Whole board: packs into the view's width and refits. Selection: packs into its own width.
function tidyPack() {
  const { list: targets, scoped } = tidyTargets();
  const list = targets.filter((t) => !t.freeAspect); if (!list.length) return;
  const entry = recordResize(list);
  const bb = boardBounds(list);
  const r = gridRect();
  const W = scoped ? bb.w : (r.width - 2 * GAP) / board.zoom;
  const origin = scoped ? { x: bb.minX, y: bb.minY } : toCanvas(r.left + GAP, r.top + GAP);
  const rects = Arrange.pack(list.map((t) => ({ w: t.board.w, h: t.board.h })), W, LINK_GAP, settings.tidySlack);
  list.forEach((t, i) => { t.board = { x: origin.x + rects[i].x, y: origin.y + rects[i].y, w: rects[i].w, h: rects[i].h }; layoutTile(t); });
  finishRects(entry);
  const pct = Math.round(Arrange.coverage(rects) * 100);
  if (scoped) setStatus(`Packed ${list.length} selected videos (${pct}% filled)`); else { fitBoard(); setStatus(`Packed the board (${pct}% filled)`); }
}
document.getElementById('tidy-pack').addEventListener('click', () => { tidyList.hidden = true; tidyPack(); });
const tidySlackEl = document.getElementById('tidy-slack');
tidySlackEl.addEventListener('change', () => { settings.tidySlack = Number(tidySlackEl.value); saveSettings(); });
tidySlackEl.addEventListener('pointerdown', (e) => e.stopPropagation()); // the menu's outside-click closer must not eat it
```

Set `tidySlackEl.value = String(settings.tidySlack)` where settings are applied after load. `boardTilesInOrder()` already sorts by y then x, which is the reading order Pack relies on; if the band grouping is too strict (two tiles at nearly the same y in the wrong order), sort by `Math.round(y / 40)` then x instead and note it.

- [ ] **Step 6: Manual check, by eye**

Build the "before" layout from the screenshot (22 tiles, five sizes, one big in the middle), screenshot it, Tidy ▾ → Pack at 25 %, screenshot again, open both PNGs with the Read tool. Expect: no gaps across rows, right edge straight or nearly, the big tile still big and still roughly where it was, nothing more than 25 % bigger or smaller. Compare to `tidy-scott-hand-sort.webp`. Try 0 % (no resize: gaps come back) and 50 %. Then on a lasso selection. Ctrl+Z. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/arrange.js lib/arrange.test.js lib/settings.js lib/settings.test.js app.js index.html
git commit -m "feat: Tidy → Pack closes gaps with sizes kept within a chosen tolerance"
```

---

### Task 2: Tidy → Justify (rows filled edge to edge)

**Files:**
- Modify: `lib/arrange.js` (add `rowsOf`, `justify`), `lib/arrange.test.js`
- Modify: `app.js` Tidy menu, `index.html`

**Interfaces:**
- Produces: `Arrange.rowsOf(rects)` → array of index arrays: tiles grouped into row bands by their current `y` (a new band starts when a tile's top is below the band's top by more than half the band's height), each band sorted by `x`.
- Produces: `Arrange.justify(rects, W, gap, slack)` → new rects: each band scaled by one factor so its width is exactly `W`, factor clamped to `[1 - slack, 1 + slack]` (with `slack >= 1` meaning unbounded), bands stacked top to bottom one gap apart, from (0,0).

- [ ] **Step 1: Write the failing tests**

```js
test('rowsOf groups by vertical band and orders by x', () => {
  const rows = A.rowsOf([{ x: 300, y: 0, w: 100, h: 100 }, { x: 0, y: 5, w: 100, h: 100 }, { x: 0, y: 200, w: 100, h: 100 }]);
  assert.deepEqual(rows, [[1, 0], [2]]);
});
test('justify: one tile per row fills the width exactly', () => {
  const r = A.justify([{ x: 0, y: 0, w: 160, h: 90 }], 800, 8, 1);
  assert.equal(Math.round(r[0].w), 800); assert.equal(Math.round(r[0].h), 450);
});
test('justify: a row keeps the ratio between its tiles and stacks rows one gap apart', () => {
  const r = A.justify([{ x: 0, y: 0, w: 160, h: 90 }, { x: 170, y: 0, w: 320, h: 180 }, { x: 0, y: 300, w: 100, h: 100 }], 1000, 8, 1);
  assert.equal(Math.round(r[0].w + 8 + r[1].w), 1000);
  assert.ok(Math.abs(r[1].w / r[0].w - 2) < 1e-6);
  assert.equal(Math.round(r[2].y), Math.round(Math.max(r[0].h, r[1].h) + 8));
  assert.equal(Math.round(r[2].w), 1000);
});
test('justify: slack bounds the factor', () => {
  const r = A.justify([{ x: 0, y: 0, w: 160, h: 90 }], 800, 8, 0.25);
  assert.equal(Math.round(r[0].w), 200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/arrange.test.js` → FAIL.

- [ ] **Step 3: Implement**

```js
  rowsOf(rects) {
    const order = rects.map((r, i) => i).sort((a, b) => (rects[a].y - rects[b].y) || (rects[a].x - rects[b].x));
    const rows = [];
    for (const i of order) {
      const r = rects[i];
      const row = rows[rows.length - 1];
      if (row && r.y <= row.top + row.h * 0.5) { row.idx.push(i); row.h = Math.max(row.h, r.h); }
      else rows.push({ top: r.y, h: r.h, idx: [i] });
    }
    return rows.map((row) => row.idx.sort((a, b) => rects[a].x - rects[b].x));
  },
  justify(rects, W, gap, slack) {
    const out = rects.map((r) => ({ ...r }));
    const lo = slack >= 1 ? 0 : 1 - slack, hi = slack >= 1 ? Infinity : 1 + slack;
    let y = 0;
    for (const row of Arrange.rowsOf(rects)) {
      const sumW = row.reduce((s, i) => s + rects[i].w, 0);
      const f = Math.min(hi, Math.max(lo, (W - gap * (row.length - 1)) / sumW));
      let x = 0, rowH = 0;
      for (const i of row) {
        const w = rects[i].w * f, h = rects[i].h * f;
        out[i] = { x, y, w, h };
        x += w + gap; rowH = Math.max(rowH, h);
      }
      y += rowH + gap;
    }
    return out;
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/arrange.test.js` → PASS.

- [ ] **Step 5: Wire**

`index.html`: `<button id="tidy-justify" title="Keep each row's videos together and scale the row to fill the width edge to edge, within the resize limit (Ctrl+Z undoes)">Justify <small>rows filled edge to edge</small></button>` after Pack.

`app.js` `tidyJustify()`: same shape as `tidyPack` but `Arrange.justify(list.map((t) => ({ ...t.board })), W, LINK_GAP, settings.tidySlack)`; note Justify uses the tiles' current rects (it groups by their `y`), so pass rects not just sizes. Status `Justified N rows`. Menu order: Pack, Justify, Align, Compact, Rows, Grid, Fit to view, then the Resize-up-to control.

- [ ] **Step 6: Manual check by eye** (same layout as Task 1): rows become straight and fill the width; the big tile's row scales so it stays big; at 0 % nothing resizes and gaps remain. Screenshot and Read. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/arrange.js lib/arrange.test.js app.js index.html
git commit -m "feat: Tidy → Justify fills each row edge to edge within the resize limit"
```

---

### Task 3: GPU bar in the load strip

**Files:**
- Modify: `lib/loadstats.js` (`parseNvidiaSmi`, `gpuBar`), `lib/loadstats.test.js`
- Modify: `main.js` (`load-stats` gains `gpu`), `index.html` (`#load-strip` third row and legend), `style.css`, `app.js` load block (grep -an `function refreshLoad`)

**Interfaces:**
- Produces: `LoadStats.parseNvidiaSmi(text)` → `{ busy, usedMB, totalMB }` from `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits` output (first GPU line), or `null` when unparsable.
- Produces: `LoadStats.gpuBar(gpu)` → `[{ key: 'used', pct }, { key: 'free', pct }]` from `usedMB/totalMB`, zeros for `null`.
- Produces: IPC `load-stats` result gains `gpu: { busy, usedMB, totalMB } | null`.

- [ ] **Step 1: Write the failing tests**

```js
test('parseNvidiaSmi reads the first GPU line', () => {
  assert.deepEqual(L.parseNvidiaSmi('34, 2150, 12288\n'), { busy: 34, usedMB: 2150, totalMB: 12288 });
  assert.deepEqual(L.parseNvidiaSmi('12, 500, 8192\n3, 100, 8192\n'), { busy: 12, usedMB: 500, totalMB: 8192 });
  assert.equal(L.parseNvidiaSmi(''), null);
  assert.equal(L.parseNvidiaSmi('NVIDIA-SMI has failed'), null);
});
test('gpuBar: used of total, zeros when unknown', () => {
  assert.deepEqual(L.gpuBar({ busy: 34, usedMB: 3072, totalMB: 12288 }), [{ key: 'used', pct: 25 }, { key: 'free', pct: 75 }]);
  assert.deepEqual(L.gpuBar(null), [{ key: 'used', pct: 0 }, { key: 'free', pct: 0 }]);
});
```

- [ ] **Step 2: Run to verify fail** → `node --test lib/loadstats.test.js` FAIL.

- [ ] **Step 3: Implement**

`lib/loadstats.js`:

```js
    parseNvidiaSmi(text) {
      const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(l));
      if (!line) return null;
      const [busy, usedMB, totalMB] = line.split(',').map((v) => Number(v.trim()));
      return { busy, usedMB, totalMB };
    },
    gpuBar(gpu) {
      if (!gpu || !(gpu.totalMB > 0)) return [{ key: 'used', pct: 0 }, { key: 'free', pct: 0 }];
      const used = Math.max(0, Math.min(100, gpu.usedMB / gpu.totalMB * 100));
      return [{ key: 'used', pct: Math.round(used) }, { key: 'free', pct: Math.round(100 - used) }];
    },
```

`main.js`, in the load-viewer section:

```js
// GPU: whole-machine busy % and VRAM from the driver's own tool when it exists (NVIDIA only).
// Windows gives no per-process VRAM, so Ozy's share is the GPU-process working set shown beside it.
const nvidiaSmi = (() => {
  const cands = process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe')] : ['/usr/bin/nvidia-smi'];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
})();
let gpuLast = null, gpuBusy = false;
function sampleGpu() {
  if (!nvidiaSmi || gpuBusy) return;
  gpuBusy = true;
  execFile(nvidiaSmi, ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 400 }, (err, stdout) => {
    gpuBusy = false;
    if (!err) { const g = LoadStats.parseNvidiaSmi(stdout); if (g) gpuLast = g; }
  });
}
```

In the `load-stats` handler: call `sampleGpu()` (it fills `gpuLast` for the next tick) and add `gpu: gpuLast` to the returned object. `execFile` is already imported near the proxy code; if `main.js` declares it below this point, move the GPU block under that declaration.

`index.html` `#load-strip`: add a third row after CPU: `<div class="ls-row"><span class="ls-label">GPU</span><div class="ls-bar ls-gpu"><span data-key="used"></span><span data-key="free"></span></div><span class="ls-text ls-gpu-text">…</span></div>`. Legend: add `<i class="used"></i> GPU used` or reuse the Ozy/other colours; `used` should be the "other" grey since it is the whole machine, with the text carrying Ozy's number.

`style.css`: `#load-strip [data-key="used"] { background: #8a8a95; }`. Bump the strip's default height if three rows no longer fit at 120 px (settings default `loadStripH` 120 → 140 and the min 56 → 76; adjust the test).

`app.js` `refreshLoad`, in the strip branch:

```js
    const gb = LoadStats.gpuBar(raw ? raw.gpu : null);
    for (const seg of gb) loadStrip.querySelector(`.ls-gpu [data-key="${seg.key}"]`).style.width = seg.pct + '%';
    loadStrip.querySelector('.ls-gpu-text').textContent = raw && raw.gpu
      ? `${raw.gpu.busy}% busy · ${LoadStats.fmt(raw.gpu.usedMB)} of ${LoadStats.fmt(raw.gpu.totalMB)} VRAM (Ozy ${LoadStats.fmt(s.ozy.gpuMemMB)})`
      : (s ? `unavailable here (Ozy ${LoadStats.fmt(s.ozy.gpuMemMB)})` : 'unavailable');
```

Also include the GPU figures in the pop-out's summary line.

- [ ] **Step 4: Run tests** → `npm test` PASS.

- [ ] **Step 5: Manual check**

This box has `C:\Windows\System32\nvidia-smi.exe`. Isolated profile: Load strip shows a GPU row with busy % and VRAM; play six clips and watch busy rise. Temporarily rename nothing; instead verify the no-NVIDIA path by evaluating `nvidiaSmi` logic with a bad path in a node one-liner, or set `gpuLast = null` over CDP is not possible (main process), so confirm by code read that a missing tool yields `gpu: null` and the strip shows "unavailable here". Confirm the load tick stays at 500 ms with `nvidia-smi` present (time ten ticks). Close the app.

- [ ] **Step 6: Commit**

```bash
git add lib/loadstats.js lib/loadstats.test.js main.js app.js index.html style.css lib/settings.js lib/settings.test.js
git commit -m "feat: GPU bar in the load strip from nvidia-smi when present"
```

---

### Task 4: Hand-off

- [ ] `npm test` green; push `feat/pack-tidy-and-gpu`.
- [ ] Reply to the hub (`scott fable windows 1 (work here)`) with commits, the before/after PNG paths from the Pack and Justify eye checks, coverage numbers, changes from the plan, and what you could not verify. Attach nothing to the PR; the hub merges.
