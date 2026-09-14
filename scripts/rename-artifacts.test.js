const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renameArtifacts } = require('./rename-artifacts');

// a throwaway dist folder holding what electron-builder would have produced for version 0.2.5
function fakeDist(version = '0.2.5') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozy-dist-'));
  const installer = `OzyMultiMediaPlayer-${version}-setup.exe`;
  const files = [
    installer,
    `${installer}.blockmap`,
    `OzyMultiMediaPlayer-${version}-portable.exe`,
    `OzyMultiMediaPlayer-${version}-mac-arm64.dmg`,
    `OzyMultiMediaPlayer-${version}-mac-arm64.zip`,
    `OzyMultiMediaPlayer-${version}-mac-arm64.zip.blockmap`,
    'builder-debug.yml', // not an artifact: must be left alone
  ];
  for (const f of files) fs.writeFileSync(path.join(dir, f), f);
  fs.writeFileSync(path.join(dir, 'latest.yml'), [
    `version: ${version}`,
    'files:',
    `  - url: ${installer}`,
    '    sha512: abc==',
    '    size: 123',
    `    blockMapSize: 45`,
    `path: ${installer}`,
    'sha512: abc==',
    'releaseDate: 2026-09-14T00:00:00.000Z',
    '',
  ].join('\n'), 'utf8');
  return { dir, installer, version };
}

test('renames every artifact and its blockmap to the tag version', () => {
  const { dir, version } = fakeDist();
  const { renamed } = renameArtifacts(dir, 'v0.2.0.5', version);
  const after = fs.readdirSync(dir).sort();
  assert.ok(after.includes('OzyMultiMediaPlayer-0.2.0.5-setup.exe'));
  assert.ok(after.includes('OzyMultiMediaPlayer-0.2.0.5-setup.exe.blockmap'));
  assert.ok(after.includes('OzyMultiMediaPlayer-0.2.0.5-portable.exe'));
  assert.ok(after.includes('OzyMultiMediaPlayer-0.2.0.5-mac-arm64.dmg'));
  assert.ok(after.includes('OzyMultiMediaPlayer-0.2.0.5-mac-arm64.zip.blockmap'));
  assert.ok(after.includes('builder-debug.yml'), 'non-artifacts are untouched');
  assert.ok(!after.some((f) => /0\.2\.5/.test(f) && f !== 'latest.yml'), 'no old names left');
  assert.equal(renamed.size, 6);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('latest.yml points at the renamed installer but keeps the semver version', () => {
  const { dir, version } = fakeDist();
  renameArtifacts(dir, 'v0.2.0.5', version);
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  assert.match(yml, /version: 0\.2\.5/);                                  // what the updater compares
  assert.match(yml, /url: OzyMultiMediaPlayer-0\.2\.0\.5-setup\.exe/);    // what it downloads
  assert.match(yml, /path: OzyMultiMediaPlayer-0\.2\.0\.5-setup\.exe/);
  assert.ok(!/url: OzyMultiMediaPlayer-0\.2\.5-setup/.test(yml), 'no stale url');
  // every file named in the yml exists on disk
  for (const m of yml.matchAll(/(?:url|path): (\S+)/g)) assert.ok(fs.existsSync(path.join(dir, m[1])), `${m[1]} exists`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tag that matches the version, or a missing latest.yml, is handled quietly', () => {
  const { dir, version } = fakeDist();
  const same = renameArtifacts(dir, 'v0.2.5', version);
  assert.equal(same.renamed.size, 0, 'nothing to do when the names already match');
  fs.rmSync(path.join(dir, 'latest.yml'));
  const r = renameArtifacts(dir, 'v0.2.0.6', version);
  assert.ok(r.renamed.size > 0);
  assert.equal(r.yml, null); // no latest.yml to rewrite (a Mac-only build)
  fs.rmSync(dir, { recursive: true, force: true });
});
