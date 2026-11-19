// The media server: a separate background process (Electron utilityProcess) that hands every video,
// picture and cached frame to the windows over a loopback-only HTTP server.
//
// Why (2026-11-05): before this, every byte of every playing video was read and passed on by the
// main process, the same one that runs the windows' file checks, IPC and menus. With a big board
// that process was busy enough that a simple "is this file there?" queued for seconds. Now the
// windows' video players talk straight to this process; the main process only hears about it.
//
// It also reads in 1 MB pieces instead of Node's default 64 KB. A spinning disk (Mark's footage is
// on a USB hard drive) serving many videos at once spends its time moving the head between files;
// bigger pieces mean far fewer moves for the same data.
//
// Nothing outside this machine can reach it (127.0.0.1 only), and nothing on it can ask for a file
// without the random token main hands the windows. Messages with main (process.parentPort):
//   in:  { type: 'init', port, token, uiOrigin }   { type: 'network-drives', list }   { type: 'forget' }
//   out: { type: 'ready', port }   { type: 'served-proxy', path }   { type: 'recovered' }   { type: 'log', level, msg, data }
const http = require('http');
const fs = require('fs');
const path = require('path');
const MediaHttp = require('./mediahttp');
const FsGuard = require('./fsguard');

const READ_CHUNK = 1024 * 1024;
const port = process.parentPort;
const send = (m) => { try { port.postMessage(m); } catch {} };
const log = (level, msg, data) => send({ type: 'log', level, msg, data });

const guard = FsGuard.create({ onRevive: () => send({ type: 'recovered' }), log });
let token = '';
let uiOrigin = '';
const lastProxyNote = new Map(); // path -> when main was last told (once every 10 s is plenty)

function handle(req, res) {
  const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': uiOrigin, 'Vary': 'Origin' };
  const fail = (status) => { res.writeHead(status, headers); res.end(); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405);
  let filePath;
  try { filePath = MediaHttp.pathFromUrl(new URL(req.url, 'http://127.0.0.1').pathname, token); } catch { filePath = null; }
  if (!filePath) return fail(404);
  if (MediaHttp.PROXY_FILE.test(filePath)) {
    const k = path.normalize(filePath).toLowerCase(), now = Date.now();
    if (now - (lastProxyNote.get(k) || 0) > 10000) { lastProxyNote.set(k, now); send({ type: 'served-proxy', path: filePath }); }
  }
  guard.run(filePath, () => fs.promises.stat(filePath), null).then((stat) => {
    if (!stat || !stat.isFile()) return fail(404);
    const size = stat.size;
    Object.assign(headers, { 'Content-Type': MediaHttp.typeOf(path.extname(filePath)), 'Accept-Ranges': 'bytes' });
    if (size === 0) { res.writeHead(200, { ...headers, 'Content-Length': '0' }); return res.end(); }
    const r = MediaHttp.range(req.headers.range, size);
    if (r.status === 416) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); return res.end(); }
    headers['Content-Length'] = String(r.end - r.start + 1);
    if (r.status === 206) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`;
    res.writeHead(r.status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start: r.start, end: r.end, highWaterMark: READ_CHUNK });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy()); // the player jumped elsewhere or the tile went away
    stream.pipe(res);
  }).catch(() => { if (!res.headersSent) fail(500); else res.destroy(); });
}

const server = http.createServer(handle);
server.keepAliveTimeout = 30000;
server.on('error', (e) => { log('error', 'media server failed', { error: String(e && e.message) }); send({ type: 'failed', error: String(e && e.message) }); });

port.on('message', (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    token = String(m.token || ''); uiOrigin = String(m.uiOrigin || '');
    // the same port as last time if main asks for one (a restart keeps the windows' URLs working)
    server.listen(Number(m.port) || 0, '127.0.0.1', () => send({ type: 'ready', port: server.address().port }));
  } else if (m.type === 'network-drives') {
    for (const d of m.list || []) guard.networkDrives.add(d);
  } else if (m.type === 'forget') {
    guard.forget();
  }
});
