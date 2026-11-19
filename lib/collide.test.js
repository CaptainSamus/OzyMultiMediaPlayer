const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./collide');

const r = (x, y, w, h) => ({ x, y, w, h });

test('nothing in the way: the drag goes where it is asked', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(500, 0, 100, 100)]);
  assert.deepEqual(C.nearest(z, 200, 50), { x: 200, y: 50 });
});
test('dragging into a neighbour stops against its edge, the neighbour stays', () => {
  const m = r(0, 0, 100, 100), o = r(300, 0, 100, 100);
  const z = C.zones([m], [o]);
  // asked for x 250: it would overlap by 50; it stops touching at shift 200
  assert.deepEqual(C.nearest(z, 250, 0), { x: 200, y: 0 });
  assert.deepEqual(o, r(300, 0, 100, 100));
});
test('dragging past the middle of what is in the way hops to its far side', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 100, 100)]);
  // asked shift 360: left edge at 360, past the obstacle's middle; nearest clear is x 400
  assert.deepEqual(C.nearest(z, 360, 0), { x: 400, y: 0 });
});
test('sliding along an edge keeps the other axis free', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 100, 100)]);
  assert.deepEqual(C.nearest(z, 230, 40), { x: 200, y: 40 });
});
test('a gap between two neighbours that is too small is skipped to the nearest clear place', () => {
  // moving 100 wide; obstacles at 200..300 and 350..450: the 50 px gap cannot hold it
  const z = C.zones([r(0, 0, 100, 100)], [r(200, 0, 100, 100), r(350, 0, 100, 100)]);
  const p = C.nearest(z, 260, 0);
  assert.ok(C.clear(z, p.x, p.y));
  assert.deepEqual(p, { x: 260, y: -100 }); // (just above the row is nearer than back to the left)
});
test('a corner pocket: blocked both ways, it lands in the corner', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 100, 400), r(0, 300, 300, 100)]);
  const p = C.nearest(z, 230, 230);
  assert.ok(C.clear(z, p.x, p.y));
  assert.deepEqual(p, { x: 200, y: 200 });
});
test('things that already overlap when the drag starts can move over each other', () => {
  const caption = r(10, 10, 50, 20), picture = r(0, 0, 200, 150);
  const z = C.zones([caption], [picture]);
  assert.equal(z.length, 0);
  assert.deepEqual(C.nearest(z, 40, 40), { x: 40, y: 40 });
});
test('touching counts as clear', () => {
  assert.equal(C.overlap(r(0, 0, 100, 100), r(100, 0, 100, 100)), false);
  assert.equal(C.overlap(r(0, 0, 100, 100), r(99, 0, 100, 100)), true);
});
test('a group moves as one: the member nearest the obstacle stops it', () => {
  const z = C.zones([r(0, 0, 100, 100), r(120, 0, 100, 100)], [r(400, 0, 100, 100)]);
  assert.deepEqual(C.nearest(z, 230, 0), { x: 180, y: 0 });
});
test('growing into a neighbour stops where it touches', () => {
  const start = r(0, 0, 100, 100), o = r(150, 0, 100, 100);
  const place = (h) => [r(0, 0, h, h)];
  const h = C.largest(place, [start], [o], 100, 300);
  assert.ok(Math.abs(h - 150) < 0.5, String(h));
  assert.equal(C.largest(place, [start], [r(500, 500, 10, 10)], 100, 300), 300);
});
test('growing over something it already overlapped is not stopped by it', () => {
  const start = r(0, 0, 100, 100), sticker = r(50, 50, 20, 20);
  assert.equal(C.largest((h) => [r(0, 0, h, h)], [start], [sticker], 100, 300), 300);
});

// how a drag moves: rests against the edge, slides along it, goes past only to a clear place
test('a hard push into a neighbour rests against its edge (it does not slip round the side)', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 160, 100)]);
  assert.deepEqual(C.move(z, { x: 0, y: 0 }, { x: 250, y: 0 }), { x: 200, y: 0 });
  assert.deepEqual(C.move(z, { x: 200, y: 0 }, { x: 330, y: 0 }), { x: 200, y: 0 });
});
test('moving the mouse up or down slides it along the edge', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 160, 100)]);
  assert.deepEqual(C.move(z, { x: 200, y: 0 }, { x: 260, y: 40 }), { x: 200, y: 40 });
});
test('once the place under the mouse is clear of it, it goes there', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 160, 100)]);
  assert.deepEqual(C.move(z, { x: 200, y: 0 }, { x: 470, y: 0 }), { x: 470, y: 0 });
});
test('a fast drag does not pass through: it stops at the first thing in its way', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 100, 100), r(600, 0, 100, 100)]);
  assert.deepEqual(C.move(z, { x: 0, y: 0 }, { x: 550, y: 0 }), { x: 200, y: 0 });
});
test('into a corner: both ways blocked, it rests in the corner', () => {
  const z = C.zones([r(0, 0, 100, 100)], [r(300, 0, 100, 400), r(0, 300, 300, 100)]);
  assert.deepEqual(C.move(z, { x: 0, y: 0 }, { x: 250, y: 260 }), { x: 200, y: 200 });
});
