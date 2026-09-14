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
test('semverFromTag folds the 4th part into the patch number', () => {
  assert.equal(Version.semverFromTag('v0.2.0.5'), '0.2.5');
  assert.equal(Version.semverFromTag('0.2.0.4'), '0.2.4');
  assert.equal(Version.semverFromTag('v0.2.0.10'), '0.2.10');
  assert.equal(Version.semverFromTag('v0.2.1.3'), '0.2.103');
  assert.equal(Version.semverFromTag('v0.2.2.0'), '0.2.200');
  assert.equal(Version.semverFromTag('v1.0.0.0'), '1.0.0');
});
test('semverFromTag keeps ordering, and passes shorter tags through', () => {
  const asSemver = ['v0.2.0.3', 'v0.2.0.4', 'v0.2.0.5', 'v0.2.1.0'].map(Version.semverFromTag);
  assert.deepEqual(asSemver, ['0.2.3', '0.2.4', '0.2.5', '0.2.100']);
  for (let i = 1; i < asSemver.length; i++) assert.ok(Version.newer(asSemver[i], asSemver[i - 1]), `${asSemver[i]} > ${asSemver[i - 1]}`);
  assert.equal(Version.semverFromTag('v0.3.0'), '0.3.0'); // already semver
  assert.equal(Version.semverFromTag('v2.1'), '2.1');
  assert.equal(Version.semverFromTag('v0.2.1.12'), '0.2.112');
});
test('semverFromTag refuses anything that is not a version', () => {
  assert.equal(Version.semverFromTag(''), null);
  assert.equal(Version.semverFromTag('nightly'), null);
  assert.equal(Version.semverFromTag('v1.2.3-beta'), null);
  assert.equal(Version.semverFromTag(null), null);
  assert.equal(Version.semverFromTag(undefined), null);
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
