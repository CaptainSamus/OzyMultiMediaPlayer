// Throttle for a scrub drag. A pointermove fires dozens of times a second; a YouTube embed treats
// every seek as "drop the buffer and fetch from here", so forwarding all of them leaves it
// spinning. This lets one value through every `minInterval` ms during the drag, and the release
// point through always.
{
  const Scrub = {
    create({ minInterval = 150 } = {}) {
      let last = null; // when the last value was let through
      return {
        // the value to preview now, or null to skip this move
        move(t, now) {
          const n = Number(now);
          if (last !== null && n - last < minInterval) return null;
          last = n;
          return t;
        },
        // the real seek at the end of the drag: never throttled, and the next drag starts clean
        end(t) { last = null; return t; },
      };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Scrub;
  else window.Scrub = Scrub;
}
