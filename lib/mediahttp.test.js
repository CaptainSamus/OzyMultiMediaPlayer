const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./mediahttp');

test('no Range (or one we do not understand) is the whole file', () => {
  assert.deepEqual(M.range(undefined, 1000), { status: 200, start: 0, end: 999 });
  assert.deepEqual(M.range('bytes=-', 1000), { status: 200, start: 0, end: 999 });
  assert.deepEqual(M.range('items=1-2', 1000), { status: 200, start: 0, end: 999 });
});

test('ranges: from, from-to (clipped to the file), and the last N bytes', () => {
  assert.deepEqual(M.range('bytes=100-', 1000), { status: 206, start: 100, end: 999 });
  assert.deepEqual(M.range('bytes=100-199', 1000), { status: 206, start: 100, end: 199 });
  assert.deepEqual(M.range('bytes=900-5000', 1000), { status: 206, start: 900, end: 999 });
  assert.deepEqual(M.range('bytes=-100', 1000), { status: 206, start: 900, end: 999 });
});

test('a range past the end cannot be served', () => {
  assert.deepEqual(M.range('bytes=1000-', 1000), { status: 416 });
  assert.deepEqual(M.range('bytes=500-400', 1000), { status: 416 });
});

test('media URLs need the right token and carry the path as base64url', () => {
  const p = 'G:\\Footage\\day 1\\clip.mp4';
  const b = Buffer.from(p, 'utf8').toString('base64url');
  assert.equal(M.pathFromUrl(`/m/abc/${b}`, 'abc'), p);
  assert.equal(M.pathFromUrl(`/m/wrong/${b}`, 'abc'), null);
  assert.equal(M.pathFromUrl(`/m/abc/${b}`, ''), null);
  assert.equal(M.pathFromUrl('/index.html', 'abc'), null);
  assert.equal(M.pathFromUrl(`/m/abc/${b}/../x`, 'abc'), null);
});

test('content types, and which files are cached copies', () => {
  assert.equal(M.typeOf('.MP4'), 'video/mp4');
  assert.equal(M.typeOf('.xyz'), 'application/octet-stream');
  assert.ok(M.PROXY_FILE.test('C:\\cache\\proxies\\' + 'a'.repeat(40) + '-half.mp4'));
  assert.ok(!M.PROXY_FILE.test('G:\\Footage\\clip.mp4'));
});
