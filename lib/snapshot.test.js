const test = require('node:test');
const assert = require('node:assert/strict');
const Snapshot = require('./snapshot');

test('diff: adds, removes, moves', () => {
  const d = Snapshot.diff(
    [{ id: 'a', board: { x: 0, y: 0, w: 1, h: 1 } }, { id: 'b', board: { x: 0, y: 0, w: 1, h: 1 } }],
    { seq: 2, videos: [{ id: 'a', board: { x: 5, y: 0, w: 1, h: 1 } }, { id: 'c', board: { x: 0, y: 0, w: 2, h: 2 } }], groups: [] });
  assert.deepEqual(d.add.map((r) => r.id), ['c']);
  assert.deepEqual(d.remove, ['b']);
  assert.deepEqual(d.move, [{ id: 'a', board: { x: 5, y: 0, w: 1, h: 1 }, galleryH: undefined }]);
});
test('diff: unchanged rects are not moves', () => {
  const d = Snapshot.diff([{ id: 'a', board: { x: 1, y: 2, w: 3, h: 4 } }], { seq: 1, videos: [{ id: 'a', board: { x: 1, y: 2, w: 3, h: 4 } }], groups: [] });
  assert.deepEqual(d.move, []);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);
});
test('diff: groups come through as member id lists', () => {
  const d = Snapshot.diff([], { seq: 1, videos: [{ id: 'a', board: null }, { id: 'b', board: null }], groups: [{ id: 1, members: [0, 1], sync: true, sticky: false }] });
  assert.deepEqual(d.regroup, [{ id: 1, members: ['a', 'b'], opts: { sync: true, sticky: false } }]);
});
test('diff: the same groups again are no regroup, a changed option is', () => {
  const groups = [{ id: 1, members: [0, 1], sync: true, sticky: true, name: 'G' }];
  const videos = [{ id: 'a', board: null }, { id: 'b', board: null }];
  const now = Snapshot.groupsOf({ videos, groups });
  assert.equal(Snapshot.diff([{ id: 'a', board: null }, { id: 'b', board: null }], { seq: 2, videos, groups }, now).regroup, null);
  assert.ok(Snapshot.diff([], { seq: 3, videos, groups: [{ ...groups[0], sync: false }] }, now).regroup);
  assert.deepEqual(Snapshot.diff([], { seq: 4, videos, groups: [] }, now).regroup, []); // every group gone
});
test('diff: a tile whose own settings changed is rebuilt; time, play state and place alone are not', () => {
  const rec = { id: 'a', type: 'file', path: 'x.mp4', loop: false, currentTime: 3, paused: true, board: { x: 0, y: 0, w: 1, h: 1 } };
  const cur = [{ id: 'a', board: rec.board, sig: Snapshot.sig(rec) }];
  assert.deepEqual(Snapshot.diff(cur, { seq: 1, videos: [{ ...rec, currentTime: 9, paused: false, playbackRate: 2 }], groups: [] }).rebuild, []);
  const d = Snapshot.diff(cur, { seq: 2, videos: [{ ...rec, loop: true }], groups: [] });
  assert.deepEqual(d.rebuild.map((r) => r.id), ['a']);
});
test('diff: a record without an id is skipped, and ids repeated in a snapshot count once', () => {
  const d = Snapshot.diff([], { seq: 1, videos: [{ board: null }, { id: 'a' }, { id: 'a' }], groups: [] });
  assert.deepEqual(d.add.map((r) => r.id), ['a']);
});
test('stale snapshot ignored', () => {
  assert.equal(Snapshot.accept(5, 4), false);
  assert.equal(Snapshot.accept(5, 5), false);
  assert.equal(Snapshot.accept(5, 6), true);
  assert.equal(Snapshot.accept(0, 1), true);
  assert.equal(Snapshot.accept(5, 'x'), false);
});
