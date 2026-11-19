// Lines on the board (Mark, 2026-11-10): dividers between rows of pictures, arrows, anything drawn
// with a straight edge. A line tile is a list of points and a look; like every tile it also has a
// board box, and its points are kept as fractions of that box, so whatever moves or scales the box
// (a drag, an undo, a tidy) moves or scales the line with it, with no special case anywhere.
//
//   record: { type: 'line', board: { x, y, w, h }, points: [[u, v], ...], style }
//   style:  { color, width, dash: 'solid' | 'dashed' | 'dotted', start: 'none' | 'arrow', end: 'none' | 'arrow' }
//
// width is in board pixels, like a picture's size: it scales with the zoom, as in Miro.
{
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

  const LineTile = {
    DEFAULTS: { color: '#1a1a1a', width: 3, dash: 'solid', start: 'none', end: 'none', route: 'straight' },
    ROUTES: ['straight', 'elbow', 'curve'], // (2026-11-15) how a line between two ends is drawn
    DASHES: ['solid', 'dashed', 'dotted'],
    CAPS: ['none', 'arrow'],
    MIN_W: 0.05,
    MAX_W: 4000,

    normalize(style) {
      const s = style && typeof style === 'object' ? style : {};
      const d = LineTile.DEFAULTS;
      return {
        color: typeof s.color === 'string' && COLOR.test(s.color) ? s.color.toLowerCase() : d.color,
        width: clamp(num(s.width, d.width), LineTile.MIN_W, LineTile.MAX_W),
        dash: LineTile.DASHES.includes(s.dash) ? s.dash : d.dash,
        start: LineTile.CAPS.includes(s.start) ? s.start : d.start,
        end: LineTile.CAPS.includes(s.end) ? s.end : d.end,
        route: LineTile.ROUTES.includes(s.route) ? s.route : d.route,
      };
    },

    // the room around the points inside the box: half the stroke, and an arrowhead's length
    pad(style) {
      const s = LineTile.normalize(style);
      const head = s.start !== 'none' || s.end !== 'none' ? s.width * 4 : 0;
      return s.width / 2 + head + 0.5;
    },

    // absolute board points [{x, y}] -> { board, points } (points as fractions of the box)
    fromAbs(abs, style) {
      const pts = (abs || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length < 2) return null;
      const pad = LineTile.pad(style);
      const minX = Math.min(...pts.map((p) => p.x)) - pad, maxX = Math.max(...pts.map((p) => p.x)) + pad;
      const minY = Math.min(...pts.map((p) => p.y)) - pad, maxY = Math.max(...pts.map((p) => p.y)) + pad;
      const board = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      return { board, points: pts.map((p) => [(p.x - minX) / board.w, (p.y - minY) / board.h]) };
    },
    // the points in board coordinates
    toAbs(board, points) {
      return (points || []).map(([u, v]) => ({ x: board.x + u * board.w, y: board.y + v * board.h }));
    },
    // a record's points, cleaned: at least two [u, v] pairs of numbers
    cleanPoints(points) {
      if (!Array.isArray(points)) return null;
      const out = points.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]);
      return out.length >= 2 ? out : null;
    },

    // the SVG path through points given in the tile's own pixels
    pathD(local) {
      return (local || []).map((p, i) => `${i ? 'L' : 'M'}${+p.x.toFixed(3)} ${+p.y.toFixed(3)}`).join(' ');
    },
    // an arrowhead at `tip`, pointing away from `from`: a filled triangle about four strokes long
    arrowD(from, tip, width) {
      const dx = tip.x - from.x, dy = tip.y - from.y;
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) return '';
      const ux = dx / len, uy = dy / len;
      const L = Math.max(width * 4, 1), W = Math.max(width * 2.2, 0.6);
      const bx = tip.x - ux * L, by = tip.y - uy * L;
      const f = (n) => +n.toFixed(3);
      return `M${f(tip.x)} ${f(tip.y)} L${f(bx - uy * W)} ${f(by + ux * W)} L${f(bx + uy * W)} ${f(by - ux * W)} Z`;
    },
    // where the visible stroke stops short of an arrowhead's tip (so the butt end doesn't poke out)
    shorten(from, tip, by) {
      const dx = tip.x - from.x, dy = tip.y - from.y;
      const len = Math.hypot(dx, dy);
      if (!(len > by)) return { ...tip };
      return { x: tip.x - (dx / len) * by, y: tip.y - (dy / len) * by };
    },
    dashArray(style) {
      const s = LineTile.normalize(style);
      if (s.dash === 'dashed') return `${s.width * 4} ${s.width * 3}`;
      if (s.dash === 'dotted') return `${s.width * 0.01} ${s.width * 2}`; // round caps make the dots
      return '';
    },

    // Drawing or dragging an end: within `tol` degrees of level or upright it snaps there (dividers
    // come out straight without trying); `step` (Shift) snaps to every `step` degrees instead.
    snapEnd(fixed, moving, { tol = 4, step = 0 } = {}) {
      const dx = moving.x - fixed.x, dy = moving.y - fixed.y;
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) return { ...moving };
      const deg = Math.atan2(dy, dx) * 180 / Math.PI;
      let to = null;
      if (step > 0) to = Math.round(deg / step) * step;
      else for (const a of [-180, -90, 0, 90, 180]) if (Math.abs(deg - a) <= tol) to = a;
      if (to === null) return { ...moving };
      const r = to * Math.PI / 180;
      // level and upright keep the pointer's own distance along that axis (no drift)
      if (to % 180 === 0) return { x: moving.x, y: fixed.y };
      if (to % 90 === 0) return { x: fixed.x, y: moving.y };
      return { x: fixed.x + Math.cos(r) * len, y: fixed.y + Math.sin(r) * len };
    },

    // The line as a thin box (the stroke itself, not the room around it): what picture edges snap
    // to and stop at. null for a line of more than two points or one at a slant.
    strokeBox(abs, width) {
      if (!abs || abs.length !== 2) return null;
      const [a, b] = abs, hw = width / 2;
      if (Math.abs(a.y - b.y) <= 1e-6 * Math.max(1, Math.abs(a.x - b.x))) return { x: Math.min(a.x, b.x), y: a.y - hw, w: Math.abs(a.x - b.x), h: width, axis: 'h' };
      if (Math.abs(a.x - b.x) <= 1e-6 * Math.max(1, Math.abs(a.y - b.y))) return { x: a.x - hw, y: Math.min(a.y, b.y), w: width, h: Math.abs(a.y - b.y), axis: 'v' };
      return null;
    },

    // ---- ends on tiles, and routes (2026-11-15) ----
    // which way a point on a box's edge faces (fx, fy: where on the box, 0..1), or null inside it
    sideDir(fx, fy) {
      return fx <= 0.01 ? { x: -1, y: 0 } : fx >= 0.99 ? { x: 1, y: 0 } : fy <= 0.01 ? { x: 0, y: -1 } : fy >= 0.99 ? { x: 0, y: 1 } : null;
    },
    // the middle of the side of box b (top-left x, y, w, h) that faces point q: { fx, fy }
    facing(b, q) {
      const dx = (q.x - (b.x + b.w / 2)) / (b.w || 1), dy = (q.y - (b.y + b.h / 2)) / (b.h || 1);
      return Math.abs(dx) >= Math.abs(dy) ? { fx: dx >= 0 ? 1 : 0, fy: 0.5 } : { fx: 0.5, fy: dy >= 0 ? 1 : 0 };
    },
    // the points of a line from A to B (each { x, y, dir }, dir: the way it leaves a tile, or null):
    // straight, elbowed (square to the sides it leaves and meets) or curved (bending out the same way)
    route(A, B, kind = 'straight') {
      const P = (p) => ({ x: p.x, y: p.y });
      let pts;
      if (kind === 'elbow') {
        const across = Math.abs(B.x - A.x) >= Math.abs(B.y - A.y);
        const firstH = A.dir ? A.dir.x !== 0 : B.dir ? B.dir.x === 0 : across;
        const lastH = B.dir ? B.dir.x !== 0 : !firstH;
        if (firstH && lastH) { const mx = (A.x + B.x) / 2; pts = [A, { x: mx, y: A.y }, { x: mx, y: B.y }, B]; }
        else if (!firstH && !lastH) { const my = (A.y + B.y) / 2; pts = [A, { x: A.x, y: my }, { x: B.x, y: my }, B]; }
        else if (firstH) pts = [A, { x: B.x, y: A.y }, B];
        else pts = [A, { x: A.x, y: B.y }, B];
      } else if (kind === 'curve') {
        const d = Math.hypot(B.x - A.x, B.y - A.y) * 0.4;
        const across = Math.abs(B.x - A.x) >= Math.abs(B.y - A.y);
        const toward = (p, q) => (across ? { x: Math.sign(q.x - p.x) || 1, y: 0 } : { x: 0, y: Math.sign(q.y - p.y) || 1 });
        const da = A.dir || toward(A, B), db = B.dir || toward(B, A);
        const c1 = { x: A.x + da.x * d, y: A.y + da.y * d }, c2 = { x: B.x + db.x * d, y: B.y + db.y * d };
        pts = [];
        for (let i = 0; i <= 20; i++) {
          const t = i / 20, u = 1 - t;
          pts.push({ x: u * u * u * A.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * B.x, y: u * u * u * A.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * B.y });
        }
      } else pts = [A, B];
      return pts.map(P).filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1e-9);
    },
    // a freehand stroke with fewer points: those closer than tol to the line through their
    // neighbours go (Ramer-Douglas-Peucker)
    simplify(pts, tol) {
      if (!pts || pts.length < 3) return (pts || []).slice();
      const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
      const stack = [[0, pts.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop();
        const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
        let worst = -1, at = -1;
        for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L; if (d > worst) { worst = d; at = i; } }
        if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
      }
      return pts.filter((_, i) => keep[i]);
    },

    // thicker (dir 1) or thinner (dir -1): a quarter more or less each step, rounded to a tidy number
    step(width, dir) {
      const w = clamp(num(width, LineTile.DEFAULTS.width) * Math.pow(1.25, dir), LineTile.MIN_W, LineTile.MAX_W);
      return LineTile.tidy(w);
    },
    // two significant figures (2.5, 0.31, 120)
    tidy(w) { return Number(w.toPrecision(2)); },
    // the thickness slider: 0..1000 on a log scale from MIN_SLIDER to MAX_SLIDER board pixels
    MIN_SLIDER: 0.1,
    MAX_SLIDER: 400,
    toSlider(width) {
      const lo = Math.log(LineTile.MIN_SLIDER), hi = Math.log(LineTile.MAX_SLIDER);
      return Math.round(clamp((Math.log(clamp(width, LineTile.MIN_SLIDER, LineTile.MAX_SLIDER)) - lo) / (hi - lo), 0, 1) * 1000);
    },
    fromSlider(v) {
      const lo = Math.log(LineTile.MIN_SLIDER), hi = Math.log(LineTile.MAX_SLIDER);
      return LineTile.tidy(Math.exp(lo + (clamp(v, 0, 1000) / 1000) * (hi - lo)));
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = LineTile;
  else window.LineTile = LineTile;
}
