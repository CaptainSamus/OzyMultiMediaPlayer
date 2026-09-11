// Downloads yt-dlp.exe into bin/ for packaging. Dev-time only; the app never downloads it.
const fs = require('fs'); const path = require('path'); const https = require('https');
const out = path.join(__dirname, '..', 'bin', 'yt-dlp.exe');
if (fs.existsSync(out)) { console.log('yt-dlp already present'); process.exit(0); }
fs.mkdirSync(path.dirname(out), { recursive: true });
const get = (url) => https.get(url, (res) => {
  if ([301, 302, 307, 308].includes(res.statusCode)) return get(res.headers.location);
  if (res.statusCode !== 200) { console.error('HTTP', res.statusCode); process.exit(1); }
  res.pipe(fs.createWriteStream(out)).on('finish', () => console.log('saved', out));
});
get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
