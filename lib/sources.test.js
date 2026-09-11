const test = require('node:test');
const assert = require('node:assert/strict');
const Sources = require('./sources');
test('filterMedia keeps video/audio, sorts case-insensitively', () => {
  assert.deepEqual(Sources.filterMedia(['b.MP4', 'a.txt', 'A.mov', 'c.flac', 'Thumbs.db']), ['A.mov', 'b.MP4', 'c.flac']);
});
test('parentDir handles both slashes', () => {
  assert.equal(Sources.parentDir('C:\\r\\x.mp4'), 'C:\\r');
  assert.equal(Sources.parentDir('C:/r/x.mp4'), 'C:/r');
});
