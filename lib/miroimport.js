// Miro import, the part that talks to Miro (main process). Reads the board's items through Miro's
// REST API v2 with the user's own access token, downloads every picture (full size, plus Miro's
// own preview for when the tile is small on screen), and writes an Ozy session next to them.
//
// Mark, 2026-11-06. What lands where, in the folder the user picked (never on C: by default):
//   <Board name>\<Board name>.mvp       the Ozy board, ready to open
//   <Board name>\images\…               the pictures at full size
//   <Board name>\images\previews\…      Miro's smaller previews of them
//   <Board name>\miro-items.json        everything Miro said about the board (to put a bug right)
//   <Board name>\miro-import.json       which item became which file (an import run again picks
//                                       up where it stopped and skips what is already there)
// The token is never written anywhere by this file and never leaves for any host but Miro's.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const Miro = require('./miro');
const ImageSize = require('./imagesize');

const API = 'https://api.miro.com';
const PAGE = 50;            // Miro's largest page of items
const CONCURRENCY = 4;      // pictures downloading at once (6 until 2026-11-06: Miro's per-minute allowance ran out)
const RETRIES = 4;
// Miro allows each app so much per minute and answers 429 once it is used up (Mark's 1492-picture
// board hit it after ~800 pictures, 2026-11-06). Ozy then waits for as long as Miro says, all
// downloads together, and carries on; it gives up only after this long of being told to wait.
const BUSY_GIVE_UP_MS = 45 * 60 * 1000;
const LOW_ALLOWANCE = 0.08; // ease off (wait for the next minute) when less than this share is left
// a crop found from a screenshot is used when the match is at least this good (0 to 1)
const CROP_TRUST = 0.7;

class ImportError extends Error {}

// a folder name from the board's name, safe on Windows
function safeDirName(name) {
  const s = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80);
  return s || 'Miro board';
}

// When Miro's allowance comes back, from its headers: X-RateLimit-Reset (seconds from now, or the
// moment itself in epoch seconds or ms) or Retry-After (seconds). null when it does not say.
function resetAt(headers, now) {
  const n = (k) => { const v = Number(headers.get(k)); return Number.isFinite(v) && v > 0 ? v : null; };
  const r = n('x-ratelimit-reset');
  if (r !== null) return r > 1e12 ? r : r > 1e9 ? r * 1000 : now + r * 1000;
  const ra = n('retry-after');
  return ra !== null ? now + ra * 1000 : null;
}

// What an import still has to fetch, from the folder as it is now (also used to check, without a
// token, what a re-run would do). For every picture on the board:
//   - listed by an earlier run (miro-import.json) and still on disk: kept as it is;
//   - not listed, but its file is in images\ anyway (a run stopped between writing it and listing it): kept;
//   - the same picture placed several times on the board: one file for all of them;
//   - otherwise fetched, under a name chosen now, in board order, and remembered for next time.
// Returns { groups: [{ keys, item, links, base, entry }], known, names, pictures, imageItems, have, need, needPreview }.
async function planDownloads(items, dir) {
  const imgDir = path.join(dir, 'images');
  const prevDir = path.join(imgDir, 'previews');
  let saved = {};
  try { saved = JSON.parse(await fsp.readFile(path.join(dir, 'miro-import.json'), 'utf8')) || {}; } catch {}
  const listed = saved.files && typeof saved.files === 'object' ? saved.files : {};
  const names = saved.names && typeof saved.names === 'object' ? { ...saved.names } : {};
  // what is in the folders now: name without extension -> file (a half-written .part does not count)
  const onDisk = async (d) => {
    const m = new Map();
    let list = [];
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch {}
    for (const e of list) {
      if (!e.isFile() || /\.part$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try { if ((await fsp.stat(full)).size > 0) m.set(path.basename(e.name, path.extname(e.name)).toLowerCase(), full); } catch {}
    }
    return m;
  };
  const disk = await onDisk(imgDir), diskPrev = await onDisk(prevDir);
  const here = (p) => !!p && disk.has(path.basename(p, path.extname(p)).toLowerCase()) && path.dirname(path.resolve(p)).toLowerCase() === path.resolve(imgDir).toLowerCase();
  const previewFor = (p) => diskPrev.get(path.basename(p, path.extname(p)).toLowerCase()) || null;
  const known = {};
  const baseOf = (p) => path.basename(p, path.extname(p)).toLowerCase();
  const taken = new Set([...disk.keys()]); // a new name never lands on a file that is there
  for (const b of Object.values(names)) taken.add(String(b).toLowerCase());
  // file names some item already owns (listed, or named by an earlier run)
  const claimed = new Set(Object.values(listed).filter((f) => f && f.path).map((f) => baseOf(f.path)));
  for (const b of Object.values(names)) claimed.add(String(b).toLowerCase());
  // pictures, and the preview picture of each link card (no YouTube: that becomes a player)
  const images = (items || []).filter((it) => it && (it.type === 'image' || (it.type === 'embed' && it.data && typeof it.data.previewUrl === 'string' && !youtubeOf(it.data.url))));
  const groups = [];
  const byResource = new Map();
  for (const it of images) {
    const key = String(it.id);
    const links = Miro.imageLinks(it);
    const res = Miro.resourceId(it);
    const g0 = res && byResource.get(res);
    if (g0) { g0.keys.push(key); continue; } // the same picture again
    const g = { keys: [key], item: it, links, base: null, entry: null };
    groups.push(g);
    if (res) byResource.set(res, g);
    const had = listed[key];
    if (had && had.path && here(had.path)) {
      g.entry = { path: had.path, thumb: had.thumb && fs.existsSync(had.thumb) ? had.thumb : previewFor(had.path) };
    } else {
      // the name it had, or would have had: in board order, so a re-run picks the same one
      let base = names[key];
      if (!base) {
        // a file under its plain name that no other item owns: an interrupted run wrote it for this one
        const plain = Miro.fileName(it, '', new Set());
        base = disk.has(plain.toLowerCase()) && !claimed.has(plain.toLowerCase()) ? plain : Miro.fileName(it, '', taken);
      }
      names[key] = base;
      taken.add(base.toLowerCase());
      claimed.add(base.toLowerCase());
      g.base = base;
      const found = disk.get(base.toLowerCase());
      if (found) g.entry = { path: found, thumb: previewFor(found) };
    }
  }
  for (const g of groups) if (g.entry) for (const k of g.keys) known[k] = g.entry;
  const have = groups.filter((g) => g.entry).length;
  return { groups, known, names, pictures: groups.length, imageItems: images.length, have, need: groups.length - have, needPreview: groups.filter((g) => !g.entry || !g.entry.thumb).length };
}

function createImporter({ fetchImpl = globalThis.fetch, apiBase = API, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  // Every request waits here while Miro has asked Ozy to hold off, so the downloads pause together
  // instead of each one being refused in turn. onWait shows the wait in the import window.
  let holdUntil = 0, busySince = 0;
  let onWait = () => {};
  async function gate(signal) {
    while (now() < holdUntil) {
      if (signal && signal.aborted) throw new ImportError('Stopped.');
      onWait(holdUntil - now());
      await sleep(Math.min(1000, Math.max(50, holdUntil - now())));
    }
  }
  function hold(until, why) {
    if (until > holdUntil) { holdUntil = until; log('info', 'miro asked to wait', { seconds: Math.round((until - now()) / 1000), why }); }
  }
  // one call to Miro's API, with the token, retried when Miro says slow down or a connection drops
  // (soft: one picture's request; anything but a refused token fails only that picture)
  async function api(token, urlOrPath, signal, soft = false) {
    const url = /^https?:/i.test(urlOrPath) ? urlOrPath : apiBase + urlOrPath;
    // the token only ever goes to Miro's API host (a link inside Miro's answer could point elsewhere)
    if (new URL(url).origin !== new URL(apiBase).origin) throw new ImportError('Miro gave a link to somewhere other than its API; stopped.');
    let wait = 2000, busyWait = 15000;
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) throw new ImportError('Stopped.');
      await gate(signal);
      let res;
      try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal });
      } catch (e) {
        if (signal && signal.aborted) throw new ImportError('Stopped.');
        if (attempt >= RETRIES) throw new ImportError(`Could not reach Miro (${e && e.message ? e.message : e}). Check the internet connection and try again.`);
        await sleep(wait); wait *= 2; continue;
      }
      if (res.status === 429) {
        // used up for now: everyone waits until Miro says (else 15 s, 30 s, … up to a minute), then on
        if (!busySince) busySince = now();
        if (now() - busySince > BUSY_GIVE_UP_MS) throw new ImportError('Miro kept saying it was busy for a long time, so the import stopped. Run it again later: the pictures already downloaded are kept and only the rest are fetched.');
        const until = resetAt(res.headers, now());
        hold(until && until > now() ? Math.min(until + 500, now() + 120000) : now() + busyWait, '429');
        busyWait = Math.min(60000, busyWait * 2);
        attempt--; // waiting for the allowance is not a failed try
        continue;
      }
      busySince = 0;
      if (res.status >= 500) {
        if (attempt >= RETRIES) throw new ImportError(`Miro had a problem (${res.status}). Try again in a minute; the pictures already downloaded are kept.`);
        await sleep(wait); wait *= 2; continue;
      }
      // nearly used up: wait for the next allowance now, rather than be refused
      const limit = Number(res.headers.get('x-ratelimit-limit')), left = Number(res.headers.get('x-ratelimit-remaining'));
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(left) && left < limit * LOW_ALLOWANCE) {
        const until = resetAt(res.headers, now());
        if (until && until > now()) hold(Math.min(until + 500, now() + 120000), 'low');
      }
      if (soft && res.status !== 401 && !res.ok) throw new Error(`Miro answered ${res.status}`);
      if (res.status === 401) throw new ImportError('Miro did not accept the token. Copy it again from Miro (Your apps → your app → the access token) and paste it in.');
      if (res.status === 403) throw new ImportError('The token cannot see this board. Install your Miro app into the team that has this board, then use the token it gives you.');
      if (res.status === 404) throw new ImportError('Miro could not find that board. Check the board link.');
      if (!res.ok) throw new ImportError(`Miro answered ${res.status}.`);
      return res;
    }
  }
  const json = async (token, p, signal) => (await api(token, p, signal)).json();

  // every item on the board, page by page
  async function listItems(token, boardId, onPage, signal) {
    const all = [];
    let cursor = '';
    for (let guard = 0; guard < 10000; guard++) {
      const q = `/v2/boards/${encodeURIComponent(boardId)}/items?limit=${PAGE}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const page = await json(token, q, signal);
      const data = Array.isArray(page.data) ? page.data : [];
      all.push(...data);
      if (onPage) onPage(all.length, Number(page.total) || 0);
      cursor = page.cursor || '';
      if (!cursor || !data.length) break;
    }
    return all;
  }
  async function countConnectors(token, boardId, signal) {
    try {
      let n = 0, cursor = '';
      for (let guard = 0; guard < 1000; guard++) {
        const page = await json(token, `/v2/boards/${encodeURIComponent(boardId)}/connectors?limit=${PAGE}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, signal);
        n += Array.isArray(page.data) ? page.data.length : 0;
        cursor = page.cursor || '';
        if (!cursor) break;
      }
      return n;
    } catch (e) { if (e instanceof ImportError && /Stopped/.test(e.message)) throw e; return 0; }
  }

  // One picture to disk. Miro first answers where the file is (a signed link to its storage, which
  // must be fetched without the token), or sends the file straight away.
  async function download(token, link, destNoExt, signal) {
    let wait = 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        let res = await api(token, link, signal, true);
        const ct = String(res.headers.get('content-type') || '');
        let fileUrl = '';
        if (/json/i.test(ct)) {
          const j = await res.json();
          fileUrl = j && (j.url || (j.data && j.data.url)) || '';
          if (!fileUrl) throw new Error('no file link in Miro\'s answer');
          res = await fetchImpl(fileUrl, { signal });
          if (!res.ok) throw new Error('storage answered ' + res.status);
        }
        const ext = Miro.extFor(res.headers.get('content-type'), fileUrl || link);
        const dest = destNoExt + ext;
        const tmp = dest + '.part';
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
        await fsp.rename(tmp, dest);
        return dest;
      } catch (e) {
        if (e instanceof ImportError) throw e;
        if (signal && signal.aborted) throw new ImportError('Stopped.');
        if (attempt >= RETRIES || /answered 4\d\d/.test(String(e && e.message))) throw e; // a refusal will not change on a retry
        await sleep(wait); wait *= 2;
      }
    }
  }

  // The whole import. onProgress({ phase, done, total, note }); returns { sessionPath, dir, report, summary }.
  // boardDir(boardId): the folder this board was imported into before, if any (main keeps the list);
  // an import of the same board always continues there, whatever folder the window names
  // miroCopy: what the user copied in Miro, read off the clipboard by main (lib/miroclip.js):
  // { boardId, crops: Map(itemId -> crop) }. Its crops are Miro's own, so they win over everything.
  async function run({ boardUrl, token, root, onProgress = () => {}, signal, boardDir = () => null, rememberDir = () => {}, miroCopy = null } = {}) {
    let lastPhase = { phase: 'board' };
    const progress = (p) => { lastPhase = p; onProgress(p); };
    // while Miro has asked for a pause, the window says so (and counts down) instead of looking stuck
    onWait = (ms) => onProgress({ ...lastPhase, waiting: Math.ceil(ms / 1000), note: `Miro asked Ozy to slow down (it limits how much an app may fetch a minute). Carrying on in ${Math.ceil(ms / 1000)} s… ${lastPhase.done != null && lastPhase.total ? `(${lastPhase.done} of ${lastPhase.total} pictures done)` : ''}`.trim() });
    const boardId = Miro.boardId(boardUrl);
    if (!boardId) throw new ImportError('That does not look like a Miro board link. Open the board in Miro and copy the address from the browser.');
    const tok = String(token || '').trim();
    if (!tok) throw new ImportError('Paste your Miro access token first.');
    if (!root) throw new ImportError('Pick a folder for the import.');
    progress({ phase: 'board', note: 'Asking Miro about the board…' });
    const info = await json(tok, `/v2/boards/${encodeURIComponent(boardId)}`, signal);
    const name = String(info.name || 'Miro board');
    const before = boardDir(boardId);
    const dir = before && fs.existsSync(path.join(before, 'miro-items.json')) ? before : path.join(root, safeDirName(name));
    if (dir === before && path.resolve(path.dirname(before)).toLowerCase() !== path.resolve(root).toLowerCase()) progress({ phase: 'board', note: `This board was imported before into ${before}; carrying on there so nothing is fetched twice` });
    const imgDir = path.join(dir, 'images');
    const prevDir = path.join(imgDir, 'previews');
    await fsp.mkdir(prevDir, { recursive: true });
    rememberDir(boardId, dir); // at once: a run stopped part way still continues here next time
    log('info', 'miro import started', { board: boardId, name, dir });

    progress({ phase: 'items', done: 0, total: 0, note: 'Reading the board…' });
    const items = await listItems(tok, boardId, (done, total) => progress({ phase: 'items', done, total, note: `Reading the board: ${done}${total ? ' of ' + total : ''} items` }), signal);
    const connectors = await countConnectors(tok, boardId, signal);
    await fsp.writeFile(path.join(dir, 'miro-items.json'), JSON.stringify({ board: { id: boardId, name, readAt: new Date().toISOString() }, connectors, items }, null, 1));

    // What is already here, worked out before anything is fetched (lib/miroimport.js planDownloads):
    // pictures an earlier run listed, files an interrupted run left without listing them, and one
    // download for a picture the board uses more than once.
    const manifestPath = path.join(dir, 'miro-import.json');
    const plan = await planDownloads(items, dir);
    const files = new Map(Object.entries(plan.known)); // never shortened: what earlier runs found stays listed
    const images = plan.groups;
    let done = 0, failed = 0;
    const saveManifest = () => fsp.writeFile(manifestPath, JSON.stringify({ board: boardId, files: Object.fromEntries(files), names: plan.names }, null, 1)).catch(() => {});
    let lastSave = Date.now();
    const need = images.filter((g) => !g.entry || !g.entry.thumb).length;
    log('info', 'miro pictures planned', { pictures: plan.pictures, items: plan.imageItems, alreadyHere: plan.have, toFetch: plan.need, previewsToFetch: plan.needPreview });
    const queue = images.slice();
    const tick = (note) => progress({ phase: 'images', done, total: images.length, failed, note });
    tick(images.length ? (plan.have ? `${plan.have} of ${images.length} pictures are already in the folder; fetching the other ${images.length - plan.have}` : `Downloading pictures: 0 of ${images.length}`) : 'No pictures on this board');
    const record = (g, entry) => { for (const k of g.keys) files.set(k, entry); };
    async function worker() {
      while (queue.length) {
        if (signal && signal.aborted) throw new ImportError('Stopped.');
        const g = queue.shift();
        let entry = g.entry ? { ...g.entry } : null;
        try {
          if (!entry) {
            if (!g.links) throw new Error('no picture link');
            entry = { path: await download(tok, g.links.original, path.join(imgDir, g.base), signal), thumb: null };
            record(g, entry); // listed the moment it is on disk, so a stop now never fetches it again
          }
          if (!entry.thumb && g.links) {
            try { entry.thumb = await download(tok, g.links.preview, path.join(prevDir, path.basename(entry.path, path.extname(entry.path))), signal); } catch (e) { if (e instanceof ImportError) throw e; } // a preview is a nicety
          }
          record(g, entry);
        } catch (e) {
          if (e instanceof ImportError) throw e;
          failed++;
          log('warn', 'miro picture failed', { items: g.keys, error: String(e && e.message || e) });
        }
        done++;
        tick(`Pictures: ${done} of ${images.length}${plan.have ? ` (${plan.have} were already here)` : ''}${failed ? `, ${failed} failed` : ''}`);
        if (Date.now() - lastSave > 3000) { lastSave = Date.now(); await saveManifest(); }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, need)) }, worker));
    } finally { await saveManifest(); }
    void need;

    progress({ phase: 'session', note: 'Laying out the board…' });
    // each picture's real size (read from the file's first bytes): a picture whose shape on the
    // board is not its file's is cropped in Miro
    for (const e of new Set(files.values())) if (e && e.path && !e.size) e.size = await ImageSize.ofFile(e.path);
    await saveManifest();
    const out = await writeBoard({ dir, boardId, name, items, files, connectors, failed, miroCopy, log });
    log('info', 'miro import finished', { board: boardId, items: items.length, images: images.length, failed, records: out.records });
    return { sessionPath: out.sessionPath, dir, boardId, report: out.report, summary: out.summary, failed, items: items.length };
  }
  return { run, api, listItems, download };
}

// What Miro's copy of a board says, kept beside it (miro-layers.json), so a later import keeps
// Miro's layer order, text heights and styles without a fresh copy. Maps <-> plain objects.
function copyToJson(c) {
  const obj = (m) => Object.fromEntries(m || []);
  return { readAt: new Date().toISOString(), order: obj(c.order), heights: obj(c.heights), styles: obj(c.styles), positions: obj(c.positions), frames: c.frames || [], lines: c.lines || [], paints: c.paints || [] };
}
function copyFromJson(j) {
  const map = (o) => new Map(Object.entries(o || {}));
  return { order: map(j.order), heights: map(j.heights), styles: map(j.styles), positions: map(j.positions), frames: Array.isArray(j.frames) ? j.frames : [], lines: Array.isArray(j.lines) ? j.lines : [], paints: Array.isArray(j.paints) ? j.paints : [] };
}

// The board file from what is on disk: Miro's items, the pictures (files: Map(itemId -> entry)),
// the crops and Miro's copy (fresh, or kept from before). Used by an import, and by rebuildBoard.
// (failed: pictures this import could not download; notFetched: ones no import has fetched yet,
// for a rebuild that does not ask Miro)
async function writeBoard({ dir, boardId, name, items, files, connectors = 0, failed = 0, notFetched = 0, miroCopy = null, log = () => {} }) {
  // Crops known for this board (miro-crops.json): Miro's own, read from a copy of the board
  // (source: 'miro'), and any worked out from screenshots. A copy made now is added to the file,
  // so later imports keep its crops without copying again. Its layers, heights and text styles
  // are kept the same way (miro-layers.json).
  const cropsPath = path.join(dir, 'miro-crops.json');
  const layersPath = path.join(dir, 'miro-layers.json');
  let rawCrops = {};
  try { rawCrops = JSON.parse(await fsp.readFile(cropsPath, 'utf8')) || {}; } catch {}
  let copy = null;
  try { copy = copyFromJson(JSON.parse(await fsp.readFile(layersPath, 'utf8'))); } catch {}
  let copyNote = '';
  if (miroCopy && ((miroCopy.crops && miroCopy.crops.size) || (miroCopy.order && miroCopy.order.size))) {
    if (miroCopy.boardId && miroCopy.boardId !== boardId) copyNote = 'What is copied in Miro is from another board, so it was not used here.';
    else {
      for (const [id, c] of miroCopy.crops || []) rawCrops[id] = { x: c.x, y: c.y, w: c.w, h: c.h, score: 1, source: 'miro' };
      await fsp.writeFile(cropsPath, JSON.stringify(rawCrops, null, 1));
      if (miroCopy.order && miroCopy.order.size) {
        copy = { order: miroCopy.order, heights: miroCopy.heights || new Map(), styles: miroCopy.styles || new Map(), positions: miroCopy.positions || new Map(), frames: miroCopy.frames || [], lines: miroCopy.lines || [], paints: miroCopy.paints || [] };
        await fsp.writeFile(layersPath, JSON.stringify(copyToJson(copy)));
      }
      log('info', 'miro copy used', { crops: (miroCopy.crops || new Map()).size, layers: (miroCopy.order || new Map()).size });
    }
  }
  const crops = new Map(Object.entries(rawCrops).filter(([, c]) => c && !(Number(c.score) < CROP_TRUST)));
  const { records, report } = Miro.toRecords(items, files, { youtube: youtubeOf, crops, copy });
  const session = {
    format: 'multi-video-player-session', version: 6, savedAt: new Date().toISOString(),
    layout: { mode: 'board', board: null, background: 'light', linked: false }, // Miro boards are white; nothing pushed apart on open
    masterVolume: 1, videos: records, groups: [], favFolders: [],
    importedFrom: { service: 'miro', board: boardId, name, at: new Date().toISOString() },
  };
  // The board file. If the one an earlier import wrote has been saved over since (moved things,
  // notes added), it is left alone and this import goes next to it under a dated name.
  // (A file Ozy saves has no importedFrom; only an import's own, untouched, does.)
  let sessionPath = path.join(dir, safeDirName(name) + '.mvp');
  let existing = null;
  try { existing = JSON.parse(String(await fsp.readFile(sessionPath, 'utf8')).replace(/^﻿/, '')); } catch (e) { existing = e && e.code === 'ENOENT' ? null : {}; }
  if (existing && !existing.importedFrom) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    sessionPath = path.join(dir, `${safeDirName(name)} (imported ${stamp}).mvp`);
  }
  await fsp.writeFile(sessionPath, JSON.stringify(session, null, 1));
  const summary = Miro.describe(report, connectors) + (copyNote ? `\n${copyNote}` : '') + (failed ? `\n${failed} picture${failed === 1 ? '' : 's'} could not be downloaded; run the import again to retry just those.` : '')
    + (notFetched ? `\n${notFetched} picture${notFetched === 1 ? ' is' : 's are'} not downloaded yet (link previews from an older import); Import from Miro fetches ${notFetched === 1 ? 'it' : 'them'}.` : '');
  return { sessionPath, report, summary, records: records.length };
}

// Lay an imported board out again from what is already in its folder (the items Miro listed, the
// pictures, the crops), without asking Miro for anything: for a new copy of the board made in
// Miro (crops, layers), or after Ozy's import rules got better. Returns what writeBoard does.
async function rebuildBoard(dir, { miroCopy = null, log = () => {} } = {}) {
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'miro-items.json'), 'utf8'));
  const items = Array.isArray(saved.items) ? saved.items : [];
  const boardId = saved.board && saved.board.id, name = (saved.board && saved.board.name) || path.basename(dir);
  const plan = await planDownloads(items, dir);
  const files = new Map(Object.entries(plan.known));
  for (const e of new Set(files.values())) if (e && e.path && !e.size) e.size = await ImageSize.ofFile(e.path);
  return writeBoard({ dir, boardId, name, items, files, connectors: Number(saved.connectors) || 0, notFetched: plan.need, miroCopy, log });
}

// a YouTube link inside a Miro embed -> { kind } for Ozy's YouTube tile
function youtubeOf(url) {
  const s = String(url || '');
  return /(?:youtube\.com\/(?:watch\?|embed\/|shorts\/)|youtu\.be\/)/i.test(s) ? { kind: 'video' } : null;
}

module.exports = { createImporter, planDownloads, writeBoard, rebuildBoard, ImportError, safeDirName, youtubeOf };
