// Which videos a window should actually decode. Everything else is a still of its last frame.
// Off-screen or tiny tiles never decode; among the rest the ones nearest the middle of the view
// win until the cap. Web embeds cannot be stilled, so they are always live but count; so are tiles
// something else is showing big (the compare view, fullscreen), marked `forced`.
{
  const Lod = {
    choose(items, view, { minPx = 96, cap = 12 } = {}) {
      const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
      const live = new Set();
      let used = 0;
      const vis = (r) => r.x < view.x + view.w && r.x + r.w > view.x && r.y < view.y + view.h && r.y + r.h > view.y;
      for (const i of items) if (!i.budgeted || i.forced) { live.add(i.id); used++; }
      const cands = items.filter((i) => i.budgeted && !i.forced && vis(i.rect) && i.rect.h >= minPx)
        .map((i) => ({ i, d: Math.hypot(i.rect.x + i.rect.w / 2 - cx, i.rect.y + i.rect.h / 2 - cy) }))
        .sort((a, b) => a.d - b.d);
      for (const c of cands) { if (used >= cap) break; live.add(c.i.id); used++; }
      return live;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Lod;
  else window.Lod = Lod;
}
