// Moving things on the board without pushing anything (2026-11-19, the default; pushing the
// neighbours aside is the older "Push neighbours" mode).
// Whatever is dragged stops when it runs into something else: it comes to rest against that
// thing's edge and nothing else moves; move the mouse along and it slides along the edge. Drag it
// all the way to a clear place on the far side and it goes there. Pairs that already overlap
// when the drag starts (a caption on a picture, a sticker on a sticky note) are left alone, so
// they can be moved over each other as before.
//
// The maths is done in "shift space": for a moving rect m (where it started) and an obstacle o,
// the shifts (sx, sy) that make them overlap form an open rectangle, a zone. A drag asks for a
// shift; the answer is the nearest shift outside every zone.
(function () {
  const Collide = {
    EPS: 0.5, // overlaps smaller than this (in board px) count as touching
    overlap(a, b, eps = Collide.EPS) {
      return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
    },
    // the forbidden shifts of rects `moving` (at their start) against `obstacles`; a pair that
    // overlaps already, at no shift, is left out
    zones(moving, obstacles) {
      const out = [];
      for (const m of moving) {
        for (const o of obstacles) {
          if (Collide.overlap(m, o)) continue;
          out.push({ x0: o.x - m.x - m.w, x1: o.x + o.w - m.x, y0: o.y - m.y - m.h, y1: o.y + o.h - m.y });
        }
      }
      return out;
    },
    // is shift (sx, sy) clear of every zone? (on a zone's edge counts as clear: touching)
    clear(zones, sx, sy, eps = Collide.EPS) {
      for (const z of zones) if (sx > z.x0 + eps && sx < z.x1 - eps && sy > z.y0 + eps && sy < z.y1 - eps) return false;
      return true;
    },
    // Where a drag goes: to the wanted shift when that place is clear; otherwise from where it is
    // now (`from`, clear) as far toward it as it can without entering a zone, one axis at a time,
    // so it rests against the edge it ran into and slides along it (both orders are tried; the one
    // that ends nearer the wanted shift wins). It never passes through anything: it is only once
    // the wanted place is clear of what was in the way that it goes there.
    move(zones, from, to) {
      if (Collide.clear(zones, to.x, to.y)) return { x: to.x, y: to.y };
      const along = (p, ax) => {
        const o = ax === 'x' ? 'y' : 'x', cur = p[ax], target = to[ax], dir = Math.sign(target - cur);
        if (!dir) return p;
        let lim = target;
        for (const z of zones) {
          const lo = ax === 'x' ? z.x0 : z.y0, hi = ax === 'x' ? z.x1 : z.y1;
          const olo = ax === 'x' ? z.y0 : z.x0, ohi = ax === 'x' ? z.y1 : z.x1;
          if (!(p[o] > olo + Collide.EPS && p[o] < ohi - Collide.EPS)) continue; // not level with it
          if (dir > 0 && lo >= cur - Collide.EPS && lo < lim) lim = Math.max(cur, lo);
          if (dir < 0 && hi <= cur + Collide.EPS && hi > lim) lim = Math.min(cur, hi);
        }
        return { ...p, [ax]: lim };
      };
      const a = along(along(from, 'x'), 'y'), b = along(along(from, 'y'), 'x');
      const d = (p) => Math.hypot(p.x - to.x, p.y - to.y);
      return d(a) <= d(b) ? a : b;
    },
    // (first version, 2026-11-19: the nearest clear place, which let a hard push slip round the
    // side of what was in the way; kept for reference)
    // The clear shift nearest (dx, dy): (dx, dy) itself when nothing is in the way, else a point on
    // the edge of a zone. A search from the wanted point outwards: each blocked point offers the
    // four edges of each zone it is in, nearest first. null if none is found within `limit` tries.
    nearest(zones, dx, dy, limit = 400) {
      if (Collide.clear(zones, dx, dy)) return { x: dx, y: dy };
      const seen = new Set(), queue = [];
      const key = (x, y) => Math.round(x * 100) + ',' + Math.round(y * 100);
      const add = (x, y) => { const k = key(x, y); if (seen.has(k)) return; seen.add(k); queue.push({ x, y, d: Math.hypot(x - dx, y - dy) }); };
      const expand = (p) => {
        for (const z of zones) {
          if (!(p.x > z.x0 + Collide.EPS && p.x < z.x1 - Collide.EPS && p.y > z.y0 + Collide.EPS && p.y < z.y1 - Collide.EPS)) continue;
          add(z.x0, p.y); add(z.x1, p.y); add(p.x, z.y0); add(p.x, z.y1);
        }
      };
      expand({ x: dx, y: dy });
      for (let n = 0; n < limit && queue.length; n++) {
        let bi = 0;
        for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[bi].d) bi = i;
        const p = queue[bi]; queue[bi] = queue[queue.length - 1]; queue.pop();
        if (Collide.clear(zones, p.x, p.y)) return { x: p.x, y: p.y };
        expand(p);
      }
      return null;
    },
    // does any of `rects` run into an obstacle it did not already overlap? (`before`: the same
    // rects where the change started, in the same order)
    blocked(rects, before, obstacles) {
      for (let i = 0; i < rects.length; i++) {
        for (const o of obstacles) if (Collide.overlap(rects[i], o) && !Collide.overlap(before[i], o)) return true;
      }
      return false;
    },
    // A resize that grows into something stops where it touches: the largest p in [lo, hi] for which
    // place(p) (the rects at p) is not blocked; lo is where it started. hi when nothing is in the way.
    largest(place, before, obstacles, lo, hi, steps = 24) {
      if (!Collide.blocked(place(hi), before, obstacles)) return hi;
      let a = lo, b = hi; // a: clear, b: blocked
      for (let i = 0; i < steps; i++) { const m = (a + b) / 2; if (Collide.blocked(place(m), before, obstacles)) b = m; else a = m; }
      return a;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Collide;
  else window.Collide = Collide;
})();
