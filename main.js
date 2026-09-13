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
const EXE = process.platform === 'win32' ? '.exe' : ''; // bundled tools are bin/ffmpeg.exe on Windows, bin/ffmpeg on macOS
const bundledYtdlp = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'yt-dlp' + EXE) : path.join(__dirname, 'bin', 'yt-dlp' + EXE));
const userYtdlp = () => path.join(app.getPath('userData'), 'bin', 'yt-dlp' + EXE);
function binPath(name) {
  if (name === 'yt-dlp') return fs.existsSync(userYtdlp()) ? userYtdlp() : bundledYtdlp();
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', name + EXE);
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
// Shown in the window title. Release builds get the tag's 4-part version written into
// package.json's top-level buildVersion by the release workflow; running from source says -dev.
ipcMain.handle('app-version', () => {
  const v = require('./package.json').buildVersion || app.getVersion();
  return app.isPackaged ? v : v + '-dev';
});
const TWITCH_PARENT = '127.0.0.1';
ipcMain.handle('twitch-parent', () => TWITCH_PARENT);
app.on('will-quit', () => { if (uiServer) uiServer.close(); });

// Only YouTube / Twitch hosts (and our own loopback page) may be reached.
const ALLOWED = ['youtube.com', 'youtube-nocookie.com', 'ytimg.com', 'googlevideo.com', 'google.com', 'gstatic.com', 'googleapis.com', 'ggpht.com',
  'twitch.tv', 'jtvnw.net', 'ttvnw.net', 'twitchcdn.net', 'live-video.net',
  'd1ndex63qxojbr.cloudfront.net', // Twitch clip video files (exact host, not all of cloudfront.net)
  'api.github.com', 'objects.githubusercontent.com']; // the update check, and the file electron-updater downloads
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
    const initial = pendingOpen || sessionFileFromArgv(process.argv);
    pendingOpen = null;
    if (initial) win.webContents.send('open-session', initial);
    // one check, 10 s after the window is up, and only if the user hasn't turned it off
    setTimeout(() => {
      if (!readSettings().updates.auto) return;
      const up = getUpdater();
      if (up) { up.allowPrerelease = readSettings().updates.includePrerelease; up.checkForUpdates().catch(() => {}); }
      else noticeCheck(false);
    }, 10000);
  });

  win.on('closed', () => { win = null; });
}

// macOS: double-clicking a .mvp in Finder (or dropping it on the dock icon) arrives as open-file,
// often before the window exists; keep it until the page has loaded.
let pendingOpen = null;
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (!p.toLowerCase().endsWith('.mvp')) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('open-session', p);
  else pendingOpen = p;
});

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

    // macOS needs an application menu for Cmd+Q / Cmd+H and Cmd+C / V / A in text fields.
    if (process.platform === 'darwin') {
      const { Menu } = require('electron');
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    }

    createWindow();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- IPC ----

const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'ogg', 'avi', 'mp3', 'wav', 'm4a', 'flac'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const FRAME_EXTS = ['exr', 'tif', 'tiff', 'dpx'];

ipcMain.handle('pick-videos', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add videos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video / audio / images / sequences', extensions: [...VIDEO_EXTS, ...IMAGE_EXTS, ...FRAME_EXTS] },
      { name: 'Images', extensions: IMAGE_EXTS },
      { name: 'Image sequences (pick any frame)', extensions: ['exr', 'png', 'tif', 'tiff', 'jpg', 'jpeg', 'webp', 'dpx'] },
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
const Sequence = require('./lib/sequence');
const ExrHeader = require('./lib/exrheader');

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

// Cache = playable copies + thumbnails + decoded sequence frames (frames/ has a folder per sequence look).
function dirUsage(dir) {
  let bytes = 0, files = 0;
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { const u = dirUsage(p); bytes += u.bytes; files += u.files; }
      else { try { bytes += fs.statSync(p).size; files++; } catch {} }
    }
  } catch {}
  return { bytes, files };
}
ipcMain.handle('cache-info', () => {
  let bytes = 0, files = 0;
  for (const dir of [proxyDir(), thumbDir(), framesDir()]) { const u = dirUsage(dir); bytes += u.bytes; files += u.files; }
  return { bytes, files };
});
ipcMain.handle('clear-cache', () => {
  for (const job of proxyJobs.values()) job.child.kill();
  cancelAllFrames();
  for (const dir of [proxyDir(), thumbDir(), framesDir()]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
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
// Non-recursive: media files directly in the folder, sorted by name. Runs of frames come back as
// sequences (their frames are left out of files); a lone exr / tif / dpx frame is a file of kind 'frame'.
function readSequences(dir, names) {
  const frames = names.filter((n) => Sequence.isFrameExt(n));
  const { sequences } = Sequence.detect(frames);
  const members = new Set(sequences.flatMap((s) => s.frames));
  return { sequences: sequences.map(({ frames: _f, ...s }) => ({ ...s, dir })), members }; // the frame list stays here (missing[] says the rest)
}
ipcMain.handle('list-folder', (_e, dir) => {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); }
  catch { return { ok: false, files: [], sequences: [] }; }
  const { sequences, members } = readSequences(dir, names);
  const files = [];
  for (const n of Sources.filterMedia(names, { images: true })) {
    if (members.has(n)) continue;
    const p = path.join(dir, n);
    try { const st = fs.statSync(p); files.push({ path: p, name: n, size: st.size, mtimeMs: st.mtimeMs, kind: Sources.kindOf(n) }); } catch {}
  }
  return { ok: true, files, sequences };
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
    if (Sources.kindOf(filePath) === 'frame') { // exr / tif / dpx: the frame player's decode (sRGB, no exposure), scaled
      const vf = 'scale=320:-2,' + Sequence.filter({ seq: { ext: path.extname(filePath).slice(1) }, colour: 'srgb', useZscale: ffmpegHasSync('zscale') });
      return execFile(binPath('ffmpeg'), ['-y', '-i', filePath, '-frames:v', '1', '-vf', vf, '-q:v', '4', out], { windowsHide: true }, (e2) => done(e2 ? null : out));
    }
    execFile(binPath('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { windowsHide: true }, (err, stdout) => {
      const dur = err ? 0 : Number(stdout) || 0;
      const ss = (dur * 0.1).toFixed(2);
      execFile(binPath('ffmpeg'), ['-y', '-ss', ss, '-i', filePath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out], { windowsHide: true }, (e2) => done(e2 ? null : out));
    });
  };
  thumbWaiting.push(job); nextThumb();
}));

// ---- updates ----
// The installed Windows build updates itself with electron-updater. The portable exe (electron-updater
// doesn't support it) and Mac (the build is unsigned, so it would refuse) just get told that a newer
// release exists, with a link. Dev runs behave like the portable one. This check is the only network
// call the app makes on its own, it runs once at launch, and App ▾ can turn it off.
const REPO = { owner: 'CaptainSamus', repo: 'OzyMultiMediaPlayer' };
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;
const canAutoUpdate = () => process.platform === 'win32' && app.isPackaged && !isPortable();
const appVersion = () => require('./package.json').buildVersion || app.getVersion();
let updater = null, updateReady = false;
const toWin = (msg) => { if (win && !win.webContents.isDestroyed()) win.webContents.send('update-event', msg); };

function getUpdater() {
  if (!canAutoUpdate()) return null;
  if (!updater) {
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = readSettings().updates.includePrerelease;
      updater.on('update-available', (info) => toWin({ kind: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 500) : '' }));
      updater.on('update-not-available', () => toWin({ kind: 'none', version: appVersion() }));
      updater.on('download-progress', (p) => toWin({ kind: 'progress', percent: Math.round(p.percent) }));
      updater.on('update-downloaded', (info) => { updateReady = true; toWin({ kind: 'ready', version: info.version }); });
      updater.on('error', (err) => toWin({ kind: 'error', message: String(err && err.message || err).slice(0, 200) }));
    } catch (e) { updater = null; }
  }
  return updater;
}

const Version = require('./lib/version'); // 4-part version comparison, with its own tests
// portable / Mac / dev: ask GitHub what the newest release is and pass the link on
async function noticeCheck(manual) {
  const s = readSettings();
  if (!manual && !s.updates.auto) return { ok: false, skipped: true };
  try {
    const { net } = require('electron');
    const res = await net.fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases?per_page=5`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return { ok: false, error: 'GitHub said ' + res.status };
    const list = await res.json();
    const releases = (Array.isArray(list) ? list : []).filter((r) => !r.draft && (s.updates.includePrerelease || !r.prerelease));
    const mine = appVersion();
    const newest = releases.find((r) => Version.newer(r.tag_name, mine));
    if (newest) { toWin({ kind: 'notice', version: String(newest.tag_name).replace(/^v/, ''), url: newest.html_url }); return { ok: true, found: true }; }
    toWin({ kind: 'none', version: mine });
    return { ok: true, found: false };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 160) }; }
}

ipcMain.handle('update-info', () => ({
  version: appVersion(), platform: process.platform, packaged: app.isPackaged,
  portable: isPortable(), canAutoUpdate: canAutoUpdate(), ready: updateReady,
  settings: readSettings().updates,
}));
ipcMain.handle('update-check', async (_e, manual) => {
  const s = readSettings();
  if (!manual && !s.updates.auto) return { ok: false, skipped: true };
  const up = getUpdater();
  if (!up) return noticeCheck(manual); // portable, Mac, or dev
  up.allowPrerelease = s.updates.includePrerelease;
  try { await up.checkForUpdates(); return { ok: true }; }
  catch (e) { const msg = String(e.message).slice(0, 160); if (manual) toWin({ kind: 'error', message: msg }); return { ok: false, error: msg }; }
});
ipcMain.handle('update-download', async () => {
  const up = getUpdater();
  if (!up) return { ok: false, error: 'This build installs updates by hand' };
  try { await up.downloadUpdate(); return { ok: true }; }
  catch (e) { const msg = String(e.message).slice(0, 160); toWin({ kind: 'error', message: msg }); return { ok: false, error: msg }; }
});
ipcMain.on('update-install', () => { const up = getUpdater(); if (up && updateReady) up.quitAndInstall(); });
ipcMain.handle('open-external', (_e, url) => {
  const u = String(url);
  if (!/^https:\/\/(github\.com|api\.github\.com)\//.test(u)) return false; // only our own release pages
  require('electron').shell.openExternal(u);
  return true;
});

// ---- image sequences: the frame player's decode cache ----
// PNG / JPEG / WebP frames are read by the renderer straight from the originals. EXR / TIFF / DPX
// frames are decoded by ffmpeg into userData/frames/<key>/<frame>.png (8-bit display frames; the
// key includes the EXR look, so a new exposure or colour setting gets its own folder). Batches of up
// to 24 contiguous frames, at most two ffmpeg processes (more don't help: see lib/sequence.js).
const framesDir = () => path.join(app.getPath('userData'), 'frames');
let filterList = null;
function ffmpegHasSync(name) {
  if (filterList === null) {
    try { filterList = require('child_process').execFileSync(binPath('ffmpeg'), ['-hide_banner', '-filters'], { windowsHide: true, encoding: 'utf8' }); }
    catch { filterList = ''; }
  }
  return new RegExp(`\\s${name}\\s`).test(filterList);
}
ipcMain.handle('ffmpeg-has', (_e, name) => checkTools() && ffmpegHasSync(String(name)));
ipcMain.handle('frames-dir', () => framesDir());

// The run a picked or dropped frame belongs to (null if it's alone; the renderer then makes a
// one-frame sequence for exr / tif / dpx).
ipcMain.handle('sequence-for', (_e, filePath) => {
  const dir = path.dirname(filePath), name = path.basename(filePath);
  let names; try { names = fs.readdirSync(dir); } catch { return null; }
  return readSequences(dir, names).sequences.find((s) => Sequence.sameRun(s, name)) || null;
});
// First frame's mtime (part of the cache key) and picture size.
ipcMain.handle('seq-info', async (_e, dir, seq) => {
  const first = path.join(dir, Sequence.framePath(seq, seq.start));
  let firstMtime = 0;
  try { firstMtime = fs.statSync(first).mtimeMs; } catch { return { ok: false }; }
  const size = !checkTools() ? {} : await new Promise((resolve) => {
    execFile(binPath('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', first], { windowsHide: true }, (err, out) => {
      try { const s = JSON.parse(out).streams[0]; resolve({ width: s.width, height: s.height }); } catch { resolve({}); }
    });
  });
  return { ok: true, firstMtime, ...size };
});
// The parts / layers of an EXR frame, from the first 64 KB of it (headers live at the front).
ipcMain.handle('exr-layers', (_e, filePath) => {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return ExrHeader.parse(new Uint8Array(buf.subarray(0, n)));
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
});
ipcMain.handle('frames-on-disk', (_e, key) => {
  if (!/^[0-9a-f]{16}$/.test(String(key))) return [];
  try { return fs.readdirSync(path.join(framesDir(), key)).filter((f) => /^\d+\.png$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b); }
  catch { return []; }
});

const MAX_FRAME_PROCS = 2;
const frameKeys = new Map(); // key -> { req, sender, pending: [[a, b]], running: Map(child -> [a, b]) }; last entry = asked most recently
let frameProcs = 0;
// req: { key, dir, seq, exposure, colour, ranges: [[a, b], ...] } in frame numbers, most wanted first.
// A new request for a key replaces what that key still has waiting (the playhead moved).
ipcMain.on('ensure-frames', (e, req) => {
  if (!req || !/^[0-9a-f]{16}$/.test(String(req.key)) || !req.seq || !checkTools()) return;
  const out = path.join(framesDir(), req.key);
  const prev = frameKeys.get(req.key);
  const entry = prev || { running: new Map() };
  entry.req = req; entry.sender = e.sender; entry.cancelled = false;
  const busy = (f) => [...entry.running.values()].some(([a, b]) => f >= a && f <= b);
  const missing = new Set(req.seq.missing || []);
  const want = []; const seen = new Set();
  for (const [a0, b0] of req.ranges || []) {
    const a = Math.max(req.seq.start, a0), b = Math.min(req.seq.end, b0);
    for (let f = a; f <= b; f++) {
      if (seen.has(f) || missing.has(f) || busy(f)) continue;
      seen.add(f);
      if (!fs.existsSync(path.join(out, Sequence.cacheFile(req.seq, f)))) want.push(f);
    }
  }
  // contiguous batches, in the order asked (so the frames around the playhead go first)
  const batches = []; let run = [];
  for (const f of want) { if (run.length && f !== run[run.length - 1] + 1) { batches.push(...Sequence.batches(run)); run = []; } run.push(f); }
  if (run.length) batches.push(...Sequence.batches(run));
  entry.pending = batches;
  frameKeys.delete(req.key); frameKeys.set(req.key, entry);
  framesPump();
});
function framesPump() {
  while (frameProcs < MAX_FRAME_PROCS) {
    const entry = [...frameKeys.values()].reverse().find((k) => k.pending && k.pending.length);
    if (!entry) return;
    const [a, b] = entry.pending.shift();
    runFrameBatch(entry, a, b);
  }
}
function runFrameBatch(entry, a, b) {
  const { req } = entry;
  const out = path.join(framesDir(), req.key);
  const tmp = path.join(out, `.part-${a}-${process.hrtime.bigint()}`); // renamed into place only when ffmpeg succeeds
  const send = (...x) => { if (!entry.sender.isDestroyed()) entry.sender.send(...x); };
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (err) { send('frames-failed', req.key, a, b, err.message); return; }
  const args = Sequence.decodeArgs({ dir: req.dir, seq: req.seq, from: a, to: b, outDir: tmp, exposure: req.exposure, colour: req.colour, useZscale: ffmpegHasSync('zscale'), sep: path.sep });
  frameProcs++;
  const child = spawn(binPath('ffmpeg'), args, { windowsHide: true });
  entry.running.set(child, [a, b]);
  let tail = '';
  child.stderr.on('data', (d) => { tail = (tail + d).slice(-1500); });
  child.on('error', () => {}); // 'close' follows
  child.on('close', (code) => {
    frameProcs--; entry.running.delete(child);
    if (code === 0) { try { for (const f of fs.readdirSync(tmp)) fs.renameSync(path.join(tmp, f), path.join(out, f)); } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (code === 0) send('frames-ready', req.key, a, b);
    else if (!entry.cancelled) send('frames-failed', req.key, a, b, tail.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with ${code}`);
    framesPump();
  });
}
function cancelFrames(key) {
  const entry = frameKeys.get(key); if (!entry) return;
  entry.cancelled = true; entry.pending = [];
  for (const child of entry.running.keys()) { try { child.kill(); } catch {} }
  frameKeys.delete(key);
}
function cancelAllFrames() { for (const key of [...frameKeys.keys()]) cancelFrames(key); }
ipcMain.on('cancel-frames', (_e, key) => cancelFrames(key));
app.on('will-quit', cancelAllFrames);

// ---- YouTube / Twitch clips as real video tiles (yt-dlp) ----
// resolve-stream hands the renderer a direct URL a <video> can play (combined audio+video, so 720p
// or less). Those URLs expire, so the answer is cached only until WebStream says it is stale.
// download-video merges the best video+audio into the proxies cache for full quality and offline.
const WebStream = require('./lib/webstream');
const resolved = new Map(); // url -> { url, height, title, resolvedAt }
ipcMain.handle('resolve-stream', (_e, pageUrl) => new Promise((resolve) => {
  const key = String(pageUrl);
  const hit = resolved.get(key);
  if (hit && !WebStream.isExpired(hit.resolvedAt)) return resolve({ ok: true, ...hit });
  if (!fs.existsSync(binPath('yt-dlp'))) return resolve({ ok: false, error: 'yt-dlp not found' });
  // Which YouTube player client yields real formats changes over time, so try them in turn.
  const clients = String(key).includes('youtube') || String(key).includes('youtu.be') ? WebStream.CLIENTS : [''];
  let lastErr = '', outdated = false;
  const attempt = (i) => {
    if (i >= clients.length) return resolve({ ok: false, error: lastErr || 'Could not resolve this video', outdated });
    execFile(binPath('yt-dlp'), WebStream.resolveArgs(key, clients[i]), { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      const info = WebStream.parseResolved(stdout);
      if (!info) {
        lastErr = String(stderr || (err && err.message) || '').trim().split('\n').slice(-1)[0] || lastErr;
        outdated = outdated || Playlist.isOutdatedError(stderr);
        return attempt(i + 1);
      }
      const entry = { ...info, client: clients[i], resolvedAt: Date.now() };
      resolved.set(key, entry);
      resolve({ ok: true, ...entry });
    });
  };
  attempt(0);
}));

const downloadJobs = new Map(); // out path -> { child, reject }
let downloadQueue = Promise.resolve();
ipcMain.handle('download-video', (e, pageUrl, type, id) => {
  const send = (...args) => { if (!e.sender.isDestroyed()) e.sender.send('download-progress', ...args); };
  const run = () => new Promise((resolve, reject) => {
    if (!fs.existsSync(binPath('yt-dlp'))) return reject(new Error('yt-dlp not found'));
    fs.mkdirSync(proxyDir(), { recursive: true });
    const out = path.join(proxyDir(), WebStream.downloadName(type, id));
    if (fs.existsSync(out)) { send(pageUrl, 1); return resolve({ file: out }); } // already downloaded
    const tmp = out + '.part.mp4';
    const binDir = path.dirname(binPath('ffmpeg')); // yt-dlp needs ffmpeg to merge the two streams
    // the client that resolving found works goes first; otherwise try them in order
    const hitClient = (resolved.get(String(pageUrl)) || {}).client;
    const clients = String(pageUrl).includes('youtu') ? [...new Set([hitClient || '', ...WebStream.CLIENTS])] : [''];
    let ci = 0, started = false, tail = '';
    const attempt = () => {
    const child = spawn(binPath('yt-dlp'), WebStream.downloadArgs(pageUrl, tmp, binDir, clients[ci]), { windowsHide: true });
    downloadJobs.set(out, { child, reject });
    const onText = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-2000);
      const frac = WebStream.parseProgress(s);
      if (frac !== null) { started = true; send(pageUrl, frac); }
    };
    child.stdout.on('data', onText); // yt-dlp prints progress on stdout
    child.stderr.on('data', onText);
    child.on('close', (code) => {
      downloadJobs.delete(out);
      // no formats for this client and nothing downloaded yet: try the next one
      if (code !== 0 && code !== null && !started && ++ci < clients.length) { tail = ''; return attempt(); }
      if (code === 0) {
        // yt-dlp may add its own extension when merging; take whatever it actually wrote
        const made = fs.existsSync(tmp) ? tmp : ['.mp4', '.mkv', '.webm'].map((x) => tmp + x).find((p) => fs.existsSync(p));
        if (!made) return reject(new Error('yt-dlp finished but wrote no file'));
        try { fs.renameSync(made, out); } catch (err) { return reject(new Error('Could not save the download: ' + err.message)); }
        send(pageUrl, 1);
        resolve({ file: out });
      } else {
        for (const p of [tmp, tmp + '.mp4', tmp + '.mkv', tmp + '.webm']) { try { fs.unlinkSync(p); } catch {} }
        reject(new Error(code === null ? 'Cancelled' : 'yt-dlp failed:\n' + tail.trim().split('\n').slice(-3).join('\n')));
      }
    });
    };
    attempt();
  });
  const p = downloadQueue.then(run, run);
  downloadQueue = p.catch(() => {});
  return p;
});
ipcMain.on('cancel-download', (_e, type, id) => {
  const job = downloadJobs.get(path.join(proxyDir(), WebStream.downloadName(type, id)));
  if (job) job.child.kill();
});
// is a download already in the cache? (download mode is then instant)
ipcMain.handle('downloaded-file', (_e, type, id) => {
  const out = path.join(proxyDir(), WebStream.downloadName(type, id));
  return fs.existsSync(out) ? out : null;
});

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
