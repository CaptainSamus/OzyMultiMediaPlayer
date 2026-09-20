// Hover play: with the mode on, a video plays only while the mouse rests on it. The rule that
// makes it feel right is the small delay - sweeping the mouse across the board must not start
// four videos - so this is a tiny state machine rather than two event handlers, and it is kept
// pure (the caller supplies `now` and carries out the actions) so every rule is testable.
//
//   armed   - hovered, waiting out the delay. Nothing is playing yet.
//   playing - the one tile that hover started. Only ever one at a time.
{
  const DEFAULT_DELAY = 150;

  const HoverPlay = {
    create({ delay = DEFAULT_DELAY } = {}) {
      let armed = null;   // { id, due }
      let playing = null; // id

      const play = (id) => ({ op: 'play', id });
      const pause = (id) => ({ op: 'pause', id });

      return {
        // the mouse arrived on a tile: arm it, and stop whatever hover started before
        enter(id, now) {
          if (playing === id) return []; // already the one playing; the delay is long past
          const out = [];
          if (playing !== null) { out.push(pause(playing)); playing = null; }
          armed = { id, due: Number(now) + delay };
          return out;
        },
        // the mouse left: disarm it, or pause it if it had started
        leave(id, now) {
          void now;
          if (armed && armed.id === id) armed = null;
          if (playing === id) { playing = null; return [pause(id)]; }
          return [];
        },
        // time passed: start the armed tile once its delay is up
        tick(now) {
          if (!armed || Number(now) < armed.due) return [];
          const id = armed.id;
          armed = null;
          playing = id;
          return [play(id)];
        },
        // the mode is off, or something else took over the screen (compare, fullscreen)
        reset() {
          const out = playing !== null ? [pause(playing)] : [];
          armed = null;
          playing = null;
          return out;
        },
        // when the caller should call tick() next, or null when nothing is waiting
        nextDue() { return armed ? armed.due : null; },
      };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = HoverPlay;
  else window.HoverPlay = HoverPlay;
}
