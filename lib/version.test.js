const test = require('node:test');
const assert = require('node:assert/strict');
const Version = require('./version');

test('newer: 4-part versions, with or without a leading v', () => {
  assert.equal(Version.newer('0.2.0.4', '0.2.0.3'), true);
  assert.equal(Version.newer('v0.2.0.4', '0.2.0.3'), true);
  assert.equal(Version.newer('0.2.0.3', '0.2.0.3'), false);
  assert.equal(Version.newer('0.2.0.2', '0.2.0.3'), false);
});
test('newer: missing parts count as zero, and numbers compare as numbers', () => {
  assert.equal(Version.newer('0.3.0', '0.2.0.3'), true);
  assert.equal(Version.newer('0.2.1', '0.2.0.9'), true);
  assert.equal(Version.newer('1.0', '0.9.9.9'), true);
  assert.equal(Version.newer('0.2.0.10', '0.2.0.9'), true);  // not a string compare
  assert.equal(Version.newer('0.2.0.3', '0.2.0.3.1'), false);
  assert.equal(Version.newer('0.2.0', '0.2.0.0'), false);
});
test('compare gives an ordering, and junk sorts as 0.0.0', () => {
  assert.equal(Version.compare('0.2.0.4', '0.2.0.3'), 1);
  assert.equal(Version.compare('0.2.0.3', '0.2.0.4'), -1);
  assert.equal(Version.compare('0.2.0.3', 'v0.2.0.3'), 0);
  assert.equal(Version.compare('', ''), 0);
  assert.equal(Version.newer('nonsense', '0.0.0.1'), false);
  assert.equal(Version.newer(null, undefined), false);
  assert.deepEqual(['0.2.0.10', '0.2.0.2', '0.3'].sort(Version.compare), ['0.2.0.2', '0.2.0.10', '0.3']);
});
