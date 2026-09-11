const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('./weburl');

test('youtube forms', () => {
  assert.deepEqual(W.parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5'), { type: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(W.parse('https://youtu.be/dQw4w9WgXcQ'), { type: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(W.parse('https://www.youtube.com/embed/dQw4w9WgXcQ'), { type: 'youtube', kind: 'video', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(W.parse('https://www.youtube.com/shorts/dQw4w9WgXcQ'), { type: 'youtube', kind: 'short', id: 'dQw4w9WgXcQ' });
  assert.deepEqual(W.parse('https://www.youtube.com/playlist?list=PLabc123'), { type: 'youtube', kind: 'playlist', id: 'PLabc123' });
  assert.deepEqual(W.parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123'), { type: 'youtube', kind: 'playlist', id: 'PLabc123' });
});
test('twitch forms', () => {
  assert.deepEqual(W.parse('https://clips.twitch.tv/AwkwardSlug'), { type: 'twitch', kind: 'clip', id: 'AwkwardSlug' });
  assert.deepEqual(W.parse('https://www.twitch.tv/somechan/clip/AwkwardSlug?filter=x'), { type: 'twitch', kind: 'clip', id: 'AwkwardSlug' });
  assert.deepEqual(W.parse('https://twitch.tv/somechan'), { type: 'twitch', kind: 'stream', id: 'somechan' });
});
test('rejects junk', () => {
  assert.equal(W.parse('https://vimeo.com/123'), null);
  assert.equal(W.parse('not a url'), null);
  assert.equal(W.parse('https://www.twitch.tv/directory'), null);
});
test('embed urls', () => {
  assert.equal(W.embed({ type: 'youtube', kind: 'video', id: 'x' }, 'p'), 'https://www.youtube.com/embed/x?enablejsapi=1&rel=0');
  assert.equal(W.embed({ type: 'twitch', kind: 'clip', id: 's' }, 'p'), 'https://clips.twitch.tv/embed?clip=s&parent=p&autoplay=false');
  assert.equal(W.embed({ type: 'twitch', kind: 'stream', id: 'c' }, 'p'), 'https://player.twitch.tv/?channel=c&parent=p&autoplay=false');
});
