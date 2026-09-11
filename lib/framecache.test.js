const test = require('node:test');
const assert = require('node:assert/strict');
const FrameCache = require('./framecache');

test('ranges merges contiguous frames', () => {
  const c = FrameCache.create({ maxBytes: 1e9 });
  for (const n of [8, 1, 3, 2, 7]) c.set(n, {}, 1);
  assert.deepEqual(c.ranges(), [[1, 3], [7, 8]]);
});
test('evicts the least recently used frame once over the byte cap, and closes it', () => {
  const closed = [];
  const bmp = (n) => ({ close: () => closed.push(n) });
  const c = FrameCache.create({ maxBytes: 30 });
  c.set(1, bmp(1), 10); c.set(2, bmp(2), 10); c.set(3, bmp(3), 10);
  c.get(1); // touch 1: now 2 is the oldest
  c.set(4, bmp(4), 10);
  assert.deepEqual([c.has(1), c.has(2), c.has(3), c.has(4)], [true, false, true, true]);
  assert.deepEqual(closed, [2]);
  assert.equal(c.bytes, 30);
});
test('caches sharing a pool share its budget', () => {
  const pool = FrameCache.pool(20);
  const a = FrameCache.create({ pool }), b = FrameCache.create({ pool });
  a.set(1, {}, 10); b.set(1, {}, 10);
  b.set(2, {}, 10); // over 20: a's frame 1 is the oldest in the pool
  assert.deepEqual([a.has(1), b.has(1), b.has(2)], [false, true, true]);
  assert.equal(pool.bytes, 20);
  a.dispose(); b.clear();
  assert.equal(pool.bytes, 0);
});
test('clear empties and set replaces', () => {
  const c = FrameCache.create({ maxBytes: 100 });
  c.set(1, 'x', 5); c.set(1, 'y', 7);
  assert.equal(c.get(1), 'y'); assert.equal(c.bytes, 7);
  c.clear(); assert.equal(c.size, 0); assert.equal(c.bytes, 0);
});
