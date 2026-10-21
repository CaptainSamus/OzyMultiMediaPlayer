// Rearranging inside a sticky group without un-tidying it: Alt-drag a member over another member
// and the two exchange slots (position and size). Plain drag still moves the group, Ctrl-drag
// still pulls one member free. Alt-drag anywhere else still pans the view (so does middle-mouse).
{
  const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const Swap = {
    isSwapDrag({ sticky, alt, mod, shift, memberCount }) {
      return !!sticky && !!alt && !mod && !shift && memberCount >= 2;
    },
    targetAt(point, slots, selfId) {
      const hit = slots.find((s) => s.id !== selfId && inside(point, s.rect));
      return hit ? hit.id : null;
    },
    apply(slots, a, b) {
      if (a === null || b === null || a === undefined || b === undefined || a === b) return slots;
      const ra = slots.find((s) => s.id === a), rb = slots.find((s) => s.id === b);
      if (!ra || !rb) return slots;
      return slots.map((s) => (s.id === a ? { id: a, rect: { ...rb.rect } } : s.id === b ? { id: b, rect: { ...ra.rect } } : s));
    },
    // The rect a tile of this aspect takes inside a slot. Same shape (the usual case: a tidied
    // group of like videos): the slot exactly, so the layout is identical after a swap. Another
    // shape: as large as fits, centred, so a 4:3 picture is never stretched into a 16:9 box.
    // No aspect (a text tile): the slot as it is.
    fitInto(rect, aspect) {
      if (!(aspect > 0) || Math.abs(rect.w - rect.h * aspect) < 0.5) return { ...rect };
      const h = Math.min(rect.h, rect.w / aspect), w = h * aspect;
      return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Swap;
  else window.Swap = Swap;
}
