const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./settings');

test('merge fills defaults and keeps known keys', () => {
  const m = S.merge({ sidebar: { width: 300 }, sources: { folders: [{ path: 'C:\\x', pinned: true }] } });
  assert.equal(m.sidebar.open, false);
  assert.equal(m.sidebar.tab, 'local');
  assert.equal(m.sidebar.width, 300);
  assert.deepEqual(m.sources.folders, [{ path: 'C:\\x', pinned: true, recent: false }]);
  assert.deepEqual(m.sources.playlists, []);
});
test('upsertRecentFolder keeps one recent row and never duplicates a pinned one', () => {
  let s = S.defaults();
  s = S.upsertRecentFolder(s, 'C:\\a');
  s = S.upsertRecentFolder(s, 'C:\\b');
  assert.deepEqual(s.sources.folders, [{ path: 'C:\\b', pinned: false, recent: true }]);
  s = S.pinFolder(s, 'C:\\b', true);
  s = S.upsertRecentFolder(s, 'C:\\b');
  assert.deepEqual(s.sources.folders, [{ path: 'C:\\b', pinned: true, recent: false }]);
});
test('removeFolder', () => {
  let s = S.pinFolder(S.defaults(), 'C:\\a', true);
  assert.equal(S.removeFolder(s, 'C:\\a').sources.folders.length, 0);
});
