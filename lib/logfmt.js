// How log lines are written, and what goes in the diagnostics blob. Pure and tested: the logger
// itself (electron-log, files, rotation) lives in main.js, but every decision about what a line
// looks like is here so it can be checked without launching the app.
//
// Nothing is redacted — paths and URLs are what make a log useful for Mark, and file contents are
// never logged in the first place. What this does guarantee is a stable shape: one line per event,
// a fixed-width level, a sortable timestamp, and structured data as compact JSON at the end.
const LogFmt = {
  LEVELS: ['error', 'warn', 'info', 'debug'],
  MAX_DATA: 1000,      // a single line's data blob; long stacks are kept separately
  TAIL_LINES: 300,     // what "Copy diagnostics" pastes

  // 2026-09-17 00:24:14.123 — local time, sortable, no timezone noise. Logs are read by one person
  // on one machine, so local beats UTC here.
  stamp(d = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  },

  level(raw) {
    const s = String(raw || '').toLowerCase();
    return LogFmt.LEVELS.includes(s) ? s : 'info';
  },

  // Anything can be handed to a logger: Errors, objects with circular references, undefined.
  // None of it may throw, and none of it may run away in size.
  data(value, max = LogFmt.MAX_DATA) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'object') return String(value).slice(0, max);
    let text;
    try {
      const seen = new WeakSet();
      text = JSON.stringify(value, (_k, v) => {
        if (v instanceof Error) return { message: v.message, code: v.code };
        if (typeof v === 'bigint') return String(v);
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      });
    } catch { text = null; }
    if (text === undefined || text === null) return '[unserialisable]';
    return text.length > max ? text.slice(0, max) + '…' : text;
  },

  // "2026-09-17 00:24:14.123 ERROR [main] session load failed {"path":"X:\\a.mvp"}"
  line({ level, scope = 'main', msg, data, at } = {}) {
    const lvl = LogFmt.level(level).toUpperCase().padEnd(5);
    const body = String(msg === undefined || msg === null ? '' : msg).replace(/\s*\n\s*/g, ' ⏎ ');
    const extra = LogFmt.data(data);
    return `${LogFmt.stamp(at instanceof Date ? at : new Date())} ${lvl} [${scope}] ${body}${extra ? ' ' + extra : ''}`;
  },

  // An error worth a log line: the message, then the stack on following lines so it stays readable.
  errorLine({ scope = 'main', msg, err, data, at } = {}) {
    const e = err || {};
    // A thrown non-Error is the case a logger most has to survive: a bare object has no .message
    // and stringifies to "[object Object]", which tells Mark nothing.
    const raw = e.message !== undefined && e.message !== null && e.message !== '' ? e.message
      : (typeof e === 'object' ? LogFmt.data(e) : e);
    const message = String(raw === '' || raw === '{}' || raw === undefined || raw === null ? 'unknown error' : raw);
    const head = LogFmt.line({ level: 'error', scope, msg: msg ? `${msg}: ${message}` : message, data, at });
    const stack = typeof e.stack === 'string' ? e.stack.split('\n').slice(1, 12).map((l) => '    ' + l.trim()) : [];
    return [head, ...stack].join('\n');
  },

  // The block at the top of every run, and the first thing in "Copy diagnostics". Mark pastes this
  // into a message, so it has to answer "what was running?" on its own.
  header(info = {}) {
    const row = (k, v) => `  ${String(k).padEnd(11)} ${v === undefined || v === null || v === '' ? '(unknown)' : v}`;
    const tools = info.tools && typeof info.tools === 'object'
      ? Object.keys(info.tools).map((k) => `${k} ${info.tools[k] ? 'ok' : 'MISSING'}`).join(', ')
      : '(not checked)';
    return [
      '--- Ozy Multi Media Player ---',
      row('version', info.version),
      row('build', info.build),           // installed / portable / dev
      row('platform', [info.platform, info.arch].filter(Boolean).join(' ')),
      row('electron', [info.electron && 'Electron ' + info.electron, info.chrome && 'Chromium ' + info.chrome].filter(Boolean).join(', ')),
      row('userData', info.userData),
      row('logs', info.logs),
      row('tools', tools),
      row('settings', LogFmt.settingsSummary(info.settings)),
      row('started', LogFmt.stamp(info.at instanceof Date ? info.at : new Date())),
    ].join('\n');
  },

  // One readable line, not a dump of settings.json (which holds folder lists and playlists).
  settingsSummary(s) {
    if (!s || typeof s !== 'object') return '(defaults)';
    const up = s.updates || {};
    const sb = s.sidebar || {};
    const src = s.sources || {};
    return [
      `auto-update ${up.auto === false ? 'off' : 'on'}`,
      `prereleases ${up.includePrerelease === false ? 'off' : 'on'}`,
      `wheel-zoom ${s.wheelZoom ? 'on' : 'off'}`,
      `sidebar ${sb.open ? 'open' : 'closed'}/${sb.tab || 'local'}`,
      `${(Array.isArray(src.folders) ? src.folders : []).length} folders`,
      `${(Array.isArray(src.playlists) ? src.playlists : []).length} playlists`,
    ].join(', ');
  },

  // What's on the board right now, for the diagnostics paste. Counts and paths, never contents.
  sessionSummary({ path, tiles, groups, mode } = {}) {
    const list = Array.isArray(tiles) ? tiles : [];
    const byType = {};
    for (const t of list) { const k = (t && t.type) || 'file'; byType[k] = (byType[k] || 0) + 1; }
    const kinds = Object.keys(byType).sort().map((k) => `${byType[k]} ${k}`).join(', ') || 'none';
    return [
      '--- session ---',
      `  file        ${path || '(unsaved)'}`,
      `  mode        ${mode || '(unknown)'}`,
      `  tiles       ${list.length}${list.length ? ' (' + kinds + ')' : ''}`,
      `  groups      ${Array.isArray(groups) ? groups.length : 0}`,
    ].join('\n');
  },

  // The last N lines of a log file, oldest first. Handles CRLF and a missing trailing newline.
  tail(text, n = LogFmt.TAIL_LINES) {
    const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(Math.max(0, lines.length - Math.max(0, n)));
  },

  // header + session + tail, in the order Mark would want to read them.
  diagnostics({ header, session, log } = {}) {
    return [header || '', session || '', '--- log (last ' + LogFmt.tail(log).length + ' lines) ---', LogFmt.tail(log).join('\n')]
      .filter((s) => s !== '').join('\n\n');
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = LogFmt;
else window.LogFmt = LogFmt;
