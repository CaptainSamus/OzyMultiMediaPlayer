// electron-builder afterPack hook. The Mac build is unsigned (no Apple Developer account), but
// Apple Silicon refuses to run arm64 code that has no signature at all, and repackaging breaks
// Electron's own. So on macOS the .app gets an ad-hoc signature ("-") before dmg/zip are made.
// Users still see the "unidentified developer" prompt the first time (right-click > Open).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('  • ad-hoc signed', app);
};
