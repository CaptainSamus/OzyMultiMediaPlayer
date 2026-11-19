const test = require('node:test');
const assert = require('node:assert');
const LineTile = require('./linetile.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('normalize fills defaults and clamps', () => {
  assert.deepStrictEqual(LineTile.normalize(null), LineTile.DEFAULTS);
  const s = LineTile.normalize({ color: '#ABCDEF', width: 1e9, dash: 'wavy', start: 'arrow', end: 'bogus' });
  assert.strictEqual(s.color, '#abcdef');
  assert.strictEqual(s.width, LineTile.MAX_W);
  assert.strictEqual(s.dash, 'solid');
  assert.strictEqual(s.start, 'arrow');
  assert.strictEqual(s.end, 'none');
  assert.strictEqual(LineTile.normalize({ width: -3 }).width, LineTile.MIN_W);
  assert.strictEqual(LineTile.normalize({ color: 'red' }).color, LineTile.DEFAULTS.color);
});

test('fromAbs / toAbs round trip, a level line keeps a box with height', () => {
  const style = { width: 4 };
  const r = LineTile.fromAbs([{ x: 10, y: 50 }, { x: 110, y: 50 }], style);
  assert.ok(r.board.h > 0);
  near(r.board.h, 2 * LineTile.pad(style));
  const back = LineTile.toAbs(r.board, r.points);
  near(back[0].x, 10); near(back[0].y, 50); near(back[1].x, 110); near(back[1].y, 50);
  // moving or scaling the box moves the line with it
  const moved = LineTile.toAbs({ ...r.board, x: r.board.x + 5, y: r.board.y - 7 }, r.points);
  near(moved[0].x, 15); near(moved[1].y, 43);
  assert.strictEqual(LineTile.fromAbs([{ x: 1, y: 1 }], style), null);
});

test('arrowheads make more room in the box', () => {
  assert.ok(LineTile.pad({ width: 2, end: 'arrow' }) > LineTile.pad({ width: 2 }));
});

test('cleanPoints', () => {
  assert.deepStrictEqual(LineTile.cleanPoints([[0, 0.5], [1, 0.5]]), [[0, 0.5], [1, 0.5]]);
  assert.strictEqual(LineTile.cleanPoints([[0, 0]]), null);
  assert.strictEqual(LineTile.cleanPoints('x'), null);
  assert.deepStrictEqual(LineTile.cleanPoints([[0, 0], ['a', 1], [1, 1, 9]]), [[0, 0], [1, 1]]);
});

test('snapEnd: nearly level or upright snaps; Shift steps; otherwise free', () => {
  assert.deepStrictEqual(LineTile.snapEnd({ x: 0, y: 0 }, { x: 100, y: 3 }), { x: 100, y: 0 });
  assert.deepStrictEqual(LineTile.snapEnd({ x: 0, y: 0 }, { x: -100, y: 4 }), { x: -100, y: 0 });
  assert.deepStrictEqual(LineTile.snapEnd({ x: 0, y: 0 }, { x: 2, y: -80 }), { x: 0, y: -80 });
  assert.deepStrictEqual(LineTile.snapEnd({ x: 0, y: 0 }, { x: 100, y: 30 }), { x: 100, y: 30 });
  const d = LineTile.snapEnd({ x: 0, y: 0 }, { x: 100, y: 90 }, { step: 45 });
  near(d.x, d.y, 1e-9);
});

test('strokeBox: level and upright two-point lines only', () => {
  assert.deepStrictEqual(LineTile.strokeBox([{ x: 50, y: 10 }, { x: 0, y: 10 }], 4), { x: 0, y: 8, w: 50, h: 4, axis: 'h' });
  assert.deepStrictEqual(LineTile.strokeBox([{ x: 5, y: 0 }, { x: 5, y: 30 }], 2), { x: 4, y: 0, w: 2, h: 30, axis: 'v' });
  assert.strictEqual(LineTile.strokeBox([{ x: 0, y: 0 }, { x: 5, y: 30 }], 2), null);
  assert.strictEqual(LineTile.strokeBox([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }], 2), null);
});

test('step and the slider', () => {
  assert.strictEqual(LineTile.step(2, 1), 2.5);
  assert.strictEqual(LineTile.step(2.5, -1), 2);
  assert.strictEqual(LineTile.step(LineTile.MAX_W, 1), LineTile.MAX_W);
  for (const w of [0.1, 1, 2.5, 40, 400]) assert.ok(Math.abs(LineTile.fromSlider(LineTile.toSlider(w)) - w) / w < 0.02, String(w));
  assert.strictEqual(LineTile.toSlider(0.001), 0);
  assert.strictEqual(LineTile.toSlider(1e6), 1000);
});

test('path, arrow, dash', () => {
  assert.strictEqual(LineTile.pathD([{ x: 0, y: 1 }, { x: 2.5, y: 1 }]), 'M0 1 L2.5 1');
  assert.ok(LineTile.arrowD({ x: 0, y: 0 }, { x: 10, y: 0 }, 1).startsWith('M10 0'));
  assert.strictEqual(LineTile.arrowD({ x: 0, y: 0 }, { x: 0, y: 0 }, 1), '');
  assert.deepStrictEqual(LineTile.shorten({ x: 0, y: 0 }, { x: 10, y: 0 }, 4), { x: 6, y: 0 });
  assert.strictEqual(LineTile.dashArray({ width: 2 }), '');
  assert.strictEqual(LineTile.dashArray({ width: 2, dash: 'dashed' }), '8 6');
});

test('route: straight, elbow square to the sides, curve; facing; simplify', () => {
  const A = { x: 0, y: 0, dir: { x: 1, y: 0 } }, B = { x: 100, y: 50, dir: { x: -1, y: 0 } };
  assert.deepStrictEqual(LineTile.route(A, B), [{ x: 0, y: 0 }, { x: 100, y: 50 }]);
  assert.deepStrictEqual(LineTile.route(A, B, 'elbow'), [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 50 }]);
  const c = LineTile.route(A, B, 'curve');
  assert.ok(c.length > 10); assert.deepStrictEqual(c[0], { x: 0, y: 0 }); near(c[c.length - 1].x, 100); near(c[c.length - 1].y, 50);
  assert.deepStrictEqual(LineTile.facing({ x: 0, y: 0, w: 100, h: 100 }, { x: 500, y: 60 }), { fx: 1, fy: 0.5 });
  assert.deepStrictEqual(LineTile.facing({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: -400 }), { fx: 0.5, fy: 0 });
  assert.deepStrictEqual(LineTile.sideDir(0, 0.5), { x: -1, y: 0 });
  assert.strictEqual(LineTile.sideDir(0.3, 0.4), null);
  const wobbly = [{ x: 0, y: 0 }, { x: 1, y: 0.01 }, { x: 2, y: -0.01 }, { x: 3, y: 0 }, { x: 3, y: 5 }];
  assert.deepStrictEqual(LineTile.simplify(wobbly, 0.1), [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 5 }]);
  assert.strictEqual(LineTile.normalize({ route: 'zigzag' }).route, 'straight');
});
