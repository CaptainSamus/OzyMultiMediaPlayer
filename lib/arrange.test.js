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
