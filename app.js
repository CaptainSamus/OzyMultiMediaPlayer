// Multi Video Player - renderer logic. Runs with no Node access; everything
// that touches disk goes through the small `window.api` bridge in preload.js.

const grid = document.getElementById('grid');
const canvas = document.getElementById('canvas');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');
const tileTemplate = document.getElementById('tile-template');
const zoomEl = document.getElementById('zoom');
const zoomLabel = document.getElementById('zoom-label');
const modeEl = document.getElementById('mode');

const SESSION_FORMAT = 'multi-video-player-session';
const SESSION_VERSION = 4;

/** @type {Array<{path:string, el:HTMLElement, video:HTMLVideoElement, seek:HTMLInputElement, time:HTMLElement, scrubbing:boolean, volume:number, aspect:number, board?:{x:number,y:number,w:number,h:number}, tick?:Function}>} */
const tiles = [];
let sessionPath = null;
let statusTimer = null;
let hoveredTile = null; // tile under the mouse, for per-video keyboard shortcuts

// ---------- layout model ----------
// Two modes.
//  gallery: tiles are attached - they flow left-to-right, wrap, and all share
//           its own height (tile.galleryH); the slider scales them all together.
//           Width follows each video's aspect.
//  board:   tiles are detached on an infinite canvas. Each has its own
//           x/y/w/h in canvas units; the view pans and zooms.
const MIN_H = 60;
const MAX_H = 1200;
const BOARD_MIN_H = 40;
const BOARD_MAX_H = 4000;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const GAP = 8;
const DEFAULT_ASPECT = 16 / 9;
// rowHeight is now only the size new tiles start at (it follows scale-all) and the fallback for
// older session files; each tile keeps its own gallery height in tile.galleryH.
const layout = { mode: 'gallery', rowHeight: 240, galleryScale: 1, timeDisplay: 'clock', timelineExpanded: false, timelineHeight: 140 };
const board = { panX: 0, panY: 0, zoom: 1, initialized: false, linked: true, hand: false };
let zTop = 1;
const selection = new Set(); // board mode: tiles picked with the lasso / shift-click
const marqueeEl = document.getElementById('marquee');
const guideV = document.getElementById('guide-v');
const guideH = document.getElementById('guide-h');
const SNAP_PX = 8;       // screen pixels
const LINK_GAP = GAP;    // space kept between linked tiles
let pendingFit = false;
let fitTimer = null;

// ---------- volume model ----------
// Each tile keeps its own level (0..1); the element's real volume is that
// level multiplied by the master. New videos start quiet.
const DEFAULT_VIDEO_VOLUME = 0.1;
const DEFAULT_MASTER_VOLUME = 1;
let masterVolume = DEFAULT_MASTER_VOLUME;

const masterVol = document.getElementById('master-vol');
const masterPct = document.getElementById('master-pct');
const masterIcon = document.getElementById('master-icon');

// ---------- helpers ----------

function basename(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

// macOS uses Cmd where Windows uses Ctrl for "just this one" clicks and multi-select.
// (Ctrl+wheel stays Ctrl everywhere: a trackpad pinch arrives as a Ctrl+wheel event.)
const IS_MAC = navigator.platform.startsWith('Mac');
const modKey = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
const MOD_LABEL = IS_MAC ? 'Cmd' : 'Ctrl';
const REVEAL_LABEL = IS_MAC ? 'Reveal in Finder' : 'Show in Explorer';
// Tooltips and menu hints say Cmd on a Mac (templates too); Ctrl+wheel hints stay Ctrl.
if (IS_MAC) {
  const roots = [document, ...[...document.querySelectorAll('template')].map((t) => t.content)];
  for (const root of roots) {
    for (const el of root.querySelectorAll('[title]')) if (!/wheel/i.test(el.title)) el.title = el.title.replace(/\bCtrl\b/g, 'Cmd');
    for (const k of root.querySelectorAll('kbd')) k.textContent = k.textContent.replace(/\bCtrl\b/g, 'Cmd');
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, isFinite(v) ? v : lo)); }

// ---------- logging ----------
// Errors here are the ones that used to vanish: the renderer's console is not open in a packaged
// build. They go to the same file main writes (userData\logs), via window.api.log.
// `sending` guards against a loop: if forwarding itself fails, console.error must not re-enter.
let sending = false;
function logUi(level, msg, data) {
  if (sending) return;
  sending = true;
  try { window.api.log(level, msg, data); } catch {} finally { sending = false; }
}
window.addEventListener('error', (e) => {
  logUi('error', 'window error: ' + (e.message || 'unknown'), {
    src: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
    stack: e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 6).join(' ⏎ ') : undefined,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  logUi('error', 'unhandled rejection: ' + String((r && r.message) || r || 'unknown'), {
    stack: r && r.stack ? String(r.stack).split('\n').slice(0, 6).join(' ⏎ ') : undefined,
  });
});
// console.error still prints in dev; it just also reaches the file now.
const consoleError = console.error.bind(console);
console.error = (...args) => {
  consoleError(...args);
  logUi('error', args.map((a) => (a && a.stack) ? String(a.stack).split('\n')[0] : String(a && a.message ? a.message : a)).join(' ').slice(0, 500));
};

function setStatus(msg, ms = 4000) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, ms);
}

let appVersion = ''; // e.g. 0.2.0.3, or 0.2.0.3-dev from source
window.api.version().then((v) => { appVersion = v || ''; updateChrome(); });
function updateChrome() {
  emptyEl.classList.toggle('hidden', tiles.length > 0);
  countEl.textContent = tiles.length ? `${tiles.length} video${tiles.length === 1 ? '' : 's'}` : '';
  const name = sessionPath ? basename(sessionPath) : 'Unsaved session';
  document.title = `${name} – Ozy Multi Media Player${appVersion ? ' ' + appVersion : ''}`;
  refreshToolbarToggles();
}

const isBoard = () => layout.mode === 'board';

// ---------- volume ----------

function applyTileVolume(tile) {
  const v = clamp(tile.volume * masterVolume * (tile.group ? tile.group.volume : 1), 0, 1);
  if (tile.video) tile.video.volume = v;
  else if (tile.yt) tile.yt.volume(v); // Twitch embeds expose no volume control
}
// A tile's own mute is remembered separately so a group mute can be undone.
function setOwnMuted(tile, m) {
  tile.ownMuted = !!m;
  const muted = tile.ownMuted || !!(tile.group && tile.group.muted);
  if (tile.video) tile.video.muted = muted;
  else if (tile.yt) { muted ? tile.yt.mute() : tile.yt.unmute(); if (tile.refreshMute) tile.refreshMute(); }
  refreshToolbarToggles();
}
const isMuted = (t) => !!(t.ownMuted || (t.group && t.group.muted));

// ---------- per-tile loop ----------
// tile.loop repeats a local or YouTube video on its own. Inside a synced group the group's timeline
// is in charge (its Loop setting, or holding at the end), so the tile's loop is ignored and its
// button dims.
const loopOverridden = (t) => !!(t.group && t.group.sync);
function applyTileLoop(t) {
  if (!t.pb) return;
  const on = !!t.loop && !loopOverridden(t);
  if (t.video) t.video.loop = on;
  const b = t.el.querySelector('.loop');
  b.classList.toggle('toggled', !!t.loop);
  b.classList.toggle('overridden', loopOverridden(t));
  b.title = loopOverridden(t) ? 'Loop this video (L). Off while its group is synced: the group\'s Sync / Loop is in charge.' : 'Loop this video (L)';
}
function setTileLoop(t, on) { t.loop = !!on; applyTileLoop(t); refreshToolbarToggles(); }
function applyLoops() { for (const t of tiles) applyTileLoop(t); }

// Toolbar: one Mute all / Unmute all toggle (Twitch has no mute, so it doesn't count) and Loop all.
function refreshToolbarToggles() {
  const mutable = tiles.filter((t) => t.video || t.yt);
  const allMuted = mutable.length > 0 && mutable.every(isMuted);
  const m = document.getElementById('btn-mute-all');
  m.textContent = allMuted ? '🔊 Unmute all' : '🔇 Mute all';
  m.title = allMuted ? 'Unmute every video' : 'Mute every video';
  const loopable = tiles.filter((t) => t.pb);
  document.getElementById('btn-loop-all').classList.toggle('toggled', loopable.length > 0 && loopable.every((t) => t.loop));
}
// Play state across local <video>, sequence and YouTube tiles (Twitch has no API: skipped).
/* DISABLED (Mark, 2026-09-11): replaced by the playback adapter versions below, which also cover sequence tiles
function playTile(t) { if (t.video) t.video.play().catch(() => {}); else if (t.yt) t.yt.play(); }
function pauseTile(t) { if (t.video) t.video.pause(); else if (t.yt) t.yt.pause(); }
function isPlaying(t) { return t.video ? !t.video.paused : !!(t.yt && !t.yt.paused); }
*/
function playTile(t) { if (t.pb) t.pb.play(); }
function pauseTile(t) { if (t.pb) t.pb.pause(); }
function isPlaying(t) { return !!(t.pb && !t.pb.paused); }
// fps for frame step and timecode: a video's ⚙ override, else what ffprobe found (null = unknown,
// shown with ~ and stepped at 24); sequences always have one (tile.fps, default 24)
const effectiveFps = (t) => t.fpsOverride || t.fps || null;

// ---------- playback adapter ----------
// tile.pb: one shape over a local <video> or a YouTube player, so groups, Sync, loops, bookmarks
// and the timeline don't care which. Twitch and image tiles have none. (t.video stays for
// DOM-only things: fullscreen, A/B, frame step.)
function videoPlayback(video) {
  return {
    web: false, kind: 'video', settling: false,
    get time() { return video.currentTime || 0; }, set time(t) { video.currentTime = t; },
    get duration() { return video.duration || 0; },
    get paused() { return video.paused; },
    play() { video.play().catch(() => {}); }, pause() { video.pause(); },
    get rate() { return video.playbackRate; }, set rate(r) { video.playbackRate = r; },
  };
}
// YouTube reports its time about 4x a second; between reports the time is extrapolated while
// playing. A seek is followed by a second of `settling` (buffering, stale reports) during
// which the drift engine leaves it alone.
function ytPlayback(yt) {
  let seekAt = -Infinity;
  const st = yt.st;
  return {
    web: true, kind: 'web',
    get settling() { return performance.now() - seekAt < 1000; },
    get time() {
      const t = st.state === 1 && st.at ? st.time + (performance.now() - st.at) / 1000 * (st.rate || 1) : st.time;
      return st.duration > 0 ? Math.min(t, st.duration) : t;
    },
    set time(t) { yt.seek(t); st.time = t; st.at = performance.now(); seekAt = st.at; },
    get duration() { return st.duration || 0; },
    get paused() { return yt.paused; },
    play() { yt.play(); }, pause() { yt.pause(); },
    get rate() { return st.rate || 1; }, set rate(r) { st.rate = r; yt.rate(r); },
  };
}
const tileName = (t) => t.title || basename(t.path);

function setMasterVolume(v, { updateSlider = true } = {}) {
  masterVolume = clamp(Number(v), 0, 1);
  if (updateSlider) masterVol.value = String(Math.round(masterVolume * 100));
  masterVol.style.setProperty('--progress', (masterVolume * 100).toFixed(1) + '%');
  masterPct.textContent = Math.round(masterVolume * 100) + '%';
  masterIcon.textContent = masterVolume === 0 ? '🔇' : masterVolume < 0.34 ? '🔈' : masterVolume < 0.67 ? '🔉' : '🔊';
  for (const t of tiles) applyTileVolume(t);
}

// ---------- geometry ----------

function gridRect() { return grid.getBoundingClientRect(); }
function innerWidth() { return Math.max(100, grid.clientWidth - 2 * GAP); }
function innerHeight() { return Math.max(100, grid.clientHeight - 2 * GAP); }

// screen -> canvas coordinates (board mode)
function toCanvas(clientX, clientY) {
  const r = gridRect();
  return { x: (clientX - r.left - board.panX) / board.zoom, y: (clientY - r.top - board.panY) / board.zoom };
}

function boardBounds(list = tiles.filter((t) => t.board)) {
  if (!list.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of list) {
    const b = t.board;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---------- zoom slider (shared between modes) ----------

// board zoom uses a log scale on the slider: 0..1000 -> 0.05x..4x
const sliderToZoom = (v) => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 1000);
const zoomToSlider = (z) => 1000 * Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
// gallery: the same slider scales every tile together, 0.25x..4x with 1x in the middle
const MIN_GS = 0.25, MAX_GS = 4;
const sliderToScale = (v) => MIN_GS * Math.pow(MAX_GS / MIN_GS, v / 1000);
const scaleToSlider = (s) => 1000 * Math.log(s / MIN_GS) / Math.log(MAX_GS / MIN_GS);

function updateZoomUI() {
  if (isBoard()) {
    zoomEl.min = '0'; zoomEl.max = '1000';
    zoomEl.value = String(Math.round(zoomToSlider(board.zoom)));
    zoomLabel.textContent = Math.round(board.zoom * 100) + '%';
  } else {
    /* DISABLED (Mark, 2026-09-12): the slider set one shared row height; it now scales every tile
    zoomEl.min = String(MIN_H); zoomEl.max = String(MAX_H);
    zoomEl.value = String(layout.rowHeight);
    zoomLabel.textContent = layout.rowHeight + 'px';
    */
    zoomEl.min = '0'; zoomEl.max = '1000';
    zoomEl.value = String(Math.round(scaleToSlider(layout.galleryScale)));
    zoomLabel.textContent = Math.round(layout.galleryScale * 100) + '%';
  }
}

// ---------- layout ----------

function layoutTile(t) {
  const s = t.el.style;
  if (isBoard()) {
    if (!t.board) return;
    s.left = t.board.x + 'px';
    s.top = t.board.y + 'px';
    s.width = t.board.w + 'px';
    s.height = t.board.h + 'px';
  } else {
    const maxW = innerWidth();
    let h = galleryHOf(t); // each tile's own height
    let w = h * t.aspect;
    if (w > maxW) { w = maxW; h = w / t.aspect; }
    s.left = ''; s.top = ''; s.zIndex = '';
    s.width = Math.round(w) + 'px';
    s.height = Math.round(h) + 'px';
  }
}

function applyBoardView() {
  canvas.style.transform = `translate(${board.panX}px, ${board.panY}px) scale(${board.zoom})`;
  canvas.style.setProperty('--ui-scale', String(1 / board.zoom)); // controls keep their screen size
  const spacing = 24 * board.zoom;
  grid.style.backgroundSize = `${spacing}px ${spacing}px`;
  grid.style.backgroundPosition = `${board.panX}px ${board.panY}px`;
  updateZoomUI();
}

function layoutTiles() {
  for (const t of tiles) layoutTile(t);
  if (isBoard()) {
    applyBoardView();
  } else {
    canvas.style.transform = ''; // the board's pan/zoom must not leak into the gallery
    canvas.style.setProperty('--ui-scale', '1');
    updateZoomUI();
  }
}

/* DISABLED (Mark, 2026-09-12): one shared height for every gallery tile; each tile has its own now
function setRowHeight(h) {
  layout.rowHeight = clamp(Math.round(h), MIN_H, MAX_H);
  layoutTiles();
}
*/
// A tile's gallery height: its own, else the current default (older sessions and new tiles).
function galleryHOf(t) { return Number(t.galleryH) > 0 ? Number(t.galleryH) : layout.rowHeight; }
function setTileGalleryH(t, h) {
  t.galleryH = clamp(Math.round(h), MIN_H, MAX_H);
  layoutTile(t);
}
// Scale-all: every tile (and the default for new ones) grows or shrinks by the same factor, so the
// sizes set by hand keep their ratios.
// The factor is trimmed so no tile crosses MIN_H / MAX_H, and then every tile gets that same
// factor: clamping tile by tile would flatten the ratios of whichever tile hit the limit first.
function scaleGallery(factor) {
  if (!(factor > 0)) return 1;
  let f = factor;
  for (const t of tiles) f = Math.min(f, MAX_H / galleryHOf(t)); // nothing grows past the max
  for (const t of tiles) f = Math.max(f, MIN_H / galleryHOf(t)); // nor shrinks under the min
  if (!(f > 0) || !isFinite(f)) return 1;
  for (const t of tiles) t.galleryH = clamp(Math.round(galleryHOf(t) * f), MIN_H, MAX_H);
  layout.rowHeight = clamp(Math.round(layout.rowHeight * f), MIN_H, MAX_H);
  layout.galleryScale = clamp(layout.galleryScale * f, MIN_GS, MAX_GS);
  layoutTiles();
  return f;
}
// The slider holds an absolute scale; moving it applies the ratio to what is on screen. If the
// tiles can't take the whole step, the thumb follows what actually happened.
function setGalleryScale(scale) {
  const want = clamp(scale, MIN_GS, MAX_GS);
  const before = layout.galleryScale;
  const f = want / before;
  if (Math.abs(f - 1) < 1e-6) { updateZoomUI(); return; }
  const applied = scaleGallery(f);
  layout.galleryScale = clamp(before * applied, MIN_GS, MAX_GS);
  updateZoomUI();
}

function zoomAt(newZoom, clientX, clientY) {
  const r = gridRect();
  const mx = clientX - r.left, my = clientY - r.top;
  newZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  board.panX = mx - (mx - board.panX) * (newZoom / board.zoom);
  board.panY = my - (my - board.panY) * (newZoom / board.zoom);
  board.zoom = newZoom;
  applyBoardView();
}

function zoomAtCenter(newZoom) {
  const r = gridRect();
  zoomAt(newZoom, r.left + r.width / 2, r.top + r.height / 2);
}

function bringToFront(tile) {
  tile.el.style.zIndex = String(++zTop);
}

// ---------- board: selection ----------

function setSelected(tile, on) {
  if (on) selection.add(tile); else selection.delete(tile);
  tile.el.classList.toggle('selected', on);
  syncActiveFromSelection();
}
function clearSelection() {
  for (const t of selection) t.el.classList.remove('selected');
  selection.clear();
  syncActiveFromSelection();
}
function selectOnly(tile) { clearSelection(); setSelected(tile, true); }
function selectGroupOf(tile) { clearSelection(); for (const m of tile.group.members) setSelected(m, true); }
function selectionStatus() {
  if (selection.size > 1) setStatus(`${selection.size} videos selected – drag any of them to move the group, Esc to deselect`, 6000);
}

// ---------- groups ----------
// A group has shared audio/speed settings; with Sync on, members also share
// one timeline (see lib/groups.js). tile.group is the group or null,
// tile.sync = { start } while the group is synced.
const GROUP_PALETTE = Object.keys(Groups.PALETTE);
const groups = [];
let nextGroupId = 1;
let active = null;       // the group whose bar / timeline is showing
let syncing = false;     // re-entrancy guard for broadcast

function groupOf(tile) { return tile.group || null; }
function activeGroup() { return active; }
function paintGroup(t) {
  const sw = t.el.querySelector('.group-swatch');
  sw.hidden = !t.group;
  if (t.group) sw.style.background = Groups.PALETTE[t.group.color];
}
// members that can play (local and YouTube); Twitch and image members only share Sticky / mute / volume
function memberModel(g) {
  return [...g.members].filter((t) => t.pb).map((t) => ({ tile: t, start: t.sync ? t.sync.start : 0, duration: t.pb.duration }));
}
function captureStarts(g) {
  const ms = [...g.members].filter((t) => t.pb);
  const starts = Groups.starts(ms.map((t) => t.pb.time));
  ms.forEach((t, i) => { t.sync = { start: starts[i] }; });
}
function createGroup(list, opts = {}) {
  for (const t of list) if (t.group) removeFromGroup(t.group, t);
  const g = {
    id: nextGroupId++, name: opts.name || `Group ${nextGroupId - 1}`,
    color: GROUP_PALETTE.includes(opts.color) ? opts.color : GROUP_PALETTE[(nextGroupId - 2) % GROUP_PALETTE.length],
    members: new Set(list), sync: !!opts.sync, sticky: opts.sticky !== false,
    loop: ['off', 'shortest', 'longest', 'range'].includes(opts.loop) ? opts.loop : 'off',
    range: opts.range || null, volume: isFinite(opts.volume) ? clamp(Number(opts.volume), 0, 1) : 1,
    muted: !!opts.muted, rate: Number(opts.rate) > 0 ? Number(opts.rate) : 1,
  };
  groups.push(g);
  for (const t of list) { t.group = g; t.sync = null; paintGroup(t); }
  if (g.sync) captureStarts(g);
  applyGroupAudio(g);
  setActiveGroup(g);
  return g;
}
// back to the tile's own mute and volume once it leaves its group
function releaseTile(t) {
  t.group = null; t.sync = null; paintGroup(t);
  setOwnMuted(t, t.ownMuted); applyTileVolume(t); applyTileLoop(t);
}
function removeFromGroup(g, t) {
  g.members.delete(t); releaseTile(t);
  if (g.members.size < 2) dissolveGroup(g);
  else if (active === g) renderGroupBar();
}
function dissolveGroup(g) {
  logUi('info', 'group dissolved', { id: g.id, members: g.members.size });
  for (const t of [...g.members]) releaseTile(t);
  g.members.clear();
  const i = groups.indexOf(g); if (i >= 0) groups.splice(i, 1);
  if (active === g) setActiveGroup(null);
}
function applyGroupAudio(g) {
  for (const t of g.members) {
    setOwnMuted(t, t.ownMuted); // web tiles join groups for mute / volume (YouTube only) and Sticky
    applyTileVolume(t);
    if (t.pb) t.pb.rate = g.rate;
    const rateSel = t.el.querySelector('.rate'); // local video and sequence tiles
    if (rateSel) rateSel.value = String(g.rate);
  }
}

function setActiveGroup(g) {
  active = g;
  renderGroupBar();
  renderTimeline();
}
function syncActiveFromSelection() {
  const t = [...selection].find((x) => x.group);
  setActiveGroup(t ? t.group : null);
}

const gb = document.getElementById('groupbar');
const gbQ = (s) => gb.querySelector(s);
function renderGroupBar() {
  applyLoops(); // Sync on/off changes whether each tile's own loop counts
  gb.hidden = !active;
  if (!active) return;
  const g = active;
  gbQ('.gb-swatch').style.background = Groups.PALETTE[g.color];
  if (document.activeElement !== gbQ('.gb-name')) gbQ('.gb-name').value = g.name;
  const anyPlaying = [...g.members].some(isPlaying);
  gbQ('.gb-play').textContent = anyPlaying ? '❚❚' : '▶';
  gbQ('.gb-mute').textContent = g.muted ? '🔇' : '🔊';
  gbQ('.gb-vol').value = String(Math.round(g.volume * 100));
  gbQ('.gb-rate').value = String(g.rate);
  gbQ('.gb-sync').classList.toggle('toggled', g.sync);
  gbQ('.gb-sticky').classList.toggle('toggled', g.sticky);
  gbQ('.gb-loop').value = g.loop;
  const notes = [];
  if (g.loop !== 'off') notes.push('Loop needs Sync, so Sync is on');
  if (g.sync && [...g.members].some((t) => t.pb && t.pb.web)) notes.push('YouTube members sync to about ¼ s, not frame-exact');
  gbQ('.gb-note').textContent = notes.join(' · ');
}
gbQ('.gb-swatch').addEventListener('click', () => { active.color = GROUP_PALETTE[(GROUP_PALETTE.indexOf(active.color) + 1) % GROUP_PALETTE.length]; for (const t of active.members) paintGroup(t); renderGroupBar(); });
gbQ('.gb-name').addEventListener('input', () => { active.name = gbQ('.gb-name').value; });
gbQ('.gb-name').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });
gbQ('.gb-play').addEventListener('click', () => playPauseGroup(active));
gbQ('.gb-mute').addEventListener('click', () => { active.muted = !active.muted; applyGroupAudio(active); renderGroupBar(); });
gbQ('.gb-vol').addEventListener('input', () => { active.volume = Number(gbQ('.gb-vol').value) / 100; applyGroupAudio(active); });
gbQ('.gb-rate').addEventListener('change', () => { active.rate = Number(gbQ('.gb-rate').value); applyGroupAudio(active); });
gbQ('.gb-sync').addEventListener('click', () => setGroupSync(active, !active.sync));
gbQ('.gb-sticky').addEventListener('click', () => { active.sticky = !active.sticky; renderGroupBar(); });
gbQ('.gb-loop').addEventListener('change', () => { active.loop = gbQ('.gb-loop').value; if (active.loop !== 'off' && !active.sync) setGroupSync(active, true); renderGroupBar(); renderTimeline(); });
gbQ('.gb-name').addEventListener('change', () => renderTimeline());
gbQ('.gb-ungroup').addEventListener('click', () => dissolveGroup(active));

function setGroupSync(g, on) {
  g.sync = on;
  if (on) captureStarts(g); else for (const t of g.members) t.sync = null;
  if (!on && g.loop !== 'off') g.loop = 'off';
  renderGroupBar();
  renderTimeline();
}
// Group time from a member that isn't clamped (playing, or paused inside its own
// extent). If every member is clamped, a member waiting at 0 means g <= its start,
// so the earliest such start is g; if all have ended, g is the group's end.
// The playing member with the steadiest clock leads: a local video (exact), then a sequence (it can
// stall while frames decode), then YouTube (extrapolated).
const LEAD_RANK = { video: 0, frames: 1, web: 2 };
const leadOf = (ms) => ms.filter((m) => !m.tile.pb.paused).sort((a, b) => LEAD_RANK[a.tile.pb.kind] - LEAD_RANK[b.tile.pb.kind])[0];
function groupTimeOf(g) {
  const ms = memberModel(g);
  if (!ms.length) return 0;
  const inside = (m) => m.tile.pb.time > 0 && m.tile.pb.time < m.duration;
  const lead = leadOf(ms) || ms.find(inside);
  if (lead) return Groups.groupTime(lead.tile.pb.time, lead.start);
  const waiting = ms.filter((m) => m.tile.pb.time <= 0);
  return waiting.length ? Math.min(...waiting.map((m) => m.start)) : Groups.end(ms);
}
function seekGroup(g, gt) {
  syncing = true;
  try { for (const m of memberModel(g)) m.tile.pb.time = Groups.memberTime(gt, m.start, m.duration); }
  finally { syncing = false; }
}
function playPauseGroup(g) {
  const ms = memberModel(g);
  const anyPlaying = ms.some((m) => !m.tile.pb.paused);
  if (anyPlaying) { for (const m of ms) m.tile.pb.pause(); renderGroupBar(); return; }
  if (g.sync) {
    const end = Groups.end(ms);
    if (groupTimeOf(g) >= end - 0.05) seekGroup(g, g.loop === 'range' && g.range ? g.range.in : 0); // Loop Off: play after the end restarts
    const gt = groupTimeOf(g);
    for (const m of ms) if (gt >= m.start && gt < m.start + m.duration) m.tile.pb.play();
  } else for (const m of ms) m.tile.pb.play();
  renderGroupBar();
}
function toggleGroupFromSelection() {
  const sel = [...selection]; // Twitch and image tiles may join for Sticky / mute / volume; Sync and the timeline skip them
  if (sel.length < 2) { setStatus('Select at least two videos to group (Shift-click, or lasso on the board)'); return; }
  createGroup(sel);
  setStatus(`${sel.length} videos grouped`);
}
document.getElementById('btn-group').addEventListener('click', toggleGroupFromSelection);
document.getElementById('btn-ungroup').addEventListener('click', () => { if (active) dissolveGroup(active); });

// A user action on one synced member applies to the rest.
// action: 'play' | 'pause' | 'seek' | 'rate'. Only call from user actions, never
// from media events (those fire later, outside the `syncing` guard).
function broadcast(leader, action, value) {
  const g = leader.group;
  if (!g) return;
  if (action === 'rate') { g.rate = value; applyGroupAudio(g); if (active === g) renderGroupBar(); return; } // speed is shared even without Sync
  if (syncing || !g.sync || !leader.sync) return;
  syncing = true;
  try {
    const gt = Groups.groupTime(leader.pb.time, leader.sync.start);
    for (const m of memberModel(g)) {
      if (m.tile === leader) continue;
      const p = m.tile.pb;
      if (action === 'play') { if (gt >= m.start && gt < m.start + m.duration) p.play(); }
      else if (action === 'pause') p.pause();
      else if (action === 'seek') p.time = Groups.memberTime(gt, m.start, m.duration);
    }
  } finally { syncing = false; }
}

// Runs 10x a second: drift correction, waiting members, held members, loops.
setInterval(() => {
  for (const g of groups) {
    if (!g.sync) continue;
    const ms = memberModel(g);
    const lead = leadOf(ms);
    if (!lead) continue;
    const gt = Groups.groupTime(lead.tile.pb.time, lead.start);
    const loopEnd = Groups.loopEnd(g.loop, ms.filter((m) => m.duration > 0), g.range); // ignore members still loading
    if (loopEnd !== null && gt >= loopEnd - 0.05) {
      const to = g.loop === 'range' && g.range ? g.range.in : 0;
      seekGroup(g, to);
      for (const m of ms) if (Groups.memberTime(to, m.start, m.duration) < m.duration && to >= m.start) m.tile.pb.play();
      continue;
    }
    syncing = true;
    try {
      for (const m of ms) {
        if (m === lead) continue;
        const p = m.tile.pb;
        const want = Groups.memberTime(gt, m.start, m.duration);
        const inside = gt >= m.start && gt < m.start + m.duration;
        if (inside && p.paused) p.play();   // its start was reached
        if (!inside && !p.paused) p.pause(); // waiting at 0 or holding at the end
        // YouTube on either side: ~¼ s slack, and none while it is still settling after a seek
        // a sequence moves in whole frames, so give it 1.5 frames of slack at low frame rates
        const slack = p.web || lead.tile.pb.web ? Groups.DRIFT_WEB : Math.max(Groups.DRIFT, p.frameSlack || 0, lead.tile.pb.frameSlack || 0);
        if (!p.settling && Math.abs(p.time - want) > slack) p.time = want;
      }
    } finally { syncing = false; }
  }
}, 100);

// ---------- marker colours ----------
const MARKER_COLORS = Groups.PALETTE;
const MARKER_KEYS = Object.keys(MARKER_COLORS);
const nextMarkerColor = (c) => MARKER_KEYS[(MARKER_KEYS.indexOf(c) + 1) % MARKER_KEYS.length];

// ---------- unified timeline ----------
const tl = document.getElementById('timeline');
const tlQ = (s) => tl.querySelector(s);

// What the timeline shows, in order: the active group; else the selected videos (one, or
// "N selected"); else every video ("All videos"). Local and YouTube tiles count (they have a pb);
// hidden only when there are none.
function timelineModel() {
  if (active) {
    const members = memberModel(active);
    if (!members.length) return null; // e.g. a group of Twitch tiles or images
    return { title: active.name, members, group: active, fps: effectiveFps(members[0].tile) };
  }
  const asMembers = (list) => list.map((t) => ({ tile: t, start: 0, duration: t.pb.duration }));
  const sel = [...selection].filter((t) => t.pb);
  if (sel.length === 1) return { title: tileName(sel[0]), members: asMembers(sel), group: null, fps: effectiveFps(sel[0]) };
  if (sel.length > 1) return { title: `${sel.length} selected`, members: asMembers(sel), group: null, fps: effectiveFps(sel[0]) };
  const all = tiles.filter((t) => t.pb);
  if (all.length) return { title: 'All videos', members: asMembers(all), group: null, fps: effectiveFps(all[0]) };
  return null;
}
// each video's own colour (a palette key), used when the timeline shows several videos
const tileColor = (t) => Groups.PALETTE[t.hue] || Groups.PALETTE.yellow;
function tlTime(model) { return model.group ? groupTimeOf(model.group) : model.members[0].tile.pb.time; }
function tlSeek(model, gt) {
  if (model.group && model.group.sync) seekGroup(model.group, gt);
  else for (const m of model.members) m.tile.pb.time = Groups.memberTime(gt, m.start, m.duration);
}

function renderTimeline() {
  const model = timelineModel();
  tl.hidden = !model;
  tl._model = model;
  if (!model) return;
  tl.classList.toggle('expanded', layout.timelineExpanded);
  tl.style.setProperty('--tl-lanes-h', layout.timelineHeight + 'px');
  tlQ('.tl-grip').textContent = layout.timelineExpanded ? '▾' : '▴';
  tlQ('.tl-title').textContent = model.title;
  for (const s of ['.tl-set-in', '.tl-set-out', '.tl-clear-range']) tlQ(s).hidden = !model.group;
  const multi = model.members.length > 1;
  // collapsed with several videos: a legend says whose colour is whose (lanes carry names when expanded)
  const legend = tlQ('.tl-legend'); legend.textContent = '';
  if (multi && !layout.timelineExpanded) {
    for (const m of model.members) {
      const item = document.createElement('span'); item.className = 'tl-leg';
      const sw = document.createElement('i'); sw.style.background = tileColor(m.tile);
      item.append(sw, tileName(m.tile));
      legend.appendChild(item);
    }
  }
  const end = Groups.end(model.members);
  const width = tlQ('.tl-bar').clientWidth;
  // lanes (expanded)
  const lanesEl = tlQ('.tl-lanes'); lanesEl.textContent = '';
  if (layout.timelineExpanded) {
    Timeline.lanes(model.members).forEach((lane, i) => {
      const m = model.members[i];
      const row = document.createElement('div'); row.className = 'tl-lane';
      const block = document.createElement('div'); block.className = 'tl-block';
      block.style.left = Timeline.xFor(lane.start, end, width) + 'px';
      block.style.width = Math.max(2, Timeline.xFor(lane.end, end, width) - Timeline.xFor(lane.start, end, width)) + 'px';
      block.style.borderColor = tileColor(m.tile); // the lane's video colour; its markers keep per-bookmark colours
      block.textContent = tileName(m.tile);
      const tcL = document.createElement('span'); tcL.className = 'tl-tc'; tcL.textContent = Frames.format(lane.start, 0, effectiveFps(m.tile), layout.timeDisplay).split(' / ')[0];
      const tcR = document.createElement('span'); tcR.className = 'tl-tc right'; tcR.textContent = Frames.format(lane.end, 0, effectiveFps(m.tile), layout.timeDisplay).split(' / ')[0];
      block.append(tcL, tcR); row.appendChild(block);
      for (const b of m.tile.bookmarks) {
        const mk = document.createElement('div'); mk.className = 'tl-mk'; mk.style.background = MARKER_COLORS[b.color];
        mk.style.left = Timeline.xFor(lane.start + b.t, end, width) + 'px'; mk.title = `${b.label || ''} ${fmtTime(b.t)}`.trim();
        mk.addEventListener('click', (e) => { e.stopPropagation(); tlSeek(model, lane.start + b.t); });
        row.appendChild(mk);
      }
      lanesEl.appendChild(row);
    });
  }
  // markers on the bar (always drawn; in expanded mode they double as an overview)
  const mkEl = tlQ('.tl-markers'); mkEl.textContent = '';
  for (const m of model.members) for (const b of m.tile.bookmarks) {
    // several videos: colour by video so you can tell whose marker it is; one video: the bookmark's own colour
    const mk = document.createElement('div'); mk.className = 'tl-mk'; mk.style.background = multi ? tileColor(m.tile) : MARKER_COLORS[b.color];
    mk.style.left = Timeline.xFor(m.start + b.t, end, width) + 'px';
    mk.title = `${tileName(m.tile)}: ${b.label || fmtTime(b.t)}  (right-click to delete, Shift-right-click to recolour)`;
    mk.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a bar scrub
    mk.addEventListener('click', (e) => { e.stopPropagation(); tlSeek(model, m.start + b.t); });
    mk.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) b.color = nextMarkerColor(b.color);
      else m.tile.bookmarks.splice(m.tile.bookmarks.indexOf(b), 1);
      m.tile.refreshBookmarks();
    });
    mkEl.appendChild(mk);
  }
  // loop range
  const showRange = !!(model.group && model.group.loop === 'range');
  const r = Timeline.clampRange(model.group ? model.group.range : null, end);
  for (const s of ['.tl-range', '.tl-in', '.tl-out']) tlQ(s).style.display = showRange ? '' : 'none';
  tlQ('.tl-range').style.left = Timeline.xFor(r.in, end, width) + 'px';
  tlQ('.tl-range').style.width = (Timeline.xFor(r.out, end, width) - Timeline.xFor(r.in, end, width)) + 'px';
  tlQ('.tl-in').style.left = Timeline.xFor(r.in, end, width) + 'px';
  tlQ('.tl-out').style.left = Timeline.xFor(r.out, end, width) + 'px';
  tl._end = end;
  tickTimeline();
}
function tickTimeline() {
  const model = tl._model; if (!model || tl.hidden) return;
  const gt = tlTime(model), end = tl._end;
  tlQ('.tl-playhead').style.left = Timeline.xFor(gt, end, tlQ('.tl-bar').clientWidth) + 'px';
  const only = !model.group && model.members.length === 1 ? model.members[0].tile : null; // one sequence: its own frame numbers
  tlQ('.tl-time').textContent = only && only.type === 'sequence' ? timeReadout(only, gt) : Frames.format(gt, end, model.fps, layout.timeDisplay);
}
function toggleTimelineExpanded() { layout.timelineExpanded = !layout.timelineExpanded; renderTimeline(); }
function setRangeAtPlayhead(which) {
  const g = tl._model && tl._model.group; if (!g) return;
  g.range = Timeline.clampRange({ ...(g.range || { in: 0, out: tl._end }), [which]: tlTime(tl._model) }, tl._end);
  if (g.loop !== 'range') { g.loop = 'range'; if (!g.sync) setGroupSync(g, true); }
  renderTimeline(); renderGroupBar();
}

// Drag the head: up past 40 px expands; while expanded, dragging sets the lane area's height
// (60-320 px, saved in the session) and dragging well below the minimum collapses. A click on
// the grip (no drag) still toggles, as does T.
const TL_MIN_H = 60, TL_MAX_H = 320, TL_SNAP = 40;
tlQ('.tl-head').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target.closest('button') && !e.target.closest('.tl-grip'))) return;
  e.preventDefault();
  const head = tlQ('.tl-head'); try { head.setPointerCapture(e.pointerId); } catch {}
  const y0 = e.clientY, wasExpanded = layout.timelineExpanded, h0 = layout.timelineHeight;
  let moved = false;
  const onMove = (ev) => {
    const up = y0 - ev.clientY; // positive = dragged up
    if (!moved && Math.abs(up) < 4) return;
    moved = true;
    if (!wasExpanded) {
      if (up > TL_SNAP) { layout.timelineHeight = Math.round(clamp(up, TL_MIN_H, TL_MAX_H)); if (!layout.timelineExpanded) { layout.timelineExpanded = true; renderTimeline(); } }
      else if (layout.timelineExpanded) { layout.timelineExpanded = false; renderTimeline(); }
    } else {
      const h = h0 + up;
      // collapsing keeps the height it had before this drag, so expanding again comes back the same size
      if (h < TL_MIN_H - TL_SNAP) { layout.timelineHeight = h0; if (layout.timelineExpanded) { layout.timelineExpanded = false; renderTimeline(); } }
      else { layout.timelineHeight = Math.round(clamp(h, TL_MIN_H, TL_MAX_H)); if (!layout.timelineExpanded) { layout.timelineExpanded = true; renderTimeline(); } }
    }
    tl.style.setProperty('--tl-lanes-h', layout.timelineHeight + 'px');
  };
  const onUp = (ev) => {
    head.removeEventListener('pointermove', onMove); head.removeEventListener('pointerup', onUp); head.removeEventListener('pointercancel', onUp);
    if (!moved && ev.type === 'pointerup' && e.target.closest('.tl-grip')) toggleTimelineExpanded();
  };
  head.addEventListener('pointermove', onMove); head.addEventListener('pointerup', onUp); head.addEventListener('pointercancel', onUp);
});
tlQ('.tl-bar').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.classList.contains('tl-handle') || !tl._model) return;
  const bar = tlQ('.tl-bar'); const r = bar.getBoundingClientRect();
  try { bar.setPointerCapture(e.pointerId); } catch {}
  const seek = (ev) => tlSeek(tl._model, Timeline.tFor(ev.clientX - r.left, tl._end, r.width));
  seek(e);
  const onMove = (ev) => seek(ev);
  const onUp = () => { bar.removeEventListener('pointermove', onMove); bar.removeEventListener('pointerup', onUp); bar.removeEventListener('pointercancel', onUp); };
  bar.addEventListener('pointermove', onMove); bar.addEventListener('pointerup', onUp); bar.addEventListener('pointercancel', onUp);
});
for (const which of ['in', 'out']) {
  tlQ('.tl-' + which).addEventListener('pointerdown', (e) => {
    e.stopPropagation(); const h = e.currentTarget;
    try { h.setPointerCapture(e.pointerId); } catch {}
    const r = tlQ('.tl-bar').getBoundingClientRect(); const g = tl._model.group;
    const onMove = (ev) => { const t = Timeline.tFor(ev.clientX - r.left, tl._end, r.width); g.range = Timeline.clampRange({ ...(g.range || { in: 0, out: tl._end }), [which]: t }, tl._end); renderTimeline(); };
    const onUp = () => { h.removeEventListener('pointermove', onMove); h.removeEventListener('pointerup', onUp); h.removeEventListener('pointercancel', onUp); };
    h.addEventListener('pointermove', onMove); h.addEventListener('pointerup', onUp); h.addEventListener('pointercancel', onUp);
  });
}
tlQ('.tl-set-in').addEventListener('click', () => setRangeAtPlayhead('in'));
tlQ('.tl-set-out').addEventListener('click', () => setRangeAtPlayhead('out'));
tlQ('.tl-clear-range').addEventListener('click', () => {
  const g = tl._model && tl._model.group; if (!g) return;
  g.range = null; if (g.loop === 'range') g.loop = 'off';
  renderTimeline(); renderGroupBar();
});
window.addEventListener('resize', () => renderTimeline());

// ---------- A/B compare ----------
// Both <video> elements move into a full-window view (they keep playing) and
// share a temporary synced group; their real groups are put back on close.
const cmp = { el: document.getElementById('compare'), a: null, b: null, saved: [], temp: null, mode: 'wipe', wipe: 50, tick: null, scrubbing: false };
const cmpQ = (s) => cmp.el.querySelector(s);

function openCompare(a, b) {
  cmp.a = a; cmp.b = b; cmp.mode = 'wipe'; cmp.wipe = 50;
  cmp.el.classList.remove('flip', 'show-a');
  cmp.el.style.setProperty('--wipe', '50%');
  for (const x of cmpQ('.cmp-mode').querySelectorAll('button')) x.classList.toggle('active', x.dataset.cmp === 'wipe');
  // snapshot the real groups (members and starts) before pulling a and b out
  cmp.saved = [...new Set([a.group, b.group].filter(Boolean))].map((g) => ({
    group: g, members: [...g.members], starts: new Map([...g.members].map((t) => [t, t.sync ? { ...t.sync } : null])),
  }));
  for (const t of [a, b]) if (t.group) removeFromGroup(t.group, t);
  cmp.temp = createGroup([a, b], { name: 'A/B', sync: true, sticky: false, rate: a.pb.rate });
  // the picture element moves (a <video>, or a sequence's canvas); it keeps playing
  cmpQ('.cmp-a').appendChild(a.mediaEl); cmpQ('.cmp-b').appendChild(b.mediaEl);
  cmpQ('.cmp-label-a').textContent = 'A: ' + tileName(a);
  cmpQ('.cmp-label-b').textContent = 'B: ' + tileName(b);
  cmp.el.hidden = false;
  cmp.tick = () => {
    const p = a.pb;
    cmpQ('.cmp-play').textContent = p.paused ? '▶' : '❚❚';
    cmpQ('.cmp-time').textContent = timeReadout(a);
    if (p.duration && !cmp.scrubbing) cmpQ('.cmp-seek').value = String(Math.round(p.time / p.duration * 10000));
  };
  cmp.tick();
}
function closeCompare() {
  if (!cmp.a) return;
  const { a, b } = cmp;
  dissolveGroup(cmp.temp);
  a.el.insertBefore(a.mediaEl, a.el.firstChild);
  b.el.insertBefore(b.mediaEl, b.el.firstChild);
  // put the real groups back as they were (a group that dropped below 2 members was dissolved; revive it)
  for (const s of cmp.saved) {
    const g = s.group;
    const members = s.members.filter((t) => tiles.includes(t));
    if (members.length < 2) continue;
    if (!groups.includes(g)) groups.push(g);
    g.members = new Set(members);
    for (const t of members) { t.group = g; t.sync = s.starts.get(t) || null; paintGroup(t); }
    applyGroupAudio(g);
  }
  cmp.el.hidden = true; cmp.a = cmp.b = null; cmp.tick = null; cmp.temp = null; cmp.saved = [];
  layoutTiles(); syncActiveFromSelection();
}
function tryOpenCompare() {
  const sel = [...selection].filter((t) => t.mediaEl && t.pb && !t.pb.web); // local videos and sequences
  if (sel.length !== 2) { setStatus('Select exactly two videos for A/B (Shift-click, or lasso on the board)'); return; }
  openCompare(sel[0], sel[1]);
}
document.getElementById('btn-ab').addEventListener('click', tryOpenCompare);
cmpQ('.cmp-close').addEventListener('click', closeCompare);
cmpQ('.cmp-play').addEventListener('click', () => cmp.a.togglePlay());
cmpQ('.cmp-fb').addEventListener('click', () => cmp.a.stepFrame(-1));
cmpQ('.cmp-ff').addEventListener('click', () => cmp.a.stepFrame(1));
cmpQ('.cmp-mode').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmp]'); if (!btn) return;
  cmp.mode = btn.dataset.cmp;
  for (const x of cmpQ('.cmp-mode').querySelectorAll('button')) x.classList.toggle('active', x === btn);
  cmp.el.classList.toggle('flip', cmp.mode === 'flip');
});
const cmpSeek = cmpQ('.cmp-seek');
cmpSeek.addEventListener('pointerdown', () => { cmp.scrubbing = true; });
cmpSeek.addEventListener('pointerup', () => { cmp.scrubbing = false; });
cmpSeek.addEventListener('input', () => {
  const p = cmp.a.pb; if (!p.duration) return;
  p.time = Number(cmpSeek.value) / 10000 * p.duration;
  broadcast(cmp.a, 'seek');
});
cmpQ('.cmp-wipe').addEventListener('pointerdown', (e) => {
  const r = cmpQ('.cmp-stage').getBoundingClientRect();
  const wipeEl = e.currentTarget;
  try { wipeEl.setPointerCapture(e.pointerId); } catch {}
  const onMove = (ev) => { cmp.wipe = clamp((ev.clientX - r.left) / r.width * 100, 0, 100); cmp.el.style.setProperty('--wipe', cmp.wipe + '%'); };
  const onUp = () => { wipeEl.removeEventListener('pointermove', onMove); wipeEl.removeEventListener('pointerup', onUp); wipeEl.removeEventListener('pointercancel', onUp); };
  wipeEl.addEventListener('pointermove', onMove); wipeEl.addEventListener('pointerup', onUp); wipeEl.addEventListener('pointercancel', onUp);
});

// ---------- undo ----------
// Entry shapes:
//  { kind: 'move'|'resize', label, rects: [{ tile, before: {x,y,w,h}, after: {x,y,w,h} }] }
//  { kind: 'gresize', label, tile, before, after }                  one gallery tile's height
//  { kind: 'gscale', label, heights: [{ tile, before, after }], scale: { before, after } }  scale-all burst
//  { kind: 'remove', label, record, index, tile, group, groupMembers, starts }
//     record = collectSession's per-video object; tile = the live tile (updated on undo so redo removes the right one);
//     group/groupMembers/starts let undo revive a group that dissolved when the tile left it.
// (Named undoStack, not history, so it can't collide with window.history.)
const undoStack = Undo.create(10);
const rectOf = (t) => (t.board ? { ...t.board } : null);
const sameRect = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function recordMove(list, label) { return { kind: 'move', label: label || 'move', rects: list.map((t) => ({ tile: t, before: rectOf(t), after: null })) }; }
function recordResize(list) { return { kind: 'resize', label: 'resize', rects: list.map((t) => ({ tile: t, before: rectOf(t), after: null })) }; }
function finishRects(entry) { // call at pointerup; keeps only tiles that actually changed, drops no-op drags
  for (const r of entry.rects) r.after = rectOf(r.tile);
  entry.rects = entry.rects.filter((r) => !sameRect(r.before, r.after));
  if (!entry.rects.length) return;
  if (entry.kind === 'move') entry.label = `move ${entry.rects.length} video${entry.rects.length === 1 ? '' : 's'}`;
  undoStack.push(entry);
}
/* DISABLED (Mark, 2026-09-12): undo of the one shared gallery height; per-tile and scale-all below
function recordRowHeight() { return { kind: 'rowHeight', label: 'resize gallery', before: layout.rowHeight, after: null }; }
function finishRowHeight(entry) { entry.after = layout.rowHeight; if (entry.after !== entry.before) undoStack.push(entry); }
*/
// one gallery tile's corner drag
function recordGResize(tile) { return { kind: 'gresize', label: `resize ${basename(tile.path)}`, tile, before: galleryHOf(tile), after: null }; }
function finishGResize(entry) { entry.after = galleryHOf(entry.tile); if (entry.after !== entry.before) undoStack.push(entry); }
// Ctrl+wheel, the zoom slider and +/- scale everything in many small steps: one entry per burst.
let rowEntry = null, rowTimer = null;
function noteGalleryScaleChange() {
  if (!rowEntry) rowEntry = { kind: 'gscale', label: 'scale gallery', heights: tiles.map((t) => ({ tile: t, before: galleryHOf(t), after: null })), scale: { before: layout.galleryScale, after: null } };
  clearTimeout(rowTimer);
  rowTimer = setTimeout(() => {
    const entry = rowEntry; rowEntry = null;
    if (!entry) return;
    for (const h of entry.heights) h.after = galleryHOf(h.tile);
    entry.scale.after = layout.galleryScale;
    entry.heights = entry.heights.filter((h) => tiles.includes(h.tile) && h.after !== h.before);
    if (entry.heights.length) undoStack.push(entry);
  }, 500);
}
function recordRemove(tile) {
  const g = tile.group;
  undoStack.push({
    kind: 'remove', label: `remove ${basename(tile.path)}`, record: collectSession().videos[tiles.indexOf(tile)],
    index: tiles.indexOf(tile), tile, group: g,
    groupMembers: g ? [...g.members] : [], starts: g ? new Map([...g.members].map((t) => [t, t.sync ? { ...t.sync } : null])) : null,
  });
}

function applyRects(entry, dir) { // dir: 'before' | 'after'
  for (const r of entry.rects) if (tiles.includes(r.tile) && r[dir]) { r.tile.board = { ...r[dir] }; layoutTile(r.tile); }
}
function restoreRemoved(entry) {
  const v = entry.record;
  const t = v.type === 'image' ? addImageTile(v.path, v)
    : v.type === 'sequence' ? addSequenceTile(v.dir, v.seq, v) // its disk cache is reused (same key)
    : v.type && v.type !== 'file' ? addWebTile(v.url, WebUrl.parse(v.url), v) : addVideo(v.path, v);
  // put it back at its old index so gallery order is preserved
  tiles.splice(tiles.indexOf(t), 1); tiles.splice(Math.min(entry.index, tiles.length), 0, t);
  canvas.insertBefore(t.el, canvas.children[entry.index] || null);
  const g = entry.group;
  if (g) {
    if (!groups.includes(g)) {
      // the group dissolved when this tile left; revive it with the members still free
      const others = entry.groupMembers.filter((m) => tiles.includes(m) && m !== t && !m.group);
      if (others.length) {
        groups.push(g); g.members = new Set(others);
        for (const m of others) { m.group = g; m.sync = entry.starts.get(m) || null; paintGroup(m); }
      }
    }
    if (groups.includes(g)) {
      g.members.add(t); t.group = g;
      t.sync = v.sync ? { start: v.sync.start } : null;
      paintGroup(t); applyGroupAudio(g);
    }
  }
  entry.tile = t;
  if (isBoard() && !t.board) placeOnBoard([t]);
  layoutTiles();
  if (typeof markOnBoard === 'function') markOnBoard(); // sidebar arrives in Task 12
  if (active) renderGroupBar();
  applyLoops(); // back in a synced group: its own loop is overridden again
}
function applyEntry(entry, dir) {
  if (entry.kind === 'move' || entry.kind === 'resize') applyRects(entry, dir);
  else if (entry.kind === 'gresize') { if (tiles.includes(entry.tile)) setTileGalleryH(entry.tile, entry[dir]); }
  else if (entry.kind === 'gscale') {
    for (const h of entry.heights) if (tiles.includes(h.tile)) h.tile.galleryH = h[dir];
    if (entry.scale[dir] > 0) layout.galleryScale = entry.scale[dir];
    layoutTiles();
  }
  else if (entry.kind === 'remove') {
    if (dir === 'before') restoreRemoved(entry);
    else if (tiles.includes(entry.tile)) removeTile(entry.tile, { record: false });
  }
}
function undo() { const e = undoStack.undo(); if (!e) { setStatus('Nothing to undo'); return; } applyEntry(e, 'before'); logUi('info', 'undo', { what: e.label }); setStatus('Undo: ' + e.label); }
function redo() { const e = undoStack.redo(); if (!e) { setStatus('Nothing to redo'); return; } applyEntry(e, 'after'); logUi('info', 'redo', { what: e.label }); setStatus('Redo: ' + e.label); }

function setLinked(on) {
  board.linked = !!on;
  document.getElementById('btn-link').classList.toggle('toggled', board.linked);
}
function setHand(on) {
  board.hand = !!on;
  document.getElementById('btn-hand').classList.toggle('toggled', board.hand);
  document.body.classList.toggle('hand', board.hand);
}

// ---------- board: linked layout (no overlaps) ----------
// Every drag/resize remembers where things started. On each frame the
// non-fixed tiles are put back to their start positions and then nudged
// just far enough to clear the fixed tiles (and each other). So neighbours
// slide aside as you grow into them and slide back if you shrink again.
let startPos = new Map();
function rememberStart() {
  startPos = new Map(tiles.filter((t) => t.board).map((t) => [t, { ...t.board }]));
}

function resolveOverlaps(fixed) {
  const list = tiles.filter((t) => t.board);
  for (const t of list) {
    if (fixed.has(t)) continue;
    const s = startPos.get(t);
    if (s) { t.board.x = s.x; t.board.y = s.y; }
  }
  const m = LINK_GAP;
  // Which way to push: decided by where the two tiles sit relative to each
  // other (side-by-side -> sideways, stacked -> up/down), using the fixed
  // tile's live rect and everyone else's start rect so the answer doesn't
  // flip around mid-drag.
  const ref = (t) => (fixed.has(t) ? t.board : (startPos.get(t) || t.board));
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const fa = fixed.has(a), fb = fixed.has(b);
        if (fa && fb) continue;
        const A = a.board, B = b.board;
        const ox = Math.min(A.x + A.w - B.x, B.x + B.w - A.x) + m;
        const oy = Math.min(A.y + A.h - B.y, B.y + B.h - A.y) + m;
        if (ox <= 0.01 || oy <= 0.01) continue;
        const RA = ref(a), RB = ref(b);
        const nx = ((RB.x + RB.w / 2) - (RA.x + RA.w / 2)) / ((RA.w + RB.w) / 2);
        const ny = ((RB.y + RB.h / 2) - (RA.y + RA.h / 2)) / ((RA.h + RB.h) / 2);
        let dx = 0, dy = 0;
        if (Math.abs(nx) >= Math.abs(ny)) dx = (nx >= 0 ? 1 : -1) * ox;
        else dy = (ny >= 0 ? 1 : -1) * oy;
        if (fa) { B.x += dx; B.y += dy; }
        else if (fb) { A.x -= dx; A.y -= dy; }
        else { A.x -= dx / 2; A.y -= dy / 2; B.x += dx / 2; B.y += dy / 2; }
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (const t of list) if (!fixed.has(t)) layoutTile(t);
}

// ---------- board: edge snapping while moving ----------

function hideGuides() { guideV.hidden = true; guideH.hidden = true; }
function showGuideV(canvasX) {
  const r = gridRect();
  guideV.style.left = (canvasX * board.zoom + board.panX) + 'px';
  guideV.hidden = false;
  void r;
}
function showGuideH(canvasY) {
  guideH.style.top = (canvasY * board.zoom + board.panY) + 'px';
  guideH.hidden = false;
}

// Given a proposed rect for the moving group, return the snapped x/y.
function snapRect(rect, exclude) {
  const th = SNAP_PX / board.zoom;
  const g = LINK_GAP;
  let bestX = null, bestY = null;
  const others = tiles.filter((t) => t.board && !exclude.has(t));
  const L = rect.x, R = rect.x + rect.w, T = rect.y, Bm = rect.y + rect.h;
  for (const o of others) {
    const b = o.board;
    const oL = b.x, oR = b.x + b.w, oT = b.y, oB = b.y + b.h;
    // x candidates: [our edge, target position for our left, guide x]
    const xs = [
      [L, oL, oL], [L, oR + g, oR], [L, oR, oR],
      [R, oR - rect.w, oR], [R, oL - g - rect.w, oL], [R, oL - rect.w, oL],
    ];
    for (const [edge, newX, guide] of xs) {
      const d = Math.abs(newX - rect.x);
      if (d <= th && (!bestX || d < bestX.d)) bestX = { d, x: newX, guide };
      void edge;
    }
    const ys = [
      [T, oT, oT], [T, oB + g, oB], [T, oB, oB],
      [Bm, oB - rect.h, oB], [Bm, oT - g - rect.h, oT], [Bm, oT - rect.h, oT],
    ];
    for (const [edge, newY, guide] of ys) {
      const d = Math.abs(newY - rect.y);
      if (d <= th && (!bestY || d < bestY.d)) bestY = { d, y: newY, guide };
      void edge;
    }
  }
  hideGuides();
  const out = { x: rect.x, y: rect.y };
  if (bestX) { out.x = bestX.x; showGuideV(bestX.guide); }
  if (bestY) { out.y = bestY.y; showGuideH(bestY.guide); }
  return out;
}

// Give tiles that have no board position a spot. If nothing is on the board
// yet, mirror the gallery arrangement so switching modes doesn't jump; else
// flow them in rows underneath everything that is already there. `at` (canvas
// coords) cascades them from a drop point instead.
function placeOnBoard(list, at = null) {
  if (!list.length) return;
  const others = tiles.filter((t) => t.board && !list.includes(t));

  if (at) {
    let i = 0;
    for (const t of list) {
      const h = galleryHOf(t);
      t.board = { x: at.x + 24 * i, y: at.y + 24 * i, w: h * t.aspect, h };
      i++;
    }
    return;
  }

  if (!others.length && !isBoard()) {
    // called while still in gallery mode: copy the on-screen rectangles
    for (const t of list) {
      t.board = { x: t.el.offsetLeft, y: t.el.offsetTop, w: t.el.offsetWidth, h: t.el.offsetHeight };
    }
    return;
  }

  const r = gridRect();
  let x0, y0, rowW;
  if (others.length) {
    const bb = boardBounds(others);
    x0 = bb.minX; y0 = bb.maxY + GAP * 2;
    rowW = Math.max(bb.w, (r.width - 80) / board.zoom);
  } else {
    const c = toCanvas(r.left + 40, r.top + 40);
    x0 = c.x; y0 = c.y;
    rowW = (r.width - 80) / board.zoom;
  }
  let x = x0, y = y0, rowH = 0;
  for (const t of list) {
    const h = galleryHOf(t);
    const w = h * t.aspect;
    if (x > x0 && x + w > x0 + rowW) { x = x0; y += rowH + GAP; rowH = 0; }
    t.board = { x, y, w, h };
    x += w + GAP;
    rowH = Math.max(rowH, h);
  }
}

// Re-flow every board tile into neat rows, keeping each one's size.
function tidyBoard() {
  if (!tiles.length) return;
  const entry = recordMove(tiles.filter((t) => t.board));
  const r = gridRect();
  const bb = boardBounds() || { minX: 0, minY: 0, w: 0 };
  const x0 = bb.minX, y0 = bb.minY;
  const rowW = Math.max(bb.w, (r.width - 80) / board.zoom);
  let x = x0, y = y0, rowH = 0;
  for (const t of tiles) {
    const { w, h } = t.board;
    if (x > x0 && x + w > x0 + rowW) { x = x0; y += rowH + GAP * 2; rowH = 0; }
    t.board.x = x; t.board.y = y;
    x += w + GAP * 2;
    rowH = Math.max(rowH, h);
  }
  layoutTiles();
  finishRects(entry);
  fitAll();
}

function setMode(mode) {
  mode = mode === 'board' ? 'board' : 'gallery';
  if (mode !== layout.mode) logUi('info', 'mode', { to: mode, tiles: tiles.length });
  if (mode === 'board' && !isBoard()) {
    // seed positions before the CSS switch so gallery offsets are still valid
    placeOnBoard(tiles.filter((t) => !t.board));
    if (!board.initialized) { board.panX = GAP; board.panY = GAP; board.zoom = 1; board.initialized = true; }
  }
  layout.mode = mode;
  if (!isBoard() || mode !== 'board') { clearSelection(); hideGuides(); }
  document.body.classList.toggle('mode-board', isBoard());
  for (const b of modeEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === mode);
  layoutTiles();
}

/* DISABLED (Mark, 2026-09-12): these searched for one shared row height; Fit all now scales the
   tiles' own heights proportionally (Arrange.packs / Arrange.fitScale).
function packsAt(rowHeight) {
  const W = innerWidth();
  const H = innerHeight();
  const rows = [];
  let x = 0, rowH = 0;
  for (const t of tiles) {
    const h = rowHeight;
    const w = h * t.aspect;
    if (w > W) return false;
    if (x > 0 && x + GAP + w > W) { rows.push(rowH); x = 0; rowH = 0; }
    x += (x > 0 ? GAP : 0) + w;
    rowH = Math.max(rowH, h);
  }
  rows.push(rowH);
  const total = rows.reduce((a, b) => a + b, 0) + GAP * (rows.length - 1);
  return total <= H;
}

function fitGallery() {
  let lo = MIN_H, hi = MAX_H;
  if (!packsAt(lo)) { setRowHeight(lo); return; }
  for (let i = 0; i < 40 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (packsAt(mid)) lo = mid; else hi = mid;
  }
  setRowHeight(Math.floor(lo));
}
*/
// Fit all (gallery): one factor for every tile, so the sizes set by hand keep their ratios.
function fitGallery() {
  if (!tiles.length) return;
  const items = tiles.map((t) => ({ aspect: t.aspect, h: galleryHOf(t) }));
  const f = Arrange.fitScale(items, innerWidth(), innerHeight(), GAP);
  scaleGallery(f);
}

function fitBoard() {
  const bb = boardBounds();
  if (!bb) return;
  const r = gridRect();
  const pad = 40;
  const z = clamp(Math.min((r.width - pad) / Math.max(bb.w, 1), (r.height - pad) / Math.max(bb.h, 1)), MIN_ZOOM, MAX_ZOOM);
  board.zoom = z;
  board.panX = (r.width - bb.w * z) / 2 - bb.minX * z;
  board.panY = (r.height - bb.h * z) / 2 - bb.minY * z;
  applyBoardView();
}

function fitAll() {
  if (!tiles.length) return;
  if (isBoard()) fitBoard(); else fitGallery();
}

function scheduleFit() {
  pendingFit = true;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { if (pendingFit) { pendingFit = false; fitAll(); } }, 150);
}

// ---------- corner resize ----------
// Only the tile you drag changes, in both modes. Board: anchored on the
// opposite corner so the far edge stays put.
function startResize(tile, corner, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch {}

  const startX = e.clientX, startY = e.clientY;
  const sx = corner.includes('l') ? -1 : 1;
  const sy = corner.includes('t') ? -1 : 1;
  const onBoard = isBoard();
  const start = onBoard ? { ...tile.board } : { w: tile.el.offsetWidth, h: tile.el.offsetHeight };
  if (onBoard) { bringToFront(tile); rememberStart(); }
  // Linked mode can push neighbours, so remember every board rect
  const undoEntry = onBoard ? recordResize(tiles.filter((t) => t.board)) : recordGResize(tile);
  const fixed = new Set([tile]);
  tile.el.classList.add('resizing');
  document.body.classList.add('resizing');
  document.body.style.cursor = getComputedStyle(handle).cursor;

  const onMove = (ev) => {
    const scale = onBoard ? board.zoom : 1;
    const dx = (ev.clientX - startX) * sx / scale;
    const dy = (ev.clientY - startY) * sy / scale;
    // follow whichever axis the user is pulling harder on
    const fromW = (start.w + dx) / tile.aspect;
    const fromH = start.h + dy;
    let h = Math.abs(fromW - start.h) > Math.abs(fromH - start.h) ? fromW : fromH;
    if (onBoard) {
      h = clamp(h, BOARD_MIN_H, BOARD_MAX_H);
      const w = h * tile.aspect;
      const b = tile.board;
      if (corner.includes('l')) b.x = start.x + (start.w - w);
      if (corner.includes('t')) b.y = start.y + (start.h - h);
      b.w = w; b.h = h;
      layoutTile(tile);
      if (board.linked && !ev.altKey) resolveOverlaps(fixed);
    } else {
      setTileGalleryH(tile, h); // gallery: just this tile
    }
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    tile.el.classList.remove('resizing');
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
    if (onBoard) finishRects(undoEntry); else finishGResize(undoEntry);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// ---------- board: move a tile ----------

function attachTileDrag(tile) {
  const el = tile.el;
  el.addEventListener('pointerdown', (e) => {
    if (!isBoard() || e.button !== 0 || !tile.board || e.altKey) return;
    if (e.target.closest('.handle, input, button, select')) return;
    if (e.shiftKey) {
      // shift-click toggles membership without starting a drag
      setSelected(tile, !selection.has(tile));
      selectionStatus();
      tile.suppressClick = true;
      setTimeout(() => { tile.suppressClick = false; }, 0);
      return;
    }
    // Ctrl: just this tile, even inside a sticky group. Otherwise clicking a
    // member selects its whole group (so its settings bar shows).
    const single = modKey(e);
    if (single) selectOnly(tile);
    else if (tile.group && !selection.has(tile)) selectGroupOf(tile);
    const start = { x: e.clientX, y: e.clientY };
    let moving = false;
    let group = [];
    let movingSet = new Set();
    let undoEntry = null;
    const onMove = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moving) {
        if (Math.hypot(dx, dy) < 4) return;
        moving = true;
        try { el.setPointerCapture(ev.pointerId); } catch {}
        // dragging something outside the selection makes it the selection
        if (!selection.has(tile)) selectOnly(tile);
        if (single) group = [tile];
        else {
          // members of non-sticky groups move on their own; sticky groups move whole
          const set = new Set([...selection].filter((t) => t === tile || !t.group || t.group.sticky));
          for (const t of [...set]) if (t.group && t.group.sticky) for (const m of t.group.members) if (m.board) set.add(m);
          group = [...set];
        }
        movingSet = new Set(group);
        rememberStart();
        undoEntry = recordMove(tiles.filter((t) => t.board)); // all board tiles: Linked mode can push neighbours
        for (const t of group) { bringToFront(t); t.el.classList.add('dragging'); }
        document.body.classList.add('tile-dragging');
      }
      // proposed position of the group's bounding box
      const bb0 = boardBounds(group.map((t) => ({ board: startPos.get(t) })));
      let nx = bb0.minX + dx / board.zoom, ny = bb0.minY + dy / board.zoom;
      if (!ev.altKey) {
        const s = snapRect({ x: nx, y: ny, w: bb0.w, h: bb0.h }, movingSet);
        nx = s.x; ny = s.y;
      } else hideGuides();
      const shiftX = nx - bb0.minX, shiftY = ny - bb0.minY;
      for (const t of group) {
        const s = startPos.get(t);
        t.board.x = s.x + shiftX; t.board.y = s.y + shiftY;
        layoutTile(t);
      }
      if (board.linked && !ev.altKey) resolveOverlaps(movingSet);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      hideGuides();
      if (moving) {
        finishRects(undoEntry);
        for (const t of group) t.el.classList.remove('dragging');
        document.body.classList.remove('tile-dragging');
        tile.suppressClick = true;
        setTimeout(() => { tile.suppressClick = false; }, 0);
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

// ---------- board: pan the view / lasso ----------

function startPan(e) {
  e.preventDefault();
  try { grid.setPointerCapture(e.pointerId); } catch {}
  const ox = e.clientX - board.panX, oy = e.clientY - board.panY;
  document.body.classList.add('panning');
  const onMove = (ev) => { board.panX = ev.clientX - ox; board.panY = ev.clientY - oy; applyBoardView(); };
  const onUp = () => {
    grid.removeEventListener('pointermove', onMove);
    grid.removeEventListener('pointerup', onUp);
    grid.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('panning');
  };
  grid.addEventListener('pointermove', onMove);
  grid.addEventListener('pointerup', onUp);
  grid.addEventListener('pointercancel', onUp);
}

function startLasso(e) {
  e.preventDefault();
  try { grid.setPointerCapture(e.pointerId); } catch {}
  const r = gridRect();
  const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
  const additive = e.shiftKey;
  const before = additive ? new Set(selection) : new Set();
  if (!additive) clearSelection();
  let dragged = false;
  const onMove = (ev) => {
    const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
    if (!dragged && Math.hypot(x1 - x0, y1 - y0) < 3) return;
    dragged = true;
    const left = Math.min(x0, x1), top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    marqueeEl.style.left = left + 'px'; marqueeEl.style.top = top + 'px';
    marqueeEl.style.width = w + 'px'; marqueeEl.style.height = h + 'px';
    marqueeEl.hidden = false;
    // select every tile the rectangle touches
    const a = toCanvas(left + r.left, top + r.top);
    const b = toCanvas(left + w + r.left, top + h + r.top);
    const hits = new Set();
    for (const t of tiles) {
      if (!t.board) continue;
      const B = t.board;
      if (B.x < b.x && B.x + B.w > a.x && B.y < b.y && B.y + B.h > a.y) hits.add(t);
    }
    // a sticky group is lassoed as one
    for (const t of [...hits]) if (t.group && t.group.sticky) for (const m of t.group.members) hits.add(m);
    for (const t of tiles) if (t.board) setSelected(t, hits.has(t) || before.has(t));
  };
  const onUp = () => {
    grid.removeEventListener('pointermove', onMove);
    grid.removeEventListener('pointerup', onUp);
    grid.removeEventListener('pointercancel', onUp);
    marqueeEl.hidden = true;
    if (dragged) selectionStatus();
  };
  grid.addEventListener('pointermove', onMove);
  grid.addEventListener('pointerup', onUp);
  grid.addEventListener('pointercancel', onUp);
}

grid.addEventListener('pointerdown', (e) => {
  if (!isBoard()) return;
  const onBackground = e.target === grid || e.target === canvas;
  if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && onBackground && board.hand)) return startPan(e);
  if (e.button === 0 && onBackground) return startLasso(e);
});
// stop Chromium's middle-click autoscroll from fighting the pan
grid.addEventListener('mousedown', (e) => { if (isBoard() && e.button === 1) e.preventDefault(); });

// One wheel notch zooms 8 %, and a single event counts at most three notches, so a fast flick
// can't throw the view across the range. A trackpad sends small deltas and gets proportionally
// small steps. The same step is used everywhere zooming happens by wheel.
const ZOOM_PER_NOTCH = 1.08;
const wheelZoomFactor = (e) => {
  const notches = clamp(Math.abs(e.deltaY) / 100, 0, 3);
  return Math.pow(ZOOM_PER_NOTCH, e.deltaY < 0 ? notches : -notches);
};
// wheel: board pans, gallery scrolls — unless Ctrl is held, the ✋ Pan + zoom tool is on, or the
// "Wheel zoom" box is ticked, in which case the wheel zooms (Shift+wheel always stays scrolling)
grid.addEventListener('wheel', (e) => {
  const wheelZooms = !!(settings && settings.wheelZoom) && !e.shiftKey;
  if (isBoard()) {
    e.preventDefault();
    if (e.ctrlKey || wheelZooms || (board.hand && !e.shiftKey)) {
      zoomAt(board.zoom * wheelZoomFactor(e), e.clientX, e.clientY);
    } else {
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      const dy = e.shiftKey ? 0 : e.deltaY;
      board.panX -= dx; board.panY -= dy;
      applyBoardView();
    }
  } else if (e.ctrlKey || wheelZooms) {
    e.preventDefault();
    noteGalleryScaleChange();
    scaleGallery(wheelZoomFactor(e)); // keeps the tiles' relative sizes
  }
}, { passive: false });

// ---------- bookmarks (local and YouTube tiles) ----------

function parseBookmarks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && isFinite(Number(b.t)) && Number(b.t) >= 0)
    .map((b) => ({ t: Number(b.t), label: typeof b.label === 'string' ? b.label : '', color: MARKER_KEYS.includes(b.color) ? b.color : 'yellow' }))
    .sort((a, b) => a.t - b.t);
}
// Markers on the tile's scrub bar, the 🔖 list panel, and tile.addBookmark / jumpBookmark /
// refreshBookmarks. pb gives the time and duration; tile.seekTo(t) jumps (and tells a synced group).
function attachBookmarks(tile, el, pb) {
  const bmAddBtn = el.querySelector('.bm-add');
  const bmListBtn = el.querySelector('.bm-list');
  const bmCount = el.querySelector('.bm-count');
  const markersEl = el.querySelector('.markers');
  const bmPanel = el.querySelector('.bm-panel');
  const seekTo = (t) => tile.seekTo(t);
  const bmTitle = (b) => (b.label ? `${b.label} · ${fmtTime(b.t)}` : fmtTime(b.t));
  const renderMarkers = () => {
    markersEl.textContent = '';
    bmCount.textContent = String(tile.bookmarks.length);
    bmListBtn.classList.toggle('has-some', tile.bookmarks.length > 0);
    if (!pb.duration) return;
    for (const b of tile.bookmarks) {
      const m = document.createElement('div');
      m.className = 'marker';
      m.style.left = (clamp(b.t / pb.duration, 0, 1) * 100).toFixed(3) + '%';
      m.style.background = MARKER_COLORS[b.color];
      m.title = bmTitle(b) + '  (right-click to delete, Shift-right-click to recolour)';
      m.addEventListener('click', (e) => { e.stopPropagation(); seekTo(b.t); });
      m.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) { b.color = nextMarkerColor(b.color); refreshBookmarks(); } else deleteBookmark(b);
      });
      m.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a board drag
      markersEl.appendChild(m);
    }
  };
  const renderPanel = () => {
    bmPanel.textContent = '';
    const head = document.createElement('div');
    head.className = 'bm-head';
    head.innerHTML = '<span></span>';
    head.firstChild.textContent = tile.bookmarks.length ? `${tile.bookmarks.length} bookmark${tile.bookmarks.length === 1 ? '' : 's'}` : 'No bookmarks yet';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add at ' + fmtTime(pb.time);
    addBtn.addEventListener('click', () => addBookmark());
    head.appendChild(addBtn);
    bmPanel.appendChild(head);
    for (const b of tile.bookmarks) {
      const row = document.createElement('div');
      row.className = 'bm-row';
      const go = document.createElement('button');
      go.className = 'bm-time';
      go.textContent = fmtTime(b.t);
      go.title = 'Jump here';
      go.addEventListener('click', () => seekTo(b.t));
      const label = document.createElement('input');
      label.className = 'bm-label';
      label.type = 'text';
      label.placeholder = 'name this bookmark…';
      label.value = b.label;
      label.addEventListener('input', () => { b.label = label.value; renderMarkers(); });
      label.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') label.blur(); e.stopPropagation(); });
      const del = document.createElement('button');
      del.className = 'bm-del';
      del.textContent = '✕';
      del.title = 'Delete bookmark';
      del.addEventListener('click', () => deleteBookmark(b));
      const sw = document.createElement('button');
      sw.className = 'bm-color';
      sw.title = 'Click to change colour';
      sw.style.background = MARKER_COLORS[b.color];
      sw.addEventListener('click', () => { b.color = nextMarkerColor(b.color); refreshBookmarks(); });
      row.append(sw, go, label, del);
      bmPanel.appendChild(row);
    }
  };
  const refreshBookmarks = () => { renderMarkers(); if (!bmPanel.classList.contains('hidden')) renderPanel(); renderTimeline(); };
  tile.refreshBookmarks = refreshBookmarks;
  const addBookmark = (t = pb.time) => {
    if (!isFinite(t)) return;
    // don't stack two bookmarks on the same frame
    if (tile.bookmarks.some((b) => Math.abs(b.t - t) < 0.05)) { setStatus('Bookmark already exists at ' + fmtTime(t)); return; }
    tile.bookmarks.push({ t, label: '', color: 'yellow' });
    tile.bookmarks.sort((a, b) => a.t - b.t);
    refreshBookmarks();
    setStatus(`Bookmark added at ${fmtTime(t)} – ${tileName(tile)}`);
  };
  const deleteBookmark = (b) => {
    const i = tile.bookmarks.indexOf(b);
    if (i >= 0) tile.bookmarks.splice(i, 1);
    refreshBookmarks();
  };
  const jumpBookmark = (dir) => {
    if (!tile.bookmarks.length) { setStatus('No bookmarks on this video'); return; }
    const cur = pb.time;
    const target = dir > 0
      ? tile.bookmarks.find((b) => b.t > cur + 0.5)
      : [...tile.bookmarks].reverse().find((b) => b.t < cur - 0.5);
    if (target) seekTo(target.t);
    else setStatus(dir > 0 ? 'No later bookmark' : 'No earlier bookmark');
  };
  const togglePanel = (show = bmPanel.classList.contains('hidden')) => {
    bmPanel.classList.toggle('hidden', !show);
    el.classList.toggle('panel-open', show);
    if (show) renderPanel();
  };
  tile.addBookmark = addBookmark;
  tile.jumpBookmark = jumpBookmark;

  bmAddBtn.addEventListener('click', () => addBookmark());
  bmListBtn.addEventListener('click', () => togglePanel());
  for (const b of [bmAddBtn, bmListBtn]) b.addEventListener('dblclick', (e) => e.stopPropagation());
  bmPanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  bmPanel.addEventListener('dblclick', (e) => e.stopPropagation());
  bmPanel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  el.addEventListener('pointerleave', () => togglePanel(false));
  return { renderMarkers };
}

// ---------- tiles ----------

function addVideo(filePath, state = {}) {
  const frag = tileTemplate.content.cloneNode(true);
  const el = frag.querySelector('.tile');
  const video = el.querySelector('video');
  const nameEl = el.querySelector('.name');
  const removeBtn = el.querySelector('.remove');
  const seek = el.querySelector('.seek');
  const playBtn = el.querySelector('.play');
  const timeEl = el.querySelector('.time');
  const muteBtn = el.querySelector('.mute');
  const volZone = el.querySelector('.vol-zone');
  const volBar = el.querySelector('.vol-bar');
  const volPct = el.querySelector('.vol-pct');
  const rate = el.querySelector('.rate');
  const errorEl = el.querySelector('.error');
  const backBtn = el.querySelector('.back');
  const fwdBtn = el.querySelector('.fwd');

  const tile = {
    path: filePath, el, video, mediaEl: video, pb: videoPlayback(video), seek, time: timeEl, scrubbing: false,
    volume: DEFAULT_VIDEO_VOLUME,
    aspect: Number(state.aspect) > 0 ? Number(state.aspect) : DEFAULT_ASPECT,
    board: null,
    suppressClick: false,
    galleryH: Number(state.galleryH) > 0 ? clamp(Number(state.galleryH), MIN_H, MAX_H) : layout.rowHeight,
    bookmarks: parseBookmarks(state.bookmarks),
  };
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) {
    tile.board = { x: Number(sb.x), y: Number(sb.y), w: Number(sb.w), h: Number(sb.h) };
  }
  tiles.push(tile);
  tile.info = null; tile.proxy = null; tile.fps = null;
  tile.fpsOverride = Number(state.fpsOverride) > 0 ? Number(state.fpsOverride) : null; // ⚙: frame step / timecode only
  tile.group = null; tile.sync = null; tile.ownMuted = !!state.muted;
  // its own colour for multi-video timelines: saved, else round-robin by position at creation
  tile.hue = GROUP_PALETTE.includes(state.color) ? state.color : GROUP_PALETTE[(tiles.length - 1) % GROUP_PALETTE.length];
  tile.loop = state.loop === true;

  nameEl.textContent = basename(filePath);
  nameEl.title = filePath + '\nRight-click: ' + REVEAL_LABEL;
  nameEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); sourceContext(e, 'file', filePath); });

  // initial per-video state (from a session file, or defaults)
  tile.volume = clamp(Number(state.volume ?? DEFAULT_VIDEO_VOLUME), 0, 1);
  applyTileVolume(tile);
  video.muted = !!state.muted;
  video.playbackRate = Number(state.playbackRate) > 0 ? Number(state.playbackRate) : 1;
  rate.value = String(video.playbackRate);
  if (rate.value !== String(video.playbackRate)) rate.value = '1';

  const wantTime = Number(state.currentTime) > 0 ? Number(state.currentTime) : 0;
  const wantPlaying = state.paused === false;

  const updateTimeLabel = () => {
    timeEl.textContent = Frames.format(video.currentTime, video.duration, effectiveFps(tile), layout.timeDisplay);
  };
  const updateSeek = () => {
    if (tile.scrubbing || !video.duration) return;
    const frac = video.currentTime / video.duration;
    const v = Math.round(frac * 10000);
    if (Number(seek.value) !== v) {
      seek.value = String(v);
      seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    }
  };
  const updatePlayBtn = () => {
    playBtn.textContent = video.paused ? '▶' : '❚❚';
    el.classList.toggle('paused-badge', video.paused);
  };
  const updateMuteBtn = () => {
    muteBtn.textContent = video.muted || tile.volume === 0 ? '🔇' : '🔊';
  };
  const updateVolUI = () => {
    const pct = Math.round(tile.volume * 100);
    volBar.style.setProperty('--vol', pct + '%');
    volPct.textContent = pct + '%';
  };
  tile.tick = () => { updateSeek(); };

  // ----- seeking helpers -----
  const seekTo = (t) => {
    if (!video.duration) return;
    video.currentTime = clamp(t, 0, video.duration);
    updateTimeLabel();
    updateSeek();
    broadcast(tile, 'seek');
  };
  const seekBy = (dt) => seekTo(video.currentTime + dt);
  tile.seekBy = seekBy;
  const stepFrame = (dir) => {
    if (!video.duration) return;
    video.pause();
    broadcast(tile, 'pause');
    seekTo(Frames.step(video.currentTime, effectiveFps(tile) || Frames.DEFAULT_FPS, dir));
  };
  // play/pause from the user (picture click, ▶ button, K); synced members follow
  tile.togglePlay = () => { togglePlay(video); broadcast(tile, video.paused ? 'pause' : 'play'); };
  tile.stepFrame = stepFrame;
  el.querySelector('.fstep-back').addEventListener('click', () => stepFrame(-1));
  el.querySelector('.fstep-fwd').addEventListener('click', () => stepFrame(1));
  timeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const modes = ['clock', 'frames', 'timecode'];
    layout.timeDisplay = modes[(modes.indexOf(layout.timeDisplay) + 1) % modes.length];
    for (const t of tiles) t.tick && t.refreshTime && t.refreshTime();
    renderTimeline(); // lane timecodes follow the display mode
  });
  tile.refreshTime = updateTimeLabel;

  // ----- bookmarks (shared with YouTube tiles: attachBookmarks) -----
  tile.seekTo = seekTo;
  const { renderMarkers } = attachBookmarks(tile, el, tile.pb);
  backBtn.addEventListener('click', (e) => seekBy(e.shiftKey ? -30 : -5));
  fwdBtn.addEventListener('click', (e) => seekBy(e.shiftKey ? 30 : 5));
  for (const b of [backBtn, fwdBtn, el.querySelector('.fstep-back'), el.querySelector('.fstep-fwd')]) b.addEventListener('dblclick', (e) => e.stopPropagation());

  el.addEventListener('pointerenter', () => { hoveredTile = tile; });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; });

  const errorText = errorEl.querySelector('.error-text');
  const makeBtn = errorEl.querySelector('.make-proxy');
  const cancelBtn = errorEl.querySelector('.cancel-proxy');
  const bar = errorEl.querySelector('.proxy-bar');
  const fill = errorEl.querySelector('.proxy-fill');

  const showError = (msg, canProxy) => {
    errorText.textContent = `${msg}\n${filePath}`;
    makeBtn.classList.toggle('hidden', !canProxy);
    errorEl.classList.remove('hidden');
  };
  tile.setSource = (url) => { errorEl.classList.add('hidden'); video.src = url; };

  const startProxy = async () => {
    makeBtn.classList.add('hidden'); cancelBtn.classList.remove('hidden'); bar.classList.remove('hidden');
    errorText.textContent = 'Making a playable copy…';
    try {
      const { proxy } = await window.api.makeProxy(filePath);
      tile.proxy = proxy;
      tile.setSource(window.api.videoUrl(proxy));
    } catch (e) {
      // ipcRenderer.invoke wraps main-process errors; show only ffmpeg's own message
      showError(String(e.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''), true);
    } finally {
      cancelBtn.classList.add('hidden'); bar.classList.add('hidden'); fill.style.width = '0';
    }
  };
  tile.onProxyProgress = (frac) => { fill.style.width = Math.round(frac * 100) + '%'; };
  makeBtn.addEventListener('click', startProxy);
  cancelBtn.addEventListener('click', () => window.api.cancelProxy(filePath));
  for (const b of [makeBtn, cancelBtn]) b.addEventListener('pointerdown', (e) => e.stopPropagation());

  (async () => {
    const info = await window.api.probe(filePath);
    if (!tiles.includes(tile)) return; // removed while probing
    tile.info = info; tile.fps = info.fps || null;
    if (!info.available && !toolsWarned) { toolsWarned = true; setStatus('ffmpeg / ffprobe not found – Make playable and frame rates are unavailable', 8000); }
    if (info.proxy) { tile.proxy = info.proxy; tile.setSource(window.api.videoUrl(info.proxy)); return; }
    // known codec with no mime (prores, mpeg4, ...) can't play; probe failed (no codec) -> let Chromium try
    const playable = info.mime ? video.canPlayType(info.mime) !== '' : !info.codec;
    if (!playable && info.available) showError(`${info.codec || 'This codec'} can't play here.`, true);
    else tile.setSource(window.api.videoUrl(filePath));
  })();

  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const ar = video.videoWidth / video.videoHeight;
      if (Math.abs(ar - tile.aspect) > 0.001) {
        tile.aspect = ar;
        if (tile.board) tile.board.w = tile.board.h * ar; // keep height, fix width
        layoutTiles();
      }
    }
    if (pendingFit) scheduleFit();
    video.playbackRate = Number(rate.value) || 1; // loading a src resets the rate to 1; the select holds the wanted speed
    if (wantTime > 0) {
      video.currentTime = isFinite(video.duration) ? Math.min(wantTime, video.duration) : wantTime;
    }
    updateTimeLabel();
    updateSeek();
    renderMarkers();
    if (wantPlaying) video.play().catch(() => {});
  });
  video.addEventListener('timeupdate', () => { if (!tile.scrubbing) updateTimeLabel(); });
  video.addEventListener('durationchange', () => {
    updateTimeLabel(); renderMarkers();
    if (tl._model && tl._model.members.some((m) => m.tile === tile)) renderTimeline(); // extent grows as durations load
  });
  // UI only: a synced member paused by the loop engine must not pause its group
  const onPlayState = () => { updatePlayBtn(); if (tile.group && tile.group === active) renderGroupBar(); };
  video.addEventListener('play', onPlayState);
  video.addEventListener('pause', onPlayState);
  video.addEventListener('ended', onPlayState);
  video.addEventListener('volumechange', updateMuteBtn);
  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 0;
    const why = code === 3 ? 'Decoding error – corrupt file or unsupported codec.' : 'Cannot play this file.';
    showError(why, !!(tile.info && tile.info.available) && !tile.proxy);
  });

  // click on picture = play/pause; double-click = fullscreen this tile
  video.addEventListener('click', (e) => {
    // Shift-click selects (board: attachTileDrag; gallery: the el click below) and never plays or pauses.
    // (suppressClick is cleared by a setTimeout(0) that fires before this click arrives, so it can't guard this.)
    if (e.shiftKey) return;
    if (!tile.suppressClick) tile.togglePlay();
  });
  el.addEventListener('click', (e) => {
    if (isBoard() || !e.shiftKey || e.target.closest('button, input, select, .bm-panel')) return;
    setSelected(tile, !selection.has(tile));
    selectionStatus();
  });
  video.addEventListener('dblclick', () => {
    if (!cmp.el.hidden) return; // in the compare view the tile is empty
    toggleTileFullscreen(el);
  });

  playBtn.addEventListener('click', () => tile.togglePlay());

  // scrubbing
  const beginScrub = () => { tile.scrubbing = true; el.classList.add('scrubbing'); };
  const endScrub = () => { tile.scrubbing = false; el.classList.remove('scrubbing'); updateSeek(); };
  seek.addEventListener('pointerdown', beginScrub);
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('input', () => {
    if (!video.duration) return;
    const frac = Number(seek.value) / 10000;
    video.currentTime = frac * video.duration;
    seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    updateTimeLabel();
    broadcast(tile, 'seek');
  });
  seek.addEventListener('change', () => { if (!tile.scrubbing) updateSeek(); });
  seek.addEventListener('keydown', (e) => {
    // step 5 s with arrow keys instead of 1/10000 of the video
    if (!video.duration) return;
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - step); broadcast(tile, 'seek'); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + step); broadcast(tile, 'seek'); }
  });

  // volume / mute / speed
  const setTileVolume = (pct) => {
    tile.volume = clamp(pct, 0, 100) / 100;
    applyTileVolume(tile);
    if (tile.volume > 0 && tile.ownMuted) setOwnMuted(tile, false);
    updateMuteBtn();
    updateVolUI();
  };
  tile.setVolume = setTileVolume;
  muteBtn.addEventListener('click', () => setOwnMuted(tile, !tile.ownMuted));
  const loopBtn = el.querySelector('.loop');
  loopBtn.addEventListener('click', () => setTileLoop(tile, !tile.loop));
  loopBtn.addEventListener('dblclick', (e) => e.stopPropagation());
  applyTileLoop(tile);
  wireSettingsButton(tile);
  rate.addEventListener('change', () => { video.playbackRate = Number(rate.value); broadcast(tile, 'rate', video.playbackRate); });

  // volume bar: click or drag anywhere on it; the level is wherever the mouse is
  const volFromPointer = (clientY) => {
    const r = volBar.getBoundingClientRect();
    setTileVolume(Math.round((1 - (clientY - r.top) / r.height) * 100));
  };
  volZone.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('vol-active');
    try { volZone.setPointerCapture(e.pointerId); } catch {}
    volFromPointer(e.clientY);
    const onMove = (ev) => volFromPointer(ev.clientY);
    const onUp = () => {
      volZone.removeEventListener('pointermove', onMove);
      volZone.removeEventListener('pointerup', onUp);
      volZone.removeEventListener('pointercancel', onUp);
      el.classList.remove('vol-active');
    };
    volZone.addEventListener('pointermove', onMove);
    volZone.addEventListener('pointerup', onUp);
    volZone.addEventListener('pointercancel', onUp);
  });
  volZone.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setTileVolume(Math.round(tile.volume * 100) + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });
  volZone.addEventListener('click', (e) => e.stopPropagation());
  volZone.addEventListener('dblclick', (e) => e.stopPropagation());

  removeBtn.addEventListener('click', () => removeTile(tile));
  wireFullscreenButton(el);

  // corner resize handles
  for (const h of el.querySelectorAll('.handle')) {
    h.addEventListener('pointerdown', (e) => startResize(tile, h.dataset.corner, e));
    h.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (isBoard() && tile.board) {
        const entry = recordResize([tile]);
        tile.board.h = layout.rowHeight; tile.board.w = layout.rowHeight * tile.aspect;
        layoutTile(tile);
        finishRects(entry);
      } else {
        fitAll();
      }
    });
  }

  attachTileDrag(tile);

  updatePlayBtn();
  updateMuteBtn();
  updateVolUI();
  updateTimeLabel();
  renderMarkers();
  canvas.appendChild(frag);
  updateChrome();
  return tile;
}

// Fullscreen one tile: the ⛶ button (top-right of every tile), double-click on a video or image; Esc leaves.
function toggleTileFullscreen(el) {
  if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch(() => {});
}
function wireFullscreenButton(el) {
  const b = el.querySelector('.fullscreen');
  b.addEventListener('click', (e) => { e.stopPropagation(); toggleTileFullscreen(el); });
  for (const ev of ['pointerdown', 'dblclick']) b.addEventListener(ev, (e) => e.stopPropagation()); // never a board drag
}
document.addEventListener('fullscreenchange', () => {
  for (const t of tiles) {
    const b = t.el.querySelector('.fullscreen');
    const on = document.fullscreenElement === t.el;
    if (!b.dataset.enterTitle) b.dataset.enterTitle = b.title;
    b.title = on ? 'Exit fullscreen (Esc)' : b.dataset.enterTitle;
  }
});

function togglePlay(video) {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function removeTile(tile, { record = true } = {}) {
  if (record && tiles.includes(tile)) recordRemove(tile); // before it leaves `tiles`, so the index is right
  const i = tiles.indexOf(tile);
  if (i >= 0) tiles.splice(i, 1);
  if (tile.group) removeFromGroup(tile.group, tile);
  selection.delete(tile);
  syncActiveFromSelection();
  if (tile.video) {
    try {
      tile.video.pause();
      tile.video.removeAttribute('src');
      tile.video.load();
    } catch {}
  }
  if (tile.destroy) tile.destroy();
  tile.el.remove();
  updateChrome();
  markOnBoard();
  renderTimeline();
}

// ---------- web tiles (YouTube / Twitch) ----------
const webTileTemplate = document.getElementById('web-tile-template');
// Must match the page's host for Twitch's frame-ancestors check; main says 127.0.0.1.
let twitchParent = location.hostname;
window.api.parent().then((p) => { if (p) twitchParent = p; });

// Minimal YouTube iframe-API client over postMessage (no external script needed).
function ytController(iframe) {
  const msg = (o) => iframe.contentWindow && iframe.contentWindow.postMessage(JSON.stringify({ ...o, id: 1, channel: 'widget' }), '*');
  const post = (func, args = []) => msg({ event: 'command', func, args });
  const st = { ready: false, state: -1, time: 0, duration: 0, muted: false, volume: 100 };
  const listeners = new Set();
  let hello = null;
  // after our own play / pause, reports that still say the old state are ignored for a moment
  let intent = null, intentAt = 0;
  const isPlayState = (s) => s === 1 || s === 3;
  const setState = (s) => { if (intent && performance.now() - intentAt < 700 && isPlayState(s) !== (intent === 'play')) return; st.state = s; };
  const assume = (kind) => { intent = kind; intentAt = performance.now(); st.state = kind === 'play' ? 3 : 2; };
  const onMsg = (e) => {
    if (e.source !== iframe.contentWindow) return;
    let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.event === 'onReady') { st.ready = true; clearInterval(hello); post('addEventListener', ['onStateChange']); }
    if (d.event === 'infoDelivery' && d.info) {
      if (!st.ready) { st.ready = true; clearInterval(hello); }
      if ('currentTime' in d.info) { st.time = d.info.currentTime; st.at = performance.now(); } // `at`: when, for extrapolating
      if ('duration' in d.info) st.duration = d.info.duration;
      if ('playbackRate' in d.info) st.rate = d.info.playbackRate;
      if ('playerState' in d.info) setState(d.info.playerState);
      if ('muted' in d.info) st.muted = d.info.muted;
      if ('volume' in d.info) st.volume = d.info.volume;
    }
    if (d.event === 'onStateChange') setState(d.info);
    for (const l of listeners) l(st, d.event);
  };
  window.addEventListener('message', onMsg);
  // keep saying hello until the player answers (it ignores messages sent before it has loaded)
  const listen = () => { clearInterval(hello); let n = 0; hello = setInterval(() => { msg({ event: 'listening' }); if (++n > 40) clearInterval(hello); }, 250); };
  iframe.addEventListener('load', listen);
  return {
    st, onChange: (l) => listeners.add(l),
    // the new state is assumed at once (the player confirms a moment later), so Sync never reads a
    // just-paused tile as still playing and restarts the others
    play: () => { post('playVideo'); if (st.ready && !isPlayState(st.state)) assume('play'); },
    pause: () => { post('pauseVideo'); if (st.ready && isPlayState(st.state)) assume('pause'); },
    seek: (t) => post('seekTo', [t, true]), mute: () => post('mute'), unmute: () => post('unMute'),
    volume: (v) => post('setVolume', [Math.round(v * 100)]), rate: (r) => post('setPlaybackRate', [r]),
    get paused() { return st.state !== 1 && st.state !== 3; }, // 1 playing, 3 buffering
    destroy: () => { clearInterval(hello); window.removeEventListener('message', onMsg); },
  };
}

// state: a session record ({ currentTime, volume, muted, paused, aspect, board, title }); at: board drop point.
function addWebTile(url, parsed, state = {}, at = null) {
  const frag = webTileTemplate.content.cloneNode(true);
  const el = frag.querySelector('.tile');
  const iframe = el.querySelector('iframe');
  const nameEl = el.querySelector('.name');
  const seek = el.querySelector('.seek');
  const playBtn = el.querySelector('.play');
  const timeEl = el.querySelector('.time');
  const muteBtn = el.querySelector('.mute');
  const errorEl = el.querySelector('.error');
  const errorText = el.querySelector('.error-text');
  const retryBtn = el.querySelector('.retry');
  const makeBtn = el.querySelector('.make-proxy');   // "Download" in Local mode
  const playerBtn = el.querySelector('.use-player'); // offered when streaming is blocked
  const cancelBtn = el.querySelector('.cancel-proxy');
  const bar = el.querySelector('.proxy-bar');
  const fill = el.querySelector('.proxy-fill');
  el.classList.add(parsed.type, parsed.kind);

  const video = el.querySelector('video');
  const modeSel = el.querySelector('.web-mode');
  // Twitch live has no API and no direct file we can play: embed only. Everything else (YouTube
  // videos / Shorts, Twitch clips) plays a real <video> by default, resolved with yt-dlp.
  const streamable = parsed.type === 'youtube' || (parsed.type === 'twitch' && parsed.kind === 'clip');
  const canPlayer = parsed.type === 'youtube'; // the Twitch clip embed exposes nothing worth keeping

  const tile = {
    path: url, url, type: parsed.type, kind: parsed.kind, el, video: null, seek, time: timeEl, scrubbing: false,
    volume: clamp(Number(state.volume ?? DEFAULT_VIDEO_VOLUME), 0, 1),
    aspect: Number(state.aspect) > 0 ? Number(state.aspect) : (parsed.kind === 'short' ? 9 / 16 : 16 / 9),
    board: null, suppressClick: false, galleryH: Number(state.galleryH) > 0 ? clamp(Number(state.galleryH), MIN_H, MAX_H) : layout.rowHeight,
    bookmarks: parsed.type === 'youtube' ? parseBookmarks(state.bookmarks) : [], info: null, proxy: null, fps: null,
    group: null, sync: null, ownMuted: !!state.muted,
    title: typeof state.title === 'string' && state.title ? state.title : WebUrl.label(parsed),
    webMode: streamable ? WebStream.mode(state.webMode || WebStream.DEFAULT_MODE) : 'player',
    webQuality: Number(state.webQuality) > 0 ? Number(state.webQuality) : 0,
  };
  if (!streamable) tile.webMode = 'player';
  if (tile.webMode === 'player' && !canPlayer) tile.webMode = 'stream';
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) tile.board = { x: Number(sb.x), y: Number(sb.y), w: Number(sb.w), h: Number(sb.h) };
  tiles.push(tile);
  // YouTube tiles get their own timeline colour like local videos (Twitch never shows on the timeline)
  if (parsed.type === 'youtube') tile.hue = GROUP_PALETTE.includes(state.color) ? state.color : GROUP_PALETTE[(tiles.length - 1) % GROUP_PALETTE.length];
  nameEl.textContent = tile.title;
  nameEl.title = url + '\nRight-click: copy URL';
  nameEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); sourceContext(e, parsed.type, url); });

  // ----- loading -----
  // Web tiles need a connection; there is no offline state. A YouTube embed that hasn't
  // reported ready after 10 s shows "Could not load" + Retry over its cached thumbnail.
  // YouTube gets our origin so its postMessage events reach this page.
  const embedSrc = () => WebUrl.embed(parsed, twitchParent) + (parsed.type === 'youtube' ? '&origin=' + encodeURIComponent(location.origin) : '');
  let loadTimer = null;
  const load = () => {
    clearTimeout(loadTimer);
    /* DISABLED (Mark, 2026-09-10): no offline handling for web tiles; they just need a connection.
    tile.offline = !navigator.onLine;
    if (tile.offline) { iframe.removeAttribute('src'); errorText.textContent = 'Offline – will load when connected'; errorEl.classList.remove('hidden'); return; }
    */
    errorEl.classList.add('hidden');
    iframe.src = embedSrc();
    // the iframe's onerror is unreliable; YouTube tells us when it is ready, Twitch doesn't
    if (tile.yt) {
      tile.yt.st.ready = false;
      loadTimer = setTimeout(() => { if (!tile.yt.st.ready) { errorText.textContent = 'Could not load'; errorEl.classList.remove('hidden'); } }, 10000);
    }
  };
  retryBtn.addEventListener('click', load);
  retryBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  // YouTube thumbnail, cached by main in userData/thumbs (so it shows on reload even offline)
  if (parsed.type === 'youtube') {
    window.api.webThumb(parsed.id).then((p) => {
      if (!p || !tiles.includes(tile)) return;
      const img = `url("${window.api.videoUrl(p)}")`;
      el.style.backgroundImage = img;
      errorEl.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.55)), ${img}`;
    });
  }

  // ----- Stream / Download: a real <video> -----
  // The tile keeps both elements and shows one; tile.pb and tile.mediaEl point at whichever is
  // live, so groups, Sync, the timeline, bookmarks, frame step and A/B need no special cases.
  const wantTime0 = Number(state.currentTime) > 0 ? Number(state.currentTime) : 0;
  let resolvedAt = 0, reResolved = false, downloading = false;
  const videoPb = videoPlayback(video);
  // set by the YouTube block below when there is an embed; the <video> versions take over while it plays
  let ytSeekTo = () => {}, ytTogglePlay = () => {};

  const showVideo = (on) => {
    video.hidden = !on;
    iframe.hidden = on;
    if (on) { tile.video = video; tile.mediaEl = video; tile.pb = videoPb; }
    else { tile.video = null; tile.mediaEl = iframe; if (tile.yt) tile.pb = ytPlayback(tile.yt); }
    el.classList.toggle('as-video', on);
  };
  const refreshModeUI = () => {
    if (!modeSel) return;
    if (!streamable) { modeSel.hidden = true; return; }
    modeSel.value = tile.webMode;
    const opt = [...modeSel.options].find((o) => o.value === 'stream');
    if (opt) opt.textContent = WebStream.labelFor('stream', tile.webQuality);
    const playerOpt = [...modeSel.options].find((o) => o.value === 'player');
    if (playerOpt) playerOpt.hidden = !canPlayer; // Twitch clips: stream / local only
  };
  // Streaming didn't work (YouTube refuses the direct URL, or yt-dlp can't resolve one). Rather
  // than quietly dropping to the embed, show the thumbnail with the two things that do work.
  const streamBlocked = (why) => {
    showVideo(false); // hide the dead <video>; the cached thumbnail is the tile's background
    // yt-dlp's own text can be a long "ERROR: [extractor] ..." line: keep the useful part on its own line
    const reason = String(why).replace(/^ERROR:\s*/i, '').replace(/^\[[^\]]+\]\s*/, '').trim();
    errorText.textContent = `${reason.replace(/\.?$/, '.')}\nDownload for full quality (exact frames, offline)${canPlayer ? ' — or use Player' : ''}.`;
    makeBtn.classList.remove('hidden');
    playerBtn.classList.toggle('hidden', !canPlayer);
    retryBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden'); bar.classList.add('hidden');
    errorEl.classList.remove('hidden');
    setStatus(`${tile.title}: ${why}`, 8000);
  };
  // yt-dlp gives us a direct URL; it expires, so we note when and re-resolve on error.
  const loadStream = async ({ keepTime = true } = {}) => {
    const at = keepTime ? (tile.pb ? tile.pb.time : 0) || wantTime0 : 0;
    setStatus(`Resolving ${tile.title}…`, 2000);
    const r = await window.api.resolveStream(url);
    if (!tiles.includes(tile) || tile.webMode !== 'stream') return;
    if (!r || !r.ok) {
      // offline, private, or yt-dlp out of date: let the user pick instead of silently degrading
      if (r && r.outdated && typeof showYtdlpOutdated === 'function') showYtdlpOutdated();
      streamBlocked((r && r.error) || 'Could not resolve this video');
      return;
    }
    tile.webQuality = r.height || 0;
    resolvedAt = r.resolvedAt || Date.now();
    refreshModeUI();
    errorEl.classList.add('hidden');
    showVideo(true);
    video.src = r.url;
    if (at > 0) video.currentTime = at;
    if (state.paused === false) video.play().catch(() => {});
  };
  const playLocalFile = (file, at) => {
    showVideo(true);
    errorEl.classList.add('hidden');
    video.src = window.api.videoUrl(file);
    if (at > 0) video.currentTime = at;
  };
  const startDownload = async () => {
    const have = await window.api.downloadedFile(parsed.type, parsed.id);
    const at = tile.pb ? tile.pb.time : 0;
    if (have) { playLocalFile(have, at); return; }
    downloading = true;
    el.classList.add('downloading');
    errorText.textContent = 'Downloading the full-quality file…';
    makeBtn.classList.add('hidden'); cancelBtn.classList.remove('hidden'); bar.classList.remove('hidden');
    errorEl.classList.remove('hidden');
    try {
      const { file } = await window.api.downloadVideo(url, parsed.type, parsed.id);
      if (!tiles.includes(tile)) return;
      playLocalFile(file, at);
    } catch (e) {
      if (!tiles.includes(tile)) return;
      const msg = String(e.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      errorText.textContent = msg;
      setStatus(`${tile.title}: ${msg}`, 8000);
      if (/Cancelled/i.test(msg)) setWebMode('stream');
    } finally {
      downloading = false;
      el.classList.remove('downloading');
      cancelBtn.classList.add('hidden'); bar.classList.add('hidden'); fill.style.width = '0';
    }
  };
  tile.onDownloadProgress = (frac) => { fill.style.width = Math.round(frac * 100) + '%'; };
  cancelBtn.addEventListener('click', () => window.api.cancelDownload(parsed.type, parsed.id));
  makeBtn.addEventListener('click', () => setWebMode('download'));
  playerBtn.addEventListener('click', () => setWebMode('player'));
  for (const b of [makeBtn, cancelBtn, playerBtn]) b.addEventListener('pointerdown', (e) => e.stopPropagation());

  // While the <video> is the live element the tile drives it directly; these replace the YouTube
  // versions below whenever a stream or a downloaded file is playing (Twitch clips only ever use these).
  const videoActive = () => tile.video === video;
  tile.seekTo = (t) => {
    if (!videoActive()) return ytSeekTo(t);
    if (!video.duration) return;
    video.currentTime = clamp(t, 0, video.duration);
    tile.tick(); broadcast(tile, 'seek');
  };
  tile.seekBy = (dt) => tile.seekTo((tile.pb ? tile.pb.time : 0) + dt);
  tile.togglePlay = () => {
    if (!videoActive()) return ytTogglePlay();
    togglePlay(video);
    broadcast(tile, video.paused ? 'pause' : 'play');
  };
  tile.stepFrame = (dir) => { // stream and local files are frame-steppable; the embed is not
    if (!videoActive() || !video.duration) return;
    video.pause(); broadcast(tile, 'pause');
    tile.seekTo(Frames.step(video.currentTime, effectiveFps(tile) || Frames.DEFAULT_FPS, dir));
  };
  const videoTick = () => {
    playBtn.textContent = video.paused ? '▶' : '❚❚';
    if (tile.scrubbing) return;
    timeEl.textContent = Frames.format(video.currentTime, video.duration || 0, effectiveFps(tile), layout.timeDisplay);
    if (video.duration) {
      const frac = clamp(video.currentTime / video.duration, 0, 1);
      seek.value = String(Math.round(frac * 10000));
      seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    }
  };
  tile.refreshTime = () => { if (videoActive()) videoTick(); };
  function setWebMode(mode, { initial = false } = {}) {
    const next = streamable ? WebStream.mode(mode) : 'player';
    const was = tile.webMode;
    tile.webMode = next === 'player' && !canPlayer ? 'stream' : next;
    refreshModeUI();
    if (!initial && was === 'download' && downloading) window.api.cancelDownload(parsed.type, parsed.id);
    const at = !initial && tile.pb ? tile.pb.time : wantTime0;
    if (tile.webMode === 'player') {
      video.pause(); video.removeAttribute('src'); video.load();
      showVideo(false);
      load(); // the embed
      if (tile.yt && at > 0) setTimeout(() => { if (tile.webMode === 'player' && tile.yt) tile.pb.time = at; }, 1200);
      return;
    }
    if (tile.webMode === 'download') { startDownload(); return; }
    loadStream({ keepTime: !initial || wantTime0 > 0 });
  }
  tile.setWebMode = setWebMode;
  if (modeSel) {
    modeSel.addEventListener('change', () => setWebMode(modeSel.value));
    for (const ev of ['pointerdown', 'dblclick', 'click']) modeSel.addEventListener(ev, (e) => e.stopPropagation());
    modeSel.addEventListener('keydown', (e) => e.stopPropagation());
  }

  // the <video> behaves like a local video tile
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const ar = video.videoWidth / video.videoHeight;
      if (Math.abs(ar - tile.aspect) > 0.001) { tile.aspect = ar; if (tile.board) tile.board.w = tile.board.h * ar; layoutTiles(); }
    }
    applyTileVolume(tile); video.muted = tile.ownMuted || !!(tile.group && tile.group.muted);
    if (tile.group) videoPb.rate = tile.group.rate;
    renderTimeline();
  });
  video.addEventListener('durationchange', () => { if (tile.refreshWebMarkers) tile.refreshWebMarkers(); renderTimeline(); });
  video.addEventListener('error', () => {
    if (tile.webMode !== 'stream') return;
    // an expired URL looks like a plain media error: re-resolve once, then give up and use the embed
    if (!reResolved || WebStream.isExpired(resolvedAt)) { reResolved = true; loadStream({ keepTime: true }); return; }
    streamBlocked('YouTube blocked direct streaming.');
  });
  const onVideoPlayState = () => { if (tile.group && tile.group === active) renderGroupBar(); };
  for (const ev of ['play', 'pause', 'ended']) video.addEventListener(ev, onVideoPlayState);
  video.addEventListener('click', (e) => { if (e.shiftKey) return; if (!tile.suppressClick) tile.togglePlay(); });
  video.addEventListener('dblclick', () => { if (cmp.el.hidden) toggleTileFullscreen(el); });

  // ----- YouTube controls -----
  const wantTime = wantTime0;
  const wantPlaying = state.paused === false;
  const refreshMute = () => { muteBtn.textContent = tile.ownMuted || (tile.group && tile.group.muted) || tile.volume === 0 ? '🔇' : '🔊'; };
  tile.refreshMute = refreshMute;
  if (parsed.type === 'youtube') {
    const yt = tile.yt = ytController(iframe);
    const pb = tile.pb = ytPlayback(yt);
    let first = true, knownDuration = 0, lastState = yt.st.state;
    yt.onChange((st, ev) => {
      // its own loop: YouTube has no loop-one-video flag, so restart when it ends
      if (st.state === 0 && lastState !== 0 && tile.loop && !loopOverridden(tile)) { pb.time = 0; yt.play(); }
      lastState = st.state;
      if (st.ready && !errorEl.classList.contains('hidden')) errorEl.classList.add('hidden'); // a late load clears "Could not load"
      if (first && st.ready) {
        first = false;
        clearTimeout(loadTimer);
        setOwnMuted(tile, tile.ownMuted); applyTileVolume(tile);
        if (tile.group) pb.rate = tile.group.rate;
        if (wantTime > 0) pb.time = wantTime;
        if (wantPlaying) yt.play();
      }
      // markers and the timeline need the duration, which arrives with the first reports
      if (st.duration > 0 && st.duration !== knownDuration) {
        knownDuration = st.duration;
        renderMarkers();
        if (tl._model && tl._model.members.some((m) => m.tile === tile)) renderTimeline();
      }
      if (ev === 'onStateChange' && tile.group && tile.group === active) renderGroupBar();
    });
    // user actions on the embed; a synced group follows (like a local video's)
    ytSeekTo = (t) => { pb.time = clamp(t, 0, pb.duration || Infinity); tile.tick(); broadcast(tile, 'seek'); };
    ytTogglePlay = () => { const play = yt.paused; play ? yt.play() : yt.pause(); broadcast(tile, play ? 'play' : 'pause'); };
    const { renderMarkers } = attachBookmarks(tile, el, pb);
    tile.refreshWebMarkers = renderMarkers;
    tile.tick = () => {
      if (videoActive()) return videoTick(); // streaming or playing the downloaded file
      const st = yt.st, now = pb.time;
      playBtn.textContent = yt.paused ? '▶' : '❚❚';
      if (!tile.scrubbing) {
        timeEl.textContent = `${fmtTime(now)} / ${fmtTime(st.duration)}`;
        if (st.duration > 0) {
          const frac = clamp(now / st.duration, 0, 1);
          seek.value = String(Math.round(frac * 10000));
          seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
        }
      }
    };
    // play / mute / scrub-drag are wired once for both elements further down
    seek.addEventListener('input', () => {
      if (videoActive()) return; // the shared handler below drives the <video>
      if (!yt.st.duration) return;
      const t = Number(seek.value) / 10000 * yt.st.duration;
      pb.time = t;
      timeEl.textContent = `${fmtTime(t)} / ${fmtTime(yt.st.duration)}`;
      broadcast(tile, 'seek');
    });
  }
  // controls shared by both elements (Twitch clips have no YouTube block at all)
  if (!tile.tick) tile.tick = () => { if (videoActive()) videoTick(); };
  playBtn.addEventListener('click', () => tile.togglePlay());
  muteBtn.addEventListener('click', () => { setOwnMuted(tile, !tile.ownMuted); refreshMute(); });
  seek.addEventListener('pointerdown', () => { tile.scrubbing = true; el.classList.add('scrubbing'); });
  const endVideoScrub = () => { tile.scrubbing = false; el.classList.remove('scrubbing'); };
  seek.addEventListener('pointerup', endVideoScrub);
  seek.addEventListener('pointercancel', endVideoScrub);
  seek.addEventListener('input', () => {
    if (!videoActive() || !video.duration) return;
    const frac = Number(seek.value) / 10000;
    video.currentTime = frac * video.duration;
    seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    videoTick();
    broadcast(tile, 'seek');
  });
  tile.loop = state.loop === true;
  {
    const loopBtn = el.querySelector('.loop');
    loopBtn.addEventListener('click', () => setTileLoop(tile, !tile.loop));
    loopBtn.addEventListener('dblclick', (e) => e.stopPropagation());
  }
  if (!tile.addBookmark && streamable) { const { renderMarkers } = attachBookmarks(tile, el, videoPb); tile.refreshWebMarkers = renderMarkers; }
  applyTileLoop(tile);
  tile.setVolume = (pct) => { tile.volume = clamp(pct, 0, 100) / 100; applyTileVolume(tile); if (tile.volume > 0 && tile.ownMuted) setOwnMuted(tile, false); refreshMute(); };
  tile.destroy = () => {
    clearTimeout(loadTimer);
    if (tile.yt) tile.yt.destroy();
    if (downloading) window.api.cancelDownload(parsed.type, parsed.id);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
  };
  for (const b of [playBtn, muteBtn]) b.addEventListener('dblclick', (e) => e.stopPropagation());

  // ----- shared tile behaviour: hover, select, remove, resize, drag -----
  el.addEventListener('pointerenter', () => { hoveredTile = tile; });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; });
  el.addEventListener('click', (e) => {
    if (isBoard() || !e.shiftKey || e.target.closest('button, input, select')) return;
    setSelected(tile, !selection.has(tile));
    selectionStatus();
  });
  el.querySelector('.remove').addEventListener('click', () => removeTile(tile));
  wireFullscreenButton(el); // the iframe eats clicks, so for web tiles the button is the way in
  for (const h of el.querySelectorAll('.handle')) {
    h.addEventListener('pointerdown', (e) => startResize(tile, h.dataset.corner, e));
    h.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (isBoard() && tile.board) {
        const entry = recordResize([tile]);
        tile.board.h = layout.rowHeight; tile.board.w = layout.rowHeight * tile.aspect;
        layoutTile(tile);
        finishRects(entry);
      } else fitAll();
    });
  }
  attachTileDrag(tile);

  refreshMute();
  refreshModeUI();
  canvas.appendChild(frag);
  // Stream is the default: nothing needs a click, and the tile is a normal video tile.
  if (tile.webMode === 'player') load(); else setWebMode(tile.webMode, { initial: true });
  if (isBoard() && !tile.board && at) placeOnBoard([tile], at);
  updateChrome();
  return tile;
}
// Image tiles: a static picture with a title bar. Move, resize, lasso, Sticky groups,
// sessions and undo work; no playback controls, and audio/sync paths skip them (no video/yt).
function addImageTile(filePath, state = {}, at = null) {
  const frag = document.getElementById('image-tile-template').content.cloneNode(true);
  const el = frag.querySelector('.tile');
  const img = el.querySelector('img');
  const tile = {
    type: 'image', path: filePath, el, img, video: null, yt: null,
    aspect: Number(state.aspect) > 0 ? Number(state.aspect) : DEFAULT_ASPECT,
    board: null, bookmarks: [], sync: null, group: null, suppressClick: false, volume: 0, ownMuted: false,
    galleryH: Number(state.galleryH) > 0 ? clamp(Number(state.galleryH), MIN_H, MAX_H) : layout.rowHeight,
  };
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) tile.board = { x: +sb.x, y: +sb.y, w: +sb.w, h: +sb.h };
  tiles.push(tile);
  el.querySelector('.name').textContent = basename(filePath);
  el.querySelector('.name').title = filePath + '\nRight-click: ' + REVEAL_LABEL;
  el.querySelector('.name').addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); sourceContext(e, 'image', filePath); });
  img.addEventListener('load', () => {
    if (img.naturalWidth > 0) {
      const ar = img.naturalWidth / img.naturalHeight;
      if (Math.abs(ar - tile.aspect) > 0.001) { tile.aspect = ar; if (tile.board) tile.board.w = tile.board.h * ar; layoutTiles(); }
    }
    if (pendingFit) scheduleFit();
  });
  img.src = window.api.videoUrl(filePath);
  el.querySelector('.remove').addEventListener('click', () => removeTile(tile));
  wireFullscreenButton(el);
  img.addEventListener('dblclick', () => toggleTileFullscreen(el));
  el.addEventListener('pointerenter', () => { hoveredTile = tile; });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; });
  el.addEventListener('click', (e) => {
    if (isBoard() || !e.shiftKey || e.target.closest('button')) return;
    setSelected(tile, !selection.has(tile));
    selectionStatus();
  });
  for (const h of el.querySelectorAll('.handle')) {
    h.addEventListener('pointerdown', (e) => startResize(tile, h.dataset.corner, e));
    h.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (isBoard() && tile.board) {
        const entry = recordResize([tile]);
        tile.board.h = layout.rowHeight; tile.board.w = layout.rowHeight * tile.aspect;
        layoutTile(tile);
        finishRects(entry);
      } else fitAll();
    });
  }
  attachTileDrag(tile);
  canvas.appendChild(frag);
  if (isBoard() && !tile.board && at) placeOnBoard([tile], at);
  updateChrome();
  return tile;
}

// ---------- image sequences: a Nuke-style frame player ----------
// A sequence tile draws frame N into a <canvas> from an in-memory bitmap cache; frames are never
// turned into a movie. PNG / JPEG / WebP frames load straight from the originals. EXR / TIFF / DPX
// frames are decoded by main's ffmpeg into userData/frames/<key>/ (in batches around the playhead,
// then the rest of the sequence), and load from there once they land. Playback holds on a frame
// that isn't ready and carries on when it arrives. tile.pb makes it look like any other video to
// groups, Sync, loops, the timeline and bookmarks.
const seqTileTemplate = document.getElementById('seq-tile-template');
const framePool = FrameCache.pool(2 * 1024 ** 3); // decoded bitmaps across all sequence tiles
let framesDirPath = null;
const framesDirReady = window.api.framesDir().then((d) => { framesDirPath = d; });
const joinPath = (dir, name) => dir + (dir.includes('\\') || !dir.includes('/') ? '\\' : '/') + name;
const COLOUR_LABELS = { srgb: 'sRGB', rec709: 'Rec.709 (Nuke)', none: 'None (linear values)' };
// frames-ready / frames-failed from main, routed to every tile showing that cache key
window.api.onFramesReady((key, a, b) => { for (const t of tiles) if (t.cacheKey === key && t.onFramesReady) t.onFramesReady(a, b); });
window.api.onFramesFailed((key, a, b, msg) => { for (const t of tiles) if (t.cacheKey === key && t.onFramesFailed) t.onFramesFailed(a, b, msg); });

// dir: the folder; seq: from Sequence.detect / Sequence.single (plus fps / exposure / colour when
// restored); state: a session record; at: board drop point.
function addSequenceTile(dir, seq, state = {}, at = null) {
  const frag = seqTileTemplate.content.cloneNode(true);
  const el = frag.querySelector('.tile');
  const cv = el.querySelector('canvas');
  const ctx = cv.getContext('2d');
  const seek = el.querySelector('.seek');
  const playBtn = el.querySelector('.play');
  const timeEl = el.querySelector('.time');
  const rateSel = el.querySelector('.rate');
  const badge = el.querySelector('.seq-badge');
  const cacheBar = el.querySelector('.cache-bar');
  const errorEl = el.querySelector('.error');
  seq = { name: seq.name, sep: seq.sep || '', pad: Number(seq.pad) || 0, ext: seq.ext, start: Number(seq.start) || 0, end: Number(seq.end) || 0,
    count: Number(seq.count) || 1, missing: Array.isArray(seq.missing) ? seq.missing.map(Number) : [], single: !!seq.single, fps: seq.fps, exposure: seq.exposure, colour: seq.colour,
    // which layer / part of a multi-layer EXR to show ('' and 0 = the file's own RGBA)
    layer: typeof (state.seq || seq).layer === 'string' ? (state.seq || seq).layer : '',
    part: Number((state.seq || seq).part) > 0 ? Number((state.seq || seq).part) : 0 };
  const total = seq.end - seq.start + 1;
  const decode = Sequence.needsDecode(seq.ext);
  const missing = new Set(seq.missing);
  const look = state.seq || seq;

  const tile = {
    type: 'sequence', dir, seq, path: joinPath(dir, Sequence.pattern(seq)), title: Sequence.label(seq),
    el, video: null, mediaEl: cv, seek, time: timeEl, scrubbing: false,
    volume: 0, ownMuted: false, aspect: Number(state.aspect) > 0 ? Number(state.aspect) : DEFAULT_ASPECT,
    board: null, suppressClick: false, bookmarks: parseBookmarks(state.bookmarks), group: null, sync: null,
    galleryH: Number(state.galleryH) > 0 ? clamp(Number(state.galleryH), MIN_H, MAX_H) : layout.rowHeight,
    fps: Number(look.fps) > 0 ? Number(look.fps) : 24,
    exposure: clamp(Number(look.exposure) || 0, -10, 10),
    colour: Sequence.COLOURS.includes(look.colour) ? look.colour : 'srgb',
    frame: 0, // 0-based index into the run; the file's own number is seq.start + frame
    loop: state.loop === true, cacheKey: null, info: null,
  };
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) tile.board = { x: +sb.x, y: +sb.y, w: +sb.w, h: +sb.h };
  tiles.push(tile);
  tile.hue = GROUP_PALETTE.includes(state.color) ? state.color : GROUP_PALETTE[(tiles.length - 1) % GROUP_PALETTE.length];
  const nameEl = el.querySelector('.name');
  nameEl.textContent = tile.title;
  nameEl.title = tile.path + `\n${seq.count} frame${seq.count === 1 ? '' : 's'}${missing.size ? `, ${missing.size} missing` : ''}\nRight-click: ` + REVEAL_LABEL;
  nameEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); sourceContext(e, 'file', joinPath(dir, Sequence.framePath(seq, seq.start))); });

  // ----- frame cache -----
  const cache = FrameCache.create({ pool: framePool });
  let disk = new Set();      // frame numbers decoded on disk (decode formats)
  const loading = new Set(); // frame numbers being read into memory
  let gen = 0;               // bumps when the look changes; loads from an older look are dropped
  let requestedAt = null;    // frame the last decode request was centred on
  let failed = null;         // last decode error text
  const num = (i) => seq.start + i;
  const onDiskOrOriginal = (n) => !missing.has(n) && (!decode || disk.has(n));
  const urlOf = (n) => window.api.videoUrl(decode ? joinPath(joinPath(framesDirPath, tile.cacheKey), Sequence.cacheFile(seq, n)) : joinPath(dir, Sequence.framePath(seq, n)));
  let bar = null;
  const renderCacheBar = () => { // throttled to one paint per frame
    if (bar) return;
    bar = requestAnimationFrame(() => {
      bar = null; cacheBar.textContent = '';
      const put = (a, b, cls) => {
        const i = document.createElement('i'); if (cls) i.className = cls;
        i.style.left = ((a - seq.start) / total * 100).toFixed(3) + '%'; i.style.width = ((b - a + 1) / total * 100).toFixed(3) + '%';
        cacheBar.appendChild(i);
      };
      if (decode) for (const [a, b] of Sequence.batches([...disk].sort((x, y) => x - y), Infinity)) put(a, b, '');
      for (const [a, b] of cache.ranges()) put(a, b, 'mem');
    });
  };
  const loadFrame = (n) => {
    if (cache.has(n) || loading.has(n) || !onDiskOrOriginal(n) || (decode && !tile.cacheKey)) return;
    loading.add(n);
    const g = gen;
    // colorSpaceConversion 'none': show the stored values, like Nuke's viewer (no profile / gAMA handling)
    fetch(urlOf(n)).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); }).then((b) => createImageBitmap(b, { colorSpaceConversion: 'none' })).then((bmp) => {
      loading.delete(n);
      if (g !== gen || !tiles.includes(tile)) { bmp.close(); return; }
      cache.set(n, bmp, bmp.width * bmp.height * 4);
      if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; setAspect(bmp.width / bmp.height); drawn = null; }
      if (n === shownNumber()) draw();
      renderCacheBar();
    }).catch(() => { loading.delete(n); });
  };
  const setAspect = (ar) => {
    if (!(ar > 0) || Math.abs(ar - tile.aspect) < 0.001) return;
    tile.aspect = ar;
    if (tile.board) tile.board.w = tile.board.h * ar;
    layoutTiles();
    if (pendingFit) scheduleFit();
  };

  // ----- drawing -----
  // A missing file shows the nearest earlier frame with a badge.
  const shownNumber = () => {
    let n = num(tile.frame);
    while (missing.has(n) && n > seq.start) n--;
    return n;
  };
  let drawn = null;
  const draw = () => {
    const n = shownNumber(), want = num(tile.frame);
    const bmp = cache.get(n);
    if (bmp && drawn !== n) { ctx.drawImage(bmp, 0, 0, cv.width, cv.height); drawn = n; }
    if (!bmp) loadFrame(n);
    const text = failed && !onDiskOrOriginal(n) ? '' : missing.has(want) ? `frame ${want} missing` : !bmp ? (decode && !disk.has(n) ? 'caching…' : 'loading…') : '';
    badge.textContent = text; badge.hidden = !text;
  };
  // keep ~2 s ahead (and a few frames behind) in memory
  const prefetch = () => {
    const ahead = Math.ceil(2 * tile.fps * Math.max(1, rate));
    for (let k = -3; k <= ahead && loading.size < 4; k++) {
      const i = tile.frame + k;
      if (i < 0 || i >= total) continue;
      loadFrame(num(i));
    }
  };
  // decode formats: ask main for frames around the playhead first, then the rest of the run
  const ensureAround = (force = false) => {
    if (!decode || !tile.cacheKey) return;
    const n = num(tile.frame);
    if (!force && requestedAt !== null && Math.abs(n - requestedAt) < 24) return;
    requestedAt = n;
    const ranges = [[n, n + 48], [n - 12, n - 1], [n + 49, seq.end], [seq.start, n - 13]];
    window.api.ensureFrames({ key: tile.cacheKey, dir, seq: { name: seq.name, sep: seq.sep, pad: seq.pad, ext: seq.ext, start: seq.start, end: seq.end, missing: seq.missing, single: seq.single, layer: seq.layer, part: seq.part }, exposure: tile.exposure, colour: tile.colour, ranges });
  };
  tile.onFramesReady = (a, b) => {
    for (let n = a; n <= b; n++) disk.add(n);
    failed = null; errorEl.classList.add('hidden');
    renderCacheBar();
    const s = shownNumber(); if (s >= a && s <= b) draw();
  };
  tile.onFramesFailed = (a, b, msg) => {
    failed = msg;
    const s = shownNumber();
    if (s >= a && s <= b) { el.querySelector('.error-text').textContent = `Could not decode frames ${a}–${b}:\n${msg}`; errorEl.classList.remove('hidden'); }
    setStatus(`${tile.title}: could not decode frames ${a}–${b}`, 8000);
  };
  // the cache key needs the first frame's mtime; the size sets the tile's shape before any frame loads
  const setKey = async () => {
    if (!tile.info) return;
    await framesDirReady;
    tile.cacheKey = Sequence.cacheKey(seq, dir, tile.exposure, tile.colour, tile.info.firstMtime);
    gen++; requestedAt = null; failed = null;
    cache.clear(); loading.clear(); drawn = null; // the canvas keeps showing the old look until the new frame lands
    disk = new Set(decode ? await window.api.framesOnDisk(tile.cacheKey) : []);
    renderCacheBar(); ensureAround(true); draw();
  };
  window.api.seqInfo(dir, seq).then(async (info) => {
    if (!tiles.includes(tile)) return;
    if (!info || !info.ok) { el.querySelector('.error-text').textContent = `Can't read this sequence:\n${tile.path}`; errorEl.classList.remove('hidden'); return; }
    tile.info = info;
    if (info.width > 0 && info.height > 0) setAspect(info.width / info.height);
    // the layer list, read once from the first frame's header (for the ⚙ Layer picker)
    if (Sequence.isExr(seq)) {
      window.api.exrLayers(joinPath(dir, Sequence.framePath(seq, seq.start)))
        .then((x) => { if (tiles.includes(tile)) tile.exrInfo = x || { parts: [] }; });
    }
    await setKey();
  });
  // ⚙: a new exposure / colour is a new cache key; the canvas keeps the old frame until the new one lands
  tile.setLook = (exposure, colour) => {
    tile.exposure = clamp(Number(exposure) || 0, -10, 10);
    tile.colour = Sequence.COLOURS.includes(colour) ? colour : 'srgb';
    if (tile.cacheKey) window.api.cancelFrames(tile.cacheKey);
    setKey();
    refreshSettingsMark(tile);
  };
  // ⚙ Layer: another layer / part of the same EXR files is a new cache key, so it decodes in the
  // background and switching back is instant (those frames are still on disk).
  tile.setLayer = (layer, part) => {
    seq.layer = typeof layer === 'string' ? layer : '';
    seq.part = Number(part) > 0 ? Number(part) : 0;
    if (tile.cacheKey) window.api.cancelFrames(tile.cacheKey);
    setKey();
    refreshSettingsMark(tile);
  };
  tile.setFps = (fps) => { // keeps the frame (so its time changes); nothing is re-decoded
    tile.fps = clamp(Number(fps) || 24, 1, 240);
    pb.rebase(); refreshTime(); renderMarkers(); renderTimeline(); refreshSettingsMark(tile);
  };
  tile.redecode = () => { if (tile.cacheKey) window.api.cancelFrames(tile.cacheKey); failed = null; errorEl.classList.add('hidden'); requestedAt = null; ensureAround(true); };
  el.querySelector('.retry').addEventListener('click', () => tile.redecode());
  el.querySelector('.retry').addEventListener('pointerdown', (e) => e.stopPropagation());

  // ----- playback: a wall-clock frame counter -----
  let playing = false, t0 = 0, f0 = 0, raf = 0, rate = Number(state.playbackRate) > 0 ? Number(state.playbackRate) : 1;
  rateSel.value = String(rate); if (rateSel.value !== String(rate)) { rate = 1; rateSel.value = '1'; }
  const readyToShow = (i) => { const n = num(i); return missing.has(n) || cache.has(n); };
  const stepLoop = (now) => {
    if (!playing) return;
    const target = f0 + Math.floor((now - t0) / 1000 * tile.fps * rate + 1e-6);
    let i = tile.frame;
    while (i < target) {
      if (i + 1 >= total) {
        if (tile.loop && !loopOverridden(tile)) { i = 0; f0 = 0; t0 = now; break; }
        playing = false; onPlayState(); break; // stops on the last frame, like a video
      }
      if (!readyToShow(i + 1)) { f0 = i; t0 = now; break; } // hold here until the frame lands
      i++;
    }
    if (i !== tile.frame) { tile.frame = i; draw(); ensureAround(); }
    prefetch();
    if (playing) raf = requestAnimationFrame(stepLoop);
  };
  const seekFrame = (i) => {
    i = clamp(Math.floor(i), 0, total - 1);
    if (i === tile.frame) return;
    tile.frame = i; f0 = i; t0 = performance.now();
    draw(); ensureAround(); prefetch();
  };
  const onPlayState = () => {
    playBtn.textContent = playing ? '❚❚' : '▶';
    el.classList.toggle('paused-badge', !playing);
    if (tile.group && tile.group === active) renderGroupBar();
  };
  const pb = tile.pb = {
    web: false, kind: 'frames', settling: false,
    get frameSlack() { return 1.5 / tile.fps; },
    get time() { return tile.frame / tile.fps; }, // frame i covers [i / fps, (i + 1) / fps)
    set time(t) { seekFrame(t * tile.fps + 1e-6); },
    get duration() { return total / tile.fps; },
    get paused() { return !playing; },
    play() {
      if (playing) return;
      if (tile.frame >= total - 1) tile.frame = 0; // like a video: play after the end starts over
      playing = true; f0 = tile.frame; t0 = performance.now();
      cancelAnimationFrame(raf); raf = requestAnimationFrame(stepLoop); onPlayState();
    },
    pause() { if (!playing) return; playing = false; cancelAnimationFrame(raf); onPlayState(); },
    get rate() { return rate; },
    set rate(r) { f0 = tile.frame; t0 = performance.now(); rate = Number(r) > 0 ? Number(r) : 1; rateSel.value = String(rate); },
    rebase() { f0 = tile.frame; t0 = performance.now(); },
  };

  // ----- controls -----
  const refreshTime = () => { timeEl.textContent = timeReadout(tile); };
  tile.refreshTime = refreshTime;
  tile.tick = () => {
    if (!tile.scrubbing) {
      const frac = total > 1 ? tile.frame / (total - 1) : 0;
      seek.value = String(Math.round(frac * 10000));
      seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    }
    refreshTime();
    if (!playing) prefetch();
  };
  tile.seekTo = (t) => { pb.time = clamp(t, 0, pb.duration); tile.tick(); broadcast(tile, 'seek'); };
  tile.seekBy = (dt) => tile.seekTo(pb.time + dt);
  tile.togglePlay = () => { playing ? pb.pause() : pb.play(); broadcast(tile, playing ? 'play' : 'pause'); };
  tile.stepFrame = (dir) => { pb.pause(); broadcast(tile, 'pause'); seekFrame(tile.frame + dir); tile.tick(); broadcast(tile, 'seek'); };
  playBtn.addEventListener('click', () => tile.togglePlay());
  el.querySelector('.fstep-back').addEventListener('click', () => tile.stepFrame(-1));
  el.querySelector('.fstep-fwd').addEventListener('click', () => tile.stepFrame(1));
  el.querySelector('.back').addEventListener('click', (e) => tile.seekBy(e.shiftKey ? -30 : -5));
  el.querySelector('.fwd').addEventListener('click', (e) => tile.seekBy(e.shiftKey ? 30 : 5));
  for (const s of ['.play', '.fstep-back', '.fstep-fwd', '.back', '.fwd']) el.querySelector(s).addEventListener('dblclick', (e) => e.stopPropagation());
  timeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const modes = ['clock', 'frames', 'timecode'];
    layout.timeDisplay = modes[(modes.indexOf(layout.timeDisplay) + 1) % modes.length];
    for (const t of tiles) t.refreshTime && t.refreshTime();
    renderTimeline();
  });
  const beginScrub = () => { tile.scrubbing = true; el.classList.add('scrubbing'); };
  const endScrub = () => { tile.scrubbing = false; el.classList.remove('scrubbing'); };
  seek.addEventListener('pointerdown', beginScrub);
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('input', () => {
    const frac = Number(seek.value) / 10000;
    seekFrame(Math.round(frac * (total - 1)));
    seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    refreshTime();
    broadcast(tile, 'seek');
  });
  rateSel.addEventListener('change', () => { pb.rate = Number(rateSel.value); broadcast(tile, 'rate', pb.rate); });
  cv.addEventListener('click', (e) => { if (e.shiftKey) return; if (!tile.suppressClick) tile.togglePlay(); });
  cv.addEventListener('dblclick', () => { if (!cmp.el.hidden) return; toggleTileFullscreen(el); });
  el.addEventListener('click', (e) => {
    if (isBoard() || !e.shiftKey || e.target.closest('button, input, select, .bm-panel')) return;
    setSelected(tile, !selection.has(tile));
    selectionStatus();
  });
  const { renderMarkers } = attachBookmarks(tile, el, pb);
  const loopBtn = el.querySelector('.loop');
  loopBtn.addEventListener('click', () => setTileLoop(tile, !tile.loop));
  loopBtn.addEventListener('dblclick', (e) => e.stopPropagation());
  applyTileLoop(tile);
  wireSettingsButton(tile);

  el.addEventListener('pointerenter', () => { hoveredTile = tile; });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; });
  el.querySelector('.remove').addEventListener('click', () => removeTile(tile));
  wireFullscreenButton(el);
  for (const h of el.querySelectorAll('.handle')) {
    h.addEventListener('pointerdown', (e) => startResize(tile, h.dataset.corner, e));
    h.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (isBoard() && tile.board) {
        const entry = recordResize([tile]);
        tile.board.h = layout.rowHeight; tile.board.w = layout.rowHeight * tile.aspect;
        layoutTile(tile);
        finishRects(entry);
      } else fitAll();
    });
  }
  attachTileDrag(tile);
  tile.destroy = () => {
    playing = false; cancelAnimationFrame(raf);
    if (tile.cacheKey && !tiles.some((t) => t !== tile && t.cacheKey === tile.cacheKey)) window.api.cancelFrames(tile.cacheKey);
    cache.dispose();
  };

  // start where the session left off
  const wantTime = Number(state.currentTime) > 0 ? Number(state.currentTime) : 0;
  tile.frame = clamp(Math.floor(wantTime * tile.fps + 1e-6), 0, total - 1);
  onPlayState(); refreshTime(); renderMarkers(); draw();
  if (state.paused === false) pb.play();
  canvas.appendChild(frag);
  if (isBoard() && !tile.board && at) placeOnBoard([tile], at);
  updateChrome();
  return tile;
}

// Time label for any playable tile. Sequences in 'frames' mode read like Nuke: the file's own frame
// number and the run's range ("1005 / 1001-1048"); clock and timecode stay index-based.
function timeReadout(t, time = t.pb.time) {
  if (t.type === 'sequence' && layout.timeDisplay === 'frames') {
    const i = clamp(Frames.toFrame(time, t.fps), 0, t.seq.end - t.seq.start);
    return `${t.seq.start + i} / ${t.seq.start}-${t.seq.end}`;
  }
  return Frames.format(time, t.pb.duration, effectiveFps(t), layout.timeDisplay);
}

// ---------- ⚙ tile settings (fps; EXR exposure and colour) ----------
let tsEl = null;
function closeTileSettings() { if (!tsEl) return; tsEl._btn.classList.remove('open'); tsEl.remove(); tsEl = null; }
window.addEventListener('pointerdown', (e) => { if (tsEl && !tsEl.contains(e.target) && e.target !== tsEl._btn) closeTileSettings(); }, true);
function wireSettingsButton(tile) {
  const b = tile.el.querySelector('.settings'); if (!b) return;
  b.addEventListener('click', (e) => { e.stopPropagation(); openTileSettings(tile, b); });
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  refreshSettingsMark(tile);
}
// the ⚙ turns yellow when something differs from the default
function refreshSettingsMark(tile) {
  const b = tile.el.querySelector('.settings'); if (!b) return;
  const custom = tile.type === 'sequence'
    ? (tile.fps !== 24 || tile.exposure !== 0 || tile.colour !== 'srgb' || !!tile.seq.layer || tile.seq.part > 0)
    : !!tile.fpsOverride;
  b.classList.toggle('custom', custom);
}
function openTileSettings(tile, btn) {
  if (tsEl && tsEl._tile === tile) { closeTileSettings(); return; }
  closeTileSettings();
  const seq = tile.type === 'sequence';
  const p = document.createElement('div');
  p.className = 'tile-settings'; p._tile = tile; p._btn = btn;
  const h = document.createElement('h4'); h.textContent = tileName(tile); h.title = tile.path; p.appendChild(h);
  const row = (label, ...els) => { const l = document.createElement('label'); const s = document.createElement('span'); s.textContent = label; l.append(s, ...els); p.appendChild(l); return l; };
  const note = (text) => { const n = document.createElement('div'); n.className = 'ts-note'; n.textContent = text; p.appendChild(n); return n; };
  const fps = document.createElement('input');
  fps.type = 'number'; fps.min = '1'; fps.max = '240'; fps.step = 'any';
  if (seq) fps.value = String(tile.fps);
  else { fps.value = tile.fpsOverride ? String(tile.fpsOverride) : ''; fps.placeholder = tile.fps ? String(Math.round(tile.fps * 1000) / 1000) : '24?'; }
  row('Frame rate', fps);
  fps.addEventListener('change', () => {
    const v = Number(fps.value);
    if (seq) { if (v > 0) tile.setFps(v); else fps.value = String(tile.fps); }
    else { tile.fpsOverride = v > 0 ? clamp(v, 1, 240) : null; if (tile.refreshTime) tile.refreshTime(); renderTimeline(); refreshSettingsMark(tile); }
  });
  if (!seq) note(`Frame step and timecode only; playback speed is untouched. Empty = the file's own (${tile.fps ? Math.round(tile.fps * 1000) / 1000 + ' fps' : 'unknown, 24 assumed'}).`);
  if (seq && Sequence.isExr(tile.seq)) {
    const exp = document.createElement('input'); exp.type = 'range'; exp.min = '-10'; exp.max = '10'; exp.step = '0.5'; exp.value = String(tile.exposure);
    const expN = document.createElement('input'); expN.type = 'number'; expN.min = '-10'; expN.max = '10'; expN.step = '0.5'; expN.value = String(tile.exposure);
    row('Exposure', exp, expN);
    const col = document.createElement('select');
    for (const c of Sequence.COLOURS) { const o = document.createElement('option'); o.value = c; o.textContent = COLOUR_LABELS[c]; col.appendChild(o); }
    col.value = tile.colour;
    row('Colour', col);
    note('Exposure is in stops, applied in linear light before the colour transform. Changing either re-decodes the frames in the background.');
    let timer = null;
    const apply = () => { clearTimeout(timer); timer = setTimeout(() => tile.setLook(Number(expN.value), col.value), 250); };
    exp.addEventListener('input', () => { expN.value = exp.value; apply(); });
    expN.addEventListener('change', () => { expN.value = String(clamp(Math.round(Number(expN.value) * 2) / 2, -10, 10)); exp.value = expN.value; apply(); });
    col.addEventListener('change', apply);
  }
  // Layer picker, only when the EXR has more than one layer or part
  if (seq && Sequence.isExr(tile.seq)) {
    if (tile.exrInfo === undefined) {
      tile.exrInfo = null; // one attempt; the popover reopens itself once the header is read
      window.api.exrLayers(joinPath(tile.dir, Sequence.framePath(tile.seq, tile.seq.start))).then((x) => {
        tile.exrInfo = x || { parts: [] };
        if (tsEl && tsEl._tile === tile) { closeTileSettings(); openTileSettings(tile, btn); }
      });
    }
    const parts = (tile.exrInfo && tile.exrInfo.parts) || [];
    const choices = parts.reduce((n, p) => n + p.layers.length, 0);
    if (choices > 1) {
      const sel = document.createElement('select');
      const opt = (parent, pi, layer) => {
        const o = document.createElement('option');
        o.value = pi + ' ' + layer; o.textContent = ExrHeader.layerLabel(layer);
        parent.appendChild(o);
      };
      if (parts.length > 1) {
        parts.forEach((p, pi) => {
          const g = document.createElement('optgroup');
          g.label = p.name || `part ${pi}`;
          for (const l of p.layers) opt(g, pi, l);
          sel.appendChild(g);
        });
      } else for (const l of parts[0].layers) opt(sel, 0, l);
      sel.value = (tile.seq.part || 0) + ' ' + (tile.seq.layer || '');
      row('Layer', sel);
      sel.addEventListener('change', () => {
        const i = sel.value.indexOf(' ');
        tile.setLayer(sel.value.slice(i + 1), Number(sel.value.slice(0, i)));
      });
    }
  }
  if (seq && String(tile.seq.ext).toLowerCase() === 'dpx') note('Log DPX shows as stored (no log-to-linear conversion yet).');
  if (seq && Sequence.needsDecode(tile.seq.ext)) {
    const re = document.createElement('button'); re.textContent = 'Re-decode'; re.title = 'Only needed if decoding failed';
    re.addEventListener('click', () => tile.redecode());
    p.appendChild(re);
  }
  for (const x of p.querySelectorAll('input, select')) x.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeTileSettings(); e.stopPropagation(); } });
  document.body.appendChild(p);
  const r = btn.getBoundingClientRect(), pr = p.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight; // window.innerWidth/Height are shadowed by this file's own innerWidth()/innerHeight()
  p.style.left = clamp(r.right - pr.width, 4, vw - pr.width - 4) + 'px';
  p.style.top = (r.top - pr.height - 6 >= 4 ? r.top - pr.height - 6 : Math.min(r.bottom + 6, vh - pr.height - 4)) + 'px';
  btn.classList.add('open');
  tsEl = p;
}

/* DISABLED (Mark, 2026-09-10): no offline handling for web tiles; they just need a connection.
// Offline web tiles retry when the connection comes back, and every 30 s.
window.addEventListener('online', () => { for (const t of tiles) if (t.offline && t.reload) t.reload(); });
window.addEventListener('offline', () => { for (const t of tiles) if (t.reload && !t.video) t.reload(); });
setInterval(() => { if (navigator.onLine) for (const t of tiles) if (t.offline && t.reload) t.reload(); }, 30000);
*/

function clearAll() {
  while (tiles.length) removeTile(tiles[tiles.length - 1], { record: false });
  undoStack.clear();
  clearTimeout(rowTimer); rowEntry = null;
}

function addVideos(paths, at = null) {
  const wasEmpty = tiles.length === 0;
  // images become image tiles, a lone exr / tif / dpx a one-frame sequence; everything else a video tile
  const added = paths.map((p) => {
    const kind = Sources.kindOf(basename(p));
    return kind === 'image' ? addImageTile(p) : kind === 'frame' ? addSequenceTile(Sources.parentDir(p), Sequence.single(basename(p))) : addVideo(p);
  });
  if (isBoard()) placeOnBoard(added.filter((t) => !t.board), at);
  layoutTiles();
  if (wasEmpty && tiles.length) scheduleFit();
  markOnBoard();
  renderTimeline(); // "All videos" follows what's on the board
}

// Picker and drop: a picked frame that belongs to a run of frames asks whether to add the whole
// sequence (once per run, however many of its frames were picked). No: png / jpg frames become
// image tiles and an exr / tif / dpx frame a one-frame sequence.
async function addPaths(paths, at = null) {
  const plain = [], runs = [], asked = new Map();
  for (const p of paths) {
    const name = basename(p);
    if (Sequence.isFrameExt(name)) {
      const seq = await window.api.sequenceFor(p);
      if (seq) {
        const k = seq.dir + '|' + Sequence.label(seq);
        if (!asked.has(k)) {
          const yes = confirm(`${Sequence.label(seq)}\n\nAdd as a sequence of ${seq.count} frames?${seq.missing.length ? ` (${seq.missing.length} missing)` : ''}`);
          asked.set(k, yes);
          if (yes) runs.push(seq);
        }
        if (asked.get(k)) continue;
      }
    }
    plain.push(p);
  }
  if (plain.length) addVideos(plain, at);
  if (runs.length) {
    const wasEmpty = tiles.length === 0;
    const added = runs.map((s, n) => addSequenceTile(s.dir, s, {}, at ? { x: at.x + n * 24, y: at.y + n * 24 } : null));
    if (isBoard()) placeOnBoard(added.filter((t) => !t.board));
    layoutTiles();
    if (wasEmpty) scheduleFit();
    markOnBoard(); renderTimeline();
  }
}

let toolsWarned = false; // one status message if ffmpeg/ffprobe are missing
window.api.onProxyProgress((p, frac) => { const t = tiles.find((x) => x.path === p); if (t && t.onProxyProgress) t.onProxyProgress(frac); });
// yt-dlp download progress for web tiles in Local mode
window.api.onDownloadProgress((pageUrl, frac) => { for (const t of tiles) if (t.url === pageUrl && t.onDownloadProgress) t.onDownloadProgress(frac); });

// smooth seek-bar updates for every tile (timeupdate alone is too coarse)
(function loop() {
  for (const t of tiles) t.tick && t.tick();
  tickTimeline();
  if (cmp.tick) cmp.tick();
  requestAnimationFrame(loop);
})();

// ---------- session save / load ----------

function collectSession() {
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    layout: {
      mode: layout.mode,
      rowHeight: layout.rowHeight, // the size new tiles start at, and the fallback for older files
      galleryScale: layout.galleryScale,
      board: board.initialized ? { panX: board.panX, panY: board.panY, zoom: board.zoom } : null,
      linked: board.linked,
      timeDisplay: layout.timeDisplay,
      timelineExpanded: layout.timelineExpanded,
      timelineHeight: layout.timelineHeight,
    },
    masterVolume,
    videos: tiles.map((t) => (t.type === 'sequence' ? {
      // image sequence: folder + run description + its look; the decoded-frame cache is found again by key
      type: 'sequence', dir: t.dir, path: t.path, galleryH: Math.round(galleryHOf(t)),
      seq: { name: t.seq.name, sep: t.seq.sep, pad: t.seq.pad, ext: t.seq.ext, start: t.seq.start, end: t.seq.end, count: t.seq.count, missing: t.seq.missing, single: !!t.seq.single, fps: t.fps, exposure: t.exposure, colour: t.colour, layer: t.seq.layer || '', part: t.seq.part || 0 },
      color: t.hue, loop: !!t.loop, currentTime: t.pb.time, volume: 0, muted: false, playbackRate: t.pb.rate, paused: t.pb.paused, aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: t.bookmarks.map((b) => ({ t: b.t, label: b.label, color: b.color })),
      sync: t.sync ? { start: t.sync.start } : null,
    } : t.type === 'image' ? {
      type: 'image', path: t.path, aspect: t.aspect, galleryH: Math.round(galleryHOf(t)),
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: [], sync: null, volume: 0, muted: false, playbackRate: 1, paused: true, currentTime: 0,
    } : (t.type === 'youtube' || t.type === 'twitch') ? {
      // web tile (YouTube / Twitch). Not "!t.video": in Stream / Local mode a web tile has a <video>.
      type: t.type, kind: t.kind, url: t.url, title: t.title, galleryH: Math.round(galleryHOf(t)),
      currentTime: t.pb ? t.pb.time : 0, volume: t.volume, muted: !!t.ownMuted, playbackRate: 1,
      paused: t.yt ? t.yt.paused : true, aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      color: t.hue, loop: !!t.loop, // YouTube only
      webMode: t.webMode || 'stream', webQuality: t.webQuality || 0,
      bookmarks: t.bookmarks.map((b) => ({ t: b.t, label: b.label, color: b.color })),
      sync: t.sync && t.pb ? { start: t.sync.start } : null,
    } : {
      type: 'file',
      path: t.path,
      galleryH: Math.round(galleryHOf(t)),
      color: t.hue,
      loop: !!t.loop,
      fpsOverride: t.fpsOverride || null,
      currentTime: isFinite(t.video.currentTime) ? t.video.currentTime : 0,
      volume: t.volume,
      muted: t.group ? !!t.ownMuted : t.video.muted, // own mute, not the group's
      playbackRate: t.video.playbackRate,
      paused: t.video.paused,
      aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: t.bookmarks.map((b) => ({ t: b.t, label: b.label, color: b.color })),
      sync: t.sync ? { start: t.sync.start } : null,
    })),
    groups: groups.map((g) => ({
      id: g.id, name: g.name, color: g.color,
      members: [...g.members].map((t) => tiles.indexOf(t)).filter((i) => i >= 0),
      sync: g.sync, sticky: g.sticky, loop: g.loop, range: g.range, volume: g.volume, muted: g.muted, rate: g.rate,
    })),
  };
}

async function applySession(data) {
  if (!data || !Array.isArray(data.videos)) throw new Error('Not a Multi Video Player session file.');
  const startedAt = Date.now();
  clearAll();
  window.api.forgetDeadPaths(); // a share that was unreachable last time may be back now
  // every rule for reading an old file lives in lib/session.js, where it is tested against fixtures
  const L = Session.layout(data.layout, {
    minH: MIN_H, maxH: MAX_H, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
    minScale: MIN_GS, maxScale: MAX_GS, minTimelineH: 60, maxTimelineH: 320,
  });
  if (L.rowHeight !== null) layout.rowHeight = L.rowHeight;
  layout.galleryScale = L.galleryScale;
  layout.timeDisplay = L.timeDisplay;
  layout.timelineExpanded = L.timelineExpanded;
  layout.timelineHeight = L.timelineHeight;
  if (L.board) {
    board.panX = L.board.panX; board.panY = L.board.panY; board.zoom = L.board.zoom;
    board.initialized = true;
  } else {
    board.initialized = false;
  }
  setLinked(L.linked);
  setMode(L.mode);
  setMasterVolume(Session.masterVolume(data.masterVolume, DEFAULT_MASTER_VOLUME));

  let missing = 0;
  const byIndex = new Map(); // index in data.videos -> tile (v3 files and bad entries leave gaps)
  for (const [i, v] of data.videos.entries()) {
    if (!v) continue;
    if (v.type === 'youtube' || v.type === 'twitch') {
      const parsed = typeof v.url === 'string' ? WebUrl.parse(v.url) : null;
      if (parsed && parsed.kind !== 'playlist') byIndex.set(i, addWebTile(v.url, parsed, v));
      continue;
    }
    if (v.type === 'sequence') {
      const seq = v.seq;
      if (typeof v.dir !== 'string' || !seq || typeof seq.name !== 'string') continue;
      if (!(await window.api.fileExists(joinPath(v.dir, Sequence.framePath(seq, seq.start))))) missing++;
      byIndex.set(i, addSequenceTile(v.dir, seq, v));
      continue;
    }
    if (typeof v.path !== 'string') continue;
    if (!(await window.api.fileExists(v.path))) missing++;
    byIndex.set(i, v.type === 'image' ? addImageTile(v.path, v) : addVideo(v.path, v));
  }
  // groups (session v4); v3 files have none
  nextGroupId = 1;
  for (const sg of Session.groups(data.groups, (i) => byIndex.has(i))) {
    const g = createGroup(sg.members.map((i) => byIndex.get(i)), { ...sg, sync: false });
    if (sg.id !== null) g.id = sg.id;
    if (sg.sync) {
      // restore saved starts rather than recapturing them from not-yet-loaded videos
      g.sync = true;
      for (const i of sg.members) byIndex.get(i).sync = { start: Session.syncStart(data.videos[i]) };
    }
    nextGroupId = Math.max(nextGroupId, g.id + 1);
  }
  clearSelection(); // createGroup made the last group active; start with nothing selected
  if (isBoard()) placeOnBoard(tiles.filter((t) => !t.board));
  layoutTiles();
  // older session files have no zoom / view saved: fit once the videos are in
  if (L.rowHeight === null || (isBoard() && !board.initialized)) scheduleFit();
  undoStack.clear(); // a freshly opened session starts with no history
  logUi('info', 'session applied', {
    version: data.version, tiles: tiles.length, loaded: data.videos.length,
    missing: missing.length !== undefined ? missing.length : missing, mode: layout.mode, ms: Date.now() - startedAt,
  });
  return { loaded: data.videos.length, missing };
}

async function saveSessionAs() {
  if (!tiles.length) { setStatus('Nothing to save – add some videos first.'); return; }
  const p = await window.api.saveSessionAs(collectSession());
  if (p) { sessionPath = p; updateChrome(); logUi('info', 'session saved as', { path: p, tiles: tiles.length }); setStatus(`Saved ${p}`); }
}

async function saveSession() {
  if (!sessionPath) return saveSessionAs();
  await window.api.saveSessionTo(sessionPath, collectSession());
  logUi('info', 'session saved', { path: sessionPath, tiles: tiles.length });
  setStatus(`Saved ${sessionPath}`);
}

async function openSession(filePath) {
  let r;
  try {
    r = await window.api.loadSession(filePath);
  } catch (e) {
    setStatus(`Could not read session: ${e.message}`, 8000);
    return;
  }
  if (!r) return;
  try {
    const { loaded, missing } = await applySession(r.data);
    sessionPath = r.filePath;
    updateChrome();
    setStatus(missing ? `Opened ${loaded} videos – ${missing} file(s) missing` : `Opened ${loaded} videos`, missing ? 10000 : 4000);
  } catch (e) {
    setStatus(`Could not open session: ${e.message}`, 8000);
  }
}

// ---------- toolbar ----------

// ---------- add-videos pulldown + URL bar ----------
const addMenu = document.getElementById('add-menu');
const menuList = addMenu.querySelector('.menu-list');
const urlBar = document.getElementById('url-bar');
const urlInput = document.getElementById('url-input');
const closeUrlBar = () => { urlBar.hidden = true; urlInput.value = ''; };
document.getElementById('btn-add').addEventListener('click', (e) => { e.stopPropagation(); menuList.hidden = !menuList.hidden; });
window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !addMenu.contains(e.target)) menuList.hidden = true; });
document.getElementById('add-local').addEventListener('click', async () => {
  menuList.hidden = true;
  const paths = await window.api.pickVideos();
  await addPaths(paths);
  if (paths.length) sidebar.addFolder(Sources.parentDir(paths[0])); // becomes the sidebar's Recent row
});
document.getElementById('add-url').addEventListener('click', () => { menuList.hidden = true; urlBar.hidden = false; urlInput.focus(); });
document.getElementById('url-cancel').addEventListener('click', closeUrlBar);
function submitUrl() {
  const parsed = WebUrl.parse(urlInput.value);
  if (!parsed) { setStatus('That is not a YouTube or Twitch link I understand'); return; }
  if (parsed.kind === 'playlist') { sidebar.addPlaylist(urlInput.value.trim()); closeUrlBar(); return; }
  const t = addWebTile(urlInput.value.trim(), parsed);
  if (isBoard()) placeOnBoard([t]);
  layoutTiles();
  if (tiles.length === 1) scheduleFit();
  closeUrlBar();
}
document.getElementById('url-go').addEventListener('click', submitUrl);
urlInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') submitUrl(); if (e.key === 'Escape') closeUrlBar(); });
document.getElementById('btn-open').addEventListener('click', () => openSession());
// Save saves in place (or asks for a file the first time); right-click always opens Save as…
const saveBtn = document.getElementById('btn-save');
saveBtn.addEventListener('click', saveSession);
saveBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); saveSessionAs(); });
// DISABLED (Mark, 2026-09-11): replaced by Clear board; Save right-click = Save as
// document.getElementById('btn-save-as').addEventListener('click', saveSessionAs);
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!tiles.length) { setStatus('Board is already empty'); return; }
  if (!confirm(`Remove all ${tiles.length} video${tiles.length === 1 ? '' : 's'} from the board?`)) return;
  clearAll(); // removes tiles, dissolves groups, clears undo history
  sessionPath = null; updateChrome(); setStatus('Board cleared');
});
// ---------- App ▾ menu and the update banner ----------
// The installed Windows build updates itself; the portable exe, Mac and dev runs are told a newer
// release exists and get a link. The check is the only network call the app makes on its own.
const appMenu = document.getElementById('app-menu');
const appMenuList = appMenu.querySelector('.menu-list');
const updBanner = document.getElementById('update-banner');
const updText = updBanner.querySelector('.ub-text');
const updAction = updBanner.querySelector('.ub-action');
const updProgress = updBanner.querySelector('.ub-progress');
const updFill = updBanner.querySelector('.ub-fill');
let updInfo = null, bannerDismissed = false, noticeUrl = null;

document.getElementById('btn-app').addEventListener('click', (e) => { e.stopPropagation(); appMenuList.hidden = !appMenuList.hidden; });
window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !appMenu.contains(e.target)) appMenuList.hidden = true; });

const showBanner = (text, actionLabel, onAction, { progress = false } = {}) => {
  if (bannerDismissed) return;
  updText.textContent = text;
  updProgress.hidden = !progress;
  updAction.hidden = !actionLabel;
  if (actionLabel) { updAction.textContent = actionLabel; updAction.onclick = onAction; }
  updBanner.hidden = false;
};
updBanner.querySelector('.ub-dismiss').addEventListener('click', () => { bannerDismissed = true; updBanner.hidden = true; });

function refreshUpdateMenu() {
  if (!updInfo) return;
  const v = document.getElementById('btn-version');
  v.textContent = `Version ${updInfo.version}`;
  document.getElementById('upd-auto').checked = !!(settings.updates && settings.updates.auto);
  document.getElementById('upd-prerelease').checked = !!(settings.updates && settings.updates.includePrerelease);
}
for (const [id, key] of [['upd-auto', 'auto'], ['upd-prerelease', 'includePrerelease']]) {
  document.getElementById(id).addEventListener('change', (e) => {
    settings.updates = { ...(settings.updates || { auto: true, includePrerelease: true }), [key]: e.target.checked };
    saveSettings();
    setStatus(key === 'auto'
      ? (e.target.checked ? 'Update check on: once at launch' : 'Update check off: the app makes no network call of its own')
      : (e.target.checked ? 'Pre-releases included' : 'Only full releases'));
  });
}
document.getElementById('btn-check-updates').addEventListener('click', async () => {
  appMenuList.hidden = true;
  bannerDismissed = false;
  setStatus('Checking for updates…', 3000);
  if (updInfo && !updInfo.canAutoUpdate) setStatus('Auto-update runs only in the installed Windows app – checking for a newer release', 6000);
  const r = await window.api.checkUpdates(true);
  if (r && r.ok === false && r.error) setStatus('Update check failed: ' + r.error, 8000);
});
window.api.onUpdateEvent((msg) => {
  if (!msg) return;
  if (msg.kind === 'available') {
    showBanner(`Version ${msg.version} is available`, 'Download', async () => {
      showBanner(`Downloading version ${msg.version}…`, '', null, { progress: true });
      await window.api.downloadUpdate();
    });
  } else if (msg.kind === 'progress') {
    updProgress.hidden = false;
    updFill.style.width = clamp(msg.percent, 0, 100) + '%';
  } else if (msg.kind === 'ready') {
    showBanner(`Version ${msg.version} is ready to install`, 'Restart to update', () => window.api.installUpdate());
  } else if (msg.kind === 'notice') {
    noticeUrl = msg.url;
    showBanner(`Version ${msg.version} is available for download`, 'Open download page', () => window.api.openExternal(noticeUrl));
  } else if (msg.kind === 'none') {
    setStatus(`You are on the latest version (${msg.version})`, 5000);
  } else if (msg.kind === 'error') {
    setStatus('Update check failed: ' + msg.message, 8000);
  }
});
window.api.updateInfo().then((i) => { updInfo = i; refreshUpdateMenu(); });

document.getElementById('btn-open-logs').addEventListener('click', async () => {
  appMenuList.hidden = true;
  const r = await window.api.openLogs();
  setStatus(r && r.ok ? 'Logs folder opened' : `Could not open the logs folder${r && r.error ? ': ' + r.error : ''}`, r && r.ok ? 4000 : 8000);
});
document.getElementById('btn-diagnostics').addEventListener('click', async () => {
  appMenuList.hidden = true;
  const r = await window.api.copyDiagnostics({
    path: sessionPath, mode: layout.mode,
    tiles: tiles.map((t) => ({ type: t.type || 'file' })),
    groups: groups.map(() => ({})),
  });
  setStatus(r && r.ok ? 'Diagnostics copied, paste them into a message' : 'Could not copy diagnostics', 6000);
});

document.getElementById('btn-cache').addEventListener('click', async () => {
  appMenuList.hidden = true;
  const { bytes, files } = await window.api.cacheInfo();
  const mb = (bytes / 1048576).toFixed(0);
  if (!files) { setStatus('Cache is empty'); return; }
  if (confirm(`${files} cached files (playable copies and thumbnails) use ${mb} MB. Clear the cache?`)) { await window.api.clearCache(); setStatus('Cache cleared'); }
});
document.getElementById('btn-play-all').addEventListener('click', () => tiles.forEach(playTile));
document.getElementById('btn-pause-all').addEventListener('click', () => tiles.forEach(pauseTile));
/* DISABLED (Mark, 2026-09-11): Mute all + Unmute all merged into one toggle (below)
document.getElementById('btn-mute-all').addEventListener('click', () => tiles.forEach((t) => setOwnMuted(t, true)));
document.getElementById('btn-unmute-all').addEventListener('click', () => {
  for (const g of groups) g.muted = false; // "all" includes group mutes
  tiles.forEach((t) => setOwnMuted(t, false));
  renderGroupBar();
});
*/
// Mute all while any video is audible; once every one is muted it becomes Unmute all
document.getElementById('btn-mute-all').addEventListener('click', () => {
  const mutable = tiles.filter((t) => t.video || t.yt);
  if (mutable.length && mutable.every(isMuted)) {
    for (const g of groups) g.muted = false; // "all" includes group mutes
    tiles.forEach((t) => setOwnMuted(t, false));
  } else tiles.forEach((t) => setOwnMuted(t, true));
  renderGroupBar();
  refreshToolbarToggles();
});
document.getElementById('btn-loop-all').addEventListener('click', () => {
  const loopable = tiles.filter((t) => t.pb);
  const on = !(loopable.length && loopable.every((t) => t.loop));
  for (const t of loopable) setTileLoop(t, on);
  setStatus(on ? 'Every video loops (a synced group still follows its own Loop setting)' : 'Loops off');
});
document.getElementById('btn-fit').addEventListener('click', fitAll);
// DISABLED (Mark, 2026-09-11): old Tidy wrapped at the tiles' own width and collapsed into 2 columns; replaced by the Tidy menu
// document.getElementById('btn-tidy').addEventListener('click', tidyBoard);

// ---------- Tidy menu (board) ----------
function boardTilesInOrder() { return tiles.filter((t) => t.board).sort((a, b) => (a.board.y - b.board.y) || (a.board.x - b.board.x)); }
// Fit to view: every tile the same height, the largest that flow-wraps inside the current view (undo = resize).
function tidyFitToView() {
  const list = boardTilesInOrder(); if (!list.length) return;
  const entry = recordResize(list);
  const r = gridRect(); const W = (r.width - 2 * GAP) / board.zoom, H = (r.height - 2 * GAP) / board.zoom;
  const origin = toCanvas(r.left + GAP, r.top + GAP);
  const { rects } = Arrange.fitToView(list.map((t) => ({ aspect: t.aspect })), W, H, GAP);
  list.forEach((t, i) => { t.board = { x: origin.x + rects[i].x, y: origin.y + rects[i].y, w: rects[i].w, h: rects[i].h }; layoutTile(t); });
  finishRects(entry); setStatus('Arranged to fit the view');
}
// Grid: sizes kept, ceil(sqrt(n)) columns edge to edge, then frame them (undo = move).
function tidyGrid() {
  const list = boardTilesInOrder(); if (!list.length) return;
  const entry = recordMove(list);
  const bb = boardBounds(list);
  const rects = Arrange.grid(list.map((t) => ({ w: t.board.w, h: t.board.h })), 0);
  list.forEach((t, i) => { t.board.x = bb.minX + rects[i].x; t.board.y = bb.minY + rects[i].y; layoutTile(t); });
  finishRects(entry); fitBoard(); setStatus('Packed into a grid');
}
// Shift+F: the selected tiles fill the current view (one tile at its aspect, several share it),
// centred in the viewport; undo = resize.
function maximizeSelectionInView() {
  if (!isBoard()) { setStatus('Board only'); return; }
  const list = boardTilesInOrder().filter((t) => selection.has(t));
  if (!list.length) { setStatus('Select a video first'); return; }
  const entry = recordResize(tiles.filter((t) => t.board));
  const r = gridRect(); const W = (r.width - 2 * GAP) / board.zoom, H = (r.height - 2 * GAP) / board.zoom;
  const origin = toCanvas(r.left + GAP, r.top + GAP);
  const { rects } = Arrange.fitToView(list.map((t) => ({ aspect: t.aspect })), W, H, GAP);
  const blockW = Math.max(...rects.map((q) => q.x + q.w)), blockH = Math.max(...rects.map((q) => q.y + q.h));
  const ox = origin.x + (W - blockW) / 2, oy = origin.y + (H - blockH) / 2;
  list.forEach((t, i) => { t.board = { x: ox + rects[i].x, y: oy + rects[i].y, w: rects[i].w, h: rects[i].h }; bringToFront(t); layoutTile(t); });
  finishRects(entry);
  setStatus(list.length === 1 ? 'Filled the view' : `${list.length} videos fill the view`);
}

const tidyMenu = document.getElementById('tidy-menu');
const tidyList = tidyMenu.querySelector('.menu-list');
document.getElementById('btn-tidy-menu').addEventListener('click', (e) => { e.stopPropagation(); tidyList.hidden = !tidyList.hidden; });
window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !tidyMenu.contains(e.target)) tidyList.hidden = true; });
document.getElementById('tidy-fit').addEventListener('click', () => { tidyList.hidden = true; tidyFitToView(); });
document.getElementById('tidy-grid').addEventListener('click', () => { tidyList.hidden = true; tidyGrid(); });
document.getElementById('btn-link').addEventListener('click', () => setLinked(!board.linked));
document.getElementById('btn-hand').addEventListener('click', () => setHand(!board.hand));

modeEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

const wheelZoomEl = document.getElementById('wheel-zoom');
wheelZoomEl.addEventListener('change', () => {
  settings.wheelZoom = wheelZoomEl.checked;
  saveSettings();
  setStatus(settings.wheelZoom
    ? 'Wheel zoom on: the wheel zooms (Shift+wheel scrolls, middle-mouse pans)'
    : 'Wheel zoom off: the wheel scrolls and pans again (Ctrl+wheel still zooms)');
});

zoomEl.addEventListener('input', () => {
  if (isBoard()) zoomAtCenter(sliderToZoom(Number(zoomEl.value)));
  else { noteGalleryScaleChange(); setGalleryScale(sliderToScale(Number(zoomEl.value))); }
});

masterVol.addEventListener('input', () => setMasterVolume(Number(masterVol.value) / 100, { updateSlider: false }));
masterVol.addEventListener('wheel', (e) => {
  e.preventDefault();
  setMasterVolume(clamp(Number(masterVol.value) + (e.deltaY < 0 ? 5 : -5), 0, 100) / 100);
}, { passive: false });

// keep gallery tiles clamped to the window width as it changes
new ResizeObserver(() => { if (!isBoard()) layoutTiles(); }).observe(grid);

// ---------- sources sidebar ----------
// Folders (and, from Task 13, playlists) to drag onto the grid. Lives in the global
// settings.json via main, not in the session, so favourites show in every session.
let settings = Settings.defaults();
const sbEl = document.getElementById('sidebar');
const sbLists = { folders: sbEl.querySelector('[data-section="folders"] .sb-list'), playlists: sbEl.querySelector('[data-section="playlists"] .sb-list') };
const sbSelected = new Set(); // selected .sb-item elements
let sbSaveTimer = null;
function saveSettings() { clearTimeout(sbSaveTimer); sbSaveTimer = setTimeout(() => window.api.saveSettings(settings), 300); }

const sidebar = {
  open() { settings.sidebar.open = true; sbEl.hidden = false; saveSettings(); layoutTiles(); },
  close() { settings.sidebar.open = false; sbEl.hidden = true; saveSettings(); layoutTiles(); },
  toggle() { settings.sidebar.open ? sidebar.close() : sidebar.open(); },
  // two tabs: 'local' (folders) and 'web' (YouTube / Twitch playlists); remembered in settings
  setTab(tab) {
    settings.sidebar.tab = tab === 'web' ? 'web' : 'local';
    sbEl.classList.toggle('tab-is-local', settings.sidebar.tab === 'local');
    sbEl.classList.toggle('tab-is-web', settings.sidebar.tab === 'web');
    for (const b of sbEl.querySelectorAll('.sb-tabs button')) b.classList.toggle('active', b.dataset.tab === settings.sidebar.tab);
    saveSettings();
  },
  async addFolder(dir, { pinned = false } = {}) {
    settings = pinned ? Settings.pinFolder(settings, dir, true) : Settings.upsertRecentFolder(settings, dir);
    saveSettings(); await renderFolders();
  },
  async refresh() { await renderFolders(); },
  // Playlists: yt-dlp lists every entry; the list is cached in settings.json and refreshed on demand.
  async addPlaylist(url) {
    setStatus('Reading playlist…', 0);
    const r = await window.api.listPlaylist(url);
    if (!r.ok) {
      if (r.outdated) showYtdlpOutdated();
      setStatus(r.error || 'Could not read playlist', 8000);
      return;
    }
    const p = r.playlist;
    const entry = { url, id: p.id || url, title: p.title, items: p.items, fetchedAt: Date.now() };
    const list = settings.sources.playlists.filter((x) => x.id !== entry.id);
    list.push(entry);
    settings.sources.playlists = list;
    saveSettings();
    renderPlaylists(entry.id);
    sidebar.setTab('web');
    if (!settings.sidebar.open) sidebar.open();
    setStatus(`${p.title}: ${p.items.length} video${p.items.length === 1 ? '' : 's'}`);
  },
};

const sbNote = sbEl.querySelector('[data-section="playlists"] .sb-note');
function showYtdlpOutdated() {
  sbNote.textContent = 'yt-dlp needs updating. ';
  const b = document.createElement('button');
  b.textContent = 'Update yt-dlp';
  b.addEventListener('click', async () => {
    b.disabled = true; setStatus('Updating yt-dlp…', 0);
    const u = await window.api.updateYtdlp();
    setStatus(u.output || (u.ok ? 'yt-dlp updated' : 'yt-dlp update failed'), 10000);
    if (u.ok) sbNote.textContent = '';
    else { b.disabled = false; sbNote.append(' (or replace yt-dlp.exe in the app\'s bin folder by hand)'); }
  });
  sbNote.appendChild(b);
}

function renderPlaylists(expandId = null) {
  const open = new Set([...sbLists.playlists.querySelectorAll('.sb-source')].filter((s) => !s.querySelector('.sb-items').hidden).map((s) => s.dataset.id));
  if (expandId) open.add(expandId);
  sbLists.playlists.textContent = '';
  for (const p of settings.sources.playlists) {
    const row = buildSource({
      id: p.id, name: p.title, count: p.items.length,
      items: p.items.map((i) => ({ type: 'youtube', url: i.url, id: i.id, title: i.title, duration: i.duration, thumbUrl: i.thumbUrl })),
      pinLabel: null, // playlists are always kept; no pin
      onRefresh: () => sidebar.addPlaylist(p.url),
      onRemove: () => { settings.sources.playlists = settings.sources.playlists.filter((x) => x.id !== p.id); saveSettings(); renderPlaylists(); },
    });
    if (open.has(p.id)) { row.querySelector('.sb-items').hidden = false; row.querySelector('.sb-expand').textContent = '▾'; }
    sbLists.playlists.appendChild(row);
  }
  pruneSelection();
  markOnBoard();
}

// Row selection (sbSelected) can span sources and tabs; "Add selected" adds all of it.
const addSelectedBtn = document.getElementById('sb-add-selected');
function updateAddSelected() { addSelectedBtn.disabled = sbSelected.size === 0; }
function pruneSelection() { for (const x of [...sbSelected]) if (!x.isConnected) sbSelected.delete(x); updateAddSelected(); } // rows that were re-rendered away
function clearSbSelection() { for (const x of sbSelected) x.classList.remove('selected'); sbSelected.clear(); updateAddSelected(); }
function addSelected() {
  if (!sbSelected.size) return;
  const payload = [...sbSelected].map(itemPayload);
  if (payload.length > 30 && !confirm(`Add ${payload.length} videos?`)) return;
  addItemsToBoard(payload, null);
  clearSbSelection();
}
addSelectedBtn.addEventListener('click', addSelected);
// Enter adds the selection while the sidebar has focus (a row was clicked)
sbEl.tabIndex = -1;
sbEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && sbSelected.size) { e.preventDefault(); e.stopPropagation(); addSelected(); } });

function onBoardPaths() { return new Set(tiles.map((t) => t.path.toLowerCase())); }
function markOnBoard() {
  const on = onBoardPaths();
  for (const it of sbEl.querySelectorAll('.sb-item')) it.classList.toggle('onboard', on.has(it.dataset.path.toLowerCase()));
}

// thumbnails are made only when a row scrolls into view
const thumbObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const it = en.target; thumbObserver.unobserve(it);
    const img = it.querySelector('.sb-thumb');
    if (it.dataset.thumbUrl) { img.src = it.dataset.thumbUrl; continue; }
    window.api.thumb(it.dataset.thumbPath || it.dataset.path).then((p) => { if (p) img.src = window.api.videoUrl(p); else img.classList.add('generic'); });
    // EXR sequences: say how many layers are in there (read from the middle frame's header)
    if (it.dataset.type === 'sequence' && /\.exr$/i.test(it.dataset.thumbPath || '')) {
      window.api.exrLayers(it.dataset.thumbPath).then((x) => {
        const n = x && x.parts ? x.parts.reduce((a, p) => a + p.layers.length, 0) : 0;
        if (n > 1 && it.isConnected) it.querySelector('.sb-dur').textContent += ` · ${n} layers`;
      });
    }
  }
}, { root: null, rootMargin: '200px' });

function buildItem(data) {
  // data: { type:'file', path, name, kind } | { type:'youtube', url, id, title, duration, thumbUrl }
  // | { type:'sequence', dir, seq, name } (a run of frames) ; files of kind 'frame' are lone exr / tif / dpx frames
  const it = document.getElementById('sb-item-template').content.firstElementChild.cloneNode(true);
  const isSeq = data.type === 'sequence';
  it.dataset.type = data.type === 'file' && (data.kind === 'image' || data.kind === 'frame') ? data.kind : data.type;
  it.dataset.path = isSeq ? joinPath(data.dir, Sequence.pattern(data.seq)) : data.type === 'file' ? data.path : data.url;
  if (isSeq) {
    it.dataset.seq = JSON.stringify({ dir: data.dir, seq: data.seq });
    // thumbnail from the middle frame (the nearest one that exists)
    let mid = Math.round((data.seq.start + data.seq.end) / 2);
    const gone = new Set(data.seq.missing); while (gone.has(mid) && mid > data.seq.start) mid--;
    it.dataset.thumbPath = joinPath(data.dir, Sequence.framePath(data.seq, mid));
    it.dataset.reveal = joinPath(data.dir, Sequence.framePath(data.seq, data.seq.start));
  }
  if (data.thumbUrl) it.dataset.thumbUrl = data.thumbUrl;
  if (data.type === 'file' || isSeq) it.dataset.name = data.name; else it.dataset.title = data.title;
  const nameEl = it.querySelector('.sb-item-name');
  nameEl.textContent = data.type === 'file' || isSeq ? data.name : data.title;
  const tag = { image: 'IMG', frame: 'IMG', sequence: 'SEQ' }[it.dataset.type];
  if (tag) { const k = document.createElement('span'); k.className = 'sb-kind'; k.textContent = tag; nameEl.prepend(k); }
  it.title = it.dataset.path + (isSeq ? `\n${data.seq.count} frames${data.seq.missing.length ? `, ${data.seq.missing.length} missing` : ''}` : '')
    + (data.type === 'file' || isSeq ? '\nRight-click: ' + REVEAL_LABEL : '\nRight-click: copy URL');
  it.querySelector('.sb-dur').textContent = isSeq ? `${data.seq.count} fr${data.seq.missing.length ? ` · ${data.seq.missing.length} missing` : ''}` : data.duration ? fmtTime(data.duration) : '';
  it.addEventListener('click', (e) => {
    if (modKey(e)) { it.classList.toggle('selected'); it.classList.contains('selected') ? sbSelected.add(it) : sbSelected.delete(it); updateAddSelected(); return; }
    if (e.shiftKey && sbSelected.size) {
      const all = [...it.parentElement.querySelectorAll('.sb-item')];
      const last = [...sbSelected].pop(); const a = all.indexOf(last), b = all.indexOf(it);
      for (const x of all.slice(Math.min(a, b), Math.max(a, b) + 1)) { x.classList.add('selected'); sbSelected.add(x); }
      updateAddSelected();
      return;
    }
    clearSbSelection();
    it.classList.add('selected'); sbSelected.add(it); updateAddSelected();
  });
  it.addEventListener('dblclick', () => addItemsToBoard([itemPayload(it)], null));
  // right-click: local rows offer Show in Explorer / Reveal in Finder; YouTube / Twitch rows copy their URL
  it.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (isSeq) sourceContext(e, 'file', it.dataset.reveal); // a sequence reveals its first frame
    else sourceContext(e, it.dataset.type === 'frame' ? 'file' : it.dataset.type, it.dataset.path);
  });
  it.addEventListener('dragstart', (e) => {
    if (!sbSelected.has(it)) { clearSbSelection(); it.classList.add('selected'); sbSelected.add(it); updateAddSelected(); }
    e.dataTransfer.setData('application/x-ozy-items', JSON.stringify([...sbSelected].map(itemPayload)));
    e.dataTransfer.effectAllowed = 'copy';
  });
  thumbObserver.observe(it);
  return it;
}
// Tiny right-click menu: one button per [label, action]; closes on click or the next pointerdown anywhere.
let ctxEl = null;
function closeRowMenu() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function showRowMenu(e, items) {
  closeRowMenu();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  for (const [label, act] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => { closeRowMenu(); act(); });
    ctxEl.appendChild(b);
  }
  document.body.appendChild(ctxEl);
  const r = ctxEl.getBoundingClientRect(); // keep it on screen (window.innerWidth/Height are shadowed by innerWidth()/innerHeight() above)
  ctxEl.style.left = Math.min(e.clientX, document.documentElement.clientWidth - r.width - 4) + 'px';
  ctxEl.style.top = Math.min(e.clientY, document.documentElement.clientHeight - r.height - 4) + 'px';
}
window.addEventListener('pointerdown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeRowMenu(); }, true);
// Shared by sidebar rows and tile names. type: 'file' | 'image' | 'youtube' | 'twitch'; where: path or URL.
function sourceContext(e, type, where) {
  if (type === 'file' || type === 'image') {
    showRowMenu(e, [[REVEAL_LABEL, async () => { if (!(await window.api.showInExplorer(where))) setStatus('File not found: ' + where); }]]);
  } else {
    window.api.copyText(where);
    setStatus('Copied ' + where);
  }
}

function itemPayload(it) {
  if (it.dataset.type === 'sequence') return { type: 'sequence', ...JSON.parse(it.dataset.seq) };
  if (it.dataset.type === 'file' || it.dataset.type === 'image' || it.dataset.type === 'frame') return { type: it.dataset.type, path: it.dataset.path };
  return { type: 'youtube', url: it.dataset.path, title: it.dataset.title };
}
// file rows become file tiles, image rows image tiles, lone frames one-frame sequences (addVideos
// routes by extension), SEQ rows sequence tiles, playlist rows YouTube tiles (cascaded 24 px when
// dropped at a point)
function addItemsToBoard(items, at) {
  const files = items.filter((i) => i.type === 'file' || i.type === 'image' || i.type === 'frame').map((i) => i.path);
  if (files.length) addVideos(files, at);
  const wasEmpty = tiles.length === 0;
  const web = [];
  items.filter((i) => i.type === 'sequence').forEach((i, n) => {
    web.push(addSequenceTile(i.dir, i.seq, {}, at ? { x: at.x + n * 24, y: at.y + n * 24 } : null));
  });
  items.filter((i) => i.type === 'youtube').forEach((i, n) => {
    const parsed = WebUrl.parse(i.url);
    if (!parsed) return;
    web.push(addWebTile(i.url, parsed, { title: i.title }, at ? { x: at.x + n * 24, y: at.y + n * 24 } : null));
  });
  if (web.length) {
    if (isBoard()) placeOnBoard(web.filter((t) => !t.board));
    layoutTiles();
    if (wasEmpty) scheduleFit();
  }
  markOnBoard();
}

function buildSource({ id, name, count, missing, items, onRefresh, onRemove, onPin, pinLabel }) {
  const src = document.getElementById('sb-source-template').content.firstElementChild.cloneNode(true);
  src.dataset.id = id;
  src.classList.toggle('missing', !!missing);
  src.querySelector('.sb-name').textContent = name; src.querySelector('.sb-name').title = id;
  src.querySelector('.sb-count').textContent = missing ? 'Missing' : String(count);
  const itemsEl = src.querySelector('.sb-items');
  for (const d of items) itemsEl.appendChild(buildItem(d));
  const expand = src.querySelector('.sb-expand');
  expand.addEventListener('click', () => { itemsEl.hidden = !itemsEl.hidden; expand.textContent = itemsEl.hidden ? '▸' : '▾'; });
  // Add all = every video; "+ images" = everything, images included (only shown when the source has images)
  const addAll = (withImages) => {
    const payload = [...itemsEl.querySelectorAll('.sb-item')].map(itemPayload).filter((p) => withImages || (p.type !== 'image' && p.type !== 'frame'));
    if (payload.length > 30 && !confirm(`Add ${payload.length} videos?`)) return;
    addItemsToBoard(payload, null);
  };
  src.querySelector('.sb-addall').addEventListener('click', () => addAll(false));
  const addImgBtn = src.querySelector('.sb-addall-img');
  if (items.some((d) => d.kind === 'image' || d.kind === 'frame')) addImgBtn.addEventListener('click', () => addAll(true));
  else addImgBtn.remove();
  // ⋯ reveals Refresh / Pin / Remove under the row (Electron has no window.prompt)
  const actions = src.querySelector('.sb-actions');
  src.querySelector('.sb-menu').addEventListener('click', () => { actions.hidden = !actions.hidden; });
  const pinBtn = src.querySelector('.sb-pin');
  if (pinLabel) pinBtn.textContent = pinLabel; else pinBtn.remove();
  src.querySelector('.sb-refresh').addEventListener('click', () => onRefresh());
  pinBtn.addEventListener('click', () => onPin && onPin());
  src.querySelector('.sb-remove').addEventListener('click', () => onRemove());
  return src;
}

async function renderFolders() {
  const open = new Set([...sbLists.folders.querySelectorAll('.sb-source')].filter((s) => !s.querySelector('.sb-items').hidden).map((s) => s.dataset.id));
  const rows = [];
  for (const f of settings.sources.folders) {
    const r = await window.api.listFolder(f.path);
    // runs of frames are one SEQ row each, sorted in among the files by name
    const items = [...r.files.map((x) => ({ type: 'file', path: x.path, name: x.name, kind: x.kind })),
      ...(r.sequences || []).map((s) => ({ type: 'sequence', dir: s.dir, seq: s, name: Sequence.label(s) }))]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    const row = buildSource({
      id: f.path, name: (f.recent ? 'Recent: ' : '') + basename(f.path), count: items.length, missing: !r.ok, items,
      pinLabel: f.pinned ? 'Unpin' : 'Pin',
      onRefresh: renderFolders,
      onPin: () => { settings = Settings.pinFolder(settings, f.path, !f.pinned); saveSettings(); renderFolders(); },
      onRemove: () => { settings = Settings.removeFolder(settings, f.path); saveSettings(); renderFolders(); },
    });
    if (open.has(f.path)) { row.querySelector('.sb-items').hidden = false; row.querySelector('.sb-expand').textContent = '▾'; } // keep expanded rows expanded
    rows.push(row);
  }
  sbLists.folders.textContent = '';
  for (const row of rows) sbLists.folders.appendChild(row);
  pruneSelection();
  markOnBoard();
}

document.getElementById('btn-sidebar').addEventListener('click', sidebar.toggle);
document.getElementById('sb-add-folder').addEventListener('click', async () => { const d = await window.api.pickFolder(); if (d) { sidebar.setTab('local'); sidebar.addFolder(d, { pinned: true }); } });
for (const b of sbEl.querySelectorAll('.sb-tabs button')) b.addEventListener('click', () => sidebar.setTab(b.dataset.tab));
document.getElementById('sb-add-playlist').addEventListener('click', () => { urlBar.hidden = false; urlInput.focus(); });
// width drag (220-480 px, remembered)
document.getElementById('sb-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault(); document.body.classList.add('sb-resizing');
  const onMove = (ev) => { settings.sidebar.width = clamp(ev.clientX, 220, 480); sbEl.style.setProperty('--sb-width', settings.sidebar.width + 'px'); layoutTiles(); };
  const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); document.body.classList.remove('sb-resizing'); saveSettings(); };
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
});
// startup
window.api.getSettings().then((s) => {
  settings = s;
  sbEl.style.setProperty('--sb-width', settings.sidebar.width + 'px');
  sbEl.hidden = !settings.sidebar.open;
  sidebar.setTab(settings.sidebar.tab);
  refreshUpdateMenu(); // the update checkboxes come from the same settings file
  wheelZoomEl.checked = !!settings.wheelZoom;
  renderFolders();
  renderPlaylists(); // from the cache in settings.json, no refetch
});
window.api.ytdlpAvailable().then((ok) => {
  document.getElementById('sb-add-playlist').disabled = !ok;
  if (!ok) sbNote.textContent = 'yt-dlp not found; playlists unavailable';
});

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  // a focused button (you just clicked one) shouldn't swallow the shortcuts
  const inControl = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === 'Escape' && tsEl) { e.preventDefault(); closeTileSettings(); return; } // the ⚙ popover first
  // Esc leaves a fullscreen tile (Electron doesn't do this for page fullscreen by itself)
  if (e.key === 'Escape' && document.fullscreenElement) { e.preventDefault(); document.exitFullscreen().catch(() => {}); return; }

  // the compare view owns the keyboard while it is open
  if (!cmp.el.hidden) {
    if (e.key === 'Escape') { closeCompare(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (cmp.mode === 'flip') cmp.el.classList.toggle('show-a'); return; }
    if (e.code === 'Space') { e.preventDefault(); cmp.a.togglePlay(); return; }
    if (e.key === ',') { cmp.a.stepFrame(-1); return; }
    if (e.key === '.') { cmp.a.stepFrame(1); return; }
    return;
  }

  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); e.shiftKey ? saveSessionAs() : saveSession(); return; }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openSession(); return; }
  if (ctrl && key === 'z' && !inControl) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && key === 'y' && !inControl) { e.preventDefault(); redo(); return; }
  if (ctrl && e.key.toLowerCase() === 'g' && !inControl) { e.preventDefault(); e.shiftKey ? (active && dissolveGroup(active)) : toggleGroupFromSelection(); return; }
  if (ctrl && e.key.toLowerCase() === 'a' && !isBoard() && !inControl) { e.preventDefault(); document.getElementById('add-local').click(); return; }

  if (inControl) return;
  if (key === 'c' && !ctrl) { tryOpenCompare(); return; }

  // shortcuts that act on the video under the mouse
  const h = hoveredTile && tiles.includes(hoveredTile) ? hoveredTile : null;
  if (h) {
    // YouTube tiles have no frame step (no stepFrame), and Twitch tiles have no playback API at all
    const big = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft' && h.seekBy) { e.preventDefault(); h.seekBy(-big); return; }
    if (e.key === 'ArrowRight' && h.seekBy) { e.preventDefault(); h.seekBy(big); return; }
    if (e.key === 'ArrowUp' && h.setVolume) { e.preventDefault(); h.setVolume(Math.round(h.volume * 100) + 5); return; }
    if (e.key === 'ArrowDown' && h.setVolume) { e.preventDefault(); h.setVolume(Math.round(h.volume * 100) - 5); return; }
    if (key === 'b' && h.addBookmark) { h.addBookmark(); return; }
    if (e.key === '[' && h.jumpBookmark) { h.jumpBookmark(-1); return; }
    if (e.key === ']' && h.jumpBookmark) { h.jumpBookmark(1); return; }
    if (key === 'k' && h.togglePlay) { h.togglePlay(); return; }
    if (key === 'm' && (h.video || h.yt)) { setOwnMuted(h, !h.ownMuted); return; }
    if (key === 'l' && !e.shiftKey && !ctrl && h.pb) { setTileLoop(h, !h.loop); setStatus(h.loop ? `Looping ${tileName(h)}` : `Loop off – ${tileName(h)}`); return; }
    if (e.key === ',' && h.stepFrame) { h.stepFrame(-1); return; }
    if (e.key === '.' && h.stepFrame) { h.stepFrame(1); return; }
  }

  if (e.code === 'Space') {
    e.preventDefault();
    const anyPlaying = tiles.some(isPlaying);
    tiles.forEach((t) => (anyPlaying ? pauseTile(t) : playTile(t)));
  } else if (e.key === 'Escape') {
    clearSelection();
  /* DISABLED (Mark, 2026-09-11): plain L now loops the hovered video; Linked moved to Shift+L
  } else if (key === 'l' && isBoard()) {
    setLinked(!board.linked);
    setStatus(board.linked ? 'Linked: neighbours move out of the way' : 'Unlinked: videos may overlap');
  */
  } else if (key === 'l' && e.shiftKey && !ctrl && isBoard()) {
    setLinked(!board.linked);
    setStatus(board.linked ? 'Linked: neighbours move out of the way' : 'Unlinked: videos may overlap');
  } else if (key === 'l' && !ctrl) {
    setStatus('L loops the video under the mouse' + (isBoard() ? '; Shift+L toggles Linked' : ''));
  } else if (key === 'h' && isBoard()) {
    setHand(!board.hand);
  } else if (ctrl && key === 'a' && isBoard()) {
    e.preventDefault();
    for (const t of tiles) setSelected(t, true);
    selectionStatus();
  } else if (e.key === '`') {
    sidebar.toggle();
  } else if (key === 't' && !ctrl) {
    toggleTimelineExpanded();
  } else if ((key === 'i' || key === 'o') && !ctrl && !tl.hidden) {
    setRangeAtPlayhead(key === 'i' ? 'in' : 'out');
  /* DISABLED (Mark, 2026-09-11): Shift+F replaced by plain F (fullscreen the selected tile)
  } else if (key === 'f' && e.shiftKey && !ctrl) {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const target = selection.size === 1 ? [...selection][0] : h;
    if (target) toggleTileFullscreen(target.el); else setStatus('Select or hover a video first');
  */
  } else if (key === 'f' && e.shiftKey && !ctrl) {
    maximizeSelectionInView();
  } else if (key === 'f' && !ctrl) {
    // F: fullscreen the one selected tile; F again (or Esc) leaves
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (selection.size === 1) toggleTileFullscreen([...selection][0].el);
    else setStatus('Select a video first');
    // DISABLED (Mark, 2026-09-11): F no longer fits; Fit all is the toolbar button only
    // fitAll();
  } else if (e.key === '=' || e.key === '+') {
    if (isBoard()) zoomAtCenter(board.zoom * 1.15); else { noteGalleryScaleChange(); scaleGallery(1.1); }
  } else if (e.key === '-' || e.key === '_') {
    if (isBoard()) zoomAtCenter(board.zoom / 1.15); else { noteGalleryScaleChange(); scaleGallery(1 / 1.1); }
  }
});

// ---------- drag & drop ----------

let dragDepth = 0;
// drags that start in the Sources sidebar don't get the big "Release to add" overlay
const isSidebarDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('application/x-ozy-items');
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (isSidebarDrag(e)) return; dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (isSidebarDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const at = isBoard() && tiles.length ? toCanvas(e.clientX, e.clientY) : null; // on the board, drop where the cursor is
  const raw = e.dataTransfer.getData('application/x-ozy-items');
  if (raw) { try { addItemsToBoard(JSON.parse(raw), at); } catch {} return; }
  const files = Array.from(e.dataTransfer.files || []);
  const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean);
  const sessions = paths.filter((p) => p.toLowerCase().endsWith('.mvp'));
  if (sessions.length) { await openSession(sessions[0]); return; }
  await addPaths(paths, at);
  if (paths.length) sidebar.addFolder(Sources.parentDir(paths[0]));
});

// ---------- session passed on the command line ----------

window.api.onOpenSession((p) => openSession(p));

updateChrome();
setMode('gallery');
layout.rowHeight = 240; // the size new gallery tiles start at
setLinked(true);
setHand(false);
setMasterVolume(DEFAULT_MASTER_VOLUME);
