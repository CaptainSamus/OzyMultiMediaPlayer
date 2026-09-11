// Fetches the platform binaries that packaging needs into bin/. Dev/CI-time only; the app never downloads them.
//   Windows: bin/yt-dlp.exe
//   macOS:   bin/yt-dlp (universal) and bin/darwin-<arch>/ffmpeg for arm64 and x64.
//            ffmpeg-static only installs the build machine's own arch, so both are fetched here from
//            the same release ffmpeg-static uses; electron-builder then picks one per arch.
// OZY_FETCH_PLATFORM=darwin|win32 overrides the platform (to test the other path).
const fs = require('fs'); const path = require('path'); const https = require('https'); const zlib = require('zlib');
const platform = process.env.OZY_FETCH_PLATFORM || process.platform;
const bin = path.join(__dirname, '..', 'bin');

function download(url, out, { gunzip = false } = {}) {
  if (fs.existsSync(out)) { console.log('already present', path.relative(process.cwd(), out)); return Promise.resolve(); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return new Promise((resolve, reject) => {
    const get = (u) => https.get(u, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) { res.resume(); return get(res.headers.location); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const tmp = out + '.part';
      const sink = fs.createWriteStream(tmp);
      (gunzip ? res.pipe(zlib.createGunzip()) : res).pipe(sink);
      sink.on('finish', () => { fs.renameSync(tmp, out); if (platform !== 'win32') fs.chmodSync(out, 0o755); console.log('saved', path.relative(process.cwd(), out)); resolve(); });
      sink.on('error', reject);
    }).on('error', reject);
    get(url);
  });
}

(async () => {
  if (platform === 'darwin') {
    await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', path.join(bin, 'yt-dlp'));
    const pkg = require('ffmpeg-static/package.json')['ffmpeg-static'];
    const tag = process.env[pkg['binary-release-tag-env-var']] || pkg['binary-release-tag'];
    for (const arch of ['arm64', 'x64']) {
      await download(`https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/ffmpeg-darwin-${arch}.gz`, path.join(bin, `darwin-${arch}`, 'ffmpeg'), { gunzip: true });
    }
  } else {
    await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', path.join(bin, 'yt-dlp.exe'));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
