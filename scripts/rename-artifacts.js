// Release workflow helper. electron-builder names artifacts from package.json's version, which is
// a semver derived from the tag (v0.2.0.5 -> 0.2.5), but the release should carry the tag's own
// 4-part number. This renames dist/*.exe, *.dmg, *.zip and their *.blockmap files, then rewrites
// latest.yml so electron-updater looks for the files that actually exist.
//
// latest.yml's `version:` stays the semver: that is what the installed app reports to the updater,
// and putting the 4-part number there would make every comparison wrong.
// Usage: node scripts/rename-artifacts.js v0.2.0.5 [distDir]
const fs = require('fs');
const path = require('path');

function renameArtifacts(dist, tag, version) {
  const tagVersion = String(tag).replace(/^v/i, '');
  const renamed = new Map(); // old name -> new name
  if (!tagVersion || tagVersion === version) return { renamed, yml: null };
  for (const name of fs.readdirSync(dist)) {
    if (!/\.(exe|dmg|zip|blockmap)$/i.test(name) || !name.includes(version)) continue;
    const next = name.split(version).join(tagVersion);
    if (next === name) continue;
    fs.renameSync(path.join(dist, name), path.join(dist, next));
    renamed.set(name, next);
  }
  // latest.yml points at the installer by name (and repeats it per file entry)
  const ymlPath = path.join(dist, 'latest.yml'); // latest-mac.yml is not uploaded: no Mac updater
  let yml = null;
  if (fs.existsSync(ymlPath)) {
    yml = fs.readFileSync(ymlPath, 'utf8');
    for (const [from, to] of renamed) yml = yml.split(from).join(to);
    fs.writeFileSync(ymlPath, yml, 'utf8');
  }
  return { renamed, yml };
}

module.exports = { renameArtifacts };

if (require.main === module) {
  const tag = String(process.argv[2] || '');
  const dist = process.argv[3] || path.join(__dirname, '..', 'dist');
  const version = require('../package.json').version;
  if (!tag) { console.error('usage: rename-artifacts.js <tag> [distDir]'); process.exit(1); }
  const { renamed } = renameArtifacts(dist, tag, version);
  for (const [from, to] of renamed) console.log(`${from} -> ${to}`);
  if (!renamed.size) console.log(`nothing to rename (version ${version}, tag ${tag})`);
}
