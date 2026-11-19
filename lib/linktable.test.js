const test = require('node:test');
const assert = require('node:assert');
const LT = require('./linktable.js');

test('cleanUrl keeps web links only and tidies what was pasted around them', () => {
  assert.strictEqual(LT.cleanUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(LT.cleanUrl('  www.artstation.com/x  '), 'https://www.artstation.com/x');
  assert.strictEqual(LT.cleanUrl('<https://example.com/>'), 'https://example.com/');
  assert.strictEqual(LT.cleanUrl('https://example.com/page.'), 'https://example.com/page');
  assert.strictEqual(LT.cleanUrl('(see https://example.com/x)'.split(' ')[1]), 'https://example.com/x');
  assert.strictEqual(LT.cleanUrl('https://en.wikipedia.org/wiki/Alien_(film)'), 'https://en.wikipedia.org/wiki/Alien_(film)');
  assert.strictEqual(LT.cleanUrl('javascript:alert(1)'), null);
  assert.strictEqual(LT.cleanUrl('file:///C:/x.txt'), null);
  assert.strictEqual(LT.cleanUrl('example.com'), null);
  assert.strictEqual(LT.cleanUrl('https://user:pw@example.com/'), null);
  assert.strictEqual(LT.cleanUrl(''), null);
  assert.strictEqual(LT.cleanUrl(null), null);
});

test('findUrls takes every link from a paste, once each, in order', () => {
  const text = 'look https://a.com/1 and\nhttps://b.com/2\r\nhttps://a.com/1 www.c.org nothing.here';
  assert.deepStrictEqual(LT.findUrls(text), ['https://a.com/1', 'https://b.com/2', 'https://www.c.org/']);
  assert.deepStrictEqual(LT.findUrls('no links here'), []);
});

test('guessName shows the site and the page part of the path until the title arrives', () => {
  assert.strictEqual(LT.guessName('https://www.artstation.com/artwork/character-turnaround-sheet'), 'artstation.com – character turnaround sheet');
  assert.strictEqual(LT.guessName('https://example.com/'), 'example.com');
  assert.strictEqual(LT.guessName('https://example.com/posts/12345'), 'example.com');
  assert.strictEqual(LT.guessName('https://example.com/a/My%20Page.html'), 'example.com – My Page');
  assert.strictEqual(LT.hostOf('https://www.youtube.com/watch?v=x'), 'youtube.com');
});

test('parseHead reads the title, site name and icon, preferring the page\'s own og: tags', () => {
  const html = `<html><head>
    <title>Turnaround sheet &amp; notes | ArtStation</title>
    <meta property="og:site_name" content="ArtStation">
    <meta property='og:title' content='Turnaround sheet &amp; notes'>
    <link rel="apple-touch-icon" href="/apple.png">
    <link rel="icon" sizes="32x32" href="/fav-32.png">
    <link rel="mask-icon" href="/mask.svg">
  </head><body>…</body></html>`;
  assert.deepStrictEqual(LT.parseHead(html), { title: 'Turnaround sheet & notes', site: 'ArtStation', icon: '/fav-32.png' });
});

test('parseHead falls back to <title>, strips the site name from its end, and decodes entities', () => {
  const html = '<title>\n  My Video &#8211; Part 2 - YouTube\n</title><meta name="og:site_name" content="YouTube"><link rel="shortcut icon" href="https://x.com/i.ico">';
  assert.deepStrictEqual(LT.parseHead(html), { title: 'My Video – Part 2', site: 'YouTube', icon: 'https://x.com/i.ico' });
  assert.deepStrictEqual(LT.parseHead('<p>no head</p>'), { title: '', site: '', icon: '' });
  assert.strictEqual(LT.decodeEntities('&lt;b&gt; &#x27;x&#x27; &nbsp;&unknown;'), "<b> 'x'  &unknown;");
});

test('parseHead moves a site name at either end of the title into the site', () => {
  assert.deepStrictEqual(LT.parseHead('<title>Alien (film) - Wikipedia</title>', 'https://en.wikipedia.org/wiki/Alien_(film)'),
    { title: 'Alien (film)', site: 'Wikipedia', icon: '' });
  assert.deepStrictEqual(LT.parseHead('<title>GitHub - electron/electron: Build apps</title><meta property="og:site_name" content="GitHub">', 'https://github.com/electron/electron'),
    { title: 'electron/electron: Build apps', site: 'GitHub', icon: '' });
  // a dash in the title that is not the site stays
  assert.strictEqual(LT.parseHead('<title>Before - After</title>', 'https://example.com/').title, 'Before - After');
  assert.strictEqual(LT.parseHead('<title>Example - Home page</title>', 'https://example.com/').title, 'Home page');
  assert.strictEqual(LT.parseHead('<title>Example - x</title>', 'https://example.com/').title, 'Example - x'); // (nothing left worth a name)
});

test('iconUrl resolves against the page and defaults to /favicon.ico', () => {
  assert.strictEqual(LT.iconUrl('/fav.png', 'https://a.com/x/y'), 'https://a.com/fav.png');
  assert.strictEqual(LT.iconUrl('', 'https://a.com/x/y'), 'https://a.com/favicon.ico');
  assert.strictEqual(LT.iconUrl('data:image/png;base64,AAA', 'https://a.com/'), null);
  assert.strictEqual(LT.isYouTube('https://youtu.be/abc'), true);
  assert.strictEqual(LT.isYouTube('https://notyoutube.com/abc'), false);
});

test('normalize keeps good rows, drops bad links, caps lengths and fixes ids', () => {
  const l = LT.normalize({ title: '  Refs  ', rows: [
    { id: 'a', url: 'https://a.com/', name: ' A  site ', note: 'n', added: 5, auto: false },
    { id: 'a', url: 'https://b.com/' },
    { url: 'javascript:x' },
    { id: 'c', url: 'https://c.com/', icon: 'data:text/html;base64,AAAA' },
    { id: 'd', url: 'https://d.com/', icon: 'data:image/png;base64,iVBOR=' },
  ] });
  assert.strictEqual(l.title, 'Refs');
  assert.deepStrictEqual(l.rows.map((r) => r.id), ['a', 'ax', 'c', 'd']);
  assert.strictEqual(l.rows[0].name, 'A site');
  assert.strictEqual(l.rows[0].auto, false);
  assert.strictEqual(l.rows[1].name, 'b.com');
  assert.strictEqual(l.rows[1].site, 'b.com');
  assert.strictEqual(l.rows[1].auto, true);
  assert.strictEqual(l.rows[2].icon, '');
  assert.strictEqual(l.rows[3].icon, 'data:image/png;base64,iVBOR=');
  assert.deepStrictEqual(LT.normalize(null), { title: 'Bookmarks', rows: [] });
});

test('addUrls appends new links, skips ones already listed, and leaves the original alone', () => {
  const base = LT.normalize({ rows: [{ id: 'a', url: 'https://a.com/' }] });
  let n = 0;
  const r = LT.addUrls(base, ['https://a.com/', 'https://b.com/x', 'bad', 'https://b.com/x'], 1000, () => 'n' + n++);
  assert.deepStrictEqual(r.links.rows.map((x) => x.url), ['https://a.com/', 'https://b.com/x']);
  assert.deepStrictEqual(r.added, ['n0']);
  assert.strictEqual(r.dupes, 2);
  assert.strictEqual(r.links.rows[1].added, 1000);
  assert.strictEqual(base.rows.length, 1);
});

test('infoPatch fills the name only while it is a guess; withInfo puts it back after an undo', () => {
  const guess = LT.normalizeRow({ id: 'a', url: 'https://a.com/x', auto: true });
  const named = LT.normalizeRow({ id: 'b', url: 'https://a.com/y', name: 'Mine', auto: false });
  const info = { ok: true, title: 'Real title', site: 'A Site', icon: 'data:image/png;base64,AA==' };
  assert.deepStrictEqual(LT.infoPatch(guess, info), { name: 'Real title', site: 'A Site', icon: 'data:image/png;base64,AA==' });
  assert.deepStrictEqual(LT.infoPatch(named, info), { site: 'A Site', icon: 'data:image/png;base64,AA==' });
  assert.deepStrictEqual(LT.infoPatch(guess, { ok: false }), {});
  // a bot check or an error page is not the page's name
  assert.deepStrictEqual(LT.infoPatch(guess, { ok: true, title: 'Just a moment...' }), {});
  assert.deepStrictEqual(LT.infoPatch(guess, { ok: true, title: 'Attention Required! | Cloudflare' }), {});
  assert.deepStrictEqual(LT.infoPatch(guess, { ok: true, title: '404 Not Found' }), {});
  assert.strictEqual(LT.junkTitle('Errors of the past: a history'), false);
  assert.strictEqual(LT.junkTitle('Signing the Constitution'), false);
  const cache = new Map([['https://a.com/x', info]]);
  const back = LT.withInfo({ title: 'B', rows: [guess, named] }, cache);
  assert.strictEqual(back.rows[0].name, 'Real title');
  assert.strictEqual(back.rows[1].name, 'Mine');
  assert.strictEqual(guess.name, 'a.com – x'); // the original is untouched
});

test('sortRows sorts by a column either way, empty cells last, stable for ties', () => {
  const rows = [
    { id: '1', name: 'banana', note: '', added: 3 },
    { id: '2', name: 'Apple', note: 'z', added: 1 },
    { id: '3', name: 'cherry 10', note: 'a', added: 2 },
    { id: '4', name: 'cherry 9', note: '', added: 4 },
  ];
  assert.deepStrictEqual(LT.sortRows(rows, 'name').map((r) => r.id), ['2', '1', '4', '3']);
  assert.deepStrictEqual(LT.sortRows(rows, 'name', true).map((r) => r.id), ['3', '4', '1', '2']);
  assert.deepStrictEqual(LT.sortRows(rows, 'note').map((r) => r.id), ['3', '2', '1', '4']);
  assert.deepStrictEqual(LT.sortRows(rows, 'note', true).map((r) => r.id), ['2', '3', '1', '4']);
  assert.deepStrictEqual(LT.sortRows(rows, 'added', true).map((r) => r.id), ['4', '1', '3', '2']);
});

test('moveRow, fmtDate and summary', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(LT.moveRow(rows, 'c', -1).map((r) => r.id), ['a', 'c', 'b']);
  assert.deepStrictEqual(LT.moveRow(rows, 'a', -1).map((r) => r.id), ['a', 'b', 'c']);
  const now = new Date(2026, 10, 16).getTime();
  assert.strictEqual(LT.fmtDate(new Date(2026, 10, 3).getTime(), now), 'Nov 3');
  assert.strictEqual(LT.fmtDate(new Date(2025, 0, 9).getTime(), now), 'Jan 9, 2025');
  assert.strictEqual(LT.fmtDate(0, now), '');
  const l = LT.normalize({ title: 'Refs', rows: [{ id: 'a', url: 'https://a.com/', name: 'A', note: 'two\nlines' }] });
  assert.strictEqual(LT.summary(l), 'Refs\nA — https://a.com/ (two lines)');
});

test('junkTitle leaves real titles that start with a number alone', () => {
  assert.strictEqual(LT.junkTitle('300 (film) - Wikipedia'), false);
  assert.strictEqual(LT.junkTitle('503 Service Unavailable'), true);
  assert.strictEqual(LT.junkTitle('Forbidden'), true);
  assert.strictEqual(LT.junkTitle('Forbidden Planet (1956)'), false);
});

test('tiers: kept when S, A or B, cycled by a click, counted, sorted best first, shown in the text', () => {
  const l = LT.normalize({ rows: [
    { id: 'a', url: 'https://a.com/', name: 'a', tier: 'B' },
    { id: 'b', url: 'https://b.com/', name: 'b' },
    { id: 'c', url: 'https://c.com/', name: 'c', tier: 'S' },
    { id: 'd', url: 'https://d.com/', name: 'd', tier: 'Z' },
    { id: 'e', url: 'https://e.com/', name: 'e', tier: 'A' },
  ], topFirst: true });
  assert.deepStrictEqual(l.rows.map((r) => r.tier), ['B', '', 'S', '', 'A']);
  assert.strictEqual(l.topFirst, true);
  assert.strictEqual(LT.normalize({ rows: [] }).topFirst, undefined);
  assert.deepStrictEqual(['', 'S', 'A', 'B', 'x'].map(LT.nextTier), ['S', 'A', 'B', '', 'S']);
  assert.deepStrictEqual(LT.tierCounts(l.rows), { S: 1, A: 1, B: 1 });
  assert.deepStrictEqual(LT.sortRows(l.rows, 'tier').map((r) => r.id), ['c', 'e', 'a', 'b', 'd']);
  assert.deepStrictEqual(LT.sortRows(l.rows, 'tier', true).map((r) => r.id), ['a', 'e', 'c', 'b', 'd']);
  assert.ok(LT.summary(l).includes('[S] c — https://c.com/'));
});

test('column widths: kept when all four are valid, clamped, and Notes takes the rest', () => {
  const l = LT.normalize({ rows: [], cols: { tier: 3.6, name: 0.2, site: '9', added: 999, note: 40 } });
  assert.deepStrictEqual(l.cols, { tier: 3.6, name: LT.COL_MIN, site: 9, added: 200 });
  assert.strictEqual(LT.normalize({ rows: [], cols: { tier: 3, name: 10 } }).cols, undefined); // not all of them
  assert.strictEqual(LT.normalize({ rows: [], cols: 'wide' }).cols, undefined);
  assert.strictEqual(LT.minTableEm({ tier: 4, name: 10, site: 6, added: 6 }), 2.1 + 2 + LT.NOTE_MIN + 26);
});
