// Board arrangements for the Tidy menu. Rects are relative to (0,0) in board units.
const Arrange = {
  // Flow-wrap at a given height; returns rects or null if it doesn't fit in W x H.
  flow(items, height, W, H, gap) {
    const rects = []; let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      const w = height * it.aspect;
      if (w > W + 0.01) return null;
      if (x > 0 && x + gap + w > W + 0.01) { x = 0; y += rowH + gap; rowH = 0; }
      if (x > 0) x += gap;
      rects.push({ x, y, w, h: height });
      x += w; rowH = Math.max(rowH, height);
    }
    return y + rowH <= H + 0.01 ? rects : null;
  },
  // Fit to view: every tile the same height, the largest that flow-wraps inside W x H.
  fitToView(items, W, H, gap) {
    if (!items.length) return { height: 0, rects: [] };
    let lo = 1, hi = H;
    if (!Arrange.flow(items, lo, W, H, gap)) return { height: lo, rects: Arrange.flow(items, lo, W, Infinity, gap) };
    for (let i = 0; i < 40 && hi - lo > 0.5; i++) { const mid = (lo + hi) / 2; if (Arrange.flow(items, mid, W, H, gap)) lo = mid; else hi = mid; }
    return { height: lo, rects: Arrange.flow(items, lo, W, H, gap) };
  },
  // Gallery packing with each tile's own height: does this set flow-wrap inside W x H?
  packs(items, W, H, gap) {
    const rows = [];
    let x = 0, rowH = 0;
    for (const it of items) {
      const w = it.h * it.aspect;
      if (w > W + 0.01) return false; // too wide even on its own row
      if (x > 0 && x + gap + w > W + 0.01) { rows.push(rowH); x = 0; rowH = 0; }
      x += (x > 0 ? gap : 0) + w;
      rowH = Math.max(rowH, it.h);
    }
    rows.push(rowH);
    return rows.reduce((a, b) => a + b, 0) + gap * (rows.length - 1) <= H + 0.01;
  },
  // Largest factor (>= 0.05) that still packs when every height is multiplied by it, so the
  // sizes the user set keep their ratios.
  fitScale(items, W, H, gap) {
    if (!items.length) return 1;
    const at = (f) => Arrange.packs(items.map((it) => ({ aspect: it.aspect, h: it.h * f })), W, H, gap);
    let lo = 0.05, hi = 20;
    if (!at(lo)) return lo;
    if (at(hi)) return hi;
    for (let i = 0; i < 40 && hi - lo > 0.001; i++) { const mid = (lo + hi) / 2; if (at(mid)) lo = mid; else hi = mid; }
    return lo;
  },
  // Grid: sizes kept, ceil(sqrt(n)) columns, rows as tall as their tallest tile.
  grid(items, gap) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(items.length)));
    const rects = []; let x = 0, y = 0, rowH = 0;
    items.forEach((it, i) => {
      if (i > 0 && i % cols === 0) { x = 0; y += rowH + gap; rowH = 0; }
      rects.push({ x, y, w: it.w, h: it.h });
      x += it.w + gap; rowH = Math.max(rowH, it.h);
    });
    return rects;
  },
  // Tidy the selection: every tile this one height, wrapped at the selection's own width. Unlike
  // flow() it never refuses - a tile wider than W just takes a row to itself - because here the
  // box is the tiles' own bounding box, not a view they have to fit.
  flowAtHeight(items, height, W, gap) {
    const rects = []; let x = 0, y = 0;
    for (const it of items) {
      const w = height * it.aspect;
      if (x > 0 && x + gap + w > W + 0.01) { x = 0; y += height + gap; }
      if (x > 0) x += gap;
      rects.push({ x, y, w, h: height });
      x += w;
    }
    return rects;
  },
  // Group scaling: every rect scaled by `factor` about the bounding-box corner opposite the handle
  // being dragged, so the far corner of the group stays put like a single tile's would.
  scaleAbout(rects, bbox, factor, corner) {
    const ox = corner.includes('l') ? bbox.minX + bbox.w : bbox.minX;
    const oy = corner.includes('t') ? bbox.minY + bbox.h : bbox.minY;
    return rects.map((r) => ({ x: ox + (r.x - ox) * factor, y: oy + (r.y - oy) * factor, w: r.w * factor, h: r.h * factor }));
  },
  // the factor limited so the smallest member stays >= minH and the largest <= maxH
  clampFactor(rects, factor, minH, maxH) {
    if (!rects.length) return factor;
    const lo = Math.min(...rects.map((r) => r.h)), hi = Math.max(...rects.map((r) => r.h));
    return Math.min(maxH / hi, Math.max(minH / lo, factor));
  },
  // Align: make a hand-made layout neat without changing it. Every tile's edges look for another
  // tile's edge (or that edge one gap away) within `th` and shift to it; the smallest correction
  // wins, ties go to the gap candidate so neighbours sit exactly one gap apart. Sizes never change,
  // and a tile with nothing within reach stays where it is.
  // Tiles settle one at a time, outward from the biggest (the big one in the middle of a hand-made
  // layout is the reference): bigger before smaller, and among equals the one nearest the biggest
  // first. A tile lines up only with tiles that have already settled, so a row closes up link by
  // link, every gap comes out even, and no two neighbours can chase each other.
  align(rects, th, gap) {
    const out = rects.map((r) => ({ ...r }));
    if (out.length < 2) return out;
    const area = (r) => r.w * r.h;
    const ref = out.reduce((m, r) => (area(r) > area(m) ? r : m), out[0]);
    const cx = ref.x + ref.w / 2, cy = ref.y + ref.h / 2;
    const far = (r) => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    const order = out.map((r, i) => i).sort((i, j) => (area(out[j]) - area(out[i])) || (far(out[i]) - far(out[j])) || (i - j));
    const settled = [];
    for (const i of order) {
      const r = out[i];
      let bx = null, by = null; // { d, shift, viaGap }
      const best = (cur, shift, viaGap) => {
        const d = Math.abs(shift);
        if (d > th + 1e-9) return cur;
        return (!cur || d < cur.d - 1e-9 || (Math.abs(d - cur.d) <= 1e-9 && viaGap && !cur.viaGap)) ? { d, shift, viaGap } : cur;
      };
      for (const o of settled) {
        bx = best(bx, o.x - r.x, false);                       // left to left
        bx = best(bx, (o.x + o.w + gap) - r.x, true);          // left to right + gap
        bx = best(bx, (o.x + o.w) - (r.x + r.w), false);       // right to right
        bx = best(bx, (o.x - gap) - (r.x + r.w), true);        // right to left - gap
        by = best(by, o.y - r.y, false);
        by = best(by, (o.y + o.h + gap) - r.y, true);
        by = best(by, (o.y + o.h) - (r.y + r.h), false);
        by = best(by, (o.y - gap) - (r.y + r.h), true);
      }
      if (bx) r.x += bx.shift;
      if (by) r.y += by.shift;
      settled.push(r);
    }
    return out;
  },
  // Compact: sizes and the arrangement are kept; the layout closes up toward its own top-left
  // until tiles sit one gap apart, like pieces settling. It works one axis at a time: every tile
  // slides up until it rests under whatever was above it in its columns, then every tile slides
  // left until it rests against whatever was left of it in its rows. So what was above stays
  // above, what was left stays left, and nothing can end up overlapping, whatever it started as.
  // "In its columns / rows" means closer than one gap on the other axis, so nothing ends up nearly
  // touching either. A second pass uses the room the first one opened.
  compact(rects, gap, passes = 2) {
    const cur = rects.map((r) => ({ ...r }));
    if (!cur.length) return cur;
    const minX = Math.min(...cur.map((r) => r.x)), minY = Math.min(...cur.map((r) => r.y));
    const e = 1e-6;
    const xNear = (a, b) => a.x < b.x + b.w + gap - e && a.x + a.w + gap - e > b.x;
    const yNear = (a, b) => a.y < b.y + b.h + gap - e && a.y + a.h + gap - e > b.y;
    const settle = (pos, size, floor, shares) => {
      const done = [];
      for (const r of [...cur].sort((a, b) => (a[pos] - b[pos]) || (a.x - b.x) || (a.y - b.y))) {
        let to = floor;
        for (const q of done) if (shares(r, q)) to = Math.max(to, q[pos] + q[size] + gap);
        r[pos] = to;
        done.push(r);
      }
    };
    for (let p = 0; p < passes; p++) {
      settle('y', 'h', minY, xNear);
      settle('x', 'w', minX, yNear);
    }
    return cur;
  },
  // Rows: sizes kept, sorted into rows across W with even gaps; for when position doesn't matter.
  rows(items, W, gap) {
    const rects = []; let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      if (x > 0 && x + gap + it.w > W + 0.01) { x = 0; y += rowH + gap; rowH = 0; }
      if (x > 0) x += gap;
      rects.push({ x, y, w: it.w, h: it.h });
      x += it.w; rowH = Math.max(rowH, it.h);
    }
    return rects;
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Arrange;
else window.Arrange = Arrange;
