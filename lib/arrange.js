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
};
if (typeof module !== 'undefined' && module.exports) module.exports = Arrange;
else window.Arrange = Arrange;
