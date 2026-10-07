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

test('tier names: full keeps the old name, the others carry the tier', () => {
  const full = ProxyCache.name('C:\v\a.mov', 10, 20);
  assert.equal(ProxyCache.name('C:\v\a.mov', 10, 20, 'full'), full);
  assert.equal(ProxyCache.name('C:\v\a.mov', 10, 20, 'half'), full.replace(/\.mp4$/, '-half.mp4'));
  assert.equal(ProxyCache.name('C:\v\a.mov', 10, 20, 'quarter'), full.replace(/\.mp4$/, '-quarter.mp4'));
});
test('tier args scale to even dimensions and use the lighter preset', () => {
  const a = ProxyCache.args('in.mov', 'out.mp4', 'half');
  const vf = a[a.indexOf('-vf') + 1];
  assert.equal(vf, 'scale=trunc(iw/2/2)*2:trunc(ih/2/2)*2');
  assert.equal(a[a.indexOf('-preset') + 1], 'faster');
  assert.equal(a[a.indexOf('-crf') + 1], '23');
  assert.ok(!ProxyCache.args('in.mov', 'out.mp4').includes('-vf'));              // full: no scaling, as before
  assert.equal(ProxyCache.args('in.mov', 'out.mp4', 'quarter')[ProxyCache.args('in.mov', 'out.mp4', 'quarter').indexOf('-vf') + 1], 'scale=trunc(iw/4/2)*2:trunc(ih/4/2)*2');
});
test('divisor', () => { assert.equal(ProxyCache.divisor('full'), 1); assert.equal(ProxyCache.divisor('half'), 2); assert.equal(ProxyCache.divisor('quarter'), 4); assert.equal(ProxyCache.divisor('nonsense'), 1); });
test('one job per file and tier', async () => {
  const pending = new Map();
  let started = 0;
  const finish = [];
  const start = () => { started++; return new Promise((r) => { finish.push(r); }); };
  const a = ProxyCache.once(pending, ProxyCache.jobKey('a.mov', 'half'), start);
  const b = ProxyCache.once(pending, ProxyCache.jobKey('a.mov', 'half'), start);
  assert.equal(a, b);                                   // asked twice while encoding: the same job
  assert.equal(started, 1);
  ProxyCache.once(pending, ProxyCache.jobKey('a.mov', 'quarter'), start);
  ProxyCache.once(pending, ProxyCache.jobKey('b.mov', 'half'), start);
  assert.equal(started, 3);                             // another tier or another file is its own job
  assert.notEqual(ProxyCache.jobKey('a.mov', 'half'), ProxyCache.jobKey('a.mov'));
  for (const f of finish) f('done');
  await Promise.all(pending.values());
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.size, 0);                        // settled jobs are forgotten, so a later ask starts again
  const failing = ProxyCache.once(pending, 'k', () => Promise.reject(new Error('x')));
  await assert.rejects(failing);
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.size, 0);
});
test('swap restores playback state', () => {
  assert.deepEqual(ProxyCache.restore({ time: 12.5, paused: false, rate: 2 }, 60), { time: 12.5, rate: 2, play: true });
  assert.deepEqual(ProxyCache.restore({ time: 12.5, paused: true, rate: 0.5 }, 60), { time: 12.5, rate: 0.5, play: false });
  assert.equal(ProxyCache.restore({ time: 99, paused: true, rate: 1 }, 60).time, 60);     // never past the new file's end
  assert.equal(ProxyCache.restore({ time: 5, paused: true, rate: 1 }, NaN).time, 5);      // duration unknown: keep the time
  assert.deepEqual(ProxyCache.restore({}, 60), { time: 0, rate: 1, play: false });        // nothing known: start, paused
});
