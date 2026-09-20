const test = require('node:test');
const assert = require('node:assert/strict');
const Clipboard = require('./clipboard');

const rec = (x, y, w, h, extra = {}) => ({ type: 'file', path: 'C:/x/a.mp4', board: { x, y, w, h }, ...extra });

test('bbox is null when nothing has a board', () => {
  assert.equal(Clipboard.bbox([]), null);
  assert.equal(Clipboard.bbox([{ type: 'file', path: 'C:/x/a.mp4', board: null }]), null);
  assert.equal(Clipboard.bbox(null), null);
});

test('bbox is the union of every record that has one', () => {
  assert.deepEqual(Clipboard.bbox([rec(10, 20, 100, 50)]), { x: 10, y: 20, w: 100, h: 50 });
  assert.deepEqual(Clipboard.bbox([rec(10, 20, 100, 50), rec(200, 0, 60, 300)]), { x: 10, y: 0, w: 250, h: 300 });
  // a boardless record (a gallery-only tile) neither moves the box nor breaks it
  assert.deepEqual(Clipboard.bbox([rec(10, 20, 100, 50), { type: 'file', path: 'C:/x/b.mp4' }]), { x: 10, y: 20, w: 100, h: 50 });
});

test('placeRecords puts the bbox top-left on the target and keeps the layout', () => {
  const src = [rec(10, 20, 100, 50), rec(210, 120, 60, 40)];
  const out = Clipboard.placeRecords(src, { x: 100, y: 50 });
  assert.deepEqual(Clipboard.bbox(out), { x: 100, y: 50, w: 260, h: 140 });
  // the offset between the two is untouched
  assert.equal(out[1].board.x - out[0].board.x, 200);
  assert.equal(out[1].board.y - out[0].board.y, 100);
  // sizes are untouched
  assert.equal(out[0].board.w, 100);
  assert.equal(out[1].board.h, 40);
});

test('placeRecords deep-copies: the originals never move', () => {
  const src = [rec(10, 20, 100, 50, { bookmarks: [{ t: 1, label: 'a' }] })];
  const out = Clipboard.placeRecords(src, { x: 0, y: 0 });
  assert.deepEqual(src[0].board, { x: 10, y: 20, w: 100, h: 50 });
  assert.notEqual(out[0], src[0]);
  assert.notEqual(out[0].board, src[0].board);
  assert.notEqual(out[0].bookmarks[0], src[0].bookmarks[0]);
  out[0].bookmarks[0].label = 'b';
  assert.equal(src[0].bookmarks[0].label, 'a');
});

test('placeRecords passes a boardless record through as a copy', () => {
  const src = [{ type: 'file', path: 'C:/x/b.mp4', board: null }, rec(10, 20, 100, 50)];
  const out = Clipboard.placeRecords(src, { x: 0, y: 0 });
  assert.equal(out[0].board, null);
  assert.notEqual(out[0], src[0]);
  assert.deepEqual(out[1].board, { x: 0, y: 0, w: 100, h: 50 });
});

test('placeRecords with no usable target or bbox still copies', () => {
  const src = [{ type: 'text', text: 'hi' }];
  const out = Clipboard.placeRecords(src, { x: 5, y: 5 });
  assert.deepEqual(out, src);
  assert.notEqual(out[0], src[0]);
  const same = Clipboard.placeRecords([rec(10, 20, 100, 50)], null);
  assert.deepEqual(same[0].board, { x: 10, y: 20, w: 100, h: 50 });
});
