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
  // (was h: 100, which is 14 px of width away: the threshold is now measured in the axis that snaps)
  const r = Snap.resize({ start, corner: 'br', h: 105, aspect: A, others: [{ x: 500, y: 0, w: 192, h: 400 }], th: 8, gap: 8 });
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
// --- final review fixes ---
test('the threshold is the distance the edge really moves, not the change in height', () => {
  // Group scaling about (0,0): the dragged tile is 1000 in, so a small change in height throws its
  // right edge a long way. A neighbour 132 away must not grab it just because that is "only" 8 of height.
  const s = { x: 1000, y: 0, w: 160, h: 90 };
  const r = Snap.resize({ start: s, corner: 'br', h: 92.5, aspect: A, others: [{ x: 1300, y: 900, w: 50, h: 50 }], th: 8, gap: 8, origin: { x: 0, y: 0 } });
  assert.equal(r.h, 92.5);
  assert.equal(r.guideX, null);
});
test('a width snap is judged in width: 14 px of width is not within an 8 px threshold', () => {
  const far = Snap.resize({ start, corner: 'br', h: 100, aspect: A, others: [{ x: 500, y: 900, w: 192, h: 400 }], th: 8, gap: 8 });
  assert.equal(far.h, 100);  // width 177.8 vs 192
  const near = Snap.resize({ start, corner: 'br', h: 105, aspect: A, others: [{ x: 500, y: 900, w: 192, h: 400 }], th: 8, gap: 8 });
  assert.equal(Math.round(near.h * A), 192);
});
test('pull: one tile on its own grows by what the pointer moved, on the axis pulled harder', () => {
  assert.equal(Snap.pull({ start, dx: 0, dy: 30 }), 120);
  assert.equal(Snap.pull({ start, dx: 160, dy: 10 }), 180);   // width doubled
});
test('pull: in a group the handle stays under the pointer wherever the member sits', () => {
  // group box 0..1000 x 0..500 anchored top-left; dragging the bottom-right member's br handle
  // 90 down moves the box's bottom from 500 to 590: a factor of 1.18, not 2
  const s = { x: 840, y: 410, w: 160, h: 90 };
  const h = Snap.pull({ start: s, corner: 'br', dx: 0, dy: 90, origin: { x: 0, y: 0 } });
  assert.ok(Math.abs(h - 90 * 1.18) < 1e-9);
  // a member touching the anchor behaves exactly like a lone tile
  assert.equal(Snap.pull({ start, corner: 'br', dx: 0, dy: 30, origin: { x: 0, y: 0 } }), 120);
});

test('with an origin, same-height and same-width snaps are judged by how far the edge travels', () => {
  // bottom-right member of a 4x4 group anchored at 0,0: its corner moves 4x as far as its height changes
  const s = { x: 480, y: 270, w: 160, h: 90 };
  const far = [{ x: 5000, y: 5000, w: 160, h: 90 }]; // same size, nowhere near an edge
  const origin = { x: 0, y: 0 };
  // 3 units taller = the corner has moved 12: past the 8 threshold, so the pull is not swallowed
  assert.equal(Snap.resize({ start: s, corner: 'br', h: 93, aspect: A, others: far, th: 8, gap: 8, origin }).h, 93);
  assert.equal(Snap.resize({ start: s, corner: 'br', h: 87, aspect: A, others: far, th: 8, gap: 8, origin }).h, 87);
  // 1 unit = the corner moved 4: still inside the threshold, still snaps to the same height
  assert.equal(Snap.resize({ start: s, corner: 'br', h: 91, aspect: A, others: far, th: 8, gap: 8, origin }).h, 90);
  // one tile on its own (no origin) is unchanged: 3 units off still snaps
  assert.equal(Snap.resize({ start: s, corner: 'br', h: 93, aspect: A, others: far, th: 8, gap: 8 }).h, 90);
});
