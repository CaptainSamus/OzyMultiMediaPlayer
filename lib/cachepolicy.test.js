const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./cachepolicy');

test('under the cap nothing is evicted', () => {
  assert.deepEqual(C.evict([{ path: 'a', size: 100, atimeMs: 1 }], 1000), []);
});
test('evicts oldest first, only as much as needed', () => {
  const files = [
    { path: 'new', size: 400, atimeMs: 300 },
    { path: 'old', size: 400, atimeMs: 100 },
    { path: 'mid', size: 400, atimeMs: 200 },
  ];
  assert.deepEqual(C.evict(files, 800), ['old']);
  assert.deepEqual(C.evict(files, 400), ['old', 'mid']);
  assert.deepEqual(C.evict(files, 0), ['old', 'mid', 'new']);
});
test('tolerates junk entries', () => {
  assert.deepEqual(C.evict([{ path: 'x', size: NaN, atimeMs: null }, { path: 'y', size: 10, atimeMs: 5 }], 5), ['x', 'y']);
});
test('a file in use counts toward the total but is never evicted', () => {
  const files = [
    { path: 'playing', size: 400, atimeMs: 100, busy: true },
    { path: 'idle', size: 400, atimeMs: 200 },
    { path: 'newest', size: 400, atimeMs: 300 },
  ];
  assert.deepEqual(C.evict(files, 800), ['idle']);            // the oldest is in use: the next oldest goes
  assert.deepEqual(C.evict(files, 0), ['idle', 'newest']);    // over the cap rather than pull a file from under a video
});
