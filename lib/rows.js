// Rows between lines (Mark, 2026-11-10): a stack of level lines (dividers) splits a part of the
// board into rows, and the pictures in each row can be lined up in one go, "as if put through one
// round of InDesign": every picture in a row the same height (each keeps its own shape), in the
// row's middle and clear of the lines, and the pictures that sit one above another (columns, empty slots and all) lined
// up on one middle. Or, kept as they are, just cut where they cross a divider (Trim): a crop, so
// nothing is lost.
//
// Pure: guides and items in, new boxes out. app.js gathers them and applies the result as one undo.
//   guide: { id, y, x1, x2, width }            a level line (y: its middle)
//   item:  { id, kind: 'picture' | 'text', board: { x, y, w, h }, aspect?, crop? }
{
  const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

  const Rows = {
    PAD: 0.03,      // room above and below the pictures, and between them, as a share of the row's height
    TOO_TALL: 1.75, // a picture taller than this many rows spans rows on purpose: left alone

    // The stack a line belongs to: the given lines when there are two or more, else every level line
    // that runs alongside it (sharing at least half of the shorter one's length). Top to bottom.
    ladder(guides, picked) {
      const ids = new Set(picked || []);
      const chosen = guides.filter((g) => ids.has(g.id));
      let out;
      if (chosen.length >= 2) out = chosen;
      else if (chosen.length === 1) {
        const s = chosen[0];
        out = guides.filter((g) => g === s || overlap(g.x1, g.x2, s.x1, s.x2) >= 0.5 * Math.min(g.x2 - g.x1, s.x2 - s.x1));
      } else out = [];
      return out.slice().sort((a, b) => a.y - b.y);
    },

    // the rows of a ladder: the room between each line and the next ({ top, bottom, x1, x2 })
    bands(ladder) {
      const out = [];
      for (let i = 0; i + 1 < ladder.length; i++) {
        const a = ladder[i], b = ladder[i + 1];
        const top = a.y + a.width / 2, bottom = b.y - b.width / 2;
        if (bottom - top > 0) out.push({ index: i, top, bottom, x1: Math.min(a.x1, b.x1), x2: Math.max(a.x2, b.x2) });
      }
      return out;
    },

    // which row each item is in: its middle between the lines (and not far outside them sideways)
    sort(bands, items) {
      const rows = bands.map((b) => ({ band: b, pictures: [], texts: [] }));
      for (const it of items) {
        const cx = it.board.x + it.board.w / 2, cy = it.board.y + it.board.h / 2;
        const r = rows.find((row) => cy > row.band.top && cy < row.band.bottom);
        if (!r) continue;
        const slack = (r.band.x2 - r.band.x1) * 0.05;
        if (cx < r.band.x1 - slack || cx > r.band.x2 + slack) continue;
        (it.kind === 'picture' ? r.pictures : r.texts).push(it);
      }
      return rows;
    },

    // Line the pictures up, row by row, like a table: every picture in a row gets one height (the
    // row's usual one, never past the lines; each keeps its own shape), in the middle of the row;
    // pictures one above another in different rows are a column, and every picture in a column gets
    // the column's middle; empty slots stay empty. Pictures lying on top of each other move as one,
    // and no picture runs into the next any more than it did before.
    // Returns { boxes: Map(id -> board), report }.
    tidy(guides, items, { picked = null, pad = Rows.PAD } = {}) {
      const ladder = Rows.ladder(guides, picked);
      const rows = Rows.sort(Rows.bands(ladder), items);
      const boxes = new Map();
      const report = { rows: 0, pictures: 0, texts: 0, columns: 0, skippedTall: 0, skippedStacked: 0 };
      // 1. each row: its pictures as units (a pile, pictures more than half covering each other, is
      // one unit and keeps its arrangement), the row's one height, each unit's new size, still at
      // its own middle
      const placed = []; // units: { members, b (their box now), row, w, h, y, cx }
      const rowsUsed = [];
      for (const row of rows) {
        if (!row.pictures.length) continue;
        const { top, bottom } = row.band;
        const room = bottom - top, p = room * pad, most = room - 2 * p;
        if (!(most > 0)) continue;
        const pics = row.pictures.filter((it) => {
          if (it.board.h > room * Rows.TOO_TALL) { report.skippedTall++; return false; }
          return true;
        });
        if (!pics.length) continue;
        // two pictures one above the other (both in the row) are a design of their own: left alone
        const stacked = pics.some((a) => pics.some((b) => a !== b && overlap(a.board.x, a.board.x + a.board.w, b.board.x, b.board.x + b.board.w) > 0.5 * Math.min(a.board.w, b.board.w) && (a.board.y + a.board.h <= b.board.y + 1e-6 || b.board.y + b.board.h <= a.board.y + 1e-6)));
        if (stacked) { report.skippedStacked++; continue; }
        const units = Rows.piles(pics).map((members) => ({ members, b: Rows.bounds(members.map((m) => m.board)), row }));
        // the row's size: the height most of its pictures have now (so nothing grows much and the
        // columns stay put), never taller than the room between the lines; in the row's middle
        const h = Math.min(median(units.map((u) => u.b.h)), most);
        for (const u of units) { u.h = h; u.w = h * (u.b.w / u.b.h); u.y = top + (room - h) / 2; u.cx = u.b.x + u.b.w / 2; }
        rowsUsed.push({ row, gap: p, list: units });
        placed.push(...units);
      }
      if (!placed.length) return { boxes, report };
      // 2. columns: middles closer than half a typical picture's width (or half the usual step from
      // one picture to the next in a row, when that is less) are one column. A column is never wider
      // than that from its first picture (a picture half way between two columns must not chain them
      // into one) and never holds two pictures of one row.
      const steps = [];
      for (const { list } of rowsUsed) { const xs = list.map((q) => q.cx).sort((a, b) => a - b); for (let i = 1; i < xs.length; i++) steps.push(xs[i] - xs[i - 1]); }
      const tol = 0.5 * Math.min(median(placed.map((q) => q.w)), steps.length ? median(steps) : Infinity);
      const cols = [];
      for (const q of placed.slice().sort((a, b) => a.cx - b.cx)) {
        const last = cols[cols.length - 1];
        if (last && q.cx - last[0].cx <= tol && !last.some((o) => o.row === q.row)) last.push(q); else cols.push([q]);
      }
      for (const col of cols) { const m = median(col.map((q) => q.cx)); for (const q of col) q.cx = m; }
      report.columns = cols.filter((c) => c.length > 1).length;
      // 3. left to right in each row: no picture runs into the next any more than it did before (one
      // grown wider than its slot nudges the next on; pictures laid over each other on purpose keep
      // their overlap)
      for (const { list, gap } of rowsUsed) {
        list.sort((a, b) => (a.b.x + a.b.w / 2) - (b.b.x + b.b.w / 2));
        let prev = null;
        for (const q of list) {
          let x = q.cx - q.w / 2;
          if (prev) {
            const was = q.b.x - (prev.b.x + prev.b.w); // the room between them now (< 0: overlapping)
            const keep = was < 0 ? was * (q.h / q.b.h) : Math.min(gap, was);
            x = Math.max(x, prev.box.x + prev.box.w + keep);
          }
          q.box = { x, y: q.y, w: q.w, h: q.h };
          const k = q.h / q.b.h;
          for (const m of q.members) {
            const f = m.board;
            boxes.set(m.id, { x: x + (f.x - q.b.x) * k, y: q.y + (f.y - q.b.y) * k, w: f.w * k, h: f.h * k });
            report.pictures++;
          }
          prev = q;
        }
        report.rows++;
      }
      // 4. a caption on or by a picture goes with it: same place on the picture's box
      for (const { row, list } of rowsUsed) {
        for (const t of row.texts) {
          const tb = t.board;
          const cx = tb.x + tb.w / 2;
          let best = null, bestD = Infinity;
          for (const q of list) {
            if (overlap(tb.x, tb.x + tb.w, q.b.x, q.b.x + q.b.w) <= 0) continue;
            const d = Math.abs(cx - (q.b.x + q.b.w / 2));
            if (d < bestD) { bestD = d; best = q; }
          }
          if (!best) continue;
          const f = best.b, to = best.box;
          const fx = (cx - f.x) / f.w, fy = (tb.y - f.y) / f.h;
          boxes.set(t.id, { x: to.x + fx * to.w - tb.w / 2, y: to.y + fy * to.h, w: tb.w, h: tb.h });
          report.texts++;
        }
      }
      return { boxes, report };
    },
    // pictures lying on top of each other (one more than half covered by another), in piles
    piles(pics) {
      const parent = pics.map((_, i) => i);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      const area = (b) => b.w * b.h;
      for (let i = 0; i < pics.length; i++) {
        for (let j = i + 1; j < pics.length; j++) {
          const a = pics[i].board, b = pics[j].board;
          const o = overlap(a.x, a.x + a.w, b.x, b.x + b.w) * overlap(a.y, a.y + a.h, b.y, b.y + b.h);
          if (o > 0.5 * Math.min(area(a), area(b))) parent[find(i)] = find(j);
        }
      }
      const groups = new Map();
      pics.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
      return [...groups.values()];
    },
    bounds(list) {
      const x0 = Math.min(...list.map((b) => b.x)), y0 = Math.min(...list.map((b) => b.y));
      const x1 = Math.max(...list.map((b) => b.x + b.w)), y1 = Math.max(...list.map((b) => b.y + b.h));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    },

    // Cut the pictures that cross a divider at the divider (a crop: the picture keeps its place and
    // size, the part past the line is hidden). Returns { changes: Map(id -> { board, crop }), report }.
    trim(guides, items, { picked = null } = {}) {
      const ladder = Rows.ladder(guides, picked);
      const rows = Rows.sort(Rows.bands(ladder), items);
      const changes = new Map();
      const report = { pictures: 0 };
      for (const row of rows) {
        const { top, bottom } = row.band;
        for (const it of row.pictures) {
          const b = it.board;
          const cut0 = Math.max(0, top - b.y), cut1 = Math.max(0, b.y + b.h - bottom);
          if (!(cut0 > 1e-6 || cut1 > 1e-6) || cut0 + cut1 >= b.h) continue;
          const c = it.crop || { x: 0, y: 0, w: 1, h: 1 };
          const f0 = cut0 / b.h, f1 = cut1 / b.h;
          const crop = { x: c.x, y: c.y + f0 * c.h, w: c.w, h: c.h * (1 - f0 - f1) };
          changes.set(it.id, { board: { x: b.x, y: b.y + cut0, w: b.w, h: b.h - cut0 - cut1 }, crop });
          report.pictures++;
        }
      }
      return { changes, report };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Rows;
  else window.Rows = Rows;
}
