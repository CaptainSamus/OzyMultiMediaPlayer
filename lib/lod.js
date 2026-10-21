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
      // web embeds cannot be stilled: always live, and they count
      for (const i of items) if (!i.budgeted) { live.add(i.id); used++; }
      // forced tiles go first, best rank first (compare, fullscreen, the most recently touched),
      // but only while there is room: nothing takes a window past its cap
      const forced = items.filter((i) => i.budgeted && i.forced).sort((a, b) => (a.forcedRank || 0) - (b.forcedRank || 0));
      for (const i of forced) { if (used >= cap) break; live.add(i.id); used++; }
      const cands = items.filter((i) => i.budgeted && !i.forced && vis(i.rect) && i.rect.h >= minPx)
        .map((i) => ({ i, d: Math.hypot(i.rect.x + i.rect.w / 2 - cx, i.rect.y + i.rect.h / 2 - cy) }))
        .sort((a, b) => a.d - b.d);
      for (const c of cands) { if (used >= cap) break; live.add(c.i.id); used++; }
      return live;
    },
  };
  // Where a still's clock starts: the element when it has loaded; else a quality swap's saved
  // position if one is in flight; else what the tile was opened at (a session's time and play state).
  Lod.seed = ({ readyState, videoTime, videoPaused, rate, swap, wantTime, wantPlaying }) => {
    if (swap) return { time: swap.time || 0, playing: !swap.paused, rate: swap.rate || rate || 1 };
    if (readyState >= 1) return { time: videoTime || 0, playing: !videoPaused, rate: rate || 1 };
    return { time: wantTime || 0, playing: !!wantPlaying, rate: rate || 1 };
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Lod;
  else window.Lod = Lod;
}
