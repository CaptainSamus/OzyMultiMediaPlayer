const test = require('node:test');
const assert = require('node:assert/strict');
const Lod = require('./lod');
const view = { x: 0, y: 0, w: 1000, h: 600 };
const it = (id, x, y, h = 200, extra = {}) => ({ id, rect: { x, y, w: h * 16 / 9, h }, playing: true, budgeted: true, ...extra });

test('off-screen and tiny tiles are stills', () => {
  const live = Lod.choose([it(1, 2000, 0), it(2, 0, 0, 40), it(3, 100, 100)], view, { minPx: 96, cap: 12 });
  assert.deepEqual([...live], [3]);
});
test('the cap keeps the ones nearest the centre', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(it(i, i * 160, 200, 150));  // a row across the view; centre x=500
  const live = Lod.choose(items, view, { minPx: 96, cap: 3 });
  assert.equal(live.size, 3);
  assert.ok(live.has(2) && live.has(3));
});
test('unbudgeted tiles are always live but use up the cap', () => {
  const live = Lod.choose([it('web', 0, 0, 200, { budgeted: false }), it(1, 300, 0), it(2, 600, 0)], view, { minPx: 96, cap: 2 });
  assert.ok(live.has('web'));
  assert.equal(live.size, 2);
});
test('paused tiles still count: a paused visible tile is live (it is cheap, but a swap costs a seek)', () => {
  const live = Lod.choose([it(1, 0, 0, 200, { playing: false })], view, { minPx: 96, cap: 12 });
  assert.ok(live.has(1));
});
test('forced tiles (compare, fullscreen) are live whatever their size or place, and count', () => {
  const live = Lod.choose([it(1, 5000, 5000, 20, { forced: true }), it(2, 0, 0), it(3, 400, 0)], view, { minPx: 96, cap: 2 });
  assert.ok(live.has(1));
  assert.equal(live.size, 2);
});
test('never more budgeted tiles live than the cap, whatever comes in (fuzz)', () => {
  let s = 5; const R = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 200; n++) {
    const cap = 4 + Math.floor(R() * 20);
    const items = Array.from({ length: Math.floor(R() * 60) }, (_, i) => it(i, R() * 1400 - 200, R() * 900 - 150, 20 + R() * 300));
    const live = Lod.choose(items, view, { minPx: 96, cap });
    assert.ok(live.size <= cap, `${live.size} live with cap ${cap}`);
  }
});
