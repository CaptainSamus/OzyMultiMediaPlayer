const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./playlist');
test('parseFlat maps yt-dlp flat playlist json', () => {
  const j = JSON.stringify({ id: 'PL1', title: 'Mood', entries: [
    { id: 'aaaaaaaaaaa', title: 'One', duration: 61, thumbnails: [{ url: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg' }] },
    { id: 'bbbbbbbbbbb', title: 'Two', duration: null, thumbnails: [] },
    null,
  ] });
  assert.deepEqual(P.parseFlat(j), { id: 'PL1', title: 'Mood', items: [
    { id: 'aaaaaaaaaaa', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'One', duration: 61, thumbUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg' },
    { id: 'bbbbbbbbbbb', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'Two', duration: null, thumbUrl: 'https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg' },
  ] });
});
test('parseFlat rejects junk', () => { assert.equal(P.parseFlat('nope'), null); assert.equal(P.parseFlat('{}'), null); });
test('isOutdatedError spots extractor failures', () => {
  assert.equal(P.isOutdatedError('ERROR: [youtube] Unable to extract yt initial data'), true);
  assert.equal(P.isOutdatedError('ERROR: [youtube] PL1: This playlist does not exist'), false);
  assert.equal(P.isOutdatedError('ERROR: Unsupported URL: https://x'), true);
});
