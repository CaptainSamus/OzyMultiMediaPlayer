const test = require('node:test');
const assert = require('node:assert/strict');
const FsGuard = require('./fsguard');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const slow = (ms, value) => () => wait(ms).then(() => value);

test('roots: a share, a drive letter, or nothing', () => {
  assert.equal(FsGuard.pathRoot('\\\\NAS\\Media\\a\\b.mp4'), '\\\\nas\\media');
  assert.equal(FsGuard.pathRoot('D:\\Videos\\a.mp4'), 'd:');
  assert.equal(FsGuard.pathRoot('/Users/m/a.mp4'), null);
});

test('mapped network drives are read from the drive-type listing', () => {
  const out = FsGuard.networkDrivesFrom('C: 3\r\nD: 3\r\nE: 2\r\nZ: 4\r\n\r\nY: 4');
  assert.deepEqual([...out].sort(), ['y:', 'z:']);
  assert.equal(FsGuard.networkDrivesFrom('').size, 0);
});

test('a plain answer and a plain error pass straight through', async () => {
  const g = FsGuard.create();
  assert.equal(await g.run('D:\\a.mp4', () => Promise.resolve(42), null), 42);
  assert.equal(await g.run('D:\\a.mp4', () => Promise.reject(new Error('ENOENT')), 'fb'), 'fb');
  assert.equal(await g.run('', () => 1, 'fb'), 'fb');
});

// The bug: a busy PC answering slowly on a LOCAL drive once made every file on it "not found".
test('a slow local disk is never written off: the next file on it is still tried', async () => {
  const g = FsGuard.create({ networkMs: 10, localMs: 30 });
  assert.equal(await g.run('D:\\a.mp4', slow(20, 'ok'), null), 'ok'); // slower than a share may be, fine locally
  assert.equal(await g.run('D:\\b.mp4', slow(60, 'ok'), null), null); // past even the local limit: this one fails...
  assert.equal(g.isDead('d:'), false);                                // ...but the drive is not condemned
  assert.equal(await g.run('D:\\c.mp4', () => Promise.resolve('ok'), null), 'ok');
});

test('a share that times out answers at once after that, and comes back when the slow call succeeds', async () => {
  const revived = [];
  const g = FsGuard.create({ networkMs: 10, localMs: 1000, onRevive: (r) => revived.push(r) });
  assert.equal(await g.run('\\\\nas\\media\\a.mp4', slow(40, 'late'), null), null);
  assert.equal(g.isDead('\\\\nas\\media'), true);
  let called = false;
  assert.equal(await g.run('\\\\nas\\media\\b.mp4', () => { called = true; return 'x'; }, null), null);
  assert.equal(called, false); // not even tried
  await wait(50); // the first call finally answers
  assert.equal(g.isDead('\\\\nas\\media'), false);
  assert.deepEqual(revived, ['\\\\nas\\media']);
  assert.equal(await g.run('\\\\nas\\media\\b.mp4', () => 'x', null), 'x');
});

test('a share whose slow call fails late stays written off', async () => {
  const g = FsGuard.create({ networkMs: 10 });
  await g.run('\\\\nas\\media\\a.mp4', () => wait(30).then(() => { throw new Error('EHOSTDOWN'); }), null);
  await wait(40);
  assert.equal(g.isDead('\\\\nas\\media'), true);
  g.forget(); // opening a session gives it a fresh chance
  assert.equal(g.isDead('\\\\nas\\media'), false);
});

test('a mapped network drive is treated like a share; a local slow answer is announced too', async () => {
  const revived = [];
  const g = FsGuard.create({ networkMs: 10, localMs: 10, networkDrives: new Set(['z:']), onRevive: (r) => revived.push(r) });
  await g.run('Z:\\a.mp4', slow(30, 1), null);
  assert.equal(g.isDead('z:'), true);
  await g.run('D:\\a.mp4', slow(30, 1), null);
  assert.equal(g.isDead('d:'), false);
  await wait(40);
  assert.deepEqual(revived.sort(), ['d:', 'z:']);
});
