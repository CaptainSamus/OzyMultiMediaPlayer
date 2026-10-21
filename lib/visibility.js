// Offscreen pause: a video nobody can see should not be decoding. Pure: the caller measures the
// rects and carries out the ops. The margin keeps a tile just outside the view running so a
// small pan doesn't stutter it; `autoPaused` makes sure only what we paused gets resumed.
{
  const Visibility = {
    decide(items, view, margin = 0) {
      const vx0 = view.x - margin, vy0 = view.y - margin, vx1 = view.x + view.w + margin, vy1 = view.y + view.h + margin;
      const out = [];
      for (const it of items) {
        const r = it.rect;
        const visible = r.x < vx1 && r.x + r.w > vx0 && r.y < vy1 && r.y + r.h > vy0;
        if (!visible && it.playing) out.push({ id: it.id, op: 'pause' });
        else if (visible && it.autoPaused && !it.playing) out.push({ id: it.id, op: 'resume' });
      }
      return out;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Visibility;
  else window.Visibility = Visibility;
}
