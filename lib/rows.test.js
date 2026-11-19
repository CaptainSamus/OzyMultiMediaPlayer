const test = require('node:test');
const assert = require('node:assert');
const Rows = require('./rows.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
// three dividers 100 apart from x 0 to 1000, 2 thick: two rows
const guides = [
  { id: 'a', y: 0, x1: 0, x2: 1000, width: 2 },
  { id: 'b', y: 100, x1: 0, x2: 1000, width: 2 },
  { id: 'c', y: 200, x1: 10, x2: 990, width: 2 },
  { id: 'far', y: 150, x1: 5000, x2: 6000, width: 2 }, // another part of the board
];

test('ladder: the lines alongside the one picked, top to bottom', () => {
  assert.deepStrictEqual(Rows.ladder(guides, ['b']).map((g) => g.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(Rows.ladder(guides, ['c', 'a']).map((g) => g.id), ['a', 'c']);
  assert.deepStrictEqual(Rows.ladder(guides, []), []);
});

test('bands sit between the strokes', () => {
  const b = Rows.bands(Rows.ladder(guides, ['a']));
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual([b[0].top, b[0].bottom], [1, 99]);
});

test('tidy: same height, tops level, columns kept (empty slots too), captions follow', () => {
  // row 1: two pictures at middles 40 and 140; row 2: one at middle 45 (same column as the first)
  // and one at 240 (a column of its own: the slot at 140 stays empty)
  const items = [
    { id: 'a', kind: 'picture', board: { x: 20, y: 10, w: 40, h: 60 }, aspect: 40 / 60 },
    { id: 'b', kind: 'picture', board: { x: 115, y: 30, w: 50, h: 50 }, aspect: 1 },
    { id: 'c', kind: 'picture', board: { x: 25, y: 120, w: 40, h: 50 }, aspect: 0.8 },
    { id: 'd', kind: 'picture', board: { x: 220, y: 110, w: 40, h: 40 }, aspect: 1 },
    { id: 't1', kind: 'text', board: { x: 120, y: 72, w: 20, h: 8 } },                    // under b
    { id: 'label', kind: 'text', board: { x: -80, y: 40, w: 60, h: 10 } },                // a row label: no picture there
    { id: 'away', kind: 'picture', board: { x: 3000, y: 50, w: 10, h: 10 }, aspect: 1 },  // not in the rows
  ];
  const { boxes, report } = Rows.tidy(guides, items, { picked: ['b'] });
  const A = boxes.get('a'), B = boxes.get('b'), C = boxes.get('c'), D = boxes.get('d');
  // one height a row: the usual one there (row 1: 60 and 50 -> the median of two is the larger), in the middle
  near(A.h, 60); near(B.h, 60); near(C.h, 50); near(D.h, 50);
  near(A.y, 1 + (98 - 60) / 2); near(B.y, A.y); near(C.y, 101 + (98 - 50) / 2);
  near(A.w / A.h, 40 / 60);
  // a and c share a column: one middle, between where they were
  near(A.x + A.w / 2, C.x + C.w / 2);
  assert.ok(A.x + A.w / 2 >= 40 && A.x + A.w / 2 <= 45);
  near(B.x + B.w / 2, 140); near(D.x + D.w / 2, 240); // their own columns: where they were
  assert.ok(!boxes.has('away') && !boxes.has('label'));
  const t = boxes.get('t1');
  near(t.y, B.y + ((72 - 30) / 50) * B.h);
  near(t.x + t.w / 2, B.x + ((130 - 115) / 50) * B.w);
  assert.deepStrictEqual({ rows: report.rows, pictures: report.pictures, texts: report.texts, columns: report.columns }, { rows: 2, pictures: 4, texts: 1, columns: 1 });
});

test('tidy: never past the lines; a picture grown wider than its slot pushes the next one on', () => {
  const items = [
    { id: 'wide', kind: 'picture', board: { x: 0, y: 30, w: 60, h: 20 }, aspect: 3 },  // grows to 60 x 180
    { id: 'next', kind: 'picture', board: { x: 80, y: 5, w: 120, h: 120 }, aspect: 1 }, // taller than the row
  ];
  const { boxes } = Rows.tidy(guides, items, { picked: ['a'] });
  const W = boxes.get('wide'), N = boxes.get('next');
  const most = 98 * (1 - 2 * Rows.PAD);
  near(W.h, most); near(N.h, most); // the median (70) is past the room: the room it is
  assert.ok(W.y >= 1 && W.y + W.h <= 99);
  assert.ok(N.x >= W.x + W.w - 1e-9);
});

test('tidy leaves alone a picture spanning rows and a row of stacked pictures', () => {
  const items = [
    { id: 'tall', kind: 'picture', board: { x: 10, y: 2, w: 50, h: 186 }, aspect: 50 / 186 }, // middle 95: row 1
    { id: 'top', kind: 'picture', board: { x: 10, y: 105, w: 40, h: 40 }, aspect: 1 },
    { id: 'under', kind: 'picture', board: { x: 15, y: 150, w: 40, h: 40 }, aspect: 1 },
  ];
  const { boxes, report } = Rows.tidy(guides, items, { picked: ['a'] });
  assert.strictEqual(boxes.size, 0);
  assert.strictEqual(report.skippedTall, 1);
  assert.strictEqual(report.skippedStacked, 1);
});

test('trim cuts at the dividers, through the crop', () => {
  const items = [
    { id: 'over', kind: 'picture', board: { x: 60, y: 70, w: 40, h: 40 }, crop: null }, // middle 90: row 1, bottom cut at 99
    { id: 'p', kind: 'picture', board: { x: 10, y: 90, w: 40, h: 100 }, crop: { x: 0, y: 0.2, w: 1, h: 0.5 } },
    { id: 'inside', kind: 'picture', board: { x: 10, y: 20, w: 40, h: 40 } },
  ];
  const { changes, report } = Rows.trim(guides, items, { picked: ['a'] });
  assert.ok(!changes.has('inside'));
  near(changes.get('over').board.h, 29); near(changes.get('over').crop.h, 29 / 40);
  const c = changes.get('p');
  // p's middle (140) is in row 2 (101..199): its top 11 above the row is cut
  near(c.board.y, 101); near(c.board.h, 89);
  near(c.crop.y, 0.2 + (11 / 100) * 0.5); near(c.crop.h, 0.5 * (1 - 11 / 100));
  assert.strictEqual(report.pictures, changes.size);
});

test('tidy: a picture between two columns does not join them into one', () => {
  // columns at 50 and 100 in rows 1 and 2; row 2 also has one at 75 (half way)
  const pic = (id, cx, y) => ({ id, kind: 'picture', board: { x: cx - 10, y, w: 20, h: 20 }, aspect: 1 });
  const items = [pic('a1', 50, 30), pic('b1', 100, 30), pic('a2', 52, 130), pic('m2', 76, 130), pic('b2', 101, 130)];
  const { boxes } = Rows.tidy(guides, items, { picked: ['a'] });
  const mid = (id) => boxes.get(id).x + boxes.get(id).w / 2;
  near(mid('a1'), mid('a2')); near(mid('b1'), mid('b2'));
  assert.ok(mid('b1') - mid('a1') > 40); // still two columns, not one
});

test('tidy: a pile of pictures moves as one, and pictures laid over each other keep their overlap', () => {
  const items = [
    { id: 'under', kind: 'picture', board: { x: 0, y: 20, w: 40, h: 40 }, aspect: 1 },
    { id: 'twin', kind: 'picture', board: { x: 2, y: 22, w: 38, h: 38 }, aspect: 1 },    // nearly all on 'under'
    { id: 'lap', kind: 'picture', board: { x: 30, y: 20, w: 40, h: 40 }, aspect: 1 },    // overlaps 'under' by 10
    { id: 'apart', kind: 'picture', board: { x: 200, y: 20, w: 40, h: 40 }, aspect: 1 },
  ];
  const { boxes, report } = Rows.tidy(guides, items, { picked: ['a'] });
  const U = boxes.get('under'), T = boxes.get('twin'), L = boxes.get('lap');
  const k = U.h / 40;
  near(T.x - U.x, 2 * k); near(T.w, 38 * k); // the twin keeps its place on 'under'
  assert.ok(L.x < U.x + U.w);                 // still laid over 'under', by as much as before
  near(U.x + U.w - L.x, 10 * (L.h / 40));
  assert.strictEqual(report.pictures, 4);
});
