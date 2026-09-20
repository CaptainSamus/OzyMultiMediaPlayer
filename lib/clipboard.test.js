const test = require('node:test');
const assert = require('node:assert/strict');
const TileClipboard = require('./clipboard');

const rec = (x, y, w, h, extra = {}) => ({ type: 'file', path: 'C:/x/a.mp4', board: { x, y, w, h }, ...extra });

test('bbox is null when nothing has a board', () => {
  assert.equal(TileClipboard.bbox([]), null);
  assert.equal(TileClipboard.bbox([{ type: 'file', path: 'C:/x/a.mp4', board: null }]), null);
  assert.equal(TileClipboard.bbox(null), null);
});

test('bbox is the union of every record that has one', () => {
  assert.deepEqual(TileClipboard.bbox([rec(10, 20, 100, 50)]), { x: 10, y: 20, w: 100, h: 50 });
  assert.deepEqual(TileClipboard.bbox([rec(10, 20, 100, 50), rec(200, 0, 60, 300)]), { x: 10, y: 0, w: 250, h: 300 });
  // a boardless record (a gallery-only tile) neither moves the box nor breaks it
  assert.deepEqual(TileClipboard.bbox([rec(10, 20, 100, 50), { type: 'file', path: 'C:/x/b.mp4' }]), { x: 10, y: 20, w: 100, h: 50 });
});

test('placeRecords puts the bbox top-left on the target and keeps the layout', () => {
  const src = [rec(10, 20, 100, 50), rec(210, 120, 60, 40)];
  const out = TileClipboard.placeRecords(src, { x: 100, y: 50 });
  assert.deepEqual(TileClipboard.bbox(out), { x: 100, y: 50, w: 260, h: 140 });
  // the offset between the two is untouched
  assert.equal(out[1].board.x - out[0].board.x, 200);
  assert.equal(out[1].board.y - out[0].board.y, 100);
  // sizes are untouched
  assert.equal(out[0].board.w, 100);
  assert.equal(out[1].board.h, 40);
});

test('placeRecords deep-copies: the originals never move', () => {
  const src = [rec(10, 20, 100, 50, { bookmarks: [{ t: 1, label: 'a' }] })];
  const out = TileClipboard.placeRecords(src, { x: 0, y: 0 });
  assert.deepEqual(src[0].board, { x: 10, y: 20, w: 100, h: 50 });
  assert.notEqual(out[0], src[0]);
  assert.notEqual(out[0].board, src[0].board);
  assert.notEqual(out[0].bookmarks[0], src[0].bookmarks[0]);
  out[0].bookmarks[0].label = 'b';
  assert.equal(src[0].bookmarks[0].label, 'a');
});

test('placeRecords passes a boardless record through as a copy', () => {
  const src = [{ type: 'file', path: 'C:/x/b.mp4', board: null }, rec(10, 20, 100, 50)];
  const out = TileClipboard.placeRecords(src, { x: 0, y: 0 });
  assert.equal(out[0].board, null);
  assert.notEqual(out[0], src[0]);
  assert.deepEqual(out[1].board, { x: 0, y: 0, w: 100, h: 50 });
});

test('placeRecords with no usable target or bbox still copies', () => {
  const src = [{ type: 'text', text: 'hi' }];
  const out = TileClipboard.placeRecords(src, { x: 5, y: 5 });
  assert.deepEqual(out, src);
  assert.notEqual(out[0], src[0]);
  const same = TileClipboard.placeRecords([rec(10, 20, 100, 50)], null);
  assert.deepEqual(same[0].board, { x: 10, y: 20, w: 100, h: 50 });
});

test('cascadePoints stacks boardless records under the placed block', () => {
  const placed = [rec(100, 50, 200, 100), rec(400, 50, 200, 100)]; // bbox 100,50 500x100
  const loose = { type: 'file', path: 'C:/x/c.mp4' };
  const pts = TileClipboard.cascadePoints([placed[0], loose, placed[1], { ...loose }], 8);
  assert.equal(pts.length, 2);
  // first one just below the block, then staggered by 24 like a drop cascade
  assert.deepEqual(pts[0], { x: 100, y: 158 });
  assert.deepEqual(pts[1], { x: 124, y: 182 });
});

test('cascadePoints has nothing to say without loose records or without a block', () => {
  assert.deepEqual(TileClipboard.cascadePoints([rec(0, 0, 10, 10)]), []);
  assert.deepEqual(TileClipboard.cascadePoints([{ type: 'file', path: 'C:/x/c.mp4' }]), []);
  assert.deepEqual(TileClipboard.cascadePoints([]), []);
  assert.deepEqual(TileClipboard.cascadePoints(null), []);
});
