// Snapping while a tile is corner-resized. Moving a tile already snaps its edges (snapRect in
// app.js); this is the size side of it: the height snaps to a neighbour's height, the width to a
// neighbour's width, and the two moving edges to neighbours' edges (with and without the link
// gap). Everything is expressed as a candidate height so the aspect ratio is never broken, and the
// smallest correction wins.
{
  const Snap = {
    rectFor(start, corner, h, aspect) {
      const w = h * aspect;
      return {
        x: corner.includes('l') ? start.x + start.w - w : start.x,
        y: corner.includes('t') ? start.y + start.h - h : start.y,
        w, h,
      };
    },
    resize({ start, corner, h, aspect, others, th, gap }) {
      const left = corner.includes('l'), top = corner.includes('t');
      // the x of the anchored vertical edge and the y of the anchored horizontal edge
      const ax = left ? start.x + start.w : start.x;
      const ay = top ? start.y + start.h : start.y;
      let best = null; // { h, d, guideX, guideY }
      const consider = (cand, guideX, guideY) => {
        if (!(cand > 0)) return;
        const d = Math.abs(cand - h);
        if (d > th) return;
        // a tie goes to the candidate with a guide line: "same height" and "bottoms level" are
        // often the same snap, and the edge is the one the user can see
        const guided = guideX !== null || guideY !== null;
        if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && guided && !best.guided)) best = { h: cand, d, guideX, guideY, guided };
      };
      for (const o of others || []) {
        consider(o.h, null, null);                 // same height
        consider(o.w / aspect, null, null);        // same width
        // moving vertical edge (right when growing right, left when growing left) meets o's edges
        for (const ex of [o.x, o.x + o.w, o.x - gap, o.x + o.w + gap]) {
          const w = left ? ax - ex : ex - ax;
          consider(w / aspect, ex < o.x ? o.x : (ex > o.x + o.w ? o.x + o.w : ex), null);
        }
        // moving horizontal edge meets o's edges
        for (const ey of [o.y, o.y + o.h, o.y - gap, o.y + o.h + gap]) {
          const hh = top ? ay - ey : ey - ay;
          consider(hh, null, ey < o.y ? o.y : (ey > o.y + o.h ? o.y + o.h : ey));
        }
      }
      return best ? { h: best.h, guideX: best.guideX, guideY: best.guideY } : { h, guideX: null, guideY: null };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Snap;
  else window.Snap = Snap;
}
