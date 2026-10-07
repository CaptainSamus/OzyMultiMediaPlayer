// "Did that click end a drag, or is it a real click?" The old flag was cleared by a setTimeout(0)
// that fired before the click arrived, so a drag's release could toggle play. This one is consumed
// by the click itself, and a fresh press clears it in case that click never came.
{
  const CONTROLS = ['button', 'input', 'select', '.seek', '.markers', '.vol-zone', '.bm-panel', '.error', '.handle', '.text-body'];
  const ClickGuard = {
    create() {
      let armed = false;
      return {
        afterDrag() { armed = true; },
        pointerDown() { armed = false; },
        shouldAct() { if (armed) { armed = false; return false; } return true; },
      };
    },
    // EZ play: a click counts as "on the picture" unless it landed on a control. `closest` is
    // (selector) => boolean, usually (s) => !!e.target.closest(s).
    ezTarget(closest) { return !CONTROLS.some((s) => closest(s)); },
    // Should this click on a tile toggle play? A board tile owns the pointer from pointerdown, so
    // Chromium hands the click to the tile element instead of the <video> under the cursor
    // (retargeted): the tile has to play it. A click the picture received itself (gallery) is the
    // picture's own handler's job. Off the picture only EZ play acts, and never on a control.
    clickPlays({ shift, retargeted, onPicture, ez, onControl }) {
      if (shift) return false;
      if (onPicture) return !!retargeted;
      return !!ez && !onControl;
    },
    CONTROLS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ClickGuard;
  else window.ClickGuard = ClickGuard;
}
