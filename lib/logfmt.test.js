const test = require('node:test');
const assert = require('node:assert/strict');
const LogFmt = require('./logfmt');

const AT = new Date(2026, 8, 17, 0, 24, 14, 123); // 2026-09-17 00:24:14.123 local

test('stamp is sortable, zero-padded local time', () => {
  assert.equal(LogFmt.stamp(AT), '2026-09-17 00:24:14.123');
  assert.equal(LogFmt.stamp(new Date(2026, 0, 2, 3, 4, 5, 6)), '2026-01-02 03:04:05.006');
  // string sort must match time order, or the log is unreadable
  const a = LogFmt.stamp(new Date(2026, 8, 17, 9, 59, 59, 999));
  const b = LogFmt.stamp(new Date(2026, 8, 17, 10, 0, 0, 0));
  assert.ok(a < b, `${a} < ${b}`);
});

test('line: fixed-width level, scope, message, compact data', () => {
  assert.equal(
    LogFmt.line({ level: 'error', scope: 'main', msg: 'session load failed', data: { path: 'X:\\a.mvp' }, at: AT }),
    '2026-09-17 00:24:14.123 ERROR [main] session load failed {"path":"X:\\\\a.mvp"}',
  );
  assert.equal(LogFmt.line({ level: 'info', scope: 'ui', msg: 'ready', at: AT }),
    '2026-09-17 00:24:14.123 INFO  [ui] ready');
});

test('line: one event is always one line', () => {
  const l = LogFmt.line({ msg: 'two\nlines\r\nhere', at: AT });
  assert.equal(l.includes('\n'), false);
  assert.match(l, /two ⏎ lines ⏎ here/);
});

test('level falls back to info for junk, never throws', () => {
  assert.equal(LogFmt.level('WARN'), 'warn');
  assert.equal(LogFmt.level('verbose'), 'info');
  assert.equal(LogFmt.level(undefined), 'info');
  assert.equal(LogFmt.level(null), 'info');
  assert.equal(LogFmt.level(7), 'info');
});

test('data survives anything a caller might pass', () => {
  assert.equal(LogFmt.data(undefined), '');
  assert.equal(LogFmt.data(null), '');
  assert.equal(LogFmt.data('plain'), 'plain');
  assert.equal(LogFmt.data(42), '42');
  assert.equal(LogFmt.data({ a: 1 }), '{"a":1}');
  const circular = { name: 'tile' }; circular.self = circular;
  assert.equal(LogFmt.data(circular), '{"name":"tile","self":"[circular]"}');
  const err = Object.assign(new Error('boom'), { code: 'ENOENT' });
  assert.equal(LogFmt.data({ err }), '{"err":{"message":"boom","code":"ENOENT"}}');
  assert.equal(LogFmt.data({ big: 1n }), '{"big":"1"}');
});

test('data is capped so one call cannot flood the file', () => {
  const long = LogFmt.data({ s: 'x'.repeat(5000) });
  assert.ok(long.length <= LogFmt.MAX_DATA + 1, long.length);
  assert.ok(long.endsWith('…'));
  assert.equal(LogFmt.data('y'.repeat(50), 10), 'yyyyyyyyyy');
});

test('errorLine keeps the message on line one and indents the stack', () => {
  const err = new Error('could not read');
  err.stack = 'Error: could not read\n    at one (main.js:1:1)\n    at two (main.js:2:2)';
  const out = LogFmt.errorLine({ scope: 'main', msg: 'load-session', err, data: { path: 'X:\\a.mvp' }, at: AT });
  const lines = out.split('\n');
  assert.equal(lines[0], '2026-09-17 00:24:14.123 ERROR [main] load-session: could not read {"path":"X:\\\\a.mvp"}');
  assert.deepEqual(lines.slice(1), ['    at one (main.js:1:1)', '    at two (main.js:2:2)']);
});

test('errorLine handles a thrown non-Error and a missing stack', () => {
  assert.match(LogFmt.errorLine({ err: 'just a string', at: AT }), /ERROR \[main\] just a string$/);
  // a thrown bare object must not land in the log as "[object Object]"
  assert.match(LogFmt.errorLine({ err: {}, at: AT }), /unknown error$/);
  assert.match(LogFmt.errorLine({ err: { code: 'EBUSY' }, at: AT }), /\{"code":"EBUSY"\}$/);
  assert.equal(LogFmt.errorLine({ err: new Error('x'), at: AT }).split('\n').length <= 12, true);
});

test('header answers "what was running?" on its own', () => {
  const h = LogFmt.header({
    version: '0.2.0.7', build: 'portable', platform: 'win32', arch: 'x64',
    electron: '33.4.11', chrome: '130.0.0.0',
    userData: 'C:\\Users\\Mark\\AppData\\Roaming\\ozy-multi-media-player',
    logs: 'C:\\Users\\Mark\\AppData\\Roaming\\ozy-multi-media-player\\logs',
    tools: { ffmpeg: true, ffprobe: true, 'yt-dlp': false },
    settings: { updates: { auto: false, includePrerelease: true }, wheelZoom: true, sidebar: { open: true, tab: 'web' }, sources: { folders: [1, 2], playlists: [] } },
    at: AT,
  });
  assert.match(h, /^--- Ozy Multi Media Player ---$/m);
  assert.match(h, /version *0\.2\.0\.7/);
  assert.match(h, /build *portable/);
  assert.match(h, /platform *win32 x64/);
  assert.match(h, /Electron 33\.4\.11, Chromium 130\.0\.0\.0/);
  assert.match(h, /yt-dlp MISSING/);       // the whole point of logging tools
  assert.match(h, /ffmpeg ok, ffprobe ok/);
  assert.match(h, /auto-update off/);
  assert.match(h, /2 folders/);
  assert.match(h, /started *2026-09-17 00:24:14\.123/);
});

test('header says so instead of lying when it knows nothing', () => {
  const h = LogFmt.header({ at: AT });
  assert.match(h, /version *\(unknown\)/);
  assert.match(h, /tools *\(not checked\)/);
  assert.match(h, /settings *\(defaults\)/);
});

test('settingsSummary is a summary, not a dump of folder paths', () => {
  const s = LogFmt.settingsSummary({ sources: { folders: [{ path: 'X:\\secret' }], playlists: [{ url: 'u' }] }, updates: {}, sidebar: {} });
  assert.match(s, /1 folders, 1 playlists/);
  assert.equal(s.includes('secret'), false);
  assert.equal(LogFmt.settingsSummary(null), '(defaults)');
});

test('sessionSummary counts tiles by type', () => {
  const s = LogFmt.sessionSummary({
    path: 'C:\\shots\\a.mvp', mode: 'board',
    tiles: [{ type: 'file' }, { type: 'file' }, { type: 'sequence' }, { type: 'youtube' }],
    groups: [{}],
  });
  assert.match(s, /file *C:\\shots\\a\.mvp/);
  assert.match(s, /mode *board/);
  assert.match(s, /tiles *4 \(2 file, 1 sequence, 1 youtube\)/);
  assert.match(s, /1 sequence/);
  assert.match(s, /groups *1/);
  assert.match(LogFmt.sessionSummary({}), /file *\(unsaved\)/);
  assert.match(LogFmt.sessionSummary({}), /tiles *0/);
});

test('tail takes the last N lines, oldest first, ignoring line endings', () => {
  const text = ['a', 'b', 'c', 'd'].join('\r\n') + '\r\n';
  assert.deepEqual(LogFmt.tail(text, 2), ['c', 'd']);
  assert.deepEqual(LogFmt.tail(text, 99), ['a', 'b', 'c', 'd']);
  assert.deepEqual(LogFmt.tail('', 5), []);
  assert.deepEqual(LogFmt.tail(null, 5), []);
  assert.deepEqual(LogFmt.tail('only', 5), ['only']);
  assert.equal(LogFmt.TAIL_LINES, 300);
});

test('diagnostics puts the header first and the log last', () => {
  const out = LogFmt.diagnostics({
    header: LogFmt.header({ version: '0.2.0.7', at: AT }),
    session: LogFmt.sessionSummary({ tiles: [{ type: 'file' }] }),
    log: 'line one\nline two\n',
  });
  const iHeader = out.indexOf('--- Ozy Multi Media Player ---');
  const iSession = out.indexOf('--- session ---');
  const iLog = out.indexOf('--- log (last 2 lines) ---');
  assert.ok(iHeader === 0 && iHeader < iSession && iSession < iLog, out);
  assert.ok(out.trimEnd().endsWith('line two'));
});

test('diagnostics still produces something when a part is missing', () => {
  const out = LogFmt.diagnostics({});
  assert.match(out, /--- log \(last 0 lines\) ---/);
  assert.doesNotThrow(() => LogFmt.diagnostics());
});
