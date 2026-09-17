const testRunner = require('node:test');
const assertUpdates = require('node:assert/strict');
const SettingsForUpdates = require('./settings');
testRunner('wheelZoom is off unless it was explicitly turned on', () => {
  assertUpdates.equal(SettingsForUpdates.defaults().wheelZoom, false);
  assertUpdates.equal(SettingsForUpdates.merge({}).wheelZoom, false);
  assertUpdates.equal(SettingsForUpdates.merge({ wheelZoom: true }).wheelZoom, true);
  assertUpdates.equal(SettingsForUpdates.merge({ wheelZoom: 'yes' }).wheelZoom, false); // only a real true counts
});
testRunner('updates settings default on, and survive a round trip', () => {
  assertUpdates.deepEqual(SettingsForUpdates.defaults().updates, { auto: true, includePrerelease: true });
  assertUpdates.deepEqual(SettingsForUpdates.merge({}).updates, { auto: true, includePrerelease: true });
  assertUpdates.deepEqual(SettingsForUpdates.merge({ updates: { auto: false, includePrerelease: false } }).updates, { auto: false, includePrerelease: false });
  // anything else stays on, so a partial file doesn't silently disable checks
  assertUpdates.deepEqual(SettingsForUpdates.merge({ updates: { auto: 'yes' } }).updates, { auto: true, includePrerelease: true });
});

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
