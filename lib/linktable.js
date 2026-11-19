// Bookmark blocks (Mark, 2026-11-16): a list of links on the board, laid out like a small
// spreadsheet (Name, Site, Notes, Added). Paste links into it; each one's page title and icon are
// looked up (main.js 'link-info', which uses parseHead below) and fill in the row. A block is a
// text tile with tile.links = { title, rows }; this file is its rules: cleaning pasted links,
// reading a page's <head>, the rows themselves, sorting, the dates, and the plain-text summary an
// older Ozy shows in its place.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LinkTable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_TITLE = 'Bookmarks';
  const MAX_ROWS = 1000;
  const MAX_ICON = 90000; // characters of a data: URL (about 64 KB of picture)
  const COLUMNS = [['tier', 'Tier'], ['name', 'Name'], ['site', 'Site'], ['note', 'Notes'], ['added', 'Added']];
  // Tiers (2026-11-17): how good a link is. S the best, then A, then B; '' none.
  const TIERS = ['S', 'A', 'B'];
  const TIER_RANK = { S: 0, A: 1, B: 2 };
  const okTier = (t) => (TIERS.includes(t) ? t : '');
  // a click on the badge: none → S → A → B → none
  const nextTier = (t) => ({ '': 'S', S: 'A', A: 'B', B: '' })[okTier(t)];
  function tierCounts(rows) {
    const c = { S: 0, A: 0, B: 0 };
    for (const r of rows) if (c[r.tier] != null) c[r.tier]++;
    return c;
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
  const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

  // A web link from what was pasted or typed: http(s) only, "www.x.com" gets https://. Else null.
  function cleanUrl(raw) {
    let s = str(raw, 4096).trim().replace(/^[<("'\[]+|[>"'\],.;!?]+$/g, '');
    // a closing bracket is the sentence's, unless the link opened one (Wikipedia: ..._(film))
    while (s.endsWith(')') && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.slice(0, -1).replace(/[>"'\],.;!?]+$/g, '');
    if (!s) return null;
    if (/^www\./i.test(s)) s = 'https://' + s;
    if (!/^https?:\/\//i.test(s)) return null;
    let u;
    try { u = new URL(s); } catch { return null; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    const href = u.href;
    return href.length <= 2048 ? href : null;
  }
  // Every link in a pasted text (one per line, or among other words), each once, in order.
  function findUrls(text) {
    const out = [];
    for (const tok of str(text, 200000).split(/\s+/)) {
      if (!/^[<("'\[]*(https?:\/\/|www\.)/i.test(tok)) continue;
      const u = cleanUrl(tok);
      if (u && !out.includes(u)) out.push(u);
      if (out.length >= 200) break;
    }
    return out;
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
  }
  // A name to show until the page's own title arrives: the site and the last part of the path.
  function guessName(url) {
    let u;
    try { u = new URL(url); } catch { return str(url, 300); }
    const host = u.hostname.replace(/^www\./i, '');
    const parts = u.pathname.split('/').filter(Boolean);
    let last = parts.length ? parts[parts.length - 1] : '';
    try { last = decodeURIComponent(last); } catch {}
    last = last.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').trim();
    return last && !/^\d+$/.test(last) ? `${host} – ${last}`.slice(0, 300) : host;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  function decodeEntities(s) {
    return str(s, 100000).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      const v = ENTITIES[e.toLowerCase()];
      return v != null ? v : m;
    });
  }
  function attrs(tag) {
    const out = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[3] != null ? m[3] : m[4] != null ? m[4] : m[5]);
    return out;
  }
  // What a page says about itself in its <head>: { title, site, icon } (icon as written: may be relative).
  function parseHead(html, pageUrl) {
    const h = str(html, 2000000);
    const metas = {};
    for (const m of h.match(/<meta\b[^>]*>/gi) || []) {
      const a = attrs(m);
      const k = (a.property || a.name || '').toLowerCase();
      if (k && a.content != null && metas[k] == null) metas[k] = oneLine(a.content);
    }
    const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(h);
    const plain = t ? oneLine(decodeEntities(t[1])) : '';
    let site = metas['og:site_name'] || metas['application-name'] || '';
    let title = metas['og:title'] || metas['twitter:title'] || plain;
    // "Alien (film) - Wikipedia", "GitHub - electron/electron": the site at either end of the title
    // goes to its own column. It is the site when it is the page's site name or, with none, a word
    // of the address (wikipedia in en.wikipedia.org).
    const bare = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const labels = hostOf(pageUrl || '').toLowerCase().split('.');
    const isSite = (x) => { const b = bare(x); return b.length >= 3 && (site ? b === bare(site) : labels.includes(b)); };
    for (const sep of [' - ', ' | ', ' – ', ' — ', ' · ', ' :: ']) {
      const i = title.lastIndexOf(sep);
      if (i > 0 && isSite(title.slice(i + sep.length)) && title.slice(0, i).trim().length >= 2) { site = site || title.slice(i + sep.length).trim(); title = title.slice(0, i).trim(); break; }
      const j = title.indexOf(sep);
      if (j > 0 && isSite(title.slice(0, j)) && title.slice(j + sep.length).trim().length >= 2) { site = site || title.slice(0, j).trim(); title = title.slice(j + sep.length).trim(); break; }
    }
    let icon = '';
    let rank = 0;
    for (const l of h.match(/<link\b[^>]*>/gi) || []) {
      const a = attrs(l);
      const rel = (a.rel || '').toLowerCase().split(/\s+/);
      if (!a.href) continue;
      const r = rel.includes('icon') && !rel.includes('mask-icon') ? (/\b(32|48|64|96)\b/.test(a.sizes || '') ? 4 : 3) : rel.includes('apple-touch-icon') ? 2 : 0;
      if (r > rank) { rank = r; icon = a.href; }
    }
    return { title: title.slice(0, 300), site: site.slice(0, 120), icon: icon.slice(0, 2048) };
  }
  // Where the icon is: the page's own <link rel=icon>, else /favicon.ico. http(s) only.
  function iconUrl(href, pageUrl) {
    try {
      const u = new URL(href || '/favicon.ico', pageUrl);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch { return null; }
  }
  const isYouTube = (url) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(hostOf(url));

  // ---- the rows ----
  const okIcon = (s) => (typeof s === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(s) && s.length <= MAX_ICON ? s : '');
  function normalizeRow(r, i = 0) {
    if (!r || typeof r !== 'object') return null;
    const url = cleanUrl(r.url);
    if (!url) return null;
    const added = Number(r.added);
    return {
      id: /^[a-z0-9_-]{1,40}$/i.test(String(r.id || '')) ? String(r.id) : `r${i}${Math.random().toString(36).slice(2, 8)}`,
      url,
      name: oneLine(str(r.name, 300)) || guessName(url),
      site: oneLine(str(r.site, 120)) || hostOf(url),
      note: str(r.note, 2000),
      icon: okIcon(r.icon),
      added: isFinite(added) && added > 0 ? added : 0,
      auto: r.auto !== false, // the name is still Ozy's guess (the page's title may replace it)
      tier: okTier(r.tier),
    };
  }
  // Column widths a user set by dragging the dividers, in em of the block's text (so they scale with
  // the block). Notes has none: it takes what is left. Missing, or nothing valid: null (the default
  // proportions). (2026-11-17)
  const COL_KEYS = ['tier', 'name', 'site', 'added'];
  const COL_MIN = 1.5, COL_MAX = 200, NOTE_MIN = 4.6; // (Notes never narrower than its heading)
  // the fixed-width columns either side: the icon and the ✕
  const EDGE_EM = 2.1 + 2;
  function normCols(c) {
    if (!c || typeof c !== 'object') return null;
    const out = {};
    for (const k of COL_KEYS) {
      const v = Number(c[k]);
      if (Number.isFinite(v) && v > 0) out[k] = Math.round(Math.min(COL_MAX, Math.max(COL_MIN, v)) * 100) / 100;
    }
    return Object.keys(out).length === COL_KEYS.length ? out : null;
  }
  // the narrowest table that shows these columns and a little of Notes, in em
  const minTableEm = (cols) => EDGE_EM + NOTE_MIN + COL_KEYS.reduce((a, k) => a + (cols ? cols[k] : 0), 0);
  function normalize(links) {
    const l = links && typeof links === 'object' ? links : {};
    const rows = [];
    const seen = new Set();
    for (const r of Array.isArray(l.rows) ? l.rows : []) {
      const n = normalizeRow(r, rows.length);
      if (!n) continue;
      while (seen.has(n.id)) n.id += 'x';
      seen.add(n.id);
      rows.push(n);
      if (rows.length >= MAX_ROWS) break;
    }
    const title = oneLine(str(l.title, 120));
    const cols = normCols(l.cols);
    return { title: title || (l.title === '' ? '' : DEFAULT_TITLE), rows, ...(l.topFirst ? { topFirst: true } : {}), ...(cols ? { cols } : {}) };
  }
  const clone = (links) => JSON.parse(JSON.stringify(links));
  // New rows for these links (at the end), skipping any already in the list.
  function addUrls(links, urls, now, newId) {
    const out = clone(links);
    const have = new Set(out.rows.map((r) => r.url));
    const added = [];
    let dupes = 0;
    for (const raw of urls) {
      const url = cleanUrl(raw);
      if (!url) continue;
      if (have.has(url)) { dupes++; continue; }
      if (out.rows.length >= MAX_ROWS) break;
      const row = normalizeRow({ id: newId(), url, added: now, auto: true }, out.rows.length);
      out.rows.push(row); have.add(url); added.push(row.id);
    }
    return { links: out, added, dupes };
  }
  // A title that is a bot check or an error page, not the page's own ("Just a moment...").
  const JUNK = /^(just a moment|attention required|access denied|please wait|one moment|checking (your|if the site)|verify(ing)? (you are|that you are) (a )?human|are you a (robot|human)|robot check|security check|ddos-guard|before you continue|sign in|log ?in|[45]\d\d (forbidden|not found|error|internal|bad|service|gateway)|page not found|forbidden$|not found$|error\b)/i;
  const junkTitle = (t) => !t || JUNK.test(oneLine(str(t, 300)));
  // What a lookup ('link-info') changes in a row: the name only while it is still Ozy's guess.
  function infoPatch(row, info) {
    const p = {};
    if (!info || !info.ok) return p;
    if (row.auto && info.title && !junkTitle(info.title)) p.name = oneLine(str(info.title, 300));
    if (info.site && (row.auto || row.site === hostOf(row.url))) p.site = oneLine(str(info.site, 120));
    const icon = okIcon(info.icon);
    if (icon && !row.icon) p.icon = icon;
    return p;
  }
  // Put looked-up names back into rows that still carry a guess (after an undo brought one back).
  function withInfo(links, cache) {
    const out = clone(links);
    for (const r of out.rows) { const info = cache && cache.get ? cache.get(r.url) : null; if (info) Object.assign(r, infoPatch(r, info)); }
    return out;
  }
  // Sorted by a column ('name' | 'site' | 'note' | 'added'), A→Z / oldest first, or the reverse.
  function sortRows(rows, key, desc = false) {
    const k = COLUMNS.some(([c]) => c === key) ? key : 'name';
    const cmp = k === 'added'
      ? (a, b) => a.added - b.added
      : k === 'tier'
      ? (a, b) => { const x = TIER_RANK[a.tier], y = TIER_RANK[b.tier]; if ((x == null) !== (y == null)) return x == null ? 1 : -1; return (x || 0) - (y || 0); }
      : (a, b) => {
        const x = String(a[k] || ''), y = String(b[k] || '');
        if (!x !== !y) return x ? -1 : 1; // empty cells last, whichever way
        return x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
      };
    const out = rows.map((r, i) => [r, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map((p) => p[0]);
    if (!desc) return out;
    if (k === 'added') return out.reverse();
    const filled = out.filter((r) => r[k]), empty = out.filter((r) => !r[k]);
    return filled.reverse().concat(empty);
  }
  function moveRow(rows, id, delta) {
    const i = rows.findIndex((r) => r.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= rows.length) return rows.slice();
    const out = rows.slice();
    const [r] = out.splice(i, 1);
    out.splice(j, 0, r);
    return out;
  }
  // "Nov 16" this year, "Nov 16, 2025" before; '' for no date
  function fmtDate(ms, nowMs) {
    if (!(ms > 0)) return '';
    const d = new Date(ms), n = new Date(nowMs > 0 ? nowMs : Date.now());
    const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    return d.getFullYear() === n.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
  }
  // The block as plain text: what an older Ozy shows in its place, and what Find (Ctrl+F) searches.
  function summary(links) {
    const l = links || { title: DEFAULT_TITLE, rows: [] };
    const lines = [l.title || DEFAULT_TITLE];
    for (const r of l.rows) lines.push(`${r.tier ? `[${r.tier}] ` : ''}${r.name} — ${r.url}${r.note ? ` (${oneLine(r.note)})` : ''}`);
    return lines.join('\n').slice(0, 20000);
  }

  return { DEFAULT_TITLE, MAX_ROWS, COLUMNS, TIERS, okTier, nextTier, tierCounts, junkTitle, cleanUrl, findUrls, hostOf, guessName, decodeEntities, parseHead, iconUrl, isYouTube, normalizeRow, normalize, normCols, minTableEm, COL_KEYS, COL_MIN, NOTE_MIN, clone, addUrls, infoPatch, withInfo, sortRows, moveRow, fmtDate, summary };
});
