// Release workflow helper: electron-builder names artifacts with package.json's 3-part version
// (npm requires semver), but the release tag can have more parts (v0.2.0.1). This renames
// dist/*.exe, *.dmg and *.zip so their version segment matches the tag.
// Usage: node scripts/rename-artifacts.js v0.2.0.1
const fs = require('fs'); const path = require('path');
const tag = String(process.argv[2] || '').replace(/^v/, '');
const version = require('../package.json').version;
if (!tag) { console.error('usage: rename-artifacts.js <tag>'); process.exit(1); }
const dist = path.join(__dirname, '..', 'dist');
for (const name of fs.readdirSync(dist)) {
  if (!/\.(exe|dmg|zip)$/i.test(name) || !name.includes(version) || tag === version) continue;
  const renamed = name.split(version).join(tag);
  fs.renameSync(path.join(dist, name), path.join(dist, renamed));
  console.log(`${name} -> ${renamed}`);
}
