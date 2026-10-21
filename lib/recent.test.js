const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./recent');

test('push puts the newest first and caps the list', () => {
  let l = [];
  for (let i = 0; i < 12; i++) l = R.push(l, `C:\\s\\${i}.mvp`, 1000 + i, { max: 10, caseInsensitive: true });
  assert.equal(l.length, 10);
  assert.equal(l[0].path, 'C:\\s\\11.mvp');
  assert.equal(l[9].path, 'C:\\s\\2.mvp');
});
test('re-opening moves to the top, case-insensitively on Windows', () => {
  let l = R.push([], 'C:\\s\\a.mvp', 1, { caseInsensitive: true });
  l = R.push(l, 'C:\\s\\b.mvp', 2, { caseInsensitive: true });
  l = R.push(l, 'c:\\S\\A.MVP', 3, { caseInsensitive: true });
  assert.deepEqual(l.map((e) => e.path), ['c:\\S\\A.MVP', 'C:\\s\\b.mvp']);
  assert.equal(l[0].openedAt, 3);
});
test('case matters when told so (mac/linux)', () => {
  const l = R.push(R.push([], '/s/a.mvp', 1, { caseInsensitive: false }), '/s/A.mvp', 2, { caseInsensitive: false });
  assert.equal(l.length, 2);
});
test('save as adds, does not remove', () => {
  let l = R.push([], 'C:\\s\\old.mvp', 1, { caseInsensitive: true });
  l = R.push(l, 'C:\\s\\new.mvp', 2, { caseInsensitive: true });
  assert.deepEqual(l.map((e) => e.path), ['C:\\s\\new.mvp', 'C:\\s\\old.mvp']);
});
test('remove', () => {
  const l = R.remove([{ path: 'a', openedAt: 1 }, { path: 'b', openedAt: 2 }], 'a');
  assert.deepEqual(l, [{ path: 'b', openedAt: 2 }]);
});
test('junk in, no throw: a non-list or entries without a path are dropped', () => {
  assert.deepEqual(R.push(null, 'a', 1).map((e) => e.path), ['a']);
  assert.deepEqual(R.push([null, 'x', { nope: 1 }, { path: 'b', openedAt: 1 }], 'a', 2).map((e) => e.path), ['a', 'b']);
  assert.deepEqual(R.remove(null, 'a'), []);
  assert.deepEqual(R.remove([null, { path: 'a' }], 'a'), []);
});
