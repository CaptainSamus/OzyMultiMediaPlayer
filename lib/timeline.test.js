const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./timeline');
test('x and t map linearly over the extent', () => {
  assert.equal(T.xFor(5, 10, 200), 100);
  assert.equal(T.tFor(150, 10, 200), 7.5);
  assert.equal(T.xFor(0, 0, 200), 0);          // empty extent never divides by zero
  assert.equal(T.tFor(-10, 10, 200), 0);        // clamps
  assert.equal(T.tFor(999, 10, 200), 10);
});
test('lanes carry start, duration and end', () => {
  assert.deepEqual(T.lanes([{ start: 2, duration: 5 }]), [{ start: 2, duration: 5, end: 7 }]);
});
test('clampRange keeps in < out inside the extent', () => {
  assert.deepEqual(T.clampRange({ in: -1, out: 50 }, 10), { in: 0, out: 10 });
  assert.deepEqual(T.clampRange({ in: 6, out: 4 }, 10), { in: 4, out: 6 });
  assert.deepEqual(T.clampRange(null, 10), { in: 0, out: 10 });
});
