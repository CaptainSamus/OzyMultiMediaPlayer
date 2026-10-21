# Recent Sessions Implementation Plan (plan F)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click reopening of recently used session files.

**Architecture:** Pure list rules in `lib/recent.js` (tested); `settings.recentSessions` persisted through the existing settings file; a split Open button with a dropdown in `index.html`/`app.js`; main's `file-exists` IPC for greying missing files.

**Tech Stack:** Vanilla JS, Electron 33, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-20-views-and-live-budget-design.md`, section "Recent sessions".

## Global Constraints

- Branch `feat/recent-sessions` from `feat/board-polish-and-performance` (`8dbe966`). One commit per task. No tag/release/PR. Push and report to the hub.
- `app.js`: `grep -an`, preserve line endings, comment out rather than delete.
- Opus 1 is on `feat/views-and-live-budget` at the same time and edits `app.js` widely (tile creation, playback, window chrome, Optimize menu, `collectSession`). Keep your `app.js` changes to: the session open/save functions (`openSession`, `saveSession`, `saveSessionAs`, ~4037-4075), the `btn-open` wiring (~4099), the settings-applied block, and the empty-board hint. In `lib/settings.js` put your key on its own line.
- Views (plan E) must not show the recent list: wrap the dropdown wiring in `if (!window.OZY_VIEW)`; plan E defines `window.OZY_VIEW` as the view number or `0`. If it is undefined on your branch, treat undefined as the main window.

## Review Focus

1. A path opened twice must appear once, at the top (Task 1 test `re-opening moves to the top`).
2. The list must survive a session file that was deleted: it shows greyed, never throws, and ✕ removes it (Task 2 manual check).
3. Save as must add the new path and leave the old one in place (Task 1 test `save as adds, does not remove`).

---

### Task 1: `Recent` rules and the setting

**Files:**
- Create: `lib/recent.js`, `lib/recent.test.js`
- Modify: `lib/settings.js`, `lib/settings.test.js`, `index.html` script list

**Interfaces:**
- Produces: `Recent.push(list, path, now, { max = 10, caseInsensitive })` → new list with `{ path, openedAt: now }` first and any earlier entry for the same path removed. `Recent.remove(list, path)`. `Recent.sameFile(a, b, caseInsensitive)`.
- Produces: `settings.recentSessions` (array, default `[]`), validated in `merge()`: entries with a string `path` only, `openedAt` a number or 0, at most 10.

- [ ] **Step 1: Write the failing test**

```js
// lib/recent.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./recent');

test('push puts the newest first and caps the list', () => {
  let l = [];
  for (let i = 0; i < 12; i++) l = R.push(l, `C:\\s\\${i}.mvp`, 1000 + i, { max: 10, caseInsensitive: true });
  assert.equal(l.length, 10);
  assert.equal(l[0].path, 'C:\\s\\11.mvp');
  assert.equal(l[9].path, 'C:\\s\\2.mvp');
});
test('re-opening moves to the top, case-insensitively on Windows', () => {
  let l = R.push([], 'C:\\s\\a.mvp', 1, { caseInsensitive: true });
  l = R.push(l, 'C:\\s\\b.mvp', 2, { caseInsensitive: true });
  l = R.push(l, 'c:\\S\\A.MVP', 3, { caseInsensitive: true });
  assert.deepEqual(l.map((e) => e.path), ['c:\\S\\A.MVP', 'C:\\s\\b.mvp']);
  assert.equal(l[0].openedAt, 3);
});
test('case matters when told so (mac/linux)', () => {
  const l = R.push(R.push([], '/s/a.mvp', 1, { caseInsensitive: false }), '/s/A.mvp', 2, { caseInsensitive: false });
  assert.equal(l.length, 2);
});
test('save as adds, does not remove', () => {
  let l = R.push([], 'C:\\s\\old.mvp', 1, { caseInsensitive: true });
  l = R.push(l, 'C:\\s\\new.mvp', 2, { caseInsensitive: true });
  assert.deepEqual(l.map((e) => e.path), ['C:\\s\\new.mvp', 'C:\\s\\old.mvp']);
});
test('remove', () => {
  const l = R.remove([{ path: 'a', openedAt: 1 }, { path: 'b', openedAt: 2 }], 'a');
  assert.deepEqual(l, [{ path: 'b', openedAt: 2 }]);
});
```

- [ ] **Step 2: Run to verify it fails** → `node --test lib/recent.test.js` FAIL.

- [ ] **Step 3: Implement**

```js
// lib/recent.js
// The recent-sessions list: newest first, one entry per file, capped. Pure.
{
  const Recent = {
    sameFile(a, b, caseInsensitive) { return caseInsensitive ? String(a).toLowerCase() === String(b).toLowerCase() : a === b; },
    push(list, path, now, { max = 10, caseInsensitive = false } = {}) {
      const rest = (Array.isArray(list) ? list : []).filter((e) => e && typeof e.path === 'string' && !Recent.sameFile(e.path, path, caseInsensitive));
      return [{ path, openedAt: Number(now) || 0 }, ...rest].slice(0, max);
    },
    remove(list, path) { return (Array.isArray(list) ? list : []).filter((e) => e.path !== path); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Recent;
  else window.Recent = Recent;
}
```

`lib/settings.js`: `recentSessions: []` in `defaults()`; in `merge()` on its own line:
`recentSessions: (Array.isArray(s.recentSessions) ? s.recentSessions : []).filter((e) => e && typeof e.path === 'string').map((e) => ({ path: e.path, openedAt: Number(e.openedAt) || 0 })).slice(0, 10),`
Test:

```js
test('recentSessions: default empty, junk dropped, capped at 10', () => {
  assert.deepEqual(S.merge({}).recentSessions, []);
  const m = S.merge({ recentSessions: [{ path: 'a', openedAt: 'x' }, { nope: 1 }, 'str', ...Array.from({ length: 12 }, (_, i) => ({ path: String(i), openedAt: i }))] });
  assert.equal(m.recentSessions.length, 10);
  assert.deepEqual(m.recentSessions[0], { path: 'a', openedAt: 0 });
});
```

Add `<script src="lib/recent.js"></script>` to `index.html`.

- [ ] **Step 4: Run to verify it passes** → `node --test lib/recent.test.js lib/settings.test.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/recent.js lib/recent.test.js lib/settings.js lib/settings.test.js index.html
git commit -m "feat: recent-sessions list rules and setting"
```

---

### Task 2: Split Open button with the recent list

**Files:**
- Modify: `index.html` (toolbar, empty-board hint), `style.css`, `app.js` (`openSession`, `saveSession`, `saveSessionAs`, `btn-open` wiring, settings-applied block, empty hint render)

**Interfaces:**
- Consumes: `Recent`, `settings.recentSessions`, `window.api.fileExists(p)`, `IS_MAC` (`app.js:~85`; Windows is the case-insensitive platform: `const RECENT_CI = !IS_MAC && navigator.platform.startsWith('Win')`).
- Produces: `rememberSession(path)`, `renderRecentMenu()`, `openRecent(path)`.

- [ ] **Step 1: Markup**

Replace the Open button at `index.html:18` with a split button inside a menu container like the Tidy menu:

```html
    <div class="menu" id="open-menu">
      <span class="split"><button id="btn-open" title="Open a saved .mvp session (Ctrl+O)">Open session</button><button id="btn-open-recent" title="Recent sessions">▾</button></span>
      <div class="menu-list" id="recent-list" hidden></div>
    </div>
```

`style.css`: `.split { display: inline-flex; } .split button:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; } .split button:last-child { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 6px; margin-left: -1px; } #recent-list .recent-row { display: flex; align-items: center; gap: 6px; } #recent-list .recent-row.missing .recent-name { color: var(--muted); text-decoration: line-through; } #recent-list .recent-forget { background: none; border: none; color: var(--muted); cursor: pointer; }`

In the empty-board hint (`#empty .hint`, grep `id="empty"`), add `<div id="empty-recent" hidden></div>`.

- [ ] **Step 2: Wire**

`app.js`, next to `openSession`:

```js
// ---------- recent sessions ----------
const RECENT_CI = navigator.platform.startsWith('Win');
function rememberSession(p) {
  if (!p) return;
  settings.recentSessions = Recent.push(settings.recentSessions, p, Date.now(), { max: 10, caseInsensitive: RECENT_CI });
  saveSettings();
  renderEmptyRecent();
}
const recentMenu = document.getElementById('open-menu');
const recentList = document.getElementById('recent-list');
async function renderRecentMenu() {
  recentList.textContent = '';
  const items = settings.recentSessions;
  if (!items.length) { const d = document.createElement('div'); d.className = 'menu-note'; d.textContent = 'No recent sessions'; recentList.appendChild(d); return; }
  const exists = await Promise.all(items.map((e) => window.api.fileExists(e.path).catch(() => false)));
  items.forEach((e, i) => {
    const row = document.createElement('div'); row.className = 'recent-row' + (exists[i] ? '' : ' missing');
    const b = document.createElement('button'); b.className = 'recent-name'; b.textContent = basename(e.path); b.title = e.path + (exists[i] ? '' : '\n(not found)');
    b.addEventListener('click', () => { recentList.hidden = true; openRecent(e.path); });
    const x = document.createElement('button'); x.className = 'recent-forget'; x.textContent = '✕'; x.title = 'Forget';
    x.addEventListener('click', (ev) => { ev.stopPropagation(); settings.recentSessions = Recent.remove(settings.recentSessions, e.path); saveSettings(); renderRecentMenu(); renderEmptyRecent(); });
    row.append(b, x); recentList.appendChild(row);
  });
  const clear = document.createElement('button'); clear.textContent = 'Clear list';
  clear.addEventListener('click', () => { settings.recentSessions = []; saveSettings(); recentList.hidden = true; renderEmptyRecent(); });
  recentList.appendChild(clear);
}
async function openRecent(p) {
  if (!(await window.api.fileExists(p))) { setStatus(`Not found: ${p}`, 8000); return; }
  await openSession(p);
}
function renderEmptyRecent() {
  const el = document.getElementById('empty-recent'); if (!el) return;
  const items = settings.recentSessions.slice(0, 3);
  el.hidden = !items.length; el.textContent = '';
  if (!items.length) return;
  el.append('Recent: ');
  items.forEach((e, i) => { const a = document.createElement('a'); a.href = '#'; a.textContent = basename(e.path); a.title = e.path; a.addEventListener('click', (ev) => { ev.preventDefault(); openRecent(e.path); }); el.appendChild(a); if (i < items.length - 1) el.append(' · '); });
}
if (!window.OZY_VIEW) {
  document.getElementById('btn-open-recent').addEventListener('click', (e) => { e.stopPropagation(); recentList.hidden = !recentList.hidden; if (!recentList.hidden) renderRecentMenu(); });
  window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !recentMenu.contains(e.target)) recentList.hidden = true; });
}
```

Hooks: in `openSession` after `sessionPath = r.filePath;` add `rememberSession(r.filePath);`. In `saveSessionAs` after `sessionPath = p;` add `rememberSession(p);`. In `saveSession` after the write add `rememberSession(sessionPath);`. In the settings-applied block add `renderEmptyRecent();`. Check `updateChrome` or wherever `#empty` is shown/hidden so the recent links render whenever the hint shows (call `renderEmptyRecent()` there).

- [ ] **Step 3: Run the suite and a manual check**

`npm test` → PASS. Isolated profile: save a board as `a.mvp`, save as `b.mvp`, open ▾: b then a. Delete `a.mvp` on disk, open ▾: a is greyed; click it: status says not found; ✕ forgets it. Clear board: the empty hint lists b. Ctrl+O still opens the dialog. Close the app.

- [ ] **Step 4: Commit**

```bash
git add app.js index.html style.css
git commit -m "feat: recent sessions under the Open button and on the empty board"
```

---

### Task 3: Hand-off

- [ ] `npm test` green; push `feat/recent-sessions`; reply to the hub (`scott fable windows 1 (work here)`) with commits, changes from the plan, what you could not verify.
