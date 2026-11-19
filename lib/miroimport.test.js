// The importer against a pretend Miro (no network): paging, the two-step picture download, the
// token going only to Miro, retrying when Miro says slow down, and picking up where a run stopped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createImporter, safeDirName } = require('./miroimport');

const API = 'https://api.miro.test';
const STORE = 'https://storage.test';

function fakeMiro({ images = 3, busyOnce = false, failImage = null } = {}) {
  const calls = [];
  let busy = busyOnce;
  const items = [
    { id: 'fr', type: 'frame', data: { title: 'Artists' }, style: {}, position: { x: 0, y: 0 }, geometry: { width: 1000, height: 800 } },
    { id: 'tx', type: 'text', data: { content: '<p>Hello</p>' }, style: { fontSize: '30' }, position: { x: 5, y: 5 }, geometry: { width: 100 } },
  ];
  for (let i = 1; i <= images; i++) items.push({ id: 'im' + i, type: 'image', data: { title: `pic ${i}.png`, imageUrl: `${API}/v2/boards/uXjVB1test/resources/images/${i}?format=preview&redirect=false` }, position: { x: i * 100, y: 0 }, geometry: { width: 80, height: 60 } });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    const auth = opts.headers && opts.headers.Authorization;
    calls.push({ url, auth });
    const u = new URL(url);
    if (u.origin === STORE) {
      if (auth) return new Response('two auth mechanisms', { status: 400 });
      return new Response(Buffer.from('PNGDATA:' + u.pathname), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (auth !== 'Bearer good-token') return json({ message: 'unauthorized' }, 401);
    if (busy && u.pathname.endsWith('/items')) { busy = false; return new Response('', { status: 429, headers: { 'retry-after': '0' } }); }
    if (u.pathname === '/v2/boards/uXjVB1test') return json({ id: 'uXjVB1test', name: 'Artists: refs?' });
    if (u.pathname === '/v2/boards/uXjVB1test/items') {
      const start = Number(u.searchParams.get('cursor') || 0);
      const page = items.slice(start, start + 2);
      return json({ data: page, total: items.length, cursor: start + 2 < items.length ? String(start + 2) : undefined });
    }
    if (u.pathname === '/v2/boards/uXjVB1test/connectors') return json({ data: [{ id: 'c1' }] });
    const m = u.pathname.match(/\/resources\/images\/(\d+)$/);
    if (m) {
      if (failImage === m[1]) return json({ message: 'gone' }, 410);
      return json({ type: 'image', url: `${STORE}/${u.searchParams.get('format')}/${m[1]}.png?sig=1` });
    }
    return json({}, 404);
  };
  return { fetchImpl, calls, items };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ozy-miro-'));
const opts = (f) => { const c = clock(); return { fetchImpl: f.fetchImpl, apiBase: API, sleep: c.sleep, now: c.now }; };

test('a whole import: board read page by page, pictures and previews on disk, a session written', async () => {
  const f = fakeMiro({ images: 3, busyOnce: true });
  const root = tmp();
  const progress = [];
  const r = await createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root, onProgress: (p) => progress.push(p) });
  assert.equal(r.dir, path.join(root, safeDirName('Artists: refs?')));
  assert.equal(path.basename(r.dir), 'Artists refs');
  const s = JSON.parse(fs.readFileSync(r.sessionPath, 'utf8'));
  assert.equal(s.format, 'multi-video-player-session');
  assert.equal(s.layout.background, 'light');
  const imgs = s.videos.filter((v) => v.type === 'image');
  assert.equal(imgs.length, 3);
  for (const v of imgs) {
    assert.ok(fs.existsSync(v.path), v.path);
    assert.ok(fs.existsSync(v.thumb), v.thumb);
    assert.match(fs.readFileSync(v.path, 'utf8'), /original/);
    assert.match(fs.readFileSync(v.thumb, 'utf8'), /preview/);
  }
  assert.equal(path.basename(imgs[0].path), 'pic 1.png');
  assert.ok(fs.existsSync(path.join(r.dir, 'miro-items.json')));
  assert.match(r.summary, /1 arrow/);
  // the token went to Miro's API only, never to the storage links
  for (const c of f.calls) assert.equal(!!c.auth, new URL(c.url).origin === API, c.url);
  assert.ok(progress.some((p) => p.phase === 'images' && p.done === 3));
  // nothing of the token on disk
  for (const name of fs.readdirSync(r.dir)) if (name.endsWith('.json') || name.endsWith('.mvp')) assert.ok(!fs.readFileSync(path.join(r.dir, name), 'utf8').includes('good-token'), name);
});

test('run again: what is on disk is not downloaded twice', async () => {
  const root = tmp();
  const f = fakeMiro({ images: 2 });
  const first = await createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root });
  const f2 = fakeMiro({ images: 2 });
  const again = await createImporter(opts(f2)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root });
  assert.equal(f2.calls.filter((c) => new URL(c.url).origin === STORE).length, 0);
  const a = JSON.parse(fs.readFileSync(first.sessionPath, 'utf8')).videos.filter((v) => v.type === 'image').map((v) => v.path);
  const b = JSON.parse(fs.readFileSync(again.sessionPath, 'utf8')).videos.filter((v) => v.type === 'image').map((v) => v.path);
  assert.deepEqual(a, b);
});

test('a picture Miro will not give is reported, the rest still come', async () => {
  const f = fakeMiro({ images: 3, failImage: '2' });
  const r = await createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: tmp() });
  assert.equal(r.failed, 1);
  assert.match(r.summary, /1 picture could not be downloaded/);
  assert.equal(JSON.parse(fs.readFileSync(r.sessionPath, 'utf8')).videos.filter((v) => v.type === 'image').length, 2);
});

test('a bad token or link says what to do', async () => {
  const f = fakeMiro();
  await assert.rejects(createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'wrong', root: tmp() }), /did not accept the token/);
  await assert.rejects(createImporter(opts(f)).run({ boardUrl: 'nope nope', token: 'good-token', root: tmp() }), /board link/);
  await assert.rejects(createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: ' ', root: tmp() }), /token/);
});

test('the token is never sent to a host other than Miro\'s API', async () => {
  const imp = createImporter({ fetchImpl: async () => { throw new Error('should not be called'); }, apiBase: API, sleep: async () => {} });
  await assert.rejects(imp.api('good-token', 'https://evil.test/v2/x'), /somewhere other than its API/);
});

// ---- Miro's per-minute allowance (2026-11-06: Mark's real import was stopped by a 429) ----
function clock() {
  let t = 1_700_000_000_000;
  return { now: () => t, sleep: async (ms) => { t += Math.max(1, ms); } };
}
test('used up: every download waits until Miro says, then the import finishes', async () => {
  const c = clock();
  const f = fakeMiro({ images: 12 });
  // a Miro that allows 5 API requests a "minute", then answers 429 until the minute is over
  let windowStart = c.now(), used = 0, refused = 0;
  const limited = async (url, opts = {}) => {
    if (new URL(url).origin === API) {
      if (c.now() - windowStart >= 60000) { windowStart = c.now(); used = 0; }
      if (++used > 5) {
        refused++;
        const resetSec = Math.ceil((windowStart + 60000 - c.now()) / 1000);
        return new Response('{}', { status: 429, headers: { 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) } });
      }
    }
    return f.fetchImpl(url, opts);
  };
  const notes = [];
  const r = await createImporter({ fetchImpl: limited, apiBase: API, sleep: c.sleep, now: c.now })
    .run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: tmp(), onProgress: (p) => notes.push(p) });
  assert.equal(r.failed, 0);
  assert.equal(JSON.parse(fs.readFileSync(r.sessionPath, 'utf8')).videos.filter((v) => v.type === 'image').length, 12);
  assert.ok(refused > 0, 'the pretend Miro did refuse');
  assert.ok(refused < 40, `the downloads waited together instead of hammering (${refused} refusals)`);
  assert.ok(notes.some((p) => p.waiting > 0 && /slow down/.test(p.note)), 'the window was told about the wait');
});

test('nearly used up: Ozy waits for the next minute before being refused', async () => {
  const c = clock();
  const f = fakeMiro({ images: 4 });
  let refused = 0, windowStart = c.now(), used = 0;
  const polite = async (url, opts = {}) => {
    if (new URL(url).origin === API) {
      if (c.now() - windowStart >= 60000) { windowStart = c.now(); used = 0; }
      used++;
      if (used > 100) { refused++; return new Response('{}', { status: 429 }); }
      const res = await f.fetchImpl(url, opts);
      const h = new Headers(res.headers);
      h.set('x-ratelimit-limit', '100'); h.set('x-ratelimit-remaining', String(Math.max(0, 100 - used - 95))); h.set('x-ratelimit-reset', String(Math.ceil((windowStart + 60000 - c.now()) / 1000)));
      return new Response(res.body, { status: res.status, headers: h });
    }
    return f.fetchImpl(url, opts);
  };
  const r = await createImporter({ fetchImpl: polite, apiBase: API, sleep: c.sleep, now: c.now })
    .run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: tmp() });
  assert.equal(r.failed, 0);
  assert.equal(refused, 0);
});

test('busy for too long: stops with a clear message, keeping what is downloaded', async () => {
  const c = clock();
  const f = fakeMiro({ images: 2 });
  const always = async (url, opts = {}) => (new URL(url).pathname.endsWith('/items') ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } }) : f.fetchImpl(url, opts));
  await assert.rejects(createImporter({ fetchImpl: always, apiBase: API, sleep: c.sleep, now: c.now })
    .run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: tmp() }), /busy for a long time/);
});

// ---- never fetching twice (2026-11-06: Mark's first run downloaded 793 files that were 347 pictures) ----
const { planDownloads } = require('./miroimport');
test('a picture placed several times is downloaded once and shown everywhere it was', async () => {
  const f = fakeMiro({ images: 3 });
  // items 4 and 5 show the same upload as item 1
  for (const n of [4, 5]) f.items.push({ id: 'dup' + n, type: 'image', data: { title: 'copy.png', imageUrl: `${API}/v2/boards/uXjVB1test/resources/images/1?format=preview&redirect=false` }, position: { x: n * 300, y: 900 }, geometry: { width: 80, height: 60 } });
  const r = await createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: tmp() });
  const imgs = JSON.parse(fs.readFileSync(r.sessionPath, 'utf8')).videos.filter((v) => v.type === 'image');
  assert.equal(imgs.length, 5);
  assert.equal(new Set(imgs.map((v) => v.path)).size, 3);
  assert.equal(f.calls.filter((c) => new URL(c.url).origin === STORE && c.url.includes('/original/')).length, 3);
});

test('a run stopped part way: the next one fetches only what is missing, and nothing listed is forgotten', async () => {
  const root = tmp();
  // first run: stopped after a few pictures
  const f1 = fakeMiro({ images: 10 });
  const ac = new AbortController();
  let stored = 0;
  const stopping = async (url, o = {}) => { const res = await f1.fetchImpl(url, o); if (new URL(url).origin === STORE && ++stored === 7) ac.abort(); return res; };
  await assert.rejects(createImporter({ ...opts(f1), fetchImpl: stopping }).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root, signal: ac.signal }), /Stopped/);
  const dir = path.join(root, 'Artists refs');
  const before = fs.readdirSync(path.join(dir, 'images')).filter((n) => /\.png$/.test(n));
  assert.ok(before.length > 0 && before.length < 10, `some pictures on disk (${before.length})`);
  // the plan, without a token: what is there is kept, the rest is to fetch
  const items = JSON.parse(fs.readFileSync(path.join(dir, 'miro-items.json'), 'utf8')).items;
  const plan = await planDownloads(items, dir);
  assert.equal(plan.have, before.length);
  assert.equal(plan.need, 10 - before.length);
  // second run: only the missing ones are fetched, under new names (nothing overwritten, no "(2)" copies)
  const f2 = fakeMiro({ images: 10 });
  const r = await createImporter(opts(f2)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root });
  assert.equal(f2.calls.filter((c) => new URL(c.url).origin === STORE && c.url.includes('/original/')).length, 10 - before.length);
  const after = fs.readdirSync(path.join(dir, 'images')).filter((n) => /\.png$/.test(n));
  assert.equal(after.length, 10);
  assert.ok(!after.some((n) => /\(2\)/.test(n)), after.join(', '));
  assert.equal(JSON.parse(fs.readFileSync(r.sessionPath, 'utf8')).videos.filter((v) => v.type === 'image').length, 10);
  // a third run has nothing at all to fetch
  const f3 = fakeMiro({ images: 10 });
  await createImporter(opts(f3)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root });
  assert.equal(f3.calls.filter((c) => new URL(c.url).origin === STORE).length, 0);
});

test('a file an interrupted run wrote but never listed is found and kept', async () => {
  const root = tmp();
  const f1 = fakeMiro({ images: 3 });
  const r1 = await createImporter(opts(f1)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root });
  // forget the list entirely, as if every file had been written but none listed
  fs.unlinkSync(path.join(r1.dir, 'miro-import.json'));
  const f2 = fakeMiro({ images: 3 });
  await createImporter(opts(f2)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root });
  assert.equal(f2.calls.filter((c) => new URL(c.url).origin === STORE).length, 0);
});

test('the same board imported again with another folder named continues in its first folder', async () => {
  const first = tmp(), other = tmp();
  const dirs = {};
  const f1 = fakeMiro({ images: 3 });
  const r1 = await createImporter(opts(f1)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: first, rememberDir: (id, d) => { dirs[id] = d; } });
  const f2 = fakeMiro({ images: 3 });
  const r2 = await createImporter(opts(f2)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: other, boardDir: (id) => dirs[id] || null });
  assert.equal(r2.dir, r1.dir);
  assert.equal(f2.calls.filter((c) => new URL(c.url).origin === STORE).length, 0);
  assert.deepEqual(fs.readdirSync(other), []);
});

// ---- crops from what was copied in Miro (2026-11-10) ----
test('a Miro copy of the board: its crops are used, kept for later, and a copy of another board is not', async () => {
  const root = tmp();
  const f = fakeMiro({ images: 2 });
  // the pretend pictures are 'PNGDATA:…' with no real size; the copy says how each is cropped
  const crops = new Map([['im1', { x: 0.25, y: 0, w: 0.5, h: 1 }]]);
  const r = await createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root, miroCopy: { boardId: 'uXjVB1test', crops } });
  const im1 = JSON.parse(fs.readFileSync(r.sessionPath, 'utf8')).videos.find((v) => v.id === 'miro-im1');
  assert.deepEqual(im1.crop, { x: 0.25, y: 0, w: 0.5, h: 1 });
  const kept = JSON.parse(fs.readFileSync(path.join(r.dir, 'miro-crops.json'), 'utf8'));
  assert.equal(kept.im1.source, 'miro');
  // next import, nothing copied: the crop stays
  const r2 = await createImporter(opts(fakeMiro({ images: 2 }))).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root });
  assert.deepEqual(JSON.parse(fs.readFileSync(r2.sessionPath, 'utf8')).videos.find((v) => v.id === 'miro-im1').crop, { x: 0.25, y: 0, w: 0.5, h: 1 });
  // a copy of some other board is left alone, and the summary says so
  const r3 = await createImporter(opts(fakeMiro({ images: 2 }))).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root, miroCopy: { boardId: 'uXjVother', crops: new Map([['im1', { x: 0, y: 0, w: 0.1, h: 0.1 }]]) } });
  assert.match(r3.summary, /another board/);
  assert.deepEqual(JSON.parse(fs.readFileSync(r3.sessionPath, 'utf8')).videos.find((v) => v.id === 'miro-im1').crop, { x: 0.25, y: 0, w: 0.5, h: 1 });
});

test('rebuildBoard: lays the board out again from its folder, without Miro, keeping the copy\'s layers', async () => {
  const { rebuildBoard } = require('./miroimport');
  const f = fakeMiro({ images: 3 });
  const r = await createImporter(opts(f)).run({ boardUrl: 'https://miro.com/app/board/uXjVB1test/', token: 'good-token', root: tmp() });
  // a copy that stacks the text behind picture 2
  const order = new Map([['fr', 0], ['im1', 1], ['tx', 2], ['im2', 3], ['im3', 4]]);
  const out = await rebuildBoard(r.dir, { miroCopy: { boardId: 'uXjVB1test', crops: new Map(), order, heights: new Map(), styles: new Map([['tx', { bold: true, italic: false, underline: false, strike: false }]]) } });
  const ids = JSON.parse(fs.readFileSync(out.sessionPath, 'utf8')).videos.map((v) => v.id);
  assert.deepEqual(ids.filter((x) => /tx|im/.test(x)), ['miro-im1', 'miro-tx', 'miro-im2', 'miro-im3']);
  assert.ok(fs.existsSync(path.join(r.dir, 'miro-layers.json')));
  // again with no copy: the kept layers still apply
  const again = await rebuildBoard(r.dir);
  const s2 = JSON.parse(fs.readFileSync(again.sessionPath, 'utf8')).videos;
  assert.deepEqual(s2.map((v) => v.id).filter((x) => /tx|im/.test(x)), ['miro-im1', 'miro-tx', 'miro-im2', 'miro-im3']);
  assert.equal(s2.find((v) => v.id === 'miro-tx').style.bold, true);
});
