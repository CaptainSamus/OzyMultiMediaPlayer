const test = require('node:test');
const assert = require('node:assert/strict');
const Swap = require('./swap');

const slots = [
  { id: 1, rect: { x: 0, y: 0, w: 100, h: 100 } },
  { id: 2, rect: { x: 110, y: 0, w: 100, h: 100 } },
  { id: 3, rect: { x: 0, y: 110, w: 200, h: 50 } },
];
test('targetAt finds the slot under the point, never the dragged tile', () => {
  assert.equal(Swap.targetAt({ x: 150, y: 50 }, slots, 1), 2);
  assert.equal(Swap.targetAt({ x: 50, y: 50 }, slots, 1), null);   // that is our own slot
  assert.equal(Swap.targetAt({ x: 50, y: 130 }, slots, 1), 3);
});
test('no target means no change', () => {
  assert.equal(Swap.targetAt({ x: 500, y: 500 }, slots, 1), null);
  assert.deepEqual(Swap.apply(slots, 1, null), slots);
});
test('apply exchanges rects, position and size, and leaves the rest alone', () => {
  const out = Swap.apply(slots, 1, 3);
  assert.deepEqual(out.find((s) => s.id === 1).rect, { x: 0, y: 110, w: 200, h: 50 });
  assert.deepEqual(out.find((s) => s.id === 3).rect, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(out.find((s) => s.id === 2).rect, slots[1].rect);
  assert.deepEqual(slots[0].rect, { x: 0, y: 0, w: 100, h: 100 }); // input untouched
});
test('isSwapDrag: Alt-drag on a sticky member, with at least two members', () => {
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: false, shift: false, memberCount: 2 }), true);
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: false, mod: false, shift: false, memberCount: 2 }), false); // plain drag moves the group as before
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: true, shift: false, memberCount: 2 }), false);   // Ctrl pulls one free
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: false, shift: true, memberCount: 2 }), false);   // Shift toggles selection
  assert.equal(Swap.isSwapDrag({ sticky: false, alt: true, mod: false, shift: false, memberCount: 2 }), false); // not sticky: Alt-drag pans
  assert.equal(Swap.isSwapDrag({ sticky: true, alt: true, mod: false, shift: false, memberCount: 1 }), false);
});
test('fitInto: a tile with the slot\'s own shape takes the slot exactly', () => {
  assert.deepEqual(Swap.fitInto({ x: 10, y: 20, w: 160, h: 90 }, 16 / 9), { x: 10, y: 20, w: 160, h: 90 });
});
test('fitInto: a different shape sits centred inside the slot, never stretched', () => {
  // a 4:3 picture in a 16:9 slot: full height, narrower, centred
  assert.deepEqual(Swap.fitInto({ x: 0, y: 0, w: 160, h: 90 }, 4 / 3), { x: 20, y: 0, w: 120, h: 90 });
  // a 16:9 picture in a 4:3 slot: full width, shorter, centred
  assert.deepEqual(Swap.fitInto({ x: 0, y: 0, w: 120, h: 90 }, 16 / 9), { x: 0, y: 11.25, w: 120, h: 67.5 });
});
test('fitInto: no aspect (a text tile) takes the slot as it is', () => {
  assert.deepEqual(Swap.fitInto({ x: 1, y: 2, w: 30, h: 40 }, null), { x: 1, y: 2, w: 30, h: 40 });
});
