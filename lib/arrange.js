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
    const hits = (p, q) => p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;
    const settled = [];
    for (const i of order) {
      const r = out[i];
      const xs = [], ys = []; // candidates: { d, shift, viaGap }
      const add = (list, shift, viaGap) => { const d = Math.abs(shift); if (d <= th + 1e-9) list.push({ d, shift, viaGap }); };
      for (const o of settled) {
        add(xs, o.x - r.x, false);                       // left to left
        add(xs, (o.x + o.w + gap) - r.x, true);          // left to right + gap
        add(xs, (o.x + o.w) - (r.x + r.w), false);       // right to right
        add(xs, (o.x - gap) - (r.x + r.w), true);        // right to left - gap
        add(ys, o.y - r.y, false);
        add(ys, (o.y + o.h + gap) - r.y, true);
        add(ys, (o.y + o.h) - (r.y + r.h), false);
        add(ys, (o.y - gap) - (r.y + r.h), true);
      }
      // An edge worth lining up with can belong to a tile on the far side of the board, and the
      // shift toward it must not slide this tile into the one beside it: a candidate that would
      // make the tile overlap anything it did not already overlap is passed over for the next best.
      const was = out.map((q, j) => j !== i && hits(r, q));
      const clear = (c) => out.every((q, j) => j === i || was[j] || !hits(c, q));
      const pick = (list, at) => list
        .sort((p, q) => (Math.abs(p.d - q.d) <= 1e-9 ? (q.viaGap ? 1 : 0) - (p.viaGap ? 1 : 0) : p.d - q.d))
        .find((c) => clear(at(c.shift)));
      const bx = pick(xs, (dx) => ({ x: r.x + dx, y: r.y, w: r.w, h: r.h }));
      if (bx) r.x += bx.shift;
      const by = pick(ys, (dy) => ({ x: r.x, y: r.y + dy, w: r.w, h: r.h }));
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
  // Pack: close the gaps the way a person does by hand. Tiles are laid on a skyline: the lowest
  // free stretch (leftmost on a tie) takes a few tiles side by side, all scaled by one factor so
  // together they fill the stretch exactly. The factor must stay within `slack` of 1 and the count
  // is the one that needs the least resizing (growing a little is preferred to shrinking). Tiles
  // of different heights leave steps, and the tiles that follow fill those steps the same way,
  // which is what makes columns of equal width appear. Aspect is always kept.
  // Which tiles a stretch takes: with plain { w, h } items, the next ones in the order given
  // (reading order). When the items carry their board position ({ x, y } too), the ones that were
  // nearest to that spot, so every tile stays about where it was and the big one in the middle
  // stays in the middle.
  // When nothing fills a stretch exactly the tiles go in at the limit (or untouched on the last
  // row), and a stretch too narrow for anything left is given up: it rises to its neighbour's
  // level, leaving a hole. Returns rects from (0,0), in the order of `items`.
  pack(items, W, gap, slack) {
    const lo = 1 - slack, hi = 1 + slack, n = items.length, eps = 1e-6;
    const out = new Array(n);
    if (!n) return out;
    // where each tile wants to be, in the packed width's own scale
    const guided = items.every((it) => Number.isFinite(it.x) && Number.isFinite(it.y));
    let tx = null, ty = null;
    if (guided) {
      const x0 = Math.min(...items.map((it) => it.x)), y0 = Math.min(...items.map((it) => it.y));
      const bw = Math.max(...items.map((it) => it.x + it.w)) - x0, k = bw > 0 ? W / bw : 1;
      tx = items.map((it) => (it.x - x0) * k); ty = items.map((it) => (it.y - y0) * k);
    }
    const placed = new Array(n).fill(false); let left = n;
    // the unplaced tile for the spot (cx, sy) that still fits in `room` at its smallest, or -1
    const choose = (cx, sy, room, taken) => {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        if (placed[i] || taken.includes(i)) continue;
        const fits = items[i].w * lo + gap <= room + eps;
        if (!guided) return fits ? i : -1;             // strictly in the order given
        if (!fits) continue;
        // a tile that belongs further down costs double; one that is overdue (its place is
        // already above the skyline) costs half, so nothing is left behind for the bottom
        const dy = ty[i] - sy, d = Math.abs(tx[i] - cx) + (dy >= 0 ? 2 * dy : -0.5 * dy);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };
    // the skyline works on tiles grown by one gap to the right and below, in a width grown by one
    // gap, so "edge to edge with a gap between" is plain edge to edge here
    const sky = [{ x: 0, w: W + gap, y: 0 }];
    const tidy = () => { for (let k = 0; k < sky.length - 1;) { if (Math.abs(sky[k].y - sky[k + 1].y) <= eps) { sky[k].w += sky[k + 1].w; sky.splice(k + 1, 1); } else k++; } };
    // what a resize costs: growing a little is preferred to shrinking, and a level row is worth
    // a bit of extra resizing over a stepped one
    const cost = (f) => (f >= 1 ? Math.log(f) : -1.5 * Math.log(f));
    const STEP_COST = 0.15;
    // what a stretch would take: tiles gathered one at a time, keeping the count that fills the
    // stretch exactly with the least resizing. null when nothing left fits it.
    const fill = (st) => {
      const group = []; let sum = 0, asp = 0, pick = null, under = 0;
      for (;;) {
        const i = choose(st.x + sum + group.length * gap, st.y, st.w - (sum * lo + group.length * gap), group);
        if (i < 0) break;
        group.push(i); sum += items[i].w; asp += items[i].w / items[i].h;
        const k = group.length, room = st.w - k * gap;
        // best: one height for the whole group, so the row's bottom is level and the next row
        // starts on a flat stretch (each tile's own factor still has to be inside the slack)
        const H = room / asp, fs = group.map((j) => H / items[j].h);
        if (fs.every((f) => f >= lo - eps && f <= hi + eps)) {
          const c = fs.reduce((a, f) => a + cost(f), 0) / k;
          if (!pick || c < pick.c) pick = { k, fs: fs.map((f) => Math.min(hi, Math.max(lo, f))), c, fills: true };
          continue;
        }
        // else one factor for the group: sizes keep their ratio, the bottom is stepped
        const f = room / sum;
        if (f > hi + eps) { under = k; continue; }               // even at the limit they leave room: maybe one more
        const c = cost(f) + STEP_COST;
        if (!pick || c < pick.c) pick = { k, fs: group.map(() => Math.min(hi, Math.max(lo, f))), c, fills: true };
      }
      // nothing fills it: as many as fit, at the limit so the leftover is small - except on the
      // last row, where the tiles that are left simply keep their size
      if (!pick && under) pick = { k: under, fs: group.map(() => (under === left ? 1 : hi)), fills: false };
      if (!pick) return null;
      pick.group = group;
      return pick;
    };
    while (left > 0) {
      // the lowest free stretch is filled first (leftmost on a tie)
      let si = 0;
      for (let k = 1; k < sky.length; k++) if (sky[k].y < sky[si].y - eps) si = k;
      let pick = fill(sky[si]);
      if (!pick) {
        if (sky.length > 1) {
          // too narrow for anything left: give the stretch up (it rises to its lower neighbour)
          sky[si].y = Math.min(si > 0 ? sky[si - 1].y : Infinity, si < sky.length - 1 ? sky[si + 1].y : Infinity);
          tidy();
          continue;
        }
        // wider than the whole width even at its smallest: a row of its own
        si = 0; pick = { k: 1, fs: [lo], fills: false, group: [placed.indexOf(false)] };
      }
      const st = sky[si], group = pick.group;
      const segs = []; let x = st.x;
      for (let k = 0; k < pick.k; k++) {
        const i = group[k], w = items[i].w * pick.fs[k], h = items[i].h * pick.fs[k];
        out[i] = { x, y: st.y, w, h };
        placed[i] = true; left--;
        segs.push({ x, w: w + gap, y: st.y + h + gap });
        x += w + gap;
      }
      const end = st.x + st.w;
      if (pick.fills || x > end) segs[segs.length - 1].w += end - x;   // meet the far edge exactly (or cover an overflow)
      else if (end - x > eps) segs.push({ x, w: end - x, y: st.y });    // what is left of the stretch stays free
      sky.splice(si, 1, ...segs);
      tidy();
    }
    return out;
  },
  // Row bands of a layout as it stands: a tile joins the current band while its top is within
  // half the band's height of the band's top. Each band is a list of indexes, left to right.
  rowsOf(rects) {
    const order = rects.map((r, i) => i).sort((a, b) => (rects[a].y - rects[b].y) || (rects[a].x - rects[b].x));
    const rows = [];
    for (const i of order) {
      const r = rects[i], row = rows[rows.length - 1];
      if (row && r.y <= row.top + row.h * 0.5) { row.idx.push(i); row.h = Math.max(row.h, r.h); }
      else rows.push({ top: r.y, h: r.h, idx: [i] });
    }
    return rows.map((row) => row.idx.sort((a, b) => rects[a].x - rects[b].x));
  },
  // The width Pack should fill: what the widest row of the layout needs at its present sizes.
  // Narrower than that and rows have to break; as wide as the board's own footprint and a
  // scattered board could never be closed up within the resize limit.
  // A row band can hold tiles stacked on top of each other (small ones beside a tall one): those
  // share a column, as wide as the widest of them, and are not counted end to end.
  packWidth(rects, gap) {
    return Math.max(0, ...Arrange.rowsOf(rects).map((row) => {
      const cols = [];
      for (const i of row) {
        const r = rects[i];
        const c = cols.find((q) => Math.min(q.x1, r.x + r.w) - Math.max(q.x0, r.x) > 0.5 * Math.min(q.w, r.w));
        if (c) { c.w = Math.max(c.w, r.w); c.x0 = Math.min(c.x0, r.x); c.x1 = Math.max(c.x1, r.x + r.w); }
        else cols.push({ x0: r.x, x1: r.x + r.w, w: r.w });
      }
      return cols.reduce((sum, c) => sum + c.w, 0) + gap * (cols.length - 1);
    }));
  },
  // Pack a board as it stands: rects with positions in, rects from (0,0) out. The width is the one
  // the layout's own widest row needs, so rows stay the rows they were; a few narrower widths are
  // tried as well and one of them is taken only when it closes the board up much better (a
  // board of wildly different sizes packs tighter in more, shorter rows).
  packBoard(rects, gap, slack) {
    const natural = Arrange.packWidth(rects, gap);
    let best = null;
    for (const k of [1, 0.9, 0.8, 0.7, 0.6]) {
      const W = natural * k, out = Arrange.pack(rects, W, gap, slack), coverage = Arrange.coverage(out);
      if (!best || coverage > best.coverage + 0.08) best = { rects: out, W, coverage };
    }
    return best;
  },
  // Justify: the layout's own rows (rowsOf), each scaled by one factor so the row is exactly W
  // wide, gaps included. The tiles of a row keep their sizes relative to each other. The factor
  // stays within `slack` of 1 (a slack of 1 or more means no limit), so a row that is too far off
  // moves toward W as far as it may. Rows are stacked one gap apart, from (0,0).
  justify(rects, W, gap, slack) {
    const out = rects.map((r) => ({ ...r }));
    const lo = slack >= 1 ? 0 : 1 - slack, hi = slack >= 1 ? Infinity : 1 + slack;
    let y = 0;
    for (const row of Arrange.rowsOf(rects)) {
      const sumW = row.reduce((s, i) => s + rects[i].w, 0);
      const f = Math.min(hi, Math.max(lo, (W - gap * (row.length - 1)) / sumW));
      let x = 0, rowH = 0;
      for (const i of row) {
        const w = rects[i].w * f, h = rects[i].h * f;
        out[i] = { x, y, w, h };
        x += w + gap; rowH = Math.max(rowH, h);
      }
      y += rowH + gap;
    }
    return out;
  },
  // how much of its bounding box a layout fills: 1 is a solid block
  coverage(rects) {
    if (!rects.length) return 0;
    const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
    const used = rects.reduce((s, r) => s + r.w * r.h, 0);
    return used / ((x1 - x0) * (y1 - y0));
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = Arrange;
else window.Arrange = Arrange;
