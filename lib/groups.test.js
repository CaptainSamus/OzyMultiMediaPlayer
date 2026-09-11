const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('./groups');

test('starts put the furthest-along member at 0 and everyone else later', () => {
  assert.deepEqual(G.starts([10, 12.5, 9]), [2.5, 0, 3.5]);
  assert.deepEqual(G.starts([0, 0]), [0, 0]);
});
test('memberTime and groupTime are inverses within the member extent', () => {
  assert.equal(G.memberTime(20, 2.5, 60), 17.5);
  assert.equal(G.memberTime(1, 2.5, 60), 0);        // before its start: waits at 0
  assert.equal(G.memberTime(100, 2.5, 60), 60);     // after its end: holds at the end
  assert.equal(G.groupTime(17.5, 2.5), 20);
});
test('end is the latest start+duration', () => {
  assert.equal(G.end([{ start: 0, duration: 10 }, { start: 3, duration: 5 }, { start: 2, duration: 9 }]), 11);
  assert.equal(G.end([]), 0);
});
test('loopEnd per mode', () => {
  const m = [{ start: 0, duration: 10 }, { start: 3, duration: 5 }];
  assert.equal(G.loopEnd('off', m, null), null);
  assert.equal(G.loopEnd('shortest', m, null), 8);
  assert.equal(G.loopEnd('longest', m, null), 10);
  assert.equal(G.loopEnd('range', m, { in: 1, out: 4 }), 4);
  assert.equal(G.loopEnd('range', m, null), 10);    // no range set: whole extent
});
