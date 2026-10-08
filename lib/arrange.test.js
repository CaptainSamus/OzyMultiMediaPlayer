const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./arrange');
test('fitToView gives one height and keeps everything inside the box', () => {
  const r = A.fitToView([{ aspect: 16 / 9 }, { aspect: 16 / 9 }, { aspect: 1 }], 1000, 500, 8);
  assert.equal(r.rects.length, 3);
  for (const x of r.rects) { assert.ok(x.x >= 0 && x.y >= 0 && x.x + x.w <= 1000 + 0.01 && x.y + x.h <= 500 + 0.01); assert.equal(Math.round(x.h), Math.round(r.height)); }
  assert.ok(r.height > 100);                     // three tiles in 1000x500 should be big
});
test('fitToView with one tile fills the height or width', () => {
  const r = A.fitToView([{ aspect: 2 }], 1000, 500, 0);
  assert.equal(Math.round(r.height), 500);
});
test('packs: per-tile heights, wraps, and says no when a tile is wider than the box', () => {
  assert.ok(A.packs([{ aspect: 16 / 9, h: 100 }, { aspect: 16 / 9, h: 200 }], 1000, 400, 8));  // one row, 200 tall
  assert.ok(!A.packs([{ aspect: 16 / 9, h: 100 }, { aspect: 16 / 9, h: 200 }], 1000, 150, 8)); // taller than the box
  assert.ok(!A.packs([{ aspect: 16 / 9, h: 400 }], 500, 1000, 8));                             // 711 wide in a 500 box
  // wrapping: two rows of 300 plus the gap need 608
  assert.ok(!A.packs([{ aspect: 1, h: 300 }, { aspect: 1, h: 300 }, { aspect: 1, h: 300 }], 700, 600, 8));
  assert.ok(A.packs([{ aspect: 1, h: 300 }, { aspect: 1, h: 300 }, { aspect: 1, h: 300 }], 700, 610, 8));
});
test('fitScale scales everything by one factor, keeping the ratios the user set', () => {
  const items = [{ aspect: 16 / 9, h: 100 }, { aspect: 16 / 9, h: 200 }];
  const f = A.fitScale(items, 1000, 400, 8);
  const scaled = items.map((it) => ({ aspect: it.aspect, h: it.h * f }));
  assert.ok(f > 1 && f < 2);                                  // room to grow, but not twice
  assert.equal(Math.round(scaled[1].h / scaled[0].h), 2);     // 1:2 kept
  assert.ok(A.packs(scaled, 1000, 400, 8));                   // and it fits
  assert.ok(!A.packs(items.map((it) => ({ aspect: it.aspect, h: it.h * f * 1.05 })), 1000, 400, 8)); // as large as it goes
});
test('fitScale with one tile fills the box; an empty gallery stays at 1', () => {
  assert.equal(Math.round(A.fitScale([{ aspect: 2, h: 100 }], 1000, 500, 0) * 100) / 100, 5);
  assert.equal(A.fitScale([], 1000, 500, 8), 1);
});
test('grid keeps sizes, uses ceil(sqrt(n)) columns, no gap', () => {
  const items = [{ w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 80 }, { w: 100, h: 50 }, { w: 100, h: 50 }];
  const r = A.grid(items, 0);
  assert.deepEqual(r[0], { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(r[2], { x: 200, y: 0, w: 100, h: 80 });   // 3 columns
  assert.deepEqual(r[3], { x: 0, y: 80, w: 100, h: 50 });    // row 2 starts under the tallest of row 1
  assert.deepEqual(r[4], { x: 100, y: 80, w: 100, h: 50 });
});

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
test('align: a chain settles outward from the biggest tile, so every gap in the row comes out even', () => {
  // hand-made row: two like tiles, then the big one. The gaps are 14 and 6; both must end up 8,
  // which means the far tile has to follow its neighbour, whatever order the tiles are listed in.
  const big = { x: 740, y: 30, w: 500, h: 300 };
  const r = A.align([{ x: 20, y: 32, w: 350, h: 200 }, { x: 384, y: 36, w: 350, h: 200 }, big], 20, 8);
  assert.deepEqual(r[2], big);
  assert.deepEqual(r[1], { x: 382, y: 30, w: 350, h: 200 });
  assert.deepEqual(r[0], { x: 24, y: 30, w: 350, h: 200 });
});

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
test('compact: no overlaps and no size changes over many scattered and piled-up layouts', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 200; n++) {
    const rects = Array.from({ length: 2 + Math.floor(rnd() * 9) }, () => ({ x: Math.round(rnd() * 900), y: Math.round(rnd() * 600), w: 40 + Math.round(rnd() * 300), h: 40 + Math.round(rnd() * 200) }));
    const r = A.compact(rects, 8);
    for (let i = 0; i < r.length; i++) {
      assert.deepEqual([r[i].w, r[i].h], [rects[i].w, rects[i].h]);
      for (let j = i + 1; j < r.length; j++) assert.ok(!overlaps(r[i], r[j]), `layout ${n}: ${i} overlaps ${j}`);
    }
  }
});
test('compact: what was left stays left, even when the tile on the right started a little higher', () => {
  // settling tile by tile in reading order let the higher right-hand tile slide into the top-left
  // corner and push the left one down; one axis at a time keeps the row as it was
  const r = A.compact([{ x: 40, y: 60, w: 260, h: 150 }, { x: 900, y: 20, w: 260, h: 150 }], 8);
  assert.deepEqual(r[0], { x: 40, y: 20, w: 260, h: 150 });
  assert.deepEqual(r[1], { x: 308, y: 20, w: 260, h: 150 });
});

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
// --- final review fix ---
test('align: lining up with a far tile never pushes a tile into its neighbour', () => {
  // tile 5's right edge is 6 from the right edge of tile 4, a tile 300 px below it; taking that
  // would slide it 6 px into tile 1, which sits right beside it
  const rects = [{ x: 700, y: 99, w: 111, h: 84 }, { x: 105, y: 210, w: 154, h: 330 }, { x: 875, y: 32, w: 351, h: 334 }, { x: 749, y: 682, w: 190, h: 301 }, { x: 23, y: 559, w: 337, h: 223 }, { x: 259, y: 256, w: 107, h: 184 }];
  const r = A.align(rects, 24, 8);
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) assert.ok(!overlaps(r[i], r[j]), `${i} overlaps ${j}`);
});
test('align: a layout with no overlaps never gains one, sizes never change, nothing moves past the threshold', () => {
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 400; n++) {
    const rects = [];
    for (let tries = 0; rects.length < 3 + Math.floor(rnd() * 8) && tries < 200; tries++) {
      const c = { x: Math.round(rnd() * 1200), y: Math.round(rnd() * 900), w: 60 + Math.round(rnd() * 300), h: 60 + Math.round(rnd() * 300) };
      if (!rects.some((q) => overlaps(c, q))) rects.push(c);
    }
    const r = A.align(rects, 24, 8);
    for (let i = 0; i < r.length; i++) {
      assert.deepEqual([r[i].w, r[i].h], [rects[i].w, rects[i].h]);
      assert.ok(Math.abs(r[i].x - rects[i].x) <= 24 + 1e-6 && Math.abs(r[i].y - rects[i].y) <= 24 + 1e-6, `layout ${n}: tile ${i} moved too far`);
      for (let j = i + 1; j < r.length; j++) assert.ok(!overlaps(r[i], r[j]), `layout ${n}: ${i} overlaps ${j}`);
    }
  }
});

// ---------- Pack (plan D) ----------
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
  // the same scattered board for both, handed over the way the app does it: rects with positions
  const board = items.map((it, i) => ({ x: (i % 6) * 240, y: Math.floor(i / 6) * 300, w: it.w, h: it.h }));
  const packed = A.packBoard(board, 8, 0.25).rects;
  const compacted = A.compact(board, 8);
  assert.ok(A.coverage(packed) > A.coverage(compacted), `${A.coverage(packed)} vs ${A.coverage(compacted)}`);
  assert.ok(A.coverage(packed) > 0.8, `coverage ${A.coverage(packed)}`);
});
test('rowsOf groups by vertical band and orders by x', () => {
  const rows = A.rowsOf([{ x: 300, y: 0, w: 100, h: 100 }, { x: 0, y: 5, w: 100, h: 100 }, { x: 0, y: 200, w: 100, h: 100 }]);
  assert.deepEqual(rows, [[1, 0], [2]]);
});
test('packWidth: the width the widest row needs at its present sizes, however far apart the tiles sit', () => {
  // two rows; the top one is 100 + 200 wide with one gap between, scattered across 2000 px
  const w = A.packWidth([{ x: 0, y: 0, w: 100, h: 100 }, { x: 1800, y: 10, w: 200, h: 100 }, { x: 500, y: 400, w: 250, h: 100 }], 8);
  assert.equal(w, 308);
  assert.equal(A.packWidth([], 8), 0);
});

test('pack with positions: never overlaps, never scales outside the slack, keeps aspect, returns every tile (fuzz)', () => {
  const R = rnd(23);
  for (let n = 0; n < 300; n++) {
    const board = Array.from({ length: 3 + Math.floor(R() * 24) }, () => { const h = 60 + R() * 240; const a = [16 / 9, 4 / 3, 1, 9 / 16, 2.39][Math.floor(R() * 5)]; return { x: R() * 2400, y: R() * 1600, w: h * a, h }; });
    const slack = [0, 0.1, 0.25, 0.5][n % 4];
    const fixed = n % 3 === 0 ? 500 + R() * 1500 : 0;
    const res = fixed ? { rects: A.pack(board, fixed, 8, slack), W: fixed } : A.packBoard(board, 8, slack);
    const r = res.rects, W = res.W;
    assert.equal(r.length, board.length);
    assert.ok(r.every(Boolean), `a tile went missing in layout ${n}`);
    assert.ok(noOverlap(r), `overlap in layout ${n}`);
    r.forEach((q, i) => {
      const f = q.w / board[i].w;
      assert.ok(f >= 1 - slack - 1e-6 && f <= 1 + slack + 1e-6, `scale ${f} outside slack ${slack} in layout ${n}`);
      assert.ok(Math.abs(q.w / q.h - board[i].w / board[i].h) < 1e-6, 'aspect changed');
      assert.ok(q.x >= -1e-6 && q.x + q.w <= W + 1e-6 || board[i].w * (1 - slack) > W, 'outside the width');
    });
  }
});
// The board in Scott's screenshot of 2026-10-07 (docs/superpowers/specs/images/2026-10-07-tidy-before.png),
// measured off the picture: 22 tiles, two rows of six, the big one in the middle of the third.
const SCOTT = [
  [60, 53, 130, 73], [208, 46, 143, 80], [356, 53, 142, 80], [502, 55, 135, 76], [641, 65, 123, 69], [769, 65, 123, 69],
  [43, 135, 128, 72], [207, 142, 187, 79], [399, 138, 127, 71], [531, 138, 121, 68], [657, 143, 113, 63], [774, 138, 123, 69],
  [60, 210, 123, 69], [207, 225, 187, 105], [399, 215, 247, 139], [755, 211, 142, 80],
  [76, 284, 127, 71], [694, 296, 203, 114],
  [90, 360, 163, 92], [317, 359, 162, 91], [486, 359, 159, 89],
  [560, 470, 128, 96],
].map(([x, y, w, h]) => ({ x: x * 2, y: y * 2, w: w * 2, h: h * 2 }));
test("pack: Scott's board closes up far better than Compact manages, and stays the board he made", () => {
  for (const slack of [0.1, 0.25, 0.5]) {
    const { rects: r, W, coverage } = A.packBoard(SCOTT, 8, slack);
    assert.ok(noOverlap(r));
    assert.equal(W, A.packWidth(SCOTT, 8), 'rows were re-broken');
    assert.ok(coverage > A.coverage(A.compact(SCOTT, 8)) + 0.1, `coverage ${coverage} at ${slack}`);
    if (slack >= 0.25) assert.ok(coverage > 0.85, `coverage ${coverage} at ${slack}`);
    // the two top rows are still the same six tiles each, left to right, and level
    for (const row of [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]]) {
      for (let k = 1; k < row.length; k++) { assert.ok(r[row[k]].x > r[row[k - 1]].x, 'row order changed'); assert.ok(Math.abs(r[row[k]].y - r[row[0]].y) < 1e-6, 'row not level'); }
    }
    assert.ok(r[6].y > r[0].y);
    // the big one is still the biggest and still in the middle, under the second row
    const big = r[14];
    assert.ok(r.every((q) => q.w * q.h <= big.w * big.h + 1e-6));
    assert.ok(big.x + big.w / 2 > W * 0.3 && big.x + big.w / 2 < W * 0.7, `big tile centre at ${big.x + big.w / 2} of ${W}`);
    assert.ok(big.y > r[6].y);
  }
});
test('pack with positions: a tile that was on the left stays on the left', () => {
  // by order alone the short stretch under the right-hand tile would take whichever came next
  const r = A.pack([{ x: 0, y: 0, w: 200, h: 200 }, { x: 208, y: 0, w: 200, h: 100 }, { x: 0, y: 220, w: 200, h: 100 }, { x: 208, y: 120, w: 200, h: 100 }], 408, 8, 0.25);
  assert.ok(r[2].x < 100 && r[3].x > 100, JSON.stringify(r));
});
