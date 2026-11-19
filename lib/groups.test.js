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

// ---- sync points (2026-11-18) ----
// A: shots X (0-10) Y (10-20) Z (20-30). B, a different cut: X (0-10) Z (10-20).
const B = { start: 0, duration: 20, points: [{ g: 0, t: 0 }, { g: 20, t: 10 }] };
test('sync points: a part only the main video has makes the follower hold', () => {
  assert.equal(G.at(B, 5), 5);
  assert.equal(G.plays(B, 5), true);
  assert.equal(G.at(B, 15), 10);          // A is in Y: B waits on the first frame of Z
  assert.equal(G.holding(B, 15), true);
  assert.equal(G.plays(B, 15), false);
  assert.equal(G.at(B, 25), 15);          // both in Z again
  assert.equal(G.plays(B, 25), true);
  assert.equal(G.at(B, 40), 20);          // past its end: holds its last frame
  assert.equal(G.plays(B, 40), false);
});
test('sync points: a part only the follower has is jumped over', () => {
  // A: X Z. C: X (0-10) Y (10-20) Z (20-30)
  const C = { start: 0, duration: 30, points: [{ g: 0, t: 0 }, { g: 10, t: 20 }] };
  assert.equal(G.at(C, 9), 9);
  assert.equal(G.at(C, 10), 20);
  assert.equal(G.at(C, 15), 25);
  assert.equal(G.toGroup(C, 25), 15);
  assert.equal(G.toGroup(C, 15), 10);     // inside the part A lacks: where it jumps
  assert.equal(G.toGroup(C, 5), 5);
});
test('sync points: one point is a plain offset, before and after it', () => {
  const D = { start: 99, duration: 50, points: [{ g: 30, t: 12 }] };
  assert.equal(G.at(D, 30), 12);
  assert.equal(G.at(D, 10), 0);           // waits at 0 before its frame 0 comes round
  assert.equal(G.plays(D, 17), false);
  assert.equal(G.plays(D, 18), true);
  assert.deepEqual(G.extent(D), { from: 18, to: 68 });
  assert.equal(G.toGroup(D, 12), 30);
});
test('sync points: no points behaves exactly like start', () => {
  const m = { start: 2.5, duration: 60 };
  for (const g of [0, 1, 2.5, 20, 62.5, 100]) assert.equal(G.at(m, g), G.memberTime(g, 2.5, 60));
  assert.equal(G.plays(m, 2.5), true);
  assert.equal(G.plays(m, 62.5), false);
  assert.equal(G.toGroup(m, 17.5), 20);
  assert.equal(G.end([m, B]), 62.5);
});
test('sync points: toGroup while the follower holds is the point it waits for', () => {
  assert.equal(G.toGroup(B, 10), 20);
  assert.equal(G.toGroup(B, 4), 4);
});
test('sync points: clean, add (re-doing a nearby one), remove, swap', () => {
  assert.equal(G.cleanPoints([]), null);
  assert.equal(G.cleanPoints('x'), null);
  assert.deepEqual(G.cleanPoints([{ g: 5, t: 1 }, { g: 'a', t: 1 }, { g: 1, t: -3 }, null]), [{ g: 1, t: 0 }, { g: 5, t: 1 }]);
  let p = G.addPoint(null, 10, 4);
  p = G.addPoint(p, 30, 20, 2);
  p = G.addPoint(p, 31, 20.6, 2);         // within 2 s of 30: replaces it
  assert.deepEqual(p, [{ g: 10, t: 4 }, { g: 31, t: 20.6 }]);
  assert.deepEqual(G.removePoint(p, 31), [{ g: 10, t: 4 }]);
  assert.equal(G.removePoint([{ g: 1, t: 1 }], 1), null);
  assert.deepEqual(G.shiftPoints(p, 2), [{ g: 12, t: 4 }, { g: 33, t: 20.6 }]);
  // main A start 0, follower B as above: swapped, A follows B with A's times keyed on B's
  assert.deepEqual(G.swapPoints(0, B.points), [{ g: 0, t: 0 }, { g: 10, t: 20 }]);
});
test('loopEnd shortest uses each member\'s extent', () => {
  assert.equal(G.loopEnd('shortest', [{ start: 0, duration: 30 }, B], null), 30);
  assert.equal(G.loopEnd('shortest', [{ start: 0, duration: 40 }, { start: 0, duration: 20, points: [{ g: 5, t: 0 }] }], null), 25);
});
