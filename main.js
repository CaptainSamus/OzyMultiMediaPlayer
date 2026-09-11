// Ozy Multi Media Player - main process.
// Local files never leave the machine. The UI is served from a loopback-only
// http server (YouTube and Twitch embeds need a real http origin), and every
// other network request is cancelled unless it goes to a YouTube/Twitch host.

const { app, BrowserWindow, ipcMain, dialog, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Custom scheme that streams local files with HTTP range support (needed for
// scrubbing) while keeping Chromium's normal web security enabled.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localvideo',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.ogg': 'video/ogg', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', // cached thumbnails and image tiles
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

// Where ffmpeg.exe / ffprobe.exe / yt-dlp.exe live: bundled next to the app when packaged,
// straight out of node_modules (ffmpeg, ffprobe) or bin/ (yt-dlp) in development.
// yt-dlp prefers a self-updated copy in userData/bin (the install folder may not be writable).
const bundledYtdlp = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'yt-dlp.exe') : path.join(__dirname, 'bin', 'yt-dlp.exe'));
const userYtdlp = () => path.join(app.getPath('userData'), 'bin', 'yt-dlp.exe');
function binPath(name) {
  if (name === 'yt-dlp') return fs.existsSync(userYtdlp()) ? userYtdlp() : bundledYtdlp();
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', name + '.exe');
  if (name === 'ffmpeg') return require('ffmpeg-static');
  return require('ffprobe-static').path;
}

function urlToFilePath(url) {
  // localvideo://v/<base64url of absolute path>
  const u = new URL(url);
  const seg = u.pathname.replace(/^\/+/, '');
  return Buffer.from(seg, 'base64url').toString('utf8');
}

function handleVideoRequest(request) {
  let filePath;
  try { filePath = urlToFilePath(request.url); } catch { return new Response('Bad URL', { status: 400 }); }

  let stat;
  try { stat = fs.statSync(filePath); } catch { return new Response('Not found', { status: 404 }); }
  if (!stat.isFile()) return new Response('Not a file', { status: 404 });

  const size = stat.size;
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const baseHeaders = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };

  if (size === 0) return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': '0' } });

  let start = 0, end = size - 1, status = 200;
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] !== '') {
        start = parseInt(m[1], 10);
        if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
      } else if (m[2] !== '') {
        start = Math.max(0, size - parseInt(m[2], 10));
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      status = 206;
    }
  }

  const headers = { ...baseHeaders, 'Content-Length': String(end - start + 1) };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const stream = fs.createReadStream(filePath, { start, end });
  return new Response(Readable.toWeb(stream), { status, headers });
}

let win = null;

// ---- UI origin: loopback static server ----
// Embeds refuse file:// and custom-scheme pages (Twitch frame-ancestors, YouTube
// error 153), so the UI loads from http://127.0.0.1:<random port>. It only
// serves files under the app folder and is never reachable from the network.
const http = require('http');
const APP_ROOT = __dirname;
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let uiServer = null;
let uiPort = 0;
function startUiServer() {
  return new Promise((resolve) => {
    uiServer = http.createServer((req, res) => {
      let urlPath;
      try { urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { res.writeHead(400); return res.end(); }
      const file = path.normalize(path.join(APP_ROOT, urlPath === '/' ? 'index.html' : urlPath));
      if (!file.startsWith(APP_ROOT + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`) || file.includes(`${path.sep}.git${path.sep}`)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': STATIC_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    uiServer.listen(0, '127.0.0.1', () => { uiPort = uiServer.address().port; resolve(uiPort); });
  });
}
const TWITCH_PARENT = '127.0.0.1';
ipcMain.handle('twitch-parent', () => TWITCH_PARENT);
app.on('will-quit', () => { if (uiServer) uiServer.close(); });

// Only YouTube / Twitch hosts (and our own loopback page) may be reached.
const ALLOWED = ['youtube.com', 'youtube-nocookie.com', 'ytimg.com', 'googlevideo.com', 'google.com', 'gstatic.com', 'googleapis.com', 'ggpht.com',
  'twitch.tv', 'jtvnw.net', 'ttvnw.net', 'twitchcdn.net', 'live-video.net',
  'd1ndex63qxojbr.cloudfront.net']; // Twitch clip video files (exact host, not all of cloudfront.net)
const allowedHost = (h) => ALLOWED.some((d) => h === d || h.endsWith('.' + d));

function sessionFileFromArgv(argv) {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith('.mvp') && fs.existsSync(a)) || null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 700,
    minHeight: 450,
    backgroundColor: '#0f0f10',
    autoHideMenuBar: true,
    title: 'Ozy Multi Media Player',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
    },
  });

  win.loadURL(`http://127.0.0.1:${uiPort}/index.html`);

  win.webContents.on('did-finish-load', () => {
    const initial = sessionFileFromArgv(process.argv);
    if (initial) win.webContents.send('open-session', initial);
  });

  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = sessionFileFromArgv(argv);
    if (f) win.webContents.send('open-session', f);
  });
  app.whenReady().then(async () => {
    protocol.handle('localvideo', handleVideoRequest);
    await startUiServer();

    // Network allowlist: our loopback page, plus YouTube / Twitch hosts. Everything else is cancelled.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
      (details, callback) => {
        let u = null;
        try { u = new URL(details.url); } catch {}
        const own = !!u && u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === uiPort;
        callback({ cancel: !(own || (u && allowedHost(u.hostname))) });
      },
    );

    createWindow();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- IPC ----

const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'ogg', 'avi', 'mp3', 'wav', 'm4a', 'flac'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

ipcMain.handle('pick-videos', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add videos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video / audio / images', extensions: [...VIDEO_EXTS, ...IMAGE_EXTS] },
      { name: 'Images', extensions: IMAGE_EXTS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('save-session-as', async (_e, data) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save session',
    defaultPath: 'session.mvp',
    filters: [{ name: 'Ozy Multi Media Player session', extensions: ['mvp'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
  return r.filePath;
});

ipcMain.handle('save-session-to', async (_e, filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
});

ipcMain.handle('load-session', async (_e, filePath) => {
  if (!filePath) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open session',
      properties: ['openFile'],
      filters: [{ name: 'Ozy Multi Media Player session', extensions: ['mvp'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    filePath = r.filePaths[0];
  }
  // Strip a UTF-8 BOM in case the file was edited in Notepad or written by PowerShell.
  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(text);
  return { filePath, data };
});

ipcMain.handle('file-exists', (_e, p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

// ---- ffprobe / ffmpeg proxies ----

const { execFile, spawn } = require('child_process');
const Codecs = require('./lib/codecs');
const ProxyCache = require('./lib/proxy');

const proxyDir = () => path.join(app.getPath('userData'), 'proxies');
function proxyPathFor(filePath, stat) {
  return path.join(proxyDir(), ProxyCache.name(filePath, stat.size, stat.mtimeMs));
}
let toolsAvailable = null;
function checkTools() {
  if (toolsAvailable === null) {
    try { toolsAvailable = fs.existsSync(binPath('ffmpeg')) && fs.existsSync(binPath('ffprobe')); }
    catch { toolsAvailable = false; }
  }
  return toolsAvailable;
}

ipcMain.handle('probe', async (_e, filePath) => {
  const base = { codec: null, width: null, height: null, fps: null, duration: null, mime: null, proxy: null, available: checkTools() };
  let stat;
  try { stat = fs.statSync(filePath); } catch { return base; }
  const proxy = proxyPathFor(filePath, stat);
  if (fs.existsSync(proxy)) base.proxy = proxy;
  if (!base.available) return base;
  const json = await new Promise((resolve) => {
    execFile(binPath('ffprobe'), [
      '-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate:format=duration',
      '-of', 'json', filePath,
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
  if (!json) return base;
  return { ...base, ...Codecs.parseProbe(json, path.extname(filePath).toLowerCase()) };
});

// One ffmpeg at a time; others wait their turn.
const proxyJobs = new Map(); // filePath -> { child, reject }
let proxyQueue = Promise.resolve();

ipcMain.handle('make-proxy', (e, filePath) => {
  const send = (...args) => { if (!e.sender.isDestroyed()) e.sender.send('proxy-progress', ...args); };
  const run = () => new Promise((resolve, reject) => {
    if (!checkTools()) return reject(new Error('ffmpeg not found'));
    let stat;
    try { stat = fs.statSync(filePath); } catch { return reject(new Error('File not found')); }
    fs.mkdirSync(proxyDir(), { recursive: true });
    const out = proxyPathFor(filePath, stat);
    if (fs.existsSync(out)) return resolve({ proxy: out });
    const tmp = out + '.part.mp4';
    const child = spawn(binPath('ffmpeg'), ProxyCache.args(filePath, tmp), { windowsHide: true });
    proxyJobs.set(filePath, { child, reject });
    let duration = 0, tail = '';
    child.stderr.on('data', (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-2000);
      if (!duration) { const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s); if (m) duration = +m[1] * 3600 + +m[2] * 60 + +m[3]; }
      const t = ProxyCache.parseTime(s);
      if (t !== null && duration) send(filePath, Math.min(0.99, t / duration));
    });
    child.on('close', (code) => {
      proxyJobs.delete(filePath);
      if (code === 0) {
        try { fs.renameSync(tmp, out); } catch (err) { return reject(new Error('Could not save playable copy: ' + err.message)); }
        send(filePath, 1);
        resolve({ proxy: out });
      } else {
        try { fs.unlinkSync(tmp); } catch {}
        reject(new Error(code === null ? 'Cancelled' : 'ffmpeg failed:\n' + tail.split('\n').slice(-4).join('\n')));
      }
    });
  });
  const p = proxyQueue.then(run, run);
  proxyQueue = p.catch(() => {});
  return p;
});

ipcMain.on('cancel-proxy', (_e, filePath) => {
  const job = proxyJobs.get(filePath);
  if (job) job.child.kill();
});

// Cache = playable copies + thumbnails.
ipcMain.handle('cache-info', () => {
  let bytes = 0, files = 0;
  for (const dir of [proxyDir(), thumbDir()]) {
    try { for (const f of fs.readdirSync(dir)) { bytes += fs.statSync(path.join(dir, f)).size; files++; } } catch {}
  }
  return { bytes, files };
});
ipcMain.handle('clear-cache', () => {
  for (const job of proxyJobs.values()) job.child.kill();
  for (const dir of [proxyDir(), thumbDir()]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// ---- YouTube thumbnails for web tiles ----
// Fetched once from i.ytimg.com (through the same allowlisted session) and kept in
// userData/thumbs, so a tile that can't load still looks like its video.
const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
ipcMain.handle('web-thumb', async (_e, id) => {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id))) return null;
  const file = path.join(thumbDir(), `yt-${id}.jpg`);
  if (fs.existsSync(file)) return file;
  try {
    const { net } = require('electron');
    const res = await net.fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    if (!res.ok) return null;
    fs.mkdirSync(thumbDir(), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch { return null; }
});

// ---- global settings (Sources sidebar) ----
const Settings = require('./lib/settings');
const Sources = require('./lib/sources');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return Settings.merge(JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^﻿/, ''))); }
  catch { return Settings.defaults(); }
}
ipcMain.handle('get-settings', () => readSettings());
ipcMain.handle('save-settings', (_e, s) => { fs.writeFileSync(settingsPath(), JSON.stringify(Settings.merge(s), null, 2), 'utf8'); });

// Right-click on a local row / tile name: open Explorer with the file selected.
// Right-click on a web row / tile name: copy its URL.
ipcMain.handle('show-in-explorer', (_e, p) => {
  try { if (fs.existsSync(p)) { require('electron').shell.showItemInFolder(path.normalize(p)); return true; } } catch {}
  return false;
});
ipcMain.handle('copy-text', (_e, t) => { require('electron').clipboard.writeText(String(t)); });

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Non-recursive: media files directly in the folder, sorted by name.
ipcMain.handle('list-folder', (_e, dir) => {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); }
  catch { return { ok: false, files: [] }; }
  const files = [];
  for (const n of Sources.filterMedia(names, { images: true })) {
    const p = path.join(dir, n);
    try { const st = fs.statSync(p); files.push({ path: p, name: n, size: st.size, mtimeMs: st.mtimeMs, kind: Sources.kindOf(n) }); } catch {}
  }
  return { ok: true, files };
});

// Local-file thumbnails: one JPEG per file (same hash as proxies) from 10 % in,
// made lazily as sidebar rows scroll into view, at most two ffmpeg jobs at once.
let thumbRunning = 0; const thumbWaiting = [];
function nextThumb() { if (thumbRunning < 2 && thumbWaiting.length) thumbWaiting.shift()(); }
ipcMain.handle('thumb', (_e, filePath) => new Promise((resolve) => {
  const job = () => {
    thumbRunning++;
    const done = (v) => { thumbRunning--; resolve(v); nextThumb(); };
    let stat; try { stat = fs.statSync(filePath); } catch { return done(null); }
    fs.mkdirSync(thumbDir(), { recursive: true });
    const out = path.join(thumbDir(), ProxyCache.name(filePath, stat.size, stat.mtimeMs).replace(/\.mp4$/, '.jpg'));
    if (fs.existsSync(out)) return done(out);
    if (!checkTools()) return done(null);
    if (Sources.kindOf(filePath) === 'image') { // images: no seek, just scale the first frame
      return execFile(binPath('ffmpeg'), ['-y', '-i', filePath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out], { windowsHide: true }, (e2) => done(e2 ? null : out));
    }
    execFile(binPath('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { windowsHide: true }, (err, stdout) => {
      const dur = err ? 0 : Number(stdout) || 0;
      const ss = (dur * 0.1).toFixed(2);
      execFile(binPath('ffmpeg'), ['-y', '-ss', ss, '-i', filePath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out], { windowsHide: true }, (e2) => done(e2 ? null : out));
    });
  };
  thumbWaiting.push(job); nextThumb();
}));

// ---- YouTube playlists via the bundled yt-dlp ----
// yt-dlp runs as its own process (it talks to YouTube directly, outside the renderer's allowlist).
const Playlist = require('./lib/playlist');
ipcMain.handle('ytdlp-available', () => fs.existsSync(binPath('yt-dlp')));
ipcMain.handle('list-playlist', (_e, url) => new Promise((resolve) => {
  if (!fs.existsSync(binPath('yt-dlp'))) return resolve({ ok: false, error: 'yt-dlp not found' });
  execFile(binPath('yt-dlp'), ['--flat-playlist', '-J', '--no-warnings', String(url)], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) return resolve({ ok: false, error: String(stderr || err.message).trim().split('\n').slice(-2).join('\n'), outdated: Playlist.isOutdatedError(stderr) });
    const pl = Playlist.parseFlat(stdout);
    resolve(pl ? { ok: true, playlist: pl } : { ok: false, error: 'Could not read playlist' });
  });
}));
// Self-update (network, only when the user clicks it). Runs on a copy in userData/bin, which
// binPath then prefers, because the install folder usually isn't writable.
ipcMain.handle('update-ytdlp', () => new Promise((resolve) => {
  try {
    if (!fs.existsSync(userYtdlp())) { fs.mkdirSync(path.dirname(userYtdlp()), { recursive: true }); fs.copyFileSync(bundledYtdlp(), userYtdlp()); }
  } catch (e) { return resolve({ ok: false, output: 'Could not copy yt-dlp: ' + e.message }); }
  execFile(userYtdlp(), ['-U'], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve({ ok: !err, output: (String(stdout) + String(stderr)).trim().split('\n').slice(-3).join('\n') }));
}));
