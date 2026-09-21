const test = require('node:test');
const assert = require('node:assert/strict');
const Scrub = require('./scrub');

test('move lets the first value through and then throttles', () => {
  const s = Scrub.create({ minInterval: 150 });
  assert.equal(s.move(1, 0), 1);
  assert.equal(s.move(2, 50), null);
  assert.equal(s.move(3, 149), null);
  assert.equal(s.move(4, 150), 4); // the interval has passed, measured from the last value let through
  assert.equal(s.move(5, 200), null);
  assert.equal(s.move(6, 300), 6);
});

test('end always commits, and starts the next drag clean', () => {
  const s = Scrub.create({ minInterval: 150 });
  assert.equal(s.move(1, 0), 1);
  assert.equal(s.move(2, 10), null);
  assert.equal(s.end(5), 5);       // the release point goes through whatever the timing
  assert.equal(s.move(6, 151), 6); // a fresh drag is not throttled by the previous one
});

test('the default interval is 150 ms', () => {
  const s = Scrub.create();
  assert.equal(s.move(1, 1000), 1);
  assert.equal(s.move(2, 1100), null);
  assert.equal(s.move(3, 1150), 3);
});

test('a value of 0 is a value, not a miss', () => {
  const s = Scrub.create();
  assert.equal(s.move(0, 0), 0);
  assert.equal(s.end(0), 0);
});
