// Multi Video Player - renderer logic. Runs with no Node access; everything
// that touches disk goes through the small `window.api` bridge in preload.js.

// Which window this is: 0 the main window, 1 or 2 an extra view (index.html?view=N), a camera on
// the main window's board that can pan, zoom, select and play but never edits the layout.
window.OZY_VIEW = window.api && window.api.viewNumber ? window.api.viewNumber() : 0;
const IS_VIEW = window.OZY_VIEW > 0;
if (IS_VIEW) document.body.classList.add('view');
// true while a view applies a snapshot from the main window: the only time a view adds, removes
// or regroups tiles
let snapshotApplying = false;
const viewMayEdit = () => !IS_VIEW || snapshotApplying;
let viewSessionName = ''; // a view's title names the main window's session

// ---------- playback mirroring ----------
// Every play, pause, seek, scrub and speed change made on a tile through its tile.pb is sent to
// the other Ozy windows, which apply it to their own copy of the tile (by id). Changes this
// window makes on its own behalf (the sync engine, offscreen pause) and changes it applies for
// another window are quiet, so nothing bounces back. Ops made in the same tick go as one message.
let pbQuiet = 0;
const quietly = (fn) => { pbQuiet++; try { return fn(); } finally { pbQuiet--; } };
let pbOut = [];
function emitPlayback(tile, op, value) {
  if (pbQuiet || !tile || !tile.id || !window.api.bus) return;
  tile.localActAt = performance.now(); // the clock leaves this tile alone for a moment
  if (!pbOut.length) queueMicrotask(() => {
    const ops = Snapshot.batch(pbOut).map((o) => ({ ...o, time: o.tile.pb ? o.tile.pb.time : 0 })).map(({ tile: _t, ...o }) => o);
    pbOut = [];
    window.api.bus({ type: 'playback', from: window.OZY_VIEW, ops });
  });
  pbOut.push({ tile, id: tile.id, op, value });
}
// tile.pb, observed: whatever playback object a tile has now or is given later (a web tile swaps
// between its embed and its <video>) reports the changes made through it
function observePb(tile) {
  let inner = tile.pb, outer = null;
  const wrap = (pb) => (pb && typeof pb === 'object' ? new Proxy(pb, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === 'play' || prop === 'pause') return (...a) => { emitPlayback(tile, prop); return v.apply(target, a); };
      if (prop === 'scrub' && typeof v === 'function') return (t) => { const r = v.call(target, t); emitPlayback(tile, 'scrub', t); return r; };
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      const r = Reflect.set(target, prop, value, target);
      if (prop === 'time') emitPlayback(tile, 'seek', value);
      else if (prop === 'rate') emitPlayback(tile, 'rate', value);
      return r;
    },
  }) : pb);
  outer = wrap(inner);
  Object.defineProperty(tile, 'pb', { configurable: true, enumerable: true, get: () => outer, set: (pb) => { inner = pb; outer = wrap(pb); } });
}

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
const SESSION_VERSION = 6;

/** @type {Array<{path:string, el:HTMLElement, video:HTMLVideoElement, seek:HTMLInputElement, time:HTMLElement, scrubbing:boolean, volume:number, aspect:number, board?:{x:number,y:number,w:number,h:number}, tick?:Function}>} */
const tiles = [];
// Every tile has a stable id: the same tile in every window (views), and across save and open.
// A record's id is kept unless another tile in this window already has it (a paste, a duplicate).
const tileIds = new Set();
function newTileId(wanted) {
  const fresh = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2));
  const id = wanted && !tileIds.has(wanted) ? wanted : fresh();
  tileIds.add(id);
  return id;
}
function tileById(id) { return tiles.find((t) => t.id === id) || null; }
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
const MIN_ZOOM = 0.002; // (0.05 until 2026-11-06: a big Miro board has to fit on screen, with room to spare)
const MAX_ZOOM = 4;
const GAP = 8;
const DEFAULT_ASPECT = 16 / 9;
const TEXT_DEFAULT_W = 240; // canvas px a new text tile starts at
const TEXT_MIN_W = 40;      // narrower than this and a word can't wrap at all
// rowHeight is now only the size new tiles start at (it follows scale-all) and the fallback for
// older session files; each tile keeps its own gallery height in tile.galleryH.
const layout = { mode: 'gallery', rowHeight: 240, galleryScale: 1, timeDisplay: 'clock', timelineExpanded: false, timelineHeight: 140, quality: 'full', background: 'dark' };
// const board = { panX: 0, panY: 0, zoom: 1, initialized: false, linked: true, hand: false }; // (before 2026-11-19: pushing was on by default)
const board = { panX: 0, panY: 0, zoom: 1, initialized: false, linked: false, hand: false }; // linked: Push neighbours (settings.pushNeighbours)
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
  renderEmptyRecent(); // the empty-board hint lists the latest sessions
  // 'videos' while it is all videos; 'items' once pictures, notes or text are on the board too (a Miro import)
  const noun = tiles.every((t) => t.video || t.yt || t.type === 'sequence') ? 'video' : 'item';
  document.body.classList.toggle('many-tiles', tiles.length > 300); // a big board drops the soft shadows (style.css)
  countEl.textContent = tiles.length ? `${tiles.length} ${noun}${tiles.length === 1 ? '' : 's'}` : '';
  const name = sessionPath ? basename(sessionPath) : 'Unsaved session';
  if (IS_VIEW) document.title = `Ozy view ${window.OZY_VIEW} – ${viewSessionName || 'Unsaved session'}`;
  else document.title = `${name} – Ozy Multi Media Player${appVersion ? ' ' + appVersion : ''}`;
  if (typeof updateBoardName === 'function') updateBoardName(); // (the name in the top-left panel)
  refreshToolbarToggles();
  scheduleFavorites(); // a tile came or went: the Favorites list follows
}

const isBoard = () => layout.mode === 'board';

// ---------- volume ----------

// Which windows decode which tiles (window 0 is main). A tile is heard from exactly one of them,
// Lod.audioOwner's pick: main if it decodes it, else the lowest-numbered view that does. The others
// keep its element at volume 0, since two windows would only echo it. (Scott, 2026-10-20: a view
// on the other monitor must have sound even when main is looking elsewhere.)
const liveSets = new Map();
let lastLiveKey = '';
const liveHere = (t) => !!t.id && (t.live || !t.release); // web tiles are always live
// This window's own part is read from its tiles as they are now, not from the set it last told the
// others: a tile is heard here as soon as it is live here (when no lower window has it), never
// once it is a still.
function isAudioOwner(tile) {
  if (!liveHere(tile)) return false;
  // a favorite kept playing out of view here is not shown here: a window that has it on screen is
  // heard instead, and this one only when none does
  if (tile.quietKept) { const others = new Map(liveSets); others.delete(window.OZY_VIEW); return Lod.audioOwner(tile.id, others) === null; }
  const sets = new Map(liveSets);
  sets.set(window.OZY_VIEW, [tile.id]);
  return Lod.audioOwner(tile.id, sets) === window.OZY_VIEW;
}
function applyTileVolume(tile) {
  // heard from one window only (main if it decodes the tile, else the lowest view): two would echo
  // const v = IS_VIEW ? 0 : clamp(tile.volume * masterVolume * (tile.group ? tile.group.volume : 1), 0, 1); // (views were silent until 2026-10-20)
  const full = isAudioOwner(tile) ? clamp(tile.volume * masterVolume * (tile.group ? tile.group.volume : 1), 0, 1) : 0;
  // a favorite playing on out of view is turned right down (Mark, 2026-11-05), fading either way
  const target = tile.quietKept ? Favorites.quietVolume(full, settings ? settings.favQuiet : Favorites.QUIET) : full;
  let v = target;
  const f = tile.volFade;
  if (f) {
    const k = (performance.now() - f.t0) / Favorites.FADE_MS;
    if (k >= 1) tile.volFade = null;
    else {
      v = Favorites.fade(f.from, target, k);
      if (!f.raf) f.raf = requestAnimationFrame(() => { f.raf = 0; if (tile.volFade === f) applyTileVolume(tile); });
    }
  }
  tile.outVolume = v;
  if (tile.video) tile.video.volume = v;
  else if (tile.yt) tile.yt.volume(v); // Twitch embeds expose no volume control
}
// A playing favorite out of sight is kept playing quietly (the live budget decides when): fade
// from what it plays at now to where it is going.
function setQuietKept(tile, on) {
  if (!!tile.quietKept === !!on) return;
  tile.quietKept = !!on;
  const from = tile.video ? tile.video.volume : Number.isFinite(tile.outVolume) ? tile.outVolume : 0;
  tile.volFade = { from, t0: performance.now(), raf: 0 };
  applyTileVolume(tile);
}
// A tile's own mute is remembered separately so a group mute can be undone.
function setOwnMuted(tile, m) {
  const was = !!tile.ownMuted;
  tile.ownMuted = !!m;
  const muted = tile.ownMuted || !!(tile.group && tile.group.muted);
  if (tile.video) tile.video.muted = muted;
  else if (tile.yt) { muted ? tile.yt.mute() : tile.yt.unmute(); if (tile.refreshMute) tile.refreshMute(); }
  refreshToolbarToggles();
  if (was !== tile.ownMuted) emitPlayback(tile, 'mute', tile.ownMuted); // the other windows follow
}
function applyAudioOwners() { for (const t of tiles) applyTileVolume(t); }
// tell the other windows which tiles this one decodes (the main window adds its master volume)
function announceLive(ids) {
  if (!window.api.bus) return;
  const msg = { type: 'live', n: window.OZY_VIEW, ids };
  if (!IS_VIEW) msg.master = masterVolume;
  window.api.bus(msg);
}
// after the live budget moved, or before a snapshot shows the views a new tile: say so if it changed
function refreshLiveSet() {
  const ids = tiles.filter((t) => liveHere(t) && !t.quietKept).map((t) => t.id); // a favorite only heard here, not shown, is not counted as shown
  const key = ids.join('\n');
  if (key === lastLiveKey) return;
  lastLiveKey = key;
  liveSets.set(window.OZY_VIEW, new Set(ids));
  announceLive(ids);
  applyAudioOwners();
}
// a group's sound, changed here: the other windows follow (sent on one of its members)
function emitGroupAudio(g) {
  const t = g && [...g.members][0];
  if (t) emitPlayback(t, 'group-audio', { volume: g.volume, muted: !!g.muted });
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
  // m.textContent = allMuted ? '🔊 Unmute all' : '🔇 Mute all'; // DISABLED (Mark, 2026-11-15): an icon button now
  m.classList.toggle('all-muted', allMuted);
  m.title = allMuted ? 'Unmute every video' : 'Mute every video';
  const loopable = tiles.filter((t) => t.pb);
  document.getElementById('btn-loop-all').classList.toggle('toggled', loopable.length > 0 && loopable.every((t) => t.loop));
}
// Play state across local <video>, sequence and YouTube tiles (Twitch has no API: skipped).
/* DISABLED (Mark, 2026-09-11): replaced by the playback adapter versions below, which also cover sequence tiles
// (a local video under the live budget goes through its tile.pb, which knows when it is a still)
function playTile(t) { if (t.release) t.pb.play(); else if (t.video) t.video.play().catch(() => {}); else if (t.yt) t.yt.play(); }
function pauseTile(t) { if (t.release) t.pb.pause(); else if (t.video) t.video.pause(); else if (t.yt) t.yt.pause(); }
function isPlaying(t) { return t.release ? !t.pb.paused : t.video ? !t.video.paused : !!(t.yt && !t.yt.paused); }
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
// Preview a position during a drag. Every adapter that can do better than a real seek provides
// `scrub`; anything else just seeks, which is free for local files.
const pbScrub = (pb, t) => { if (!pb) return; if (pb.scrub) pb.scrub(t); else pb.time = t; };

function videoPlayback(video) {
  return {
    web: false, kind: 'video', settling: false,
    get time() { return video.currentTime || 0; }, set time(t) { video.currentTime = t; },
    scrub(t) { video.currentTime = t; }, // a local file seeks instantly: preview and commit are the same
    get duration() { return video.duration || 0; },
    get paused() { return video.paused; },
    play() { video.play().catch(() => {}); }, pause() { video.pause(); },
    get rate() { return video.playbackRate; }, set rate(r) { video.playbackRate = r; },
  };
}
// A local video under the live budget (lib/lod.js): while it is a still its <video> has no source,
// so time, play state, rate and length come from `tile.shadow`, a clock that keeps running as
// though it were playing. Everything else in the app reads tile.pb, so a still stays on the
// board's time and restores where it should. Live, every call goes straight to the element.
// (a still released before its metadata came in takes its length from the probe)
const shadowDuration = (tile) => tile.shadow.duration || (tile.info && tile.info.duration) || 0;
function shadowNow(tile) {
  const s = tile.shadow, d = shadowDuration(tile);
  let t = s.time + (s.playing ? (performance.now() - s.at) / 1000 * s.rate : 0);
  if (d > 0) t = tile.loop ? t % d : Math.min(t, d);
  return t;
}
// a still that has played to the end of a file that does not loop has stopped, as the video would
const shadowEnded = (tile) => !tile.loop && shadowDuration(tile) > 0 && shadowNow(tile) >= shadowDuration(tile);
function budgetedPlayback(tile, inner) {
  const touch = () => { const s = tile.shadow; s.time = shadowNow(tile); s.at = performance.now(); };
  return {
    web: false, kind: 'video', settling: false, budgeted: true,
    get time() { return tile.shadow ? shadowNow(tile) : inner.time; },
    set time(t) { if (tile.shadow) { tile.shadow.time = t; tile.shadow.at = performance.now(); } else inner.time = t; },
    scrub(t) { if (tile.shadow) { tile.shadow.time = t; tile.shadow.at = performance.now(); } else inner.scrub(t); },
    get duration() { return tile.shadow ? shadowDuration(tile) : inner.duration; },
    get paused() { return tile.shadow ? !tile.shadow.playing || shadowEnded(tile) : inner.paused; },
    play() { if (tile.shadow) { if (shadowEnded(tile)) tile.shadow.time = 0; touch(); tile.shadow.playing = true; if (tile.onShadow) tile.onShadow(); } else inner.play(); },
    pause() { if (tile.shadow) { touch(); tile.shadow.playing = false; if (tile.onShadow) tile.onShadow(); } else inner.pause(); },
    get rate() { return tile.shadow ? tile.shadow.rate : inner.rate; },
    set rate(r) { if (tile.shadow) { touch(); tile.shadow.rate = r; } else inner.rate = r; },
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
    // A second after a seek, and for as long as the embed says it is still buffering (state 3).
    // Without the buffering part the drift engine starts re-seeking a tile that has not finished
    // loading the last seek, which keeps it buffering forever; the 10 s cap stops a dead embed
    // from holding its group up for good.
    get settling() {
      const since = performance.now() - seekAt;
      return since < 1000 || (st.state === 3 && since < 10000);
    },
    get time() {
      const t = st.state === 1 && st.at ? st.time + (performance.now() - st.at) / 1000 * (st.rate || 1) : st.time;
      return st.duration > 0 ? Math.min(t, st.duration) : t;
    },
    set time(t) { yt.seek(t); st.time = t; st.at = performance.now(); seekAt = st.at; },
    // While the user is dragging: ask the player to show that frame without committing to it
    // (allowSeekAhead false), and do not start settling - there is a real seek coming on release.
    scrub(t) { yt.scrub(t); st.time = t; st.at = performance.now(); },
    get duration() { return st.duration || 0; },
    get paused() { return yt.paused; },
    play() { yt.play(); }, pause() { yt.pause(); },
    get rate() { return st.rate || 1; }, set rate(r) { st.rate = r; yt.rate(r); },
  };
}
// A text tile has no path and no title: its own first words name it, on one line (the name goes
// into status lines, undo labels and the timeline legend, where a newline would break the layout).
const tileName = (t) => (t.type === 'text' ? (t.text.trim().replace(/\s+/g, ' ').slice(0, 24) || 'Text') : t.type === 'line' ? 'Line' : t.title || basename(t.path));

function setMasterVolume(v, { updateSlider = true } = {}) {
  masterVolume = clamp(Number(v), 0, 1);
  if (updateSlider) masterVol.value = String(Math.round(masterVolume * 100));
  masterVol.style.setProperty('--progress', (masterVolume * 100).toFixed(1) + '%');
  masterPct.textContent = Math.round(masterVolume * 100) + '%';
  masterIcon.textContent = masterVolume === 0 ? '🔇' : masterVolume < 0.34 ? '🔈' : masterVolume < 0.67 ? '🔉' : '🔊';
  for (const t of tiles) applyTileVolume(t);
  if (!IS_VIEW) announceLive([...(liveSets.get(0) || [])]); // the views play at the main window's master volume
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
    s.rotate = t.rotation ? t.rotation + 'deg' : '';
    s.zIndex = t.lifted ? String(zTop + 2) : t.z != null ? String(t.z) : ''; // its place in the stack (bring to front / send to back); lifted: above all while cropping or swapping
    cullTile(t); // moved into or out of view (an undo, a drag, a tidy)
    if (t.type === 'line') drawLine(t); // its stroke, in its (maybe new) box
    else { const ls = attachedLinesOf(t); if (ls) for (const ln of ls) reattachLine(ln); } // (arrows on it follow)
    if (selection.size === 1 && selection.has(t)) updateRotateHandle(); // (resized, moved, undone)
    if (t.group) try { schedulePlaceSyncBars(); } catch {} // (its group's play bar follows it)
  } else {
    if (t.freeAspect) return; // text tiles have no gallery form; they are hidden there
    const maxW = innerWidth();
    let h = galleryHOf(t); // each tile's own height
    let w = h * t.aspect;
    if (w > maxW) { w = maxW; h = w / t.aspect; }
    s.left = ''; s.top = ''; s.zIndex = ''; s.rotate = ''; // the gallery is a straight grid
    s.width = Math.round(w) + 'px';
    s.height = Math.round(h) + 'px';
  }
}

// offscreen pause (the block after hover play) re-checks shortly after anything moves the view
let offscreenTimer = null;
function scheduleOffscreen() { clearTimeout(offscreenTimer); offscreenTimer = setTimeout(() => { applyLiveBudget(); applyOffscreen(); applyImageLod(); }, 50); }

// ---- big boards: what is not in view is not on the page (2026-11-06) ----
// A Miro import of 3000 pictures and captions made every frame of a pan cost 50-200 ms: Chromium
// redraws, and works out what is under the mouse among, every element on the board, ~25 per tile.
// So a picture or text tile well outside the view is taken off the page (display: none) until the
// view comes near it, and one too small on screen to click loses its buttons and handles. The
// tile's place, size and everything else stay as they are; only the drawing goes. Videos are left
// alone: the live budget already decides what they decode.
const CULL_MARGIN = 0.5;   // of the view, each side: tiles that near are kept, so a pan never shows a gap
const TINY_PX = 28;        // shorter than this on screen: no title bar or handles (nothing to aim at)
let cullView = null;       // the view in board coordinates, set by applyBoardView
const cullable = (t) => t.type === 'image' || t.type === 'text' || t.type === 'line';
function cullTile(t) {
  if (!cullable(t) || !t.board) return;
  const v = cullView;
  const out = !!v && isBoard() && !t.editing && !selection.has(t) && (t.board.x > v.x1 || t.board.x + t.board.w < v.x0 || t.board.y > v.y1 || t.board.y + t.board.h < v.y0);
  if (out !== !!t.culled) {
    t.culled = out;
    t.el.classList.toggle('culled', out);
    if (!out && t.type === 'text' && t.needsMeasure) { t.needsMeasure = false; renderTextTile(t); } // its height was left as it was while off the page
  }
  const tiny = !!v && isBoard() && t.board.h * board.zoom < TINY_PX;
  if (tiny !== !!t.tiny) { t.tiny = tiny; t.el.classList.toggle('tiny', tiny); }
}
function applyCulling() {
  if (!isBoard()) { cullView = null; for (const t of tiles) { if (t.culled) { t.culled = false; t.el.classList.remove('culled'); } if (t.tiny) { t.tiny = false; t.el.classList.remove('tiny'); } } return; }
  const r = gridRect();
  const z = board.zoom, mx = r.width * CULL_MARGIN, my = r.height * CULL_MARGIN;
  cullView = { x0: (-mx - board.panX) / z, y0: (-my - board.panY) / z, x1: (r.width + mx - board.panX) / z, y1: (r.height + my - board.panY) / z };
  for (const t of tiles) cullTile(t);
}
// The controls on every tile keep their screen size through --ui-scale (1 / zoom). Changing it
// restyles and re-lays-out every tile on the page, which made each step of a zoom cost 100+ ms on a
// big board; so while a zoom is going on it waits, and is set once the zoom has paused.
let lastUiScale = '', uiScaleTimer = null;
const UI_SCALE_SETTLE_MS = 120;
function setUiScaleNow() { clearTimeout(uiScaleTimer); uiScaleTimer = null; const ui = String(1 / board.zoom); if (ui !== lastUiScale) { lastUiScale = ui; canvas.style.setProperty('--ui-scale', ui); } }
function applyBoardView() {
  canvas.style.transform = `translate(${board.panX}px, ${board.panY}px) scale(${board.zoom})`;
  if (String(1 / board.zoom) !== lastUiScale) {
    if (!lastUiScale || lastUiScale === '1' || tiles.length < 150) setUiScaleNow(); // a small board, or the first view: at once
    else { clearTimeout(uiScaleTimer); uiScaleTimer = setTimeout(setUiScaleNow, UI_SCALE_SETTLE_MS); }
  }
  applyCulling();
  // the dots: 24 board px apart, four times wider each time they would crowd closer than 12 screen px
  let spacing = 24 * board.zoom;
  while (spacing < 12) spacing *= 4;
  grid.style.backgroundSize = `${spacing}px ${spacing}px`;
  grid.style.backgroundPosition = `${board.panX}px ${board.panY}px`;
  updateZoomUI();
  updateTextToolbar(); // it floats over the board in screen space, so pan and zoom move it
  try { placeSyncBars(); } catch {} // (so do the synced groups' play bars; not yet set up while the app starts)
  try { if (miniOn) drawMiniMap(); } catch {} // (the view on the overview map; not yet set up while the app starts)
  scheduleOffscreen();
}

function layoutTiles() {
  for (const t of tiles) layoutTile(t);
  if (isBoard()) {
    applyBoardView();
  } else {
    canvas.style.transform = ''; // the board's pan/zoom must not leak into the gallery
    canvas.style.setProperty('--ui-scale', '1'); lastUiScale = '1';
    applyCulling(); // everything back on the page for the gallery
    updateZoomUI();
  }
  scheduleOffscreen();
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

// ---------- stacking: bring to front / send to back (Mark, 2026-11-10) ----------
// A tile is raised whenever it is clicked or dragged, so something can end up in front by
// accident; Send to back (right-click any tile, or PageDown) puts it behind everything again, and
// Bring to front (PageUp) the other way. A tile's place in the stack is tile.z (null: where it was
// added, in board order), saved with the session so it survives a reopen.
let zBottom = 0;
function bringToFront(tile) {
  tile.z = ++zTop;
  tile.el.style.zIndex = String(tile.z);
}
function sendToBack(tile) {
  tile.z = --zBottom;
  tile.el.style.zIndex = String(tile.z);
}
// where a tile is in the stack now: its z (0 when it has none), then board order
const stackKey = (t) => (t.z != null ? t.z : 0) * 1e6 + tiles.indexOf(t);
// what a menu or key acts on: everything selected when this tile is part of it, else just this tile
function stackTargets(tile) {
  const list = tile && !selection.has(tile) ? [tile] : [...selection].filter((t) => tiles.includes(t) && t.board);
  return list.sort((a, b) => stackKey(a) - stackKey(b));
}
function stackToFront(tile) {
  const list = stackTargets(tile);
  if (!list.length) return;
  for (const t of list) bringToFront(t); // lowest first: they keep their order among themselves
  setStatus(list.length === 1 ? `${tileName(list[0])} brought to front` : `${list.length} tiles brought to front`, 2500);
}
function stackToBack(tile) {
  const list = stackTargets(tile);
  if (!list.length) return;
  for (const t of list.slice().reverse()) sendToBack(t); // highest first, so they keep their order
  setStatus(list.length === 1 ? `${tileName(list[0])} sent to back` : `${list.length} tiles sent to back`, 2500);
}
// the two lines every tile's right-click menu has
const stackMenuItems = (tile) => [
  ['Bring to front  (PgUp)', () => stackToFront(tile)],
  ['Send to back  (PgDn)', () => stackToBack(tile)],
];
// a tile's place in the stack from a saved record (null when it has none)
function applySavedZ(tile, v) {
  const z = v && v.z != null && v.z !== '' ? Number(v.z) : NaN;
  if (!Number.isFinite(z)) return;
  tile.z = z;
  if (z > zTop) zTop = z;
  if (z < zBottom) zBottom = z;
  layoutTile(tile);
}
// ---------- locking (Mark, 2026-11-10) ----------
// A locked tile stays exactly as it is: it can't be moved, resized, cropped, edited, restyled or
// removed, and the lasso and every tidy leave it alone. Pressing on it is pressing on the board:
// a drag draws the lasso (so pictures lying on a locked panel are easy to sweep up), a click selects
// just it, so it can be unlocked (right-click → Unlock, or Ctrl+Shift+L). Lines and pictures still
// snap to it, and a locked divider still makes rows. Videos on it still play from their buttons.
function setLocked(tile, on, { quiet = false } = {}) {
  tile.locked = !!on;
  tile.el.classList.toggle('locked', tile.locked);
  if (tile.locked && !tile.el.querySelector(':scope > .lock-badge')) {
    const b = document.createElement('div');
    b.className = 'lock-badge';
    b.textContent = '🔒';
    b.title = 'Locked – right-click → Unlock (Ctrl+Shift+L)';
    tile.el.appendChild(b);
  }
  if (tile.locked && tile.editing) endTextEdit(tile);
  if (!quiet) updateTextToolbar();
}
// what the menu or the key acts on: the selection when this tile is in it, else this tile
function lockTargets(tile) { return tile && !selection.has(tile) ? [tile] : [...selection].filter((t) => tiles.includes(t)); }
// lock them all, or, when they are all locked already, unlock them all (one undo)
function toggleLock(tile) {
  const list = lockTargets(tile);
  if (!list.length) { setStatus('Select something to lock first'); return; }
  const on = list.some((t) => !t.locked);
  const changes = list.filter((t) => !!t.locked !== on).map((t) => ({ tile: t, before: !!t.locked, after: on }));
  for (const c of changes) setLocked(c.tile, on);
  if (changes.length) undoStack.push({ kind: 'lock', label: `${on ? 'lock' : 'unlock'} ${changes.length === 1 ? tileName(changes[0].tile) : changes.length + ' tiles'}`, changes });
  setStatus(list.length === 1 ? `${tileName(list[0])} ${on ? 'locked – drag on it to lasso what lies on it' : 'unlocked'}` : `${list.length} tiles ${on ? 'locked' : 'unlocked'}`, 4000);
}
const lockMenuItem = (tile) => ['Lock  (Ctrl+Shift+L)', () => toggleLock(tile)];
// the menu of a locked tile: unlocking, and for a divider the rows it makes (they move other things)
function lockedMenuItems(tile) {
  const items = [['Unlock  (Ctrl+Shift+L)', () => toggleLock(tile)]];
  if (tile.type === 'line' && isLevelLine(tile)) {
    items.push(['Line up the pictures between these lines', () => lineUpRows(tile)]);
    items.push(['Trim pictures at these lines', () => trimAtLines(tile)]);
  }
  if (tile.type === 'line') items.push(['Select lines like this one', () => selectLinesLike(tile)]);
  if (tile.type === 'image') items.push([REVEAL_LABEL, async () => { if (!(await window.api.showInExplorer(tile.path))) setStatus('File not found: ' + tile.path); }]);
  return items;
}
// the locked tile a press landed on (a control on it, like a video's play button, is not the tile)
function lockedTileAt(target) {
  if (!target || !target.closest || target.closest('button, input, select, textarea, .handle, .line-end')) return null;
  const el = target.closest('.tile');
  const t = el && tiles.find((x) => x.el === el);
  return t && t.locked && t.board ? t : null;
}

// For the length of a gesture that needs the tile seen whole (cropping, swapping), it is drawn
// above everything without changing its place in the stack; off again, it is back where it was.
function liftTile(tile, on) {
  tile.lifted = !!on;
  layoutTile(tile);
}

// Every board interaction (drag, resize, lasso, pan) marks the body and the tile while it runs,
// and `body.tile-dragging .tile` / `body.resizing .tile` set pointer-events: none on everything
// else so the drag cannot be stolen. If the release is lost - it landed inside a cross-origin
// embed, the window lost focus, the pointer was cancelled - those marks stay, and with them the
// board is frozen: measured on 2026-09-21, elementFromPoint over a tile returned <main>. This
// puts everything back, and every interaction calls it when its pointer sequence ends any way at
// all. Mark's workaround (switch to Gallery and back) still calls it too, as the last resort.
// Each board interaction registers how to end itself here while it runs, so a recovery can stop
// it properly rather than only tidying the classes: a half-dead drag whose pointermove listeners
// are still attached goes on moving tiles (and throws in boardBounds, seen 2026-09-21).
const activeInteractions = new Set();
function endActiveInteractions() {
  for (const end of [...activeInteractions]) { activeInteractions.delete(end); try { end(); } catch {} }
}
function resetBoardInteraction() {
  endActiveInteractions();
  document.body.classList.remove('tile-dragging', 'resizing', 'panning');
  for (const t of tiles) t.el.classList.remove('dragging', 'resizing');
  document.body.style.cursor = '';
  if (marqueeEl) marqueeEl.hidden = true;
  hideGuides();
}
// The release still reaches the window even when it happened over an embed, so listen in the
// capture phase; blur covers alt-tab mid-drag, and pointercancel a drag Chromium gave up on.
for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, () => setTimeout(resetBoardInteraction, 0), true);
window.addEventListener('blur', () => resetBoardInteraction());

// ---------- board: selection ----------

function setSelected(tile, on) {
  if (on) selection.add(tile); else selection.delete(tile);
  tile.el.classList.toggle('selected', on);
  syncActiveFromSelection();
  updateTextToolbar();
}
function clearSelection() {
  for (const t of selection) { t.el.classList.remove('selected'); if (t.editing) endTextEdit(t); }
  selection.clear();
  syncActiveFromSelection();
  updateTextToolbar();
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
  if (!sw) return; // a text tile has no overlay to paint
  sw.hidden = !t.group;
  if (t.group) sw.style.background = Groups.PALETTE[t.group.color];
}
// members that can play (local and YouTube); Twitch and image members only share Sticky / mute / volume
// (2026-11-18) and its sync points, if it has any: see lib/groups.js
const memberEntry = (t) => ({ tile: t, start: t.sync ? t.sync.start : 0, points: (t.sync && t.sync.points) || null, duration: t.pb.duration });
function memberModel(g) {
  return [...g.members].filter((t) => t.pb).map(memberEntry);
}
// the video the others follow: the one picked, else the longest (it never has sync points itself)
function mainOf(g) {
  if (g.main && g.members.has(g.main) && g.main.pb) return g.main;
  const ms = [...g.members].filter((t) => t.pb);
  return ms.sort((a, b) => (b.pb.duration || 0) - (a.pb.duration || 0))[0] || null;
}
function captureStarts(g) {
  const ms = [...g.members].filter((t) => t.pb);
  const starts = Groups.starts(ms.map((t) => t.pb.time));
  ms.forEach((t, i) => { t.sync = { start: starts[i] }; });
}
function createGroup(list, opts = {}) {
  if (!viewMayEdit()) return null;
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
  t.group = null; t.sync = null; paintGroup(t); markHold(t, false);
  setOwnMuted(t, t.ownMuted); applyTileVolume(t); applyTileLoop(t);
}
function removeFromGroup(g, t) {
  g.members.delete(t); releaseTile(t);
  if (g.members.size < 2) dissolveGroup(g);
  else if (active === g) renderGroupBar();
}
function dissolveGroup(g) {
  if (!viewMayEdit()) return;
  logUi('info', 'group dissolved', { id: g.id, members: g.members.size });
  for (const t of [...g.members]) releaseTile(t);
  g.members.clear();
  if (g.lining) g.lining = null;
  const i = groups.indexOf(g); if (i >= 0) groups.splice(i, 1);
  placeSyncBars();
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
gbQ('.gb-mute').addEventListener('click', () => { active.muted = !active.muted; applyGroupAudio(active); emitGroupAudio(active); renderGroupBar(); });
gbQ('.gb-vol').addEventListener('input', () => { active.volume = Number(gbQ('.gb-vol').value) / 100; applyGroupAudio(active); emitGroupAudio(active); });
gbQ('.gb-rate').addEventListener('change', () => { active.rate = Number(gbQ('.gb-rate').value); applyGroupAudio(active); });
/* (before 2026-11-18: Sync locked the videos wherever they happened to be)
gbQ('.gb-sync').addEventListener('click', () => setGroupSync(active, !active.sync));
*/
gbQ('.gb-sync').addEventListener('click', () => toggleSyncFromUser(active));
gbQ('.gb-sticky').addEventListener('click', () => { active.sticky = !active.sticky; renderGroupBar(); });
gbQ('.gb-tidy').addEventListener('click', () => tidyGroup(active));
gbQ('.gb-loop').addEventListener('change', () => { active.loop = gbQ('.gb-loop').value; if (active.loop !== 'off' && !active.sync) setGroupSync(active, true); renderGroupBar(); renderTimeline(); });
gbQ('.gb-name').addEventListener('change', () => renderTimeline());
gbQ('.gb-ungroup').addEventListener('click', () => dissolveGroup(active));

// Sync from the user: never lined up (and nothing kept from before) -> the sync editor, to line them up
function toggleSyncFromUser(g) {
  if (!g) return;
  if (!g.sync && !g.stash && [...g.members].filter((t) => t.pb && t.mediaEl && !t.pb.web).length >= 2) {
    openSyncEditor(g);
    setStatus('Line them up here: put both on the same frame, then ◆ Sync here');
    return;
  }
  setGroupSync(g, !g.sync);
}
function setGroupSync(g, on) {
  if (g.lining) endLining(g, false);
  g.sync = on;
  if (on) {
    // sync points made before Sync was turned off come back with it
    const st = g.stash;
    if (st && [...g.members].every((t) => !t.pb || st.has(t))) { for (const t of g.members) t.sync = st.get(t) || null; setStatus('Sync on, with its sync points back'); }
    else captureStarts(g);
    g.stash = null;
  } else {
    if (g.main || [...g.members].some((t) => t.sync && t.sync.points)) g.stash = new Map([...g.members].map((t) => [t, t.sync])); // (lined up in the sync editor: kept for turning it on again)
    for (const t of g.members) t.sync = null;
  }
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
// (the main video first when it is playing: its time maps straight onto the group's, where a follower
// with sync points may be holding or about to jump)
const leadOf = (ms) => ms.filter((m) => !m.tile.pb.paused).sort((a, b) => (a.points ? 1 : 0) - (b.points ? 1 : 0) || LEAD_RANK[a.tile.pb.kind] - LEAD_RANK[b.tile.pb.kind])[0];
function groupTimeOf(g) {
  const ms = memberModel(g);
  if (!ms.length) return 0;
  const inside = (m) => m.tile.pb.time > 0 && m.tile.pb.time < m.duration;
  const lead = leadOf(ms) || ms.find((m) => !m.points && inside(m)) || ms.find(inside);
  if (lead) return Groups.toGroup(lead, lead.tile.pb.time);
  const waiting = ms.filter((m) => m.tile.pb.time <= 0);
  return waiting.length ? Math.min(...waiting.map((m) => Groups.extent(m).from)) : Groups.end(ms);
}
function seekGroup(g, gt) {
  syncing = true;
  try { for (const m of memberModel(g)) m.tile.pb.time = Groups.at(m, gt); }
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
    for (const m of ms) if (Groups.plays(m, gt)) m.tile.pb.play();
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
  // the other windows hear about the leader here: its own bar and keys move its <video> directly,
  // not through tile.pb (the members below go through tile.pb and report themselves)
  if (leader.pb) emitPlayback(leader, action, action === 'rate' ? value : action === 'seek' || action === 'scrub' ? leader.pb.time : undefined);
  const g = leader.group;
  if (!g) return;
  if (action === 'rate') { g.rate = value; applyGroupAudio(g); if (active === g) renderGroupBar(); return; } // speed is shared even without Sync
  if (syncing || !g.sync || !leader.sync) return;
  if (g.lining) return; // lining up: each video moves on its own until Keep
  syncing = true;
  try {
    const gt = Groups.toGroup(memberEntry(leader), leader.pb.time);
    for (const m of memberModel(g)) {
      if (m.tile === leader) continue;
      const p = m.tile.pb;
      if (action === 'play') { if (Groups.plays(m, gt)) p.play(); }
      else if (action === 'pause') p.pause();
      else if (action === 'seek') p.time = Groups.at(m, gt);
      // mid-drag: members preview too, so a YouTube member is not made to re-buffer on every step
      else if (action === 'scrub') pbScrub(p, Groups.at(m, gt));
    }
  } finally { syncing = false; }
}

// Runs 10x a second: drift correction, waiting members, held members, loops. Quiet (what it does
// is this window's own correction), and not at all in a view: a view follows the main window's
// playback messages and clock instead.
setInterval(() => { if (!IS_VIEW) quietly(syncEngineTick); }, 100);
function syncEngineTick() {
  for (const g of groups) {
    if (!g.sync || g.lining) continue;
    const ms = memberModel(g);
    const lead = leadOf(ms);
    if (!lead) continue;
    // Someone is dragging a member's bar: the group is deliberately out of sync until they let go,
    // and correcting it mid-drag just re-seeks (and re-buffers) the other members for nothing.
    if (timelineScrubbing || ms.some((m) => m.tile.scrubbing)) continue;
    const gt = Groups.toGroup(lead, lead.tile.pb.time);
    const loopEnd = Groups.loopEnd(g.loop, ms.filter((m) => m.duration > 0), g.range); // ignore members still loading
    if (loopEnd !== null && gt >= loopEnd - 0.05) {
      const to = g.loop === 'range' && g.range ? g.range.in : 0;
      seekGroup(g, to);
      for (const m of ms) if (!m.tile.autoPaused && Groups.plays(m, to)) m.tile.pb.play();
      continue;
    }
    syncing = true;
    try {
      for (const m of ms) {
        if (m === lead) continue;
        if (m.tile.autoPaused) continue; // paused because it is off screen: applyOffscreen re-seeks and resumes it
        const p = m.tile.pb;
        const want = Groups.at(m, gt);
        const inside = Groups.plays(m, gt);
        if (inside && p.paused) p.play();   // its start was reached
        if (!inside && !p.paused) p.pause(); // waiting at 0 or holding at the end
        // YouTube on either side: ~¼ s slack, and none while it is still settling after a seek
        // a sequence moves in whole frames, so give it 1.5 frames of slack at low frame rates
        const slack = p.web || lead.tile.pb.web ? Groups.DRIFT_WEB : Math.max(Groups.DRIFT, p.frameSlack || 0, lead.tile.pb.frameSlack || 0);
        if (!p.settling && Math.abs(p.time - want) > slack) p.time = want;
      }
    } finally { syncing = false; }
  }
}

// ---------- sync points, lining up, and a play bar by each synced group (2026-11-18) ----------
// Two cuts of the same footage drift apart wherever their edits differ, so one offset per video is
// not enough. A follower can carry sync points ("at this moment of the main video, I am here"; the
// maths is in lib/groups.js), made by lining the videos up by eye or by sound (lib/audiosync.js).
// Each synced group gets a small bar on the board, just above its videos: play/pause, the main
// video's time, previous / next sync point, + Sync point. It can be dragged, but only so far from
// the videos.
const SYNC_NEAR = 1.0; // s: a new sync point this close to one already there re-does that one
function syncRecord(t) {
  const s = t.sync || (t.group && t.group.stash && t.group.stash.get(t)) || null;
  if (!s) return null;
  return { start: s.start, ...(s.points ? { points: s.points.map((p) => ({ g: p.g, t: p.t })) } : {}) };
}
// dimmed while it waits through a part only the main video has
function markHold(t, on) {
  if (!!t.holdMarked === !!on) return;
  t.holdMarked = !!on;
  t.el.classList.toggle('sync-hold', !!on);
}
// a follower's sync as a whole: a single point is just an offset
function followerSync(pts, fallbackStart) {
  if (!pts || !pts.length) return { start: fallbackStart, points: null };
  /* (before 2026-11-18 evening: one point was folded into a plain offset; the sync editor keeps it,
     so a line-up made there is told apart from an old blind Sync press)
  if (pts.length === 1) return { start: pts[0].g - pts[0].t, points: null };
  */
  return { start: Groups.extent({ points: pts, duration: 0 }).from, points: pts };
}
// every sync point of the group, in group time (the followers' points together)
function groupPoints(g) {
  const out = [];
  for (const m of memberModel(g)) if (m.points) for (const p of m.points) if (!out.some((x) => Math.abs(x.g - p.g) < 0.05)) out.push(p);
  return out.sort((a, b) => a.g - b.g);
}
// group time from 0: the earliest member begins at 0, as Groups.starts has always done
function normalizeGroup(g) {
  const ms = memberModel(g);
  if (!ms.length) return;
  const from = Math.min(...ms.map((m) => Groups.extent(m).from));
  if (!isFinite(from) || Math.abs(from) < 1e-6) return;
  const d = -from;
  for (const m of ms) m.tile.sync = { start: m.start + d, points: m.points ? Groups.shiftPoints(m.points, d) : null };
  if (g.range) g.range = { in: g.range.in + d, out: g.range.out + d };
}
// undo: the group's whole sync (on/off, main video, every member's offset and points, the range)
function syncState(g) {
  return { sync: g.sync, main: g.main || null, range: g.range ? { ...g.range } : null, members: new Map([...g.members].map((t) => [t, t.sync ? { ...t.sync } : null])) };
}
function applySyncState(g, st) {
  if (!groups.includes(g)) return;
  if (g.lining && !(sedOpen() && sed.g === g)) endLining(g, false); // (the sync editor keeps its videos apart)
  g.sync = st.sync; g.main = st.main; g.range = st.range ? { ...st.range } : null;
  for (const [t, v] of st.members) if (g.members.has(t)) t.sync = v ? { ...v } : null;
  afterSyncChange(g);
}
function pushSyncUndo(g, label, before) { undoStack.push({ kind: 'sync', label, group: g, before, after: syncState(g) }); }
function afterSyncChange(g) {
  if (!g.sync) for (const t of g.members) markHold(t, false);
  renderGroupBar(); renderTimeline(); placeSyncBars();
}

// ---- lining up: each video moves on its own (its bar, , . keys) until Keep ----
function startLining(g, quiet) {
  if (!viewMayEdit() || !g || g.lining) return;
  const ms = memberModel(g);
  if (ms.length < 2) { setStatus('Lining up needs two videos in the group'); return; }
  for (const m of ms) m.tile.pb.pause();
  g.lining = { before: syncState(g), times: new Map(ms.map((m) => [m.tile, m.tile.pb.time])) };
  for (const m of ms) { m.tile.el.classList.add('lining'); markHold(m.tile, false); }
  if (!quiet) setStatus('Lining up: move each video to the same moment (its own bar, or , and . on the one under the mouse). 🎧 can do it by sound. Then ✓ Keep.', 12000);
  placeSyncBars();
}
function endLining(g, kept) {
  const L = g.lining;
  if (!L) return;
  g.lining = null;
  for (const t of g.members) t.el.classList.remove('lining');
  if (!kept) for (const [t, time] of L.times) if (g.members.has(t) && t.pb) { t.pb.pause(); t.pb.time = time; }
  renderGroupBar(); renderTimeline(); placeSyncBars();
}
// Keep: this moment of the main video is this moment of each other one
async function keepLining(g) {
  const L = g.lining;
  if (!L) return;
  const main = mainOf(g);
  if (!main) { endLining(g, false); return; }
  const before = L.before;
  const ms = memberModel(g), mm = ms.find((m) => m.tile === main);
  let label = 'sync point', note = '';
  if (!g.sync) {
    // the first line-up: plain offsets from here, as Sync always made
    for (const m of ms) m.tile.sync = { start: m.tile === main ? 0 : main.pb.time - m.tile.pb.time, points: null };
    g.sync = true; g.stash = null; label = 'line up';
    note = 'Synced here. Where their cuts differ later, line them up again there (+ Sync point).';
  } else {
    if (mm.points) main.sync = { start: Groups.extent(mm).from, points: null }; // (the main video never follows)
    const gt = Groups.toGroup(memberEntry(main), main.pb.time);
    let added = 0, redone = 0, refined = 0;
    L.newAt = gt; L.changed = [];
    for (const m of ms) {
      if (m.tile === main) continue;
      const ft = m.tile.pb.time;
      if (!m.points) {
        // a plain offset so far: a small change is a better line-up of the same stretch; a big one is
        // a place where the cuts differ, so the old line-up stays as a point at its frame 0
        if (Math.abs((gt - ft) - m.start) < SYNC_NEAR) { m.tile.sync = { start: gt - ft, points: null }; refined++; continue; }
        m.tile.sync = followerSync(Groups.cleanPoints([{ g: m.start, t: 0 }, { g: gt, t: ft }]), m.start);
        added++; L.changed.push(m.tile);
      } else {
        const near = m.points.some((p) => Math.abs(p.g - gt) <= SYNC_NEAR);
        m.tile.sync = followerSync(Groups.addPoint(m.points, gt, ft, SYNC_NEAR), m.start);
        if (near) redone++; else added++;
        L.changed.push(m.tile);
      }
    }
    note = added ? 'Sync point added: from here on they stay together' : redone ? 'Sync point re-done' : refined ? 'Lined up here' : '';
  }
  g.main = main;
  const gtAt = L.newAt, changed = L.changed || [];
  endLining(g, true);
  // where exactly the cuts part, between this sync point and the ones either side of it
  let cuts = [];
  if (changed.length) {
    setStatus('Listening for where their cuts part…', 20000);
    try { cuts = await findCuts(g, main, changed, gtAt); } catch (err) { logUi('warn', 'finding cuts failed', { error: String(err && err.message || err) }); }
  }
  normalizeGroup(g);
  pushSyncUndo(g, label, before);
  afterSyncChange(g);
  const n = groupPoints(g).length;
  setStatus(`${note}${cuts.length ? ' · ' + cuts.join(' · ') : ''}${n ? ` · ${n} sync point${n === 1 ? '' : 's'}` : ''} · ▶ plays them together`, 9000);
}
// Between a new sync point and its neighbours the offset changes, but the points alone cannot say
// where: by itself the follower would play on and only wait (or jump) just before the next point.
// The sound can say: the cut is put where it is, as one more sync point. Videos on this PC only,
// stretches up to ten minutes.
async function findCuts(g, main, followers, at) {
  const local = (t) => !!(t.pb && t.pb.kind === 'video' && !t.pb.web && !t.url && t.path);
  const out = [];
  if (!local(main) || main.sync.points) return out;
  const S_M = main.sync.start, step = AudioSync.HOP / AudioSync.RATE;
  const pcm = (u) => new Int16Array(u.buffer.slice(u.byteOffset, u.byteOffset + (u.byteLength & ~1)));
  for (const f of followers) {
    if (!local(f) || !f.sync || !f.sync.points) continue;
    let pts = f.sync.points;
    const i = pts.findIndex((p) => Math.abs(p.g - at) < 0.05);
    if (i < 0) continue;
    for (const [p, n] of [[pts[i - 1], pts[i]], [pts[i], pts[i + 1]]]) {
      if (!p || !n || n.t < p.t) continue;
      const dg = n.g - p.g, dt = n.t - p.t;
      if (Math.abs(dg - dt) < 0.1 || dg > 600 || dg < 2) continue;
      const o1 = p.g - p.t, o2 = n.g - n.t, gap = Math.max(0, dg - dt), skip = Math.max(0, dt - dg);
      const b0 = Math.max(0, Math.min(p.t, n.t - dg) - 0.5), b1 = Math.min(f.pb.duration || Infinity, Math.max(p.t + dg, n.t) + 0.5);
      const [ua, ub] = await Promise.all([window.api.audioPcm(main.path, p.g - S_M, dg), window.api.audioPcm(f.path, b0, b1 - b0)]);
      if (!ua || !ub) continue;
      // (offsets in main time: main time = group time - S_M). The points are lined up by picture, and
      // the sound can sit a few frames off it, differently in each copy: a quarter second of slack.
      const pm = p.g - S_M;
      const r = AudioSync.findCut(AudioSync.envelope(pcm(ua)), pm, AudioSync.envelope(pcm(ub)), b0, o1 - S_M, o2 - S_M, gap, step, 0.25);
      logUi('info', 'find cut', { file: tileName(f), from: p.g, to: n.g, gap, skip, result: r });
      if (!r) { out.push(`${tileName(f)}: could not hear where the cuts part, so it ${gap ? 'waits' : 'jumps'} just before the next sync point`); continue; }
      let gc = r.at + S_M;
      // the sound says roughly; the picture says exactly: onto the nearest shot change in the follower
      const ft = p.t + (gc - p.g);
      const scenes = await window.api.sceneCuts(f.path, Math.max(0, ft - 0.6), 1.2).catch(() => []);
      if (scenes && scenes.length) { const near = scenes.reduce((x, y) => (Math.abs(y - ft) < Math.abs(x - ft) ? y : x)); gc += near - ft; }
      const q = gap ? { g: gc + gap, t: p.t + (gc - p.g) } : { g: gc, t: p.t + (gc - p.g) + skip };
      if (q.g <= p.g + 0.05 || q.g >= n.g - 0.05) continue; // already where the points put it
      pts = Groups.cleanPoints([...pts, q]);
      f.sync = followerSync(pts, f.sync.start);
      out.push(gap ? `${tileName(f)} waits ${gap.toFixed(1)} s from ${fmtTime(gc - S_M)} (a part it does not have)` : `${tileName(f)} skips ${skip.toFixed(1)} s at ${fmtTime(gc - S_M)} (a part only it has)`);
    }
  }
  return out;
}

// ---- by sound: move each other local video to where its sound matches the main one's ----
async function matchBySound(g, btn) {
  const main = mainOf(g);
  if (!main || !g.lining) return;
  const local = (t) => !!(t.pb && t.pb.kind === 'video' && !t.pb.web && !t.url && t.path); // a video file (no type: the original kind)
  if (!local(main)) { setStatus('Matching by sound needs the main video to be a video file on this PC'); return; }
  const others = [...g.members].filter((t) => t !== main && t.pb);
  if (btn) { btn.disabled = true; btn.textContent = '🎧 Listening…'; }
  const msgs = [];
  try {
    for (const f of others) {
      if (!local(f)) { msgs.push(`${tileName(f)}: not a video file, line it up by eye`); continue; }
      const mainT = main.pb.time;
      const pcm = (u) => new Int16Array(u.buffer.slice(u.byteOffset, u.byteOffset + (u.byteLength & ~1)));
      // 16 s of sound within 40 s either way first; nothing there: 32 s, then two minutes either way
      let r = null, unread = null;
      for (const { half, search } of AudioSync.TRIES) {
        const w = AudioSync.windows(mainT, main.pb.duration, f.pb.time, f.pb.duration, search, half);
        const [a, b] = await Promise.all([window.api.audioPcm(main.path, w.main.start, w.main.dur), window.api.audioPcm(f.path, w.other.start, w.other.dur)]);
        if (!g.lining) return; // cancelled meanwhile
        if (!a || !b) { unread = !a ? main : f; break; }
        r = AudioSync.match(pcm(a), w.main.start, pcm(b), w.other.start, mainT);
        if (r.time !== null) break;
      }
      if (unread) { msgs.push(`${tileName(unread)}: its sound could not be read`); continue; }
      logUi('info', 'match by sound', { file: tileName(f), at: mainT, result: r });
      if (r.time === null) { msgs.push(`${tileName(f)}: ${r.why}, line it up by eye`); continue; }
      const moved = r.time - f.pb.time;
      f.pb.time = r.time;
      msgs.push(`${tileName(f)} moved ${moved >= 0 ? '+' : '−'}${Math.abs(moved).toFixed(2)} s${r.sure ? '' : ' (not sure: check by eye)'}`);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🎧 Match by sound'; }
  }
  setStatus(msgs.join(' · ') + (msgs.length ? ' · ✓ Keep when it looks right' : ''), 9000);
}

// ---- the sync points themselves ----
function gotoSyncPoint(g, dir) {
  const pts = groupPoints(g);
  if (!pts.length) return;
  const gt = groupTimeOf(g);
  const p = dir < 0 ? [...pts].reverse().find((x) => x.g < gt - 0.25) : pts.find((x) => x.g > gt + 0.05);
  if (!p) { setStatus(dir < 0 ? 'No sync point before this' : 'No sync point after this'); return; }
  seekGroup(g, p.g);
  if (tl._model && tl._model.group === g) tickTimeline();
}
function removeSyncPoint(g, at) {
  const before = syncState(g);
  let n = 0;
  for (const m of memberModel(g)) {
    if (!m.points) continue;
    const pts = Groups.removePoint(m.points, at, 0.05);
    if ((pts ? pts.length : 0) === m.points.length) continue;
    const keep = pts || [m.points.find((p) => Math.abs(p.g - at) <= 0.05)];
    m.tile.sync = followerSync(keep, m.start); n++;
  }
  if (!n) return;
  normalizeGroup(g);
  pushSyncUndo(g, 'remove sync point', before);
  afterSyncChange(g);
  setStatus('Sync point removed (Ctrl+Z puts it back)');
}
function nearSyncPoint(g) {
  const gt = groupTimeOf(g);
  return groupPoints(g).find((p) => Math.abs(p.g - gt) <= SYNC_NEAR) || null;
}
// back to one offset each: the one they have where the playhead is, so they stay together here
function clearSyncPoints(g) {
  const before = syncState(g), gt = groupTimeOf(g);
  for (const m of memberModel(g)) {
    if (!m.points) continue;
    const p = m.points[Groups.seg(m.points, gt)];
    m.tile.sync = { start: p.g - p.t, points: null };
  }
  normalizeGroup(g);
  pushSyncUndo(g, 'clear sync points', before);
  afterSyncChange(g);
  setStatus('Sync points cleared: one offset each, as lined up here');
}
// two videos: the other one becomes the one followed
function swapMain(g) {
  const ms = memberModel(g);
  if (ms.length !== 2) return;
  const before = syncState(g);
  const M = ms.find((m) => m.tile === mainOf(g)), F = ms.find((m) => m !== M);
  if (F.points) {
    const pts = Groups.swapPoints(M.start, F.points);
    F.tile.sync = { start: 0, points: null };
    M.tile.sync = followerSync(pts, 0);
    g.range = null; // group time means something else now
  }
  g.main = F.tile;
  normalizeGroup(g);
  pushSyncUndo(g, 'swap the main video', before);
  afterSyncChange(g);
  setStatus(`${tileName(F.tile)} is the main video now: ${tileName(M.tile)} follows it`);
}

// the timeline's lanes (expanded): each sync point, and the stretches a follower waits through
function laneSyncPoints(row, model, m, end, width) {
  const g = model.group, pts = m.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], n = pts[i + 1];
    if (n.t < p.t) continue;
    const len = Math.min(n.t - p.t, n.g - p.g);
    if (n.g - p.g > len + 0.05) {
      const h = document.createElement('div'); h.className = 'tl-hold';
      h.style.left = Timeline.xFor(p.g + len, end, width) + 'px';
      h.style.width = Math.max(2, Timeline.xFor(n.g, end, width) - Timeline.xFor(p.g + len, end, width)) + 'px';
      h.title = `${tileName(m.tile)} does not have these ${(n.g - p.g - len).toFixed(1)} s: it waits (dimmed) until the next sync point`;
      row.appendChild(h);
    }
  }
  for (const p of pts) {
    const d = document.createElement('div'); d.className = 'tl-sp';
    d.style.left = Timeline.xFor(p.g, end, width) + 'px';
    const main = mainOf(g);
    d.title = `Sync point: ${main ? tileName(main) + ' ' + fmtTime(Groups.at(memberEntry(main), p.g)) : fmtTime(p.g)} = ${tileName(m.tile)} ${fmtTime(p.t)} · click: go there · right-click: remove`;
    d.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.addEventListener('click', (e) => { e.stopPropagation(); tlSeek(model, p.g); });
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); if (viewMayEdit()) removeSyncPoint(g, p.g); });
    row.appendChild(d);
  }
}

// ---- the bar ----
const syncBars = new Map(); // group -> { el, parts }
function syncBarFor(g) {
  let sb = syncBars.get(g);
  if (sb) return sb;
  const el = document.createElement('div');
  el.className = 'sync-bar';
  el.hidden = true;
  const mk = (cls, text, title) => { const b = document.createElement('button'); b.className = cls; b.textContent = text; if (title) b.title = title; el.appendChild(b); return b; };
  const span = (cls, text, title) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; if (title) s.title = title; el.appendChild(s); return s; };
  const parts = {
    grip: span('sb-grip', '⠿', 'Drag to move this bar (it stays near its videos)'),
    play: mk('sb-play', '▶', 'Play / pause them together'),
    time: span('sb-time', ''),
    prev: mk('sb-prev sb-on', '‹', 'Previous sync point'),
    count: span('sb-count sb-on', ''),
    next: mk('sb-next sb-on', '›', 'Next sync point'),
    /* (the first version, lining up in place on the board; replaced by the sync editor, 2026-11-18)
    add: mk('sb-add sb-on', '＋ Sync point', 'Line them up again here, where their cuts differ (pauses them)'),
    line: mk('sb-line sb-off', '⛓ Line them up', 'Put each on the same moment, then Keep: they play together from then on'),
    hint: span('sb-hint sb-lining', 'Put each on the same moment'),
    sound: mk('sb-sound sb-lining', '🎧 Match by sound', 'Listens to 16-32 s around the main video and moves the other one (up to 2 minutes either way) to where its sound matches'),
    keep: mk('sb-keep sb-lining', '✓ Keep', 'They are on the same moment: keep it as a sync point'),
    cancel: mk('sb-cancel sb-lining', '✕', 'Cancel: put them back where they were'),
    */
    edit: mk('sb-edit', '⇆ Sync editor', 'Line them up frame by frame, side by side (they are never linked while you do)'),
    more: mk('sb-more', '⋯', 'More'),
  };
  el.addEventListener('dblclick', (e) => e.stopPropagation());
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  parts.play.addEventListener('click', () => {
    if (g.sync && !g.lining) { playPauseGroup(g); return; }
    // not synced yet, or lining up: each plays on its own, to check them by eye and ear
    const ms = memberModel(g), any = ms.some((m) => !m.tile.pb.paused);
    for (const m of ms) { if (any) m.tile.pb.pause(); else m.tile.pb.play(); }
  });
  parts.prev.addEventListener('click', () => gotoSyncPoint(g, -1));
  parts.next.addEventListener('click', () => gotoSyncPoint(g, 1));
  /* (the first version's lining up in place, 2026-11-18)
  parts.add.addEventListener('click', () => startLining(g));
  parts.line.addEventListener('click', () => startLining(g));
  parts.sound.addEventListener('click', () => matchBySound(g, parts.sound));
  parts.keep.addEventListener('click', () => keepLining(g));
  parts.cancel.addEventListener('click', () => { endLining(g, false); setStatus('Lining up cancelled'); });
  */
  parts.edit.addEventListener('click', () => openSyncEditor(g));
  parts.more.addEventListener('click', (e) => {
    e.stopPropagation();
    const ms = memberModel(g), main = mainOf(g), other = ms.length === 2 ? ms.find((m) => m.tile !== main) : null;
    const near = g.sync ? nearSyncPoint(g) : null;
    const can = viewMayEdit() && !g.lining;
    showRowMenu(menuAt(parts.more), [
      [main ? `Main video: ${tileName(main)}` : 'Main video', () => {}, true],
      [other ? `Make “${tileName(other.tile)}” the main video` : 'Make the other one the main video', () => swapMain(g), !can || !other],
      ['Remove the sync point here', () => removeSyncPoint(g, near.g), !can || !near],
      ['Clear all sync points', () => clearSyncPoints(g), !can || !groupPoints(g).length],
      [g.sync ? 'Turn Sync off' : 'Turn Sync on', () => toggleSyncFromUser(g), !can],
      ['Put this bar back above the videos', () => { g.ctrl = null; placeSyncBars(); }, !g.ctrl],
    ]);
  });
  // drag it anywhere near its videos
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const box = groupBox(g);
    if (!box) return;
    const z = board.zoom, c0 = syncBarCenter(g, box), x0 = e.clientX, y0 = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
    const move = (ev) => {
      const cx = c0.x + (ev.clientX - x0) / z, cy = c0.y + (ev.clientY - y0) / z;
      g.ctrl = { dx: cx - (box.x + box.w / 2), dy: cy - box.y };
      placeSyncBars();
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('lostpointercapture', up); el.classList.remove('dragging'); if (g.ctrl) { const k = syncBarCenter(g, box); g.ctrl = { dx: k.x - (box.x + box.w / 2), dy: k.y - box.y }; } };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('lostpointercapture', up);
  });
  document.body.appendChild(el);
  sb = { el, parts };
  syncBars.set(g, sb);
  return sb;
}
function groupBox(g) {
  const ts = [...g.members].filter((t) => t.board && t.el.isConnected);
  if (!ts.length) return null;
  const x0 = Math.min(...ts.map((t) => t.board.x)), y0 = Math.min(...ts.map((t) => t.board.y));
  const x1 = Math.max(...ts.map((t) => t.board.x + t.board.w)), y1 = Math.max(...ts.map((t) => t.board.y + t.board.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// the bar's centre on the board: where it was put, kept within reach of its videos
function syncBarCenter(g, box) {
  const z = board.zoom, sb = syncBars.get(g);
  const h = (sb && sb.el.offsetHeight) || 40;
  const reach = Math.max(box.h * 0.35, 90 / z);
  let x = box.x + box.w / 2, y = box.y - (h / 2 + 12) / z; // default: just above the videos
  if (g.ctrl) { x = box.x + box.w / 2 + g.ctrl.dx; y = box.y + g.ctrl.dy; }
  x = clamp(x, box.x - reach, box.x + box.w + reach);
  y = clamp(y, box.y - reach, box.y + box.h + reach);
  return { x, y };
}
let syncBarsQueued = false;
function schedulePlaceSyncBars() { if (syncBarsQueued) return; syncBarsQueued = true; requestAnimationFrame(() => { syncBarsQueued = false; placeSyncBars(); }); }
function placeSyncBars() {
  for (const [g, sb] of syncBars) if (!groups.includes(g)) { sb.el.remove(); syncBars.delete(g); }
  const r = gridRect(), z = board.zoom;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  for (const g of groups) {
    const box = isBoard() && !IS_VIEW && cmp.el.hidden && !sedOpen() && !document.fullscreenElement && g !== cmp.temp && memberModel(g).length >= 2 ? groupBox(g) : null;
    // off the screen, or too small there to aim at: no bar
    const on = box && box.h * z >= 50 && r.left + board.panX + (box.x + box.w) * z > r.left && r.left + board.panX + box.x * z < r.right
      && r.top + board.panY + (box.y + box.h) * z > r.top && r.top + board.panY + box.y * z < r.bottom;
    const sb = on ? syncBarFor(g) : syncBars.get(g);
    if (!sb) continue;
    sb.el.hidden = !on;
    if (!on) continue;
    fillSyncBar(g, sb);
    const c = syncBarCenter(g, box), w = sb.el.offsetWidth, h = sb.el.offsetHeight;
    const sx = r.left + board.panX + c.x * z, sy = r.top + board.panY + c.y * z;
    sb.el.style.left = Math.round(clamp(sx - w / 2, 8, vw - w - 8)) + 'px';
    sb.el.style.top = Math.round(clamp(sy - h / 2, 8, vh - h - 8)) + 'px';
  }
  try { clearSelBarOfSyncBars(); } catch {}
}
function fillSyncBar(g, sb) {
  const P = sb.parts, el = sb.el;
  const state = g.lining ? 'lining' : g.sync ? 'on' : 'off';
  if (el.dataset.state !== state) {
    el.dataset.state = state;
    for (const b of el.querySelectorAll('.sb-on')) b.hidden = state !== 'on';
    for (const b of el.querySelectorAll('.sb-off')) b.hidden = state !== 'off';
    for (const b of el.querySelectorAll('.sb-lining')) b.hidden = state !== 'lining';
    P.edit.disabled = !viewMayEdit();
  }
  const ms = memberModel(g), main = mainOf(g);
  P.play.textContent = ms.some((m) => !m.tile.pb.paused) ? '❚❚' : '▶';
  P.time.textContent = main ? `${fmtTime(main.pb.time)} / ${fmtTime(main.pb.duration)}` : '';
  P.time.title = main ? `${tileName(main)} (the main video; the others follow it)` : '';
  if (state === 'on') {
    const n = groupPoints(g).length;
    P.count.textContent = n ? `◆ ${n}` : '◆';
    P.count.title = n ? `${n} sync points: where their cuts differ they are lined up again` : 'Lined up once, at one offset. Where their cuts differ, add a sync point there.';
    P.prev.disabled = P.next.disabled = !n;
  }
}
// every quarter second: the bars' times, and which followers are waiting through a part they lack
setInterval(() => quietly(() => {
  for (const g of groups) {
    if (!g.sync || g.lining) continue;
    const ms = memberModel(g);
    if (!ms.some((m) => m.points)) { for (const m of ms) markHold(m.tile, false); continue; }
    const gt = groupTimeOf(g);
    for (const m of ms) markHold(m.tile, !!m.points && Groups.holding(m, gt));
  }
  if (groups.length || syncBars.size) placeSyncBars();
}), 250);
// the selection bar goes above a sync bar it would cover
function clearSelBarOfSyncBars() {
  if (selBar.hidden) return;
  const a = selBar.getBoundingClientRect();
  for (const sb of syncBars.values()) {
    if (sb.el.hidden) continue;
    const b = sb.el.getBoundingClientRect();
    if (a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom) selBar.style.top = Math.max(8, b.top - a.height - 6) + 'px';
  }
}

// ---------- the sync editor (2026-11-18) ----------
// Lining two cuts of the same footage up by hand, frame by frame. The two videos fill the window side
// by side and are never linked while it is open: moving one never moves the other. Under each, a
// strip a few seconds wide with a tick per frame and the video's sound drawn on it: drag it to scrub
// (right is later), scroll it one frame at a time. The video last clicked is the one the keys steer.
// ⚡ Match lines the other one up by sound, then by picture (that is what has to line up; in a
// capture the sound can sit a few frames off it). ◆ Sync here keeps the moment as a sync point.
const sed = { el: document.getElementById('sync-editor'), g: null, main: null, f: null, active: 1, saved: 0, raf: 0, span: 8, wave: new Map(), busy: false, drawn: [null, null] };
const sedQ = (s) => sed.el.querySelector(s);
const sedOpen = () => !!sed.g;
const sedTile = (i) => (i === 0 ? sed.main : sed.f);
const sedFps = (t) => effectiveFps(t) || Frames.DEFAULT_FPS;
const sedOffset = () => sed.main.pb.time - sed.f.pb.time;
const sedLocal = (t) => !!(t && t.pb && t.pb.kind === 'video' && !t.pb.web && !t.url && t.path);
const sedTC = (t, time) => `${Frames.timecode(time, sedFps(t))}`;

// the two panes are built once
(function buildSyncEditorPanes() {
  const stage = sedQ('.sed-stage');
  for (let i = 0; i < 2; i++) {
    const p = document.createElement('section');
    p.className = 'sed-pane';
    p.dataset.i = String(i);
    p.innerHTML = `<div class="sed-head"><span class="sed-role"></span><b class="sed-name"></b><select class="sed-which" hidden title="Which video to line up with the main one"></select><button class="sed-tosync" hidden title="Put it where the sync puts it for the main video's frame (G)">⤓ Go to its sync</button><button class="sed-mkmain" hidden title="Make this the video the others follow">Make this the main video</button></div>
      <div class="sed-media"></div>
      <div class="sed-read"><span class="sed-tc"></span><span class="sed-fr"></span><span class="sed-delta"></span></div>
      <div class="sed-over" title="The whole video: click or drag to jump"><div class="sed-over-pts"></div><div class="sed-over-head"></div></div>
      <canvas class="sed-jog" title="Drag to scrub frame by frame (right is later) · scroll: one frame (Shift: ten) · Ctrl+scroll: show more or less"></canvas>
      <div class="sed-btns"><button data-step="-10" title="Back ten frames (Shift+←)">−10</button><button data-step="-1" title="Back one frame (←)">◀ 1</button><button class="sed-play" title="Play / pause this one (Space)">▶</button><button data-step="1" title="Forward one frame (→)">1 ▶</button><button data-step="10" title="Forward ten frames (Shift+→)">+10</button></div>`;
    stage.appendChild(p);
    p.addEventListener('pointerdown', () => sedActivate(i), true);
    // the picture belongs to a tile, whose own clicks play it or start a drag: here a click only picks it
    const media = p.querySelector('.sed-media');
    for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown', 'contextmenu']) media.addEventListener(type, (e) => { e.stopPropagation(); if (type !== 'pointerdown' && type !== 'mousedown') e.preventDefault(); }, true);
    p.addEventListener('wheel', (e) => {
      if (!sedOpen()) return;
      e.preventDefault();
      if (e.ctrlKey) { sed.span = clamp(sed.span * (e.deltaY > 0 ? 1.25 : 0.8), 2, 60); return; }
      sedStep(sedTile(i), (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }, { passive: false });
    for (const b of p.querySelectorAll('[data-step]')) b.addEventListener('click', () => sedStep(sedTile(i), Number(b.dataset.step)));
    p.querySelector('.sed-play').addEventListener('click', () => sedPlay(sedTile(i)));
    p.querySelector('.sed-mkmain').addEventListener('click', () => sedMakeMain());
    p.querySelector('.sed-tosync').addEventListener('click', () => sedToSync());
    p.querySelector('.sed-which').addEventListener('change', (e) => sedSetFollower(sed.g && [...sed.g.members].find((t) => t.id === e.target.value)));
    // the whole video
    const over = p.querySelector('.sed-over');
    over.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !sedOpen()) return;
      e.preventDefault();
      const t = sedTile(i), r = over.getBoundingClientRect();
      const go = (ev) => sedSeek(t, clamp((ev.clientX - r.left) / r.width, 0, 1) * (t.pb.duration || 0));
      t.pb.pause(); go(e);
      try { over.setPointerCapture(e.pointerId); } catch {}
      const up = () => { over.removeEventListener('pointermove', go); over.removeEventListener('pointerup', up); over.removeEventListener('lostpointercapture', up); };
      over.addEventListener('pointermove', go); over.addEventListener('pointerup', up); over.addEventListener('lostpointercapture', up);
    });
    // the frame strip: drag to scrub (right is later), a click without a drag jumps there
    const jog = p.querySelector('.sed-jog');
    jog.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !sedOpen()) return;
      e.preventDefault();
      const t = sedTile(i), x0 = e.clientX, t0 = t.pb.time, pps = jog.clientWidth / sed.span;
      let moved = false;
      t.pb.pause();
      try { jog.setPointerCapture(e.pointerId); } catch {}
      jog.classList.add('dragging');
      const move = (ev) => { if (Math.abs(ev.clientX - x0) > 2) moved = true; if (moved) sedSeek(t, t0 + (ev.clientX - x0) / pps); };
      const up = (ev) => {
        jog.removeEventListener('pointermove', move); jog.removeEventListener('pointerup', up); jog.removeEventListener('lostpointercapture', up);
        jog.classList.remove('dragging');
        if (!moved && ev && ev.type === 'pointerup') { const r = jog.getBoundingClientRect(); sedSeek(t, t0 + (ev.clientX - r.left - r.width / 2) / pps); }
      };
      jog.addEventListener('pointermove', move); jog.addEventListener('pointerup', up); jog.addEventListener('lostpointercapture', up);
    });
  }
})();
sedQ('.sed-done').addEventListener('click', () => closeSyncEditor(false));
sedQ('.sed-match').addEventListener('click', () => sedMatch());
sedQ('.sed-both').addEventListener('click', () => sedPlayBoth());
sedQ('.sed-add').addEventListener('click', () => sedSyncHere());
sedQ('.sed-prev').addEventListener('click', () => sedGoPoint(-1));
sedQ('.sed-next').addEventListener('click', () => sedGoPoint(1));
sedQ('.sed-ask-keep').addEventListener('click', async () => { sedQ('.sed-ask').hidden = true; await sedSyncHere(); closeSyncEditor(true); });
sedQ('.sed-ask-drop').addEventListener('click', () => closeSyncEditor(true));
sedQ('.sed-ask-back').addEventListener('click', () => { sedQ('.sed-ask').hidden = true; });

function openSyncEditor(g) {
  if (!g || sedOpen() || !cmp.el.hidden || !viewMayEdit()) return;
  const ms = [...g.members].filter((t) => t.pb && t.mediaEl && !t.pb.web);
  if (ms.length < 2) { setStatus('The sync editor needs two video files (or image sequences) in the group'); return; }
  if (g.lining) endLining(g, false);
  if (!g.sync && g.stash) setGroupSync(g, true); // its sync points first
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  hpReset();
  const main = ms.includes(mainOf(g)) ? mainOf(g) : ms[0];
  sed.g = g; sed.main = main; sed.f = ms.find((t) => t !== main); sed.active = 1; sed.drawn = [null, null];
  startLining(g, true);
  sedQ('.sed-ask').hidden = true;
  sedAttach();
  sed.saved = sedOffset();
  sed.el.hidden = false;
  sedMsg(g.sync ? '' : 'Put both on the same frame, then ◆ Sync here.');
  setTimeout(applyLiveBudget, 0);
  sedFill();
  cancelAnimationFrame(sed.raf);
  sed.raf = requestAnimationFrame(sedFrame);
  placeSyncBars();
  logUi('info', 'sync editor', { group: g.id, main: tileName(main), other: tileName(sed.f) });
}
function sedAttach() {
  sed.el.querySelectorAll('.sed-pane')[0].querySelector('.sed-media').appendChild(sed.main.mediaEl);
  sed.el.querySelectorAll('.sed-pane')[1].querySelector('.sed-media').appendChild(sed.f.mediaEl);
}
function sedDetach(t) { if (t && t.mediaEl && t.el && t.mediaEl.parentElement !== t.el) t.el.insertBefore(t.mediaEl, t.el.firstChild); }
// lined up differently from their sync, and not kept yet
function sedDirty() {
  if (!sedOpen()) return false;
  const half = 0.5 / Math.max(sedFps(sed.main), sedFps(sed.f));
  return Math.abs(sedOffset() - sed.saved) > half;
}
function closeSyncEditor(force) {
  if (!sedOpen()) return;
  if (!force && sedDirty()) { sedQ('.sed-ask').hidden = false; return; }
  const g = sed.g, main = sed.main;
  for (const t of [sed.main, sed.f]) { t.pb.pause(); sedDetach(t); }
  sed.el.hidden = true;
  sedQ('.sed-ask').hidden = true;
  cancelAnimationFrame(sed.raf);
  sed.g = sed.main = sed.f = null;
  endLining(g, true);
  // the others go where the sync puts them for the main video's frame
  if (g.sync && groups.includes(g)) seekGroup(g, Groups.toGroup(memberEntry(main), main.pb.time));
  layoutTiles();
  setTimeout(applyLiveBudget, 0);
  afterSyncChange(g);
}
function sedActivate(i) {
  if (sed.active === i) return;
  sed.active = i;
  for (const p of sed.el.querySelectorAll('.sed-pane')) p.classList.toggle('active', Number(p.dataset.i) === i);
}
function sedSeek(t, time) {
  const d = t.pb.duration || 0;
  t.pb.time = clamp(PicSync.onFrame(Math.max(0, time), sedFps(t)), 0, d ? Math.max(0, d - 0.5 / sedFps(t)) : Infinity);
}
function sedStep(t, n) {
  if (!t) return;
  t.pb.pause();
  const fps = sedFps(t);
  sedSeek(t, (Frames.toFrame(t.pb.time, fps) + n + 0.5) / fps);
}
function sedPlay(t) { if (t.pb.paused) t.pb.play(); else t.pb.pause(); }
// both from where they are, to check them by eye and ear (not linked: each on its own clock)
function sedPlayBoth() {
  const any = !sed.main.pb.paused || !sed.f.pb.paused;
  for (const t of [sed.main, sed.f]) { if (any) t.pb.pause(); else t.pb.play(); }
}
function sedMsg(text, ms = 0) {
  const el = sedQ('.sed-msg');
  el.textContent = text || '';
  clearTimeout(sed.msgTimer);
  if (ms) sed.msgTimer = setTimeout(() => { el.textContent = ''; }, ms);
}
// this follower's sync points, as { g, t }
const sedPoints = () => (sed.f && sed.f.sync && sed.f.sync.points) || [];
function sedFill() {
  if (!sedOpen()) return;
  const g = sed.g;
  sedQ('.sed-title').textContent = `Sync editor · ${g.name}`;
  const panes = sed.el.querySelectorAll('.sed-pane');
  [sed.main, sed.f].forEach((t, i) => {
    const p = panes[i];
    p.classList.toggle('active', sed.active === i);
    p.querySelector('.sed-role').textContent = i === 0 ? 'Main' : 'Lines up with it';
    p.querySelector('.sed-name').textContent = `${tileName(t)} · ${(+sedFps(t).toFixed(3))} fps`;
    p.querySelector('.sed-mkmain').hidden = i === 0 || memberModel(g).length !== 2;
    p.querySelector('.sed-tosync').hidden = i === 0 || !g.sync;
    const which = p.querySelector('.sed-which');
    const others = [...g.members].filter((x) => x !== sed.main && x.pb && x.mediaEl && !x.pb.web);
    which.hidden = i === 0 || others.length < 2;
    if (!which.hidden) {
      which.textContent = '';
      for (const o of others) { const op = document.createElement('option'); op.value = o.id; op.textContent = tileName(o); op.selected = o === sed.f; which.appendChild(op); }
    }
    // sync points along the whole video
    const op = p.querySelector('.sed-over-pts'); op.textContent = '';
    const d = t.pb.duration || 0;
    if (d) for (const pt of sedPoints()) {
      const tt = i === 0 ? Groups.at(memberEntry(sed.main), pt.g) : pt.t;
      const m = document.createElement('i'); m.style.left = (tt / d * 100) + '%'; op.appendChild(m);
    }
  });
  // the sync points of the one being lined up
  const box = sedQ('.sed-pts'); box.textContent = '';
  const pts = sedPoints();
  if (!pts.length) {
    const s = document.createElement('span'); s.className = 'sed-none';
    s.textContent = g.sync ? 'No sync points yet (they are at one offset, never lined up here: the first ◆ Sync here replaces it)' : 'No sync points yet';
    box.appendChild(s);
  }
  pts.forEach((pt, k) => {
    const chip = document.createElement('span'); chip.className = 'sed-chip';
    const go = document.createElement('button'); go.className = 'sed-chip-go';
    go.textContent = `◆ ${k + 1}  ${sedTC(sed.main, Groups.at(memberEntry(sed.main), pt.g))}`;
    go.title = `${tileName(sed.main)} ${sedTC(sed.main, Groups.at(memberEntry(sed.main), pt.g))} = ${tileName(sed.f)} ${sedTC(sed.f, pt.t)} · click: go there`;
    go.addEventListener('click', () => sedGoTo(pt));
    const x = document.createElement('button'); x.className = 'sed-chip-x'; x.textContent = '✕'; x.title = 'Remove this sync point';
    x.addEventListener('click', () => { removeSyncPoint(g, pt.g); sedFill(); });
    chip.append(go, x); box.appendChild(chip);
  });
  sedQ('.sed-prev').disabled = sedQ('.sed-next').disabled = !pts.length;
  sedQ('.sed-match').disabled = sed.busy || !sedLocal(sed.main) || !sedLocal(sed.f);
  sedQ('.sed-match').title = sedLocal(sed.main) && sedLocal(sed.f) ? `Line ${tileName(sed.f)} up with ${tileName(sed.main)} where it is: by sound to get close, then by picture to land on the frame (M)` : 'Matching needs two video files on this PC';
}
// where the sync puts the other one for the main video's frame (null while not synced)
function sedExpected() {
  if (!sedOpen() || !sed.g.sync || !sed.f.sync) return null;
  return Groups.at(memberEntry(sed.f), Groups.toGroup(memberEntry(sed.main), sed.main.pb.time));
}
function sedToSync() {
  const e = sedExpected();
  if (e === null) return;
  sed.f.pb.pause();
  sedSeek(sed.f, e);
  sed.saved = sedOffset();
}
function sedGoTo(pt) {
  sed.main.pb.pause(); sed.f.pb.pause();
  sedSeek(sed.main, Groups.at(memberEntry(sed.main), pt.g));
  sedSeek(sed.f, pt.t);
  sed.saved = sedOffset();
}
function sedGoPoint(dir) {
  const pts = sedPoints();
  if (!pts.length) return;
  const gt = Groups.toGroup(memberEntry(sed.main), sed.main.pb.time);
  const p = dir < 0 ? [...pts].reverse().find((x) => x.g < gt - 0.05) : pts.find((x) => x.g > gt + 0.05);
  if (p) sedGoTo(p); else sedMsg(dir < 0 ? 'No sync point before this' : 'No sync point after this', 2500);
}
async function sedSyncHere() {
  if (!sedOpen() || sed.busy) return;
  sed.busy = true; sedQ('.sed-add').disabled = true;
  sedMsg('Keeping it…');
  try {
    const msg = await commitLineUp(sed.g, [sed.f]);
    sed.saved = sedOffset();
    sedMsg(msg || 'Kept', 12000);
  } finally { sed.busy = false; sedQ('.sed-add').disabled = false; sedFill(); }
}
function sedMakeMain() {
  if (!sedOpen() || memberModel(sed.g).length !== 2) return;
  swapMain(sed.g);
  [sed.main, sed.f] = [sed.f, sed.main];
  sedAttach();
  sed.active = 1 - sed.active;
  sed.saved = sedOffset();
  sedFill();
}
function sedSetFollower(t) {
  if (!t || t === sed.f || t === sed.main) return;
  sed.f.pb.pause(); sedDetach(sed.f);
  sed.f = t; sedAttach();
  sed.saved = sedOffset();
  setTimeout(applyLiveBudget, 0);
  sedFill();
}
async function sedMatch() {
  if (!sedOpen() || sed.busy || !sedLocal(sed.main) || !sedLocal(sed.f)) return;
  sed.busy = true; sedFill();
  sed.main.pb.pause(); sed.f.pb.pause();
  sedMsg('Listening and looking…');
  try {
    const before = sed.f.pb.time;
    // far from where its sync puts it (the main one was moved a long way): look from there
    const e = sedExpected();
    const r = await matchFollower(sed.main, sed.f, e !== null && Math.abs(e - sed.f.pb.time) > 20 ? e : null);
    if (!sedOpen()) return;
    if (r.time === null) { sedMsg(`Could not match them here: ${r.why}. Line it up by eye.`, 12000); return; }
    sedSeek(sed.f, r.time);
    const frames = Math.round((sed.f.pb.time - before) * sedFps(sed.f));
    sedMsg(`${tileName(sed.f)} moved ${frames >= 0 ? '+' : '−'}${Math.abs(frames)} frame${Math.abs(frames) === 1 ? '' : 's'} (lined up by ${r.how}). Check it, nudge it if you need to, then ◆ Sync here.`, 20000);
  } finally { sed.busy = false; sedFill(); }
}
// (first, before every other key handler: nothing else on the board reacts while it is open)
window.addEventListener('keydown', (e) => { if (sedOpen()) { sedKey(e); e.stopImmediatePropagation(); } }, true);
function sedKey(e) {
  const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (e.target instanceof HTMLSelectElement) return;
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); if (!sedQ('.sed-ask').hidden) sedQ('.sed-ask').hidden = true; else closeSyncEditor(false); return; }
  if (ctrl && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); sedFill(); return; }
  if (ctrl && key === 'y') { e.preventDefault(); redo(); sedFill(); return; }
  if (ctrl) return;
  const t = sedTile(sed.active);
  if (e.key === 'ArrowLeft' || e.key === ',') { e.preventDefault(); sedStep(t, e.shiftKey ? -10 : -1); return; }
  if (e.key === 'ArrowRight' || e.key === '.') { e.preventDefault(); sedStep(t, e.shiftKey ? 10 : 1); return; }
  if (e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); sedActivate(1 - sed.active); return; }
  if (e.code === 'Space') { e.preventDefault(); if (e.shiftKey) sedPlayBoth(); else sedPlay(t); return; }
  if (key === 'k') { e.preventDefault(); t.pb.pause(); return; }
  if (key === 'l') { e.preventDefault(); t.pb.play(); return; }
  if (key === 'j') { e.preventDefault(); t.pb.pause(); sedSeek(t, t.pb.time - 1); return; }
  if (key === 'm') { e.preventDefault(); sedMatch(); return; }
  if (key === 'p') { e.preventDefault(); sedPlayBoth(); return; }
  if (key === 'g') { e.preventDefault(); sedToSync(); return; }
  if (e.key === 'Enter') { e.preventDefault(); sedSyncHere(); return; }
}

// every frame while it is open: the readouts, and each strip when its video moved
function sedFrame() {
  if (!sedOpen()) return;
  sed.raf = requestAnimationFrame(sedFrame);
  const panes = sed.el.querySelectorAll('.sed-pane');
  const expected = sed.g.sync && sed.f.sync ? Groups.at(memberEntry(sed.f), Groups.toGroup(memberEntry(sed.main), sed.main.pb.time)) : null;
  [sed.main, sed.f].forEach((t, i) => {
    const p = panes[i], fps = sedFps(t), time = t.pb.time;
    p.querySelector('.sed-tc').textContent = sedTC(t, time);
    p.querySelector('.sed-fr').textContent = `frame ${Frames.toFrame(time, fps)}`;
    p.querySelector('.sed-play').textContent = t.pb.paused ? '▶' : '❚❚';
    const d = t.pb.duration || 0;
    p.querySelector('.sed-over-head').style.left = d ? (time / d * 100) + '%' : '0';
    const del = p.querySelector('.sed-delta');
    if (i === 1) {
      if (expected === null) { del.textContent = 'not synced yet'; del.className = 'sed-delta'; }
      else {
        const n = Math.round((time - expected) * fps);
        del.textContent = n === 0 ? 'on its sync' : `${n > 0 ? '+' : '−'}${Math.abs(n)} frame${Math.abs(n) === 1 ? '' : 's'} from its sync`;
        del.className = 'sed-delta ' + (n === 0 ? 'ok' : 'off');
      }
    } else del.textContent = '';
    const cv = p.querySelector('.sed-jog');
    const key = `${time.toFixed(4)}|${cv.clientWidth}|${cv.clientHeight}|${sed.span}|${sedWaveKey(t)}|${sedPoints().length}`;
    if (sed.drawn[i] !== key) { sed.drawn[i] = key; sedDrawJog(t, cv, i); }
    sedWantWave(t);
  });
  sedQ('.sed-both').textContent = !sed.main.pb.paused || !sed.f.pb.paused ? '❚❚ Pause both' : '▶ Play both';
  sedQ('.sed-add').classList.toggle('pulse', sedDirty());
}
// its sound around where it is, for the strip (fetched in 20 s pieces, peaks every 10 ms)
function sedWaveKey(t) { const w = sed.wave.get(t); return w ? w.start + ':' + (w.peaks ? w.peaks.length : 'x') : ''; }
function sedWantWave(t) {
  if (!sedLocal(t)) return;
  const w = sed.wave.get(t), now = t.pb.time, half = sed.span / 2 + 1;
  if (w && (w.loading || (now - half >= w.start && now + half <= w.start + w.dur))) return;
  if (w && w.failed && performance.now() - w.failed < 5000) return;
  const start = Math.max(0, now - Math.max(10, half + 4)), dur = Math.max(20, 2 * half + 8);
  const entry = { start, dur, loading: true, peaks: w && w.peaks && !w.failed ? w.peaks : null, pStart: w ? w.pStart : 0 };
  sed.wave.set(t, entry);
  window.api.audioPcm(t.path, start, dur).then((u) => {
    if (sed.wave.get(t) !== entry) return;
    if (!u) { entry.loading = false; entry.failed = performance.now(); return; }
    const pcm = new Int16Array(u.buffer.slice(u.byteOffset, u.byteOffset + (u.byteLength & ~1)));
    const per = AudioSync.RATE / 100, n = Math.floor(pcm.length / per), peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let k = i * per, e = k + per; k < e; k++) { const v = Math.abs(pcm[k]); if (v > m) m = v; } peaks[i] = m / 32768; }
    Object.assign(entry, { loading: false, peaks, pStart: start });
  }).catch(() => { entry.loading = false; entry.failed = performance.now(); });
}
function sedDrawJog(t, cv, i) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#15151a'; c.fillRect(0, 0, w, h);
  const fps = sedFps(t), now = t.pb.time, span = sed.span, pps = w / span, x0 = now - span / 2;
  const X = (time) => (time - x0) * pps;
  // the sound
  const wv = sed.wave.get(t);
  if (wv && wv.peaks) {
    c.fillStyle = '#34507e';
    const mid = h * 0.55, amp = h * 0.42;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x0 + x / pps - wv.pStart) * 100), b = Math.max(a + 1, Math.floor((x0 + (x + 1) / pps - wv.pStart) * 100));
      let m = 0;
      for (let k = Math.max(0, a); k < Math.min(wv.peaks.length, b); k++) if (wv.peaks[k] > m) m = wv.peaks[k];
      if (m > 0) { const y = Math.max(1, Math.sqrt(m) * amp); c.fillRect(x, mid - y, 1, 2 * y); }
    }
  }
  // the frame it is on
  const f0 = Frames.toFrame(now, fps);
  c.fillStyle = 'rgba(79,140,255,0.28)';
  c.fillRect(X(f0 / fps), 0, Math.max(1, pps / fps), h);
  // a tick per frame (when they are far enough apart), a tall one and a label every second
  const step = pps / fps >= 3 ? 1 : pps / fps >= 0.6 ? 5 : Math.round(fps);
  c.fillStyle = '#5a5a66';
  for (let f = Math.floor(x0 * fps / step) * step; f / fps < x0 + span; f += step) { if (f >= 0) c.fillRect(Math.round(X(f / fps)), 0, 1, 6); }
  c.fillStyle = '#9a9aa6'; c.font = '10px system-ui, sans-serif';
  const every = span > 24 ? 5 : 1;
  for (let s = Math.max(0, Math.ceil(x0 / every) * every); s < x0 + span; s += every) {
    const x = Math.round(X(s)); c.fillRect(x, 0, 1, 14); c.fillText(fmtTime(s), x + 3, 12);
  }
  // sync points
  c.fillStyle = '#ffd166';
  for (const pt of sedPoints()) {
    const tt = i === 0 ? Groups.at(memberEntry(sed.main), pt.g) : pt.t;
    const x = X(tt);
    if (x < -6 || x > w + 6) continue;
    c.beginPath(); c.moveTo(x, h - 12); c.lineTo(x + 5, h - 6); c.lineTo(x, h); c.lineTo(x - 5, h - 6); c.closePath(); c.fill();
  }
  // where it is
  c.fillStyle = '#ffffff'; c.fillRect(Math.round(w / 2), 0, 1.5, h);
}

// ---- lining up by sound, then by picture ----
// Where the other video is when the main one is where it is now. { time, how } or { time: null, why }.
async function matchFollower(main, f, guess = null) {
  const mainT = main.pb.time, fromT = guess !== null ? guess : f.pb.time;
  const pcm = (u) => new Int16Array(u.buffer.slice(u.byteOffset, u.byteOffset + (u.byteLength & ~1)));
  // 1. by sound, to get close (16 s within 40 s either way; then 32 s; then two minutes either way)
  let sound = null;
  for (const { half, search } of AudioSync.TRIES) {
    const w = AudioSync.windows(mainT, main.pb.duration, fromT, f.pb.duration, search, half);
    const [a, b] = await Promise.all([window.api.audioPcm(main.path, w.main.start, w.main.dur), window.api.audioPcm(f.path, w.other.start, w.other.dur)]);
    if (!a || !b) break;
    const r = AudioSync.match(pcm(a), w.main.start, pcm(b), w.other.start, mainT);
    if (r.time !== null) { sound = r; break; }
  }
  const est = sound ? sound.time : fromT;
  // 2. by picture, to land on the frame: 12 s of the main video against the other around there
  const aS = Math.max(0, mainT - 6), aD = 12, reach = sound ? 7 : 15;
  const bS = Math.max(0, est - (mainT - aS) - reach), bD = aD + 2 * reach;
  const [sa, sb] = await Promise.all([window.api.frameActivity(main.path, aS, aD), window.api.frameActivity(f.path, bS, bD)]);
  const pic = sa.length > 20 && sb.length > 20 ? PicSync.match({ start: aS, dur: aD, sig: sa }, { start: bS, dur: bD, sig: sb }) : null;
  let offset = null, how = '';
  if (pic && pic.score >= 0.25 && pic.score - pic.second >= 0.05 && (!sound || Math.abs(pic.offset - (mainT - sound.time)) < 1)) { offset = pic.offset; how = 'picture'; }
  else if (sound) { offset = mainT - sound.time; how = 'sound only, check it by eye'; }
  logUi('info', 'match', { main: tileName(main), other: tileName(f), at: mainT, sound: sound && { time: sound.time, score: sound.score }, picture: pic, offset, how });
  if (offset === null) return { time: null, why: sound ? 'their pictures do not match here' : 'neither their sound nor their pictures match here' };
  // 3. a shot change in both at that offset says it exactly
  const [ca, cb] = await Promise.all([window.api.sceneCuts(main.path, aS, Math.min(5, aD)), window.api.sceneCuts(f.path, Math.max(0, aS - offset - 0.5), Math.min(5, aD) + 1)]).catch(() => [[], []]);
  const more = mainT - aS > 5 ? await Promise.all([window.api.sceneCuts(main.path, aS + 5, 5), window.api.sceneCuts(f.path, Math.max(0, aS + 5 - offset - 0.5), 6)]).catch(() => [[], []]) : [[], []];
  const cut = PicSync.fromCuts([...ca, ...more[0]], [...cb, ...more[1]], offset, how === 'picture' ? 0.12 : 0.3);
  if (cut) { offset = cut.offset; how = 'a shot change in both'; }
  return { time: mainT - offset, how };
}

// ◆ Sync here: this frame of the main video is this frame of each one in `followers`. A sync point made
// here is kept; an offset never lined up here (an old Sync press) is replaced by the first one.
// Returns what it did, in words.
async function commitLineUp(g, followers) {
  const main = mainOf(g);
  if (!main) return '';
  const before = syncState(g);
  const ms = memberModel(g), list = ms.filter((m) => m.tile !== main && (!followers || followers.includes(m.tile)));
  let note = '';
  const changed = [];
  if (!g.sync) {
    main.sync = { start: 0, points: null };
    for (const m of ms) if (m.tile !== main) m.tile.sync = list.includes(m) ? { start: main.pb.time - m.tile.pb.time, points: [{ g: main.pb.time, t: m.tile.pb.time }] } : { start: main.pb.time - m.tile.pb.time, points: null };
    g.sync = true; g.stash = null;
    note = 'Synced at this frame. Where their cuts differ later, line them up there and ◆ Sync here again.';
  } else {
    const mm = ms.find((m) => m.tile === main);
    if (mm.points) main.sync = { start: Groups.extent(mm).from, points: null }; // (the main video never follows)
    const gt = Groups.toGroup(memberEntry(main), main.pb.time);
    let added = 0, redone = 0;
    for (const m of list) {
      const ft = m.tile.pb.time;
      if (!m.points) { m.tile.sync = { start: gt - ft, points: [{ g: gt, t: ft }] }; redone++; continue; }
      const near = m.points.some((p) => Math.abs(p.g - gt) <= SYNC_NEAR);
      m.tile.sync = followerSync(Groups.addPoint(m.points, gt, ft, SYNC_NEAR), m.start);
      if (near) redone++; else added++;
      if (m.tile.sync.points && m.tile.sync.points.length > 1) changed.push(m.tile);
    }
    note = added ? 'Sync point added' : redone ? 'Lined up again here' : '';
    g.newAt = gt;
  }
  g.main = main;
  let cuts = [];
  if (changed.length) {
    sedMsg('Listening for where their cuts part…');
    try { cuts = await findCuts(g, main, changed, g.newAt); } catch (err) { logUi('warn', 'finding cuts failed', { error: String(err && err.message || err) }); }
  }
  normalizeGroup(g);
  pushSyncUndo(g, 'sync point', before);
  afterSyncChange(g);
  const n = Math.max(...memberModel(g).map((m) => (m.points ? m.points.length : 0)));
  return `${note}${cuts.length ? ' · ' + cuts.join(' · ') : ''}${n ? ` · ${n} sync point${n === 1 ? '' : 's'}` : ''}`;
}

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
  else for (const m of model.members) m.tile.pb.time = Groups.at(m, gt);
}
// True while the bottom timeline is being dragged: the drift engine leaves every group alone until
// the drag ends, the same as it does for a tile's own bar (tile.scrubbing).
let timelineScrubbing = false;
// A preview seek on every member, never the group machinery (no broadcast, no drift work) - the
// real seek happens once on release.
function tlScrub(model, gt) {
  for (const m of model.members) pbScrub(m.tile.pb, Groups.at(m, gt));
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
    model.members.map((m) => { const e = Groups.extent(m); return { start: e.from, end: e.to }; }).forEach((lane, i) => {
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
        mk.style.left = Timeline.xFor(Groups.toGroup(m, b.t), end, width) + 'px'; mk.title = `${b.label || ''} ${fmtTime(b.t)}`.trim();
        mk.addEventListener('click', (e) => { e.stopPropagation(); tlSeek(model, Groups.toGroup(m, b.t)); });
        row.appendChild(mk);
      }
      if (m.points && model.group) laneSyncPoints(row, model, m, end, width);
      lanesEl.appendChild(row);
    });
  }
  // markers on the bar (always drawn; in expanded mode they double as an overview)
  const mkEl = tlQ('.tl-markers'); mkEl.textContent = '';
  for (const m of model.members) for (const b of m.tile.bookmarks) {
    // several videos: colour by video so you can tell whose marker it is; one video: the bookmark's own colour
    const mk = document.createElement('div'); mk.className = 'tl-mk'; mk.style.background = multi ? tileColor(m.tile) : MARKER_COLORS[b.color];
    mk.style.left = Timeline.xFor(Groups.toGroup(m, b.t), end, width) + 'px';
    mk.title = `${tileName(m.tile)}: ${b.label || fmtTime(b.t)}  (right-click to delete, Shift-right-click to recolour)`;
    mk.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a bar scrub
    mk.addEventListener('click', (e) => { e.stopPropagation(); tlSeek(model, Groups.toGroup(m, b.t)); });
    mk.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) b.color = nextMarkerColor(b.color);
      else m.tile.bookmarks.splice(m.tile.bookmarks.indexOf(b), 1);
      m.tile.refreshBookmarks();
    });
    mkEl.appendChild(mk);
  }
  // a synced group's sync points (2026-11-18)
  if (model.group && model.group.sync) for (const p of groupPoints(model.group)) {
    const d = document.createElement('div'); d.className = 'tl-sp';
    d.style.left = Timeline.xFor(p.g, end, width) + 'px';
    d.title = 'Sync point · click: go there';
    d.addEventListener('pointerdown', (e) => e.stopPropagation());
    d.addEventListener('click', (e) => { e.stopPropagation(); tlSeek(model, p.g); });
    mkEl.appendChild(d);
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
  const gtAt = (ev) => Timeline.tFor(ev.clientX - r.left, tl._end, r.width);
  const seek = (ev) => tlSeek(tl._model, gtAt(ev));
  seek(e); // the click itself is a real seek
  // A drag only previews, at most every 150 ms: a YouTube embed re-buffers on every real seek and
  // would spin for as long as the drag lasts.
  const sc = Scrub.create();
  let lastGt = gtAt(e);
  timelineScrubbing = true;
  const onMove = (ev) => {
    lastGt = gtAt(ev);
    const t = sc.move(lastGt, performance.now());
    if (t !== null) tlScrub(tl._model, t);
  };
  const onUp = () => {
    timelineScrubbing = false;
    tlSeek(tl._model, sc.end(lastGt)); // where the drag actually ended, committed once
    bar.removeEventListener('pointermove', onMove); bar.removeEventListener('pointerup', onUp); bar.removeEventListener('pointercancel', onUp);
  };
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
  hpReset(); // the compare view owns playback while it is open
  cmp.a = a; cmp.b = b; cmp.mode = 'wipe'; cmp.wipe = 50;
  setTimeout(applyLiveBudget, 0); // what the compare view shows must be live (stills come back)
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
// A/B pairs two local videos today, but the same rule applies if either side is ever a web tile:
// preview while dragging, commit once on release.
const cmpScrubber = Scrub.create();
let cmpScrubT = 0;
cmpSeek.addEventListener('pointerdown', () => { cmp.scrubbing = true; });
const endCmpScrub = () => {
  if (!cmp.scrubbing) return;
  cmp.scrubbing = false;
  if (cmp.a && cmp.a.pb) { cmp.a.pb.time = cmpScrubber.end(cmpScrubT); broadcast(cmp.a, 'seek'); }
};
cmpSeek.addEventListener('pointerup', endCmpScrub);
cmpSeek.addEventListener('pointercancel', endCmpScrub);
cmpSeek.addEventListener('input', () => {
  const p = cmp.a.pb; if (!p.duration) return;
  const t = Number(cmpSeek.value) / 10000 * p.duration;
  if (cmp.scrubbing) {
    cmpScrubT = t;
    const v = cmpScrubber.move(t, performance.now());
    if (v !== null) pbScrub(p, v);
    return;
  }
  p.time = t;
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
  scheduleOffscreen();
}
/* DISABLED (Mark, 2026-09-12): undo of the one shared gallery height; per-tile and scale-all below
function recordRowHeight() { return { kind: 'rowHeight', label: 'resize gallery', before: layout.rowHeight, after: null }; }
function finishRowHeight(entry) { entry.after = layout.rowHeight; if (entry.after !== entry.before) undoStack.push(entry); }
*/
// one gallery tile's corner drag
function recordGResize(tile) { return { kind: 'gresize', label: `resize ${tileName(tile)}`, tile, before: galleryHOf(tile), after: null }; }
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
    kind: 'remove', label: `remove ${tileName(tile)}`, record: collectSession().videos[tiles.indexOf(tile)],
    index: tiles.indexOf(tile), tile, group: g,
    groupMembers: g ? [...g.members] : [], starts: g ? new Map([...g.members].map((t) => [t, t.sync ? { ...t.sync } : null])) : null,
  });
}

// Adds you make with a keystroke are undoable: a new text tile, and a whole paste as one step.
// 'before' takes them away again, 'after' rebuilds them from the same records a remove stores.
function recordAdd(list, label) {
  const all = collectSession().videos;
  const items = list.filter((t) => tiles.includes(t)).map((t) => {
    const index = tiles.indexOf(t);
    return { record: all[index], index, tile: t, group: null, groupMembers: [], starts: null };
  });
  if (!items.length) return;
  undoStack.push({ kind: 'add', label: label || `add ${tileName(items[0].tile)}`, items });
}
// one entry per editing session / per toolbar interaction
function recordTextEdit(tile, before, after) {
  if (before === after) return;
  undoStack.push({ kind: 'text', label: 'edit text', tile, before, after });
}
function recordTextStyle(list, befores) {
  const changes = list.map((t, i) => ({ tile: t, before: befores[i], after: { ...t.style } })).filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
  if (changes.length) undoStack.push({ kind: 'tstyle', label: 'text style', changes });
}

function applyRects(entry, dir) { // dir: 'before' | 'after'
  for (const r of entry.rects) if (tiles.includes(r.tile) && r[dir]) { r.tile.board = { ...r[dir] }; layoutTile(r.tile); }
}
function restoreRemoved(entry) {
  const v = entry.record;
  const t = buildFromRecord(v);
  if (!t) return; // e.g. a text record whose board was unusable: nothing to put back
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
      t.sync = v.sync ? { start: Session.syncStart(v), points: Groups.cleanPoints(Session.syncPoints(v)) } : null;
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
  if (entry.kind === 'move' || entry.kind === 'resize') {
    // a scaled block: its text size first, so its height comes back with the rect
    if (entry.styles) for (const c of entry.styles) if (tiles.includes(c.tile)) { c.tile.style = { ...c[dir] }; rerenderBlock(c.tile); }
    applyRects(entry, dir);
    if (entry.styles) for (const c of entry.styles) if (tiles.includes(c.tile)) rerenderBlock(c.tile);
  }
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
  // an add is a remove read backwards; a paste is one add of several tiles
  else if (entry.kind === 'add') {
    if (dir === 'before') for (const it of entry.items) { if (tiles.includes(it.tile)) removeTile(it.tile, { record: false }); }
    else for (const it of [...entry.items].sort((a, b) => a.index - b.index)) restoreRemoved(it);
  }
  else if (entry.kind === 'crop') {
    const t = entry.tile, st = entry[dir];
    if (tiles.includes(t)) { t.crop = st.crop ? { ...st.crop } : null; t.board = { ...st.board }; t.aspect = st.aspect; applyCrop(t); layoutTile(t); }
  }
  else if (entry.kind === 'text') {
    if (tiles.includes(entry.tile)) { entry.tile.text = entry[dir]; renderTextTile(entry.tile); updateTextToolbar(); }
  }
  else if (entry.kind === 'frame-title') { if (tiles.includes(entry.tile)) setFrame(entry.tile, { title: entry[dir] }); }
  else if (entry.kind === 'todo') { if (tiles.includes(entry.tile)) { if (todoEdit && todoEdit.tile === entry.tile) todoEdit = null; setTodo(entry.tile, entry[dir]); } } // a to-do list (2026-11-17)
  else if (entry.kind === 'sync') applySyncState(entry.group, entry[dir]); // sync points, lining up (2026-11-18)
  else if (entry.kind === 'links') { if (tiles.includes(entry.tile)) { if (linkEdit && linkEdit.tile === entry.tile) finishLinkEdit(false); if (entry.boards) { entry.tile.board = { ...entry.boards[dir] }; layoutTile(entry.tile); } setLinks(entry.tile, entry[dir]); } } // a bookmark block (2026-11-16)
  else if (entry.kind === 'lock') { // locked or unlocked (2026-11-10)
    for (const c of entry.changes) if (tiles.includes(c.tile)) setLocked(c.tile, c[dir]);
  }
  else if (entry.kind === 'state') { // a line's ends or look, a tidy, a trim (2026-11-10)
    for (const c of entry.changes) if (tiles.includes(c.tile)) setShapeState(c.tile, c[dir]);
    updateLineToolbar(); scheduleOffscreen();
  }
  else if (entry.kind === 'tstyle') {
    for (const c of entry.changes) if (tiles.includes(c.tile)) { c.tile.style = { ...c[dir] }; renderTextTile(c.tile); }
    updateTextToolbar();
  }
}
function undo() { if (IS_VIEW) return; const e = undoStack.undo(); if (!e) { setStatus('Nothing to undo'); return; } applyEntry(e, 'before'); logUi('info', 'undo', { what: e.label }); setStatus('Undo: ' + e.label); }
function redo() { if (IS_VIEW) return; const e = undoStack.redo(); if (!e) { setStatus('Nothing to redo'); return; } applyEntry(e, 'after'); logUi('info', 'redo', { what: e.label }); setStatus('Redo: ' + e.label); }

function setLinked(on) {
  board.linked = !!on;
  document.getElementById('btn-link').classList.toggle('toggled', board.linked);
}
// Push neighbours on or off, from the user (the board's right-click menu, the toolbar button,
// Shift+L): kept in settings, so every board works the same way (2026-11-19; off as standard)
function setPushNeighbours(on) {
  setLinked(on);
  if (settings) { settings.pushNeighbours = !!on; saveSettings(); }
  setStatus(on ? 'Push neighbours: what you move or resize pushes its neighbours out of the way'
    : `Push neighbours off: what you move stops against what it meets, and nothing else moves (hold ${IS_MAC ? 'Option' : 'Alt'} while dragging to let it overlap)`, 5000);
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

// what stops a move when nothing is pushed (lib/collide.js): not lines (they cross things on
// purpose) and not frames (they hold things); locked tiles are the background and stop nothing
function blocksMoves(t) { return !!t.board && t.type !== 'line' && !t.frame; }
function stopObstacles(moving) { return tiles.filter((t) => blocksMoves(t) && !t.locked && !moving.has(t)).map((t) => t.board); }

function resolveOverlaps(fixed) {
  const list = tiles.filter((t) => t.board && t.type !== 'line' && !t.locked && !t.frame); // (lines cross things on purpose; locked tiles never move; a frame holds things)
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
  const L = rect.x, R = rect.x + rect.w, T = rect.y, Bm = rect.y + rect.h;
  // the nearest edge within reach among some tiles, each way
  const scan = (list) => {
    let bestX = null, bestY = null;
    for (const o of list) {
      // const b = o.board; // DISABLED (Mark, 2026-11-10): a line snaps by its stroke (a picture stops at it)
      const b = snapBoxOf(o);
      if (!b) continue;
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
    return { bestX, bestY };
  };
  const others = tiles.filter((t) => t.board && !exclude.has(t));
  // lines are guides: one within reach wins over any tile's edge (2026-11-10: a caption under a
  // picture used to win, and the picture never stopped at the divider)
  const byLines = scan(others.filter((t) => t.type === 'line'));
  const byTiles = scan(others.filter((t) => t.type !== 'line'));
  const bestX = byLines.bestX || byTiles.bestX, bestY = byLines.bestY || byTiles.bestY;
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
      t.board = t.freeAspect
        ? { x: at.x + 24 * i, y: at.y + 24 * i, w: TEXT_DEFAULT_W, h: 40 } // width is the user's; height follows the text
        : { x: at.x + 24 * i, y: at.y + 24 * i, w: h * t.aspect, h };
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
    const h = t.freeAspect ? 40 : galleryHOf(t);
    const w = t.freeAspect ? TEXT_DEFAULT_W : h * t.aspect;
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
  resetBoardInteraction(); // Mark's own workaround for a stuck board; keep it working
  if (!isBoard() || mode !== 'board') { clearSelection(); hideGuides(); }
  document.body.classList.toggle('mode-board', isBoard());
  for (const b of modeEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === mode);
  for (const t of tiles) if (t.type === 'text' || t.type === 'line') t.el.hidden = !isBoard(); // text and lines are board-only
  layoutTiles();
  // now they are visible again, let the text say how tall each box really is
  if (isBoard()) for (const t of tiles) if (t.type === 'text') renderTextTile(t);
  updateTextToolbar();
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
  const items = tiles.filter((t) => !t.freeAspect).map((t) => ({ aspect: t.aspect, h: galleryHOf(t) }));
  if (!items.length) return;
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
  if (IS_VIEW) return; // a view never edits the layout
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch {}

  const startX = e.clientX, startY = e.clientY;
  const sx = corner.includes('l') ? -1 : 1;
  const sy = corner.includes('t') ? -1 : 1;
  const onBoard = isBoard();
  /* DISABLED (2026-10-07): only a sticky group scaled together; a lassoed selection resized one tile
  const groupScale = onBoard && !modKey(e) && !tile.freeAspect && tile.group && tile.group.sticky
    ? [...tile.group.members].filter((m) => m.board) : null;
  */
  // Pulling a corner scales everything that is selected with this tile, and the whole of any
  // sticky group involved, as one object about their bounding box (Ctrl: just this tile, mirroring
  // Ctrl-drag). A sticky group scales whole even with nothing selected. Unlike a move, selected
  // members of a non-sticky group come too. Text members scale their box and re-wrap; a text
  // tile's own handle only ever sets its width. Rule in lib/select.js.
  if (tile.locked) return; // (its handles are hidden too)
  const groupScale = onBoard && !tile.freeAspect ? Select.dragSet(tile, [...selection], modKey(e), Select.RESIZE).filter((t) => !t.locked) : null;
  const members = groupScale && groupScale.length > 1 ? groupScale : null;
  const groupBB = members ? boardBounds(members) : null;
  const memberStart = members ? new Map(members.map((m) => [m, { ...m.board }])) : null;
  // the corner of the group's box that stays put: the one opposite the handle
  const groupOrigin = members ? { x: corner.includes('l') ? groupBB.minX + groupBB.w : groupBB.minX, y: corner.includes('t') ? groupBB.minY + groupBB.h : groupBB.minY } : undefined;
  const start = onBoard ? { ...tile.board } : { w: tile.el.offsetWidth, h: tile.el.offsetHeight };
  // DISABLED (Mark, 2026-11-10): resizing no longer raises the tile; it keeps its layer
  // if (onBoard) { bringToFront(tile); rememberStart(); }
  if (onBoard) rememberStart();
  // Linked mode can push neighbours, so remember every board rect
  const undoEntry = onBoard ? recordResize(tiles.filter((t) => t.board)) : recordGResize(tile);
  const fixed = new Set(members || [tile]);
  // Push neighbours off (the standard): growing into something stops where it touches (2026-11-19)
  const fixedList = [...fixed], blockIdx = fixedList.map((t, i) => (blocksMoves(t) ? i : -1)).filter((i) => i >= 0);
  const stopObst = onBoard && !tile.frame ? stopObstacles(fixed) : [];
  const stopBefore = onBoard ? blockIdx.map((i) => ({ ...fixedList[i].board })) : [];
  const stops = (ev) => onBoard && !board.linked && !ev.altKey && stopObst.length > 0 && blockIdx.length > 0;
  const nowRects = () => blockIdx.map((i) => fixedList[i].board);
  let lastK = 1, lastRect = onBoard ? { ...tile.board } : null; // the last scale / box that touched nothing new
  // a bookmark block or to-do list scales as a whole from a corner: its text, padding and corners
  // with it (Shift: the width only, as before) (2026-11-17)
  const startStyle = tile.style ? { ...tile.style } : null;
  let blockScaled = false;
  tile.el.classList.add('resizing');
  if (members) for (const m of members) m.el.classList.add('resizing');
  document.body.classList.add('resizing');
  document.body.style.cursor = getComputedStyle(handle).cursor;

  const onMove = (ev) => {
    const scale = onBoard ? board.zoom : 1;
    const dx = (ev.clientX - startX) * sx / scale;
    const dy = (ev.clientY - startY) * sy / scale;
    // A text tile has no aspect: the corner sets its width only, anchored on the opposite edge,
    // and the height comes back from the wrapped text.
    if (tile.freeAspect) {
      if (!onBoard) return;
      const b = tile.board;
      if (isScalableBlock(tile) && !ev.shiftKey && corner.length === 2) {
        // the scale whose corner lands nearest the pointer: the pull projected on the box's diagonal
        const k = ((start.w + dx) * start.w + (start.h + dy) * start.h) / (start.w * start.w + start.h * start.h);
        const kk = scaleBlockTo(tile, startStyle, start, k, corner);
        blockScaled = true;
        if (stops(ev)) { if (Collide.blocked(nowRects(), stopBefore, stopObst)) scaleBlockTo(tile, startStyle, start, lastK, corner); else lastK = kk; }
        if (board.linked && !ev.altKey) resolveOverlaps(fixed);
        return;
      }
      if (isScalableBlock(tile) && blockScaled) { tile.style = { ...startStyle }; rerenderBlock(tile); blockScaled = false; } // Shift pressed mid-drag: back to the text size it had
      const w = Math.max(isScalableBlock(tile) ? Math.min(blockMinW(tile), start.w) : TEXT_MIN_W, start.w + dx); // (a bookmark block keeps its columns whole)
      if (corner.includes('l')) b.x = start.x + (start.w - w);
      b.y = start.y;
      b.w = w;
      // a fixed box (sticky note, shape, frame) takes its height from the drag too
      if (tile.style && tile.style.box === 'fixed') { const h = Math.max(BOARD_MIN_H, start.h + dy); if (corner.includes('t')) b.y = start.y + (start.h - h); b.h = h; }
      layoutTile(tile);
      renderTextTile(tile);
      if (stops(ev)) {
        if (Collide.blocked(nowRects(), stopBefore, stopObst)) { Object.assign(b, lastRect); layoutTile(tile); renderTextTile(tile); }
        else lastRect = { ...b };
      }
      if (board.linked && !ev.altKey) resolveOverlaps(fixed);
      updateTextToolbar();
      return;
    }
    // follow whichever axis the user is pulling harder on
    const fromW = (start.w + dx) / tile.aspect;
    const fromH = start.h + dy;
    let h = Math.abs(fromW - start.h) > Math.abs(fromH - start.h) ? fromW : fromH;
    // a group scales about its box's far corner: measure the pull from there, so the handle
    // stays under the pointer whichever member it belongs to
    if (members) h = Snap.pull({ start, corner, dx, dy, origin: groupOrigin });
    if (onBoard) {
      // snap the size and the moving edges to the other tiles (Alt: free), like a move does
      if (!ev.altKey) {
        // (lines first: a line within reach wins over any tile's edge; a line snaps by its stroke)
        const near = tiles.filter((t) => t.board && !fixed.has(t));
        const opts = { start, corner, h, aspect: tile.aspect, th: SNAP_PX / board.zoom, gap: LINK_GAP, origin: groupOrigin };
        let s = Snap.resize({ ...opts, others: near.filter((t) => t.type === 'line').map(snapBoxOf).filter(Boolean) });
        if (s.guideX === null && s.guideY === null) s = Snap.resize({ ...opts, others: near.filter((t) => t.type !== 'line').map(snapBoxOf).filter(Boolean) });
        h = s.h;
        hideGuides();
        if (s.guideX !== null) showGuideV(s.guideX);
        if (s.guideY !== null) showGuideH(s.guideY);
      } else hideGuides();
      h = clamp(h, BOARD_MIN_H, BOARD_MAX_H);
      if (stops(ev)) {
        // the rects at height hh, without moving anything: the biggest that touches nothing new wins
        const rectsAt = (hh) => {
          let all;
          if (members) {
            const factor = Arrange.clampFactor([...memberStart.values()], hh / start.h, BOARD_MIN_H, BOARD_MAX_H);
            all = Arrange.scaleAbout(members.map((m) => memberStart.get(m)), groupBB, factor, corner);
          } else {
            const w = hh * tile.aspect;
            all = [{ x: corner.includes('l') ? start.x + (start.w - w) : start.x, y: corner.includes('t') ? start.y + (start.h - hh) : start.y, w, h: hh }];
          }
          return blockIdx.map((i) => all[i]);
        };
        h = Collide.largest(rectsAt, stopBefore, stopObst, start.h, h);
      }
      if (members) {
        const factor = Arrange.clampFactor([...memberStart.values()], h / start.h, BOARD_MIN_H, BOARD_MAX_H);
        const rects = Arrange.scaleAbout(members.map((m) => memberStart.get(m)), groupBB, factor, corner);
        members.forEach((m, i) => { m.board = { ...rects[i] }; layoutTile(m); if (m.freeAspect) renderTextTile(m); });
      } else {
        const w = h * tile.aspect;
        const b = tile.board;
        if (corner.includes('l')) b.x = start.x + (start.w - w);
        if (corner.includes('t')) b.y = start.y + (start.h - h);
        b.w = w; b.h = h;
        layoutTile(tile);
      }
      if (board.linked && !ev.altKey) resolveOverlaps(fixed);
    } else {
      setTileGalleryH(tile, h); // gallery: just this tile
    }
  };
  let ended = false;
  const onUp = () => {
    if (ended) return; // pointerup, lostpointercapture and a recovery can all arrive
    ended = true;
    activeInteractions.delete(onUp);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.removeEventListener('lostpointercapture', onUp);
    tile.el.classList.remove('resizing');
    if (members) for (const m of members) m.el.classList.remove('resizing');
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
    hideGuides();
    if (onBoard && blockScaled) { undoEntry.styles = [{ tile, before: startStyle, after: { ...tile.style } }]; undoEntry.label = 'scale ' + blockName(tile); }
    if (onBoard) finishRects(undoEntry); else finishGResize(undoEntry);
    if (blockScaled) setStatus(`${blockName(tile)[0].toUpperCase() + blockName(tile).slice(1)}: text ${Math.round(tile.style.size * board.zoom)} px on screen (Shift+drag a corner changes the width only)`, 4000);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.addEventListener('lostpointercapture', onUp);
  activeInteractions.add(onUp);
}

// ---------- board: move a tile ----------

function attachTileDrag(tile) {
  attachFavorite(tile); // every kind of tile passes through here: it gets its favorite star too
  const el = tile.el;
  // right-click a tile on the board: its place in the stack (pictures and text add their own lines
  // to this menu and handle the click themselves; a control's own menu goes first)
  el.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || !isBoard() || IS_VIEW || !tile.board) return;
    if (e.target.closest('input, select, textarea, iframe')) return;
    e.preventDefault(); e.stopPropagation();
    showRowMenu(e, [...stackMenuItems(tile), lockMenuItem(tile), ['Remove', () => removeTile(tile)]]);
  });
  // a locked tile has its own short menu, ahead of every other one on it (capture: before them)
  el.addEventListener('contextmenu', (e) => {
    if (!tile.locked || !isBoard() || IS_VIEW || !tile.board) return;
    if (e.target.closest('input, select, textarea, iframe')) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (!selection.has(tile)) selectOnly(tile);
    showRowMenu(e, lockedMenuItems(tile));
  }, true);
  el.addEventListener('pointerdown', (e) => {
    tile.guard.pointerDown(); // a fresh press: whatever click the last drag was waiting for never came
    if (!isBoard() || e.button !== 0 || !tile.board) return;
    if (e.target.closest('.handle, input, button, select')) return;
    if (tile.locked && !IS_VIEW) return; // a press on a locked tile is a press on the board: grid's pointerdown draws the lasso
    if (tile.frame && !IS_VIEW && !e.target.closest('.frame-title')) return; // inside a frame too (its title moves it)
    if (tile.editing && e.target.closest('.text-body')) return; // put the caret, don't drag the tile
    if (e.target.closest('.lt-ed, .lt-grip')) return; // (a bookmark block's cell being typed in, or a column divider, too)
    if (e.target.closest('.td-edit[contenteditable="plaintext-only"]')) return; // (and a to-do list's words)
    // Alt-drag on a sticky group's member rearranges inside the group (swap two slots)
    const swapMembers = tile.group ? [...tile.group.members].filter((m) => m.board) : [];
    if (!IS_VIEW && Swap.isSwapDrag({ sticky: !!(tile.group && tile.group.sticky), alt: e.altKey, mod: modKey(e), shift: e.shiftKey, memberCount: swapMembers.length })) {
      e.stopPropagation(); // the grid's pointerdown would otherwise start an Alt-pan too
      return startSwapDrag(tile, swapMembers, e);
    }
    if (e.altKey) return; // Alt-drag anywhere else pans (grid handler)
    const action = Select.onPointerDown({
      inSelection: selection.has(tile), grouped: !!tile.group, sticky: !!(tile.group && tile.group.sticky),
      mod: modKey(e), shift: e.shiftKey,
    });
    if (action === 'toggle') {
      // shift-click toggles membership without starting a drag
      setSelected(tile, !selection.has(tile));
      selectionStatus();
      // DISABLED (2026-10-07): cleared by a setTimeout(0) that fired before the click arrived; tile.guard replaces it
      // tile.suppressClick = true;
      // setTimeout(() => { tile.suppressClick = false; }, 0);
      tile.guard.afterDrag(); // a shift-click must not play either
      return;
    }
    // Ctrl: just this tile, even inside a sticky group. A plain click picks one tile, or a sticky
    // member's whole group (so its settings bar shows); a click inside the selection keeps it.
    const single = modKey(e);
    if (action === 'only') selectOnly(tile);
    else if (action === 'group') selectGroupOf(tile);
    if (IS_VIEW) return; // a view selects but never drags (no capture: the picture gets its own click)
    const start = { x: e.clientX, y: e.clientY };
    // Capture from the very first event, not once the drag passes the 4 px threshold: a release
    // over a cross-origin embed is only delivered back here if this element already owns the
    // pointer. Losing the capture anyway ends the drag like a normal release (onUp below).
    try { el.setPointerCapture(e.pointerId); } catch {}
    let moving = false;
    let group = [];
    let movingSet = new Set();
    let undoEntry = null;
    let stopZones = null, lastFree = { x: 0, y: 0 }; // Push neighbours off: where the group may not go
    const onMove = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moving) {
        if (Math.hypot(dx, dy) < 4) return;
        moving = true;
        // dragging something outside the selection makes it the selection
        if (!selection.has(tile)) selectOnly(tile);
        /* DISABLED (2026-10-07): the rule now lives in lib/select.js (Select.dragSet), shared with corner resize
        if (single) group = [tile];
        else {
          // members of non-sticky groups move on their own; sticky groups move whole
          const set = new Set([...selection].filter((t) => t === tile || !t.group || t.group.sticky));
          for (const t of [...set]) if (t.group && t.group.sticky) for (const m of t.group.members) if (m.board) set.add(m);
          group = [...set];
        }
        */
        // DISABLED (2026-10-07): selected members of a non-sticky group used to be left behind by a move
        // group = Select.dragSet(tile, [...selection], single);
        // everything selected moves together, non-sticky group or not; a sticky group moves whole
        group = Select.dragSet(tile, [...selection], single, Select.MOVE).filter((t) => !t.locked); // (locked tiles stay put)
        movingSet = new Set(group);
        // a frame takes what is in it along (2026-11-15)
        for (const f of [...group]) if (f.frame) for (const c of frameContents(f)) if (!movingSet.has(c)) { group.push(c); movingSet.add(c); }
        // an arrow held by a tile that is not moving stays where it is: its ends move it (2026-11-15)
        const held = group.filter((t) => t.type === 'line' && t.ends && t.ends.some((en) => en && !group.some((g) => g.id === en.id)));
        if (held.length) { group = group.filter((t) => !held.includes(t)); movingSet = new Set(group); if (!group.length) setStatus('This arrow is held by what it points at – drag its round ends to move it', 4000); }
        rememberStart();
        // Push neighbours off (the standard): it stops against what it meets (2026-11-19)
        stopZones = Collide.zones(group.filter(blocksMoves).map((t) => startPos.get(t)), stopObstacles(movingSet));
        undoEntry = recordMove(tiles.filter((t) => t.board)); // all board tiles: Linked mode can push neighbours
        // DISABLED (Mark, 2026-11-10): moving no longer raises tiles; they keep their layers, as in Miro
        // for (const t of group) { bringToFront(t); t.el.classList.add('dragging'); }
        for (const t of group) t.el.classList.add('dragging');
        document.body.classList.add('tile-dragging');
      }
      if (!group.length) return; // (only a held arrow was dragged: it stays)
      // proposed position of the group's bounding box
      const bb0 = boardBounds(group.map((t) => ({ board: startPos.get(t) })));
      let nx = bb0.minX + dx / board.zoom, ny = bb0.minY + dy / board.zoom;
      // one level or upright line: its stroke is what snaps, not the room around it
      const sb0 = group.length === 1 && group[0].type === 'line' ? snapBoxOf({ ...group[0], board: startPos.get(group[0]) }) : null;
      if (!ev.altKey && sb0) {
        const s = snapRect({ x: sb0.x + dx / board.zoom, y: sb0.y + dy / board.zoom, w: sb0.w, h: sb0.h }, movingSet);
        nx = bb0.minX + (s.x - sb0.x); ny = bb0.minY + (s.y - sb0.y);
      } else if (!ev.altKey) {
        const s = snapRect({ x: nx, y: ny, w: bb0.w, h: bb0.h }, movingSet);
        nx = s.x; ny = s.y;
      } else hideGuides();
      // const shiftX = nx - bb0.minX, shiftY = ny - bb0.minY; // (before 2026-11-19)
      let shiftX = nx - bb0.minX, shiftY = ny - bb0.minY;
      if (!board.linked && !ev.altKey && stopZones && stopZones.length) {
        // it rests against what it ran into and slides along it; once the place under the mouse is clear, it goes there
        const p = Collide.move(stopZones, lastFree, { x: shiftX, y: shiftY });
        if (p.x !== shiftX) guideV.hidden = true;
        if (p.y !== shiftY) guideH.hidden = true;
        shiftX = p.x; shiftY = p.y; lastFree = p;
      }
      for (const t of group) {
        const s = startPos.get(t);
        t.board.x = s.x + shiftX; t.board.y = s.y + shiftY;
        layoutTile(t);
      }
      if (board.linked && !ev.altKey) resolveOverlaps(movingSet);
      updateTextToolbar();
    };
    let ended = false;
    const onUp = () => {
      if (ended) return; // pointerup, lostpointercapture and a recovery can all arrive
      ended = true;
      activeInteractions.delete(onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      hideGuides();
      if (moving) {
        finishRects(undoEntry);
        for (const t of group) t.el.classList.remove('dragging');
        document.body.classList.remove('tile-dragging');
        // DISABLED (2026-10-07): cleared by a setTimeout(0) that fired before the click arrived; tile.guard replaces it
        // tile.suppressClick = true;
        // setTimeout(() => { tile.suppressClick = false; }, 0);
        tile.guard.afterDrag(); // the click this release produces must not toggle play
      }
      updateTextToolbar();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', onUp); // the embed, or Chromium, took the pointer
    activeInteractions.add(onUp); // a recovery ends this drag properly, listeners and all
  });
}

// ---------- board: swap two members of a sticky group ----------
// The dragged tile follows the pointer; the member under the pointer is the target and previews
// moving into the dragged tile's slot. Release on a target: the two exchange slots (position and
// size; a tile of another shape sits centred inside its new slot). Anywhere else, or a drag that
// ends any other way than a release on this tile (lost capture, cancel, recovery): everything
// goes back. One undo entry.
function startSwapDrag(tile, members, e) {
  const el = tile.el;
  try { el.setPointerCapture(e.pointerId); } catch {}
  const startC = { x: e.clientX, y: e.clientY };
  const slots = members.map((m) => ({ id: m, rect: { ...m.board } }));
  const startRect = { ...tile.board };
  let moving = false, target = null, undoEntry = null;
  const place = (m, rect) => { m.board = Swap.fitInto(rect, m.freeAspect ? null : m.aspect); layoutTile(m); if (m.freeAspect) renderTextTile(m); };
  const restore = (m) => { const s = slots.find((x) => x.id === m); m.board = { ...s.rect }; layoutTile(m); if (m.freeAspect) renderTextTile(m); };
  const setTarget = (m) => {
    if (target === m) return;
    if (target) { target.el.classList.remove('swap-target'); restore(target); }
    target = m;
    if (target) { target.el.classList.add('swap-target'); place(target, startRect); }
  };
  const onMove = (ev) => {
    const dx = ev.clientX - startC.x, dy = ev.clientY - startC.y;
    if (!moving) {
      if (Math.hypot(dx, dy) < 4) return;
      moving = true;
      undoEntry = recordMove(members, 'swap');
      // bringToFront(tile); // DISABLED (Mark, 2026-11-10): lifted only while it follows the pointer
      liftTile(tile, true);
      el.classList.add('swapping');
      document.body.classList.add('tile-dragging');
    }
    tile.board.x = startRect.x + dx / board.zoom; tile.board.y = startRect.y + dy / board.zoom;
    layoutTile(tile);
    const p = toCanvas(ev.clientX, ev.clientY);
    setTarget(Swap.targetAt(p, slots, tile));
  };
  let ended = false;
  const onUp = (ev) => {
    if (ended) return; // pointerup, lostpointercapture and a recovery can all arrive
    ended = true;
    activeInteractions.delete(onUp);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('lostpointercapture', onUp);
    if (!moving) return;
    // only a real release commits; a cancelled drag puts everything back
    if (!ev || ev.type !== 'pointerup') setTarget(null);
    const swapped = target;
    if (target) target.el.classList.remove('swap-target');
    for (const s of Swap.apply(slots, tile, target)) {
      if (swapped && (s.id === tile || s.id === swapped)) place(s.id, s.rect); else restore(s.id);
    }
    el.classList.remove('swapping');
    liftTile(tile, false); // back at its own layer
    document.body.classList.remove('tile-dragging');
    finishRects(undoEntry); // drops the entry when nothing changed (no target)
    tile.guard.afterDrag();
    updateTextToolbar();
    if (swapped) { setStatus('Swapped'); logUi('info', 'swap', { group: tile.group && tile.group.id }); }
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  activeInteractions.add(onUp);
}

// ---------- board: pan the view / lasso ----------

function startPan(e) {
  e.preventDefault();
  try { grid.setPointerCapture(e.pointerId); } catch {}
  const ox = e.clientX - board.panX, oy = e.clientY - board.panY;
  document.body.classList.add('panning');
  const onMove = (ev) => { board.panX = ev.clientX - ox; board.panY = ev.clientY - oy; applyBoardView(); };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    activeInteractions.delete(onUp);
    grid.removeEventListener('pointermove', onMove);
    grid.removeEventListener('pointerup', onUp);
    grid.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('panning');
  };
  grid.addEventListener('pointermove', onMove);
  grid.addEventListener('pointerup', onUp);
  grid.addEventListener('pointercancel', onUp);
  activeInteractions.add(onUp);
}

function startLasso(e, lockedHit = null) {
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
      if (!t.board || t.locked) continue; // (the lasso leaves locked tiles out)
      const B = t.board;
      // (a tile the whole lasso lies inside is what it was drawn on, a background: not taken)
      if (B.x <= a.x && B.y <= a.y && B.x + B.w >= b.x && B.y + B.h >= b.y) continue;
      // (a frame only when all of it is inside the lasso, as in Miro)
      if (t.frame && !(B.x >= a.x && B.y >= a.y && B.x + B.w <= b.x && B.y + B.h <= b.y)) continue;
      if (B.x < b.x && B.x + B.w > a.x && B.y < b.y && B.y + B.h > a.y) hits.add(t);
    }
    // a sticky group is lassoed as one
    for (const t of [...hits]) if (t.group && t.group.sticky) for (const m of t.group.members) if (!m.locked) hits.add(m);
    for (const t of tiles) if (t.board) setSelected(t, hits.has(t) || before.has(t));
  };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    activeInteractions.delete(onUp);
    grid.removeEventListener('pointermove', onMove);
    grid.removeEventListener('pointerup', onUp);
    grid.removeEventListener('pointercancel', onUp);
    marqueeEl.hidden = true;
    if (dragged) selectionStatus();
    // a click (no drag) on a locked tile selects it, so it can be unlocked
    else if (lockedHit && tiles.includes(lockedHit)) { if (additive) setSelected(lockedHit, !before.has(lockedHit)); else selectOnly(lockedHit); }
  };
  grid.addEventListener('pointermove', onMove);
  grid.addEventListener('pointerup', onUp);
  grid.addEventListener('pointercancel', onUp);
  activeInteractions.add(onUp);
}

grid.addEventListener('pointerdown', (e) => {
  if (!isBoard()) return;
  // a locked tile is part of the board here: a drag on it draws the lasso (or pans), a click selects it
  const lockedHit = IS_VIEW ? null : lockedTileAt(e.target);
  const onBackground = e.target === grid || e.target === canvas || !!lockedHit || (!IS_VIEW && !!frameBodyAt(e.target));
  if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && onBackground && board.hand)) return startPan(e);
  if (e.button === 0 && onBackground) return startLasso(e, lockedHit);
});
// right-click on empty board space: copy the selection, or paste where the cursor is
grid.addEventListener('contextmenu', (e) => {
  if (!isBoard()) return;
  if (e.target !== grid && e.target !== canvas) return; // a tile's own menu wins
  e.preventDefault();
  lastPointer = { clientX: e.clientX, clientY: e.clientY };
  showRowMenu(e, [
    ['Copy', () => copySelection(), !selection.size],
    ['Paste', () => pasteClipboard()], // Ozy's own tiles, or a picture copied elsewhere
    [layout.background === 'light' ? 'Dark board' : 'Light board', () => { setBoardBackground(layout.background === 'light' ? 'dark' : 'light'); setStatus(layout.background === 'light' ? 'Light board (saved with the session)' : 'Dark board'); }, IS_VIEW],
    [(board.linked ? '☑' : '☐') + ' Push neighbours when moving', () => setPushNeighbours(!board.linked), IS_VIEW], // (2026-11-19; off as standard)
  ]);
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
    suppressClick: false, // kept for older code paths
    guard: ClickGuard.create(),
    id: newTileId(Session.tileId(state)),
    galleryH: Number(state.galleryH) > 0 ? clamp(Number(state.galleryH), MIN_H, MAX_H) : layout.rowHeight,
    bookmarks: parseBookmarks(state.bookmarks),
  };
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) {
    tile.board = { x: Number(sb.x), y: Number(sb.y), w: Number(sb.w), h: Number(sb.h) };
  }
  tiles.push(tile);
  observePb(tile);
  tile.pb = budgetedPlayback(tile, tile.pb); // reads the still's clock while the source is released
  tile.info = null; tile.proxy = null; tile.fps = null;
  tile.fpsOverride = Number(state.fpsOverride) > 0 ? Number(state.fpsOverride) : null; // ⚙: frame step / timecode only
  tile.quality = Session.tileQuality(state);      // 'scene' | 'full' | 'half' | 'quarter'
  tile.tiers = { half: null, quarter: null };       // cached tier files found by probe / made on demand
  tile.tier = 'full';                               // what is loaded right now
  tile.tierJob = null;                              // tier being encoded, if any
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

  // (through tile.pb: a still has no source, its time and length live in tile.shadow)
  const updateTimeLabel = () => {
    timeEl.textContent = Frames.format(tile.pb.time, tile.pb.duration, effectiveFps(tile), layout.timeDisplay);
  };
  const updateSeek = () => {
    if (tile.scrubbing || !tile.pb.duration) return;
    const frac = tile.pb.time / tile.pb.duration;
    const v = Math.round(frac * 10000);
    if (Number(seek.value) !== v) {
      seek.value = String(v);
      seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    }
  };
  const updatePlayBtn = () => {
    playBtn.textContent = tile.pb.paused ? '▶' : '❚❚';
    el.classList.toggle('paused-badge', tile.pb.paused);
    el.classList.toggle('playing-still', !tile.live && !tile.pb.paused);
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
  // (a still has no source: seeking and stepping move its shadow clock through tile.pb instead)
  const seekTo = (t) => {
    if (!tile.live) {
      tile.pb.time = clamp(t, 0, tile.pb.duration || Infinity);
      tile.onShadow();
      broadcast(tile, 'seek');
      return;
    }
    if (!video.duration) return;
    video.currentTime = clamp(t, 0, video.duration);
    updateTimeLabel();
    updateSeek();
    broadcast(tile, 'seek');
  };
  const seekBy = (dt) => seekTo(tile.pb.time + dt);
  tile.seekBy = seekBy;
  const stepFrame = (dir) => {
    if (!tile.live) {
      tile.pb.pause();
      broadcast(tile, 'pause');
      seekTo(Frames.step(tile.pb.time, effectiveFps(tile) || Frames.DEFAULT_FPS, dir));
      return;
    }
    if (!video.duration) return;
    video.pause();
    broadcast(tile, 'pause');
    seekTo(Frames.step(video.currentTime, effectiveFps(tile) || Frames.DEFAULT_FPS, dir));
  };
  // play/pause from the user (picture click, ▶ button, K); synced members follow
  // through tile.pb so a still (or one on its way back) plays on its own clock until it is live
  tile.togglePlay = () => { if (tile.pb.paused) tile.pb.play(); else tile.pb.pause(); broadcast(tile, tile.pb.paused ? 'pause' : 'play'); };
  /* DISABLED (2026-10-20): read the <video>, which has no source while the tile is a still
  tile.togglePlay = () => { togglePlay(video); broadcast(tile, video.paused ? 'pause' : 'play'); };
  */
  tile.stepFrame = stepFrame;
  el.querySelector('.fstep-back').addEventListener('click', () => stepFrame(-1));
  el.querySelector('.fstep-fwd').addEventListener('click', () => stepFrame(1));
  // (gallery; on the board the tile owns the pointer and tileClick() runs tile.timeClick instead)
  timeEl.addEventListener('click', (e) => { e.stopPropagation(); cycleTimeDisplay(); });
  tile.timeClick = cycleTimeDisplay;
  /* DISABLED (2026-10-07): body moved into cycleTimeDisplay() so the board path can share it
  timeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const modes = ['clock', 'frames', 'timecode'];
    layout.timeDisplay = modes[(modes.indexOf(layout.timeDisplay) + 1) % modes.length];
    for (const t of tiles) t.tick && t.refreshTime && t.refreshTime();
    renderTimeline(); // lane timecodes follow the display mode
  });
  */
  tile.refreshTime = updateTimeLabel;

  // ----- bookmarks (shared with YouTube tiles: attachBookmarks) -----
  tile.seekTo = seekTo;
  const { renderMarkers } = attachBookmarks(tile, el, tile.pb);
  backBtn.addEventListener('click', (e) => seekBy(e.shiftKey ? -30 : -5));
  fwdBtn.addEventListener('click', (e) => seekBy(e.shiftKey ? 30 : 5));
  for (const b of [backBtn, fwdBtn, el.querySelector('.fstep-back'), el.querySelector('.fstep-fwd')]) b.addEventListener('dblclick', (e) => e.stopPropagation());

  el.addEventListener('pointerenter', () => { hoveredTile = tile; hpEnter(tile); });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; hpLeave(tile); });

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
  // The file could not be read while the PC was busy (or its share was down) and has answered
  // since: load it again. Chromium remembers the failed URL, hence the new query.
  tile.retryAfterRecovery = () => {
    if (!video.error || tile.unplayable) return; // only a tile that failed to load, not one that can't play here
    logUi('info', 'reloading after the drive answered', { path: filePath });
    tile.loadRetries = (tile.loadRetries || 0) + 1;
    tierGen.full++; tierGen.half++; tierGen.quarter++;
    loadFull();
    if (wanted() !== 'full') tile.applyQuality();
  };

  // ----- playback resolution (Optimize menu, ⚙): play a half / quarter size copy instead -----
  // the tier this tile should play: its own override, else the scene's
  const wanted = () => (tile.quality === 'scene' ? layout.quality : tile.quality);
  tile.wantedTier = wanted;
  const tierMark = (q) => (q === 'half' ? '½' : q === 'quarter' ? '¼' : '');
  const qBadge = el.querySelector('.q-badge');
  const showBadge = (text) => { qBadge.textContent = text; qBadge.hidden = !text; };
  // change the file behind the <video> without losing where it was (put back on loadedmetadata, below)
  let swapState = null;
  tile.swapSource = (url) => {
    // nothing loaded yet: the first load's own restore (the saved time) applies. A swap already
    // under way keeps the state it took from the file that was really playing.
    if (!swapState && (video.readyState > 0 || video.error)) swapState = { time: video.currentTime, paused: video.paused, rate: video.playbackRate };
    tile.setSource(url);
  };

  // ----- live budget: a still is the last frame on a canvas, the <video> drops its source -----
  // applyLiveBudget() decides which tiles a window decodes (lib/lod.js). Releasing copies the frame
  // to a canvas, starts the shadow clock (tile.pb reads it) and frees the decoder. Restoring loads
  // the source again and lands at the shadow's time and play state through the same swap restore
  // a quality change uses; the still stays up until the video can draw. A source that changes
  // while the tile is a still (a tier or a playable copy that just became ready) is remembered.
  const still = el.querySelector('canvas.still');
  tile.live = true;
  tile.shadow = null;
  tile.releasedSrc = null;
  const setSourceNow = tile.setSource;
  tile.setSource = (url) => { if (!tile.live) { tile.releasedSrc = url; return; } setSourceNow(url); };
  tile.onShadow = () => { updatePlayBtn(); updateTimeLabel(); updateSeek(); if (tile.group && tile.group === active) renderGroupBar(); };
  tile.release = () => {
    if (!tile.live) return;
    const src = video.getAttribute('src');
    if (!src || video.error) return; // nothing loaded (an unplayable file waiting for a copy): nothing to free
    if (!tile.shadow) {
      try {
        if (video.videoWidth && video.readyState >= 2) { still.width = video.videoWidth; still.height = video.videoHeight; still.getContext('2d').drawImage(video, 0, 0); }
      } catch {}
      // a tile released before its metadata came in (a big session just opened) or in the middle
      // of a quality swap starts from what it was opened at, or from the swap's saved place
      const seed = Lod.seed({ readyState: video.readyState, videoTime: video.currentTime, videoPaused: video.paused, rate: video.playbackRate, swap: swapState, wantTime, wantPlaying });
      tile.shadow = { ...seed, duration: video.duration || 0, at: performance.now() };
    }
    tile.releasedSrc = src;
    tile.live = false;
    video.volume = 0; // never heard as a still, whichever window is heard next
    swapState = null; // a quality swap that had not landed yet: the shadow has the state now
    video.pause(); video.removeAttribute('src'); video.load();
    still.hidden = false; el.classList.add('still');
    updatePlayBtn();
  };
  tile.restore = () => {
    if (tile.live) return;
    tile.live = true;
    if (!tile.releasedSrc) { tile.shadow = null; still.hidden = true; el.classList.remove('still', 'playing-still'); return; }
    const url = tile.releasedSrc; tile.releasedSrc = null;
    // Until the metadata is in, tile.pb keeps answering from the shadow (a play or a seek made
    // meanwhile lands there); then the element takes over at the shadow's time, rate and play
    // state. This listener is added after the first-load and swap restores, so it has the last
    // word. The still stays up until the video has a frame to draw.
    const landed = () => {
      video.removeEventListener('loadedmetadata', landed);
      if (!tile.live || !tile.shadow) return; // released again before it got here
      const s = tile.shadow, at = shadowNow(tile), playing = s.playing && !shadowEnded(tile);
      tile.shadow = null;
      video.currentTime = isFinite(video.duration) ? Math.min(at, video.duration) : at;
      video.playbackRate = s.rate;
      if (playing) video.play().catch(() => {}); else video.pause();
      updatePlayBtn(); updateTimeLabel(); updateSeek();
    };
    const shown = () => {
      video.removeEventListener('loadeddata', shown);
      if (!tile.live) return;
      still.hidden = true; el.classList.remove('still', 'playing-still');
    };
    video.addEventListener('loadedmetadata', landed);
    video.addEventListener('loadeddata', shown);
    setSourceNow(url);
  };
  // touching a still (its buttons, a click, a scrub) asks for it to be live for a while
  el.addEventListener('pointerdown', () => { if (!tile.live) { tile.wantedAt = performance.now(); scheduleOffscreen(); } }, true);
  // Chromium remembers a URL that failed to load for the life of the page, so a copy that had to
  // be made again (same file name) is asked for under a new query; main ignores the query.
  const tierGen = { half: 0, quarter: 0, full: 0 };
  const tierUrl = (q) => window.api.videoUrl(tile.tiers[q]) + (tierGen[q] ? '?v=' + tierGen[q] : '');
  const proxyUrl = () => window.api.videoUrl(tile.proxy) + (tierGen.full ? '?v=' + tierGen.full : '');
  const origUrl = () => window.api.videoUrl(filePath) + (tile.loadRetries ? '?r=' + tile.loadRetries : ''); // see retryAfterRecovery
  const loadFull = () => {
    tile.tier = 'full'; showBadge('');
    if (tile.unplayable && !tile.proxy) { // the original can't play here and no playable copy was made: back to that offer
      swapState = null; video.removeAttribute('src'); video.load();
      showError(`${(tile.info && tile.info.codec) || 'This codec'} can't play here.`, true);
    } else tile.swapSource(tile.proxy ? proxyUrl() : origUrl());
  };
  // an encode this tile no longer wants is stopped, unless another tile of the same file still wants it
  const dropTierJob = () => {
    const j = tile.tierJob;
    if (!tiles.some((t) => t !== tile && t.path === filePath && t.wantedTier && t.wantedTier() === j)) window.api.cancelProxy(filePath, j);
  };
  tile.applyQuality = async () => {
    if (!tile.info) return;                          // probe not back yet; the probe's own branch calls this
    const want = wanted();
    if (tile.tierJob && tile.tierJob !== want) dropTierJob();
    if (want === tile.tier) { showBadge(tierMark(want)); return; }
    if (want === 'full') { loadFull(); return; }
    if (tile.tiers[want]) { tile.tier = want; tile.swapSource(tierUrl(want)); showBadge(tierMark(want)); return; }
    if (!tile.info.available) { showBadge(''); setStatus('ffmpeg not found – playback quality needs it', 6000); return; }
    if (tile.tierJob === want) return;               // already encoding this one
    tile.tierJob = want;
    showBadge(tierMark(want) + ' 0%');               // keeps playing what it has until the copy is ready
    try {
      const { proxy } = await window.api.makeProxy(filePath, want);
      if (!tiles.includes(tile)) return;
      tile.tiers[want] = proxy;
    } catch (e) {
      if (tiles.includes(tile) && wanted() === want) {
        showBadge(tierMark(tile.tier));
        if (!/Cancelled/.test(String(e.message))) {
          setStatus(`Could not make a smaller copy of ${basename(filePath)} – it keeps playing as it is`, 6000);
          logUi('warn', 'tier failed', { path: filePath, tier: want, error: String(e.message) });
        }
      }
      return;
    } finally { if (tile.tierJob === want) tile.tierJob = null; }
    if (wanted() === want) tile.applyQuality();      // still wanted once it is done
    else showBadge(tierMark(tile.tier));
  };
  tile.onTierProgress = (frac, tier) => { if (tile.tierJob === tier) showBadge(tierMark(tier) + ' ' + Math.round(frac * 100) + '%'); };
  // A cached copy can vanish (the cache was cleared or trimmed) or be unreadable: fall back to the
  // full file and make the copy again, once. Registered before the tile's own error handler, which
  // must not put its "Cannot play" panel over a video that is about to play.
  const tierRetried = new Set();
  video.addEventListener('error', (e) => {
    const next = ProxyCache.lostCopy({ tier: tile.tier, hasProxy: !!tile.proxy, unplayable: !!tile.unplayable });
    if (next === 'none') return;
    if (next !== 'remake-tier') {
      // The playable copy is gone (the cache was trimmed or cleared while this tile sat idle).
      logUi('warn', 'playable copy unreadable', { path: filePath });
      tile.proxy = null; tierGen.full++;
      if (next === 'offer-playable') return;      // the tile's own handler now offers Make playable again
      e.stopImmediatePropagation();
      loadFull();                                 // the original plays here: carry on with it
      return;
    }
    e.stopImmediatePropagation();
    const lost = tile.tier;
    tile.tiers[lost] = null;
    tierGen[lost]++;
    logUi('warn', 'tier copy unreadable', { path: filePath, tier: lost });
    loadFull();
    if (!tierRetried.has(lost)) { tierRetried.add(lost); tile.applyQuality(); }
  });

  const startProxy = async () => {
    makeBtn.classList.add('hidden'); cancelBtn.classList.remove('hidden'); bar.classList.remove('hidden');
    errorText.textContent = 'Making a playable copy…';
    try {
      const { proxy } = await window.api.makeProxy(filePath);
      tile.proxy = proxy;
      tile.setSource(proxyUrl());
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
    tile.tiers = info.tiers || tile.tiers;
    if (!info.available && !toolsWarned) { toolsWarned = true; setStatus('ffmpeg / ffprobe not found – Make playable and frame rates are unavailable', 8000); }
    if (info.proxy) { tile.proxy = info.proxy; tile.setSource(window.api.videoUrl(info.proxy)); }
    else {
      // known codec with no mime (prores, mpeg4, ...) can't play; probe failed (no codec) -> let Chromium try
      const playable = info.mime ? video.canPlayType(info.mime) !== '' : !info.codec;
      tile.unplayable = !playable && info.available;
      if (tile.unplayable) showError(`${info.codec || 'This codec'} can't play here.`, true);
      else tile.setSource(window.api.videoUrl(filePath));
    }
    tile.applyQuality(); // a tile added into a ½ / ¼ scene, or saved with its own quality, goes there at once
  })();

  // a half / quarter copy is rounded to even pixels, so its shape can be a hair off the original's:
  // the tile takes its aspect from the full-size file (or the saved one), never from a smaller copy
  let aspectKnown = Number(state.aspect) > 0;
  video.addEventListener('loadedmetadata', () => {
    if (video.videoWidth > 0 && video.videoHeight > 0 && (tile.tier === 'full' || !aspectKnown)) {
      aspectKnown = true;
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
  // after the first-load restore above: a tier swap puts back what was really playing
  video.addEventListener('loadedmetadata', () => {
    if (tile.tier !== 'full') tierRetried.delete(tile.tier); // it loaded: a later loss gets its own retry
    if (!swapState) return;
    const r = ProxyCache.restore(swapState, video.duration);
    swapState = null;
    video.currentTime = r.time;
    video.playbackRate = r.rate;
    if (r.play) video.play().catch(() => {}); else video.pause();
    updateTimeLabel(); updateSeek();
  });
  video.addEventListener('timeupdate', () => { if (!tile.scrubbing) updateTimeLabel(); });
  video.addEventListener('durationchange', () => {
    updateTimeLabel(); renderMarkers();
    if (tl._model && tl._model.members.some((m) => m.tile === tile)) renderTimeline(); // extent grows as durations load
  });
  // UI only: a synced member paused by the loop engine must not pause its group
  const onPlayState = () => { if (!video.paused) tile.autoPaused = false; updatePlayBtn(); if (tile.group && tile.group === active) renderGroupBar(); }; // any play, by anyone, ends an offscreen pause
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
    // On the board this handler does not see the click at all: the tile owns the pointer, so the
    // click goes to the tile element and tileClick() plays it.
    if (e.shiftKey) return;
    if (!tile.guard.shouldAct()) return; // this click ended a drag
    tile.togglePlay();
  });
  el.addEventListener('click', (e) => {
    tileClick(tile, e);
    if (isBoard() || !e.shiftKey || e.target.closest('button, input, select, .bm-panel')) return;
    setSelected(tile, !selection.has(tile));
    selectionStatus();
  });
  // (gallery; on the board the dblclick goes to the tile element, see tileDblClick)
  video.addEventListener('dblclick', () => {
    if (!cmp.el.hidden || sedOpen()) return; // in the compare view (or the sync editor) the tile is empty
    toggleTileFullscreen(el);
  });
  el.addEventListener('dblclick', (e) => tileDblClick(tile, e));

  playBtn.addEventListener('click', () => tile.togglePlay());

  // scrubbing
  // This file seeks instantly, but its group may hold a YouTube tile that does not: the broadcast
  // is throttled during the drag and sent once on release.
  const scrubber = Scrub.create();
  const beginScrub = () => { tile.scrubbing = true; el.classList.add('scrubbing'); };
  const endScrub = () => {
    const wasScrubbing = tile.scrubbing;
    tile.scrubbing = false; el.classList.remove('scrubbing'); updateSeek();
    if (wasScrubbing) { scrubber.end(0); broadcast(tile, 'seek'); }
  };
  seek.addEventListener('pointerdown', beginScrub);
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('input', () => {
    if (!tile.live) { // a still: the bar moves its clock
      if (!tile.pb.duration) return;
      const f = Number(seek.value) / 10000;
      tile.pb.time = f * tile.pb.duration;
      seek.style.setProperty('--progress', (f * 100).toFixed(2) + '%');
      updateTimeLabel();
      if (!tile.scrubbing) broadcast(tile, 'seek');
      return;
    }
    if (!video.duration) return;
    const frac = Number(seek.value) / 10000;
    video.currentTime = frac * video.duration;
    seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    updateTimeLabel();
    if (!tile.scrubbing) { broadcast(tile, 'seek'); return; }
    if (scrubber.move(frac, performance.now()) !== null) broadcast(tile, 'scrub'); // preview the group
  });
  seek.addEventListener('change', () => { if (!tile.scrubbing) updateSeek(); });
  seek.addEventListener('keydown', (e) => {
    // step 5 s with arrow keys instead of 1/10000 of the video
    const step = e.shiftKey ? 30 : 5;
    if (!tile.live) { // a still
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); seekBy(-step); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); seekBy(step); }
      return;
    }
    if (!video.duration) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - step); broadcast(tile, 'seek'); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + step); broadcast(tile, 'seek'); }
  });

  // volume / mute / speed
  const setTileVolume = (pct) => {
    tile.volume = clamp(pct, 0, 100) / 100;
    applyTileVolume(tile);
    emitPlayback(tile, 'volume', tile.volume);
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
document.addEventListener('fullscreenchange', () => scheduleOffscreen()); // a fullscreen still comes back live
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) hpReset(); // a fullscreen tile owns playback; hovering resumes on exit
  for (const t of tiles) {
    const b = t.el.querySelector('.fullscreen');
    if (!b) continue; // text tiles have no overlay and never go fullscreen
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
  if (!viewMayEdit()) return;
  attachDirty(); // (an arrow's end on it is loose from now on)
  if (record && tiles.includes(tile)) recordRemove(tile); // before it leaves `tiles`, so the index is right
  const i = tiles.indexOf(tile);
  if (i >= 0) tiles.splice(i, 1);
  tileIds.delete(tile.id);
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
  updateTextToolbar();
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
      // the embed knows the video's real title; it costs nothing to take it
      if (d.info.videoData && typeof d.info.videoData.title === 'string' && d.info.videoData.title) st.title = d.info.videoData.title;
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
    seek: (t) => post('seekTo', [t, true]),
    // allowSeekAhead false: show the frame, don't start fetching from there. YouTube's own advice
    // for a drag; with true it re-buffers on every pointermove and never catches up.
    scrub: (t) => post('seekTo', [t, false]),
    mute: () => post('mute'), unmute: () => post('unMute'),
    volume: (v) => post('setVolume', [Math.round(v * 100)]), rate: (r) => post('setPlaybackRate', [r]),
    get paused() { return st.state !== 1 && st.state !== 3; }, // 1 playing, 3 buffering
    destroy: () => { clearInterval(hello); window.removeEventListener('message', onMsg); },
  };
}

// Background title lookups run one after another, never in parallel (see addWebTile).
let titleQueue = Promise.resolve();

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
    board: null, suppressClick: false, /* kept for older code paths */ guard: ClickGuard.create(), id: newTileId(Session.tileId(state)), galleryH: Number(state.galleryH) > 0 ? clamp(Number(state.galleryH), MIN_H, MAX_H) : layout.rowHeight,
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
  observePb(tile); // its playback changes reach the other windows
  // YouTube tiles get their own timeline colour like local videos (Twitch never shows on the timeline)
  if (parsed.type === 'youtube') tile.hue = GROUP_PALETTE.includes(state.color) ? state.color : GROUP_PALETTE[(tiles.length - 1) % GROUP_PALETTE.length];
  nameEl.textContent = tile.title;
  nameEl.title = url + '\nRight-click: copy URL';
  // Until something tells us better, a web tile is named "YouTube · <id>". The real title arrives
  // from the embed (infoDelivery carries videoData) or from a yt-dlp resolve; whichever comes
  // first wins, and a name the user or a playlist already set is never overwritten.
  const placeholderTitle = WebUrl.label(parsed);
  // a drag on this tile's own bar previews at most every 150 ms and commits once on release
  const webScrubber = Scrub.create();
  let webScrubT = 0;
  const setWebTitle = (t) => {
    const s = typeof t === 'string' ? t.trim() : '';
    if (!s || s === tile.title || tile.title !== placeholderTitle) return;
    tile.title = s;
    nameEl.textContent = s;
    renderTimeline();   // the legend and the lanes name it too
    if (active) renderGroupBar();
  };
  tile.setWebTitle = setWebTitle;
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
    if (opt) {
      opt.textContent = WebStream.labelFor('stream', tile.webQuality);
      /* DISABLED (Mark, 2026-09-21): Stream is broken until Task 35; Player + timeline sync covers
         the need. The <option> stays in index.html so restoring it is one line here.
         A Twitch clip has no embed, so Stream is still its only way to play. */
      opt.hidden = canPlayer;
    }
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
    setWebTitle(r.title);
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
      // (quiet: putting the embed back where it was is this window's business, not a seek to send)
      if (tile.yt && at > 0) setTimeout(() => { if (tile.webMode === 'player' && tile.yt) quietly(() => { tile.pb.time = at; }); }, 1200);
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
  video.addEventListener('click', (e) => { if (e.shiftKey) return; if (!tile.guard.shouldAct()) return; tile.togglePlay(); });
  video.addEventListener('dblclick', () => { if (cmp.el.hidden && !sedOpen()) toggleTileFullscreen(el); });
  el.addEventListener('dblclick', (e) => tileDblClick(tile, e)); // board: the tile gets it, not the <video>

  // ----- YouTube controls -----
  const wantTime = wantTime0;
  const wantPlaying = state.paused === false;
  const refreshMute = () => { muteBtn.textContent = tile.ownMuted || (tile.group && tile.group.muted) || tile.volume === 0 ? '🔇' : '🔊'; };
  tile.refreshMute = refreshMute;
  if (parsed.type === 'youtube') {
    const yt = tile.yt = ytController(iframe);
    const pb = tile.pb = ytPlayback(yt);
    let first = true, knownDuration = 0, lastState = yt.st.state;
    // Restoring the saved time on a player that has not started makes YouTube start it (seekTo
    // does that), so a tile restored paused - every tile, on open and paste - is paused again the
    // moment it reports playing. Once, and only for a few seconds: after that a play is the user's.
    let holdPausedUntil = 0;
    const ytPlay = yt.play;
    yt.play = () => { holdPausedUntil = 0; ytPlay(); }; // Play all, the group bar, a synced partner: a wanted play is never undone
    yt.onChange((st, ev) => {
      if (holdPausedUntil && ev === 'onStateChange' && st.state === 1) {
        if (performance.now() < holdPausedUntil) yt.pause();
        holdPausedUntil = 0;
      }
      if (st.title) setWebTitle(st.title);
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
        else if (wantTime > 0) { holdPausedUntil = performance.now() + 5000; yt.pause(); }
      }
      // markers and the timeline need the duration, which arrives with the first reports
      if (st.duration > 0 && st.duration !== knownDuration) {
        knownDuration = st.duration;
        renderMarkers();
        if (tl._model && tl._model.members.some((m) => m.tile === tile)) renderTimeline();
      }
      if (ev === 'onStateChange' && !yt.paused) tile.autoPaused = false; // any play ends an offscreen pause
      if (ev === 'onStateChange' && tile.group && tile.group === active) renderGroupBar();
    });
    // user actions on the embed; a synced group follows (like a local video's)
    ytSeekTo = (t) => { pb.time = clamp(t, 0, pb.duration || Infinity); tile.tick(); broadcast(tile, 'seek'); };
    ytTogglePlay = () => { holdPausedUntil = 0; const play = yt.paused; play ? yt.play() : yt.pause(); broadcast(tile, play ? 'play' : 'pause'); };
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
      timeEl.textContent = `${fmtTime(t)} / ${fmtTime(yt.st.duration)}`;
      if (tile.scrubbing) {
        // mid-drag: preview only, and leave the rest of a synced group alone until release
        webScrubT = t;
        const v = webScrubber.move(t, performance.now());
        if (v !== null) pbScrub(pb, v);
        return;
      }
      pb.time = t;
      broadcast(tile, 'seek');
    });
  }
  // controls shared by both elements (Twitch clips have no YouTube block at all)
  if (!tile.tick) tile.tick = () => { if (videoActive()) videoTick(); };
  playBtn.addEventListener('click', () => tile.togglePlay());
  muteBtn.addEventListener('click', () => { setOwnMuted(tile, !tile.ownMuted); refreshMute(); });
  seek.addEventListener('pointerdown', () => { tile.scrubbing = true; el.classList.add('scrubbing'); webScrubT = tile.pb ? tile.pb.time : 0; });
  const endVideoScrub = () => {
    const wasScrubbing = tile.scrubbing;
    tile.scrubbing = false;
    el.classList.remove('scrubbing');
    // the embed was only previewing during the drag: commit where it ended, once
    if (wasScrubbing && !videoActive() && tile.pb && tile.pb.web) {
      tile.pb.time = webScrubber.end(webScrubT);
      broadcast(tile, 'seek');
    }
  };
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
  tile.setVolume = (pct) => { tile.volume = clamp(pct, 0, 100) / 100; applyTileVolume(tile); emitPlayback(tile, 'volume', tile.volume); if (tile.volume > 0 && tile.ownMuted) setOwnMuted(tile, false); refreshMute(); };
  tile.destroy = () => {
    clearTimeout(loadTimer);
    if (tile.yt) tile.yt.destroy();
    if (downloading) window.api.cancelDownload(parsed.type, parsed.id);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
  };
  for (const b of [playBtn, muteBtn]) b.addEventListener('dblclick', (e) => e.stopPropagation());

  // ----- shared tile behaviour: hover, select, remove, resize, drag -----
  el.addEventListener('pointerenter', () => { hoveredTile = tile; hpEnter(tile); });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; hpLeave(tile); });
  el.addEventListener('click', (e) => {
    tileClick(tile, e); // with EZ play on, the .pan-shield over the embed takes the click and lands here
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
  // Player is the default: the embed loads, nothing is downloaded, and nothing needs a click.
  if (tile.webMode === 'player') load(); else setWebMode(tile.webMode, { initial: true });
  // The embed usually names the video within a second or two. If it doesn't (blocked embed, or a
  // mode that never loads one), ask yt-dlp once, purely for the title - main caches the answer, and
  // this never changes the tile's mode or starts a download.
  if (parsed.type === 'youtube') {
    setTimeout(() => {
      if (!tiles.includes(tile) || tile.title !== placeholderTitle) return;
      // one at a time: opening a session full of web tiles must not start a dozen yt-dlp processes
      titleQueue = titleQueue.then(() => {
        if (!tiles.includes(tile) || tile.title !== placeholderTitle) return null;
        return window.api.resolveStream(url).then((r) => { if (r && r.ok) setWebTitle(r.title); });
      }).catch(() => {});
    }, 3000);
  }
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
    board: null, bookmarks: [], sync: null, group: null, suppressClick: false, /* kept for older code paths */ guard: ClickGuard.create(), id: newTileId(Session.tileId(state)), volume: 0, ownMuted: false,
    galleryH: Number(state.galleryH) > 0 ? clamp(Number(state.galleryH), MIN_H, MAX_H) : layout.rowHeight,
  };
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) tile.board = { x: +sb.x, y: +sb.y, w: +sb.w, h: +sb.h };
  // a smaller copy of the picture (a Miro import keeps Miro's preview), shown while the tile is small on screen
  tile.thumb = typeof state.thumb === 'string' && state.thumb ? state.thumb : null;
  tile.crop = cleanCrop(state.crop); // the part of the picture shown (null: all of it)
  tiles.push(tile);
  el.querySelector('.name').textContent = basename(filePath);
  el.querySelector('.name').title = filePath + '\nRight-click: ' + REVEAL_LABEL;
  el.querySelector('.name').addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); sourceContext(e, 'image', filePath); });
  img.addEventListener('load', () => {
    if (tile.thumb && !tile.showingFull && img.naturalHeight > 0) tile.thumbH = img.naturalHeight * (tile.crop ? tile.crop.h : 1); // the small copy's rows that show: a crop shows only part of it, so the full one is wanted sooner
    if (img.naturalWidth > 0 && !(cropping && cropping.tile === tile)) {
      const ar = cropAspect(tile, img.naturalWidth, img.naturalHeight); // a cropped picture's shape is its crop's
      if (Math.abs(ar - tile.aspect) > 0.001) { tile.aspect = ar; if (tile.board) tile.board.w = tile.board.h * ar; layoutTiles(); }
    }
    if (pendingFit) scheduleFit();
  });
  img.src = window.api.videoUrl(tile.thumb || filePath); // the small copy first, when there is one (applyImageLod)
  applyCrop(tile);
  // cropping takes the pointer and the wheel over the picture (see beginCrop)
  el.addEventListener('pointerdown', (e) => { cropPointerDown(tile, e); }, true);
  el.addEventListener('wheel', (e) => { cropWheel(tile, e); }, { capture: true, passive: false });
  el.addEventListener('contextmenu', (e) => {
    if (!isBoard() || IS_VIEW) return;
    e.preventDefault(); e.stopPropagation();
    showRowMenu(e, [
      ['Crop…', () => beginCrop(tile)],
      [tile.crop && tile.crop.guessed ? 'Reset crop (Miro\'s crop position was guessed)' : 'Reset crop', () => resetCrop(tile), !tile.crop],
      ...stackMenuItems(tile),
      lockMenuItem(tile),
      [REVEAL_LABEL, async () => { if (!(await window.api.showInExplorer(tile.path))) setStatus('File not found: ' + tile.path); }],
      ['Remove', () => removeTile(tile)],
    ]);
  });
  el.querySelector('.remove').addEventListener('click', () => removeTile(tile));
  wireFullscreenButton(el);
  img.addEventListener('dblclick', () => toggleTileFullscreen(el));
  el.addEventListener('dblclick', (e) => tileDblClick(tile, e)); // board: the tile gets it, not the <img>
  el.addEventListener('pointerenter', () => { hoveredTile = tile; hpEnter(tile); });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; hpLeave(tile); });
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

// ---------- cropping a picture (Mark, 2026-11-06) ----------
// A picture tile can show part of its file: tile.crop = { x, y, w, h }, fractions of the file
// (null = all of it). Nothing is written to the file. Right-click a picture → Crop… : the whole
// file shows faintly around the frame; drag inside the frame to slide the picture, wheel to zoom it,
// drag a corner to change the frame's shape. Enter, Esc or a click elsewhere finishes; one undo
// step puts it back. A Miro import brings each picture's cropped shape (guessed: true, since
// Miro does not say which part the crop keeps, so the middle is shown until moved here).
const CROP_MIN = 0.02; // the smallest crop, as a share of the file's side
function cleanCrop(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  let w = clamp(n(c.w), CROP_MIN, 1), h = clamp(n(c.h), CROP_MIN, 1);
  if (!(w > 0) || !(h > 0)) return null;
  const x = clamp(n(c.x) || 0, 0, 1 - w), y = clamp(n(c.y) || 0, 0, 1 - h);
  if (w > 0.999 && h > 0.999) return null;
  return { x, y, w, h, ...(c.guessed ? { guessed: true } : {}) };
}
// the <img> sized and moved so only the crop shows through the tile
function applyCrop(tile) {
  const img = tile.img;
  if (!img) return;
  const c = tile.crop;
  img.classList.toggle('cropped', !!c);
  if (!c) { img.style.width = img.style.height = img.style.left = img.style.top = ''; return; }
  img.style.width = (100 / c.w) + '%';
  img.style.height = (100 / c.h) + '%';
  img.style.left = (-c.x / c.w * 100) + '%';
  img.style.top = (-c.y / c.h * 100) + '%';
}
// the shape a crop gives, from the file's own shape
const cropAspect = (tile, natW, natH) => (tile.crop ? (tile.crop.w * natW) / (tile.crop.h * natH) : natW / natH);

let cropping = null; // { tile, ghost, before }
function beginCrop(tile) {
  if (IS_VIEW || !isBoard() || tile.type !== 'image' || !tile.board || tile.locked) return;
  if (cropping) endCrop();
  const nat = { w: tile.img.naturalWidth || 0, h: tile.img.naturalHeight || 0 };
  if (!nat.w) { setStatus('The picture is still loading; try again in a moment'); return; }
  // bringToFront(tile); // DISABLED (Mark, 2026-11-10): lifted only while cropping, see endCrop
  liftTile(tile, true);
  selectOnly(tile);
  const ghost = document.createElement('img');
  ghost.className = 'crop-ghost';
  ghost.src = window.api.videoUrl(tile.path); // the full picture (not the small copy): it is being looked at closely
  ghost.draggable = false;
  canvas.appendChild(ghost);
  if (tile.thumb && !tile.showingFull) { tile.showingFull = true; tile.img.src = ghost.src; }
  cropping = { tile, ghost, before: { crop: tile.crop ? { ...tile.crop } : null, board: { ...tile.board }, aspect: tile.aspect } };
  tile.el.classList.add('cropping');
  placeCropGhost();
  setStatus('Crop: drag the picture to move it, wheel to zoom it, drag a corner to change the shape. Enter or Esc when done.', 8000);
}
// the faint whole picture, where it is behind the frame
function placeCropGhost() {
  if (!cropping) return;
  const { tile, ghost } = cropping;
  const c = tile.crop || { x: 0, y: 0, w: 1, h: 1 };
  const W = tile.board.w / c.w, H = tile.board.h / c.h;
  ghost.style.left = (tile.board.x - c.x * W) + 'px';
  ghost.style.top = (tile.board.y - c.y * H) + 'px';
  ghost.style.width = W + 'px';
  ghost.style.height = H + 'px';
  ghost.style.zIndex = String((Number(tile.el.style.zIndex) || 1) - 1);
}
function setCropLive(tile, c) {
  tile.crop = cleanCrop(c);
  tile.thumbH = 0; // measured again from the next small copy shown (the full one is up while cropping)
  if (tile.crop) delete tile.crop.guessed; // moved by hand: no longer a guess
  applyCrop(tile);
  placeCropGhost();
}
function endCrop(cancel = false) {
  if (!cropping) return;
  const { tile, ghost, before } = cropping;
  cropping = null;
  ghost.remove();
  tile.el.classList.remove('cropping');
  liftTile(tile, false); // back at its own layer
  if (cancel) { tile.crop = before.crop; tile.board = { ...before.board }; tile.aspect = before.aspect; applyCrop(tile); layoutTile(tile); return; }
  const after = { crop: tile.crop ? { ...tile.crop } : null, board: { ...tile.board }, aspect: tile.aspect };
  if (JSON.stringify(after) !== JSON.stringify(before)) undoStack.push({ kind: 'crop', label: `crop ${tileName(tile)}`, tile, before, after });
  scheduleOffscreen();
}
function resetCrop(tile) {
  if (!tile.crop) return;
  const before = { crop: { ...tile.crop }, board: { ...tile.board }, aspect: tile.aspect };
  const nat = { w: tile.img.naturalWidth, h: tile.img.naturalHeight };
  tile.crop = null; applyCrop(tile);
  if (nat.w && nat.h) { tile.aspect = nat.w / nat.h; tile.board.w = tile.board.h * tile.aspect; layoutTile(tile); }
  undoStack.push({ kind: 'crop', label: `uncrop ${tileName(tile)}`, tile, before, after: { crop: null, board: { ...tile.board }, aspect: tile.aspect } });
}
// Pointer and wheel while cropping. Everything is worked out against the whole picture's place
// (W x H board px, fixed while dragging), so the picture stays under the pointer.
function cropPointerDown(tile, e) {
  if (!cropping || cropping.tile !== tile) return false;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  const corner = e.target.classList.contains('handle') ? e.target.dataset.corner : null;
  const c0 = tile.crop || { x: 0, y: 0, w: 1, h: 1 };
  const b0 = { ...tile.board };
  const W = b0.w / c0.w, H = b0.h / c0.h;               // the whole picture, board px
  const ox = b0.x - c0.x * W, oy = b0.y - c0.y * H;     // and its corner
  const sx = e.clientX, sy = e.clientY;
  try { tile.el.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    const dx = (ev.clientX - sx) / board.zoom, dy = (ev.clientY - sy) / board.zoom;
    if (!corner) {
      // slide the picture under the frame: the frame stays, the crop moves the other way
      setCropLive(tile, { x: c0.x - dx / W, y: c0.y - dy / H, w: c0.w, h: c0.h });
      return;
    }
    // a corner moves the frame's edge over the still picture (never past the picture's own edge)
    let x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h;
    const minW = W * CROP_MIN, minH = H * CROP_MIN;
    if (corner.includes('l')) x0 = clamp(b0.x + dx, ox, x1 - minW); else x1 = clamp(x1 + dx, x0 + minW, ox + W);
    if (corner.includes('t')) y0 = clamp(b0.y + dy, oy, y1 - minH); else y1 = clamp(y1 + dy, y0 + minH, oy + H);
    tile.board = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    tile.aspect = tile.board.w / tile.board.h;
    setCropLive(tile, { x: (x0 - ox) / W, y: (y0 - oy) / H, w: (x1 - x0) / W, h: (y1 - y0) / H });
    layoutTile(tile);
  };
  const up = () => { tile.el.removeEventListener('pointermove', move); tile.el.removeEventListener('pointerup', up); tile.el.removeEventListener('pointercancel', up); };
  tile.el.addEventListener('pointermove', move);
  tile.el.addEventListener('pointerup', up);
  tile.el.addEventListener('pointercancel', up);
  return true;
}
function cropWheel(tile, e) {
  if (!cropping || cropping.tile !== tile) return false;
  e.preventDefault(); e.stopPropagation();
  const c = tile.crop || { x: 0, y: 0, w: 1, h: 1 };
  const f = Math.pow(1.1, clamp(-e.deltaY / 100, -3, 3)); // up: zoom the picture in (a smaller crop)
  const r = tile.el.getBoundingClientRect();
  const px = clamp((e.clientX - r.left) / r.width, 0, 1), py = clamp((e.clientY - r.top) / r.height, 0, 1);
  // keep the frame's shape: both sides of the crop shrink or grow together, about the pointer
  let w = c.w / f, h = c.h / f;
  const k = Math.min(1, 1 / w, 1 / h); w *= k; h *= k; // never past the whole picture
  if (w < CROP_MIN || h < CROP_MIN) return true;
  const fx = c.x + px * c.w, fy = c.y + py * c.h;
  setCropLive(tile, { x: fx - px * w, y: fy - py * h, w, h });
  return true;
}
window.addEventListener('keydown', (e) => { if (cropping && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); e.stopPropagation(); endCrop(); } }, true);
window.addEventListener('pointerdown', (e) => { if (cropping && !(e.target instanceof Node && cropping.tile.el.contains(e.target))) endCrop(); }, true);

// ---------- text tiles (board only) ----------
// Miro-style notes: floating text or a filled bubble. A text tile is the odd one out among tiles –
// no path, no playback, no overlay – so it carries `freeAspect` and `type: 'text'` and every piece
// of code that assumed "tile = media" checks one of those. The user sets the width; the height is
// always whatever the wrapped text needs, written back into board.h so lasso, snap, overlap
// resolution and Arrange see the real box.
const textTileTemplate = document.getElementById('tpl-text');

function addTextTile(record = {}) {
  const b = record.board;
  if (!b || !isFinite(Number(b.x)) || !isFinite(Number(b.y)) || !(Number(b.w) > 0)) return null;
  const frag = textTileTemplate.content.cloneNode(true);
  const el = frag.querySelector('.tile');
  const tile = {
    type: 'text', el, video: null, yt: null, img: null,
    text: TextTile.sanitize(record.text),
    style: TextTile.normalize(record.style),
    aspect: null, freeAspect: true, editing: false,
    // (a saved box keeps its width, however narrow: a scaled Miro board has small text; TEXT_MIN_W is for dragging)
    board: { x: Number(b.x), y: Number(b.y), w: Math.max(0.5, Number(b.w)), h: Number(b.h) > 0 ? Number(b.h) : 40 },
    bookmarks: [], sync: null, group: null, suppressClick: false, /* kept for older code paths */ guard: ClickGuard.create(), id: newTileId(Session.tileId(record)), volume: 0, ownMuted: false,
    galleryH: layout.rowHeight,
  };
  tiles.push(tile);
  const body = el.querySelector('.text-body');
  el.querySelector('.remove').addEventListener('click', () => removeTile(tile));
  el.addEventListener('pointerenter', () => { hoveredTile = tile; hpEnter(tile); });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; hpLeave(tile); });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    // a frame: its title renames it (its own listener); inside it, a new note there, as on the board
    if (tile.frame) { if (!e.target.closest('.frame-title') && isBoard() && !IS_VIEW) createTextTileAt(toCanvas(e.clientX, e.clientY)); return; }
    if (tile.links) { linksDblClick(tile, e); return; } // a bookmark block: type in the cell
    if (tile.todo) return; // a to-do list: its words are typed in with one click
    beginTextEdit(tile);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (tile.frame) { showRowMenu(e, frameMenuItems(tile)); return; }
    if (tile.links) { showRowMenu(e, linksMenuItems(tile, e)); return; }
    if (tile.todo) { showRowMenu(e, todoMenuItems(tile, e)); return; }
    showRowMenu(e, [['Edit', () => beginTextEdit(tile)], ...stackMenuItems(tile), lockMenuItem(tile), ['Remove', () => removeTile(tile)]]);
  });
  el.addEventListener('click', (e) => {
    if (isBoard() || !e.shiftKey || e.target.closest('button')) return;
    setSelected(tile, !selection.has(tile));
    selectionStatus();
  });
  // while typing, the body owns the keyboard: single-key shortcuts and Space must not reach the board
  body.addEventListener('keydown', (e) => {
    if (!tile.editing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endTextEdit(tile); return; }
    e.stopPropagation();
  });
  // Clicking the style toolbar must not end the edit: the point of it is restyling while typing.
  body.addEventListener('blur', (e) => {
    if (!tile.editing) return;
    const to = e.relatedTarget;
    if (to && to.closest && to.closest('.text-toolbar, .color-pop')) return;
    endTextEdit(tile);
  });
  for (const h of el.querySelectorAll('.handle')) {
    h.addEventListener('pointerdown', (e) => startResize(tile, h.dataset.corner, e));
    h.addEventListener('dblclick', (e) => e.stopPropagation()); // no aspect to reset to
  }
  if (record.frame) setFrame(tile, record.frame); // (2026-11-15)
  if (record.links) setLinks(tile, record.links, { render: false }); // a bookmark block (2026-11-16)
  if (record.todo) setTodo(tile, record.todo, { render: false }); // a to-do list (2026-11-17)
  attachTileDrag(tile);
  canvas.appendChild(frag);
  el.hidden = !isBoard();
  layoutTile(tile);
  // hidden elements measure 0, so in gallery mode keep the saved height until the board shows it
  if (isBoard()) renderTextTile(tile); else applyTextStyleToEl(tile);
  updateChrome();
  return tile;
}

// Re-apply the style and let the text decide the height. Called after every text, style or width
// change; cheap enough (one forced layout) to run inside a resize drag.
function renderTextTile(tile) {
  applyTextStyleToEl(tile);
  if (tile.culled) { tile.needsMeasure = true; return; } // off the page it measures nothing: done when it is back
  // a fixed box (sticky note, shape, frame) keeps its size; the text sits in it (shrunk to fit if asked)
  if (tile.style.box === 'fixed') { layoutTile(tile); if (tile.style.fit) fitTextTile(tile); return; }
  const bubble = tile.el.querySelector('.text-bubble');
  // the element is already at its board width, so offsetHeight is the wrapped height
  tile.board.h = Math.max(Math.min(BOARD_MIN_H, tile.style.size * 1.3), bubble.offsetHeight); // (small text, e.g. on a scaled Miro board, gets a box its own size)
  layoutTile(tile);
}

// the look only; the height it implies is renderTextTile's job (and needs a visible element)
function applyTextStyleToEl(tile) {
  const el = tile.el;
  const bubble = el.querySelector('.text-bubble');
  const body = el.querySelector('.text-body');
  const s = tile.style;
  if (body.textContent !== tile.text) body.textContent = tile.text;
  body.style.fontFamily = s.font;
  body.style.fontSize = s.size + 'px';
  body.style.color = s.color;
  body.style.textAlign = s.align;
  body.style.lineHeight = String(s.lineHeight || 1.25); // (1.25 for Ozy's own notes; a Miro text: 1.4)
  // the whole text bold / italic / underlined / struck through (Miro imports, 2026-11-10)
  body.style.fontWeight = s.bold ? '700' : '';
  body.style.fontStyle = s.italic ? 'italic' : '';
  body.style.textDecoration = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  // (2026-11-15) a triangle, diamond, star...: its outline is an SVG behind the text, stretched to the box
  const poly = s.bubble && TextTile.SHAPES[s.shape];
  let bg = el.querySelector(':scope > .shape-bg');
  if (poly) {
    if (!bg) {
      bg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      bg.setAttribute('class', 'shape-bg'); bg.setAttribute('viewBox', '0 0 100 100'); bg.setAttribute('preserveAspectRatio', 'none');
      bg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'polygon'));
      el.insertBefore(bg, el.firstChild);
    }
    const pg = bg.firstChild;
    pg.setAttribute('points', poly);
    pg.style.fill = s.fill;
    pg.style.stroke = s.outlineWidth > 0 ? s.outline : 'none';
    pg.style.strokeWidth = s.outlineWidth + 'px';
    bg.style.filter = s.shadow ? 'drop-shadow(0 4px 6px rgba(0,0,0,0.28))' : '';
  } else if (bg) bg.remove();
  bubble.style.background = s.bubble && !poly ? s.fill : 'transparent';
  bubble.style.border = s.bubble && !poly && s.outlineWidth > 0 ? `${s.outlineWidth}px solid ${s.outline}` : 'none';
  // (2026-11-06) corner rounding, an ellipse, padding, a shadow and, in a fixed box, where the text sits
  bubble.style.borderRadius = s.shape === 'ellipse' ? '50%' : s.radius + 'px';
  bubble.style.padding = s.bubble ? s.padding + 'px' : '0';
  bubble.style.boxShadow = s.shadow && !poly ? '0 4px 10px rgba(0,0,0,0.28)' : 'none';
  const fixed = s.box === 'fixed';
  el.classList.toggle('text-fixed', fixed);
  bubble.style.justifyContent = fixed ? ({ top: 'flex-start', middle: 'center', bottom: 'flex-end' }[s.valign] || 'flex-start') : '';
  if (fixed && s.fit && tile.fitSize) body.style.fontSize = tile.fitSize + 'px';
}
// A sticky note's text: as big as its style says, smaller until it fits inside the note.
function fitTextTile(tile) {
  const bubble = tile.el.querySelector('.text-bubble');
  const body = tile.el.querySelector('.text-body');
  if (!tile.el.isConnected || tile.el.hidden) return;
  const pad = tile.style.bubble ? tile.style.padding * 2 : 0;
  const availH = tile.board.h - pad, availW = tile.board.w - pad;
  const fits = (px) => { body.style.fontSize = px + 'px'; return body.scrollHeight <= availH + 1 && body.scrollWidth <= availW + 1; };
  let lo = 6, hi = Math.max(6, tile.style.size);
  if (fits(hi)) lo = hi;
  else { for (let i = 0; i < 9 && hi - lo > 0.5; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; } }
  tile.fitSize = Math.floor(lo * 2) / 2;
  body.style.fontSize = tile.fitSize + 'px';
  void bubble;
}

function beginTextEdit(tile) {
  if (IS_VIEW) return;
  if (!isBoard() || tile.editing || tile.locked || tile.frame || tile.links || tile.todo) return;
  for (const t of tiles) if (t !== tile && t.editing) endTextEdit(t); // only one at a time
  tile.editing = true;
  tile.el.classList.add('editing');
  // bringToFront(tile); // DISABLED (Mark, 2026-11-10): editing text keeps it at its layer
  const body = tile.el.querySelector('.text-body');
  tile._textBefore = tile.text;
  body.contentEditable = 'plaintext-only';
  body.focus();
  // caret at the end, so typing continues the note rather than replacing it
  const sel = window.getSelection();
  if (sel) { const r = document.createRange(); r.selectNodeContents(body); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
  updateTextToolbar();
}

function endTextEdit(tile) {
  if (!tile.editing) return;
  tile.editing = false;
  tile.el.classList.remove('editing');
  const body = tile.el.querySelector('.text-body');
  const before = tile._textBefore;
  tile.text = TextTile.sanitize(body.textContent);
  body.contentEditable = 'false';
  try { body.blur(); } catch {}
  // An empty note is no note, like Miro. One that was never finished isn't worth an undo step.
  // if (!tile.text) { removeTile(tile, { record: !tile.isNew }); return; } // DISABLED (Mark, 2026-11-15): empty shapes and notes stay
  if (!tile.text && !(tile.style.bubble && tile.style.box === 'fixed')) { removeTile(tile, { record: !tile.isNew }); return; }
  renderTextTile(tile);
  // a brand new note is one undo step ("add"), not "add" plus "edit text"
  if (tile.isNew) { tile.isNew = false; recordAdd([tile]); } else recordTextEdit(tile, before, tile.text);
  updateTextToolbar();
}

// A new tile at a point on the board, straight into edit mode.
function createTextTileAt(world) {
  const style = layout.background === 'light' ? { ...TextTile.DEFAULTS, color: '#1a1a1a' } : TextTile.DEFAULTS; // readable on a light board
  const tile = addTextTile({ text: '', style, board: { x: world.x, y: world.y, w: TEXT_DEFAULT_W, h: 40 } });
  if (!tile) return null;
  tile.isNew = true; // the undo entry is pushed once there is something in it (see endTextEdit)
  bringToFront(tile);
  selectOnly(tile);
  beginTextEdit(tile);
  return tile;
}
function viewCentreWorld() {
  const r = gridRect();
  return toCanvas(r.left + r.width / 2, r.top + r.height / 2);
}

document.getElementById('add-text').addEventListener('click', () => {
  if (!isBoard()) { setStatus('Text tiles live on the board – switch to Board mode'); return; }
  const c = viewCentreWorld();
  createTextTileAt({ x: c.x - TEXT_DEFAULT_W / 2, y: c.y });
});
// double-click empty board space makes a note there
grid.addEventListener('dblclick', (e) => {
  if (!isBoard() || IS_VIEW) return;
  if (e.target !== grid && e.target !== canvas && !lockedTileAt(e.target)) return; // not on a tile (a locked one is board)
  e.preventDefault();
  createTextTileAt(toCanvas(e.clientX, e.clientY));
});

// ---------- shapes, sticky notes, duplicate, rotate (Mark, 2026-11-15) ----------
// Shapes and sticky notes are text tiles in a fixed box (lib/texttile.js SHAPES draws the outline
// of the ones that are not a box or an ellipse). The ◇ Shapes menu puts one in the middle of the
// view; N puts a sticky note under the mouse and starts typing in it. Ctrl+D duplicates the
// selection. A selected tile gets a round handle above it that turns it (Shift: 15° steps; it
// settles on level within 3°).
const SHAPE_KINDS = [['box', 'Rectangle'], ['round', 'Rounded rectangle'], ['ellipse', 'Circle'], ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'], ['star', 'Star'], ['arrow', 'Arrow'], ['parallelogram', 'Parallelogram']];
// a new shape's look: drawn at the size it should have on screen now
function shapeLook(kind) {
  const z = board.zoom, dark = layout.background !== 'light';
  return TextTile.normalize({
    font: 'Segoe UI', size: 18 / z, color: dark ? '#e8e8ea' : '#1a1a1a', align: 'center', valign: 'middle',
    bubble: true, fill: dark ? '#2b2b31' : '#ffffff', outline: dark ? '#cfcfd4' : '#1a1a1a', outlineWidth: 2 / z,
    box: 'fixed', shape: kind === 'round' ? 'box' : kind, radius: kind === 'round' ? 18 / z : 0, padding: 10 / z,
  });
}
function noteLook(fill) {
  const z = board.zoom;
  return TextTile.normalize({
    font: 'Segoe UI', size: 28 / z, color: fill === '#000000' ? '#ffffff' : '#1a1a1a', align: 'center', valign: 'middle',
    bubble: true, fill: fill || TextTile.NOTE_COLORS[0], outline: '#00000000', outlineWidth: 0,
    box: 'fixed', fit: true, shadow: true, radius: 2 / z, padding: 14 / z,
  });
}
let lastNoteColor = TextTile.NOTE_COLORS[0];
// where a new thing goes: under the mouse when it is over the board, else the middle of the view
function placePoint() { return pointerOverBoard && lastPointer ? toCanvas(lastPointer.clientX, lastPointer.clientY) : viewCentreWorld(); }
function addShapeAt(kind, at = viewCentreWorld()) {
  if (!isBoard() || IS_VIEW) { setStatus('Shapes live on the board – switch to Board mode'); return null; }
  const note = kind === 'note';
  const side = (note ? 200 : 160) / board.zoom;
  const w = kind === 'arrow' || kind === 'parallelogram' ? side * 1.4 : side;
  const style = note ? noteLook(lastNoteColor) : shapeLook(kind);
  const tile = addTextTile({ text: '', style, board: { x: at.x - w / 2, y: at.y - side / 2, w, h: side } });
  if (!tile) return null;
  bringToFront(tile);
  selectOnly(tile);
  if (note) { tile.isNew = true; beginTextEdit(tile); } // a note is for writing in: straight into typing
  else recordAdd([tile], 'add ' + (SHAPE_KINDS.find((k) => k[0] === kind) || [0, 'shape'])[1].toLowerCase());
  updateChrome(); markOnBoard();
  return tile;
}
function openShapesMenu(anchor) {
  const at = menuAt(anchor); // (beside the left rail)
  showRowMenu(at, [
    ['Sticky note  (N)', () => addShapeAt('note')],
    ['Frame', () => addFrame()],
    ...SHAPE_KINDS.map(([k, label]) => [label, () => addShapeAt(k)]),
  ]);
}
document.getElementById('add-shape').addEventListener('click', (e) => openShapesMenu(e.currentTarget));

// Ctrl+D: a copy of every selected tile, a little down and to the right, selected instead
function duplicateSelection() {
  if (!isBoard() || IS_VIEW) return;
  const all = collectSession().videos;
  const picked = tiles.map((t, i) => i).filter((i) => selection.has(tiles[i]) && tiles[i].board && !tiles[i].locked);
  if (!picked.length) { setStatus('Select something to duplicate'); return; }
  const d = 24 / board.zoom;
  const added = [];
  for (const i of picked) {
    const v = all[i];
    const t = buildFromRecord({ ...Session.openRecord(v), id: undefined, sync: null, locked: undefined, favorite: undefined, z: undefined, ends: undefined, board: { ...v.board, x: v.board.x + d, y: v.board.y + d } });
    if (t) added.push(t);
  }
  if (!added.length) return;
  clearSelection();
  for (const t of added) { if (!t.board) placeOnBoard([t]); bringToFront(t); setSelected(t, true); }
  layoutTiles();
  recordAdd(added, `duplicate ${added.length === 1 ? tileName(added[0]) : added.length + ' tiles'}`);
  updateChrome(); markOnBoard();
  setStatus(`Duplicated ${added.length} tile${added.length === 1 ? '' : 's'}`, 2500);
}

// ---- the turn handle: one, over the board, for the one selected tile ----
const rotHandle = document.createElement('div');
rotHandle.className = 'rotate-handle';
rotHandle.title = 'Drag to turn (Shift: 15° steps). Double-click: level again';
rotHandle.hidden = true;
grid.appendChild(rotHandle);
const rotatable = (t) => t && t.board && t.type !== 'line' && !t.locked && !t.editing;
function rotTarget() { if (!isBoard() || IS_VIEW || selection.size !== 1) return null; const t = [...selection][0]; return tiles.includes(t) && rotatable(t) && !(cropping && cropping.tile === t) ? t : null; }
function updateRotateHandle() {
  const t = rotTarget();
  if (!t) { rotHandle.hidden = true; return; }
  const b = t.board, a = (t.rotation || 0) * Math.PI / 180;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, off = b.h / 2 + 26 / board.zoom;
  const x = cx + Math.sin(a) * off, y = cy - Math.cos(a) * off;
  rotHandle.style.left = (x * board.zoom + board.panX) + 'px';
  rotHandle.style.top = (y * board.zoom + board.panY) + 'px';
  rotHandle.hidden = false;
}
rotHandle.addEventListener('pointerdown', (e) => {
  const t = rotTarget();
  if (!t || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  try { rotHandle.setPointerCapture(e.pointerId); } catch {}
  const before = shapeState(t);
  const b = t.board, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  document.body.classList.add('rotating');
  const onMove = (ev) => {
    const p = toCanvas(ev.clientX, ev.clientY);
    let deg = Math.atan2(p.x - cx, -(p.y - cy)) * 180 / Math.PI;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    else for (const k of [-180, -90, 0, 90, 180]) if (Math.abs(deg - k) < 3) deg = k;
    t.rotation = ((deg % 360) + 360) % 360;
    if (t.rotation < 0.05 || t.rotation > 359.95) t.rotation = 0;
    layoutTile(t);
    updateRotateHandle();
    setStatus(`Turned ${Math.round(t.rotation)}°`, 1500);
  };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    activeInteractions.delete(onUp);
    rotHandle.removeEventListener('pointermove', onMove);
    rotHandle.removeEventListener('pointerup', onUp);
    rotHandle.removeEventListener('pointercancel', onUp);
    rotHandle.removeEventListener('lostpointercapture', onUp);
    document.body.classList.remove('rotating');
    recordStates('turn ' + tileName(t), [t], [before]);
  };
  rotHandle.addEventListener('pointermove', onMove);
  rotHandle.addEventListener('pointerup', onUp);
  rotHandle.addEventListener('pointercancel', onUp);
  rotHandle.addEventListener('lostpointercapture', onUp);
  activeInteractions.add(onUp);
});
rotHandle.addEventListener('dblclick', (e) => {
  e.stopPropagation();
  const t = rotTarget();
  if (!t || !t.rotation) return;
  const before = shapeState(t);
  t.rotation = 0; layoutTile(t); updateRotateHandle();
  recordStates('level ' + tileName(t), [t], [before]);
});

// ---------- frames (Mark, 2026-11-15) ----------
// A frame is a box (a fixed text tile with tile.frame = { title }) that holds what lies on it:
// dragging it by its title moves everything whose middle is inside it, and pressing inside it is
// pressing on the board (the lasso), as in Miro. Its title sits just above it at one size on screen;
// double-click the title to rename it. The ▣ Frames menu lists them and flies to one; Present steps
// through them in order (← → or Page Up / Down, Esc ends).
function setFrame(tile, frame) {
  tile.frame = frame ? { title: String(frame.title || '').slice(0, 200) } : null;
  tile.el.classList.toggle('is-frame', !!tile.frame);
  let pin = tile.el.querySelector(':scope > .frame-title-pin');
  if (!tile.frame) { if (pin) pin.remove(); return; }
  if (!pin) {
    pin = document.createElement('div'); pin.className = 'frame-title-pin';
    const t = document.createElement('div'); t.className = 'frame-title';
    t.title = 'Drag to move the frame and what is in it. Double-click to rename';
    t.addEventListener('dblclick', (e) => { e.stopPropagation(); renameFrame(tile); });
    pin.appendChild(t); tile.el.appendChild(pin);
  }
  pin.firstChild.textContent = tile.frame.title || 'Frame';
}
const frameTiles = () => tiles.filter((t) => t.frame && t.board);
// what a frame holds: every unlocked tile whose middle is inside it
function frameContents(f) {
  const b = f.board;
  return tiles.filter((t) => t !== f && t.board && !t.locked && (() => { const cx = t.board.x + t.board.w / 2, cy = t.board.y + t.board.h / 2; return cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h; })());
}
// the frame a press landed on, when it was on the frame itself and not its title
function frameBodyAt(target) {
  if (!target || !target.closest || target.closest('button, input, select, textarea, .handle, .frame-title')) return null;
  const el = target.closest('.tile.is-frame');
  const t = el && tiles.find((x) => x.el === el);
  return t && t.board && !t.editing ? t : null;
}
function renameFrame(tile) {
  if (IS_VIEW || !tile.frame || tile.locked) return;
  const el = tile.el.querySelector('.frame-title');
  const before = tile.frame.title;
  el.contentEditable = 'plaintext-only';
  el.focus();
  try { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch {}
  const done = (keep) => {
    el.removeEventListener('keydown', onKey); el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    const title = keep ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : before;
    setFrame(tile, { title });
    if (title !== before) undoStack.push({ kind: 'frame-title', label: 'rename frame', tile, before, after: title });
  };
  const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); el.blur(); } else if (e.key === 'Escape') { e.preventDefault(); done(false); } };
  const onBlur = () => done(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}
function frameLook() {
  const dark = layout.background !== 'light';
  return TextTile.normalize({ font: 'Segoe UI', size: 14 / board.zoom, color: dark ? '#e8e8ea' : '#1a1a1a', align: 'left', valign: 'top', bubble: true, fill: dark ? '#26262b' : '#ffffff', outline: dark ? '#ffffff22' : '#00000022', outlineWidth: 1 / board.zoom, box: 'fixed', radius: 0, padding: 12 / board.zoom });
}
const nextFrameName = () => `Frame ${frameTiles().length + 1}`;
// a new frame: around the selection (just behind it), or 16:9 in the middle of the view (at the back)
function addFrame({ aroundSelection = false } = {}) {
  if (!isBoard() || IS_VIEW) return null;
  const sel = [...selection].filter((t) => tiles.includes(t) && t.board);
  let box;
  if (aroundSelection && sel.length) {
    const bb = boardBounds(sel), pad = 40 / board.zoom;
    box = { x: bb.minX - pad, y: bb.minY - pad, w: bb.w + 2 * pad, h: bb.h + 2 * pad };
  } else {
    const c = viewCentreWorld(), w = 800 / board.zoom, h = 450 / board.zoom;
    box = { x: c.x - w / 2, y: c.y - h / 2, w, h };
  }
  const tile = addTextTile({ text: '', style: frameLook(), board: box });
  if (!tile) return null;
  setFrame(tile, { title: nextFrameName() });
  if (aroundSelection && sel.length) {
    // just behind the lowest of what it holds: same layer, one place under it
    const low = sel.slice().sort((a, b) => stackKey(a) - stackKey(b))[0];
    tile.z = low.z != null ? low.z : null;
    tiles.splice(tiles.indexOf(tile), 1); tiles.splice(tiles.indexOf(low), 0, tile);
    canvas.insertBefore(tile.el, low.el);
    layoutTile(tile);
  } else sendToBack(tile);
  selectOnly(tile);
  recordAdd([tile], 'add frame');
  updateChrome(); markOnBoard();
  setStatus('Frame added – drag it by its title; double-click the title to rename it', 5000);
  return tile;
}
// in reading order: top to bottom, and left to right along a row
function framesInOrder() {
  const fs = frameTiles();
  if (!fs.length) return [];
  const rowH = Math.min(...fs.map((f) => f.board.h)) / 2;
  return fs.slice().sort((a, b) => (Math.abs(a.board.y - b.board.y) > rowH ? a.board.y - b.board.y : a.board.x - b.board.x));
}
function flyToFrame(f) {
  const r = gridRect();
  flyTo(Favorites.camera(f.board, { w: r.width, h: r.height }, { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }));
}
let presenting = null; // { list, i }
function presentFrames(start = 0) {
  const list = framesInOrder();
  if (!list.length) { setStatus('No frames on this board yet – ◇ ▾ → Frame'); return; }
  presenting = { list, i: Math.max(0, Math.min(start, list.length - 1)) };
  document.body.classList.add('presenting');
  clearSelection();
  showPresented();
}
function showPresented() {
  const f = presenting.list[presenting.i];
  flyToFrame(f);
  setStatus(`${f.frame.title || 'Frame'} – ${presenting.i + 1} of ${presenting.list.length}  (← → to move, Esc to stop)`, 0);
}
function stopPresenting() { presenting = null; document.body.classList.remove('presenting'); setStatus('', 1); }
window.addEventListener('keydown', (e) => {
  if (!presenting) return;
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); stopPresenting(); return; }
  const step = k === 'ArrowRight' || k === 'PageDown' || k === ' ' ? 1 : k === 'ArrowLeft' || k === 'PageUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault(); e.stopPropagation();
  presenting.i = Math.max(0, Math.min(presenting.list.length - 1, presenting.i + step));
  showPresented();
}, true);
function openFramesMenu(anchor) {
  const list = framesInOrder();
  showRowMenu(menuAt(anchor), [
    ['Present  (← → step, Esc ends)', () => presentFrames(0), !list.length],
    ['New frame', () => addFrame(), !isBoard() || IS_VIEW],
    ['Frame around the selection', () => addFrame({ aroundSelection: true }), !selection.size || !isBoard() || IS_VIEW],
    ['Export the view as a picture (PNG)…', () => exportView(), !isBoard()],
    ['Export the frames as one PDF…', () => exportFrames('pdf'), !list.length],
    ['Export each frame as a picture (PNG)…', () => exportFrames('pngs'), !list.length],
    [miniOn ? 'Hide the overview map  (M)' : 'Show the overview map  (M)', () => setMiniMap(!miniOn)],
    ...list.map((f, i) => [`${i + 1}. ${f.frame.title || 'Frame'}`, () => flyToFrame(f)]),
  ]);
}
document.getElementById('btn-frames').addEventListener('click', (e) => openFramesMenu(e.currentTarget));
function frameMenuItems(tile) {
  return [
    ['Rename', () => renameFrame(tile)],
    ['Present from here', () => presentFrames(framesInOrder().indexOf(tile))],
    ['Select what is in it', () => { clearSelection(); for (const t of frameContents(tile)) setSelected(t, true); selectionStatus(); }],
    ...stackMenuItems(tile),
    lockMenuItem(tile),
    ['Remove the frame (keep what is in it)', () => removeTile(tile)],
  ];
}

// ---------- find, export, the overview map (Mark, 2026-11-15) ----------
// Ctrl+F: a box over the board; what is typed is looked for in every text, note, shape, frame
// title and picture's file name. Enter flies to the next one (Shift+Enter: back), Esc closes.
const findBox = document.createElement('div');
findBox.className = 'find-box';
findBox.hidden = true;
const findInput = document.createElement('input');
findInput.type = 'text'; findInput.placeholder = 'Find on the board'; findInput.spellcheck = false;
const findCount = document.createElement('span');
findCount.className = 'find-count';
findBox.append(findInput, findCount);
findBox.addEventListener('pointerdown', (e) => e.stopPropagation());
grid.appendChild(findBox);
let findHits = [], findAt = -1;
const findText = (t) => (t.type === 'text' ? (t.frame ? t.frame.title + ' ' : '') + t.text : t.type === 'line' ? '' : (t.title || '') + ' ' + basename(t.path || ''));
function runFind() {
  const q = findInput.value.trim().toLowerCase();
  findHits = q ? tiles.filter((t) => t.board && findText(t).toLowerCase().includes(q)).sort((a, b) => (a.board.y - b.board.y) || (a.board.x - b.board.x)) : [];
  findAt = -1;
  findCount.textContent = q ? (findHits.length ? `${findHits.length} found` : 'none') : '';
}
function findStep(dir) {
  if (!findHits.length) return;
  findAt = (findAt + dir + findHits.length) % findHits.length;
  const t = findHits[findAt];
  const r = gridRect();
  flyTo(Favorites.camera(t.board, { w: r.width, h: r.height }, { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, fill: 0.35 }));
  selectOnly(t);
  findCount.textContent = `${findAt + 1} of ${findHits.length}`;
}
function openFind() {
  if (!isBoard()) { setStatus('Find works on the board'); return; }
  findBox.hidden = false;
  findInput.focus(); findInput.select();
}
function closeFind() { findBox.hidden = true; findInput.blur(); }
findInput.addEventListener('input', runFind);
findInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); if (findAt < 0 && !findHits.length) runFind(); findStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});

// ---- export: the view, or every frame, as pictures or one PDF ----
// What is on screen is photographed (the window's own drawing, at the screen's pixels): for a
// frame, the view first fits that frame and waits for its pictures to load at full size.
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const baseName = () => (sessionPath ? basename(sessionPath).replace(/\.mvp$/i, '') : 'Ozy board');
async function photographRect(rect) {
  document.body.classList.add('exporting');
  await nextFrame();
  try { return await window.api.captureRect(rect); } finally { document.body.classList.remove('exporting'); }
}
async function picturesSettled(list, ms = 4000) {
  const t0 = Date.now();
  scheduleOffscreen();
  await new Promise((r) => setTimeout(r, 400));
  while (Date.now() - t0 < ms) {
    if (list.every((t) => !t.img || (t.img.complete && t.img.naturalWidth > 0))) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function exportView() {
  if (!isBoard()) { setStatus('Export works on the board'); return; }
  const g = grid.getBoundingClientRect();
  const png = await photographRect({ x: g.left, y: g.top, w: g.width, h: g.height });
  const out = await window.api.saveExport({ kind: 'png', name: baseName() + ' – view.png', pages: [png] });
  if (out) setStatus('Saved ' + out, 5000);
}
async function exportFrames(kind) {
  const list = framesInOrder();
  if (!list.length) { setStatus('No frames to export – ▣ Frames ▾ → New frame'); return; }
  const cam0 = { zoom: board.zoom, panX: board.panX, panY: board.panY };
  const sel = [...selection];
  clearSelection();
  const pages = [];
  try {
    for (const [i, f] of list.entries()) {
      setStatus(`Exporting frame ${i + 1} of ${list.length}…`, 0);
      const g = grid.getBoundingClientRect();
      const cam = Favorites.camera(f.board, { w: g.width, h: g.height }, { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, fill: 0.98 });
      board.zoom = cam.zoom; board.panX = cam.panX; board.panY = cam.panY;
      applyBoardView(); setUiScaleNow();
      await picturesSettled(frameContents(f));
      const x0 = Math.max(g.left, g.left + f.board.x * board.zoom + board.panX), y0 = Math.max(g.top, g.top + f.board.y * board.zoom + board.panY);
      const x1 = Math.min(g.right, g.left + (f.board.x + f.board.w) * board.zoom + board.panX), y1 = Math.min(g.bottom, g.top + (f.board.y + f.board.h) * board.zoom + board.panY);
      pages.push({ png: await photographRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), name: f.frame.title || `Frame ${i + 1}` });
    }
  } finally {
    board.zoom = cam0.zoom; board.panX = cam0.panX; board.panY = cam0.panY;
    applyBoardView();
    for (const t of sel) if (tiles.includes(t)) setSelected(t, true);
  }
  const out = await window.api.saveExport({ kind, name: baseName() + (kind === 'pdf' ? '.pdf' : ''), pages: pages.map((p) => p.png), names: pages.map((p) => p.name) });
  setStatus(out ? 'Saved ' + out : 'Export cancelled', 5000);
}

// ---- the overview map: the whole board small in a corner, the view on it; click or drag to go ----
const miniMap = document.createElement('canvas');
miniMap.className = 'mini-map';
miniMap.width = 220; miniMap.height = 150;
miniMap.hidden = true; // (until it is turned on: M)
miniMap.title = 'The whole board: click or drag to go there (M to hide)';
grid.appendChild(miniMap);
let miniOn = false;
try { miniOn = localStorage.getItem('ozy.minimap') === '1'; } catch {}
let miniFrame = 0, miniMap0 = null; // the mapping last drawn: board -> map pixels
function setMiniMap(on) {
  miniOn = !!on;
  { const b = document.getElementById('btn-map'); if (b) b.classList.toggle('toggled', miniOn); }
  try { localStorage.setItem('ozy.minimap', miniOn ? '1' : '0'); } catch {}
  drawMiniMap();
}
function drawMiniMap() {
  miniMap.hidden = !(miniOn && isBoard() && tiles.some((t) => t.board));
  if (miniMap.hidden || miniFrame) return;
  miniFrame = requestAnimationFrame(() => {
    miniFrame = 0;
    const W = miniMap.width, H = miniMap.height, pad = 6;
    const bb = boardBounds(tiles.filter((t) => t.board));
    if (!bb) return;
    const k = Math.min((W - 2 * pad) / Math.max(1, bb.w), (H - 2 * pad) / Math.max(1, bb.h));
    const ox = pad + ((W - 2 * pad) - bb.w * k) / 2 - bb.minX * k, oy = pad + ((H - 2 * pad) - bb.h * k) / 2 - bb.minY * k;
    miniMap0 = { k, ox, oy };
    const c = miniMap.getContext('2d');
    const light = layout.background === 'light';
    c.clearRect(0, 0, W, H);
    c.fillStyle = light ? 'rgba(255,255,255,0.92)' : 'rgba(24,24,28,0.92)';
    c.fillRect(0, 0, W, H);
    for (const t of tiles) {
      if (!t.board) continue;
      const b = t.board;
      c.fillStyle = t.frame ? (light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)') : t.type === 'line' ? 'rgba(120,120,130,0.8)' : t.type === 'text' ? (light ? 'rgba(200,170,40,0.55)' : 'rgba(255,220,90,0.5)') : (light ? 'rgba(60,60,70,0.55)' : 'rgba(200,200,210,0.5)');
      c.fillRect(ox + b.x * k, oy + b.y * k, Math.max(1, b.w * k), Math.max(1, b.h * k));
    }
    const g = gridRect();
    const vx = -board.panX / board.zoom, vy = -board.panY / board.zoom;
    c.strokeStyle = '#4f8cff'; c.lineWidth = 1.5;
    c.strokeRect(ox + vx * k, oy + vy * k, (g.width / board.zoom) * k, (g.height / board.zoom) * k);
  });
}
function miniGo(e) {
  if (!miniMap0) return;
  const r = miniMap.getBoundingClientRect();
  const x = ((e.clientX - r.left) * (miniMap.width / r.width) - miniMap0.ox) / miniMap0.k;
  const y = ((e.clientY - r.top) * (miniMap.height / r.height) - miniMap0.oy) / miniMap0.k;
  const g = gridRect();
  board.panX = g.width / 2 - x * board.zoom; board.panY = g.height / 2 - y * board.zoom;
  applyBoardView();
}
miniMap.addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  try { miniMap.setPointerCapture(e.pointerId); } catch {}
  miniGo(e);
  const move = (ev) => miniGo(ev);
  const up = () => { miniMap.removeEventListener('pointermove', move); miniMap.removeEventListener('pointerup', up); miniMap.removeEventListener('lostpointercapture', up); };
  miniMap.addEventListener('pointermove', move);
  miniMap.addEventListener('pointerup', up);
  miniMap.addEventListener('lostpointercapture', up);
});
miniMap.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
setInterval(() => { if (miniOn) drawMiniMap(); }, 1500); // (things added, moved, removed)

// ---------- the floating panels (Mark, 2026-11-15) ----------
// index.html lays the toolbar out as panels over the board; here every button with data-icon gets
// its icon (drawn here: no icon font can be downloaded), the board's name follows the file, the
// zoom − / + and map buttons work, and menus opened from the left rail open beside it.
const ICON_PATHS = {
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1.2a6 6 0 0 1-4.6-2.2L3.8 14.6a1.5 1.5 0 0 1 2.3-1.9L8 15',
  media: 'M12 5v14M5 12h14',
  text: 'M5 7V5h14v2M12 5v14M9 19h6',
  shapes: 'M4 13h7v7H4zM14.5 7.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M8 3l3.5 6h-7z',
  line: 'M5 19L19 5',
  pen: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  frame: 'M8 3v18M16 3v18M3 8h18M3 16h18',
  folders: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  play: 'M8 5v14l11-7z',
  pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
  loop: 'M17 2l3 3-3 3M3 11V9a4 4 0 0 1 4-4h13M7 22l-3-3 3-3M21 13v2a4 4 0 0 1-4 4H4',
  hover: 'M6 3l5 15 2-6 6-2zM14 14l5 5',
  tap: 'M9 11l5 10 1.5-4 4-1.5zM4 4l2 2M9 2v3M2 9h3M14 4l-2 2',
  volume: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  muted: 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6',
  gallery: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  board: 'M3 5h18v12H3zM8 21l4-4 4 4',
  group: 'M7 7h6v6H7zM11 11h6v6h-6zM3 7V3h4M21 7V3h-4M3 17v4h4M21 17v4h-4',
  ungroup: 'M4 4h7v7H4zM13 13h7v7h-7z',
  ab: 'M12 3v18M4 6h5v12H4zM15 6h5v12h-5z',
  tidy: 'M4 4h7v5H4zM13 4h7v9h-7zM4 11h7v9H4zM13 15h7v5h-7z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1M3 7v10a2 2 0 0 0 2 2h12l3-8H7l-4 8',
  save: 'M5 4h11l4 4v12H5zM8 4v5h7V4M8 20v-6h8v6',
  saveas: 'M5 4h11l4 4v4M5 4v16h7M8 4v5h7V4M18 15v6M15 18h6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  window: 'M3 6h13v10H3zM8 16v3h13V9h-5',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  chart: 'M5 20V11M11 20V5M17 20v-7M3 20h18',
  chevron: 'M6 9l6 6 6-6',
  front: 'M12 19V6M6 11l6-6 6 6M5 21h14',
  back: 'M12 5v13M6 13l6 6 6-6M5 3h14',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  crop: 'M6 2v16h16M2 6h16v16',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  remove: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  close: 'M6 6l12 12M18 6L6 18',
  bookmark: 'M6 3h12v18l-6-4.5L6 21z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M15.3 15.3L20 20',
  photosearch: 'M20 10V5H4v14h7M4 15l4-4 3.5 3.5M14 8.5a.5.5 0 1 0 0 .01M17 13a3 3 0 1 0 0 6a3 3 0 1 0 0-6M19.2 18.2L21.5 20.5',
  checklist: 'M3.5 6.5l1.5 1.5 3-3M3.5 12.5l1.5 1.5 3-3M3.5 18.5l1.5 1.5 3-3M11 6.5h9.5M11 12.5h9.5M11 18.5h9.5',
};
function iconSvg(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICON_PATHS[name] || '');
  svg.appendChild(p);
  return svg;
}
for (const b of document.querySelectorAll('[data-icon]')) {
  b.prepend(iconSvg(b.dataset.icon));
  if (b.title && !b.getAttribute('aria-label')) b.setAttribute('aria-label', b.title.split(/[:(.;]| – /)[0].trim());
}
// the mute button: a speaker, and a crossed-out one shown once everything is muted
{
  const m = document.getElementById('btn-mute-all');
  const on = iconSvg('volume'); on.classList.add('ic-mute');
  const off = iconSvg('muted'); off.classList.add('ic-unmute');
  m.append(on, off);
  m.setAttribute('aria-label', 'Mute all');
}
function updateBoardName() {
  const el = document.getElementById('board-name');
  if (el) el.textContent = IS_VIEW ? `View ${window.OZY_VIEW}` : sessionPath ? basename(sessionPath).replace(/\.mvp$/i, '') : 'Untitled board';
}
document.getElementById('board-name').addEventListener('click', (e) => { e.stopPropagation(); if (IS_VIEW) return; const r = document.getElementById('btn-open-recent'); if (!r.hidden) r.click(); else document.getElementById('btn-open').click(); });
document.getElementById('zoom-in').addEventListener('click', () => { if (isBoard()) zoomAtCenter(board.zoom * 1.25); else { noteGalleryScaleChange(); scaleGallery(1.15); } });
document.getElementById('zoom-out').addEventListener('click', () => { if (isBoard()) zoomAtCenter(board.zoom / 1.25); else { noteGalleryScaleChange(); scaleGallery(1 / 1.15); } });
document.getElementById('btn-map').addEventListener('click', () => { setMiniMap(!miniOn); document.getElementById('btn-map').classList.toggle('toggled', miniOn); });
// where a menu opened from a toolbar button goes: beside the left rail, else under the button
function menuAt(anchor) {
  const r = anchor.getBoundingClientRect();
  return anchor.closest('.hud-rail') ? { clientX: r.right + 10, clientY: r.top } : { clientX: r.left, clientY: r.bottom + 6 };
}

// ---- the selection bar: what can be done to the selected pictures and videos ----
// Over the selection, as the text and line bars are over theirs (shown when neither of those is):
// to the front or back, lock, crop (one picture), duplicate, a frame around them, group, remove.
const selBar = document.createElement('div');
selBar.className = 'sel-bar';
selBar.hidden = true;
selBar.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
document.body.appendChild(selBar);
const selPicked = () => [...selection].filter((t) => tiles.includes(t) && t.board);
const SEL_ACTIONS = [
  ['front', 'Bring to front (PgUp)', () => stackToFront(null), (l) => l.length > 0],
  ['back', 'Send to back (PgDn)', () => stackToBack(null), (l) => l.length > 0],
  ['lock', 'Lock / unlock (Ctrl+Shift+L)', () => toggleLock(null), (l) => l.length > 0],
  ['crop', 'Crop the picture', () => { const t = selPicked()[0]; if (t) beginCrop(t); }, (l) => l.length === 1 && l[0].type === 'image' && !l[0].locked],
  ['copy', 'Duplicate (Ctrl+D)', () => duplicateSelection(), (l) => l.some((t) => !t.locked)],
  ['frame', 'Put a frame around them', () => addFrame({ aroundSelection: true }), (l) => l.length > 0],
  ['group', 'Group (Ctrl+G)', () => toggleGroupFromSelection(), (l) => l.filter((t) => t.pb || t.video || t.yt).length >= 2],
  ['remove', 'Remove', () => { const l = selPicked().filter((t) => !t.locked); for (const t of l) removeTile(t); setStatus(l.length === 1 ? 'Removed – Ctrl+Z puts it back' : `Removed ${l.length} – Ctrl+Z puts them back`, 4000); }, (l) => l.some((t) => !t.locked)],
];
const selButtons = SEL_ACTIONS.map(([icon, title, act]) => {
  const b = document.createElement('button');
  b.title = title; b.setAttribute('aria-label', title);
  b.appendChild(iconSvg(icon));
  b.addEventListener('click', () => { act(); updateTextToolbar(); });
  if (icon === 'remove') b.classList.add('danger');
  selBar.appendChild(b);
  return b;
});
function updateSelBar() {
  const list = selPicked();
  const otherBar = (textToolbar && !textToolbar.el.hidden) || (lineBar && !lineBar.el.hidden);
  if (!list.length || !isBoard() || IS_VIEW || otherBar || document.body.classList.contains('tile-dragging') || cropping) { selBar.hidden = true; return; }
  SEL_ACTIONS.forEach(([, , , ok], i) => { selButtons[i].hidden = !ok(list); });
  const rects = list.map((t) => t.el.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
  const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
  selBar.hidden = false;
  const r = selBar.getBoundingClientRect();
  let y = top - r.height - 10 - (rotHandle.hidden ? 0 : 34);
  const g = grid.getBoundingClientRect();
  if (y < g.top + 56) y = bottom + 10; // (under the top panels: below the selection instead)
  const x = (left + right) / 2 - r.width / 2;
  selBar.style.left = Math.max(8, Math.min(x, document.documentElement.clientWidth - r.width - 8)) + 'px';
  selBar.style.top = Math.max(8, Math.min(y, document.documentElement.clientHeight - r.height - 8)) + 'px';
  try { clearSelBarOfSyncBars(); } catch {} // (above a synced group's play bar, not over it)
}

// ---------- bookmark blocks (Mark, 2026-11-16) ----------
// A list of links on the board, laid out like a small spreadsheet: Name, Site, Notes, Added. It is a
// text tile with tile.links = { title, rows } (lib/linktable.js has the rules). Links go in by
// pasting them into its box at the bottom, Ctrl+V while it is selected, dropping a link from a
// browser on it, or pasting / dropping a link on empty board (a new block). Each new link's page
// title, site name and icon are looked up (main.js 'link-info'); a name you typed yourself is never
// replaced. Click a name to open it in the browser; double-click a cell to type in it (Tab goes to
// the next one, Enter keeps it, Esc puts it back); click a column's heading to sort by it (again:
// the other way); right-click a row for the rest. The tile's text is the list as lines: what an
// older Ozy shows in its place, and what Find (Ctrl+F) searches.
const linkInfoCache = new Map(); // url → what its lookup found (an undo can bring back a row without it)
const linkLoading = new Set();   // urls being looked up now
let linkEdit = null;             // the cell being typed in: { tile, id, field, ed }
const newLinkRowId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const isLinksTile = (t) => !!(t && t.links && tiles.includes(t));

function setLinks(tile, links, { render = true } = {}) {
  tile.links = LinkTable.withInfo(LinkTable.normalize(links), linkInfoCache);
  tile.text = LinkTable.summary(tile.links);
  tile.el.classList.add('is-links');
  addEdgeHandles(tile);
  renderLinkTable(tile);
  if (render && tile.el.isConnected && isBoard()) renderTextTile(tile);
}
// one change to a list, as one undo step; fn gets a copy and returns the new list (or null: no change)
function changeLinks(tile, label, fn) {
  if (IS_VIEW || tile.locked) return false;
  const before = LinkTable.clone(tile.links);
  const next = fn(LinkTable.clone(tile.links));
  if (!next) return false;
  setLinks(tile, next);
  const after = LinkTable.clone(tile.links);
  if (JSON.stringify(before) !== JSON.stringify(after)) undoStack.push({ kind: 'links', label, tile, before, after });
  return true;
}
const linkRow = (tile, id) => tile.links.rows.find((r) => r.id === id) || null;
// the rows in the order shown: the list's own, or S / A / B first when it keeps top tiers at the top
const shownLinkRows = (tile) => (tile.links.topFirst ? LinkTable.sortRows(tile.links.rows, 'tier') : tile.links.rows);
function setLinkTier(tile, id, tier) {
  const t = LinkTable.okTier(tier);
  changeLinks(tile, t ? `tier ${t}` : 'clear tier', (l) => { const r = l.rows.find((x) => x.id === id); if (!r || r.tier === t) return null; r.tier = t; return l; });
}

function linksLook() {
  const z = board.zoom, dark = layout.background !== 'light';
  return TextTile.normalize({
    font: 'Segoe UI', size: 14 / z, color: dark ? '#e8e8ea' : '#1d1d26', align: 'left', valign: 'top',
    bubble: true, fill: dark ? '#232328' : '#ffffff', outline: dark ? '#ffffff1f' : '#00000017', outlineWidth: 1 / z,
    box: 'auto', radius: 10 / z, padding: 14 / z, shadow: true,
  });
}
function addLinksBlock(at = placePoint(), urls = []) {
  if (!isBoard() || IS_VIEW) { setStatus('Bookmark blocks live on the board – switch to Board mode'); return null; }
  const z = board.zoom, w = 680 / z;
  const tile = addTextTile({ text: '', style: linksLook(), board: { x: at.x - w / 2, y: at.y - 30 / z, w, h: 120 / z }, links: { title: LinkTable.DEFAULT_TITLE, rows: [] } });
  if (!tile) return null;
  bringToFront(tile);
  selectOnly(tile);
  if (urls.length) {
    const res = LinkTable.addUrls(tile.links, urls, Date.now(), newLinkRowId);
    setLinks(tile, res.links);
    for (const r of tile.links.rows) lookUpLink(r.url);
    setStatus(`New bookmark block with ${res.added.length} link${res.added.length === 1 ? '' : 's'}`, 3000);
  } else {
    const input = tile.el.querySelector('.lt-add input');
    if (input) setTimeout(() => input.focus(), 0);
    setStatus('Paste links into the box at the bottom of the list', 4000);
  }
  recordAdd([tile], 'add bookmarks');
  updateChrome();
  return tile;
}
// new links at the end of a list; each is looked up
function addLinks(tile, urls) {
  if (IS_VIEW) return 0;
  if (tile.locked) { setStatus('This list is locked (Ctrl+Shift+L unlocks it)', 4000); return 0; }
  let res = null;
  changeLinks(tile, urls.length === 1 ? 'add link' : `add ${urls.length} links`, (l) => {
    res = LinkTable.addUrls(l, urls, Date.now(), newLinkRowId);
    return res.added.length ? res.links : null;
  });
  if (!res || !res.added.length) {
    setStatus(res && res.dupes ? (res.dupes === 1 ? 'That link is already in this list' : 'Those links are already in this list') : 'No web links in that (they start with http://, https:// or www.)', 4000);
    return 0;
  }
  tile.linkSort = null; // (new rows at the end: the list is no longer in a sorted order)
  for (const id of res.added) { const r = linkRow(tile, id); if (r) lookUpLink(r.url); }
  const n = res.added.length;
  setStatus(`Added ${n} link${n === 1 ? '' : 's'}${res.dupes ? ` (${res.dupes} already listed)` : ''}`, 3000);
  return n;
}
// a link's page title, site name and icon; every list showing it is filled in when it comes back
async function lookUpLink(url) {
  if (linkInfoCache.has(url) || linkLoading.has(url) || !window.api.linkInfo) { refreshLinkTiles(url); return; }
  linkLoading.add(url);
  refreshLinkTiles(url);
  let info = null;
  try { info = await window.api.linkInfo(url); } catch {}
  linkLoading.delete(url);
  if (info && info.ok) linkInfoCache.set(url, info);
  refreshLinkTiles(url);
}
function refreshLinkTiles(url) {
  for (const t of tiles) {
    if (!t.links || !t.links.rows.some((r) => r.url === url)) continue;
    if (linkEdit && linkEdit.tile === t) { t.linksStale = true; continue; } // (not under the typing: when it ends)
    setLinks(t, t.links);
  }
}
function openLinkRow(r) {
  if (!window.api.openLink) return;
  Promise.resolve(window.api.openLink(r.url)).then((ok) => setStatus(ok ? `Opening ${r.site || LinkTable.hostOf(r.url)} in your browser` : 'Could not open that link', 2500));
}

// ---- drawing the list ----
function renderLinkTable(tile) {
  if (linkEdit && linkEdit.tile === tile) { tile.linksStale = true; return; }
  tile.linksStale = false;
  const bubble = tile.el.querySelector('.text-bubble');
  let root = bubble.querySelector(':scope > .lt');
  if (!root) { root = document.createElement('div'); root.className = 'lt'; bubble.appendChild(root); wireLinkTable(tile, root); wireLinkCols(tile, root); }
  const s = tile.style, l = tile.links, now = Date.now();
  const canEdit = !IS_VIEW && !tile.locked;
  root.style.fontSize = s.size + 'px';
  root.style.fontFamily = s.font;
  root.style.color = s.color;
  // on a dark list the site icons get a light backing (GitHub's black cat would vanish otherwise)
  { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s.fill || ''); root.classList.toggle('lt-dark', !!m && (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) < 128); }
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const head = mk('div', 'lt-head');
  const title = mk('div', 'lt-title', l.title || LinkTable.DEFAULT_TITLE);
  title.title = canEdit ? 'Double-click to rename the list' : '';
  const tc = LinkTable.tierCounts(l.rows);
  const tierNote = LinkTable.TIERS.filter((k) => tc[k]).map((k) => ` · ${tc[k]} ${k}`).join('');
  head.append(title, mk('div', 'lt-count', `${l.rows.length} link${l.rows.length === 1 ? '' : 's'}${tierNote}`));
  const table = mk('table', 'lt-table');
  const cg = mk('colgroup');
  for (const c of ['ic', 'tier', 'name', 'site', 'note', 'added', 'x']) { const col = mk('col', 'lt-c-' + c); if (l.cols && l.cols[c]) col.style.width = l.cols[c] + 'em'; cg.appendChild(col); }
  const thead = mk('thead'), hr = mk('tr');
  hr.appendChild(mk('th'));
  for (const [key, label] of LinkTable.COLUMNS) {
    const th = mk('th');
    const b = mk('button', 'lt-sort', label);
    b.dataset.sort = key;
    b.title = key === 'tier' ? 'Sort by tier: S first (click again: the other way)' : `Sort by ${label.toLowerCase()} (click again: the other way)`;
    if (tile.linkSort && tile.linkSort.key === key) b.dataset.dir = tile.linkSort.desc ? 'desc' : 'asc';
    th.appendChild(b);
    // a divider on its right edge (Notes has none: it takes what is left)
    if (canEdit && key !== 'note') { const g = mk('span', 'lt-grip'); g.dataset.col = key; g.title = "Drag to change this column's width · double-click: fit it to what is in it"; th.appendChild(g); }
    hr.appendChild(th);
  }
  hr.appendChild(mk('th'));
  thead.appendChild(hr);
  const tbody = mk('tbody');
  for (const r of shownLinkRows(tile)) {
    const tr = mk('tr', r.tier ? 'tier-' + r.tier : 'tier-none'); tr.dataset.id = r.id;
    const ic = mk('td', 'lt-ic');
    if (linkLoading.has(r.url)) ic.appendChild(mk('span', 'lt-spin'));
    else if (r.icon) { const img = mk('img'); img.src = r.icon; img.alt = ''; img.draggable = false; img.addEventListener('error', () => img.replaceWith(iconSvg('link'))); ic.appendChild(img); }
    else ic.appendChild(iconSvg('link'));
    // the tier badge (2026-11-17): S, A, B or none; a click goes on to the next
    const tierTd = mk('td', 'lt-tier-td');
    const tb = mk('button', 'lt-tier', r.tier || '+');
    tb.title = canEdit ? 'Tier: click for S (the best), A, B or none. Keys 1 2 3, 0 to clear, over the row' : (r.tier ? `Tier ${r.tier}` : '');
    if (!canEdit) tb.disabled = true;
    tierTd.appendChild(tb);
    const name = mk('td', 'lt-name'); name.dataset.k = 'name';
    const open = mk('button', 'lt-open', r.name); open.title = `${r.url}\nClick: open in your browser. Double-click beside it to rename`;
    name.appendChild(open);
    const site = mk('td', 'lt-site', r.site); site.dataset.k = 'site'; site.title = r.url;
    const note = mk('td', 'lt-note', r.note); note.dataset.k = 'note'; note.title = r.note;
    const added = mk('td', 'lt-added', LinkTable.fmtDate(r.added, now)); added.title = r.added ? new Date(r.added).toLocaleString() : '';
    const x = mk('td', 'lt-x');
    if (canEdit) { const del = mk('button', 'lt-del'); del.title = 'Remove this link'; del.appendChild(iconSvg('close')); x.appendChild(del); }
    tr.append(ic, tierTd, name, site, note, added, x);
    tbody.appendChild(tr);
  }
  if (!l.rows.length) {
    const tr = mk('tr', 'lt-empty-row'), td = mk('td', 'lt-empty', 'No links yet. Paste one (or a whole list) below: each gets its page name and icon by itself.');
    td.colSpan = 7; tr.appendChild(td); tbody.appendChild(tr);
  }
  table.append(cg, thead, tbody);
  const parts = [head, table];
  if (canEdit) {
    const add = mk('div', 'lt-add');
    const input = mk('input');
    input.type = 'text';
    input.placeholder = 'Paste a link here (or several), or type one and press Enter';
    input.spellcheck = false;
    add.appendChild(input);
    parts.push(add);
  }
  // keep the box's focus and typing when a lookup redraws the list under it
  const old = root.querySelector('.lt-add input');
  const keep = old && document.activeElement === old ? { v: old.value, a: old.selectionStart, b: old.selectionEnd } : null;
  root.replaceChildren(...parts);
  if (keep) { const ni = root.querySelector('.lt-add input'); if (ni) { ni.value = keep.v; ni.focus(); try { ni.setSelectionRange(keep.a, keep.b); } catch {} } }
}
// once per list: its clicks, typing, pastes and drops (delegated: the rows are redrawn often)
// ---------- a bookmark block's column widths, dragged like Explorer's (2026-11-17) ----------
// Each heading but Notes has a divider on its right: drag it to change that column, double-click
// it to fit the column to what is in it. Notes takes what is left; when it would get too thin the
// block widens instead, so nothing is ever cut off. Widths are in em of the block's text, so they
// scale with the block. One undo step per drag.
const LT_COLS = LinkTable.COL_KEYS;
// the widths it has now, in em: the saved ones, or measured off the default proportions
function linkColsNow(tile) {
  if (tile.links.cols) return { ...tile.links.cols };
  const size = tile.style.size, out = {};
  // (layout px are board units, and the text is size px there: px / size = em)
  for (const k of LT_COLS) { const c = tile.el.querySelector('.lt-table th:nth-child(' + (2 + LinkTable.COLUMNS.findIndex(([x]) => x === k)) + ')'); out[k] = c ? Math.max(LinkTable.COL_MIN, c.offsetWidth / size) : 6; }
  return LinkTable.normCols(out);
}
function applyLinkCols(tile, cols) {
  for (const k of LT_COLS) { const c = tile.el.querySelector('.lt-c-' + k); if (c) c.style.width = cols ? cols[k] + 'em' : ''; }
}
// the block's width for these columns: at least what they need (never narrower than it was, b0w)
function linkWidthFor(tile, cols, b0w) {
  const s = tile.style;
  const need = LinkTable.minTableEm(cols) * s.size + 2 * (s.padding + s.outlineWidth);
  return Math.max(b0w, need);
}
// one undo step: the list and the block's rect together
function pushLinkColsUndo(tile, label, before, b0) {
  const after = LinkTable.clone(tile.links);
  const b1 = { ...tile.board };
  if (JSON.stringify(before) === JSON.stringify(after) && b0.w === b1.w) return;
  undoStack.push({ kind: 'links', label, tile, before, after, boards: { before: b0, after: b1 } });
}
function wireLinkCols(tile, root) {
  root.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest && e.target.closest('.lt-grip');
    if (!grip || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (IS_VIEW || tile.locked || !isBoard()) return;
    const key = grip.dataset.col;
    // a second press on the same divider soon after: fit the column (the header is redrawn after a
    // drag, so the browser would not see the two clicks as one double-click)
    const now = performance.now();
    if (tile.ltGripLast && tile.ltGripLast.key === key && now - tile.ltGripLast.t < 450) { tile.ltGripLast = null; fitLinkCol(tile, key); return; }
    tile.ltGripLast = { key, t: now };
    const cols0 = linkColsNow(tile);
    if (!cols0) return;
    const before = LinkTable.clone(tile.links), b0 = { ...tile.board };
    const emPx = tile.style.size * board.zoom, x0 = e.clientX;
    let cols = cols0, moved = false;
    try { grip.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add('lt-col-drag');
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      moved = true;
      cols = { ...cols0, [key]: clamp(cols0[key] + (ev.clientX - x0) / emPx, LinkTable.COL_MIN, 200) };
      applyLinkCols(tile, cols);
      const w = linkWidthFor(tile, cols, b0.w);
      if (w !== tile.board.w) { tile.board.w = w; layoutTile(tile); }
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('lostpointercapture', up);
      document.body.classList.remove('lt-col-drag');
      if (!moved) return; // a click: nothing to redraw (and the next click may make it a double-click)
      tile.ltGripLast = null;
      const c = LinkTable.normCols(cols);
      if (c) tile.links.cols = c;
      setLinks(tile, tile.links);
      pushLinkColsUndo(tile, 'column width', before, b0);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('lostpointercapture', up);
  });
  root.addEventListener('dblclick', (e) => { if (e.target.closest && e.target.closest('.lt-grip')) { e.preventDefault(); e.stopPropagation(); } }, true); // (fitting is done on the second press)
}
// a column as wide as its widest cell (heading included), like double-clicking Explorer's divider
function fitLinkCol(tile, key) {
  const cols = linkColsNow(tile);
  if (!cols) return;
  const i = 1 + LinkTable.COLUMNS.findIndex(([k]) => k === key); // (the icon column is first)
  const table = tile.el.querySelector('.lt-table');
  if (!table || i < 1) return;
  let px = 0;
  for (const tr of table.querySelectorAll('tr')) {
    const cell = tr.children[i];
    if (!cell || tr.children.length < 3) continue;
    const inner = cell.querySelector('.lt-sort, .lt-open') || cell;
    // the content's natural width plus the cell's padding, in layout px (= board units)
    const pad = inner === cell ? 0 : cell.clientWidth - inner.clientWidth;
    px = Math.max(px, inner.scrollWidth + Math.max(0, pad) + 2);
  }
  if (!px) return;
  const before = LinkTable.clone(tile.links), b0 = { ...tile.board };
  cols[key] = Math.min(200, Math.max(LinkTable.COL_MIN, px / tile.style.size));
  const c = LinkTable.normCols(cols);
  if (!c) return;
  tile.links.cols = c;
  tile.board.w = linkWidthFor(tile, c, b0.w);
  layoutTile(tile);
  setLinks(tile, tile.links);
  pushLinkColsUndo(tile, 'fit column', before, b0);
  setStatus(`${LinkTable.COLUMNS.find(([k]) => k === key)[1]} column fits what is in it`, 2500);
}
function resetLinkCols(tile) {
  if (!tile.links.cols) return;
  const before = LinkTable.clone(tile.links), b0 = { ...tile.board };
  delete tile.links.cols;
  setLinks(tile, tile.links);
  pushLinkColsUndo(tile, 'reset column widths', before, b0);
}
// left and right edges: the width only, the text keeping its size (a bookmark block or to-do list)
function addEdgeHandles(tile) {
  if (tile.el.querySelector(':scope > .handle.ml')) return;
  for (const side of ['l', 'r']) {
    const h = document.createElement('div');
    h.className = 'handle edge m' + side;
    h.dataset.corner = side;
    h.title = 'Drag to change the width (the text keeps its size)';
    h.addEventListener('pointerdown', (e) => startResize(tile, side, e));
    h.addEventListener('dblclick', (e) => e.stopPropagation());
    tile.el.appendChild(h);
  }
}
// the narrowest a block may be pulled: a bookmark block keeps its columns whole
function blockMinW(tile) {
  const s = tile.style;
  if (!tile.links) return TEXT_MIN_W;
  const em = tile.links.cols ? LinkTable.minTableEm(tile.links.cols) : 24;
  return em * s.size + 2 * (s.padding + s.outlineWidth);
}
function wireLinkTable(tile, root) {
  // where a press began: a drag of the block takes the pointer, so its double-click comes to the tile
  root.addEventListener('pointerdown', (e) => { tile.ltDown = e.target; }, true);
  root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const open = t.closest('.lt-open');
    if (open) { e.stopPropagation(); const r = linkRow(tile, open.closest('tr').dataset.id); if (r) openLinkRow(r); return; }
    const del = t.closest('.lt-del');
    if (del) {
      e.stopPropagation();
      const id = del.closest('tr').dataset.id;
      if (changeLinks(tile, 'remove link', (l) => { l.rows = l.rows.filter((x) => x.id !== id); return l; })) setStatus('Removed – Ctrl+Z puts it back', 3000);
      return;
    }
    const tierB = t.closest('.lt-tier');
    if (tierB) { e.stopPropagation(); const r = linkRow(tile, tierB.closest('tr').dataset.id); if (r) setLinkTier(tile, r.id, LinkTable.nextTier(r.tier)); return; }
    const sort = t.closest('.lt-sort');
    if (sort) {
      e.stopPropagation();
      const key = sort.dataset.sort;
      const desc = !!(tile.linkSort && tile.linkSort.key === key && !tile.linkSort.desc);
      if (IS_VIEW || tile.locked) return;
      tile.linkSort = { key, desc };
      if (!changeLinks(tile, 'sort links', (l) => { l.rows = LinkTable.sortRows(l.rows, key, desc); return l; })) renderLinkTable(tile);
    }
  });
  // the row under the mouse, for the 1 2 3 / 0 tier keys
  root.addEventListener('pointerover', (e) => { const tr = e.target instanceof Element && e.target.closest('tr[data-id]'); tile.ltHoverRow = tr ? tr.dataset.id : null; });
  root.addEventListener('pointerleave', () => { tile.ltHoverRow = null; });
  root.addEventListener('keydown', (e) => {
    const input = e.target instanceof Element && e.target.closest('.lt-add input');
    if (!input) return;
    e.stopPropagation(); // typing, not shortcuts
    if (e.key === 'Escape') { input.value = ''; input.blur(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    const urls = LinkTable.findUrls(v);
    if (!urls.length) { const u = LinkTable.cleanUrl(v); if (u) urls.push(u); }
    if (!urls.length) { setStatus('That is not a web link (it needs http://, https:// or www.)', 4000); return; }
    input.value = '';
    addLinks(tile, urls);
  });
  root.addEventListener('paste', (e) => {
    const input = e.target instanceof Element && e.target.closest('.lt-add input');
    if (!input) return;
    const urls = LinkTable.findUrls(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
    if (!urls.length) return; // (not a link: it goes into the box as typing)
    e.preventDefault(); e.stopPropagation();
    addLinks(tile, urls);
  });
}

// ---- typing in a cell (and in the list's title) ----
const LINK_FIELDS = ['name', 'site', 'note'];
function editLinkCell(tile, id, field) {
  if (IS_VIEW || tile.locked || !isBoard() || !isLinksTile(tile)) return;
  finishLinkEdit(true);
  let host, start;
  if (field === 'title') {
    host = tile.el.querySelector('.lt-title');
    start = tile.links.title;
  } else {
    const r = linkRow(tile, id);
    const tr = r && [...tile.el.querySelectorAll('tr[data-id]')].find((x) => x.dataset.id === id);
    host = tr && tr.querySelector(`td[data-k="${field === 'url' ? 'site' : field}"]`);
    if (!host) return;
    start = r[field] || '';
  }
  if (!host) return;
  const ed = document.createElement('div');
  ed.className = 'lt-ed';
  ed.contentEditable = 'plaintext-only';
  ed.textContent = start;
  host.replaceChildren(ed);
  host.classList.add('lt-editing');
  linkEdit = { tile, id, field, ed };
  ed.focus();
  try { const rg = document.createRange(); rg.selectNodeContents(ed); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg); } catch {}
  ed.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finishLinkEdit(false); }
    else if (e.key === 'Enter' && !(field === 'note' && e.shiftKey)) { e.preventDefault(); finishLinkEdit(true); }
    else if (e.key === 'Tab' && field !== 'title') {
      e.preventDefault();
      const next = nextLinkCell(tile, id, field === 'url' ? 'site' : field, e.shiftKey);
      finishLinkEdit(true);
      if (next) editLinkCell(tile, next.id, next.field);
    }
  });
  ed.addEventListener('blur', () => { if (linkEdit && linkEdit.ed === ed) finishLinkEdit(true); });
}
function nextLinkCell(tile, id, field, back) {
  const rows = shownLinkRows(tile);
  let i = rows.findIndex((r) => r.id === id), f = LINK_FIELDS.indexOf(field);
  if (i < 0 || f < 0) return null;
  f += back ? -1 : 1;
  if (f >= LINK_FIELDS.length) { f = 0; i++; }
  if (f < 0) { f = LINK_FIELDS.length - 1; i--; }
  return rows[i] ? { id: rows[i].id, field: LINK_FIELDS[f] } : null;
}
function finishLinkEdit(keep) {
  const le = linkEdit;
  if (!le) return;
  linkEdit = null;
  const { tile, id, field, ed } = le;
  const raw = ed.textContent || '';
  if (!tiles.includes(tile)) return;
  let bad = false, newUrl = null;
  const changed = keep && changeLinks(tile, field === 'url' ? 'edit link' : field === 'title' ? 'rename list' : `edit ${field === 'note' ? 'note' : field}`, (l) => {
    if (field === 'title') { const v = raw.replace(/\s+/g, ' ').trim(); if (v === l.title) return null; l.title = v || LinkTable.DEFAULT_TITLE; return l; }
    const r = l.rows.find((x) => x.id === id);
    if (!r) return null;
    if (field === 'url') {
      const u = LinkTable.cleanUrl(raw.trim());
      if (!u) { bad = true; return null; }
      if (u === r.url) return null;
      r.url = u; r.icon = ''; r.site = LinkTable.hostOf(u);
      if (r.auto) r.name = LinkTable.guessName(u);
      newUrl = u;
      return l;
    }
    if (field === 'name') {
      const v = raw.replace(/\s+/g, ' ').trim();
      if (!v) { r.auto = true; r.name = ''; return l; } // emptied: the page's own name again
      if (v === r.name) return null;
      r.name = v; r.auto = false;
      return l;
    }
    const v = field === 'note' ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
    if (v === (r[field] || '')) return null;
    r[field] = v || (field === 'site' ? LinkTable.hostOf(r.url) : '');
    return l;
  });
  if (!changed) { renderLinkTable(tile); if (isBoard()) renderTextTile(tile); }
  if (bad) setStatus('That is not a web link (it needs http:// or https://)', 4000);
  if (newUrl) lookUpLink(newUrl);
  else if (changed && field === 'name') { const r = linkRow(tile, id); if (r && r.auto) lookUpLink(r.url); }
}
// a double-click on the list: type in the cell (or the title) it landed on
function linksDblClick(tile, e) {
  const t = tile.ltDown instanceof Element && tile.el.contains(tile.ltDown) ? tile.ltDown : e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('.lt-title')) { editLinkCell(tile, null, 'title'); return; }
  const cell = t.closest('td[data-k]');
  const tr = cell && cell.closest('tr[data-id]');
  if (tr) { editLinkCell(tile, tr.dataset.id, cell.dataset.k); return; }
  if (t.closest('.lt-add, .lt-empty')) { const i = tile.el.querySelector('.lt-add input'); if (i) i.focus(); }
}
// ---------- scaling a bookmark block or to-do list as a whole (2026-11-17) ----------
// Their look is all in board units (made at the zoom they were added at), so one added while far
// out is huge next to everything else. Scaling multiplies the width and every size in the style;
// the height follows from the re-wrapped content.
const isScalableBlock = (t) => !!(t && (t.links || t.todo) && t.style);
const blockName = (t) => (t.links ? 'bookmark block' : 'to-do list');
const blockBaseSize = (t) => (t.links ? 14 : 15); // its text size on screen when added (linksLook / todoLook)
function rerenderBlock(tile) {
  if (tile.links) renderLinkTable(tile);
  else if (tile.todo) renderTodo(tile);
  if (isBoard()) renderTextTile(tile); else applyTextStyleToEl(tile);
}
// k from the style and rect it started at; the corner opposite the handle stays put
function scaleBlockTo(tile, st0, b0, k, corner = 'br') {
  const lo = Math.max(0.5 / st0.size, TEXT_MIN_W / b0.w);
  const hi = Math.min(4000 / st0.size, 2000 / Math.max(st0.padding, 1e-6), 200 / Math.max(st0.outlineWidth, 1e-6), 400000 / b0.w);
  k = clamp(Number.isFinite(k) ? k : 1, lo, Math.max(lo, hi));
  tile.style = { ...st0, size: st0.size * k, padding: st0.padding * k, radius: st0.radius * k, outlineWidth: st0.outlineWidth * k };
  const b = tile.board;
  b.w = b0.w * k;
  b.x = corner.includes('l') ? b0.x + b0.w - b.w : b0.x;
  rerenderBlock(tile);
  b.y = corner.includes('t') ? b0.y + b0.h - b.h : b0.y;
  layoutTile(tile);
  return k;
}
// from a menu: one undo step
function scaleBlockBy(tile, k, how) {
  if (IS_VIEW || tile.locked || !isScalableBlock(tile) || !tile.board) return;
  const entry = recordResize(tiles.filter((t) => t.board));
  const st0 = { ...tile.style };
  scaleBlockTo(tile, st0, { ...tile.board }, k);
  if (board.linked) resolveOverlaps(new Set([tile]));
  entry.styles = [{ tile, before: st0, after: { ...tile.style } }];
  entry.label = 'scale ' + blockName(tile);
  finishRects(entry);
  setStatus(`${how}: text now ${Math.round(tile.style.size * board.zoom)} px on screen at this zoom`, 3500);
}
function blockSizeMenuItems(tile) {
  const can = !IS_VIEW && !tile.locked && isBoard();
  const norm = (blockBaseSize(tile) / board.zoom) / tile.style.size;
  return [
    ['Smaller (half size)', () => scaleBlockBy(tile, 0.5, 'Half size'), !can],
    ['Larger (double size)', () => scaleBlockBy(tile, 2, 'Double size'), !can],
    ['Normal size at this zoom', () => scaleBlockBy(tile, norm, 'Normal size at this zoom'), !can || Math.abs(norm - 1) < 0.02],
  ];
}
function linksMenuItems(tile, e) {
  const t = e.target instanceof Element ? e.target : null;
  const tr = t && t.closest('tr[data-id]');
  const r = tr && linkRow(tile, tr.dataset.id);
  const can = !IS_VIEW && !tile.locked;
  const items = [];
  if (r) {
    const i = tile.links.rows.indexOf(r);
    items.push(
      ['Open in browser', () => openLinkRow(r)],
      ['Copy link', () => { window.api.copyText(r.url); setStatus('Copied ' + r.url, 3000); }],
      ['Rename', () => editLinkCell(tile, r.id, 'name'), !can],
      ['Edit link', () => editLinkCell(tile, r.id, 'url'), !can],
      ['Edit note', () => editLinkCell(tile, r.id, 'note'), !can],
      ['Get its name from the page again', () => {
        linkInfoCache.delete(r.url);
        changeLinks(tile, 'name from page', (l) => { const x = l.rows.find((y) => y.id === r.id); if (!x) return null; x.auto = true; x.name = ''; x.icon = ''; return l; });
        lookUpLink(r.url);
      }, !can],
      ...[['S', 'Tier S (the best)'], ['A', 'Tier A'], ['B', 'Tier B'], ['', 'No tier']].filter(([k]) => k !== r.tier).map(([k, label]) => [label, () => setLinkTier(tile, r.id, k), !can]),
      ['Move up', () => changeLinks(tile, 'move link', (l) => { l.rows = LinkTable.moveRow(l.rows, r.id, -1); return l; }), !can || i <= 0],
      ['Move down', () => changeLinks(tile, 'move link', (l) => { l.rows = LinkTable.moveRow(l.rows, r.id, 1); return l; }), !can || i >= tile.links.rows.length - 1],
      ['Remove link', () => changeLinks(tile, 'remove link', (l) => { l.rows = l.rows.filter((x) => x.id !== r.id); return l; }), !can],
    );
  }
  items.push(
    ['Rename the list', () => editLinkCell(tile, null, 'title'), !can],
    ['Reset column widths', () => resetLinkCols(tile), !can || !tile.links.cols],
    [tile.links.topFirst ? '✓ Top tiers at the top' : 'Keep top tiers at the top', () => changeLinks(tile, 'top tiers first', (l) => { l.topFirst = !l.topFirst; if (!l.topFirst) delete l.topFirst; return l; }), !can],
    ['Copy all links', () => { window.api.copyText(tile.links.rows.map((x) => x.url).join('\n')); setStatus(`Copied ${tile.links.rows.length} links`, 3000); }, !tile.links.rows.length],
    ...blockSizeMenuItems(tile),
    ...stackMenuItems(tile), lockMenuItem(tile), ['Remove the block', () => removeTile(tile)],
  );
  return items;
}
// the links in what was pasted or dropped (a browser drag carries text/uri-list)
function linksInTransfer(dt) {
  if (!dt) return [];
  const uri = dt.getData('text/uri-list') || '';
  const list = uri.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).join('\n');
  return LinkTable.findUrls(list || dt.getData('text/plain') || '');
}
const linksTileAt = (x, y) => {
  for (const el of document.elementsFromPoint(x, y)) { const te = el.closest && el.closest('.text-tile.is-links'); if (te) return tiles.find((t) => t.el === te) || null; }
  return null;
};
document.getElementById('add-links').addEventListener('click', () => addLinksBlock(viewCentreWorld()));
// 1 2 3 give the row under the mouse tier S A B, 0 clears it (ahead of the board's own keys)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !/^[0-3]$/.test(e.key)) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
  const t = hoveredTile;
  if (!t || !t.links || !t.ltHoverRow || !linkRow(t, t.ltHoverRow) || IS_VIEW || t.locked) return;
  e.preventDefault(); e.stopImmediatePropagation();
  setLinkTier(t, t.ltHoverRow, e.key === '0' ? '' : LinkTable.TIERS[Number(e.key) - 1]);
}, true);

// ---------- to-do blocks (Mark, 2026-11-17) ----------
// A goal at the top and the tasks that get it done under it, each with as many sub-tasks as it
// needs (lib/todolist.js has the rules). It is a text tile with tile.todo = { title, color, items }.
// Click a task's words to type; Enter adds the next task (from the caret on, the words go with it),
// Tab makes it a sub-task of the one above, Shift+Tab takes it back out, Backspace on an empty one
// removes it, ↑ ↓ go between tasks, Alt+↑ ↓ move it, Ctrl+Enter ticks it. Pasting several lines
// makes several tasks (their indents become sub-tasks). The box ticks a task; a goal is ticked when
// all its sub-tasks are, and ticking it ticks them all. Each task can have a colour, and so can the
// list (its band, its bar and its boxes). ▸ folds a task's sub-tasks away. The tile's text is the list
// as lines (☐ / ☑): what an older Ozy shows in its place, and what Find (Ctrl+F) searches.
let todoEdit = null; // the words being typed: { tile, id ('title' or a task's id), before }
const TODO_DEFAULT_COLOR = '#4f8cff';

function setTodo(tile, todo, { render = true } = {}) {
  tile.todo = TodoList.normalize(todo);
  tile.text = TodoList.summary(tile.todo);
  tile.el.classList.add('is-todo');
  addEdgeHandles(tile);
  renderTodo(tile);
  if (render && tile.el.isConnected && isBoard()) renderTextTile(tile);
}
// one change as one undo step; fn changes the copy it gets and returns what it made (falsy: nothing)
function changeTodo(tile, label, fn) {
  if (IS_VIEW || tile.locked || !tile.todo) return null;
  commitTodoText(); // what was being typed is its own step first
  const before = TodoList.clone(tile.todo);
  const m = TodoList.clone(tile.todo);
  const res = fn(m);
  if (!res) return null;
  setTodo(tile, m);
  if (JSON.stringify(before) !== JSON.stringify(tile.todo)) undoStack.push({ kind: 'todo', label, tile, before, after: TodoList.clone(tile.todo) });
  return res;
}
function commitTodoText() {
  const e = todoEdit;
  if (!e) return;
  todoEdit = null;
  if (!tiles.includes(e.tile) || !e.tile.todo) return;
  e.tile.todo = TodoList.normalize(e.tile.todo); // (trims the title)
  e.tile.text = TodoList.summary(e.tile.todo);
  if (JSON.stringify(e.before) !== JSON.stringify(e.tile.todo)) undoStack.push({ kind: 'todo', label: e.id === 'title' ? 'rename goal' : 'edit task', tile: e.tile, before: e.before, after: TodoList.clone(e.tile.todo) });
}
function todoLook() {
  const z = board.zoom, dark = layout.background !== 'light';
  return TextTile.normalize({
    font: 'Segoe UI', size: 15 / z, color: dark ? '#e8e8ea' : '#1d1d26', align: 'left', valign: 'top',
    bubble: true, fill: dark ? '#232328' : '#ffffff', outline: dark ? '#ffffff1f' : '#00000017', outlineWidth: 1 / z,
    box: 'auto', radius: 12 / z, padding: 16 / z, shadow: true,
  });
}
function addTodoBlock(at = placePoint(), items = null) {
  if (!isBoard() || IS_VIEW) { setStatus('To-do lists live on the board – switch to Board mode'); return null; }
  const z = board.zoom, w = 460 / z;
  const tile = addTextTile({ text: '', style: todoLook(), board: { x: at.x - w / 2, y: at.y - 40 / z, w, h: 160 / z }, todo: { title: '', items: items || [] } });
  if (!tile) return null;
  bringToFront(tile);
  selectOnly(tile);
  recordAdd([tile], 'add to-do list');
  updateChrome();
  setTimeout(() => focusTodo(tile, 'title', 'end'), 0);
  setStatus('Name the goal, then Enter for its first task (Tab: a sub-task)', 5000);
  return tile;
}

// ---- the caret ----
function caretOffset(el) {
  const s = window.getSelection();
  if (!s || !s.rangeCount) return 0;
  const r = s.getRangeAt(0);
  if (!el.contains(r.startContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function placeCaret(el, at) {
  const s = window.getSelection();
  if (!s) return;
  const r = document.createRange();
  const tn = el.firstChild;
  const len = el.textContent.length;
  const n = at === 'end' ? len : Math.max(0, Math.min(len, at | 0));
  if (tn && tn.nodeType === 3) { r.setStart(tn, Math.min(n, tn.length)); } else { r.selectNodeContents(el); r.collapse(n > 0 ? false : true); }
  r.collapse(true);
  s.removeAllRanges(); s.addRange(r);
}
const todoEditEl = (tile, id) => [...tile.el.querySelectorAll('.td-edit')].find((x) => x.dataset.id === id) || null;
function focusTodo(tile, id, at = 'end') {
  const el = todoEditEl(tile, id);
  if (!el || el.contentEditable !== 'plaintext-only') return;
  el.focus();
  placeCaret(el, at);
}

// ---- drawing the list ----
function renderTodo(tile) {
  const bubble = tile.el.querySelector('.text-bubble');
  let root = bubble.querySelector(':scope > .td');
  if (!root) { root = document.createElement('div'); root.className = 'td'; bubble.appendChild(root); wireTodo(tile, root); }
  const m = tile.todo, s = tile.style;
  const can = !IS_VIEW && !tile.locked;
  root.style.fontSize = s.size + 'px';
  root.style.fontFamily = s.font;
  root.style.color = s.color;
  root.style.setProperty('--td-color', m.color || TODO_DEFAULT_COLOR);
  { const mm = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s.fill || ''); root.classList.toggle('td-dark', !!mm && (0.299 * parseInt(mm[1], 16) + 0.587 * parseInt(mm[2], 16) + 0.114 * parseInt(mm[3], 16)) < 128); }
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const editable = (el, id, text, ph) => {
    el.classList.add('td-edit'); el.dataset.id = id; el.textContent = text; el.dataset.ph = ph;
    if (can) { el.contentEditable = 'plaintext-only'; el.spellcheck = true; }
    return el;
  };
  const head = mk('div', 'td-head');
  head.appendChild(editable(mk('div', 'td-title'), 'title', m.title, 'What is the goal?'));
  const p = TodoList.progress(m.items);
  const prog = mk('div', 'td-prog');
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  prog.append(mk('span', 'td-prog-text', p.total ? `${p.done} of ${p.total} done` : 'No tasks yet'), mk('span', 'td-pct', p.total ? `${pct}%` : ''));
  const bar = mk('div', 'td-bar'); const fill = mk('div', 'td-fill'); fill.style.width = pct + '%'; bar.appendChild(fill);
  head.append(prog, bar);
  root.classList.toggle('td-complete', p.total > 0 && p.done === p.total);
  const list = mk('div', 'td-list');
  for (const { item: it, depth } of TodoList.visible(m.items)) {
    const row = mk('div', 'td-row'); row.dataset.id = it.id;
    row.style.setProperty('--d', depth);
    if (it.done) row.classList.add('done');
    if (it.color) { row.classList.add('colored'); row.style.setProperty('--c', it.color); }
    if (it.kids.length) row.classList.add('has-kids');
    if (it.kids.length) { const f = mk('button', 'td-fold', it.open ? '▾' : '▸'); f.title = it.open ? 'Fold its sub-tasks away' : 'Show its sub-tasks'; row.appendChild(f); }
    else row.appendChild(mk('span', 'td-fold-sp'));
    const box = mk('button', 'td-check');
    box.title = it.kids.length ? (it.done ? 'Untick it and all its sub-tasks' : 'Tick it and all its sub-tasks') : (it.done ? 'Not done' : 'Done (Ctrl+Enter)');
    box.setAttribute('role', 'checkbox'); box.setAttribute('aria-checked', String(it.done));
    if (!can) box.disabled = true;
    if (it.done) box.appendChild(iconSvg('check'));
    row.appendChild(box);
    row.appendChild(editable(mk('div', 'td-text'), it.id, it.text, depth ? 'Sub-task' : 'Task'));
    if (it.kids.length) { const kp = TodoList.progress(it.kids); row.appendChild(mk('span', 'td-kcount', `${kp.done}/${kp.total}`)); }
    if (can) {
      const tools = mk('span', 'td-tools');
      const add = mk('button', 'td-addsub'); add.title = 'Add a sub-task'; add.appendChild(iconSvg('plus'));
      const col = mk('button', 'td-color'); col.title = 'Colour'; col.appendChild(mk('span', 'td-dot'));
      const del = mk('button', 'td-del'); del.title = it.kids.length ? 'Delete it and its sub-tasks' : 'Delete'; del.appendChild(iconSvg('close'));
      tools.append(add, col, del);
      row.appendChild(tools);
    }
    list.appendChild(row);
  }
  if (!m.items.length) list.appendChild(mk('div', 'td-empty', can ? 'Add the first task below, or paste a list of them.' : 'No tasks.'));
  const parts = [head, list];
  if (can) { const add = mk('button', 'td-add'); add.appendChild(iconSvg('plus')); add.append(' Add a task'); parts.push(add); }
  root.replaceChildren(...parts);
}

// once per list: its clicks and typing (delegated: the rows are redrawn after every change)
function wireTodo(tile, root) {
  const rowId = (el) => { const r = el.closest('.td-row'); return r ? r.dataset.id : null; };
  root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const btn = t.closest('button');
    if (!btn) return;
    e.stopPropagation();
    const id = rowId(btn);
    if (btn.classList.contains('td-check')) changeTodo(tile, 'tick', (m) => TodoList.toggle(m, id));
    else if (btn.classList.contains('td-fold')) changeTodo(tile, 'fold', (m) => TodoList.setOpen(m, id));
    else if (btn.classList.contains('td-addsub')) { const n = changeTodo(tile, 'add sub-task', (m) => TodoList.addChild(m, id, '')); if (n) focusTodo(tile, n, 0); else setStatus('That is as deep as sub-tasks go', 3000); }
    else if (btn.classList.contains('td-del')) changeTodo(tile, 'delete task', (m) => TodoList.remove(m, id));
    else if (btn.classList.contains('td-color')) pickTodoColor(tile, id, btn);
    else if (btn.classList.contains('td-add')) { const n = changeTodo(tile, 'add task', (m) => TodoList.addAfter(m, null, '')); if (n) focusTodo(tile, n, 0); }
  });
  // typing: the model follows each key (the height too); the undo step is made when the typing ends
  root.addEventListener('input', (e) => {
    const el = e.target instanceof Element && e.target.closest('.td-edit');
    if (!el || !tile.todo) return;
    const id = el.dataset.id;
    if (!todoEdit || todoEdit.tile !== tile || todoEdit.id !== id) { commitTodoText(); todoEdit = { tile, id, before: TodoList.clone(tile.todo) }; }
    if (id === 'title') tile.todo.title = el.textContent.slice(0, 300);
    else TodoList.setText(tile.todo, id, el.textContent);
    tile.text = TodoList.summary(tile.todo);
    if (isBoard()) renderTextTile(tile);
  });
  root.addEventListener('focusout', (e) => { if (e.target instanceof Element && e.target.closest('.td-edit')) commitTodoText(); });
  root.addEventListener('paste', (e) => {
    const el = e.target instanceof Element && e.target.closest('.td-edit');
    if (!el) return;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!/\n/.test(text.trim())) return; // one line: it goes in as typing
    e.preventDefault(); e.stopPropagation();
    const items = TodoList.fromText(text);
    if (!items.length) return;
    const id = el.dataset.id;
    changeTodo(tile, `paste ${items.length} tasks`, (m) => {
      const f = id !== 'title' && TodoList.find(m.items, id);
      if (f) f.list.splice(f.index + 1, 0, ...items); else m.items.push(...items);
      TodoList.settle(m.items);
      return true;
    });
    setStatus(`Added ${TodoList.count(items)} tasks`, 3000);
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target instanceof Element && e.target.closest('.td-edit');
    if (!el) return;
    e.stopPropagation(); // typing, not the board's shortcuts
    const id = el.dataset.id;
    const m = tile.todo;
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); return; }
    if (id === 'title') {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (m.items.length && e.key === 'ArrowDown') { focusTodo(tile, m.items[0].id, 'end'); return; }
        const n = changeTodo(tile, 'add task', (mm) => (mm.items.length ? TodoList.addBefore(mm, mm.items[0].id, '') : TodoList.addAfter(mm, null, '')));
        if (n) focusTodo(tile, n, 0);
      }
      return;
    }
    const at = caretOffset(el), text = el.textContent;
    const f = TodoList.find(m.items, id);
    if (!f) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); changeTodo(tile, 'tick', (mm) => TodoList.toggle(mm, id)); focusTodo(tile, id, at); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const depth = TodoList.depthOf(m.items, id);
      if (!text.trim() && depth > 0) { changeTodo(tile, 'outdent', (mm) => TodoList.outdent(mm, id)); focusTodo(tile, id, 0); return; }
      if (!text.trim() && !f.item.kids.length) { el.blur(); return; } // an empty task at the top: done adding
      if (at === 0 && text) { changeTodo(tile, 'add task', (mm) => TodoList.addBefore(mm, id, '')); focusTodo(tile, id, 0); return; }
      const n = changeTodo(tile, 'add task', (mm) => {
        TodoList.setText(mm, id, text.slice(0, at));
        const it = TodoList.find(mm.items, id).item;
        return TodoList.addAfter(mm, id, text.slice(at), { asFirstChild: it.kids.length > 0 && it.open });
      });
      if (n) focusTodo(tile, n, 0);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ok = changeTodo(tile, e.shiftKey ? 'outdent' : 'indent', (mm) => (e.shiftKey ? TodoList.outdent(mm, id) : TodoList.indent(mm, id)));
      focusTodo(tile, id, at);
      if (!ok && !e.shiftKey) setStatus(f.index === 0 ? 'Tab makes it a sub-task of the task above it: there is none at this level' : 'That is as deep as sub-tasks go', 3000);
      return;
    }
    if (e.key === 'Backspace' && !text && !f.item.kids.length && window.getSelection().isCollapsed) {
      e.preventDefault();
      const prev = TodoList.neighbour(m.items, id, -1);
      changeTodo(tile, 'delete task', (mm) => TodoList.remove(mm, id));
      if (prev) focusTodo(tile, prev, 'end'); else focusTodo(tile, 'title', 'end');
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      e.preventDefault();
      changeTodo(tile, 'move task', (mm) => TodoList.move(mm, id, e.key === 'ArrowUp' ? -1 : 1));
      focusTodo(tile, id, at);
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey) {
      const n = TodoList.neighbour(m.items, id, e.key === 'ArrowUp' ? -1 : 1);
      if (n || e.key === 'ArrowUp') { e.preventDefault(); focusTodo(tile, n || 'title', e.key === 'ArrowUp' ? 'end' : Math.min(at, 9999)); }
    }
  });
}
function pickTodoColor(tile, id, anchor) {
  const cur = id ? (TodoList.find(tile.todo.items, id) || {}).item : null;
  const now = id ? (cur && cur.color) || '' : tile.todo.color;
  openColorPop(anchor, now || TODO_DEFAULT_COLOR, (c) => {
    if (id) changeTodo(tile, 'task colour', (m) => TodoList.setColor(m, id, c));
    else changeTodo(tile, 'list colour', (m) => { m.color = TodoList.okColor(c); return true; });
  });
}
function todoMenuItems(tile, e) {
  const t = e.target instanceof Element ? e.target : null;
  const rowEl = t && t.closest('.td-row');
  const f = rowEl && TodoList.find(tile.todo.items, rowEl.dataset.id);
  const can = !IS_VIEW && !tile.locked;
  const items = [];
  if (f) {
    const id = f.item.id, it = f.item;
    items.push(
      [it.done ? 'Mark not done' : 'Mark done', () => changeTodo(tile, 'tick', (m) => TodoList.toggle(m, id)), !can],
      ['Add a sub-task', () => { const n = changeTodo(tile, 'add sub-task', (m) => TodoList.addChild(m, id, '')); if (n) focusTodo(tile, n, 0); }, !can],
      ['Add a task below', () => { const n = changeTodo(tile, 'add task', (m) => TodoList.addAfter(m, id, '')); if (n) focusTodo(tile, n, 0); }, !can],
      ['Make it a sub-task (Tab)', () => changeTodo(tile, 'indent', (m) => TodoList.indent(m, id)), !can || f.index === 0],
      ['Take it out a level (Shift+Tab)', () => changeTodo(tile, 'outdent', (m) => TodoList.outdent(m, id)), !can || !f.parent],
      ['Move up (Alt+↑)', () => changeTodo(tile, 'move task', (m) => TodoList.move(m, id, -1)), !can || f.index === 0],
      ['Move down (Alt+↓)', () => changeTodo(tile, 'move task', (m) => TodoList.move(m, id, 1)), !can || f.index >= f.list.length - 1],
      ['Colour…', () => pickTodoColor(tile, id, rowEl.querySelector('.td-color') || rowEl), !can],
      ...(it.color ? [['No colour', () => changeTodo(tile, 'task colour', (m) => TodoList.setColor(m, id, '')), !can]] : []),
      [it.kids.length ? 'Delete it and its sub-tasks' : 'Delete task', () => changeTodo(tile, 'delete task', (m) => TodoList.remove(m, id)), !can],
    );
  }
  const hasKids = TodoList.visible(tile.todo.items).some((v) => v.item.kids.length);
  items.push(
    ['Rename the goal', () => focusTodo(tile, 'title', 'end'), !can],
    ['Colour of the list…', () => pickTodoColor(tile, null, tile.el.querySelector('.td-title')), !can],
    ['Fold all sub-tasks away', () => changeTodo(tile, 'fold all', (m) => TodoList.setAllOpen(m, false)), !can || !hasKids],
    ['Show all sub-tasks', () => changeTodo(tile, 'unfold all', (m) => TodoList.setAllOpen(m, true)), !can || !hasKids],
    ['Clear the done tasks', () => { const n = changeTodo(tile, 'clear done', (m) => TodoList.clearDone(m)); setStatus(n ? `Cleared ${n} done task${n === 1 ? '' : 's'} – Ctrl+Z puts them back` : 'Nothing done yet', 3000); }, !can],
    ['Untick everything', () => changeTodo(tile, 'untick all', (m) => TodoList.uncheckAll(m)), !can],
    ['Copy as text', () => { window.api.copyText(TodoList.summary(tile.todo)); setStatus('Copied the list as text', 3000); }],
    ...blockSizeMenuItems(tile),
    ...stackMenuItems(tile), lockMenuItem(tile), ['Remove the block', () => removeTile(tile)],
  );
  return items;
}
document.getElementById('add-todo').addEventListener('click', () => addTodoBlock(viewCentreWorld()));

// ---------- search: Ozy's features, and the pictures and videos (Mark, 2026-11-17) ----------
// Two searches that look nothing alike on purpose.
// ⌕ Search features (Ctrl+K, the top of the left rail): every button and menu item in the panels
// (read from them each time it opens, so a new button is found without being listed here) and the
// features that only have a key. Type a few letters; Enter or a click does it. The ones used last
// come first when nothing is typed.
// Pictures and videos (Ctrl+Shift+F, the rail's picture-search button): the tiles by name, as
// thumbnails; a click flies to one (the board) or scrolls to it (the gallery).
const FEATURE_EXTRA = [
  ['Find words on the board', 'In notes, text, frame titles and file names; Enter goes to the next', 'Ctrl+F', () => openFind(), 'search'],
  ['Search pictures and videos', 'By their names, as thumbnails', 'Ctrl+Shift+F', () => openMediaSearch(), 'photosearch'],
  ['Overview map', 'The small map of the whole board, bottom right', 'M', () => setMiniMap(!miniOn), 'map'],
  ['Duplicate', 'A copy of what is selected, beside it', 'Ctrl+D', () => duplicateSelection(), 'copy'],
  ['Lock or unlock', 'Locked things stay put and the lasso goes over them', 'Ctrl+Shift+L', () => toggleLock(null), 'lock'],
  ['Bring to front', 'The selection above everything', 'PgUp', () => stackToFront(null), 'front'],
  ['Send to back', 'The selection behind everything', 'PgDn', () => stackToBack(null), 'back'],
  ['Undo', 'The last change', 'Ctrl+Z', () => undo(), 'back'],
  ['Redo', 'The change just undone', 'Ctrl+Y', () => redo(), 'front'],
  ['Paste', 'Pictures, links (a bookmark block) or tiles copied here', 'Ctrl+V', () => pasteClipboard(), 'copy'],
  ['Put a frame around the selection', 'A frame that holds what is selected', '', () => addFrame({ aroundSelection: true }), 'frame'],
  ['Present the frames', 'One frame after another, full view (← → to step, Esc ends)', '', () => presentFrames(), 'frame'],
  ['Export the view as a picture', 'What is on screen now, as a PNG', '', () => exportView(), 'save'],
  ['Export the frames as one PDF', 'Each frame a page', '', () => exportFrames('pdf'), 'save'],
  ['Export each frame as a picture', 'One PNG per frame', '', () => exportFrames('pngs'), 'save'],
  ['Crop the selected picture', 'Drag its edges to crop; Enter or a click outside keeps it', '', () => { const t = [...selection].find((x) => x.type === 'image' && tiles.includes(x)); if (t) beginCrop(t); else setStatus('Select a picture first, then crop', 4000); }, 'crop'],
  ['Select all', 'Everything on the board (not the locked things)', 'Ctrl+A', () => { if (!isBoard()) { setStatus('Select all works on the board'); return; } for (const t of tiles) if (!t.locked) setSelected(t, true); selectionStatus(); }, 'group'],
  ['Rotate', 'Select something, then drag the round handle above it (Shift: 15° steps)', '', () => setStatus('Select something, then drag the round handle above it to turn it (Shift: 15° steps)', 6000), 'loop'],
  ['Master volume', 'The volume slider, top right', '', () => { const v = document.getElementById('master-vol'); if (v) v.focus(); }, 'volume'],
  ['Light board', 'A white board', '', () => setBoardBackground('light'), 'board'],
  ['Dark board', 'A dark board', '', () => setBoardBackground('dark'), 'board'],
];
// other words people look for things by
const FEATURE_WORDS = {
  'btn-hand': 'pan move scroll drag around', 'add-text': 'type words write label', 'add-shape': 'rectangle circle square triangle star sticky note post-it',
  'add-line': 'arrow connector divider rule', 'btn-pen': 'draw sketch freehand highlighter brush', 'btn-frames': 'section area slides present export pdf',
  'add-links': 'links urls websites web favourites tier', 'add-todo': 'tasks checklist todo to do goals plan', 'btn-sidebar': 'folders files library browse import',
  'btn-favs': 'starred star best', 'btn-map': 'minimap overview navigator', 'btn-fit': 'zoom fit all everything whole board', 'zoom-in': 'bigger magnify closer',
  'zoom-out': 'smaller further', 'btn-clear': 'delete remove everything empty new', 'btn-save': 'store keep', 'btn-tidy': 'arrange align organise organize rows grid',
  'btn-mute-all': 'sound audio silence quiet volume', 'btn-loop-all': 'repeat', 'btn-link': 'push neighbours overlap',
};
const FEATURE_RECENT_KEY = 'ozy-feature-recent';
const featureRecent = () => { try { return JSON.parse(localStorage.getItem(FEATURE_RECENT_KEY) || '[]'); } catch { return []; } };
function noteFeatureUsed(name) {
  try { localStorage.setItem(FEATURE_RECENT_KEY, JSON.stringify([name, ...featureRecent().filter((n) => n !== name)].slice(0, 8))); } catch {}
}
// the keys in a title like "Line (D): drag on the board" or "Find (Ctrl+F)"
function keysIn(title) {
  const all = [...String(title || '').matchAll(/\(([^()]{1,24})\)/g)].map((m) => m[1].trim());
  return all.find((k) => /^(ctrl|shift|alt|pgup|pgdn|esc|space|`|[a-z0-9[\]]$|[a-z]:)/i.test(k) && !/\s{2}|[.,]$/.test(k)) || '';
}
function featureList() {
  const out = [], seen = new Set();
  const push = (f) => { const k = f.name.toLowerCase(); if (!f.name || seen.has(k)) return; seen.add(k); out.push(f); };
  const nameOf = (b) => (b.getAttribute('aria-label') || (b.title || '').split(/[:(;]|\. | – /)[0] || b.textContent).replace(/\s+/g, ' ').trim();
  const where = (b) => (b.closest('.hud-rail') ? 'Left bar' : b.closest('.hud-file') ? 'Top left' : b.closest('.hud-play') ? 'Top right' : b.closest('.hud-arrange') ? 'Bottom left' : b.closest('.hud-view') ? 'Bottom right' : 'Toolbar');
  const shown = (b) => !b.disabled && !b.closest('[hidden]:not(.menu-list)') && getComputedStyle(b).display !== 'none';
  for (const b of document.querySelectorAll('#toolbar button')) {
    if (b.id === 'btn-search' || b.closest('.menu-list') || b.closest('#url-bar') || !shown(b)) continue;
    const name = nameOf(b);
    if (!name || name.length < 2) continue;
    push({ name, desc: b.title && b.title !== name ? b.title : '', keys: keysIn(b.title), icon: b.querySelector('svg'), run: () => b.click(), where: where(b), words: FEATURE_WORDS[b.id] || '' });
  }
  for (const b of document.querySelectorAll('#toolbar .menu-list button, #toolbar .menu-list label.menu-check')) {
    if (b.disabled || b.closest('[hidden]:not(.menu-list)')) continue;
    const name = b.textContent.replace(/\s+/g, ' ').trim();
    if (!name || name.length < 2) continue;
    const owner = b.closest('.menu') && b.closest('.menu').querySelector('button[title]');
    const input = b.tagName === 'LABEL' ? b.querySelector('input') : null;
    push({ name: input && input.type === 'checkbox' ? `${name} (${input.checked ? 'on' : 'off'})` : name, desc: b.title || '', keys: keysIn(b.title), icon: owner && owner.querySelector('svg'),
      run: () => (input ? input.click() : b.click()), where: owner ? `${nameOf(owner)} menu` : 'Menu', words: '' });
  }
  for (const [name, desc, keys, run, icon] of FEATURE_EXTRA) push({ name, desc, keys, run, iconName: icon, where: keys ? 'Shortcut' : 'Board', words: '' });
  return out;
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function featureScore(f, words) {
  const name = f.name.toLowerCase();
  const hay = `${f.name} ${f.desc} ${f.words} ${f.where} ${f.keys}`.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (name.startsWith(w)) s += 30;
    else if (new RegExp('\\b' + reEsc(w)).test(name)) s += 20;
    else if (name.includes(w)) s += 12;
    else if (new RegExp('\\b' + reEsc(w)).test(hay)) s += 6;
    else return 0;
  }
  return s;
}

let featurePal = null;
function openFeatureSearch() {
  if (IS_VIEW) return;
  if (featurePal) { featurePal.input.focus(); featurePal.input.select(); return; }
  closeMediaSearch();
  const el = document.createElement('div');
  el.className = 'fs-pal';
  el.innerHTML = '<div class="fs-top"><span class="fs-badge"></span><input class="fs-input" type="text" spellcheck="false" placeholder="Search Ozy\'s features: crop, export, loop, lock…"><kbd class="fs-esc">Esc</kbd></div><div class="fs-list" role="listbox"></div><div class="fs-foot">↑ ↓ to choose · Enter to do it · this searches what Ozy can do — for pictures and videos use <b>Ctrl+Shift+F</b></div>';
  el.querySelector('.fs-badge').appendChild(iconSvg('search'));
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(el);
  const input = el.querySelector('.fs-input'), listEl = el.querySelector('.fs-list');
  const all = featureList();
  let shown = [], at = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    if (!words.length) {
      const rec = featureRecent();
      const recent = rec.map((n) => all.find((f) => f.name === n)).filter(Boolean);
      shown = [...recent.map((f) => ({ ...f, recent: true })), ...all.filter((f) => !recent.includes(f))];
    } else {
      shown = all.map((f) => ({ f, s: featureScore(f, words) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.f);
    }
    at = Math.min(at, Math.max(0, shown.length - 1));
    listEl.replaceChildren();
    if (!shown.length) { const n = document.createElement('div'); n.className = 'fs-none'; n.textContent = `No feature called "${input.value.trim()}". Looking for a picture or video? Ctrl+Shift+F`; listEl.appendChild(n); return; }
    shown.slice(0, 80).forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'fs-row' + (i === at ? ' on' : '');
      row.setAttribute('role', 'option');
      const ic = document.createElement('span'); ic.className = 'fs-ic';
      ic.appendChild(f.icon ? f.icon.cloneNode(true) : iconSvg(f.iconName || 'bolt'));
      const tx = document.createElement('span'); tx.className = 'fs-tx';
      const nm = document.createElement('span'); nm.className = 'fs-name'; nm.textContent = f.name;
      const ds = document.createElement('span'); ds.className = 'fs-desc'; ds.textContent = f.recent ? 'Used lately' : f.desc && f.desc !== f.name ? f.desc : '';
      tx.append(nm, ds);
      const wh = document.createElement('span'); wh.className = 'fs-where'; wh.textContent = f.where;
      row.append(ic, tx, wh);
      if (f.keys) { const k = document.createElement('kbd'); k.className = 'fs-key'; k.textContent = f.keys; row.appendChild(k); }
      row.addEventListener('pointermove', () => { if (at !== i) { at = i; for (const [j, r] of [...listEl.children].entries()) r.classList.toggle('on', j === i); } });
      row.addEventListener('click', () => runFeature(f));
      listEl.appendChild(row);
    });
  };
  const runFeature = (f) => {
    noteFeatureUsed(f.name.replace(/ \((on|off)\)$/, ''));
    closeFeatureSearch();
    try { f.run(); } catch (err) { setStatus('Could not do that here: ' + (err && err.message || err), 4000); }
  };
  input.addEventListener('input', () => { at = 0; draw(); listEl.scrollTop = 0; });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeFeatureSearch(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = Math.max(0, Math.min(Math.min(shown.length, 80) - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      [...listEl.children].forEach((r, j) => r.classList.toggle('on', j === at));
      const r = listEl.children[at]; if (r) r.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); if (shown[at]) runFeature(shown[at]); }
  });
  featurePal = { el, input };
  document.getElementById('btn-search').classList.add('toggled');
  draw();
  input.focus();
}
function closeFeatureSearch() {
  if (!featurePal) return;
  featurePal.el.remove();
  featurePal = null;
  const b = document.getElementById('btn-search'); if (b) b.classList.remove('toggled');
}

// ---- pictures and videos, by name ----
const MEDIA_KINDS = { file: 'Video', image: 'Picture', sequence: 'Sequence', youtube: 'YouTube', twitch: 'Twitch' };
let mediaPanel = null;
const mediaKind = (t) => (t.type == null ? 'file' : MEDIA_KINDS[t.type] ? t.type : null); // (a local video's tile has no type)
const mediaTiles = () => tiles.filter((t) => mediaKind(t));
const mediaSearchText = (t) => `${tileName(t)} ${t.title || ''} ${t.path ? t.path.replace(/[\\/]+/g, ' ') : ''} ${t.url || ''}`.toLowerCase();
function mediaThumb(t, img) {
  const k = mediaKind(t);
  const fail = () => img.classList.add('none');
  img.addEventListener('error', fail);
  if (k === 'youtube' && t.url) { const p = WebUrl.parse(t.url); if (p && p.id && p.kind !== 'playlist') { img.src = `https://i.ytimg.com/vi/${p.id}/mqdefault.jpg`; return; } }
  if ((k === 'image' || k === 'file') && t.path) {
    Promise.resolve(window.api.thumb(t.path)).then((p) => { if (p) img.src = window.api.videoUrl(p); else if (k === 'image') img.src = window.api.videoUrl(t.thumb || t.path); else fail(); }).catch(fail);
    return;
  }
  fail();
}
function openMediaSearch() {
  if (mediaPanel) { mediaPanel.input.focus(); mediaPanel.input.select(); return; }
  closeFeatureSearch();
  const el = document.createElement('div');
  el.className = 'ms-panel';
  el.innerHTML = '<div class="ms-head"><span class="ms-badge"></span><div class="ms-titles"><div class="ms-title">Pictures and videos</div><div class="ms-sub"></div></div><button class="ms-x" title="Close (Esc)"></button></div>'
    + '<input class="ms-input" type="text" spellcheck="false" placeholder="Search by name or folder…"><div class="ms-chips"></div><div class="ms-grid"></div>';
  el.querySelector('.ms-badge').appendChild(iconSvg('photosearch'));
  el.querySelector('.ms-x').appendChild(iconSvg('close'));
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(el);
  const input = el.querySelector('.ms-input'), grid2 = el.querySelector('.ms-grid'), chips = el.querySelector('.ms-chips'), sub = el.querySelector('.ms-sub');
  let kind = 'all';
  const present = new Set(mediaTiles().map(mediaKind));
  for (const [k, label] of [['all', 'All'], ...Object.entries(MEDIA_KINDS).filter(([k]) => present.has(k)).map(([k, l]) => [k, l === 'Video' ? 'Videos' : l === 'Picture' ? 'Pictures' : l])]) {
    const c = document.createElement('button'); c.className = 'ms-chip' + (k === 'all' ? ' on' : ''); c.textContent = label; c.dataset.k = k;
    c.addEventListener('click', () => { kind = k; for (const x of chips.children) x.classList.toggle('on', x === c); draw(); });
    chips.appendChild(c);
  }
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { const img = en.target; io.unobserve(img); const t = tiles.find((x) => x.id === img.dataset.tile); if (t) mediaThumb(t, img); }
  }, { root: grid2 });
  let shown = [];
  const draw = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = mediaTiles();
    shown = all.filter((t) => (kind === 'all' || mediaKind(t) === kind) && words.every((w) => mediaSearchText(t).includes(w)));
    shown.sort((a, b) => { const an = tileName(a).toLowerCase(), bn = tileName(b).toLowerCase(); const w = words[0] || ''; return (w && an.startsWith(w) ? 0 : 1) - (w && bn.startsWith(w) ? 0 : 1) || an.localeCompare(bn, undefined, { numeric: true }); });
    sub.textContent = words.length || kind !== 'all' ? `${shown.length} of ${all.length}` : `${all.length} on this board`;
    io.disconnect();
    grid2.replaceChildren();
    if (!shown.length) { const n = document.createElement('div'); n.className = 'ms-none'; n.textContent = all.length ? 'Nothing by that name.' : 'No pictures or videos on this board yet.'; grid2.appendChild(n); return; }
    for (const t of shown.slice(0, 300)) {
      const card = document.createElement('button');
      card.className = 'ms-card';
      card.title = t.path || t.url || tileName(t);
      const th = document.createElement('div'); th.className = 'ms-th';
      const img = document.createElement('img'); img.alt = ''; img.draggable = false; img.dataset.tile = t.id;
      th.appendChild(img);
      const kb = document.createElement('span'); kb.className = 'ms-kind k-' + mediaKind(t); kb.textContent = MEDIA_KINDS[mediaKind(t)];
      th.appendChild(kb);
      const nm = document.createElement('div'); nm.className = 'ms-name'; nm.textContent = tileName(t);
      card.append(th, nm);
      card.addEventListener('click', () => {
        if (isBoard() && t.board) selectOnly(t);
        focusTile(t);
        for (const c of grid2.querySelectorAll('.ms-card.on')) c.classList.remove('on');
        card.classList.add('on');
      });
      grid2.appendChild(card);
      io.observe(img);
    }
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeMediaSearch(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = grid2.querySelector('.ms-card'); if (c) c.click(); }
  });
  el.querySelector('.ms-x').addEventListener('click', closeMediaSearch);
  mediaPanel = { el, input, io };
  document.getElementById('btn-media-search').classList.add('toggled');
  draw();
  input.focus();
}
function closeMediaSearch() {
  if (!mediaPanel) return;
  mediaPanel.io.disconnect();
  mediaPanel.el.remove();
  mediaPanel = null;
  const b = document.getElementById('btn-media-search'); if (b) b.classList.remove('toggled');
}
document.getElementById('btn-search').addEventListener('click', () => (featurePal ? closeFeatureSearch() : openFeatureSearch()));
document.getElementById('btn-media-search').addEventListener('click', () => (mediaPanel ? closeMediaSearch() : openMediaSearch()));
// a click elsewhere closes the feature search (the picture search stays until Esc or ✕: you click through it)
window.addEventListener('pointerdown', (e) => { if (featurePal && !(e.target instanceof Node && (featurePal.el.contains(e.target) || e.target.closest && e.target.closest('#btn-search')))) closeFeatureSearch(); }, true);
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'k' && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); featurePal ? closeFeatureSearch() : openFeatureSearch(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); mediaPanel ? closeMediaSearch() : openMediaSearch(); }
}, true);

// ---------- the floating text style toolbar ----------
// One toolbar for the whole app, shown whenever the selection holds a text tile and parked just
// above the selected tiles' screen rects. Built once, imperatively (the CSP forbids innerHTML
// markup with inline style), then refreshed from the first selected tile.
let textToolbar = null;   // { el, ...controls }
let colorPop = null;
let styleTimer = null, styleBefores = null;

function selectedTextTiles() { return [...selection].filter((t) => t.type === 'text' && tiles.includes(t) && !t.locked && !t.links && !t.todo); } // (a bookmark block or to-do list has no text style bar)

function applyTextStyle(patch, { debounce = false } = {}) {
  const list = selectedTextTiles();
  if (!list.length) return;
  if (!styleBefores) styleBefores = list.map((t) => ({ ...t.style }));
  for (const t of list) { t.style = TextTile.normalize({ ...t.style, ...patch }); renderTextTile(t); }
  fillTextToolbar();
  positionTextToolbar();
  const commit = () => { const b = styleBefores; styleBefores = null; if (b) recordTextStyle(list, b); };
  clearTimeout(styleTimer);
  if (debounce) styleTimer = setTimeout(commit, 250); else commit();
}

function buildTextToolbar() {
  const el = document.createElement('div');
  el.className = 'text-toolbar';
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // never clears the selection or starts a lasso
    // a button press keeps the caret where it is; the select and the number inputs need the focus
    if (e.target.closest('button') && !e.target.closest('input, select')) e.preventDefault();
  });
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; el.appendChild(n); return n; };

  const font = mk('select', 'font');
  for (const f of TextTile.FONTS) {
    const o = document.createElement('option');
    o.value = f; o.textContent = f; o.style.fontFamily = f; // each option in its own face
    font.appendChild(o);
  }
  font.title = 'Font';
  font.addEventListener('change', () => applyTextStyle({ font: font.value }));

  const minus = mk('button', null, '−'); minus.title = 'Smaller';
  const size = mk('input'); size.type = 'number'; size.min = '8'; size.max = '400'; size.step = '2'; size.title = 'Size';
  const plus = mk('button', null, '+'); plus.title = 'Bigger';
  const bump = (d) => { const v = Number(size.value) || TextTile.DEFAULTS.size; size.value = String(v + d); applyTextStyle({ size: Number(size.value) }); };
  minus.addEventListener('click', () => bump(-2));
  plus.addEventListener('click', () => bump(2));
  size.addEventListener('input', () => applyTextStyle({ size: Number(size.value) }, { debounce: true }));

  mk('div', 'sep');
  const color = mk('button', 'swatch'); color.title = 'Text colour';
  color.addEventListener('click', () => openColorPop(color, textToolbar.state().color, (c) => applyTextStyle({ color: c })));

  mk('div', 'sep');
  const aligns = {};
  for (const [a, label] of [['left', 'L'], ['center', 'C'], ['right', 'R']]) {
    const b = mk('button', 'align', label);
    b.title = `Align ${a}`;
    b.addEventListener('click', () => applyTextStyle({ align: a }));
    aligns[a] = b;
  }

  mk('div', 'sep');
  const bubble = mk('button', 'bubble', 'Bubble');
  bubble.title = 'Draw the text inside a filled box';
  bubble.addEventListener('click', () => applyTextStyle({ bubble: !textToolbar.state().bubble }));
  const fill = mk('button', 'swatch'); fill.title = 'Fill (the second row: sticky note colours)';
  fill.addEventListener('click', () => openColorPop(fill, textToolbar.state().fill, (c) => { if (selectedTextTiles().some((t) => t.style.fit)) lastNoteColor = c; applyTextStyle({ fill: c }); }, TextTile.NOTE_COLORS));
  const outline = mk('button', 'swatch'); outline.title = 'Bubble outline';
  outline.addEventListener('click', () => openColorPop(outline, textToolbar.state().outline, (c) => applyTextStyle({ outline: c })));
  const ow = mk('input'); ow.type = 'number'; ow.min = '0'; ow.max = '20'; ow.step = '1'; ow.title = 'Outline width';
  ow.addEventListener('input', () => applyTextStyle({ outlineWidth: Number(ow.value) }, { debounce: true }));

  document.body.appendChild(el);
  // (2026-11-15) the shape: any text can become one (it keeps the box it has)
  const shape = mk('select', 'shape-pick'); shape.title = 'Shape';
  for (const [k, label] of SHAPE_KINDS) { const o = document.createElement('option'); o.value = k; o.textContent = label; shape.appendChild(o); }
  shape.addEventListener('change', () => {
    const z = board.zoom;
    applyTextStyle({ bubble: true, box: 'fixed', valign: 'middle', shape: shape.value === 'round' ? 'box' : shape.value, radius: shape.value === 'round' ? 18 / z : 0 });
  });
  textToolbar = { el, font, size, color, aligns, bubble, fill, outline, ow, shape, state: () => (selectedTextTiles()[0] || { style: TextTile.DEFAULTS }).style || TextTile.DEFAULTS };
  return textToolbar;
}

// the controls show the first selected text tile; mixed selections are not indicated
function fillTextToolbar() {
  const first = selectedTextTiles()[0];
  if (!textToolbar || !first) return;
  const s = first.style;
  textToolbar.font.value = s.font;
  if (document.activeElement !== textToolbar.size) textToolbar.size.value = String(s.size);
  textToolbar.color.style.background = s.color;
  for (const [a, b] of Object.entries(textToolbar.aligns)) b.classList.toggle('on', s.align === a);
  textToolbar.bubble.classList.toggle('on', s.bubble);
  textToolbar.fill.style.background = s.fill;
  textToolbar.outline.style.background = s.outline;
  if (document.activeElement !== textToolbar.ow) textToolbar.ow.value = String(s.outlineWidth);
  for (const c of [textToolbar.fill, textToolbar.outline, textToolbar.ow]) c.disabled = !s.bubble;
  if (textToolbar.shape) textToolbar.shape.value = !s.bubble ? 'box' : s.shape === 'box' && s.radius * board.zoom > 4 ? 'round' : s.shape;
}

function positionTextToolbar() {
  const list = selectedTextTiles();
  if (!textToolbar || !list.length) return;
  const rects = list.map((t) => t.el.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const el = textToolbar.el;
  const r = el.getBoundingClientRect();
  const maxX = document.documentElement.clientWidth - r.width - 8;
  let y = top - r.height - 8 - (rotHandle.hidden ? 0 : 34); // (clear of the turn handle above the tile)
  if (y < 40) y = bottom + 8; // under the app toolbar: flip below the tiles
  el.style.left = Math.max(8, Math.min(left, maxX)) + 'px';
  el.style.top = Math.max(8, Math.min(y, document.documentElement.clientHeight - r.height - 8)) + 'px';
}

function updateTextToolbar() {
  updateLineToolbar(); // (the line bar comes and goes with the selection too)
  updateRotateHandle(); // (and the turn handle)
  try { updateSelBar(); } catch {} // (and the selection bar; not yet set up while the app starts)
  const list = selectedTextTiles();
  if (!list.length || !isBoard() || IS_VIEW) {
    if (textToolbar) textToolbar.el.hidden = true;
    closeColorPop();
    return;
  }
  if (!textToolbar) buildTextToolbar();
  textToolbar.el.hidden = false;
  fillTextToolbar();
  positionTextToolbar();
}

function closeColorPop() { if (colorPop) { colorPop.remove(); colorPop = null; } }
// The 8 group colours plus a full picker, anchored under the swatch that opened it.
function openColorPop(anchor, current, onPick, extra = []) {
  const wasMine = colorPop && colorPop._anchor === anchor;
  closeColorPop();
  if (wasMine) return;
  const pop = document.createElement('div');
  pop.className = 'color-pop';
  pop._anchor = anchor;
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  for (const hex of Object.values(Groups.PALETTE)) {
    const b = document.createElement('button');
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => { onPick(hex); closeColorPop(); });
    pop.appendChild(b);
  }
  // (2026-11-15) a second row of colours, when asked (the sticky note colours)
  if (extra.length) { const br = document.createElement('div'); br.className = 'color-pop-break'; pop.appendChild(br); }
  for (const hex of extra) {
    const b = document.createElement('button');
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => { onPick(hex); closeColorPop(); });
    pop.appendChild(b);
  }
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#ffffff';
  picker.addEventListener('input', () => onPick(picker.value));
  pop.appendChild(picker);
  document.body.appendChild(pop);
  const a = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(a.left, document.documentElement.clientWidth - r.width - 8)) + 'px';
  pop.style.top = Math.min(a.bottom + 6, document.documentElement.clientHeight - r.height - 8) + 'px';
  colorPop = pop;
}
window.addEventListener('pointerdown', (e) => { if (colorPop && !colorPop.contains(e.target)) closeColorPop(); }, true);
// the floating text and line bars sit over the board in screen space: when the app's toolbar changes
// height (a status message coming or going wraps it), the board moves down or up under them, so they
// follow (2026-11-10)
try { new ResizeObserver(() => updateTextToolbar()).observe(document.getElementById('toolbar')); } catch {}

// ---------- lines (Mark, 2026-11-10) ----------
// Dividers and arrows on the board; the rules are in lib/linetile.js. A line tile's element is its
// box. Inside, an SVG draws the stroke, a wider see-through copy of it takes the clicks (so the empty
// parts of the box let clicks through to whatever is under them), and a highlight shows it selected.
// Its two ends get round handles to drag. The floating line bar sets the thickness (− / + / the
// slider / a number), colour, dashes and arrowheads; [ and ] make the selected lines thinner and
// thicker. Level lines are also guides: picture edges snap to them while moving or resizing, and
// the pictures between a stack of them can be lined up in one go (lib/rows.js).
const SVGNS = 'http://www.w3.org/2000/svg';
let lineLook = null; // the look the next drawn line gets: the last one set (null: the default)

function addLineTile(record = {}) {
  const b = record.board;
  const points = LineTile.cleanPoints(record.points);
  if (!b || ![b.x, b.y, b.w, b.h].every((n) => isFinite(Number(n))) || !(Number(b.w) > 0) || !(Number(b.h) > 0) || !points) return null;
  const el = document.createElement('div');
  el.className = 'tile line-tile';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'line-svg');
  const part = (cls) => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('class', cls); svg.appendChild(p); return p; };
  const sel = part('line-sel'), stroke = part('line-stroke'), headA = part('line-head'), headB = part('line-head'), hit = part('line-hit');
  el.appendChild(svg);
  const ends = [0, 1].map((i) => {
    const pin = document.createElement('div'); pin.className = 'line-end-pin';
    const h = document.createElement('div'); h.className = 'line-end'; h.dataset.end = String(i); h.title = 'Drag to move this end (Shift: in steps of 15°, Alt: no snapping)';
    pin.appendChild(h); el.appendChild(pin);
    return { pin, h };
  });
  const tile = {
    type: 'line', el, video: null, yt: null, img: null,
    points, style: LineTile.normalize(record.style),
    aspect: null, freeAspect: true, editing: false,
    board: { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) },
    bookmarks: [], sync: null, group: null, suppressClick: false, /* kept for older code paths */ guard: ClickGuard.create(), id: newTileId(Session.tileId(record)), volume: 0, ownMuted: false,
    galleryH: layout.rowHeight,
    lineParts: { svg, sel, stroke, headA, headB, hit, ends }, drawnKey: '',
    ends: null, freehand: record.freehand === true,
  };
  // (2026-11-15) its ends on tiles: [{ id, fx, fy } | null, same]
  if (Array.isArray(record.ends)) {
    const ok = (x) => x && typeof x.id === 'string' && Number.isFinite(x.fx) && Number.isFinite(x.fy) ? { id: x.id, fx: x.fx, fy: x.fy } : null;
    const ends = [ok(record.ends[0]), ok(record.ends[1])];
    if (ends.some(Boolean)) tile.ends = ends;
  }
  if (tile.freehand) el.classList.add('freehand');
  tiles.push(tile);
  if (tile.ends) attachDirty();
  el.addEventListener('pointerenter', () => { hoveredTile = tile; });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; });
  // (added before attachTileDrag's own menu, which then leaves this one alone)
  el.addEventListener('contextmenu', (e) => {
    if (!isBoard() || IS_VIEW) return;
    e.preventDefault(); e.stopPropagation();
    if (!selection.has(tile)) selectOnly(tile);
    showRowMenu(e, lineMenuItems(tile));
  });
  ends.forEach(({ h }, i) => h.addEventListener('pointerdown', (e) => startLineEndDrag(tile, i, e)));
  attachTileDrag(tile);
  canvas.appendChild(el);
  el.hidden = !isBoard();
  layoutTile(tile);
  return tile;
}

// draw the line into its box (only when its size, points or look changed: layoutTile runs on every
// step of a drag)
function drawLine(t) {
  const { w, h } = t.board;
  const key = `${w},${h},${JSON.stringify(t.points)},${JSON.stringify(t.style)}`;
  if (key === t.drawnKey) return;
  t.drawnKey = key;
  const P = t.lineParts, s = t.style;
  const local = t.points.map(([u, v]) => ({ x: u * w, y: v * h }));
  const n = local.length;
  // with an arrowhead, the stroke stops inside the head so its square end never pokes out of the tip
  const body = local.slice();
  if (s.start === 'arrow') body[0] = LineTile.shorten(local[1], local[0], s.width * 3);
  if (s.end === 'arrow') body[n - 1] = LineTile.shorten(local[n - 2], local[n - 1], s.width * 3);
  const d = LineTile.pathD(local);
  P.stroke.setAttribute('d', LineTile.pathD(body));
  P.sel.setAttribute('d', d);
  P.hit.setAttribute('d', d);
  P.headA.setAttribute('d', s.start === 'arrow' ? LineTile.arrowD(local[1], local[0], s.width) : '');
  P.headB.setAttribute('d', s.end === 'arrow' ? LineTile.arrowD(local[n - 2], local[n - 1], s.width) : '');
  P.svg.setAttribute('width', String(w));
  P.svg.setAttribute('height', String(h));
  t.el.style.setProperty('--lw', s.width + 'px');
  t.el.style.setProperty('--lc', s.color);
  P.stroke.style.strokeDasharray = LineTile.dashArray(s);
  P.stroke.style.strokeLinecap = s.start === 'arrow' || s.end === 'arrow' ? 'butt' : 'round';
  const a = local[0], z = local[n - 1];
  P.ends[0].pin.style.left = a.x + 'px'; P.ends[0].pin.style.top = a.y + 'px';
  P.ends[1].pin.style.left = z.x + 'px'; P.ends[1].pin.style.top = z.y + 'px';
}

const lineAbs = (t) => LineTile.toAbs(t.board, t.points);
// put a line through new board points (its box follows)
function setLineAbs(t, abs) {
  const r = LineTile.fromAbs(abs, t.style);
  if (!r) return;
  t.board = r.board; t.points = r.points;
  layoutTile(t);
}
// a new look, with the line's points where they were (a thicker line needs a bigger box)
function setLineStyle(t, style) {
  const abs = lineAbs(t);
  t.style = LineTile.normalize(style);
  setLineAbs(t, abs);
}
// What a tile's edges are for snapping: its box; for a line, its stroke when it is level or
// upright (a picture stops right at the line), else nothing.
function snapBoxOf(t) {
  if (t.type !== 'line') return t.board;
  return LineTile.strokeBox(lineAbs(t), t.style.width);
}

// ---- undo: a tile's shape (box, crop, a line's points and look) before and after ----
// { kind: 'state', label, changes: [{ tile, before, after }] }
function shapeState(t) {
  return {
    board: t.board ? { ...t.board } : null, aspect: t.aspect, crop: t.crop ? { ...t.crop } : null, rotation: t.rotation || 0,
    ...(t.type === 'line' ? { points: t.points.map((p) => p.slice()), style: { ...t.style }, ends: t.ends ? t.ends.map((e) => (e ? { ...e } : null)) : null } : {}),
  };
}
function setShapeState(t, s) {
  if (s.board) t.board = { ...s.board };
  t.rotation = s.rotation || 0;
  if (t.type === 'line') { t.points = s.points.map((p) => p.slice()); t.style = { ...s.style }; if ('ends' in s) setLineEnds(t, s.ends); }
  else if (t.type === 'image') { t.crop = s.crop ? { ...s.crop } : null; t.aspect = s.aspect; applyCrop(t); }
  layoutTile(t);
  if (t.type === 'text') renderTextTile(t);
}
function recordStates(label, list, befores) {
  const changes = list.map((t, i) => ({ tile: t, before: befores[i], after: shapeState(t) })).filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
  if (changes.length) undoStack.push({ kind: 'state', label, changes });
  return changes.length;
}

// ---- dragging an end, and drawing a new line ----
// Where an end may snap besides level / upright: the ends of other lines and the edges of other
// tiles, within SNAP_PX on screen (so dividers start and stop in line with each other).
function snapLineEnd(p, fixed, exclude) {
  const th = SNAP_PX / board.zoom;
  const level = Math.abs(p.y - fixed.y) < 1e-9, upright = Math.abs(p.x - fixed.x) < 1e-9;
  let bx = null, by = null;
  const tryX = (x) => { const d = Math.abs(x - p.x); if (d <= th && (!bx || d < bx.d)) bx = { d, x }; };
  const tryY = (y) => { const d = Math.abs(y - p.y); if (d <= th && (!by || d < by.d)) by = { d, y }; };
  for (const t of tiles) {
    if (!t.board || t === exclude) continue;
    if (t.type === 'line') { for (const q of lineAbs(t)) { tryX(q.x); tryY(q.y); } continue; }
    const b = t.board;
    tryX(b.x); tryX(b.x + b.w); tryY(b.y); tryY(b.y + b.h);
  }
  hideGuides();
  const out = { ...p };
  if (bx && !upright) { out.x = bx.x; showGuideV(bx.x); }
  if (by && !level) { out.y = by.y; showGuideH(by.y); }
  return out;
}
function startLineEndDrag(tile, end, e) {
  if (IS_VIEW || !isBoard() || e.button !== 0 || tile.locked) return;
  e.preventDefault(); e.stopPropagation();
  const handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch {}
  const before = shapeState(tile);
  const abs0 = lineAbs(tile);
  const idx = end === 0 ? 0 : abs0.length - 1;
  const fixed = abs0[end === 0 ? 1 : abs0.length - 2];
  const ends0 = tile.ends ? tile.ends.slice() : [null, null];
  let onEnd = null; // the tile this end is over: it goes on it when dropped
  document.body.classList.add('resizing');
  const onMove = (ev) => {
    let p = toCanvas(ev.clientX, ev.clientY);
    const target = ev.altKey ? null : attachTargetAt(ev.clientX, ev.clientY, tile);
    onEnd = target ? attachEnd(target, p) : null;
    showAttachTarget(target);
    if (onEnd) { p = { x: onEnd.x, y: onEnd.y }; hideGuides(); }
    else if (!ev.altKey) { p = LineTile.snapEnd(fixed, p, ev.shiftKey ? { step: 15 } : {}); p = snapLineEnd(p, fixed, tile); } else hideGuides();
    const ends = ends0.slice(); ends[end] = null; // (loose while it moves; on a tile once dropped)
    tile.ends = ends.some(Boolean) ? ends : null;
    const abs = abs0.slice(); abs[idx] = p;
    setLineAbs(tile, abs);
    updateLineToolbar();
  };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    activeInteractions.delete(onUp);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.removeEventListener('lostpointercapture', onUp);
    document.body.classList.remove('resizing');
    hideGuides();
    showAttachTarget(null);
    const ends = tile.ends ? tile.ends.slice() : [null, null];
    ends[end] = onEnd ? { id: onEnd.id, fx: onEnd.fx, fy: onEnd.fy } : null;
    setLineEnds(tile, ends);
    reattachLine(tile); // (an elbowed or curved line is routed again)
    if (recordStates(onEnd ? 'attach line end' : 'move line end', [tile], [before])) scheduleOffscreen();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.addEventListener('lostpointercapture', onUp);
  activeInteractions.add(onUp);
}

// The line tool (the ╱ button, or D): press and drag on the board to draw one line; a click
// without a drag draws a level one. Esc, or the button again, puts the tool away.
let lineTool = false;
function setLineTool(on) {
  lineTool = !!on && isBoard() && !IS_VIEW;
  document.body.classList.toggle('line-tool', lineTool);
  const btn = document.getElementById('add-line');
  if (btn) btn.classList.toggle('toggled', lineTool);
  if (lineTool) setStatus('Line: drag on the board to draw it (Shift: 15° steps). Esc: done', 6000);
}
function newLineLook() {
  const dark = layout.background !== 'light';
  // about 3 px on screen at the zoom it is drawn at, unless a look was set since
  const base = { color: dark ? '#e6e6e6' : '#1a1a1a', width: LineTile.tidy(3 / board.zoom), dash: 'solid', start: 'none', end: 'none' };
  return LineTile.normalize(lineLook ? { ...base, ...lineLook } : base);
}
grid.addEventListener('pointerdown', (e) => {
  if (!lineTool || e.button !== 0 || !isBoard() || IS_VIEW) return;
  if (e.target.closest && e.target.closest('.text-toolbar, .ctx')) return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  try { grid.setPointerCapture(e.pointerId); } catch {}
  let p0 = toCanvas(e.clientX, e.clientY);
  const s0 = { x: e.clientX, y: e.clientY };
  const style = newLineLook();
  // (2026-11-15) started on a tile: the line starts on it (the middle of its side nearest the press)
  const startOn = e.altKey ? null : attachTargetAt(e.clientX, e.clientY, null);
  const startEnd = startOn ? attachEnd(startOn, p0) : null;
  if (startEnd) p0 = { x: startEnd.x, y: startEnd.y };
  let endOn = null;
  let tile = null;
  const onMove = (ev) => {
    if (!tile && Math.hypot(ev.clientX - s0.x, ev.clientY - s0.y) < 4) return;
    let p = toCanvas(ev.clientX, ev.clientY);
    const target = ev.altKey ? null : attachTargetAt(ev.clientX, ev.clientY, tile);
    endOn = target && target !== startOn ? attachEnd(target, p) : null;
    showAttachTarget(endOn ? target : null);
    if (endOn) { p = { x: endOn.x, y: endOn.y }; hideGuides(); }
    else if (!ev.altKey) { p = LineTile.snapEnd(p0, p, ev.shiftKey ? { step: 15 } : {}); p = snapLineEnd(p, p0, tile); } else hideGuides();
    const r = LineTile.fromAbs([p0, p], style);
    if (!r) return;
    if (!tile) { tile = addLineTile({ board: r.board, points: r.points, style }); if (!tile) return; bringToFront(tile); }
    else { tile.board = r.board; tile.points = r.points; layoutTile(tile); }
  };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    activeInteractions.delete(onUp);
    grid.removeEventListener('pointermove', onMove);
    grid.removeEventListener('pointerup', onUp);
    grid.removeEventListener('pointercancel', onUp);
    grid.removeEventListener('lostpointercapture', onUp);
    hideGuides();
    if (!tile) { // a click: a level line 200 px long on screen, from where it was clicked
      const r = LineTile.fromAbs([p0, { x: p0.x + 200 / board.zoom, y: p0.y }], style);
      tile = r && addLineTile({ board: r.board, points: r.points, style });
      if (tile) bringToFront(tile);
    }
    setLineTool(false);
    showAttachTarget(null);
    if (!tile) return;
    if (startEnd || endOn) { setLineEnds(tile, [startEnd, endOn]); reattachLine(tile); }
    selectOnly(tile);
    recordAdd([tile], 'draw line');
    updateChrome(); markOnBoard();
    setStatus('Line drawn – drag its ends to change it; [ ] thinner / thicker', 5000);
  };
  grid.addEventListener('pointermove', onMove);
  grid.addEventListener('pointerup', onUp);
  grid.addEventListener('pointercancel', onUp);
  grid.addEventListener('lostpointercapture', onUp);
  activeInteractions.add(onUp);
}, true);
document.getElementById('add-line').addEventListener('click', () => {
  if (!isBoard()) { setStatus('Lines live on the board – switch to Board mode'); return; }
  setLineTool(!lineTool);
});
window.addEventListener('keydown', (e) => { if (lineTool && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLineTool(false); } }, true);

// ---------- arrows that stay on what they point at; the pen (Mark, 2026-11-15) ----------
// A line's end dropped on a picture, shape or note stays on it: line.ends[i] = { id, fx, fy } (where
// on that tile's box, at the middle of the side it was dropped nearest). When that tile moves,
// resizes or is undone, the line follows; an elbowed or curved line is routed again
// (lib/linetile.js route). Alt while dropping: a loose end. Frames, locked tiles and other lines are
// never ends. An arrow held at both ends is changed by its ends, not dragged on its own.
let attachIndex = null; // Map(tile id -> Set(lines with an end on it)); null: to be worked out again
function attachDirty() { attachIndex = null; }
function attachedLinesOf(t) {
  if (!attachIndex) {
    attachIndex = new Map();
    for (const ln of tiles) if (ln.type === 'line' && ln.ends) for (const e of ln.ends) if (e && e.id) { if (!attachIndex.has(e.id)) attachIndex.set(e.id, new Set()); attachIndex.get(e.id).add(ln); }
  }
  return attachIndex.get(t.id) || null;
}
// where an end on a tile is now (null when that tile is gone or off the board)
function endPoint(e) {
  const t = e && e.id ? tileById(e.id) : null;
  if (!t || !t.board) return null;
  const b = t.board;
  return { x: b.x + e.fx * b.w, y: b.y + e.fy * b.h, dir: LineTile.sideDir(e.fx, e.fy) };
}
function reattachLine(ln) {
  if (!ln.ends || !tiles.includes(ln)) return;
  const A0 = endPoint(ln.ends[0]), B0 = endPoint(ln.ends[1]);
  if (!A0 && !B0) return;
  const abs = lineAbs(ln);
  const A = A0 || { ...abs[0], dir: null }, B = B0 || { ...abs[abs.length - 1], dir: null };
  let pts;
  if (ln.style.route !== 'straight' || abs.length === 2) pts = LineTile.route(A, B, ln.style.route);
  else { pts = abs.map((p) => ({ x: p.x, y: p.y })); pts[0] = { x: A.x, y: A.y }; pts[pts.length - 1] = { x: B.x, y: B.y }; }
  setLineAbs(ln, pts);
}
// the tile under a point that an end can go on
function attachTargetAt(clientX, clientY, exclude) {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const te = el.closest && el.closest('.tile');
    if (!te) continue;
    const t = tiles.find((x) => x.el === te);
    if (!t || t === exclude || t.type === 'line' || t.frame || t.locked || !t.board) continue;
    return t;
  }
  return null;
}
// the middle of the target's side nearest p: { id, fx, fy, x, y }
function attachEnd(t, p) {
  const b = t.board;
  const sides = [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1]].map(([fx, fy]) => ({ fx, fy, x: b.x + fx * b.w, y: b.y + fy * b.h }));
  sides.sort((u, v) => Math.hypot(u.x - p.x, u.y - p.y) - Math.hypot(v.x - p.x, v.y - p.y));
  return { id: t.id, ...sides[0] };
}
let attachShown = null;
function showAttachTarget(t) { if (attachShown === t) return; if (attachShown) attachShown.el.classList.remove('attach-target'); attachShown = t; if (t) t.el.classList.add('attach-target'); }
function setLineEnds(ln, ends) { ln.ends = ends && ends.some(Boolean) ? ends.map((e) => (e ? { id: e.id, fx: e.fx, fy: e.fy } : null)) : null; attachDirty(); }

// ---- the pen and the highlighter ----
// P draws with the pen, Shift+P with the highlighter (or the ✎ menu); it stays on for stroke after
// stroke until Esc or P again. Each stroke is a line (lib/linetile.js) of many points, smoothed a
// little, one undo each; select one to change its colour or thickness in the line bar.
let penTool = null; // null | 'pen' | 'highlighter'
function setPenTool(kind) {
  penTool = kind && isBoard() && !IS_VIEW ? kind : null;
  if (penTool && lineTool) setLineTool(false);
  document.body.classList.toggle('pen-tool', !!penTool);
  const btn = document.getElementById('btn-pen');
  if (btn) btn.classList.toggle('toggled', !!penTool);
  if (penTool) setStatus(`${penTool === 'pen' ? 'Pen' : 'Highlighter'}: draw on the board. Esc or ${penTool === 'pen' ? 'P' : 'Shift+P'} to stop`, 6000);
}
let penLook = { pen: null, highlighter: null }; // the last look set on a stroke of each kind
function newPenLook(kind) {
  const z = board.zoom, dark = layout.background !== 'light';
  const base = kind === 'highlighter'
    ? { color: '#ffe14d80', width: LineTile.tidy(22 / z), dash: 'solid', start: 'none', end: 'none', route: 'straight' }
    : { color: dark ? '#e6e6e6' : '#1a1a1a', width: LineTile.tidy(3 / z), dash: 'solid', start: 'none', end: 'none', route: 'straight' };
  return LineTile.normalize(penLook[kind] ? { ...base, ...penLook[kind] } : base);
}
grid.addEventListener('pointerdown', (e) => {
  if (!penTool || e.button !== 0 || !isBoard() || IS_VIEW) return;
  if (e.target.closest && e.target.closest('.text-toolbar, .ctx')) return;
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  try { grid.setPointerCapture(e.pointerId); } catch {}
  const kind = penTool;
  const style = newPenLook(kind);
  const pts = [toCanvas(e.clientX, e.clientY)];
  let last = { x: e.clientX, y: e.clientY };
  let tile = null;
  const onMove = (ev) => {
    if (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) < 1.5) return; // (a point every pixel and a half is plenty)
    last = { x: ev.clientX, y: ev.clientY };
    pts.push(toCanvas(ev.clientX, ev.clientY));
    const r = LineTile.fromAbs(pts, style);
    if (!r) return;
    if (!tile) { tile = addLineTile({ board: r.board, points: r.points, style, freehand: true }); if (tile) bringToFront(tile); }
    else { tile.board = r.board; tile.points = r.points; layoutTile(tile); }
  };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    activeInteractions.delete(onUp);
    grid.removeEventListener('pointermove', onMove);
    grid.removeEventListener('pointerup', onUp);
    grid.removeEventListener('pointercancel', onUp);
    grid.removeEventListener('lostpointercapture', onUp);
    if (!tile) { // a click: a dot
      const p = pts[0], d = style.width * 0.01;
      const r = LineTile.fromAbs([p, { x: p.x + d, y: p.y }], style);
      tile = r && addLineTile({ board: r.board, points: r.points, style, freehand: true });
      if (tile) bringToFront(tile);
    } else setLineAbs(tile, LineTile.simplify(pts, 0.6 / board.zoom)); // fewer points, the same stroke
    if (!tile) return;
    recordAdd([tile], kind === 'pen' ? 'draw' : 'highlight');
    updateChrome(); markOnBoard();
  };
  grid.addEventListener('pointermove', onMove);
  grid.addEventListener('pointerup', onUp);
  grid.addEventListener('pointercancel', onUp);
  grid.addEventListener('lostpointercapture', onUp);
  activeInteractions.add(onUp);
}, true);
window.addEventListener('keydown', (e) => { if (penTool && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPenTool(null); } }, true);
document.getElementById('btn-pen').addEventListener('click', (e) => {
  showRowMenu(menuAt(e.currentTarget), [
    [penTool === 'pen' ? 'Pen  (P) – on' : 'Pen  (P)', () => setPenTool(penTool === 'pen' ? null : 'pen')],
    [penTool === 'highlighter' ? 'Highlighter  (Shift+P) – on' : 'Highlighter  (Shift+P)', () => setPenTool(penTool === 'highlighter' ? null : 'highlighter')],
    ['Stop drawing  (Esc)', () => setPenTool(null), !penTool],
  ]);
});

// ---- what the menu and keys act on ----
function selectedLines() { return [...selection].filter((t) => t.type === 'line' && tiles.includes(t) && !t.locked); }
// the selected lines when this one is among them, else just this one
function linesFor(tile) { const sel = selectedLines(); return tile && !selection.has(tile) ? [tile] : sel.length ? sel : tile ? [tile] : []; }

let lineStyleTimer = null, lineStyleBefores = null, lineStyleList = null;
// restyle lines (patch: some of the style, or a function of each line's style); one undo per burst
function applyLineStyle(list, patch, { debounce = false } = {}) {
  if (!list.length) return;
  if (!lineStyleBefores || lineStyleList.length !== list.length || lineStyleList.some((t, i) => t !== list[i])) {
    commitLineStyle();
    lineStyleList = list.slice(); lineStyleBefores = list.map(shapeState);
  }
  for (const t of list) setLineStyle(t, { ...t.style, ...(typeof patch === 'function' ? patch(t.style) : patch) });
  lineLook = { ...list[list.length - 1].style }; // the next line drawn looks like this
  updateLineToolbar();
  clearTimeout(lineStyleTimer);
  if (debounce) lineStyleTimer = setTimeout(commitLineStyle, 400); else commitLineStyle();
}
function commitLineStyle() {
  clearTimeout(lineStyleTimer);
  const list = lineStyleList, befores = lineStyleBefores;
  lineStyleList = null; lineStyleBefores = null;
  if (list) recordStates(list.length === 1 ? 'line look' : `look of ${list.length} lines`, list.filter((t) => tiles.includes(t)), befores.filter((_, i) => tiles.includes(list[i])));
}
function stepLines(dir, tile) {
  const list = linesFor(tile);
  if (!list.length) return;
  applyLineStyle(list, (s) => ({ width: LineTile.step(s.width, dir) }), { debounce: true });
  const w = list[0].style.width;
  setStatus(`${list.length === 1 ? 'Line' : list.length + ' lines'}: ${+w.toPrecision(3)} px thick`, 2000);
}
// every line with the same colour and thickness as this one (the dividers of a board, say), so they
// can all be changed at once
function selectLinesLike(tile) {
  const same = tiles.filter((t) => t.type === 'line' && t.board && t.style.color === tile.style.color && Math.abs(t.style.width - tile.style.width) <= tile.style.width * 0.02);
  clearSelection();
  for (const t of same) setSelected(t, true);
  setStatus(`${same.length} line${same.length === 1 ? '' : 's'} selected – the line bar changes them all`, 5000);
}
function removeLines(tile) {
  const list = linesFor(tile).filter((t) => !t.locked);
  for (const t of list) removeTile(t);
  setStatus(list.length === 1 ? 'Line removed' : `${list.length} lines removed`, 2500);
}

// ---- rows between level lines ----
function levelGuides() {
  const out = [];
  for (const t of tiles) {
    if (t.type !== 'line' || !t.board) continue;
    const sb = snapBoxOf(t);
    if (sb && sb.axis === 'h') out.push({ id: t.id, y: sb.y + sb.h / 2, x1: sb.x, x2: sb.x + sb.w, width: t.style.width });
  }
  return out;
}
const isLevelLine = (t) => { const sb = t && t.type === 'line' ? snapBoxOf(t) : null; return !!sb && sb.axis === 'h'; };
function rowItems({ picturesOnly = false } = {}) {
  return tiles.filter((t) => t.board && !t.rotation && !t.locked && !t.frame && t.type !== 'line' && (t.type === 'text' ? !picturesOnly : (picturesOnly ? t.type === 'image' : t.aspect > 0)))
    .map((t) => ({ id: t.id, kind: t.type === 'text' ? 'text' : 'picture', board: { ...t.board }, aspect: t.aspect, crop: t.crop || null }));
}
function rowsPicked(tile) { return linesFor(tile).filter(isLevelLine).map((t) => t.id); }
function lineUpRows(tile) {
  const { boxes, report } = Rows.tidy(levelGuides(), rowItems(), { picked: rowsPicked(tile) });
  if (!boxes.size) {
    setStatus(report.skippedStacked ? 'Those rows have pictures stacked above each other; left as they are' : 'No pictures between these lines (draw a line above and below a row)', 5000);
    return;
  }
  const list = [...boxes.keys()].map(tileById).filter(Boolean);
  const befores = list.map(shapeState);
  for (const t of list) { t.board = { ...boxes.get(t.id) }; layoutTile(t); if (t.type === 'text') renderTextTile(t); }
  recordStates('line up pictures', list, befores);
  scheduleOffscreen();
  const left = [];
  if (report.skippedTall) left.push(`${report.skippedTall} spanning rows`);
  if (report.skippedStacked) left.push(`${report.skippedStacked} row${report.skippedStacked === 1 ? '' : 's'} of stacked pictures`);
  setStatus(`Lined up ${report.pictures} picture${report.pictures === 1 ? '' : 's'} in ${report.rows} row${report.rows === 1 ? '' : 's'}` + (report.texts ? `, with ${report.texts} caption${report.texts === 1 ? '' : 's'}` : '') + (left.length ? ` (left alone: ${left.join(', ')})` : '') + ' – Ctrl+Z undoes', 8000);
}
function trimAtLines(tile) {
  const { changes, report } = Rows.trim(levelGuides(), rowItems({ picturesOnly: true }), { picked: rowsPicked(tile) });
  if (!changes.size) { setStatus('No picture crosses these lines', 4000); return; }
  const list = [...changes.keys()].map(tileById).filter(Boolean);
  const befores = list.map(shapeState);
  for (const t of list) {
    const c = changes.get(t.id);
    t.crop = { ...c.crop }; t.board = { ...c.board }; t.aspect = c.board.w / c.board.h;
    t.thumbH = 0; applyCrop(t); layoutTile(t);
  }
  recordStates('trim pictures at lines', list, befores);
  scheduleOffscreen();
  setStatus(`Trimmed ${report.pictures} picture${report.pictures === 1 ? '' : 's'} at the lines (a crop: right-click → Reset crop brings a picture back) – Ctrl+Z undoes`, 8000);
}
function lineMenuItems(tile) {
  const level = isLevelLine(tile);
  return [
    ['Thicker  ( ] )', () => stepLines(1, tile)],
    ['Thinner  ( [ )', () => stepLines(-1, tile)],
    ['Select lines like this one', () => selectLinesLike(tile)],
    ['Line up the pictures between these lines', () => lineUpRows(tile), !level],
    ['Trim pictures at these lines', () => trimAtLines(tile), !level],
    ...stackMenuItems(tile),
    lockMenuItem(tile),
    ['Remove', () => removeLines(tile)],
  ];
}

// ---- the floating line bar ----
let lineBar = null;
function buildLineBar() {
  const el = document.createElement('div');
  el.className = 'text-toolbar line-toolbar';
  el.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target.closest('button') && !e.target.closest('input, select')) e.preventDefault(); });
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; el.appendChild(n); return n; };
  const label = mk('span', 'lb-label', 'Line');
  const thinner = mk('button', null, '−'); thinner.title = 'Thinner ( [ )';
  const slider = mk('input', 'lb-slider'); slider.type = 'range'; slider.min = '0'; slider.max = '1000'; slider.step = '1'; slider.title = 'Thickness';
  const thicker = mk('button', null, '+'); thicker.title = 'Thicker ( ] )';
  const width = mk('input', 'lb-width'); width.type = 'number'; width.min = String(LineTile.MIN_W); width.max = String(LineTile.MAX_W); width.step = 'any'; width.title = 'Thickness (board pixels)';
  const lines = () => selectedLines();
  thinner.addEventListener('click', () => stepLines(-1));
  thicker.addEventListener('click', () => stepLines(1));
  slider.addEventListener('input', () => applyLineStyle(lines(), { width: LineTile.fromSlider(Number(slider.value)) }, { debounce: true }));
  width.addEventListener('input', () => { const v = Number(width.value); if (v > 0) applyLineStyle(lines(), { width: v }, { debounce: true }); });
  mk('div', 'sep');
  const color = mk('button', 'swatch'); color.title = 'Colour';
  color.addEventListener('click', () => openColorPop(color, (lines()[0] || {}).style ? lines()[0].style.color : '#1a1a1a', (c) => applyLineStyle(lines(), { color: c })));
  mk('div', 'sep');
  const dash = mk('select', 'lb-dash'); dash.title = 'Solid, dashed or dotted';
  for (const [v, t] of [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; dash.appendChild(o); }
  dash.addEventListener('change', () => applyLineStyle(lines(), { dash: dash.value }));
  const route = mk('select', 'lb-route'); route.title = 'Straight, elbowed or curved';
  for (const [v, t] of [['straight', 'Straight'], ['elbow', 'Elbow'], ['curve', 'Curved']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; route.appendChild(o); }
  route.addEventListener('change', () => {
    const list = lines().filter((t) => !t.freehand);
    applyLineStyle(list, { route: route.value });
    // routed again now, between its ends where they are
    for (const t of list) {
      const abs = lineAbs(t), en = t.ends || [];
      const A = endPoint(en[0]) || { ...abs[0], dir: null }, B = endPoint(en[1]) || { ...abs[abs.length - 1], dir: null };
      setLineAbs(t, LineTile.route(A, B, route.value));
    }
  });
  const startCap = mk('button', 'lb-cap', '◀'); startCap.title = 'Arrowhead at the start';
  const endCap = mk('button', 'lb-cap', '▶'); endCap.title = 'Arrowhead at the end';
  startCap.addEventListener('click', () => { const on = (lines()[0] || {}).style && lines()[0].style.start === 'arrow'; applyLineStyle(lines(), { start: on ? 'none' : 'arrow' }); });
  endCap.addEventListener('click', () => { const on = (lines()[0] || {}).style && lines()[0].style.end === 'arrow'; applyLineStyle(lines(), { end: on ? 'none' : 'arrow' }); });
  mk('div', 'sep');
  const like = mk('button', null, 'Select alike'); like.title = 'Select every line with this colour and thickness, to change them all at once';
  like.addEventListener('click', () => { const t = lines()[0]; if (t) selectLinesLike(t); });
  const tidy = mk('button', null, 'Line up rows'); tidy.title = 'Line up the pictures between these lines: same height, side by side, tops level';
  tidy.addEventListener('click', () => { const t = lines()[0]; if (t) lineUpRows(t); });
  const trim = mk('button', null, 'Trim'); trim.title = 'Cut pictures where they cross these lines (a crop: nothing is lost)';
  trim.addEventListener('click', () => { const t = lines()[0]; if (t) trimAtLines(t); });
  document.body.appendChild(el);
  lineBar = { el, label, slider, width, color, dash, route, startCap, endCap, tidy, trim };
  return lineBar;
}
function updateLineToolbar() {
  const list = selectedLines();
  if (!list.length || !isBoard() || IS_VIEW) { if (lineBar) lineBar.el.hidden = true; return; }
  if (!lineBar) buildLineBar();
  const b = lineBar, s = list[0].style;
  b.el.hidden = false;
  b.label.textContent = list.length === 1 ? 'Line' : `${list.length} lines`;
  if (document.activeElement !== b.slider) b.slider.value = String(LineTile.toSlider(s.width));
  if (document.activeElement !== b.width) b.width.value = String(+s.width.toPrecision(3));
  b.color.style.background = s.color;
  b.dash.value = s.dash;
  b.route.value = s.route || 'straight';
  b.route.disabled = list.every((t) => t.freehand);
  b.startCap.classList.toggle('on', s.start === 'arrow');
  b.endCap.classList.toggle('on', s.end === 'arrow');
  const level = list.some(isLevelLine);
  b.tidy.disabled = !level; b.trim.disabled = !level;
  // above the selected lines, or under them when the text bar is up there too
  const rects = list.map((t) => t.el.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left)), top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
  const r = b.el.getBoundingClientRect();
  const textUp = textToolbar && !textToolbar.el.hidden;
  let y = textUp ? bottom + 8 : top - r.height - 8;
  if (y < 40) y = bottom + 8;
  b.el.style.left = Math.max(8, Math.min(left, document.documentElement.clientWidth - r.width - 8)) + 'px';
  b.el.style.top = Math.max(8, Math.min(y, document.documentElement.clientHeight - r.height - 8)) + 'px';
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
    board: null, suppressClick: false, /* kept for older code paths */ guard: ClickGuard.create(), id: newTileId(Session.tileId(state)), bookmarks: parseBookmarks(state.bookmarks), group: null, sync: null,
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
  observePb(tile); // its playback changes reach the other windows
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
    if (playing) tile.autoPaused = false; // any play ends an offscreen pause
    playBtn.textContent = playing ? '❚❚' : '▶';
    el.classList.toggle('paused-badge', !playing);
    if (tile.group && tile.group === active) renderGroupBar();
  };
  const pb = tile.pb = {
    web: false, kind: 'frames', settling: false,
    get frameSlack() { return 1.5 / tile.fps; },
    get time() { return tile.frame / tile.fps; }, // frame i covers [i / fps, (i + 1) / fps)
    set time(t) { seekFrame(t * tile.fps + 1e-6); },
    scrub(t) { seekFrame(t * tile.fps + 1e-6); }, // frames come from the cache: no preview needed
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
  // (gallery; on the board the tile owns the pointer and tileClick() runs tile.timeClick instead)
  timeEl.addEventListener('click', (e) => { e.stopPropagation(); cycleTimeDisplay(); });
  tile.timeClick = cycleTimeDisplay;
  /* DISABLED (2026-10-07): body moved into cycleTimeDisplay() so the board path can share it
  timeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const modes = ['clock', 'frames', 'timecode'];
    layout.timeDisplay = modes[(modes.indexOf(layout.timeDisplay) + 1) % modes.length];
    for (const t of tiles) t.refreshTime && t.refreshTime();
    renderTimeline();
  });
  */
  // frames come from the cache, but a synced YouTube member does not: throttle the broadcast
  const scrubber = Scrub.create();
  const beginScrub = () => { tile.scrubbing = true; el.classList.add('scrubbing'); };
  const endScrub = () => {
    const wasScrubbing = tile.scrubbing;
    tile.scrubbing = false; el.classList.remove('scrubbing');
    if (wasScrubbing) { scrubber.end(0); broadcast(tile, 'seek'); }
  };
  seek.addEventListener('pointerdown', beginScrub);
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);
  seek.addEventListener('input', () => {
    const frac = Number(seek.value) / 10000;
    seekFrame(Math.round(frac * (total - 1)));
    seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
    refreshTime();
    if (!tile.scrubbing) { broadcast(tile, 'seek'); return; }
    if (scrubber.move(frac, performance.now()) !== null) broadcast(tile, 'scrub'); // preview the group
  });
  rateSel.addEventListener('change', () => { pb.rate = Number(rateSel.value); broadcast(tile, 'rate', pb.rate); });
  cv.addEventListener('click', (e) => { if (e.shiftKey) return; if (!tile.guard.shouldAct()) return; tile.togglePlay(); });
  cv.addEventListener('dblclick', () => { if (!cmp.el.hidden || sedOpen()) return; toggleTileFullscreen(el); });
  el.addEventListener('dblclick', (e) => tileDblClick(tile, e)); // board: the tile gets it, not the canvas
  el.addEventListener('click', (e) => {
    tileClick(tile, e);
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

  el.addEventListener('pointerenter', () => { hoveredTile = tile; hpEnter(tile); });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; hpLeave(tile); });
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
    : !!tile.fpsOverride || (!!tile.quality && tile.quality !== 'scene');
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
  if (tile.applyQuality) { // local videos: this tile's own playback resolution
    const q = document.createElement('select');
    for (const [v, label] of [['scene', 'Scene default'], ['full', 'Full'], ['half', '½ resolution'], ['quarter', '¼ resolution']]) { const o = document.createElement('option'); o.value = v; o.textContent = label; q.appendChild(o); }
    q.value = tile.quality;
    row('Quality', q);
    q.addEventListener('change', () => { tile.quality = q.value; tile.applyQuality(); refreshSettingsMark(tile); });
    note('Playback resolution. Lower = lighter on the machine. A smaller copy is made once and cached.');
  }
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
  if (!viewMayEdit()) return; // (removeTile refuses in a view: the loop below would never end)
  while (tiles.length) removeTile(tiles[tiles.length - 1], { record: false });
  zTop = 1; zBottom = 0; // a new scene starts a new stack
  favFolders = []; scheduleFavorites(); // a new scene has no favorite folders
  undoStack.clear();
  clearTimeout(rowTimer); rowEntry = null;
  layout.quality = 'full'; syncQualityRadios(); // a new scene starts at full resolution
  setBoardBackground('dark'); // and dark
}

function addVideos(paths, at = null) {
  if (!viewMayEdit()) return;
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
  if (!viewMayEdit()) return;
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
/* DISABLED (2026-10-07): progress now carries the tier, and copies of one file all follow it
window.api.onProxyProgress((p, frac) => { const t = tiles.find((x) => x.path === p); if (t && t.onProxyProgress) t.onProxyProgress(frac); });
*/
window.api.onProxyProgress((p, frac, tier) => {
  for (const t of tiles) {
    if (t.path !== p) continue;
    if (tier === 'full') { if (t.onProxyProgress) t.onProxyProgress(frac); }
    else if (t.onTierProgress) t.onTierProgress(frac, tier);
  }
});
// yt-dlp download progress for web tiles in Local mode
// main tells us when a drive or share that answered too slowly has answered after all (see
// guardedFs in main.js): every video that failed to load meanwhile gets another go
if (window.api.onPathsRecovered) window.api.onPathsRecovered(() => {
  const failed = tiles.filter((t) => t.retryAfterRecovery && t.video && t.video.error);
  for (const t of failed) t.retryAfterRecovery();
  if (failed.length) setStatus(`Reloading ${failed.length} video${failed.length === 1 ? '' : 's'} that could not be read while the PC was busy`, 6000);
});
window.api.onDownloadProgress((pageUrl, frac) => { for (const t of tiles) if (t.url === pageUrl && t.onDownloadProgress) t.onDownloadProgress(frac); });

// smooth seek-bar updates for every tile (timeupdate alone is too coarse)
(function loop() {
  for (const t of tiles) t.tick && t.tick();
  tickTimeline();
  if (cmp.tick) cmp.tick();
  requestAnimationFrame(loop);
})();

// ---------- Import from Miro (Mark, 2026-11-06) ----------
// App ▾ → Import from Miro…: a board link, the user's own Miro access token and a folder. The main
// process reads the board, downloads its pictures into that folder and writes an Ozy board there
// (lib/miroimport.js); this window only asks, shows the progress and opens the result.
const miroDlg = document.getElementById('miro-dialog');
const miroQ = (sel) => miroDlg.querySelector(sel);
let miroRunning = false;
let miroHasToken = false;
async function openMiroDialog() {
  if (IS_VIEW) return;
  document.querySelectorAll('.menu-list').forEach((m) => { if (m.id !== 'recent-list') m.hidden = true; });
  miroDlg.hidden = false;
  if (!miroRunning) {
    miroQ('.miro-result').hidden = true;
    miroQ('.miro-progress').hidden = true;
    miroQ('#miro-go').disabled = false;
    miroQ('#miro-go').textContent = 'Import';
  }
  try {
    const d = await window.api.miroDefaults();
    if (!miroQ('#miro-root').value) miroQ('#miro-root').value = d.root || '';
    miroHasToken = !!d.hasToken;
  } catch {}
  miroQ('.miro-saved').hidden = !miroHasToken;
  miroQ('#miro-token').placeholder = miroHasToken ? 'Saved on this PC (paste a new one to replace it)' : 'Paste your Miro access token';
  (miroQ('#miro-url').value ? miroQ('#miro-token') : miroQ('#miro-url')).focus();
}
function closeMiroDialog() { if (!miroRunning) miroDlg.hidden = true; }
function miroShowResult(text, kind) {
  const r = miroQ('.miro-result');
  r.hidden = false; r.textContent = text; r.className = 'miro-result ' + (kind || '');
}
async function runMiroImport() {
  if (miroRunning) { window.api.miroCancel(); miroQ('#miro-go').textContent = 'Stopping…'; return; }
  const boardUrl = miroQ('#miro-url').value.trim();
  const token = miroQ('#miro-token').value.trim();
  const root = miroQ('#miro-root').value.trim();
  if (!boardUrl) { miroShowResult('Paste the board link first (open the board in Miro and copy the address).', 'bad'); miroQ('#miro-url').focus(); return; }
  if (!token && !miroHasToken) { miroShowResult('Paste your Miro access token first.', 'bad'); miroQ('#miro-token').focus(); return; }
  miroRunning = true;
  miroQ('.miro-result').hidden = true;
  miroQ('.miro-progress').hidden = false;
  miroQ('.miro-note').textContent = 'Starting…';
  miroQ('.miro-progress .fill').style.width = '0%';
  miroQ('#miro-go').textContent = 'Stop';
  miroQ('#miro-close').disabled = true;
  logUi('info', 'miro import requested', { root });
  let r;
  try { r = await window.api.miroImport({ boardUrl, token, root, remember: miroQ('#miro-remember').checked }); }
  catch (e) { r = { error: String(e && e.message || e) }; }
  miroRunning = false;
  miroQ('#miro-go').textContent = 'Import';
  miroQ('#miro-close').disabled = false;
  miroQ('#miro-token').value = ''; // not left sitting in the window
  if (r.error) { miroShowResult(r.error, 'bad'); return; }
  if (miroQ('#miro-remember').checked) miroHasToken = true;
  miroQ('.miro-progress .fill').style.width = '100%';
  miroQ('.miro-note').textContent = `Done: ${r.items} item${r.items === 1 ? '' : 's'} read. Saved in ${r.dir}`;
  miroShowResult(r.summary || 'Imported.', r.failed ? 'warn' : 'good');
  setStatus('Miro board imported: ' + r.sessionPath, 6000);
  if (tiles.length && !confirm('Open the imported board now? The board that is open here will be closed (save it first if you want to keep changes).')) return;
  await openSession(r.sessionPath);
}
if (!IS_VIEW) {
  document.getElementById('btn-miro').addEventListener('click', (e) => { e.stopPropagation(); openMiroDialog(); });
  miroQ('#miro-go').addEventListener('click', runMiroImport);
  miroQ('#miro-close').addEventListener('click', closeMiroDialog);
  miroQ('#miro-browse').addEventListener('click', async () => { const p = await window.api.miroPickRoot(miroQ('#miro-root').value); if (p) miroQ('#miro-root').value = p; });
  miroQ('#miro-forget').addEventListener('click', async () => { await window.api.miroForgetToken(); miroHasToken = false; miroQ('.miro-saved').hidden = true; miroQ('#miro-token').placeholder = 'Paste your Miro access token'; setStatus('Miro token forgotten on this PC'); });
  miroQ('#miro-help').addEventListener('click', () => { const h = miroQ('.miro-howto'); h.hidden = !h.hidden; });
  // typing in the dialog is not a shortcut; Enter imports, Escape closes
  miroDlg.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closeMiroDialog(); if (e.key === 'Enter' && e.target.tagName === 'INPUT') runMiroImport(); });
  miroDlg.addEventListener('pointerdown', (e) => { if (e.target === miroDlg) closeMiroDialog(); });
  window.api.onMiroProgress((p) => {
    if (!miroRunning || !p) return;
    miroQ('.miro-note').textContent = p.note || '';
    const share = p.phase === 'board' ? 0.02 : p.phase === 'items' ? 0.02 + 0.08 * (p.total ? Math.min(1, p.done / p.total) : 0.5) : p.phase === 'images' ? 0.1 + 0.88 * (p.total ? p.done / p.total : 1) : 0.99;
    miroQ('.miro-progress .fill').style.width = (share * 100).toFixed(1) + '%';
  });
}

// ---------- light or dark board ----------
// A board is dark unless it is set light (right-click on empty board space). A Miro import starts
// light, since everything on a Miro board was made to be read on white. Saved with the session.
function setBoardBackground(bg) {
  layout.background = bg === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('board-light', layout.background === 'light');
}

// ---------- pictures: a small copy while small on screen ----------
// A picture that has a smaller copy (a Miro import keeps Miro's own preview beside each picture)
// shows that copy until it is big enough on screen to need the full one, and goes back to it once
// it is small or off screen again. A board of a thousand photos then never decodes them all at
// full size. The full one is decoded off to the side first, so the swap never flashes.
function applyImageLod() {
  if (!isBoard()) return;
  const r = gridRect();
  const view = { x: r.left, y: r.top, w: r.width, h: r.height };
  const dpr = window.devicePixelRatio || 1;
  const fsEl = document.fullscreenElement;
  for (const t of tiles) {
    if (t.type !== 'image' || !t.thumb || !t.img || !t.board) continue;
    // where it is on screen, worked out from the board (measuring a thousand elements would make the page lay itself out)
    const b = t.culled ? { left: -1e6, top: -1e6, width: 0, height: 0 } : { left: r.left + board.panX + t.board.x * board.zoom, top: r.top + board.panY + t.board.y * board.zoom, width: t.board.w * board.zoom, height: t.board.h * board.zoom };
    const onScreen = Lod.seen({ x: b.left, y: b.top, w: b.width, h: b.height }, view, 0);
    const thumbH = t.thumbH || 600;
    // up when it is drawn taller than the small copy has pixels; down again a little below that
    const want = (fsEl && fsEl === t.el) || (onScreen && b.height * dpr > thumbH * (t.showingFull ? 0.8 : 1.05));
    if (want === !!t.showingFull || t.lodBusy) continue;
    const url = window.api.videoUrl(want ? t.path : t.thumb);
    t.lodBusy = true;
    const pre = new Image();
    pre.src = url;
    pre.decode().catch(() => {}).then(() => {
      t.lodBusy = false;
      if (!tiles.includes(t)) return;
      t.showingFull = want;
      t.img.src = url;
    });
  }
}

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
      views: viewsForSession(), // the extra view windows open now, where they are and their camera
      quality: layout.quality, // v6: the scene's playback resolution
      background: layout.background, // 2026-11-06: 'dark' or 'light'
    },
    masterVolume,
    // every record leads with the tile's stable id (v6, additive: older builds ignore it)
    favFolders: favFolders.map((f) => ({ id: f.id, name: f.name, color: f.color, open: f.open !== false })), // the Favorites tab's folders
    videos: tiles.map((t) => ({ id: t.id, ...(t.rotation ? { rotation: t.rotation } : {}), ...(t.z != null ? { z: t.z } : {}), ...(t.locked ? { locked: true } : {}), ...(t.favorite ? { favorite: true, ...(t.favFolder ? { favFolder: t.favFolder } : {}) } : {}), ...(t.type === 'line' ? {
      // a line: its points (fractions of its box) and look; older builds skip it (no path)
      type: 'line', points: t.points.map((p) => p.slice()), style: { ...t.style },
      ...(t.ends ? { ends: t.ends.map((e) => (e ? { ...e } : null)) } : {}), ...(t.freehand ? { freehand: true } : {}),
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
    } : t.type === 'text' ? {
      // a text tile is only its words, its look and its box; older builds skip it (no path)
      type: 'text', text: t.text, style: { ...t.style }, ...(t.frame ? { frame: { ...t.frame } } : {}), ...(t.links ? { links: LinkTable.clone(t.links) } : {}), ...(t.todo ? { todo: TodoList.clone(t.todo) } : {}),
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
    } : t.type === 'sequence' ? {
      // image sequence: folder + run description + its look; the decoded-frame cache is found again by key
      type: 'sequence', dir: t.dir, path: t.path, galleryH: Math.round(galleryHOf(t)),
      seq: { name: t.seq.name, sep: t.seq.sep, pad: t.seq.pad, ext: t.seq.ext, start: t.seq.start, end: t.seq.end, count: t.seq.count, missing: t.seq.missing, single: !!t.seq.single, fps: t.fps, exposure: t.exposure, colour: t.colour, layer: t.seq.layer || '', part: t.seq.part || 0 },
      color: t.hue, loop: !!t.loop, currentTime: t.pb.time, volume: 0, muted: false, playbackRate: t.pb.rate, paused: Session.savedPaused(t.pb.paused, t.autoPaused), aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: t.bookmarks.map((b) => ({ t: b.t, label: b.label, color: b.color })),
      sync: syncRecord(t),
    } : t.type === 'image' ? {
      type: 'image', path: t.path, ...(t.thumb ? { thumb: t.thumb } : {}), ...(t.crop ? { crop: { ...t.crop } } : {}), aspect: t.aspect, galleryH: Math.round(galleryHOf(t)),
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: [], sync: null, volume: 0, muted: false, playbackRate: 1, paused: true, currentTime: 0,
    } : (t.type === 'youtube' || t.type === 'twitch') ? {
      // web tile (YouTube / Twitch). Not "!t.video": in Stream / Local mode a web tile has a <video>.
      type: t.type, kind: t.kind, url: t.url, title: t.title, galleryH: Math.round(galleryHOf(t)),
      currentTime: t.pb ? t.pb.time : 0, volume: t.volume, muted: !!t.ownMuted, playbackRate: 1,
      paused: t.yt ? Session.savedPaused(t.yt.paused, t.autoPaused) : true, aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      color: t.hue, loop: !!t.loop, // YouTube only
      webMode: t.webMode || 'stream', webQuality: t.webQuality || 0,
      bookmarks: t.bookmarks.map((b) => ({ t: b.t, label: b.label, color: b.color })),
      sync: t.pb ? syncRecord(t) : null,
    } : {
      type: 'file',
      path: t.path,
      galleryH: Math.round(galleryHOf(t)),
      color: t.hue,
      loop: !!t.loop,
      fpsOverride: t.fpsOverride || null,
      quality: t.quality || 'scene', // v6: its own playback resolution, or follow the scene
      // through tile.pb: a still's time and play state are its shadow clock, not the empty <video>
      currentTime: isFinite(t.pb.time) ? t.pb.time : 0,
      volume: t.volume,
      muted: t.group ? !!t.ownMuted : t.video.muted, // own mute, not the group's
      playbackRate: t.pb.rate,
      paused: Session.savedPaused(t.pb.paused, t.autoPaused), // off screen and auto-paused still counts as playing
      aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: t.bookmarks.map((b) => ({ t: b.t, label: b.label, color: b.color })),
      sync: syncRecord(t),
    }) })),
    groups: groups.map((g) => ({
      id: g.id, name: g.name, color: g.color,
      members: [...g.members].map((t) => tiles.indexOf(t)).filter((i) => i >= 0),
      sync: g.sync, sticky: g.sticky, loop: g.loop, range: g.range, volume: g.volume, muted: g.muted, rate: g.rate,
      ...(g.main && g.members.has(g.main) ? { main: tiles.indexOf(g.main) } : {}), ...(g.ctrl ? { ctrl: { ...g.ctrl } } : {}),
    })),
  };
}

// One session record -> one tile. The single place that knows which record shape builds which
// kind of tile, shared by opening a session, undoing a remove, and pasting. Returns the tile (null
// when the record can't build one) and whether its file is currently unreachable.
function buildFromRecord(v) {
  const t = buildTileFromRecord(v);
  if (t && Favorites.fromRecord(v)) { t.favFolder = Favorites.folderOf(v, favFolders); setFavorite(t, true, { quiet: true }); } // starred (and filed) when saved / removed / copied
  // turned on the board (degrees clockwise; 2026-11-06, for Miro imports): drawn turned, about its middle
  if (t) applySavedZ(t, v); // its place in the stack
  if (t && v && v.locked === true) setLocked(t, true, { quiet: true });
  if (t) { const deg = Number(v && v.rotation); t.rotation = Number.isFinite(deg) && Math.abs(deg % 360) > 0.05 ? ((deg % 360) + 360) % 360 : 0; if (t.rotation) layoutTile(t); }
  return t;
}
function buildTileFromRecord(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.type === 'youtube' || v.type === 'twitch') {
    const parsed = typeof v.url === 'string' ? WebUrl.parse(v.url) : null;
    return parsed && parsed.kind !== 'playlist' ? addWebTile(v.url, parsed, v) : null;
  }
  // text: null when the record has no usable board, since text has no gallery form
  if (v.type === 'text') return addTextTile(v);
  if (v.type === 'line') return addLineTile(v); // (null without a usable board: lines are board-only too)
  if (v.type === 'sequence') {
    const seq = v.seq;
    if (typeof v.dir !== 'string' || !seq || typeof seq.name !== 'string') return null;
    return addSequenceTile(v.dir, seq, v); // its disk cache is reused (same key)
  }
  if (typeof v.path !== 'string') return null;
  return v.type === 'image' ? addImageTile(v.path, v) : addVideo(v.path, v);
}
// the same, plus the "is the file still there?" check the file-backed kinds need
async function addFromRecord(v) {
  const missing = await recordFileMissing(v);
  return { tile: buildFromRecord(v), missing };
}
async function recordFileMissing(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.type === 'sequence') {
    const seq = v.seq;
    if (typeof v.dir !== 'string' || !seq || typeof seq.name !== 'string') return false;
    return !(await window.api.fileExists(joinPath(v.dir, Sequence.framePath(seq, seq.start))));
  }
  if (v.type === 'youtube' || v.type === 'twitch' || v.type === 'text' || v.type === 'line') return false;
  if (typeof v.path !== 'string') return false;
  return !(await window.api.fileExists(v.path));
}

async function applySession(data, veil) {
  if (!data || !Array.isArray(data.videos)) throw new Error('Not a Multi Video Player session file.');
  const startedAt = Date.now();
  clearAll();
  favFolders = Favorites.folders(data.favFolders); // before the tiles: each finds its folder as it is built
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
  layout.quality = L.quality; syncQualityRadios(); // before the tiles are built: each goes to its tier once probed
  setBoardBackground(L.background);
  if (L.board) {
    board.panX = L.board.panX; board.panY = L.board.panY; board.zoom = L.board.zoom;
    board.initialized = true;
  } else {
    board.initialized = false;
  }
  // setLinked(L.linked); // (before 2026-11-19: each session carried it, on in most; Push neighbours is a setting now)
  setMode(L.mode);
  setMasterVolume(Session.masterVolume(data.masterVolume, DEFAULT_MASTER_VOLUME));

  let missing = 0;
  const byIndex = new Map(); // index in data.videos -> tile (v3 files and bad entries leave gaps)
  for (const [i, v] of data.videos.entries()) {
    const r = await addFromRecord(Session.openRecord(v));
    if (veil) loadVeil.building(veil, i + 1, data.videos.length);
    if (r.missing) missing++;
    if (r.tile) byIndex.set(i, r.tile);
  }
  // groups (session v4); v3 files have none
  nextGroupId = 1;
  for (const sg of Session.groups(data.groups, (i) => byIndex.has(i))) {
    const g = createGroup(sg.members.map((i) => byIndex.get(i)), { ...sg, sync: false });
    if (sg.id !== null) g.id = sg.id;
    if (sg.main !== null) g.main = byIndex.get(sg.main) || null;
    if (sg.ctrl) g.ctrl = sg.ctrl;
    const saved = (i) => ({ start: Session.syncStart(data.videos[i]), points: Groups.cleanPoints(Session.syncPoints(data.videos[i])) });
    if (sg.sync) {
      // restore saved starts rather than recapturing them from not-yet-loaded videos
      g.sync = true;
      for (const i of sg.members) byIndex.get(i).sync = saved(i);
    } else if (sg.members.some((i) => Session.syncPoints(data.videos[i]))) {
      // Sync was off, but its sync points are kept for when it is turned on again
      g.stash = new Map(sg.members.map((i) => [byIndex.get(i), saved(i)]));
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
  reopenViews(data.layout && data.layout.views); // the views that were open when it was saved
  return { loaded: data.videos.length, missing };
}

async function saveSessionAs() {
  if (!tiles.length) { setStatus('Nothing to save – add some videos first.'); return; }
  const p = await window.api.saveSessionAs(collectSession());
  if (p) { sessionPath = p; rememberSession(p); updateChrome(); logUi('info', 'session saved as', { path: p, tiles: tiles.length }); setStatus(`Saved ${p}`); }
}

async function saveSession() {
  if (!sessionPath) return saveSessionAs();
  await window.api.saveSessionTo(sessionPath, collectSession());
  rememberSession(sessionPath);
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
  const veil = loadVeil.begin(basename(r.filePath || 'session').replace(/\.mvp$/i, ''));
  try {
    // const { loaded, missing } = await applySession(r.data); // (before 2026-11-19)
    const { loaded, missing } = await applySession(r.data, veil);
    loadVeil.watch(veil); // stays up until what is on screen has loaded
    sessionPath = r.filePath;
    rememberSession(r.filePath);
    updateChrome();
    setStatus(missing ? `Opened ${loaded} videos – ${missing} file(s) missing` : `Opened ${loaded} videos`, missing ? 10000 : 4000);
  } catch (e) {
    loadVeil.end(veil);
    setStatus(`Could not open session: ${e.message}`, 8000);
  }
}

// ---------- opening a session: the board dims until what is on screen has loaded (2026-11-19) ----------
// Shown after a quarter of a second (a small session never flashes it): first while the tiles are
// set up, then until every picture and local video in view shows something (or a minute passes,
// or "Show the board now"). YouTube / Twitch, text and lines are not waited on.
const loadVeil = (() => {
  const el = document.getElementById('load-veil');
  const fill = el.querySelector('.lv-fill'), title = el.querySelector('.lv-title'), note = el.querySelector('.lv-note');
  let run = 0, showTimer = null, poll = null;
  const bar = (frac) => { fill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; };
  const hide = () => {
    clearTimeout(showTimer); clearInterval(poll); poll = null;
    el.classList.remove('on');
    setTimeout(() => { if (!el.classList.contains('on')) el.hidden = true; }, 250);
  };
  el.querySelector('.lv-skip').addEventListener('click', () => { run++; hide(); });
  const onScreen = (t) => {
    if (!t.el || !t.el.isConnected) return false;
    const r = t.el.getBoundingClientRect(), g = grid.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > g.left && r.left < g.right && r.bottom > g.top && r.top < g.bottom;
  };
  const shows = (t) => {
    if (t.type === 'image') return !!t.img && t.img.complete;
    if (!t.type && t.video && t.path && !t.url) { // a local video
      if (t.live === false || t.video.error || t.video.readyState >= 2) return true;
      const err = t.el.querySelector('.error');
      return !!err && !err.classList.contains('hidden'); // (an error panel is something to see too)
    }
    return true;
  };
  return {
    begin(name) {
      const my = ++run;
      clearTimeout(showTimer); clearInterval(poll); poll = null;
      title.textContent = `Opening ${name}…`; note.textContent = 'Reading the session'; bar(0.02);
      showTimer = setTimeout(() => { if (run !== my) return; el.hidden = false; requestAnimationFrame(() => { if (run === my) el.classList.add('on'); }); }, 250);
      return my;
    },
    building(my, i, n) { if (run !== my) return; note.textContent = `Setting up ${i} of ${n}`; bar(0.25 * i / Math.max(1, n)); },
    watch(my) {
      if (run !== my) return;
      const t0 = performance.now();
      const tick = () => {
        if (run !== my) return;
        const want = tiles.filter((t) => (t.type === 'image' || (!t.type && t.video)) && onScreen(t));
        const ready = want.filter(shows).length;
        note.textContent = want.length ? `Loading media: ${ready} of ${want.length} on screen` : 'Nearly there';
        bar(0.25 + 0.75 * (want.length ? ready / want.length : 1));
        if (ready >= want.length || performance.now() - t0 > 60000) { run++; setTimeout(hide, want.length ? 150 : 0); }
      };
      tick();
      if (run === my) poll = setInterval(tick, 150);
    },
    end(my) { if (run === my) { run++; hide(); } },
  };
})();

// ---------- recent sessions ----------
// settings.recentSessions, newest first (rules in lib/recent.js): updated on open, save and save
// as; listed under Open session ▾ and, three of them, on the empty board. A view window
// (window.OZY_VIEW set) can't open sessions, so it shows neither.
const RECENT_CI = navigator.platform.startsWith('Win'); // Windows paths are case-insensitive
function rememberSession(p) {
  if (!p || !settings) return;
  settings.recentSessions = Recent.push(settings.recentSessions, p, Date.now(), { max: 10, caseInsensitive: RECENT_CI });
  saveSettings();
  renderEmptyRecent();
}
function forgetRecent(p) {
  settings.recentSessions = Recent.remove(settings.recentSessions, p);
  saveSettings();
  renderEmptyRecent();
}
const recentMenu = document.getElementById('open-menu');
const recentList = document.getElementById('recent-list');
async function renderRecentMenu() {
  const items = (settings && settings.recentSessions) || [];
  // missing files are checked each time the menu opens (a share may have come back)
  const exists = await Promise.all(items.map((e) => window.api.fileExists(e.path).catch(() => false)));
  recentList.textContent = '';
  if (!items.length) { const d = document.createElement('div'); d.className = 'menu-note'; d.textContent = 'No recent sessions'; recentList.appendChild(d); return; }
  items.forEach((e, i) => {
    const row = document.createElement('div'); row.className = 'recent-row' + (exists[i] ? '' : ' missing');
    const b = document.createElement('button'); b.className = 'recent-name'; b.textContent = basename(e.path); b.title = e.path + (exists[i] ? '' : '\n(not found)');
    b.addEventListener('click', () => { recentList.hidden = true; openRecent(e.path); });
    const x = document.createElement('button'); x.className = 'recent-forget'; x.textContent = '✕'; x.title = 'Forget this one';
    x.addEventListener('click', (ev) => { ev.stopPropagation(); forgetRecent(e.path); renderRecentMenu(); });
    row.append(b, x); recentList.appendChild(row);
  });
  const clear = document.createElement('button'); clear.textContent = 'Clear list';
  clear.addEventListener('click', () => { settings.recentSessions = []; saveSettings(); recentList.hidden = true; renderEmptyRecent(); });
  recentList.appendChild(clear);
}
async function openRecent(p) {
  if (!(await window.api.fileExists(p).catch(() => false))) { setStatus(`Not found: ${p} (✕ in Open session ▾ forgets it)`, 8000); return; }
  await openSession(p);
}
function renderEmptyRecent() {
  const el = document.getElementById('empty-recent');
  if (!el) return;
  let items = [];
  // updateChrome can run before the settings binding further down exists (temporal dead zone)
  try { items = !window.OZY_VIEW && settings && Array.isArray(settings.recentSessions) ? settings.recentSessions.slice(0, 3) : []; } catch { return; }
  el.hidden = !items.length; el.textContent = '';
  if (!items.length) return;
  el.append('Recent: ');
  items.forEach((e, i) => {
    const a = document.createElement('a'); a.href = '#'; a.textContent = basename(e.path); a.title = e.path;
    a.addEventListener('click', (ev) => { ev.preventDefault(); openRecent(e.path); });
    el.appendChild(a);
    if (i < items.length - 1) el.append(' · ');
  });
}
if (!window.OZY_VIEW) {
  document.getElementById('btn-open-recent').addEventListener('click', (e) => { e.stopPropagation(); recentList.hidden = !recentList.hidden; if (!recentList.hidden) renderRecentMenu(); });
  window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !recentMenu.contains(e.target)) recentList.hidden = true; });
} else document.getElementById('btn-open-recent').hidden = true;

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
  if (!viewMayEdit()) return;
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
// re-enabled as a visible button 2026-10-07 (Mark); the right-click on Save still works too
document.getElementById('btn-save-as').addEventListener('click', saveSessionAs);
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
document.getElementById('btn-play-all').addEventListener('click', () => {
  if (hoverPlayOn()) { setStatus('Hover play is on'); return; }
  tiles.forEach(playTile);
});
document.getElementById('btn-pause-all').addEventListener('click', () => {
  if (hoverPlayOn()) { setStatus('Hover play is on'); return; }
  tiles.forEach(pauseTile);
});
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
// the tiles a Tidy entry works on: the selection when there is one, else the whole board
function tidyTargets() {
  const all = boardTilesInOrder().filter((t) => !t.locked); // (locked tiles stay where they are)
  const sel = all.filter((t) => selection.has(t));
  return sel.length ? { list: sel, scoped: true } : { list: all, scoped: false };
}
// Fit: every tile the same height. Whole board: the largest that flow-wraps inside the view.
// Selection: the mean of their current heights, wrapped at the selection's own width, so the
// rest of the board is untouched (undo = resize).
function tidyFitToView() {
  // text tiles size themselves from their text, so they sit this one out and keep their own box
  const { list: targets, scoped } = tidyTargets();
  const list = targets.filter((t) => !t.freeAspect); if (!list.length) return;
  const entry = recordResize(list);
  if (scoped) {
    const bb = boardBounds(list);
    const height = list.reduce((s, t) => s + t.board.h, 0) / list.length;
    const rects = Arrange.flowAtHeight(list.map((t) => ({ aspect: t.aspect })), height, bb.w, GAP);
    list.forEach((t, i) => { t.board = { x: bb.minX + rects[i].x, y: bb.minY + rects[i].y, w: rects[i].w, h: rects[i].h }; layoutTile(t); });
    finishRects(entry); setStatus(`Tidied ${list.length} selected videos`);
    return;
  }
  const r = gridRect(); const W = (r.width - 2 * GAP) / board.zoom, H = (r.height - 2 * GAP) / board.zoom;
  const origin = toCanvas(r.left + GAP, r.top + GAP);
  const { rects } = Arrange.fitToView(list.map((t) => ({ aspect: t.aspect })), W, H, GAP);
  list.forEach((t, i) => { t.board = { x: origin.x + rects[i].x, y: origin.y + rects[i].y, w: rects[i].w, h: rects[i].h }; layoutTile(t); });
  finishRects(entry); setStatus('Arranged to fit the view');
}
// Grid: sizes kept, ceil(sqrt(n)) columns edge to edge from the block's top-left. Whole board:
// then frame it. Selection: leave the view alone (undo = move).
function tidyGrid() {
  const { list, scoped } = tidyTargets(); if (!list.length) return;
  const entry = recordMove(list);
  const bb = boardBounds(list);
  const rects = Arrange.grid(list.map((t) => ({ w: t.board.w, h: t.board.h })), 0);
  list.forEach((t, i) => { t.board.x = bb.minX + rects[i].x; t.board.y = bb.minY + rects[i].y; layoutTile(t); });
  finishRects(entry);
  if (scoped) setStatus(`Packed ${list.length} selected videos into a grid`);
  else { fitBoard(); setStatus('Packed into a grid'); }
}
// Align: edges that are nearly lined up get lined up, gaps that are nearly a gap become one.
// Sizes and the arrangement are kept; a tile with nothing within reach stays put (undo = move).
const ALIGN_PX = 24; // screen px: generous, since a hand-made layout is "nearly" right
function tidyAlign() {
  const { list, scoped } = tidyTargets(); if (list.length < 2) { setStatus('Nothing to line up'); return; }
  const entry = recordMove(list);
  const rects = Arrange.align(list.map((t) => ({ ...t.board })), ALIGN_PX / board.zoom, LINK_GAP);
  list.forEach((t, i) => { t.board.x = rects[i].x; t.board.y = rects[i].y; layoutTile(t); });
  finishRects(entry);
  setStatus(scoped ? `Lined up ${list.length} selected videos` : 'Lined up the board');
}
// Compact: sizes and arrangement kept; tiles settle up and left until one gap apart (undo = move).
// Pack: close the gaps the way Scott does by hand. Every tile stays about where it is and may grow
// or shrink by at most settings.tidySlack so neighbours meet edge to edge (Arrange.packBoard has
// the rules). The block keeps its top-left corner; text tiles sit it out (undo = resize).
function tidyPack() {
  const { list: targets, scoped } = tidyTargets();
  const list = targets.filter((t) => !t.freeAspect); if (!list.length) return;
  const entry = recordResize(list);
  const bb = boardBounds(list);
  const packed = Arrange.packBoard(list.map((t) => ({ ...t.board })), LINK_GAP, settings.tidySlack);
  list.forEach((t, i) => { const q = packed.rects[i]; t.board = { x: bb.minX + q.x, y: bb.minY + q.y, w: q.w, h: q.h }; layoutTile(t); });
  finishRects(entry);
  const pct = Math.round(packed.coverage * 100);
  if (scoped) setStatus(`Packed ${list.length} selected videos (${pct}% filled)`); else { fitBoard(); setStatus(`Packed the board (${pct}% filled)`); }
}
// Justify: the rows stay the rows they are; each is scaled as one piece, within the resize limit,
// until it is as wide as the widest row, so both edges come out straight. The block keeps its
// top-left corner; text tiles sit it out (undo = resize).
function tidyJustify() {
  const { list: targets, scoped } = tidyTargets();
  const list = targets.filter((t) => !t.freeAspect); if (!list.length) return;
  const entry = recordResize(list);
  const bb = boardBounds(list);
  const before = list.map((t) => ({ ...t.board }));
  const rects = Arrange.justify(before, Arrange.packWidth(before, LINK_GAP), LINK_GAP, settings.tidySlack);
  list.forEach((t, i) => { const q = rects[i]; t.board = { x: bb.minX + q.x, y: bb.minY + q.y, w: q.w, h: q.h }; layoutTile(t); });
  finishRects(entry);
  const n = Arrange.rowsOf(before).length;
  if (!scoped) fitBoard();
  setStatus(`Justified ${n} row${n === 1 ? '' : 's'}${scoped ? ' of the selection' : ''}`);
}
function tidyCompact() {
  const { list, scoped } = tidyTargets(); if (!list.length) return;
  const entry = recordMove(list);
  const rects = Arrange.compact(list.map((t) => ({ ...t.board })), LINK_GAP);
  list.forEach((t, i) => { t.board.x = rects[i].x; t.board.y = rects[i].y; layoutTile(t); });
  finishRects(entry);
  if (scoped) setStatus(`Compacted ${list.length} selected videos`); else { fitBoard(); setStatus('Compacted the board'); }
}
// Rows: sizes kept, flowed into rows at the view's width; text tiles sit it out (undo = move).
function tidyRows() {
  const { list: targets, scoped } = tidyTargets();
  const list = targets.filter((t) => !t.freeAspect); if (!list.length) return;
  const entry = recordMove(list);
  const r = gridRect(); const W = (r.width - 2 * GAP) / board.zoom;
  const bb = boardBounds(list);
  const origin = scoped ? { x: bb.minX, y: bb.minY } : toCanvas(r.left + GAP, r.top + GAP);
  const rects = Arrange.rows(list.map((t) => ({ w: t.board.w, h: t.board.h })), W, LINK_GAP);
  list.forEach((t, i) => { t.board.x = origin.x + rects[i].x; t.board.y = origin.y + rects[i].y; layoutTile(t); });
  finishRects(entry);
  if (scoped) setStatus(`Sorted ${list.length} selected videos into rows`); else { fitBoard(); setStatus('Sorted into rows'); }
}
// Group bar: Tidy = select the group and Fit it
function tidyGroup(g) {
  if (!g) return;
  selectGroupOf([...g.members][0]);
  tidyFitToView();
}
// Shift+F: the selected tiles fill the current view (one tile at its aspect, several share it),
// centred in the viewport; undo = resize.
function maximizeSelectionInView() {
  if (!isBoard()) { setStatus('Board only'); return; }
  const list = boardTilesInOrder().filter((t) => selection.has(t) && !t.freeAspect && !t.locked);
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
document.getElementById('btn-tidy-menu').addEventListener('click', (e) => {
  e.stopPropagation(); tidyList.hidden = !tidyList.hidden;
  // the entries act on the selection when there is one; say so
  const scoped = selection.size > 0;
  document.querySelector('#tidy-align small').textContent = scoped ? '(selection) keep sizes, straighten edges' : 'keep sizes, straighten edges';
  document.querySelector('#tidy-pack small').textContent = scoped ? '(selection) close gaps, sizes within the limit below' : 'close gaps, sizes within the limit below';
  document.querySelector('#tidy-justify small').textContent = scoped ? '(selection) rows filled edge to edge' : 'rows filled edge to edge';
  document.querySelector('#tidy-compact small').textContent = scoped ? '(selection) keep sizes, close the gaps' : 'keep sizes, close the gaps';
  document.querySelector('#tidy-rows small').textContent = scoped ? '(selection) keep sizes, sort into rows' : 'keep sizes, sort into rows';
  document.querySelector('#tidy-fit small').textContent = scoped ? '(selection) same height, wrapped in place' : 'same size, fills the view';
  document.querySelector('#tidy-grid small').textContent = scoped ? '(selection) keep sizes, no gaps' : 'keep sizes, no gaps';
});
window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !tidyMenu.contains(e.target)) tidyList.hidden = true; });
document.getElementById('tidy-align').addEventListener('click', () => { tidyList.hidden = true; tidyAlign(); });
document.getElementById('tidy-pack').addEventListener('click', () => { tidyList.hidden = true; tidyPack(); });
// how much Pack (and Justify) may resize a video; remembered
const tidySlackEl = document.getElementById('tidy-slack');
tidySlackEl.addEventListener('change', () => { settings.tidySlack = Number(tidySlackEl.value); saveSettings(); });
document.getElementById('tidy-justify').addEventListener('click', () => { tidyList.hidden = true; tidyJustify(); });
document.getElementById('tidy-compact').addEventListener('click', () => { tidyList.hidden = true; tidyCompact(); });
document.getElementById('tidy-rows').addEventListener('click', () => { tidyList.hidden = true; tidyRows(); });
document.getElementById('tidy-fit').addEventListener('click', () => { tidyList.hidden = true; tidyFitToView(); });
document.getElementById('tidy-grid').addEventListener('click', () => { tidyList.hidden = true; tidyGrid(); });
// document.getElementById('btn-link').addEventListener('click', () => setLinked(!board.linked)); // (before 2026-11-19)
document.getElementById('btn-link').addEventListener('click', () => setPushNeighbours(!board.linked));
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
// Every Ozy window keeps its own copy of the settings; after a save the others re-read the file so
// none of them later writes back a stale copy over what this one changed.
function saveSettings() {
  clearTimeout(sbSaveTimer);
  sbSaveTimer = setTimeout(() => {
    Promise.resolve(window.api.saveSettings(settings)).then(() => { if (window.api.bus) window.api.bus({ type: 'settings-changed' }); }).catch(() => {});
  }, 300);
}

const sidebar = {
  open() { settings.sidebar.open = true; sbEl.hidden = false; sidebar.lit(); saveSettings(); layoutTiles(); },
  close() { settings.sidebar.open = false; sbEl.hidden = true; sidebar.lit(); saveSettings(); layoutTiles(); },
  // the rail's buttons light up while Sources is open: the folder on Local / YouTube, the star on Favorites
  lit() {
    const on = !sbEl.hidden, fav = settings.sidebar.tab === 'fav';
    const f = document.getElementById('btn-sidebar'), s = document.getElementById('btn-favs');
    if (f) f.classList.toggle('toggled', on && !fav);
    if (s) s.classList.toggle('toggled', on && fav);
  },
  toggle() { settings.sidebar.open ? sidebar.close() : sidebar.open(); },
  // three tabs: 'local' (folders), 'web' (YouTube / Twitch playlists) and 'fav' (the starred
  // tiles on this board); remembered in settings
  setTab(tab) {
    settings.sidebar.tab = tab === 'web' || tab === 'fav' ? tab : 'local';
    sbEl.classList.toggle('tab-is-local', settings.sidebar.tab === 'local');
    sbEl.classList.toggle('tab-is-web', settings.sidebar.tab === 'web');
    sbEl.classList.toggle('tab-is-fav', settings.sidebar.tab === 'fav');
    if (settings.sidebar.tab === 'fav') renderFavorites();
    for (const b of sbEl.querySelectorAll('.sb-tabs button')) b.classList.toggle('active', b.dataset.tab === settings.sidebar.tab);
    sidebar.lit();
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

// ---------- favorites ----------
// A star (☆ / ★) on every tile's title bar but text. A favorite wears a gold ring, is saved with the
// session (favorite: true on its record) and is listed on the sidebar's ★ Favorites tab, where a
// click on its name flies the board to it. Pure rules (sorting, the camera) in lib/favorites.js.
const btnFavs = document.getElementById('btn-favs');
function attachFavorite(tile) {
  if (tile.type === 'text' || tile.type === 'line' || tile.favBtn) return;
  const top = tile.el.querySelector('.overlay .top');
  if (!top) return;
  const btn = document.createElement('button');
  btn.className = 'fav';
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (!IS_VIEW) setFavorite(tile, !tile.favorite); });
  btn.addEventListener('dblclick', (e) => e.stopPropagation()); // not a fullscreen
  btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openFavMenu(tile, e.clientX, e.clientY); }); // which folder
  const remove = top.querySelector('.remove');
  if (remove) remove.after(btn); else top.prepend(btn);
  const badge = document.createElement('span');
  badge.className = 'fav-badge'; badge.textContent = '★';
  tile.el.appendChild(badge);
  tile.favBtn = btn;
  tile.favorite = !!tile.favorite;
  paintFavorite(tile);
}
function paintFavorite(tile) {
  tile.el.classList.toggle('favorite', !!tile.favorite);
  // a favorite in a folder wears that folder's colour (ring, badge, star)
  const f = tile.favorite && tile.favFolder ? favFolderById(tile.favFolder) : null;
  if (f) tile.el.style.setProperty('--fav-c', f.color); else tile.el.style.removeProperty('--fav-c');
  if (tile.favBtn) {
    tile.favBtn.textContent = tile.favorite ? '★' : '☆';
    tile.favBtn.classList.toggle('on', !!tile.favorite);
    tile.favBtn.title = tile.favorite ? `Favorite${f ? ' in ' + f.name : ''}: click to unstar, right-click to file it in a folder` : 'Star as a favorite (listed under ★ Favorites). Right-click: star it into a folder';
  }
  scheduleFavorites();
}
function setFavorite(tile, on, { quiet = false } = {}) {
  if (!viewMayEdit() || tile.type === 'text' || tile.type === 'line') return;
  tile.favorite = !!on;
  if (!on) tile.favFolder = null; // starred again later, it starts out of any folder
  paintFavorite(tile);
  if (!on) scheduleOffscreen(); // no longer kept playing out of view
  if (quiet) return;
  logUi('info', on ? 'favorite added' : 'favorite removed', { name: tileName(tile) });
  setStatus(on ? `★ ${tileName(tile)} is a favorite` : `${tileName(tile)} is no longer a favorite`, 3000);
}
// The list is redrawn once per tick at most, whatever changed (a star, a removed tile, a session).
// The timer lives on the function: updateChrome can run before this part of the file has.
function scheduleFavorites() {
  if (IS_VIEW || scheduleFavorites.timer) return;
  scheduleFavorites.timer = setTimeout(() => { scheduleFavorites.timer = null; renderFavorites(); }, 0);
}
const favKind = (t) => (t.type === 'youtube' ? 'YouTube' : t.type === 'twitch' ? 'Twitch' : t.type === 'image' ? 'Image' : t.type === 'sequence' ? 'Seq' : '');

// ---- folders (Mark, 2026-11-05) ----
// The session's favorite folders, in the order they are listed: [{ id, name, color, open }]. A
// favorite's folder is tile.favFolder (an id, or null). Saved as favFolders on the session and
// favFolder on each record; the rules for reading them back are in lib/favorites.js. (A var, not
// a let: paintFavorite can run for a tile built before this part of the file has.)
var favFolders = [];
function favFolderById(id) { return (favFolders || []).find((f) => f.id === id) || null; }
function setTileFolder(tile, folderId, { quiet = false } = {}) {
  if (!viewMayEdit() || tile.type === 'text' || tile.type === 'line') return;
  const f = folderId ? favFolderById(folderId) : null;
  tile.favorite = true; // filing a video stars it
  tile.favFolder = f ? f.id : null;
  paintFavorite(tile);
  if (!quiet) setStatus(f ? `★ ${tileName(tile)} → ${f.name}` : `★ ${tileName(tile)} is in no folder`, 2500);
}
function repaintFavorites() { for (const t of tiles) if (t.favBtn) paintFavorite(t); scheduleFavorites(); }
let favRenameNext = null; // a folder just made: its name opens for typing once the list is drawn
function newFavFolder({ withSelection = true } = {}) {
  if (IS_VIEW) return null;
  const f = Favorites.newFolder(favFolders);
  favFolders.push(f);
  // what is selected on the board goes straight into it (starred if it was not)
  const picked = withSelection ? [...selection].filter((t) => tiles.includes(t) && t.type !== 'text' && t.type !== 'line') : [];
  for (const t of picked) { t.favorite = true; t.favFolder = f.id; }
  logUi('info', 'favorite folder added', { name: f.name, tiles: picked.length });
  // the tab is on show first: a name box in a hidden sidebar cannot take the typing
  if (!settings.sidebar.open || settings.sidebar.tab !== 'fav') { sidebar.setTab('fav'); if (!settings.sidebar.open) sidebar.open(); }
  favRenameNext = f.id;
  repaintFavorites();
  setStatus(picked.length ? `New folder with ${picked.length} favorite${picked.length === 1 ? '' : 's'}: type its name` : 'New folder: type its name, then drag favorites onto it', 4000);
  return f;
}
function deleteFavFolder(f) {
  const members = tiles.filter((t) => t.favFolder === f.id);
  favFolders = favFolders.filter((x) => x !== f);
  for (const t of members) t.favFolder = null; // still favorites, just in no folder
  logUi('info', 'favorite folder removed', { name: f.name, tiles: members.length });
  repaintFavorites();
  setStatus(`Folder ${f.name} removed${members.length ? `; its ${members.length} favorite${members.length === 1 ? ' is' : 's are'} still starred` : ''}`, 4000);
}
// fly to show every tile in a folder at once
function focusFolder(f) {
  const members = tiles.filter((t) => t.favorite && t.favFolder === f.id);
  if (!members.length) { setStatus(`${f.name} is empty: drag favorites onto it`, 2500); return; }
  if (members.length === 1) { focusTile(members[0]); return; }
  if (isBoard()) {
    const box = Favorites.bounds(members.map((t) => t.board));
    if (!box) return;
    const r = gridRect();
    flyTo(Favorites.camera(box, { w: r.width, h: r.height }, { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, fill: 0.9 }));
  } else {
    members[0].el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }
  for (const t of members) pulseTile(t);
  setStatus(`★ ${f.name}: ${members.length} favorites`, 2500);
}
// A small menu (right-click a favorite's name, or a tile's star): which folder it goes in.
let favMenuEl = null;
function closeFavMenu() { if (favMenuEl) { favMenuEl.remove(); favMenuEl = null; } }
function openFavMenu(tile, x, y) {
  if (IS_VIEW || tile.type === 'text' || tile.type === 'line') return;
  closeFavMenu();
  const m = document.createElement('div');
  m.className = 'fav-menu';
  const add = (label, on, fn, cls) => {
    const b = document.createElement('button');
    b.className = 'fav-menu-item' + (cls ? ' ' + cls : '') + (on ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); closeFavMenu(); fn(); });
    m.appendChild(b);
    return b;
  };
  const head = document.createElement('div'); head.className = 'fav-menu-head'; head.textContent = tileName(tile); m.appendChild(head);
  for (const f of favFolders) {
    const b = add(f.name, tile.favorite && tile.favFolder === f.id, () => setTileFolder(tile, f.id));
    const sw = document.createElement('span'); sw.className = 'fav-swatch'; sw.style.background = f.color; b.prepend(sw);
  }
  add(favFolders.length ? 'No folder' : 'Star it (no folder)', tile.favorite && !tile.favFolder, () => setTileFolder(tile, null));
  add('+ New folder with it', false, () => { const f = newFavFolder({ withSelection: false }); if (f) setTileFolder(tile, f.id, { quiet: true }); }, 'fav-menu-new');
  if (tile.favorite) add('Unstar', false, () => setFavorite(tile, false), 'fav-menu-unstar');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  favMenuEl = m;
}
window.addEventListener('pointerdown', (e) => { if (favMenuEl && !(e.target instanceof Node && favMenuEl.contains(e.target))) closeFavMenu(); }, true);
window.addEventListener('keydown', (e) => { if (favMenuEl && e.key === 'Escape') { e.stopPropagation(); closeFavMenu(); } }, true);
window.addEventListener('blur', closeFavMenu);
// a name dragged onto a folder (or onto "No folder") is filed there
const FAV_DRAG = 'application/x-ozy-fav';
const isFavDrag = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes(FAV_DRAG));
function favDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    if (!isFavDrag(e)) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', (e) => { if (!(e.relatedTarget instanceof Node) || !el.contains(e.relatedTarget)) el.classList.remove('drop-hover'); });
  el.addEventListener('drop', (e) => {
    const id = e.dataTransfer && e.dataTransfer.getData(FAV_DRAG);
    if (!id) return;
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop-hover');
    const t = tileById(id);
    if (t) setTileFolder(t, folderId);
  });
}
function renameFolderInline(f, nameEl) {
  if (!nameEl) return;
  const input = document.createElement('input');
  input.className = 'fav-rename'; input.value = f.name; input.maxLength = 80;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (keep && v && v !== f.name) { f.name = v.slice(0, 80); logUi('info', 'favorite folder renamed', { name: f.name }); }
    input.blur();
    repaintFavorites();
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  for (const ev of ['pointerdown', 'click', 'dblclick']) input.addEventListener(ev, (e) => e.stopPropagation());
}
function favRow(f) {
  const row = document.createElement('div');
  row.className = 'fav-row';
  row.title = `${f.name}\nClick: show it on the board. Drag onto a folder, or right-click, to file it.`;
  row.draggable = true;
  const star = document.createElement('span'); star.className = 'fav-star'; star.textContent = '★';
  const name = document.createElement('span'); name.className = 'fav-name'; name.textContent = f.name;
  row.append(star, name);
  if (f.kind) { const k = document.createElement('span'); k.className = 'fav-kind'; k.textContent = f.kind; row.append(k); }
  const unstar = document.createElement('button');
  unstar.className = 'fav-unstar'; unstar.textContent = '✕'; unstar.title = 'Unstar (the video stays on the board)';
  unstar.addEventListener('click', (e) => { e.stopPropagation(); const t = tileById(f.id); if (t) setFavorite(t, false); });
  row.append(unstar);
  row.addEventListener('click', () => { const t = tileById(f.id); if (t) focusTile(t); });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); const t = tileById(f.id); if (t) openFavMenu(t, e.clientX, e.clientY); });
  row.addEventListener('dragstart', (e) => { e.dataTransfer.setData(FAV_DRAG, f.id); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); sbEl.classList.add('fav-dragging'); });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); sbEl.classList.remove('fav-dragging'); for (const x of sbEl.querySelectorAll('.drop-hover')) x.classList.remove('drop-hover'); });
  return row;
}
function renderFavorites() {
  if (IS_VIEW) return;
  const list = sbEl.querySelector('.fav-list');
  const typing = document.activeElement;
  if (typing && typing.classList.contains('fav-rename') && list.contains(typing)) return; // not while a name is being typed (its blur redraws)
  const all = tiles.filter((t) => t.favorite && t.type !== 'text' && t.type !== 'line');
  const items = all.map((t) => ({ id: t.id, name: tileName(t), kind: favKind(t), folder: t.favFolder || null }));
  sbEl.querySelector('.sb-tabs .fav-count').textContent = all.length ? String(all.length) : '';
  // btnFavs.textContent = all.length ? `★ Favorites (${all.length})` : '★ Favorites'; // DISABLED (Mark, 2026-11-15): an icon button now
  btnFavs.dataset.count = all.length ? String(all.length) : ''; // (a small number on the star)
  btnFavs.classList.toggle('has-favs', all.length > 0);
  list.textContent = '';
  list.classList.toggle('has-folders', favFolders.length > 0);
  sbEl.querySelector('.fav-help').hidden = !all.length;
  for (const sec of Favorites.sections(items, favFolders)) {
    const f = sec.folder;
    if (!f && !favFolders.length) { for (const it of sec.items) list.appendChild(favRow(it)); continue; } // no folders: the plain list
    const box = document.createElement('div');
    box.className = 'fav-folder' + (f ? '' : ' fav-loose') + (f && !f.open ? ' closed' : '');
    if (f) box.style.setProperty('--fav-c', f.color);
    const head = document.createElement('div'); head.className = 'fav-fhead';
    const caret = document.createElement('button'); caret.className = 'fav-caret'; caret.textContent = f && !f.open ? '▸' : '▾';
    if (f) {
      caret.title = f.open ? 'Hide its favorites' : 'Show its favorites';
      caret.addEventListener('click', (e) => { e.stopPropagation(); f.open = !f.open; renderFavorites(); });
    } else caret.disabled = true;
    head.appendChild(caret);
    if (f) {
      const sw = document.createElement('button'); sw.className = 'fav-swatch'; sw.style.background = f.color; sw.title = 'Change its colour';
      sw.addEventListener('click', (e) => { e.stopPropagation(); const c = Favorites.COLORS; f.color = c[(c.indexOf(f.color) + 1) % c.length]; repaintFavorites(); });
      head.appendChild(sw);
    }
    const nm = document.createElement('span'); nm.className = 'fav-fname'; nm.textContent = f ? f.name : 'No folder';
    head.appendChild(nm);
    const cnt = document.createElement('span'); cnt.className = 'fav-fcount'; cnt.textContent = String(sec.items.length);
    head.appendChild(cnt);
    if (f) {
      head.title = `${f.name}\nClick: show all of it on the board. Double-click the name to rename it.`;
      head.addEventListener('click', () => focusFolder(f));
      nm.addEventListener('dblclick', (e) => { e.stopPropagation(); renameFolderInline(f, nm); });
      const ren = document.createElement('button'); ren.className = 'fav-fbtn'; ren.textContent = '✎'; ren.title = 'Rename';
      ren.addEventListener('click', (e) => { e.stopPropagation(); renameFolderInline(f, head.querySelector('.fav-fname')); });
      const del = document.createElement('button'); del.className = 'fav-fbtn'; del.textContent = '✕'; del.title = 'Remove the folder (its videos stay favorites)';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteFavFolder(f); });
      head.append(ren, del);
    }
    box.appendChild(head);
    const body = document.createElement('div'); body.className = 'fav-fbody';
    for (const it of sec.items) body.appendChild(favRow(it));
    if (f && !sec.items.length) { const e = document.createElement('div'); e.className = 'fav-empty'; e.textContent = 'Drag favorites here'; body.appendChild(e); }
    box.appendChild(body);
    favDropTarget(box, f ? f.id : null);
    box.dataset.folder = f ? f.id : '';
    list.appendChild(box);
  }
  if (favRenameNext) {
    const id = favRenameNext; favRenameNext = null;
    const box = list.querySelector(`.fav-folder[data-folder="${CSS.escape(id)}"]`);
    const f = favFolderById(id);
    if (f && box) { box.scrollIntoView({ block: 'nearest' }); renameFolderInline(f, box.querySelector('.fav-fname')); }
  }
}
// Show this tile: on the board fly the camera to it (centred, filling about 60 % of the view); in
// the gallery scroll it into the middle. Either way it pulses gold once so the eye finds it.
let flyRaf = 0;
const cancelFly = () => { if (flyRaf) { cancelAnimationFrame(flyRaf); flyRaf = 0; } };
grid.addEventListener('wheel', cancelFly, { capture: true, passive: true }); // the user takes over
grid.addEventListener('pointerdown', cancelFly, true);
// the board camera flies from where it is to `to` ({ zoom, panX, panY })
function flyTo(to) {
  const r = gridRect();
  const view = { w: r.width, h: r.height };
  const from = { zoom: board.zoom, panX: board.panX, panY: board.panY };
  cancelFly();
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / Favorites.FLY_MS);
    const c = Favorites.between(from, to, k, view);
    board.zoom = c.zoom; board.panX = c.panX; board.panY = c.panY; board.initialized = true;
    applyBoardView();
    flyRaf = k < 1 ? requestAnimationFrame(step) : 0;
  };
  flyRaf = requestAnimationFrame(step);
}
// one flash round a tile (gold, or its folder's colour), so the eye finds it
function pulseTile(tile) {
  for (const old of tile.el.querySelectorAll('.fav-pulse')) old.remove();
  const pulse = document.createElement('div');
  pulse.className = 'fav-pulse';
  pulse.addEventListener('animationend', () => pulse.remove());
  tile.el.appendChild(pulse);
}
function focusTile(tile) {
  if (!tiles.includes(tile)) return;
  if (isBoard() && tile.board) {
    const r = gridRect();
    flyTo(Favorites.camera(tile.board, { w: r.width, h: r.height }, { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }));
    // bringToFront(tile); // DISABLED (Mark, 2026-11-10): jumping to it no longer changes its layer
  } else {
    tile.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }
  pulseTile(tile);
  setStatus(`★ ${tileName(tile)}`, 2500);
}
// ★ Favorites in the toolbar: the sidebar on its Favorites tab (again: closes it)
btnFavs.addEventListener('click', () => {
  if (settings.sidebar.open && settings.sidebar.tab === 'fav') { sidebar.close(); return; }
  sidebar.setTab('fav');
  if (!settings.sidebar.open) sidebar.open();
});
if (!IS_VIEW) sbEl.querySelector('.fav-newfolder').addEventListener('click', (e) => { e.stopPropagation(); newFavFolder(); });
// "Playing favorites keep playing out of view": one setting, shown in the Optimize menu and on the
// Favorites tab, with its quiet level (a share of full volume) on the tab
const favKeepBoxes = [...document.querySelectorAll('.opt-favkeep')];
const favQuietInput = sbEl.querySelector('.opt-favquiet');
function syncFavKeep() {
  for (const b of favKeepBoxes) b.checked = !!settings.favKeepPlaying;
  favQuietInput.value = String(Math.round(settings.favQuiet * 100));
  favQuietInput.disabled = !settings.favKeepPlaying;
}
function setFavKeep(on) {
  settings.favKeepPlaying = !!on;
  saveSettings(); syncFavKeep();
  if (on) for (const t of tiles) if (t.favorite && t.autoPaused && t.pb) offscreenResume(t); // what offscreen pause stopped plays on
  applyLiveBudget(); applyOffscreen();
  setStatus(on ? `Playing favorites keep playing out of view, at ${Math.round(settings.favQuiet * 100)}% volume` : 'Favorites out of view are stills again, like every other video', 4000);
}
for (const b of favKeepBoxes) b.addEventListener('change', () => setFavKeep(b.checked));
favQuietInput.addEventListener('keydown', (e) => e.stopPropagation()); // digits are not shortcuts here
favQuietInput.addEventListener('change', () => {
  settings.favQuiet = Settings.merge({ favQuiet: Number(favQuietInput.value) / 100 }).favQuiet;
  saveSettings(); syncFavKeep();
  applyAudioOwners(); // the favorites playing out of view now are at the new level
  setStatus(`Favorites out of view play at ${Math.round(settings.favQuiet * 100)}% volume`, 3000);
});

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

// text tiles have no path at all, so they never mark a sidebar row as on the board
function onBoardPaths() { return new Set(tiles.filter((t) => typeof t.path === 'string').map((t) => t.path.toLowerCase())); }
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
  for (const [label, act, disabled] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    if (disabled) b.disabled = true; // shown greyed rather than hidden, so the menu keeps its shape
    else b.addEventListener('click', () => { closeRowMenu(); act(); });
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
  if (!viewMayEdit()) return;
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
document.getElementById('sb-close').addEventListener('click', () => sidebar.close()); // (the ✕ in its own header)
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
  applySettingsToUi();
  renderFolders();
  renderPlaylists(); // from the cache in settings.json, no refetch
});
// the toggles and fields that show a setting; at startup, and when another window saved settings
function applySettingsToUi() {
  wheelZoomEl.checked = !!settings.wheelZoom;
  setLinked(!!settings.pushNeighbours); // Push neighbours (off as standard)
  optOffscreen.checked = settings.pauseOffscreen;
  applyLoadStrip(); // the strip and its height come back as they were left
  optLiveCap.value = String(settings.viewLiveCap);
  syncFavKeep(); // favorites playing on out of view, and how quietly
  tidySlackEl.value = String(settings.tidySlack);
  hoverPlayBtn.classList.toggle('toggled', !!settings.hoverPlay); // the mode survives a restart
  ezPlayBtn.classList.toggle('toggled', !!settings.ezPlay); document.body.classList.toggle('ez-play', !!settings.ezPlay);
  renderEmptyRecent(); // the empty-board hint lists the recent sessions
}
window.api.ytdlpAvailable().then((ok) => {
  document.getElementById('sb-add-playlist').disabled = !ok;
  if (!ok) sbNote.textContent = 'yt-dlp not found; playlists unavailable';
});

// ---------- hover play ----------
// A viewing mode: every video stays paused until the cursor rests on it. The timing rules live in
// lib/hoverplay.js; this half owns the tiles - turning an action into a play/pause on the right
// thing (a synced group moves together), and keeping one timer pointed at the next due moment.
const hp = HoverPlay.create({ delay: 150 });
let hpTimer = null;
let hpSeq = 0;
const hpId = (t) => (t.hpId || (t.hpId = ++hpSeq)); // stable per tile, unlike an index
const hpTile = (id) => tiles.find((t) => t.hpId === id) || null;
const hoverPlayOn = () => !!(settings && settings.hoverPlay);
const hoverPlayBusy = () => !cmp.el.hidden || sedOpen() || !!document.fullscreenElement; // compare / the sync editor / fullscreen own playback

function hpApply(actions) {
  for (const a of actions) {
    const t = hpTile(a.id);
    if (!t || !t.pb || !tiles.includes(t)) continue;
    const g = t.group;
    // a synced group plays and pauses as one, so hovering a member moves the whole group
    if (g && g.sync && t.sync) { t.pb[a.op](); broadcast(t, a.op); }
    else t.pb[a.op]();
  }
  hpSchedule();
}
function hpSchedule() {
  clearTimeout(hpTimer);
  hpTimer = null;
  const due = hp.nextDue();
  if (due === null) return;
  hpTimer = setTimeout(() => hpApply(hp.tick(performance.now())), Math.max(0, due - performance.now()));
}
// called from every tile's pointerenter / pointerleave, next to where hoveredTile is set
function hpEnter(t) {
  if (!hoverPlayOn() || !t.pb || hoverPlayBusy()) return;
  hpApply(hp.enter(hpId(t), performance.now()));
}
function hpLeave(t) {
  if (!hoverPlayOn() || !t.pb) return;
  hpApply(hp.leave(hpId(t), performance.now()));
}
function hpReset() { hpApply(hp.reset()); }

const hoverPlayBtn = document.getElementById('hover-play');
function setHoverPlay(on) {
  settings.hoverPlay = !!on;
  saveSettings();
  hoverPlayBtn.classList.toggle('toggled', settings.hoverPlay);
  hpReset(); // whatever hover started stops either way
  if (settings.hoverPlay) {
    tiles.forEach(pauseTile); // start from silence: nothing plays until you hover it
    setStatus('Hover play on: a video plays while the cursor rests on it. Space and Play all are off.');
  } else {
    setStatus('Hover play off: videos stay as they are, Space and Play all work again.');
  }
}
hoverPlayBtn.addEventListener('click', () => setHoverPlay(!hoverPlayOn()));

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
const offscreenOn = () => !!(settings && settings.pauseOffscreen) && !hoverPlayOn() && cmp.el.hidden && !sedOpen() && !document.fullscreenElement;
// An explicit pause (Pause all, the group bar, a synced partner) of a tile we paused must stick, or
// it would start playing when it came back. It is already paused, so no media event fires: catch
// the call itself, once per playback adapter.
function watchPause(t) {
  const pb = t.pb;
  if (pb.offscreenWatched) return;
  pb.offscreenWatched = true;
  const pause = pb.pause.bind(pb);
  pb.pause = () => { t.autoPaused = false; pause(); };
}
function offscreenResume(t) { quietly(() => offscreenResumeNow(t)); } // this window's own business
function offscreenResumeNow(t) {
  t.autoPaused = false;
  const g = t.group;
  if (g && g.sync && t.sync) {
    const gt = groupTimeOf(g), m = memberEntry(t);
    t.pb.time = Groups.at(m, gt);
    if (!Groups.plays(m, gt)) return; // waiting at 0, holding, or held at its end: the sync engine starts it
  }
  t.pb.play();
}
function applyOffscreen() { quietly(applyOffscreenNow); } // a pause here is not the board's
function applyOffscreenNow() {
  if (!offscreenOn()) return;
  const r = gridRect();
  const view = { x: r.left, y: r.top, w: r.width, h: r.height };
  const items = tiles.filter((t) => t.pb && t.el.isConnected && (isBoard() ? !!t.board : !t.freeAspect)).map((t) => {
    const b = t.el.getBoundingClientRect();
    return { id: t, rect: { x: b.left, y: b.top, w: b.width, h: b.height }, playing: !t.pb.paused, autoPaused: !!t.autoPaused };
  });
  // local videos are not paused off screen any more: the live budget turns them into stills
  // a playing favorite is not paused either while favorites keep playing (applyLiveBudget turns it down)
  for (const t of tiles) if (t.autoPaused && t.pb && keptFavorite(t)) offscreenResume(t);
  for (const a of Visibility.decide(items.filter((i) => !i.id.release && !keptFavorite(i.id)), view, Math.max(r.width, r.height) * OFFSCREEN_MARGIN)) {
    const t = a.id;
    if (a.op === 'pause') { watchPause(t); t.pb.pause(); t.autoPaused = true; } // no broadcast: the group keeps playing
    else offscreenResume(t);
  }
}
// ---------- live budget ----------
// Tiles off screen or smaller than LIVE_MIN_PX on screen are stills in every window (motion is
// invisible at that size). An extra view window also decodes at most settings.viewLiveCap local
// videos, the surplus furthest from its middle being stills; the main window has no cap (Scott,
// 2026-10-20). What the compare view or fullscreen shows, and a still that was just touched, are
// always live (lib/lod.js).
const LIVE_MIN_PX = 96;
const LIVE_WANTED_MS = 5000;
const liveCapHere = () => (window.OZY_VIEW > 0 ? settings.viewLiveCap : Infinity);
// a favorite that is playing keeps playing out of view (the main window only: it is the one heard
// for it; a view that also shows it is heard instead while it does)
const favKeepOn = () => !IS_VIEW && !!(settings && settings.favKeepPlaying);
const keptFavorite = (t) => favKeepOn() && !!t.favorite && !!t.pb && (!t.pb.paused || !!t.autoPaused);
function applyLiveBudget() {
  if (!settings) return;
  const r = gridRect();
  const view = { x: r.left, y: r.top, w: r.width, h: r.height };
  const fsEl = document.fullscreenElement, now = performance.now();
  const forced = (t) => (!cmp.el.hidden && (t === cmp.a || t === cmp.b)) || (sedOpen() && (t === sed.main || t === sed.f)) || (fsEl && fsEl === t.el) || (t.wantedAt && now - t.wantedAt < LIVE_WANTED_MS);
  // compare and fullscreen first, then the most recently touched (Lod caps them at the window's cap)
  const forcedRank = (t) => ((!cmp.el.hidden && (t === cmp.a || t === cmp.b)) || (sedOpen() && (t === sed.main || t === sed.f)) || (fsEl && fsEl === t.el) ? 0 : 1 + (now - (t.wantedAt || 0)));
  const items = tiles.filter((t) => (t.release || t.pb) && !t.freeAspect).map((t) => {
    const shown = t.el.isConnected && !t.el.hidden && (isBoard() ? !!t.board : true);
    const b = shown ? t.el.getBoundingClientRect() : { left: -1e6, top: -1e6, width: 0, height: 0 };
    const f = !!(t.release && forced(t));
    return { id: t, rect: { x: b.left, y: b.top, w: b.width, h: b.height }, playing: !!(t.pb && !t.pb.paused), budgeted: !!t.release, forced: f, forcedRank: f ? forcedRank(t) : 0, keep: keptFavorite(t) };
  });
  const live = Lod.choose(items, view, { minPx: LIVE_MIN_PX, cap: liveCapHere() });
  // kept playing but not really in view (off screen or too small to see): quietly
  for (const i of items) setQuietKept(i.id, i.keep && live.has(i.id) && !Lod.seen(i.rect, view, LIVE_MIN_PX));
  for (const t of tiles) {
    if (!t.release) continue;
    if (live.has(t)) { if (!t.live) t.restore(); }
    else if (t.live) t.release();
    else t.onShadow(); // a still's clock keeps moving: keep its time and seek bar honest
  }
  refreshLiveSet(); // which window is heard for each tile may have moved
}
setInterval(() => { if (!document.hidden) { applyLiveBudget(); applyOffscreen(); applyImageLod(); } }, 500);
grid.addEventListener('scroll', scheduleOffscreen, { passive: true });
const optOffscreen = document.getElementById('opt-offscreen');
function setPauseOffscreen(on) {
  settings.pauseOffscreen = !!on;
  saveSettings();
  optOffscreen.checked = settings.pauseOffscreen;
  if (settings.pauseOffscreen) applyOffscreen();
  else for (const t of tiles) if (t.autoPaused && t.pb) offscreenResume(t); // give back what we paused
  setStatus(settings.pauseOffscreen ? 'Offscreen videos pause until they come back into view' : 'Offscreen videos keep playing');
}
optOffscreen.addEventListener('change', () => setPauseOffscreen(optOffscreen.checked));
// how many local videos each extra view window decodes at once (the main window has no cap)
const optLiveCap = document.getElementById('opt-livecap');
optLiveCap.addEventListener('change', () => {
  settings.viewLiveCap = Settings.merge({ viewLiveCap: Number(optLiveCap.value) }).viewLiveCap;
  optLiveCap.value = String(settings.viewLiveCap);
  saveSettings();
  applyLiveBudget();
  if (window.api.bus) window.api.bus({ type: 'settings', viewLiveCap: settings.viewLiveCap }); // open views follow at once
  setStatus(`Extra views play at most ${settings.viewLiveCap} videos live; the rest show a still`);
});
optLiveCap.addEventListener('keydown', (e) => e.stopPropagation()); // digits are not shortcuts here

// ---------- playback quality (scene) ----------
// layout.quality is the scene's tier; a tile's own ⚙ quality overrides it. Each video tile's
// applyQuality() (addVideo) swaps to the cached smaller copy, or has one made first.
function syncQualityRadios() { for (const r of document.querySelectorAll('input[name="opt-quality"]')) r.checked = r.value === layout.quality; }
function setSceneQuality(q) {
  layout.quality = q === 'half' || q === 'quarter' ? q : 'full';
  syncQualityRadios();
  for (const t of tiles) if (t.applyQuality) t.applyQuality();
  setStatus(layout.quality === 'full' ? 'Playing at full resolution' : `Playing at ${layout.quality === 'half' ? '½' : '¼'} resolution – smaller copies are made as needed`);
}
for (const r of document.querySelectorAll('input[name="opt-quality"]')) r.addEventListener('change', () => { if (r.checked) setSceneQuality(r.value); });
syncQualityRadios();

// ---------- cache folder and cap ----------
// The cap covers the video copies (playable + smaller); main trims after each one it makes.
const optCacheLine = document.getElementById('opt-cache-line');
const optCacheCap = document.getElementById('opt-cache-cap');
async function refreshCacheLine() {
  try {
    const { bytes, proxyBytes, capMB, dir } = await window.api.cacheInfo();
    const mb = (b) => (b / 1048576).toFixed(0);
    optCacheLine.textContent = `Video copies ${mb(proxyBytes)} MB of ${capMB} MB · whole cache ${mb(bytes)} MB\n${dir}`;
    optCacheLine.title = dir;
    optCacheCap.value = String(settings.cacheCapMB);
  } catch { optCacheLine.textContent = 'unavailable'; }
}
document.getElementById('btn-optimize').addEventListener('click', refreshCacheLine);
optCacheCap.addEventListener('keydown', (e) => e.stopPropagation()); // typing a number is not a shortcut
optCacheCap.addEventListener('change', async () => {
  settings.cacheCapMB = Math.max(512, Number(optCacheCap.value) || 20480);
  await window.api.saveSettings(settings); // main reads the cap from the file: write now, not on the debounce
  refreshCacheLine();
});
document.getElementById('opt-cache-folder').addEventListener('click', async () => {
  const dir = await window.api.pickCacheFolder();
  if (!dir) return;
  settings.cacheDir = dir;
  await window.api.saveSettings(settings); // as above: the next copy must already go to the new folder
  setStatus('New copies go to ' + dir + ' (existing ones stay where they were)', 8000);
  refreshCacheLine();
});
document.getElementById('opt-cache-clear').addEventListener('click', () => { optList.hidden = true; document.getElementById('btn-cache').click(); });

// ---------- load viewer: docked strip (live bars) and the pop-out table ----------
// Twice a second while either is showing: Ozy against everything else (totals from main,
// lib/loadstats.js does the arithmetic) and a row per tile. Reads nothing about other programs.
const loadPanel = document.getElementById('load-panel');
const optLoad = document.getElementById('opt-load');
const loadStrip = document.getElementById('load-strip');
const loadBtn = document.getElementById('btn-load');
const LS_MIN_H = 56, LS_MAX_H = 400, LS_TABLE_H = 220;
let loadTimer = null;
const tileState = (t) => (!t.pb ? (t.type || 'image') : t.release && !t.live ? (t.pb.paused ? 'still' : 'still, playing') : t.autoPaused ? 'auto-paused' : t.pb.paused ? 'paused' : 'playing');
const loadShowing = () => !loadPanel.hidden || !loadStrip.hidden;
function fillLoadRows(tbody) {
  const rows = LoadStats.rows(tiles.map((t) => {
    const v = t.video;
    const q = v && typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    return { name: tileName(t), width: v ? v.videoWidth : 0, height: v ? v.videoHeight : 0, tier: t.tier, state: tileState(t), dropped: q ? q.droppedVideoFrames : undefined };
  }));
  tbody.textContent = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of [r.name, r.res, r.tier, r.state, r.dropped, r.estMB ? LoadStats.fmt(r.estMB) : '–']) { const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td); }
    tr.firstChild.title = r.name;
    tbody.appendChild(tr);
  }
}
async function refreshLoad() {
  if (!loadShowing()) return;
  // a failed read (IPC error) leaves s null: both views say "unavailable", nothing throws in the timer
  let raw = null, s = null;
  try { raw = await window.api.loadStats(); s = LoadStats.split(raw); } catch { raw = null; s = null; }
  // the first sample has nothing to compare the machine's CPU against yet
  const pct = (v) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) + '%';
  const otherCpu = !s || raw.sysCpu === null ? '…' : pct(s.other.cpu);
  // the whole machine's GPU, from nvidia-smi when the machine has it (null otherwise, or while a
  // sample is on its way); Ozy's own figure is its GPU process's memory, a different measure
  const gpu = s && raw.gpu ? raw.gpu : null;
  if (!loadPanel.hidden) {
    loadPanel.querySelector('.lp-sum').textContent = s
      ? `Ozy ${pct(s.ozy.cpu)} CPU · ${LoadStats.fmt(s.ozy.memMB)} (${LoadStats.fmt(s.ozy.gpuMemMB)} GPU) · Everything else ${otherCpu} CPU · ${LoadStats.fmt(s.other.memMB)} · ${LoadStats.fmt(s.freeMB)} free`
        + (gpu ? ` · GPU ${gpu.busy}% busy, ${LoadStats.fmt(gpu.usedMB)} of ${LoadStats.fmt(gpu.totalMB)}` : '')
      : 'unavailable';
    fillLoadRows(loadPanel.querySelector('tbody'));
  }
  if (!loadStrip.hidden) {
    const b = LoadStats.bars(s, s ? raw.totalMemMB : 0);
    for (const seg of b.mem) loadStrip.querySelector(`.ls-mem [data-key="${seg.key}"]`).style.width = seg.pct + '%';
    for (const seg of b.cpu) loadStrip.querySelector(`.ls-cpu [data-key="${seg.key}"]`).style.width = seg.pct + '%';
    loadStrip.querySelector('.ls-mem-text').textContent = s ? `Ozy ${LoadStats.fmt(s.ozy.memMB)} · else ${LoadStats.fmt(s.other.memMB)} · free ${LoadStats.fmt(s.freeMB)} of ${LoadStats.fmt(raw.totalMemMB)}` : 'unavailable';
    loadStrip.querySelector('.ls-cpu-text').textContent = s ? `Ozy ${pct(s.ozy.cpu)} · else ${otherCpu}` : 'unavailable';
    for (const seg of LoadStats.gpuBar(gpu)) loadStrip.querySelector(`.ls-gpu [data-key="${seg.key}"]`).style.width = seg.pct + '%';
    loadStrip.querySelector('.ls-gpu-text').textContent = gpu
      ? `${gpu.busy}% busy · ${LoadStats.fmt(gpu.usedMB)} of ${LoadStats.fmt(gpu.totalMB)} · Ozy ${LoadStats.fmt(s.ozy.gpuMemMB)}`
      : (s ? `unavailable here · Ozy ${LoadStats.fmt(s.ozy.gpuMemMB)}` : 'unavailable');
    const tbl = loadStrip.querySelector('.ls-table');
    if (!tbl.hidden) fillLoadRows(tbl.querySelector('tbody'));
  }
}
function syncLoadTimer() {
  clearInterval(loadTimer); loadTimer = null;
  if (loadShowing()) { refreshLoad(); loadTimer = setInterval(refreshLoad, 500); }
}
function setLoadViewer(on) {            // the pop-out, from Optimize ▾
  loadPanel.hidden = !on;
  optLoad.checked = on;
  syncLoadTimer();
}
// show the strip the way settings say (startup, and after every change); does not save
function applyLoadStrip() {
  loadStrip.hidden = !settings.loadStrip;
  loadBtn.classList.toggle('toggled', !!settings.loadStrip);
  loadStrip.style.setProperty('--ls-h', settings.loadStripH + 'px');
  syncLoadTimer();
  layoutTiles(); // the board / gallery viewport changed height
}
function setLoadStrip(on) {             // the docked strip, from the Load button; remembered
  settings.loadStrip = !!on;
  saveSettings();
  applyLoadStrip();
}
optLoad.addEventListener('change', () => setLoadViewer(optLoad.checked));
loadPanel.querySelector('.lp-close').addEventListener('click', () => setLoadViewer(false));
loadBtn.addEventListener('click', () => setLoadStrip(!settings.loadStrip));
loadStrip.querySelector('.ls-close').addEventListener('click', () => setLoadStrip(false));
loadStrip.querySelector('.ls-videos').addEventListener('click', (e) => {
  const tbl = loadStrip.querySelector('.ls-table');
  tbl.hidden = !tbl.hidden;
  e.currentTarget.textContent = tbl.hidden ? 'Videos ▾' : 'Videos ▴';
  // the table needs room: grow a short strip so its rows can be seen
  if (!tbl.hidden && settings.loadStripH < 200) { settings.loadStripH = LS_TABLE_H; saveSettings(); loadStrip.style.setProperty('--ls-h', LS_TABLE_H + 'px'); layoutTiles(); }
  refreshLoad();
});
// drag the top edge to resize, same idea as the timeline's head
loadStrip.querySelector('.ls-grip').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const grip = e.currentTarget;
  try { grip.setPointerCapture(e.pointerId); } catch {}
  const y0 = e.clientY, h0 = settings.loadStripH;
  const onMove = (ev) => {
    settings.loadStripH = Math.round(clamp(h0 + (y0 - ev.clientY), LS_MIN_H, LS_MAX_H));
    loadStrip.style.setProperty('--ls-h', settings.loadStripH + 'px');
  };
  let ended = false;
  const onUp = () => {
    if (ended) return;
    ended = true;
    grip.removeEventListener('pointermove', onMove); grip.removeEventListener('pointerup', onUp); grip.removeEventListener('pointercancel', onUp); grip.removeEventListener('lostpointercapture', onUp);
    saveSettings(); layoutTiles();
  };
  grip.addEventListener('pointermove', onMove); grip.addEventListener('pointerup', onUp); grip.addEventListener('pointercancel', onUp); grip.addEventListener('lostpointercapture', onUp);
});

// ---------- EZ play ----------
// A click anywhere on a tile that is not a control plays or pauses it. The picture already does
// this; EZ play extends it to the overlay bars and, for embeds, to a shield over the iframe.
const ezPlayBtn = document.getElementById('ez-play');
const ezPlayOn = () => !!(settings && settings.ezPlay);
function setEzPlay(on) {
  settings.ezPlay = !!on;
  saveSettings();
  ezPlayBtn.classList.toggle('toggled', settings.ezPlay);
  document.body.classList.toggle('ez-play', settings.ezPlay);
  setStatus(settings.ezPlay ? 'EZ play on: click anywhere on a video to play or pause it' : 'EZ play off');
}
ezPlayBtn.addEventListener('click', () => setEzPlay(!ezPlayOn()));
// Every click that reaches a tile's element. On the board the tile owns the pointer from
// pointerdown (attachTileDrag), so Chromium delivers the click here, not to the <video> / canvas
// under the cursor: e.target is the tile and the picture's own handler never runs. So look up
// what is really under the pointer and play from here. In the gallery the picture gets its own
// click and this only adds EZ play (tile chrome, and the shield over an embed).
function tileClick(tile, e) {
  if (!tile.pb || (isBoard() && board.hand)) return;
  const retargeted = e.target === tile.el;
  const hit = retargeted ? document.elementFromPoint(e.clientX, e.clientY) : e.target;
  if (!hit || !tile.el.contains(hit)) return;
  const closest = (s) => !!hit.closest(s);
  const onPicture = hit === tile.mediaEl && hit.tagName !== 'IFRAME';
  const target = ClickGuard.clickTarget({ closest, onPicture, ez: ezPlayOn() });
  // The time readout's own click handler is starved the same way the picture's is. (A bookmark
  // marker is not: it stops the pointerdown, so the tile never captures and its click arrives.)
  if (target === 'time') { if (retargeted && tile.timeClick && tile.guard.shouldAct()) tile.timeClick(); return; }
  if (target !== 'picture') return;
  const plays = ClickGuard.clickPlays({ shift: e.shiftKey, retargeted, onPicture, ez: ezPlayOn(), onControl: !ClickGuard.ezTarget(closest) });
  if (!plays || !tile.guard.shouldAct()) return;
  if (tile.togglePlay) tile.togglePlay(); else if (tile.pb.paused) tile.pb.play(); else tile.pb.pause();
}
// Double-click on the picture = fullscreen. On the board the dblclick is delivered to the tile
// element for the same reason the click is, so the picture's own dblclick handler never runs
// there; in the gallery it does, and this stays out of its way (not retargeted).
function tileDblClick(tile, e) {
  const retargeted = e.target === tile.el;
  const hit = retargeted ? document.elementFromPoint(e.clientX, e.clientY) : e.target;
  if (!hit || !tile.el.contains(hit)) return;
  // the picture: the tile's video / canvas (not an embed's iframe), or an image tile's <img>
  const onPicture = (hit === tile.mediaEl && hit.tagName !== 'IFRAME') || (hit.tagName === 'IMG' && hit.parentElement === tile.el);
  if (ClickGuard.dblClickFullscreens({ retargeted, onPicture, compareOpen: !cmp.el.hidden || sedOpen() })) toggleTileFullscreen(tile.el);
}
// the time readout cycles clock -> frames -> timecode, for every tile at once
function cycleTimeDisplay() {
  const modes = ['clock', 'frames', 'timecode'];
  layout.timeDisplay = modes[(modes.indexOf(layout.timeDisplay) + 1) % modes.length];
  for (const t of tiles) t.refreshTime && t.refreshTime();
  renderTimeline(); // lane timecodes follow the display mode
}

// ---------- copy / paste ----------
// In-app clipboard: the selected tiles' session records, the same shape a saved file and undo's
// remove already use, so paste can rebuild every tile type through addFromRecord. Groups are not
// copied; pasted tiles start ungrouped with their own volume / mute / loop / bookmarks.
let clipboard = null;        // { records, origin: {x,y}|null, lastPaste: {x,y}|null }
let pointerOverBoard = false;
let lastPointer = null;      // last client coords seen over the board, for "paste at the cursor"
grid.addEventListener('pointerenter', () => { pointerOverBoard = true; });
grid.addEventListener('pointerleave', () => { pointerOverBoard = false; });
grid.addEventListener('pointermove', (e) => { lastPointer = { clientX: e.clientX, clientY: e.clientY }; });

// what a tile looks like as one line of text, for the OS clipboard
const recordLine = (r) => (r.type === 'text' ? r.text : r.type === 'line' ? '' : r.url || r.dir || r.path || '');

function copySelection() {
  if (!selection.size) { setStatus('Nothing selected to copy'); return; }
  const all = collectSession().videos; // same order as `tiles`, which undo already relies on
  const records = tiles.map((t, i) => i).filter((i) => selection.has(tiles[i])).map((i) => all[i]);
  const bb = TileClipboard.bbox(records);
  clipboard = { records, origin: bb ? { x: bb.x, y: bb.y } : null, lastPaste: null };
  setStatus(`Copied ${records.length} tile${records.length === 1 ? '' : 's'}`);
  logUi('info', 'copy', { tiles: records.length });
  // also hand the paths / text to the OS clipboard, so they can be pasted elsewhere. Best effort.
  try {
    const lines = records.map(recordLine).filter(Boolean);
    clipboard.osText = lines.join('\n'); // so a paste can tell Ozy's own copy from something copied since
    // (through main, not navigator.clipboard: that one fails when the window is not focused)
    if (lines.length) Promise.resolve(window.api.copyText(lines.join('\n'))).catch(() => navigator.clipboard.writeText(lines.join('\n')).catch(() => {}));
  } catch {}
}

// ---- a picture copied in another program (Mark, 2026-11-10) ----
// Ctrl+V with a picture on the system clipboard (Chrome's or Discord's Copy image, a link to a
// picture) puts it on the board under the cursor, unless the clipboard still holds what Ozy itself
// copied last, in which case Ozy's tiles are pasted as before. main.js picks the best copy of the
// picture and keeps it in "Ozy Imports\Pasted".
const sameText = (a, b) => String(a || '').replace(/\r\n/g, '\n').trim() === String(b || '').replace(/\r\n/g, '\n').trim();
let pastingPicture = false;
let lastPasteNote = ''; // why a copied link could not be pasted, said if there is nothing else to paste
async function pastePicture() {
  if (pastingPicture) return true;
  pastingPicture = true;
  setStatus('Pasting the picture…', 20000);
  let r;
  try { r = await window.api.pasteImage(); } catch (e) { r = { error: String(e && e.message || e) }; } finally { pastingPicture = false; }
  if (!r || r.notPicture) { lastPasteNote = r && r.error ? r.error : ''; return false; }
  if (r.error) { setStatus(r.error, 6000); return true; }
  // where: under the cursor on the board, else the middle of the view; about as big on screen as
  // it really is, but never more than half the view's height (the board can zoom in on it)
  let at = null, board0 = null;
  if (isBoard()) {
    const gr = gridRect();
    const c = pointerOverBoard && lastPointer ? toCanvas(lastPointer.clientX, lastPointer.clientY) : viewCentreWorld();
    const ar = r.w > 0 && r.h > 0 ? r.w / r.h : DEFAULT_ASPECT;
    const hScreen = Math.max(80, Math.min(r.h > 0 ? r.h : gr.height * 0.4, gr.height * 0.5));
    const h = hScreen / board.zoom, w = h * ar;
    board0 = { x: c.x - w / 2, y: c.y - h / 2, w, h };
    at = c;
  }
  const tile = addImageTile(r.path, board0 ? { board: board0, aspect: board0.w / board0.h } : {}, at);
  if (!tile) return true;
  if (isBoard() && !tile.board) placeOnBoard([tile], at);
  layoutTiles();
  clearSelection(); bringToFront(tile); setSelected(tile, true);
  recordAdd([tile], 'paste picture');
  updateChrome(); markOnBoard();
  const from = r.from === 'link' ? 'the original file' : r.from === 'data' ? 'the picture in the page' : 'the copied picture';
  setStatus(`Pasted ${r.w && r.h ? `${r.w} × ${r.h} ` : ''}picture (${from}${r.reused ? ', already pasted before: same file' : ''})`, 5000);
  logUi('info', 'picture pasted', { from: r.from, w: r.w, h: r.h, reused: !!r.reused });
  return true;
}

async function pasteClipboard() {
  if (!viewMayEdit()) return;
  // a picture copied in another program since Ozy's own last copy wins
  let sys = null;
  try { sys = await window.api.clipboardKind(); } catch {}
  const ozyOwn = !!(clipboard && clipboard.osText != null && sys && sameText(sys.text, clipboard.osText) && !sys.hasImage);
  lastPasteNote = '';
  // links (2026-11-16): into the selected bookmark block; else, once they are no picture, a new block
  const pastedUrls = sys && !ozyOwn && !sys.hasImage ? LinkTable.findUrls(sys.text || '') : [];
  const linkBlocks = [...selection].filter(isLinksTile);
  if (pastedUrls.length && linkBlocks.length === 1) { addLinks(linkBlocks[0], pastedUrls); return; }
  // lines of text into the selected to-do list: one task each (2026-11-17)
  const todoBlocks = [...selection].filter((t) => t.todo && tiles.includes(t));
  if (todoBlocks.length === 1 && sys && !ozyOwn && !sys.hasImage && (sys.text || '').trim()) {
    const items = TodoList.fromText(sys.text);
    if (items.length && changeTodo(todoBlocks[0], `paste ${items.length} tasks`, (m) => { m.items.push(...items); TodoList.settle(m.items); return true; })) { setStatus(`Added ${TodoList.count(items)} tasks`, 3000); return; }
  }
  if (sys && !ozyOwn && (sys.hasImage || sys.src || sys.url)) { if (await pastePicture()) return; }
  if (pastedUrls.length && isBoard() && !IS_VIEW) { addLinksBlock(placePoint(), pastedUrls); return; }
  if (!clipboard || !clipboard.records.length) { setStatus(lastPasteNote || 'Nothing to paste: copy a picture (or tiles here) first', 5000); return; }
  let target = null;
  if (isBoard() && pointerOverBoard && lastPointer) {
    target = toCanvas(lastPointer.clientX, lastPointer.clientY); // drop the block under the cursor
  } else {
    const base = clipboard.lastPaste || clipboard.origin;
    if (base) target = { x: base.x + 24, y: base.y + 24 }; // repeated pastes stagger
  }
  const recs = TileClipboard.placeRecords(clipboard.records, target);
  // a record with no board of its own (a gallery-only tile) cascades under the pasted block
  const loosePoints = isBoard() ? TileClipboard.cascadePoints(recs, GAP) : [];
  const added = [];
  let missing = 0, skipped = 0, loose = 0;
  for (const v of recs) {
    if (!isBoard() && (v.type === 'text' || v.type === 'line')) { skipped++; continue; } // text and lines have no gallery form
    const wasLoose = !(v.board && isFinite(Number(v.board.x)));
    // groups aren't copied, so nor are offsets; copies start paused and are new tiles (new ids)
    const r = await addFromRecord(Session.openRecord({ ...v, sync: null, id: undefined, locked: undefined, ends: undefined })); // (a pasted copy is not locked, nor held at its ends)
    if (r.missing) missing++;
    if (r.tile) {
      if (isBoard() && wasLoose && !r.tile.board) placeOnBoard([r.tile], loosePoints[loose] || null);
      added.push(r.tile);
    }
    if (wasLoose) loose++;
  }
  if (added.length) {
    clearSelection();
    for (const t of added) { bringToFront(t); setSelected(t, true); }
    if (isBoard()) placeOnBoard(added.filter((t) => !t.board)); // anything still unplaced
    layoutTiles();
    recordAdd(added, `paste ${added.length} tile${added.length === 1 ? '' : 's'}`);
  }
  clipboard.lastPaste = target;
  updateChrome();
  markOnBoard();
  renderTimeline();
  logUi('info', 'paste', { tiles: added.length, missing, skipped });
  const notes = [];
  if (missing) notes.push(`${missing} missing`);
  if (skipped) notes.push('text tiles paste on the board only');
  setStatus(`Pasted ${added.length} tile${added.length === 1 ? '' : 's'}` + (notes.length ? ` – ${notes.join(', ')}` : ''));
}

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  // a focused button (you just clicked one) shouldn't swallow the shortcuts
  // a tile being typed into counts as a control: its keys are text, not shortcuts
  const inControl = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!(e.target && e.target.isContentEditable);
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === 'Escape' && colorPop) { e.preventDefault(); closeColorPop(); return; } // the colour pop first
  if (e.key === 'Escape' && tsEl) { e.preventDefault(); closeTileSettings(); return; } // then the ⚙ popover
  // Esc leaves a fullscreen tile (Electron doesn't do this for page fullscreen by itself)
  if (e.key === 'Escape' && document.fullscreenElement) { e.preventDefault(); document.exitFullscreen().catch(() => {}); return; }

  // the sync editor owns the keyboard while it is open
  if (sedOpen()) { sedKey(e); return; }
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
  // inControl already covers a text tile being edited, where these are the native copy and paste
  if ((e.key === 'PageUp' || e.key === 'PageDown') && !ctrl && !inControl && isBoard() && !IS_VIEW) {
    const target = selection.size ? null : hoveredTile;
    if (selection.size || (target && target.board)) { e.preventDefault(); (e.key === 'PageUp' ? stackToFront : stackToBack)(target); return; }
  }
  if (ctrl && e.shiftKey && key === 'l' && !inControl && isBoard() && !IS_VIEW) { e.preventDefault(); toggleLock(selection.size ? null : hoveredTile); return; }
  if (ctrl && key === 'd' && !e.shiftKey && !inControl && isBoard() && !IS_VIEW) { e.preventDefault(); duplicateSelection(); return; }
  if (ctrl && key === 'f' && !e.shiftKey && isBoard()) { e.preventDefault(); openFind(); return; }
  if (ctrl && key === 'c' && !inControl) { e.preventDefault(); copySelection(); return; }
  if (ctrl && key === 'v' && !inControl) { e.preventDefault(); pasteClipboard(); return; }

  if (inControl) return;
  if (key === 'c' && !ctrl) { tryOpenCompare(); return; }
  // lines (2026-11-10): [ ] thinner / thicker (the selected lines, else the line under the mouse);
  // Delete removes the selected lines; D draws a line
  if ((e.key === '[' || e.key === ']') && !ctrl && isBoard() && !IS_VIEW) {
    const target = selectedLines().length ? null : hoveredTile && hoveredTile.type === 'line' ? hoveredTile : null;
    if (selectedLines().length || target) { e.preventDefault(); stepLines(e.key === ']' ? 1 : -1, target); return; }
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !ctrl && isBoard() && !IS_VIEW && selectedLines().length) { e.preventDefault(); removeLines(null); return; }
  if (key === 'd' && !ctrl && !e.shiftKey && isBoard() && !IS_VIEW) { e.preventDefault(); setLineTool(!lineTool); return; }
  if (key === 'n' && !ctrl && !e.shiftKey && isBoard() && !IS_VIEW) { e.preventDefault(); addShapeAt('note', placePoint()); return; }
  if (key === 'p' && !ctrl && isBoard() && !IS_VIEW) { e.preventDefault(); const k = e.shiftKey ? 'highlighter' : 'pen'; setPenTool(penTool === k ? null : k); return; }

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
    if (hoverPlayOn()) { setStatus('Hover play is on'); return; } // the cursor decides what plays
    const anyPlaying = tiles.some(isPlaying);
    tiles.forEach((t) => (anyPlaying ? pauseTile(t) : playTile(t)));
  } else if (e.key === 'Escape') {
    clearSelection();
  /* DISABLED (Mark, 2026-09-11): plain L now loops the hovered video; Linked moved to Shift+L
  } else if (key === 'l' && isBoard()) {
    setLinked(!board.linked);
    setStatus(board.linked ? 'Linked: neighbours move out of the way' : 'Unlinked: videos may overlap');
  */
  /* (before 2026-11-19: Linked was saved in each session)
  } else if (key === 'l' && e.shiftKey && !ctrl && isBoard()) {
    setLinked(!board.linked);
    setStatus(board.linked ? 'Linked: neighbours move out of the way' : 'Unlinked: videos may overlap');
  */
  } else if (key === 'l' && e.shiftKey && !ctrl && isBoard()) {
    setPushNeighbours(!board.linked);
  } else if (key === 'l' && !ctrl) {
    setStatus('L loops the video under the mouse' + (isBoard() ? '; Shift+L toggles Push neighbours' : ''));
  } else if (key === 'h' && isBoard()) {
    setHand(!board.hand);
  } else if (key === 'm' && !ctrl && isBoard()) { // (2026-11-15) the overview map
    setMiniMap(!miniOn);
  } else if (ctrl && key === 'a' && isBoard()) {
    e.preventDefault();
    for (const t of tiles) if (!t.locked) setSelected(t, true); // (not the locked ones, as in Miro)
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
//
// Measured over CDP on 2026-09-21 (Task 38), board mode, a Player-mode YouTube tile beside a local
// video, each interaction released over the embed:
//   (a) tile drag   -> body.tile-dragging and .tile.dragging stay set. Every OTHER tile then
//                      computes pointer-events: none (body.tile-dragging .tile), and
//                      elementFromPoint over a tile returns <main>, so nothing can be grabbed.
//   (b) corner resize -> the same through body.resizing / .tile.resizing.
//   (c) lasso and (d) pan -> recover on their own: their listeners sit on #grid with pointer
//                      capture, so the release comes back to #grid even over the embed.
//   (e) dragenter x2 + dragleave x1 -> body.dragging sticks and #drop-hint stays visible.
// (a) and (b) are Mark's "tiles cannot be moved until I switch to Gallery and back"; (e) is the
// stuck blue overlay. Both are the same shape of bug: a release the app never sees.

/* DISABLED (fable, 2026-09-21): the counter never balanced when a drag ended inside an iframe,
   which left body.dragging (and the overlay) on for good. lib/dragstate.js replaces it.
let dragDepth = 0;
*/
const dropState = DragState.create({ idleMs: 400 });
let dropTimer = null;
function applyDropState(visible) {
  document.body.classList.toggle('dragging', visible);
  if (visible && !dropTimer) {
    // while it is up, check that the drag is still really there
    dropTimer = setInterval(() => applyDropState(dropState.tick(performance.now())), 200);
  } else if (!visible && dropTimer) {
    clearInterval(dropTimer); dropTimer = null;
  }
}
// drags that start in the Sources sidebar don't get the big "Release to add" overlay
const isSidebarDrag = (e) => e.dataTransfer && ([...e.dataTransfer.types].includes('application/x-ozy-items') || [...e.dataTransfer.types].includes('application/x-ozy-fav')); // (a favorite's name being filed)
// a dragleave only counts when the pointer really left the window: between elements it fires
// constantly, and Chromium reports relatedTarget null when it leaves for good
const leftTheWindow = (e) => e.relatedTarget === null
  || e.clientX <= 0 || e.clientY <= 0
  || e.clientX >= document.documentElement.clientWidth || e.clientY >= document.documentElement.clientHeight;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (isSidebarDrag(e)) return; applyDropState(dropState.enter(performance.now())); });
window.addEventListener('dragover', (e) => { e.preventDefault(); if (isSidebarDrag(e)) return; applyDropState(dropState.over(performance.now())); });
window.addEventListener('dragleave', (e) => { if (isSidebarDrag(e)) return; if (leftTheWindow(e)) applyDropState(dropState.leave()); });
// every way a drag can end that still reaches us
for (const ev of ['dragend', 'pointerup', 'mouseup', 'blur']) window.addEventListener(ev, () => applyDropState(dropState.end()));
document.addEventListener('visibilitychange', () => { if (document.hidden) applyDropState(dropState.end()); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (IS_VIEW) return; // nothing is added from a view
  applyDropState(dropState.drop());
  if (isFavDrag(e)) return; // a favorite's name let go outside its list: nothing to add
  // a link dragged from a browser (2026-11-16): onto a bookmark block it joins it; elsewhere on the board, a new block
  if (isBoard() && !(e.dataTransfer.files && e.dataTransfer.files.length) && !e.dataTransfer.getData('application/x-ozy-items')) {
    const urls = linksInTransfer(e.dataTransfer);
    if (urls.length) { const lt = linksTileAt(e.clientX, e.clientY); if (lt) addLinks(lt, urls); else addLinksBlock(toCanvas(e.clientX, e.clientY), urls); return; }
  }
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
// setLinked(true); // (before 2026-11-19)
setLinked(false); // until the settings are in (applySettingsToUi)
setHand(false);
setMasterVolume(DEFAULT_MASTER_VOLUME);

// ---------- extra views ----------
// Window ▾ opens up to two more windows on this board (main.js). The main window is the
// authority: while a view is open it sends a snapshot (collectSession() plus each tile's stable
// id) whenever the board changes, and each view applies it by diff (lib/snapshot.js). A view
// pans, zooms, selects and plays on its own; it never changes the layout.
const viewsOpen = new Set();          // main: the views that asked for snapshots
const viewStates = new Map();         // main: n -> what each open view last reported (window and camera)
const viewHints = new Map();          // main: n -> the camera a reopened view should take up
let viewHintPending = null;           // view: a camera the main window asked for, before the tiles were in
let lastViewState = '';               // view: what it last told the main window about itself
function viewsForSession() {
  if (IS_VIEW) return [];
  return [...viewStates.values()].filter((v) => viewsOpen.has(v.n)).map((v) => ({ n: v.n, bounds: v.bounds, panX: v.panX, panY: v.panY, zoom: v.zoom }));
}
// opening a session reopens its views where they were, each with its own camera
function reopenViews(raw) {
  if (IS_VIEW) return;
  for (const v of Session.views(raw)) {
    if (v.zoom !== null && v.panX !== null && v.panY !== null) viewHints.set(v.n, { panX: v.panX, panY: v.panY, zoom: v.zoom });
    window.api.openView(v.n, v.bounds);
    sendViewHint(v.n); // a view that was already open takes it now; a new one when it asks for the board
  }
}
function sendViewHint(n) {
  const h = viewHints.get(n);
  if (h) window.api.bus({ type: 'view-hint', n, ...h });
}
function applyViewHint(h) {
  if (!tiles.length) { viewHintPending = h; return; } // after the first snapshot
  board.panX = h.panX; board.panY = h.panY; board.zoom = h.zoom; board.initialized = true;
  viewFitted = true;
  applyBoardView();
  scheduleOffscreen();
}
let snapSeq = 0, lastSnapKey = '';    // main: sequence number, and what the last snapshot said
let lastSeq = 0, lastGroups = [];     // view: the last snapshot applied, and its groups
let viewFitted = false;               // view: framed the board once, after the first tiles came in
// what a snapshot says about the board, minus what moves on its own (time, play state, speed, sound)
// const SNAP_SKIP = new Set(['currentTime', 'paused', 'playbackRate', 'volume', 'muted', 'savedAt']);
// (sound is board state since 2026-10-20: a volume or mute change in main reaches the views)
const SNAP_SKIP = new Set(['currentTime', 'paused', 'playbackRate', 'savedAt']);
function snapshotNow(force) {
  if (IS_VIEW || !viewsOpen.size) return;
  refreshLiveSet(); // the views know a new tile is heard here before they build it
  const s = collectSession();
  const body = { videos: s.videos, groups: s.groups, favFolders: s.favFolders, layout: { mode: layout.mode, quality: layout.quality, timeDisplay: layout.timeDisplay, background: layout.background }, name: sessionPath ? basename(sessionPath) : '' };
  const key = JSON.stringify(body, (k, v) => (SNAP_SKIP.has(k) ? undefined : v));
  if (!force && key === lastSnapKey) return;
  lastSnapKey = key;
  window.api.bus({ type: 'snapshot', seq: ++snapSeq, ...body });
}
// Five times a second while a view is open: cheaper and surer than hooking every place that can
// change the board (a drag, a tidy, an undo, a paste, a metadata-corrected aspect, a text edit).
if (!IS_VIEW) setInterval(() => { if (viewsOpen.size) snapshotNow(false); }, 200); // even minimised: the views may be on show

function applySnapshot(msg) {
  if (!Snapshot.accept(lastSeq, msg.seq)) return; // older than one already applied
  lastSeq = msg.seq;
  viewSessionName = msg.name || '';
  const wasEmpty = tiles.length === 0;
  snapshotApplying = true;
  try {
    const lay = msg.layout || {};
    if (lay.mode && lay.mode !== layout.mode) setMode(lay.mode);
    if (lay.background && lay.background !== layout.background) setBoardBackground(lay.background);
    if (lay.timeDisplay && lay.timeDisplay !== layout.timeDisplay) { layout.timeDisplay = lay.timeDisplay; for (const t of tiles) if (t.refreshTime) t.refreshTime(); }
    if (lay.quality && lay.quality !== layout.quality) { layout.quality = lay.quality; syncQualityRadios(); for (const t of tiles) if (t.applyQuality) t.applyQuality(); }
    applyGroupSound(msg);
    const current = tiles.map((t) => ({ id: t.id, board: t.board ? { ...t.board } : null, galleryH: t.galleryH, sig: t.snapSig }));
    const d = Snapshot.diff(current, msg, lastGroups);
    for (const id of [...d.remove, ...d.rebuild.map((r) => r.id)]) { const t = tileById(id); if (t) removeTile(t, { record: false }); }
    for (const rec of [...d.rebuild, ...d.add]) {
      const t = buildFromRecord(rec); // built as the main window has it: at its time, playing or not
      if (t) t.snapSig = Snapshot.sig(rec);
    }
    for (const m of d.move) {
      const t = tileById(m.id);
      if (!t) continue;
      t.board = m.board ? { ...m.board } : t.board;
      if (m.galleryH > 0) t.galleryH = m.galleryH;
      layoutTile(t);
    }
    // a removed or rebuilt member took its group apart here: put the groups back as main has them
    const regroup = d.regroup || (d.remove.length || d.rebuild.length ? Snapshot.groupsOf(msg) : null);
    if (regroup) {
      for (const g of [...groups]) dissolveGroup(g);
      for (const g of regroup) { const list = g.members.map(tileById).filter(Boolean); if (list.length > 1) createGroup(list, g.opts); }
      lastGroups = regroup;
    }
    // a synced member's offset and sync points as main has them (regrouping here captured its own,
    // from this window's times), so what is scrubbed here moves the others where main will (2026-11-18)
    for (const rec of msg.videos || []) {
      const t = rec && tileById(rec.id);
      if (t && t.group && t.group.sync && rec.sync) t.sync = { start: Session.syncStart(rec), points: Groups.cleanPoints(Session.syncPoints(rec)) };
    }
    // each tile's place in the stack, as main has it
    for (const rec of msg.videos || []) {
      const t = rec && tileById(rec.id);
      const z = rec && rec.z != null ? Number(rec.z) : null;
      if (t && t.z !== z) { t.z = z; layoutTile(t); }
    }
    // which tiles main has starred (the star itself is not in the rebuild signature: no reload for it)
    favFolders = Favorites.folders(msg.favFolders);
    for (const rec of msg.videos || []) {
      const t = rec && tileById(rec.id);
      if (t) { t.favorite = Favorites.fromRecord(rec); t.favFolder = t.favorite ? Favorites.folderOf(rec, favFolders) : null; paintFavorite(t); } // ring and its folder's colour
    }
    // each tile's volume and mute as main has them (not one this view changed a moment ago and
    // main has not heard about yet)
    for (const rec of msg.videos || []) {
      const t = rec && tileById(rec.id);
      if (!t || !(t.video || t.yt) || touchedHere(t)) continue;
      if (Number.isFinite(rec.volume) && Math.abs(rec.volume - t.volume) > 1e-6 && t.setVolume) t.setVolume(rec.volume * 100);
      if (!!rec.muted !== !!t.ownMuted) setOwnMuted(t, !!rec.muted);
    }
    // the board's stacking order is the main window's
    const order = new Map(((msg.videos) || []).map((r, i) => [r && r.id, i]));
    tiles.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  } finally { snapshotApplying = false; }
  layoutTiles(); markOnBoard(); renderTimeline(); updateChrome();
  if (tiles.length && viewHintPending) { const h = viewHintPending; viewHintPending = null; applyViewHint(h); }
  else if (tiles.length && (wasEmpty || !viewFitted)) { viewFitted = true; fitAll(); }
  scheduleOffscreen(); // the live budget for what is now on screen here
}

const touchedHere = (t) => !!t.localActAt && performance.now() - t.localActAt < 1500;
// A group's volume or mute changed in main: set it here as it is, rather than letting the snapshot
// take the group apart and build it again for a slider's every step.
function applyGroupSound(msg) {
  const incoming = Snapshot.groupsOf(msg);
  incoming.forEach((ng, i) => {
    const og = lastGroups[i];
    if (!og || JSON.stringify(og.members) !== JSON.stringify(ng.members)) return;
    const first = tileById(ng.members[0]), g = first && first.group;
    if (!g || g.members.size !== ng.members.length) return;
    // (changed here a moment ago: this view's value stands until main has heard of it)
    if (!touchedHere(first)) {
      if (Number.isFinite(ng.opts.volume)) g.volume = clamp(ng.opts.volume, 0, 1);
      if ('muted' in ng.opts) g.muted = !!ng.opts.muted;
      applyGroupAudio(g);
    }
    if ('volume' in og.opts && 'volume' in ng.opts) og.opts.volume = ng.opts.volume;
    if ('muted' in og.opts && 'muted' in ng.opts) og.opts.muted = ng.opts.muted;
  });
}

if (window.api.onBus) window.api.onBus((msg) => {
  if (!msg || typeof msg !== 'object') return;
  // which tiles another window decodes (and, from main, the master volume): who is heard may move
  if (msg.type === 'live' && Number.isInteger(msg.n) && msg.n !== window.OZY_VIEW) {
    const newcomer = !liveSets.has(msg.n);
    liveSets.set(msg.n, new Set(msg.ids || []));
    // a window not heard from before (just opened, or after main-hello) learns this one's set too:
    // two views showing a tile main does not must know of each other, or both would be heard
    if (newcomer && liveSets.has(window.OZY_VIEW)) announceLive([...liveSets.get(window.OZY_VIEW)]);
    if (IS_VIEW && Number.isFinite(msg.master)) setMasterVolume(msg.master); // (applies every tile's volume)
    else applyAudioOwners();
    return;
  }
  if (msg.type === 'live-gone' && Number.isInteger(msg.n)) { liveSets.delete(msg.n); applyAudioOwners(); return; } // a view closed
  // (a view that asks learns first which tiles main is heard for, then what is on the board)
  if (msg.type === 'snapshot-request' && !IS_VIEW) { if (msg.n) viewsOpen.add(msg.n); announceLive([...(liveSets.get(0) || [])]); snapshotNow(true); if (msg.n) sendViewHint(msg.n); return; }
  // if (msg.type === 'view-closed' && !IS_VIEW) { viewsOpen.delete(msg.n); viewStates.delete(msg.n); viewHints.delete(msg.n); return; }
  // a closed view is heard for nothing: main takes back what it shows, and tells the other view too
  if (msg.type === 'view-closed' && !IS_VIEW) {
    viewsOpen.delete(msg.n); viewStates.delete(msg.n); viewHints.delete(msg.n);
    liveSets.delete(msg.n); applyAudioOwners();
    if (window.api.bus) window.api.bus({ type: 'live-gone', n: msg.n });
    return;
  }
  if (msg.type === 'view-state' && !IS_VIEW) { viewStates.set(msg.n, msg); viewHints.delete(msg.n); return; } // it has its own camera now
  if (msg.type === 'view-hint' && IS_VIEW && msg.n === window.OZY_VIEW) { applyViewHint(msg); return; }
  if (msg.type === 'snapshot' && IS_VIEW) { quietly(() => applySnapshot(msg)); return; } // building tiles here is not playback to send
  // the main window (re)started: its snapshot numbers start again, so ask afresh
  // and tell it again where this view is, and which tiles it decodes (the old main's sets go)
  if (msg.type === 'main-hello' && IS_VIEW) { lastSeq = 0; lastViewState = ''; liveSets.clear(); lastLiveKey = ''; applyAudioOwners(); window.api.bus({ type: 'snapshot-request', n: window.OZY_VIEW }); return; }
  if (msg.type === 'settings' && msg.viewLiveCap) {
    settings.viewLiveCap = msg.viewLiveCap; optLiveCap.value = String(settings.viewLiveCap); applyLiveBudget(); return;
  }
  if (msg.type === 'settings-changed') {
    // another window saved: take the file's settings so this window never writes back a stale copy
    window.api.getSettings().then((s) => { if (!s) return; settings = s; applySettingsToUi(); applyLiveBudget(); });
  }
});

// (the old Window menu, before 2026-11-17)
// // Window ▾ (main window only)
// const winMenu = document.getElementById('window-menu');
// if (winMenu) {
//   const winList = winMenu.querySelector('.menu-list');
//   document.getElementById('btn-window').addEventListener('click', (e) => { e.stopPropagation(); winList.hidden = !winList.hidden; });
//   window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !winMenu.contains(e.target)) winList.hidden = true; });
//   for (const n of [1, 2]) {
//     document.getElementById(`win-view-${n}`).addEventListener('click', () => {
//       winList.hidden = true;
//       window.api.openView(n);
//       setStatus(`View ${n}: another camera on this board (pan, zoom and play there; edit here)`);
//     });
//   }
// }

// Window ▾ (main window only): the extra windows, each open or not, and how they load videos.
// The controls here are a second face of the Optimize ones (same settings, same handlers).
const winMenu = document.getElementById('window-menu');
const winList = winMenu ? winMenu.querySelector('.menu-list') : null;
const winLiveCap = document.getElementById('win-livecap');
const winOffscreen = document.getElementById('win-offscreen');
const winQuality = document.getElementById('win-quality');
function refreshWindowMenu() {
  if (!winList || IS_VIEW) return;
  winLiveCap.value = String(settings ? settings.viewLiveCap : 12);
  winOffscreen.checked = !!(settings && settings.pauseOffscreen);
  winQuality.value = layout.quality || 'full';
  for (const row of winList.querySelectorAll('.wm-view')) {
    const n = Number(row.dataset.n), open = viewsOpen.has(n), live = liveSets.get(n);
    row.classList.toggle('open', open);
    row.querySelector('.wm-state').textContent = open ? `open${live ? ` · ${live.size} playing live` : ''}` : 'closed';
    const b = row.querySelector('.wm-open');
    b.textContent = open ? 'Bring to front' : `Open view ${n}`;
    b.title = open ? `View ${n} is open: bring its window to the front` : `Open view ${n}: another window on this board`;
  }
}
if (winList && !IS_VIEW) {
  document.getElementById('btn-window').addEventListener('click', (e) => { e.stopPropagation(); refreshWindowMenu(); winList.hidden = !winList.hidden; });
  window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !winMenu.contains(e.target)) winList.hidden = true; });
  setInterval(() => { if (!winList.hidden) refreshWindowMenu(); }, 1000); // a view opening or closing
  for (const n of [1, 2]) {
    document.getElementById(`win-view-${n}`).addEventListener('click', () => {
      const was = viewsOpen.has(n);
      window.api.openView(n);
      setStatus(was ? `View ${n} brought to the front` : `View ${n}: another camera on this board. Its settings are on its View settings button (top left), and here under ⧉`);
      setTimeout(refreshWindowMenu, 800);
    });
  }
  winLiveCap.addEventListener('keydown', (e) => e.stopPropagation()); // digits are not shortcuts here
  winLiveCap.addEventListener('change', () => { optLiveCap.value = winLiveCap.value; optLiveCap.dispatchEvent(new Event('change')); winLiveCap.value = optLiveCap.value; });
  winOffscreen.addEventListener('change', () => setPauseOffscreen(winOffscreen.checked));
  winQuality.addEventListener('change', () => setSceneQuality(winQuality.value));
}
// The Optimize menu says what this window is doing with its videos right now (in a view it is the
// View settings panel, with a word on how a view works and where its quality comes from).
const optLiveLine = document.getElementById('opt-live-line');
function refreshOptLive() {
  if (!optLiveLine || optList.hidden) return;
  const budgeted = tiles.filter((t) => t.release);
  const live = budgeted.filter((t) => t.live).length, stills = budgeted.length - live;
  const web = tiles.filter((t) => t.pb && !t.release && (t.yt || t.type === 'youtube' || t.type === 'twitch')).length;
  const cap = liveCapHere();
  const parts = [`<b>${live}</b> local video${live === 1 ? '' : 's'} playing live`];
  if (stills) parts.push(`<b>${stills}</b> shown as a still`);
  if (web) parts.push(`${web} YouTube / Twitch`);
  optLiveLine.innerHTML = `${IS_VIEW ? 'In this view now' : 'In this window now'}: ${parts.join(' · ')}`
    + (Number.isFinite(cap) ? ` <span style="opacity:.7">(limit ${cap})</span>` : '');
  const q = document.querySelector('#opt-list .ov-quality');
  if (q) q.textContent = layout.quality === 'half' ? '½ resolution' : layout.quality === 'quarter' ? '¼ resolution' : 'Full';
}
document.getElementById('btn-optimize').addEventListener('click', () => setTimeout(refreshOptLive, 0));
setInterval(refreshOptLive, 1000);
// A view's first few openings point at its settings, which a new window otherwise hides well.
if (IS_VIEW) {
  let seen = 0;
  try { seen = Number(localStorage.getItem('ozy-view-callout')) || 0; } catch { seen = 3; }
  if (seen < 3) {
    try { localStorage.setItem('ozy-view-callout', String(seen + 1)); } catch {}
    const c = document.createElement('div');
    c.className = 'view-callout';
    c.innerHTML = `<b>View ${window.OZY_VIEW} settings are here</b>: how many videos play live in this window, pausing what is off screen, and the load viewer.<small>Click to close</small>`;
    const close = () => c.remove();
    c.addEventListener('click', close);
    document.getElementById('btn-optimize').addEventListener('click', close, { once: true });
    setTimeout(close, 12000);
    document.body.appendChild(c);
  }
}

// In a view only the keys that look and play do anything: no adding, removing, grouping, undo,
// opening or saving, no tile settings. (Caught before every other handler.)
if (IS_VIEW) {
  // const VIEW_KEYS = new Set([' ', 'arrowleft', 'arrowright', 'k', ',', '.', '[', ']', 'escape', 'h', 'f', 't', 'tab', 'shift', 'control', 'alt', 'meta']);
  const VIEW_KEYS = new Set([' ', 'arrowleft', 'arrowright', 'k', ',', '.', '[', ']', 'escape', 'h', 'f', 't', 'm', 'tab', 'shift', 'control', 'alt', 'meta']); // M mutes (shared, since 2026-10-20)
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // the controls a view keeps
    const key = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (ctrl ? key === 'c' || key === 'a' : VIEW_KEYS.has(key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  window.api.bus({ type: 'snapshot-request', n: window.OZY_VIEW });
  // tell the main window where this view is and where its camera points, when that changes, so a
  // saved session can bring it back
  const reportViewState = async () => {
    const bounds = await window.api.viewBounds();
    const st = { type: 'view-state', n: window.OZY_VIEW, bounds: bounds ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } : null, panX: board.panX, panY: board.panY, zoom: board.zoom };
    const key = JSON.stringify(st);
    if (key !== lastViewState && tiles.length) { lastViewState = key; window.api.bus(st); }
  };
  setInterval(reportViewState, 1000);
} else if (window.api.bus) window.api.bus({ type: 'main-hello' }); // views left open from before ask again

// Apply another window's playback ops to this window's copies, quietly. A pause lands on the exact
// time it was made at; a play only seeks when this copy is clearly off.
function applyPlayback(msg) {
  quietly(() => {
    for (const o of msg.ops || []) {
      const t = tileById(o.id);
      if (!t || !t.pb) continue;
      const p = t.pb;
      if (o.op === 'play') { if (Snapshot.clockFix(p.time, o.time, 0.25) !== null) p.time = o.time; p.play(); }
      else if (o.op === 'pause') { p.pause(); if (Number.isFinite(o.time)) p.time = o.time; }
      else if (o.op === 'seek') { if (Number.isFinite(o.value)) p.time = o.value; }
      else if (o.op === 'scrub') { if (Number.isFinite(o.value)) pbScrub(p, o.value); }
      else if (o.op === 'mute') setOwnMuted(t, !!o.value);
      else if (o.op === 'volume') { if (Number.isFinite(o.value) && t.setVolume) t.setVolume(o.value * 100); }
      else if (o.op === 'group-audio') {
        if (t.group && o.value) { if (Number.isFinite(o.value.volume)) t.group.volume = clamp(o.value.volume, 0, 1); t.group.muted = !!o.value.muted; applyGroupAudio(t.group); }
      }
      else if (o.op === 'rate' && Number(o.value) > 0) {
        p.rate = Number(o.value);
        const sel = t.el.querySelector('select.rate, .rate select, select[class*="rate"]');
        if (sel) sel.value = String(o.value);
      }
      if (t.tick) t.tick();
      if (t.refreshTime) t.refreshTime();
      if (t.onShadow && !t.live) t.onShadow();
    }
  });
  if (active) renderGroupBar();
}
// Once a second the main window says where every tile is and which are playing (a tile it only
// paused because it is off screen counts as playing). A view puts right anything clearly off,
// except a tile it acted on itself a moment ago or one it has paused off screen on its own.
const boardPlaying = (t) => !!t.pb && (!t.pb.paused || !!t.autoPaused);
if (!IS_VIEW) setInterval(() => {
  if (!viewsOpen.size) return;
  const times = {}, playing = [];
  for (const t of tiles) if (t.pb && t.id) { times[t.id] = t.pb.time; if (boardPlaying(t)) playing.push(t.id); }
  window.api.bus({ type: 'clock', times, playing });
}, 1000);
function applyClock(msg) {
  const on = new Set(msg.playing || []), now = performance.now();
  quietly(() => {
    for (const t of tiles) {
      if (!t.pb || !t.id || !(t.id in (msg.times || {})) || t.scrubbing || t.autoPaused) continue;
      const since = t.localActAt ? now - t.localActAt : Infinity;
      const act = Snapshot.clockPlay(t.pb.paused, on.has(t.id), since);
      if (act) t.pb[act]();
      if (since < Snapshot.CLOCK_GRACE_MS || (t.pb.settling)) continue;
      const fix = Snapshot.clockFix(t.pb.time, msg.times[t.id], 0.25);
      if (fix !== null) t.pb.time = fix;
    }
  });
}
if (window.api.onBus) window.api.onBus((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'playback') applyPlayback(msg);
  else if (msg.type === 'clock' && IS_VIEW) applyClock(msg);
});
