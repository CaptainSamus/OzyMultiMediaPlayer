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
test('grid keeps sizes, uses ceil(sqrt(n)) columns, no gap', () => {
  const items = [{ w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 80 }, { w: 100, h: 50 }, { w: 100, h: 50 }];
  const r = A.grid(items, 0);
  assert.deepEqual(r[0], { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(r[2], { x: 200, y: 0, w: 100, h: 80 });   // 3 columns
  assert.deepEqual(r[3], { x: 0, y: 80, w: 100, h: 50 });    // row 2 starts under the tallest of row 1
  assert.deepEqual(r[4], { x: 100, y: 80, w: 100, h: 50 });
});
