const test = require('node:test');
const assert = require('node:assert/strict');
const ProxyCache = require('./proxy');

test('name is a stable sha1 of path+size+mtime with .mp4', () => {
  const a = ProxyCache.name('C:\\a\\b.mov', 100, 5);
  assert.match(a, /^[0-9a-f]{40}\.mp4$/);
  assert.equal(a, ProxyCache.name('C:\\a\\b.mov', 100, 5));
  assert.notEqual(a, ProxyCache.name('C:\\a\\b.mov', 101, 5));
});

test('args produce the spec ffmpeg command', () => {
  assert.deepEqual(ProxyCache.args('in.mov', 'out.mp4'), [
    '-y', '-i', 'in.mov', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', 'out.mp4',
  ]);
});

test('parseTime reads the last time= from ffmpeg stderr', () => {
  assert.equal(ProxyCache.parseTime('frame=  10 fps=0 time=00:00:01.50 bitrate=x'), 1.5);
  assert.equal(ProxyCache.parseTime('time=01:02:03.04'), 3723.04);
  assert.equal(ProxyCache.parseTime('nothing here'), null);
});
