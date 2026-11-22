// Ozy Multi Media Player - main process.
// Local files never leave the machine. The UI is served from a loopback-only
// http server (YouTube and Twitch embeds need a real http origin), and every
// other network request is cancelled unless it goes to a YouTube/Twitch host.

// Node does all file reads on a pool of 4 threads by default. Every playing video streams through
// that pool, so with a big board on a busy PC a simple "does this file exist?" waited in line for
// seconds. More threads; must be set before the pool is first used.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const { app, BrowserWindow, ipcMain, dialog, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---- logging ----
// There was no way to find out why a packaged build misbehaved on Mark's machine, so every run now
// writes a real log file: app.getPath('logs') (on Windows userData\logs, which the portable exe has
// too), 2 MB per file, 5 kept. How a line looks lives in lib/logfmt.js, where it is tested.
const LogFmt = require('./lib/logfmt');
const elog = require('electron-log');
const LOG_MAX = 2 * 1024 * 1024;
const logsDir = () => path.join(app.getPath('logs'));
function setupLogging() {
  elog.transports.file.maxSize = LOG_MAX;
  elog.transports.file.resolvePathFn = () => path.join(logsDir(), 'main.log');
  // Our own format, so main.log and the renderer's forwarded lines read the same. It must return an
  // ARRAY: electron-log runs the result through more transforms, which reduce over it.
  elog.transports.file.format = ({ message }) => [message.data[0]];
  elog.transports.console.format = ({ message }) => [message.data[0]];
  if (app.isPackaged) elog.transports.console.level = false; // no console to print to
  // electron-log keeps main.old.log; ask for 5 files' worth of history
  elog.transports.file.archiveLogFn = (file) => {
    const f = file.path !== undefined ? file.path : String(file);
    const dir = path.dirname(f), ext = path.extname(f), base = path.basename(f, ext);
    try {
      for (let i = 4; i >= 1; i--) {
        const from = path.join(dir, `${base}.${i}${ext}`);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `${base}.${i + 1}${ext}`));
      }
      fs.renameSync(f, path.join(dir, `${base}.1${ext}`));
    } catch {}
  };
}
// One way in for everything, main and renderer alike.
const log = (level, msg, data, scope = 'main') => {
  try { elog[LogFmt.level(level)](LogFmt.line({ level, scope, msg, data })); } catch {}
};
const logError = (msg, err, data, scope = 'main') => {
  try { elog.error(LogFmt.errorLine({ scope, msg, err, data })); } catch {}
};
// A failed tool run is the most common real-world failure: keep the command and what it said.
const logTool = (name, args, err, stderr) => {
  logError(`${name} failed`, err, {
    args: Array.isArray(args) ? args.join(' ').slice(0, 300) : String(args || ''),
    code: err && (err.code !== undefined ? err.code : err.exitCode),
    stderr: String(stderr || '').trim().split('\n').slice(-4).join(' ⏎ ').slice(0, 600),
  });
};

// Crashes and swallowed rejections: log, and keep running where it is safe to.
process.on('uncaughtException', (err) => logError('uncaught exception', err));
process.on('unhandledRejection', (reason) => logError('unhandled rejection', reason instanceof Error ? reason : { message: LogFmt.data(reason) }));
app.on('render-process-gone', (_e, _wc, details) => log('error', 'render process gone', details));
app.on('child-process-gone', (_e, details) => log('error', 'child process gone', details));
app.on('will-quit', () => log('info', 'app quit'));

// Every ipcMain.handle in this file gets wrapped once, here: a handler that throws used to reject
// in the renderer with no trace of why on this side.
const rawHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => rawHandle(channel, async (event, ...args) => {
  try { return await fn(event, ...args); }
  catch (err) { logError(`ipc ${channel}`, err); throw err; }
});

// Custom scheme that streams local files with HTTP range support (needed for
// scrubbing) while keeping Chromium's normal web security enabled.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localvideo',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

// content types and Range handling: lib/mediahttp.js (shared with the media server process)
const MediaHttp = require('./lib/mediahttp');

// Where ffmpeg.exe / ffprobe.exe / yt-dlp.exe live: bundled next to the app when packaged,
// straight out of node_modules (ffmpeg, ffprobe) or bin/ (yt-dlp) in development.
// yt-dlp prefers a self-updated copy in userData/bin (the install folder may not be writable).
const EXE = process.platform === 'win32' ? '.exe' : ''; // bundled tools are bin/ffmpeg.exe on Windows, bin/ffmpeg on macOS
const bundledYtdlp = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'yt-dlp' + EXE) : path.join(__dirname, 'bin', 'yt-dlp' + EXE));
const userYtdlp = () => path.join(app.getPath('userData'), 'bin', 'yt-dlp' + EXE);
function binPath(name) {
  if (name === 'yt-dlp') return fs.existsSync(userYtdlp()) ? userYtdlp() : bundledYtdlp();
  // QuickJS-NG, the JavaScript runtime yt-dlp uses to solve YouTube's player challenge. It is the
  // one tool that is optional at runtime - yt-dlp still runs without it, just badly - so a missing
  // binary answers '' rather than a path that does not exist.
  if (name === 'qjs') {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'bin', 'qjs' + EXE)
      : (process.platform === 'darwin' ? path.join(__dirname, 'bin', 'darwin-' + process.arch, 'qjs') : path.join(__dirname, 'bin', 'qjs' + EXE));
    try { return fs.existsSync(p) ? p : ''; } catch { return ''; }
  }
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', name + EXE);
  if (name === 'ffmpeg') return require('ffmpeg-static');
  return require('ffprobe-static').path;
}
const qjs = () => binPath('qjs');

function urlToFilePath(url) {
  // localvideo://v/<base64url of absolute path>
  const u = new URL(url);
  const seg = u.pathname.replace(/^\/+/, '');
  return Buffer.from(seg, 'base64url').toString('utf8');
}

// Serves localvideo:// — the fallback way the windows get videos, pictures and cached frames, used
// only if the media server process (below) could not start. It runs on the main process, so a
// tile whose file sits on a share that no longer answers must not be able to block it: the stat is
// guarded like every other user-supplied path, and an unreachable file simply 404s.
// when each cached video copy was last asked for: the cache trim leaves alone what a tile is reading
const proxyServedAt = new Map();
async function handleVideoRequest(request) {
  let filePath;
  try { filePath = urlToFilePath(request.url); } catch { return new Response('Bad URL', { status: 400 }); }
  if (MediaHttp.PROXY_FILE.test(filePath)) proxyServedAt.set(path.normalize(filePath).toLowerCase(), Date.now());

  const stat = await guardedStat(filePath);
  if (!stat) return new Response('Not found', { status: 404 });
  if (!stat.isFile()) return new Response('Not a file', { status: 404 });

  const size = stat.size;
  const baseHeaders = { 'Content-Type': MediaHttp.typeOf(path.extname(filePath)), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (size === 0) return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': '0' } });

  const r = MediaHttp.range(request.headers.get('range'), size);
  if (r.status === 416) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const headers = { ...baseHeaders, 'Content-Length': String(r.end - r.start + 1) };
  if (r.status === 206) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`;
  if (request.method === 'HEAD') return new Response(null, { status: r.status, headers });

  const stream = fs.createReadStream(filePath, { start: r.start, end: r.end });
  return new Response(Readable.toWeb(stream), { status: r.status, headers });
}

// ---- media server process ----
// Every video, picture and cached frame is served by lib/mediaserver.js in its own background
// process, so the bytes of a big board playing never pass through this one (see that file). The
// windows build their media URLs from mediaBase, which they ask for once as they load (preload.js):
// http://127.0.0.1:<port>/m/<token>/. Empty means the server isn't there and they use localvideo://.
const crypto = require('crypto');
const mediaToken = crypto.randomBytes(16).toString('hex');
let mediaProc = null;
let mediaPort = 0;
let mediaBase = '';
let mediaRestarts = 0;
let quitting = false;
function startMediaServer() {
  return new Promise((resolve) => {
    const { utilityProcess } = require('electron');
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    let proc;
    try {
      proc = utilityProcess.fork(path.join(__dirname, 'lib', 'mediaserver.js'), [], {
        serviceName: 'Ozy media server',
        stdio: 'ignore',
        env: { ...process.env, UV_THREADPOOL_SIZE: '16' }, // many videos read at once: more file threads
      });
    } catch (e) { log('error', 'media server could not start; serving from the main process', { error: String(e && e.message) }); return done(false); }
    mediaProc = proc;
    const timer = setTimeout(() => { log('warn', 'media server did not answer in time; serving from the main process'); done(false); }, 8000);
    proc.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        clearTimeout(timer);
        const restarted = !!mediaBase;
        mediaPort = m.port;
        mediaBase = `http://127.0.0.1:${mediaPort}/m/${mediaToken}/`;
        log('info', restarted ? 'media server restarted' : 'media server ready', { port: mediaPort });
        if (fsGuard.networkDrives.size) proc.postMessage({ type: 'network-drives', list: [...fsGuard.networkDrives] });
        if (restarted) for (const w of ozyWindows()) { w.webContents.send('media-base', mediaBase); w.webContents.send('paths-recovered'); }
        done(true);
      } else if (m.type === 'failed') {
        // the old port was taken by something else after a restart: take any free one
        if (mediaPort) { mediaPort = 0; proc.postMessage({ type: 'init', port: 0, token: mediaToken, uiOrigin: `http://127.0.0.1:${uiPort}` }); }
        else { clearTimeout(timer); done(false); }
      } else if (m.type === 'served-proxy') {
        proxyServedAt.set(path.normalize(String(m.path)).toLowerCase(), Date.now());
      } else if (m.type === 'recovered') {
        announceRecovered();
      } else if (m.type === 'log') {
        log(m.level || 'info', '[media] ' + m.msg, m.data);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (mediaProc === proc) mediaProc = null;
      if (quitting) return;
      log('warn', 'media server stopped', { code });
      done(false);
      // bring it back on the same port, so the windows' URLs keep working; give up after a few tries
      if (mediaBase && mediaRestarts++ < 5) setTimeout(() => { if (!quitting) startMediaServer(); }, 500);
      else if (mediaBase) { mediaBase = ''; for (const w of ozyWindows()) w.webContents.send('media-base', ''); }
    });
    proc.postMessage({ type: 'init', port: mediaPort, token: mediaToken, uiOrigin: `http://127.0.0.1:${uiPort}` });
  });
}
app.on('will-quit', () => { quitting = true; if (mediaProc) mediaProc.kill(); });
ipcMain.on('media-base', (e) => { e.returnValue = mediaBase; });

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
      if (up) { up.allowPrerelease = allowPrerelease(readSettings()); up.checkForUpdates().catch(() => {}); }
      else noticeCheck(false);
    }, 10000);
  });

  // the views are cameras on this window's board: they go when it goes
  win.on('closed', () => {
    win = null;
    for (const v of views.values()) if (!v.isDestroyed()) v.close();
  });
}

// ---- extra views ----
// Up to two more windows on the same board (index.html?view=N): own pan and zoom, playback
// mirrored, no editing. The renderers talk over the bus below; the main window is the authority
// for the layout and answers a new view's snapshot-request with the whole board.
const views = new Map(); // n -> BrowserWindow
const ozyWindows = () => [win, ...views.values()].filter((w) => w && !w.isDestroyed());
function openView(n, bounds) {
  if (n !== 1 && n !== 2) return false;
  const open = views.get(n);
  if (open && !open.isDestroyed()) { if (open.isMinimized()) open.restore(); open.focus(); return true; }
  const b = bounds && typeof bounds === 'object' ? { ...bounds } : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined);
  // a saved place on a monitor that is not there any more: let the system place the window
  if (num(b.x) !== undefined && num(b.y) !== undefined) {
    const { screen } = require('electron');
    const r = { x: num(b.x), y: num(b.y), width: num(b.w) || 1100, height: num(b.h) || 700 };
    const onScreen = screen.getAllDisplays().some((d) => { const a = d.workArea; return r.x < a.x + a.width - 40 && r.x + r.width > a.x + 40 && r.y < a.y + a.height - 40 && r.y + r.height > a.y; });
    if (!onScreen) { delete b.x; delete b.y; }
  }
  const v = new BrowserWindow({
    width: num(b.w) > 300 ? num(b.w) : 1100,
    height: num(b.h) > 200 ? num(b.h) : 700,
    x: num(b.x), y: num(b.y),
    minWidth: 500, minHeight: 320,
    backgroundColor: '#0f0f10',
    autoHideMenuBar: true,
    title: `Ozy view ${n}`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
      // A view is silent (the main window has the sound), and Chromium pauses a silent video in a
      // window it thinks is hidden - a view behind the main window, or on a monitor it thinks is
      // covered. A view has to keep playing in step whatever is in front of it.
      backgroundThrottling: false,
    },
  });
  v.loadURL(`http://127.0.0.1:${uiPort}/index.html?view=${n}`);
  views.set(n, v);
  v.on('closed', () => {
    if (views.get(n) === v) views.delete(n);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('bus', { type: 'view-closed', n });
  });
  return true;
}
ipcMain.handle('open-view', (_e, n, bounds) => openView(Number(n), bounds));
ipcMain.handle('view-bounds', (e) => { const w = BrowserWindow.fromWebContents(e.sender); return w && !w.isDestroyed() ? w.getBounds() : null; });
// The bus: whatever one Ozy window sends goes to every other one, untouched. A new view's
// snapshot-request goes to the main window only. A window that is closing is skipped.
ipcMain.on('bus', (e, msg) => {
  if (!msg || typeof msg !== 'object') return;
  const targets = msg.type === 'snapshot-request' ? [win] : ozyWindows();
  for (const w of targets) {
    if (!w || w.isDestroyed() || w.webContents.isDestroyed() || w.webContents === e.sender) continue;
    try { w.webContents.send('bus', msg); } catch {}
  }
});

// macOS: double-clicking a .mvp in Finder (or dropping it on the dock icon) arrives as open-file,
// often before the window exists; keep it until the page has loaded.
let pendingOpen = null;
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (!p.toLowerCase().endsWith('.mvp')) return;
  if (win && !win.webContents.isLoading()) win.webContents.send('open-session', p);
  else pendingOpen = p;
});

// Windows groups a taskbar button with its pin by app ID. The installer tags the Start menu, desktop
// and pinned shortcuts with build.appId, but the app itself never said it, so it had that ID only
// when started from one of those shortcuts. Opened from a .mvp file, restarted after an update or
// started from Explorer, it got a different ID and showed up as a second icon beside the pin
// (Mark, 2026-11-22). Saying the same ID here keeps it on its pin however it starts. Dev runs keep
// Electron's own ID so they don't land on the installed app's pin.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('com.ozy.multimediaplayer'); // = package.json build.appId

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
    setupLogging();
    elog.info(startupHeader()); // the block every run starts with
    detectDriveTypes(); // which drive letters are network drives (see guardedFs)
    protocol.handle('localvideo', handleVideoRequest);
    await startUiServer();
    await startMediaServer(); // before the window: its first URLs already go there

    // Network allowlist: our loopback page, plus YouTube / Twitch hosts. Everything else is cancelled.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
      (details, callback) => {
        let u = null;
        try { u = new URL(details.url); } catch {}
        const own = !!u && u.protocol === 'http:' && u.hostname === '127.0.0.1' && (Number(u.port) === uiPort || (mediaPort > 0 && Number(u.port) === mediaPort));
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
  // The .mvp itself can be on a share that no longer answers, so this is guarded too.
  const raw = await guardedReadFile(filePath, 'utf8');
  if (raw === null) throw new Error(`Could not read ${filePath}`);
  const data = JSON.parse(String(raw).replace(/^﻿/, ''));
  log('info', 'session read', { path: filePath, version: data && data.version, videos: Array.isArray(data && data.videos) ? data.videos.length : 0, bytes: String(raw).length });
  return { filePath, data };
});

// Does this file exist? A session can name files on a share or drive that no longer answers, so
// every call on a user-supplied path is guarded: see lib/fsguard.js (where the "every video goes
// red when the PC is busy" bug was, and is tested).
const FsGuard = require('./lib/fsguard');
// A slow call finally answered: every window is told (once a second at most) so tiles that failed
// meanwhile load again.
let recoverTimer = null;
function announceRecovered() {
  if (recoverTimer) return;
  recoverTimer = setTimeout(() => {
    recoverTimer = null;
    for (const w of ozyWindows()) w.webContents.send('paths-recovered');
  }, 1000);
}
const fsGuard = FsGuard.create({ onRevive: announceRecovered, log: (level, msg, data) => log(level, msg, data) });
const guardedFs = (p, work, fallback) => fsGuard.run(p, work, fallback);
// Which drive letters are mapped network drives (the only drive letters that may hang like a
// share). Asked once, in the background, at startup; until the answer is back every drive letter
// counts as local, which at worst means one slow load from a dead mapped drive, never a false "missing".
function detectDriveTypes() {
  if (process.platform !== 'win32') return;
  const ps = 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { "$($_.DeviceID) $($_.DriveType)" }';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
    if (err) { log('warn', 'could not list drive types; every drive letter counts as local', { error: String(err.message || err) }); return; }
    for (const d of FsGuard.networkDrivesFrom(stdout)) fsGuard.networkDrives.add(d);
    if (mediaProc && fsGuard.networkDrives.size) mediaProc.postMessage({ type: 'network-drives', list: [...fsGuard.networkDrives] });
    log('info', 'drive types', { network: [...fsGuard.networkDrives] });
  });
}
const fileExists = (p) => guardedFs(p, () => fs.promises.access(p, fs.constants.F_OK).then(() => true), false);
const guardedStat = (p) => guardedFs(p, () => fs.promises.stat(p), null);
const guardedReaddir = (p, opts) => guardedFs(p, () => fs.promises.readdir(p, opts), null);
const guardedReadFile = (p, enc) => guardedFs(p, () => fs.promises.readFile(p, enc), null);
// the first bytes of a file, for the EXR header
const guardedReadHead = (p, bytes) => guardedFs(p, async () => {
  const fh = await fs.promises.open(p, 'r');
  try { const buf = Buffer.alloc(bytes); const { bytesRead } = await fh.read(buf, 0, bytes, 0); return buf.subarray(0, bytesRead); }
  finally { await fh.close().catch(() => {}); }
}, null);
ipcMain.handle('file-exists', (_e, p) => fileExists(p));
// a new session load gets a fresh chance at a share that may be back
ipcMain.on('forget-dead-paths', () => { fsGuard.forget(); if (mediaProc) mediaProc.postMessage({ type: 'forget' }); });

// ---- logging: what the renderer sends, and the two App ▾ items ----
// The renderer forwards window.onerror, unhandledrejection and console.error here, plus a few
// info-level user actions. Paths are fine in a log; file contents are never sent.
ipcMain.on('log', (_e, level, msg, data) => log(level, msg, data, 'ui'));
ipcMain.handle('open-logs', async () => {
  const dir = logsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  log('info', 'open logs folder', { dir });
  const err = await require('electron').shell.openPath(dir);
  if (err) { logError('open logs folder', { message: err }, { dir }); return { ok: false, error: err, dir }; }
  return { ok: true, dir };
});
// Everything Mark needs in one paste: the start-up header, what's on the board, and the log tail.
ipcMain.handle('copy-diagnostics', async (_e, session) => {
  const file = path.join(logsDir(), 'main.log');
  const text = LogFmt.diagnostics({
    header: startupHeader(),
    session: LogFmt.sessionSummary(session || {}),
    log: (await guardedReadFile(file, 'utf8')) || '',
  });
  require('electron').clipboard.writeText(text);
  log('info', 'diagnostics copied', { lines: LogFmt.tail(text, 1e9).length });
  return { ok: true, lines: LogFmt.tail(text, 1e9).length };
});

// ---- ffprobe / ffmpeg proxies ----

const { execFile, spawn } = require('child_process');
const Codecs = require('./lib/codecs');
const ProxyCache = require('./lib/proxy');
const Sequence = require('./lib/sequence');
const ExrHeader = require('./lib/exrheader');

/* DISABLED (2026-10-07): the cache folder can be moved (Optimize ▾ → Change folder…)
const proxyDir = () => path.join(app.getPath('userData'), 'proxies');
*/
// settings.cacheDir (null = the app's own data folder); always a `proxies` folder inside it, so
// clearing the cache can never remove anything else from a folder the user picked
const proxyDir = () => { const s = readSettings(); return s.cacheDir ? path.join(s.cacheDir, 'proxies') : path.join(app.getPath('userData'), 'proxies'); };
function proxyPathFor(filePath, stat, tier = 'full') {
  return path.join(proxyDir(), ProxyCache.name(filePath, stat.size, stat.mtimeMs, tier));
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
  const base = { codec: null, width: null, height: null, fps: null, duration: null, mime: null, proxy: null, tiers: { half: null, quarter: null }, available: checkTools() };
  const stat = await guardedStat(filePath); // may be on a share that no longer answers
  if (!stat) return base;
  const proxy = proxyPathFor(filePath, stat);
  if (fs.existsSync(proxy)) base.proxy = proxy; // the proxy cache is ours, always local
  // smaller copies already made for the playback tiers (Optimize menu / a tile's own quality)
  for (const tier of ['half', 'quarter']) { const p = proxyPathFor(filePath, stat, tier); if (fs.existsSync(p)) base.tiers[tier] = p; }
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

// A stretch of a video's sound for lining up by sound (lib/audiosync.js): mono 16-bit PCM at 8 kHz,
// at most ten minutes (the stretch between two sync points, when finding where two cuts part), as bytes. null when the file is gone, has no sound, or ffmpeg fails.
ipcMain.handle('audio-pcm', async (_e, filePath, start, dur) => {
  if (typeof filePath !== 'string' || !checkTools()) return null;
  const s = Math.max(0, Number(start) || 0), d = Math.min(600, Math.max(0, Number(dur) || 0));
  if (!d || !(await guardedStat(filePath))) return null;
  return new Promise((resolve) => {
    execFile(binPath('ffmpeg'), ['-v', 'error', '-ss', s.toFixed(3), '-t', d.toFixed(3), '-i', filePath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'],
      { windowsHide: true, encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 60000 }, (err, stdout) => {
        if (err || !stdout || !stdout.length) { if (err) log('warn', 'audio-pcm failed', { error: String(err.message || err).slice(0, 300) }); return resolve(null); }
        resolve(new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length));
      });
  });
});

// Where the picture cuts in a short stretch of a video (at most 5 s): the times, in the video's own
// time. Used to put a cut found by sound exactly on the frame where the shot changes.
ipcMain.handle('scene-cuts', async (_e, filePath, start, dur) => {
  if (typeof filePath !== 'string' || !checkTools()) return [];
  const s = Math.max(0, Number(start) || 0), d = Math.min(5, Math.max(0, Number(dur) || 0));
  if (!d || !(await guardedStat(filePath))) return [];
  return new Promise((resolve) => {
    execFile(binPath('ffmpeg'), ['-hide_banner', '-ss', s.toFixed(3), '-t', d.toFixed(3), '-i', filePath, '-an', '-vf', "select='gt(scene,0.2)',showinfo", '-f', 'null', '-'],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30000 }, (err, _out, stderr) => {
        if (err) return resolve([]);
        resolve([...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map((m) => s + Number(m[1])).filter(isFinite));
      });
  });
});

// How much each frame of a stretch (at most 30 s) changes from the one before, for lining two videos
// up by picture (lib/picsync.js): [{ t, v }], t in the video's own time, v the mean grey-level change
// of 32x24 frames. [] when it cannot be read.
ipcMain.handle('frame-activity', async (_e, filePath, start, dur) => {
  if (typeof filePath !== 'string' || !checkTools()) return [];
  const s = Math.max(0, Number(start) || 0), d = Math.min(30, Math.max(0, Number(dur) || 0));
  if (!d || !(await guardedStat(filePath))) return [];
  const W = 32, H = 24, N = W * H;
  return new Promise((resolve) => {
    const child = spawn(binPath('ffmpeg'), ['-hide_banner', '-ss', s.toFixed(3), '-t', d.toFixed(3), '-i', filePath, '-an', '-vf', `scale=${W}:${H},format=gray,showinfo`, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const chunks = []; let err = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { err += c; if (err.length > 4e6) err = err.slice(-2e6); });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      const times = [...err.matchAll(/pts_time:([0-9.]+)/g)].map((m) => s + Number(m[1]));
      const n = Math.min(times.length, Math.floor(buf.length / N)), out = [];
      for (let i = 1; i < n; i++) { let v = 0; for (let k = 0; k < N; k++) v += Math.abs(buf[i * N + k] - buf[(i - 1) * N + k]); out.push({ t: times[i], v: v / N }); }
      resolve(out);
    });
  });
});

// One ffmpeg at a time; others wait their turn. A job is one file at one tier ('full' is the
// playable copy; 'half' / 'quarter' the smaller playback copies).
const proxyJobs = new Map(); // `${filePath}|${tier}` -> { child, reject }: the one that is running
const proxyPending = new Map(); // same key -> its promise, waiting or running; asking again joins it
const proxyCancelled = new Set(); // keys cancelled while still waiting their turn
let proxyQueue = Promise.resolve();

ipcMain.handle('make-proxy', (e, filePath, tier = 'full') => {
  tier = ProxyCache.divisor(tier) === 1 ? 'full' : tier;
  const key = ProxyCache.jobKey(filePath, tier);
  const what = tier === 'full' ? 'playable copy' : `${tier}-resolution copy`;
  proxyCancelled.delete(key); // wanted again before its turn came
  const send = (...args) => { if (!e.sender.isDestroyed()) e.sender.send('proxy-progress', ...args); };
  // The checks run before the promise is made: an async executor would swallow a throw (mkdirSync
  // can fail) and the job would never settle, wedging the queue behind it.
  const run = async () => {
    if (proxyCancelled.delete(key)) throw new Error('Cancelled');
    if (!checkTools()) throw new Error('ffmpeg not found');
    const stat = await guardedStat(filePath);
    if (!stat) throw new Error('File not found');
    fs.mkdirSync(proxyDir(), { recursive: true });
    const out = proxyPathFor(filePath, stat, tier);
    if (fs.existsSync(out)) return { proxy: out };
    const tmp = out + '.part.mp4';
    return new Promise((resolve, reject) => {
      const child = spawn(binPath('ffmpeg'), ProxyCache.args(filePath, tmp, tier), { windowsHide: true });
      proxyJobs.set(key, { child, reject });
      let duration = 0, tail = '';
      child.stderr.on('data', (buf) => {
        const s = buf.toString();
        tail = (tail + s).slice(-2000);
        if (!duration) { const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s); if (m) duration = +m[1] * 3600 + +m[2] * 60 + +m[3]; }
        const t = ProxyCache.parseTime(s);
        if (t !== null && duration) send(filePath, Math.min(0.99, t / duration), tier);
      });
      child.on('close', (code) => {
        proxyJobs.delete(key);
        if (code === 0) {
          try { fs.renameSync(tmp, out); } catch (err) { logError('proxy rename', err, { tmp, out }); return reject(new Error(`Could not save ${what}: ` + err.message)); }
          send(filePath, 1, tier);
          log('info', `${what} made`, { path: filePath, tier, out });
          resolve({ proxy: out });
          trimProxyCache(out);
        } else {
          try { fs.unlinkSync(tmp); } catch {}
          if (code !== null) logTool(`ffmpeg (${what})`, ProxyCache.args(filePath, tmp, tier), { code }, tail);
          else log('info', `${what} cancelled`, { path: filePath, tier });
          reject(new Error(code === null ? 'Cancelled' : 'ffmpeg failed:\n' + tail.split('\n').slice(-4).join('\n')));
        }
      });
    });
  };
  // asked again while this file and tier is waiting or encoding: the same job, never a second ffmpeg
  return ProxyCache.once(proxyPending, key, () => {
    const p = proxyQueue.then(run, run);
    proxyQueue = p.catch(() => {});
    return p;
  });
});

// After every finished copy: back under settings.cacheCapMB, least recently used first (rules in
// lib/cachepolicy.js). The copy just made and anything a tile asked for in the last ten minutes
// are left alone; so is whatever can't be deleted. Windows updates a file's access time lazily, so
// "used" is the newest of access time, modified time and when we last served it.
const CachePolicy = require('./lib/cachepolicy');
const PROXY_BUSY_MS = 10 * 60 * 1000;
function trimProxyCache(justMade) {
  try {
    const dir = proxyDir();
    const now = Date.now();
    const keep = justMade ? path.normalize(justMade).toLowerCase() : null;
    const files = [];
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.mp4') || n.endsWith('.part.mp4')) continue;
      const p = path.join(dir, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      const k = path.normalize(p).toLowerCase();
      const served = proxyServedAt.get(k) || 0;
      files.push({ path: p, size: st.size, atimeMs: Math.max(st.atimeMs, st.mtimeMs, served), busy: k === keep || now - served < PROXY_BUSY_MS });
    }
    const cap = readSettings().cacheCapMB * 1048576;
    for (const p of CachePolicy.evict(files, cap)) {
      try { fs.unlinkSync(p); proxyServedAt.delete(path.normalize(p).toLowerCase()); log('info', 'cache trimmed', { path: p }); } catch {} // in use: next time
    }
  } catch (err) { logError('cache trim', err); }
}

ipcMain.on('cancel-proxy', (_e, filePath, tier = 'full') => {
  const key = ProxyCache.jobKey(filePath, tier);
  const job = proxyJobs.get(key);
  if (job) job.child.kill();
  else if (proxyPending.has(key)) proxyCancelled.add(key); // still waiting its turn: dropped when it gets there
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
  // the cap covers the video copies only (thumbnails and decoded sequence frames are not trimmed)
  return { bytes, files, proxyBytes: dirUsage(proxyDir()).bytes, capMB: readSettings().cacheCapMB, dir: proxyDir() };
});
// ---- load viewer ----
// Totals only: Ozy's own processes from app.getAppMetrics(), the machine from os. No per-program detail.
const os = require('os');
const LoadStats = require('./lib/loadstats');
let lastCpus = null;
// GPU: whole-machine busy % and video memory from the driver's own tool when it exists (NVIDIA
// only; a read-only query, nothing is ever set). Windows gives no per-process video memory, so
// Ozy's share is the GPU-process working set shown beside it. The tool runs on its own, at most
// once a second and never two at a time; the load tick only ever reads the last good sample, so
// a slow or hung nvidia-smi (killed after 400 ms) cannot hold the tick up.
const nvidiaSmi = (() => {
  const cands = process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe')] : ['/usr/bin/nvidia-smi'];
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
})();
let gpuLast = null, gpuAt = 0, gpuBusy = false, gpuAsked = 0;
function sampleGpu() {
  const now = Date.now();
  if (!nvidiaSmi || gpuBusy || now - gpuAsked < 900) return;
  gpuBusy = true; gpuAsked = now;
  try {
    execFile(nvidiaSmi, ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 400 }, (err, stdout) => {
      gpuBusy = false;
      if (!err) { const g = LoadStats.parseNvidiaSmi(stdout); if (g) { gpuLast = g; gpuAt = Date.now(); } }
    });
  } catch { gpuBusy = false; }
}
ipcMain.handle('load-stats', () => {
  sampleGpu(); // fills gpuLast for a later tick
  const cpus = os.cpus();
  const sysCpu = LoadStats.cpuPercent(lastCpus, cpus);
  lastCpus = cpus;
  let appCpu = 0, appMemMB = 0, gpuMemMB = 0;
  for (const m of app.getAppMetrics()) {
    const mb = (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024;
    appCpu += m.cpu ? m.cpu.percentCPUUsage : 0;
    if (m.type === 'GPU') gpuMemMB += mb; else appMemMB += mb;
  }
  // percentCPUUsage is already a share of the whole machine (Electron divides by the core count),
  // so the processes just add up. One decimal: on a many-core machine a few videos are 1-2 %.
  appCpu = Math.round(appCpu * 10) / 10;
  const totalMemMB = os.totalmem() / 1048576, usedMemMB = (os.totalmem() - os.freemem()) / 1048576;
  return { appCpu, appMemMB: Math.round(appMemMB + gpuMemMB), gpuMemMB: Math.round(gpuMemMB), sysCpu, usedMemMB: Math.round(usedMemMB), totalMemMB: Math.round(totalMemMB), gpu: LoadStats.freshGpu(gpuLast, gpuAt, Date.now()) };
});

ipcMain.handle('pick-cache-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Cache folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
ipcMain.handle('clear-cache', () => {
  for (const job of proxyJobs.values()) job.child.kill();
  for (const key of proxyPending.keys()) if (!proxyJobs.has(key)) proxyCancelled.add(key); // and the ones still waiting
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

// ---------- Miro import (Mark, 2026-11-06) ----------
// The renderer asks; this process talks to Miro (lib/miroimport.js) and writes the board. The
// token is kept only if the user ticks "remember", encrypted by Windows for this user
// (safeStorage), and it is never handed back to a window.
const MiroImport = require('./lib/miroimport');
const MiroClip = require('./lib/miroclip');
const miroTokenPath = () => path.join(app.getPath('userData'), 'miro-token.bin');
function miroSavedToken() {
  try { const { safeStorage } = require('electron'); if (!safeStorage.isEncryptionAvailable()) return ''; return safeStorage.decryptString(fs.readFileSync(miroTokenPath())); } catch { return ''; }
}
function miroSaveToken(tok) {
  try { const { safeStorage } = require('electron'); if (!safeStorage.isEncryptionAvailable()) return false; fs.writeFileSync(miroTokenPath(), safeStorage.encryptString(tok)); return true; } catch { return false; }
}
// Where imports go unless picked: "Ozy Imports" on the drive the app is installed on, unless
// that is the system drive (then on the first other fixed drive with room, else Documents).
function miroDefaultRoot() {
  const sys = (process.env.SystemDrive || 'C:').toUpperCase();
  const appDrive = path.parse(process.execPath).root.slice(0, 2).toUpperCase(); // 'D:' from 'D:\'
  if (/^[A-Z]:$/.test(appDrive) && appDrive !== sys) return path.join(appDrive + path.sep, 'Ozy Imports');
  for (const d of 'DEFGHIJ') { try { if (d + ':' !== sys && fs.existsSync(d + ':' + path.sep)) return path.join(d + ':' + path.sep, 'Ozy Imports'); } catch {} }
  return path.join(app.getPath('documents'), 'Ozy Imports');
}
// which folder each Miro board was imported into: { boardId: dir } (no token, nothing secret)
const miroBoardsPath = () => path.join(app.getPath('userData'), 'miro-boards.json');
function miroBoards(next) {
  if (next) { try { fs.writeFileSync(miroBoardsPath(), JSON.stringify(next, null, 1)); } catch {} return next; }
  try { const o = JSON.parse(fs.readFileSync(miroBoardsPath(), 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
// ---------- pasting a picture copied elsewhere (Mark, 2026-11-10) ----------
// Ctrl+V on the board with a picture copied in Chrome (Google Images), Discord or anywhere. The
// clipboard can hold the picture itself and a link to its file; the bigger of the two is kept (the
// linked file on a tie: its own format, and a GIF still moves). Saved in "Ozy Imports\Pasted" on
// the same drive as Miro imports (never C: unless that is all there is); the same picture pasted
// again is the same file, not a new copy (pasted-index.json, by its content's fingerprint).
const PasteImage = require('./lib/pasteimage');
const ImageSizeLib = require('./lib/imagesize');
const PASTE_MAX_BYTES = 150 * 1024 * 1024;
function clipboardNow() {
  const { clipboard } = require('electron');
  const html = clipboard.readHTML() || '';
  const text = clipboard.readText() || '';
  const img = clipboard.readImage();
  return { html, text, img, src: PasteImage.imgSrc(html), url: PasteImage.urlFromText(text) };
}
ipcMain.handle('clipboard-kind', () => {
  const c = clipboardNow();
  return { hasImage: !c.img.isEmpty(), src: !!c.src, url: !!c.url, text: c.text };
});
// a picture's width and height from its bytes, or null
function pictureSize(bytes) {
  const s = ImageSizeLib.fromBuffer(bytes);
  if (s && s.w > 0 && s.h > 0) return s;
  try { const ni = require('electron').nativeImage.createFromBuffer(bytes); if (!ni.isEmpty()) { const z = ni.getSize(); return { w: z.width, h: z.height }; } } catch {}
  return null;
}
// a picture from the web, as bytes (null when it is not a picture, too big, or does not come)
async function fetchPicture(url) {
  // (its own browser session: the windows' session only lets them reach Ozy's own few hosts, a rule
  // that stays as it is; this one fetches only the picture the user just pasted, and keeps nothing)
  const ses = session.fromPartition('ozy-paste-fetch');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await ses.fetch(url, { signal: ac.signal, headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } });
    if (!res.ok) { log('info', 'pasted link not fetched', { status: res.status, host: new URL(url).hostname }); return null; }
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    const ext = PasteImage.extFor(type, url);
    if (!type.startsWith('image/') && !ext) { log('info', 'pasted link is not a picture', { type, host: new URL(url).hostname }); return null; }
    if (Number(res.headers.get('content-length')) > PASTE_MAX_BYTES) { log('info', 'pasted picture too big', { host: new URL(url).hostname }); return null; }
    const chunks = []; let n = 0;
    for await (const ch of res.body) { n += ch.length; if (n > PASTE_MAX_BYTES) return null; chunks.push(Buffer.from(ch)); }
    const bytes = Buffer.concat(chunks);
    if (!type.startsWith('image/') && !pictureSize(bytes)) return null; // a page, not a picture
    return { bytes, type: type.startsWith('image/') ? type : '', ext: ext || '.jpg' };
  } catch (e) { log('info', 'pasted link not fetched', { error: String(e && e.message || e), host: (() => { try { return new URL(url).hostname; } catch { return ''; } })() }); return null; } finally { clearTimeout(timer); }
}
ipcMain.handle('paste-image', async () => {
  const c = clipboardNow();
  const cands = [];
  const link = c.src && /^https?:/i.test(c.src) ? c.src : c.url;
  if (link) {
    const got = await fetchPicture(link);
    if (got) { const z = pictureSize(got.bytes); cands.push({ kind: 'link', bytes: got.bytes, ext: got.ext, url: link, w: z ? z.w : 0, h: z ? z.h : 0 }); }
  }
  if (c.src && /^data:/i.test(c.src)) {
    const d = PasteImage.fromDataUrl(c.src);
    if (d) { const z = pictureSize(d.bytes); cands.push({ kind: 'data', bytes: d.bytes, ext: PasteImage.extFor(d.type, '') || '.png', w: z ? z.w : 0, h: z ? z.h : 0 }); }
  }
  if (!c.img.isEmpty()) { const z = c.img.getSize(); cands.push({ kind: 'bitmap', img: c.img, ext: '.png', w: z.width, h: z.height }); }
  log('info', 'paste: clipboard', { link: link ? new URL(link).hostname : null, data: !!(c.src && /^data:/i.test(c.src)), bitmap: !c.img.isEmpty(), got: cands.map((x) => `${x.kind} ${x.w}x${x.h}`) });
  const pick = PasteImage.best(cands);
  if (!pick) return link ? { notPicture: true, error: 'That link is not a picture (or the site would not hand it over).' } : { notPicture: true };
  const bytes = pick.bytes || pick.img.toPNG();
  // (OZY_PASTE_DIR: a scratch folder for testing, honoured only in a dev run)
  const dir = !app.isPackaged && process.env.OZY_PASTE_DIR ? process.env.OZY_PASTE_DIR : path.join(miroDefaultRoot(), 'Pasted');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { error: `Could not make ${dir}: ${e.message}` }; }
  // the same picture pasted again: the file it already is
  const sha = require('crypto').createHash('sha1').update(bytes).digest('hex');
  const indexPath = path.join(dir, 'pasted-index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) || {}; } catch {}
  const had = index[sha] && path.join(dir, index[sha]);
  let file = had && fs.existsSync(had) ? had : null;
  if (!file) {
    let name = PasteImage.fileName(pick.url || '', pick.ext);
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = name.replace(/(\.[a-z0-9]+)$/i, ` ${n}$1`);
    file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    index[sha] = name;
    try { fs.writeFileSync(indexPath, JSON.stringify(index, null, 1)); } catch {}
  }
  const others = cands.filter((x) => x !== pick && x.w).map((x) => `${x.kind} ${x.w}x${x.h}`);
  log('info', 'picture pasted', { from: pick.kind, w: pick.w, h: pick.h, file, alsoOffered: others, reused: file === had });
  return { path: file, w: pick.w, h: pick.h, from: pick.kind, reused: file === had };
});

let miroAbort = null;
ipcMain.handle('miro-defaults', () => ({ root: miroDefaultRoot(), hasToken: !!miroSavedToken() }));
ipcMain.handle('miro-pick-root', async (_e, from) => {
  const r = await dialog.showOpenDialog(win, { title: 'Where to put imported boards', defaultPath: from || undefined, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// ---- export (Mark, 2026-11-15) ----
// capture-rect: a part of the asking window (its own CSS pixels) as a PNG data URL.
// save-export: { kind: 'png' | 'pngs' | 'pdf', name, pages: [dataURL], names: [frame names] } saved
// where the user picks; a PDF has one page per picture, each page the picture's own size.
ipcMain.handle('capture-rect', async (e, rect) => {
  const r = rect || {};
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const img = await e.sender.capturePage({ x: n(r.x), y: n(r.y), width: Math.max(1, n(r.w)), height: Math.max(1, n(r.h)) });
  return img.toDataURL();
});
const pngBytes = (url) => Buffer.from(String(url || '').replace(/^data:image\/png;base64,/, ''), 'base64');
const safeFileName = (s) => String(s || 'Frame').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80) || 'Frame';
// (dev only, like OZY_PASTE_DIR: OZY_EXPORT_DIR answers every save dialog with a path in that folder)
const exportDevDir = () => (!app.isPackaged && process.env.OZY_EXPORT_DIR ? process.env.OZY_EXPORT_DIR : null);
ipcMain.handle('save-export', async (e, job = {}) => {
  const owner = BrowserWindow.fromWebContents(e.sender) || win;
  const dev = exportDevDir();
  if (dev) {
    const realSave = dialog.showSaveDialog, realOpen = dialog.showOpenDialog;
    dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: path.join(dev, path.basename(o.defaultPath || 'export')) });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dev] });
    try { return await saveExportJob(owner, job); } finally { dialog.showSaveDialog = realSave; dialog.showOpenDialog = realOpen; }
  }
  return saveExportJob(owner, job);
});
async function saveExportJob(owner, job) {
  const pages = Array.isArray(job.pages) ? job.pages.filter((p) => typeof p === 'string' && p.startsWith('data:image/png;base64,')) : [];
  if (!pages.length) return null;
  if (job.kind === 'png') {
    const r = await dialog.showSaveDialog(owner, { title: 'Save the picture', defaultPath: safeFileName(String(job.name || 'Ozy').replace(/\.png$/i, '')) + '.png', filters: [{ name: 'PNG picture', extensions: ['png'] }] });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, pngBytes(pages[0]));
    return r.filePath;
  }
  if (job.kind === 'pngs') {
    const r = await dialog.showOpenDialog(owner, { title: 'Folder for the frame pictures', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const names = Array.isArray(job.names) ? job.names : [];
    const used = new Set();
    for (const [i, p] of pages.entries()) {
      let base = `${String(i + 1).padStart(2, '0')} ${safeFileName(names[i] || 'Frame')}`, k = 2;
      while (used.has(base.toLowerCase())) base = `${base} (${k++})`;
      used.add(base.toLowerCase());
      await fs.promises.writeFile(path.join(r.filePaths[0], base + '.png'), pngBytes(p));
    }
    return r.filePaths[0];
  }
  if (job.kind === 'pdf') {
    const r = await dialog.showSaveDialog(owner, { title: 'Save the PDF', defaultPath: safeFileName(String(job.name || 'Ozy').replace(/\.pdf$/i, '')) + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    // the pictures in a page each, in a hidden window of its own, printed to PDF
    const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'ozy-pdf-'));
    const { nativeImage } = require('electron');
    try {
      // (one page size for all, the largest picture's: Chromium ignores a size per page) each picture
      // centred on a page of its own
      let W = 1, H = 1, body = '';
      for (const [i, p] of pages.entries()) {
        const bytes = pngBytes(p);
        await fs.promises.writeFile(path.join(dir, `${i}.png`), bytes);
        const sz = nativeImage.createFromBuffer(bytes).getSize();
        W = Math.max(W, sz.width); H = Math.max(H, sz.height);
        body += `<div class="pg"><img src="${i}.png"></div>`;
      }
      const css = `@page { size: ${W}px ${H}px; margin: 0 } html, body { margin: 0; padding: 0; background: #fff }
        .pg { width: ${W}px; height: ${H}px; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page; }
        .pg:last-child { break-after: auto } .pg img { max-width: 100%; max-height: 100%; display: block }`;
      await fs.promises.writeFile(path.join(dir, 'pages.html'), `<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`);
      const pw = new BrowserWindow({ show: false, webPreferences: { partition: 'ozy-export', javascript: false, sandbox: true } });
      try {
        await pw.loadFile(path.join(dir, 'pages.html'));
        const pdf = await pw.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { marginType: 'none' } });
        await fs.promises.writeFile(r.filePath, pdf);
      } finally { pw.destroy(); }
      return r.filePath;
    } finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }
  return null;
}
ipcMain.handle('miro-forget-token', () => { try { fs.unlinkSync(miroTokenPath()); } catch {} return true; });
ipcMain.handle('miro-cancel', () => { if (miroAbort) miroAbort.abort(); return true; });
ipcMain.handle('miro-import', async (e, opts = {}) => {
  if (miroAbort) return { error: 'An import is already running.' };
  const typed = String(opts.token || '').trim();
  const token = typed || miroSavedToken();
  const root = String(opts.root || '') || miroDefaultRoot();
  miroAbort = new AbortController();
  const send = (p) => { try { if (!e.sender.isDestroyed()) e.sender.send('miro-progress', p); } catch {} };
  try {
    // (OZY_MIRO_API: a pretend Miro for testing, honoured only in a dev run, never in the installed app)
    const apiBase = !app.isPackaged && process.env.OZY_MIRO_API ? process.env.OZY_MIRO_API : undefined;
    const imp = MiroImport.createImporter({ log: (level, msg, data) => log(level, msg, data), ...(apiBase ? { apiBase } : {}) });
    // Miro's own crops: what the user copied in Miro (Ctrl+A, Ctrl+C on the board) is on the
    // clipboard, with every picture's crop in it (lib/miroclip.js). Read only, never changed.
    let miroCopy = null;
    try {
      const decoded = MiroClip.decode(require('electron').clipboard.readHTML());
      if (decoded) miroCopy = MiroClip.info(decoded); // crops, layer order, text heights and styles, frames
      log('info', 'miro copy on the clipboard', decoded ? { board: decoded.boardId, objects: decoded.objects.length, pictureCrops: miroCopy.crops.size } : { none: true });
    } catch (e) { log('warn', 'miro copy could not be read', { error: String(e && e.message || e) }); }
    const r = await imp.run({ boardUrl: opts.boardUrl, token, root, onProgress: send, signal: miroAbort.signal, boardDir: (id) => miroBoards()[id] || null, miroCopy,
      rememberDir: (id, dir) => miroBoards({ ...miroBoards(), [id]: dir }) }); // next time this board continues in the same folder
    if (typed && opts.remember) miroSaveToken(typed);
    return { sessionPath: r.sessionPath, dir: r.dir, summary: r.summary, failed: r.failed, items: r.items };
  } catch (err) {
    const msg = err instanceof MiroImport.ImportError ? err.message : `The import stopped: ${err && err.message ? err.message : err}`;
    log('warn', 'miro import failed', { error: msg });
    return { error: msg };
  } finally { miroAbort = null; }
});

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
ipcMain.handle('list-folder', async (_e, dir) => {
  // a folder source can live on a share that has gone away since it was added
  const entries = await guardedReaddir(dir, { withFileTypes: true });
  if (!entries) return { ok: false, files: [], sequences: [] };
  const names = entries.filter((d) => d.isFile()).map((d) => d.name);
  // Spotting sequences is a convenience; listing the folder is not. If detection ever throws on
  // some filename nobody thought of, the folder still lists its plain files.
  let sequences = [], members = new Set();
  try { ({ sequences, members } = readSequences(dir, names)); }
  catch (err) { logError('sequence detect failed', err, { dir, files: names.length }); sequences = []; members = new Set(); }
  const files = [];
  for (const n of Sources.filterMedia(names, { images: true })) {
    if (members.has(n)) continue;
    const p = path.join(dir, n);
    const st = await guardedStat(p); // the folder answered, so these are quick; the guard is for a share dying mid-listing
    if (st) files.push({ path: p, name: n, size: st.size, mtimeMs: st.mtimeMs, kind: Sources.kindOf(n) });
  }
  return { ok: true, files, sequences };
});

// Local-file thumbnails: one JPEG per file (same hash as proxies) from 10 % in,
// made lazily as sidebar rows scroll into view, at most two ffmpeg jobs at once.
let thumbRunning = 0; const thumbWaiting = [];
function nextThumb() { if (thumbRunning < 2 && thumbWaiting.length) thumbWaiting.shift()(); }
ipcMain.handle('thumb', (_e, filePath) => new Promise((resolve) => {
  const job = async () => {
    thumbRunning++;
    const done = (v) => { thumbRunning--; resolve(v); nextThumb(); };
    const stat = await guardedStat(filePath);
    if (!stat) return done(null);
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
// The block at the top of every run (and of every diagnostics paste). Answers "what was running?"
function startupHeader() {
  let ytdlp = false;
  try { ytdlp = fs.existsSync(binPath('yt-dlp')); } catch {}
  let hasQjs = false;
  try { hasQjs = !!qjs(); } catch {} // YouTube needs it; the header is where you look first
  return LogFmt.header({
    version: (() => { try { return require('./package.json').buildVersion || app.getVersion(); } catch { return null; } })(),
    build: !app.isPackaged ? 'dev' : isPortable() ? 'portable' : 'installed',
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userData: app.getPath('userData'),
    logs: logsDir(),
    tools: { ffmpeg: checkTools(), ffprobe: checkTools(), 'yt-dlp': ytdlp, qjs: hasQjs },
    settings: readSettings(),
  });
}
const canAutoUpdate = () => process.platform === 'win32' && app.isPackaged && !isPortable();
const appVersion = () => require('./package.json').buildVersion || app.getVersion();
let updater = null, updateReady = false;
// A local test build is versioned like 0.2.16-local.29. With pre-releases allowed, electron-updater
// reads that "-local" as a release channel and accepts only release tags on the same channel. Our
// tags (v0.3.0.0) never are one, so every check failed with "No published versions on GitHub" and
// the local build never saw 0.3 (Mark, 2026-11-19). A build like that looks at the newest full
// release instead. Release builds (0.3.0, from the tag) have no "-" part and are unaffected.
const allowPrerelease = (s) => s.updates.includePrerelease && !app.getVersion().includes('-');
// electron-updater's raw errors are not for reading: app-update.yml is missing in a build that
// wasn't produced by an installer, and a network failure shouldn't look like a bug in the app.
function updateErrorText(err) {
  const raw = String((err && err.message) || err || '');
  if (/app-update\.yml|ENOENT/i.test(raw)) return 'This build cannot update itself; download the new version instead';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo/i.test(raw)) return 'Could not reach GitHub to check for updates';
  return raw.split('\n')[0].slice(0, 160);
}
const toWin = (msg) => { if (win && !win.webContents.isDestroyed()) win.webContents.send('update-event', msg); };

function getUpdater() {
  if (!canAutoUpdate()) return null;
  if (!updater) {
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
      updater.logger = elog; // electron-updater's own diagnostics land in the same file
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = allowPrerelease(readSettings());
      updater.on('update-available', (info) => { log('info', 'update available', { version: info.version }); toWin({ kind: 'available', version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 500) : '' }); });
      updater.on('update-not-available', () => { log('info', 'update: already newest', { version: appVersion() }); toWin({ kind: 'none', version: appVersion() }); });
      updater.on('download-progress', (p) => toWin({ kind: 'progress', percent: Math.round(p.percent) }));
      updater.on('update-downloaded', (info) => { updateReady = true; log('info', 'update downloaded, ready to install', { version: info.version }); toWin({ kind: 'ready', version: info.version }); });
      updater.on('error', (err) => { logError('update', err); toWin({ kind: 'error', message: String(err && err.message || err).slice(0, 200) }); });
    } catch (e) { logError('electron-updater could not start', e); updater = null; }
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
  up.allowPrerelease = allowPrerelease(s);
  try { await up.checkForUpdates(); return { ok: true }; }
  catch (e) { const msg = updateErrorText(e); if (manual) toWin({ kind: 'error', message: msg }); return { ok: false, error: msg }; }
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

// ---- bookmark blocks (Mark, 2026-11-16) ----
// A link in a bookmark block opens in the default browser (http / https only). A link pasted into
// one is looked up for its page title, site name and icon. The lookup runs in its own in-memory
// session, apart from the window's: the window's network allowlist above stays as it is, and the
// sites see no cookies. At most ~1 MB of the page is read (its <head> is enough) and a 64 KB icon.
const LinkTable = require('./lib/linktable');
ipcMain.handle('open-link', (_e, url) => {
  const u = LinkTable.cleanUrl(url);
  if (!u) return false;
  require('electron').shell.openExternal(u);
  return true;
});
let linkSession = null;
const linkSes = () => linkSession || (linkSession = session.fromPartition('ozy-link-info'));
async function linkFetch(url, ms, accept) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return { res: await linkSes().fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { Accept: accept, 'Accept-Language': 'en-US,en;q=0.8' } }), ctl, timer }; }
  catch (e) { clearTimeout(timer); throw e; }
}
// the body up to `cap` bytes (stopping early once `until` shows up in the text), then let go of the rest
async function readCapped(res, cap, until) {
  const reader = res.body && res.body.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts = []; let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value)); n += value.length;
      if (n >= cap) break;
      if (until && Buffer.from(value).toString('latin1').toLowerCase().includes(until)) break;
    }
  } finally { try { await reader.cancel(); } catch {} }
  return Buffer.concat(parts).subarray(0, cap);
}
async function linkIcon(url) {
  if (!url) return '';
  let f;
  try {
    f = await linkFetch(url, 6000, 'image/*');
    const type = (f.res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!f.res.ok || !/^image\/[a-z0-9.+-]+$/.test(type)) return '';
    const buf = await readCapped(f.res, 64 * 1024 + 1);
    if (!buf.length || buf.length > 64 * 1024) return '';
    return `data:${type === 'image/vnd.microsoft.icon' ? 'image/x-icon' : type};base64,${buf.toString('base64')}`;
  } catch { return ''; }
  finally { if (f) clearTimeout(f.timer); }
}
ipcMain.handle('link-info', async (_e, raw) => {
  const url = LinkTable.cleanUrl(raw);
  if (!url) return { ok: false };
  let title = '', site = '', page = url, iconHref = '';
  // YouTube's page can be a cookie-consent page; its oEmbed answer is the video's own title
  if (LinkTable.isYouTube(url)) {
    let f;
    try {
      f = await linkFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, 6000, 'application/json');
      if (f.res.ok) { const j = JSON.parse((await readCapped(f.res, 64 * 1024)).toString('utf8')); title = String(j.title || ''); site = 'YouTube'; }
    } catch {} finally { if (f) clearTimeout(f.timer); }
  }
  if (!title) {
    let f;
    try {
      f = await linkFetch(url, 9000, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
      page = f.res.url || url;
      const type = (f.res.headers.get('content-type') || '').toLowerCase();
      if (!f.res.ok) { try { await f.res.body.cancel(); } catch {} } // an error or a bot check: its title is not the page's
      else if (/html|xml/.test(type)) {
        const buf = await readCapped(f.res, 1024 * 1024, '</head>');
        const cs = (/charset=([\w-]+)/.exec(type) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.toString('latin1')) || [])[1];
        let text;
        try { text = new TextDecoder(cs || 'utf-8').decode(buf); } catch { text = buf.toString('utf8'); }
        const h = LinkTable.parseHead(text, page);
        title = h.title; site = site || h.site; iconHref = h.icon;
      } else {
        try { await f.res.body.cancel(); } catch {}
        // a picture or a PDF: its file name is its name
        const last = decodeURIComponent((new URL(page).pathname.split('/').filter(Boolean).pop()) || '');
        title = last;
      }
    } catch (e) {
      if (!site) return { ok: false, error: String(e && e.message || e).slice(0, 160) };
    } finally { if (f) clearTimeout(f.timer); }
  }
  const icon = await linkIcon(LinkTable.iconUrl(iconHref, page));
  return { ok: true, title, site, icon, url: page };
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
ipcMain.handle('sequence-for', async (_e, filePath) => {
  const dir = path.dirname(filePath), name = path.basename(filePath);
  const names = await guardedReaddir(dir);
  if (!names) return null;
  return readSequences(dir, names).sequences.find((s) => Sequence.sameRun(s, name)) || null;
});
// First frame's mtime (part of the cache key) and picture size.
ipcMain.handle('seq-info', async (_e, dir, seq) => {
  const first = path.join(dir, Sequence.framePath(seq, seq.start));
  const firstStat = await guardedStat(first);
  if (!firstStat) return { ok: false };
  const firstMtime = firstStat.mtimeMs;
  const size = !checkTools() ? {} : await new Promise((resolve) => {
    execFile(binPath('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', first], { windowsHide: true }, (err, out) => {
      if (err) logTool('ffprobe (sequence size)', ['-show_entries', 'stream=width,height', first], err, '');
      try { const s = JSON.parse(out).streams[0]; resolve({ width: s.width, height: s.height }); } catch { resolve({}); }
    });
  });
  return { ok: true, firstMtime, ...size };
});
// The parts / layers of an EXR frame, from the first 64 KB of it (headers live at the front).
ipcMain.handle('exr-layers', async (_e, filePath) => {
  const head = await guardedReadHead(filePath, 65536);
  return head ? ExrHeader.parse(new Uint8Array(head)) : null;
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
// Without the runtime yt-dlp fails on YouTube in ways that read like a yt-dlp bug, so say what is
// actually wrong rather than letting somebody debug the wrong thing for an hour.
// Only when the binary really is absent AND the failure looks like its absence, so a private or
// deleted video is not reported as a missing runtime.
const missingRuntimePrefix = (stderr) => (!qjs() && WebStream.runtimeLikely(stderr) ? 'YouTube needs the bundled JavaScript runtime (qjs), which is missing. ' : '');
const resolved = new Map(); // url -> { url, height, title, resolvedAt }
ipcMain.handle('resolve-stream', (_e, pageUrl) => new Promise((resolve) => {
  const key = String(pageUrl);
  const hit = resolved.get(key);
  if (hit && !WebStream.isExpired(hit.resolvedAt)) return resolve({ ok: true, ...hit });
  if (!fs.existsSync(binPath('yt-dlp'))) return resolve({ ok: false, error: 'yt-dlp not found' });
  // Which YouTube player client yields real formats changes over time, so try them in turn.
  const clients = String(key).includes('youtube') || String(key).includes('youtu.be') ? WebStream.CLIENTS : [''];
  let lastErr = '', lastStderr = '', outdated = false;
  const attempt = (i) => {
    if (i >= clients.length) return resolve({ ok: false, error: missingRuntimePrefix(lastStderr) + (lastErr || 'Could not resolve this video'), outdated });
    const args = WebStream.resolveArgs(key, clients[i], { qjs: qjs() });
    execFile(binPath('yt-dlp'), args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
    if (err) logTool(`yt-dlp resolve (${clients[i]})`, args, err, stderr);
      const info = WebStream.parseResolved(stdout);
      if (!info) {
        lastErr = String(stderr || (err && err.message) || '').trim().split('\n').slice(-1)[0] || lastErr;
        lastStderr += String(stderr || ''); // every client's complaint, for runtimeLikely
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
    const args = WebStream.downloadArgs(pageUrl, tmp, binDir, clients[ci], { qjs: qjs() });
    const child = spawn(binPath('yt-dlp'), args, { windowsHide: true });
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
      if (code !== 0 && code !== null) logTool(`yt-dlp download (${clients[ci]})`, args, new Error('exit ' + code), tail);
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
        reject(new Error(code === null ? 'Cancelled' : missingRuntimePrefix(tail) + 'yt-dlp failed:\n' + tail.trim().split('\n').slice(-3).join('\n')));
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
  const args = ['--flat-playlist', '-J', ...WebStream.runtimeArgs(qjs()), String(url)];
  execFile(binPath('yt-dlp'), args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      logTool('yt-dlp playlist', args, err, stderr);
      return resolve({ ok: false, error: missingRuntimePrefix(stderr) + String(stderr || err.message).trim().split('\n').slice(-2).join('\n'), outdated: Playlist.isOutdatedError(stderr) });
    }
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
