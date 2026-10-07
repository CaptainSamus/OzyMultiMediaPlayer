const test = require('node:test');
const assert = require('node:assert/strict');
const Snap = require('./snap');

const start = { x: 0, y: 0, w: 160, h: 90 }; // 16:9
const A = 16 / 9;

test('rectFor anchors the opposite corner', () => {
  assert.deepEqual(Snap.rectFor(start, 'br', 180, A), { x: 0, y: 0, w: 320, h: 180 });
  assert.deepEqual(Snap.rectFor(start, 'tl', 180, A), { x: -160, y: -90, w: 320, h: 180 });
});
test('snaps the height to a neighbour with the same height', () => {
  const r = Snap.resize({ start, corner: 'br', h: 176, aspect: A, others: [{ x: 500, y: 0, w: 320, h: 180 }], th: 8, gap: 8 });
  assert.equal(r.h, 180);
});
test('snaps the width to a neighbour with the same width', () => {
  const r = Snap.resize({ start, corner: 'br', h: 100, aspect: A, others: [{ x: 500, y: 0, w: 192, h: 400 }], th: 8, gap: 8 });
  assert.equal(Math.round(r.h * A), 192); // width 192 -> height 108
});
test('snaps the moving edge to a neighbour edge, with the gap', () => {
  // growing right toward a tile whose left edge is at x=400: our right edge snaps to 392 (gap 8)
  const r = Snap.resize({ start, corner: 'br', h: 218, aspect: A, others: [{ x: 400, y: 300, w: 100, h: 100 }], th: 8, gap: 8 });
  assert.equal(Math.round(r.h * A), 392);
  assert.equal(r.guideX, 400);
});
test('outside the threshold nothing snaps', () => {
  const r = Snap.resize({ start, corner: 'br', h: 150, aspect: A, others: [{ x: 500, y: 0, w: 320, h: 180 }], th: 8, gap: 8 });
  assert.equal(r.h, 150);
  assert.equal(r.guideX, null); assert.equal(r.guideY, null);
});
test('ignores excluded tiles', () => {
  // the caller passes only the rects that may be snapped to; an empty list means no snap at all
  const r = Snap.resize({ start, corner: 'br', h: 176, aspect: A, others: [], th: 8, gap: 8 });
  assert.equal(r.h, 176);
});
test('the smallest correction wins', () => {
  const r = Snap.resize({ start, corner: 'br', h: 176, aspect: A, others: [{ x: 500, y: 0, w: 10, h: 180 }, { x: 600, y: 0, w: 10, h: 177 }], th: 8, gap: 8 });
  assert.equal(r.h, 177);
});
test('when an edge and a size ask for the same height, the edge wins so its guide shows', () => {
  // neighbour beside us, tops level: "same height" and "bottom edges level" are the same snap
  const r = Snap.resize({ start, corner: 'br', h: 176, aspect: A, others: [{ x: 500, y: 0, w: 320, h: 180 }], th: 8, gap: 8 });
  assert.equal(r.h, 180);
  assert.equal(r.guideY, 180);
});
test('with an origin (group scaling) the moving edge is measured from the group anchor', () => {
  // the tile sits 100 in from the group's top-left; scaling about (0,0) moves its right edge
  // from 260 by the same factor as its height. Neighbour's left edge at 528: with the gap our
  // right edge belongs at 520, which is a factor of 2, so height 180.
  const s = { x: 100, y: 0, w: 160, h: 90 };
  const o = [{ x: 528, y: 500, w: 50, h: 50 }];
  const r = Snap.resize({ start: s, corner: 'br', h: 178, aspect: A, others: o, th: 8, gap: 8, origin: { x: 0, y: 0 } });
  assert.equal(r.h, 180);
  assert.equal(r.guideX, 528);
  // without the origin the same drag is nowhere near an edge
  assert.equal(Snap.resize({ start: s, corner: 'br', h: 178, aspect: A, others: o, th: 8, gap: 8 }).h, 178);
});
test('with an origin, a top-left drag measures the top edge from the group anchor too', () => {
  // group anchored at its bottom-right (400, 300); the tile's top edge starts at 100, so 200 above
  // the anchor. A neighbour's bottom at 0 puts our top at 0: factor 1.5, height 135.
  const s = { x: 100, y: 100, w: 160, h: 90 };
  const r = Snap.resize({ start: s, corner: 'tl', h: 134.5, aspect: A, others: [{ x: 900, y: -80, w: 50, h: 80 }], th: 8, gap: 8, origin: { x: 400, y: 300 } });
  assert.equal(r.h, 135);
  assert.equal(r.guideY, 0);
});
