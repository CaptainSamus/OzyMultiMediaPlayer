// Whether the big "Release to add" overlay should be showing.
//
// The old version counted dragenter minus dragleave, which only balances if the app sees the end
// of every drag. It does not: a drag that ends inside a cross-origin iframe (a YouTube embed, say)
// sends its last events to the frame, the counter never returns to zero, and the overlay stays up
// over a window that then looks broken. So there is no counter here. The overlay follows the last
// thing that actually happened, and a drag that goes quiet for `idleMs` is assumed to have ended
// somewhere out of sight.
{
  const DragState = {
    create({ idleMs = 400 } = {}) {
      let visible = false;
      let last = 0; // when the drag was last seen over the window
      const show = (now) => { visible = true; last = Number(now) || 0; return visible; };
      const hide = () => { visible = false; return visible; };
      return {
        enter(now) { return show(now); },
        // dragover fires continuously while the drag is over us; it is the heartbeat, and it also
        // covers an enter we never saw
        over(now) { return show(now); },
        leave() { return hide(); },   // the caller decides what counts as really leaving
        drop() { return hide(); },
        end() { return hide(); },     // dragend, pointerup, blur, tab hidden
        tick(now) { if (visible && (Number(now) || 0) - last >= idleMs) hide(); return visible; },
      };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DragState;
  else window.DragState = DragState;
}
