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
//           one height (layout.rowHeight). Width follows each video's aspect.
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
const layout = { mode: 'gallery', rowHeight: 240, timeDisplay: 'clock', timelineExpanded: false };
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

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, isFinite(v) ? v : lo)); }

function setStatus(msg, ms = 4000) {
  statusEl.textContent = msg;
  clearTimeout(statusTimer);
  if (ms > 0) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, ms);
}

function updateChrome() {
  emptyEl.classList.toggle('hidden', tiles.length > 0);
  countEl.textContent = tiles.length ? `${tiles.length} video${tiles.length === 1 ? '' : 's'}` : '';
  const name = sessionPath ? basename(sessionPath) : 'Unsaved session';
  document.title = `${name} – Ozy Multi Media Player`;
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
}
// Play state across local <video> tiles and YouTube tiles (Twitch has no API: skipped).
function playTile(t) { if (t.video) t.video.play().catch(() => {}); else if (t.yt) t.yt.play(); }
function pauseTile(t) { if (t.video) t.video.pause(); else if (t.yt) t.yt.pause(); }
function isPlaying(t) { return t.video ? !t.video.paused : !!(t.yt && !t.yt.paused); }

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

function updateZoomUI() {
  if (isBoard()) {
    zoomEl.min = '0'; zoomEl.max = '1000';
    zoomEl.value = String(Math.round(zoomToSlider(board.zoom)));
    zoomLabel.textContent = Math.round(board.zoom * 100) + '%';
  } else {
    zoomEl.min = String(MIN_H); zoomEl.max = String(MAX_H);
    zoomEl.value = String(layout.rowHeight);
    zoomLabel.textContent = layout.rowHeight + 'px';
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
    let h = layout.rowHeight;
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

function setRowHeight(h) {
  layout.rowHeight = clamp(Math.round(h), MIN_H, MAX_H);
  layoutTiles();
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
function memberModel(g) {
  return [...g.members].filter((t) => t.video).map((t) => ({ tile: t, start: t.sync ? t.sync.start : 0, duration: t.video.duration || 0 }));
}
function captureStarts(g) {
  const ms = [...g.members].filter((t) => t.video);
  const starts = Groups.starts(ms.map((t) => t.video.currentTime || 0));
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
  setOwnMuted(t, t.ownMuted); applyTileVolume(t);
}
function removeFromGroup(g, t) {
  g.members.delete(t); releaseTile(t);
  if (g.members.size < 2) dissolveGroup(g);
  else if (active === g) renderGroupBar();
}
function dissolveGroup(g) {
  for (const t of [...g.members]) releaseTile(t);
  g.members.clear();
  const i = groups.indexOf(g); if (i >= 0) groups.splice(i, 1);
  if (active === g) setActiveGroup(null);
}
function applyGroupAudio(g) {
  for (const t of g.members) {
    setOwnMuted(t, t.ownMuted); // web tiles join groups for mute / volume (YouTube only) and Sticky
    applyTileVolume(t);
    if (t.video) {
      t.video.playbackRate = g.rate;
      t.el.querySelector('.rate').value = String(g.rate);
    }
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
  gbQ('.gb-note').textContent = g.loop !== 'off' ? 'Loop needs Sync, so Sync is on' : '';
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
function groupTimeOf(g) {
  const ms = memberModel(g);
  if (!ms.length) return 0;
  const inside = (m) => m.tile.video.currentTime > 0 && m.tile.video.currentTime < m.duration;
  const lead = ms.find((m) => !m.tile.video.paused) || ms.find(inside);
  if (lead) return Groups.groupTime(lead.tile.video.currentTime, lead.start);
  const waiting = ms.filter((m) => m.tile.video.currentTime <= 0);
  return waiting.length ? Math.min(...waiting.map((m) => m.start)) : Groups.end(ms);
}
function seekGroup(g, gt) {
  syncing = true;
  try { for (const m of memberModel(g)) m.tile.video.currentTime = Groups.memberTime(gt, m.start, m.duration); }
  finally { syncing = false; }
}
function playPauseGroup(g) {
  const ms = memberModel(g);
  const web = [...g.members].filter((t) => !t.video && t.yt); // YouTube members play/pause with the group, never synced
  const anyPlaying = ms.some((m) => !m.tile.video.paused) || web.some(isPlaying);
  if (anyPlaying) { for (const m of ms) m.tile.video.pause(); for (const t of web) pauseTile(t); renderGroupBar(); return; }
  for (const t of web) playTile(t);
  if (g.sync) {
    const end = Groups.end(ms);
    if (groupTimeOf(g) >= end - 0.05) seekGroup(g, g.loop === 'range' && g.range ? g.range.in : 0); // Loop Off: play after the end restarts
    const gt = groupTimeOf(g);
    for (const m of ms) if (gt >= m.start && gt < m.start + m.duration) m.tile.video.play().catch(() => {});
  } else for (const m of ms) m.tile.video.play().catch(() => {});
  renderGroupBar();
}
function toggleGroupFromSelection() {
  const sel = [...selection]; // web tiles may join for Sticky / mute / volume; Sync and the timeline skip them
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
    const gt = Groups.groupTime(leader.video.currentTime, leader.sync.start);
    for (const m of memberModel(g)) {
      if (m.tile === leader) continue;
      const v = m.tile.video;
      if (action === 'play') { if (gt >= m.start && gt < m.start + m.duration) v.play().catch(() => {}); }
      else if (action === 'pause') v.pause();
      else if (action === 'seek') v.currentTime = Groups.memberTime(gt, m.start, m.duration);
    }
  } finally { syncing = false; }
}

// Runs 10x a second: drift correction, waiting members, held members, loops.
setInterval(() => {
  for (const g of groups) {
    if (!g.sync) continue;
    const ms = memberModel(g);
    const lead = ms.find((m) => !m.tile.video.paused);
    if (!lead) continue;
    const gt = Groups.groupTime(lead.tile.video.currentTime, lead.start);
    const loopEnd = Groups.loopEnd(g.loop, ms.filter((m) => m.duration > 0), g.range); // ignore members still loading
    if (loopEnd !== null && gt >= loopEnd - 0.05) {
      const to = g.loop === 'range' && g.range ? g.range.in : 0;
      seekGroup(g, to);
      for (const m of ms) if (Groups.memberTime(to, m.start, m.duration) < m.duration && to >= m.start) m.tile.video.play().catch(() => {});
      continue;
    }
    syncing = true;
    try {
      for (const m of ms) {
        if (m === lead) continue;
        const v = m.tile.video;
        const want = Groups.memberTime(gt, m.start, m.duration);
        const inside = gt >= m.start && gt < m.start + m.duration;
        if (inside && v.paused) v.play().catch(() => {});   // its start was reached
        if (!inside && !v.paused) v.pause();                 // waiting at 0 or holding at the end
        if (Math.abs(v.currentTime - want) > Groups.DRIFT) v.currentTime = want;
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

// What the timeline shows: the active group, else a single selected tile as a one-member "group".
function timelineModel() {
  if (active) return { title: active.name, members: memberModel(active), group: active, fps: [...active.members][0].fps };
  const sel = [...selection].filter((t) => t.video);
  if (sel.length === 1) return { title: basename(sel[0].path), members: [{ tile: sel[0], start: 0, duration: sel[0].video.duration || 0 }], group: null, fps: sel[0].fps };
  return null;
}
function tlTime(model) { return model.group ? groupTimeOf(model.group) : model.members[0].tile.video.currentTime; }
function tlSeek(model, gt) {
  if (model.group && model.group.sync) seekGroup(model.group, gt);
  else for (const m of model.members) m.tile.video.currentTime = Groups.memberTime(gt, m.start, m.duration);
}

function renderTimeline() {
  const model = timelineModel();
  tl.hidden = !model;
  tl._model = model;
  if (!model) return;
  tl.classList.toggle('expanded', layout.timelineExpanded);
  tlQ('.tl-grip').textContent = layout.timelineExpanded ? '▾' : '▴';
  tlQ('.tl-title').textContent = model.title;
  for (const s of ['.tl-set-in', '.tl-set-out', '.tl-clear-range']) tlQ(s).hidden = !model.group;
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
      block.textContent = basename(m.tile.path);
      const tcL = document.createElement('span'); tcL.className = 'tl-tc'; tcL.textContent = Frames.format(lane.start, 0, m.tile.fps, layout.timeDisplay).split(' / ')[0];
      const tcR = document.createElement('span'); tcR.className = 'tl-tc right'; tcR.textContent = Frames.format(lane.end, 0, m.tile.fps, layout.timeDisplay).split(' / ')[0];
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
    const mk = document.createElement('div'); mk.className = 'tl-mk'; mk.style.background = MARKER_COLORS[b.color];
    mk.style.left = Timeline.xFor(m.start + b.t, end, width) + 'px';
    mk.title = `${basename(m.tile.path)}: ${b.label || fmtTime(b.t)}  (right-click to delete, Shift-right-click to recolour)`;
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
  tlQ('.tl-time').textContent = Frames.format(gt, end, model.fps, layout.timeDisplay);
}
function toggleTimelineExpanded() { layout.timelineExpanded = !layout.timelineExpanded; renderTimeline(); }
function setRangeAtPlayhead(which) {
  const g = tl._model && tl._model.group; if (!g) return;
  g.range = Timeline.clampRange({ ...(g.range || { in: 0, out: tl._end }), [which]: tlTime(tl._model) }, tl._end);
  if (g.loop !== 'range') { g.loop = 'range'; if (!g.sync) setGroupSync(g, true); }
  renderTimeline(); renderGroupBar();
}

tlQ('.tl-grip').addEventListener('click', toggleTimelineExpanded);
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
  cmp.temp = createGroup([a, b], { name: 'A/B', sync: true, sticky: false, rate: a.video.playbackRate });
  cmpQ('.cmp-a').appendChild(a.video); cmpQ('.cmp-b').appendChild(b.video);
  cmpQ('.cmp-label-a').textContent = 'A: ' + basename(a.path);
  cmpQ('.cmp-label-b').textContent = 'B: ' + basename(b.path);
  cmp.el.hidden = false;
  cmp.tick = () => {
    const v = a.video;
    cmpQ('.cmp-play').textContent = v.paused ? '▶' : '❚❚';
    cmpQ('.cmp-time').textContent = Frames.format(v.currentTime, v.duration, a.fps, layout.timeDisplay);
    if (v.duration && !cmp.scrubbing) cmpQ('.cmp-seek').value = String(Math.round(v.currentTime / v.duration * 10000));
  };
  cmp.tick();
}
function closeCompare() {
  if (!cmp.a) return;
  const { a, b } = cmp;
  dissolveGroup(cmp.temp);
  a.el.insertBefore(a.video, a.el.firstChild);
  b.el.insertBefore(b.video, b.el.firstChild);
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
  const sel = [...selection].filter((t) => t.video);
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
  const v = cmp.a.video; if (!v.duration) return;
  v.currentTime = Number(cmpSeek.value) / 10000 * v.duration;
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
//  { kind: 'rowHeight', label, before, after }
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
function recordRowHeight() { return { kind: 'rowHeight', label: 'resize gallery', before: layout.rowHeight, after: null }; }
function finishRowHeight(entry) { entry.after = layout.rowHeight; if (entry.after !== entry.before) undoStack.push(entry); }
// Ctrl+wheel, the zoom slider and +/- change the row height in many small steps: one entry per burst.
let rowEntry = null, rowTimer = null;
function noteRowHeightChange() {
  if (!rowEntry) rowEntry = recordRowHeight();
  clearTimeout(rowTimer);
  rowTimer = setTimeout(() => { finishRowHeight(rowEntry); rowEntry = null; }, 500);
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
  const t = v.type && v.type !== 'file' && typeof addWebTile === 'function' ? addWebTile(v.url, WebUrl.parse(v.url), v) : addVideo(v.path, v);
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
}
function applyEntry(entry, dir) {
  if (entry.kind === 'move' || entry.kind === 'resize') applyRects(entry, dir);
  else if (entry.kind === 'rowHeight') setRowHeight(entry[dir]);
  else if (entry.kind === 'remove') {
    if (dir === 'before') restoreRemoved(entry);
    else if (tiles.includes(entry.tile)) removeTile(entry.tile, { record: false });
  }
}
function undo() { const e = undoStack.undo(); if (!e) { setStatus('Nothing to undo'); return; } applyEntry(e, 'before'); setStatus('Undo: ' + e.label); }
function redo() { const e = undoStack.redo(); if (!e) { setStatus('Nothing to redo'); return; } applyEntry(e, 'after'); setStatus('Redo: ' + e.label); }

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
      const h = layout.rowHeight;
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
    const h = layout.rowHeight;
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

// Simulate the flex-wrap packing for a candidate row height; true if every
// tile fits in the visible area without scrolling.
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
// Gallery: every tile follows. Board: only this tile, anchored on the
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
  const undoEntry = onBoard ? recordResize(tiles.filter((t) => t.board)) : recordRowHeight();
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
      setRowHeight(clamp(h, MIN_H, MAX_H));
    }
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    tile.el.classList.remove('resizing');
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
    if (onBoard) finishRects(undoEntry); else finishRowHeight(undoEntry);
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
    const single = e.ctrlKey;
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

// wheel: board pans (Ctrl zooms at the cursor); gallery scrolls (Ctrl resizes)
grid.addEventListener('wheel', (e) => {
  if (isBoard()) {
    e.preventDefault();
    if (e.ctrlKey) {
      zoomAt(board.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    } else {
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      const dy = e.shiftKey ? 0 : e.deltaY;
      board.panX -= dx; board.panY -= dy;
      applyBoardView();
    }
  } else if (e.ctrlKey) {
    e.preventDefault();
    noteRowHeightChange();
    setRowHeight(layout.rowHeight * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }
}, { passive: false });

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
  const bmAddBtn = el.querySelector('.bm-add');
  const bmListBtn = el.querySelector('.bm-list');
  const bmCount = el.querySelector('.bm-count');
  const markersEl = el.querySelector('.markers');
  const bmPanel = el.querySelector('.bm-panel');

  const tile = {
    path: filePath, el, video, seek, time: timeEl, scrubbing: false,
    volume: DEFAULT_VIDEO_VOLUME,
    aspect: Number(state.aspect) > 0 ? Number(state.aspect) : DEFAULT_ASPECT,
    board: null,
    suppressClick: false,
    bookmarks: [],
  };
  if (Array.isArray(state.bookmarks)) {
    tile.bookmarks = state.bookmarks
      .filter((b) => b && isFinite(Number(b.t)) && Number(b.t) >= 0)
      .map((b) => ({ t: Number(b.t), label: typeof b.label === 'string' ? b.label : '', color: MARKER_KEYS.includes(b.color) ? b.color : 'yellow' }))
      .sort((a, b) => a.t - b.t);
  }
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) {
    tile.board = { x: Number(sb.x), y: Number(sb.y), w: Number(sb.w), h: Number(sb.h) };
  }
  tiles.push(tile);
  tile.info = null; tile.proxy = null; tile.fps = null;
  tile.group = null; tile.sync = null; tile.ownMuted = !!state.muted;

  nameEl.textContent = basename(filePath);
  nameEl.title = filePath;

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
    timeEl.textContent = Frames.format(video.currentTime, video.duration, tile.fps, layout.timeDisplay);
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
    seekTo(Frames.step(video.currentTime, tile.fps || Frames.DEFAULT_FPS, dir));
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

  // ----- bookmarks -----
  const bmTitle = (b) => (b.label ? `${b.label} · ${fmtTime(b.t)}` : fmtTime(b.t));
  const renderMarkers = () => {
    markersEl.textContent = '';
    bmCount.textContent = String(tile.bookmarks.length);
    bmListBtn.classList.toggle('has-some', tile.bookmarks.length > 0);
    if (!video.duration) return;
    for (const b of tile.bookmarks) {
      const m = document.createElement('div');
      m.className = 'marker';
      m.style.left = (clamp(b.t / video.duration, 0, 1) * 100).toFixed(3) + '%';
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
    addBtn.textContent = '+ Add at ' + fmtTime(video.currentTime);
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
  const addBookmark = (t = video.currentTime) => {
    if (!isFinite(t)) return;
    // don't stack two bookmarks on the same frame
    if (tile.bookmarks.some((b) => Math.abs(b.t - t) < 0.05)) { setStatus('Bookmark already exists at ' + fmtTime(t)); return; }
    tile.bookmarks.push({ t, label: '', color: 'yellow' });
    tile.bookmarks.sort((a, b) => a.t - b.t);
    refreshBookmarks();
    setStatus(`Bookmark added at ${fmtTime(t)} – ${basename(filePath)}`);
  };
  const deleteBookmark = (b) => {
    const i = tile.bookmarks.indexOf(b);
    if (i >= 0) tile.bookmarks.splice(i, 1);
    refreshBookmarks();
  };
  const jumpBookmark = (dir) => {
    if (!tile.bookmarks.length) { setStatus('No bookmarks on this video'); return; }
    const cur = video.currentTime;
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
  backBtn.addEventListener('click', (e) => seekBy(e.shiftKey ? -30 : -5));
  fwdBtn.addEventListener('click', (e) => seekBy(e.shiftKey ? 30 : 5));
  for (const b of [bmAddBtn, bmListBtn, backBtn, fwdBtn, el.querySelector('.fstep-back'), el.querySelector('.fstep-fwd')]) b.addEventListener('dblclick', (e) => e.stopPropagation());
  bmPanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  bmPanel.addEventListener('dblclick', (e) => e.stopPropagation());
  bmPanel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  el.addEventListener('pointerenter', () => { hoveredTile = tile; });
  el.addEventListener('pointerleave', () => { if (hoveredTile === tile) hoveredTile = null; togglePanel(false); });

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
    if (!isBoard() && e.shiftKey) return; // gallery Shift-click selects (below)
    if (!tile.suppressClick) tile.togglePlay();
  });
  el.addEventListener('click', (e) => {
    if (isBoard() || !e.shiftKey || e.target.closest('button, input, select, .bm-panel')) return;
    setSelected(tile, !selection.has(tile));
    selectionStatus();
  });
  video.addEventListener('dblclick', () => {
    if (!cmp.el.hidden) return; // in the compare view the tile is empty
    if (document.fullscreenElement === el) document.exitFullscreen();
    else el.requestFullscreen().catch(() => {});
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
  const onMsg = (e) => {
    if (e.source !== iframe.contentWindow) return;
    let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (d.event === 'onReady') { st.ready = true; clearInterval(hello); post('addEventListener', ['onStateChange']); }
    if (d.event === 'infoDelivery' && d.info) {
      if (!st.ready) { st.ready = true; clearInterval(hello); }
      if ('currentTime' in d.info) st.time = d.info.currentTime;
      if ('duration' in d.info) st.duration = d.info.duration;
      if ('playerState' in d.info) st.state = d.info.playerState;
      if ('muted' in d.info) st.muted = d.info.muted;
      if ('volume' in d.info) st.volume = d.info.volume;
    }
    if (d.event === 'onStateChange') st.state = d.info;
    for (const l of listeners) l(st, d.event);
  };
  window.addEventListener('message', onMsg);
  // keep saying hello until the player answers (it ignores messages sent before it has loaded)
  const listen = () => { clearInterval(hello); let n = 0; hello = setInterval(() => { msg({ event: 'listening' }); if (++n > 40) clearInterval(hello); }, 250); };
  iframe.addEventListener('load', listen);
  return {
    st, onChange: (l) => listeners.add(l),
    play: () => post('playVideo'), pause: () => post('pauseVideo'),
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
  el.classList.add(parsed.type, parsed.kind);

  const tile = {
    path: url, url, type: parsed.type, kind: parsed.kind, el, video: null, seek, time: timeEl, scrubbing: false,
    volume: clamp(Number(state.volume ?? DEFAULT_VIDEO_VOLUME), 0, 1),
    aspect: Number(state.aspect) > 0 ? Number(state.aspect) : (parsed.kind === 'short' ? 9 / 16 : 16 / 9),
    board: null, suppressClick: false, bookmarks: [], info: null, proxy: null, fps: null,
    group: null, sync: null, ownMuted: !!state.muted,
    title: typeof state.title === 'string' && state.title ? state.title : WebUrl.label(parsed),
  };
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) tile.board = { x: Number(sb.x), y: Number(sb.y), w: Number(sb.w), h: Number(sb.h) };
  tiles.push(tile);
  nameEl.textContent = tile.title;
  nameEl.title = url;

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

  // ----- YouTube controls -----
  const wantTime = Number(state.currentTime) > 0 ? Number(state.currentTime) : 0;
  const wantPlaying = state.paused === false;
  const refreshMute = () => { muteBtn.textContent = tile.ownMuted || (tile.group && tile.group.muted) || tile.volume === 0 ? '🔇' : '🔊'; };
  tile.refreshMute = refreshMute;
  if (parsed.type === 'youtube') {
    const yt = tile.yt = ytController(iframe);
    let first = true;
    yt.onChange((st, ev) => {
      if (st.ready && !errorEl.classList.contains('hidden')) errorEl.classList.add('hidden'); // a late load clears "Could not load"
      if (first && st.ready) {
        first = false;
        clearTimeout(loadTimer);
        setOwnMuted(tile, tile.ownMuted); applyTileVolume(tile);
        if (wantTime > 0) yt.seek(wantTime);
        if (wantPlaying) yt.play();
      }
      if (ev === 'onStateChange' && tile.group && tile.group === active) renderGroupBar();
    });
    tile.togglePlay = () => { yt.paused ? yt.play() : yt.pause(); };
    tile.seekBy = (dt) => yt.seek(clamp(yt.st.time + dt, 0, yt.st.duration || Infinity));
    tile.tick = () => {
      const st = yt.st;
      playBtn.textContent = yt.paused ? '▶' : '❚❚';
      if (!tile.scrubbing) {
        timeEl.textContent = `${fmtTime(st.time)} / ${fmtTime(st.duration)}`;
        if (st.duration > 0) {
          const frac = clamp(st.time / st.duration, 0, 1);
          seek.value = String(Math.round(frac * 10000));
          seek.style.setProperty('--progress', (frac * 100).toFixed(2) + '%');
        }
      }
    };
    playBtn.addEventListener('click', () => tile.togglePlay());
    seek.addEventListener('pointerdown', () => { tile.scrubbing = true; el.classList.add('scrubbing'); });
    const endScrub = () => { tile.scrubbing = false; el.classList.remove('scrubbing'); };
    seek.addEventListener('pointerup', endScrub);
    seek.addEventListener('pointercancel', endScrub);
    seek.addEventListener('input', () => {
      if (!yt.st.duration) return;
      const t = Number(seek.value) / 10000 * yt.st.duration;
      yt.seek(t); yt.st.time = t;
      timeEl.textContent = `${fmtTime(t)} / ${fmtTime(yt.st.duration)}`;
    });
    muteBtn.addEventListener('click', () => { setOwnMuted(tile, !tile.ownMuted); refreshMute(); });
  }
  tile.setVolume = (pct) => { tile.volume = clamp(pct, 0, 100) / 100; applyTileVolume(tile); if (tile.volume > 0 && tile.ownMuted) setOwnMuted(tile, false); refreshMute(); };
  tile.destroy = () => { clearTimeout(loadTimer); if (tile.yt) tile.yt.destroy(); };
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
  canvas.appendChild(frag);
  load();
  if (isBoard() && !tile.board && at) placeOnBoard([tile], at);
  updateChrome();
  return tile;
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
  const added = paths.map((p) => addVideo(p));
  if (isBoard()) placeOnBoard(added.filter((t) => !t.board), at);
  layoutTiles();
  if (wasEmpty && tiles.length) scheduleFit();
}

let toolsWarned = false; // one status message if ffmpeg/ffprobe are missing
window.api.onProxyProgress((p, frac) => { const t = tiles.find((x) => x.path === p); if (t && t.onProxyProgress) t.onProxyProgress(frac); });

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
      rowHeight: layout.rowHeight,
      board: board.initialized ? { panX: board.panX, panY: board.panY, zoom: board.zoom } : null,
      linked: board.linked,
      timeDisplay: layout.timeDisplay,
      timelineExpanded: layout.timelineExpanded,
    },
    masterVolume,
    videos: tiles.map((t) => (!t.video ? {
      // web tile (YouTube / Twitch)
      type: t.type, kind: t.kind, url: t.url, title: t.title,
      currentTime: t.yt ? t.yt.st.time : 0, volume: t.volume, muted: !!t.ownMuted, playbackRate: 1,
      paused: t.yt ? t.yt.paused : true, aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: [], sync: null,
    } : {
      type: 'file',
      path: t.path,
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
  clearAll();
  const lay = data.layout || {};
  const wantMode = lay.mode === 'board' ? 'board' : 'gallery';
  if (Number(lay.rowHeight) > 0) layout.rowHeight = clamp(Number(lay.rowHeight), MIN_H, MAX_H);
  layout.timeDisplay = ['clock', 'frames', 'timecode'].includes(lay.timeDisplay) ? lay.timeDisplay : 'clock';
  layout.timelineExpanded = lay.timelineExpanded === true;
  const bv = lay.board;
  if (bv && isFinite(bv.panX) && isFinite(bv.panY) && bv.zoom > 0) {
    board.panX = Number(bv.panX); board.panY = Number(bv.panY);
    board.zoom = clamp(Number(bv.zoom), MIN_ZOOM, MAX_ZOOM);
    board.initialized = true;
  } else {
    board.initialized = false;
  }
  setLinked(lay.linked ?? true);
  setMode(wantMode);
  setMasterVolume(data.masterVolume ?? DEFAULT_MASTER_VOLUME);

  let missing = 0;
  const byIndex = new Map(); // index in data.videos -> tile (v3 files and bad entries leave gaps)
  for (const [i, v] of data.videos.entries()) {
    if (!v) continue;
    if (v.type === 'youtube' || v.type === 'twitch') {
      const parsed = typeof v.url === 'string' ? WebUrl.parse(v.url) : null;
      if (parsed && parsed.kind !== 'playlist') byIndex.set(i, addWebTile(v.url, parsed, v));
      continue;
    }
    if (typeof v.path !== 'string') continue;
    if (!(await window.api.fileExists(v.path))) missing++;
    byIndex.set(i, addVideo(v.path, v));
  }
  // groups (session v4); v3 files have none
  nextGroupId = 1;
  for (const sg of Array.isArray(data.groups) ? data.groups : []) {
    const idx = Array.isArray(sg.members) ? sg.members.filter((i) => byIndex.has(i)) : [];
    if (idx.length < 2) continue;
    const g = createGroup(idx.map((i) => byIndex.get(i)), { ...sg, sync: false });
    if (Number.isInteger(sg.id)) g.id = sg.id;
    if (sg.sync) {
      // restore saved starts rather than recapturing them from not-yet-loaded videos
      g.sync = true;
      for (const i of idx) { const s = data.videos[i].sync; byIndex.get(i).sync = { start: s && isFinite(s.start) ? Number(s.start) : 0 }; }
    }
    nextGroupId = Math.max(nextGroupId, g.id + 1);
  }
  clearSelection(); // createGroup made the last group active; start with nothing selected
  if (isBoard()) placeOnBoard(tiles.filter((t) => !t.board));
  layoutTiles();
  // older session files have no zoom / view saved: fit once the videos are in
  if (!(Number(lay.rowHeight) > 0) || (isBoard() && !board.initialized)) scheduleFit();
  undoStack.clear(); // a freshly opened session starts with no history
  return { loaded: data.videos.length, missing };
}

async function saveSessionAs() {
  if (!tiles.length) { setStatus('Nothing to save – add some videos first.'); return; }
  const p = await window.api.saveSessionAs(collectSession());
  if (p) { sessionPath = p; updateChrome(); setStatus(`Saved ${p}`); }
}

async function saveSession() {
  if (!sessionPath) return saveSessionAs();
  await window.api.saveSessionTo(sessionPath, collectSession());
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
document.getElementById('add-local').addEventListener('click', async () => { menuList.hidden = true; addVideos(await window.api.pickVideos()); });
document.getElementById('add-url').addEventListener('click', () => { menuList.hidden = true; urlBar.hidden = false; urlInput.focus(); });
document.getElementById('url-cancel').addEventListener('click', closeUrlBar);
function submitUrl() {
  const parsed = WebUrl.parse(urlInput.value);
  if (!parsed) { setStatus('That is not a YouTube or Twitch link I understand'); return; }
  if (parsed.kind === 'playlist') { setStatus('Playlists open in the Sources sidebar (coming in the next update)'); return; } // Task 13 replaces this line
  const t = addWebTile(urlInput.value.trim(), parsed);
  if (isBoard()) placeOnBoard([t]);
  layoutTiles();
  if (tiles.length === 1) scheduleFit();
  closeUrlBar();
}
document.getElementById('url-go').addEventListener('click', submitUrl);
urlInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') submitUrl(); if (e.key === 'Escape') closeUrlBar(); });
document.getElementById('btn-open').addEventListener('click', () => openSession());
document.getElementById('btn-save').addEventListener('click', saveSession);
document.getElementById('btn-save-as').addEventListener('click', saveSessionAs);
document.getElementById('btn-cache').addEventListener('click', async () => {
  const { bytes, files } = await window.api.cacheInfo();
  const mb = (bytes / 1048576).toFixed(0);
  if (!files) { setStatus('Cache is empty'); return; }
  if (confirm(`${files} cached files (playable copies and thumbnails) use ${mb} MB. Clear the cache?`)) { await window.api.clearCache(); setStatus('Cache cleared'); }
});
document.getElementById('btn-play-all').addEventListener('click', () => tiles.forEach(playTile));
document.getElementById('btn-pause-all').addEventListener('click', () => tiles.forEach(pauseTile));
document.getElementById('btn-mute-all').addEventListener('click', () => tiles.forEach((t) => setOwnMuted(t, true)));
document.getElementById('btn-unmute-all').addEventListener('click', () => {
  for (const g of groups) g.muted = false; // "all" includes group mutes
  tiles.forEach((t) => setOwnMuted(t, false));
  renderGroupBar();
});
document.getElementById('btn-fit').addEventListener('click', fitAll);
document.getElementById('btn-tidy').addEventListener('click', tidyBoard);
document.getElementById('btn-link').addEventListener('click', () => setLinked(!board.linked));
document.getElementById('btn-hand').addEventListener('click', () => setHand(!board.hand));

modeEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

zoomEl.addEventListener('input', () => {
  if (isBoard()) zoomAtCenter(sliderToZoom(Number(zoomEl.value)));
  else { noteRowHeightChange(); layout.rowHeight = clamp(Math.round(Number(zoomEl.value)), MIN_H, MAX_H); for (const t of tiles) layoutTile(t); zoomLabel.textContent = layout.rowHeight + 'px'; }
});

masterVol.addEventListener('input', () => setMasterVolume(Number(masterVol.value) / 100, { updateSlider: false }));
masterVol.addEventListener('wheel', (e) => {
  e.preventDefault();
  setMasterVolume(clamp(Number(masterVol.value) + (e.deltaY < 0 ? 5 : -5), 0, 100) / 100);
}, { passive: false });

// keep gallery tiles clamped to the window width as it changes
new ResizeObserver(() => { if (!isBoard()) layoutTiles(); }).observe(grid);

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  // a focused button (you just clicked one) shouldn't swallow the shortcuts
  const inControl = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

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
    // web tiles have no bookmarks or frame step, and Twitch tiles have no playback API at all
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
    if (e.key === ',' && h.stepFrame) { h.stepFrame(-1); return; }
    if (e.key === '.' && h.stepFrame) { h.stepFrame(1); return; }
  }

  if (e.code === 'Space') {
    e.preventDefault();
    const anyPlaying = tiles.some(isPlaying);
    tiles.forEach((t) => (anyPlaying ? pauseTile(t) : playTile(t)));
  } else if (e.key === 'Escape') {
    clearSelection();
  } else if (key === 'l' && isBoard()) {
    setLinked(!board.linked);
    setStatus(board.linked ? 'Linked: neighbours move out of the way' : 'Unlinked: videos may overlap');
  } else if (key === 'h' && isBoard()) {
    setHand(!board.hand);
  } else if (ctrl && key === 'a' && isBoard()) {
    e.preventDefault();
    for (const t of tiles) setSelected(t, true);
    selectionStatus();
  } else if (key === 't' && !ctrl) {
    toggleTimelineExpanded();
  } else if ((key === 'i' || key === 'o') && !ctrl && !tl.hidden) {
    setRangeAtPlayhead(key === 'i' ? 'in' : 'out');
  } else if (key === 'f') {
    fitAll();
  } else if (e.key === '=' || e.key === '+') {
    if (isBoard()) zoomAtCenter(board.zoom * 1.15); else { noteRowHeightChange(); setRowHeight(layout.rowHeight * 1.1); }
  } else if (e.key === '-' || e.key === '_') {
    if (isBoard()) zoomAtCenter(board.zoom / 1.15); else { noteRowHeightChange(); setRowHeight(layout.rowHeight / 1.1); }
  }
});

// ---------- drag & drop ----------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = Array.from(e.dataTransfer.files || []);
  const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean);
  const sessions = paths.filter((p) => p.toLowerCase().endsWith('.mvp'));
  if (sessions.length) { await openSession(sessions[0]); return; }
  // on the board, drop the new videos where the cursor is
  addVideos(paths, isBoard() && tiles.length ? toCanvas(e.clientX, e.clientY) : null);
});

// ---------- session passed on the command line ----------

window.api.onOpenSession((p) => openSession(p));

updateChrome();
setMode('gallery');
setRowHeight(240);
setLinked(true);
setHand(false);
setMasterVolume(DEFAULT_MASTER_VOLUME);
