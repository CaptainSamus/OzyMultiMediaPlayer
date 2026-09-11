const test = require('node:test');
const assert = require('node:assert/strict');
const Sources = require('./sources');
test('filterMedia keeps video/audio, sorts case-insensitively', () => {
  assert.deepEqual(Sources.filterMedia(['b.MP4', 'a.txt', 'A.mov', 'c.flac', 'Thumbs.db']), ['A.mov', 'b.MP4', 'c.flac']);
});
test('kindOf classifies by extension', () => {
  assert.equal(Sources.kindOf('a.MP4'), 'video');
  assert.equal(Sources.kindOf('a.flac'), 'audio');
  assert.equal(Sources.kindOf('a.PNG'), 'image');
  assert.equal(Sources.kindOf('a.txt'), null);
});
test('filterMedia excludes images unless asked', () => {
  const names = ['b.mp4', 'a.png', 'c.gif', 'd.txt'];
  assert.deepEqual(Sources.filterMedia(names), ['b.mp4']);
  assert.deepEqual(Sources.filterMedia(names, { images: true }), ['a.png', 'b.mp4', 'c.gif']);
});
test('parentDir handles both slashes', () => {
  assert.equal(Sources.parentDir('C:\\r\\x.mp4'), 'C:\\r');
  assert.equal(Sources.parentDir('C:/r/x.mp4'), 'C:/r');
});
