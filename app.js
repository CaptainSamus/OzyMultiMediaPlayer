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
const layout = { mode: 'gallery', rowHeight: 240, timeDisplay: 'clock' };
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
  tile.video.volume = clamp(tile.volume * masterVolume, 0, 1);
}

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
}
function clearSelection() {
  for (const t of selection) t.el.classList.remove('selected');
  selection.clear();
}
function selectOnly(tile) { clearSelection(); setSelected(tile, true); }
function selectionStatus() {
  if (selection.size > 1) setStatus(`${selection.size} videos selected – drag any of them to move the group, Esc to deselect`, 6000);
}

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
    const start = { x: e.clientX, y: e.clientY };
    let moving = false;
    let group = [];
    const onMove = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moving) {
        if (Math.hypot(dx, dy) < 4) return;
        moving = true;
        try { el.setPointerCapture(ev.pointerId); } catch {}
        // dragging something outside the selection makes it the selection
        if (!selection.has(tile)) selectOnly(tile);
        group = [...selection];
        rememberStart();
        for (const t of group) { bringToFront(t); t.el.classList.add('dragging'); }
        document.body.classList.add('tile-dragging');
      }
      // proposed position of the group's bounding box
      const bb0 = boardBounds(group.map((t) => ({ board: startPos.get(t) })));
      let nx = bb0.minX + dx / board.zoom, ny = bb0.minY + dy / board.zoom;
      if (!ev.altKey) {
        const s = snapRect({ x: nx, y: ny, w: bb0.w, h: bb0.h }, selection);
        nx = s.x; ny = s.y;
      } else hideGuides();
      const shiftX = nx - bb0.minX, shiftY = ny - bb0.minY;
      for (const t of group) {
        const s = startPos.get(t);
        t.board.x = s.x + shiftX; t.board.y = s.y + shiftY;
        layoutTile(t);
      }
      if (board.linked && !ev.altKey) resolveOverlaps(selection);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      hideGuides();
      if (moving) {
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
    for (const t of tiles) {
      if (!t.board) continue;
      const B = t.board;
      const hit = B.x < b.x && B.x + B.w > a.x && B.y < b.y && B.y + B.h > a.y;
      setSelected(t, hit || before.has(t));
    }
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
      .map((b) => ({ t: Number(b.t), label: typeof b.label === 'string' ? b.label : '' }))
      .sort((a, b) => a.t - b.t);
  }
  const sb = state.board;
  if (sb && isFinite(sb.x) && isFinite(sb.y) && sb.w > 0 && sb.h > 0) {
    tile.board = { x: Number(sb.x), y: Number(sb.y), w: Number(sb.w), h: Number(sb.h) };
  }
  tiles.push(tile);
  tile.info = null; tile.proxy = null; tile.fps = null;

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
  };
  const seekBy = (dt) => seekTo(video.currentTime + dt);
  tile.seekBy = seekBy;
  const stepFrame = (dir) => {
    if (!video.duration) return;
    video.pause();
    seekTo(Frames.step(video.currentTime, tile.fps || Frames.DEFAULT_FPS, dir));
  };
  tile.stepFrame = stepFrame;
  el.querySelector('.fstep-back').addEventListener('click', () => stepFrame(-1));
  el.querySelector('.fstep-fwd').addEventListener('click', () => stepFrame(1));
  timeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const modes = ['clock', 'frames', 'timecode'];
    layout.timeDisplay = modes[(modes.indexOf(layout.timeDisplay) + 1) % modes.length];
    for (const t of tiles) t.tick && t.refreshTime && t.refreshTime();
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
      m.title = bmTitle(b) + '  (right-click to delete)';
      m.addEventListener('click', (e) => { e.stopPropagation(); seekTo(b.t); });
      m.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); deleteBookmark(b); });
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
      row.append(go, label, del);
      bmPanel.appendChild(row);
    }
  };
  const refreshBookmarks = () => { renderMarkers(); if (!bmPanel.classList.contains('hidden')) renderPanel(); };
  const addBookmark = (t = video.currentTime) => {
    if (!isFinite(t)) return;
    // don't stack two bookmarks on the same frame
    if (tile.bookmarks.some((b) => Math.abs(b.t - t) < 0.05)) { setStatus('Bookmark already exists at ' + fmtTime(t)); return; }
    tile.bookmarks.push({ t, label: '' });
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
    if (wantTime > 0) {
      video.currentTime = isFinite(video.duration) ? Math.min(wantTime, video.duration) : wantTime;
    }
    updateTimeLabel();
    updateSeek();
    renderMarkers();
    if (wantPlaying) video.play().catch(() => {});
  });
  video.addEventListener('timeupdate', () => { if (!tile.scrubbing) updateTimeLabel(); });
  video.addEventListener('durationchange', () => { updateTimeLabel(); renderMarkers(); });
  video.addEventListener('play', updatePlayBtn);
  video.addEventListener('pause', updatePlayBtn);
  video.addEventListener('ended', updatePlayBtn);
  video.addEventListener('volumechange', updateMuteBtn);
  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 0;
    const why = code === 3 ? 'Decoding error – corrupt file or unsupported codec.' : 'Cannot play this file.';
    showError(why, !!(tile.info && tile.info.available) && !tile.proxy);
  });

  // click on picture = play/pause; double-click = fullscreen this tile
  video.addEventListener('click', () => { if (!tile.suppressClick) togglePlay(video); });
  video.addEventListener('dblclick', () => {
    if (document.fullscreenElement === el) document.exitFullscreen();
    else el.requestFullscreen().catch(() => {});
  });

  playBtn.addEventListener('click', () => togglePlay(video));

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
  });
  seek.addEventListener('change', () => { if (!tile.scrubbing) updateSeek(); });
  seek.addEventListener('keydown', (e) => {
    // step 5 s with arrow keys instead of 1/10000 of the video
    if (!video.duration) return;
    const step = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - step); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); video.currentTime = Math.min(video.duration, video.currentTime + step); }
  });

  // volume / mute / speed
  const setTileVolume = (pct) => {
    tile.volume = clamp(pct, 0, 100) / 100;
    applyTileVolume(tile);
    if (tile.volume > 0 && video.muted) video.muted = false;
    updateMuteBtn();
    updateVolUI();
  };
  tile.setVolume = setTileVolume;
  muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
  rate.addEventListener('change', () => { video.playbackRate = Number(rate.value); });

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
        tile.board.h = layout.rowHeight; tile.board.w = layout.rowHeight * tile.aspect;
        layoutTile(tile);
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

function removeTile(tile) {
  const i = tiles.indexOf(tile);
  if (i >= 0) tiles.splice(i, 1);
  selection.delete(tile);
  try {
    tile.video.pause();
    tile.video.removeAttribute('src');
    tile.video.load();
  } catch {}
  tile.el.remove();
  updateChrome();
}

function clearAll() {
  while (tiles.length) removeTile(tiles[tiles.length - 1]);
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
    },
    masterVolume,
    videos: tiles.map((t) => ({
      path: t.path,
      currentTime: isFinite(t.video.currentTime) ? t.video.currentTime : 0,
      volume: t.volume,
      muted: t.video.muted,
      playbackRate: t.video.playbackRate,
      paused: t.video.paused,
      aspect: t.aspect,
      board: t.board ? { x: t.board.x, y: t.board.y, w: t.board.w, h: t.board.h } : null,
      bookmarks: t.bookmarks.map((b) => ({ t: b.t, label: b.label })),
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
  for (const v of data.videos) {
    if (!v || typeof v.path !== 'string') continue;
    if (!(await window.api.fileExists(v.path))) missing++;
    addVideo(v.path, v);
  }
  if (isBoard()) placeOnBoard(tiles.filter((t) => !t.board));
  layoutTiles();
  // older session files have no zoom / view saved: fit once the videos are in
  if (!(Number(lay.rowHeight) > 0) || (isBoard() && !board.initialized)) scheduleFit();
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

document.getElementById('btn-add').addEventListener('click', async () => {
  addVideos(await window.api.pickVideos());
});
document.getElementById('btn-open').addEventListener('click', () => openSession());
document.getElementById('btn-save').addEventListener('click', saveSession);
document.getElementById('btn-save-as').addEventListener('click', saveSessionAs);
document.getElementById('btn-cache').addEventListener('click', async () => {
  const { bytes, files } = await window.api.cacheInfo();
  const mb = (bytes / 1048576).toFixed(0);
  if (!files) { setStatus('Cache is empty'); return; }
  if (confirm(`${files} playable copies use ${mb} MB. Clear the cache?`)) { await window.api.clearCache(); setStatus('Cache cleared'); }
});
document.getElementById('btn-play-all').addEventListener('click', () => tiles.forEach((t) => t.video.play().catch(() => {})));
document.getElementById('btn-pause-all').addEventListener('click', () => tiles.forEach((t) => t.video.pause()));
document.getElementById('btn-mute-all').addEventListener('click', () => tiles.forEach((t) => { t.video.muted = true; }));
document.getElementById('btn-unmute-all').addEventListener('click', () => tiles.forEach((t) => { t.video.muted = false; }));
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
  else { layout.rowHeight = clamp(Math.round(Number(zoomEl.value)), MIN_H, MAX_H); for (const t of tiles) layoutTile(t); zoomLabel.textContent = layout.rowHeight + 'px'; }
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

  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); e.shiftKey ? saveSessionAs() : saveSession(); return; }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openSession(); return; }
  if (ctrl && e.key.toLowerCase() === 'a' && !isBoard()) { e.preventDefault(); document.getElementById('btn-add').click(); return; }

  if (inControl) return;
  const key = e.key.toLowerCase();

  // shortcuts that act on the video under the mouse
  const h = hoveredTile && tiles.includes(hoveredTile) ? hoveredTile : null;
  if (h) {
    const big = e.shiftKey ? 30 : 5;
    if (e.key === 'ArrowLeft') { e.preventDefault(); h.seekBy(-big); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); h.seekBy(big); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); h.setVolume(Math.round(h.volume * 100) + 5); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); h.setVolume(Math.round(h.volume * 100) - 5); return; }
    if (key === 'b') { h.addBookmark(); return; }
    if (e.key === '[') { h.jumpBookmark(-1); return; }
    if (e.key === ']') { h.jumpBookmark(1); return; }
    if (key === 'k') { togglePlay(h.video); return; }
    if (key === 'm') { h.video.muted = !h.video.muted; return; }
    if (e.key === ',') { h.stepFrame(-1); return; }
    if (e.key === '.') { h.stepFrame(1); return; }
  }

  if (e.code === 'Space') {
    e.preventDefault();
    const anyPlaying = tiles.some((t) => !t.video.paused);
    tiles.forEach((t) => (anyPlaying ? t.video.pause() : t.video.play().catch(() => {})));
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
  } else if (key === 'f') {
    fitAll();
  } else if (e.key === '=' || e.key === '+') {
    if (isBoard()) zoomAtCenter(board.zoom * 1.15); else setRowHeight(layout.rowHeight * 1.1);
  } else if (e.key === '-' || e.key === '_') {
    if (isBoard()) zoomAtCenter(board.zoom / 1.15); else setRowHeight(layout.rowHeight / 1.1);
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
