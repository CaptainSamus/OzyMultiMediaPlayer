# View audio: one window is heard per tile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playing video is heard from whichever window shows it live, so a view on the other monitor has sound even when the main window is looking elsewhere.

**Architecture:** Every window broadcasts the list of tile ids it currently decodes (its live set) on the bus. Each window keeps every window's live set and picks one *audio owner* per tile with a pure rule: the main window if the tile is live there, else the lowest-numbered view where it is live. A window sets a tile's element volume to the real value only when it is the owner, otherwise 0. Volume and mute changes are mirrored so every window agrees on what "the real value" is.

**Tech Stack:** vanilla JS, Electron bus (`ipcRenderer.send('bus')` relay in main.js), `node --test` for `lib/lod.js`.

**Spec:** `docs/superpowers/specs/2026-10-20-views-and-live-budget-design.md` (section "Extra views"; this plan amends "views are silent": Scott, 2026-10-20, "if it's playing, and in ANY view, I should be able to hear it").

**Baseline:** `feat/board-polish-and-performance` at `6d9fc24` (v0.2.0.14). Branch `feat/view-audio` from there in a sibling worktree.

## Global Constraints
- Comment out, never delete. `grep -an` for app.js (NUL byte). One commit per task. No tag, release, PR or push from the coder; sonnet does that.
- No echo: a tile must never be audible in two windows at once, even for a moment while live sets change. A window mutes a tile it releases immediately in `tile.release`, before anyone else can claim it.
- The user's own volume/mute controls keep working in every window, with the same meaning everywhere.

## Review Focus
- A tile live in main and in view 1 at once: only main is heard (test in Task 1, manual check in Task 2).
- Main pans away so the tile becomes a still in main while view 1 still shows it: view 1 becomes audible within one budget tick (500 ms) and main's still is silent.
- View closes while owning a tile's audio: main deletes that view's set on `view-closed`; if main shows the tile live it becomes the owner again, otherwise nobody (silent, as today for stills).
- A view opened later (or after `main-hello`): it must learn main's live set without waiting for main's set to change (main resends on `snapshot-request`).
- Mute in a view, or the master volume slider in main: the other window follows (Task 2 step 4).

---

### Task 1: `Lod.audioOwner` (pure)

**Files:**
- Modify: `lib/lod.js`
- Test: `lib/lod.test.js`

**Produces:** `Lod.audioOwner(id, liveSets)` where `liveSets` is a `Map<number, Set|Array>` (window number → tile ids; 0 is main). Returns `0` if main has it, else the smallest view number that has it, else `null`.

- [ ] **Step 1: failing tests** (append to `lib/lod.test.js`, same require/test style as the file)

```js
test('audioOwner: main wins, then the lowest view, else nobody', () => {
  const sets = new Map([[0, new Set(['a'])], [1, ['a', 'b']], [2, ['b', 'c']]]);
  assert.equal(Lod.audioOwner('a', sets), 0);
  assert.equal(Lod.audioOwner('b', sets), 1);
  assert.equal(Lod.audioOwner('c', sets), 2);
  assert.equal(Lod.audioOwner('d', sets), null);
  assert.equal(Lod.audioOwner('a', new Map()), null);
});
```

- [ ] **Step 2:** `node --test lib/lod.test.js` → FAIL (`Lod.audioOwner is not a function`).
- [ ] **Step 3: implement** inside the block of `lib/lod.js`, before the export lines:

```js
  // Which window is heard for a tile: the main window when it decodes it, else the lowest-numbered
  // view that does. Two windows playing the same sound would only echo it.
  Lod.audioOwner = (id, liveSets) => {
    let best = null;
    for (const [n, ids] of liveSets) {
      const has = ids instanceof Set ? ids.has(id) : Array.isArray(ids) && ids.includes(id);
      if (has && (best === null || n < best)) best = n;
    }
    return best;
  };
```

- [ ] **Step 4:** `node --test lib/lod.test.js` → PASS. `npm test` → all pass.
- [ ] **Step 5:** commit `feat(lod): audioOwner picks the one window heard per tile`.

### Task 2: live sets on the bus, owner-gated volume (app.js)

**Files:**
- Modify: `app.js` — `applyTileVolume` (~line 211), `tile.release` (~2243), `applyLiveBudget` (~5162), the bus handler (~5760), the `IS_VIEW` block (~5795), `SNAP_SKIP` (~5704).

**Interfaces:** new bus message `{ type: 'live', n, ids: string[], master?: number }` sent by every window (`master` = main's `masterVolume`, main only). Existing: `view-closed`, `snapshot-request`, `main-hello`, `playback` ops.

- [ ] **Step 1: state and owner-gated volume.** Near `applyTileVolume`:

```js
// Which windows decode which tiles (window 0 is main). A tile is heard in exactly one of them,
// Lod.audioOwner's pick; the others keep its element at volume 0. (Scott, 2026-10-20: a view on
// the other monitor must have sound even when main is looking elsewhere.)
const liveSets = new Map();
let lastLiveKey = '';
const isAudioOwner = (tile) => Lod.audioOwner(tile.id, liveSets) === window.OZY_VIEW;
function applyTileVolume(tile) {
  // const v = IS_VIEW ? 0 : clamp(...);   // (views were silent until 2026-10-20)
  const v = isAudioOwner(tile) ? clamp(tile.volume * masterVolume * (tile.group ? tile.group.volume : 1), 0, 1) : 0;
  if (tile.video) tile.video.volume = v;
  else if (tile.yt) tile.yt.volume(v);
}
function applyAudioOwners() { for (const t of tiles) applyTileVolume(t); }
```

Note: with no `live` message ever received and nothing announced, `liveSets` is empty and every tile would be silent. So the main window must announce its own set on its first budget tick, which Step 2 does; make sure `applyLiveBudget` runs once right after a session opens (it does on the 500 ms interval; if the first second of a session is silent in testing, call it at the end of the open path too).

- [ ] **Step 2: broadcast the live set** at the end of `applyLiveBudget` (after the for loop):

```js
  const ids = tiles.filter((t) => t.id && (t.live || !t.release)).map((t) => t.id); // web tiles are always live
  const key = ids.join('\n');
  if (key !== lastLiveKey) { lastLiveKey = key; liveSets.set(window.OZY_VIEW, new Set(ids)); announceLive(ids); applyAudioOwners(); }
```

and

```js
function announceLive(ids) {
  if (!window.api.bus) return;
  const msg = { type: 'live', n: window.OZY_VIEW, ids };
  if (!IS_VIEW) msg.master = masterVolume;
  window.api.bus(msg);
}
```

In `tile.release`, right after `tile.live = false;` add `if (tile.video) tile.video.volume = 0; // never audible as a still, whoever owns it next`.

- [ ] **Step 3: receive.** In the bus handler, alongside the `view-closed` line:

```js
  if (msg.type === 'live') { liveSets.set(msg.n, new Set(msg.ids || [])); if (IS_VIEW && Number.isFinite(msg.master)) masterVolume = clamp(msg.master, 0, 1); applyAudioOwners(); return; }
```

Extend the existing `view-closed` line with `liveSets.delete(msg.n); applyAudioOwners();`. Where main handles `snapshot-request`, also `announceLive([...(liveSets.get(0) || [])])` so a new or re-hello'd view learns main's set at once. In a view's `main-hello` handler add `liveSets.clear(); lastLiveKey = '';` so stale sets from a previous main go away and the next tick re-announces.

When main's master slider changes (the `masterVolume = clamp(...)` setter ~line 351), call `announceLive([...(liveSets.get(0) || [])])` so views follow the master volume.

- [ ] **Step 4: mirror mute and volume.** `SNAP_SKIP` (~line 5704) drops `volume` and `muted`, so a view does not know a tile's volume or mute. Remove `'volume'` and `'muted'` from `SNAP_SKIP` (comment the old line out, add the new one) and make the view's snapshot apply path set `tile.volume`, `setOwnMuted(tile, rec.muted)` and group `volume`/`muted` quietly, then `applyTileVolume`. For a view's own mute button, volume slider and group mute, send a playback op (`{ op: 'mute', value }`, `{ op: 'volume', value }`) through the existing `playback` bus message and handle those two ops in `applyPlayback` in every window (`setOwnMuted(t, !!o.value)` / `t.volume = o.value; applyTileVolume(t)`). If the view's mute already round-trips another way, keep that and say so in the commit message.

- [ ] **Step 5: manual check** (isolated `--user-data-dir`, close everything after): open a session with two videos, open view 1, zoom view 1 onto video A, pan main away so A is a still in main. Expect: A audible from view 1 within a second. Pan main back onto A: sound moves to main, no doubled or echoed audio. Mute A in the view: silent everywhere, main's 🔇 updates. Close the view while it owns A: A silent (still in main); pan main onto A: audible. Run `npm test`.

- [ ] **Step 6:** commit `feat(views): the window showing a video live is the one heard`.

### Task 3: docs

- [ ] In the spec, replace the "Views are silent" wording under "Extra views" with: "A tile is heard from one window: main if it decodes it, else the lowest-numbered view that does (`Lod.audioOwner`). Mute and volume are shared board state." Update the comment at app.js line 212 likewise. Update the README or in-app help if either says views are silent (`grep -an -i silent`). Commit `docs: views are no longer silent`.

Report: test count, commits, and anything from the manual check that differed from the expectations above.
