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
