# Performance Implementation Plan (plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a heavy scene run well: sessions and pastes open paused, offscreen videos stop decoding, local videos can play at ½ or ¼ resolution per tile or per scene, the proxy cache has a location and a cap, and a load viewer shows what Ozy costs versus the rest of the machine.

**Architecture:** Pure rules in new `lib/` modules with `node --test` coverage (`lib/visibility.js`, `lib/cachepolicy.js`, `lib/loadstats.js`, extensions to `lib/proxy.js`, `lib/settings.js`, `lib/session.js`). `main.js` grows tiered proxy jobs, cache trimming and a load-stats IPC; `preload.js` exposes them; `app.js` wires an **Optimize ▾** toolbar menu, a per-tile quality override in the ⚙ popover, source swapping, and the load panel.

**Tech Stack:** Vanilla JS, Electron 33 (`app.getAppMetrics`), Node `os`, ffmpeg-static, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-board-polish-and-performance-design.md`

## Global Constraints

- Branch `feat/performance` from `main` (`aab619e`). One commit per task. No version bump, tag, release or PR.
- Pure logic in `lib/*.js`, exported with `if (typeof module !== 'undefined' && module.exports) module.exports = X; else window.X = X;`, tests in `lib/<name>.test.js`, run with `npm test`. Every new lib file goes into `index.html` as `<script src="lib/<name>.js"></script>` before `app.js` (block near `index.html:403`) **and**, if `main.js` needs it, is `require`d there.
- `app.js` has a NUL byte near offset 175927: search with `grep -an` and `sed -n`, never plain `grep`/ripgrep. Line numbers are for `main` at `aab619e`; re-locate with `grep -an` before editing.
- Session version: `SESSION_VERSION` (`app.js:15`) and `Session.VERSION` (`lib/session.js:17`) become 6. Every fixture in `test-fixtures/sessions/` must still open; `lib/session.test.js` must stay green.
- Cut behaviour by commenting out in place, never deleting.
- Manual checks run the app with a separate profile: `./node_modules/.bin/electron . --user-data-dir=<scratchpad>/ozy-userdata --remote-debugging-port=9333`, never Mark's running instance. Close every window you open. CDP recipe: memory note `ozy-manual-checks-via-cdp`.
- Plan A (`feat/board-interaction`) edits `app.js` in `attachTileDrag`, `startResize`, the Tidy menu, the tile click handlers, the hover-play block, `lib/arrange.js` and `lib/settings.js`. Stay out of those regions except where a task below names them. In `lib/settings.js`, add your keys each on its own line so the merge is trivial.
- ffmpeg flags for tiers are fixed by the spec: `-vf scale=trunc(iw/D/2)*2:trunc(ih/D/2)*2` (D = 2 or 4), `-c:v libx264 -preset faster -crf 23 -pix_fmt yuv420p -c:a aac -movflags +faststart`.

## Review Focus

1. A session saved while playing must open with every tile paused and at its saved time (Task 1 manual check; `lib/session.test.js` test `open never autoplays`).
2. Offscreen pausing must never pause through `broadcast`, or one offscreen member would pause its whole synced group (Task 2 test `offscreen decisions are per tile` and the manual check with a synced group).
3. A tier swap must land on the same time, paused state and rate the tile had, and a swap requested while a previous one is still encoding must not stack two ffmpeg jobs for the same file and tier (Task 3 tests `swap restores playback state` and `one job per file and tier`).
4. Cache trimming must never delete a file newer than the cap allows and must skip files it cannot delete (Task 4 test `evicts oldest first, only as much as needed`; `main.js` ignores unlink errors).
5. The load panel must not throw when a tile has no `<video>` (web Player tiles, images, text) or when `getVideoPlaybackQuality` is missing (Task 5 test `rows tolerate tiles without a video`).

---

### Task 1: Sessions and pastes open paused

**Files:**
- Modify: `lib/session.js` (add `openRecord`), `lib/session.test.js`
- Modify: `app.js` `applySession` (grep -an `const r = await addFromRecord(v);` inside it, ~line 3708), `pasteClipboard` (`app.js:~4441`, the `addFromRecord({ ...v, sync: null })` call)

**Interfaces:**
- Produces: `Session.openRecord(v)` → a shallow copy of the record with `paused: true`, or the input unchanged when it is not an object.

- [ ] **Step 1: Write the failing test**

Append to `lib/session.test.js`:

```js
test('open never autoplays: openRecord forces paused and keeps the time', () => {
  const v = { type: 'file', path: 'a.mp4', paused: false, currentTime: 12.5 };
  const o = Session.openRecord(v);
  assert.equal(o.paused, true);
  assert.equal(o.currentTime, 12.5);
  assert.equal(v.paused, false);                 // input untouched
  assert.equal(Session.openRecord(null), null);  // bad entries pass through to buildFromRecord's own guard
});
```

(`lib/session.test.js` already requires the module as `Session`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/session.test.js`
Expected: FAIL, `Session.openRecord is not a function`.

- [ ] **Step 3: Implement**

Add to the `Session` object in `lib/session.js`:

```js
    // A file saved while playing used to resume on open (Mark, 2026-10-07). Opening and pasting
    // build every tile paused at its saved time; the file still records the real state.
    openRecord(v) { return v && typeof v === 'object' ? { ...v, paused: true } : v; },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/session.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it**

In `applySession`, change `const r = await addFromRecord(v);` to `const r = await addFromRecord(Session.openRecord(v));`.

In `pasteClipboard`, change `const r = await addFromRecord({ ...v, sync: null });` to `const r = await addFromRecord(Session.openRecord({ ...v, sync: null })); // groups aren't copied, so nor are offsets; copies start paused`.

Confirm web tiles honour it: `addWebTile` reads `state.paused === false` into `wantPlaying` (`app.js:~2528`), so `paused: true` is enough. Sequence tiles: grep -an `state.paused` in `addSequenceTile`; if they autoplay from `paused === false`, the same record fix covers them.

- [ ] **Step 6: Manual check**

Isolated profile: add two videos, play both, Save. Clear board, Open the file: both tiles sit paused at their saved times. Copy one, paste: the copy is paused. Close the app.

- [ ] **Step 7: Commit**

```bash
git add lib/session.js lib/session.test.js app.js
git commit -m "fix: opening a session or pasting never autoplays"
```

---

### Task 2: Pause what you cannot see

**Files:**
- Create: `lib/visibility.js`, `lib/visibility.test.js`
- Modify: `lib/settings.js` (`pauseOffscreen`), `lib/settings.test.js`
- Modify: `index.html` (Optimize ▾ menu, script list), `app.js` (new block after the hover-play section ~4393; hooks in `applyBoardView` ~337, `layoutTiles` ~347, `finishRects` ~1008, `#grid` scroll)

**Interfaces:**
- Produces: `Visibility.decide(items, view, margin)` where `items` is `[{ id, rect, playing, autoPaused }]` (rects and view in the same coordinate space), `view` is `{ x, y, w, h }` → `[{ id, op: 'pause' | 'resume' }]`.
- Produces: `settings.pauseOffscreen` (default `true`), `applyOffscreen()` in `app.js`, `tile.autoPaused` flag.
- Produces: the Optimize ▾ menu (`#optimize-menu`, `#opt-list`), extended by Tasks 3-5.

- [ ] **Step 1: Write the failing test**

```js
// lib/visibility.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('./visibility');

const view = { x: 0, y: 0, w: 1000, h: 600 };
test('a playing tile fully outside the view (plus margin) is paused', () => {
  const out = V.decide([{ id: 1, rect: { x: 2000, y: 0, w: 100, h: 100 }, playing: true, autoPaused: false }], view, 300);
  assert.deepEqual(out, [{ id: 1, op: 'pause' }]);
});
test('inside the margin counts as visible', () => {
  const out = V.decide([{ id: 1, rect: { x: 1200, y: 0, w: 100, h: 100 }, playing: true, autoPaused: false }], view, 300);
  assert.deepEqual(out, []);
});
test('only tiles we paused are resumed, and only once back in view', () => {
  const items = [
    { id: 1, rect: { x: 10, y: 10, w: 100, h: 100 }, playing: false, autoPaused: true },   // back: resume
    { id: 2, rect: { x: 10, y: 10, w: 100, h: 100 }, playing: false, autoPaused: false },  // the user paused it: leave it
    { id: 3, rect: { x: 5000, y: 0, w: 100, h: 100 }, playing: false, autoPaused: true },  // still away: nothing
  ];
  assert.deepEqual(V.decide(items, view, 0), [{ id: 1, op: 'resume' }]);
});
test('offscreen decisions are per tile', () => {
  const items = [
    { id: 'a', rect: { x: 10, y: 10, w: 100, h: 100 }, playing: true, autoPaused: false },
    { id: 'b', rect: { x: 9000, y: 10, w: 100, h: 100 }, playing: true, autoPaused: false },
  ];
  assert.deepEqual(V.decide(items, view, 0), [{ id: 'b', op: 'pause' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/visibility.test.js`
Expected: FAIL, `Cannot find module './visibility'`.

- [ ] **Step 3: Implement**

```js
// lib/visibility.js
// Offscreen pause: a video nobody can see should not be decoding. Pure: the caller measures the
// rects and carries out the ops. The margin keeps a tile just outside the view running so a
// small pan doesn't stutter it; `autoPaused` makes sure only what we paused gets resumed.
{
  const Visibility = {
    decide(items, view, margin = 0) {
      const vx0 = view.x - margin, vy0 = view.y - margin, vx1 = view.x + view.w + margin, vy1 = view.y + view.h + margin;
      const out = [];
      for (const it of items) {
        const r = it.rect;
        const visible = r.x < vx1 && r.x + r.w > vx0 && r.y < vy1 && r.y + r.h > vy0;
        if (!visible && it.playing) out.push({ id: it.id, op: 'pause' });
        else if (visible && it.autoPaused && !it.playing) out.push({ id: it.id, op: 'resume' });
      }
      return out;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Visibility;
  else window.Visibility = Visibility;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/visibility.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Setting**

`lib/settings.js` `defaults()`: add `pauseOffscreen: true`. `merge()`: add `pauseOffscreen: s.pauseOffscreen !== false,` on its own line. Test (append at the end of `lib/settings.test.js`, where the module is `S`):

```js
test('pauseOffscreen is on unless explicitly false', () => {
  assert.equal(S.merge({}).pauseOffscreen, true);
  assert.equal(S.merge({ pauseOffscreen: false }).pauseOffscreen, false);
});
```

- [ ] **Step 6: Optimize menu and wiring**

`index.html`: after the `#app-menu` div (closes at line 38) add:

```html
    <div class="menu" id="optimize-menu">
      <button id="btn-optimize" title="Make a heavy scene lighter: pause what is off screen, play at a lower resolution, see what the scene costs">Optimize ▾</button>
      <div class="menu-list" id="opt-list" hidden>
        <label class="menu-check" title="A video scrolled out of view stops decoding and resumes when it comes back"><input type="checkbox" id="opt-offscreen"> Pause offscreen videos</label>
      </div>
    </div>
```

Add `<script src="lib/visibility.js"></script>` to the script list.

`app.js`, after the hover-play block (after `hoverPlayBtn.addEventListener(...)`, ~4393):

```js
// ---------- Optimize menu ----------
const optMenu = document.getElementById('optimize-menu');
const optList = document.getElementById('opt-list');
document.getElementById('btn-optimize').addEventListener('click', (e) => { e.stopPropagation(); optList.hidden = !optList.hidden; });
window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !optMenu.contains(e.target)) optList.hidden = true; });

// ---------- offscreen pause ----------
// A playing tile whose element is entirely out of the viewport (plus half a viewport of margin)
// is paused without touching its group, and resumed when it comes back; a synced member is
// re-seeked to the group time first so it stays in step. Rules in lib/visibility.js.
const OFFSCREEN_MARGIN = 0.5; // of the viewport, each side
const offscreenOn = () => !!(settings && settings.pauseOffscreen) && !hoverPlayOn() && cmp.el.hidden && !document.fullscreenElement;
function applyOffscreen() {
  if (!offscreenOn()) return;
  const r = gridRect();
  const view = { x: r.left, y: r.top, w: r.width, h: r.height };
  const items = tiles.filter((t) => t.pb && t.el.isConnected && (isBoard() ? !!t.board : !t.freeAspect)).map((t) => {
    const b = t.el.getBoundingClientRect();
    return { id: t, rect: { x: b.left, y: b.top, w: b.width, h: b.height }, playing: !t.pb.paused, autoPaused: !!t.autoPaused };
  });
  for (const a of Visibility.decide(items, view, Math.max(r.width, r.height) * OFFSCREEN_MARGIN)) {
    const t = a.id;
    if (a.op === 'pause') { t.pb.pause(); t.autoPaused = true; }          // no broadcast: the group keeps playing
    else {
      t.autoPaused = false;
      const g = t.group;
      if (g && g.sync && t.sync) t.pb.time = Math.max(0, groupTimeOf(g) - t.sync.start);
      t.pb.play();
    }
  }
}
let offscreenTimer = null;
function scheduleOffscreen() { clearTimeout(offscreenTimer); offscreenTimer = setTimeout(applyOffscreen, 50); }
setInterval(() => { if (!document.hidden) applyOffscreen(); }, 500);
grid.addEventListener('scroll', scheduleOffscreen, { passive: true });
const optOffscreen = document.getElementById('opt-offscreen');
function setPauseOffscreen(on) {
  settings.pauseOffscreen = !!on;
  saveSettings();
  optOffscreen.checked = settings.pauseOffscreen;
  if (settings.pauseOffscreen) applyOffscreen();
  else for (const t of tiles) if (t.autoPaused) { t.autoPaused = false; if (t.pb) t.pb.play(); } // give back what we paused
  setStatus(settings.pauseOffscreen ? 'Offscreen videos pause until they come back into view' : 'Offscreen videos keep playing');
}
optOffscreen.addEventListener('change', () => setPauseOffscreen(optOffscreen.checked));
```

Hooks: add `scheduleOffscreen();` as the last line of `applyBoardView` (~337) and `layoutTiles` (~347), and inside `finishRects` (~1008) after it pushes the undo entry. Where settings are applied after load (the block that sets `wheelZoomEl.checked`, grep -an `wheelZoomEl.checked =`), add `optOffscreen.checked = settings.pauseOffscreen;`.

User pause must clear the flag: in `videoPlayback` (`app.js:211`) nothing changes; instead, in `addVideo`'s `onPlayState` (~1998) add `if (!video.paused) tile.autoPaused = false;` so any play, by anyone, clears it. Do the same in the web tile's state handler (grep -an `onPlayState` in `addWebTile`) and the sequence tile's.

`groupTimeOf(g)` exists at `app.js:594`. `gridRect()` at `:267`. `cmp` is the compare view object used by `hoverPlayBusy`.

- [ ] **Step 7: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: six videos on the board, Play all, zoom in so only two are visible: within a second the others pause (their ▶ buttons show) while the two keep playing. Zoom out: they resume. Group two with Sync on, play the group, pan one member off screen: the visible member keeps playing; pan back: the other resumes at the group time. Untick "Pause offscreen videos": everything we paused resumes. Close the app.

- [ ] **Step 8: Commit**

```bash
git add lib/visibility.js lib/visibility.test.js lib/settings.js lib/settings.test.js app.js index.html
git commit -m "feat: offscreen videos pause until they are back in view"
```

---

### Task 3: Playback resolution tiers

**Files:**
- Modify: `lib/proxy.js` (`name`, `args` take a tier; `TIERS`), `lib/proxy.test.js`
- Modify: `lib/session.js` (`VERSION` 6, `layout.quality`, `tileQuality`), `lib/session.test.js`
- Modify: `main.js:437-519` (`proxyPathFor`, `probe`, `make-proxy`, `cancel-proxy`), `preload.js` (`makeProxy`, `cancelProxy`, `onProxyProgress`)
- Modify: `app.js` — `SESSION_VERSION` (:15), `layout` (:42), `addVideo` (:1810-1992: tile fields, source choice, a `swapSource`), `collectSession` (:3578-3640 layout + file branch), `applySession` layout read, ⚙ popover (:3421-3445), Optimize menu block (Task 2), proxy-progress listener (:3564)
- Modify: `index.html` (Optimize menu radios), `style.css` (`.q-badge`)

**Interfaces:**
- Produces: `ProxyCache.TIERS = ['full', 'half', 'quarter']`, `ProxyCache.divisor(tier)` → 1 | 2 | 4, `ProxyCache.name(originalPath, size, mtimeMs, tier = 'full')` (unchanged name for `'full'`; `-half.mp4` / `-quarter.mp4` otherwise), `ProxyCache.args(input, output, tier = 'full')`.
- Produces: `Session.quality(v)` → `'full' | 'half' | 'quarter'` from a layout record (default `'full'`), `Session.tileQuality(v)` → `'scene' | 'full' | 'half' | 'quarter'` (default `'scene'`).
- Produces: IPC `probe` result gains `tiers: { half: path|null, quarter: path|null }`; `make-proxy(filePath, tier)`; `cancel-proxy(filePath, tier)`; `proxy-progress(filePath, frac, tier)`.
- Produces in `app.js`: `layout.quality`, `tile.quality`, `tile.tiers`, `effectiveQuality(tile)`, `applyQuality(tile)`, `setSceneQuality(q)`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/proxy.test.js`:

```js
test('tier names: full keeps the old name, the others carry the tier', () => {
  const full = ProxyCache.name('C:\\v\\a.mov', 10, 20);
  assert.equal(ProxyCache.name('C:\\v\\a.mov', 10, 20, 'full'), full);
  assert.equal(ProxyCache.name('C:\\v\\a.mov', 10, 20, 'half'), full.replace(/\.mp4$/, '-half.mp4'));
  assert.equal(ProxyCache.name('C:\\v\\a.mov', 10, 20, 'quarter'), full.replace(/\.mp4$/, '-quarter.mp4'));
});
test('tier args scale to even dimensions and use the lighter preset', () => {
  const a = ProxyCache.args('in.mov', 'out.mp4', 'half');
  const vf = a[a.indexOf('-vf') + 1];
  assert.equal(vf, 'scale=trunc(iw/2/2)*2:trunc(ih/2/2)*2');
  assert.equal(a[a.indexOf('-preset') + 1], 'faster');
  assert.equal(a[a.indexOf('-crf') + 1], '23');
  assert.ok(!ProxyCache.args('in.mov', 'out.mp4').includes('-vf'));              // full: no scaling, as before
  assert.equal(ProxyCache.args('in.mov', 'out.mp4', 'quarter')[ProxyCache.args('in.mov', 'out.mp4', 'quarter').indexOf('-vf') + 1], 'scale=trunc(iw/4/2)*2:trunc(ih/4/2)*2');
});
test('divisor', () => { assert.equal(ProxyCache.divisor('full'), 1); assert.equal(ProxyCache.divisor('half'), 2); assert.equal(ProxyCache.divisor('quarter'), 4); assert.equal(ProxyCache.divisor('nonsense'), 1); });
```

(`lib/proxy.test.js` already requires the module as `ProxyCache`.)

Append to `lib/session.test.js`:

```js
test('quality: scene default is full, tile default is scene, junk falls back', () => {
  assert.equal(Session.quality({}), 'full');
  assert.equal(Session.quality({ quality: 'half' }), 'half');
  assert.equal(Session.quality({ quality: 'tiny' }), 'full');
  assert.equal(Session.tileQuality({}), 'scene');
  assert.equal(Session.tileQuality({ quality: 'quarter' }), 'quarter');
  assert.equal(Session.tileQuality({ quality: 7 }), 'scene');
});
test('VERSION is 6', () => { assert.equal(Session.VERSION, 6); });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/proxy.test.js lib/session.test.js`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement the lib side**

`lib/proxy.js`:

```js
// Naming and command-line details for ffmpeg H.264 proxies: the playable copy ('full', the
// original size) and the playback tiers ('half', 'quarter') Mark asked for so a heavy scene can be
// dropped like Premiere's 1/2 and 1/4. Named ProxyCache so it never shadows the built-in Proxy.
const ProxyCache = {
  TIERS: ['full', 'half', 'quarter'],
  divisor(tier) { return tier === 'half' ? 2 : tier === 'quarter' ? 4 : 1; },
  name(originalPath, size, mtimeMs, tier = 'full') {
    const crypto = require('crypto');
    const base = crypto.createHash('sha1').update(`${originalPath}|${size}|${mtimeMs}`).digest('hex');
    return base + (tier === 'half' || tier === 'quarter' ? `-${tier}` : '') + '.mp4';
  },
  args(input, output, tier = 'full') {
    const d = ProxyCache.divisor(tier);
    if (d === 1) {
      return ['-y', '-i', input, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output];
    }
    return ['-y', '-i', input, '-vf', `scale=trunc(iw/${d}/2)*2:trunc(ih/${d}/2)*2`,
      '-c:v', 'libx264', '-preset', 'faster', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output];
  },
  parseTime(chunk) { /* unchanged */ },
};
```

(Keep the existing `parseTime` body.)

`lib/session.js`: set `VERSION: 6`; add to the `Session` object:

```js
    // playback resolution: the scene's tier, and a tile's own override ('scene' = follow the scene)
    quality(raw) { const q = raw && raw.quality; return q === 'half' || q === 'quarter' ? q : 'full'; },
    tileQuality(raw) { const q = raw && raw.quality; return q === 'full' || q === 'half' || q === 'quarter' ? q : 'scene'; },
```

Also make `Session.layout(raw)` return `quality: Session.quality(lay)` alongside its other fields (find the returned object in `layout()` and add the key; the existing layout tests should not care about an extra key, but run them).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/proxy.test.js lib/session.test.js`
Expected: PASS.

- [ ] **Step 5: Main process and preload**

`main.js`:

```js
function proxyPathFor(filePath, stat, tier = 'full') {
  return path.join(proxyDir(), ProxyCache.name(filePath, stat.size, stat.mtimeMs, tier));
}
```

In the `probe` handler, after `if (fs.existsSync(proxy)) base.proxy = proxy;` add:

```js
  base.tiers = { half: null, quarter: null };
  for (const tier of ['half', 'quarter']) { const p = proxyPathFor(filePath, stat, tier); if (fs.existsSync(p)) base.tiers[tier] = p; }
```

and add `tiers: { half: null, quarter: null }` to the `base` literal so a dead-share return has the field.

`make-proxy`: change the handler signature to `(e, filePath, tier = 'full')`, key jobs by `${filePath}|${tier}` (`proxyJobs.set(key, ...)`, `proxyJobs.delete(key)`), use `proxyPathFor(filePath, stat, tier)` and `ProxyCache.args(filePath, tmp, tier)`, and send progress as `send(filePath, frac, tier)` (both the `0.99` and the final `1`). Log lines: include `tier` in the data object. If a job for the same key is already running, return its promise instead of queueing another:

```js
  const key = `${filePath}|${tier}`;
  const running = proxyPending.get(key);
  if (running) return running;
  const p = proxyQueue.then(run, run);
  proxyPending.set(key, p);
  p.finally(() => proxyPending.delete(key)).catch(() => {});
  proxyQueue = p.catch(() => {});
  return p;
```

with `const proxyPending = new Map();` next to `proxyJobs`. `cancel-proxy`: `(_e, filePath, tier = 'full')` looks up `proxyJobs.get(`${filePath}|${tier}`)`. `clear-cache` already kills every job.

`preload.js`:

```js
  makeProxy: (p, tier) => ipcRenderer.invoke('make-proxy', p, tier || 'full'),
  cancelProxy: (p, tier) => ipcRenderer.send('cancel-proxy', p, tier || 'full'),
  onProxyProgress: (cb) => ipcRenderer.on('proxy-progress', (_e, p, frac, tier) => cb(p, frac, tier || 'full')),
```

- [ ] **Step 6: Renderer: scene and tile quality**

`app.js:15`: `const SESSION_VERSION = 6;`. `app.js:42`: add `quality: 'full'` to the `layout` object.

In `addVideo`, next to `tile.fpsOverride = ...` (~1843) add:

```js
  tile.quality = Session.tileQuality(state);      // 'scene' | 'full' | 'half' | 'quarter'
  tile.tiers = { half: null, quarter: null };       // cached tier files found by probe / made on demand
  tile.tier = 'full';                               // what is loaded right now
  tile.tierJob = null;                              // tier being encoded, if any
```

Add these helpers after `tile.setSource = ...` (~1941):

```js
  // the tier this tile should play: its own override, else the scene's
  const wanted = () => (tile.quality === 'scene' ? layout.quality : tile.quality);
  const fullUrl = () => window.api.videoUrl(tile.proxy || filePath);
  // change the file behind the <video> without losing where it was
  tile.swapSource = (url) => {
    const at = video.currentTime, wasPaused = video.paused, r = video.playbackRate;
    const once = () => {
      video.removeEventListener('loadedmetadata', once);
      if (at > 0) video.currentTime = isFinite(video.duration) ? Math.min(at, video.duration) : at;
      video.playbackRate = r;
      if (!wasPaused) video.play().catch(() => {});
    };
    video.addEventListener('loadedmetadata', once);
    tile.setSource(url);
  };
  const qBadge = el.querySelector('.q-badge');
  const showBadge = (text) => { qBadge.textContent = text; qBadge.hidden = !text; };
  tile.applyQuality = async () => {
    if (!tile.info) return;                          // probe not back yet; the probe's own branch calls this
    const want = wanted();
    if (want === tile.tier) { showBadge(want === 'full' ? '' : (want === 'half' ? '½' : '¼')); return; }
    if (want === 'full') { tile.tier = 'full'; tile.swapSource(fullUrl()); showBadge(''); return; }
    if (tile.tiers[want]) { tile.tier = want; tile.swapSource(window.api.videoUrl(tile.tiers[want])); showBadge(want === 'half' ? '½' : '¼'); return; }
    if (!tile.info.available) { showBadge(''); setStatus('ffmpeg not found – playback quality needs it', 6000); return; }
    if (tile.tierJob === want) return;               // already encoding this one
    tile.tierJob = want;
    showBadge((want === 'half' ? '½' : '¼') + ' 0%');
    try {
      const { proxy } = await window.api.makeProxy(filePath, want);
      if (!tiles.includes(tile)) return;
      tile.tiers[want] = proxy;
    } catch (e) {
      if (tiles.includes(tile)) { showBadge(''); logUi('warn', 'tier failed', { path: filePath, tier: want, error: String(e.message) }); }
      return;
    } finally { tile.tierJob = null; }
    if (wanted() === want) tile.applyQuality();      // still wanted once it is done
    else showBadge('');
  };
  tile.onTierProgress = (frac, tier) => { if (tile.tierJob === tier) showBadge((tier === 'half' ? '½' : '¼') + ' ' + Math.round(frac * 100) + '%'); };
```

In the probe branch (~1963-1972): after `tile.info = info; tile.fps = info.fps || null;` add `tile.tiers = info.tiers || tile.tiers;`. Keep the existing source choice, then as the last line of the async block add `tile.applyQuality();` (so a tile added into a ½ scene starts encoding at once; `tile.tier` is `'full'` from the initial source).

Per-tile override: in `openTileSettings` (~3421), for non-sequence tiles that have `tile.applyQuality`, add after the frame-rate row:

```js
  if (tile.applyQuality) {
    const q = document.createElement('select');
    for (const [v, label] of [['scene', 'Scene default'], ['full', 'Full'], ['half', '½ resolution'], ['quarter', '¼ resolution']]) { const o = document.createElement('option'); o.value = v; o.textContent = label; q.appendChild(o); }
    q.value = tile.quality;
    row('Playback quality', q);
    q.addEventListener('change', () => { tile.quality = q.value; tile.applyQuality(); refreshSettingsMark(tile); });
    note('Lower = lighter on the machine. A smaller copy is made once and cached.');
  }
```

and in `refreshSettingsMark` make the non-sequence condition `!!tile.fpsOverride || (tile.quality && tile.quality !== 'scene')`.

Scene control: `index.html`, inside `#opt-list` after the offscreen checkbox:

```html
        <div class="menu-title">Playback quality <small>local videos; each tile's ⚙ can override</small></div>
        <label class="menu-check"><input type="radio" name="opt-quality" value="full"> Full</label>
        <label class="menu-check"><input type="radio" name="opt-quality" value="half"> ½ resolution</label>
        <label class="menu-check"><input type="radio" name="opt-quality" value="quarter"> ¼ resolution</label>
```

(Add a `.menu-title` style in `style.css` if one does not exist: `.menu-title { padding: 6px 10px 2px; color: var(--muted); font-size: 12px; } .menu-title small { display: block; }`.)

`app.js` in the Optimize block:

```js
function setSceneQuality(q) {
  layout.quality = q === 'half' || q === 'quarter' ? q : 'full';
  for (const r of document.querySelectorAll('input[name="opt-quality"]')) r.checked = r.value === layout.quality;
  for (const t of tiles) if (t.applyQuality) t.applyQuality();
  setStatus(layout.quality === 'full' ? 'Playing at full resolution' : `Playing at ${layout.quality === 'half' ? '½' : '¼'} resolution – smaller copies are made as needed`);
}
for (const r of document.querySelectorAll('input[name="opt-quality"]')) r.addEventListener('change', () => { if (r.checked) setSceneQuality(r.value); });
```

Progress: replace the listener at `~3564` with
`window.api.onProxyProgress((p, frac, tier) => { const t = tiles.find((x) => x.path === p); if (!t) return; if (tier === 'full') { if (t.onProxyProgress) t.onProxyProgress(frac); } else if (t.onTierProgress) t.onTierProgress(frac, tier); });`

Badge markup: in `#tile-template` (`index.html:227`), inside `.overlay .top` after `.name`, add `<span class="q-badge" hidden title="Playback quality (⚙ to change)"></span>`; `style.css`: `.q-badge { font-size: 11px; padding: 0 6px; border-radius: 4px; background: rgba(255,255,255,0.15); white-space: nowrap; }`.

Session: in `collectSession` add `quality: layout.quality,` to the `layout` object and `quality: t.quality || 'scene',` to the file-tile branch (next to `fpsOverride`). In `applySession`, where `layout.*` fields are restored from `Session.layout(data.layout)` (grep -an `timelineHeight` inside `applySession`), add `setSceneQuality(lay.quality)` (or set `layout.quality = lay.quality` before tiles are built and call `setSceneQuality(layout.quality)` after, so the radios sync; either order works because `applyQuality` is a no-op until the probe returns). Reset to `'full'` in `clearAll` (grep -an `^function clearAll`).

- [ ] **Step 7: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: add a 1080p video, play it, Optimize ▾ → ½: the badge counts up, then the tile swaps to the smaller copy at the same time and keeps playing; the title-bar badge shows ½. ⚙ on the tile → Full: it goes back. Save, clear, open: the scene radio and the tile's override are restored. Check `userData/proxies` has a `-half.mp4`. Run ffprobe on it: height is half the original (even). Close the app.

- [ ] **Step 8: Commit**

```bash
git add lib/proxy.js lib/proxy.test.js lib/session.js lib/session.test.js main.js preload.js app.js index.html style.css
git commit -m "feat: playback resolution tiers (full, half, quarter) per scene and per tile"
```

---

### Task 4: Cache location and cap

**Files:**
- Create: `lib/cachepolicy.js`, `lib/cachepolicy.test.js`
- Modify: `lib/settings.js` (`cacheDir`, `cacheCapMB`), `lib/settings.test.js`
- Modify: `main.js` (`proxyDir`, trim after a job, `pick-cache-folder`, `cache-info` returns cap), `preload.js`, `app.js` (Optimize menu cache row), `index.html`

**Interfaces:**
- Produces: `CachePolicy.evict(files, capBytes)` where `files` is `[{ path, size, atimeMs }]` → array of paths to delete, oldest `atimeMs` first, until the remaining total is ≤ `capBytes`.
- Produces: settings `cacheDir: string|null`, `cacheCapMB: number` (default 20480, min 512).
- Produces: IPC `pick-cache-folder` → `string|null`; `cache-info` → `{ bytes, files, capMB, dir }`.

- [ ] **Step 1: Write the failing test**

```js
// lib/cachepolicy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./cachepolicy');

test('under the cap nothing is evicted', () => {
  assert.deepEqual(C.evict([{ path: 'a', size: 100, atimeMs: 1 }], 1000), []);
});
test('evicts oldest first, only as much as needed', () => {
  const files = [
    { path: 'new', size: 400, atimeMs: 300 },
    { path: 'old', size: 400, atimeMs: 100 },
    { path: 'mid', size: 400, atimeMs: 200 },
  ];
  assert.deepEqual(C.evict(files, 800), ['old']);
  assert.deepEqual(C.evict(files, 400), ['old', 'mid']);
  assert.deepEqual(C.evict(files, 0), ['old', 'mid', 'new']);
});
test('tolerates junk entries', () => {
  assert.deepEqual(C.evict([{ path: 'x', size: NaN, atimeMs: null }, { path: 'y', size: 10, atimeMs: 5 }], 5), ['x', 'y']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/cachepolicy.test.js`
Expected: FAIL, `Cannot find module './cachepolicy'`.

- [ ] **Step 3: Implement**

```js
// lib/cachepolicy.js
// Which cached files to drop to get back under the cap: least recently used first. The caller
// lists the folder and deletes; anything it can't delete (in use) just stays for next time.
{
  const CachePolicy = {
    evict(files, capBytes) {
      const list = (Array.isArray(files) ? files : []).map((f) => ({ path: f.path, size: Number(f.size) || 0, atimeMs: Number(f.atimeMs) || 0 }));
      let total = list.reduce((s, f) => s + f.size, 0);
      const cap = Number(capBytes) || 0;
      const out = [];
      for (const f of list.sort((a, b) => a.atimeMs - b.atimeMs)) {
        if (total <= cap) break;
        out.push(f.path); total -= f.size;
      }
      return out;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CachePolicy;
  else window.CachePolicy = CachePolicy;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/cachepolicy.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Settings, main, preload**

`lib/settings.js` `defaults()`: add `cacheDir: null, cacheCapMB: 20480`. `merge()`: add on their own lines
`cacheDir: typeof s.cacheDir === 'string' && s.cacheDir ? s.cacheDir : null,` and
`cacheCapMB: Math.max(512, Number(s.cacheCapMB) || d.cacheCapMB),`. Test (append at the end of `lib/settings.test.js`, where the module is `S`):

```js
test('cache settings: folder null by default, cap has a floor', () => {
  const m = S.merge({});
  assert.equal(m.cacheDir, null); assert.equal(m.cacheCapMB, 20480);
  assert.equal(S.merge({ cacheDir: 'D:\\ozycache', cacheCapMB: 100 }).cacheDir, 'D:\\ozycache');
  assert.equal(S.merge({ cacheCapMB: 100 }).cacheCapMB, 512);
});
```

`main.js`: `readSettings` is defined at `~571`, after the proxy section; it is a function declaration so it hoists. Change `proxyDir` to:

```js
const proxyDir = () => { const s = readSettings(); return s.cacheDir ? path.join(s.cacheDir, 'proxies') : path.join(app.getPath('userData'), 'proxies'); };
```

Add trimming after a job finishes (in `make-proxy`'s `close` handler, after `resolve({ proxy: out })`), as a separate function:

```js
const CachePolicy = require('./lib/cachepolicy');
function trimProxyCache() {
  try {
    const dir = proxyDir();
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.mp4') && !n.endsWith('.part.mp4')).map((n) => {
      const p = path.join(dir, n); const st = fs.statSync(p);
      return { path: p, size: st.size, atimeMs: Math.max(st.atimeMs, st.mtimeMs) };
    });
    const cap = readSettings().cacheCapMB * 1048576;
    for (const p of CachePolicy.evict(files, cap)) { try { fs.unlinkSync(p); log('info', 'cache trimmed', { path: p }); } catch {} } // in use: next time
  } catch (err) { logError('cache trim', err); }
}
```

Call `trimProxyCache();` right after the `resolve({ proxy: out })` line. (Windows updates atime lazily; `max(atime, mtime)` keeps a just-made file newest.)

IPC: `ipcMain.handle('pick-cache-folder', async () => { const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }); return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]; });` and extend `cache-info` to return `{ bytes, files, capMB: readSettings().cacheCapMB, dir: proxyDir() }`.

`preload.js`: `pickCacheFolder: () => ipcRenderer.invoke('pick-cache-folder'),`.

- [ ] **Step 6: Optimize menu cache row**

`index.html` `#opt-list`, at the end:

```html
        <div class="menu-title">Cache <small id="opt-cache-line">…</small></div>
        <label class="menu-check" title="Smaller copies are deleted oldest-first once the cache passes this size">Cap <input type="number" id="opt-cache-cap" min="512" step="512" style="width:7em"> MB</label>
        <button id="opt-cache-folder" title="Where playable and smaller copies are kept. Existing files are not moved.">Change folder…</button>
        <button id="opt-cache-clear" title="Delete every cached copy, thumbnail and decoded frame">Clear cache…</button>
```

`app.js` Optimize block:

```js
const optCacheLine = document.getElementById('opt-cache-line');
const optCacheCap = document.getElementById('opt-cache-cap');
async function refreshCacheLine() {
  try {
    const { bytes, capMB, dir } = await window.api.cacheInfo();
    optCacheLine.textContent = `${(bytes / 1048576).toFixed(0)} MB of ${capMB} MB · ${dir}`;
    optCacheLine.title = dir;
    optCacheCap.value = String(settings.cacheCapMB);
  } catch { optCacheLine.textContent = 'unavailable'; }
}
document.getElementById('btn-optimize').addEventListener('click', refreshCacheLine);
optCacheCap.addEventListener('change', () => { settings.cacheCapMB = Math.max(512, Number(optCacheCap.value) || 20480); saveSettings(); refreshCacheLine(); });
document.getElementById('opt-cache-folder').addEventListener('click', async () => {
  const dir = await window.api.pickCacheFolder();
  if (!dir) return;
  settings.cacheDir = dir; saveSettings();
  setStatus('New copies go to ' + dir + ' (existing ones stay where they were)', 8000);
  refreshCacheLine();
});
document.getElementById('opt-cache-clear').addEventListener('click', () => { optList.hidden = true; document.getElementById('btn-cache').click(); });
```

`saveSettings` debounces 300 ms; `proxyDir()` in main reads the file, so a tier requested within that window could still land in the old folder. Acceptable; note it in the commit message.

- [ ] **Step 7: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: Optimize ▾ shows the cache line. Set the cap to 512, request ¼ on two large videos: after the second finishes, the first's file is gone from the folder if the total passed 512 MB (check the log for `cache trimmed`). Change folder to a scratch directory, request ½ on a third: its `-half.mp4` appears there. Close the app.

- [ ] **Step 8: Commit**

```bash
git add lib/cachepolicy.js lib/cachepolicy.test.js lib/settings.js lib/settings.test.js main.js preload.js app.js index.html
git commit -m "feat: proxy cache folder and size cap with oldest-first trimming"
```

---

### Task 5: Load viewer

**Files:**
- Create: `lib/loadstats.js`, `lib/loadstats.test.js`
- Modify: `main.js` (`load-stats` IPC), `preload.js`, `app.js` (panel), `index.html` (panel + menu entry), `style.css`

**Interfaces:**
- Produces: `LoadStats.cpuPercent(prev, next)` from two `os.cpus()` samples → system CPU % (0-100) or `null` when `prev` is missing.
- Produces: `LoadStats.split({ appCpu, appMemMB, gpuMemMB, sysCpu, usedMemMB, totalMemMB })` → `{ ozy: { cpu, memMB, gpuMemMB }, other: { cpu, memMB }, freeMB }` with every value clamped at 0.
- Produces: `LoadStats.estimateMB(width, height)` → decode-buffer estimate in MB (`w*h*1.5*4/1048576`, four frames in flight).
- Produces: `LoadStats.rows(tiles)` where each tile is `{ name, width, height, tier, state, dropped }` (any field may be missing) → display rows `{ name, res, tier, state, dropped, estMB }`.
- Produces: IPC `load-stats` → `{ appCpu, appMemMB, gpuMemMB, sysCpu, usedMemMB, totalMemMB }`.

- [ ] **Step 1: Write the failing test**

```js
// lib/loadstats.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./loadstats');

const cpus = (idle, busy) => [{ times: { user: busy, nice: 0, sys: 0, irq: 0, idle } }];
test('cpuPercent from two samples', () => {
  assert.equal(L.cpuPercent(null, cpus(100, 100)), null);
  assert.equal(L.cpuPercent(cpus(100, 100), cpus(150, 150)), 50);
  assert.equal(L.cpuPercent(cpus(100, 100), cpus(100, 100)), 0);   // no time passed: 0, not NaN
});
test('split: everything else is the system minus Ozy, never negative', () => {
  const s = L.split({ appCpu: 30, appMemMB: 1000, gpuMemMB: 200, sysCpu: 50, usedMemMB: 8000, totalMemMB: 16000 });
  assert.deepEqual(s, { ozy: { cpu: 30, memMB: 1000, gpuMemMB: 200 }, other: { cpu: 20, memMB: 7000 }, freeMB: 8000 });
  const t = L.split({ appCpu: 60, appMemMB: 9000, gpuMemMB: 0, sysCpu: 50, usedMemMB: 8000, totalMemMB: 16000 });
  assert.equal(t.other.cpu, 0); assert.equal(t.other.memMB, 0);
});
test('estimateMB scales with pixels', () => {
  assert.equal(Math.round(L.estimateMB(1920, 1080)), 12);
  assert.equal(Math.round(L.estimateMB(960, 540)), 3);
  assert.equal(L.estimateMB(0, 0), 0);
});
test('rows tolerate tiles without a video', () => {
  const rows = L.rows([
    { name: 'a.mp4', width: 1920, height: 1080, tier: 'full', state: 'playing', dropped: 3 },
    { name: 'note', state: 'text' },
    { name: 'yt', tier: 'full', state: 'paused' },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].res, '1920×1080'); assert.equal(rows[0].dropped, 3); assert.equal(Math.round(rows[0].estMB), 12);
  assert.equal(rows[1].res, '–'); assert.equal(rows[1].estMB, 0); assert.equal(rows[1].dropped, '–');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/loadstats.test.js`
Expected: FAIL, `Cannot find module './loadstats'`.

- [ ] **Step 3: Implement**

```js
// lib/loadstats.js
// The load viewer's arithmetic. Ozy's own numbers come from Electron's app.getAppMetrics(); the
// whole machine's from Node's os module; "everything else" is the difference. Nothing here reads
// what other programs are running - that was the deal with Mark - only totals.
{
  const sum = (c) => c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  const LoadStats = {
    cpuPercent(prev, next) {
      if (!Array.isArray(prev) || !Array.isArray(next) || !prev.length || prev.length !== next.length) return null;
      let total = 0, idle = 0;
      for (let i = 0; i < next.length; i++) { total += sum(next[i]) - sum(prev[i]); idle += next[i].times.idle - prev[i].times.idle; }
      return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    },
    split({ appCpu, appMemMB, gpuMemMB, sysCpu, usedMemMB, totalMemMB }) {
      const n = (v) => Math.max(0, Number(v) || 0);
      return {
        ozy: { cpu: n(appCpu), memMB: n(appMemMB), gpuMemMB: n(gpuMemMB) },
        other: { cpu: n(n(sysCpu) - n(appCpu)), memMB: n(n(usedMemMB) - n(appMemMB)) },
        freeMB: n(n(totalMemMB) - n(usedMemMB)),
      };
    },
    // decoded frames are 12 bits per pixel (yuv420) and a handful are in flight
    estimateMB(width, height) { return (Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0) * 1.5 * 4) / 1048576; },
    rows(tiles) {
      return (tiles || []).map((t) => {
        const hasRes = Number(t.width) > 0 && Number(t.height) > 0;
        return {
          name: String(t.name || ''),
          res: hasRes ? `${t.width}×${t.height}` : '–',
          tier: t.tier || '–',
          state: t.state || '–',
          dropped: Number.isFinite(t.dropped) ? t.dropped : '–',
          estMB: hasRes ? LoadStats.estimateMB(t.width, t.height) : 0,
        };
      });
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = LoadStats;
  else window.LoadStats = LoadStats;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/loadstats.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Main and preload**

`main.js` (near the cache handlers):

```js
// ---- load viewer ----
// Totals only: Ozy's own processes from app.getAppMetrics(), the machine from os. No per-program detail.
const os = require('os');
const LoadStats = require('./lib/loadstats');
let lastCpus = null;
ipcMain.handle('load-stats', () => {
  const cpus = os.cpus();
  const sysCpu = LoadStats.cpuPercent(lastCpus, cpus);
  lastCpus = cpus;
  let appCpu = 0, appMemMB = 0, gpuMemMB = 0;
  for (const m of app.getAppMetrics()) {
    const mb = (m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024;
    appCpu += m.cpu ? m.cpu.percentCPUUsage : 0;
    if (m.type === 'GPU') gpuMemMB += mb; else appMemMB += mb;
  }
  // percentCPUUsage is per process summed over cores; scale to the machine's 0-100
  appCpu = Math.round(appCpu / Math.max(1, cpus.length));
  const totalMemMB = os.totalmem() / 1048576, usedMemMB = (os.totalmem() - os.freemem()) / 1048576;
  return { appCpu, appMemMB: Math.round(appMemMB + gpuMemMB), gpuMemMB: Math.round(gpuMemMB), sysCpu, usedMemMB: Math.round(usedMemMB), totalMemMB: Math.round(totalMemMB) };
});
```

`preload.js`: `loadStats: () => ipcRenderer.invoke('load-stats'),`.

- [ ] **Step 6: Panel**

`index.html`: in `#opt-list` add `<label class="menu-check"><input type="checkbox" id="opt-load"> Show load viewer</label>` after the offscreen checkbox. After `#groupbar` (before `#timeline`) add:

```html
  <div id="load-panel" hidden>
    <div class="lp-head"><span>Load</span><span class="lp-sum"></span><span class="spacer"></span><button class="lp-close" title="Hide (Optimize ▾ shows it again)">✕</button></div>
    <table class="lp-table"><thead><tr><th>Video</th><th>Source</th><th>Tier</th><th>State</th><th>Dropped</th><th>≈ MB</th></tr></thead><tbody></tbody></table>
    <div class="lp-note">Ozy = this app's processes. Everything else = the rest of the machine, as one number. GPU is Ozy's GPU process only. ≈ MB is an estimate from resolution; a paused or offscreen video costs little.</div>
  </div>
```

`style.css`:

```css
#load-panel { position: fixed; right: 12px; bottom: 160px; width: 520px; max-height: 50vh; overflow: auto; background: var(--panel); border: 1px solid #333338; border-radius: 8px; padding: 8px 10px; font-size: 12px; z-index: 50; box-shadow: 0 6px 24px rgba(0,0,0,0.55); }
#load-panel .lp-head { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
#load-panel .lp-sum { color: var(--muted); font-variant-numeric: tabular-nums; }
#load-panel table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
#load-panel th, #load-panel td { text-align: left; padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
#load-panel .lp-note { color: var(--muted); margin-top: 6px; }
#load-panel .lp-close { background: none; border: none; color: var(--text); cursor: pointer; }
```

`app.js` Optimize block:

```js
// ---------- load viewer ----------
const loadPanel = document.getElementById('load-panel');
const optLoad = document.getElementById('opt-load');
let loadTimer = null;
const tileState = (t) => (!t.pb ? (t.type || 'image') : t.autoPaused ? 'auto-paused' : t.pb.paused ? 'paused' : 'playing');
async function refreshLoad() {
  if (loadPanel.hidden) return;
  let s = null;
  try { s = LoadStats.split(await window.api.loadStats()); } catch {}
  loadPanel.querySelector('.lp-sum').textContent = s
    ? `Ozy ${s.ozy.cpu}% CPU · ${s.ozy.memMB} MB (${s.ozy.gpuMemMB} MB GPU) · Everything else ${s.other.cpu === 0 && s.ozy.cpu === 0 ? '…' : s.other.cpu + '%'} CPU · ${s.other.memMB} MB · ${s.freeMB} MB free`
    : 'unavailable';
  const rows = LoadStats.rows(tiles.map((t) => {
    const v = t.video;
    const q = v && typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    return { name: tileName(t), width: v ? v.videoWidth : 0, height: v ? v.videoHeight : 0, tier: t.tier, state: tileState(t), dropped: q ? q.droppedVideoFrames : undefined };
  }));
  const body = loadPanel.querySelector('tbody');
  body.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of [r.name, r.res, r.tier, r.state, r.dropped, r.estMB ? r.estMB.toFixed(0) : '–']) { const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td); }
    body.appendChild(tr);
  }
}
function setLoadViewer(on) {
  loadPanel.hidden = !on;
  optLoad.checked = on;
  clearInterval(loadTimer); loadTimer = null;
  if (on) { refreshLoad(); loadTimer = setInterval(refreshLoad, 1000); }
}
optLoad.addEventListener('change', () => setLoadViewer(optLoad.checked));
loadPanel.querySelector('.lp-close').addEventListener('click', () => setLoadViewer(false));
```

`tileName(t)` exists (used by `openTileSettings`). The first sample's system CPU is `null` (no previous sample); `split` turns that into 0, and the line shows `…` for that one tick.

- [ ] **Step 7: Run the suite and a manual check**

Run: `npm test` → PASS. Isolated profile: Optimize ▾ → Show load viewer. Numbers refresh each second; play six videos and watch Ozy CPU and ≈ MB rise; switch the scene to ¼ and watch the Source column and estimate fall. Add a text tile and a YouTube tile: their rows show `–` and no errors in the console (read it over CDP or `read_console_messages`). Close the app.

- [ ] **Step 8: Commit**

```bash
git add lib/loadstats.js lib/loadstats.test.js main.js preload.js app.js index.html style.css
git commit -m "feat: load viewer showing Ozy versus everything else, per-tile cost"
```

---

### Task 6: Hand-off

- [ ] Run `npm test` once more on the branch; all green. Open every fixture in `test-fixtures/sessions/` through the app once (CDP `applySession` on each, or the Open dialog) to confirm old files still load.
- [ ] Push `feat/performance` to origin (no PR).
- [ ] Reply to the hub window (`scott fable windows 1 (work here)`) with: commit list, anything you changed from the plan and why, what you could not verify (an ffmpeg-less machine, a Mac). Do not merge; sonnet merges both branches when Mark says so.
