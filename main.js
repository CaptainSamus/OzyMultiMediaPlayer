// Multi Video Player - main process.
// Entirely local: no remote content is ever loaded, and every http/https/ws
// request is cancelled at the network layer as a hard guarantee.

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
};

// Where ffmpeg.exe / ffprobe.exe live: bundled next to the app when packaged,
// straight out of node_modules in development.
function binPath(name) {
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

  win.loadFile('index.html');

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
  app.whenReady().then(() => {
    protocol.handle('localvideo', handleVideoRequest);

    // Hard block on any outbound network request from the renderer.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );

    createWindow();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- IPC ----

const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'ogg', 'avi', 'mp3', 'wav', 'm4a', 'flac'];

ipcMain.handle('pick-videos', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add videos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video / audio', extensions: VIDEO_EXTS },
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
